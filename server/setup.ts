// First-run setup: what a new Mac needs before Annex can do anything, checked from here, so
// someone handed Annex.dmg never opens Terminal.app. Each check that fails names a fix; a fix runs
// in Annex's own terminal pane, and the commands come only from the map below, never from the page.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupCheck, SetupFixId as FixId } from "./api-types.ts";
export type { SetupCheck, FixId };

// What a check runs, with stdout and stderr together; never throws.
export type CheckRun = (file: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

export const runCheck: CheckRun = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // a program that never started printed nothing; say why instead
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() || (err?.message ?? "") });
    });
  });

// Where things are looked for, besides the PATH: Homebrew on either chip, and where Claude Code's
// own installer puts it.
export interface Where {
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (p: string) => boolean;
}
const here = (): Where => ({ env: process.env, home: homedir(), exists: existsSync });

// The claude agents and sessions run. A real install is preferred over wrapper shims some
// terminals put first on PATH; null when there is none (Annex still starts, and setup says so).
export function findClaude(w: Where = here()): string | null {
  if (w.env.CLAUDE_COMMAND) return w.env.CLAUDE_COMMAND;
  for (const c of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(w.home, ".local/bin/claude")]) {
    if (w.exists(c)) return c;
  }
  return onPath("claude", w);
}

// A program on the PATH or in Homebrew's folders, found without running anything.
export function onPath(name: string, w: Where = here()): string | null {
  const dirs = [...(w.env.PATH ?? "").split(":").filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) if (w.exists(join(d, name))) return join(d, name);
  return null;
}

const PLANS: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" };

export async function setupStatus(run: CheckRun = runCheck, w: Where = here()): Promise<SetupCheck[]> {
  const claude = findClaude(w);
  const claudeChecks = async (): Promise<SetupCheck[]> => {
    if (!claude) {
      return [
        { id: "claude", label: "Claude Code installed", ok: false, detail: "Not installed", required: true, fix: { id: "claude-install", label: "Install" } },
        { id: "login", label: "Signed in to Claude", ok: false, detail: "Install Claude Code first", required: true },
      ];
    }
    const version = await run(claude, ["--version"]);
    const installed: SetupCheck = version.ok
      ? { id: "claude", label: "Claude Code installed", ok: true, detail: version.out.split("\n")[0] ?? "", required: true }
      : { id: "claude", label: "Claude Code installed", ok: false, detail: `${claude} did not run: ${version.out.split("\n").pop() ?? ""}`.trim(), required: true, fix: { id: "claude-install", label: "Reinstall" } };
    if (!installed.ok) return [installed, { id: "login", label: "Signed in to Claude", ok: false, detail: "Install Claude Code first", required: true }];
    // `auth status` prints JSON either way and exits 1 when signed out
    const status = await run(claude, ["auth", "status"]);
    let s: { loggedIn?: unknown; subscriptionType?: unknown } | null = null;
    try {
      s = JSON.parse(status.out.slice(status.out.indexOf("{")));
    } catch {
      s = null;
    }
    const plan = typeof s?.subscriptionType === "string" ? PLANS[s.subscriptionType] ?? s.subscriptionType : null;
    const login: SetupCheck = !s
      ? { id: "login", label: "Signed in to Claude", ok: false, detail: `Could not read claude auth status: ${status.out.split("\n").pop() ?? ""}`.trim(), required: true, fix: { id: "claude-login", label: "Log in" } }
      : s.loggedIn === true
        ? { id: "login", label: "Signed in to Claude", ok: true, detail: plan ? `Signed in (${plan} plan)` : "Signed in", required: true }
        : { id: "login", label: "Signed in to Claude", ok: false, detail: "Not signed in", required: true, fix: { id: "claude-login", label: "Log in" } };
    return [installed, login];
  };
  // macOS's /usr/bin/git is a stub that pops an installer while the Command Line Tools are
  // missing; git is run only once xcode-select says they are there
  const gitCheck = async (): Promise<SetupCheck> => {
    const fix = { id: "git-install" as const, label: "Install" };
    if (!(await run("/usr/bin/xcode-select", ["-p"])).ok) return { id: "git", label: "Git (Command Line Tools)", ok: false, detail: "The Command Line Tools are not installed", required: true, fix };
    const v = await run("git", ["--version"]);
    return v.ok ? { id: "git", label: "Git (Command Line Tools)", ok: true, detail: v.out, required: true } : { id: "git", label: "Git (Command Line Tools)", ok: false, detail: v.out || "git did not run", required: true, fix };
  };
  const githubCheck = async (): Promise<SetupCheck> => {
    const label = "GitHub CLI signed in";
    const gh = onPath("gh", w);
    if (!gh) {
      const fix = onPath("brew", w) ? { id: "gh-login" as const, label: "Install and sign in" } : undefined;
      return { id: "github", label, ok: false, detail: "Needed only for private repositories", required: false, ...(fix ? { fix } : {}) };
    }
    const s = await run(gh, ["auth", "status"]);
    if (s.ok) {
      const account = /account (\S+)/.exec(s.out)?.[1];
      return { id: "github", label, ok: true, detail: account ? `Signed in as ${account}` : "Signed in", required: false };
    }
    return { id: "github", label, ok: false, detail: "Not signed in to GitHub (needed only for private repositories)", required: false, fix: { id: "gh-login", label: "Sign in" } };
  };
  const [cl, git, gh] = await Promise.all([claudeChecks(), gitCheck(), githubCheck()]);
  return [...cl, git, gh];
}

// The checks, kept a few seconds so a page polling them does not run claude each time.
export function setupChecker(run: CheckRun = runCheck, w?: Where, ttlMs = 5000) {
  let last: { at: number; checks: Promise<SetupCheck[]> } | null = null;
  return (fresh = false): Promise<SetupCheck[]> => {
    if (fresh || !last || Date.now() - last.at > ttlMs) last = { at: Date.now(), checks: setupStatus(run, w) };
    return last.checks;
  };
}

// ---------- fixes ----------

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Every command a setup terminal can run. The official native installer puts claude in
// ~/.local/bin, which a login shell may not have on PATH yet, so logging in uses it there first.
const FIXES: Record<FixId, { label: string; command: (w: Where) => string | null }> = {
  "claude-install": { label: "Install Claude Code", command: () => "curl -fsSL https://claude.ai/install.sh | bash" },
  "claude-login": {
    label: "Log in to Claude",
    command: (w) => {
      const local = join(w.home, ".local/bin/claude");
      return `${quote(w.exists(local) ? local : findClaude(w) ?? "claude")} auth login`;
    },
  },
  "git-install": { label: "Install the Command Line Tools", command: () => "xcode-select --install" },
  "gh-login": {
    label: "Sign in to GitHub",
    command: (w) => (onPath("gh", w) ? "gh auth login" : onPath("brew", w) ? "brew install gh && gh auth login" : null),
  },
};

export class UnknownFix extends Error {}

// The command for a fix id, or an error for an id that is not in the map or cannot run here.
export function fixCommand(id: string, w: Where = here()): { label: string; command: string } {
  const f = Object.hasOwn(FIXES, id) ? FIXES[id as FixId] : undefined;
  if (!f) throw new UnknownFix("There is no such setup step");
  const command = f.command(w);
  if (!command) throw new UnknownFix("That cannot be done from here: install Homebrew (brew.sh) or the GitHub CLI (cli.github.com) first");
  return { label: f.label, command };
}
