/**
 * Web Fetch Tool - Fetch web pages and extract content
 *
 * Results are served from a three-layer cache and all disk I/O is async,
 * so a fetch never blocks the event loop:
 *   1. in-memory LRU  - repeat fetches in this process skip disk entirely
 *   2. on-disk cache  - subagents run in separate processes; the disk cache
 *                       (default ~/.pi/web-fetch-cache, TTL-gated) dedupes
 *                       fetches across processes. Writes are atomic (temp
 *                       file + rename). Directory pruning is throttled to
 *                       once per 5 min instead of running on every fetch.
 *   3. in-flight map  - parallel calls for the same URL share one request
 * Fetches carry a timeout (WEB_FETCH_TIMEOUT_MS, default 30s) plus the
 * caller's abort signal, so slow servers can't hang the tool forever.
 */

import { createHash } from "crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CACHE_NAMESPACE = "default";
const CACHE_DIR = process.env.WEB_FETCH_CACHE_DIR
  ? resolve(process.env.WEB_FETCH_CACHE_DIR)
  : join(homedir(), ".pi", "web-fetch-cache");

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CACHE_TTL_MS = envMs("WEB_FETCH_CACHE_TTL_MS", 60 * 60 * 1000); // 1 hour
const FETCH_TIMEOUT_MS = envMs("WEB_FETCH_TIMEOUT_MS", 30_000);
const MAX_CACHE_ENTRIES = 2000;
const MEM_CACHE_MAX = 100;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

interface CacheEntry {
  url: string;
  raw: boolean;
  fetchedAt: number;
  result: any;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : "Unknown error");

function cacheKey(url: string, raw: boolean): string {
  return `${CACHE_NAMESPACE}:${url}:${raw ? "raw" : "text"}`;
}

function cachePath(url: string, raw: boolean): string {
  const hash = createHash("sha256").update(cacheKey(url, raw)).digest("hex");
  return join(CACHE_DIR, `${hash}.json`);
}

function textResult(url: string, raw: boolean, text: string) {
  return { content: [{ type: "text", text }], details: { url, raw } };
}

// ── Layer 1: in-memory cache (LRU) ─────────────────────────────────────
const memCache = new Map<string, { expires: number; result: any }>();

function memGet(url: string, raw: boolean): any | null {
  const key = cacheKey(url, raw);
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    memCache.delete(key);
    return null;
  }
  memCache.delete(key); // re-insert to mark as most-recently-used
  memCache.set(key, hit);
  return hit.result;
}

function memSet(url: string, raw: boolean, result: any): void {
  const key = cacheKey(url, raw);
  memCache.delete(key);
  memCache.set(key, { expires: Date.now() + CACHE_TTL_MS, result });
  if (memCache.size > MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value; // Maps iterate oldest-first
    if (oldest !== undefined) memCache.delete(oldest);
  }
}

// ── Layer 2: on-disk cache (async, shared across processes) ────────────
async function diskGet(url: string, raw: boolean): Promise<any | null> {
  const p = cachePath(url, raw);
  let entry: CacheEntry;
  try {
    entry = JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null; // missing or unreadable
  }
  if (!entry || entry.url !== url || entry.raw !== raw || !entry.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    unlink(p).catch(() => { });
    return null;
  }
  return entry.result;
}

async function diskSet(url: string, raw: boolean, result: any): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const p = cachePath(url, raw);
    const tmp = `${p}.${process.pid}.tmp`;
    const entry: CacheEntry = { url, raw, fetchedAt: Date.now(), result };
    await writeFile(tmp, JSON.stringify(entry));
    try {
      await rename(tmp, p);
    } catch (err: any) {
      // Windows cannot rename over an existing file: remove and retry once.
      if (err?.code === "EEXIST") {
        await unlink(p).catch(() => { });
        await rename(tmp, p).catch(() => { });
      }
    }
  } catch {
    // Cache write failed; the fetch itself already succeeded.
  }
  maybePrune();
}

// Pruning scans the whole cache dir, so it is throttled to once per
// PRUNE_INTERVAL_MS per process instead of running after every fetch.
let lastPrune = 0;
let pruning = false;

function maybePrune(): void {
  const now = Date.now();
  if (pruning || now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  pruning = true;
  pruneCache()
    .catch(() => { })
    .finally(() => {
      pruning = false;
    });
}

async function pruneCache(): Promise<void> {
  try {
    const files = (await readdir(CACHE_DIR)).filter((f) => f.endsWith(".json"));
    if (files.length <= MAX_CACHE_ENTRIES) return;
    const withMtime = (
      await Promise.all(
        files.map(async (name) => {
          try {
            return { name, mtime: (await stat(join(CACHE_DIR, name))).mtimeMs };
          } catch {
            return null; // vanished between readdir and stat
          }
        }),
      )
    ).filter((x): x is { name: string; mtime: number } => x !== null);
    withMtime.sort((a, b) => a.mtime - b.mtime);
    const removeCount = Math.ceil(files.length * 0.1);
    await Promise.all(
      withMtime.slice(0, removeCount).map(({ name }) => unlink(join(CACHE_DIR, name)).catch(() => { })),
    );
  } catch {
    // Pruning is best-effort.
  }
}

// ── HTML → readable text ───────────────────────────────────────────────
// One regex per concern (5 passes total; the old version needed 10).
const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">" };

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt);|&#(\d+);/g, (_m, name, num) =>
      num ? String.fromCharCode(parseInt(num, 10)) : ENTITIES[name])
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

// ── Layer 3: in-flight dedup + fetch ───────────────────────────────────
const inflight = new Map<string, Promise<any>>();

async function fetchAndCache(url: string, raw: boolean, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const html = await res.text();
  const result = textResult(url, raw, raw ? html : htmlToText(html));
  memSet(url, raw, result);
  await diskSet(url, raw, result);
  return result;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web-fetch",
    label: "Web Fetch",
    description: "Fetch a web page and extract readable text content",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      raw: Type.Boolean({ description: "Return raw HTML instead of extracted text", default: false }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { url, raw = false } = params as { url: string; raw?: boolean };
      try {
        const cached = memGet(url, raw) ?? (await diskGet(url, raw));
        if (cached) {
          memSet(url, raw, cached); // warm layer 1 for the next call
          return cached;
        }

        // Share one network request between parallel same-URL calls.
        const key = cacheKey(url, raw);
        let p = inflight.get(key);
        if (!p) {
          p = fetchAndCache(url, raw, signal).finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
        return await p;
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error fetching ${url}: ${errMsg(error)}` }],
          details: { error: errMsg(error) },
        };
      }
    },
  });
}
