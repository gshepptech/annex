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
  writeFileSync(join(repo, "new.txt"), "n\n");
  const seen = (await P.branches(repo)).changes;
  assert.deepEqual(seen, [" M a.txt", "?? new.txt"], "untracked files count as changes too");
  await assert.rejects(P.commitAll(repo, "work", [" M a.txt"]), /different from what you were shown/);
  await assert.rejects(P.commitAll(repo, "  ", seen), /commit message/);
  await P.commitAll(repo, "work", seen);
  assert.equal(g(repo, "log", "-1", "--format=%s"), "work");
  assert.deepEqual((await P.branches(repo)).changes, []);
  const done = await P.publish(repo, "feature/x");
  assert.equal(done.pushed, "feature/x");
  assert.match(g(bare, "branch"), /feature\/x/);
});

test("turning a plugin on for you changes only that key in your settings, with a backup", () => {
  const home = mkdtempSync(join(tmpdir(), "annex-plug-"));
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "lint-kit@acme": [{ version: "4.8.0" }] } }));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "x", enabledPlugins: { "other@m": true } }));
  P.setPluginForYou("lint-kit@acme", true, join(home, "b"), home);
  const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s, { model: "x", enabledPlugins: { "other@m": true, "lint-kit@acme": true } });
  assert.deepEqual(P.pluginRows(home), [{ id: "lint-kit@acme", version: "4.8.0", enabledForYou: true }]);
  assert.throws(() => P.setPluginForYou("nope@x", true, join(home, "b"), home), /not installed/);
});

test("claude mcp list is read into rows; servers from plugins and claude.ai are not yours to remove here", () => {
  const rows = P.parseMcpList("Checking MCP server health…\n\nclaude.ai Docs: https://x/mcp - ✔ Connected\nplugin:pw:pw: npx @playwright/mcp - ✔ Connected\ngithub: npx -y gh-mcp - ✗ Failed to connect\nlinear: https://mcp.linear.app (HTTP) - ! Needs authentication\n");
  assert.deepEqual(rows.map((r) => [r.name, r.ok, r.yours]), [["claude.ai Docs", true, false], ["plugin:pw:pw", true, false], ["github", false, true], ["linear", false, true]]);
  assert.equal(rows[3]!.status, "Needs authentication");
});

test("the projects list: added folders, office repos and sessions' folders, with ~/Projects repos, less forgotten ones", () => {
  const home = mkdtempSync(join(tmpdir(), "annex-known-"));
  const repo = (p: string) => (mkdirSync(join(p, ".git"), { recursive: true }), p);
  const inProjects = repo(join(home, "Projects", "app"));
  const otherInProjects = repo(join(home, "Projects", "old"));
  mkdirSync(join(home, "Projects", "not-a-repo"));
  const added = repo(join(home, "Work", "client"));
  const office = repo(join(home, "Code", "office-repo"));
  const seen = join(home, "scratch");
  mkdirSync(seen);
  const gone = join(home, "deleted");
  assert.deepEqual(
    P.knownProjects({ added: [added, gone], offices: [office], seen: [seen, gone], forgotten: [otherInProjects, office] }, home),
    [inProjects, office, added, seen].sort(),
    "a forgotten ~/Projects repo goes; an office's repo stays even when forgotten; deleted folders never show",
  );
  assert.deepEqual(P.knownProjects({ forgotten: [seen], seen: [seen] }, home), [inProjects, otherInProjects], "a forgotten session folder goes");
});

test("a new project is a fresh repo in the folder you chose; bad names and non-empty folders are refused", async () => {
  const parent = mkdtempSync(join(tmpdir(), "annex-new-"));
  const made = await P.createProject(parent, "  shop ");
  assert.equal(made, join(parent, "shop"));
  assert.equal(g(made, "log", "--format=%s"), "Start the project");
  assert.equal(readFileSync(join(made, "README.md"), "utf8"), "# shop\n");
  for (const bad of ["", " ", ".", "..", "a/b", "../x", "a\\b"]) await assert.rejects(P.createProject(parent, bad), P.ProjectError, JSON.stringify(bad));
  await assert.rejects(P.createProject(parent, "shop"), /already exists and is not empty/);
  writeFileSync(join(parent, "file"), "x");
  await assert.rejects(P.createProject(parent, "file"), /already exists/);
  await assert.rejects(P.createProject(join(parent, "missing"), "x"), /is not a folder/);
  await assert.rejects(P.createProject("relative/dir", "x"), /full path/);
  mkdirSync(join(parent, "empty"));
  assert.equal(await P.createProject(parent, "empty"), join(parent, "empty"), "an empty folder of that name is used");
  assert.deepEqual(readdirSync(parent).sort(), ["empty", "file", "shop"], "nothing else was made");
  // a new Mac has no ~/Projects yet; that one folder is made, any other must exist
  const home = mkdtempSync(join(tmpdir(), "annex-newmac-"));
  assert.equal(await P.createProject(join(home, "Projects"), "first", home), join(home, "Projects", "first"));
  await assert.rejects(P.createProject(join(home, "Elsewhere"), "x", home), /is not a folder/);
});

test("a folder you add must exist and be a folder; it is kept without a trailing slash", () => {
  const dir = mkdtempSync(join(tmpdir(), "annex-add-"));
  writeFileSync(join(dir, "f"), "x");
  assert.equal(P.existingFolder(`${dir}/`), dir);
  assert.throws(() => P.existingFolder(join(dir, "f")), /not a folder/);
  assert.throws(() => P.existingFolder(join(dir, "nope")), /not a folder/);
  assert.throws(() => P.existingFolder("~/x"), /full path/);
});
