import { test } from "node:test";
import assert from "node:assert/strict";
import { Pairing, PAIR_MS } from "./pair.ts";

test("a code is long, URL-safe and new each time", () => {
  let t = 1_000;
  const p = new Pairing(() => t);
  const a = p.mint();
  const b = p.mint();
  assert.ok(a.code.length >= 32);
  assert.match(a.code, /^[\w-]+$/);
  assert.notEqual(a.code, b.code);
  assert.equal(a.expiresAt, new Date(t + PAIR_MS).toISOString());
});

test("a code works once", () => {
  const p = new Pairing(() => 0);
  const { code } = p.mint();
  assert.equal(p.claim(code), true);
  assert.equal(p.claim(code), false);
});

test("a wrong code is refused and leaves the right one standing", () => {
  const p = new Pairing(() => 0);
  const { code } = p.mint();
  const near = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
  for (const wrong of ["x", near, undefined, 123, "a".repeat(500)]) assert.equal(p.claim(wrong), false);
  assert.equal(p.claim(code), true);
});

test("a code stops working after five minutes", () => {
  let t = 0;
  const p = new Pairing(() => t);
  const a = p.mint();
  t += PAIR_MS - 1;
  assert.equal(p.claim(a.code), true, "still good just before the end");
  const b = p.mint();
  t += PAIR_MS;
  assert.equal(p.claim(b.code), false);
});

test("a new code replaces the old one", () => {
  const p = new Pairing(() => 0);
  const a = p.mint();
  const b = p.mint();
  assert.equal(p.claim(a.code), false);
  assert.equal(p.claim(b.code), true);
});
