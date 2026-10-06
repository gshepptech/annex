import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveSessions } from "./live.ts";

// A stand-in for `claude`: records what Annex writes, and lets the test speak for Claude.
function fakeClaude() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.emit("exit", null); } });
  const written: Record<string, unknown>[] = [];
  child.stdin.on("data", (d: Buffer) => { for (const l of d.toString().split("\n").filter(Boolean)) written.push(JSON.parse(l)); });
  const say = (m: unknown) => child.stdout.write(JSON.stringify(m) + "\n");
  return { child, written, say, run: (() => child) as never };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "annex-live-"));
  const lives = new LiveSessions({ claude: "claude", bourneUrl: "http://127.0.0.1:1", dir });
  const f = fakeClaude();
  const v = lives.start({ cwd: dir, mode: "default", run: f.run });
  return { lives, f, id: v.id, dir };
}

test("a question waits for you; Allow lets it run; allowing for the session skips the next one, but only the same Bash command", async () => {
  const { lives, id } = setup();
  const first = lives.ask(id, "Write", { file_path: "/x", content: "hi" });
  assert.equal(lives.get(id)!.prompts.length, 1, "the card is up");
  lives.answer(id, lives.get(id)!.prompts[0]!.id, { allow: true, always: true });
  assert.equal((await first).allow, true);
  assert.deepEqual(await lives.ask(id, "Write", { file_path: "/y" }), { allow: true }, "Write is allowed for the session now");
  const b1 = lives.ask(id, "Bash", { command: "npm test" });
  lives.answer(id, lives.get(id)!.prompts[0]!.id, { allow: true, always: true });
  await b1;
  assert.deepEqual(await lives.ask(id, "Bash", { command: "npm test" }), { allow: true });
  lives.ask(id, "Bash", { command: "rm -rf build" });
  assert.equal(lives.get(id)!.prompts.length, 1, "a different command still asks");
});

test("Stop and Close answer open questions with no, and nothing written after Close can crash Annex", async () => {
  const { lives, id, f } = setup();
  const q = lives.ask(id, "Bash", { command: "ls" });
  lives.interrupt(id);
  assert.equal((await q).allow, false);
  assert.ok(f.written.some((m) => (m.request as { subtype?: string } | undefined)?.subtype === "interrupt"));
  const q2 = lives.ask(id, "Edit", {});
  lives.close(id);
  assert.equal((await q2).allow, false);
  assert.throws(() => lives.send(id, "hello"), /closed/);
  assert.throws(() => lives.interrupt(id), /closed/);
  f.child.stdin.destroy();
  f.child.emit("exit", 1);
  await tick();
  assert.equal(lives.get(id)!.status, "closed");
});

test("the mode changes only when Claude accepts it; a refusal is shown", async () => {
  const { lives, id, f } = setup();
  lives.setMode(id, "plan");
  assert.equal(lives.get(id)!.mode, "default", "not before Claude answers");
  const req = f.written.at(-1)!.request_id as string;
  f.say({ type: "control_response", response: { subtype: "success", request_id: req, response: { mode: "plan" } } });
  await tick();
  assert.equal(lives.get(id)!.mode, "plan");
  lives.setMode(id, "bypassPermissions");
  const req2 = f.written.at(-1)!.request_id as string;
  f.say({ type: "control_response", response: { subtype: "error", request_id: req2, error: "Cannot set permission mode to bypassPermissions" } });
  await tick();
  assert.equal(lives.get(id)!.mode, "plan");
  assert.match(lives.get(id)!.error!, /Claude kept the mode: Cannot set/);
});

test("each session's approve server has its own token", () => {
  const a = setup();
  const b2 = fakeClaude();
  const other = a.lives.start({ cwd: a.dir, mode: "default", run: b2.run });
  const cfg = JSON.parse(readFileSync(join(a.dir, `${a.id}.mcp.json`), "utf8"));
  const token = cfg.mcpServers.bourne_live.env.BOURNE_TOKEN as string;
  assert.equal(a.lives.tokenOk(a.id, token), true);
  assert.equal(a.lives.tokenOk(other.id, token), false, "a token cannot speak for another session");
  assert.equal(a.lives.tokenOk(a.id, undefined), false);
});

test("the stream becomes entries; the turn's closing summary does not repeat the answer", async () => {
  const { lives, id, f } = setup();
  f.say({ type: "system", subtype: "init", session_id: "s-1", model: "claude-opus-5-5", slash_commands: ["help", "smith:start"] });
  await tick();
  lives.send(id, "hi");
  f.say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
  await tick();
  assert.equal(lives.get(id)!.partial, "Hel");
  f.say({ type: "assistant", message: { content: [{ type: "text", text: "Hello." }] } });
  f.say({ type: "result", result: "Hello.", is_error: false, duration_ms: 1000, num_turns: 1 });
  await tick();
  const v = lives.get(id)!;
  assert.equal(v.sessionId, "s-1");
  assert.deepEqual(v.slashCommands, ["help", "smith:start"]);
  assert.deepEqual(v.entries.map((e) => e.kind), ["prompt", "text", "done"]);
  assert.equal((v.entries[2] as { text: string }).text, "");
  assert.equal(v.status, "waiting");
  assert.equal(v.partial, "");
});

test("open sessions are written down and reopened after a restart, with their mode; closed ones are not", async () => {
  const { lives, f, id, dir } = setup();
  f.say({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "m", slash_commands: [] });
  await tick();
  const g = fakeClaude();
  const other = lives.start({ cwd: dir, mode: "plan", run: g.run });
  g.say({ type: "system", subtype: "init", session_id: "22222222-2222-4222-8222-222222222222", model: "m", slash_commands: [] });
  await tick();
  lives.close(other.id);
  lives.closeAll();
  const after = new LiveSessions({ claude: "claude", bourneUrl: "http://127.0.0.1:1", dir });
  const started: string[] = [];
  const orig = after.start.bind(after);
  after.start = ((o: Parameters<typeof orig>[0]) => { started.push(`${o.resume} ${o.mode}`); return orig({ ...o, run: fakeClaude().run }); }) as typeof after.start;
  assert.equal(after.restore(() => [{ kind: "prompt", at: "", text: "earlier" }]), 1);
  assert.deepEqual(started, ["11111111-1111-4111-8111-111111111111 default"], "the closed one stays closed");
  assert.equal(after.list()[0]!.entries[0]!.kind, "prompt", "its history is shown again");
  void id;
});

test("pasted images go to Claude as image blocks; anything that is not a small image is refused", () => {
  const { lives, f, id } = setup();
  lives.send(id, "what is this", [{ mediaType: "image/png", data: "iVBORw0KGgo=" }]);
  const msg = f.written.at(-1) as { message: { content: { type: string }[] } };
  assert.deepEqual(msg.message.content.map((c) => c.type), ["text", "image"]);
  assert.throws(() => lives.send(id, "x", [{ mediaType: "text/html", data: "PGgxPg==" }]), /PNG, JPEG/);
  assert.throws(() => lives.send(id, "x", [{ mediaType: "image/png", data: "not base64!" }]), /too large|damaged/);
});

test("!command runs in the session's folder and Claude gets the output; @ finds files there", async () => {
  const { lives, f, id, dir } = setup();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "cart.ts"), "export {}\n");
  const r = await lives.shell(id, "echo hello && pwd");
  assert.equal(r.exitCode, 0);
  const sent = (f.written.at(-1) as { message: { content: string } }).message.content;
  assert.match(sent, /\$ echo hello && pwd\nhello\n/);
  assert.match(sent, /\(exit 0\)/);
  assert.deepEqual(await lives.files(id, "cart"), ["src/cart.ts"]);
});

test("closeAndWait resolves only after the child has exited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "annex-live-"));
  const lives = new LiveSessions({ claude: "claude", bourneUrl: "http://127.0.0.1:1", dir });
  // a child that takes its time: kill does nothing until the test says it exited
  const f = fakeClaude();
  f.child.kill = () => {};
  const v = lives.start({ cwd: dir, mode: "default", run: f.run });
  let done = false;
  const p = lives.closeAndWait(v.id).then(() => (done = true));
  await tick();
  assert.equal(done, false, "still running");
  f.child.emit("exit", 0);
  await p;
  assert.equal(lives.get(v.id)!.status, "closed");
  await lives.closeAndWait(v.id);
});
