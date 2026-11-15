// Where Annex's code is, and where its data is. Run from a checkout, they are the same folder.
// Inside Annex.app the code is read-only in the bundle and the data lives elsewhere: the app's
// login service passes ANNEX_HOME (by default ~/Library/Application Support/Annex).

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODE_ROOT = join(import.meta.dirname, "..");
export const HOME = process.env.ANNEX_HOME || CODE_ROOT;
export const WINGS_DIR = join(HOME, "wings");

// true when this code runs from inside an .app bundle rather than a checkout
export const BUNDLED = CODE_ROOT.includes(".app/Contents/");

export function ensureHome() {
  mkdirSync(join(HOME, ".annex", "logs"), { recursive: true });
  mkdirSync(WINGS_DIR, { recursive: true });
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}
