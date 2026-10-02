// Turns a wing file into a running wing: a Paperclip company, a project whose tasks each get their
// own worktree cut from the integration branch, and a crew. Safe to run on every start; it only
// creates what is missing.

import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store, AgentRow } from "./db.ts";
import type { Wing } from "./wing.ts";
import { prepareWing, type WingWorkspace } from "./git.ts";
import type { Paperclip, AgentSpec } from "./engine/paperclip.ts";
import { leadInstructions, workerInstructions, reviewerInstructions } from "./prompts.ts";

export interface Provisioned {
  wing: Wing;
  companyId: string;
  projectId: string | null;
  workspace: WingWorkspace | null;
  lead: AgentRow;
  workers: AgentRow[];
  reviewer: AgentRow;
}

const CODENAMES = ["Kestrel", "Marlin", "Wren", "Otter", "Heron", "Lynx", "Finch", "Badger"];

// Read-only tools every agent may use, plus the shell commands its role needs. A command the
// list does not cover is refused rather than asked about, because nobody is there to answer.
const BASE_TOOLS = ["Read", "Glob", "Grep", "Skill", "TodoWrite"];
const BASE_SHELL = ["ls", "cat", "head", "tail", "pwd", "wc", "diff", "curl"];
// Git, by subcommand: everyone may read history, only the crew may commit, and nobody may move
// branches, push, or point git at another directory (DENIED_GIT below wins over any allow).
const READ_GIT = ["git status", "git log", "git diff", "git show", "git rev-parse", "git branch --show-current", "git ls-files"];
const WORKER_GIT = ["git add", "git commit", "git restore", "git rm", "git mv", "git stash"];
export const DENIED_GIT = [
  "git push", "git -C", "git --git-dir", "git --work-tree", "git checkout", "git switch", "git reset",
  "git rebase", "git merge", "git worktree", "git branch -D", "git branch -d", "git branch -f", "git clean", "git remote", "git config",
];

export function toolsFor(role: AgentRow["role"], wing: Wing): string[] {
  const shell = new Set([...BASE_SHELL, ...READ_GIT]);
  if (role === "worker") {
    for (const c of WORKER_GIT) shell.add(c);
    // `git` in a wing's allow list means the commit-level commands above, never all of git
    for (const c of wing.allow) if (c !== "git") shell.add(c);
  }
  const edit = role === "worker" ? ["Write", "Edit"] : [];
  return [...BASE_TOOLS, ...edit, ...[...shell].map((c) => `Bash(${c}:*)`)];
}

// Claude settings every Annex agent runs with: the person's global CLAUDE.md and auto-memory are
// hidden, and together with `--setting-sources project,local` so are their hooks and plugins.
export function writeAgentSettings(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "claude-settings.json");
  const settings = {
    claudeMdExcludes: [join(homedir(), ".claude", "CLAUDE.md"), join(homedir(), ".claude", "**", "CLAUDE.md")],
    autoMemoryEnabled: false,
    // deny rules beat any allow, so these hold whatever a wing file lists
    permissions: { deny: DENIED_GIT.map((c) => `Bash(${c}:*)`) },
  };
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}

export async function provision(opts: {
  wing: Wing;
  store: Store;
  pc: Paperclip;
  stateDir: string;
  claudeCommand: string;
  settingsFile: string;
}): Promise<Provisioned> {
  const { wing, store, pc } = opts;
  const row = store.ensureWing(wing.id, wing.initialMode);
  const wingDir = join(opts.stateDir, "wings", wing.id);

  let companyId = row.companyId;
  if (companyId && !(await pc.companies()).some((c) => c.id === companyId)) companyId = null;
  if (!companyId) {
    const c = await pc.createCompany(`Annex · ${wing.name}`, `Annex wing "${wing.id}". Managed by Annex; edit wings/${wing.id}/wing.toml instead of this company.`);
    companyId = c.id;
    store.setCompany(wing.id, companyId);
    // a new company means any crew recorded for the old one is gone
    for (const a of store.agents(wing.id)) store.removeAgent(a.id);
  }

  let workspace: WingWorkspace | null = null;
  let projectId = row.projectId;
  if (wing.repo) {
    workspace = await prepareWing(wing.repo.path, wing.repo.baseBranch, wing.repo.integrationBranch, wingDir);
    if (projectId && !(await pc.projects(companyId)).some((p) => p.id === projectId)) projectId = null;
    if (!projectId) {
      const p = await pc.createProject(companyId, {
        name: wing.repo.path.split("/").pop() ?? wing.id,
        repo: wing.repo.path,
        baseRef: wing.repo.integrationBranch,
        branchTemplate: `${wing.repo.integrationBranch}--{{issue.identifier}}`,
        worktreeDir: join(wingDir, "tasks"),
      });
      projectId = p.projectId;
      store.setProject(wing.id, projectId);
    }
  }

  const existing = new Set((await pc.agents(companyId)).map((a) => a.id));
  for (const a of store.agents(wing.id)) if (!existing.has(a.id)) store.removeAgent(a.id);

  const spec = (role: AgentRow["role"], name: string, extra: Partial<AgentSpec>): AgentSpec => ({
    name,
    role: role === "lead" ? "ceo" : role === "reviewer" ? "qa" : "engineer",
    title: role === "lead" ? `${wing.name} lead` : role === "reviewer" ? `${wing.name} reviewer` : `${wing.name} crew`,
    model: role === "lead" ? wing.crew.leadModel : role === "reviewer" ? wing.crew.reviewerModel : wing.crew.workerModel,
    instructions: role === "lead" ? leadInstructions(wing) : role === "reviewer" ? reviewerInstructions(wing) : workerInstructions(wing),
    claudeCommand: opts.claudeCommand,
    settingsFile: opts.settingsFile,
    allowedTools: toolsFor(role, wing),
    ...extra,
  });

  const hire = async (role: AgentRow["role"], name: string, reportsTo?: string): Promise<AgentRow> => {
    const created = await pc.createAgent(companyId!, spec(role, name, reportsTo ? { reportsTo } : {}));
    return store.addAgent({ id: created.id, wingId: wing.id, role, name });
  };

  for (const a of store.agents(wing.id)) await pc.syncAgent(a.id, spec(a.role, a.name, {}));

  const crew = () => store.agents(wing.id);
  const lead = crew().find((a) => a.role === "lead") ?? (await hire("lead", "Handler"));
  const reviewer = crew().find((a) => a.role === "reviewer") ?? (await hire("reviewer", "Auditor", lead.id));
  const workers = crew().filter((a) => a.role === "worker");
  const used = new Set(workers.map((w) => w.name));
  for (const name of CODENAMES) {
    if (workers.length >= wing.crew.workers) break;
    if (used.has(name)) continue;
    workers.push(await hire("worker", name, lead.id));
  }

  return { wing, companyId, projectId, workspace, lead, workers, reviewer };
}
