import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadWings, parseWing, parseDuration, inQuietHours, WingFileError } from "./wing.ts";

test("the shipped wing files load", () => {
  const wings = loadWings(join(import.meta.dirname, "..", "wings"));
  assert.deepEqual(wings.map((w) => w.id), ["colophon", "studio", "upkeep"]);
  const upkeep = wings.find((w) => w.id === "upkeep")!;
  assert.equal(upkeep.initialMode, "autonomous");
  assert.equal(upkeep.repo?.integrationBranch, "annex/upkeep", "offices made before the rename keep their branch");
  assert.ok(upkeep.repo?.path.endsWith("/Projects/reckon"));
  assert.equal(upkeep.signals.length, 4);
  assert.equal(upkeep.settings.wakeEverySec, 900);
});

test("every limit is off unless the file sets it", () => {
  const w = parseWing("x", `name = "X"`);
  assert.equal(w.initialMode, "with_you");
  assert.equal(w.settings.maxRunsPerHour, null);
  assert.equal(w.settings.quietHours, null);
  assert.equal(w.settings.backOffWhenIdle, false);
  assert.deepEqual(w.settings.askBefore, []);
});

test("an autonomous wing needs a charter and a repo", () => {
  assert.throws(() => parseWing("x", `mode = "autonomous"`), /charter is required/);
  assert.throws(() => parseWing("x", `mode = "autonomous"\ncharter = "c"`), /repo is required/);
});

test("errors name the file and the field", () => {
  assert.throws(() => parseWing("w", `mode = "sometimes"`), (e: unknown) => e instanceof WingFileError && /wings\/w\/wing.toml: mode/.test(e.message));
  assert.throws(() => parseWing("w", `[settings]\nmax_runs_per_hour = 0`), /max_runs_per_hour must be a whole number/);
});

test("durations", () => {
  assert.equal(parseDuration("15m"), 900);
  assert.equal(parseDuration("1h30m"), 5400);
  assert.throws(() => parseDuration("30s"), /at least 1m/);
  assert.throws(() => parseDuration("soon"), /must look like/);
});

test("quiet hours that cross midnight", () => {
  const w = parseWing("x", `[settings]\nquiet_hours = "22:00-06:00"`);
  const at = (h: number) => new Date(2026, 9, 2, h, 0);
  assert.equal(inQuietHours(w.settings.quietHours, at(23)), true);
  assert.equal(inQuietHours(w.settings.quietHours, at(3)), true);
  assert.equal(inQuietHours(w.settings.quietHours, at(6)), false);
  assert.equal(inQuietHours(w.settings.quietHours, at(12)), false);
});
