import "@fontsource/stardos-stencil/400.css";
import "@fontsource/stardos-stencil/700.css";
import "@fontsource/courier-prime/400.css";
import "@fontsource/courier-prime/700.css";
import "@fontsource/archivo-narrow/400.css";
import "@fontsource/archivo-narrow/600.css";
import "./styles.css";

import type { StateView } from "../../server/api-types.ts";
import type { BourneEvent } from "../../server/events.ts";
import { getState, stream } from "./api.ts";
import { Room } from "./room.ts";
import { Panel } from "./panel.ts";
import { h } from "./dom.ts";

const app = document.getElementById("app")!;
const rooms = new Map<string, Room>();
const building = h("main", { class: "building", "aria-label": "Wings" });
const status = h("p", { class: "status", role: "status" }, "Connecting...");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let state: StateView | null = null;
let selected: string | null = null;
let recent: BourneEvent[] = [];
const panel = new Panel(() => scheduleRefresh(0));

app.append(
  h("header", { class: "top" }, h("h1", { class: "wordmark" }, "Annex"), status),
  h("div", { class: "layout" }, building, panel.el),
);

function select(id: string, fromTap = false) {
  selected = id;
  // on a phone the case file sits below the rooms, so bring it into view
  if (fromTap && matchMedia("(max-width: 960px)").matches) requestAnimationFrame(() => panel.el.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth" }));
  for (const [wid, r] of rooms) r.el.classList.toggle("selected", wid === id);
  const w = state?.wings.find((x) => x.id === id);
  if (w) panel.show(w, recent);
}

function applyState(next: StateView) {
  state = next;
  for (const w of next.wings) {
    const existing = rooms.get(w.id);
    if (existing && existing.sameCrew(w)) {
      existing.update(w);
    } else {
      const room = new Room(w, existing?.scene.lastEventId ?? next.lastEventId, (id) => select(id, true));
      if (existing) existing.el.replaceWith(room.el);
      else building.append(room.el);
      rooms.set(w.id, room);
    }
  }
  if (!selected && next.wings[0]) selected = next.wings[0].id;
  if (selected) select(selected);
  const held = next.wings.filter((w) => w.held);
  status.textContent = held.length
    ? `Held: ${held[0]!.held!.reason}`
    : `${next.wings.length} wings · ${next.wings.filter((w) => w.mode === "autonomous").length} on their own`;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh(ms = 400) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      applyState(await getState());
    } catch (err) {
      status.textContent = (err as Error).message;
    }
  }, ms);
}

// Events that change what the labels and the panel show; movement itself comes from the event.
const REFRESH_ON = new Set(["task.created", "task.done", "task.stopped", "wing.mode_changed", "wing.held", "wing.resumed", "chat.message", "approval.requested", "approval.decided"]);

async function boot() {
  try {
    const first = await getState();
    recent = first.recent;
    applyState(first);
    stream(
      first.lastEventId,
      (e) => {
        recent.push(e);
        if (recent.length > 1000) recent = recent.slice(-1000);
        rooms.get(e.wingId)?.apply(e, performance.now());
        panel.push(e);
        if (REFRESH_ON.has(e.kind)) scheduleRefresh();
      },
      (connected) => {
        if (!connected) status.textContent = "Lost the connection to Annex. Reconnecting...";
        else if (state) applyState(state);
      },
    );
  } catch (err) {
    status.textContent = `${(err as Error).message}. Is \`npm start\` running?`;
    setTimeout(boot, 3000);
    return;
  }
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(100, now - last);
    last = now;
    for (const r of rooms.values()) r.frame(dt, now, reducedMotion.matches);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
