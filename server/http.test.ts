import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db.ts";
import { startHttp, UserError, type Bureau } from "./http.ts";
import { refuseForeign } from "./http.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { LiveSessions } from "./live.ts";
import { Terminals, type SpawnPty } from "./terminals.ts";

function fakeBureau(store: Store): Bureau & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async state() { return { wings: [], director: null, lastEventId: 0, recent: store.eventsSince(0), usage: null }; },
    async directorSay(t) { calls.push(`director ${t}`); },
    async chat(w, t) { calls.push(`chat ${w} ${t}`); },
    async handoff(w) { calls.push(`handoff ${w}`); },
    async approveBrief(w, b) { calls.push(`approve ${w} ${b}`); },
    async comeBack(w) { if (w === "nope") throw new UserError("No wing called nope", 404); calls.push(`back ${w}`); },
    async dropIn(w, t) { calls.push(`drop ${w} ${t}`); return { taskId: "T9" }; },
    async transcript(a) { calls.push(`transcript ${a}`); return { agent: { id: a, role: "worker", name: "K", desk: 1, status: "idle", model: "", filed: 0, wingId: "w" }, instructions: "", systemPrompt: null, runs: [] }; },
    async hireFromOffice(w, n) { calls.push(`hire ${w} ${n}`); return { hired: n }; },
    async updateWing(w, e) { calls.push(`edit ${w} ${JSON.stringify(e)}`); },
    async createWing(n) { calls.push(`new ${n.id}`); return { id: n.id }; },
    async decideAsk(w, id, ok) { calls.push(`ask ${w} ${id} ${ok}`); },
    pause(w) { calls.push(`pause ${w}`); },
    resume(w) { calls.push(`resume ${w}`); },
    async addGoal(w, t, d) { calls.push(`goal ${w} ${t} ${d}`); return { id: 1 }; },
    closeGoal(w, id, s) { calls.push(`goal ${w} ${id} ${s}`); },
    async setAutonomy(w, on) { calls.push(`autonomy ${w} ${on}`); },
    async changes(w) { calls.push(`changes ${w}`); return { files: [] }; },
  };
}

async function boot(o: { key?: string; live?: LiveSessions; terminals?: Terminals } = {}) {
  const store = new Store(":memory:");
  const bureau = fakeBureau(store);
  const web = mkdtempSync(join(tmpdir(), "annex-web-"));
  writeFileSync(join(web, "index.html"), "<p>office</p>");
  const server = await startHttp({ bureau, store, port: 0, webDir: web, ...o });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, bureau, server, base };
}

test("routes reach the bureau and errors come back as readable JSON", async () => {
  const { bureau, server, base } = await boot();
  try {
    const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", body: JSON.stringify(body) });
    assert.equal((await post("/api/wings/upkeep/tasks", { title: "Bump vite" })).status, 201);
    assert.equal((await post("/api/wings/studio/chat", { text: "hi" })).status, 202);
    assert.equal((await post("/api/wings/studio/briefs/3/approve", {})).status, 200);
    assert.deepEqual(bureau.calls, ["drop upkeep Bump vite", "chat studio hi", "approve studio 3"]);
    assert.equal((await fetch(base + "/api/agents/A1/transcript")).status, 200);
    assert.equal((await fetch(base + "/api/wings/upkeep", { method: "PUT", body: JSON.stringify({ wakeEvery: "30m" }) })).status, 200);
    assert.equal((await post("/api/wings", { id: "docs", name: "Docs" })).status, 201);
    assert.equal((await post("/api/wings/upkeep/asks/4/decline", {})).status, 200);
    assert.equal((await post("/api/wings/upkeep/pause", {})).status, 200);
    assert.deepEqual(bureau.calls.slice(3), ["transcript A1", 'edit upkeep {"wakeEvery":"30m"}', "new docs", "ask upkeep 4 false", "pause upkeep"]);

    const missing = await post("/api/wings/upkeep/tasks", { title: "  " });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "title is required" });
    const unknown = await post("/api/wings/nope/come-back", {});
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).error, /No wing called nope/);
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal(await (await fetch(base + "/some/client/route")).text(), "<p>office</p>");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("the stream replays what was missed, then sends live events once each", async () => {
  const { store, server, base } = await boot();
  try {
    const first = store.record({ wingId: "w", kind: "lead.woke", actor: "L", taskId: null, payload: {} });
    store.record({ wingId: "w", kind: "lead.idle", actor: "L", taskId: null, payload: {} });
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream?after=${first.id}`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const seen: string[] = [];
    const decoder = new TextDecoder();
    let buf = "";
    setTimeout(() => store.record({ wingId: "w", kind: "task.created", actor: "L", taskId: "T1", payload: {} }), 50);
    while (seen.length < 2) {
      const { value } = await reader.read();
      buf += decoder.decode(value);
      for (const m of buf.matchAll(/data: (.*)\n\n/g)) {
        const kind = JSON.parse(m[1]!).kind;
        if (!seen.includes(kind)) seen.push(kind);
      }
    }
    assert.deepEqual(seen, ["lead.idle", "task.created"]);
    ctrl.abort();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("requests from another site or another host name are refused", () => {
  const r = (headers: Record<string, string>) => refuseForeign({ headers } as never);
  assert.equal(r({ host: "127.0.0.1:4300" }), null, "curl and Node clients send no Origin");
  assert.equal(r({ host: "127.0.0.1:4300", origin: "http://127.0.0.1:4300", "sec-fetch-site": "same-origin" }), null);
  assert.equal(r({ host: "localhost:4300", origin: "http://localhost:4300" }), null);
  assert.match(r({ host: "evil.example:4300" })!, /addressed to this machine/, "DNS rebinding");
  assert.match(r({ host: "127.0.0.1:4300", origin: "https://evil.example" })!, /not allowed/);
  assert.match(r({ host: "127.0.0.1:4300", origin: "null" })!, /sandboxed/);
  assert.match(r({ host: "127.0.0.1:4300", origin: "http://localhost:5173" })!, /not allowed/, "another local port is another site");
  assert.match(r({ host: "127.0.0.1:4300", "sec-fetch-site": "cross-site" })!, /Cross-site/);
});

test("with a key set, every API call must carry it; the page and the health check do not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "annex-key-"));
  writeFileSync(join(dir, "index.html"), "<p>office</p>");
  const store = new Store(join(dir, "b.db"));
  const server = await startHttp({ bureau: fakeBureau(store), store, port: 0, webDir: dir, key: "k".repeat(32) });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 200, "the page itself needs no key");
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/wings/upkeep/pause`, { method: "POST" })).status, 401, "curl from an agent is refused");
    assert.equal((await fetch(`${base}/api/state`, { headers: { "x-annex-key": "k".repeat(31) + "x" } })).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { "x-annex-key": "k".repeat(32) } })).status, 200);
    assert.equal((await fetch(`${base}/api/sessions?key=${"k".repeat(32)}`)).status, 200, "event streams pass it in the query");
  } finally {
    server.close();
  }
});

test("an event stream for a session that does not exist is refused cleanly, and Annex keeps running", async () => {
  const { LiveSessions } = await import("./live.ts");
  const dir = mkdtempSync(join(tmpdir(), "annex-sse-"));
  writeFileSync(join(dir, "index.html"), "<p>office</p>");
  const store = new Store(join(dir, "b.db"));
  const live = new LiveSessions({ claude: "claude", bourneUrl: "http://127.0.0.1:1", dir });
  const server = await startHttp({ bureau: fakeBureau(store), store, port: 0, webDir: dir, live });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${base}/api/live/00000000-0000-4000-8000-000000000000/events`);
    assert.equal(r.status, 404);
    assert.equal((await fetch(`${base}/api/health`)).status, 200, "still up");
  } finally {
    server.close();
  }
});

// A stand-in for `claude -p`: says which conversation it is, and exits when its input ends.
function fakeClaude(sessionId: string) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill() { child.emit("exit", null); } });
  child.stdin.on("finish", () => setTimeout(() => {
    child.exitCode = 0;
    child.emit("exit", 0);
  }, 20));
  setTimeout(() => child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "m", slash_commands: [] }) + "\n"), 5);
  return (() => child) as never;
}

function fakeSpawn(onSpawn: (args: string[]) => void = () => {}) {
  const written: string[] = [];
  const resizes: number[][] = [];
  const spawn: SpawnPty = (_file, args) => {
    onSpawn(args);
    return { pid: 1, onData() {}, onExit() {}, write: (d) => void written.push(d), resize: (c, r) => void resizes.push([c, r]), kill() {} };
  };
  return { spawn, written, resizes };
}

const SID = "22222222-2222-4222-8222-222222222222";
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const send = (base: string, p: string, body: unknown) => fetch(base + p, { method: "POST", body: JSON.stringify(body) });

test("terminals need the key", async () => {
  const terminals = new Terminals({ claude: "claude", spawn: fakeSpawn().spawn });
  const { server, base } = await boot({ key: "k".repeat(32), terminals });
  try {
    assert.equal((await fetch(`${base}/api/terminals`)).status, 401);
    assert.equal((await send(base, "/api/terminals", { cwd: "/" })).status, 401);
    assert.equal((await fetch(`${base}/api/terminals`, { headers: { "x-annex-key": "k".repeat(32) } })).status, 200);
  } finally {
    server.close();
  }
});

test("Open in terminal closes the live session before claude --resume starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "annex-move-"));
  const lives = new LiveSessions({ claude: "claude", bourneUrl: "http://127.0.0.1:1", dir });
  const l = lives.start({ cwd: dir, mode: "default", run: fakeClaude(SID) });
  await tick(30);
  const seen: { status: string | undefined; args: string[] }[] = [];
  const terminals = new Terminals({ claude: "/x/claude", shell: "/bin/zsh", spawn: fakeSpawn((args) => seen.push({ status: lives.get(l.id)?.status, args })).spawn });
  const { server, base } = await boot({ live: lives, terminals });
  try {
    const r = await send(base, "/api/terminals", { live: l.id });
    assert.equal(r.status, 201);
    const v = await r.json();
    assert.equal(v.kind, "claude");
    assert.equal(v.sessionId, SID);
    assert.deepEqual(seen, [{ status: "closed", args: ["-l", "-c", 'exec "$0" --resume "$1"', "/x/claude", SID] }], "the live child had exited first");
    assert.equal((await send(base, "/api/terminals", { live: l.id })).status, 200, "asking again finds the same terminal");
    assert.equal(terminals.list().length, 1);
  } finally {
    server.close();
  }
});

test("a conversation open in a terminal is not opened live or replied to", async () => {
  const dir = mkdtempSync(join(tmpdir(), "annex-one-"));
  const lives = new LiveSessions({ claude: "claude", bourneUrl: "http://127.0.0.1:1", dir });
  const terminals = new Terminals({ claude: "claude", spawn: fakeSpawn().spawn });
  terminals.open({ cwd: dir, claude: { resume: SID } });
  const { server, base } = await boot({ live: lives, terminals });
  try {
    const a = await send(base, "/api/live", { resume: SID });
    assert.equal(a.status, 409);
    assert.match((await a.json()).error, /terminal/);
    const b = await send(base, `/api/sessions/${SID}/reply`, { text: "hi" });
    assert.equal(b.status, 409);
    assert.match((await b.json()).error, /terminal/);
  } finally {
    server.close();
  }
});

test("input and resize reach the terminal; an unknown terminal is 404 before any stream starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "annex-io-"));
  const f = fakeSpawn();
  const terminals = new Terminals({ claude: "claude", spawn: f.spawn });
  const { server, base } = await boot({ terminals });
  try {
    const opened = await send(base, "/api/terminals", { cwd: dir });
    assert.equal(opened.status, 201);
    const { id } = await opened.json();
    assert.equal((await send(base, `/api/terminals/${id}/input`, { data: " " })).status, 200);
    assert.equal((await send(base, `/api/terminals/${id}/resize`, { cols: 120, rows: 40 })).status, 200);
    assert.deepEqual(f.written, [" "]);
    assert.deepEqual(f.resizes, [[120, 40]]);
    assert.equal((await send(base, `/api/terminals/${id}/input`, {})).status, 400);
    assert.equal((await send(base, "/api/terminals", { cwd: "relative/path" })).status, 400);
    assert.equal((await fetch(`${base}/api/terminals/00000000-0000-4000-8000-000000000000/events`)).status, 404);
    assert.equal((await fetch(`${base}/api/health`)).status, 200, "still up");
  } finally {
    server.close();
  }
});
