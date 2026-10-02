// Every wing and everyone in it. Choosing a wing opens its case file; choosing an agent opens its
// terminal.

import type { StateView, WingView } from "../../server/api-types.ts";
import { h } from "./dom.ts";

const ROLE_LABEL = { lead: "Lead", worker: "Crew", reviewer: "Reviewer" } as const;

export function wingPill(w: WingView): HTMLElement {
  if (w.offline) return h("span", { class: "pill offline" }, "Offline");
  if (w.paused) return h("span", { class: "pill paused" }, "Paused");
  if (w.held) return h("span", { class: "pill held" }, "Held");
  return w.mode === "autonomous" ? h("span", { class: "pill own" }, "On its own") : h("span", { class: "pill with" }, "With you");
}

export class Sidebar {
  readonly el = h("aside", { class: "sidebar", "aria-label": "Wings and agents" });
  private status = h("p", { class: "status", role: "status" }, "Connecting...");
  private list = h("nav", { class: "wing-list" });
  private handlers: { wing: (id: string) => void; agent: (id: string) => void; newWing: () => void };

  constructor(handlers: { wing: (id: string) => void; agent: (id: string) => void; newWing: () => void }) {
    this.handlers = handlers;
    this.el.append(
      h("div", { class: "brand" }, h("h1", { class: "wordmark" }, "Annex"), this.status),
      this.list,
      h("button", { class: "new-wing", type: "button", onclick: () => this.handlers.newWing() }, "+ New wing"),
    );
  }

  setStatus(text: string, held = false) {
    this.status.textContent = text;
    this.status.classList.toggle("held", held);
  }

  render(state: StateView, selectedWing: string | null, selectedAgent: string | null) {
    this.list.replaceChildren(
      ...state.wings.map((w) => {
        const open = w.tasks.length;
        const head = h(
          "button",
          { class: `wing-head${w.id === selectedWing && !selectedAgent ? " selected" : ""}`, type: "button", onclick: () => this.handlers.wing(w.id) },
          h("span", { class: "name" }, w.name),
          w.asks.length ? h("span", { class: "pill ask", title: "The lead is asking for your approval" }, `${w.asks.length} ask`) : wingPill(w),
          h("span", { class: "count", title: `${open} open, ${w.filedCount} filed` }, `${open}·${w.filedCount}`),
        );
        const order = { lead: 0, worker: 1, reviewer: 2 } as const;
        const agents = [...w.agents].sort((a, b) => order[a.role] - order[b.role] || a.desk - b.desk);
        return h(
          "div",
          { class: "wing-group" },
          head,
          h(
            "ul",
            { class: "agents" },
            ...agents.map((a) => {
              const running = a.status === "running";
              return h(
                "li",
                {},
                h(
                  "button",
                  { class: `agent role-${a.role}${running ? " running" : ""}${a.id === selectedAgent ? " selected" : ""}`, type: "button", onclick: () => this.handlers.agent(a.id), "aria-label": `Open ${a.name}'s terminal` },
                  h("span", { class: "dot" }),
                  h("span", { class: "who" }, h("b", {}, a.name), h("small", {}, ROLE_LABEL[a.role])),
                  h("span", { class: "state" }, running ? "working" : "idle"),
                ),
              );
            }),
          ),
        );
      }),
    );
  }
}
