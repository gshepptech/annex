// The case file for the selected wing: what it is doing, what the lead is asking, the chat, the
// brief, and every setting, which can be changed here and apply at once.

import type { WingView, WingEdit } from "../../server/api-types.ts";
import type { BourneEvent } from "../../server/events.ts";
import { describe } from "./log.ts";
import { post } from "./api.ts";
import { h } from "./dom.ts";
import { wingPill } from "./sidebar.ts";

type Tab = "log" | "talk" | "brief" | "settings";

const MODELS = ["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"];

export class Panel {
  readonly el = h("section", { class: "panel", "aria-label": "Selected wing" });
  private wing: WingView | null = null;
  private tab: Tab = "log";
  private events: BourneEvent[] = [];
  private busy = "";
  private error = "";
  private saved = "";
  private refresh: () => void;

  constructor(refresh: () => void) {
    this.refresh = refresh;
  }

  show(wing: WingView, events: BourneEvent[]) {
    const switched = this.wing?.id !== wing.id;
    this.wing = wing;
    this.events = events.filter((e) => e.wingId === wing.id);
    if (switched) {
      this.tab = wing.mode === "with_you" ? "talk" : "log";
      this.error = "";
      this.saved = "";
    }
    // a settings form being edited is not redrawn under the person's hands
    if (!switched && this.tab === "settings" && this.el.contains(document.activeElement)) return;
    this.render();
  }

  push(e: BourneEvent) {
    if (!this.wing || e.wingId !== this.wing.id) return;
    this.events.push(e);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    if (this.tab === "log") {
      const list = this.el.querySelector(".log");
      if (list) {
        list.querySelector(".empty")?.remove();
        list.append(this.logItem(e));
        list.scrollTop = list.scrollHeight;
      }
    }
  }

  private nameOf = (id: string) => this.wing?.agents.find((a) => a.id === id)?.name ?? "someone";
  private roleOf = (id: string) => (id === "you" ? "who-you" : id === "annex" ? "who-annex" : `role-${this.wing?.agents.find((a) => a.id === id)?.role ?? "worker"}`);
  private titleOf = (id: string) => this.wing?.tasks.find((t) => t.id === id)?.title ?? "a task";

  private logItem(e: BourneEvent) {
    const l = describe(e, this.nameOf, this.titleOf);
    return h("li", { class: `tone-${l.tone} ${this.roleOf(e.actor)}` }, h("time", {}, l.time), h("b", {}, l.who), h("span", {}, l.text));
  }

  // `after` runs only when the request succeeded, before the panel redraws.
  private async act(label: string, path: string, body: unknown = {}, after?: () => void, method = "POST") {
    this.busy = label;
    this.error = "";
    this.saved = "";
    this.render();
    try {
      if (method === "POST") {
        await post(path, body);
      } else {
        const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
      }
      after?.();
      this.refresh();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.busy = "";
      this.render();
    }
  }

  private render() {
    // keep anything half-typed, and the cursor, across re-renders
    const fields = new Map<string, string>();
    for (const f of this.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-keep]")) fields.set(f.dataset.keep!, f.value);
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.keep;
    this.draw();
    for (const f of this.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-keep]")) {
      const k = f.dataset.keep!;
      if (fields.has(k)) f.value = fields.get(k)!;
      if (k === focused) f.focus();
    }
  }

  private clear(...keys: string[]) {
    for (const k of keys) {
      const f = this.el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-keep="${k}"]`);
      if (f) f.value = "";
    }
  }

  private draw() {
    const w = this.wing;
    this.el.replaceChildren();
    if (!w) return;
    const base = `/api/wings/${encodeURIComponent(w.id)}`;
    const busy = !!this.busy;

    const modeButton =
      w.mode === "with_you"
        ? h("button", { class: "btn primary", type: "button", disabled: busy || !!w.offline, onclick: () => this.act("Asking the lead to write the brief", `${base}/handoff`, {}, () => (this.tab = "brief")) }, "Hand off")
        : h("button", { class: "btn primary", type: "button", disabled: busy || !!w.offline, onclick: () => this.act("Bringing the lead back", `${base}/come-back`, {}, () => (this.tab = "talk")) }, "Come back in");
    const holdButton = w.held
      ? h("button", { class: "btn", type: "button", disabled: busy, onclick: () => this.act("Resuming", `${base}/resume`) }, w.paused ? "Resume" : "Resume now")
      : h("button", { class: "btn ghost", type: "button", disabled: busy, onclick: () => this.act("Pausing", `${base}/pause`) }, "Pause");

    this.el.append(
      h(
        "header",
        { class: "panel-head" },
        h("div", { class: "row-top" }, wingPill(w)),
        h("h2", {}, w.name),
        h("p", { class: "where" }, w.repo ? `${w.repo.replace(/^\/Users\/[^/]+/, "~")} → ${w.integrationBranch}` : "No repo yet. Set one in Settings to hand this wing off."),
        h("div", { class: "actions" }, modeButton, holdButton),
      ),
    );
    if (w.offline) this.el.append(h("p", { class: "notice bad" }, `Not connected to the engine: ${w.offline}`));
    if (w.held && !w.paused) {
      const until = w.held.until ? new Date(w.held.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
      this.el.append(h("div", { class: "notice warn" }, h("span", {}, `Held${until ? ` until ${until}` : ""}: ${w.held.reason}. It starts again by itself.`)));
    }
    if (this.busy) this.el.append(h("p", { class: "notice" }, `${this.busy}...`));
    if (this.error) this.el.append(h("p", { class: "notice bad", role: "alert" }, this.error));

    if (w.asks.length) {
      this.el.append(
        h(
          "div",
          { class: "asks" },
          ...w.asks.map((a) =>
            h(
              "div",
              { class: "ask" },
              h("div", { class: "label" }, "The lead is asking"),
              h("h3", {}, a.title),
              h("p", {}, a.reason),
              h(
                "div",
                { class: "row" },
                h("button", { class: "btn good", type: "button", disabled: busy, onclick: () => this.act("Approving", `${base}/asks/${a.id}/approve`) }, "Approve and start"),
                h("button", { class: "btn bad", type: "button", disabled: busy, onclick: () => this.act("Declining", `${base}/asks/${a.id}/decline`) }, "Decline"),
              ),
            ),
          ),
        ),
      );
    }

    const tabs: [Tab, string, number][] = [["log", "Log", 0], ["talk", "Talk", 0], ["brief", "Brief", w.draft ? 1 : 0], ["settings", "Settings", 0]];
    this.el.append(
      h(
        "nav",
        { class: "tabs", role: "tablist" },
        ...tabs.map(([id, label, badge]) =>
          h("button", { type: "button", role: "tab", "aria-selected": String(this.tab === id), onclick: () => { this.tab = id; this.saved = ""; this.render(); } }, label, badge ? h("span", { class: "badge" }, String(badge)) : null),
        ),
      ),
    );
    const body = h("div", { class: "tab-body", role: "tabpanel" });
    this.el.append(body);

    if (this.tab === "log") this.drawLog(body, w, base, busy);
    if (this.tab === "talk") this.drawTalk(body, w, base, busy);
    if (this.tab === "brief") this.drawBrief(body, w, base, busy);
    if (this.tab === "settings") this.drawSettings(body, w, base, busy);
  }

  private drawLog(body: HTMLElement, w: WingView, base: string, busy: boolean) {
    const list = h("ol", { class: "log" }, ...this.events.map((e) => this.logItem(e)));
    if (this.events.length === 0) list.append(h("li", { class: "empty" }, "Nothing has happened in this wing yet."));
    const title = h("input", { "data-keep": "title", required: true, placeholder: "What needs doing", "aria-label": "Task title" });
    const detail = h("textarea", { "data-keep": "detail", rows: 2, placeholder: "Details the lead should know (optional)", "aria-label": "Task details" });
    body.append(
      list,
      h(
        "form",
        {
          onsubmit: (ev: Event) => {
            ev.preventDefault();
            void this.act("Adding it to the inbox", `${base}/tasks`, { title: title.value, detail: detail.value }, () => this.clear("title", "detail"));
          },
        },
        h("h3", {}, "Drop in a task"),
        title,
        detail,
        h("button", { class: "btn", type: "submit", disabled: busy || !!w.offline }, `Add to ${w.name}'s inbox`),
      ),
    );
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
  }

  private drawTalk(body: HTMLElement, w: WingView, base: string, busy: boolean) {
    if (w.mode === "autonomous") {
      body.append(h("p", { class: "empty" }, `${w.name} is on its own. Press Come back in to talk with its lead, or drop in a task from the Log.`));
      return;
    }
    const list = h("ol", { class: "chat" }, ...w.chat.map((m) => h("li", { class: m.who }, h("b", {}, m.who === "you" ? "You" : "Lead"), h("p", {}, m.text))));
    if (w.chat.length === 0) list.append(h("li", { class: "empty" }, "Tell the lead what this wing should work on. When you're done planning, press Hand off."));
    const text = h("textarea", { "data-keep": "message", rows: 3, required: true, placeholder: "Message the lead", "aria-label": "Message the lead" });
    text.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) (ev.target as HTMLTextAreaElement).form?.requestSubmit();
    });
    body.append(
      list,
      h(
        "form",
        { onsubmit: (ev: Event) => { ev.preventDefault(); void this.act("Sending", `${base}/chat`, { text: text.value }, () => this.clear("message")); } },
        text,
        h("button", { class: "btn", type: "submit", disabled: busy || !!w.offline }, "Send  ⌘↵"),
      ),
    );
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
  }

  private drawBrief(body: HTMLElement, w: WingView, base: string, busy: boolean) {
    if (w.draft) {
      body.append(
        h("h3", {}, `Draft brief, version ${w.draft.version}`),
        h("pre", { class: "brief draft" }, w.draft.text),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn primary", type: "button", disabled: busy, onclick: () => this.act("Handing off", `${base}/briefs/${w.draft!.id}/approve`) }, "Approve and hand off"),
          h("button", { class: "btn", type: "button", onclick: () => { this.tab = "talk"; this.render(); } }, "Keep talking"),
        ),
      );
    }
    if (w.brief) body.append(h("h3", {}, `Brief in force, version ${w.brief.version}`), h("pre", { class: "brief" }, w.brief.text));
    if (!w.draft && !w.brief) {
      body.append(h("p", { class: "empty" }, w.charter ? "This wing runs on its charter:" : "No brief yet. Plan with the lead in Talk, then press Hand off and it writes one for you to approve."));
      if (w.charter) body.append(h("pre", { class: "brief" }, w.charter));
    }
  }

  private drawSettings(body: HTMLElement, w: WingView, base: string, busy: boolean) {
    const e = w.edit;
    const s = w.settings;
    const input = (k: string, value: string, attrs: Record<string, string | number | boolean> = {}) => h("input", { "data-keep": `set-${k}`, name: k, value, ...attrs });
    const field = (label: string, control: HTMLElement, hint?: string) => h("div", { class: "field" }, h("label", {}, label, control), hint ? h("span", { class: "hint" }, hint) : null);
    const backoff = h("input", { type: "checkbox", name: "backOffWhenIdle", checked: s.backOffWhenIdle, id: "backoff" });
    const charter = h("textarea", { "data-keep": "set-charter", name: "charter", rows: 5 });
    charter.value = e.charter;
    const askBefore = h("textarea", { "data-keep": "set-askBefore", name: "askBefore", rows: 3, placeholder: "One per line, e.g. adding a new dependency" });
    askBefore.value = s.askBefore.join("\n");

    const form = h(
      "form",
      {
        class: "settings-form",
        onsubmit: (ev: Event) => {
          ev.preventDefault();
          const f = new FormData(ev.target as HTMLFormElement);
          const val = (k: string) => String(f.get(k) ?? "").trim();
          const edit: WingEdit = {
            name: val("name"),
            charter: val("charter"),
            repoPath: val("repoPath") || null,
            baseBranch: val("baseBranch") || "main",
            doneCheck: val("doneCheck") || null,
            setup: val("setup") || null,
            workers: Number(val("workers")),
            leadModel: val("leadModel"),
            workerModel: val("workerModel"),
            reviewerModel: val("reviewerModel"),
            wakeEvery: val("wakeEvery"),
            maxRunsPerHour: val("maxRunsPerHour") ? Number(val("maxRunsPerHour")) : null,
            quietHours: val("quietFrom") && val("quietTo") ? `${val("quietFrom")}-${val("quietTo")}` : null,
            backOffWhenIdle: backoff.checked,
            askBefore: val("askBefore").split("\n"),
            allow: val("allow").split(/[,\s]+/).filter(Boolean),
          };
          void this.act("Saving and applying", base, edit, () => (this.saved = "Saved. The wing is using the new settings."), "PUT");
        },
      },
      h("datalist", { id: "models" }, ...MODELS.map((m) => h("option", { value: m }))),
      h(
        "fieldset",
        {},
        h("legend", {}, "The wing"),
        field("Name", input("name", e.name, { required: true })),
        field("Charter", charter, "What the lead works toward. Each task must quote a line of it."),
        h("div", { class: "two" }, field("Repo", input("repoPath", e.repoPath ?? "", { placeholder: "~/Projects/my-app" })), field("Base branch", input("baseBranch", e.baseBranch))),
        field("Done check", input("doneCheck", e.doneCheck ?? "", { placeholder: "npm test" }), "Annex runs this itself before a task can count as done."),
        field("Setup", input("setup", e.setup ?? "", { placeholder: "npm ci" }), "Run in a fresh worktree before checks."),
      ),
      h(
        "fieldset",
        {},
        h("legend", {}, "The crew"),
        field("Workers", input("workers", String(e.workers), { type: "number", min: 1, max: 8 })),
        h("div", { class: "two" }, field("Lead model", input("leadModel", e.leadModel, { list: "models" })), field("Crew model", input("workerModel", e.workerModel, { list: "models" }))),
        field("Reviewer model", input("reviewerModel", e.reviewerModel, { list: "models" })),
        field("Commands the crew may run", input("allow", e.allow.join(", "), { placeholder: "npm, npx, node" })),
      ),
      h(
        "fieldset",
        {},
        h("legend", {}, "Pace and limits (all optional)"),
        h("div", { class: "two" }, field("Wake every", input("wakeEvery", s.wakeEvery, { placeholder: "15m" })), field("Runs per hour", input("maxRunsPerHour", s.maxRunsPerHour === null ? "" : String(s.maxRunsPerHour), { type: "number", min: 1, placeholder: "No limit" }))),
        h("div", { class: "two" }, field("Quiet from", input("quietFrom", s.quietHours?.split("-")[0] ?? "", { type: "time" })), field("Quiet until", input("quietTo", s.quietHours?.split("-")[1] ?? "", { type: "time" }))),
        h("div", { class: "field check" }, backoff, h("label", { for: "backoff" }, "Back off when idle: wait longer after wakes that found nothing")),
        field("Ask me before", askBefore, "The lead raises its hand for these instead of starting them."),
      ),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", disabled: busy }, "Save settings"), this.saved ? h("span", { class: "saved" }, this.saved) : null),
    );
    body.append(form);
  }
}
