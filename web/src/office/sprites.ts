// The office drawn the way offices are drawn: as a floor plan, seen from above. Walls are solid
// poché, doors are swing arcs, furniture is outlined, and people are the only filled colour.
// The palette follows Linear's: dark is charcoal on near-black with gray hairlines, light is gray
// on white, and colour is left to the people and the lights. Coordinates are in
// room units (TILE per tile); the renderer scales the canvas to the screen's real resolution.

export const TILE = 16;

export const ROLE = { lead: "#F2994A", worker: "#4EA7FC", reviewer: "#BB87FC" } as const;
export const GOOD = "#4CB782";
export const BAD = "#EB5757";
export const WARN = "#F2C94C";

// The room's colours for each theme. `PAL` is the one in use; setRoomTheme swaps it in place.
const LIGHT = {
  GROUND: "#FFFFFF",
  GRID: "rgba(31,32,35,0.045)",
  WALL: "#C9CBD1",
  LINE: "#A9ACB4",
  FAINT: "rgba(31,32,35,0.22)",
  FILL: "#F4F5F7",
  SCREEN_OFF: "#D6D8DD",
  FILE: "#F2C94C",
  SHADE: "rgba(31,32,35,0.08)",
  DIM: "rgba(255,255,255,0.6)",
  GLOW: "0.16",
  RING: "#FFFFFF",
};

const DARK: typeof LIGHT = {
  GROUND: "#131416",
  GRID: "rgba(247,248,248,0.035)",
  WALL: "#3E3E44",
  LINE: "#4A4B52",
  FAINT: "rgba(208,214,224,0.22)",
  FILL: "#1A1B1E",
  SCREEN_OFF: "#26272B",
  FILE: "#F2C94C",
  SHADE: "rgba(0,0,0,0.35)",
  DIM: "rgba(8,9,10,0.6)",
  GLOW: "0.22",
  RING: "#0F1011",
};

export const PAL = { ...DARK };

export function setRoomTheme(theme: "light" | "dark") {
  Object.assign(PAL, theme === "light" ? LIGHT : DARK);
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

function outline(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 0.8, width = 0.7) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = PAL.FILL;
  ctx.fill();
  ctx.lineWidth = width;
  ctx.strokeStyle = PAL.LINE;
  ctx.stroke();
}

function circle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string | null, stroke: string | null = null, width = 0.6) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.lineWidth = width;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

export interface Look {
  skin: string;
  hair: string;
  body: string;
  visor: string | null;
}

const SKINS = ["#F2C6A0", "#C68A62", "#8D5A3B", "#F6D7BD", "#A86F4C"];
const HAIRS = ["#2B2118", "#6B4A2E", "#C08A4F", "#16161D", "#9CA3AF"];

export function lookFor(role: keyof typeof ROLE | "director" | "you", index: number): Look {
  const skin = SKINS[index % SKINS.length]!;
  const hair = HAIRS[(index * 3 + 1) % HAIRS.length]!;
  if (role === "director") return { skin: SKINS[0]!, hair: "#D9DEE2", body: BAD, visor: null };
  if (role === "you") return { skin, hair, body: "#F4F6F7", visor: null };
  return { skin, hair, body: ROLE[role], visor: role === "reviewer" ? GOOD : null };
}

// A person seen from above, centred in a 16x16 cell whose top-left is (x, y): shoulders in their
// role colour, the head on top, hair toward the back. A step swings the shoulders a little.
export function drawPerson(ctx: CanvasRenderingContext2D, x: number, y: number, look: Look, pose: "stand" | "step" | "sit", facing: 1 | -1) {
  const cx = x + 8;
  const cy = y + 9;
  const swing = pose === "step" ? 0.2 * facing : 0;
  circle(ctx, cx + 0.6, cy + 1.2, 5.6, PAL.SHADE);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(swing);
  ctx.beginPath();
  ctx.ellipse(0, 0, 5.8, 3.8, 0, 0, Math.PI * 2);
  ctx.fillStyle = look.body;
  ctx.fill();
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = PAL.RING;
  ctx.stroke();
  ctx.restore();
  // from above a head is mostly hair; the face shows as a sliver toward where they look
  circle(ctx, cx, cy - 0.2, 3.1, look.hair, PAL.RING, 0.5);
  ctx.beginPath();
  ctx.ellipse(cx, cy + 1.3, 2.3, 1.3, 0, 0, Math.PI);
  ctx.fillStyle = look.skin;
  ctx.fill();
  if (look.visor) roundRect(ctx, cx - 2.4, cy + 0.6, 4.8, 1, 0.5, look.visor);
}

export function drawFolder(ctx: CanvasRenderingContext2D, x: number, y: number) {
  roundRect(ctx, x, y + 2, 8, 5.5, 0.6, PAL.FILE);
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = PAL.RING;
  ctx.strokeRect(x, y + 2, 8, 5.5);
}

// A desk in plan: the top outlined, a monitor along its back edge that fills with the owner's
// colour while they work, and the chair they sit in.
export function drawDesk(ctx: CanvasRenderingContext2D, x: number, y: number, glow: string | null) {
  const w = TILE * 2;
  circle(ctx, x + TILE, y + 17, 3.8, PAL.FILL, PAL.FAINT, 0.6);
  outline(ctx, x + 1, y + 1, w - 2, 12, 0.8, 0.8);
  ctx.fillStyle = glow ?? PAL.SCREEN_OFF;
  ctx.fillRect(x + 9, y + 2.5, 14, 2.2);
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = PAL.LINE;
  ctx.strokeRect(x + 9, y + 2.5, 14, 2.2);
  ctx.strokeStyle = PAL.FAINT;
  ctx.strokeRect(x + 11, y + 7, 10, 2.4);
}

export function drawCabinet(ctx: CanvasRenderingContext2D, x: number, y: number, filed: number) {
  const w = TILE * 2;
  outline(ctx, x + 1, y + 1, w - 2, TILE * 2 - 2, 0.8, 0.8);
  // storage, in plan: the diagonal
  ctx.beginPath();
  ctx.moveTo(x + 1, y + 1);
  ctx.lineTo(x + w - 1, y + TILE * 2 - 1);
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = PAL.FAINT;
  ctx.stroke();
  // a gold edge grows along the top as work is filed
  if (filed > 0) roundRect(ctx, x + 3, y + 2.5, Math.min(w - 6, 3 + filed * 2.5), 1.6, 0.8, PAL.FILE);
}

export function drawTable(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const w = TILE * 3;
  const h = TILE * 2 - 4;
  for (const [cx, cy] of [[x + 10, y - 2], [x + 24, y - 2], [x + 38, y - 2], [x + 10, y + h + 4], [x + 24, y + h + 4], [x + 38, y + h + 4]] as const) {
    circle(ctx, cx, cy, 3.4, PAL.FILL, PAL.FAINT, 0.6);
  }
  outline(ctx, x, y + 1, w, h, 5, 0.8);
  // the plan being worked out on it
  ctx.strokeStyle = PAL.FAINT;
  ctx.lineWidth = 0.5;
  ctx.strokeRect(x + 9, y + 6, 11, 8);
  ctx.strokeRect(x + 25, y + 7, 11, 8);
}

// A tree in plan: a canopy circle with smaller crowns inside.
export function drawPlant(ctx: CanvasRenderingContext2D, x: number, y: number) {
  circle(ctx, x + 8, y + 8, 6.2, PAL.FILL, PAL.LINE, 0.6);
  for (const [dx, dy] of [[-2.2, -1.6], [2.4, -1.2], [0, 2.6]] as const) circle(ctx, x + 8 + dx, y + 8 + dy, 2.2, null, PAL.FAINT, 0.5);
}

// A window in the top wall: three thin lines, the way a plan draws glazing.
export function drawWindow(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const w = TILE * 2;
  ctx.fillStyle = PAL.GROUND;
  ctx.fillRect(x, y + TILE - 5, w, 5);
  ctx.strokeStyle = PAL.LINE;
  ctx.lineWidth = 0.5;
  for (const dy of [TILE - 5, TILE - 2.5, TILE]) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy);
    ctx.lineTo(x + w, y + dy);
    ctx.stroke();
  }
}

// The door in the bottom wall: an opening with the leaf drawn open and its swing as a quarter arc.
// A closed office draws it shut, in red.
export function drawDoor(ctx: CanvasRenderingContext2D, x: number, y: number, closed: boolean) {
  ctx.fillStyle = PAL.GROUND;
  ctx.fillRect(x, y - 0.5, TILE, 5.5);
  ctx.strokeStyle = closed ? BAD : PAL.LINE;
  ctx.beginPath();
  if (closed) {
    ctx.lineWidth = 1.4;
    ctx.moveTo(x, y + 2);
    ctx.lineTo(x + TILE, y + 2);
    ctx.stroke();
    return;
  }
  ctx.lineWidth = 0.8;
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - TILE + 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.lineWidth = 0.5;
  ctx.setLineDash([1.2, 1.2]);
  ctx.arc(x, y, TILE - 2, -Math.PI / 2, 0);
  ctx.stroke();
  ctx.setLineDash([]);
}
