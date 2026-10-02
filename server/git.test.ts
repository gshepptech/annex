import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, prepareWing, taskWorktree, mergeTask, hasCommitsBeyond, removeTaskWorktree } from "./git.ts";
import { runCommand } from "./run.ts";

async function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "annex-git-"));
  const repo = join(dir, "repo");
  await git(dir, "init", "-q", "-b", "main", repo);
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
  return { dir, repo };
}

async function commitIn(cwd: string, file: string, text: string) {
  writeFileSync(join(cwd, file), text);
  await git(cwd, "add", ".");
  await git(cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", `edit ${file}`);
}

test("a wing's work never touches the person's checkout", async () => {
  const { dir, repo } = await makeRepo();
  const ws = await prepareWing(repo, "main", "annex/w", join(dir, "ws"));
  const t = await taskWorktree(ws, "t1");
  assert.equal(await hasCommitsBeyond(t, "annex/w"), false);
  await commitIn(t, "b.txt", "two\n");
  assert.equal(await hasCommitsBeyond(t, "annex/w"), true);

  const merged = await mergeTask(ws, "t1", "Merge t1");
  assert.equal(merged.ok, true);
  assert.equal(readFileSync(join(ws.integrationDir, "b.txt"), "utf8"), "two\n");
  // the person's checkout is still on main and has not changed
  assert.equal(await git(repo, "branch", "--show-current"), "main");
  assert.equal(existsSync(join(repo, "b.txt")), false);
  assert.equal(await git(repo, "rev-list", "--count", "main"), "1");

  await removeTaskWorktree(ws, "t1", true);
  assert.equal(existsSync(t), false);
});

test("a conflicting merge is aborted and reported", async () => {
  const { dir, repo } = await makeRepo();
  const ws = await prepareWing(repo, "main", "annex/w", join(dir, "ws"));
  const t1 = await taskWorktree(ws, "t1");
  const t2 = await taskWorktree(ws, "t2");
  await commitIn(t1, "a.txt", "from t1\n");
  await commitIn(t2, "a.txt", "from t2\n");
  assert.equal((await mergeTask(ws, "t1", "Merge t1")).ok, true);
  const second = await mergeTask(ws, "t2", "Merge t2");
  assert.equal(second.ok, false);
  assert.equal(await git(ws.integrationDir, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(ws.integrationDir, "a.txt"), "utf8"), "from t1\n");
});

test("commands report exit codes, output and timeouts", async () => {
  const ok = await runCommand("echo hello && exit 0", tmpdir());
  assert.deepEqual([ok.exitCode, ok.output.trim(), ok.timedOut], [0, "hello", false]);
  const bad = await runCommand("echo nope >&2; exit 3", tmpdir());
  assert.deepEqual([bad.exitCode, bad.output.trim()], [3, "nope"]);
  const slow = await runCommand("sleep 5", tmpdir(), 200);
  assert.equal(slow.timedOut, true);
  assert.notEqual(slow.exitCode, 0);
});
