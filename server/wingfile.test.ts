import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWing } from "./wing.ts";
import { applyEdit, toToml } from "./wingfile.ts";

const settings = { wakeEvery: "15m", maxRunsPerHour: null, quietHours: null, backOffWhenIdle: false, askBefore: [] as string[], maxWorkers: 6, maxTasksPerWake: 3, checkAttempts: 3, checkTimeout: "15m", wakeTimeout: "30m", maxBackoff: "24h" };

test("a shipped wing survives a round trip through the writer", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "examples", "wings", "upkeep", "wing.toml"), "utf8");
  const w = parseWing("upkeep", src);
  const again = parseWing("upkeep", toToml(w, settings));
  assert.deepEqual({ ...again, settings: undefined }, { ...w, settings: undefined });
});

test("edits change only what they name, and limits written off stay off", () => {
  const w = parseWing("upkeep", readFileSync(join(import.meta.dirname, "..", "examples", "wings", "upkeep", "wing.toml"), "utf8"));
  const edited = parseWing("upkeep", toToml(applyEdit(w, { workers: 3 }), { ...settings, maxRunsPerHour: 6, quietHours: "22:00-06:00", askBefore: ["adding a dependency"] }));
  assert.equal(edited.crew.workers, 3);
  assert.equal(edited.charter, w.charter);
  assert.equal(edited.settings.maxRunsPerHour, 6);
  assert.deepEqual(edited.settings.askBefore, ["adding a dependency"]);
  const off = parseWing("upkeep", toToml(w, settings));
  assert.equal(off.settings.maxRunsPerHour, null);
  assert.equal(off.settings.quietHours, null);
});
