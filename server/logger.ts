// Annex's own log: every decision it makes, with the wing it was about. Written as JSON lines to
// .annex/logs/annex.log (rotated at 5 MB, one previous file kept), echoed to the console, and
// kept in memory so the office can show the latest lines.

import { appendFileSync, mkdirSync, renameSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Level = "info" | "warn" | "error";

export interface LogLine {
  id: number;
  at: string;
  level: Level;
  wing: string | null;
  msg: string;
}

const KEEP = 3000;
const ROTATE_BYTES = 5 * 1024 * 1024;

export class Logger {
  readonly file: string | null;
  private lines: LogLine[] = [];
  private next = 1;
  private quiet: boolean;

  constructor(dir: string | null, opts: { quiet?: boolean } = {}) {
    this.quiet = opts.quiet ?? false;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      this.file = join(dir, "annex.log");
      this.loadTail();
    } else {
      this.file = null;
    }
  }

  // the end of the file from earlier runs, so the office's log does not start empty on a restart
  private loadTail() {
    if (!this.file || !existsSync(this.file)) return;
    let text = "";
    try {
      text = readFileSync(this.file, "utf8").slice(-400_000);
    } catch {
      return;
    }
    for (const raw of text.split("\n").slice(-KEEP)) {
      try {
        if (raw.trim()) this.lines.push({ ...(JSON.parse(raw) as LogLine), id: this.next++ });
      } catch {
        // the first line may be cut in half by the slice, or damaged; skip just that line
      }
    }
  }

  info(wing: string | null, msg: string) {
    this.write("info", wing, msg);
  }

  warn(wing: string | null, msg: string) {
    this.write("warn", wing, msg);
  }

  error(wing: string | null, msg: string) {
    this.write("error", wing, msg);
  }

  since(afterId: number, wing?: string, limit = 500): LogLine[] {
    const out = this.lines.filter((l) => l.id > afterId && (!wing || l.wing === wing || l.wing === null));
    return out.slice(-limit);
  }

  private write(level: Level, wing: string | null, msg: string) {
    const line: LogLine = { id: this.next++, at: new Date().toISOString(), level, wing, msg };
    this.lines.push(line);
    if (this.lines.length > KEEP) this.lines.splice(0, this.lines.length - KEEP);
    if (!this.quiet) {
      const tag = level === "info" ? "" : ` ${level.toUpperCase()}`;
      console.log(`[annex${tag}]${wing ? ` ${wing}:` : ""} ${msg}`);
    }
    if (!this.file) return;
    try {
      if (existsSync(this.file) && statSync(this.file).size > ROTATE_BYTES) renameSync(this.file, this.file + ".1");
      appendFileSync(this.file, JSON.stringify(line) + "\n");
    } catch {
      // a full disk or a removed directory must not stop the bureau; the console still has it
    }
  }
}
