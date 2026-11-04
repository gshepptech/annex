import { test } from "node:test";
import assert from "node:assert/strict";
import { findClaude, fixCommand, setupChecker, setupStatus, UnknownFix, type CheckRun, type Where } from "./setup.ts";

// A Mac described by the files on it and what each command answers, so nothing here depends on
// this machine.
function mac(files: string[], answers: Record<string, { ok: boolean; out: string }>): { w: Where; run: CheckRun; ran: string[] } {
  const ran: string[] = [];
  const w: Where = { env: { PATH: "/usr/bin:/bin" }, home: "/Users/new", exists: (p) => files.includes(p) };
  const run: CheckRun = async (file, args) => {
    const cmd = [file, ...args].join(" ");
    ran.push(cmd);
    return answers[cmd] ?? { ok: false, out: `no answer for ${cmd}` };
  };
  return { w, run, ran };
}

const byId = (checks: Awaited<ReturnType<typeof setupStatus>>) => Object.fromEntries(checks.map((c) => [c.id, c]));

test("a brand-new Mac: nothing installed, every required check fails with a fix, and git is never run", async () => {
  const { w, run, ran } = mac([], { "/usr/bin/xcode-select -p": { ok: false, out: "xcode-select: error: unable to get active developer directory" } });
  const c = byId(await setupStatus(run, w));
  assert.deepEqual([c.claude!.ok, c.claude!.fix?.id], [false, "claude-install"]);
  assert.deepEqual([c.login!.ok, c.login!.fix], [false, undefined], "no log in before there is a claude");
  assert.deepEqual([c.git!.ok, c.git!.fix?.id], [false, "git-install"]);
  assert.deepEqual([c.github!.ok, c.github!.required, c.github!.detail, c.github!.fix], [false, false, "Needed only for private repositories", undefined], "no gh and no brew: no fix");
  assert.ok(!ran.some((r) => r.startsWith("git ")), "the /usr/bin/git stub would pop an installer");
});

test("a Mac that is set up: versions, the plan, and the GitHub account", async () => {
  const claude = "/Users/new/.local/bin/claude";
  const { w, run } = mac([claude, "/opt/homebrew/bin/gh"], {
    [`${claude} --version`]: { ok: true, out: "2.1.280 (Claude Code)" },
    [`${claude} auth status`]: { ok: true, out: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) },
    "/usr/bin/xcode-select -p": { ok: true, out: "/Library/Developer/CommandLineTools" },
    "git --version": { ok: true, out: "git version 2.50.1" },
    "/opt/homebrew/bin/gh auth status": { ok: true, out: "github.com\n  ✓ Logged in to github.com account octo (keyring)" },
  });
  const checks = await setupStatus(run, w);
  assert.ok(checks.every((x) => x.ok && !x.fix));
  const c = byId(checks);
  assert.equal(c.claude!.detail, "2.1.280 (Claude Code)");
  assert.equal(c.login!.detail, "Signed in (Max plan)");
  assert.equal(c.git!.detail, "git version 2.50.1");
  assert.equal(c.github!.detail, "Signed in as octo");
});

test("signed out of Claude (auth status exits 1 with JSON) and of GitHub", async () => {
  const { w, run } = mac(["/opt/homebrew/bin/claude", "/opt/homebrew/bin/gh"], {
    "/opt/homebrew/bin/claude --version": { ok: true, out: "2.1.280 (Claude Code)" },
    "/opt/homebrew/bin/claude auth status": { ok: false, out: JSON.stringify({ loggedIn: false, authMethod: "none" }, null, 2) },
    "/usr/bin/xcode-select -p": { ok: true, out: "/Library/Developer/CommandLineTools" },
    "git --version": { ok: true, out: "git version 2.50.1" },
    "/opt/homebrew/bin/gh auth status": { ok: false, out: "You are not logged into any GitHub hosts. To log in, run: gh auth login" },
  });
  const c = byId(await setupStatus(run, w));
  assert.deepEqual([c.login!.ok, c.login!.detail, c.login!.fix?.id], [false, "Not signed in", "claude-login"]);
  assert.deepEqual([c.github!.ok, c.github!.fix?.id], [false, "gh-login"]);
});

test("claude is found in the usual places, then on the PATH; none is null, not an error", () => {
  const w = (files: string[], env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/custom/bin" }): Where => ({ env, home: "/Users/new", exists: (p) => files.includes(p) });
  assert.equal(findClaude(w([])), null);
  assert.equal(findClaude(w(["/custom/bin/claude", "/Users/new/.local/bin/claude"])), "/Users/new/.local/bin/claude");
  assert.equal(findClaude(w(["/custom/bin/claude"])), "/custom/bin/claude");
  assert.equal(findClaude(w([], { CLAUDE_COMMAND: "/x/claude" })), "/x/claude");
});

test("results are kept a few seconds; Check again runs them fresh", async () => {
  const { w, run, ran } = mac([], {});
  const checks = setupChecker(run, w);
  await checks();
  const once = ran.length;
  await checks();
  assert.equal(ran.length, once);
  await checks(true);
  assert.equal(ran.length, once * 2);
});

test("fixes come only from the fixed map: unknown ids and anything shaped like a command are refused", () => {
  const w: Where = { env: { PATH: "/usr/bin" }, home: "/Users/new", exists: (p) => p === "/Users/new/.local/bin/claude" };
  assert.equal(fixCommand("claude-install", w).command, "curl -fsSL https://claude.ai/install.sh | bash");
  assert.equal(fixCommand("claude-login", w).command, "'/Users/new/.local/bin/claude' auth login");
  assert.equal(fixCommand("git-install", w).command, "xcode-select --install");
  for (const bad of ["rm -rf ~", "toString", "__proto__", "constructor", ""]) assert.throws(() => fixCommand(bad, w), UnknownFix, bad);
  assert.throws(() => fixCommand("gh-login", w), /cannot be done from here/, "no gh and no brew");
  assert.equal(fixCommand("gh-login", { ...w, exists: (p) => p === "/opt/homebrew/bin/brew" }).command, "brew install gh && gh auth login");
  assert.equal(fixCommand("gh-login", { ...w, exists: (p) => p === "/usr/bin/gh" }).command, "gh auth login");
});
