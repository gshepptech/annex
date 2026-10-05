// Live sessions: your own Claude Code sessions, driven from the browser instead of a terminal.
// Each is one `claude -p` child talking stream-json both ways, so it keeps one conversation across
// turns, streams its answer as it is written, takes interrupts and mode switches, and runs slash
// commands. It runs on your login and your own Claude settings, exactly as the terminal does; it
// is not an agent.
//
// Permission prompts come back through a small MCP server (agent-tools/approve-mcp.mjs) named as
// the permission prompt tool. It asks Annex, Annex holds the question until you answer in the
// browser, and the answer goes back to Claude. A question nobody answers waits; the card stays up.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIVE_MODES as MODES, type Entry, type LiveMode as Mode, type LivePrompt, type LiveView, type LiveUpdate } from "./api-types.ts";
import { toEntries } from "./transcript.ts";

export { MODES };
export type { Mode, LivePrompt, LiveView, LiveUpdate };

export type Decision = { allow: true; always?: boolean } | { allow: false; message?: string };

interface Live extends LiveView {
  child: ChildProcess | null;
  pending: Map<string, { prompt: LivePrompt; resolve: (d: Decision) => void }>;
  // tools you allowed for the rest of the session (a Bash command is matched exactly)
  allowed: Set<string>;
  listeners: Set<(u: LiveUpdate) => void>;
  configFile: string;
}

const MAX_ENTRIES = 2000;

export class LiveSessions {
  private lives = new Map<string, Live>();
  private opts: { claude: string; bourneUrl: string; token: string; dir: string; onUsage?: (info: unknown) => void; approveScript: string };

  constructor(opts: { claude: string; bourneUrl: string; token: string; dir: string; onUsage?: (info: unknown) => void; approveScript?: string }) {
    this.opts = { ...opts, approveScript: opts.approveScript ?? join(import.meta.dirname, "agent-tools", "approve-mcp.mjs") };
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
  start(o: { cwd: string; mode: Mode; resume?: string | null; history?: Entry[]; run?: typeof spawn }): LiveView {
    if (!existsSync(o.cwd) || !statSync(o.cwd).isDirectory()) throw new LiveError(`${o.cwd} is not a folder`);
    if (!MODES.includes(o.mode)) throw new LiveError(`Unknown mode "${o.mode}"`);
    if (o.resume) {
      const already = this.bySession(o.resume);
      if (already) return already;
    }
    const id = randomUUID();
    mkdirSync(this.opts.dir, { recursive: true });
    const configFile = join(this.opts.dir, `${id}.mcp.json`);
    writeFileSync(
      configFile,
      JSON.stringify({ mcpServers: { bourne_live: { command: process.execPath, args: [this.opts.approveScript], env: { BOURNE_URL: this.opts.bourneUrl, BOURNE_LIVE: id, BOURNE_TOKEN: this.opts.token } } } }),
      { mode: 0o600 },
    );
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-mode", o.mode, "--mcp-config", configFile, "--permission-prompt-tool", "mcp__bourne_live__approve",
      ...(o.resume ? ["--resume", o.resume] : []),
    ];
    // a permission question can wait as long as you take; do not let the MCP call time out
    const env = { ...process.env, MCP_TOOL_TIMEOUT: String(7 * 86_400_000) };
    const child = (o.run ?? spawn)(this.opts.claude, args, { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], env });
    const live: Live = {
      id, sessionId: o.resume ?? null, cwd: o.cwd, mode: o.mode, model: null, status: "starting", entries: [...(o.history ?? [])], partial: "", prompts: [], slashCommands: [], error: null,
      child, pending: new Map(), allowed: new Set(), listeners: new Set(), configFile,
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
    child.on("error", (e) => this.closed(live, e.message));
    child.on("exit", (code) => this.closed(live, code ? err.trim().split("\n").slice(-3).join("\n") || `claude exited ${code}` : null));
    return view(live);
  }

  send(id: string, text: string) {
    const l = this.need(id);
    if (!text.trim()) throw new LiveError("Nothing to send");
    l.entries.push({ kind: "prompt", at: new Date().toISOString(), text });
    l.status = "working";
    this.write(l, { type: "user", message: { role: "user", content: text } });
    this.publish(l, l.entries.length - 1);
  }

  interrupt(id: string) {
    const l = this.need(id);
    // stopping the turn answers any open question with no
    this.settle(l, "The person stopped this turn.");
    this.write(l, { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
  }

  setMode(id: string, mode: Mode) {
    const l = this.need(id);
    if (!MODES.includes(mode)) throw new LiveError(`Unknown mode "${mode}"`);
    this.write(l, { type: "control_request", request_id: randomUUID(), request: { subtype: "set_permission_mode", mode } });
    l.mode = mode;
    this.publish(l);
  }

  close(id: string) {
    const l = this.lives.get(id);
    if (!l) return;
    this.settle(l, "The session was closed.");
    l.child?.stdin?.end();
    // a turn that does not end on its own is stopped
    const child = l.child;
    setTimeout(() => child?.kill("SIGTERM"), 3000).unref();
  }

  closeAll() {
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
    if (l.status === "closed") throw new LiveError("That session is closed. Open it again from Your desk.");
    return l;
  }

  private write(l: Live, msg: unknown) {
    l.child?.stdin?.write(JSON.stringify(msg) + "\n");
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
      if (l.status === "starting") l.status = l.entries.some((e) => e.kind === "prompt") ? "working" : "waiting";
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
    if (m.type === "rate_limit_event") {
      this.opts.onUsage?.(m.rate_limit_info);
      return;
    }
    if (m.type === "assistant") l.partial = "";
    if (m.type === "result") {
      l.partial = "";
      l.status = "waiting";
    }
    const at = new Date().toISOString();
    // a turn's closing summary repeats its last message; keep only how it ended
    const add = toEntries(m, at).map((e) => (e.kind === "done" ? { ...e, text: "" } : e));
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
