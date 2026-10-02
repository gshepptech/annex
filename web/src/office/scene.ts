// The office as a model. A snapshot from the server places everyone; after that, every change on
// screen comes from applying one stored event (design D8). Nothing moves on a timer of its own:
// an agent with nothing to do sits at its desk.

import type { BourneEvent } from "../../../server/events.ts";
import type { WingView, AgentView, TaskView } from "../../../server/api-types.ts";
import { defaultLayout, deskOf, findPath, type RoomLayout, type Spot } from "./grid.ts";

export type Place =
  | { kind: "desk"; desk: number }
  | { kind: "review" }
  | { kind: "carried"; by: string }
  | { kind: "filed" };

export interface Folder {
  id: string;
  title: string;
  assigneeId: string | null;
  place: Place;
}

export type Action =
  | { kind: "walk"; to: Spot }
  | { kind: "pick"; taskId: string }
  | { kind: "drop"; taskId: string; place: Place }
  | { kind: "file"; taskId: string }
  | { kind: "say"; text: string; ms: number }
  | { kind: "wait"; ms: number }
  // hold until a folder reaches the review desk, so a reviewer never takes a file out of the
  // hands of the worker still carrying it there
  | { kind: "await_review"; taskId: string };

export interface Actor {
  id: string;
  role: AgentView["role"];
  name: string;
  desk: number;
  index: number;
  pos: Spot;
  path: Spot[];
  queue: Action[];
  // when the current wait or say action ends
  busyUntil: number;
  bubble: { text: string; until: number } | null;
  working: boolean;
  facing: 1 | -1;
}

export type Light = "off" | "amber" | "green" | "red";

export interface Stamp {
  text: "VERIFIED" | "RETURNED";
  at: number;
}

export interface RoomScene {
  wingId: string;
  layout: RoomLayout;
  mode: WingView["mode"];
  actors: Map<string, Actor>;
  folders: Map<string, Folder>;
  filedCount: number;
  reviewLight: Light;
  stamp: Stamp | null;
  held: boolean;
  doorSign: string | null;
  lastEventId: number;
}

const WALK_TILES_PER_SEC = 4.5;

export function sceneFromSnapshot(w: WingView, lastEventId: number): RoomScene {
  // enough desks for the highest desk number in use, so a gap left by a departed worker is fine
  const layout = defaultLayout(Math.max(1, ...w.agents.filter((a) => a.role === "worker").map((a) => a.desk)));
  const scene: RoomScene = {
    wingId: w.id,
    layout,
    mode: w.mode,
    actors: new Map(),
    folders: new Map(),
    filedCount: w.filedCount,
    reviewLight: "off",
    stamp: null,
    held: w.held !== null,
    doorSign: w.held ? holdSign(w.held.until) : null,
    lastEventId,
  };
  w.agents.forEach((a, index) => {
    const actor: Actor = {
      ...a,
      index,
      pos: { x: 0, y: 0 },
      path: [],
      queue: [],
      busyUntil: 0,
      bubble: null,
      working: false,
      facing: 1,
    };
    actor.pos = { ...home(scene, actor) };
    scene.actors.set(a.id, actor);
  });
  for (const t of w.tasks) placeFromStatus(scene, t);
  return scene;
}

function placeFromStatus(scene: RoomScene, t: TaskView) {
  if (t.status === "done" || t.status === "cancelled") return;
  const assignee = t.assigneeId ? scene.actors.get(t.assigneeId) : undefined;
  const place: Place =
    t.status === "in_review" ? { kind: "review" } : { kind: "desk", desk: assignee?.desk ?? 0 };
  scene.folders.set(t.id, { id: t.id, title: t.title, assigneeId: t.assigneeId, place });
  if (assignee && t.status === "in_progress") assignee.working = true;
}

// Where an actor belongs when it has nothing to do.
export function home(scene: RoomScene, a: Pick<Actor, "role" | "desk">): Spot {
  if (a.role === "reviewer") return scene.layout.review.seat;
  if (a.role === "lead" && scene.mode === "with_you") return scene.layout.table.seats[0]!;
  return deskOf(scene.layout, a.desk).seat;
}

function lead(scene: RoomScene): Actor | undefined {
  return [...scene.actors.values()].find((a) => a.role === "lead");
}

function reviewer(scene: RoomScene): Actor | undefined {
  return [...scene.actors.values()].find((a) => a.role === "reviewer");
}

export function applyEvent(scene: RoomScene, e: BourneEvent, now: number) {
  if (e.wingId !== scene.wingId || e.id <= scene.lastEventId) return;
  scene.lastEventId = e.id;
  const actor = scene.actors.get(e.actor);
  const p = e.payload;
  const folder = e.taskId ? scene.folders.get(e.taskId) : undefined;

  switch (e.kind) {
    case "lead.woke": {
      const l = lead(scene);
      if (l) say(l, "Checking the signals", 2500, now);
      break;
    }
    case "lead.idle": {
      const l = lead(scene);
      if (l) say(l, String(p.reason ?? "Nothing worth doing yet"), 3500, now);
      break;
    }
    case "task.created": {
      if (!e.taskId) break;
      const assigneeId = typeof p.assigneeId === "string" ? p.assigneeId : null;
      const assignee = assigneeId ? scene.actors.get(assigneeId) : undefined;
      const by = actor ?? lead(scene);
      const f: Folder = { id: e.taskId, title: String(p.title ?? "Task"), assigneeId, place: { kind: "desk", desk: by?.desk ?? 0 } };
      scene.folders.set(f.id, f);
      if (by && assignee && assignee.id !== by.id) {
        const target = deskOf(scene.layout, assignee.desk);
        by.queue.push(
          { kind: "pick", taskId: f.id },
          { kind: "walk", to: beside(scene, target.seat) },
          { kind: "drop", taskId: f.id, place: { kind: "desk", desk: assignee.desk } },
          { kind: "walk", to: home(scene, by) },
        );
      } else if (assignee) {
        f.place = { kind: "desk", desk: assignee.desk };
      }
      break;
    }
    case "task.started":
      if (actor) actor.working = true;
      break;
    case "agent.tool":
      if (actor) say(actor, toolLine(p), 2200, now);
      break;
    case "agent.said":
      if (actor) say(actor, String(p.text ?? ""), 4000, now);
      break;
    case "task.in_review": {
      if (!folder) break;
      const worker = (actor && actor.role === "worker" ? actor : undefined) ?? (folder.assigneeId ? scene.actors.get(folder.assigneeId) : undefined);
      if (worker) {
        worker.working = false;
        worker.queue.push(
          { kind: "pick", taskId: folder.id },
          { kind: "walk", to: scene.layout.review.stand },
          { kind: "drop", taskId: folder.id, place: { kind: "review" } },
          { kind: "walk", to: home(scene, worker) },
        );
      } else {
        folder.place = { kind: "review" };
      }
      break;
    }
    case "check.started":
      scene.reviewLight = "amber";
      break;
    case "check.passed":
      scene.reviewLight = "green";
      break;
    case "check.failed":
      scene.reviewLight = "red";
      if (folder) sendBack(scene, folder, "RETURNED", now);
      break;
    case "review.rejected":
      scene.reviewLight = "red";
      if (folder) sendBack(scene, folder, "RETURNED", now);
      break;
    case "review.accepted":
      scene.reviewLight = "green";
      break;
    case "task.done": {
      scene.stamp = { text: "VERIFIED", at: now };
      if (!folder) break;
      const r = reviewer(scene);
      if (r) {
        r.queue.push(
          { kind: "await_review", taskId: folder.id },
          { kind: "wait", ms: 900 },
          { kind: "pick", taskId: folder.id },
          { kind: "walk", to: scene.layout.cabinet.stand },
          { kind: "file", taskId: folder.id },
          { kind: "walk", to: home(scene, r) },
        );
      } else {
        scene.folders.delete(folder.id);
        scene.filedCount++;
      }
      scene.reviewLight = "off";
      break;
    }
    case "task.stopped":
      if (folder) {
        scene.folders.delete(folder.id);
        const a = folder.assigneeId ? scene.actors.get(folder.assigneeId) : undefined;
        if (a) a.working = false;
      }
      break;
    case "approval.requested": {
      const l = lead(scene);
      if (l) {
        l.queue.push({ kind: "walk", to: scene.layout.door.stand });
        say(l, String(p.title ?? "Needs your say"), 4000, now);
      }
      break;
    }
    case "approval.decided": {
      const l = lead(scene);
      if (l) l.queue.push({ kind: "walk", to: home(scene, l) });
      break;
    }
    case "wing.mode_changed": {
      scene.mode = p.mode === "autonomous" ? "autonomous" : "with_you";
      const l = lead(scene);
      if (l) l.queue.push({ kind: "walk", to: home(scene, l) });
      break;
    }
    case "wing.held":
      scene.held = true;
      scene.doorSign = holdSign(typeof p.until === "string" ? p.until : null);
      break;
    case "wing.resumed":
      scene.held = false;
      scene.doorSign = null;
      break;
    case "chat.message": {
      const l = lead(scene);
      if (l && p.who === "lead") say(l, String(p.text ?? ""), 5000, now);
      break;
    }
  }
}

function sendBack(scene: RoomScene, folder: Folder, text: Stamp["text"], now: number) {
  scene.stamp = { text, at: now };
  const r = reviewer(scene);
  const worker = folder.assigneeId ? scene.actors.get(folder.assigneeId) : undefined;
  const alreadyReturning = r?.queue.some((q) => q.kind === "pick" && q.taskId === folder.id);
  if (r && worker && !alreadyReturning) {
    r.queue.push(
      { kind: "await_review", taskId: folder.id },
      { kind: "wait", ms: 900 },
      { kind: "pick", taskId: folder.id },
      { kind: "walk", to: beside(scene, deskOf(scene.layout, worker.desk).seat) },
      { kind: "drop", taskId: folder.id, place: { kind: "desk", desk: worker.desk } },
      { kind: "walk", to: home(scene, r) },
    );
  } else if (worker && !alreadyReturning) {
    folder.place = { kind: "desk", desk: worker.desk };
  }
}

// The tile next to a seat, so a visitor does not stand on top of whoever sits there.
function beside(scene: RoomScene, seat: Spot): Spot {
  for (const dx of [1, -1]) {
    const x = seat.x + dx;
    if (!scene.layout.solid[seat.y * scene.layout.w + x]) return { x, y: seat.y };
  }
  return { x: seat.x, y: seat.y + 1 };
}

function say(a: Actor, text: string, ms: number, now: number) {
  if (text) a.bubble = { text: text.length > 60 ? text.slice(0, 57) + "..." : text, until: now + ms };
}

function toolLine(p: Record<string, unknown>): string {
  const tool = String(p.tool ?? "tool");
  const detail = typeof p.detail === "string" ? p.detail : "";
  return detail ? `${tool}: ${detail}` : tool;
}

function holdSign(until: string | null): string {
  if (!until) return "HELD";
  const t = new Date(until);
  return `BACK ${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")}`;
}

// Advance every actor by dt milliseconds.
export function tick(scene: RoomScene, dt: number, now: number) {
  for (const a of scene.actors.values()) {
    if (a.bubble && a.bubble.until < now) a.bubble = null;
    step(scene, a, dt, now);
  }
}

function step(scene: RoomScene, a: Actor, dt: number, now: number) {
  let budget = (dt / 1000) * WALK_TILES_PER_SEC;
  for (let guard = 0; guard < 20; guard++) {
    const act = a.queue[0];
    if (!act) return;
    if (act.kind === "walk") {
      if (a.path.length === 0) {
        a.path = findPath(scene.layout, a.pos, act.to);
        if (a.path.length === 0) {
          a.pos = { ...act.to };
          a.queue.shift();
          continue;
        }
      }
      while (budget > 0 && a.path.length) {
        const next = a.path[0]!;
        const dx = next.x - a.pos.x;
        const dy = next.y - a.pos.y;
        const dist = Math.hypot(dx, dy);
        if (dx !== 0) a.facing = dx > 0 ? 1 : -1;
        if (dist <= budget) {
          a.pos = { ...next };
          a.path.shift();
          budget -= dist;
        } else {
          a.pos = { x: a.pos.x + (dx / dist) * budget, y: a.pos.y + (dy / dist) * budget };
          budget = 0;
        }
      }
      if (a.path.length) return;
      a.queue.shift();
      continue;
    }
    if (act.kind === "wait" || act.kind === "say") {
      if (a.busyUntil === 0) {
        a.busyUntil = now + act.ms;
        if (act.kind === "say") a.bubble = { text: act.text, until: now + act.ms };
      }
      if (now < a.busyUntil) return;
      a.busyUntil = 0;
      a.queue.shift();
      continue;
    }
    if (act.kind === "await_review") {
      const waiting = scene.folders.get(act.taskId);
      if (a.busyUntil === 0) a.busyUntil = now + 20_000;
      if (waiting && waiting.place.kind !== "review" && now < a.busyUntil) return;
      a.busyUntil = 0;
      a.queue.shift();
      continue;
    }
    const f = scene.folders.get(act.taskId);
    if (act.kind === "pick" && f) f.place = { kind: "carried", by: a.id };
    if (act.kind === "drop" && f) f.place = act.place;
    if (act.kind === "file") {
      if (f) scene.folders.delete(f.id);
      scene.filedCount++;
    }
    a.queue.shift();
  }
}

export function isMoving(a: Actor): boolean {
  return a.queue[0]?.kind === "walk";
}
