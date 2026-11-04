// Provisions every wing twice against the live Paperclip and checks the second pass changes
// nothing. Wakes no agent. Run: node scripts/check-provision.ts
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../server/db.ts";
import { loadWings } from "../server/wing.ts";
import { Paperclip } from "../server/engine/paperclip.ts";
import { provision, writeAgentSettings } from "../server/provision.ts";

import { HOME as root } from "../server/paths.ts";
const stateDir = join(root, ".annex");
const store = new Store(join(stateDir, "annex.db"));
const pc = new Paperclip();
await pc.enableExperiments();
const settingsFile = writeAgentSettings(stateDir);
const claudeCommand = "/opt/homebrew/bin/claude";

for (const wing of loadWings(join(root, "wings"))) {
  const a = await provision({ wing, store, pc, stateDir, claudeCommand, settingsFile });
  const b = await provision({ wing, store, pc, stateDir, claudeCommand, settingsFile });
  const same = a.companyId === b.companyId && a.projectId === b.projectId && a.lead.id === b.lead.id && a.workers.map((w) => w.id).join() === b.workers.map((w) => w.id).join();
  console.log(`${same ? "PASS" : "FAIL"} ${wing.id}: company ${a.companyId.slice(0, 8)}, project ${a.projectId?.slice(0, 8) ?? "none"}, crew ${[a.lead, ...a.workers, a.reviewer].map((x) => `${x.name}@${x.desk}`).join(" ")}`);
  const agents = await pc.agents(a.companyId);
  console.log(`     Paperclip has ${agents.length} agents; idle: ${agents.every((x) => x.status !== "running")}`);
  if (a.workspace) {
    console.log(`     integration worktree: ${execFileSync("git", ["-C", a.workspace.integrationDir, "branch", "--show-current"]).toString().trim()}`);
    console.log(`     person's checkout still on: ${execFileSync("git", ["-C", wing.repo!.path, "branch", "--show-current"]).toString().trim()}, clean: ${execFileSync("git", ["-C", wing.repo!.path, "status", "--porcelain"]).toString().trim() === ""}`);
  }
}
