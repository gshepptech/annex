// The director's desk: one conversation above every office. It answers from a line per office and
// routes work into them; what it did is listed under each reply.

import type { DirectorView } from "../../server/api-types.ts";
import { post } from "./api.ts";
import { h } from "./dom.ts";
import { portrait } from "./portrait.ts";

export class DirectorDesk {
  readonly el = h("section", { class: "panel director", "aria-label": "Director" });
  private view: DirectorView | null = null;
  private busy = false;
  private error = "";
  private onBack: () => void;
  private refresh: () => void;
  private lastKey = "";

  constructor(onBack: () => void, refresh: () => void) {
    this.onBack = onBack;
    this.refresh = refresh;
  }

  show(view: DirectorView | null) {
    this.view = view;
    const key = JSON.stringify([view?.chat.length, view?.offline, view?.status, this.busy, this.error]);
    if (key === this.lastKey && this.el.childElementCount) return;
    this.lastKey = key;
    this.draw();
  }

  private async send(text: string, box: HTMLTextAreaElement) {
    this.busy = true;
    this.error = "";
    this.draw();
    try {
      await post("/api/director", { text });
      box.value = "";
      this.refresh();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.busy = false;
      this.lastKey = "";
      this.draw();
    }
  }

  private draw() {
    const v = this.view;
    const kept = (this.el.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? "";
    const hadFocus = this.el.contains(document.activeElement);
    this.el.replaceChildren();
    const thinking = v?.status === "running";
    this.el.append(
      h(
        "header",
        { class: "term-head", style: "--c: var(--annex)" },
        h("button", { class: "back", type: "button", onclick: () => this.onBack() }, "◀ OFFICES"),
        portrait("director", 0, 52, "big"),
        h("h2", {}, "DIRECTOR"),
        h("div", { class: "meta" }, h("span", {}, "sees every office, one line each · routes work to their leads"), thinking ? h("span", { class: "live" }, "● THINKING") : null),
      ),
    );
    if (v?.offline) this.el.append(h("p", { class: "notice bad" }, `The director is not connected: ${v.offline}`));
    if (this.error) this.el.append(h("p", { class: "notice bad", role: "alert" }, this.error));
    const list = h("ol", { class: "chat" }, ...(v?.chat ?? []).map((m) => h("li", { class: m.who === "you" ? "you" : "lead director-line" }, h("b", {}, m.who === "you" ? "YOU" : "DIRECTOR"), h("p", {}, m.text))));
    if (!v?.chat.length) {
      list.append(h("li", { class: "empty" }, 'Ask how the offices are doing, or tell the director what you want done: "have Upkeep check the README", "open an office for ~/Projects/colophon", "hire one more for Upkeep".'));
    }
    const box = h("textarea", { rows: 3, required: true, placeholder: "Tell the director", "aria-label": "Message the director" }) as HTMLTextAreaElement;
    box.value = kept;
    box.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) box.form?.requestSubmit();
    });
    this.el.append(
      h(
        "div",
        { class: "tab-body" },
        list,
        h(
          "form",
          { onsubmit: (ev: Event) => { ev.preventDefault(); if (box.value.trim()) void this.send(box.value, box); } },
          box,
          h("button", { class: "btn primary", type: "submit", disabled: this.busy || !!v?.offline }, this.busy ? "SENDING..." : "SEND ⌘↵"),
        ),
      ),
    );
    if (hadFocus) box.focus();
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
  }
}
