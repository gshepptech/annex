import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entry } from "../../server/api-types.ts";
import { signedOut } from "./signedout.ts";

const at = "2026-11-04T10:00:00Z";
// what `claude -p` answers when signed out, byte for byte
const NOT_LOGGED_IN = "Not logged in \u00b7 Please run /login";
const prompt: Entry = { kind: "prompt", at, text: "hi" };
const done = (isError: boolean): Entry => ({ kind: "done", at, text: "", isError, durationMs: 0, turns: 1 });

test("a failed turn that says Claude Code is not logged in is a sign-out", () => {
  // what `claude -p` prints signed out: the reply, then a result marked as an error
  assert.equal(signedOut([prompt, { kind: "text", at, text: NOT_LOGGED_IN }, done(true)], null), true);
  assert.equal(signedOut([prompt, { kind: "text", at, text: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}' }, done(true)], null), true);
  assert.equal(signedOut([], "Invalid API key \u00b7 Please run /login"), true);
});

test("a reply about logging in, an older failure, or a later good turn is not", () => {
  assert.equal(signedOut([prompt, { kind: "text", at, text: "I added authentication and a /login route." }, done(false)], null), false);
  const before = [prompt, { kind: "text", at, text: NOT_LOGGED_IN } as Entry, done(true)];
  assert.equal(signedOut([...before, prompt, { kind: "text", at, text: "Hello" }, done(false)], null), false, "logged in again since");
  assert.equal(signedOut([...before, prompt], null), true, "still the last finished turn");
  assert.equal(signedOut([prompt, { kind: "text", at, text: "Something broke" }, done(true)], "claude exited 1"), false);
});
