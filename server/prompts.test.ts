import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeIssue } from "./prompts.ts";
import { parseWing } from "./wing.ts";

test("a wake shows the lead what it already asked the person, so it does not ask again", () => {
  const wing = parseWing("w", 'name = "W"\n');
  const { description } = wakeIssue({
    wing, brief: null, signals: [], open: [], closed: [], dropIns: [],
    asked: [{ title: "Bump @types/node to 26.6.4 (major)", status: "pending" }, { title: "Bump vite to 8", status: "declined" }],
  });
  assert.match(description, /## Already put to the person/);
  assert.match(description, /\[waiting for an answer\] Bump @types\/node to 26\.6\.4/);
  assert.match(description, /\[declined\] Bump vite to 8/);
  assert.doesNotMatch(wakeIssue({ wing, brief: null, signals: [], open: [], closed: [], dropIns: [] }).description, /Already put/);
});
