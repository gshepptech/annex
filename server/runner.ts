// Running the app you are building: start a package.json script or any command in a folder, keep
// its output, find the address it serves on, stop it. Each run gets its own process group, so
// stopping it stops everything it started; the groups are written to a file so a crash of Annex
// does not leave dev servers running forever (the next start stops them).

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRun as RunView } from "./api-types.ts";
export type { RunView };

const KEEP_LINES = 2000;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}[^\s"'`)]*/;


interface Run extends RunView {
  pgid: number | null;
  out: string[];
  // the index of out[0] in the run's whole output, so a reader can ask for "lines after n"
  dropped: number;
}

export class RunError extends Error {}

export class Runner {
  private runs = new Map<string, Run>();
  private file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "runs.json");
    this.reapLeftovers();
  }

  // Scripts a folder's package.json offers, dev-ish ones first.
  scripts(folder: string): string[] {
    try {
      const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const names = Object.keys(pkg.scripts ?? {});
      const order = ["dev", "start", "test", "build", "preview", "typecheck", "lint"];
      return names.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
    } catch {
      return [];
    }
  }

  list(folder?: string): RunView[] {
    return [...this.runs.values()].filter((r) => !folder || r.folder === folder).map(view);
  }

  // `script` runs `npm run <script>`; `command` runs a shell command line you typed.
  // `setup` runs first when given (an office's preview that has never been set up).
  start(o: { folder: string; script?: string; command?: string; label?: string; setup?: string | null }): RunView {
    if (!existsSync(o.folder) || !statSync(o.folder).isDirectory()) throw new RunError(`${o.folder} is not a folder`);
    let command: string;
    if (o.script) {
      if (!this.scripts(o.folder).includes(o.script)) throw new RunError(`package.json has no "${o.script}" script`);
      command = `npm run ${o.script}`;
    } else if (o.command?.trim()) {
      command = o.command.trim();
    } else {
      throw new RunError("Name a script or a command to run");
    }
    const same = [...this.runs.values()].find((r) => r.folder === o.folder && r.label === (o.label ?? command) && r.status === "running");
    if (same) return view(same);
    const label = o.label ?? command;
    if (o.setup) command = `${o.setup} && ${command}`;
    // a login-like environment, without CI=1, so dev servers behave as they do in your terminal
    const env = { ...process.env, FORCE_COLOR: "0" } as Record<string, string>;
    delete env.CI;
    const child = spawn("/bin/sh", ["-c", command], { cwd: o.folder, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const run: Run = {
      id: randomUUID(), folder: o.folder, command, label, status: "running", exitCode: null, url: null,
      startedAt: new Date().toISOString(), endedAt: null, lines: 0, pgid: child.pid ?? null, out: [], dropped: 0,
    };
    this.runs.set(run.id, run);
    this.save();
    let partial = "";
    const take = (d: Buffer) => {
      const text = partial + d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      const lines = text.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const l of lines) this.push(run, l);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("exit", (code) => {
      if (partial) this.push(run, partial);
      if (run.status === "running") run.status = "exited";
      run.exitCode = code;
      run.endedAt = new Date().toISOString();
      run.pgid = null;
      this.save();
    });
    child.on("error", (e) => {
      this.push(run, `Could not start: ${e.message}`);
      run.status = "exited";
      run.endedAt = new Date().toISOString();
      run.pgid = null;
      this.save();
    });
    return view(run);
  }

  stop(id: string): RunView {
    const r = this.runs.get(id);
    if (!r) throw new RunError("No run with that id");
    if (r.status === "running" && r.pgid) {
      r.status = "stopped";
      killGroup(r.pgid, "SIGTERM");
      const pgid = r.pgid;
      // anything that ignores the polite signal goes after a few seconds
      setTimeout(() => killGroup(pgid, "SIGKILL"), 4000).unref();
    }
    return view(r);
  }

  // Output after line `after` (counting from the run's first line).
  log(id: string, after = 0): { lines: string[]; next: number; run: RunView } {
    const r = this.runs.get(id);
    if (!r) throw new RunError("No run with that id");
    const from = Math.max(0, after - r.dropped);
    return { lines: r.out.slice(from), next: r.dropped + r.out.length, run: view(r) };
  }

  stopAll() {
    for (const r of this.runs.values()) if (r.status === "running" && r.pgid) killGroup(r.pgid, "SIGTERM");
  }

  private push(r: Run, line: string) {
    r.out.push(line);
    r.lines++;
    if (r.out.length > KEEP_LINES) {
      const cut = r.out.length - KEEP_LINES;
      r.out.splice(0, cut);
      r.dropped += cut;
    }
    if (!r.url) {
      const m = URL_RE.exec(line);
      if (m) r.url = m[0].replace("0.0.0.0", "localhost").replace(/[.,;]$/, "");
    }
  }

  private save() {
    const groups = [...this.runs.values()].filter((r) => r.status === "running" && r.pgid).map((r) => ({ pgid: r.pgid, command: r.command }));
    try {
      writeFileSync(this.file, JSON.stringify(groups));
    } catch {
      // the state folder is gone; nothing to reap next time either
    }
  }

  // Groups a previous Annex started and never stopped (it crashed): stopped now, but only when
  // the process still runs the command Annex started, so a reused process id is left alone.
  private reapLeftovers() {
    let groups: { pgid: number; command: string }[] = [];
    try {
      groups = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    for (const g of groups) {
      try {
        const cmd = execFileSync("ps", ["-o", "command=", "-p", String(g.pgid)], { encoding: "utf8" }).trim();
        if (cmd.includes(g.command)) killGroup(g.pgid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    writeFileSync(this.file, "[]");
  }
}

function killGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch {
    // the group has exited
  }
}

function view(r: Run): RunView {
  return { id: r.id, folder: r.folder, command: r.command, label: r.label, status: r.status, exitCode: r.exitCode, url: r.url, startedAt: r.startedAt, endedAt: r.endedAt, lines: r.lines };
}
