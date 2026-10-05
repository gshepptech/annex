// Runs Annex as a login service on macOS, so it is up after a reboot and comes back if it exits.
//
//   npm run service:install    write the LaunchAgent and start it now
//   npm run service:remove     stop it and take it out
//   npm run service:status     say whether it is loaded
//
// The service runs `scripts/up.ts`, the same thing `npm run up` does; its output goes to
// .annex/logs/service.log.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const LABEL = "dev.annex.office";
const root = join(import.meta.dirname, "..");
const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = `gui/${userInfo().uid}`;
const log = join(root, ".annex", "logs", "service.log");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function launchctl(...args: string[]): string {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

const cmd = process.argv[2];
if (cmd === "install") {
  mkdirSync(join(root, ".annex", "logs"), { recursive: true });
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  // launchd starts with a bare PATH. Keep the PATH of the shell installing the service (where
  // claude, npx, gh, git credential helpers and plugins' MCP servers are found), plus the usual
  // places in case it was thin.
  const usual = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const path = [...new Set([...(process.env.PATH ?? "").split(":").filter(Boolean), ...usual])].join(":");
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(join(root, "scripts", "up.ts"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(path)}</string>
    <key>HOME</key><string>${esc(homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`);
  launchctl("bootout", `${domain}/${LABEL}`);
  const out = launchctl("bootstrap", domain, plist);
  console.log(out.trim() || `Installed ${plist}. Annex starts at login and restarts if it exits; its log is ${log}.`);
} else if (cmd === "remove") {
  launchctl("bootout", `${domain}/${LABEL}`);
  if (existsSync(plist)) rmSync(plist);
  console.log("Removed the login service. Annex stops now and will not start at login.");
} else if (cmd === "status") {
  const out = launchctl("print", `${domain}/${LABEL}`);
  console.log(out.includes("state =") ? out.split("\n").filter((l) => /state =|pid =|last exit/.test(l)).join("\n") : "Not installed.");
} else {
  console.log("usage: node scripts/service.ts install | remove | status");
  process.exit(1);
}
