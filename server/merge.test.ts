import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, mergeForPerson } from "./git.ts";

const id = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

async function repoWithWork(opts: { conflict?: boolean } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "annex-merge-"));
  await git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  await git(repo, "add", ".");
  await git(repo, ...id, "commit", "-q", "-m", "init");
  await git(repo, "branch", "annex/w");
  const wt = join(repo, "..", `${repo.split("/").pop()}-wt`);
  await git(repo, "worktree", "add", "-q", wt, "annex/w");
  writeFileSync(join(wt, "a.txt"), "one\ntwo\n");
  writeFileSync(join(wt, "b.txt"), "new\n");
  await git(wt, "add", ".");
  await git(wt, ...id, "commit", "-q", "-m", "work");
  if (opts.conflict) {
    writeFileSync(join(repo, "a.txt"), "uno\n");
    await git(repo, ...id, "commit", "-qam", "theirs");
  }
  const sha = (await git(repo, "rev-parse", "annex/w")).trim();
  return { repo, sha };
}

test("merges the confirmed commit into the checked-out branch when the tree is clean", async () => {
  const { repo, sha } = await repoWithWork();
  const r = await mergeForPerson(repo, "main", sha, "Merge annex/w");
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.where, realpathSync(repo));
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "new\n");
});

test("refuses a dirty checkout and one in the middle of a merge, touching nothing", async () => {
  const { repo, sha } = await repoWithWork();
  writeFileSync(join(repo, "a.txt"), "edited by the person\n");
  const dirty = await mergeForPerson(repo, "main", sha, "m");
  assert.ok(!dirty.ok && /uncommitted changes/.test(dirty.reason));
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "edited by the person\n");
  await git(repo, "checkout", "--", "a.txt");
  writeFileSync(join(repo, ".git", "MERGE_HEAD"), sha + "\n");
  const busy = await mergeForPerson(repo, "main", sha, "m");
  assert.ok(!busy.ok && /middle of a merge/.test(busy.reason));
});

test("a conflict is found before anything changes, and the files are named", async () => {
  const { repo, sha } = await repoWithWork({ conflict: true });
  const before = (await git(repo, "rev-parse", "HEAD")).trim();
  const r = await mergeForPerson(repo, "main", sha, "m");
  assert.ok(!r.ok);
  assert.deepEqual(r.conflicts, ["a.txt"]);
  assert.equal((await git(repo, "rev-parse", "HEAD")).trim(), before);
  assert.equal((await git(repo, "status", "--porcelain")).trim(), "", "the checkout is untouched");
});

test("a branch checked out nowhere is merged without a working tree", async () => {
  const { repo, sha } = await repoWithWork({ conflict: true });
  await git(repo, "checkout", "-q", "-b", "elsewhere");
  // resolve the conflict on annex/w so the merge is clean, then merge into main, which no worktree holds
  const r1 = await mergeForPerson(repo, "main", sha, "m");
  assert.ok(!r1.ok, "still conflicts");
  const { repo: r2, sha: s2 } = await repoWithWork();
  await git(r2, "checkout", "-q", "-b", "elsewhere");
  const r = await mergeForPerson(r2, "main", s2, "Merge annex/w");
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal((await git(r2, "rev-parse", "main")).trim(), s2, "a fast-forward moves main to the confirmed commit");
  assert.equal((await git(r2, "branch", "--show-current")).trim(), "elsewhere", "the person's checkout did not move");
});
