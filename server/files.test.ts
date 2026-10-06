import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as F from "./files.ts";
import * as P from "./projects.ts";

const id = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
// tmpdir() is /var/… on macOS, which is really /private/var/…
const temp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function repo(): string {
  const r = temp("annex-files-");
  g(r, "init", "-q", "-b", "main");
  writeFileSync(join(r, "a.txt"), "hello\n");
  return r;
}

test("paths stay inside the project", () => {
  const r = repo();
  const deny = temp("annex-deny-");
  writeFileSync(join(deny, "key"), "secret");
  mkdirSync(join(r, "sub"));
  symlinkSync(join(r, "a.txt"), join(r, "link-in"));
  symlinkSync("/etc/hosts", join(r, "link-out"));
  symlinkSync(join(r, ".git", "config"), join(r, "gitlink"));
  symlinkSync(join(deny, "key"), join(r, "keylink"));
  execFileSync("mkfifo", [join(r, "fifo")]);
  const known = [r];
  assert.equal(F.insideProject(r, "a.txt", known, [deny]).real, join(r, "a.txt"));
  assert.equal(F.insideProject(r, "link-in", known, [deny]).real, join(r, "a.txt"));
  for (const bad of ["../x", "/etc/hosts", "a//b", "a.txt/", ".git/config", ".GIT/HEAD", "link-out", "gitlink", "sub", "fifo", "keylink", "", "a\\b", "./a.txt"]) {
    assert.throws(() => F.insideProject(r, bad, known, [deny]), P.ProjectError, bad);
  }
  assert.throws(() => F.insideProject(r, "link-out", known, [deny]), /outside the project/);
  assert.throws(() => F.insideProject(r, "keylink", known, [deny]), /outside the project|key folder/);
  assert.throws(() => F.insideProject(r, "fifo", known, [deny]), /not a file/);
  assert.throws(() => F.insideProject(r, "gone.txt", known, [deny]), /does not exist/);
  assert.throws(() => F.insideProject("/etc", "hosts", known), /not one of your projects/);
  // a project that holds the key folder still refuses it
  assert.throws(() => F.insideProject(deny, "key", [deny], [deny]), /key folder/);
  // APFS ignores case: the key folder typed in another case is still the key folder
  const home = temp("annex-home-");
  mkdirSync(join(home, "keys"));
  writeFileSync(join(home, "keys", "key"), "secret");
  assert.throws(() => F.insideProject(home, "KEYS/key", [home], [join(home, "keys")]), /key folder/);
});

test("the list is git's: tracked and untracked, not ignored, not deleted, odd names intact", async () => {
  const r = repo();
  writeFileSync(join(r, ".gitignore"), "dist\n");
  writeFileSync(join(r, "gone.txt"), "x\n");
  g(r, "add", ".");
  g(r, ...id, "commit", "-qm", "init");
  unlinkSync(join(r, "gone.txt"));
  mkdirSync(join(r, "dist"));
  writeFileSync(join(r, "dist", "b.js"), "1");
  mkdirSync(join(r, "sub"));
  writeFileSync(join(r, "sub", "new.ts"), "1");
  writeFileSync(join(r, "sp ace é.txt"), "1");
  const l = await F.listProjectFiles(r, [r]);
  assert.equal(l.git, true);
  assert.deepEqual(l.files, [".gitignore", "a.txt", "sp ace é.txt", "sub/new.ts"]);
  assert.equal(l.truncated, false);
  await assert.rejects(F.listProjectFiles("/etc", [r]), /not one of your projects/);

  const plain = temp("annex-plain-");
  for (const n of ["a", "b", "c", "d"]) writeFileSync(join(plain, n), n);
  mkdirSync(join(plain, "node_modules"));
  writeFileSync(join(plain, "node_modules", "x"), "x");
  const w = await F.listProjectFiles(plain, [plain], 3);
  assert.equal(w.git, false);
  assert.deepEqual(w.files, ["a", "b", "c"]);
  assert.equal(w.truncated, true);
  assert.deepEqual((await F.listProjectFiles(plain, [plain])).files, ["a", "b", "c", "d"], "node_modules is skipped");
});

test("reading refuses binary, non-UTF-8 and large files; BOM and CRLF come back exactly", () => {
  const r = repo();
  const known = [r];
  writeFileSync(join(r, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
  writeFileSync(join(r, "latin.txt"), Buffer.from([0xff, 0x41]));
  writeFileSync(join(r, "big.txt"), Buffer.alloc(F.MAX_FILE_BYTES + 1, 0x61));
  assert.throws(() => F.readProjectFile(r, "logo.png", known), /binary/);
  assert.throws(() => F.readProjectFile(r, "latin.txt", known), /not UTF-8/);
  assert.throws(() => F.readProjectFile(r, "big.txt", known), /too large/);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo\r\nworld\r\n")]);
  writeFileSync(join(r, "bom.txt"), bytes);
  const f = F.readProjectFile(r, "bom.txt", known);
  assert.deepEqual(Buffer.from(f.text, "utf8"), bytes);
  assert.equal(f.hash, sha(bytes));
  assert.equal(f.size, bytes.length);
  assert.equal(f.path, "bom.txt");
});

test("saving: never over someone else's change, backed up, keeps links and modes", () => {
  const r = repo();
  const known = [r];
  const backups = temp("annex-backups-");
  const first = F.readProjectFile(r, "a.txt", known);
  const saved = F.writeProjectFile({ root: r, path: "a.txt", text: "changed\n", hash: first.hash, known, backups });
  assert.equal(readFileSync(join(r, "a.txt"), "utf8"), "changed\n");
  assert.ok(saved.backup && readFileSync(saved.backup, "utf8") === "hello\n", "the old version is kept");
  assert.throws(() => F.writeProjectFile({ root: r, path: "a.txt", text: "mine\n", hash: first.hash, known, backups }), P.FileChanged);
  assert.equal(readFileSync(join(r, "a.txt"), "utf8"), "changed\n", "a stale save changes nothing");
  assert.throws(() => F.writeProjectFile({ root: r, path: "new.txt", text: "x", hash: first.hash, known, backups }), /does not exist/, "no new files");
  assert.throws(() => F.writeProjectFile({ root: r, path: "../a.txt", text: "x", hash: first.hash, known, backups }), P.ProjectError);

  writeFileSync(join(r, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(r, "run.sh"), 0o755);
  F.writeProjectFile({ root: r, path: "run.sh", text: "#!/bin/sh\necho hi\n", hash: F.readProjectFile(r, "run.sh", known).hash, known, backups });
  assert.equal(statSync(join(r, "run.sh")).mode & 0o777, 0o755);

  symlinkSync(join(r, "a.txt"), join(r, "link-in"));
  F.writeProjectFile({ root: r, path: "link-in", text: "through the link\n", hash: F.readProjectFile(r, "link-in", known).hash, known, backups });
  assert.equal(lstatSync(join(r, "link-in")).isSymbolicLink(), true, "the link stays a link");
  assert.equal(readFileSync(join(r, "a.txt"), "utf8"), "through the link\n");
  assert.deepEqual(readdirSync(r).filter((n) => n.includes(".annex-")), [], "no stray temp files");

  // keep: only the newest backups of this one file stay; another file's backups are left alone
  const target = join(r, "kept.txt");
  writeFileSync(target, "0");
  const dir = join(backups, "keep");
  mkdirSync(dir);
  writeFileSync(join(dir, "p--kept.txt--b--2026-01-01T00-00-00-000Z.txt"), "other file");
  let hash = sha(readFileSync(target));
  for (let i = 1; i <= 3; i++) {
    const ts = new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString().replace(/[:.]/g, "-");
    hash = P.saveChecked({ path: target, text: String(i), hash, backups: dir, backupName: `p--kept.txt--${ts}.txt`, keep: 2 }).hash;
  }
  const left = readdirSync(dir).sort();
  assert.equal(left.filter((n) => n.startsWith("p--kept.txt--2026")).length, 2);
  assert.ok(left.includes("p--kept.txt--b--2026-01-01T00-00-00-000Z.txt"), "a file whose name shares the prefix keeps its backups");
  assert.ok(existsSync(join(dir, left.at(-1)!)));
});

test("locate finds the deepest known project", () => {
  const outer = repo();
  const inner = join(outer, "inner");
  mkdirSync(inner);
  writeFileSync(join(inner, "x.ts"), "1");
  assert.deepEqual(F.locateFile(join(inner, "x.ts"), [outer, inner]), { root: inner, path: "x.ts" });
  assert.deepEqual(F.locateFile(join(outer, "a.txt"), [outer, inner]), { root: outer, path: "a.txt" });
  assert.deepEqual(F.locateFile(join(inner, "not-yet.ts"), [outer, inner]), { root: inner, path: "not-yet.ts" }, "a deleted file is still placed by its folder");
  assert.throws(() => F.locateFile("/etc/hosts", [outer, inner]), /not in one of your projects/);
  assert.throws(() => F.locateFile("relative/x.ts", [outer]), /full path/);
});
