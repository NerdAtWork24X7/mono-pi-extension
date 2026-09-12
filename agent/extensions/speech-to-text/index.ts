/**
 * Speech-to-Text (Groq Whisper)
 *
 * Push-to-talk dictation into the pi prompt:
 *
 *   hold Alt+T   record while held  →  release  →  the clip is transcribed
 *
 * The transcript is appended to whatever is already in the prompt editor so
 * you can review it before sending. `/listen` toggles a recording instead of
 * holding, and `/stt` reports/configures the extension.
 *
 * How the key is detected: extensions receive raw terminal input *before* the
 * editor, via `ctx.ui.onTerminalInput`. pi asks the terminal for the Kitty
 * keyboard protocol with flags 1|2|4 (`CSI > 7 u`), so on Kitty/Ghostty/
 * WezTerm/foot/Alacritty etc. we get explicit press, repeat and **release**
 * events (`isKeyRelease`). Terminals that fall back to xterm modifyOtherKeys
 * never report a release, so there auto-repeat acts as the "still held" signal
 * and recording stops `holdReleaseGapMs` after the last repeat.
 *
 * Setup:  export GROQ_API_KEY=gsk_...      (https://console.groq.com/keys)
 *
 * While recording, the footer shows a live level meter (`████░░░░ 0:05`) read
 * straight from the WAV the recorder is writing, plus a "no signal?" hint if
 * nothing has been picked up for a couple of seconds.
 *
 * Optional overrides, either via environment or a JSON config file
 * (`<agentDir>/speech-to-text.json`, overridden by `.pi/speech-to-text.json`):
 *
 *   {
 *     "model": "whisper-large-v3-turbo",   // GROQ_STT_MODEL
 *     "language": "en",                    // GROQ_STT_LANGUAGE ("" = auto)
 *     "prompt": "Kubernetes, TypeScript",  // vocabulary hints
 *     "maxDurationSeconds": 120,           // GROQ_STT_MAX_SECONDS
 *     "holdReleaseGapMs": 900,             // GROQ_STT_HOLD_RELEASE_MS
 *     "silenceAutoStop": false,            // sox only: stop after trailing silence
 *     "recorder": "auto",                  // GROQ_STT_RECORDER: auto|sox|arecord|ffmpeg
 *     "sampleRate": 16000,
 *     "levelMeter": true,                  // GROQ_STT_METER=0 to disable
 *     "keepAudio": false
 *   }
 *
 * Requires a host recorder: sox (`rec`), alsa-utils (`arecord`), or ffmpeg.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, isKeyRelease, isKeyRepeat, matchesKey } from "@mariozechner/pi-tui";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL, globalConfigPath, loadConfig, projectConfigPath, type SttConfig } from "./config";
import { transcribe } from "./groq";
import { AudioLevelMeter } from "./level";
import { detectRecorder, hasAudio, startRecorder, stopRecorder, type RecorderHandle } from "./recorder";

type Phase = "idle" | "recording" | "transcribing";
type NotifyType = "info" | "warning" | "error";

const LISTEN_KEY = Key.alt("t");

/** Last-resort guard so a transcript can never blow past the editor. */
const MAX_TRANSCRIPT_CHARS = 4000;

/** Cells in the level meter bar. */
const METER_SEGMENTS = 8;
/** Status refresh while recording: fast enough for a live meter. */
const METER_TICK_MS = 120;
/** Plain status refresh when the meter is off. */
const PLAIN_TICK_MS = 1000;
/** Show the "no signal" hint after this long without audio. */
const NO_SIGNAL_MS = 2500;

/** Kitty reports the event type as `:<n>u` (1 = press, 2 = repeat, 3 = release).
 *  Its presence on a press means the terminal will also send a release. */
const KITTY_EVENT_TYPE = /:\d+u$/;

function formatElapsed(ms: number): string {
	const total = Math.floor(ms / 1000);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

class SpeechToText {
	private cfg: SttConfig;
	private phase: Phase = "idle";
	private handle: RecorderHandle | null = null;
	private startedAt = 0;
	private statusTimer: ReturnType<typeof setInterval> | null = null;
	private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
	/** Fires `holdReleaseGapMs` after the last alt+t event when the terminal
	 *  cannot report key releases (auto-repeat keeps re-arming it). */
	private releaseWatchdog: ReturnType<typeof setTimeout> | null = null;
	/** True for the current recording when the terminal reports event types,
	 *  i.e. the release event will arrive and stop us. */
	private eventTypes = false;
	/** True when the current recording was started by holding alt+t, so a key
	 *  release (or the repeat-gap watchdog) is expected to stop it. False for
	 *  /listen-style toggles, which stop on the next press instead. */
	private waitForRelease = false;
	/** Live level meter reading the WAV the recorder is still writing. */
	private meter: AudioLevelMeter | null = null;
	/** Unsubscribe for the raw terminal input listener (TUI only). */
	private unsubscribe: (() => void) | null = null;
	/** True while a stop we initiated is in flight, so the recorder's own exit
	 *  event doesn't kick off a second transcription pass. */
	private ownStop = false;
	/** Timestamp of the last alt+t event we handled, so the registered-shortcut
	 *  fallback never double-handles an event the terminal listener consumed. */
	lastKeyEventAt = 0;
	/** Last ctx seen, reused for notifications that fire after a handler returns. */
	ctx: any = null;

	constructor(cwd: string) {
		this.cfg = loadConfig(cwd);
	}

	// ── Raw terminal input (press / repeat / release) ───────────────────

	/** Install the TUI input listener. No-op outside interactive mode. */
	installTerminalListener(): void {
		if (this.unsubscribe) return;
		const ui = this.ctx?.ui;
		if (this.ctx?.mode !== "tui" || typeof ui?.onTerminalInput !== "function") return;
		this.unsubscribe = ui.onTerminalInput((data: string) => this.handleTerminalInput(data));
	}

	/** Runs before the editor sees the key. Returns `{ consume: true }` for
	 *  alt+t so the editor never inserts it and the shortcut can't double-fire. */
	private handleTerminalInput(data: string): { consume?: boolean } | undefined {
		if (!matchesKey(data, LISTEN_KEY)) return undefined;
		this.lastKeyEventAt = Date.now();

		// Explicit release: stop immediately.
		if (isKeyRelease(data)) {
			this.eventTypes = true;
			this.cancelWatchdog();
			void this.stopAndTranscribe();
			return { consume: true };
		}

		// Auto-repeat: the key is still held. Ignore it so holding records
		// continuously instead of toggling on every repeat.
		if (isKeyRepeat(data)) {
			this.eventTypes = true;
			this.cancelWatchdog();
			return { consume: true };
		}

		this.onPress(KITTY_EVENT_TYPE.test(data));
		return { consume: true };
	}

	private onPress(reportsEventTypes: boolean): void {
		if (this.phase === "transcribing") {
			this.notify("Still transcribing the previous clip…", "info");
			return;
		}
		if (this.phase === "recording") {
			if (!this.waitForRelease) {
				// Toggle recording (/listen): the next press stops it.
				void this.stopAndTranscribe();
				return;
			}
			if (this.eventTypes) {
				// The release will stop us; a press here is spurious.
				return;
			}
			// No release events: a repeated byte-identical press means the key
			// is still held, so treat it as "hold continues" and re-arm the
			// watchdog instead of stopping.
			this.armWatchdog();
			return;
		}
		void this.start("hold", reportsEventTypes);
	}

	// ── Recording ───────────────────────────────────────────────────────

	private async start(mode: "hold" | "toggle", reportsEventTypes = false): Promise<void> {
		if (!this.cfg.enabled) {
			this.notify("Speech-to-text is off. Run /stt on to enable it.", "warning");
			return;
		}
		if (!this.cfg.apiKey) {
			this.notify("Speech-to-text: set GROQ_API_KEY (https://console.groq.com/keys) first.", "error");
			return;
		}

		const file = join(tmpdir(), `pi-stt-${process.pid}-${Date.now()}.wav`);
		let handle: RecorderHandle;
		try {
			handle = startRecorder(this.cfg, file);
		} catch (err) {
			this.notify(`Speech-to-text: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		this.handle = handle;
		this.phase = "recording";
		this.waitForRelease = mode === "hold";
		this.eventTypes = mode === "hold" && reportsEventTypes;
		this.ownStop = false;
		this.startedAt = Date.now();

		// The recorder can end on its own (sox silence detection, unplugged
		// device, ffmpeg crash). Only treat that as an auto-stop while this
		// handle is still the one we are waiting on.
		handle.proc.once("exit", () => this.onRecorderExit(handle));
		handle.proc.once("error", (err: Error) => {
			if (this.handle === handle) {
				this.notify(`Recording failed: ${err.message}`, "error");
				void this.stopAndTranscribe();
			}
		});

		// Terminals without event types only tell us the key was released
		// indirectly: auto-repeat stops arriving. Toggle recordings (/listen)
		// have no held key, so they must not arm the watchdog.
		if (mode === "hold" && !reportsEventTypes) this.armWatchdog();

		// Live level meter: sample the growing WAV and repaint the status line.
		const stopHint = mode === "hold" ? "release alt+t to transcribe" : "alt+t or /listen to stop";
		if (this.cfg.levelMeter) this.meter = new AudioLevelMeter(file, this.cfg.sampleRate);
		this.renderStatus(stopHint);
		this.statusTimer = setInterval(
			() => this.renderStatus(stopHint),
			this.cfg.levelMeter ? METER_TICK_MS : PLAIN_TICK_MS,
		);

		if (this.cfg.maxDurationSeconds > 0) {
			this.maxDurationTimer = setTimeout(() => {
				this.notify(`Reached the ${this.cfg.maxDurationSeconds}s limit — transcribing.`, "info");
				void this.stopAndTranscribe();
			}, this.cfg.maxDurationSeconds * 1000);
		}
	}

	/** Repaint the recording status: level bar, elapsed time, stop hint. */
	private renderStatus(stopHint: string): void {
		const elapsed = formatElapsed(Date.now() - this.startedAt);
		let meter = "";
		if (this.meter) {
			const level = this.meter.sample();
			const filled = Math.min(METER_SEGMENTS, Math.max(0, Math.round(level * METER_SEGMENTS)));
			meter = `${"█".repeat(filled)}${"░".repeat(METER_SEGMENTS - filled)}`;
			if (this.meter.silentForMs() > NO_SIGNAL_MS) meter += " no signal?";
			meter += " ";
		}
		this.setStatus(`🎤 ${meter}${elapsed} — ${stopHint}`);
	}

	private armWatchdog(): void {
		this.cancelWatchdog();
		this.releaseWatchdog = setTimeout(() => {
			this.releaseWatchdog = null;
			// No alt+t event for the gap → the key was released.
			void this.stopAndTranscribe();
		}, this.cfg.holdReleaseGapMs);
	}

	private cancelWatchdog(): void {
		if (!this.releaseWatchdog) return;
		clearTimeout(this.releaseWatchdog);
		this.releaseWatchdog = null;
	}

	private onRecorderExit(handle: RecorderHandle): void {
		if (this.handle !== handle || this.ownStop || this.phase !== "recording") return;
		// Ended by itself (sox silence, or a crash that already notified).
		void this.stopAndTranscribe();
	}

	private async stopAndTranscribe(): Promise<void> {
		if (this.phase !== "recording" || !this.handle) return;
		this.phase = "transcribing";
		this.ownStop = true;
		this.clearTimers();

		const handle = this.handle;
		this.handle = null;
		const file = handle.file;

		try {
			await stopRecorder(handle);
		} catch { /* best effort — use whatever was captured */ }

		this.setStatus("🎤 transcribing…");
		try {
			if (!hasAudio(file)) {
				const detail = handle.stderr.trim() ? ` (${handle.stderr.trim().split("\n").pop()})` : "";
				throw new Error(`no audio captured${detail}`);
			}
			const { text, model, elapsedMs } = await transcribe(this.cfg, file);
			if (!text) {
				this.notify(`No speech detected (${model}, ${elapsedMs}ms).`, "warning");
			} else {
				const applied = this.insertText(text);
				const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
				this.notify(
					applied ? `Transcribed: “${preview}”` : `Transcript (editor unavailable): “${preview}”`,
					applied ? "info" : "warning",
				);
			}
		} catch (err) {
			this.notify(`Speech-to-text: ${err instanceof Error ? err.message : String(err)}`, "error");
		} finally {
			this.closeMeter();
			this.cleanupAudio(file);
			this.phase = "idle";
			this.ownStop = false;
			this.waitForRelease = false;
			this.eventTypes = false;
			this.setStatus(undefined);
		}
	}

	// ── Fallback entry point (/listen, and the registered shortcut when the
	//    terminal listener isn't what received the key) ──────────────────

	async toggle(ctx: any, opts: { hold?: boolean } = {}): Promise<void> {
		this.ctx = ctx;
		if (this.phase === "recording") {
			void this.stopAndTranscribe();
			return;
		}
		if (this.phase === "transcribing") {
			this.notify("Still transcribing the previous clip…", "info");
			return;
		}
		await this.start(opts.hold ? "hold" : "toggle");
	}

	// ── Prompt insertion ────────────────────────────────────────────────

	/** Append the transcript to the prompt editor, preserving typed text.
	 *  Returns false when the host exposes no editor text API. */
	private insertText(text: string): boolean {
		const ui = this.ctx?.ui;
		const safe = text.slice(0, MAX_TRANSCRIPT_CHARS);
		if (!ui || typeof ui.setEditorText !== "function") {
			this.notify(`Transcript (copy manually): ${safe}`, "warning");
			return false;
		}
		let current = "";
		try {
			current = typeof ui.getEditorText === "function" ? ui.getEditorText() ?? "" : "";
		} catch {
			current = "";
		}
		const sep = current.length > 0 && !/\s$/.test(current) ? " " : "";
		try {
			ui.setEditorText(`${current}${sep}${safe}`);
			return true;
		} catch {
			this.notify(`Transcript (copy manually): ${safe}`, "warning");
			return false;
		}
	}

	// ── Command/diagnostic surface ──────────────────────────────────────

	get isEnabled(): boolean {
		return this.cfg.enabled;
	}

	get hasApiKey(): boolean {
		return this.cfg.apiKey.length > 0;
	}

	get language(): string {
		return this.cfg.language || "auto";
	}

	get model(): string {
		return this.cfg.model;
	}

	statusLines(): string[] {
		const rec = (() => {
			try {
				return detectRecorder(this.cfg.recorder);
			} catch (err) {
				return `unavailable — ${err instanceof Error ? err.message : String(err)}`;
			}
		})();
		const mode = this.unsubscribe ? "push-to-talk (release detected)" : `push-to-talk (release gap ${this.cfg.holdReleaseGapMs}ms)`;
		return [
			`state:    ${this.cfg.enabled ? "enabled" : "disabled"} (now: ${this.phase})`,
			`key:      ${this.hasApiKey ? "GROQ_API_KEY set" : "MISSING — set GROQ_API_KEY"}`,
			`model:    ${this.cfg.model}${this.cfg.model === DEFAULT_MODEL ? "" : ` (default ${DEFAULT_MODEL})`}`,
			`language: ${this.language}`,
			`recorder: ${rec}`,
			`input:    ${mode}, meter ${this.cfg.levelMeter ? "on" : "off"}`,
			`limit:    ${this.cfg.maxDurationSeconds}s${this.cfg.silenceAutoStop ? ", silence auto-stop on" : ""}`,
			`config:   ${projectConfigPath(process.cwd())} (fallback ${globalConfigPath()})`,
			`keys:     hold alt+t to record · /listen to toggle · /stt on|off · /stt lang <code|auto>`,
		];
	}

	setEnabled(enabled: boolean): void {
		this.cfg.enabled = enabled;
		if (!enabled && this.phase === "recording") void this.stopAndTranscribe();
	}

	setLanguage(language: string): void {
		const next = language.trim().toLowerCase();
		this.cfg.language = next === "auto" || next === "" ? "" : next;
	}

	setModel(model: string): void {
		this.cfg.model = model.trim() || DEFAULT_MODEL;
	}

	// ── Helpers ─────────────────────────────────────────────────────────

	private notify(message: string, type: NotifyType = "info"): void {
		try {
			this.ctx?.ui?.notify?.(message, type);
		} catch { /* no UI (print/rpc) — nothing to do */ }
	}

	private setStatus(text: string | undefined): void {
		try {
			this.ctx?.ui?.setStatus?.("speech-to-text", text);
		} catch { /* no UI available */ }
	}

	private clearTimers(): void {
		if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
		if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }
		this.cancelWatchdog();
	}

	private closeMeter(): void {
		this.meter?.close();
		this.meter = null;
	}

	private cleanupAudio(file: string): void {
		if (this.cfg.keepAudio) return;
		try { rmSync(file, { force: true }); } catch { /* ignore */ }
	}

	/** Tear down on session shutdown. */
	async dispose(): Promise<void> {
		this.clearTimers();
		this.closeMeter();
		try { this.unsubscribe?.(); } catch { /* ignore */ }
		this.unsubscribe = null;
		const handle = this.handle;
		this.handle = null;
		this.phase = "idle";
		if (handle) {
			try { await stopRecorder(handle); } catch { /* ignore */ }
			this.cleanupAudio(handle.file);
		}
		this.setStatus(undefined);
	}
}

export default function (pi: ExtensionAPI) {
	const get = (ctx: any): SpeechToText => {
		const stt = new SpeechToText(ctx?.cwd ?? process.cwd());
		stt.ctx = ctx;
		stt.installTerminalListener();
		return stt;
	};
	let stt: SpeechToText | null = null;

	// ── Lifecycle ───────────────────────────────────────────────────────
	pi.on("session_start", async (_event: any, ctx: any) => {
		if (stt) await stt.dispose();
		stt = get(ctx);

		// Fail loudly at startup rather than on the first keypress. TUI only:
		// subagent/print sessions load this extension too and must stay quiet.
		if (ctx?.mode === "tui" && !stt.hasApiKey) {
			ctx.ui.notify(
				"Speech-to-text ready (hold alt+t), but GROQ_API_KEY is not set — get a key at https://console.groq.com/keys",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		if (stt) await stt.dispose();
		stt = null;
	});

	// ── Shortcut: hold Alt+T to record, release to transcribe ───────────
	// In the TUI the terminal input listener above consumes alt+t and handles
	// press/repeat/release precisely, so this handler only runs when that
	// listener isn't the one that saw the key (non-TUI modes, or another
	// handler consuming input first). The timestamp guard keeps the two paths
	// from double-handling the same keystroke.
	pi.registerShortcut(LISTEN_KEY, {
		description: "Speech-to-text: hold to record, release to transcribe (Groq Whisper)",
		handler: async (ctx: any) => {
			if (!stt) stt = get(ctx);
			if (Date.now() - stt.lastKeyEventAt < 300) return;
			await stt.toggle(ctx, { hold: true });
		},
	});

	// ── Commands ────────────────────────────────────────────────────────
	pi.registerCommand("listen", {
		description: "Speech-to-text: start/stop recording (press-once alternative to holding alt+t)",
		handler: async (_args: string, ctx: any) => {
			if (!stt) stt = get(ctx);
			await stt.toggle(ctx);
		},
	});

	pi.registerCommand("stt", {
		description: "Speech-to-text: status, on|off, lang <code|auto>, model <id>",
		handler: async (args: string, ctx: any) => {
			if (!stt) stt = get(ctx);
			stt.ctx = ctx;

			const [sub = "", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			switch (sub.toLowerCase()) {
				case "":
				case "status":
					ctx.ui.notify(stt.statusLines().join("\n"), "info");
					return;
				case "on":
					stt.setEnabled(true);
					ctx.ui.notify("Speech-to-text enabled. Hold alt+t to record.", "info");
					return;
				case "off":
					stt.setEnabled(false);
					ctx.ui.notify("Speech-to-text disabled.", "info");
					return;
				case "lang":
				case "language":
					if (!rest[0]) {
						ctx.ui.notify(`Language: ${stt.language}`, "info");
						return;
					}
					stt.setLanguage(rest[0]);
					ctx.ui.notify(`Speech-to-text language: ${stt.language}`, "info");
					return;
				case "model":
					if (!rest[0]) {
						ctx.ui.notify(`Model: ${stt.model}`, "info");
						return;
					}
					stt.setModel(rest[0]);
					ctx.ui.notify(`Speech-to-text model: ${stt.model}`, "info");
					return;
				default:
					ctx.ui.notify("Usage: /stt [status|on|off|lang <code|auto>|model <id>]", "warning");
			}
		},
	});
}
