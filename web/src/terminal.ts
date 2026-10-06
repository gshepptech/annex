// avoid-ai-design-ignore-file: I2 (these are Claude Code's own terminal marks, shown on purpose)
// One agent's work, run by run, drawn the way a Claude Code terminal draws it: ⏺ for what the
// agent says and each tool it calls, ⎿ for what came back. It follows the bottom while the agent
// is working, unless the person has scrolled up to read.

import type { TranscriptView, RunView, Entry, SessionTranscript } from "../../server/api-types.ts";
import { h } from "./dom.ts";
import { apiFetch } from "./api.ts";
import { portrait, faceIndex } from "./portrait.ts";

const ROLE_LABEL = { lead: "Lead", worker: "Crew", reviewer: "Reviewer" } as const;
const PREVIEW_LINES = 6;

export class Terminal {
  readonly el = h("section", { class: "terminal", "aria-label": "Agent terminal" });
  agentId: string | null = null;
  // set instead of agentId when showing one of your own sessions
  sessionId: string | null = null;
  // set by the page: continue one of your sessions live
  onOpenLive: (sessionId: string, force?: boolean) => void = () => {};
  // the session whose "it may be open in a terminal" question is showing
  private confirming: string | null = null;
  private screen = h("div", { class: "screen", tabindex: "0", "aria-live": "polite" });
  private head = h("header", { class: "term-head" });
  private briefing = h("div", { class: "briefing" });
  // the reply box under one of your sessions; empty for an agent
  private foot = h("div", { class: "term-foot" });
  private replyError = "";
  private footKey = "";
  private stick = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private onBack: () => void;
  private wingName: (id: string) => string;
  private lastRender = "";
  // how many of the newest runs to show; "Load older runs" raises it
  private limit = 8;

  constructor(onBack: () => void, wingName: (id: string) => string) {
    this.onBack = onBack;
    this.wingName = wingName;
    this.el.append(this.head, this.briefing, this.screen, this.foot);
    this.screen.addEventListener("scroll", () => {
      this.stick = this.screen.scrollHeight - this.screen.scrollTop - this.screen.clientHeight < 40;
    });
  }

  open(agentId: string) {
    this.sessionId = null;
    this.foot.replaceChildren();
    this.footKey = "";
    if (this.agentId !== agentId) {
      this.agentId = agentId;
      this.stick = true;
      this.limit = 8;
      this.lastRender = "";
      this.head.replaceChildren();
      this.briefing.replaceChildren();
      this.screen.replaceChildren(h("p", { class: "term-empty" }, "Loading…"));
    }
    void this.load();
  }

  openSession(id: string) {
    this.agentId = null;
    if (this.sessionId !== id) {
      this.sessionId = id;
      this.stick = true;
      this.lastRender = "";
      this.head.replaceChildren();
      this.briefing.replaceChildren();
      this.screen.replaceChildren(h("p", { class: "term-empty" }, "Loading…"));
      this.foot.replaceChildren();
      this.replyError = "";
      this.footKey = "";
    }
    void this.loadSession();
  }

  private async loadSession() {
    const id = this.sessionId;
    if (!id) return;
    if (this.timer) clearTimeout(this.timer);
    let t: SessionTranscript;
    try {
      const r = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/transcript`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `answered ${r.status}`);
      t = await r.json();
    } catch (err) {
      if (this.sessionId === id) this.screen.replaceChildren(h("p", { class: "term-empty" }, `Could not read the session: ${(err as Error).message}`));
      return;
    }
    if (this.sessionId !== id) return;
    this.renderSession(t);
    this.timer = setTimeout(() => void this.loadSession(), t.session.status === "working" ? 3000 : 10000);
  }

  private renderSession(t: SessionTranscript) {
    const s = t.session;
    this.el.className = "terminal role-you";
    const cmd = `cd ${JSON.stringify(s.cwd)} && claude --resume ${s.id}`;
    const copy = h("button", { class: "btn", type: "button", onclick: async () => { await navigator.clipboard?.writeText(cmd).catch(() => {}); copy.textContent = "Copied"; } }, "Copy");
    this.head.replaceChildren(
      h("button", { class: "back", type: "button", onclick: () => this.onBack() }, "← Offices"),
      h("h2", {}, s.title),
      h(
        "div",
        { class: "meta" },
        h("span", { class: "badge" }, "Your session"),
        h("span", {}, shortPath(s.cwd)),
        s.branch ? h("span", {}, s.branch) : null,
        s.model ? h("span", {}, s.model) : null,
        s.status === "working" ? h("span", { class: "live" }, "Working") : h("span", {}, "idle"),
      ),
    );
    const quiet = Date.now() - new Date(s.updatedAt).getTime() >= 3 * 60_000;
    const redraw = () => { this.lastRender = ""; this.renderSession(t); };
    const openLive = () => {
      if (quiet) return this.onOpenLive(s.id);
      this.confirming = s.id;
      redraw();
    };
    const resume = h(
      "div",
      { class: "resume" },
      h("span", {}, "Continue it here, live, or in your terminal"),
      h("button", { class: "btn primary", type: "button", disabled: s.replying, onclick: openLive }, "Open live"),
      h("code", {}, cmd),
      copy,
    );
    const ask = !quiet && this.confirming === s.id
      ? h(
          "div",
          { class: "confirm" },
          h("p", {}, "This session changed in the last few minutes. If it is still open in a terminal, exit Claude there first: two copies of one conversation split it in two."),
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn primary", type: "button", onclick: () => { this.confirming = null; this.onOpenLive(s.id, true); } }, "Open anyway"),
            h("button", { class: "btn ghost", type: "button", onclick: () => { this.confirming = null; redraw(); } }, "Cancel"),
          ),
        )
      : null;
    this.briefing.replaceChildren(resume, ...(ask ? [ask] : []));
    this.drawReply(s);
    const key = `${t.entries.length}:${t.entries.at(-1)?.at ?? ""}`;
    if (key === this.lastRender) return;
    this.lastRender = key;
    const open = new Set([...this.screen.querySelectorAll("details[open]")].map((d) => (d as HTMLElement).dataset.k));
    const results = new Map<string, Extract<Entry, { kind: "result" }>>();
    for (const e of t.entries) if (e.kind === "result") results.set(e.toolId, e);
    const body: (HTMLElement | null)[] = [];
    for (const [i, e] of t.entries.entries()) body.push(...renderEntry(e, results, `s:${i}`));
    if (!t.entries.length) body.push(line("sys", "✻", "Nothing in this session yet."));
    this.screen.replaceChildren(h("p", { class: "run-reason" }, "the latest part of this session"), ...body.filter((b): b is HTMLElement => b !== null));
    for (const d of this.screen.querySelectorAll("details")) if (open.has((d as HTMLElement).dataset.k)) (d as HTMLDetailsElement).open = true;
    if (this.stick) this.screen.scrollTop = this.screen.scrollHeight;
  }

  // A session quiet for a few minutes can be answered from here; a busy one is probably open in a
  // terminal, and answering it here would fork the conversation.
  private drawReply(s: SessionTranscript["session"]) {
    const box = this.foot.querySelector("textarea") as HTMLTextAreaElement | null;
    const kept = box?.value ?? "";
    const focused = !!box && document.activeElement === box;
    const quietFor = Date.now() - new Date(s.updatedAt).getTime();
    const open = quietFor < 3 * 60_000;
    const reason = s.replying ? "Claude is answering in this session now." : open ? "Active in the last few minutes, so it may be open in a terminal. Reply there, or wait a few minutes." : "";
    const key = `${s.id}:${reason}:${this.replyError}:${s.permissionMode}`;
    if (key === this.footKey) return;
    this.footKey = key;
    const text = h("textarea", { rows: 2, placeholder: "Reply in this session", "aria-label": "Reply in this session", disabled: !!reason }) as HTMLTextAreaElement;
    text.value = kept;
    const send = async () => {
      if (!text.value.trim()) return;
      try {
        const r = await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text.value }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `answered ${r.status}`);
        text.value = "";
        this.replyError = "";
        this.stick = true;
      } catch (err) {
        this.replyError = (err as Error).message;
      }
      void this.loadSession();
    };
    text.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) void send();
    });
    this.foot.replaceChildren(
      h(
        "form",
        { onsubmit: (ev: Event) => { ev.preventDefault(); void send(); } },
        text,
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn primary", type: "submit", disabled: !!reason }, "Send ⌘↵"),
          h("span", { class: "hint" }, reason || `Runs as this session's next turn${s.permissionMode ? `, in ${s.permissionMode} mode like the rest of it` : ""}.`),
        ),
        this.replyError ? h("p", { class: "notice bad", role: "alert" }, this.replyError) : null,
      ),
    );
    if (focused) text.focus();
  }

  close() {
    this.agentId = null;
    this.sessionId = null;
    if (this.timer) clearTimeout(this.timer);
  }

  // Something this agent did just arrived on the event stream: refresh shortly, once.
  poke() {
    if (!this.agentId || this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.load();
    }, 1200);
  }

  private async load() {
    const id = this.agentId;
    if (!id) return;
    if (this.timer) clearTimeout(this.timer);
    let t: TranscriptView;
    try {
      const r = await apiFetch(`/api/agents/${encodeURIComponent(id)}/transcript?limit=${this.limit}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `answered ${r.status}`);
      t = await r.json();
    } catch (err) {
      if (this.agentId === id) this.screen.replaceChildren(h("p", { class: "term-empty" }, `Could not read the runs: ${(err as Error).message}`));
      return;
    }
    if (this.agentId !== id) return;
    this.render(t);
    const active = t.agent.status === "running" || t.runs.some((r) => r.status === "running" || r.status === "queued");
    this.timer = setTimeout(() => void this.load(), active ? 3000 : 15000);
  }

  private render(t: TranscriptView) {
    const a = t.agent;
    const running = a.status === "running" || t.runs.some((r) => r.status === "running");
    this.el.className = `terminal role-${a.role}`;
    this.head.replaceChildren(
      h("button", { class: "back", type: "button", onclick: () => this.onBack() }, `← ${this.wingName(a.wingId)}`),
      portrait(a.role, faceIndex(a), 52, "big"),
      h("h2", {}, a.name),
      h(
        "div",
        { class: "meta" },
        h("span", { class: "badge" }, ROLE_LABEL[a.role]),
        a.model ? h("span", {}, a.model) : null,
        h("span", {}, `${a.filed} verified`),
        running ? h("span", { class: "live" }, "Working") : h("span", {}, "idle"),
      ),
    );
    // what the agent is told before any task: Annex's orders, then everything Paperclip adds
    if (!this.briefing.childElementCount) {
      this.briefing.append(h("details", {}, h("summary", {}, "Standing orders from Annex"), h("pre", {}, t.instructions || "(none)")));
      if (t.systemPrompt) this.briefing.append(h("details", {}, h("summary", {}, "Full system prompt (Paperclip's contract and ours)"), h("pre", {}, t.systemPrompt)));
    }

    // skip the DOM rebuild when nothing changed, so a reader's place and open folds survive polls
    const key = JSON.stringify(t.runs.map((r) => [r.id, r.status, r.entries.length]));
    if (key === this.lastRender) return;
    this.lastRender = key;

    const open = new Set([...this.screen.querySelectorAll("details[open]")].map((d) => (d as HTMLElement).dataset.k));
    const runs = [...t.runs].reverse();
    if (runs.length === 0) {
      this.screen.replaceChildren(h("p", { class: "term-empty" }, `${a.name} has not run yet.`));
      return;
    }
    const older = t.runs.length >= this.limit
      ? h("button", { class: "btn older", type: "button", onclick: () => { this.limit += 20; this.stick = false; this.lastRender = ""; void this.load(); } }, "Load older runs")
      : h("p", { class: "run-reason" }, "— the first run —");
    this.screen.replaceChildren(older, ...runs.map((r) => this.run(r)));
    for (const d of this.screen.querySelectorAll("details")) if (open.has((d as HTMLElement).dataset.k)) (d as HTMLDetailsElement).open = true;
    if (this.stick) this.screen.scrollTop = this.screen.scrollHeight;
  }

  private run(r: RunView): HTMLElement {
    const started = r.startedAt ? new Date(r.startedAt) : null;
    const took = r.startedAt && r.finishedAt ? duration(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) : null;
    const rule = h(
      "div",
      { class: "run-rule" },
      h("b", {}, r.task ? `${r.task.identifier} ${r.task.title}` : "run"),
      h("span", { class: `st-${r.status}` }, r.status.replace(/_/g, " ")),
      started ? h("span", {}, started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })) : null,
      took ? h("span", {}, took) : null,
    );
    const results = new Map<string, Extract<Entry, { kind: "result" }>>();
    for (const e of r.entries) if (e.kind === "result") results.set(e.toolId, e);

    const body: (HTMLElement | null)[] = [];
    for (const [i, e] of r.entries.entries()) body.push(...renderEntry(e, results, `${r.id}:${i}`));
    if (r.entries.length === 0) body.push(line("sys", "✻", r.status === "queued" ? "Waiting to start..." : "No output recorded."));
    const prompt = r.prompt ? h("details", { class: "run-prompt", "data-k": `${r.id}:prompt` }, h("summary", {}, "Prompt sent"), h("pre", {}, r.prompt)) : null;
    return h("div", { class: "run" }, rule, r.reason ? h("p", { class: "run-reason" }, `woke: ${r.reason.replace(/_/g, " ")}`) : null, prompt, ...body);
  }

}

// A file path the page shows (a Read, an Edit) opens in the editor; the page says how.
let openPath: (abs: string) => void = () => {};
export function whenPathClicked(fn: (abs: string) => void) {
  openPath = fn;
}

export function fileLink(abs: string, label = abs): HTMLElement {
  return h("button", { type: "button", class: "arg file-link", title: abs, onclick: () => openPath(abs) }, label);
}

// One entry the way Claude Code prints it; shared by agents' runs, your sessions and live ones.
export function renderEntry(e: Entry, results: Map<string, Extract<Entry, { kind: "result" }>>, k: string): (HTMLElement | null)[] {
  const out = renderOne(e, results, k);
  // work done inside a subagent sits indented under the call that started it
  if (e.sub) for (const el of out) el?.classList.add("sub");
  return out;
}

function renderOne(e: Entry, results: Map<string, Extract<Entry, { kind: "result" }>>, k: string): (HTMLElement | null)[] {
  switch (e.kind) {
    case "start":
      return [line("sys", "✻", `${e.model} in ${shortPath(e.cwd)}`)];
    case "text":
      return [line("say", "⏺", e.text)];
    case "prompt":
      return [line("you", "❯", e.text)];
    case "tool": {
      const res = results.get(e.id);
      const state = !res ? "" : res.isError ? "err" : "ok";
      const el = h("div", { class: `ln tool ${state}` }, h("span", { class: "mk" }, "⏺"), h("span", { class: "body" }, h("b", {}, e.name), "(", e.path ? fileLink(e.path, e.summary) : h("span", { class: "arg" }, e.summary), ")"));
      const out: (HTMLElement | null)[] = [el];
      if (e.detail) out.push(e.name === "TodoWrite" ? h("pre", { class: "todos" }, e.detail) : diff(e.detail));
      if (res) out.push(result(res, k));
      return out;
    }
    case "result":
      return [];
    case "done":
      return [line(e.isError ? "done err" : "done", "✻", `${e.isError ? "Stopped" : "Done"}${e.durationMs ? ` in ${duration(e.durationMs)}` : ""}${e.turns ? `, ${e.turns} turns` : ""}`), e.text ? line("say", "⏺", e.text) : null];
    case "error":
      return [line("error", "✗", e.text)];
  }
}

function line(kind: string, mark: string, text: string): HTMLElement {
  return h("div", { class: `ln ${kind}` }, h("span", { class: "mk" }, mark), h("span", { class: "body" }, text));
}

function result(r: Extract<Entry, { kind: "result" }>, k: string): HTMLElement {
  const lines = r.text.replace(/\n+$/, "").split("\n");
  const head = lines.slice(0, PREVIEW_LINES).join("\n") || "(no output)";
  const rest = lines.slice(PREVIEW_LINES);
  const content = rest.length
    ? h("div", {}, h("pre", {}, head), h("details", { "data-k": k }, h("summary", {}, `… +${rest.length} lines`), h("pre", {}, rest.join("\n"))))
    : h("pre", {}, head);
  return h("div", { class: `out${r.isError ? " err" : ""}` }, h("span", { class: "mk" }, "⎿"), content);
}

function diff(text: string): HTMLElement {
  return h("div", { class: "diff" }, ...text.split("\n").map((l) => h("div", { class: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "" }, l)));
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : p;
}
