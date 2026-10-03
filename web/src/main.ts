import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

import type { StateView, WingView, SessionView } from "../../server/api-types.ts";
import type { BourneEvent } from "../../server/events.ts";
import { getState, getSessions, stream } from "./api.ts";
import { Room } from "./room.ts";
import { Panel } from "./panel.ts";
import { Sidebar } from "./sidebar.ts";
import { Terminal } from "./terminal.ts";
import { newWingDialog } from "./newwing.ts";
import { logDialog } from "./syslog.ts";
import { DirectorDesk } from "./directorview.ts";
import { h } from "./dom.ts";
import { portrait } from "./portrait.ts";
import { setRoomTheme } from "./office/sprites.ts";

const app = document.getElementById("app")!;
const rooms = new Map<string, Room>();
const world = h("main", { class: "world", "aria-label": "Offices" });
const drawer = h("aside", { class: "drawer box" });
const toasts = h("div", { class: "toasts", "aria-live": "polite" });
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

let state: StateView | null = null;
let selectedWing: string | null = null;
let selectedAgent: string | null = null;
let showDirector = false;
let sessions: SessionView[] = [];
let deskRoom: Room | null = null;
const DESK = "your-desk";
let recent: BourneEvent[] = [];
// agents hired since the last snapshot: their room is rebuilt and they walk in from the door
const arriving = new Set<string>();

const panel = new Panel(() => scheduleRefresh(0));
const terminal = new Terminal(
  () => selectWing(selectedWing ?? state?.wings[0]?.id ?? ""),
  (id) => state?.wings.find((w) => w.id === id)?.name ?? "Back",
);
const sidebar = new Sidebar({
  wing: (id) => selectWing(id, true),
  agent: (id) => selectAgent(id, true),
  newWing: () => newOffice.showModal(),
  session: (id) => selectSession(id, true),
});
const newOffice = newWingDialog((id) => {
  selectedWing = id;
  scheduleRefresh(0);
});
const syslog = logDialog();
const director = new DirectorDesk(() => selectWing(selectedWing ?? state?.wings[0]?.id ?? ""), () => scheduleRefresh(0));

// Dark by default; the choice is kept in this browser only.
type Theme = "light" | "dark";
let theme: Theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
setRoomTheme(theme);
const themeBtn = h("button", { class: "hud-btn", type: "button", onclick: () => flipTheme() });
function flipTheme() {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  setRoomTheme(theme);
  try {
    localStorage.setItem("annex-theme", theme);
  } catch {
    // private windows can refuse storage; the switch still works for this visit
  }
  labelTheme();
}
function labelTheme() {
  themeBtn.textContent = theme === "dark" ? "Light mode" : "Dark mode";
}
labelTheme();

// the HUD: the game's top bar
const stats = h("div", { class: "stats" });
const openState = h("span", { class: "state", role: "status" }, "Connecting…");
const hud = h(
  "header",
  { class: "hud box" },
  h("h1", { class: "logo" }, "Annex"),
  stats,
  openState,
  h("button", { class: "hud-btn director-btn", type: "button", onclick: () => openDirector() }, portrait("director", 0, 26, ""), "Director"),
  h("button", { class: "hud-btn", type: "button", onclick: () => syslog.open() }, "System log"),
  themeBtn,
);

app.append(h("div", { class: "shell" }, hud, sidebar.el, world, drawer), toasts, newOffice, syslog.el);

function toast(text: string, colour: string) {
  const t = h("div", { class: "toast", style: `--c: ${colour}` }, text);
  toasts.append(t);
  setTimeout(() => t.remove(), 4200);
  while (toasts.childElementCount > 4) toasts.firstElementChild?.remove();
}

// on narrow screens the dialog sits below the offices, so bring it into view when chosen
function reveal(fromTap: boolean) {
  if (fromTap && matchMedia("(max-width: 1300px)").matches) requestAnimationFrame(() => drawer.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth" }));
}

function openDirector() {
  showDirector = true;
  selectedAgent = null;
  terminal.close();
  draw();
  reveal(true);
}

function selectWing(id: string, fromTap = false) {
  selectedWing = id;
  selectedAgent = null;
  showDirector = false;
  terminal.close();
  draw();
  reveal(fromTap);
}

function selectSession(id: string, fromTap = false) {
  selectedAgent = id;
  showDirector = false;
  terminal.openSession(id);
  draw();
  reveal(fromTap);
}

// Your sessions drawn as a room: one figure per session, at work while its session is.
function deskWing(list: SessionView[]): WingView {
  return {
    id: DESK, name: "Your desk", mode: "with_you", charter: "", repo: null, integrationBranch: null, held: null, offline: null,
    agents: list.map((s, i) => ({ id: s.id, role: "worker" as const, name: s.title, desk: i + 1, status: s.status === "working" ? "running" : "idle", model: s.model ?? "", filed: 0 })),
    tasks: [], goals: [], filedCount: 0, brief: null, draft: null, chat: [], asks: [], paused: false, houseRules: [],
    settings: { wakeEvery: "", maxRunsPerHour: null, quietHours: null, backOffWhenIdle: false, askBefore: [], maxWorkers: 8, maxTasksPerWake: 0, checkAttempts: 0, checkTimeout: "", wakeTimeout: "", maxBackoff: "" },
    edit: { name: "", charter: "", doneCheck: null, setup: null, repoPath: null, baseBranch: "", workers: 0, leadModel: "", workerModel: "", reviewerModel: "", allow: [], plugins: [] },
    nextWake: { at: null, blockedBy: null },
    loot: { commits: [], command: null },
  };
}

function applySessions(list: SessionView[]) {
  sessions = list;
  if (!list.length) {
    deskRoom?.el.remove();
    deskRoom = null;
  } else {
    const w = deskWing(list);
    if (deskRoom && deskRoom.sameCrew(w)) {
      deskRoom.update(w);
    } else {
      const room = new Room(w, 0, () => undefined, (id) => selectSession(id, true), new Set(), "desk");
      if (deskRoom) deskRoom.el.replaceWith(room.el);
      else world.prepend(room.el);
      deskRoom = room;
    }
  }
  draw();
}

async function pollSessions() {
  try {
    applySessions(await getSessions());
  } catch {
    // the offices still work without it; try again next time
  }
}

function selectAgent(id: string, fromTap = false) {
  if (sessions.some((s) => s.id === id)) return selectSession(id, fromTap);
  const wing = state?.wings.find((w) => w.agents.some((a) => a.id === id));
  if (!wing) return;
  selectedWing = wing.id;
  selectedAgent = id;
  showDirector = false;
  terminal.open(id);
  draw();
  reveal(fromTap);
}

function draw() {
  if (!state) return;
  for (const [wid, r] of rooms) r.el.classList.toggle("selected", !showDirector && wid === selectedWing);
  sidebar.render(state, showDirector ? null : selectedWing, selectedAgent, sessions);
  if (showDirector) {
    director.show(state.director);
    if (drawer.firstChild !== director.el) drawer.replaceChildren(director.el);
  } else if (selectedAgent && (terminal.agentId || terminal.sessionId)) {
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
      const arrivals = new Set(w.agents.filter((a) => arriving.has(a.id)).map((a) => a.id));
      for (const id of arrivals) arriving.delete(id);
      const room = new Room(w, existing?.scene.lastEventId ?? next.lastEventId, (id) => selectWing(id, true), (id) => selectAgent(id, true), arrivals);
      if (existing) existing.el.replaceWith(room.el);
      else world.append(room.el);
      rooms.set(w.id, room);
    }
  }
  if (!selectedWing || !next.wings.some((w) => w.id === selectedWing)) selectedWing = next.wings[0]?.id ?? null;

  const crew = next.wings.flatMap((w) => w.agents);
  const working = crew.filter((a) => a.status === "running").length;
  const filed = next.wings.reduce((n, w) => n + w.filedCount, 0);
  const quests = next.wings.reduce((n, w) => n + w.asks.length, 0);
  stats.replaceChildren(
    h("span", {}, "Offices", h("b", {}, String(next.wings.length))),
    h("span", {}, "Crew", h("b", {}, String(crew.length))),
    h("span", {}, "Working", h("b", {}, String(working))),
    h("span", {}, "Verified", h("b", {}, String(filed))),
  );
  if (quests) stats.append(h("span", { class: "asks" }, "Asks", h("b", {}, String(quests))));
  const held = next.wings.find((w) => w.held && !w.paused);
  if (held?.held) {
    const until = held.held.until ? new Date(held.held.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
    openState.textContent = `Closed${until ? ` until ${until}` : ""}`;
    openState.title = held.held.reason;
    openState.classList.add("closed");
  } else {
    openState.textContent = working ? `${working} at work` : "Open";
    openState.title = "";
    openState.classList.remove("closed");
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
      openState.textContent = "No connection";
      openState.title = (err as Error).message;
    }
  }, ms);
}

// Real events become game notifications; nothing is announced that did not happen.
function announce(e: BourneEvent) {
  if (e.wingId === "director") {
    if (e.kind === "chat.message" && e.payload.who === "lead" && !showDirector) toast("The director replied", "var(--annex)");
    return;
  }
  const wing = state?.wings.find((w) => w.id === e.wingId);
  const office = wing?.name ?? "";
  const title = String(e.payload.title ?? "").slice(0, 48);
  if (e.kind === "task.done") toast(`Verified · ${office} · ${title}`, "var(--ok)");
  if (e.kind === "task.stopped") toast(`Stopped · ${office} · ${title}`, "var(--bad)");
  if (e.kind === "agent.hired") toast(`${String(e.payload.name ?? "")} joined ${office}`, "var(--worker)");
  if (e.kind === "approval.requested") toast(`${office} asks · ${String(e.payload.title ?? "").slice(0, 48)}`, "var(--ask)");
  if (e.kind === "wing.held") toast(`${office} closed${e.payload.reason ? ` · ${String(e.payload.reason)}` : ""}`, "var(--warn)");
  if (e.kind === "wing.resumed") toast(`${office} is open again`, "var(--ok)");
}

const REFRESH_ON = new Set(["task.created", "task.started", "task.done", "task.stopped", "wing.mode_changed", "wing.held", "wing.resumed", "chat.message", "approval.requested", "approval.decided", "lead.woke", "lead.idle", "agent.said", "agent.hired"]);

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
        if (e.kind === "agent.hired" && typeof e.payload.agentId === "string") arriving.add(e.payload.agentId);
        rooms.get(e.wingId)?.apply(e, performance.now());
        panel.push(e);
        announce(e);
        if (selectedAgent && e.actor === selectedAgent) terminal.poke();
        if (REFRESH_ON.has(e.kind)) scheduleRefresh();
      },
      (connected) => {
        if (!connected) {
          openState.textContent = "Reconnecting…";
          openState.classList.add("closed");
        } else {
          scheduleRefresh(0);
        }
      },
    );
  } catch (err) {
    openState.textContent = "No connection";
    openState.title = `${(err as Error).message}. Is \`npm start\` running?`;
    setTimeout(boot, 3000);
    return;
  }
  // working or idle comes from Paperclip, so it is re-read now and then
  setInterval(() => scheduleRefresh(0), 10_000);
  void pollSessions();
  setInterval(() => void pollSessions(), 5_000);
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(100, now - last);
    last = now;
    for (const r of rooms.values()) r.frame(dt, now, reducedMotion.matches);
    deskRoom?.frame(dt, now, reducedMotion.matches);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
