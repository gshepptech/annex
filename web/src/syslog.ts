// SYSTEM LOG: Annex's own record of what it decided and why, the same lines as
// .annex/logs/annex.log. Follows new lines while open.

import { h } from "./dom.ts";
import { apiFetch } from "./api.ts";

interface Line {
  id: number;
  at: string;
  level: "info" | "warn" | "error";
  wing: string | null;
  msg: string;
}

export function logDialog() {
  const list = h("ol", { class: "syslog" });
  const where = h("p", {});
  const filter = h("select", { "aria-label": "Show lines for" }, h("option", { value: "" }, "All offices")) as HTMLSelectElement;
  const el = h("dialog", { class: "box wide", "aria-label": "System log" }) as HTMLDialogElement;
  let last = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const wings = new Set<string>();

  const pull = async () => {
    const r = await apiFetch(`/api/logs?after=${last}`).catch(() => null);
    if (!r?.ok) return;
    const { file, lines } = (await r.json()) as { file: string | null; lines: Line[] };
    where.textContent = file ? `Also written to ${file}` : "";
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
    for (const l of lines) {
      last = Math.max(last, l.id);
      if (l.wing && !wings.has(l.wing)) {
        wings.add(l.wing);
        filter.append(h("option", { value: l.wing }, l.wing));
      }
      const t = new Date(l.at).toLocaleTimeString([], { hour12: false });
      list.append(h("li", { class: l.level, "data-wing": l.wing ?? "" }, h("time", {}, t), h("span", { class: "w" }, l.wing ?? "annex"), h("span", {}, l.msg)));
    }
    applyFilter();
    if (stick) list.scrollTop = list.scrollHeight;
  };

  const applyFilter = () => {
    for (const li of list.children) {
      const w = (li as HTMLElement).dataset.wing;
      (li as HTMLElement).hidden = !!filter.value && w !== filter.value && w !== "";
    }
  };
  filter.addEventListener("change", applyFilter);

  el.append(
    h(
      "div",
      { class: "pad" },
      h("div", { class: "row" }, h("h2", {}, "System log"), h("span", { style: "margin-left: auto" }), filter, h("button", { class: "btn", type: "button", onclick: () => el.close() }, "Close")),
      where,
      list,
    ),
  );
  el.addEventListener("close", () => {
    if (timer) clearInterval(timer);
    timer = null;
  });

  return {
    el,
    open() {
      el.showModal();
      void pull().then(() => (list.scrollTop = list.scrollHeight));
      timer = setInterval(() => void pull(), 3000);
    },
  };
}
