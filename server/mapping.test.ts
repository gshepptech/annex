import { test } from "node:test";
import assert from "node:assert/strict";
import { toolUses, isUsageLimit, resetTime } from "./mapping.ts";

test("tool uses are read out of stream-json chunks", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "" },
    { type: "tool_use", name: "Bash", input: { command: "npm test\nmore" } },
    { type: "tool_use", name: "Edit", input: { file_path: "/a/b/src/index.ts" } },
  ] } });
  assert.deepEqual(toolUses(line + "\n" + JSON.stringify({ type: "user" })), [
    { tool: "Bash", detail: "npm test" },
    { tool: "Edit", detail: "index.ts" },
  ]);
  assert.deepEqual(toolUses("not json at all"), []);
});

test("usage limits are recognised and their reset time read", () => {
  assert.equal(isUsageLimit("Claude AI usage limit reached|1791010800"), true);
  assert.equal(isUsageLimit("You've hit your limit · resets 5pm (America/New_York)"), true);
  assert.equal(isUsageLimit("5-hour limit reached ∙ resets 5pm"), true);
  assert.equal(isUsageLimit("Tests failed"), false);
  const now = new Date(2026, 9, 2, 14, 0);
  assert.equal(resetTime("limit reached, resets 5pm", now).getHours(), 17);
  const tomorrow = resetTime("resets at 9:30am", now);
  assert.deepEqual([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()], [3, 9, 30]);
  assert.equal(resetTime("no idea when", now).getTime(), now.getTime() + 3_600_000);
});
