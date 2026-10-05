import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "./runner.ts";

const until = async (f: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("a script runs in its folder, its output and address are kept, and Stop stops its whole group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "annex-run-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "echo built", dev: "echo 'ready on http://localhost:5173/' && sleep 30 & sleep 30" } }));
  const runner = new Runner(dir);
  assert.deepEqual(runner.scripts(dir), ["dev", "build"], "dev first");
  assert.throws(() => runner.start({ folder: dir, script: "nope" }), /no "nope" script/);
  const r = runner.start({ folder: dir, script: "dev" });
  await until(() => runner.log(r.id).run.url !== null);
  assert.equal(runner.log(r.id).run.url, "http://localhost:5173/");
  assert.match(readFileSync(join(dir, "runs.json"), "utf8"), /npm run dev/, "its group is on record in case Annex crashes");
  const pgid = r.id && Number(JSON.parse(readFileSync(join(dir, "runs.json"), "utf8"))[0].pgid);
  runner.stop(r.id);
  await until(() => runner.log(r.id).run.endedAt !== null);
  assert.equal(runner.log(r.id).run.status, "stopped");
  // every process the run started is gone, not only the shell (the backgrounded sleep too)
  await until(() => { try { process.kill(-pgid, 0); return false; } catch { return true; } });
  const b = runner.start({ folder: dir, command: "echo $CI-done" });
  await until(() => runner.log(b.id).run.endedAt !== null);
  assert.equal(runner.log(b.id).run.exitCode, 0);
  assert.deepEqual(runner.log(b.id).lines, ["-done"], "CI is not set");
  assert.equal(runner.log(b.id, 1).lines.length, 0, "reading after the last line returns nothing new");
});
