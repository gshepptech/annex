import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, sessionTranscript } from "./sessions.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "annex-sess-"));
  const mine = join(root, "-Users-me-app");
  const agent = join(root, "-Users-me-annex--paperclip-x");
  mkdirSync(mine);
  mkdirSync(agent);
  const lines = [
    { type: "custom-title", customTitle: "app-main", sessionId: A },
    { type: "user", cwd: "/Users/me/app", gitBranch: "main", timestamp: "2026-10-02T10:00:00Z", message: { role: "user", content: "add a login page" } },
    { type: "user", isMeta: true, cwd: "/Users/me/app", message: { role: "user", content: "<system-reminder>x</system-reminder>" } },
    { type: "assistant", cwd: "/Users/me/app/web", timestamp: "2026-10-02T10:00:05Z", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "On it." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/Users/me/app/web/login.ts" } }] } },
    { type: "user", cwd: "/Users/me/app/web", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "export {}" }] } },
    { type: "last-prompt", lastPrompt: "add a login page", sessionId: A },
  ];
  writeFileSync(join(mine, `${A}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(agent, `${B}.jsonl`), JSON.stringify({ type: "user", cwd: "/Users/me/annex/.paperclip/instances/default/workspaces/w", message: { content: "Wake" } }) + "\n");
  return root;
}

test("your sessions are listed with their project, branch, model and last prompt; Annex's agents are not", () => {
  const root = fixture();
  const list = listSessions({ root });
  assert.equal(list.length, 1);
  const s = list[0]!;
  assert.equal(s.title, "app-main");
  assert.equal(s.cwd, "/Users/me/app");
  assert.equal(s.branch, "main");
  assert.equal(s.model, "claude-opus-5-5");
  assert.equal(s.lastPrompt, "add a login page");
  assert.equal(s.status, "working");
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(root, "-Users-me-app", `${A}.jsonl`), old, old);
  assert.equal(listSessions({ root })[0]!.status, "idle");
  assert.equal(listSessions({ root, withinMs: 60_000 }).length, 0);
});

test("a session's transcript shows what you typed and what Claude did, not its internal notes", () => {
  const t = sessionTranscript(A, { root: fixture() })!;
  assert.deepEqual(t.entries.map((e) => e.kind), ["prompt", "text", "tool", "result"]);
  assert.equal(sessionTranscript(B, { root: fixture() }), null, "an agent's session is not yours to read here");
  assert.equal(sessionTranscript("../../etc/passwd", { root: fixture() }), null);
});
