// A person's mark for the roster and the terminal: their figure from the floor plan, seen from
// above, drawn at the screen's real resolution so it stays crisp.

import { drawPerson, lookFor } from "./office/sprites.ts";

export function portrait(role: "lead" | "worker" | "reviewer" | "director" | "you", index: number, size: number, className: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const px = Math.round(size * devicePixelRatio);
  c.width = px;
  c.height = px;
  c.className = className;
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  const ctx = c.getContext("2d")!;
  // the figure sits in a 16-unit cell centred on (8, 9); frame its 14 units
  const s = px / 14;
  ctx.setTransform(s, 0, 0, s, -1 * s, -2 * s);
  drawPerson(ctx, 0, 0, lookFor(role, index), "sit", 1);
  return c;
}

// One face per agent everywhere it appears: chosen by desk, which never changes while they stay.
export function faceIndex(a: { desk: number }): number {
  return a.desk < 0 ? 7 : a.desk;
}
