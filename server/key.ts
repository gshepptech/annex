// Annex's API key. Annex listens on 127.0.0.1 with no login, and its agents run on the same
// machine, so every API request must carry this key: the browser gets it once from a link and
// keeps it; agents are not allowed to read the file it lives in (see provision.ts).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const KEY_DIR = join(homedir(), ".config", "annex");
export const KEY_FILE = join(KEY_DIR, "key");

export function loadOrCreateKey(file = KEY_FILE): string {
  if (existsSync(file)) {
    const k = readFileSync(file, "utf8").trim();
    if (k.length >= 32) return k;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const k = randomBytes(24).toString("base64url");
  writeFileSync(file, k + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return k;
}

export function sameKey(given: string | null | undefined, key: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The link that hands the key to the page; the page moves it out of the address bar at once.
export function openLink(port: number, key: string): string {
  return `http://127.0.0.1:${port}/#key=${key}`;
}
