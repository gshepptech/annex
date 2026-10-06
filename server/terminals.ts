// Terminals: a real terminal in a folder, in the browser. Each is a pseudo-terminal running your
// login shell (or `claude --resume <id>` through it), so full-screen programs, colours, Ctrl-C and
// resizing work as they do in Terminal.app. Output is kept, up to a bound, so a page that
// reconnects sees the screen again.
//
// Closing a terminal, or stopping Annex, hangs up the shell exactly as closing a terminal window
// does: the shell gets SIGHUP and takes its jobs with it. If Annex dies outright, the kernel does
// the same when the pty closes, so nothing is left running and no reaper file is needed.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TerminalView, TerminalUpdate } from "./api-types.ts";
export type { TerminalView, TerminalUpdate };

export class TerminalError extends Error {}

export interface PtyLike {
  pid: number;
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export type SpawnPty = (file: string, args: string[], o: { cwd: string; cols: number; rows: number; env: Record<string, string>; name: string }) => PtyLike;

interface Term extends TerminalView {
  pty: PtyLike;
  closing: boolean;
  // what it printed: chunks[0] starts at offset `start`; `end` counts everything ever printed
  chunks: string[];
  start: number;
  end: number;
  listeners: Set<(u: TerminalUpdate) => void>;
}

const UUID = /^[0-9a-f-]{36}$/;

export class Terminals {
  private terms = new Map<string, Term>();
  // conversations a claude terminal here drove and has since let go of
  private ran = new Set<string>();
  private opts: { claude: string; shell: string; shellArgs: string[]; spawn: SpawnPty | null; max: number; keep: number };

  constructor(opts: { claude: string; shell?: string; shellArgs?: string[]; spawn?: SpawnPty; max?: number; keep?: number }) {
    this.opts = {
      claude: opts.claude,
      shell: opts.shell ?? userShell(),
      shellArgs: opts.shellArgs ?? ["-l"],
      spawn: opts.spawn ?? null,
      max: opts.max ?? 12,
      keep: opts.keep ?? 512 * 1024,
    };
  }

  list(): TerminalView[] {
    return [...this.terms.values()].map(view);
  }

  get(id: string): TerminalView | null {
    const t = this.terms.get(id);
    return t ? view(t) : null;
  }

  // A running claude terminal on that conversation, so it is never driven by two processes.
  bySession(sessionId: string): TerminalView | null {
    const t = [...this.terms.values()].find((x) => x.sessionId === sessionId && x.status === "running");
    return t ? view(t) : null;
  }

  // A claude terminal here drove this conversation last and has exited: reopening it live needs no wait.
  ranSession(sessionId: string): boolean {
    return this.ran.has(sessionId) && !this.bySession(sessionId);
  }

  // Your login shell in `cwd`; with `claude`, Claude Code continuing `resume` (or a new
  // conversation) started through that shell, so your login PATH and environment apply.
  open(o: { cwd: string; claude?: { resume: string | null } }): TerminalView {
    if (!existsSync(o.cwd) || !statSync(o.cwd).isDirectory()) throw new TerminalError(`${o.cwd} is not a folder`);
    if ([...this.terms.values()].filter((t) => t.status === "running").length >= this.opts.max) throw new TerminalError(`${this.opts.max} terminals are open already. Close one first.`);
    const resume = o.claude?.resume ?? null;
    if (resume !== null && !UUID.test(resume)) throw new TerminalError("That is not a Claude session id");
    if (resume && this.bySession(resume)) throw new TerminalError("That conversation is open in a terminal already");
    // the id and the claude path go in as $1 and $0: nothing is pasted into the shell's command
    const args = o.claude
      ? ["-l", "-c", resume ? 'exec "$0" --resume "$1"' : 'exec "$0"', this.opts.claude, ...(resume ? [resume] : [])]
      : this.opts.shellArgs;
    const pty = (this.opts.spawn ?? defaultSpawn())(this.opts.shell, args, { cwd: o.cwd, cols: 100, rows: 30, env: terminalEnv(process.env), name: "xterm-256color" });
    const t: Term = {
      id: randomUUID(), cwd: o.cwd, kind: o.claude ? "claude" : "shell", sessionId: resume,
      title: o.claude ? (resume ? `claude --resume ${resume.slice(0, 8)}` : "claude") : basename(this.opts.shell),
      status: "running", exitCode: null, startedAt: new Date().toISOString(),
      pty, closing: false, chunks: [], start: 0, end: 0, listeners: new Set(),
    };
    this.terms.set(t.id, t);
    pty.onData((d) => {
      t.chunks.push(d);
      t.end += d.length;
      this.trim(t);
      this.publish(t, { type: "output", at: t.end, data: d });
    });
    pty.onExit((e) => this.exited(t, e.signal ? null : e.exitCode));
    return view(t);
  }

  input(id: string, data: string) {
    const t = this.need(id);
    if (t.status !== "running" || t.closing) throw new TerminalError("That terminal has ended");
    if (data.length > 1_000_000) throw new TerminalError("That is too much to type at once");
    t.pty.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const t = this.need(id);
    if (t.status !== "running") return;
    t.pty.resize(clamp(cols, 2, 500), clamp(rows, 2, 200));
  }

  // Replays from `after` (an offset a reader already has) when that is still kept, otherwise the
  // whole kept history as a reset. Synchronous, so nothing printed in between is lost.
  subscribe(id: string, after: number | null, fn: (u: TerminalUpdate) => void): () => void {
    const t = this.need(id);
    const all = t.chunks.join("");
    if (after !== null && after >= t.start && after <= t.end) {
      const tail = all.slice(after - t.start);
      if (tail) fn({ type: "output", at: t.end, data: tail });
    } else {
      fn({ type: "output", at: t.end, data: all, reset: true });
    }
    if (t.status === "exited") fn({ type: "exit", exitCode: t.exitCode });
    t.listeners.add(fn);
    return () => t.listeners.delete(fn);
  }

  close(id: string) {
    const t = this.need(id);
    if (t.status !== "running") {
      this.terms.delete(id);
      return;
    }
    if (t.closing) return;
    t.closing = true;
    // an interactive shell ignores SIGTERM; a hang-up is what closing a window sends
    t.pty.kill("SIGHUP");
    const pid = t.pty.pid;
    setTimeout(() => {
      if (t.status !== "running") return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // the group has gone
      }
    }, 3000).unref();
  }

  closeAll() {
    for (const t of this.terms.values()) {
      if (t.status !== "running") continue;
      t.closing = true;
      try {
        t.pty.kill("SIGHUP");
      } catch {
        // already gone
      }
    }
  }

  private need(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw new TerminalError("No terminal with that id");
    return t;
  }

  private trim(t: Term) {
    while (t.end - t.start > this.opts.keep && t.chunks.length) {
      const first = t.chunks[0]!;
      const over = t.end - t.start - this.opts.keep;
      if (first.length <= over) {
        t.chunks.shift();
        t.start += first.length;
        continue;
      }
      // cut after a line break, so a replay rarely starts in the middle of an escape sequence
      const nl = first.indexOf("\n", over);
      const cut = nl < 0 ? over : nl + 1;
      t.chunks[0] = first.slice(cut);
      t.start += cut;
    }
  }

  private exited(t: Term, exitCode: number | null) {
    if (t.status === "exited") return;
    t.status = "exited";
    t.exitCode = exitCode;
    if (t.sessionId) this.ran.add(t.sessionId);
    this.publish(t, { type: "exit", exitCode });
    // closed from here: gone at once. Ended by itself: kept a while so the page can show how it ended.
    if (t.closing) this.terms.delete(t.id);
    else {
      setTimeout(() => {
        if (!t.listeners.size) this.terms.delete(t.id);
      }, 30 * 60_000).unref();
    }
  }

  private publish(t: Term, u: TerminalUpdate) {
    for (const fn of t.listeners) fn(u);
  }
}

// The environment a terminal starts with: yours, minus the markers that make Claude Code think it
// is nested or in CI and the variables `npm run` adds (npm_config_prefix breaks nvm), plus what a
// terminal sets. launchd sets no LANG, which garbles UTF-8 in zsh.
export function terminalEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith("npm_") || ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "MCP_TOOL_TIMEOUT", "CI", "INIT_CWD"].includes(k)) continue;
    env[k] = v;
  }
  // `npm run` also puts Annex's own node_modules/.bin first on PATH
  if (env.PATH) env.PATH = env.PATH.split(":").filter((p) => !p.endsWith("/node_modules/.bin")).join(":");
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "Annex";
  env.LANG = base.LANG || "en_US.UTF-8";
  env.HOME = base.HOME || homedir();
  return env;
}

function userShell(): string {
  try {
    const s = userInfo().shell;
    if (s) return s;
  } catch {
    // no passwd entry; fall back below
  }
  return process.env.SHELL || "/bin/zsh";
}

let spawnPty: SpawnPty | null = null;

// node-pty, loaded on first use. Its 1.1.0 prebuilds ship `spawn-helper` without the execute bit
// (its install script only checks the prebuild exists), so every spawn fails with "posix_spawnp
// failed" until the bit is set; Annex sets it here, which also survives `npm ci`.
function defaultSpawn(): SpawnPty {
  if (spawnPty) return spawnPty;
  try {
    const req = createRequire(import.meta.url);
    const dir = dirname(req.resolve("node-pty/package.json"));
    for (const p of [join(dir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), join(dir, "build", "Release", "spawn-helper")]) {
      if (existsSync(p) && (statSync(p).mode & 0o111) === 0) chmodSync(p, 0o755);
    }
    spawnPty = (req("node-pty") as { spawn: SpawnPty }).spawn;
    return spawnPty;
  } catch (err) {
    throw new TerminalError(`Terminals need node-pty: run npm install in the annex folder (${(err as Error).message})`);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));
}

function view(t: Term): TerminalView {
  return { id: t.id, cwd: t.cwd, kind: t.kind, sessionId: t.sessionId, title: t.title, status: t.status, exitCode: t.exitCode, startedAt: t.startedAt };
}
