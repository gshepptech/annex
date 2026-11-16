// Live check of server/engine/paperclip.ts against a running Paperclip. Makes only calls that do
// not wake an agent, so it costs no Claude usage. Run: node scripts/check-engine.ts
import { Paperclip } from "../server/engine/paperclip.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { findClaude } from "../server/setup.ts";

const claude = findClaude();
if (!claude) {
  console.error("claude not found: install Claude Code or set CLAUDE_COMMAND to its path");
  process.exit(1);
}
const pc = new Paperclip();
const ok = (label: string, cond: unknown) => { console.log(`${cond ? "PASS" : "FAIL"} ${label}`); if (!cond) process.exitCode = 1; };

const health = await pc.health();
ok(`health ${health.version}`, health.status === "ok");
await pc.enableExperiments();

const repo = mkdtempSync(join(tmpdir(), "annex-engine-"));
execFileSync("git", ["init", "-q", "-b", "main", repo]);
execFileSync("git", ["-C", repo, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);

const company = await pc.createCompany(`annex-enginecheck-${Date.now()}`, "Annex engine check");
ok("company created", company.id);
const frames: string[] = [];
const stop = pc.subscribe(company.id, (f) => frames.push(f.type));
await new Promise((r) => setTimeout(r, 800));

const { projectId, workspaceId } = await pc.createProject(company.id, {
  name: "check", repo, baseRef: "main", branchTemplate: "annex/check--{{issue.identifier}}", worktreeDir: join(repo, "..", "wt"),
});
ok("project and workspace created", projectId && workspaceId);

const lead = await pc.createAgent(company.id, {
  name: "Lead", role: "ceo", title: "Lead", model: "claude-haiku-4-5-20251001", instructions: "# Lead\nDo nothing.",
  claudeCommand: claude, settingsFile: "/dev/null", allowedTools: ["Read"],
});
const cfg = (await pc.agents(company.id)).find((a) => a.id === lead.id)!;
ok("agent has skip-permissions off", cfg.adapterConfig.dangerouslySkipPermissions === false);
ok("agent timer off, one run at a time", JSON.stringify(cfg.runtimeConfig.heartbeat).includes('"enabled":false') && JSON.stringify(cfg.runtimeConfig.heartbeat).includes('"maxConcurrentRuns":1'));
ok("agent uses the cli engine and the resolved claude", cfg.adapterConfig.engine === "cli" && cfg.adapterConfig.command === claude);

await pc.patchAgent(lead.id, { title: "Lead (checked)" });
await new Promise((r) => setTimeout(r, 1500));
stop();
ok(`websocket delivered frames (${[...new Set(frames)].join(", ")})`, frames.length > 0);
ok("issues list works", Array.isArray(await pc.issues(company.id)));
