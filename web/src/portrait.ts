// A character's face for the roster and the terminal: the top of their sprite, drawn at a
// whole-number scale on a small canvas so it stays crisp.

import { drawPerson, lookFor } from "./office/sprites.ts";

export function portrait(role: "lead" | "worker" | "reviewer", index: number, size: number, className: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 12;
  c.height = 12;
  c.className = className;
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  // the sprite is 16 wide with the head in rows 1-11; shift it so the face fills the frame
  drawPerson(ctx, -2, 0, lookFor(role, index), "stand", 1);
  return c;
}

// One face per agent everywhere it appears: chosen by desk, which never changes while they stay.
export function faceIndex(a: { desk: number }): number {
  return a.desk < 0 ? 7 : a.desk;
}
