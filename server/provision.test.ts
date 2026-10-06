import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWing } from "./wing.ts";
import { toolsFor, writeAgentSettings } from "./provision.ts";

const wing = parseWing("w", `[permissions]\nallow = ["npm", "git"]`);

test("only the crew can edit or commit, and nobody gets all of git", () => {
  for (const role of ["lead", "worker", "reviewer"] as const) {
    const tools = toolsFor(role, wing);
    assert.equal(tools.includes("Bash(git:*)"), false, `${role} has all of git`);
    assert.ok(tools.includes("Bash(git diff:*)"), `${role} can read diffs`);
  }
  assert.ok(toolsFor("worker", wing).includes("Bash(git commit:*)"));
  assert.ok(toolsFor("worker", wing).includes("Edit"));
  assert.equal(toolsFor("lead", wing).includes("Bash(git commit:*)"), false);
  assert.equal(toolsFor("reviewer", wing).includes("Edit"), false);
});

test("the settings file denies moving branches, pushing, and pointing git elsewhere", () => {
  const file = writeAgentSettings(mkdtempSync(join(tmpdir(), "annex-set-")));
  const deny: string[] = JSON.parse(readFileSync(file, "utf8")).permissions.deny;
  for (const c of ["git push", "git -C", "git checkout", "git reset", "git worktree"]) assert.ok(deny.includes(`Bash(${c}:*)`), c);
});

test("every agent runs in Claude Code's sandbox: the key unreadable, the repo's git folder writable, no unsandboxed retry", async () => {
  const { sandboxSettings, writeAgentSettings, SANDBOX_DOMAINS } = await import("./provision.ts");
  const { KEY_DIR } = await import("./key.ts");
  const s = sandboxSettings({ enabled: true, gitDir: "/r/.git", stateDir: "/b/.annex", allowedDomains: ["api.example.com"] }) as { allowUnsandboxedCommands: boolean; filesystem: { denyRead: string[]; allowWrite: string[] }; network: { allowedDomains: string[]; strictAllowlist: boolean } };
  assert.equal(s.allowUnsandboxedCommands, false);
  assert.deepEqual(s.filesystem.denyRead, [KEY_DIR, "/b/.annex/live"]);
  assert.ok(s.filesystem.allowWrite.includes("/r/.git"));
  assert.ok(s.network.strictAllowlist);
  assert.deepEqual(s.network.allowedDomains, [...SANDBOX_DOMAINS, "api.example.com"]);
  assert.equal(sandboxSettings({ enabled: false }), null);
  const file = writeAgentSettings(mkdtempSync(join(tmpdir(), "annex-sbx-")));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).sandbox.enabled, true, "on unless a wing turns it off");
  const { parseWing } = await import("./wing.ts");
  assert.deepEqual(parseWing("w", 'name = "W"\n').sandbox, { enabled: true, allowedDomains: [], allowWrite: [] });
  assert.equal(parseWing("w", 'name = "W"\n[sandbox]\nenabled = false\n').sandbox.enabled, false);
});
