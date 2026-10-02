// A wing's room as data, and A* across it. The room is generated from how many desks the wing
// needs; nothing here assumes a fixed number of agents or a single room.

export interface Spot {
  x: number;
  y: number;
}

export interface Desk {
  desk: number;
  // top-left tile of the 2x1 desk
  at: Spot;
  // where the agent sits, below the desk
  seat: Spot;
}

export interface RoomLayout {
  w: number;
  h: number;
  solid: boolean[];
  desks: Desk[];
  review: { at: Spot; stand: Spot; seat: Spot };
  door: { at: Spot; stand: Spot };
  table: { at: Spot; seats: Spot[] };
  cabinet: { at: Spot; stand: Spot };
}

export const ROOM_W = 22;
export const ROOM_H = 14;

const WORKER_ROWS = [6, 10];
const WORKER_COLS = [2, 6, 10, 14];

export function defaultLayout(workerDesks: number): RoomLayout {
  const w = ROOM_W;
  const h = ROOM_H;
  const solid = new Array<boolean>(w * h).fill(false);
  const block = (x: number, y: number, bw = 1, bh = 1) => {
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) solid[(y + j) * w + (x + i)] = true;
  };

  // walls, with a door in the bottom wall
  for (let x = 0; x < w; x++) {
    block(x, 0);
    block(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    block(0, y);
    block(w - 1, y);
  }
  const door = { at: { x: 10, y: h - 1 }, stand: { x: 10, y: h - 2 } };
  solid[door.at.y * w + door.at.x] = false;

  const desks: Desk[] = [];
  const addDesk = (desk: number, x: number, y: number) => {
    block(x, y, 2, 1);
    desks.push({ desk, at: { x, y }, seat: { x, y: y + 1 } });
  };
  addDesk(0, 2, 2);
  const slots = WORKER_ROWS.flatMap((y) => WORKER_COLS.map((x) => ({ x, y })));
  for (let i = 0; i < Math.min(workerDesks, slots.length); i++) addDesk(i + 1, slots[i]!.x, slots[i]!.y);

  const table = { at: { x: 8, y: 2 }, seats: [{ x: 7, y: 3 }, { x: 11, y: 3 }, { x: 9, y: 4 }] };
  block(table.at.x, table.at.y, 3, 2);

  const review = { at: { x: 18, y: 4 }, stand: { x: 17, y: 5 }, seat: { x: 19, y: 5 } };
  block(review.at.x, review.at.y, 2, 1);

  const cabinet = { at: { x: 19, y: 10 }, stand: { x: 18, y: 11 } };
  block(cabinet.at.x, cabinet.at.y, 2, 2);

  // two plants, drawn by the renderer at these tiles
  block(1, h - 2);
  block(w - 2, 1);

  return { w, h, solid, desks, review, door, table, cabinet };
}

export function deskOf(layout: RoomLayout, desk: number): Desk {
  return layout.desks.find((d) => d.desk === desk) ?? layout.desks[0]!;
}

function walkable(layout: RoomLayout, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < layout.w && y < layout.h && !layout.solid[y * layout.w + x];
}

// 4-way A* with a Manhattan heuristic. Rooms are a few hundred tiles, so a sorted open list is
// plenty. Returns the tiles after `from`, ending at `to`; empty when already there or unreachable.
export function findPath(layout: RoomLayout, from: Spot, to: Spot): Spot[] {
  const key = (s: Spot) => s.y * layout.w + s.x;
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  if (start.x === to.x && start.y === to.y) return [];
  if (!walkable(layout, to.x, to.y)) return [];

  const g = new Map<number, number>([[key(start), 0]]);
  const came = new Map<number, Spot>();
  const open: { s: Spot; f: number }[] = [{ s: start, f: manhattan(start, to) }];
  const closed = new Set<number>();

  while (open.length) {
    open.sort((a, b) => a.f - b.f);
    const { s } = open.shift()!;
    const k = key(s);
    if (s.x === to.x && s.y === to.y) {
      const path: Spot[] = [s];
      let cur = came.get(k);
      while (cur && key(cur) !== key(start)) {
        path.unshift(cur);
        cur = came.get(key(cur));
      }
      return path;
    }
    if (closed.has(k)) continue;
    closed.add(k);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { x: s.x + dx, y: s.y + dy };
      if (!walkable(layout, n.x, n.y) && !(n.x === start.x && n.y === start.y)) continue;
      const nk = key(n);
      const ng = (g.get(k) ?? Infinity) + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        came.set(nk, s);
        open.push({ s: n, f: ng + manhattan(n, to) });
      }
    }
  }
  return [];
}

function manhattan(a: Spot, b: Spot) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
