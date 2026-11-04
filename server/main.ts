// Starts Annex: reads the wing files, connects each wing to Paperclip, and serves the office.
//
//   ANNEX_PORT     where the office is served (default 4300)
//   PAPERCLIP_URL   the engine (default http://127.0.0.1:3100)
//   CLAUDE_COMMAND  the claude binary agents run (default: the first real one found; see setup.ts)

import { join } from "node:path";
import { existsSync, watch, readFileSync } from "node:fs";
import { Store } from "./db.ts";
import { loadWings, WingFileError } from "./wing.ts";
import { Paperclip } from "./engine/paperclip.ts";
import { writeAgentSettings } from "./provision.ts";
import { Bureau } from "./bureau.ts";
import { startHttp } from "./http.ts";
import { Logger } from "./logger.ts";
import { Director } from "./director.ts";
import { backupIfDue } from "./upkeep.ts";
import { LiveSessions } from "./live.ts";
import { Runner } from "./runner.ts";
import { Terminals } from "./terminals.ts";
import { sessionTranscript } from "./sessions.ts";
import { recordUsage } from "./usage.ts";
import { loadOrCreateKey } from "./key.ts";
import { moveFromOldName } from "./rename.ts";
import { CODE_ROOT, HOME, WINGS_DIR, ensureHome } from "./paths.ts";
import { findClaude } from "./setup.ts";

for (const step of moveFromOldName(HOME)) console.log(`[annex] ${step}`);
ensureHome();
const stateDir = join(HOME, ".annex");
const port = Number(process.env.ANNEX_PORT ?? 4300);

let wings;
try {
  wings = loadWings(WINGS_DIR);
} catch (err) {
  if (err instanceof WingFileError) {
    console.error(`[annex] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const store = new Store(join(stateDir, "annex.db"));
const logger = new Logger(join(stateDir, "logs"));
const pc = new Paperclip(process.env.PAPERCLIP_URL);
// Annex starts without Claude Code, so the page can offer to install it; until then "claude" is
// looked up on the PATH when something runs it (the login service's PATH has ~/.local/bin)
const foundClaude = findClaude();
const claudeCommand = foundClaude ?? "claude";
if (!foundClaude) logger.warn(null, "Claude Code is not installed yet; the page's setup screen installs it");
const settingsFile = writeAgentSettings(stateDir, [], { enabled: true, stateDir });
const bureau = new Bureau({
  store,
  pc,
  wings,
  stateDir,
  wingsDir: WINGS_DIR,
  logger,
  claudeCommand,
  settingsFile,
});
bureau.attachDirector(new Director({ store, pc, logger, offices: bureau, claudeCommand, settingsFile }));

const startedAt = new Date();
const live = new LiveSessions({ claude: claudeCommand, annexUrl: `http://127.0.0.1:${port}`, dir: join(stateDir, "live"), onUsage: recordUsage });
const key = loadOrCreateKey();
const runner = new Runner(stateDir);
const terminals = new Terminals({ claude: claudeCommand });
await startHttp({ terminals, backupsDir: join(stateDir, "backups", "config"), runner, key, live, bureau, store, logger, port, webDir: join(CODE_ROOT, "web", "dist"), claudeCommand, engineUrl: process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3100", startedAt });

// a copy of the database a day, seven kept
const backup = () => {
  try {
    const made = backupIfDue(store, join(stateDir, "backups"));
    if (made) logger.info(null, `backed up the database to ${made}`);
  } catch (err) {
    logger.warn(null, `could not back up the database: ${(err as Error).message}`);
  }
};
backup();
setInterval(backup, 3600_000).unref();
// sessions that were open when Annex last stopped carry on where they were
const reopened = live.restore((id) => sessionTranscript(id)?.entries ?? null);
if (reopened) logger.info(null, `reopened ${reopened} live session${reopened === 1 ? "" : "s"} from before the restart`);
logger.info(null, `the office is at http://127.0.0.1:${port} (first time in a browser: npm run open, or pair it from one that has Annex open); this log is ${logger.file}`);
await bureau.start();

// A wing file edited by hand is applied without a restart; editors save in bursts, so wait for
// the file to settle first.
const pending = new Map<string, ReturnType<typeof setTimeout>>();
watch(WINGS_DIR, { recursive: true }, (_e, file) => {
  if (!file?.endsWith("wing.toml")) return;
  const id = file.split(/[\\/]/)[0]!;
  clearTimeout(pending.get(id));
  pending.set(id, setTimeout(() => {
    const path = join(WINGS_DIR, id, "wing.toml");
    if (existsSync(path)) void bureau.reloadFile(id, readFileSync(path, "utf8"));
  }, 400));
});

const shutdown = () => {
  runner.stopAll();
  terminals.closeAll();
  live.closeAll();
  bureau.stopAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
