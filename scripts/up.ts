// One command for everything: starts the pinned Paperclip engine if it is not already up, waits
// for it to be healthy, builds the office page if it has not been built, then runs Annex.
// Ctrl-C stops what this started.
//
//   npm run up

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const engine = process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3100";
const children: ChildProcess[] = [];

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${engine}/api/health`)).ok;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], cwd: string, logTo?: string): ChildProcess {
  const out = logTo ? openSync(logTo, "a") : "inherit";
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", out, out] });
  children.push(child);
  return child;
}

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

mkdirSync(join(root, ".annex", "logs"), { recursive: true });

if (await healthy()) {
  console.log(`[up] Paperclip is already running at ${engine}`);
} else {
  if (!existsSync(join(root, "runtime", "node_modules", ".bin", "paperclipai"))) {
    console.log("[up] installing the pinned Paperclip engine (first run only)...");
    await new Promise((resolve, reject) => run("npm", ["install", "--no-fund", "--no-audit"], join(root, "runtime")).on("exit", (code) => (code === 0 ? resolve(null) : reject(new Error(`npm install exited ${code}`)))));
  }
  const log = join(root, ".annex", "logs", "paperclip.log");
  console.log(`[up] starting Paperclip; its log is ${log}`);
  run("npx", ["paperclipai", "run", "--data-dir", join(root, ".paperclip")], join(root, "runtime"), log);
  const deadline = Date.now() + 180_000;
  while (!(await healthy())) {
    if (Date.now() > deadline) {
      console.error(`[up] Paperclip did not come up in 3 minutes; see ${log}`);
      stop();
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log("[up] Paperclip is up");
}

// build the page when it is missing or older than its source, so an always-on service never
// serves a stale page after an update
const built = join(root, "web", "dist", "index.html");
const newestSource = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((t, e) => Math.max(t, e.isDirectory() ? newestSource(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0);
if (!existsSync(built) || statSync(built).mtimeMs < Math.max(newestSource(join(root, "web", "src")), statSync(join(root, "web", "index.html")).mtimeMs)) {
  console.log("[up] building the office page...");
  await new Promise((resolve) => run("npx", ["vite", "build", "web"], root).on("exit", resolve));
}

run(process.execPath, [join(root, "server", "main.ts")], root).on("exit", (code) => {
  console.log(`[up] Annex exited (${code})`);
  stop();
});
