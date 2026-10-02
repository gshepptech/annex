// Pixels only. Text (speech, names, the stamp, the door sign) is HTML laid over the canvas, so it
// stays sharp at any scale and can be read by a screen reader.

import type { RoomScene, Actor } from "./scene.ts";
import { isMoving } from "./scene.ts";
import { deskOf } from "./grid.ts";
import {
  TILE, FLOOR_A, FLOOR_B, WALL, WALL_TOP, STAMP, STEEL_DARK, INK,
  drawPerson, drawFolder, drawDesk, drawCabinet, drawTable, lookFor,
} from "./sprites.ts";

const LIGHT_COLOUR = { off: STEEL_DARK, amber: "#E0A43A", green: "#4FA36B", red: STAMP } as const;

export function renderRoom(ctx: CanvasRenderingContext2D, scene: RoomScene, now: number) {
  const { layout } = scene;
  ctx.imageSmoothingEnabled = false;

  for (let y = 0; y < layout.h; y++) {
    for (let x = 0; x < layout.w; x++) {
      const solidWall = x === 0 || y === 0 || x === layout.w - 1 || y === layout.h - 1;
      if (solidWall && layout.solid[y * layout.w + x]) {
        ctx.fillStyle = WALL;
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
        if (y === 0) {
          ctx.fillStyle = WALL_TOP;
          ctx.fillRect(x * TILE, TILE - 3, TILE, 3);
        }
      } else {
        ctx.fillStyle = (x + y) % 2 === 0 ? FLOOR_A : FLOOR_B;
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
  }

  // door
  const d = layout.door.at;
  ctx.fillStyle = scene.held ? STAMP : "#2A2F27";
  ctx.fillRect(d.x * TILE + 2, d.y * TILE, TILE - 4, TILE);

  drawTable(ctx, layout.table.at.x * TILE, layout.table.at.y * TILE);
  drawCabinet(ctx, layout.cabinet.at.x * TILE, layout.cabinet.at.y * TILE, scene.filedCount);

  // the review desk carries the check light instead of a lamp
  const r = layout.review.at;
  drawDesk(ctx, r.x * TILE, r.y * TILE, false);
  ctx.fillStyle = LIGHT_COLOUR[scene.reviewLight];
  ctx.fillRect(r.x * TILE + 3, r.y * TILE - 2, 6, 4);

  const occupied = new Set([...scene.actors.values()].filter((a) => a.role !== "reviewer").map((a) => a.desk));
  for (const desk of layout.desks) {
    if (!occupied.has(desk.desk)) continue;
    const sitter = [...scene.actors.values()].find((a) => a.desk === desk.desk && a.role !== "reviewer");
    // a lamp is on when its owner is at the desk and has something to do there
    const atDesk = !!sitter && Math.abs(sitter.pos.x - desk.seat.x) < 0.01 && Math.abs(sitter.pos.y - desk.seat.y) < 0.01;
    drawDesk(ctx, desk.at.x * TILE, desk.at.y * TILE, !scene.held && atDesk && (sitter!.working || sitter!.role === "lead"));
  }

  // folders resting on desks and on the review desk, stacked a little when there are several
  const stacks = new Map<string, number>();
  for (const f of scene.folders.values()) {
    let x: number, y: number;
    if (f.place.kind === "desk") {
      const at = deskOf(layout, f.place.desk).at;
      x = at.x * TILE + 4;
      y = at.y * TILE + 2;
    } else if (f.place.kind === "review") {
      x = r.x * TILE + 14;
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
}

function drawActor(ctx: CanvasRenderingContext2D, scene: RoomScene, a: Actor, now: number) {
  const moving = isMoving(a);
  const atSeat = !moving && seatedAt(scene, a);
  const pose = moving ? (Math.floor(now / 180) % 2 === 0 ? "step" : "stand") : atSeat ? "sit" : "stand";
  const px = Math.round(a.pos.x * TILE);
  // seated people sit up into the desk tile above them
  const py = Math.round(a.pos.y * TILE) - (pose === "sit" ? 10 : 6);
  drawPerson(ctx, px, py, lookFor(a.role, a.index), pose, a.facing);
  // a working agent's hands move on the keyboard
  if (a.working && pose === "sit" && Math.floor(now / 260) % 2 === 0) {
    ctx.fillStyle = INK;
    ctx.fillRect(px + 6, py + 9, 4, 1);
  }
  const carrying = [...scene.folders.values()].some((f) => f.place.kind === "carried" && f.place.by === a.id);
  if (carrying) drawFolder(ctx, px + (a.facing === 1 ? 9 : -2), py + 8);
}

function seatedAt(scene: RoomScene, a: Actor): boolean {
  const seats = [
    ...scene.layout.desks.map((d) => d.seat),
    scene.layout.review.seat,
    ...scene.layout.table.seats,
  ];
  return seats.some((s) => Math.abs(s.x - a.pos.x) < 0.01 && Math.abs(s.y - a.pos.y) < 0.01);
}
