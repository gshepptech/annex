// SET UP ANNEX: what this Mac needs (Claude Code, its login, git, and GitHub for private repos),
// each with a Fix that runs in a terminal pane here, and a few lines on where to start. It opens
// by itself while something required is missing, so a new Mac never needs Terminal.app.

import type { SetupCheck, SetupFixId } from "../../server/api-types.ts";
import { get } from "./api.ts";
import { h } from "./dom.ts";

export class SetupDialog {
  readonly el = h("dialog", { class: "setup", "aria-label": "Set up Annex" }) as HTMLDialogElement;
  checks: SetupCheck[] = [];
  // called after every check, so the top bar can show or hide Finish setup
  onChecked: (missing: boolean) => void = () => {};
  private list = h("ol", { class: "setup-checks", "aria-live": "polite" });
  private note = h("p", { class: "hint", role: "status" });
  private fix: (id: SetupFixId) => void;

  constructor(fix: (id: SetupFixId) => void) {
    this.fix = fix;
    this.el.append(
      h(
        "div",
        { class: "pad" },
        h("h2", {}, "Set up Annex"),
        h("p", {}, "Annex runs your own Claude Code on your subscription. This is what it needs on this Mac. A fix opens in a terminal here; when it says Done, close that terminal and press Check again."),
        this.list,
        this.note,
        h("h3", {}, "Getting started"),
        h(
          "ol",
          { class: "getting-started" },
          h("li", {}, "Sign in to Claude above, if it says you are not signed in."),
          h("li", {}, h("b", {}, "Projects"), " in the top bar: add a folder you already have, make a new project, or clone one."),
          h("li", {}, h("b", {}, "New session"), " starts Claude Code in a project, the way claude starts in a terminal."),
          h("li", {}, h("b", {}, "+ New office"), " gives a project a lead and a crew that plan and do work, with you or on their own."),
        ),
        h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: () => void this.check(true) }, "Check again"), h("button", { class: "btn ghost", type: "button", onclick: () => this.el.close() }, "Close")),
      ),
    );
  }

  get missing(): boolean {
    return this.checks.some((c) => c.required && !c.ok);
  }

  async open() {
    if (!this.el.open) this.el.showModal();
    await this.check(true);
  }

  // `fresh` skips the server's few seconds of caching: Check again means now
  async check(fresh = false): Promise<void> {
    this.note.textContent = "Checking…";
    try {
      this.checks = await get<SetupCheck[]>(`/api/setup${fresh ? "?fresh=1" : ""}`);
      this.note.textContent = this.missing ? "" : "Everything Annex needs is here.";
    } catch (err) {
      this.note.textContent = `Could not check: ${(err as Error).message}`;
    }
    this.draw();
    this.onChecked(this.missing);
  }

  private draw() {
    this.list.replaceChildren(
      ...this.checks.map((c) =>
        h(
          "li",
          { class: `setup-check ${c.ok ? "ok" : c.required ? "bad" : "optional"}` },
          h("span", { class: "dot", "aria-hidden": "true" }),
          h("div", {}, h("b", {}, c.label), h("span", {}, c.detail)),
          c.fix && !c.ok
            ? h("button", { class: `btn${c.required ? " primary" : ""}`, type: "button", onclick: () => { this.el.close(); this.fix(c.fix!.id); } }, c.fix.label)
            : null,
        ),
      ),
    );
  }
}
