// Turns a Paperclip run log into what a Claude Code terminal shows: the assistant's words, each
// tool call with its input, the result under it, and how the run ended. The log is NDJSON of
// {ts, stream, chunk}; stdout chunks hold Claude's stream-json, and a JSON line can be split
// across chunks, so stdout is joined before it is split into lines.

import type { Entry } from "./api-types.ts";
export type { Entry };

const RESULT_CHARS = 1600;

export function parseLog(ndjson: string): Entry[] {
  let stdout = "";
  const stamps: { at: number; ts: string }[] = [];
  const stderr: string[] = [];
  for (const raw of ndjson.split("\n")) {
    if (!raw.trim()) continue;
    let rec: { ts?: string; stream?: string; chunk?: string };
    try {
      rec = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof rec.chunk !== "string") continue;
    if (rec.stream === "stderr") {
      stderr.push(rec.chunk);
      continue;
    }
    stamps.push({ at: stdout.length, ts: rec.ts ?? "" });
    stdout += rec.chunk;
  }

  const entries: Entry[] = [];
  let offset = 0;
  for (const line of stdout.split("\n")) {
    const at = stampAt(stamps, offset);
    offset += line.length + 1;
    if (!line.trim().startsWith("{")) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    entries.push(...toEntries(msg, at));
  }
  const err = stderr.join("").trim();
  if (err && !entries.some((e) => e.kind === "done")) entries.push({ kind: "error", at: stamps.at(-1)?.ts ?? "", text: err.slice(-1200) });
  return entries;
}

function stampAt(stamps: { at: number; ts: string }[], offset: number): string {
  let ts = stamps[0]?.ts ?? "";
  for (const s of stamps) {
    if (s.at > offset) break;
    ts = s.ts;
  }
  return ts;
}

export function toEntries(msg: Record<string, unknown>, at: string): Entry[] {
  const type = msg.type;
  if (type === "system" && msg.subtype === "init") {
    return [{ kind: "start", at, model: String(msg.model ?? ""), cwd: String(msg.cwd ?? "") }];
  }
  if (type === "assistant" || type === "user") {
    const content = ((msg.message as { content?: unknown })?.content ?? []) as Record<string, unknown>[];
    if (!Array.isArray(content)) return [];
    const out: Entry[] = [];
    for (const c of content) {
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
        if (type === "assistant") out.push({ kind: "text", at, text: c.text.trim() });
      } else if (c.type === "tool_use") {
        const input = (c.input ?? {}) as Record<string, unknown>;
        out.push({ kind: "tool", at, id: String(c.id ?? ""), name: String(c.name ?? "tool"), summary: summarize(String(c.name ?? ""), input), detail: detailOf(String(c.name ?? ""), input) });
      } else if (c.type === "tool_result") {
        const text = resultText(c.content);
        out.push({ kind: "result", at, toolId: String(c.tool_use_id ?? ""), text: text.length > RESULT_CHARS ? text.slice(0, RESULT_CHARS) + "\n…" : text, isError: c.is_error === true, lines: text.split("\n").length });
      }
    }
    return out;
  }
  if (type === "result") {
    return [{
      kind: "done",
      at,
      text: String(msg.result ?? ""),
      isError: msg.is_error === true,
      durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : null,
      turns: typeof msg.num_turns === "number" ? msg.num_turns : null,
    }];
  }
  return [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join("\n");
  return "";
}

// The one-line form Claude Code prints: Bash(npm test), Read(src/index.ts), Edit(package.json).
function summarize(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const short = (p: string) => p.split("/").slice(-2).join("/");
  switch (name) {
    case "Bash":
      return s("command").split("\n")[0]!.slice(0, 160);
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return short(s("file_path"));
    case "Glob":
    case "Grep":
      return s("pattern").slice(0, 100);
    case "Skill":
      return s("skill") || s("name");
    case "TodoWrite":
      return `${Array.isArray(input.todos) ? input.todos.length : 0} items`;
    default:
      return Object.values(input).filter((v) => typeof v === "string").map((v) => (v as string).slice(0, 60))[0] ?? "";
  }
}

// What a terminal shows under the call when it is expanded: the full command, or an edit's diff.
function detailOf(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  if (name === "Bash") return s("command").includes("\n") ? s("command").slice(0, 2000) : "";
  if (name === "Edit") {
    const minus = s("old_string").split("\n").slice(0, 12).map((l) => `- ${l}`);
    const plus = s("new_string").split("\n").slice(0, 12).map((l) => `+ ${l}`);
    return [...minus, ...plus].join("\n");
  }
  if (name === "Write") return s("content").split("\n").slice(0, 16).join("\n");
  // a to-do list as a checklist: done, in progress, still to do
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    return (input.todos as { content?: unknown; status?: unknown }[]).map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "·"} ${String(t.content ?? "")}`).join("\n");
  }
  return "";
}
