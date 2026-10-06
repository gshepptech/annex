// Live sessions: your own Claude Code sessions, driven from the browser instead of a terminal.
// Each is one `claude -p` child talking stream-json both ways, so it keeps one conversation across
// turns, streams its answer as it is written, takes interrupts and mode switches, and runs slash
// commands. It runs on your login and your own Claude settings, exactly as the terminal does; it
// is not an agent.
//
// Permission prompts come back through a small MCP server (agent-tools/approve-mcp.mjs) named as
// the permission prompt tool. It asks Annex, Annex holds the question until you answer in the
// browser, and the answer goes back to Claude. A question nobody answers waits; the card stays up.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { sameKey } from "./key.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { LIVE_MODES as MODES, type Entry, type LiveMode as Mode, type LivePrompt, type LiveView, type LiveUpdate } from "./api-types.ts";
import { toEntries } from "./transcript.ts";
import { walk } from "./files.ts";

export { MODES };
export type { Mode, LivePrompt, LiveView, LiveUpdate };

// `answers` is your reply to a question Claude asked (AskUserQuestion): question text -> chosen
// label(s), comma-joined for multiple choice.
export type Decision = { allow: true; always?: boolean; answers?: Record<string, string> } | { allow: false; message?: string };

interface Live extends LiveView {
  child: ChildProcess | null;
  // this session's own token for its approve MCP server: a token read from another session's
  // config cannot put a question in front of you for this one
  token: string;
  // Close was pressed: nothing more is written to the child while it winds down
  closing: boolean;
  startedAt: string;
  pending: Map<string, { prompt: LivePrompt; resolve: (d: Decision) => void }>;
  // tools you allowed for the rest of the session (a Bash command is matched exactly)
  allowed: Set<string>;
  listeners: Set<(u: LiveUpdate) => void>;
  configFile: string;
}

const MAX_ENTRIES = 2000;

export class LiveSessions {
  private lives = new Map<string, Live>();
  // the open sessions, written down so a restart of Annex reopens them
  private openFile: string;
  private shuttingDown = false;
  private opts: { claude: string; bourneUrl: string; dir: string; onUsage?: (info: unknown) => void; approveScript: string };

  constructor(opts: { claude: string; bourneUrl: string; dir: string; onUsage?: (info: unknown) => void; approveScript?: string }) {
    this.opts = { ...opts, approveScript: opts.approveScript ?? join(import.meta.dirname, "agent-tools", "approve-mcp.mjs") };
    this.openFile = join(opts.dir, "open.json");
  }

  private persist() {
    if (this.shuttingDown) return;
    const open = [...this.lives.values()].filter((l) => l.status !== "closed" && !l.closing && l.sessionId).map((l) => ({ sessionId: l.sessionId, cwd: l.cwd, mode: l.mode }));
    try {
      mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.openFile, JSON.stringify(open));
    } catch {
      // nothing to reopen next time; the conversations themselves are kept by Claude Code
    }
  }

  // After a restart: reopen every session that was open when Annex stopped, each continuing its
  // own conversation (\`history\` reads what it already said from Claude Code's log).
  restore(history: (sessionId: string) => Entry[] | null): number {
    let list: { sessionId: string; cwd: string; mode: Mode }[] = [];
    try {
      list = JSON.parse(readFileSync(this.openFile, "utf8"));
    } catch {
      return 0;
    }
    let n = 0;
    for (const o of list) {
      try {
        if (!o.sessionId || !existsSync(o.cwd)) continue;
        this.start({ cwd: o.cwd, mode: MODES.includes(o.mode) ? o.mode : "default", resume: o.sessionId, history: history(o.sessionId) ?? [] });
        n++;
      } catch {
        // a folder that moved: that one stays closed
      }
    }
    return n;
  }

  list(): LiveView[] {
    return [...this.lives.values()].map(view);
  }

  get(id: string): LiveView | null {
    const l = this.lives.get(id);
    return l ? view(l) : null;
  }

  // The live session already driving a Claude session, if any, so it is not started twice.
  bySession(sessionId: string): LiveView | null {
    const l = [...this.lives.values()].find((x) => x.sessionId === sessionId && x.status !== "closed");
    return l ? view(l) : null;
  }

  // `history` is what a resumed session already said, read from its log, so the view starts whole.
  start(o: { cwd: string; mode: Mode; resume?: string | null; history?: Entry[]; model?: string | null; run?: typeof spawn }): LiveView {
    if (o.model && !MODEL.test(o.model)) throw new LiveError(`Unknown model "${o.model}"`);
    if (!existsSync(o.cwd) || !statSync(o.cwd).isDirectory()) throw new LiveError(`${o.cwd} is not a folder`);
    if (!MODES.includes(o.mode)) throw new LiveError(`Unknown mode "${o.mode}"`);
    if (o.resume) {
      const already = this.bySession(o.resume);
      if (already) return already;
    }
    const id = randomUUID();
    const token = randomBytes(24).toString("base64url");
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    const configFile = join(this.opts.dir, `${id}.mcp.json`);
    writeFileSync(
      configFile,
      JSON.stringify({ mcpServers: { bourne_live: { command: process.execPath, args: [this.opts.approveScript], env: { BOURNE_URL: this.opts.bourneUrl, BOURNE_LIVE: id, BOURNE_TOKEN: token } } } }),
      { mode: 0o600 },
    );
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-mode", o.mode, "--mcp-config", configFile, "--permission-prompt-tool", "mcp__bourne_live__approve",
      ...(o.resume ? ["--resume", o.resume] : []),
      ...(o.model ? ["--model", o.model] : []),
    ];
    // a permission question can wait as long as you take; do not let the MCP call time out
    const env = { ...process.env, MCP_TOOL_TIMEOUT: String(7 * 86_400_000) };
    const child = (o.run ?? spawn)(this.opts.claude, args, { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], env });
    const live: Live = {
      id, sessionId: o.resume ?? null, cwd: o.cwd, mode: o.mode, model: null, status: "starting", entries: [...(o.history ?? [])], partial: "", prompts: [], slashCommands: [], error: null,
      child, pending: new Map(), allowed: new Set(), listeners: new Set(), configFile, token, closing: false, startedAt: new Date().toISOString(),
    };
    this.lives.set(id, live);
    let buf = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("{")) this.onLine(live, line);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    // a child that died or never started: writes to it fail quietly and the session closes
    child.stdin?.on("error", () => {});
    child.on("error", (e) => this.closed(live, e.message));
    child.on("exit", (code) => this.closed(live, code ? err.trim().split("\n").slice(-3).join("\n") || `claude exited ${code}` : null));
    return view(live);
  }

  // A message, with any pasted images (png, jpeg, gif or webp, at most four, 5 MB each).
  send(id: string, text: string, images: { mediaType: string; data: string }[] = []) {
    const l = this.need(id);
    if (!text.trim() && !images.length) throw new LiveError("Nothing to send");
    if (images.length > 4) throw new LiveError("At most four images in one message");
    for (const i of images) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(i.mediaType)) throw new LiveError("Images can be PNG, JPEG, GIF or WebP");
      if (!/^[A-Za-z0-9+/=]+$/.test(i.data) || i.data.length > 7_000_000) throw new LiveError("An image is too large (5 MB at most) or damaged");
    }
    l.entries.push({ kind: "prompt", at: new Date().toISOString(), text: images.length ? `${text}${text ? "\n" : ""}[${images.length} image${images.length === 1 ? "" : "s"}]` : text });
    l.status = "working";
    const content = images.length
      ? [...(text.trim() ? [{ type: "text", text }] : []), ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } }))]
      : text;
    this.write(l, { type: "user", message: { role: "user", content } });
    this.publish(l, l.entries.length - 1);
  }

  // Files in the session's folder for @-completion: git's list when it is a repo (so ignored
  // build output stays out), otherwise a shallow walk. Names only; nothing is read.
  async files(id: string, q: string): Promise<string[]> {
    const l = this.lives.get(id);
    if (!l) throw new LiveError("No live session with that id");
    let all: string[] = [];
    try {
      const { stdout } = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: l.cwd, maxBuffer: 32 * 1024 * 1024 });
      all = stdout.split("\n").filter(Boolean);
    } catch {
      all = walk(l.cwd, "", 3, 4000);
    }
    const needle = q.toLowerCase();
    const hits = all.filter((f) => f.toLowerCase().includes(needle));
    // names that start with what you typed come first, then shorter paths
    return hits.sort((a, b) => Number(!basename(a).toLowerCase().startsWith(needle)) - Number(!basename(b).toLowerCase().startsWith(needle)) || a.length - b.length).slice(0, 12);
  }

  // \`!command\`, as in the terminal: run it in the session's folder and hand Claude the output,
  // so it is part of the conversation. Two minutes at most; output cut to the last 20,000 characters.
  async shell(id: string, command: string): Promise<{ exitCode: number; output: string }> {
    const l = this.need(id);
    if (!command.trim()) throw new LiveError("Type a command after !");
    let output = "";
    let exitCode = 0;
    try {
      const r = await exec("/bin/sh", ["-c", command], { cwd: l.cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      output = (r.stdout + r.stderr).trim();
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() + (e.killed ? "\n(stopped after two minutes)" : "");
      exitCode = typeof e.code === "number" ? e.code : 1;
    }
    output = output.length > 20_000 ? `…${output.slice(-20_000)}` : output;
    this.send(id, `I ran this in the shell:\n\n$ ${command}\n${output || "(no output)"}\n(exit ${exitCode})`);
    return { exitCode, output };
  }

  interrupt(id: string) {
    const l = this.need(id);
    // stopping the turn answers any open question with no
    this.settle(l, "The person stopped this turn.");
    this.write(l, { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
  }

  // The mode changes when Claude accepts it (its control response says so); a refusal is shown.
  setMode(id: string, mode: Mode) {
    const l = this.need(id);
    if (!MODES.includes(mode)) throw new LiveError(`Unknown mode "${mode}"`);
    const request_id = randomUUID();
    this.modeRequests.set(request_id, { live: l, mode });
    this.write(l, { type: "control_request", request_id, request: { subtype: "set_permission_mode", mode } });
  }

  private modeRequests = new Map<string, { live: Live; mode: Mode }>();
  private modelRequests = new Map<string, Live>();

  // Switches the model mid-session (\`opus\`, \`sonnet\`, \`haiku\` or a full model id); Claude's
  // next init says which model it is now running.
  setModel(id: string, model: string) {
    const l = this.need(id);
    if (!MODEL.test(model)) throw new LiveError(`Unknown model "${model}"`);
    const request_id = randomUUID();
    this.modelRequests.set(request_id, l);
    this.write(l, { type: "control_request", request_id, request: { subtype: "set_model", model } });
  }

  // The approve MCP server proves which session it serves with that session's own token.
  tokenOk(id: string, given: string | undefined): boolean {
    const l = this.lives.get(id);
    return !!l && sameKey(given, l.token);
  }

  // Sessions Annex itself drove most recently (closed now): reopening one needs no "may be open
  // in a terminal" wait, because Annex knows its own child was the last writer.
  // The mode a session last had while Annex drove it, so reopening it keeps it.
  lastMode(sessionId: string): Mode | null {
    const all = [...this.lives.values()].filter((l) => l.sessionId === sessionId);
    return all.at(-1)?.mode ?? null;
  }

  lastDrivenByBourne(sessionId: string): boolean {
    return [...this.lives.values()].some((l) => l.sessionId === sessionId);
  }

  close(id: string) {
    const l = this.lives.get(id);
    if (!l || l.closing) return;
    l.closing = true;
    this.settle(l, "The session was closed.");
    this.persist();
    l.child?.stdin?.end();
    // a turn that does not end on its own is stopped
    const child = l.child;
    setTimeout(() => child?.kill("SIGTERM"), 3000).unref();
  }

  // Close and wait until the claude child has exited, so the same conversation is never driven by
  // two processes (Open in terminal starts `claude --resume` only after this).
  closeAndWait(id: string): Promise<void> {
    const l = this.lives.get(id);
    const child = l?.child;
    if (!l || l.status === "closed" || !child || (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      // close() asks it to stop at 3 s; one that still runs is killed, and then we give up
      const kill = setTimeout(() => child.kill("SIGKILL"), 8000);
      const fail = setTimeout(() => reject(new LiveError("Claude did not stop; try again")), 10_000);
      kill.unref();
      fail.unref();
      child.once("exit", () => {
        clearTimeout(kill);
        clearTimeout(fail);
        resolve();
      });
      this.close(id);
    });
  }

  closeAll() {
    // what is open now is what reopens next time; the children dying below must not change that
    this.persist();
    this.shuttingDown = true;
    for (const l of this.lives.values()) {
      l.child?.kill("SIGTERM");
      rmSync(l.configFile, { force: true });
    }
  }

  // Called by the approve MCP server for every tool Claude wants to use that needs your yes.
  // Answers at once for a tool you already allowed for the session; otherwise waits for you.
  ask(id: string, tool: string, input: Record<string, unknown>): Promise<Decision> {
    const l = this.need(id);
    if (l.allowed.has(allowKey(tool, input))) return Promise.resolve({ allow: true });
    const prompt: LivePrompt = { id: randomUUID(), tool, input, at: new Date().toISOString() };
    return new Promise((resolve) => {
      l.pending.set(prompt.id, { prompt, resolve });
      l.prompts = [...l.pending.values()].map((p) => p.prompt);
      this.publish(l);
    });
  }

  answer(id: string, promptId: string, d: Decision) {
    const l = this.need(id);
    const p = l.pending.get(promptId);
    if (!p) throw new LiveError("That question was already answered");
    if (d.allow && d.always) l.allowed.add(allowKey(p.prompt.tool, p.prompt.input));
    l.pending.delete(promptId);
    l.prompts = [...l.pending.values()].map((x) => x.prompt);
    p.resolve(d);
    this.publish(l);
  }

  // A closed session can still be watched (its last state), so a page that reconnects sees why it ended.
  subscribe(id: string, fn: (u: LiveUpdate) => void): () => void {
    const l = this.lives.get(id);
    if (!l) throw new LiveError("No live session with that id");
    l.listeners.add(fn);
    fn({ ...update(l, 0), slashCommands: l.slashCommands });
    return () => l.listeners.delete(fn);
  }

  private settle(l: Live, message: string) {
    for (const p of l.pending.values()) p.resolve({ allow: false, message });
    l.pending.clear();
    l.prompts = [];
    this.publish(l);
  }

  private need(id: string): Live {
    const l = this.lives.get(id);
    if (!l) throw new LiveError("No live session with that id");
    if (l.status === "closed" || l.closing) throw new LiveError("That session is closed. Open it again from Your desk.");
    return l;
  }

  private write(l: Live, msg: unknown) {
    const stdin = l.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) throw new LiveError("That session has ended.");
    stdin.write(JSON.stringify(msg) + "\n");
  }

  private onLine(l: Live, line: string) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const from = l.entries.length;
    if (m.type === "system" && m.subtype === "init") {
      l.sessionId = String(m.session_id ?? l.sessionId ?? "") || null;
      l.model = typeof m.model === "string" ? m.model : l.model;
      const first = !l.slashCommands.length;
      if (Array.isArray(m.slash_commands)) l.slashCommands = (m.slash_commands as unknown[]).map(String);
      if (l.status === "starting") l.status = l.entries.some((e) => e.kind === "prompt" && e.at > startedAt(l)) ? "working" : "waiting";
      this.persist();
      return this.publish(l, from, first);
    }
    if (m.type === "stream_event") {
      const ev = m.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        l.partial += ev.delta.text;
        this.publish(l);
      }
      return;
    }
    if (m.type === "control_response") {
      const r = m.response as { subtype?: string; request_id?: string; error?: string } | undefined;
      const modelFor = r?.request_id ? this.modelRequests.get(r.request_id) : undefined;
      if (modelFor) {
        this.modelRequests.delete(r!.request_id!);
        if (r!.subtype !== "success") {
          l.error = `Claude kept the model: ${r!.error ?? "it refused the change"}`;
          this.publish(l);
        }
        return;
      }
      const asked = r?.request_id ? this.modeRequests.get(r.request_id) : undefined;
      if (asked) {
        this.modeRequests.delete(r!.request_id!);
        if (r!.subtype === "success") {
          l.mode = asked.mode;
          l.error = null;
          this.persist();
        } else {
          l.error = `Claude kept the mode: ${r!.error ?? "it refused the change"}`;
        }
        this.publish(l);
      }
      return;
    }
    if (m.type === "rate_limit_event") {
      this.opts.onUsage?.(m.rate_limit_info);
      return;
    }
    if (m.type === "assistant" && !m.parent_tool_use_id) l.partial = "";
    if (m.type === "result") {
      l.partial = "";
      l.status = "waiting";
    }
    const at = new Date().toISOString();
    // a turn's closing summary repeats its last message; keep only how it ended
    // a subagent's own messages carry the id of the tool call that started it
    const sub = typeof m.parent_tool_use_id === "string" && m.parent_tool_use_id !== "";
    const add = toEntries(m, at).map((e) => (e.kind === "done" ? { ...e, text: "" } : sub ? { ...e, sub: true } : e));
    if (add.length) {
      l.entries.push(...add);
      if (l.entries.length > MAX_ENTRIES) l.entries.splice(0, l.entries.length - MAX_ENTRIES);
    }
    if (add.length || m.type === "result" || m.type === "assistant") this.publish(l, Math.min(from, l.entries.length));
  }

  private closed(l: Live, error: string | null) {
    if (l.status === "closed") return;
    l.status = "closed";
    l.error = error;
    l.partial = "";
    for (const p of l.pending.values()) p.resolve({ allow: false, message: "The session ended." });
    l.pending.clear();
    l.prompts = [];
    l.child = null;
    rmSync(l.configFile, { force: true });
    this.publish(l);
    this.persist();
    // a closed session stays visible a while (a page reconnecting sees why it ended), then goes
    setTimeout(() => {
      if (l.status === "closed" && !l.listeners.size) this.lives.delete(l.id);
    }, 30 * 60_000).unref();
  }

  private publish(l: Live, from = l.entries.length, withCommands = false) {
    const u = update(l, from);
    if (withCommands) u.slashCommands = l.slashCommands;
    for (const fn of l.listeners) fn(u);
  }
}

export class LiveError extends Error {}

function view(l: Live): LiveView {
  return { id: l.id, sessionId: l.sessionId, cwd: l.cwd, mode: l.mode, model: l.model, status: l.status, entries: l.entries, partial: l.partial, prompts: l.prompts, slashCommands: l.slashCommands, error: l.error };
}

function update(l: Live, from: number): LiveUpdate {
  return { from, entries: l.entries.slice(from), partial: l.partial, status: l.status, mode: l.mode, prompts: l.prompts, sessionId: l.sessionId, model: l.model, error: l.error };
}

// "Allow for this session": a tool by name, except Bash, which is allowed one exact command at a time.
function allowKey(tool: string, input: Record<string, unknown>): string {
  return tool === "Bash" ? `Bash:${String(input.command ?? "")}` : tool;
}

// Your default permission mode from your own Claude settings, so a new session starts the way the
// terminal would.
export function defaultMode(home = homedir()): Mode {
  try {
    const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { permissions?: { defaultMode?: string } };
    const m = s.permissions?.defaultMode;
    return MODES.includes(m as Mode) ? (m as Mode) : "default";
  } catch {
    return "default";
  }
}

const exec = promisify(execFile);

// History read from the log came before this child started; only a prompt sent since means busy.
function startedAt(l: { startedAt: string }): string {
  return l.startedAt;
}

// a model alias Claude Code knows, or a model id
const MODEL = /^(opus|sonnet|haiku|fable|default|claude-[a-z0-9.-]+(\[1m\])?)$/;
