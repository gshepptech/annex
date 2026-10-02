// One office on the page: its nameplate, the canvas, and the text laid over it.

import type { WingView } from "../../server/api-types.ts";
import type { BourneEvent } from "../../server/events.ts";
import { sceneFromSnapshot, applyEvent, tick, type RoomScene } from "./office/scene.ts";
import { renderRoom, actorAt } from "./office/render.ts";
import { officeBadge } from "./sidebar.ts";
import { TILE } from "./office/sprites.ts";
import { h } from "./dom.ts";

const STAMP_MS = 1800;

export class Room {
  readonly el: HTMLElement;
  scene: RoomScene;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private overlay: HTMLElement;
  private sign: HTMLElement;
  private pill: HTMLElement;
  private stampEl: HTMLElement;
  private doorEl: HTMLElement;
  private bubbles = new Map<string, HTMLElement>();
  private names = new Map<string, HTMLElement>();
  private wing: WingView;

  private next: HTMLElement;
  private scale = 1;

  constructor(wing: WingView, lastEventId: number, onSelect: (id: string) => void, onAgent: (agentId: string) => void, arrivals: Set<string> = new Set()) {
    this.wing = wing;
    this.scene = sceneFromSnapshot(wing, lastEventId, arrivals);
    const { w, h: rows } = this.scene.layout;
    this.canvas = h("canvas", { width: w * TILE, height: rows * TILE, "aria-hidden": "true" });
    this.ctx = this.canvas.getContext("2d")!;
    // the backing store follows the room's size on screen, so shapes are drawn at full resolution
    new ResizeObserver(([entry]) => {
      const px = (entry?.contentRect.width ?? 0) * devicePixelRatio;
      if (px <= 0) return;
      this.scale = Math.min(8, px / (w * TILE));
      this.canvas.width = Math.round(w * TILE * this.scale);
      this.canvas.height = Math.round(rows * TILE * this.scale);
    }).observe(this.canvas);
    this.overlay = h("div", { class: "overlay" });
    this.stampEl = h("div", { class: "stamp", hidden: true });
    this.doorEl = h("div", { class: "door-sign", hidden: true });
    this.overlay.append(this.stampEl, this.doorEl);
    const { review, door } = this.scene.layout;
    this.stampEl.style.left = `${((review.at.x + 1) / w) * 100}%`;
    this.stampEl.style.top = `${((review.at.y + 0.5) / rows) * 100}%`;
    this.doorEl.style.left = `${((door.at.x + 0.5) / w) * 100}%`;
    this.doorEl.style.top = `${((door.at.y - 0.6) / rows) * 100}%`;
    this.sign = h("h2", {}, wing.name);
    this.pill = h("span", {});
    this.next = h("span", { class: "next" });
    this.el = h(
      "section",
      { class: "room box", "data-wing": wing.id },
      h(
        "button",
        { class: "plaque", type: "button", onclick: () => onSelect(wing.id), "aria-label": `Open ${wing.name}` },
        this.sign,
        this.pill,
        this.next,
      ),
      h("div", { class: "floor", style: `aspect-ratio: ${w} / ${rows}` }, this.canvas, this.overlay),
    );
    // clicking a person opens their terminal; clicking anywhere else opens the wing
    this.canvas.addEventListener("click", (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * this.scene.layout.w * TILE;
      const y = ((ev.clientY - r.top) / r.height) * this.scene.layout.h * TILE;
      const hit = actorAt(this.scene, x, y);
      if (hit) onAgent(hit.id);
      else onSelect(wing.id);
    });
    for (const a of this.scene.actors.values()) {
      const name = h("span", { class: `tag role-${a.role}` }, a.name);
      const bubble = h("span", { class: `bubble role-${a.role}`, hidden: true });
      this.names.set(a.id, name);
      this.bubbles.set(a.id, bubble);
      this.overlay.append(name, bubble);
    }
    this.update(wing);
  }

  // When the crew is unchanged a fresh snapshot only updates the labels, so animations already in
  // flight keep going. A changed crew needs a new Room.
  sameCrew(wing: WingView): boolean {
    return wing.agents.length === this.wing.agents.length && wing.agents.every((a, i) => a.id === this.wing.agents[i]?.id);
  }

  update(wing: WingView) {
    this.wing = wing;
    this.sign.textContent = wing.name;
    this.pill.replaceChildren(officeBadge(wing));
    this.el.classList.toggle("offline", wing.offline !== null);
    this.el.dataset.mode = wing.mode;
  }

  // The nameplate's right side: when the lead next wakes, counting down, or why it will not.
  private tickNext() {
    const n = this.wing.nextWake;
    const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    let text = "";
    let closed = false;
    // closed and paused are already on the badge and the door; the right side stays quiet
    if (this.wing.paused || this.wing.held) [text, closed] = ["", true];
    else if (this.wing.mode === "with_you") text = "Waiting for you";
    else if (n.blockedBy) text = n.blockedBy[0]!.toUpperCase() + n.blockedBy.slice(1);
    else if (n.at) {
      const s = Math.max(0, Math.round((new Date(n.at).getTime() - Date.now()) / 1000));
      text = s === 0 ? "Waking…" : `Next wake in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }
    if (this.next.textContent !== text) this.next.textContent = text;
    this.next.classList.toggle("closed", closed);
  }

  apply(e: BourneEvent, now: number) {
    applyEvent(this.scene, e, now);
  }

  frame(dt: number, now: number, reducedMotion: boolean) {
    tick(this.scene, dt, now);
    this.tickNext();
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    renderRoom(this.ctx, this.scene, now);
    const { w, h: rows } = this.scene.layout;
    for (const a of this.scene.actors.values()) {
      const left = `${((a.pos.x + 0.5) / w) * 100}%`;
      const name = this.names.get(a.id)!;
      name.style.left = left;
      name.style.top = `${((a.pos.y + 0.55) / rows) * 100}%`;
      const bubble = this.bubbles.get(a.id)!;
      if (a.bubble) {
        bubble.hidden = false;
        if (bubble.textContent !== a.bubble.text) bubble.textContent = a.bubble.text;
        bubble.style.left = left;
        bubble.style.top = `${((a.pos.y - 1.1) / rows) * 100}%`;
      } else {
        bubble.hidden = true;
      }
    }
    const s = this.scene.stamp;
    if (s && now - s.at < STAMP_MS) {
      this.stampEl.hidden = false;
      this.stampEl.textContent = s.text;
      this.stampEl.dataset.kind = s.text.toLowerCase();
      // the thump: lands large and settles, unless the person has asked for less motion
      const t = Math.min(1, (now - s.at) / 160);
      const scale = reducedMotion ? 1 : 1.9 - 0.9 * t;
      const fade = now - s.at > STAMP_MS - 400 ? (STAMP_MS - (now - s.at)) / 400 : 1;
      this.stampEl.style.transform = `translate(-50%, -50%) rotate(-9deg) scale(${scale})`;
      this.stampEl.style.opacity = String(fade);
    } else {
      this.stampEl.hidden = true;
    }
    this.doorEl.hidden = !this.scene.doorSign;
    if (this.scene.doorSign) this.doorEl.textContent = this.scene.doorSign;
  }
}
