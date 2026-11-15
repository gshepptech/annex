// Annex runs done checks and signals itself, in a shell, and keeps the exit code and the end of
// the output. An agent's own report that "tests pass" is never used in place of this.

import { spawn } from "node:child_process";

export interface RunResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

const TAIL_BYTES = 12_000;

export function runCommand(command: string, cwd: string, timeoutMs = 10 * 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    // detached so a timeout can kill the whole process group, not just the shell
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: true,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const keep = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > TAIL_BYTES * 2) out = out.slice(-TAIL_BYTES);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // the group already exited between the timer firing and the kill
      }
    }, timeoutMs);

    const finish = (exitCode: number) => {
      clearTimeout(timer);
      resolve({ exitCode, output: out.slice(-TAIL_BYTES), timedOut, durationMs: Date.now() - started });
    };
    child.on("error", (err) => {
      out += `\n[annex] could not start the command: ${err.message}`;
      finish(127);
    });
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}
