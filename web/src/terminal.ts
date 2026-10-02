// One agent's work, run by run, drawn the way a Claude Code terminal draws it: ⏺ for what the
// agent says and each tool it calls, ⎿ for what came back. It follows the bottom while the agent
// is working, unless the person has scrolled up to read.

import type { TranscriptView, RunView, Entry } from "../../server/api-types.ts";
import { h } from "./dom.ts";
import { portrait, faceIndex } from "./portrait.ts";

const ROLE_LABEL = { lead: "LEAD", worker: "CREW", reviewer: "REVIEWER" } as const;
const PREVIEW_LINES = 6;

export class Terminal {
  readonly el = h("section", { class: "terminal", "aria-label": "Agent terminal" });
  agentId: string | null = null;
  private screen = h("div", { class: "screen", tabindex: "0", "aria-live": "polite" });
  private head = h("header", { class: "term-head" });
  private briefing = h("div", { class: "briefing" });
  private stick = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private onBack: () => void;
  private wingName: (id: string) => string;
  private lastRender = "";

  constructor(onBack: () => void, wingName: (id: string) => string) {
    this.onBack = onBack;
    this.wingName = wingName;
    this.el.append(this.head, this.briefing, this.screen);
    this.screen.addEventListener("scroll", () => {
      this.stick = this.screen.scrollHeight - this.screen.scrollTop - this.screen.clientHeight < 40;
    });
  }

  open(agentId: string) {
    if (this.agentId !== agentId) {
      this.agentId = agentId;
      this.stick = true;
      this.lastRender = "";
      this.head.replaceChildren();
      this.briefing.replaceChildren();
      this.screen.replaceChildren(h("p", { class: "term-empty" }, "LOADING..."));
    }
    void this.load();
  }

  close() {
    this.agentId = null;
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
      const r = await fetch(`/api/agents/${encodeURIComponent(id)}/transcript`);
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
      h("button", { class: "back", type: "button", onclick: () => this.onBack() }, `◀ ${this.wingName(a.wingId).toUpperCase()}`),
      portrait(a.role, faceIndex(a), 52, "big"),
      h("h2", {}, a.name.toUpperCase()),
      h(
        "div",
        { class: "meta" },
        h("span", { class: "badge", style: "background: var(--c)" }, ROLE_LABEL[a.role]),
        a.model ? h("span", {}, a.model) : null,
        h("span", {}, `★${a.filed} filed`),
        running ? h("span", { class: "live" }, "● WORKING") : h("span", {}, "idle"),
      ),
    );
    // what the agent is told before any task: Annex's orders, then everything Paperclip adds
    if (!this.briefing.childElementCount) {
      this.briefing.append(h("details", {}, h("summary", {}, "BRIEFING: STANDING ORDERS FROM ANNEX"), h("pre", {}, t.instructions || "(none)")));
      if (t.systemPrompt) this.briefing.append(h("details", {}, h("summary", {}, "FULL SYSTEM PROMPT (PAPERCLIP'S CONTRACT + OURS)"), h("pre", {}, t.systemPrompt)));
    }

    // skip the DOM rebuild when nothing changed, so a reader's place and open folds survive polls
    const key = JSON.stringify(t.runs.map((r) => [r.id, r.status, r.entries.length]));
    if (key === this.lastRender) return;
    this.lastRender = key;

    const open = new Set([...this.screen.querySelectorAll("details[open]")].map((d) => (d as HTMLElement).dataset.k));
    const runs = [...t.runs].reverse();
    if (runs.length === 0) {
      this.screen.replaceChildren(h("p", { class: "term-empty" }, `${a.name.toUpperCase()} HAS NOT RUN YET.`));
      return;
    }
    this.screen.replaceChildren(...runs.map((r) => this.run(r)));
    for (const d of this.screen.querySelectorAll("details")) if (open.has((d as HTMLElement).dataset.k)) (d as HTMLDetailsElement).open = true;
    if (this.stick) this.screen.scrollTop = this.screen.scrollHeight;
  }

  private run(r: RunView): HTMLElement {
    const started = r.startedAt ? new Date(r.startedAt) : null;
    const took = r.startedAt && r.finishedAt ? duration(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) : null;
    const rule = h(
      "div",
      { class: "run-rule" },
      h("b", {}, r.task ? `${r.task.identifier} · ${r.task.title}` : "run"),
      h("span", { class: `st-${r.status}` }, r.status.replace(/_/g, " ")),
      started ? h("span", {}, started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })) : null,
      took ? h("span", {}, took) : null,
    );
    const results = new Map<string, Extract<Entry, { kind: "result" }>>();
    for (const e of r.entries) if (e.kind === "result") results.set(e.toolId, e);

    const body: (HTMLElement | null)[] = [];
    for (const [i, e] of r.entries.entries()) body.push(...this.entry(e, results, `${r.id}:${i}`));
    if (r.entries.length === 0) body.push(line("sys", "✻", r.status === "queued" ? "Waiting to start..." : "No output recorded."));
    const prompt = r.prompt ? h("details", { class: "run-prompt", "data-k": `${r.id}:prompt` }, h("summary", {}, "▸ PROMPT SENT"), h("pre", {}, r.prompt)) : null;
    return h("div", { class: "run" }, rule, r.reason ? h("p", { class: "run-reason" }, `woke: ${r.reason.replace(/_/g, " ")}`) : null, prompt, ...body);
  }

  private entry(e: Entry, results: Map<string, Extract<Entry, { kind: "result" }>>, k: string): (HTMLElement | null)[] {
    switch (e.kind) {
      case "start":
        return [line("sys", "✻", `${e.model}  ·  ${shortPath(e.cwd)}`)];
      case "text":
        return [line("say", "⏺", e.text)];
      case "tool": {
        const res = results.get(e.id);
        const state = !res ? "" : res.isError ? "err" : "ok";
        const el = h("div", { class: `ln tool ${state}` }, h("span", { class: "mk" }, "⏺"), h("span", { class: "body" }, h("b", {}, e.name), "(", h("span", { class: "arg" }, e.summary), ")"));
        const out: (HTMLElement | null)[] = [el];
        if (e.detail) out.push(diff(e.detail));
        if (res) out.push(result(res, k));
        return out;
      }
      case "result":
        return [];
      case "done":
        return [line(e.isError ? "done err" : "done", "✻", `${e.isError ? "Stopped" : "Done"}${e.durationMs ? ` in ${duration(e.durationMs)}` : ""}${e.turns ? ` · ${e.turns} turns` : ""}`), e.text ? line("say", "⏺", e.text) : null];
      case "error":
        return [line("error", "✗", e.text)];
    }
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
