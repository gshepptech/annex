// A live session: your own Claude Code session, driven from here instead of a terminal. The
// answer streams in as it is written; a tool that needs your yes shows as a card; Stop ends the
// turn; the mode switches between asking, accepting edits, planning and not asking; slash
// commands complete from the session's own list.

import type { Entry, LiveUpdate, LivePrompt, LiveMode as Mode } from "../../server/api-types.ts";
import { apiFetch, withKey } from "./api.ts";
import { h } from "./dom.ts";
import { renderEntry } from "./terminal.ts";
import { RunPanel } from "./runpanel.ts";

const MODE_LABEL: Record<Mode, string> = { default: "Ask before acting", acceptEdits: "Accept edits", plan: "Plan only", bypassPermissions: "Don't ask" };

export class LiveView {
  readonly el = h("section", { class: "terminal live-session role-you", "aria-label": "Live session" });
  liveId: string | null = null;
  sessionId: string | null = null;
  private head = h("header", { class: "term-head" });
  private screen = h("div", { class: "screen", tabindex: "0", "aria-live": "polite" });
  private partialEl = h("div", { class: "ln say partial" });
  private cards = h("div", { class: "prompt-cards" });
  private foot = h("div", { class: "term-foot" });
  private run = new RunPanel();
  private runBox = h("details", { class: "run-box" }, h("summary", {}, "Run the app"));
  private input = h("textarea", { rows: 3, placeholder: "Message Claude (/ for commands)", "aria-label": "Message Claude" }) as HTMLTextAreaElement;
  private menu = h("ul", { class: "slash-menu", role: "listbox", hidden: true });
  private source: EventSource | null = null;
  private entries: Entry[] = [];
  private partial = "";
  private status: LiveUpdate["status"] = "starting";
  private mode: Mode = "default";
  private model: string | null = null;
  private prompts: LivePrompt[] = [];
  private commands: string[] = [];
  private cwd = "";
  private error: string | null = null;
  private stick = true;
  private drawn = -1;
  private frame = 0;
  private onBack: () => void;
  private onChange: () => void;
  private onPrompt: (tool: string) => void;

  constructor(onBack: () => void, onChange: () => void, onPrompt: (tool: string) => void = () => {}) {
    this.onBack = onBack;
    this.onChange = onChange;
    this.onPrompt = onPrompt;
    this.el.append(this.head, this.screen, this.cards, this.runBox, this.foot);
    this.runBox.append(this.run.el);
    this.runBox.addEventListener("toggle", () => (this.runBox.open && this.cwd ? this.run.show({ folder: this.cwd }) : this.run.hide()));
    this.screen.addEventListener("scroll", () => {
      this.stick = this.screen.scrollHeight - this.screen.scrollTop - this.screen.clientHeight < 40;
    });
    this.input.addEventListener("keydown", (ev) => this.keys(ev));
    this.input.addEventListener("input", () => this.complete());
    this.foot.append(
      h(
        "form",
        { onsubmit: (ev: Event) => { ev.preventDefault(); void this.send(); } },
        h("div", { class: "slash-wrap" }, this.menu, this.input),
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Send ⌘↵"), h("span", { class: "hint" }, "Enter for a new line; ⌘↵ sends")),
      ),
    );
  }

  open(liveId: string, cwd: string) {
    if (this.liveId === liveId) return;
    this.close();
    this.liveId = liveId;
    this.cwd = cwd;
    this.entries = [];
    this.partial = "";
    this.prompts = [];
    this.error = null;
    this.drawn = -1;
    this.stick = true;
    this.screen.replaceChildren(h("p", { class: "term-empty" }, "Starting Claude…"));
    this.source = new EventSource(withKey(`/api/live/${liveId}/events`));
    this.source.onmessage = (m) => this.apply(JSON.parse(m.data) as LiveUpdate);
    this.source.onerror = () => {
      // a passing hiccup reconnects by itself; a refused stream means the session is gone (Annex
      // restarted), which the person should be told rather than left looking at nothing
      if (this.source?.readyState === EventSource.CLOSED) {
        this.status = "closed";
        this.error = "This live session ended when Annex restarted. Its conversation is kept: open it again from Your desk.";
        this.drawn = -1;
        this.draw();
      }
    };
    this.drawHead();
  }

  close() {
    this.run.hide();
    this.runBox.open = false;
    this.source?.close();
    this.source = null;
    this.liveId = null;
  }

  private apply(u: LiveUpdate) {
    this.entries.length = Math.min(this.entries.length, u.from);
    this.entries.push(...u.entries);
    this.partial = u.partial;
    const was = this.status;
    this.status = u.status;
    this.mode = u.mode;
    this.model = u.model;
    const asked = u.prompts.filter((p) => !this.prompts.some((q) => q.id === p.id));
    this.prompts = u.prompts;
    for (const p of asked) this.onPrompt(p.tool);
    this.error = u.error;
    this.sessionId = u.sessionId;
    if (u.slashCommands) this.commands = u.slashCommands;
    if (was !== this.status) this.onChange();
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw() {
    this.drawHead();
    if (this.drawn !== this.entries.length) {
      this.drawn = this.entries.length;
      const open = new Set([...this.screen.querySelectorAll("details[open]")].map((d) => (d as HTMLElement).dataset.k));
      const results = new Map<string, Extract<Entry, { kind: "result" }>>();
      for (const e of this.entries) if (e.kind === "result") results.set(e.toolId, e);
      const body: HTMLElement[] = [];
      for (const [i, e] of this.entries.entries()) for (const el of renderEntry(e, results, `l:${i}`)) if (el) body.push(el);
      if (!body.length) body.push(h("p", { class: "term-empty" }, this.status === "starting" ? "Starting Claude…" : "Say what you want to do."));
      this.screen.replaceChildren(...body, this.partialEl);
      for (const d of this.screen.querySelectorAll("details")) if (open.has((d as HTMLElement).dataset.k)) (d as HTMLDetailsElement).open = true;
    }
    this.partialEl.replaceChildren(...(this.partial ? [h("span", { class: "mk" }, "⏺"), h("span", { class: "body" }, this.partial)] : []));
    if (this.error) this.screen.append(h("div", { class: "ln error" }, h("span", { class: "mk" }, "✗"), h("span", { class: "body" }, this.error)));
    this.drawCards();
    if (this.stick) this.screen.scrollTop = this.screen.scrollHeight;
    const closed = this.status === "closed";
    this.input.disabled = closed;
    (this.foot.querySelector("button[type=submit]") as HTMLButtonElement).disabled = closed;
  }

  private drawHead() {
    const name = this.cwd.split("/").filter(Boolean).pop() ?? this.cwd;
    const working = this.status === "working";
    const modeSel = h("select", { "aria-label": "Permission mode", disabled: this.status === "closed" }, ...Object.entries(MODE_LABEL).map(([v, label]) => h("option", { value: v, selected: v === this.mode }, label))) as HTMLSelectElement;
    modeSel.addEventListener("change", () => void this.post("mode", { mode: modeSel.value }));
    this.head.replaceChildren(
      h("button", { class: "back", type: "button", onclick: () => this.onBack() }, "← Offices"),
      h("h2", {}, name),
      h(
        "div",
        { class: "meta" },
        h("span", { class: "badge" }, "Live"),
        h("span", { title: this.cwd }, shortPath(this.cwd)),
        this.model ? h("span", {}, this.model.replace(/\[.*\]$/, "")) : null,
        h("span", { class: working ? "live" : "" }, this.status === "working" ? "Working" : this.status === "waiting" ? "Your turn" : this.status === "closed" ? "Closed" : "Starting"),
      ),
      h(
        "div",
        { class: "row live-controls" },
        modeSel,
        h("button", { class: "btn", type: "button", disabled: !working, onclick: () => void this.post("interrupt") }, "Stop"),
        h("button", { class: "btn ghost", type: "button", disabled: this.status === "closed", onclick: () => void this.post("close") }, "Close session"),
      ),
    );
  }

  // A tool waiting for your yes: what it wants to do, in full, and the three answers.
  private drawCards() {
    this.cards.replaceChildren(
      ...this.prompts.map((p) => {
        const reason = h("input", { placeholder: "Why not (optional, Claude sees it)", "aria-label": "Reason for saying no" }) as HTMLInputElement;
        return h(
          "div",
          { class: "prompt-card", role: "alertdialog", "aria-label": `Claude wants to use ${p.tool}` },
          h("div", { class: "label" }, `Claude wants to use ${p.tool}`),
          describeInput(p),
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn good", type: "button", onclick: () => void this.answer(p.id, { allow: true }) }, "Allow"),
            h("button", { class: "btn", type: "button", onclick: () => void this.answer(p.id, { allow: true, always: true }), title: p.tool === "Bash" ? "This exact command, for the rest of this session" : `Every ${p.tool}, for the rest of this session` }, p.tool === "Bash" ? "Allow this command for the session" : `Allow ${p.tool} for the session`),
            h("button", { class: "btn bad", type: "button", onclick: () => void this.answer(p.id, { allow: false, message: reason.value }) }, "Deny"),
          ),
          reason,
        );
      }),
    );
  }

  private async answer(promptId: string, d: { allow: boolean; always?: boolean; message?: string }) {
    await this.post("answer", { promptId, ...d });
  }

  private async send() {
    const text = this.input.value;
    if (!text.trim() || !this.liveId) return;
    this.menu.hidden = true;
    const ok = await this.post("message", { text });
    if (ok) {
      this.input.value = "";
      this.stick = true;
    }
  }

  private async post(action: string, body: unknown = {}): Promise<boolean> {
    if (!this.liveId) return false;
    const r = await apiFetch(`/api/live/${this.liveId}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      this.error = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Annex answered ${r.status}`;
      this.draw();
      return false;
    }
    return true;
  }

  // Slash commands: typing "/" at the start lists the session's commands; Tab or Enter on a
  // highlighted one completes it.
  private complete() {
    const v = this.input.value;
    const m = /^\/([\w:.-]*)$/.exec(v);
    if (!m || !this.commands.length) {
      this.menu.hidden = true;
      return;
    }
    const q = m[1]!.toLowerCase();
    const hits = this.commands.filter((c) => c.toLowerCase().includes(q)).sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q))).slice(0, 8);
    this.menu.replaceChildren(...hits.map((c, i) => h("li", { role: "option", "aria-selected": String(i === 0), onmousedown: (ev: Event) => { ev.preventDefault(); this.pick(c); } }, `/${c}`)));
    this.menu.hidden = !hits.length;
  }

  private pick(c: string) {
    this.input.value = `/${c} `;
    this.menu.hidden = true;
    this.input.focus();
  }

  private keys(ev: KeyboardEvent) {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void this.send();
      return;
    }
    if (this.menu.hidden) return;
    const items = [...this.menu.children] as HTMLElement[];
    const at = items.findIndex((li) => li.getAttribute("aria-selected") === "true");
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const next = (at + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute("aria-selected", String(i === next)));
    } else if (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey)) {
      ev.preventDefault();
      this.pick(items[Math.max(0, at)]!.textContent!.slice(1));
    } else if (ev.key === "Escape") {
      this.menu.hidden = true;
    }
  }
}

function describeInput(p: LivePrompt): HTMLElement {
  const s = (k: string) => (typeof p.input[k] === "string" ? (p.input[k] as string) : "");
  if (p.tool === "Bash") return h("pre", { class: "prompt-detail" }, s("command"));
  if (p.tool === "Write") return h("div", {}, h("p", { class: "prompt-path" }, s("file_path")), h("pre", { class: "prompt-detail" }, s("content").split("\n").slice(0, 30).join("\n")));
  if (p.tool === "Edit") {
    const diff = [...s("old_string").split("\n").map((l) => `- ${l}`), ...s("new_string").split("\n").map((l) => `+ ${l}`)].slice(0, 40);
    return h("div", {}, h("p", { class: "prompt-path" }, s("file_path")), h("pre", { class: "prompt-detail" }, ...diff.map((l) => h("div", { class: l.startsWith("+") ? "add" : "del" }, l))));
  }
  return h("pre", { class: "prompt-detail" }, JSON.stringify(p.input, null, 2).slice(0, 2000));
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : p;
}
