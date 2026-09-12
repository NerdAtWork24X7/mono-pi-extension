/**
 * Speech-to-Text — Groq transcription client.
 *
 * POSTs a WAV file to Groq's OpenAI-compatible transcription endpoint
 * (https://console.groq.com/docs/speech-to-text). Uses the global fetch /
 * FormData / Blob available in Node >= 20.6, so no dependencies are needed.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SttConfig } from "./config";

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

export interface TranscriptionResult {
	text: string;
	model: string;
	/** Wall-clock duration of the API call in ms. */
	elapsedMs: number;
}

/** Turn a non-2xx Groq response into a message a human can act on. */
function describeError(status: number, body: string): string {
	const snippet = body.replace(/\s+/g, " ").trim().slice(0, 300);
	if (status === 401 || status === 403) {
		return `Groq rejected the API key (HTTP ${status}). Check GROQ_API_KEY. ${snippet}`;
	}
	if (status === 413) {
		return `Recording too large for Groq (HTTP 413). Try a shorter clip. ${snippet}`;
	}
	if (status === 429) {
		return `Groq rate limit hit (HTTP 429). Wait a moment and retry. ${snippet}`;
	}
	return `Groq transcription failed (HTTP ${status}). ${snippet}`;
}

/** Transcribe a local audio file. Throws with a user-facing message on failure. */
export async function transcribe(cfg: SttConfig, file: string): Promise<TranscriptionResult> {
	if (!cfg.apiKey) throw new Error("GROQ_API_KEY is not set. Export it, or add \"apiKey\" to speech-to-text.json.");

	const audio = await readFile(file);
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), basename(file));
	form.append("model", cfg.model);
	form.append("response_format", "json");
	form.append("temperature", "0");
	if (cfg.language) form.append("language", cfg.language);
	if (cfg.prompt) form.append("prompt", cfg.prompt);

	const startedAt = Date.now();
	let res: Response;
	try {
		res = await fetch(ENDPOINT, {
			method: "POST",
			headers: { Authorization: `Bearer ${cfg.apiKey}` },
			body: form,
		});
	} catch (err) {
		throw new Error(`Could not reach Groq: ${err instanceof Error ? err.message : String(err)}`);
	}

	const raw = await res.text();
	if (!res.ok) throw new Error(describeError(res.status, raw));

	let text = "";
	try {
		const parsed = JSON.parse(raw) as { text?: unknown };
		text = typeof parsed.text === "string" ? parsed.text : "";
	} catch {
		throw new Error(`Unexpected Groq response: ${raw.slice(0, 300)}`);
	}

	return { text: text.trim(), model: cfg.model, elapsedMs: Date.now() - startedAt };
}

/** List models available to this key that can transcribe (best-effort). */
export async function listModels(cfg: SttConfig): Promise<string[]> {
	if (!cfg.apiKey) return [];
	try {
		const res = await fetch("https://api.groq.com/openai/v1/models", {
			headers: { Authorization: `Bearer ${cfg.apiKey}` },
		});
		if (!res.ok) return [];
		const data = (await res.json()) as { data?: Array<{ id?: string }> };
		return (data.data ?? [])
			.map((m) => m.id ?? "")
			.filter((id) => /whisper|distil/i.test(id));
	} catch {
		return [];
	}
}
