// Every sprite is drawn here from character maps and rectangles, so there are no image files and
// no art licences to track. One character is one pixel; the renderer scales the room up.
//
// The office is at night: navy tiles, a starry window, walnut desks, and colour that comes from
// people and work. A desk lamp throws a warm pool only while someone is working at it, and a
// monitor glows in its owner's role colour.

export const TILE = 16;

export const ROLE = { lead: "#FFB547", worker: "#38BDF8", reviewer: "#C084FC" } as const;
export const INK = "#0B0D1A";
export const FLOOR_A = "#1D2550";
export const FLOOR_B = "#1A2148";
export const FLOOR_LINE = "#232C5C";
export const WALL = "#0F1230";
export const WALL_TRIM = "#3B3F8F";
export const SKY = "#0A0E2E";
export const STAR = "#E0E7FF";
export const WOOD = "#8A5A3C";
export const WOOD_TOP = "#A8714C";
export const WOOD_DARK = "#5E3B27";
export const BEZEL = "#151935";
export const SCREEN_OFF = "#252A5A";
export const MANILA = "#FCD34D";
export const MANILA_DARK = "#D97706";
export const CABINET = "#3A4080";
export const CABINET_LIGHT = "#5158A8";
export const RUG = "#3B1E73";
export const RUG_EDGE = "#7C3AED";
export const LEAF = "#34D399";
export const LEAF_DARK = "#059669";
export const POT = "#EA580C";
export const GOOD = "#34D399";
export const BAD = "#FB7185";
export const WARN = "#FBBF24";

// Front-facing person. H hair, S skin, E eye, C jacket, W shirt or tie, P trousers, B shoes,
// V visor (reviewers only, drawn over the hair).
const PERSON_STAND = [
  "................",
  "......HHHH......",
  ".....HHHHHH.....",
  ".....HSSSSH.....",
  ".....SESSES.....",
  ".....SSSSSS.....",
  "......SSSS......",
  "....CCCWWCCC....",
  "...CCCCWWCCCC...",
  "...CCCCWWCCCC...",
  "...SCCCWWCCCS...",
  "...SCCCCCCCCS...",
  "....CCCCCCCC....",
  "....PPP..PPP....",
  "....PPP..PPP....",
  "....BBB..BBB....",
];

const PERSON_STEP = [
  ...PERSON_STAND.slice(0, 13),
  "....PPP...PPP...",
  "...PPP....PPP...",
  "...BBB.....BBB..",
];

// Seated: the lower body is hidden by the desk, the arms reach forward.
const PERSON_SIT = [
  ...PERSON_STAND.slice(0, 7),
  "....CCCWWCCC....",
  "...CCCCWWCCCC...",
  "..SCCCCWWCCCCS..",
  "..SSCCCCCCCCSS..",
  "....CCCCCCCC....",
  "................",
  "................",
  "................",
  "................",
];

const VISOR_ROW = ".....VVVVVVV....";

export interface Look {
  hair: string;
  skin: string;
  jacket: string;
  shirt: string;
  trousers: string;
  shoes: string;
  visor: string | null;
}

const SKINS = ["#F2C6A0", "#C68A62", "#8D5A3B", "#F6D7BD", "#A86F4C"];
const HAIRS = ["#2B2118", "#6B4A2E", "#C08A4F", "#16161D", "#9CA3AF"];

export function lookFor(role: keyof typeof ROLE | "director", index: number): Look {
  if (role === "director") return { hair: "#E5E7EB", skin: SKINS[0]!, jacket: "#BE123C", shirt: "#FFD84A", trousers: "#1E2246", shoes: "#0B0D1A", visor: null };
  const skin = SKINS[index % SKINS.length]!;
  const hair = HAIRS[(index * 3 + 1) % HAIRS.length]!;
  if (role === "lead") return { hair, skin, jacket: "#F59E0B", shirt: "#FFF7E6", trousers: "#1E2246", shoes: "#0B0D1A", visor: null };
  if (role === "reviewer") return { hair, skin, jacket: "#A855F7", shirt: "#F5F3FF", trousers: "#2A1E4A", shoes: "#0B0D1A", visor: "#34D399" };
  const shirts = ["#0EA5E9", "#22D3EE", "#3B82F6", "#06B6D4"];
  return { hair, skin, jacket: shirts[index % shirts.length]!, shirt: "#E0F2FE", trousers: "#1E2246", shoes: "#0B0D1A", visor: null };
}

export function drawPerson(ctx: CanvasRenderingContext2D, x: number, y: number, look: Look, pose: "stand" | "step" | "sit", facing: 1 | -1) {
  const map = pose === "sit" ? PERSON_SIT : pose === "step" ? PERSON_STEP : PERSON_STAND;
  const colours: Record<string, string> = {
    H: look.hair,
    S: look.skin,
    E: INK,
    C: look.jacket,
    W: look.shirt,
    P: look.trousers,
    B: look.shoes,
    V: look.visor ?? look.hair,
  };
  for (let row = 0; row < map.length; row++) {
    const line = look.visor && row === 2 ? VISOR_ROW : map[row]!;
    for (let col = 0; col < line.length; col++) {
      const ch = line[facing === 1 ? col : line.length - 1 - col]!;
      if (ch === ".") continue;
      ctx.fillStyle = colours[ch]!;
      ctx.fillRect(x + col, y + row, 1, 1);
    }
  }
}

export function drawFolder(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = MANILA_DARK;
  ctx.fillRect(x, y + 1, 4, 1);
  ctx.fillStyle = MANILA;
  ctx.fillRect(x, y + 2, 9, 6);
  ctx.fillStyle = MANILA_DARK;
  ctx.fillRect(x, y + 7, 9, 1);
  ctx.fillStyle = INK;
  ctx.fillRect(x + 2, y + 4, 5, 1);
}

// A desk with a monitor. `glow` is the screen colour while its owner works, null when idle.
export function drawDesk(ctx: CanvasRenderingContext2D, x: number, y: number, glow: string | null) {
  const w = TILE * 2;
  ctx.fillStyle = WOOD_DARK;
  ctx.fillRect(x, y + 5, w, 11);
  ctx.fillStyle = WOOD;
  ctx.fillRect(x, y + 3, w, 9);
  ctx.fillStyle = WOOD_TOP;
  ctx.fillRect(x, y + 3, w, 1);
  // legs
  ctx.fillStyle = WOOD_DARK;
  ctx.fillRect(x + 1, y + 12, 2, 4);
  ctx.fillRect(x + w - 3, y + 12, 2, 4);
  // monitor
  ctx.fillStyle = BEZEL;
  ctx.fillRect(x + 9, y - 6, 14, 10);
  ctx.fillStyle = glow ?? SCREEN_OFF;
  ctx.fillRect(x + 10, y - 5, 12, 7);
  if (glow) {
    // lines of text on the screen
    ctx.fillStyle = INK;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x + 11, y - 4, 7, 1);
    ctx.fillRect(x + 11, y - 2, 9, 1);
    ctx.fillRect(x + 11, y, 5, 1);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = BEZEL;
  ctx.fillRect(x + 15, y + 4, 2, 1);
}

export function drawCabinet(ctx: CanvasRenderingContext2D, x: number, y: number, filed: number) {
  ctx.fillStyle = CABINET;
  ctx.fillRect(x, y, TILE * 2, TILE * 2);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = CABINET_LIGHT;
    ctx.fillRect(x + 2, y + 2 + i * 7, TILE * 2 - 4, 6);
    ctx.fillStyle = CABINET;
    ctx.fillRect(x + TILE - 3, y + 4 + i * 7, 6, 1);
  }
  // a gold edge shows in the top drawer once anything has been filed, longer as more is filed
  if (filed > 0) {
    ctx.fillStyle = MANILA;
    ctx.fillRect(x + 4, y + 1, Math.min(24, 4 + filed * 3), 1);
  }
}

export function drawTable(ctx: CanvasRenderingContext2D, x: number, y: number) {
  // the rug the planning happens on
  ctx.fillStyle = RUG_EDGE;
  ctx.fillRect(x - 8, y - 4, TILE * 3 + 16, TILE * 2 + 12);
  ctx.fillStyle = RUG;
  ctx.fillRect(x - 6, y - 2, TILE * 3 + 12, TILE * 2 + 8);
  ctx.fillStyle = WOOD_DARK;
  ctx.fillRect(x, y + 4, TILE * 3, TILE * 2 - 4);
  ctx.fillStyle = WOOD;
  ctx.fillRect(x, y + 2, TILE * 3, TILE * 2 - 6);
  ctx.fillStyle = "#F8FAFC";
  ctx.fillRect(x + 8, y + 6, 10, 7);
  ctx.fillRect(x + 22, y + 8, 9, 7);
  ctx.fillStyle = "#6366F1";
  ctx.fillRect(x + 10, y + 8, 6, 1);
  ctx.fillRect(x + 10, y + 10, 4, 1);
  ctx.fillRect(x + 24, y + 10, 5, 1);
}

export function drawPlant(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = POT;
  ctx.fillRect(x + 4, y + 10, 8, 6);
  ctx.fillStyle = "#C2410C";
  ctx.fillRect(x + 4, y + 10, 8, 1);
  ctx.fillStyle = LEAF_DARK;
  ctx.fillRect(x + 3, y + 4, 4, 6);
  ctx.fillRect(x + 9, y + 3, 4, 7);
  ctx.fillStyle = LEAF;
  ctx.fillRect(x + 6, y, 4, 10);
  ctx.fillRect(x + 2, y + 5, 2, 2);
  ctx.fillRect(x + 12, y + 4, 2, 2);
}

// A window in the top wall: night sky with a few fixed stars.
export function drawWindow(ctx: CanvasRenderingContext2D, x: number, y: number, seed: number) {
  ctx.fillStyle = WALL_TRIM;
  ctx.fillRect(x, y + 2, TILE * 2, 11);
  ctx.fillStyle = SKY;
  ctx.fillRect(x + 1, y + 3, TILE * 2 - 2, 9);
  ctx.fillStyle = WALL_TRIM;
  ctx.fillRect(x + TILE - 1, y + 3, 1, 9);
  ctx.fillStyle = STAR;
  for (let i = 0; i < 4; i++) {
    const sx = (seed * 7 + i * 11) % (TILE * 2 - 4);
    const sy = (seed * 3 + i * 5) % 7;
    ctx.fillRect(x + 2 + sx, y + 4 + sy, 1, 1);
  }
}
