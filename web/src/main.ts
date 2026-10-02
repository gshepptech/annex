import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

import type { StateView } from "../../server/api-types.ts";
import type { BourneEvent } from "../../server/events.ts";
import { getState, stream } from "./api.ts";
import { Room } from "./room.ts";
import { Panel } from "./panel.ts";
import { Sidebar } from "./sidebar.ts";
import { Terminal } from "./terminal.ts";
import { newWingDialog } from "./newwing.ts";
import { h } from "./dom.ts";

const app = document.getElementById("app")!;
const rooms = new Map<string, Room>();
const building = h("main", { class: "building", "aria-label": "Wings" });
const drawer = h("aside", { class: "drawer" });
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

let state: StateView | null = null;
let selectedWing: string | null = null;
let selectedAgent: string | null = null;
let recent: BourneEvent[] = [];

const panel = new Panel(() => scheduleRefresh(0));
const terminal = new Terminal(
  () => selectWing(selectedWing ?? state?.wings[0]?.id ?? ""),
  (id) => state?.wings.find((w) => w.id === id)?.name ?? "Back",
);
const sidebar = new Sidebar({
  wing: (id) => selectWing(id, true),
  agent: (id) => selectAgent(id, true),
  newWing: () => dialog.showModal(),
});
const dialog = newWingDialog((id) => {
  selectedWing = id;
  scheduleRefresh(0);
});

app.append(h("div", { class: "shell" }, sidebar.el, building, drawer), dialog);

// on narrow screens the drawer sits below the rooms, so bring it into view when chosen
function reveal(fromTap: boolean) {
  if (fromTap && matchMedia("(max-width: 1280px)").matches) requestAnimationFrame(() => drawer.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth" }));
}

function selectWing(id: string, fromTap = false) {
  selectedWing = id;
  selectedAgent = null;
  terminal.close();
  draw();
  reveal(fromTap);
}

function selectAgent(id: string, fromTap = false) {
  const wing = state?.wings.find((w) => w.agents.some((a) => a.id === id));
  if (!wing) return;
  selectedWing = wing.id;
  selectedAgent = id;
  terminal.open(id);
  draw();
  reveal(fromTap);
}

function draw() {
  if (!state) return;
  for (const [wid, r] of rooms) r.el.classList.toggle("selected", wid === selectedWing);
  sidebar.render(state, selectedWing, selectedAgent);
  if (selectedAgent) {
    if (drawer.firstChild !== terminal.el) drawer.replaceChildren(terminal.el);
  } else {
    const w = state.wings.find((x) => x.id === selectedWing);
    if (w) panel.show(w, recent);
    if (drawer.firstChild !== panel.el) drawer.replaceChildren(panel.el);
  }
}

function applyState(next: StateView) {
  state = next;
  for (const w of next.wings) {
    const existing = rooms.get(w.id);
    if (existing && existing.sameCrew(w)) {
      existing.update(w);
    } else {
      const room = new Room(w, existing?.scene.lastEventId ?? next.lastEventId, (id) => selectWing(id, true), (id) => selectAgent(id, true));
      if (existing) existing.el.replaceWith(room.el);
      else building.append(room.el);
      rooms.set(w.id, room);
    }
  }
  if (!selectedWing || !next.wings.some((w) => w.id === selectedWing)) selectedWing = next.wings[0]?.id ?? null;
  const held = next.wings.find((w) => w.held && !w.paused);
  const own = next.wings.filter((w) => w.mode === "autonomous").length;
  const working = next.wings.flatMap((w) => w.agents).filter((a) => a.status === "running").length;
  if (held) {
    const until = held.held!.until ? new Date(held.held!.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
    sidebar.setStatus(`Held${until ? ` until ${until}` : ""}: ${held.held!.reason}`, true);
  } else {
    sidebar.setStatus(`${next.wings.length} wings · ${own} on their own · ${working} working`);
  }
  draw();
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh(ms = 400) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      applyState(await getState());
    } catch (err) {
      sidebar.setStatus((err as Error).message, true);
    }
  }, ms);
}

// Events that change what the labels, the sidebar and the case file show; movement itself comes
// from the event.
const REFRESH_ON = new Set(["task.created", "task.started", "task.done", "task.stopped", "wing.mode_changed", "wing.held", "wing.resumed", "chat.message", "approval.requested", "approval.decided", "lead.woke", "lead.idle", "agent.said"]);

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
        if (selectedAgent && e.actor === selectedAgent) terminal.poke();
        if (REFRESH_ON.has(e.kind)) scheduleRefresh();
      },
      (connected) => {
        if (!connected) sidebar.setStatus("Lost the connection to Annex. Reconnecting...", true);
        else scheduleRefresh(0);
      },
    );
  } catch (err) {
    sidebar.setStatus(`${(err as Error).message}. Is \`npm start\` running?`, true);
    setTimeout(boot, 3000);
    return;
  }
  // agent status (working or idle) comes from Paperclip, so it is re-read now and then
  setInterval(() => scheduleRefresh(0), 10_000);
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
