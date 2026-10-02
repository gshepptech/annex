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

export async function isClean(dir: string): Promise<boolean> {
  return (await git(dir, "status", "--porcelain")) === "";
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
