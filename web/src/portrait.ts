// A character's face for the roster and the terminal: the head and shoulders of their figure in a
// round frame, drawn at the screen's real resolution so it stays crisp.

import { drawPerson, lookFor } from "./office/sprites.ts";

export function portrait(role: "lead" | "worker" | "reviewer" | "director", index: number, size: number, className: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const px = Math.round(size * devicePixelRatio);
  c.width = px;
  c.height = px;
  c.className = className;
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  const ctx = c.getContext("2d")!;
  // the figure is 16 units wide with the head and shoulders in rows 0-12; frame those
  const s = px / 11;
  ctx.setTransform(s, 0, 0, s, -2.5 * s, 0.2 * s);
  drawPerson(ctx, 0, 0, lookFor(role, index), "sit", 1);
  return c;
}

// One face per agent everywhere it appears: chosen by desk, which never changes while they stay.
export function faceIndex(a: { desk: number }): number {
  return a.desk < 0 ? 7 : a.desk;
}
