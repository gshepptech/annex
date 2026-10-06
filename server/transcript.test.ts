import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLog } from "./transcript.ts";

test("a real run log reads like a terminal: start, calls with results, the end", () => {
  const entries = parseLog(readFileSync(join(import.meta.dirname, "fixtures", "run.ndjson"), "utf8"));
  assert.equal(entries[0]!.kind, "start");
  assert.equal(entries.at(-1)!.kind, "done");
  const tools = entries.filter((e) => e.kind === "tool");
  const results = entries.filter((e) => e.kind === "result");
  assert.ok(tools.length > 0 && tools.length === results.length, "every call has its result");
  for (const e of entries) assert.ok(e.at, `${e.kind} has a time`);
});

test("a JSON line split across chunks is still read", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello there" }] } });
  const ndjson = [
    JSON.stringify({ ts: "2026-10-02T10:00:00Z", stream: "stdout", chunk: line.slice(0, 20) }),
    JSON.stringify({ ts: "2026-10-02T10:00:01Z", stream: "stdout", chunk: line.slice(20) + "\n" }),
  ].join("\n");
  assert.deepEqual(parseLog(ndjson).map((e) => (e.kind === "text" ? e.text : e.kind)), ["hello there"]);
});

test("tool calls get Claude Code's one-line form and edits get a diff", () => {
  const msg = { type: "assistant", message: { content: [
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
    { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/a/b/src/x.ts", old_string: "a", new_string: "b" } },
  ] } };
  const [bash, edit] = parseLog(JSON.stringify({ ts: "t", stream: "stdout", chunk: JSON.stringify(msg) + "\n" }));
  assert.ok(bash?.kind === "tool" && edit?.kind === "tool");
  assert.deepEqual([bash.summary, edit.summary], ["npm test", "src/x.ts"]);
  assert.equal(edit.detail, "- a\n+ b");
  assert.equal(edit.path, "/a/b/src/x.ts", "the full path, so the page can open it");
  assert.equal(bash.path, undefined);
});
