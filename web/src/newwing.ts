// "New office": a wing file written for you, on a repo you have or a new empty one. It starts with
// Autonomous off, so nothing runs until you give its lead a goal or a task.

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
  const repo = h("input", { name: "repoPath", placeholder: "~/Projects/my-app" }) as HTMLInputElement;
  const branch = h("input", { name: "baseBranch", value: "main" }) as HTMLInputElement;
  const branchField = h("div", { class: "field" }, h("label", {}, "Base branch", branch));
  const fresh = h("input", { type: "checkbox", name: "newRepo", id: "new-repo" }) as HTMLInputElement;
  // a new project lives in ~/Projects/<id> unless you name another empty folder
  const syncRepo = () => {
    branchField.hidden = fresh.checked;
    repo.placeholder = fresh.checked ? `~/Projects/${id.value || "my-app"}` : "~/Projects/my-app";
  };
  fresh.addEventListener("change", syncRepo);
  id.addEventListener("input", syncRepo);
  name.addEventListener("input", syncRepo);
  const dialog = h("dialog", { class: "box", "aria-label": "New office" }) as HTMLDialogElement;
  const form = h(
    "form",
    {
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        const f = new FormData(ev.target as HTMLFormElement);
        const body: Record<string, unknown> = Object.fromEntries(f.entries());
        body.newRepo = fresh.checked;
        if (fresh.checked && !repo.value.trim()) body.repoPath = `~/Projects/${id.value}`;
        try {
          const r = (await post("/api/wings", body)) as { id: string };
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
    h("h2", {}, "New office"),
    h("p", {}, "A room with its own lead, crew and reviewer, working on one repo. Give it a goal and the lead plans the work; turn on Autonomous when it should also find work by itself."),
    error,
    h("div", { class: "two" }, h("div", { class: "field" }, h("label", {}, "Name", name)), h("div", { class: "field" }, h("label", {}, "Id", id))),
    h("div", { class: "field check" }, fresh, h("label", { for: "new-repo" }, "Start a new, empty project (Annex makes the folder and the git repo)")),
    h("div", { class: "field" }, h("label", {}, "Repo", repo)),
    branchField,
    h("div", { class: "field" }, h("label", {}, "Charter (optional)", h("textarea", { name: "charter", rows: 3, placeholder: "What should this office keep true?" }))),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Open the office"), h("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel")),
  );
  dialog.append(form);
  return dialog;
}
