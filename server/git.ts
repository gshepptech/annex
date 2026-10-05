// Every task gets its own branch and worktree, cut from the wing's integration branch (design D7).
// Annex never checks out anything in the person's own working copy, never pushes, and never
// touches the base branch. Verified work is merged into the integration branch inside Annex's own
// worktree for it, and the person merges that branch when they choose to.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

// A brand-new project: an empty folder made into a git repo with one commit, so an office can
// branch from it. Refuses a folder that already has anything in it.
export async function initRepo(dir: string, name: string, about: string): Promise<void> {
  const { existsSync, mkdirSync, readdirSync, writeFileSync } = await import("node:fs");
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} already exists and is not empty`);
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(`${dir}/README.md`, `# ${name}\n${about ? `\n${about.trim()}\n` : ""}`);
  await git(dir, "add", "README.md");
  try {
    await git(dir, "commit", "-q", "-m", "Start the project");
  } catch {
    // no git identity set up on this machine: sign the first commit as Annex
    await git(dir, "-c", "user.name=Annex", "-c", "user.email=annex@localhost", "commit", "-q", "-m", "Start the project");
  }
}

export interface WingWorkspace {
  repo: string;
  baseBranch: string;
  integrationBranch: string;
  // Annex's own checkout of the integration branch; merges happen here.
  integrationDir: string;
  // Parent directory for per-task worktrees.
  tasksDir: string;
}

export async function prepareWing(
  repo: string,
  baseBranch: string,
  integrationBranch: string,
  root: string,
): Promise<WingWorkspace> {
  if (!existsSync(join(repo, ".git"))) throw new Error(`${repo} is not a git repository`);
  if (!(await branchExists(repo, baseBranch))) throw new Error(`${repo} has no branch "${baseBranch}"`);
  if (!(await branchExists(repo, integrationBranch))) {
    // `git branch` creates the ref without touching whatever the person has checked out.
    await git(repo, "branch", integrationBranch, baseBranch);
  }
  const integrationDir = join(root, "integration");
  if (!existsSync(integrationDir)) {
    mkdirSync(dirname(integrationDir), { recursive: true });
    await git(repo, "worktree", "add", integrationDir, integrationBranch);
  }
  const tasksDir = join(root, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  return { repo, baseBranch, integrationBranch, integrationDir, tasksDir };
}

// Not `${integration}/${key}`: git cannot have a branch "annex/w/t1" while "annex/w" exists,
// because one ref would have to be both a file and a directory.
export function taskBranch(ws: WingWorkspace, taskKey: string): string {
  return `${ws.integrationBranch}--${taskKey}`;
}

export async function taskWorktree(ws: WingWorkspace, taskKey: string): Promise<string> {
  const dir = join(ws.tasksDir, taskKey);
  if (existsSync(dir)) return dir;
  const branch = taskBranch(ws, taskKey);
  if (await branchExists(ws.repo, branch)) {
    await git(ws.repo, "worktree", "add", dir, branch);
  } else {
    await git(ws.repo, "worktree", "add", "-b", branch, dir, ws.integrationBranch);
  }
  return dir;
}

export async function hasCommitsBeyond(dir: string, base: string): Promise<boolean> {
  return (await git(dir, "rev-list", "--count", `${base}..HEAD`)) !== "0";
}

// Tracked files only: untracked scratch files (agents' API payloads, logs) are never merged, so
// they do not make a worktree dirty for Annex's purposes.
export async function isClean(dir: string): Promise<boolean> {
  return (await git(dir, "status", "--porcelain", "--untracked-files=no")) === "";
}

export type MergeResult = { ok: true; commit: string } | { ok: false; reason: string };

// Merges a verified task branch into the integration branch. Fast-forward when the integration
// branch has not moved, a merge commit otherwise; a conflict is aborted and reported, never left
// half-merged.
export async function mergeTask(ws: WingWorkspace, taskKey: string, message: string): Promise<MergeResult> {
  const branch = taskBranch(ws, taskKey);
  try {
    await git(ws.integrationDir, "merge", "--no-edit", "-m", message, branch);
    return { ok: true, commit: await git(ws.integrationDir, "rev-parse", "HEAD") };
  } catch (err) {
    try {
      await git(ws.integrationDir, "merge", "--abort");
    } catch {
      // nothing to abort: the merge failed before it started
    }
    return { ok: false, reason: (err as { stderr?: string }).stderr?.trim() || (err as Error).message };
  }
}

export async function head(dir: string): Promise<string> {
  return git(dir, "rev-parse", "HEAD");
}

// Merge any branch (Paperclip names task branches) into the integration branch.
export async function mergeBranch(ws: WingWorkspace, branch: string, message: string): Promise<MergeResult> {
  try {
    await git(ws.integrationDir, "merge", "--no-ff", "--no-edit", "-m", message, branch);
    return { ok: true, commit: await head(ws.integrationDir) };
  } catch (err) {
    try {
      await git(ws.integrationDir, "merge", "--abort");
    } catch {
      // nothing to abort: the merge failed before it started
    }
    return { ok: false, reason: (err as { stderr?: string }).stderr?.trim() || (err as Error).message };
  }
}

// Only ever used on Annex's own integration worktree, to undo a merge that broke the checks.
export async function resetIntegration(ws: WingWorkspace, commit: string) {
  await git(ws.integrationDir, "reset", "--hard", commit);
}

export async function removeTaskWorktree(ws: WingWorkspace, taskKey: string, deleteBranch: boolean) {
  const dir = join(ws.tasksDir, taskKey);
  if (existsSync(dir)) await git(ws.repo, "worktree", "remove", "--force", dir);
  if (deleteBranch && (await branchExists(ws.repo, taskBranch(ws, taskKey)))) {
    await git(ws.repo, "branch", "-D", taskBranch(ws, taskKey));
  }
}

// Commits on the integration branch that the base branch does not have yet: what is waiting for
// the person to merge. Merge commits are Annex's, so their subjects name each verified task.
export async function waiting(repo: string, base: string, integration: string): Promise<{ sha: string; date: string; subject: string }[]> {
  try {
    const out = await git(repo, "log", "--first-parent", "--format=%h%x09%cs%x09%s", `${base}..${integration}`);
    return out ? out.split("\n").map((l) => { const [sha, date, ...rest] = l.split("\t"); return { sha: sha!, date: date!, subject: rest.join("\t") }; }) : [];
  } catch {
    return [];
  }
}

export interface ChangedFile {
  path: string;
  // A added, M modified, D deleted (a rename shows as a delete and an add)
  status: string;
  added: number;
  removed: number;
}

// What `to` changes compared with where it left `from` (the three-dot form), file by file.
// Read only: nothing here touches a working tree.
export async function changedFiles(repo: string, from: string, to: string): Promise<ChangedFile[]> {
  const range = `${from}...${to}`;
  const [names, nums] = await Promise.all([git(repo, "-c", "core.quotePath=false", "diff", "--no-renames", "--name-status", range, "--"), git(repo, "-c", "core.quotePath=false", "diff", "--no-renames", "--numstat", range, "--")]);
  const counts = new Map<string, { added: number; removed: number }>();
  for (const l of nums.split("\n").filter(Boolean)) {
    const [a, r, ...rest] = l.split("\t");
    counts.set(rest.join("\t"), { added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r) });
  }
  return names.split("\n").filter(Boolean).map((l) => {
    const [status, ...rest] = l.split("\t");
    const path = rest.join("\t");
    return { path, status: status!.charAt(0), ...(counts.get(path) ?? { added: 0, removed: 0 }) };
  });
}

// One file's patch. The caller passes a path it got from changedFiles, never one from a person.
export async function filePatch(repo: string, from: string, to: string, path: string): Promise<string> {
  const out = await git(repo, "-c", "core.quotePath=false", "diff", "--no-renames", `${from}...${to}`, "--", path);
  return out.length > 400_000 ? out.slice(0, 400_000) + "\n… (cut: the rest of this diff is very long)" : out;
}

export async function revParse(repo: string, ref: string): Promise<string | null> {
  try {
    return (await git(repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).trim() || null;
  } catch {
    return null;
  }
}

// A throwaway checkout of the integration branch's latest commit, for running the app: never the
// integration worktree itself, where Annex merges, checks and resets. Detached, so it holds no
// branch; refreshed to the newest verified work each time. Untracked build output stays.
export async function previewWorktree(ws: WingWorkspace): Promise<string> {
  const dir = join(dirname(ws.integrationDir), "preview");
  const sha = await git(ws.repo, "rev-parse", ws.integrationBranch);
  if (!existsSync(dir)) {
    await git(ws.repo, "worktree", "add", "--detach", dir, sha);
  } else {
    await git(dir, "checkout", "--detach", "--force", sha);
  }
  return dir;
}

