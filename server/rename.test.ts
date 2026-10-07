import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveFromOldName } from "./rename.ts";

test("the old name's data folder, database and key folder move to the new name, once", () => {
  const root = mkdtempSync(join(tmpdir(), "annex-rename-"));
  mkdirSync(join(root, ".annex", "wings", "w"), { recursive: true });
  for (const f of ["annex.db", "annex.db-wal", "annex.db-shm"]) writeFileSync(join(root, ".annex", f), f);
  const oldKey = join(root, "config", "annex");
  const newKey = join(root, "config", "annex");
  mkdirSync(oldKey, { recursive: true });
  writeFileSync(join(oldKey, "key"), "k".repeat(32));

  const done = moveFromOldName(root, newKey, oldKey);
  assert.equal(done.length, 3);
  assert.equal(readFileSync(join(root, ".annex", "annex.db-wal"), "utf8"), "annex.db-wal", "write-ahead file goes with the database");
  assert.ok(lstatSync(join(root, ".annex")).isSymbolicLink());
  assert.equal(readlinkSync(join(root, ".annex")), ".annex");
  assert.ok(existsSync(join(root, ".annex", "wings", "w")), "old absolute paths still resolve");
  assert.equal(readFileSync(join(newKey, "key"), "utf8"), "k".repeat(32));
  assert.ok(!existsSync(oldKey));

  assert.deepEqual(moveFromOldName(root, newKey, oldKey), [], "a second run does nothing");
});
