// The case file for the selected wing: what it is doing, what it said, and the controls that
// change its mode.

import type { WingView } from "../../server/api-types.ts";
import type { BourneEvent } from "../../server/events.ts";
import { describe } from "./log.ts";
import { post } from "./api.ts";
import { h } from "./dom.ts";

type Tab = "log" | "talk" | "brief" | "settings";

export class Panel {
  readonly el = h("aside", { class: "panel", "aria-label": "Selected wing" });
  private wing: WingView | null = null;
  private tab: Tab = "log";
  private events: BourneEvent[] = [];
  private busy = "";
  private error = "";

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
    }
    this.render();
  }

  push(e: BourneEvent) {
    if (!this.wing || e.wingId !== this.wing.id) return;
    this.events.push(e);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    if (this.tab === "log") {
      const list = this.el.querySelector(".log");
      if (list) {
        list.append(this.logItem(e));
        list.scrollTop = list.scrollHeight;
      }
    }
  }

  private nameOf = (id: string) => this.wing?.agents.find((a) => a.id === id)?.name ?? "someone";
  private titleOf = (id: string) => this.wing?.tasks.find((t) => t.id === id)?.title ?? "a task";

  private logItem(e: BourneEvent) {
    const l = describe(e, this.nameOf, this.titleOf);
    return h("li", { class: `tone-${l.tone}` }, h("time", {}, l.time), h("b", {}, l.who), h("span", {}, l.text));
  }

  // `after` runs only when the request succeeded, before the panel redraws.
  private async act(label: string, path: string, body: unknown = {}, after?: () => void) {
    this.busy = label;
    this.error = "";
    this.render();
    try {
      await post(path, body);
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
    for (const f of this.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
      fields.set(f.getAttribute("aria-label") ?? "", f.value);
    }
    const focused = (document.activeElement as HTMLElement | null)?.getAttribute?.("aria-label");
    this.draw();
    for (const f of this.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
      const label = f.getAttribute("aria-label") ?? "";
      if (fields.has(label)) f.value = fields.get(label)!;
      if (label === focused) f.focus();
    }
  }

  private clearField(label: string) {
    const f = this.el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
    if (f) f.value = "";
  }

  private draw() {
    const w = this.wing;
    this.el.replaceChildren();
    if (!w) return;
    const base = `/api/wings/${encodeURIComponent(w.id)}`;

    const primary =
      w.mode === "with_you"
        ? h("button", { class: "primary", type: "button", disabled: !!this.busy || !!w.offline, onclick: () => this.act("Asking the lead to write the brief", `${base}/handoff`, {}, () => (this.tab = "brief")) }, "Hand off")
        : h("button", { class: "primary", type: "button", disabled: !!this.busy || !!w.offline, onclick: () => this.act("Bringing the lead back", `${base}/come-back`) }, "Come back in");

    this.el.append(
      h(
        "header",
        { class: "panel-head" },
        h("p", { class: "eyebrow" }, w.mode === "autonomous" ? "On its own" : "With you"),
        h("h2", {}, w.name),
        primary,
      ),
    );
    if (w.offline) this.el.append(h("p", { class: "notice bad" }, `Not connected to the engine: ${w.offline}`));
    if (w.held) {
      const until = w.held.until ? ` until ${new Date(w.held.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
      this.el.append(h("p", { class: "notice ask" }, `Held${until}: ${w.held.reason}. It starts again by itself.`));
    }
    if (this.busy) this.el.append(h("p", { class: "notice" }, `${this.busy}...`));
    if (this.error) this.el.append(h("p", { class: "notice bad", role: "alert" }, this.error));

    const tabs: [Tab, string][] = [["log", "Log"], ["talk", "Talk"], ["brief", "Brief"], ["settings", "Settings"]];
    this.el.append(
      h(
        "nav",
        { class: "tabs", role: "tablist" },
        ...tabs.map(([id, label]) =>
          h("button", { type: "button", role: "tab", "aria-selected": String(this.tab === id), onclick: () => { this.tab = id; this.render(); } }, label),
        ),
      ),
    );

    const body = h("div", { class: "tab-body", role: "tabpanel" });
    this.el.append(body);

    if (this.tab === "log") {
      const list = h("ol", { class: "log" }, ...this.events.map((e) => this.logItem(e)));
      if (this.events.length === 0) list.append(h("li", { class: "empty" }, "Nothing has happened in this wing yet."));
      const title = h("input", { name: "title", required: true, placeholder: "What needs doing", "aria-label": "Task title" });
      const detail = h("textarea", { name: "detail", rows: 3, placeholder: "Details the lead should know (optional)", "aria-label": "Task details" });
      const form = h(
        "form",
        {
          class: "drop-in",
          onsubmit: (ev: Event) => {
            ev.preventDefault();
            void this.act("Adding it to the inbox", `${base}/tasks`, { title: title.value, detail: detail.value }, () =>
              ["Task title", "Task details"].forEach((l) => this.clearField(l)),
            );
          },
        },
        h("h3", {}, "Drop in a task"),
        title,
        detail,
        h("button", { type: "submit", disabled: !!this.busy || !!w.offline }, `Add to ${w.name}'s inbox`),
      );
      body.append(list, form);
      requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
    }

    if (this.tab === "talk") {
      if (w.mode === "autonomous") {
        body.append(h("p", { class: "empty" }, `${w.name} is on its own. Come back in to talk with its lead, or drop in a task from the Log.`));
      } else {
        const list = h(
          "ol",
          { class: "chat" },
          ...w.chat.map((m) => h("li", { class: m.who }, h("b", {}, m.who === "you" ? "You" : "Lead"), h("p", {}, m.text))),
        );
        if (w.chat.length === 0) list.append(h("li", { class: "empty" }, "Tell the lead what you want this wing to work on. When you're done planning, press Hand off."));
        const text = h("textarea", { rows: 3, required: true, placeholder: "Message the lead", "aria-label": "Message the lead" });
        const form = h(
          "form",
          { class: "say", onsubmit: (ev: Event) => { ev.preventDefault(); void this.act("Sending", `${base}/chat`, { text: text.value }, () => this.clearField("Message the lead")); } },
          text,
          h("button", { type: "submit", disabled: !!this.busy || !!w.offline }, "Send"),
        );
        body.append(list, form);
        requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
      }
    }

    if (this.tab === "brief") {
      if (w.draft) {
        body.append(
          h("h3", {}, `Draft brief, version ${w.draft.version}`),
          h("pre", { class: "brief draft" }, w.draft.text),
          h(
            "div",
            { class: "row" },
            h("button", { class: "primary", type: "button", disabled: !!this.busy, onclick: () => this.act("Handing off", `${base}/briefs/${w.draft!.id}/approve`) }, "Approve and hand off"),
            h("button", { type: "button", onclick: () => { this.tab = "talk"; this.render(); } }, "Keep talking"),
          ),
        );
      }
      if (w.brief) {
        body.append(h("h3", {}, `Brief in force, version ${w.brief.version}`), h("pre", { class: "brief" }, w.brief.text));
      }
      if (!w.draft && !w.brief) {
        body.append(h("p", { class: "empty" }, w.charter ? "This wing runs on its charter from the wing file:" : "No brief yet. Plan with the lead in Talk, then press Hand off and it writes one for you to approve."));
        if (w.charter) body.append(h("pre", { class: "brief" }, w.charter));
      }
    }

    if (this.tab === "settings") {
      const s = w.settings;
      const row = (k: string, v: string) => h("div", {}, h("dt", {}, k), h("dd", {}, v));
      body.append(
        h(
          "dl",
          { class: "settings" },
          row("Wakes every", s.wakeEvery),
          row("Runs per hour", s.maxRunsPerHour === null ? "No limit" : String(s.maxRunsPerHour)),
          row("Quiet hours", s.quietHours ?? "None"),
          row("Backs off when idle", s.backOffWhenIdle ? "Yes" : "No"),
          row("Asks you before", s.askBefore.length ? s.askBefore.join(", ") : "Nothing"),
          row("Repo", w.repo ?? "None"),
          row("Integration branch", w.integrationBranch ?? "None"),
        ),
        h("p", { class: "hint" }, `Change these in wings/${w.id}/wing.toml. Annex reads the file again when it changes.`),
      );
    }
  }
}
