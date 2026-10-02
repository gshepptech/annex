// The party: every office and everyone in it. Choosing an office opens its file; choosing a member
// opens their terminal.

import type { StateView, WingView } from "../../server/api-types.ts";
import { h } from "./dom.ts";
import { portrait, faceIndex } from "./portrait.ts";

const CLASS = { lead: "LEAD", worker: "CREW", reviewer: "REVIEWER" } as const;

export function officeBadge(w: WingView): HTMLElement {
  if (w.offline) return h("span", { class: "badge offline" }, "OFFLINE");
  if (w.paused) return h("span", { class: "badge paused" }, "PAUSED");
  if (w.held) return h("span", { class: "badge held" }, "CLOSED");
  return w.mode === "autonomous" ? h("span", { class: "badge own" }, "ON ITS OWN") : h("span", { class: "badge with" }, "WITH YOU");
}

export class Sidebar {
  readonly el = h("aside", { class: "roster box", "aria-label": "Offices and crew" });
  private list = h("nav", { class: "office-list" });
  private handlers: { wing: (id: string) => void; agent: (id: string) => void; newWing: () => void };

  constructor(handlers: { wing: (id: string) => void; agent: (id: string) => void; newWing: () => void }) {
    this.handlers = handlers;
    this.el.append(
      h("h2", { class: "panel-title" }, "PARTY"),
      this.list,
      h("button", { class: "new-office", type: "button", onclick: () => this.handlers.newWing() }, "+ NEW OFFICE"),
    );
  }

  render(state: StateView, selectedWing: string | null, selectedAgent: string | null) {
    this.list.replaceChildren(
      ...state.wings.map((w) => {
        const head = h(
          "button",
          { class: `office-head${w.id === selectedWing && !selectedAgent ? " selected" : ""}`, type: "button", onclick: () => this.handlers.wing(w.id) },
          h("span", { class: "title" }, w.name.toUpperCase()),
          w.asks.length ? h("span", { class: "badge quest", title: "The lead is asking for your approval" }, `! ${w.asks.length}`) : officeBadge(w),
          h("span", { class: "count", title: `${w.tasks.length} open, ${w.filedCount} filed` }, `${w.tasks.length}/${w.filedCount}`),
        );
        const order = { lead: 0, worker: 1, reviewer: 2 } as const;
        const members = [...w.agents].sort((x, y) => order[x.role] - order[y.role] || x.desk - y.desk);
        return h(
          "div",
          { class: "office" },
          head,
          h(
            "ul",
            { class: "members" },
            ...members.map((a) => {
              const working = a.status === "running";
              const state = w.held ? "zzz" : working ? "working" : "idle";
              return h(
                "li",
                {},
                h(
                  "button",
                  { class: `member role-${a.role}${working ? " working" : ""}${a.id === selectedAgent ? " selected" : ""}`, type: "button", onclick: () => this.handlers.agent(a.id), "aria-label": `Open ${a.name}'s terminal` },
                  portrait(a.role, faceIndex(a), 34, "portrait"),
                  h(
                    "span",
                    { class: "info" },
                    h("b", {}, a.name),
                    h("span", { class: "cls" }, CLASS[a.role]),
                    h("span", { class: "bar", "aria-hidden": "true" }, h("i", {})),
                    h("span", { class: "line" }, h("span", { class: "st" }, state), h("span", { title: "Tasks this agent got filed as verified" }, `★${a.filed}`)),
                  ),
                ),
              );
            }),
          ),
        );
      }),
    );
  }
}
