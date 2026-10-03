// The party: every office and everyone in it. Choosing an office opens its file; choosing a member
// opens their terminal.

import type { StateView, WingView, SessionView } from "../../server/api-types.ts";
import { h } from "./dom.ts";
import { portrait, faceIndex } from "./portrait.ts";

const CLASS = { lead: "Lead", worker: "Crew", reviewer: "Reviewer" } as const;

export function officeBadge(w: WingView): HTMLElement {
  if (w.offline) return h("span", { class: "badge offline" }, "Offline");
  if (w.paused) return h("span", { class: "badge paused" }, "Paused");
  if (w.held) return h("span", { class: "badge held" }, "Closed");
  return w.mode === "autonomous" ? h("span", { class: "badge own" }, "On its own") : h("span", { class: "badge with" }, "With you");
}

export class Sidebar {
  readonly el = h("aside", { class: "roster box", "aria-label": "Offices and crew" });
  private list = h("nav", { class: "office-list" });
  private handlers: { wing: (id: string) => void; agent: (id: string) => void; newWing: () => void; session: (id: string) => void };

  constructor(handlers: { wing: (id: string) => void; agent: (id: string) => void; newWing: () => void; session: (id: string) => void }) {
    this.handlers = handlers;
    this.el.append(
      h("h2", { class: "panel-title" }, "Offices"),
      this.list,
      h("button", { class: "new-office", type: "button", onclick: () => this.handlers.newWing() }, "+ New office"),
    );
  }

  render(state: StateView, selectedWing: string | null, selectedAgent: string | null, sessions: SessionView[] = []) {
    const desk = sessions.length
      ? h(
          "div",
          { class: "office" },
          h("div", { class: "office-head desk-head" }, h("span", { class: "title" }, "Your desk"), h("span", { class: "count" }, String(sessions.length))),
          h(
            "ul",
            { class: "members" },
            ...sessions.map((s, i) =>
              h(
                "li",
                {},
                h(
                  "button",
                  { class: `member who-you${s.status === "working" ? " working" : ""}${s.id === selectedAgent ? " selected" : ""}`, type: "button", onclick: () => this.handlers.session(s.id), "aria-label": `Open your ${s.title} session` },
                  portrait("worker", i + 2, 34, "portrait"),
                  h(
                    "span",
                    { class: "info" },
                    h("b", {}, s.title),
                    h("span", { class: "cls" }, s.branch ?? "no branch"),
                    h("span", { class: "bar", "aria-hidden": "true" }, h("i", {})),
                    h("span", { class: "line" }, h("span", { class: "st" }, s.status === "working" ? "working" : "waiting"), h("span", {}, ago(s.updatedAt))),
                  ),
                ),
              ),
            ),
          ),
        )
      : null;
    this.list.replaceChildren(
      ...(desk ? [desk] : []),
      ...state.wings.map((w) => {
        const head = h(
          "button",
          { class: `office-head${w.id === selectedWing && !selectedAgent ? " selected" : ""}`, type: "button", onclick: () => this.handlers.wing(w.id) },
          h("span", { class: "title" }, w.name),
          w.asks.length ? h("span", { class: "badge ask-count", title: "The lead is asking for your approval" }, `${w.asks.length} ask${w.asks.length === 1 ? "" : "s"}`) : officeBadge(w),
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
                    h("span", { class: "line" }, h("span", { class: "st" }, state), h("span", { title: "Tasks this agent got filed as verified" }, `${a.filed} verified`)),
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

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}
