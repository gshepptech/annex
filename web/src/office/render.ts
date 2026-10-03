// Shapes only. Text (speech, names, the stamp, the door sign) is HTML laid over the canvas, so it
// stays sharp at any scale and can be read by a screen reader. Callers set the canvas transform so
// one unit here is one room unit (TILE per tile).

import type { RoomScene, Actor } from "./scene.ts";
import { isMoving } from "./scene.ts";
import { deskOf } from "./grid.ts";
import {
  TILE, PAL, ROLE, GOOD, BAD, WARN,
  drawPerson, drawFolder, drawDesk, drawCabinet, drawTable, drawPlant, drawWindow, drawDoor, lookFor,
} from "./sprites.ts";

const PERSON_SCALE = 1.7;
const LIGHT_COLOUR = { amber: WARN, green: GOOD, red: BAD } as const;

export function renderRoom(ctx: CanvasRenderingContext2D, scene: RoomScene, now: number) {
  const { layout } = scene;
  ctx.imageSmoothingEnabled = true;
  const W = layout.w * TILE;
  const H = layout.h * TILE;

  // paper, then the plan grid, then the walls drawn solid around the floor
  ctx.fillStyle = PAL.GROUND;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = PAL.GRID;
  for (let x = 1; x < layout.w; x++) ctx.fillRect(x * TILE, TILE, 0.5, H - TILE * 2);
  for (let y = 1; y < layout.h; y++) ctx.fillRect(TILE, y * TILE, W - TILE * 2, 0.5);
  const WALL = 5;
  ctx.fillStyle = PAL.WALL;
  ctx.fillRect(TILE - WALL, TILE - WALL, W - TILE * 2 + WALL * 2, WALL);
  ctx.fillRect(TILE - WALL, H - TILE, W - TILE * 2 + WALL * 2, WALL);
  ctx.fillRect(TILE - WALL, TILE, WALL, H - TILE * 2);
  ctx.fillRect(W - TILE, TILE, WALL, H - TILE * 2);
  for (const wx of [4, 13]) drawWindow(ctx, wx * TILE, 0);
  drawDoor(ctx, layout.door.at.x * TILE, layout.door.at.y * TILE, scene.held);

  drawTable(ctx, layout.table.at.x * TILE, layout.table.at.y * TILE);
  drawPlant(ctx, 1 * TILE, (layout.h - 2) * TILE);
  drawPlant(ctx, (layout.w - 2) * TILE, 1 * TILE + 4);
  drawCabinet(ctx, layout.cabinet.at.x * TILE, layout.cabinet.at.y * TILE, scene.filedCount);

  // pools of lamplight under every desk where someone is working, drawn before the furniture
  const workers = [...scene.actors.values()].filter((a) => a.role !== "reviewer");
  const lit = (a: Actor | undefined, seat: { x: number; y: number }) =>
    !scene.held && !!a && atSeat(a, seat) && (a.working || (a.role === "lead" && scene.mode === "autonomous"));
  for (const desk of layout.desks) {
    const sitter = workers.find((a) => a.desk === desk.desk);
    if (lit(sitter, desk.seat)) glow(ctx, desk.at.x * TILE + TILE, desk.at.y * TILE + 10, 44, sitter!.role === "lead" ? "238,138,46" : "43,127,217", now);
  }
  const r = layout.review.at;
  if (scene.reviewLight !== "off") {
    const rgb = scene.reviewLight === "green" ? "31,157,99" : scene.reviewLight === "red" ? "224,70,78" : "233,168,0";
    glow(ctx, r.x * TILE + TILE, r.y * TILE + 8, 36, rgb, now);
  }

  // the review desk carries the check light on its monitor
  drawDesk(ctx, r.x * TILE, r.y * TILE, scene.reviewLight === "off" ? null : LIGHT_COLOUR[scene.reviewLight]);
  for (const desk of layout.desks) {
    const sitter = workers.find((a) => a.desk === desk.desk);
    if (!sitter) continue;
    drawDesk(ctx, desk.at.x * TILE, desk.at.y * TILE, lit(sitter, desk.seat) ? ROLE[sitter.role] : null);
  }

  // files resting on desks and on the review desk, stacked a little when there are several
  const stacks = new Map<string, number>();
  for (const f of scene.folders.values()) {
    let x: number, y: number;
    if (f.place.kind === "desk") {
      const at = deskOf(layout, f.place.desk).at;
      x = at.x * TILE + 1;
      y = at.y * TILE + 2;
    } else if (f.place.kind === "review") {
      x = r.x * TILE + 1;
      y = r.y * TILE + 2;
    } else {
      continue;
    }
    const k = `${x},${y}`;
    const n = stacks.get(k) ?? 0;
    stacks.set(k, n + 1);
    if (n < 4) drawFolder(ctx, x + n, y - n * 2);
  }

  // people, back to front so nearer ones overlap
  const actors = [...scene.actors.values()].sort((a, b) => a.pos.y - b.pos.y);
  for (const a of actors) drawActor(ctx, scene, a, now);

  // a closed office is dimmed, as if the lights were off
  if (scene.held) {
    ctx.fillStyle = PAL.DIM;
    ctx.fillRect(0, 0, W, H);
  }
}

function glow(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, rgb: string, now: number) {
  // a slow flicker of a few percent, so a lit desk reads as alive without pulling the eye
  const f = Number(PAL.GLOW) + 0.03 * Math.sin(now / 700 + cx);
  const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, radius);
  g.addColorStop(0, `rgba(${rgb},${f})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
}

function atSeat(a: Actor, seat: { x: number; y: number }) {
  return Math.abs(a.pos.x - seat.x) < 0.01 && Math.abs(a.pos.y - seat.y) < 0.01;
}

function drawActor(ctx: CanvasRenderingContext2D, scene: RoomScene, a: Actor, now: number) {
  const moving = isMoving(a);
  const seated = !moving && seatedAt(scene, a);
  const pose = moving ? (Math.floor(now / 180) % 2 === 0 ? "step" : "stand") : seated ? "sit" : "stand";
  const px = a.pos.x * TILE;
  const py = a.pos.y * TILE - (pose === "sit" ? 2 : 6);
  // people are drawn larger than a tile, grown from where they stand, so they read at a glance
  ctx.save();
  ctx.translate(px + 8, py + 16);
  ctx.scale(PERSON_SCALE, PERSON_SCALE);
  ctx.translate(-8, -16);
  drawPerson(ctx, 0, 0, lookFor(scene.wingId === "your-desk" ? "you" : a.role, a.index), pose, a.facing);
  ctx.restore();
  const carrying = [...scene.folders.values()].some((f) => f.place.kind === "carried" && f.place.by === a.id);
  if (carrying) drawFolder(ctx, px + (a.facing === 1 ? 11 : -5), py + 6);
}

function seatedAt(scene: RoomScene, a: Actor): boolean {
  const seats = [...scene.layout.desks.map((d) => d.seat), scene.layout.review.seat, ...scene.layout.table.seats];
  return seats.some((s) => atSeat(a, s));
}

// Which actor, if any, is under a point in canvas pixels; used to open an agent's terminal.
export function actorAt(scene: RoomScene, x: number, y: number): { id: string } | null {
  let best: Actor | null = null;
  let bestD = Infinity;
  for (const a of scene.actors.values()) {
    const d = Math.hypot(a.pos.x * TILE + 8 - x, a.pos.y * TILE - y);
    if (d < 20 && d < bestD) {
      best = a;
      bestD = d;
    }
  }
  return best;
}
