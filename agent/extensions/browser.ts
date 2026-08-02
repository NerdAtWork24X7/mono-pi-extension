/**
 * Browser Automation Tool - Stealth Playwright browser control for subagents
 *
 * Cookies: if ~/.pi/agent/cookie exists (JSON array/object or Netscape cookies.txt), they are loaded into the context on launch.
 * Uses playwright-extra + stealth plugin to evade bot detection.
 * Each subagent process gets its own browser instance (module-level singleton).
 * Tools: browser (actions: launch, goto, click, type,
 *        screenshot, eval, read, wait, newpage, close)
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

// ── Browser singleton (per-process) ──────────────────────────────────

let browser: any = null;
let context: any = null;
let page: any = null;
const pages = new Map<string, any>();
let activePageId = "main";
let playwrightExtra: any = null;

const SCREENSHOT_DIR = join(tmpdir(), "pi-browser-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });
const COOKIE_FILE = join(homedir(), ".pi", "agent", "cookie");

// ── Stealth & anti-detection patches (injected before every page) ────

const STEALTH_INIT_SCRIPT = `
  // 1. navigator.webdriver → false
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. Chrome runtime (window.chrome)
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  }

  // 3. Fake plugins array (non-empty)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      return plugins;
    },
  });

  // 4. MimeTypes
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => ({
      length: 2,
      0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      1: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    }),
  });

  // 5. languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // 5b. hardwareConcurrency / deviceMemory (headless often reports low/odd values)
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // 6. permissions.query patch (notifications → prompt, not denied)
  const origQuery = window.Permissions?.prototype?.query;
  if (origQuery) {
    window.Permissions.prototype.query = function(params) {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission || 'prompt' });
      }
      return origQuery.call(this, params);
    };
  }

  // 7. WebGL vendor/renderer spoofing (WebGL1 + WebGL2 — sites can use either context)
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, param);
  };
  if (window.WebGL2RenderingContext) {
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter2.call(this, param);
    };
  }

  // 8. Remove cdc_ attributes injected by chromedriver
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (typeof name === 'string' && name.startsWith('cdc_')) return this;
    return origSetAttribute.call(this, name, value);
  };

  // 9. Override connection.rtt (headless sets 0, real browsers don't)
  if (navigator.connection) {
    Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
  }

  // 10. Fix iframe contentWindow.chrome
  try {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    document.body.appendChild(frame);
    if (frame.contentWindow && !frame.contentWindow.chrome) {
      frame.contentWindow.chrome = window.chrome;
    }
    document.body.removeChild(frame);
  } catch {}
`;

// ── Realistic default context options ────────────────────────────────

const VIEWPORTS = [
 { width: 1920, height: 1080 },
 { width: 1366, height: 768 },
 { width: 1536, height: 864 },
 { width: 1440, height: 900 },
 { width: 1280, height: 720 },
];

function randomViewport() {
	return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

// ── Chromium launch args for stealth ─────────────────────────────────

const STEALTH_ARGS = [
	"--disable-blink-features=AutomationControlled",
	"--disable-infobars",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-extensions",
	"--disable-component-extensions-with-background-pages",
	"--disable-default-apps",
	"--disable-dev-shm-usage",
	// NOTE: --disable-gpu removed — it forces SwiftShader software rendering,
	// which conflicts with the WebGL vendor/renderer spoof below (sites can
	// detect the mismatch between reported vendor and actual render behavior).
	// NOTE: --disable-features=IsolateOrigins,site-per-process removed — Site
	// Isolation is ON by default in real consumer Chrome, so disabling it makes
	// the fingerprint diverge from a stock install instead of blending in.
	// --no-sandbox / --disable-setuid-sandbox are only needed when running as
	// root (Docker/CI) — added conditionally below, not unconditionally.
	...(process.env.CI || (typeof process.getuid === "function" && process.getuid() === 0)
		? ["--no-sandbox", "--disable-setuid-sandbox"]
		: []),
];

// ── Helpers ──────────────────────────────────────────────────────────

export type BrowserCookie = {
	name: string;
	value: string;
	domain: string;
	path?: string;
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
};

function parseNetscapeCookies(text: string): BrowserCookie[] {
	const out: BrowserCookie[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const parts = trimmed.split("\t");
		if (parts.length < 7) continue;
		const [domain, , path, secureFlag, expiresStr, name, value] = parts;
		const expires = Number(expiresStr);
		if (expires > 0 && expires <= Math.floor(Date.now() / 1000)) continue; // skip expired
		out.push({
			name,
			value,
			domain: domain.replace(/^\./, ""), // strip leading dot, Playwright covers subdomains
			path,
			secure: secureFlag === "TRUE",
			...(expires > 0 ? { expires } : {}),
		});
	}
	return out;
}

function normalizeJsonCookies(list: unknown[]): BrowserCookie[] {
	const out: BrowserCookie[] = [];
	for (const raw of list) {
		const c = raw as Record<string, unknown>;
		if (!c || typeof c !== "object") continue;
		if (!c.name || !c.value || !c.domain) continue; // Playwright throws without these
		const expires = (c.expires ?? c.expirationDate) as number | undefined;
		if (typeof expires === "number" && expires > 0 && expires <= Math.floor(Date.now() / 1000)) continue; // skip expired
		const outCookie: BrowserCookie = {
			name: String(c.name),
			value: String(c.value),
			domain: String(c.domain).replace(/^\./, ""),
			...(c.path ? { path: String(c.path) } : {}),
			...(typeof expires === "number" && expires > 0 ? { expires } : {}),
			...(typeof c.httpOnly === "boolean" ? { httpOnly: c.httpOnly } : {}),
			...(typeof c.secure === "boolean" ? { secure: c.secure } : {}),
		};
		const ss = String(c.sameSite ?? "").toLowerCase();
		if (ss === "strict" || ss === "lax" || ss === "none" || ss === "no_restriction") {
			outCookie.sameSite = ss === "strict" ? "Strict" : ss === "lax" ? "Lax" : "None";
		}
		out.push(outCookie);
	}
	return out;
}

/** Parse cookie file content. Auto-detect: JSON (array or single object, Playwright/devtools style) or Netscape cookies.txt (tab-separated). Throws on malformed JSON. */
export function parseCookieFile(text: string): BrowserCookie[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		const parsed = JSON.parse(trimmed);
		if (!Array.isArray(parsed)) throw new Error("cookie file JSON must be an array of cookie objects");
		return normalizeJsonCookies(parsed);
	}
	if (trimmed.startsWith("{")) {
		const parsed = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("cookie file JSON must be a cookie object or array");
		return normalizeJsonCookies([parsed]);
	}
	return parseNetscapeCookies(text);
}

/** Read ~/.pi/agent/cookie; returns [] if file missing. Throws on unparseable content. */
function readCookieFile(): BrowserCookie[] {
	let raw: string;
	try {
		raw = readFileSync(COOKIE_FILE, "utf8");
	} catch {
		return []; // no cookie file present — not an error
	}
	return parseCookieFile(raw);
}

async function getPw() {
	if (!playwrightExtra) {
		try {
			const pwExtra = await import("playwright-extra");
			const stealthMod = await import("puppeteer-extra-plugin-stealth");
			const stealth = (stealthMod as any).default();
			pwExtra.chromium.use(stealth);
			playwrightExtra = pwExtra;
		} catch (e: unknown) {
			throw new Error(
				"playwright-extra not installed. Run: npm i playwright-extra puppeteer-extra-plugin-stealth"
			);
		}
	}
	return playwrightExtra;
}

function getActivePage(): any {
	if (!page) throw new Error("No browser page open. Call browser with action: launch first.");
	return page;
}

function ok(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function err(msg: string) {
	return { content: [{ type: "text" as const, text: `Error: ${msg}` }], details: { error: msg } };
}

/** Add human-like jitter to a value (±5-15%) */
function jitter(value: number, pct = 0.1): number {
	return value + value * (Math.random() * pct * 2 - pct);
}

// ── Extension entry ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: "Stealth browser automation. Use action param to: launch, goto, click, type, screenshot, eval, read, wait, newpage, close; cookies from ~/.pi/agent/cookie (JSON or Netscape) auto-loaded on launch.",
		parameters: Type.Object({
			action: Type.String({ description: "Action: launch, goto, click, type, screenshot, eval, read, wait, newpage, close" }),
			browserType: Type.Optional(Type.String({ description: "(launch) Browser engine: chromium, firefox, webkit. Default chromium.", default: "chromium" })),
			viewport: Type.Optional(Type.Object({
				width: Type.Number({ description: "Viewport width in px" }),
				height: Type.Number({ description: "Viewport height in px" }),
			})),
			url: Type.Optional(Type.String({ description: "(goto) URL to navigate to" })),
			waitUntil: Type.Optional(Type.String({ description: "(goto) Wait condition: load, domcontentloaded, networkidle, commit. Default domcontentloaded.", default: "domcontentloaded" })),
			selector: Type.Optional(Type.String({ description: "(click/type/read/wait) CSS selector. Use >> for text: text=Sign In" })),
			button: Type.Optional(Type.String({ description: "(click) Mouse button: left, right, middle. Default left.", default: "left" })),
			text: Type.Optional(Type.String({ description: "(type) Text to type" })),
			clear: Type.Optional(Type.Boolean({ description: "(type) Clear field before typing. Default true.", default: true })),
			fullPage: Type.Optional(Type.Boolean({ description: "(screenshot) Capture full scrollable page. Default false.", default: false })),
			expression: Type.Optional(Type.String({ description: "(eval) JavaScript expression to evaluate" })),
			timeout: Type.Optional(Type.Number({ description: "(wait) Timeout in ms. Default 10000.", default: 10_000 })),
			id: Type.Optional(Type.String({ description: "(newpage) Page identifier. Default auto-generated.", default: "" })),
		}),

		async execute(_id, params) {
			try {
				const p = params as any;
				switch (p.action) {
					case "launch": {
						let cookies: BrowserCookie[] = [];
						try {
							cookies = readCookieFile();
						} catch (e: unknown) {
							return err(`Failed to parse cookie file ${COOKIE_FILE}: ${e instanceof Error ? e.message : String(e)}. Fix or remove the file, then relaunch.`);
						}
						if (browser) return ok("Browser already running.");

						const browserType = p.browserType ?? "chromium";

						const pw = await getPw();
						const launcher = (pw as any)[browserType];
						if (!launcher) return err(`Unknown browser: ${browserType}. Use chromium, firefox, or webkit.`);

						const vp = p.viewport || randomViewport();

						// Launch with stealth args. Prefer the real installed Chrome binary
						// over Playwright's bundled Chromium when available — some detectors
						// fingerprint the bundled-Chromium binary itself (missing Widevine,
						// different codec support, etc.) regardless of JS-level patches.
						const launchOpts: any = {
							headless: false,
							args: browserType === "chromium" ? STEALTH_ARGS : undefined,
						};
						if (browserType === "chromium") launchOpts.channel = "chrome";
						try {
							browser = await launcher.launch(launchOpts);
						} catch {
							// Fall back to bundled Chromium if "chrome" channel isn't installed
							delete launchOpts.channel;
							browser = await launcher.launch(launchOpts);
						}

						// Derive UA / Client-Hints from the *actual* launched browser version
						// instead of hardcoding — a mismatch between navigator.userAgent,
						// navigator.userAgentData, and the sec-ch-ua headers is one of the
						// highest-signal bot tells for detectors like FingerprintJS/Cloudflare.
						const fullVersion: string = browser.version?.() ?? "124.0.6367.60";
						const majorVersion = fullVersion.split(".")[0];
						const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`;

						// Create context with realistic fingerprint
						context = await browser.newContext({
							viewport: vp,
							// screen should be >= viewport; a viewport that exactly equals
							// screen with no chrome/taskbar allowance is itself a signal
							screen: { width: vp.width, height: vp.height + 40 },
							userAgent,
							locale: "en-US",
							timezoneId: "America/New_York",
							geolocation: { latitude: 40.7128, longitude: -74.006 },
							permissions: ["geolocation"],
							colorScheme: "light",
							deviceScaleFactor: 1,
							hasTouch: false,
							javaScriptEnabled: true,
							ignoreHTTPSErrors: true,
							extraHTTPHeaders: {
								"Accept-Language": "en-US,en;q=0.9",
								"Accept-Encoding": "gzip, deflate, br",
								"sec-ch-ua": `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not-A.Brand";v="99"`,
								"sec-ch-ua-mobile": "?0",
								"sec-ch-ua-platform": '"Windows"',
							},
						});

						// Inject stealth scripts before every page/frame
						await context.addInitScript(STEALTH_INIT_SCRIPT);

						if (cookies.length > 0) {
							await context.addCookies(cookies);
						}

						page = await context.newPage();
						pages.set("main", page);
						activePageId = "main";

						return ok(
							`Stealth browser launched (${browserType}, headless=false, viewport=${vp.width}x${vp.height}).` +
								(cookies.length > 0 ? ` Loaded ${cookies.length} cookies from ${COOKIE_FILE}.` : "")
						);
					}
					case "goto": {
						if (!p.url) return err("url is required for goto action");
						const waitUntil = p.waitUntil ?? "domcontentloaded";
						const pg = getActivePage();
						await pg.goto(p.url, { waitUntil: waitUntil as any, timeout: 30_000 });
						const title = await pg.title();
						return ok(`Navigated to ${p.url}\nTitle: ${title}`);
					}
					case "click": {
						if (!p.selector) return err("selector is required for click action");
						const button = p.button ?? "left";
						const pg = getActivePage();

						// Human-like: move to element area first, then click
						const el = await pg.$(p.selector);
						if (!el) return err(`Element not found: ${p.selector}`);
						const box = await el.boundingBox();
						if (box) {
							const x = jitter(box.x + box.width / 2);
							const y = jitter(box.y + box.height / 2);
							await pg.mouse.move(x, y, { steps: Math.floor(jitter(5, 0.5)) });
							await new Promise(r => setTimeout(r, jitter(80, 0.3)));
						}
						await el.click({ button: button as any, timeout: 10_000 });
						return ok(`Clicked: ${p.selector}`);
					}
					case "type": {
						if (!p.selector || p.text === undefined) return err("selector and text are required for type action");
						const clear = p.clear ?? true;
						const pg = getActivePage();
						if (clear) {
							await pg.fill(p.selector, "");
							// Type with human-like delay (40-90ms per char)
							await pg.type(p.selector, p.text, { delay: jitter(60, 0.4) });
						} else {
							await pg.type(p.selector, p.text, { delay: jitter(60, 0.4) });
						}
						return ok(`Typed into ${p.selector}`);
					}
					case "screenshot": {
						const fullPage = p.fullPage ?? false;
						const pg = getActivePage();
						const ts = Date.now();
						const filePath = join(SCREENSHOT_DIR, `screenshot-${ts}.png`);
						await pg.screenshot({ path: filePath, fullPage });
						return ok(`Screenshot saved: ${filePath}`);
					}
					case "eval": {
						if (!p.expression) return err("expression is required for eval action");
						const pg = getActivePage();
						const result = await pg.evaluate(p.expression);
						const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
						return ok(text);
					}
					case "read": {
						const selector = p.selector ?? "body";
						const pg = getActivePage();
						const text = await pg.innerText(selector);
						const trimmed = text.length > 16_000 ? text.slice(0, 16_000) + "\n... [truncated]" : text;
						return ok(trimmed);
					}
					case "wait": {
						const selector = p.selector ?? "";
						const timeout = p.timeout ?? 10_000;
						const pg = getActivePage();
						if (selector) {
							await pg.waitForSelector(selector, { timeout });
							return ok(`Element appeared: ${selector}`);
						}
						await pg.waitForLoadState("domcontentloaded", { timeout });
						return ok("Page loaded (domcontentloaded).");
					}
					case "newpage": {
						if (!context) return err("No browser context. Call browser with action: launch first.");
						const newPage = await context.newPage();
						const pageId = (p.id || "") || `page-${pages.size}`;
						pages.set(pageId, newPage);
						page = newPage;
						activePageId = pageId;
						return ok(`New page opened: ${pageId}`);
					}
					case "close": {
						try {
							if (browser) {
								await browser.close();
							}
						} catch {
							// close error ignored, still reset state
						} finally {
							browser = null;
							context = null;
							page = null;
							pages.clear();
						}
						return ok("Browser closed.");
					}
					default:
						return err(`Unknown action: ${p.action}. Use: launch, goto, click, type, screenshot, eval, read, wait, newpage, close`);
				}
			} catch (e: unknown) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	});

	// ── Cleanup on process exit ─────────────────────────────────────

	process.on("exit", () => {
		if (browser) browser.close().catch(() => {});
	});
	process.on("SIGTERM", async () => {
		if (browser) await browser.close().catch(() => {});
		process.exit(0);
	});
}
