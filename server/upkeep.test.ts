import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./db.ts";
import { backupIfDue, health } from "./upkeep.ts";

test("the database is copied once a day and seven copies are kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "annex-up-"));
  const store = new Store(join(dir, "b.db"));
  store.ensureWing("w", "with_you");
  const backups = join(dir, "backups");
  const day = 86_400_000;
  const start = Date.parse("2026-10-01T10:00:00Z");
  const first = backupIfDue(store, backups, start)!;
  assert.ok(first);
  assert.equal(backupIfDue(store, backups, start + 3600_000), null, "not again within the day");
  for (let i = 1; i <= 9; i++) {
    // age the newest copy so the next one is due
    for (const f of readdirSync(backups)) utimesSync(join(backups, f), new Date(start + (i - 1) * day), new Date(start + (i - 1) * day));
    backupIfDue(store, backups, start + i * day);
  }
  assert.equal(readdirSync(backups).length, 7);
  const copy = new DatabaseSync(join(backups, readdirSync(backups).sort().at(-1)!));
  assert.equal((copy.prepare("select count(*) n from wing").get() as { n: number }).n, 1, "a real, readable copy");
});

test("health names what is wrong", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "annex-h-")), "b.db"));
  const now = Date.now();
  const h = await health({ engineUrl: "http://127.0.0.1:9", store, lastTick: new Date(now - 120_000), startedAt: new Date(now - 600_000), now });
  assert.equal(h.ok, false);
  assert.match(h.engine!, /not reachable/);
  assert.match(h.database!, /no tick since/);
});
