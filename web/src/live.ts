// A live session: your own Claude Code session, driven from here instead of a terminal. The
// answer streams in as it is written; a tool that needs your yes shows as a card; Stop ends the
// turn; the mode switches between asking, accepting edits, planning and not asking; slash
// commands complete from the session's own list.

import type { Entry, LiveUpdate, LivePrompt, LiveMode as Mode } from "../../server/api-types.ts";
import { apiFetch, withKey } from "./api.ts";
import { h } from "./dom.ts";
import { fileLink, renderEntry } from "./terminal.ts";
import { RunPanel } from "./runpanel.ts";
import { MODELS } from "./newsession.ts";
import { TERMINAL_ONLY, needsTerminal } from "./slash.ts";

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
  private input = h("textarea", { rows: 3, placeholder: "Message Claude", "aria-label": "Message Claude" }) as HTMLTextAreaElement;
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
  // the stream went away (Annex restarted): the page looks for the same conversation reopened
  onGone: (sessionId: string | null) => void = () => {};
  // move this conversation to a terminal pane (`claude --resume`), with the command to type there
  onTerminal: (command: string | null) => void = () => {};

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
    // paste or drop an image to send it with the next message
    this.input.addEventListener("paste", (ev) => {
      for (const item of ev.clipboardData?.items ?? []) {
        const f = item.kind === "file" ? item.getAsFile() : null;
        if (f && f.type.startsWith("image/")) {
          ev.preventDefault();
          void this.addImage(f);
        }
      }
    });
    this.input.addEventListener("dragover", (ev) => ev.preventDefault());
    this.input.addEventListener("drop", (ev) => {
      const files = [...(ev.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      ev.preventDefault();
      for (const f of files) void this.addImage(f);
    });
    this.foot.append(
      h(
        "form",
        { onsubmit: (ev: Event) => { ev.preventDefault(); void this.send(); } },
        this.attachments,
        h("div", { class: "slash-wrap" }, this.menu, this.input),
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Send ⌘↵"), h("span", { class: "hint" }, "⌘↵ sends. Type / for commands, @ for files, ! to run a shell command. ↑ recalls, Esc stops. Paste images.")),
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
    this.cardsKey = "";
    this.headKey = "";
    this.stick = true;
    this.screen.replaceChildren(h("p", { class: "term-empty" }, "Starting Claude…"));
    this.source = new EventSource(withKey(`/api/live/${liveId}/events`));
    this.source.onmessage = (m) => this.apply(JSON.parse(m.data) as LiveUpdate);
    this.source.onerror = () => {
      // a passing hiccup reconnects by itself; a refused stream means the session is gone (Annex
      // restarted), which the person should be told rather than left looking at nothing
      if (this.source?.readyState === EventSource.CLOSED) {
        this.status = "closed";
        this.error = "Reconnecting: Annex restarted, and reopens the sessions that were open…";
        this.drawn = -1;
        this.draw();
        this.onGone(this.sessionId);
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

  private headKey = "";

  private drawHead() {
    // only when something in it changed, so an open dropdown is not rebuilt under your pointer
    const key = `${this.liveId}|${this.status}|${this.mode}|${this.model}|${this.cwd}|${this.sessionId}`;
    if (key === this.headKey) return;
    this.headKey = key;
    const name = this.cwd.split("/").filter(Boolean).pop() ?? this.cwd;
    const working = this.status === "working";
    const modeSel = h("select", { "aria-label": "Permission mode", disabled: this.status === "closed" }, ...Object.entries(MODE_LABEL).map(([v, label]) => h("option", { value: v, selected: v === this.mode }, label))) as HTMLSelectElement;
    modeSel.addEventListener("change", () => void this.post("mode", { mode: modeSel.value }));
    const family = (this.model ?? "").match(/opus|sonnet|haiku|fable/)?.[0] ?? "";
    const modelSel = h("select", { "aria-label": "Model", disabled: this.status === "closed" }, ...MODELS.filter(([v]) => v !== "default").map(([v, label]) => h("option", { value: v, selected: v === family }, label))) as HTMLSelectElement;
    modelSel.addEventListener("change", () => void this.post("model", { model: modelSel.value }));
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
        modelSel,
        h("button", { class: "btn", type: "button", disabled: !working, onclick: () => void this.post("interrupt") }, "Stop"),
        h("button", { class: "btn ghost", type: "button", disabled: this.status === "closed" && !this.sessionId, onclick: () => this.toTerminal(null) }, "Open in terminal"),
        h("button", { class: "btn ghost", type: "button", disabled: this.status === "closed", onclick: () => void this.post("close") }, "Close session"),
      ),
    );
  }

  // A tool waiting for your yes: what it wants to do, in full, and the three answers.
  private cardsKey = "";

  private drawCards() {
    // redrawn only when the set of questions changes, so choices you are making survive the stream
    const key = this.prompts.map((p) => p.id).join(",");
    if (key === this.cardsKey) return;
    this.cardsKey = key;
    this.cards.replaceChildren(
      ...this.prompts.map((p) => {
        if (p.tool === "AskUserQuestion") return this.questionCard(p);
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

  // Claude asking you something: each question with its options as buttons (several when Claude
  // allows several), an "Other" answer of your own, and Send. Skip tells Claude you did not answer.
  private questionCard(p: LivePrompt): HTMLElement {
    type Q = { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };
    const questions = (Array.isArray(p.input.questions) ? p.input.questions : []) as Q[];
    const chosen = new Map<string, Set<string>>();
    const others = new Map<string, HTMLInputElement>();
    const blocks = questions.map((q) => {
      const picked = new Set<string>();
      chosen.set(q.question, picked);
      const buttons = (q.options ?? []).map((o) => {
        const b = h("button", { type: "button", class: "choice", "aria-pressed": "false", title: o.description ?? "" }, h("b", {}, o.label), o.description ? h("span", {}, o.description) : null) as HTMLButtonElement;
        b.onclick = () => {
          if (!q.multiSelect) {
            picked.clear();
            for (const x of buttons) x.setAttribute("aria-pressed", "false");
          }
          if (picked.has(o.label)) picked.delete(o.label);
          else picked.add(o.label);
          b.setAttribute("aria-pressed", String(picked.has(o.label)));
        };
        return b;
      });
      const other = h("input", { placeholder: "Or answer in your own words", "aria-label": `Your own answer to: ${q.question}` }) as HTMLInputElement;
      others.set(q.question, other);
      return h(
        "fieldset",
        { class: "question" },
        h("legend", {}, q.header ? `${q.header}: ` : "", q.question, q.multiSelect ? " (choose any)" : ""),
        h("div", { class: "choices" }, ...buttons),
        other,
      );
    });
    const err = h("p", { class: "hint" });
    const send = () => {
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const own = others.get(q.question)!.value.trim();
        const picks = [...chosen.get(q.question)!];
        const a = [...picks, ...(own ? [own] : [])].join(", ");
        if (!a) {
          err.textContent = `Answer "${q.question}" first, or press Skip.`;
          return;
        }
        answers[q.question] = a;
      }
      void this.answer(p.id, { allow: true, answers });
    };
    return h(
      "div",
      { class: "prompt-card ask", role: "dialog", "aria-label": "Claude is asking you" },
      h("div", { class: "label" }, "Claude is asking you"),
      ...blocks,
      err,
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn primary", type: "button", onclick: send }, "Send answer"),
        h("button", { class: "btn ghost", type: "button", onclick: () => void this.answer(p.id, { allow: false, message: "The person skipped the question; carry on with your best judgement and say what you assumed." }) }, "Skip"),
      ),
    );
  }

  private async answer(promptId: string, d: { allow: boolean; always?: boolean; message?: string; answers?: Record<string, string> }) {
    await this.post("answer", { promptId, ...d });
  }

  // What you sent, newest last, for ↑ and ↓; and images waiting to go with the next message.
  private history: string[] = [];
  private historyAt = -1;
  private images: { name: string; mediaType: string; data: string }[] = [];
  private attachments = h("div", { class: "attachments" });

  private async send() {
    const text = this.input.value;
    if ((!text.trim() && !this.images.length) || !this.liveId) return;
    this.menu.hidden = true;
    // a command with only an interactive screen cannot run under `claude -p`; offer the terminal
    const t = needsTerminal(text, this.commands);
    if (t && !this.images.length) return this.toTerminal(t);
    // "!command": run it in the session's folder and give Claude the output, as the terminal does
    const bang = /^!\s*(\S[\s\S]*)$/.exec(text.trim());
    const ok = bang && !this.images.length
      ? await this.post("shell", { command: bang[1] })
      : await this.post("message", { text, images: this.images.map((i) => ({ mediaType: i.mediaType, data: i.data })) });
    if (ok) {
      if (text.trim()) this.history.push(text);
      this.historyAt = -1;
      this.input.value = "";
      this.images = [];
      this.drawAttachments();
      this.stick = true;
    }
  }

  // Closes this live session (one conversation never runs in two processes) and continues it in a
  // terminal pane, where `command` can be typed.
  private toTerminal(command: string | null) {
    const what = command ? `${command} works only in Claude Code's terminal screen. ` : "";
    if (!confirm(`${what}Close this live session and continue the conversation in a terminal?`)) return;
    this.menu.hidden = true;
    if (command) this.input.value = "";
    this.onTerminal(command);
  }

  private async addImage(file: File) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
    if (file.size > 5 * 1024 * 1024) {
      this.error = `${file.name || "That image"} is larger than 5 MB.`;
      return this.draw();
    }
    if (this.images.length >= 4) return;
    const data = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]+,/, ""));
      r.readAsDataURL(file);
    });
    this.images.push({ name: file.name || `pasted ${file.type.split("/")[1]}`, mediaType: file.type, data });
    this.drawAttachments();
  }

  private drawAttachments() {
    this.attachments.replaceChildren(
      ...this.images.map((img, i) =>
        h("span", { class: "chip" }, h("img", { src: `data:${img.mediaType};base64,${img.data}`, alt: "" }), img.name, h("button", { type: "button", "aria-label": `Remove ${img.name}`, onclick: () => { this.images.splice(i, 1); this.drawAttachments(); } }, "×")),
      ),
    );
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
  // Completion: "/" at the start lists the session's commands; "@" lists files in its folder.
  private completeTimer: ReturnType<typeof setTimeout> | null = null;

  private complete() {
    const v = this.input.value;
    const slash = /^\/([\w:.-]*)$/.exec(v);
    if (slash) {
      const q = slash[1]!.toLowerCase();
      const first = (a: string, b: string) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q));
      const hits = this.commands.filter((c) => c.toLowerCase().includes(q)).sort(first).slice(0, 8);
      // commands this session cannot run (and the bare /config screen) open in a terminal
      const elsewhere = TERMINAL_ONLY.filter((c) => c.includes(q) && (c === "config" || !this.commands.includes(c))).sort(first).slice(0, 4);
      const items = [
        ...hits.map((c): MenuItem => ({ label: `/${c}`, insert: `/${c} `, replace: [0, v.length] })),
        ...elsewhere.map((c): MenuItem => ({ label: `/${c}`, note: "opens in a terminal", insert: "", replace: [0, 0], run: () => this.toTerminal(`/${c}`) })),
      ];
      // what starts with what you typed comes first, from either list
      return this.showMenu(items.sort((a, b) => first(a.label.slice(1), b.label.slice(1))));
    }
    const caret = this.input.selectionStart ?? v.length;
    const at = /(^|\s)@([\w./-]*)$/.exec(v.slice(0, caret));
    if (at && this.liveId) {
      const from = caret - at[2]!.length - 1;
      if (this.completeTimer) clearTimeout(this.completeTimer);
      this.completeTimer = setTimeout(async () => {
        const r = await apiFetch(`/api/live/${this.liveId}/files?q=${encodeURIComponent(at[2]!)}`);
        const files = r.ok ? ((await r.json()) as string[]) : [];
        this.showMenu(files.map((f) => ({ label: `@${f}`, insert: `@${f} `, replace: [from, caret] })));
      }, 120);
      return;
    }
    this.menu.hidden = true;
  }

  private menuItems: MenuItem[] = [];

  private showMenu(items: MenuItem[]) {
    this.menuItems = items;
    this.menu.replaceChildren(...items.map((it, i) => h("li", { role: "option", "aria-selected": String(i === 0), onmousedown: (ev: Event) => { ev.preventDefault(); this.pick(i); } }, it.label, it.note ? h("span", { class: "note" }, it.note) : null)));
    this.menu.hidden = !items.length;
  }

  private pick(i: number) {
    const it = this.menuItems[i];
    if (!it) return;
    if (it.run) return it.run();
    const v = this.input.value;
    this.input.value = v.slice(0, it.replace[0]) + it.insert + v.slice(it.replace[1]);
    const caret = it.replace[0] + it.insert.length;
    this.input.setSelectionRange(caret, caret);
    this.menu.hidden = true;
    this.input.focus();
  }

  private keys(ev: KeyboardEvent) {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void this.send();
      return;
    }
    if (!this.menu.hidden) {
      const items = [...this.menu.children] as HTMLElement[];
      const at = items.findIndex((li) => li.getAttribute("aria-selected") === "true");
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const next = (at + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.setAttribute("aria-selected", String(i === next)));
      } else if (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey)) {
        ev.preventDefault();
        this.pick(Math.max(0, at));
      } else if (ev.key === "Escape") {
        this.menu.hidden = true;
      }
      return;
    }
    // Esc stops Claude, as in the terminal
    if (ev.key === "Escape" && this.status === "working") {
      ev.preventDefault();
      void this.post("interrupt");
      return;
    }
    // ↑ and ↓ step through what you sent, when the caret is on the first or last line
    const v = this.input.value;
    const caret = this.input.selectionStart ?? 0;
    if (ev.key === "ArrowUp" && !v.slice(0, caret).includes("\n") && this.history.length) {
      ev.preventDefault();
      this.historyAt = this.historyAt < 0 ? this.history.length - 1 : Math.max(0, this.historyAt - 1);
      this.input.value = this.history[this.historyAt]!;
    } else if (ev.key === "ArrowDown" && this.historyAt >= 0 && !v.slice(caret).includes("\n")) {
      ev.preventDefault();
      this.historyAt = this.historyAt + 1 < this.history.length ? this.historyAt + 1 : -1;
      this.input.value = this.historyAt < 0 ? "" : this.history[this.historyAt]!;
    }
  }
}

type MenuItem = { label: string; insert: string; replace: [number, number]; note?: string; run?: () => void };

function describeInput(p: LivePrompt): HTMLElement {
  const s = (k: string) => (typeof p.input[k] === "string" ? (p.input[k] as string) : "");
  // leaving plan mode: the plan is what you are approving
  if (p.tool === "ExitPlanMode") return h("pre", { class: "prompt-detail plan-text" }, s("plan") || "Claude wants to stop planning and start making changes.");
  if (p.tool === "Bash") return h("pre", { class: "prompt-detail" }, s("command"));
  // everything you are approving is shown; long input scrolls rather than being cut
  if (p.tool === "Write") return h("div", {}, h("p", { class: "prompt-path" }, s("file_path") ? fileLink(s("file_path")) : ""), h("pre", { class: "prompt-detail" }, s("content")));
  if (p.tool === "Edit") {
    const diff = [...s("old_string").split("\n").map((l) => `- ${l}`), ...s("new_string").split("\n").map((l) => `+ ${l}`)];
    return h("div", {}, h("p", { class: "prompt-path" }, s("file_path") ? fileLink(s("file_path")) : ""), h("pre", { class: "prompt-detail" }, ...diff.map((l) => h("div", { class: l.startsWith("+") ? "add" : "del" }, l))));
  }
  return h("pre", { class: "prompt-detail" }, JSON.stringify(p.input, null, 2));
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : p;
}
