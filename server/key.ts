// Annex's API key. Annex listens on 127.0.0.1 with no login, and its agents run on the same
// machine, so every API request must carry this key: the browser gets it once from a link and
// keeps it. What it does and does not stop:
//   - a web page in your browser: stopped (and by the Host/Origin checks in http.ts);
//   - an agent with Annex's default shell allow list: no curl, and its settings deny reading the
//     key's folder by any file tool or any shell command that names it (provision.ts);
//   - an agent in an office whose allow list includes node, npm or npx: NOT stopped. Those run
//     arbitrary code as you, which can read any file you can. Isolating that needs an OS-level
//     sandbox for agents' shells, which Annex does not set up yet.

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
