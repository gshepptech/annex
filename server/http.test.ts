import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db.ts";
import { startHttp, UserError, type Bureau } from "./http.ts";

function fakeBureau(store: Store): Bureau & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async state() { return { wings: [], lastEventId: 0, recent: store.eventsSince(0) }; },
    async chat(w, t) { calls.push(`chat ${w} ${t}`); },
    async handoff(w) { calls.push(`handoff ${w}`); },
    async approveBrief(w, b) { calls.push(`approve ${w} ${b}`); },
    async comeBack(w) { if (w === "nope") throw new UserError("No wing called nope", 404); calls.push(`back ${w}`); },
    async dropIn(w, t) { calls.push(`drop ${w} ${t}`); return { taskId: "T9" }; },
  };
}

async function boot() {
  const store = new Store(":memory:");
  const bureau = fakeBureau(store);
  const web = mkdtempSync(join(tmpdir(), "annex-web-"));
  writeFileSync(join(web, "index.html"), "<p>office</p>");
  const server = await startHttp({ bureau, store, port: 0, webDir: web });
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
