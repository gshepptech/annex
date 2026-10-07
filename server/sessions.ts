// Your own Claude Code sessions, read from the logs Claude Code writes for every session on this
// machine (~/.claude/projects/<project>/<session>.jsonl). Watch only: Annex never writes to them.
// Annex's own agents also run Claude Code, in its worktrees; those are left out, since they
// already appear in their offices.

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Entry, SessionView, SessionTranscript } from "./api-types.ts";
import { toEntries } from "./transcript.ts";


export const PROJECTS = join(homedir(), ".claude", "projects");
// A session touched this recently may be open in a terminal; a reply then would fork the
// conversation behind the person's back, so Annex waits.
export const IDLE_MS = 3 * 60_000;
const MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk"]);
const replying = new Set<string>();
// A session whose log moved this recently is mid-turn.
const WORKING_MS = 20_000;
// The end of a log holds everything the list needs; a transcript reads more of it.
const LIST_BYTES = 192 * 1024;
const TRANSCRIPT_BYTES = 1536 * 1024;

// Annex's agents work in Paperclip's workspaces and Annex's own worktrees.
export function isAnnexAgent(cwd: string): boolean {
  return cwd.includes("/.paperclip/") || cwd.includes("/.annex/") || cwd.includes("/.annex/");
}

function tail(file: string, bytes: number): string[] {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    // the first line is cut in half unless the whole file fit
    return len < size ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

function records(lines: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of lines) {
    if (!l.startsWith("{")) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // a line still being written
    }
  }
  return out;
}

function describe(id: string, recs: Record<string, unknown>[], mtime: Date, now: number): SessionView | null {
  let cwd = "";
  let branch: string | null = null;
  let model: string | null = null;
  let title: string | null = null;
  let lastPrompt: string | null = null;
  let permissionMode: string | null = null;
  for (const r of recs) {
    if (r.type === "permission-mode" && typeof r.permissionMode === "string") permissionMode = r.permissionMode;
    // the project is where the session started; it may have changed into a subfolder since
    if (typeof r.cwd === "string" && (!cwd || r.cwd.length < cwd.length)) cwd = r.cwd;
    if (typeof r.gitBranch === "string" && r.gitBranch) branch = r.gitBranch;
    if (r.type === "custom-title" && typeof r.customTitle === "string") title = r.customTitle;
    if (r.type === "last-prompt" && typeof r.lastPrompt === "string") lastPrompt = r.lastPrompt;
    const m = (r.message as { model?: unknown } | undefined)?.model;
    if (r.type === "assistant" && typeof m === "string" && !m.startsWith("<")) model = m;
  }
  if (!cwd || isAnnexAgent(cwd)) return null;
  return {
    id,
    title: title ?? basename(cwd),
    cwd,
    branch,
    model,
    status: now - mtime.getTime() < WORKING_MS ? "working" : "idle",
    updatedAt: mtime.toISOString(),
    lastPrompt,
    permissionMode,
    replying: replying.has(id),
  };
}

// Sessions whose log changed within `withinMs`, newest first.
export function listSessions(opts: { root?: string; withinMs?: number; limit?: number; now?: number } = {}): SessionView[] {
  const root = opts.root ?? PROJECTS;
  const now = opts.now ?? Date.now();
  const since = now - (opts.withinMs ?? 12 * 3600_000);
  if (!existsSync(root)) return [];
  const files: { id: string; file: string; mtime: Date }[] = [];
  for (const dir of readdirSync(root)) {
    let names: string[];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const file = join(root, dir, n);
      const mtime = statSync(file).mtime;
      if (mtime.getTime() >= since) files.push({ id: n.slice(0, -6), file, mtime });
    }
  }
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const out: SessionView[] = [];
  for (const f of files) {
    const s = describe(f.id, records(tail(f.file, LIST_BYTES)), f.mtime, now);
    if (s) out.push(s);
    if (out.length >= (opts.limit ?? 8)) break;
  }
  return out;
}

function findFile(root: string, id: string): string | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  for (const dir of readdirSync(root)) {
    const f = join(root, dir, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

// A typed prompt, not Claude Code's own notes to the model (hooks, command output, reminders).
function promptText(r: Record<string, unknown>): string | null {
  if (r.type !== "user" || r.isMeta === true || r.isSidechain === true) return null;
  const content = (r.message as { content?: unknown } | undefined)?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("\n")
      : "";
  const t = text.trim();
  if (!t || t.startsWith("<") || t.startsWith("[Request interrupted")) return null;
  return t.length > 4000 ? t.slice(0, 4000) + "…" : t;
}

export function sessionTranscript(id: string, opts: { root?: string; now?: number } = {}): SessionTranscript | null {
  const root = opts.root ?? PROJECTS;
  const file = findFile(root, id);
  if (!file) return null;
  const recs = records(tail(file, TRANSCRIPT_BYTES));
  const session = describe(id, recs, statSync(file).mtime, opts.now ?? Date.now());
  if (!session) return null;
  const entries: Entry[] = [];
  for (const r of recs) {
    if (r.isSidechain === true) continue;
    const at = typeof r.timestamp === "string" ? r.timestamp : "";
    const prompt = promptText(r);
    if (prompt) entries.push({ kind: "prompt", at, text: prompt });
    else entries.push(...toEntries(r, at));
  }
  return { session, entries: entries.slice(-600) };
}

export class SessionBusy extends Error {}

// A one-shot reply is running in this session; a live session must not start on it meanwhile.
export function isReplying(id: string): boolean {
  return replying.has(id);
}

// Sends your message to one of your sessions as its next turn, the way \`claude --resume <id> -p\`
// would from its folder, in the permission mode the session was already using. The answer lands
// in the session's own log, so its transcript shows it, and the terminal shows it next time you
// resume there. Refused while the session looks open, or while a reply is already running.
export function replyToSession(id: string, text: string, opts: { claude: string; root?: string; now?: number; run?: typeof spawn }): SessionView {
  const root = opts.root ?? PROJECTS;
  const file = findFile(root, id);
  if (!file) throw new SessionBusy("No session with that id");
  const mtime = statSync(file).mtime;
  const session = describe(id, records(tail(file, LIST_BYTES)), mtime, opts.now ?? Date.now());
  if (!session) throw new SessionBusy("That session belongs to one of Annex's agents");
  if (replying.has(id)) throw new SessionBusy("A reply is already running in this session");
  const quiet = (opts.now ?? Date.now()) - mtime.getTime();
  if (quiet < IDLE_MS) {
    throw new SessionBusy(`This session was active ${Math.max(1, Math.round(quiet / 1000))}s ago and may be open in a terminal. Reply there, or wait until it has been quiet for ${IDLE_MS / 60000} minutes.`);
  }
  const mode = session.permissionMode && MODES.has(session.permissionMode) ? session.permissionMode : null;
  const args = ["-p", text, "--resume", id, "--output-format", "json", ...(mode ? ["--permission-mode", mode] : [])];
  const child = (opts.run ?? spawn)(opts.claude, args, { cwd: session.cwd, detached: true, stdio: "ignore" });
  replying.add(id);
  child.on("exit", () => replying.delete(id));
  child.on("error", () => replying.delete(id));
  child.unref();
  return { ...session, replying: true };
}
