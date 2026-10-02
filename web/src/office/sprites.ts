// Every piece of the office is drawn here as vector shapes, so there are no image files and no
// art licences to track. Coordinates are in room units (TILE per tile); the renderer scales the
// canvas up to the screen's real resolution, so edges stay smooth at any size.
//
// The office is an architect's model, by day or by night: furniture with soft shadows, and
// colour that comes from people and work. A monitor lights up in its owner's role colour
// only while they are working.

export const TILE = 16;

export const ROLE = { lead: "#EE8A2E", worker: "#2B7FD9", reviewer: "#7C5CE0" } as const;
export const INK = "#18232A";
// The room's colours for each theme. `PAL` is the one in use; setRoomTheme swaps it in place.
const LIGHT = {
  FLOOR: "#F1F3EF",
  FLOOR_LINE: "#E9EDE9",
  WALL: "#33434B",
  WALL_TOP: "#46585F",
  SKY: "#BFE4F4",
  SKY_LOW: "#E3F3F9",
  DESK_TOP: "#FFFFFF",
  DESK_EDGE: "#D5DDD9",
  DESK_LEG: "#B4C1BB",
  SCREEN_OFF: "#3A4A52",
  BEZEL: "#22303A",
  FILE: "#F7C948",
  FILE_DARK: "#D9A21B",
  CABINET: "#D9E1DE",
  CABINET_EDGE: "#B9C6C0",
  RUG: "#D6ECE6",
  RUG_EDGE: "#B5D8CF",
  LEAF: "#3FAE72",
  LEAF_DARK: "#2C8A57",
  POT: "#E9E4DA",
  SHADOW: "rgba(24, 35, 42, 0.14)",
  MUG: "#E9EEF0",
  PAPER: "#EEF3F6",
  DRAWER: "#E8EDEB",
  DOORMAT: "#D7DFDB",
  WALL_SHADE: "24,35,42",
  DIM: "rgba(24,35,42,0.32)",
  GLOW: "0.2",
};

const DARK: typeof LIGHT = {
  FLOOR: "#222B31",
  FLOOR_LINE: "#27313A",
  WALL: "#0C1114",
  WALL_TOP: "#1A2328",
  SKY: "#1B2F4D",
  SKY_LOW: "#2C4868",
  DESK_TOP: "#3A464D",
  DESK_EDGE: "#2A343A",
  DESK_LEG: "#1E272C",
  SCREEN_OFF: "#161D21",
  BEZEL: "#0A0E10",
  FILE: "#F7C948",
  FILE_DARK: "#D9A21B",
  CABINET: "#323E44",
  CABINET_EDGE: "#252F34",
  RUG: "#1D3634",
  RUG_EDGE: "#284845",
  LEAF: "#3FAE72",
  LEAF_DARK: "#2C8A57",
  POT: "#4A5157",
  SHADOW: "rgba(0, 0, 0, 0.32)",
  MUG: "#56636A",
  PAPER: "#4C5960",
  DRAWER: "#3B484F",
  DOORMAT: "#2E393F",
  WALL_SHADE: "0,0,0",
  DIM: "rgba(0,0,0,0.4)",
  GLOW: "0.3",
};

export const PAL = { ...DARK };

export function setRoomTheme(theme: "light" | "dark") {
  Object.assign(PAL, theme === "light" ? LIGHT : DARK);
}

export const GOOD = "#1F9D63";
export const BAD = "#E0464E";
export const WARN = "#E9A800";

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

function circle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function ellipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, fill: string) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

export interface Look {
  hair: string;
  skin: string;
  jacket: string;
  trousers: string;
  visor: string | null;
}

const SKINS = ["#F2C6A0", "#C68A62", "#8D5A3B", "#F6D7BD", "#A86F4C"];
const HAIRS = ["#2B2118", "#6B4A2E", "#C08A4F", "#16161D", "#9CA3AF"];

export function lookFor(role: keyof typeof ROLE | "director", index: number): Look {
  const skin = SKINS[index % SKINS.length]!;
  const hair = HAIRS[(index * 3 + 1) % HAIRS.length]!;
  if (role === "director") return { hair: "#D9DEE2", skin: SKINS[0]!, jacket: BAD, trousers: "#2A3940", visor: null };
  if (role === "reviewer") return { hair, skin, jacket: ROLE.reviewer, trousers: "#2A3940", visor: "#1F9D63" };
  return { hair, skin, jacket: ROLE[role], trousers: "#2A3940", visor: null };
}

// One person in a 16x16 cell whose top-left is (x, y). A step lifts the body a little.
export function drawPerson(ctx: CanvasRenderingContext2D, x: number, y: number, look: Look, pose: "stand" | "step" | "sit", facing: 1 | -1) {
  const cx = x + 8;
  const sit = pose === "sit";
  const lift = pose === "step" ? -0.8 : 0;
  if (!sit) {
    ellipse(ctx, cx, y + 15.4, 4.6, 1.3, PAL.SHADOW);
    // while stepping one foot is off the floor
    const raised = facing === 1 ? 0 : 1;
    for (const [i, lx] of [cx - 3.2, cx + 0.6].entries()) {
      const up = pose === "step" && i === raised ? 1.2 : 0;
      roundRect(ctx, lx, y + 11 + lift, 2.6, 4.2 - lift - up, 1.2, look.trousers);
    }
  }
  // body
  const top = y + 6.6 + lift + (sit ? 1 : 0);
  roundRect(ctx, cx - 4.6, top, 9.2, sit ? 5.4 : 6, 3, look.jacket);
  // a lighter collar keeps the body readable against its own colour
  ctx.globalAlpha = 0.35;
  roundRect(ctx, cx - 1.6, top + 0.4, 3.2, 1.6, 0.8, "#FFFFFF");
  ctx.globalAlpha = 1;
  // head
  const hy = y + 4 + lift + (sit ? 1 : 0);
  circle(ctx, cx, hy, 3.7, look.skin);
  // hair: a cap over the top of the head, parted toward where they face
  ctx.beginPath();
  ctx.arc(cx, hy, 3.9, Math.PI * 1.02, Math.PI * 1.98);
  ctx.quadraticCurveTo(cx + facing * 1.5, hy - 1.4, cx - 3.9, hy - 0.2);
  ctx.fillStyle = look.hair;
  ctx.fill();
  // eyes, or a visor across them
  if (look.visor) {
    roundRect(ctx, cx - 3.6, hy - 0.2, 7.2, 1.7, 0.85, look.visor);
  } else {
    circle(ctx, cx - 1.3 + facing * 0.4, hy + 0.6, 0.45, INK);
    circle(ctx, cx + 1.3 + facing * 0.4, hy + 0.6, 0.45, INK);
  }
}

export function drawFolder(ctx: CanvasRenderingContext2D, x: number, y: number) {
  roundRect(ctx, x + 0.6, y + 2.6, 9, 6, 1, PAL.SHADOW);
  roundRect(ctx, x, y + 1, 4, 2, 0.8, PAL.FILE_DARK);
  roundRect(ctx, x, y + 2, 9, 6, 1, PAL.FILE);
  ctx.fillStyle = "rgba(24,35,42,0.35)";
  ctx.fillRect(x + 2, y + 4.4, 5, 0.7);
}

// A desk with a monitor. `glow` is the screen colour while its owner works, null when idle.
export function drawDesk(ctx: CanvasRenderingContext2D, x: number, y: number, glow: string | null) {
  const w = TILE * 2;
  roundRect(ctx, x + 1, y + 6, w - 1, 11, 2.5, PAL.SHADOW);
  roundRect(ctx, x + 2, y + 10, 1.6, 6, 0.8, PAL.DESK_LEG);
  roundRect(ctx, x + w - 3.6, y + 10, 1.6, 6, 0.8, PAL.DESK_LEG);
  roundRect(ctx, x, y + 3, w, 9, 2.5, PAL.DESK_EDGE);
  roundRect(ctx, x, y + 2, w, 8, 2.5, PAL.DESK_TOP);
  // monitor on its stand
  roundRect(ctx, x + 14.5, y + 2, 3, 3, 0.6, PAL.BEZEL);
  roundRect(ctx, x + 8.5, y - 6.5, 15, 10, 1.8, PAL.BEZEL);
  roundRect(ctx, x + 9.5, y - 5.5, 13, 8, 1.2, glow ?? PAL.SCREEN_OFF);
  if (glow) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(x + 11, y - 3.8, 7, 0.8);
    ctx.fillRect(x + 11, y - 2, 9, 0.8);
    ctx.fillRect(x + 11, y - 0.2, 5, 0.8);
  }
  // a mug, so the desks read as lived in
  roundRect(ctx, x + 3, y + 3.5, 2.6, 2.8, 0.8, PAL.MUG);
}

export function drawCabinet(ctx: CanvasRenderingContext2D, x: number, y: number, filed: number) {
  const w = TILE * 2;
  roundRect(ctx, x + 1.5, y + 2, w, TILE * 2, 3, PAL.SHADOW);
  roundRect(ctx, x, y, w, TILE * 2, 3, PAL.CABINET_EDGE);
  roundRect(ctx, x, y, w, TILE * 2 - 1.5, 3, PAL.CABINET);
  for (let i = 0; i < 4; i++) {
    roundRect(ctx, x + 2.5, y + 2.5 + i * 7, w - 5, 5.6, 1.4, PAL.DRAWER);
    roundRect(ctx, x + TILE - 3, y + 4.6 + i * 7, 6, 1.2, 0.6, PAL.CABINET_EDGE);
  }
  // a gold edge shows in the top drawer once anything has been filed, longer as more is filed
  if (filed > 0) roundRect(ctx, x + 4, y + 1, Math.min(24, 4 + filed * 3), 1.4, 0.7, PAL.FILE);
}

export function drawTable(ctx: CanvasRenderingContext2D, x: number, y: number) {
  // the rug the planning happens on
  roundRect(ctx, x - 8, y - 4, TILE * 3 + 16, TILE * 2 + 12, 8, PAL.RUG_EDGE);
  roundRect(ctx, x - 6.5, y - 2.5, TILE * 3 + 13, TILE * 2 + 9, 7, PAL.RUG);
  roundRect(ctx, x + 1.5, y + 4, TILE * 3, TILE * 2 - 4, 6, PAL.SHADOW);
  roundRect(ctx, x, y + 2, TILE * 3, TILE * 2 - 5, 6, PAL.DESK_EDGE);
  roundRect(ctx, x, y + 1, TILE * 3, TILE * 2 - 6, 6, PAL.DESK_TOP);
  // papers being planned over
  roundRect(ctx, x + 8, y + 6, 10, 7, 1, PAL.PAPER);
  roundRect(ctx, x + 22, y + 8, 9, 7, 1, PAL.PAPER);
  ctx.fillStyle = ROLE.lead;
  ctx.fillRect(x + 10, y + 8, 6, 0.8);
  ctx.fillRect(x + 10, y + 10, 4, 0.8);
  ctx.fillRect(x + 24, y + 10, 5, 0.8);
}

export function drawPlant(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ellipse(ctx, x + 8.5, y + 15.5, 5, 1.4, PAL.SHADOW);
  roundRect(ctx, x + 4, y + 10, 8, 6, 2, PAL.POT);
  circle(ctx, x + 5.5, y + 6.5, 3.4, PAL.LEAF_DARK);
  circle(ctx, x + 10.8, y + 5.8, 3.6, PAL.LEAF_DARK);
  circle(ctx, x + 8, y + 3.6, 4, PAL.LEAF);
  circle(ctx, x + 6, y + 8.6, 2.6, PAL.LEAF);
  circle(ctx, x + 10.6, y + 8.4, 2.4, PAL.LEAF);
}

// A window in the top wall: a band of daylight sky.
export function drawWindow(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const w = TILE * 2;
  roundRect(ctx, x, y + 2.5, w, 11, 2, PAL.WALL_TOP);
  const g = ctx.createLinearGradient(0, y + 3.5, 0, y + 12.5);
  g.addColorStop(0, PAL.SKY);
  g.addColorStop(1, PAL.SKY_LOW);
  ctx.beginPath();
  ctx.roundRect(x + 1.2, y + 3.7, w - 2.4, 8.6, 1.2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.fillStyle = PAL.WALL_TOP;
  ctx.fillRect(x + TILE - 0.6, y + 3.7, 1.2, 8.6);
}
