// Your projects and your Claude setup, from the browser: clone, branches, publishing (push and a
// pull request), the files that configure Claude, MCP servers, and plugins. Everything here is
// the person acting on their own machine, each step behind a confirmation in the page; Annex's
// agents never reach any of it (they have no key, see key.ts).
//
// Files are never named by the browser: it names a kind ("your settings", "this project's
// CLAUDE.md") and a project folder Annex already knows, and the path is built here.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export class ProjectError extends Error {}

// ---------- the folders Annex knows ----------

export function knownProjects(extra: string[] = [], home = homedir()): string[] {
  const root = join(home, "Projects");
  const found = new Set<string>(extra.filter(Boolean));
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && existsSync(join(root, d.name, ".git"))) found.add(join(root, d.name));
  } catch {
    // no ~/Projects
  }
  // a folder deleted since a session ran there is not offered
  return [...found].filter((p) => existsSync(p)).sort();
}

function mustKnow(root: string, known: string[]): string {
  if (!known.includes(root)) throw new ProjectError("That folder is not one of your projects");
  return root;
}

// ---------- git ----------

async function git(cwd: string, ...args: string[]): Promise<string> {
  // a credential prompt would hang the server; fail instead and say so
  const { stdout } = await run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60_000 });
  // only the end: leading spaces carry meaning (git status puts the change kind in column one)
  return stdout.trimEnd();
}

function gitError(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).trim().split("\n").slice(-3).join(" ");
}

// https, ssh, or the scp-like git@host:path form; nothing that git would read as an option or a
// remote helper (ext::), and no spaces.
export function cloneUrlOk(url: string): boolean {
  if (/\s/.test(url) || url.startsWith("-") || /::/.test(url)) return false;
  return /^https:\/\/[^/]+\/.+/.test(url) || /^ssh:\/\/[^/]+\/.+/.test(url) || /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url);
}

export async function clone(url: string, name: string | null, home = homedir()): Promise<string> {
  if (!cloneUrlOk(url)) throw new ProjectError("Give a repository address that starts with https://, ssh:// or git@host:");
  const folder = (name?.trim() || basename(url).replace(/\.git$/, "")).trim();
  if (!/^[\w.-]+$/.test(folder) || folder.startsWith(".")) throw new ProjectError("The folder name may use letters, digits, dots, dashes and underscores");
  const target = join(home, "Projects", folder);
  if (existsSync(target)) throw new ProjectError(`${target} already exists`);
  mkdirSync(dirname(target), { recursive: true });
  try {
    await git(dirname(target), "clone", "--", url, target);
  } catch (err) {
    throw new ProjectError(`git clone failed: ${gitError(err)}`);
  }
  return target;
}

export interface BranchView {
  current: string | null;
  branches: string[];
  dirty: boolean;
  // every changed or new file, as `git status --short` shows them
  changes: string[];
  busy: string | null;
  remote: string | null;
  // commits on the current branch not yet on its upstream, or null when it has no upstream
  ahead: number | null;
  defaultBranch: string | null;
}

export async function branches(root: string): Promise<BranchView> {
  const current = (await git(root, "branch", "--show-current").catch(() => "")) || null;
  const list = (await git(root, "branch", "--format=%(refname:short)")).split("\n").filter(Boolean);
  const dirty = !!(await git(root, "status", "--porcelain", "--untracked-files=no"));
  const changes = (await git(root, "-c", "core.quotePath=false", "status", "--short", "--untracked-files=all")).split("\n").filter(Boolean);
  const remote = (await git(root, "remote").catch(() => "")).split("\n").filter(Boolean)[0] ?? null;
  let ahead: number | null = null;
  try {
    ahead = Number(await git(root, "rev-list", "--count", "@{upstream}..HEAD"));
  } catch {
    ahead = null;
  }
  let defaultBranch: string | null = null;
  if (remote) defaultBranch = (await git(root, "symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`).catch(() => "")).replace(`${remote}/`, "") || null;
  return { current, branches: list, dirty, changes, busy: await midOperation(root), remote, ahead, defaultBranch };
}

async function midOperation(root: string): Promise<string | null> {
  const gitDir = await git(root, "rev-parse", "--absolute-git-dir");
  const marks: [string, string][] = [["MERGE_HEAD", "merge"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["BISECT_LOG", "bisect"]];
  for (const [f, what] of marks) if (existsSync(join(gitDir, f))) return what;
  return null;
}

// Commit everything changed in the checkout (the list you were shown), with your message.
export async function commitAll(root: string, message: string, expected: string[]): Promise<string> {
  if (!message.trim()) throw new ProjectError("Write a commit message");
  const b = await branches(root);
  if (b.busy) throw new ProjectError(`The checkout is in the middle of a ${b.busy}; finish or abort it first`);
  if (!b.changes.length) throw new ProjectError("Nothing to commit");
  if (JSON.stringify(b.changes) !== JSON.stringify(expected)) throw new ProjectError("The changes are different from what you were shown; look again before committing");
  try {
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", message.trim());
  } catch (err) {
    throw new ProjectError(`git commit failed: ${gitError(err)}`);
  }
  return (await git(root, "rev-parse", "--short", "HEAD")).trim();
}

export const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]{1,100}(?<![./])$/;

export async function switchBranch(root: string, branch: string, create: boolean): Promise<string> {
  if (!BRANCH_NAME.test(branch)) throw new ProjectError("That is not a branch name git accepts");
  const b = await branches(root);
  if (b.busy) throw new ProjectError(`The checkout is in the middle of a ${b.busy}; finish or abort it first`);
  if (b.dirty) throw new ProjectError("The checkout has uncommitted changes to tracked files; commit or stash them first");
  if (!create && !b.branches.includes(branch)) throw new ProjectError(`There is no branch "${branch}"`);
  if (create && b.branches.includes(branch)) throw new ProjectError(`"${branch}" already exists`);
  try {
    await git(root, "switch", ...(create ? ["-c"] : []), branch);
  } catch (err) {
    throw new ProjectError(`git switch failed: ${gitError(err)}`);
  }
  return branch;
}

// What publishing would do, shown before it is done.
export async function publishPlan(root: string): Promise<{ branch: string; remote: string; commands: string[]; pr: boolean }> {
  const b = await branches(root);
  if (!b.current) throw new ProjectError("The checkout is not on a branch");
  if (!b.remote) throw new ProjectError("This repo has no remote to publish to");
  const pr = !!b.defaultBranch && b.current !== b.defaultBranch;
  return {
    branch: b.current,
    remote: b.remote,
    pr,
    commands: [`git push -u ${b.remote} ${b.current}`, ...(pr ? [`gh pr create --fill --head ${b.current}`] : [])],
  };
}

// Push (never forced) and, off the default branch, open a pull request with gh.
export async function publish(root: string, expectBranch: string): Promise<{ pushed: string; pr: string | null }> {
  const plan = await publishPlan(root);
  if (plan.branch !== expectBranch) throw new ProjectError(`The checkout is on ${plan.branch} now, not ${expectBranch}; look again before publishing`);
  try {
    await git(root, "push", "-u", plan.remote, plan.branch);
  } catch (err) {
    throw new ProjectError(`git push failed: ${gitError(err)}`);
  }
  if (!plan.pr) return { pushed: plan.branch, pr: null };
  try {
    const { stdout } = await run("gh", ["pr", "create", "--fill", "--head", plan.branch], { cwd: root, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeout: 120_000 });
    return { pushed: plan.branch, pr: stdout.trim().split("\n").pop() ?? null };
  } catch (err) {
    const msg = gitError(err);
    // a PR that already exists is not a failure of the push
    if (/already exists/i.test(msg)) return { pushed: plan.branch, pr: msg.match(/https:\/\/\S+/)?.[0] ?? null };
    throw new ProjectError(`Pushed ${plan.branch}, but opening the pull request failed: ${msg}`);
  }
}

// ---------- the files that configure Claude ----------

export const CONFIG_KINDS = {
  "user-settings": { label: "Your Claude settings", json: true, project: false, file: (_r: string, home: string) => join(home, ".claude", "settings.json") },
  "project-settings": { label: "Project settings (shared)", json: true, project: true, file: (r: string) => join(r, ".claude", "settings.json") },
  "project-local": { label: "Project settings (just you)", json: true, project: true, file: (r: string) => join(r, ".claude", "settings.local.json") },
  "claude-md": { label: "CLAUDE.md", json: false, project: true, file: (r: string) => join(r, "CLAUDE.md") },
  "mcp-json": { label: "Project MCP servers (.mcp.json)", json: true, project: true, file: (r: string) => join(r, ".mcp.json") },
} as const;
export type ConfigKind = keyof typeof CONFIG_KINDS;

function configPath(kind: string, root: string | null, known: string[], home: string): { path: string; json: boolean } {
  const k = CONFIG_KINDS[kind as ConfigKind];
  if (!k) throw new ProjectError("Unknown kind of file");
  if (k.project && !root) throw new ProjectError("Choose a project");
  return { path: k.file(k.project ? mustKnow(root!, known) : "", home), json: k.json };
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

export function readConfig(kind: string, root: string | null, known: string[], home = homedir()): { path: string; text: string; hash: string; exists: boolean } {
  const { path } = configPath(kind, root, known, home);
  const exists = existsSync(path);
  const text = exists ? readFileSync(path, "utf8") : "";
  return { path, text, hash: hashOf(text), exists };
}

// Saves a config file: valid JSON where it must be, only if nobody changed it since it was read
// (the hash), with the old version copied to Annex's backups first, written atomically.
export function writeConfig(o: { kind: string; root: string | null; text: string; hash: string; known: string[]; backups: string; home?: string }): { path: string; hash: string; backup: string | null } {
  const home = o.home ?? homedir();
  const { path, json } = configPath(o.kind, o.root, o.known, home);
  if (json && o.text.trim()) {
    try {
      JSON.parse(o.text);
    } catch (err) {
      // Node names the line for most mistakes; say it first, so it is easy to find
      const msg = (err as Error).message;
      const line = /\(line (\d+)/.exec(msg)?.[1] ?? null;
      throw new ProjectError(`That is not valid JSON${line ? ` (line ${line})` : ""}: ${msg.replace(/ in JSON at position \d+ \(line \d+ column \d+\)/, "")}`);
    }
  }
  const now = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (hashOf(now) !== o.hash) throw new ProjectError("The file changed since you opened it; open it again to see the change, then edit");
  let backup: string | null = null;
  if (existsSync(path)) {
    mkdirSync(o.backups, { recursive: true });
    backup = join(o.backups, `${o.kind}-${basename(o.root ?? "you")}-${new Date().toISOString().replace(/[:.]/g, "-")}${json ? ".json" : ".md"}`);
    copyFileSync(path, backup);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.annex-${process.pid}.tmp`;
  writeFileSync(tmp, o.text, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o644 });
  renameSync(tmp, path);
  return { path, hash: hashOf(o.text), backup };
}

// ---------- MCP servers, through Claude Code's own CLI ----------

export const MCP_NAME = /^[\w.-]{1,64}$/;

export async function mcpList(claude: string, root: string): Promise<string> {
  try {
    const { stdout } = await run(claude, ["mcp", "list"], { cwd: root, timeout: 60_000 });
    return stdout.trim();
  } catch (err) {
    throw new ProjectError(`claude mcp list failed: ${gitError(err)}`);
  }
}

export async function mcpAdd(claude: string, root: string, o: { name: string; scope: string; command: string; args: string[] }): Promise<string> {
  if (!MCP_NAME.test(o.name)) throw new ProjectError("A server name may use letters, digits, dots, dashes and underscores");
  if (!["user", "project", "local"].includes(o.scope)) throw new ProjectError("Scope is user, project or local");
  if (!o.command.trim()) throw new ProjectError("Give the command that starts the server");
  try {
    const { stdout } = await run(claude, ["mcp", "add", "--scope", o.scope, o.name, "--", o.command.trim(), ...o.args], { cwd: root, timeout: 60_000 });
    return stdout.trim();
  } catch (err) {
    throw new ProjectError(`claude mcp add failed: ${gitError(err)}`);
  }
}

export async function mcpRemove(claude: string, root: string, name: string, scope: string): Promise<string> {
  if (!MCP_NAME.test(name)) throw new ProjectError("That is not a server name");
  if (!["user", "project", "local"].includes(scope)) throw new ProjectError("Scope is user, project or local");
  try {
    const { stdout } = await run(claude, ["mcp", "remove", "--scope", scope, name], { cwd: root, timeout: 60_000 });
    return stdout.trim();
  } catch (err) {
    throw new ProjectError(`claude mcp remove failed: ${gitError(err)}`);
  }
}

// ---------- plugins ----------

export interface PluginRow {
  id: string;
  version: string | null;
  enabledForYou: boolean;
}

export function pluginRows(home = homedir()): PluginRow[] {
  let installed: Record<string, { version?: string }[]> = {};
  try {
    installed = (JSON.parse(readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8")) as { plugins?: typeof installed }).plugins ?? {};
  } catch {
    // none installed
  }
  let enabled: Record<string, boolean> = {};
  try {
    enabled = (JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { enabledPlugins?: Record<string, boolean> }).enabledPlugins ?? {};
  } catch {
    // no settings yet
  }
  return Object.entries(installed)
    .map(([id, v]) => ({ id, version: v[0]?.version ?? null, enabledForYou: enabled[id] === true }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Turning a plugin on or off for you is a change to your settings.json, made like any other
// config save: read, change one key, back up, write atomically.
export function setPluginForYou(id: string, on: boolean, backups: string, home = homedir()): void {
  if (!pluginRows(home).some((p) => p.id === id)) throw new ProjectError("That plugin is not installed");
  const cur = readConfig("user-settings", null, [], home);
  let data: Record<string, unknown> = {};
  try {
    data = cur.text.trim() ? JSON.parse(cur.text) : {};
  } catch {
    throw new ProjectError("Your settings.json is not valid JSON; fix it in Settings first");
  }
  const ep = (data.enabledPlugins ?? {}) as Record<string, boolean>;
  ep[id] = on;
  data.enabledPlugins = ep;
  writeConfig({ kind: "user-settings", root: null, text: JSON.stringify(data, null, 2) + "\n", hash: cur.hash, known: [], backups, home });
}
