// Keeping Annex itself healthy: a daily copy of its database, and a health report the page shows.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./db.ts";

const KEEP = 7;
const DAY = 86_400_000;

// Copies the database with VACUUM INTO (a consistent snapshot while Annex runs) when the newest
// copy is a day old, and keeps the last seven. Returns the new copy's path, or null when none was due.
export function backupIfDue(store: Store, dir: string, now = Date.now()): string | null {
  mkdirSync(dir, { recursive: true });
  const copies = readdirSync(dir).filter((f) => /^annex-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}\.db$/.test(f)).sort();
  const newest = copies.at(-1);
  if (newest && now - statSync(join(dir, newest)).mtimeMs < DAY) return null;
  const name = `annex-${new Date(now).toISOString().slice(0, 16).replace(":", "-")}.db`;
  const path = join(dir, name);
  if (existsSync(path)) return null;
  store.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  for (const old of [...copies, name].sort().slice(0, -KEEP)) rmSync(join(dir, old), { force: true });
  return path;
}

export interface Health {
  ok: boolean;
  engine: string | null;
  database: string | null;
  lastTick: string | null;
  startedAt: string;
}

export async function health(opts: { engineUrl: string; store: Store; lastTick: Date | null; startedAt: Date; now?: number }): Promise<Health> {
  let engine: string | null = null;
  try {
    const r = await fetch(`${opts.engineUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) engine = `the engine answered ${r.status}`;
  } catch (err) {
    engine = "Paperclip, the engine that runs the agents, is not answering. The login service restarts it; if this stays, run npm run service:install again.";
  }
  let database: string | null = null;
  try {
    // taking the write lock and letting it go proves the database can be written, not just read
    opts.store.db.exec("begin immediate; rollback;");
  } catch (err) {
    database = (err as Error).message;
  }
  // the bureau ticks every few seconds; a minute without one means it is stuck
  const stale = opts.lastTick && (opts.now ?? Date.now()) - opts.lastTick.getTime() > 60_000 ? `no tick since ${opts.lastTick.toISOString()}` : null;
  return {
    ok: !engine && !database && !stale,
    engine,
    database: database ?? stale,
    lastTick: opts.lastTick?.toISOString() ?? null,
    startedAt: opts.startedAt.toISOString(),
  };
}
