// Turns a wing file into a running wing: a Paperclip company, a project whose tasks each get their
// own worktree cut from the integration branch, and a crew. Safe to run on every start; it only
// creates what is missing.

import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store, AgentRow } from "./db.ts";
import type { Wing } from "./wing.ts";
import { prepareWing, type WingWorkspace } from "./git.ts";
import { KEY_DIR } from "./key.ts";
import type { Paperclip, AgentSpec } from "./engine/paperclip.ts";
import { leadInstructions, workerInstructions, reviewerInstructions, REPORT_SCRIPT } from "./prompts.ts";
import { findPlugin, mcpRule, type PluginInfo } from "./plugins.ts";

export interface Provisioned {
  wing: Wing;
  companyId: string;
  projectId: string | null;
  workspace: WingWorkspace | null;
  lead: AgentRow;
  workers: AgentRow[];
  reviewer: AgentRow;
  // plugins the wing file names that are not installed, so they could not be enabled
  missingPlugins: string[];
}

// Names are unique across every office, so the party roster never shows two of the same person.
const NAMES = {
  lead: ["Handler", "Marshal", "Warden", "Skipper", "Foreman", "Keeper", "Captain", "Steward", "Chief", "Bosun"],
  reviewer: ["Auditor", "Inspector", "Examiner", "Assessor", "Proctor", "Arbiter", "Checker", "Censor", "Verifier", "Notary"],
  worker: [
    "Kestrel", "Marlin", "Wren", "Otter", "Heron", "Lynx", "Finch", "Badger", "Osprey", "Puffin", "Ferret", "Plover",
    "Raven", "Stoat", "Lark", "Gecko", "Pike", "Ibis", "Vole", "Tern", "Moth", "Newt", "Shrike", "Egret", "Hare",
    "Merlin", "Petrel", "Dace", "Skink", "Robin", "Swift", "Teal", "Marten", "Dunlin", "Sable", "Weasel", "Kite", "Avocet",
  ],
} as const;

export function nextName(role: AgentRow["role"], taken: Set<string>): string {
  const pool = NAMES[role];
  const free = pool.find((n) => !taken.has(n));
  if (free) return free;
  let i = 2;
  while (taken.has(`${pool[0]} ${i}`)) i++;
  return `${pool[0]} ${i}`;
}

// Read-only tools every agent may use, plus the shell commands its role needs. A command the
// list does not cover is refused rather than asked about, because nobody is there to answer.
const BASE_TOOLS = ["Read", "Glob", "Grep", "Skill", "TodoWrite"];
// No curl: Annex's own API is on this machine, and an agent has no business calling it.
const BASE_SHELL = ["ls", "cat", "head", "tail", "pwd", "wc", "diff"];
// Git, by subcommand: everyone may read history, only the crew may commit, and nobody may move
// branches, push, or point git at another directory (DENIED_GIT below wins over any allow).
const READ_GIT = ["git status", "git log", "git diff", "git show", "git rev-parse", "git branch --show-current", "git ls-files"];
const WORKER_GIT = ["git add", "git commit", "git restore", "git rm", "git mv", "git stash"];
export const DENIED_GIT = [
  "git push", "git -C", "git --git-dir", "git --work-tree", "git checkout", "git switch", "git reset",
  "git rebase", "git merge", "git worktree", "git branch -D", "git branch -d", "git branch -f", "git clean", "git remote", "git config",
];

export function toolsFor(role: AgentRow["role"], wing: Wing, plugins: PluginInfo[] = []): string[] {
  const shell = new Set([...BASE_SHELL, ...READ_GIT, `node ${REPORT_SCRIPT}`]);
  if (role === "worker") {
    for (const c of WORKER_GIT) shell.add(c);
    // `git` in a wing's allow list means the commit-level commands above, never all of git
    for (const c of wing.allow) if (c !== "git") shell.add(c);
  }
  const edit = role === "worker" ? ["Write", "Edit"] : [];
  // a plugin's commands may start subagents and call its own MCP servers
  const fromPlugins = plugins.length ? ["Agent", ...plugins.flatMap((p) => p.mcpServers.map((s) => mcpRule(p.name, s)))] : [];
  return [...BASE_TOOLS, ...edit, ...fromPlugins, ...[...shell].map((c) => `Bash(${c}:*)`)];
}

// Claude settings every Annex agent runs with: the person's global CLAUDE.md and auto-memory are
// hidden, and together with `--setting-sources project,local` so are their hooks and plugins.
// Plugins an office names are the exception: they are enabled here, for that office only.
// The folder holding Annex's API key is off limits to agents: the file tools by path, and any
// shell command that names it anywhere (a wildcard rule matches the path in any position, as an
// argument or a relative path). Rules match the command as written, so a shell glob that spells
// the path differently, or an office that lets its crew run node, npm or npx (arbitrary code as
// you), can still reach it; see key.ts.
export function keyDenies(dir = KEY_DIR): string[] {
  const abs = dir.replace(/\/$/, "");
  const tilde = abs.startsWith(homedir()) ? `~${abs.slice(homedir().length)}` : abs;
  const tail = abs.split("/").slice(-2).join("/");
  const reads = ["Read", "Grep", "Glob", "Edit", "Write"].flatMap((t) => [`${t}(/${abs}/**)`, `${t}(${tilde}/**)`]);
  return [...reads, `Bash(*${tail}*)`, "Bash(curl:*)", "Bash(wget:*)"];
}

export function writeAgentSettings(dir: string, plugins: string[] = []): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "claude-settings.json");
  const settings = {
    claudeMdExcludes: [join(homedir(), ".claude", "CLAUDE.md"), join(homedir(), ".claude", "**", "CLAUDE.md")],
    autoMemoryEnabled: false,
    // deny rules beat any allow, so these hold whatever a wing file lists
    permissions: { deny: [...DENIED_GIT.map((c) => `Bash(${c}:*)`), ...keyDenies()] },
    ...(plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((p) => [p, true])) } : {}),
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

  const plugins = wing.plugins.map((id) => findPlugin(id)).filter((p): p is PluginInfo => p !== null);
  const missingPlugins = wing.plugins.filter((id) => !plugins.some((p) => p.id === id));
  const settingsFile = plugins.length ? writeAgentSettings(wingDir, plugins.map((p) => p.id)) : opts.settingsFile;

  const existing = new Set((await pc.agents(companyId)).map((a) => a.id));
  for (const a of store.agents(wing.id)) if (!existing.has(a.id)) store.removeAgent(a.id);

  const spec = (role: AgentRow["role"], name: string, extra: Partial<AgentSpec>): AgentSpec => ({
    name,
    role: role === "lead" ? "ceo" : role === "reviewer" ? "qa" : "engineer",
    title: role === "lead" ? `${wing.name} lead` : role === "reviewer" ? `${wing.name} reviewer` : `${wing.name} crew`,
    model: role === "lead" ? wing.crew.leadModel : role === "reviewer" ? wing.crew.reviewerModel : wing.crew.workerModel,
    instructions: role === "lead" ? leadInstructions(wing, plugins) : role === "reviewer" ? reviewerInstructions(wing) : workerInstructions(wing, plugins),
    claudeCommand: opts.claudeCommand,
    settingsFile,
    allowedTools: toolsFor(role, wing, role === "reviewer" ? [] : plugins),
    // the lead plans from its own workspace; this lets its Read, Glob and Grep reach the repo
    ...(role === "lead" && workspace ? { readDirs: [workspace.integrationDir] } : {}),
    ...extra,
  });

  const hire = async (role: AgentRow["role"], name: string, reportsTo?: string): Promise<AgentRow> => {
    const created = await pc.createAgent(companyId!, spec(role, name, reportsTo ? { reportsTo } : {}));
    return store.addAgent({ id: created.id, wingId: wing.id, role, name });
  };

  // Anyone whose name another office already uses gets a fresh one; offices are named in order,
  // so the office that had a name first keeps it.
  const elsewhere = new Set(store.allAgents().filter((a) => a.wingId !== wing.id && a.wingId < wing.id).map((a) => a.name));
  const taken = () => new Set(store.allAgents().map((a) => a.name));
  for (const a of store.agents(wing.id)) {
    if (!elsewhere.has(a.name)) continue;
    const name = nextName(a.role, taken());
    store.renameAgent(a.id, name);
    await pc.patchAgent(a.id, { name });
  }
  for (const a of store.agents(wing.id)) await pc.syncAgent(a.id, spec(a.role, a.name, {}));

  const crew = () => store.agents(wing.id);
  const lead = crew().find((a) => a.role === "lead") ?? (await hire("lead", nextName("lead", taken())));
  const reviewer = crew().find((a) => a.role === "reviewer") ?? (await hire("reviewer", nextName("reviewer", taken()), lead.id));
  const workers = crew().filter((a) => a.role === "worker");
  while (workers.length < wing.crew.workers) workers.push(await hire("worker", nextName("worker", taken()), lead.id));

  return { wing, companyId, projectId, workspace, lead, workers, reviewer, missingPlugins };
}
