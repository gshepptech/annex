// The app was called Annex before it was Annex. This moves what the old name left on disk, once,
// before anything opens it: the data folder and the key folder. Each step is skipped when the new
// place already exists, so running it again does nothing.
//
// The data folder keeps a `.annex` symlink to `.annex`: git worktrees of the offices and Paperclip's
// saved workspaces hold absolute paths through `.annex`, and the link keeps every one of them valid.

import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KEY_DIR } from "./key.ts";

export const OLD_KEY_DIR = join(homedir(), ".config", "annex");

function isRealDir(path: string): boolean {
  try {
    const s = lstatSync(path);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
}

export function moveFromOldName(root: string, keyDir = KEY_DIR, oldKeyDir = OLD_KEY_DIR): string[] {
  const done: string[] = [];
  const oldState = join(root, ".annex");
  const state = join(root, ".annex");
  if (isRealDir(oldState) && !existsSync(state)) {
    renameSync(oldState, state);
    symlinkSync(".annex", oldState);
    done.push(`moved ${oldState} to ${state}`);
  }
  if (existsSync(join(state, "annex.db")) && !existsSync(join(state, "annex.db"))) {
    // the write-ahead files go with the database, or its last writes are lost
    for (const suffix of ["", "-shm", "-wal"]) {
      if (existsSync(join(state, `annex.db${suffix}`))) renameSync(join(state, `annex.db${suffix}`), join(state, `annex.db${suffix}`));
    }
    done.push("renamed annex.db to annex.db");
  }
  if (isRealDir(oldKeyDir) && !existsSync(keyDir)) {
    mkdirSync(join(keyDir, ".."), { recursive: true });
    renameSync(oldKeyDir, keyDir);
    done.push(`moved the key folder to ${keyDir}`);
  }
  return done;
}
