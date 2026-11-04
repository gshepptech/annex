import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

import type { StateView, WingView, SessionView, TerminalView } from "../../server/api-types.ts";
import type { AnnexEvent } from "../../server/events.ts";
import { getState, getSessions, stream, apiFetch, whenKeyMissing, post, claimPairing, pairFailed } from "./api.ts";
import { Room } from "./room.ts";
import { Panel } from "./panel.ts";
import { Sidebar } from "./sidebar.ts";
import { Terminal, whenPathClicked } from "./terminal.ts";
import { newWingDialog } from "./newwing.ts";
import { logDialog } from "./syslog.ts";
import { pairDialog } from "./pair.ts";
import { DirectorDesk } from "./directorview.ts";
import { LiveView } from "./live.ts";
import { newSessionDialog, newTerminalDialog } from "./newsession.ts";
import type { TermPane } from "./termpane.ts";
import { ProjectsDialog } from "./projects.ts";
import { SetupDialog } from "./setup.ts";
import { FilesDialog } from "./editor.ts";
import { h } from "./dom.ts";
import { setRoomTheme } from "./office/sprites.ts";

const app = document.getElementById("app")!;

// Without Annex's key nothing loads; say how to get it instead of showing an empty office.
whenKeyMissing(() => {
  // pairFailed: a pairing link opened here that Annex refused (expired, used or wrong)
  const shown = document.querySelector(".no-key");
  if (shown) {
    shown.querySelector<HTMLElement>(".bad")!.hidden = !pairFailed;
    return;
  }
  document.body.append(
    h(
      "div",
      { class: "no-key", role: "alertdialog", "aria-label": "Annex needs its key" },
      h("h2", {}, "Annex needs its key"),
      h("p", { class: "bad", hidden: !pairFailed }, "That pairing link has expired or was already used."),
      h("p", {}, "Annex only answers a browser that has its key, so programs on this machine (Annex's own agents included) cannot drive it. Two ways to give it one:"),
      h("h3", {}, "From a browser that has Annex open"),
      h("p", {}, "Choose Pair a browser in the top bar and open the link here. It works once, for five minutes."),
      h("h3", {}, "From a terminal"),
      h("p", {}, "In the annex folder, run:"),
      h("pre", {}, "npm run open"),
      h("p", {}, "The browser keeps the key from then on."),
    ),
  );
});
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
// live sessions Annex is driving, by the Claude session they continue once it has an id
let lives: { id: string; sessionId: string | null; cwd: string; status: string }[] = [];
let selectedLive: string | null = null;
// terminals open on this machine, and the one shown
let terms: TerminalView[] = [];
let selectedTerm: string | null = null;
let termPane: TermPane | null = null;
let deskRoom: Room | null = null;
const DESK = "your-desk";
let recent: AnnexEvent[] = [];
// agents hired since the last snapshot: their room is rebuilt and they walk in from the door
const arriving = new Set<string>();

const panel = new Panel(() => scheduleRefresh(0));
const terminal = new Terminal(
  // back from one of your sessions goes to the first office; Your desk has no file of its own
  () => selectWing(selectedWing && selectedWing !== DESK ? selectedWing : state?.wings[0]?.id ?? ""),
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
const pair = pairDialog();
const liveView = new LiveView(
  () => selectWing(selectedWing && selectedWing !== DESK ? selectedWing : state?.wings[0]?.id ?? ""),
  () => void pollSessions(),
  (tool) => alertMe("Claude is waiting for your yes", `It wants to use ${tool}`),
);
// Annex restarted under an open live session: wait for it to reopen that conversation, then follow.
liveView.onGone = async (sessionId) => {
  if (!sessionId) return;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    await pollSessions();
    const again = lives.find((l) => l.sessionId === sessionId && l.status !== "closed");
    if (again) return selectLive(again.id, again.cwd, false);
    if (!selectedLive) return;
  }
};

terminal.onOpenLive = async (sessionId, force) => {
  try {
    const v = (await post("/api/live", { resume: sessionId, force: !!force })) as { id: string; cwd: string };
    selectLive(v.id, v.cwd);
    void pollSessions();
  } catch (err) {
    toast((err as Error).message, "var(--bad)");
  }
};
// the editor: from Projects, a file path in a session, or a file in Ready to merge
const files = new FilesDialog();
whenPathClicked((abs) => void files.openPath(abs));
panel.onOpenFile = (root, rel) => void files.open(root, rel);
const projects = new ProjectsDialog(
  async (folder) => {
    try {
      const v = (await post("/api/live", { cwd: folder })) as { id: string; cwd: string };
      selectLive(v.id, v.cwd);
      void pollSessions();
    } catch (err) {
      toast((err as Error).message, "var(--bad)");
    }
  },
  (folder) => void files.open(folder),
  (folder) => void openTerminal({ cwd: folder }),
);
// "Open in terminal" in a live session: Annex closes it, then continues it in `claude --resume`
liveView.onTerminal = (command) => {
  if (liveView.liveId) void openTerminal({ live: liveView.liveId }, command);
};
// First-run setup: each fix runs in a terminal pane; a session that finds Claude Code signed out
// offers the same login
const setup = new SetupDialog((id) => void openTerminal({ setup: id }));
liveView.onLogin = () => void openTerminal({ setup: "claude-login" });
const newTerminal = newTerminalDialog((v) => {
  void selectTerm(v);
  void pollSessions();
});

// xterm.js is loaded the first time a terminal is shown, so it stays out of the first page load.
async function pane(): Promise<TermPane> {
  if (!termPane) {
    const { TermPane } = await import("./termpane.ts");
    termPane ??= new TermPane(
      () => selectWing(selectedWing && selectedWing !== DESK ? selectedWing : state?.wings[0]?.id ?? ""),
      (sessionId) => terminal.onOpenLive(sessionId),
      () => void pollSessions(),
    );
  }
  return termPane;
}

async function openTerminal(body: { cwd: string } | { live: string } | { setup: string }, hint: string | null = null) {
  try {
    const v = (await post("/api/terminals", body)) as TerminalView;
    await selectTerm(v, hint);
    void pollSessions();
  } catch (err) {
    toast((err as Error).message, "var(--bad)");
  }
}

async function selectTerm(v: TerminalView, hint: string | null = null) {
  const p = await pane();
  selectedWing = DESK;
  selectedLive = null;
  selectedAgent = null;
  showDirector = false;
  liveView.close();
  terminal.close();
  selectedTerm = v.id;
  draw();
  await p.show(v, hint);
  reveal(true);
}

// leaving a terminal keeps it running; it is listed under Your desk
function leaveTerm() {
  selectedTerm = null;
  termPane?.hide();
}
const newSession = newSessionDialog((id, cwd) => {
  selectLive(id, cwd);
  void pollSessions();
});
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
// your plan's usage, as Claude last reported it
const plan = h("div", { class: "plan-use", title: "" });

// Desktop alerts for things that need you, while this tab is in the background. Off until you
// allow them in the browser.
const canAlert = typeof Notification !== "undefined";
// Inside Annex.app the page hands alerts and the waiting count to macOS (app/main.swift).
const native = (window as { webkit?: { messageHandlers?: { annex?: { postMessage(m: unknown): void } } } }).webkit?.messageHandlers?.annex;
const alertBtn = h("button", { class: "hud-btn", type: "button", hidden: !!native || !canAlert || Notification.permission !== "default", onclick: async () => { await Notification.requestPermission(); alertBtn.hidden = Notification.permission !== "default"; } }, "Turn on alerts");
function alertMe(title: string, body = "") {
  if (native) return native.postMessage({ kind: "alert", title, body });
  if (!canAlert || Notification.permission !== "granted" || !document.hidden) return;
  const n = new Notification(title, { body, tag: title });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}
const openState = h("span", { class: "state", role: "status" }, "Connecting…");
// shown while something Annex needs (Claude Code, its login, git) is missing
const finishSetup = h("button", { class: "hud-btn setup-btn", type: "button", hidden: true, onclick: () => void setup.open() }, "Finish setup");
setup.onChecked = (missing) => (finishSetup.hidden = !missing);
const hud = h(
  "header",
  { class: "hud box" },
  h("h1", { class: "logo" }, "Annex"),
  stats,
  openState,
  plan,
  alertBtn,
  finishSetup,
  h("button", { class: "hud-btn new-session", type: "button", onclick: () => void newSession.open() }, "New session"),
  h("button", { class: "hud-btn", type: "button", onclick: () => newTerminal.open() }, "Terminal"),
  h("button", { class: "hud-btn", type: "button", onclick: () => void projects.open() }, "Projects"),
  h("button", { class: "hud-btn director-btn", type: "button", onclick: () => openDirector() }, "Director"),
  h("button", { class: "hud-btn", type: "button", onclick: () => syslog.open() }, "System log"),
  h("button", { class: "hud-btn", type: "button", onclick: () => pair.open() }, "Pair a browser"),
  themeBtn,
);

const shellEl = h("div", { class: "shell" }, hud, sidebar.el, world, drawer);
app.append(shellEl, toasts, newOffice, syslog.el, pair.el, newSession.el, newTerminal.el, projects.el, files.el, setup.el);

function toast(text: string, colour: string) {
  const t = h("div", { class: "toast", style: `--c: ${colour}` }, text);
  toasts.append(t);
  setTimeout(() => t.remove(), 4200);
  while (toasts.childElementCount > 4) toasts.firstElementChild?.remove();
}

// The chosen office moves to the top of the floor; scroll up to it, or the change happens out of
// sight. On narrow screens the dialog sits below the offices, so bring that into view instead.
function reveal(fromTap: boolean) {
  if (!fromTap) return;
  const behavior = reducedMotion.matches ? "auto" : "smooth";
  if (matchMedia("(max-width: 1300px)").matches) requestAnimationFrame(() => drawer.scrollIntoView({ behavior }));
  else requestAnimationFrame(() => world.scrollTo({ top: 0, behavior }));
}

function openDirector() {
  leaveTerm();
  selectedLive = null;
  liveView.close();
  showDirector = true;
  selectedAgent = null;
  terminal.close();
  draw();
  reveal(true);
}

function selectWing(id: string, fromTap = false) {
  leaveTerm();
  selectedLive = null;
  liveView.close();
  selectedWing = id;
  selectedAgent = null;
  showDirector = false;
  terminal.close();
  draw();
  reveal(fromTap);
}

function selectLive(id: string, cwd: string, fromTap = true) {
  leaveTerm();
  selectedWing = DESK;
  selectedAgent = null;
  selectedLive = id;
  showDirector = false;
  terminal.close();
  liveView.open(id, cwd);
  draw();
  reveal(fromTap);
}

function selectSession(id: string, fromTap = false) {
  // a session Annex is driving live opens live
  const l = lives.find((x) => x.sessionId === id && x.status !== "closed");
  if (l) return selectLive(l.id, l.cwd, fromTap);
  leaveTerm();
  selectedLive = null;
  liveView.close();
  selectedWing = DESK;
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
    tasks: [], goals: [], spend: { runs: 0, minutes: 0 }, filedCount: 0, brief: null, draft: null, chat: [], asks: [], paused: false, houseRules: [],
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
      // the desk's nameplate opens the most recent session
      const room = new Room(w, 0, () => sessions[0] && selectSession(sessions[0].id, true), (id) => selectSession(id, true), new Set(), "desk");
      if (deskRoom) deskRoom.el.replaceWith(room.el);
      else world.prepend(room.el);
      deskRoom = room;
    }
  }
  draw();
}

// Annex's own health: a dead engine or a stuck loop shows in the top bar instead of looking idle.
let unhealthy: string | null = null;
async function pollHealth() {
  try {
    const r = await apiFetch("/api/health");
    const h = (await r.json()) as { ok: boolean; engine: string | null; database: string | null };
    unhealthy = h.ok ? null : (h.engine ?? h.database ?? "something is wrong");
  } catch {
    unhealthy = "Annex's server is not answering";
  }
  if (state) applyState(state);
}

async function pollSessions() {
  try {
    const [list, live, tt] = await Promise.all([
      getSessions(),
      apiFetch("/api/live").then((r) => r.json()) as Promise<{ lives: typeof lives }>,
      apiFetch("/api/terminals").then((r) => r.json()) as Promise<{ terminals?: TerminalView[] }>,
    ]);
    lives = live.lives;
    terms = tt.terminals ?? [];
    applySessions(list);
  } catch {
    // the offices still work without it; try again next time
  }
}

function selectAgent(id: string, fromTap = false) {
  if (sessions.some((s) => s.id === id)) return selectSession(id, fromTap);
  leaveTerm();
  selectedLive = null;
  liveView.close();
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
  deskRoom?.el.classList.toggle("selected", !showDirector && selectedWing === DESK);
  sidebar.render(state, showDirector ? null : selectedWing, selectedLive ? lives.find((l) => l.id === selectedLive)?.sessionId ?? null : selectedAgent, sessions, lives.filter((l) => l.status !== "closed"), (id, cwd) => selectLive(id, cwd), terms, (id) => {
    const v = terms.find((t) => t.id === id);
    if (v) void selectTerm(v);
  }, selectedTerm);
  // a terminal wants width: the drawer widens while one is shown
  shellEl.classList.toggle("wide", !!selectedTerm);
  if (selectedTerm && termPane) {
    if (drawer.firstChild !== termPane.el) drawer.replaceChildren(termPane.el);
  } else if (selectedLive) {
    if (drawer.firstChild !== liveView.el) drawer.replaceChildren(liveView.el);
  } else if (showDirector) {
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
  if (!selectedWing || (selectedWing !== DESK && !next.wings.some((w) => w.id === selectedWing))) selectedWing = next.wings[0]?.id ?? null;

  const crew = next.wings.flatMap((w) => w.agents);
  const working = crew.filter((a) => a.status === "running").length;
  const filed = next.wings.reduce((n, w) => n + w.filedCount, 0);
  const quests = next.wings.reduce((n, w) => n + w.asks.length, 0);
  // one sentence, so the counts read as a status line rather than a row of tiles
  stats.replaceChildren(
    h("b", {}, String(working)), ` of ${crew.length} at work in ${next.wings.length} offices, `,
    h("b", {}, String(filed)), " verified",
  );
  native?.postMessage({ kind: "badge", count: quests });
  if (quests) stats.append(", ", h("span", { class: "asks" }, h("b", {}, String(quests)), ` waiting on you`));
  const u = next.usage;
  if (u?.fiveHour && new Date(u.fiveHour.resetsAt).getTime() < Date.now()) {
    // the window this figure belongs to has ended; do not show an old number as current
    plan.replaceChildren(`Plan: the 5-hour window reset at ${new Date(u.fiveHour.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}; a new figure comes with the next run`);
    plan.classList.remove("high");
  } else if (u?.fiveHour) {
    const at = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    plan.replaceChildren(
      "Plan ",
      h("b", {}, pct(u.fiveHour.used)),
      ` of 5 hours (resets ${at(u.fiveHour.resetsAt)})`,
      u.sevenDay ? `, ${pct(u.sevenDay.used)} of the week` : "",
    );
    plan.title = `As Claude reported it at ${at(u.seenAt)}`;
    plan.classList.toggle("high", u.fiveHour.used >= 0.8 || (u.sevenDay?.used ?? 0) >= 0.8);
  }
  const held = next.wings.find((w) => w.held && !w.paused);
  if (unhealthy) {
    openState.textContent = unhealthy.length > 70 ? `${unhealthy.slice(0, 67)}…` : unhealthy;
    openState.title = unhealthy;
    openState.classList.add("closed", "bad");
  } else if (held?.held) {
    const until = held.held.until ? new Date(held.held.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
    openState.textContent = `Closed${until ? ` until ${until}` : ""}`;
    openState.title = held.held.reason;
    openState.classList.add("closed");
  } else {
    openState.textContent = working ? `${working} at work` : "Open";
    openState.title = "";
    openState.classList.remove("closed", "bad");
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
function announce(e: AnnexEvent) {
  if (e.wingId === "director") {
    if (e.kind === "chat.message" && e.payload.who === "lead" && !showDirector) {
      toast("The director replied", "var(--annex)");
      alertMe("The director replied");
    }
    return;
  }
  const wing = state?.wings.find((w) => w.id === e.wingId);
  const office = wing?.name ?? "";
  const title = String(e.payload.title ?? "").slice(0, 48);
  if (e.kind === "task.done") toast(`${office}: verified ${title}`, "var(--ok)");
  if (e.kind === "task.stopped") toast(`${office}: stopped ${title}`, "var(--bad)");
  if (e.kind === "agent.hired") toast(`${String(e.payload.name ?? "")} joined ${office}`, "var(--worker)");
  if (e.kind === "approval.requested") alertMe(`${office} is asking`, String(e.payload.title ?? ""));
  if (e.kind === "task.stopped") alertMe(`${office} stopped a task`, title);
  if (e.kind === "goal.done") alertMe(`${office} reached a goal`, String(e.payload.title ?? ""));
  if (e.kind === "wing.held") alertMe(`${office} closed`, String(e.payload.reason ?? ""));
  if (e.kind === "approval.requested") toast(`${office} is asking: ${String(e.payload.title ?? "").slice(0, 48)}`, "var(--ask)");
  if (e.kind === "wing.held") toast(`${office} closed${e.payload.reason ? ` (${String(e.payload.reason)})` : ""}`, "var(--warn)");
  if (e.kind === "wing.resumed") toast(`${office} is open again`, "var(--ok)");
}

const REFRESH_ON = new Set(["task.created", "task.started", "task.done", "task.stopped", "wing.mode_changed", "wing.held", "wing.resumed", "chat.message", "approval.requested", "approval.decided", "lead.woke", "lead.idle", "agent.said", "agent.hired"]);

async function boot() {
  // a pairing link trades its code for the key before anything asks for it; once the # is gone
  // this does nothing, so a retry below does not claim twice
  await claimPairing();
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
  void pollHealth();
  setInterval(() => void pollHealth(), 30_000);
  // a new Mac: the setup screen opens by itself while something required is missing, and is
  // checked again now and then until it is all there (a fix finishes in a terminal pane)
  void setup.check().then(() => {
    if (setup.missing) void setup.open();
  });
  setInterval(() => {
    if (setup.missing && !setup.el.open) void setup.check();
  }, 30_000);
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
