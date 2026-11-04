import { test } from "node:test";
import assert from "node:assert/strict";
import { needsTerminal } from "./slash.ts";

test("commands with only an interactive screen go to a terminal; the rest stay in the live session", () => {
  assert.equal(needsTerminal("/login", []), "/login");
  assert.equal(needsTerminal("  /status ", ["context"]), "/status");
  assert.equal(needsTerminal("/config", ["config"]), "/config", "the bare settings screen");
  assert.equal(needsTerminal("/config theme=dark", ["config"]), null, "its -p twin takes key=value");
  assert.equal(needsTerminal("/workflows", ["workflows"]), null, "the session lists it, so it runs there");
  assert.equal(needsTerminal("hello /login", []), null);
  assert.equal(needsTerminal("/lint-kit:run", []), null);
});
