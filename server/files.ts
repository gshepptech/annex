// A project's files, for the editor: listed, read and saved. Every path is relative to a project
// Annex knows, checked here, and never leaves it.
//
// The browser names a project (one of the known folders, matched exactly) and a path inside it.
// The path is checked as typed (no "..", no absolute path, no ".git" in any case), then resolved
// with symlinks followed and checked again, so a link cannot lead out of the project, into its
// .git folder, or into Annex's own key folder. Only regular files are opened: a FIFO would hang
// the server on read.

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { KEY_DIR } from "./key.ts";
import { ProjectError, hashOf, mustKnow, saveChecked } from "./projects.ts";

const run = promisify(execFile);

export const MAX_FILE_BYTES = 1_048_576; // 1 MiB, read and save
export const MAX_LIST = 20_000;

const isGit = (segment: string) => segment.toLowerCase() === ".git";

function realOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function under(p: string, dir: string): boolean {
  return p === dir || p.startsWith(`${dir}/`);
}

// rel -> the real path of an existing regular file inside root; throws ProjectError otherwise
export function insideProject(root: string, rel: string, known: string[], deny: string[] = [KEY_DIR]): { real: string; rel: string } {
  mustKnow(root, known);
  if (!rel || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) throw new ProjectError("Name a file by its path inside the project");
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new ProjectError("Name a file by its path inside the project");
  // APFS ignores case, so .GIT/HEAD is the git folder too
  if (parts.some(isGit)) throw new ProjectError("Annex does not open files inside .git");
  // .native: the case as stored on disk (APFS takes .CONFIG/ANNEX for .config/annex), so the
  // checks below compare real names, not what was typed
  const rootReal = realpathSync.native(root);
  let real: string;
  try {
    real = realpathSync.native(join(rootReal, rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ProjectError("That file does not exist (it may have been moved or deleted)");
    throw new ProjectError(`Could not open that file: ${(err as Error).message}`);
  }
  if (real !== rootReal && !real.startsWith(`${rootReal}/`)) throw new ProjectError("That path leads outside the project");
  // a symlink into .git
  if (relative(rootReal, real).split("/").some(isGit)) throw new ProjectError("Annex does not open files inside .git");
  if (deny.some((d) => under(real, realOr(d)))) throw new ProjectError("Annex does not open its own key folder");
  // before anything opens it: a FIFO or a device would block or never end
  if (!statSync(real).isFile()) throw new ProjectError("That is not a file");
  return { real, rel };
}

export async function listProjectFiles(root: string, known: string[], limit = MAX_LIST): Promise<{ root: string; git: boolean; files: string[]; truncated: boolean }> {
  mustKnow(root, known);
  const opts = { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 };
  let all: string[];
  let git = true;
  try {
    // -z: names exactly as they are, never quoted; run from a subfolder, git lists only that folder
    const listed = (await run("git", ["-c", "core.quotePath=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], opts)).stdout.split("\0");
    // --cached still lists a tracked file deleted from the checkout
    const gone = new Set((await run("git", ["ls-files", "--deleted", "-z"], opts)).stdout.split("\0"));
    all = listed.filter((f) => f && !gone.has(f) && !f.split("/").some(isGit));
  } catch {
    git = false;
    all = walk(realpathSync.native(root), "", 8, limit + 1);
  }
  all = [...new Set(all)].sort();
  return { root, git, files: all.slice(0, limit), truncated: all.length > limit };
}

export function readProjectFile(root: string, rel: string, known: string[], deny?: string[]): { path: string; text: string; hash: string; size: number } {
  const { real } = insideProject(root, rel, known, deny);
  const size = statSync(real).size;
  if (size > MAX_FILE_BYTES) throw new ProjectError(`That file is too large to edit here (${(size / 1_048_576).toFixed(1)} MB; the limit is 1 MB)`);
  const buf = readFileSync(real);
  // git's rule for binary: a NUL in the first 8000 bytes
  if (buf.subarray(0, 8000).includes(0)) throw new ProjectError("That file is binary; Annex edits text only");
  let text: string;
  try {
    // fatal: bad bytes would become U+FFFD and saving would damage the file; ignoreBOM keeps a BOM
    // in the text, so saving writes the same bytes back
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new ProjectError("That file is not UTF-8 text; Annex edits UTF-8 only");
  }
  return { path: rel, text, hash: hashOf(buf), size };
}

// Saves over an existing file only if it is still what was opened. A symlinked file is written at
// its target (checked to be inside the project), so the link stays a link.
//
// Known gap: between the checks here and the write, a process on this machine could swap a folder
// on the path for a symlink. That needs something local racing your own save, and agents cannot
// call this without the key; accepted.
export function writeProjectFile(o: { root: string; path: string; text: string; hash: string; known: string[]; backups: string; deny?: string[] }): { path: string; hash: string; backup: string | null } {
  if (Buffer.byteLength(o.text) > MAX_FILE_BYTES) throw new ProjectError("That is too large to save here (the limit is 1 MB)");
  const { real, rel } = insideProject(o.root, o.path, o.known, o.deny);
  const rootReal = realpathSync.native(o.root);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    const saved = saveChecked({
      path: real,
      text: o.text,
      hash: o.hash,
      backups: join(o.backups, "files"),
      backupName: `${basename(rootReal)}-${hashOf(rootReal).slice(0, 8)}--${rel.replaceAll("/", "__")}--${ts}${extname(rel)}`,
      keep: 20,
    });
    return { path: rel, ...saved };
  } catch (err) {
    if (err instanceof ProjectError) throw err;
    throw new ProjectError(`Could not save: ${(err as Error).message}`);
  }
}

// An absolute path (from a session or a diff) -> the deepest known project holding it, and the
// path inside it.
export function locateFile(abs: string, known: string[]): { root: string; path: string } {
  if (!abs.startsWith("/")) throw new ProjectError("That is not a full path");
  let real: string;
  try {
    real = realpathSync.native(abs);
  } catch {
    // deleted since: its folder still places it
    real = join(realOr(dirname(abs)), basename(abs));
  }
  const roots = known.map((k) => ({ k, r: realOr(k) })).sort((a, b) => b.r.length - a.r.length);
  for (const { k, r } of roots) {
    if (real.startsWith(`${r}/`)) return { root: k, path: relative(r, real) };
  }
  throw new ProjectError("That file is not in one of your projects");
}

// A folder outside git: dot-files and node_modules skipped, symlinked folders not followed
// (a Dirent for a link is not a directory).
export function walk(root: string, rel: string, depth: number, limit: number, out: string[] = []): string[] {
  if (depth < 0 || out.length >= limit) return out;
  let names: Dirent[] = [];
  try {
    names = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    if (d.name.startsWith(".") || d.name === "node_modules") continue;
    const p = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) walk(root, p, depth - 1, limit, out);
    else out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
