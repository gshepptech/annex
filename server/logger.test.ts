import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "./logger.ts";

test("the log is written as JSON lines and read back after a restart, skipping a broken line", () => {
  const dir = mkdtempSync(join(tmpdir(), "annex-log-"));
  const a = new Logger(dir, { quiet: true });
  a.info("upkeep", "woke the lead");
  a.warn(null, "Paperclip is slow");
  writeFileSync(join(dir, "annex.log"), "half a line}\n" + readFileSync(join(dir, "annex.log"), "utf8"));
  const b = new Logger(dir, { quiet: true });
  assert.deepEqual(b.since(0).map((l) => [l.wing, l.level, l.msg]), [["upkeep", "info", "woke the lead"], [null, "warn", "Paperclip is slow"]]);
  assert.deepEqual(b.since(0, "upkeep").map((l) => l.msg), ["woke the lead", "Paperclip is slow"], "lines with no office show for every office");
});
