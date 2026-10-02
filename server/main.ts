// Starts Annex: reads the wing files, connects each wing to Paperclip, and serves the office.
//
//   BOURNE_PORT     where the office is served (default 4300)
//   PAPERCLIP_URL   the engine (default http://127.0.0.1:3100)
//   CLAUDE_COMMAND  the claude binary agents run (default: the first real one on PATH)

import { join } from "node:path";
import { existsSync, watch } from "node:fs";
import { execFileSync } from "node:child_process";
import { Store } from "./db.ts";
import { loadWings, WingFileError } from "./wing.ts";
import { Paperclip } from "./engine/paperclip.ts";
import { writeAgentSettings } from "./provision.ts";
import { Bureau } from "./bureau.ts";
import { startHttp } from "./http.ts";

const root = join(import.meta.dirname, "..");
const stateDir = join(root, ".annex");
const port = Number(process.env.BOURNE_PORT ?? 4300);

// Prefer a real install over wrapper shims some terminals put first on PATH.
function findClaude(): string {
  if (process.env.CLAUDE_COMMAND) return process.env.CLAUDE_COMMAND;
  for (const c of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(process.env.HOME ?? "", ".local/bin/claude")]) {
    if (existsSync(c)) return c;
  }
  return execFileSync("/bin/sh", ["-c", "command -v claude"]).toString().trim();
}

let wings;
try {
  wings = loadWings(join(root, "wings"));
} catch (err) {
  if (err instanceof WingFileError) {
    console.error(`[annex] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const store = new Store(join(stateDir, "annex.db"));
const bureau = new Bureau({
  store,
  pc: new Paperclip(process.env.PAPERCLIP_URL),
  wings,
  stateDir,
  claudeCommand: findClaude(),
  settingsFile: writeAgentSettings(stateDir),
});

await startHttp({ bureau, store, port, webDir: join(root, "web", "dist") });
console.log(`[annex] the office is at http://127.0.0.1:${port}`);
await bureau.start();

// Wing files are read once at start. Say so when one changes, rather than half-applying it.
watch(join(root, "wings"), { recursive: true }, (_e, file) => {
  if (file?.endsWith("wing.toml")) console.log(`[annex] ${file} changed. Restart Annex to apply it.`);
});

const shutdown = () => {
  bureau.stopAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
