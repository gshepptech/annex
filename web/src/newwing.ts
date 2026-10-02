// "New wing": a wing file written for you. It starts with you, so nothing runs until you plan with
// its lead and hand it off.

import { post } from "./api.ts";
import { h } from "./dom.ts";

export function newWingDialog(done: (id: string) => void): HTMLDialogElement {
  const error = h("p", { class: "notice bad", hidden: true, role: "alert" });
  const name = h("input", { name: "name", required: true, placeholder: "Docs" });
  const id = h("input", { name: "id", required: true, pattern: "[a-z][a-z0-9\\-]{1,30}", placeholder: "docs" });
  // the id follows the name until it is edited by hand
  let idTouched = false;
  id.addEventListener("input", () => (idTouched = true));
  name.addEventListener("input", () => {
    if (!idTouched) id.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);
  });
  const dialog = h("dialog", { "aria-label": "New wing" }) as HTMLDialogElement;
  const form = h(
    "form",
    {
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        const f = new FormData(ev.target as HTMLFormElement);
        try {
          const r = (await post("/api/wings", Object.fromEntries(f.entries()))) as { id: string };
          dialog.close();
          (ev.target as HTMLFormElement).reset();
          idTouched = false;
          error.hidden = true;
          done(r.id);
        } catch (err) {
          error.textContent = (err as Error).message;
          error.hidden = false;
        }
      },
    },
    h("h2", {}, "New wing"),
    h("p", {}, "A new room with its own lead, crew and reviewer. It starts with you: plan with the lead, then hand it off."),
    error,
    h("div", { class: "two" }, h("div", { class: "field" }, h("label", {}, "Name", name)), h("div", { class: "field" }, h("label", {}, "Id", id))),
    h("div", { class: "field" }, h("label", {}, "Repo (optional)", h("input", { name: "repoPath", placeholder: "~/Projects/my-app" }))),
    h("div", { class: "field" }, h("label", {}, "Base branch", h("input", { name: "baseBranch", value: "main" }))),
    h("div", { class: "field" }, h("label", {}, "Charter (optional)", h("textarea", { name: "charter", rows: 3, placeholder: "What should this wing keep true?" }))),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Open the wing"), h("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel")),
  );
  dialog.append(form);
  return dialog;
}
