import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./db.ts";

const store = () => new Store(":memory:");

test("a wing keeps its mode across ensureWing calls", () => {
  const s = store();
  s.ensureWing("upkeep", "autonomous");
  s.setMode("upkeep", "with_you");
  assert.equal(s.ensureWing("upkeep", "autonomous").mode, "with_you");
});

test("desks are never handed out while taken", () => {
  const s = store();
  s.ensureWing("w", "with_you");
  assert.equal(s.addAgent({ id: "lead", wingId: "w", role: "lead", name: "Lead" }).desk, 0);
  assert.equal(s.addAgent({ id: "rev", wingId: "w", role: "reviewer", name: "Rev" }).desk, -1, "the reviewer takes no worker desk");
  assert.equal(s.addAgent({ id: "a", wingId: "w", role: "worker", name: "A" }).desk, 1);
  assert.equal(s.addAgent({ id: "b", wingId: "w", role: "worker", name: "B" }).desk, 2);
  s.removeAgent("a");
  assert.equal(s.addAgent({ id: "c", wingId: "w", role: "worker", name: "C" }).desk, 1);
  assert.equal(s.addAgent({ id: "d", wingId: "w", role: "worker", name: "D" }).desk, 3);
});

test("approving a brief supersedes the previous one", () => {
  const s = store();
  s.ensureWing("w", "with_you");
  const one = s.addBrief("w", "first");
  s.approveBrief(one.id);
  const two = s.addBrief("w", "second");
  assert.equal(two.version, 2);
  s.approveBrief(two.id);
  assert.equal(s.currentBrief("w")?.text, "second");
  assert.equal(s.brief(one.id)?.status, "superseded");
});

test("check attempts count up per task", () => {
  const s = store();
  s.ensureWing("w", "autonomous");
  const a = s.startCheck({ wingId: "w", taskId: "t1", command: "npm test", cwd: "/x" });
  s.finishCheck(a.id, 1, "fail");
  const b = s.startCheck({ wingId: "w", taskId: "t1", command: "npm test", cwd: "/x" });
  assert.equal(b.attempt, 2);
  assert.deepEqual(s.checks("t1").map((c) => c.exitCode), [1, null]);
});

test("recorded events reach listeners and can be replayed", () => {
  const s = store();
  const seen: string[] = [];
  s.onEvent((e) => seen.push(e.kind));
  const first = s.record({ wingId: "w", kind: "lead.woke", actor: "lead", taskId: null, payload: {} });
  s.record({ wingId: "w", kind: "task.created", actor: "lead", taskId: "t1", payload: { title: "x" } });
  assert.deepEqual(seen, ["lead.woke", "task.created"]);
  assert.deepEqual(s.eventsSince(first.id).map((e) => e.payload), [{ title: "x" }]);
});
