import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as P from "./projects.ts";

const id = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

test("only plain repository addresses can be cloned", () => {
  for (const ok of ["https://github.com/a/b.git", "ssh://git@host/a/b", "git@github.com:a/b.git"]) assert.equal(P.cloneUrlOk(ok), true, ok);
  for (const bad of ["--upload-pack=touch /tmp/x", "ext::sh -c touch% /tmp/pwned", "file:///etc", "https://x y", "/tmp/repo", "git@host:a b"]) assert.equal(P.cloneUrlOk(bad), false, bad);
});

test("config files: valid JSON only, never over someone else's change, backed up, never outside known projects", () => {
  const home = mkdtempSync(join(tmpdir(), "annex-home-"));
  const proj = join(home, "Projects", "app");
  mkdirSync(proj, { recursive: true });
  const backups = join(home, "backups");
  const known = [proj];
  assert.throws(() => P.readConfig("claude-md", "/etc", known, home), /not one of your projects/);
  assert.throws(() => P.readConfig("../../etc/passwd", proj, known, home), /Unknown kind/);
  const first = P.readConfig("project-settings", proj, known, home);
  assert.equal(first.exists, false);
  const saved = P.writeConfig({ kind: "project-settings", root: proj, text: '{ "model": "claude-sonnet-5" }\n', hash: first.hash, known, backups, home });
  assert.equal(readFileSync(join(proj, ".claude", "settings.json"), "utf8"), '{ "model": "claude-sonnet-5" }\n');
  assert.equal(saved.backup, null, "nothing to back up the first time");
  assert.throws(() => P.writeConfig({ kind: "project-settings", root: proj, text: '{\n  "a": 1,\n  "b" 2\n}', hash: saved.hash, known, backups, home }), /not valid JSON \(line 3\)/);
  assert.throws(() => P.writeConfig({ kind: "project-settings", root: proj, text: "{}", hash: first.hash, known, backups, home }), /changed since you opened it/);
  const again = P.writeConfig({ kind: "project-settings", root: proj, text: "{}\n", hash: saved.hash, known, backups, home });
  assert.ok(again.backup && existsSync(again.backup), "the old version is kept");
  assert.equal(readdirSync(join(proj, ".claude")).length, 1, "no stray temp or backup files in the project");
});

test("switching branches refuses a dirty checkout; publishing shows its commands first", async () => {
  const repo = mkdtempSync(join(tmpdir(), "annex-proj-"));
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1\n");
  g(repo, "add", ".");
  g(repo, ...id, "commit", "-qm", "init");
  await P.switchBranch(repo, "feature/x", true);
  assert.equal(g(repo, "branch", "--show-current"), "feature/x");
  writeFileSync(join(repo, "a.txt"), "2\n");
  await assert.rejects(P.switchBranch(repo, "main", false), /uncommitted changes/);
  await assert.rejects(P.switchBranch(repo, "-x", true), /not a branch name/);
  await assert.rejects(P.publishPlan(repo), /no remote/);
  const bare = mkdtempSync(join(tmpdir(), "annex-remote-"));
  g(bare, "init", "-q", "--bare");
  g(repo, "remote", "add", "origin", bare);
  const plan = await P.publishPlan(repo);
  assert.deepEqual(plan.commands, ["git push -u origin feature/x"], "no PR when the remote has no default branch to compare with");
  await assert.rejects(P.publish(repo, "main"), /on feature\/x now/);
  g(repo, "checkout", "--", "a.txt");
  const done = await P.publish(repo, "feature/x");
  assert.equal(done.pushed, "feature/x");
  assert.match(g(bare, "branch"), /feature\/x/);
});

test("turning a plugin on for you changes only that key in your settings, with a backup", () => {
  const home = mkdtempSync(join(tmpdir(), "annex-plug-"));
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "smith@the-tavern": [{ version: "4.8.0" }] } }));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "x", enabledPlugins: { "other@m": true } }));
  P.setPluginForYou("smith@the-tavern", true, join(home, "b"), home);
  const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s, { model: "x", enabledPlugins: { "other@m": true, "smith@the-tavern": true } });
  assert.deepEqual(P.pluginRows(home), [{ id: "smith@the-tavern", version: "4.8.0", enabledForYou: true }]);
  assert.throws(() => P.setPluginForYou("nope@x", true, join(home, "b"), home), /not installed/);
});
