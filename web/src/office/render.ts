// Pixels only. Text (speech, names, the stamp, the door sign) is HTML laid over the canvas, so it
// stays sharp at any scale and can be read by a screen reader.

import type { RoomScene, Actor } from "./scene.ts";
import { isMoving } from "./scene.ts";
import { deskOf } from "./grid.ts";
import {
  TILE, FLOOR_A, FLOOR_B, FLOOR_LINE, WALL, WALL_TRIM, ROLE, INK, GOOD, BAD, WARN, SCREEN_OFF,
  drawPerson, drawFolder, drawDesk, drawCabinet, drawTable, drawPlant, drawWindow, lookFor,
} from "./sprites.ts";

const LIGHT_COLOUR = { off: SCREEN_OFF, amber: WARN, green: GOOD, red: BAD } as const;

export function renderRoom(ctx: CanvasRenderingContext2D, scene: RoomScene, now: number) {
  const { layout } = scene;
  ctx.imageSmoothingEnabled = false;
  const W = layout.w * TILE;
  const H = layout.h * TILE;

  // floor and walls
  for (let y = 0; y < layout.h; y++) {
    for (let x = 0; x < layout.w; x++) {
      const edge = x === 0 || y === 0 || x === layout.w - 1 || y === layout.h - 1;
      if (edge && layout.solid[y * layout.w + x]) {
        ctx.fillStyle = WALL;
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      } else {
        ctx.fillStyle = (x + y) % 2 === 0 ? FLOOR_A : FLOOR_B;
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
        ctx.fillStyle = FLOOR_LINE;
        ctx.fillRect(x * TILE, y * TILE, TILE, 1);
      }
    }
  }
  ctx.fillStyle = WALL_TRIM;
  ctx.fillRect(TILE, TILE - 2, W - TILE * 2, 2);
  for (const [i, wx] of [4, 13].entries()) drawWindow(ctx, wx * TILE, 0, i + scene.wingId.length);

  // door, red while the wing is held
  const d = layout.door.at;
  ctx.fillStyle = scene.held ? BAD : "#2A2F6B";
  ctx.fillRect(d.x * TILE + 2, d.y * TILE, TILE - 4, TILE);
  ctx.fillStyle = scene.held ? "#FECDD3" : WALL_TRIM;
  ctx.fillRect(d.x * TILE + TILE - 6, d.y * TILE + 7, 2, 2);

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
    if (lit(sitter, desk.seat)) glow(ctx, desk.at.x * TILE + TILE, desk.at.y * TILE + 10, 44, sitter!.role === "lead" ? "255,181,71" : "56,189,248", now);
  }
  const r = layout.review.at;
  if (scene.reviewLight !== "off") {
    const rgb = scene.reviewLight === "green" ? "52,211,153" : scene.reviewLight === "red" ? "251,113,133" : "251,191,36";
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

  // a held wing is dimmed, as if the lights were off
  if (scene.held) {
    ctx.fillStyle = "rgba(8,10,30,0.45)";
    ctx.fillRect(0, 0, W, H);
  }
}

function glow(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, rgb: string, now: number) {
  // a slow flicker of a few percent, so a lit desk reads as alive without pulling the eye
  const f = 0.26 + 0.03 * Math.sin(now / 700 + cx);
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
  const px = Math.round(a.pos.x * TILE);
  const py = Math.round(a.pos.y * TILE) - (pose === "sit" ? 10 : 6);
  // a soft shadow grounds a standing or walking figure
  if (pose !== "sit") {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(px + 4, py + 15, 8, 2);
  }
  drawPerson(ctx, px, py, lookFor(a.role, a.index), pose, a.facing);
  if (a.working && pose === "sit" && Math.floor(now / 260) % 2 === 0) {
    ctx.fillStyle = INK;
    ctx.fillRect(px + 6, py + 9, 4, 1);
  }
  const carrying = [...scene.folders.values()].some((f) => f.place.kind === "carried" && f.place.by === a.id);
  if (carrying) drawFolder(ctx, px + (a.facing === 1 ? 9 : -2), py + 8);
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
    if (d < 14 && d < bestD) {
      best = a;
      bestD = d;
    }
  }
  return best;
}
