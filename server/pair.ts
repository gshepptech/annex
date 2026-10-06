// Pairing another browser: a page that already has Annex's key makes a one-time code, and a
// browser on this machine that opens the link trades it for the key. Making a code needs the key,
// so a program here without it cannot mint one; a code is 192 random bits, kept only as a hash,
// works once and for five minutes, and only the latest one works. In memory only: a restart
// cancels any outstanding code.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PAIR_MS = 5 * 60_000;
const sha = (s: string) => createHash("sha256").update(s).digest();

export class Pairing {
  #pending: { hash: Buffer; expires: number } | null = null;
  #now: () => number;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  // a new code replaces any earlier one, so "Make a new link" cancels the old link
  mint(): { code: string; expiresAt: string } {
    const code = randomBytes(24).toString("base64url");
    const expires = this.#now() + PAIR_MS;
    this.#pending = { hash: sha(code), expires };
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  // true once, for the outstanding code, within its five minutes; a wrong code leaves it standing,
  // or any program here could cancel your pairing by posting junk
  claim(code: unknown): boolean {
    const p = this.#pending;
    if (!p || typeof code !== "string" || code.length > 128) return false;
    if (this.#now() >= p.expires) {
      this.#pending = null;
      return false;
    }
    const ok = timingSafeEqual(sha(code), p.hash);
    if (ok) this.#pending = null;
    return ok;
  }
}
