// ── Integrations: tool registration + slash commands + shortcut ──

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { randomBytes } from "crypto";
import type { AgentTeamContext, BatchTaskResult } from "./core";
import { SessionLogger, displayName, shortModel } from "./core";
import { MAX_RESPONSE_LENGTH } from "./orchestration";
import { toggleSidebar } from "./ui";

// ── File helpers shared by the custom read/write/edit tools ──

/** Read `[offset, offset+limit)` lines from a file without loading the whole
 *  file into memory. Stops reading as soon as `limit` lines are collected.
 *  Line content is preserved byte-for-byte (including `\r`); only the `\n`
 *  delimiter is stripped. Throws on binary files (NUL bytes). */
async function readLineRange(
  absolutePath: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; scanned: number; complete: boolean }> {
  const stream = createReadStream(absolutePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const lines: string[] = [];
  let buf = "";
  let scanned = 0;
  try {
    for await (const chunk of stream) {
      if ((chunk as string).includes("\0")) throw new Error("file appears to be binary (contains NUL bytes)");
      buf += chunk;
      let idx: number;
      let stop = false;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        scanned++;
        if (scanned >= offset) {
          lines.push(line);
          if (lines.length >= limit) { stop = true; break; }
        }
      }
      if (stop) return { lines, scanned, complete: false };
    }
    if (buf.length > 0) {
      scanned++;
      if (scanned >= offset && lines.length < limit) lines.push(buf);
    }
    return { lines, scanned, complete: true };
  } finally {
    stream.destroy();
  }
}

/** Atomic write: write to a temp file in the same directory, then rename.
 *  Creates parent directories as needed. A crash mid-write can no longer
 *  leave a truncated target file. */
function writeFileAtomic(absolutePath: string, content: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  const tmp = `${absolutePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, absolutePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ── Side-by-side diff rendering (custom_edit result) ──

type DiffOp = { type: "same" | "del" | "add"; oldIdx?: number; newIdx?: number };

const LCS_CELL_LIMIT = 1_000_000; // fall back to block del+add above this
const DIFF_CONTEXT = 2;           // unchanged context lines around each change
const DIFF_ROW_CAP = 80;          // safety cap on rendered diff rows
const DIFF_DETAIL_CAP = 50_000;   // skip storing oldText/newText in details above this

/** Line-level LCS diff. Common prefix/suffix are trimmed first so large
 *  edits with small changes stay cheap; oversized middles degrade to a
 *  simple delete-all/add-all block instead of an O(n·m) blowup. */
function computeLineOps(oldLines: string[], newLines: string[]): DiffOp[] {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "same", oldIdx: i, newIdx: i });

  const m = oldEnd - start;
  const n = newEnd - start;
  if (m > 0 || n > 0) {
    if (m * n <= LCS_CELL_LIMIT) {
      const width = n + 1;
      const dp = new Uint32Array((m + 1) * width);
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          dp[i * width + j] = oldLines[start + i] === newLines[start + j]
            ? dp[(i + 1) * width + j + 1] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < m && j < n) {
        if (oldLines[start + i] === newLines[start + j]) { ops.push({ type: "same", oldIdx: start + i, newIdx: start + j }); i++; j++; }
        else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ type: "del", oldIdx: start + i }); i++; }
        else { ops.push({ type: "add", newIdx: start + j }); j++; }
      }
      while (i < m) { ops.push({ type: "del", oldIdx: start + i }); i++; }
      while (j < n) { ops.push({ type: "add", newIdx: start + j }); j++; }
    } else {
      for (let i = start; i < oldEnd; i++) ops.push({ type: "del", oldIdx: i });
      for (let j = start; j < newEnd; j++) ops.push({ type: "add", newIdx: j });
    }
  }

  for (let i = oldEnd; i < oldLines.length; i++) ops.push({ type: "same", oldIdx: i, newIdx: newEnd + (i - oldEnd) });
  return ops;
}

/** Build a line-numbered side-by-side diff for display in the TUI, framed in
 *  a rounded box with two equal columns (OLD │ NEW) that fit within `width`
 *  cells. Only change hunks plus DIFF_CONTEXT lines of context are shown;
 *  long unchanged runs collapse to a single marker row, overlong lines are
 *  truncated with an ellipsis so they never wrap, and the output is capped at
 *  DIFF_ROW_CAP rows so large edits cannot flood the TUI. */
function sideBySideDiff(oldText: string, newText: string, theme: any, width: number): string {
  const oldLines = oldText.length ? oldText.split("\n") : [];
  const newLines = newText.length ? newText.split("\n") : [];
  const ops = computeLineOps(oldLines, newLines);

  // Column geometry: │ left │ right │ — content columns padded to a fixed
  // width so the separators form straight vertical rules across all rows.
  const total = Math.max(24, width);
  const inner = total - 2; // cells between the outer borders
  const leftW = Math.floor((inner - 1) / 2);
  const rightW = inner - 1 - leftW;
  // Tabs would be expanded to 3 spaces by the Text component at render time,
  // so expand them here first to keep width accounting exact.
  const fit = (s: string, w: number) => {
    const t = s.replace(/\t/g, "   ");
    return t.length <= w ? t.padEnd(w) : t.slice(0, Math.max(0, w - 1)) + "…";
  };
  const border = (s: string) => theme.fg("border", s);
  const hBar = (l: string, m: string, r: string) =>
    border(l + "─".repeat(leftW) + m + "─".repeat(rightW) + r);

  // Mark ops to keep: every change plus DIFF_CONTEXT lines on each side.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "same") {
      for (let k = -DIFF_CONTEXT; k <= DIFF_CONTEXT; k++) {
        if (i + k >= 0 && i + k < ops.length) keep[i + k] = true;
      }
    }
  }

  const numWidth = String(Math.max(oldLines.length, newLines.length, 1)).length;
  const gutterWidth = numWidth + 2; // sign + number + trailing space
  const gutter = (sign: string, n: number | undefined) =>
    `${sign}${n === undefined ? " ".repeat(numWidth) : String(n).padStart(numWidth)} `;
  const sep = border("│");

  // Header row: column titles aligned with the line content (past the gutter),
  // boxed and split from the body by a separator with a column junction.
  const gutterPad = " ".repeat(gutterWidth);
  const title = fit(" comparison", inner);
  const rows: string[] = [
    border("╭") + theme.fg("toolTitle", theme.bold(title)) + border("╮"),
    border("│") +
      theme.fg("error", theme.bold(fit(gutterPad + "OLD", leftW))) +
      sep +
      theme.fg("success", theme.bold(fit(gutterPad + "NEW", rightW))) +
      border("│"),
    hBar("├", "┬", "┤"),
  ];
  let hidden = 0;
  const flushHidden = () => {
    if (hidden > 0) {
      // Full-width marker row spanning both columns (TUI style).
      rows.push(border("│") + theme.fg("dim", fit(`${gutterPad}⋮ ${hidden} unchanged`, inner)) + border("│"));
      hidden = 0;
    }
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!keep[i]) { hidden++; continue; }
    if (op.type === "same") {
      flushHidden();
      const num = gutter(" ", op.oldIdx! + 1);
      rows.push(
        border("│") +
        theme.fg("dim", fit(num + oldLines[op.oldIdx!], leftW)) + sep +
        theme.fg("dim", fit(num + newLines[op.newIdx!], rightW)) +
        border("│"),
      );
      continue;
    }
    flushHidden();
    const dels: number[] = [];
    const adds: number[] = [];
    let j = i;
    while (j < ops.length && ops[j].type !== "same") {
      if (ops[j].type === "del") dels.push(ops[j].oldIdx!);
      else adds.push(ops[j].newIdx!);
      j++;
    }
    i = j - 1;
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const d = k < dels.length ? dels[k] : undefined;
      const a = k < adds.length ? adds[k] : undefined;
      const left = d === undefined ? " ".repeat(leftW) : theme.fg("error", fit(gutter("-", d + 1) + oldLines[d], leftW));
      const right = a === undefined ? " ".repeat(rightW) : theme.fg("success", fit(gutter("+", a + 1) + newLines[a], rightW));
      rows.push(border("│") + left + sep + right + border("│"));
    }
  }
  flushHidden();
  if (rows.length > 3) rows.push(hBar("╰", "┴", "╯"));

  let note = "";
  if (rows.length > DIFF_ROW_CAP) {
    note = "\n" + theme.fg("dim", `… ${rows.length - DIFF_ROW_CAP} more diff row(s) truncated`);
    const bottom = rows.pop()!; // keep the box's bottom border visible
    rows.length = DIFF_ROW_CAP - 1;
    rows.push(bottom);
  }
  return rows.join("\n") + note;
}

/** Compatibility wrapper for Pi's strict file reader. Accepts `file` as an alias for `path`. */
export function registerCustomReadTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "custom_read",
    label: "Custom Read",
    description: "Read a file or line range. Accepts path or file, plus optional offset and limit.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const input = params as Record<string, unknown>;
      const filePath = firstStringArg(input, "path", "file");
      if (typeof filePath !== "string" || !filePath) {
        throw new Error("custom_read requires `path` or `file`.");
      }

      const absolutePath = resolve(filePath);
      if (!existsSync(absolutePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      // Rejects directories (EISDIR) and FIFOs/sockets (which would hang a read).
      if (!statSync(absolutePath).isFile()) {
        throw new Error(`Not a regular file: ${filePath}`);
      }

      const offset = typeof input.offset === "number" ? Math.max(1, Math.floor(input.offset)) : 1;
      const limit = typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : Number.POSITIVE_INFINITY;

      try {
        const { lines, scanned, complete } = await readLineRange(absolutePath, offset, limit);
        const text = lines.join("\n");
        let note = "";
        if (lines.length === 0) {
          note = complete
            ? (scanned === 0 ? "file is empty" : `offset ${offset} is past end of file (${scanned} line(s))`)
            : "no lines in requested range";
        }
        return {
          content: [{ type: "text", text: note ? (text ? `${text}\n[custom_read: ${note}]` : `[custom_read: ${note}]`) : text }],
          details: {
            ok: true,
            filePath,
            offset,
            limit: Number.isFinite(limit) ? limit : undefined,
            lines: lines.length,
            complete,
            note: note || undefined,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Read failed for ${filePath}: ${message}`);
      }
    },
    renderCall(args, theme) {
      const a = args as any;
      const filePath = a.path || a.file || "?";
      const range = [a.offset, a.limit].filter((v) => v !== undefined).join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("custom_read ")) +
        theme.fg("accent", filePath) +
        (range ? theme.fg("muted", ` (${range})`) : ""),
        0, 0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details as any;
      const text = (result.content[0] as any)?.text || "";
      if (details?.ok === false) return new Text(theme.fg("error", text), 0, 0);
      // Collapsed (Ctrl+O off): show a one-line summary only. Note that pi's
      // tool container still renders a trailing "…" line, which ends up above
      // this body — same as the built-in tools, so the affordance stays.
      if (!options?.expanded) {
        const filePath = details?.filePath || "?";
        const n = typeof details?.lines === "number" ? details.lines : 0;
        return new Text(theme.fg("dim", `— ${n} line(s) from `) + theme.fg("accent", filePath), 0, 0);
      }
      // Render with a dim line-number gutter (numbers exist only in the TUI —
      // the model receives raw text so exact-match edits keep working) and
      // cap the display so huge reads don't flood the scrollback.
      const RENDER_CAP = 400;
      const lines = text.split("\n");
      const realLines = typeof details?.lines === "number" ? details.lines : lines.length;
      const start = typeof details?.offset === "number" ? details.offset : 1;
      const shown = lines.slice(0, Math.min(realLines, RENDER_CAP));
      const width = String(start + Math.max(realLines, 1) - 1).length;
      const parts = shown.map((l: string, i: number) =>
        theme.fg("dim", `${String(start + i).padStart(width)} │ `) + theme.fg("muted", l),
      );
      if (details?.note) parts.push(theme.fg("dim", `[${details.note}]`));
      if (realLines > RENDER_CAP) parts.push(theme.fg("dim", `… ${realLines - RENDER_CAP} more line(s)`));
      return new Text(parts.join("\n"), 0, 0);
    },
  });
}

/** DeepSeek-friendly wrapper for Pi's strict file-writing tool. */
export function registerCustomWriteTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "custom_write",
    label: "Custom Write",
    description: "Write complete file contents. Accepts path/file and content/text/data aliases for DeepSeek compatibility.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      data: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const input = params as Record<string, unknown>;
      const filePath = firstStringArg(input, "path", "file");
      const content = firstStringArg(input, "content", "text", "data");
      if (typeof filePath !== "string" || !filePath || typeof content !== "string") {
        throw new Error("custom_write requires path and content (aliases file/text/data accepted).");
      }
      try {
        const absolutePath = resolve(filePath);
        writeFileAtomic(absolutePath, content);
        const bytes = Buffer.byteLength(content, "utf8");
        return {
          content: [{ type: "text", text: `Wrote ${filePath} (${bytes} bytes).` }],
          details: {
            ok: true,
            filePath,
            bytes,
            characters: content.length,
            preview: content.slice(0, 2000),
            truncated: content.length > 2000,
            result: `Wrote ${filePath}.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Write failed for ${filePath}: ${message}`);
      }
    },
    renderCall(args, theme) {
      const a = args as any;
      const filePath = a.path || a.file || "?";
      const body = a.content ?? a.text ?? a.data;
      const size = typeof body === "string" ? theme.fg("muted", ` (${body.length} chars)`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("custom_write ")) + theme.fg("accent", filePath) + size,
        0, 0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details as any;
      if (!details) return new Text((result.content[0] as any)?.text || "", 0, 0);
      if (options.isPartial) {
        return new Text(theme.fg("accent", "custom_write - writing..."), 0, 0);
      }
      if (details.ok === false) {
        return new Text(theme.fg("error", "✗ ") + theme.fg("muted", (result.content[0] as any)?.text || "Write failed"), 0, 0);
      }
      const header = theme.fg("success", "✓ ") +
        theme.fg("accent", details.filePath || "?") +
        theme.fg("muted", ` — ${details.bytes ?? 0} bytes (${details.characters ?? 0} chars)`);
      if (!options.expanded) return new Text(header, 0, 0);
      const previewLines = (typeof details.preview === "string" ? details.preview : "").split("\n").slice(0, 12);
      const width = String(previewLines.length).length;
      const body = previewLines.map((l: string, i: number) =>
        theme.fg("dim", `${String(i + 1).padStart(width)} │ `) + theme.fg("muted", l),
      ).join("\n");
      const more = details.truncated ? "\n" + theme.fg("dim", "… (preview truncated)") : "";
      return new Text(header + "\n" + body + more, 0, 0);
    },
  });
}

/** DeepSeek-friendly replacement for Pi's strict exact-match edit tool. */
export function registerCustomEditTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "custom_edit",
    label: "Custom Edit",
    description: "Safely replace text in a file. Accepts path/file, oldString/old_text/search, and newString/new_text/replace aliases.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()), file: Type.Optional(Type.String()),
      oldString: Type.Optional(Type.String()), old_string: Type.Optional(Type.String()), old_text: Type.Optional(Type.String()), search: Type.Optional(Type.String()),
      newString: Type.Optional(Type.String()), new_string: Type.Optional(Type.String()), new_text: Type.Optional(Type.String()), replace: Type.Optional(Type.String()),
      replaceAll: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      const input = params as Record<string, unknown>;
      const filePath = firstStringArg(input, "path", "file");
      const oldText = firstStringArg(input, "oldString", "old_string", "old_text", "search");
      const newText = firstStringArg(input, "newString", "new_string", "new_text", "replace");
      if (typeof filePath !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
        throw new Error("custom_edit requires path, oldString, and newString (aliases accepted).");
      }
      const absolutePath = resolve(filePath);
      if (!existsSync(absolutePath)) throw new Error(`File not found: ${filePath}`);
      if (!statSync(absolutePath).isFile()) throw new Error(`Not a regular file: ${filePath}`);
      if (oldText.length === 0) throw new Error("oldString must not be empty.");
      if (oldText === newText) throw new Error("oldString and newString are identical; nothing to change.");
      try {
        const content = readFileSync(absolutePath, "utf8");
        if (content.includes("\0")) throw new Error(`Refusing to edit binary file: ${filePath}`);
        const matches = content.split(oldText).length - 1;
        if (matches === 0) throw new Error(`No match found in ${filePath}; re-read and retry.`);
        if (matches > 1 && input.replaceAll !== true) throw new Error(`Found ${matches} matches; provide a more specific search or set replaceAll=true.`);
        const updated = input.replaceAll === true ? content.split(oldText).join(newText) : content.replace(oldText, newText);
        writeFileAtomic(absolutePath, updated);
        // Avoid storing huge old/new strings in session details: above
        // DIFF_DETAIL_CAP the render falls back to a summary instead.
        const keepDiff = oldText.length + newText.length <= DIFF_DETAIL_CAP;
        return {
          content: [{ type: "text", text: `Updated ${filePath} (${matches} replacement${matches > 1 ? "s" : ""}).` }],
          details: {
            ok: true,
            matches,
            filePath,
            oldLines: oldText.split("\n").length,
            newLines: newText.split("\n").length,
            oldText: keepDiff ? oldText : undefined,
            newText: keepDiff ? newText : undefined,
            diffOmitted: !keepDiff,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Edit failed for ${filePath}: ${message}`);
      }
    },
    renderCall(args, theme) {
      const a = (args as any);
      const fp = a.path || a.file || "?";
      // Flatten newlines so multi-line oldString values can't break the header layout.
      const t = String(a.oldString || a.old_string || a.old_text || a.search || "").replace(/\r/g, "").replace(/\n/g, "⏎");
      return new Text(
        theme.fg("toolTitle", theme.bold("custom_edit ")) +
        theme.fg("accent", `${fp} - `) +
        theme.fg("muted", `${t.slice(0, 60)}${t.length > 60 ? "…" : ""}`),
        0, 0,
      );
    },
    renderResult(result, options, theme) {
      const d = result.details as any;
      if (!d) return new Text((result.content[0] as any)?.text || "", 0, 0);
      if (options.isPartial) {
        return new Text(theme.fg("accent", "custom_edit - editing..."), 0, 0);
      }
      if (d.ok !== true) {
        const msg = (result.content[0] as any)?.text || "Edit failed";
        return new Text(theme.fg("error", "✗ ") + theme.fg("muted", msg), 0, 0);
      }
      // Success — build side-by-side diff (or a summary for oversized edits).
      // Collapsed (Ctrl+O off): header line only; expanded shows the full diff.
      const fp = d.filePath || "?";
      const header = theme.fg("success", "✓ ") + theme.fg("accent", fp) +
        (d.matches > 1 ? theme.fg("muted", ` (${d.matches} replacements)`) : "");
      if (!options.expanded) return new Text(header, 0, 0);
      if (d.diffOmitted || typeof d.oldText !== "string" || typeof d.newText !== "string") {
        return new Text(header + "\n" + theme.fg("dim", `(large edit: ${d.oldLines ?? "?"} → ${d.newLines ?? "?"} lines, diff omitted)`), 0, 0);
      }
      // Fit the two-column diff to the terminal: the tool result renders in a
      // Box with 1-cell padding on each side, and 1 extra cell of slack keeps
      // long rows from wrapping if the surrounding chrome changes.
      const termWidth = typeof process.stdout?.columns === "number" ? process.stdout.columns : 80;
      return new Text(header + "\n" + sideBySideDiff(d.oldText, d.newText, theme, termWidth - 3), 0, 0);
    },
  });
}

/** First present string among a tool input's alias keys (deepseek-style
 *  `path`/`file`, `content`/`text`/`data`, …). Returns undefined when none
 *  of the aliases is a string — callers reject with their own message. */
function firstStringArg(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Shared "✓/✗ label - N task(s), F failed (Xs)" summary line used by both
 *  dispatch tools' batch renderResults, so the wording can't drift apart.
 *  `withElapsed` appends the aggregate elapsed seconds (dispatch_agent only —
 *  dispatch_agents carries no aggregate elapsed in its details). */
function batchSummary(d: any, label: string, withElapsed: boolean): [string, string] {
  const results: any[] = d.results ?? [];
  const n = results.length;
  const fails = results.filter(r => r.code !== 0).length;
  const ok = d.status === "done" && fails === 0;
  const elapsed = withElapsed && typeof d.elapsed === "number" ? ` (${Math.round(d.elapsed / 1000)}s)` : "";
  return [ok ? "success" : "error", `${ok ? "✓" : "✗"} ${label} - ${n} task(s)${fails ? `, ${fails} failed` : ""}${elapsed}`];
}

/** Standard result returned when a dispatch tool runs while the team is off. */
const TEAM_DISABLED_RESULT = { content: [{ type: "text" as const, text: "Agent team is disabled. /agents-team-toggle on" }], details: {} };

/** Truncate a subagent output to the tool-result cap (keeps the tail). */
function capOutput(out: string): string {
  return out.length > MAX_RESPONSE_LENGTH ? out.slice(-MAX_RESPONSE_LENGTH) : out;
}

/** Format batch results as markdown sections joined by "---". `includeAgent`
 *  adds the agent name to the section header (dispatch_agents spans multiple
 *  agents; dispatch_agent's multi-task mode always reports one). Sets
 *  `anyFail` when any result exited non-zero. Shared by both dispatch tools.
 *
 *  Individual outputs are capped at MAX_RESPONSE_LENGTH, but when many
 *  subagents run in parallel the combined text can still be N× that limit.
 *  An overall cap (with a clear truncation marker) prevents the downstream
 *  orchestrator from receiving a silently-truncated result. */
function formatBatchParts(results: BatchTaskResult[], includeAgent: boolean): { text: string; anyFail: boolean } {
  let anyFail = false;

  // Build parts one at a time, tracking total size so we can stop before
  // the combined output exceeds the cap. Always include at least the first
  // result; subsequent results are added only if there is headroom.
  let combined = "";
  let included = 0;
  for (const res of results) {
    if (res.code !== 0) anyFail = true;
    const status = res.code === 0 ? "done" : "error";
    const header = includeAgent ? `### ${res.agent}\n${res.task}` : `### ${res.task}`;
    const part = `${header}\n→ ${status} (${Math.round(res.elapsed / 1000)}s)\n\n${capOutput(res.output)}`;
    const separator = included > 0 ? "\n\n---\n\n" : "";
    if (combined.length + separator.length + part.length > MAX_RESPONSE_LENGTH && included > 0) {
      const remaining = results.length - included;
      combined += `\n\n---\n\n… [${remaining} more result(s) truncated — combined output exceeded ${MAX_RESPONSE_LENGTH} chars]`;
      break;
    }
    combined += separator + part;
    included++;
  }

  return { text: combined, anyFail };
}

/** Get agent display info: [name][model] tag */
function agentTag(team: AgentTeamContext, name: string): string {
  const apRef = team.procs.get(name.toLowerCase());
  return `[${name}][${apRef ? shortModel(apRef.model) : "?"}]`;
}

export function registerDispatchAgentTool(pi: ExtensionAPI, team: AgentTeamContext) {
  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description: "Delegate one independent task to a specialist in a fresh isolated process. The worker sees no orchestrator context, other workers, or unsaved reasoning, so include objective, scope, relevant paths/symbols and snippets, constraints, acceptance criteria, and an explicit output format with status, evidence, errors, and uncertainty. Use one consolidated dispatch for related writable edits; never overlap writes. For large generated files, provide a path and specification rather than pasting the entire file.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name (case-insensitive)" }),
      task: Type.String({ description: "Task description for the agent. Use this OR `tasks`." }),
      tasks: Type.Optional(Type.Array(Type.String(), { description: "Multiple task descriptions for the SAME agent — spawns one isolated subagent per task (parallel for read-only agents, serialized for writable ones). When dispatching multiple instances of the same agent partition the work (URLs, queries, files) so each task is distinct to avoid duplicate work. For writable agents prefer a single consolidated `task` over many small `tasks` — they run serialized with a cold start each. Use instead of `task`." })),
    }),

    async execute(_id, params, signal, onUpdate, _ctx) {
      const { agent, task, tasks } = params as { agent: string; task?: string; tasks?: string[] };
      if (!team.enabled) return TEAM_DISABLED_RESULT;

      const multi = Array.isArray(tasks) && tasks.length > 0;
      const single = typeof task === "string" && task.trim().length > 0;
      if (!multi && !single) {
        return {
          content: [{ type: "text", text: "dispatch_agent requires either `task` (string) or non-empty `tasks` (array of strings for the same agent)." }],
          details: {},
        };
      }

      // Listen for ESC / abort signal — kill the shared team-member proc
      // if this is a single dispatch. Multi-task clones are aborted via the
      // signal passed to dispatchAgentMany, which scopes termination to
      // only the clones it created for this call.
      let abortHandler: (() => void) | undefined;
      try {
        const tag = agentTag(team, agent);

        onUpdate?.({
          content: [{ type: "text", text: `${tag} - ${multi ? `dispatching ${tasks!.length} task(s)...` : "dispatching..."}` }],
          details: { agent, task, tasks, status: "dispatching", multi },
        });

        if (signal) {
          const capturedAp = team.procs.get(agent.toLowerCase());
          abortHandler = () => {
            if (capturedAp && (capturedAp.status === "running" || capturedAp.status === "starting")) {
              team.logger.logErrorBox(capturedAp, "ABORTED", "User pressed ESC");
              team.killProc(capturedAp, true);
              team.wipeSessionFile(capturedAp);
              capturedAp.status = "dead";
              team.invalidate();
            }
          };
          signal.addEventListener("abort", abortHandler);
        }

        // Normalize to an aggregated batch result so single + multi
        // paths share one formatting/truncation path below.
        let aggregate: { ok: boolean; error?: string; results: Array<{ agent: string; task: string; output: string; code: number; elapsed: number; error: string | null }> };
        if (multi) {
          const r = await team.dispatchAgentMany(agent, tasks as string[], signal);
          if (!r.ok) {
            if (team.wCtx) team.wCtx.ui.notify(`${tag} rejected`, "error");
            return {
              content: [{ type: "text", text: `dispatch_agent rejected: ${r.error}` }],
              details: { agent, tasks, status: "error", error: r.error },
            };
          }
          aggregate = r;
        } else {
          const r = await team.dispatch(agent, task as string);
          aggregate = { ok: true, results: [{ agent, task: task as string, output: r.output, code: r.code, elapsed: r.elapsed, error: null }] };
        }

        const batch = multi
          ? formatBatchParts(aggregate.results, false)
          : { text: "", anyFail: aggregate.results.some(r => r.code !== 0) };
        const anyFail = batch.anyFail;

        const finalOutput = multi ? batch.text : capOutput(aggregate.results[0].output);

        const totalElapsed = aggregate.results.reduce((s, r) => s + r.elapsed, 0);
        const status = anyFail ? "error" : "done";
        const summary = `${tag} - ${status} in ${Math.round(totalElapsed / 1000)}s`;

        if (anyFail && team.wCtx) team.wCtx.ui.notify(summary, "error");

        return {
          content: [{ type: "text", text: finalOutput }],
          details: { agent, task: single ? task : undefined, tasks: multi ? tasks : undefined, status, elapsed: totalElapsed, exitCode: anyFail ? 1 : 0, multi, fullOutput: finalOutput, results: multi ? aggregate.results : undefined },
        };
      } catch (err: any) {
        if (team.wCtx) team.wCtx.ui.notify(`[${agent}] Error: ${err?.message || err}`, "error");
        return {
          content: [{ type: "text", text: `Error dispatching ${agent}: ${err?.message || err}. The orchestrator should inform the user.` }],
          details: { agent, task, tasks, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
        };
      } finally {
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      }
    },

    renderCall(args, theme) {
      const a = (args as any).agent || "?";
      const t = (args as any).task || "";
      const tasksArr = (args as any).tasks;
      const multiLabel = Array.isArray(tasksArr) && tasksArr.length > 1 ? ` (${tasksArr.length} tasks)` : "";
      const text = t || (Array.isArray(tasksArr) ? `${tasksArr.length} task(s)` : "");
      return new Text(
        theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
        theme.fg("accent", `${agentTag(team, a)}${multiLabel} - `) +
        theme.fg("muted", text),
        0, 0,
      );
    },

    renderResult(result, options, theme) {
      const d = result.details as any;
      if (!d) return new Text((result.content[0] as any)?.text || "", 0, 0);

      const tag = agentTag(team, d.agent || "?");

      if (options.isPartial || d.status === "dispatching") {
        return new Text(
          theme.fg("accent", `${tag} - working...`),
          0, 0,
        );
      }

      if (d.multi && d.results) {
        const [sumColor, sumText] = batchSummary(d, `${tag} -`, true);
        const header = theme.fg(sumColor as any, sumText);
        if (options.expanded && d.fullOutput) {
          return new Text(header + "\n" + theme.fg("muted", d.fullOutput), 0, 0);
        }
        return new Text(header, 0, 0);
      }

      const icon = d.status === "done" ? "✓" : "✗";
      const color = d.status === "done" ? "success" : "error";
      const elapsed = typeof d.elapsed === "number" ? Math.round(d.elapsed / 1000) : 0;
      const header = theme.fg(color, `${icon} ${tag} - ${elapsed}s`);

      if (options.expanded && d.fullOutput) {
        return new Text(header + "\n" + theme.fg("muted", d.fullOutput), 0, 0);
      }

      return new Text(header, 0, 0);
    },
  });
}

export function registerDispatchAgentsTool(pi: ExtensionAPI, team: AgentTeamContext) {
  pi.registerTool({
    name: "dispatch_agents",
    label: "Dispatch Agents (parallel, read-only)",
    description:
      "Run independent READ-ONLY tasks concurrently and return every result labeled by agent and task. " +
      "Each task must have a distinct non-overlapping scope and include objective, context, acceptance criteria, and output/evidence requirements. " +
      "Only read-only agents are allowed; writable agents must use dispatch_agent and must never overlap file mutations. " +
      "Treat non-zero exits, timeouts, empty/malformed output, and BLOCKED results as failures surfaced to the orchestrator.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          agent: Type.String({ description: "Agent name (case-insensitive)" }),
          task: Type.String({ description: "Task description for the agent" }),
        }),
        { description: "Independent read-only lookups to run concurrently." },
      ),
    }),

    async execute(_id, params, signal, onUpdate, _ctx) {
      const { tasks } = params as { tasks: Array<{ agent: string; task: string }> };
      if (!team.enabled) {
        return TEAM_DISABLED_RESULT;
      }
      if (!team.parallelDispatch) {
        return {
          content: [{
            type: "text",
            text: "Parallel dispatch is disabled. Enable with /agents-parallel on, or use dispatch_agent for each agent.",
          }],
          details: {},
        };
      }
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return {
          content: [{ type: "text", text: "dispatch_agents requires a non-empty `tasks` array of {agent, task}." }],
          details: {},
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `dispatch_agents - dispatching ${tasks.length} read-only task(s) in parallel...` }],
        details: { count: tasks.length, status: "dispatching" },
      });

      const r = await team.dispatchMany(tasks, signal);

      if (!r.ok) {
        if (team.wCtx) team.wCtx.ui.notify(`dispatch_agents rejected`, "error");
        return {
          content: [{ type: "text", text: `dispatch_agents rejected: ${r.error}` }],
          details: { status: "error", error: r.error },
        };
      }

      const { text: combined, anyFail } = formatBatchParts(r.results, true);

      return {
        content: [{ type: "text", text: combined }],
        details: { status: anyFail ? "error" : "done", results: r.results, fullOutput: combined },
      };
    },

    renderCall(args, theme) {
      const list = (args as any).tasks || [];
      const names = list.map((t: any) => t.agent).join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("dispatch_agents ")) +
        theme.fg("accent", `(${list.length}) `) +
        theme.fg("muted", names),
        0, 0,
      );
    },

    renderResult(result, options, theme) {
      const d = result.details as any;
      if (!d) return new Text((result.content[0] as any)?.text || "", 0, 0);
      if (options.isPartial || d.status === "dispatching") {
        return new Text(theme.fg("accent", `dispatch_agents - working...`), 0, 0);
      }
      const [sumColor, sumText] = batchSummary(d, "dispatch_agents -", false);
      return new Text(theme.fg(sumColor as any, sumText), 0, 0);
    },
  });
}

export function registerCommands(pi: ExtensionAPI, team: AgentTeamContext) {
  pi.registerCommand("agents-team", {
    description: "Select a team",
    handler: async (_args, ctx) => {
      team.wCtx = ctx;
      const names = Object.keys(team.teams);
      if (!names.length) { ctx.ui.notify("No teams defined", "warning"); return; }

      const opts = names.map(n => {
        const m = team.teams[n].map(t => displayName(t.name)).join(", ");
        return `${n} - ${m}`;
      });

      const choice = await ctx.ui.select("Select Team", opts);
      if (choice === undefined) return;

      const name = names[opts.indexOf(choice)];
      await team.activateTeam(name);
      team.invalidate();
      ctx.ui.setStatus("agent-team", `Team: ${name} (${team.procs.size})`);
      ctx.ui.notify(`Team: ${name} - ${Array.from(team.procs.values()).map(a => displayName(a.def.name)).join(", ")}`, "info");
    },
  });

  pi.registerCommand("agents-list", {
    description: "List agents + process status",
    handler: async (_args, ctx) => {
      team.wCtx = ctx;
      const list = Array.from(team.procs.values())
        .map(a => {
          const alive = a.proc ? "alive" : "dead";
          return `${displayName(a.def.name)} [${a.status}|${alive}|runs:${a.runCount}] ${a.def.description}`;
        })
        .join("\n");
      ctx.ui.notify(list || "No agents loaded", "info");
    },
  });

  pi.registerCommand("agents-grid", {
    description: "Set grid columns: /agents-grid <1-6>",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = ["1", "2", "3", "4", "5", "6"].map(n => ({ value: n, label: `${n} columns` }));
      const f = items.filter(i => i.value.startsWith(prefix));
      return f.length ? f : items;
    },
    handler: async (args, ctx) => {
      team.wCtx = ctx;
      const n = parseInt(args?.trim() || "", 10);
      if (n >= 1 && n <= 6) {
        team.gridCols = n;
        team.persist();
        ctx.ui.notify(`Grid: ${team.gridCols} columns`, "info");
        team.invalidate();
      } else {
        ctx.ui.notify("Usage: /agents-grid <1-6>", "error");
      }
    },
  });

  pi.registerCommand("agents-team-toggle", {
    description: "Enable/disable agent team (on/off/status)",
    handler: async (args, ctx) => {
      const sub = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (sub === "on") {
        await team.enableAgentTeam(ctx);
        const members = Array.from(team.procs.values()).map(a => displayName(a.def.name)).join(", ");
        await ctx.ui.notify(`✓ Agent team enabled — Team: ${team.activeTeam} (${members}) — agents spawn on-demand`);
      } else if (sub === "off") {
        await team.disableAgentTeam(ctx);
        await ctx.ui.notify("✓ Agent team disabled - all subagent processes killed");
      } else if (sub === "status") {
        await ctx.ui.notify(team.enabled ? "Agent team is enabled" : "Agent team is disabled");
      } else {
        await ctx.ui.notify("Usage: /agents-team-toggle on|off|status");
      }
    },
  });

  pi.registerCommand("agents-debug", {
    description: "Set dispatch-pipeline debug level: /agents-debug [0|1|2|status]",
    handler: async (args, ctx) => {
      team.wCtx = ctx;
      const sub = (args?.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (sub === "status") {
        const label = team.debugLevel === 0 ? "OFF" : team.debugLevel === 2 ? "2 (lifecycle + raw JSONL)" : "1 (lifecycle)";
        const logPath = SessionLogger.debugLogPath() || "<sessionDir>/agent-team-debug.log";
        ctx.ui.notify(`Debug level: ${label}. Lifecycle log: ${logPath}. Level 2 also writes per-dispatch <agent>-debug.jsonl traces.`, "info");
        return;
      }
      const n = parseInt(sub, 10);
      if (!(n === 0 || n === 1 || n === 2)) {
        ctx.ui.notify("Usage: /agents-debug <0|1|2|status>", "error");
        return;
      }
      team.debugLevel = n;
      SessionLogger.debugLevel = n; // statics are read on the hot dispatch path
      team.persist();
      const logPath = SessionLogger.debugLogPath() || "<sessionDir>/agent-team-debug.log";
      ctx.ui.notify(
        n === 0
          ? "Debug: OFF"
          : n === 1
            ? `Debug: 1 — dispatch lifecycle events appended to ${logPath}.`
            : `Debug: 2 — lifecycle events + per-dispatch raw JSONL traces under ${SessionLogger.debugDir || "<sessionDir>"}/.`,
        "info",
      );
      team.invalidate();
    },
  });

  pi.registerCommand("agents-parallel", {
    description: "Toggle GLOBAL parallelism (subagent dispatch + host tool calls): /agents-parallel [on|off|status] [max N]",
    handler: async (args, ctx) => {
      team.wCtx = ctx;
      const tokens = (args?.trim().split(/\s+/).filter(Boolean) ?? []).map(t => t.toLowerCase());
      let changed = false;
      let note = "";
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "on") { team.parallelDispatch = true; changed = true; }
        else if (t === "off") { team.parallelDispatch = false; changed = true; }
        else if (t === "status") { /* report only */ }
        else if (t === "max") {
          const n = parseInt(tokens[++i] ?? "", 10);
          if (Number.isFinite(n) && n >= 1 && n <= 20) { team.maxParallel = n; changed = true; }
          else note += "Invalid max (1-20). ";
        } else if (t.startsWith("max=")) {
          const n = parseInt(t.slice(4), 10);
          if (Number.isFinite(n) && n >= 1 && n <= 20) { team.maxParallel = n; changed = true; }
          else note += "Invalid max (1-20). ";
        } else {
          note += `Unknown arg "${t}". `;
        }
      }
      if (changed) {
        team.persist();
        pi.setActiveTools(team.activeToolList());
        team.invalidate();
      }
      const mode = team.parallelDispatch ? "ON" : "OFF";
      ctx.ui.notify(
        `${note}Parallelism: ${mode} — covers subagent dispatch AND host tool calls (read/grep/find/ls); writes always serialized.${changed ? ` Max ${team.maxParallel} concurrent read-only subagents.` : ""}`,
        "info",
      );
    },
  });
}


export function registerShortcut(pi: ExtensionAPI, team: AgentTeamContext) {
  pi.registerShortcut("ctrl+q", {
    description: "Toggle agent team sidebar",
    handler: async (ctx) => {
      if (!team.enabled) return;
      team.wCtx = ctx;
      toggleSidebar(team);
    },
  });

  pi.registerShortcut("ctrl+shift+e", {
    description: "Toggle agent team on/off",
    handler: async (ctx) => {
      team.wCtx = ctx;
      if (team.enabled) {
        await team.disableAgentTeam(ctx);
        ctx.ui.notify("✓ Agent team disabled", "info");
      } else {
        await team.enableAgentTeam(ctx);
        const members = Array.from(team.procs.values()).map(a => displayName(a.def.name)).join(", ");
        ctx.ui.setStatus("agent-team", `Team: ${team.activeTeam} (${team.procs.size})`);
        ctx.ui.notify(`✓ Agent team enabled — Team: ${team.activeTeam} (${members})`, "info");
      }
    },
  });

}
