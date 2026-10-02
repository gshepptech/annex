// Every sprite is drawn here from character maps, so there are no image files and no art licences
// to track. One character is one pixel; the renderer scales the whole room by a whole number.

export const TILE = 16;

export const INK = "#23304F";
export const FLOOR_A = "#59654F";
export const FLOOR_B = "#55614B";
export const WALL = "#3A4436";
export const WALL_TOP = "#6F7A68";
export const STEEL = "#8C9599";
export const STEEL_DARK = "#646D71";
export const STEEL_LIGHT = "#B4BCBF";
export const MANILA = "#DDBF6C";
export const MANILA_DARK = "#B99B4E";
export const STAMP = "#B3302A";
export const LAMP = "#F2D27A";
export const WOOD = "#7A5A3C";
export const WOOD_DARK = "#5C4330";

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

const SKINS = ["#E8B894", "#C68A62", "#8D5A3B", "#F1CDB0", "#A86F4C"];
const HAIRS = ["#2B2118", "#6B4A2E", "#A07B4F", "#1B1B1F", "#8E8E8A"];

export function lookFor(role: "lead" | "worker" | "reviewer", index: number): Look {
  const skin = SKINS[index % SKINS.length]!;
  const hair = HAIRS[(index * 3 + 1) % HAIRS.length]!;
  if (role === "lead") {
    return { hair, skin, jacket: "#2E3440", shirt: STAMP, trousers: "#262B35", shoes: "#141414", visor: null };
  }
  if (role === "reviewer") {
    return { hair, skin, jacket: "#6E6A4F", shirt: "#E9E4D2", trousers: "#3F3C2E", shoes: "#141414", visor: "#2F7A55" };
  }
  const shirts = ["#A9B8C9", "#C9B8A0", "#B5C4B0", "#C4AFC0"];
  return { hair, skin, jacket: shirts[index % shirts.length]!, shirt: INK, trousers: "#3B4256", shoes: "#141414", visor: null };
}

export function drawPerson(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  look: Look,
  pose: "stand" | "step" | "sit",
  facing: 1 | -1,
) {
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

export function drawDesk(ctx: CanvasRenderingContext2D, x: number, y: number, lampOn: boolean) {
  const w = TILE * 2;
  ctx.fillStyle = STEEL_DARK;
  ctx.fillRect(x, y + 4, w, 12);
  ctx.fillStyle = STEEL;
  ctx.fillRect(x, y + 2, w, 10);
  ctx.fillStyle = STEEL_LIGHT;
  ctx.fillRect(x, y + 2, w, 1);
  // drawer handles
  ctx.fillStyle = STEEL_DARK;
  ctx.fillRect(x + 3, y + 13, 4, 1);
  ctx.fillRect(x + w - 7, y + 13, 4, 1);
  // lamp
  ctx.fillStyle = INK;
  ctx.fillRect(x + w - 6, y, 1, 4);
  ctx.fillStyle = lampOn ? LAMP : STEEL_DARK;
  ctx.fillRect(x + w - 9, y - 1, 6, 2);
}

export function drawCabinet(ctx: CanvasRenderingContext2D, x: number, y: number, filed: number) {
  ctx.fillStyle = STEEL_DARK;
  ctx.fillRect(x, y, TILE * 2, TILE * 2);
  ctx.fillStyle = STEEL;
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(x + 2, y + 2 + i * 7, TILE * 2 - 4, 6);
    ctx.fillStyle = STEEL_LIGHT;
    ctx.fillRect(x + TILE - 3, y + 4 + i * 7, 6, 1);
    ctx.fillStyle = STEEL;
  }
  // a manila edge shows in the top drawer once anything has been filed
  if (filed > 0) {
    ctx.fillStyle = MANILA;
    ctx.fillRect(x + 4, y + 1, Math.min(24, 4 + filed * 2), 1);
  }
}

export function drawTable(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = WOOD_DARK;
  ctx.fillRect(x, y + 4, TILE * 3, TILE * 2 - 4);
  ctx.fillStyle = WOOD;
  ctx.fillRect(x, y + 2, TILE * 3, TILE * 2 - 6);
  // papers spread on the table: the plan being worked out
  ctx.fillStyle = "#E9E4D2";
  ctx.fillRect(x + 8, y + 6, 10, 7);
  ctx.fillRect(x + 22, y + 8, 9, 7);
  ctx.fillStyle = INK;
  ctx.fillRect(x + 10, y + 8, 6, 1);
  ctx.fillRect(x + 10, y + 10, 4, 1);
  ctx.fillRect(x + 24, y + 10, 5, 1);
}
