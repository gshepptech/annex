import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultLayout, findPath } from "./grid.ts";
import { sceneFromSnapshot, applyEvent, tick, type RoomScene } from "./scene.ts";
import type { WingView } from "../../../server/api-types.ts";
import type { BourneEvent, EventKind } from "../../../server/events.ts";

const wing = (over: Partial<WingView> = {}): WingView => ({
  id: "upkeep",
  name: "Upkeep",
  mode: "autonomous",
  charter: "",
  repo: null,
  integrationBranch: null,
  held: null,
  offline: null,
  agents: [
    { id: "L", role: "lead", name: "Lead", desk: 0, status: "idle", model: "", filed: 0 },
    { id: "W1", role: "worker", name: "One", desk: 1, status: "idle", model: "", filed: 0 },
    { id: "W2", role: "worker", name: "Two", desk: 2, status: "idle", model: "", filed: 0 },
    { id: "R", role: "reviewer", name: "Rev", desk: -1, status: "idle", model: "", filed: 0 },
  ],
  tasks: [],
  filedCount: 0,
  brief: null,
  draft: null,
  chat: [],
  settings: { wakeEvery: "15m", maxRunsPerHour: null, quietHours: null, backOffWhenIdle: false, askBefore: [], maxWorkers: 6 },
  nextWake: { at: null, blockedBy: null },
  houseRules: [],
  loot: { commits: [], command: null },
  asks: [],
  paused: false,
  edit: { name: "Upkeep", charter: "", doneCheck: null, setup: null, repoPath: null, baseBranch: "main", workers: 2, leadModel: "", workerModel: "", reviewerModel: "", allow: [] },
  ...over,
});

let id = 0;
const ev = (kind: EventKind, actor: string, taskId: string | null, payload: Record<string, unknown> = {}): BourneEvent => ({
  id: ++id, wingId: "upkeep", at: new Date().toISOString(), kind, actor, taskId, payload,
});

// run the scene forward in 50ms steps
function settle(scene: RoomScene, start: number, ms = 30_000): number {
  let t = start;
  for (; t < start + ms; t += 50) tick(scene, 50, t);
  return t;
}

test("every desk seat, the review desk, the cabinet and the door are reachable from the lead's desk", () => {
  const layout = defaultLayout(8);
  const from = layout.desks[0]!.seat;
  const targets = [...layout.desks.map((d) => d.seat), layout.review.stand, layout.review.seat, layout.cabinet.stand, layout.door.stand, ...layout.table.seats];
  for (const t of targets) {
    const p = findPath(layout, from, t);
    assert.ok(t.x === from.x && t.y === from.y ? p.length === 0 : p.length > 0, `no path to ${JSON.stringify(t)}`);
  }
});

test("a path never steps on furniture", () => {
  const layout = defaultLayout(4);
  for (const s of findPath(layout, layout.desks[0]!.seat, layout.cabinet.stand)) {
    assert.equal(layout.solid[s.y * layout.w + s.x], false);
  }
});

test("a task goes lead -> worker -> review -> filed, and the office goes quiet after", () => {
  const scene = sceneFromSnapshot(wing(), 0);
  let t = 0;
  applyEvent(scene, ev("task.created", "L", "T1", { title: "Bump react", assigneeId: "W1" }), t);
  assert.equal(scene.folders.get("T1")?.place.kind, "desk");
  t = settle(scene, t);
  assert.deepEqual(scene.folders.get("T1")?.place, { kind: "desk", desk: 1 });
  assert.deepEqual(scene.actors.get("L")!.pos, scene.layout.desks[0]!.seat, "lead walked back to its desk");

  applyEvent(scene, ev("task.started", "W1", "T1"), t);
  assert.equal(scene.actors.get("W1")!.working, true);
  applyEvent(scene, ev("task.in_review", "W1", "T1"), t);
  t = settle(scene, t);
  assert.deepEqual(scene.folders.get("T1")?.place, { kind: "review" });
  assert.equal(scene.actors.get("W1")!.working, false);

  applyEvent(scene, ev("check.started", "annex", "T1"), t);
  assert.equal(scene.reviewLight, "amber");
  applyEvent(scene, ev("check.passed", "annex", "T1"), t);
  applyEvent(scene, ev("review.accepted", "R", "T1"), t);
  applyEvent(scene, ev("task.done", "annex", "T1"), t);
  assert.equal(scene.stamp?.text, "VERIFIED");
  t = settle(scene, t);
  assert.equal(scene.folders.has("T1"), false);
  assert.equal(scene.filedCount, 1);
  for (const a of scene.actors.values()) assert.equal(a.queue.length, 0, `${a.id} still has work queued`);
});

test("a rejection that lands while the worker is still walking waits for the file to reach review", () => {
  const scene = sceneFromSnapshot(wing({ tasks: [{ id: "T2", key: "t2", title: "x", status: "in_progress", assigneeId: "W2" }] }), 0);
  let t = 0;
  applyEvent(scene, ev("task.in_review", "W2", "T2"), t);
  tick(scene, 50, (t += 50));
  assert.equal(scene.folders.get("T2")?.place.kind, "carried");
  applyEvent(scene, ev("review.rejected", "R", "T2", { reason: "tests fail" }), t);
  applyEvent(scene, ev("check.failed", "annex", "T2"), t);
  assert.equal(scene.stamp?.text, "RETURNED");
  t = settle(scene, t);
  assert.deepEqual(scene.folders.get("T2")?.place, { kind: "desk", desk: 2 });
  assert.equal(scene.actors.get("R")!.queue.length, 0);
});

test("old or foreign events change nothing", () => {
  const scene = sceneFromSnapshot(wing(), 100);
  applyEvent(scene, { ...ev("wing.held", "annex", null, {}), id: 50 }, 0);
  applyEvent(scene, { ...ev("wing.held", "annex", null, {}), wingId: "studio", id: 200 }, 0);
  assert.equal(scene.held, false);
});

test("mode changes move the lead between its desk and the planning table", () => {
  const scene = sceneFromSnapshot(wing({ mode: "with_you" }), 0);
  assert.deepEqual(scene.actors.get("L")!.pos, scene.layout.table.seats[0]);
  applyEvent(scene, ev("wing.mode_changed", "you", null, { mode: "autonomous" }), 0);
  settle(scene, 0);
  assert.deepEqual(scene.actors.get("L")!.pos, scene.layout.desks[0]!.seat);
});

test("nothing moves without an event", () => {
  const scene = sceneFromSnapshot(wing(), 0);
  const before = JSON.stringify([...scene.actors.values()].map((a) => a.pos));
  settle(scene, 0, 60_000);
  assert.equal(JSON.stringify([...scene.actors.values()].map((a) => a.pos)), before);
});
