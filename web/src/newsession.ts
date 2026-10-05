// "New session": a live Claude Code session in any folder, the way `claude` starts in a terminal.

import { apiFetch, post } from "./api.ts";
import { h } from "./dom.ts";

const MODES: [string, string][] = [["default", "Ask before acting"], ["acceptEdits", "Accept edits"], ["plan", "Plan only"], ["bypassPermissions", "Don't ask"]];

export function newSessionDialog(started: (id: string, cwd: string) => void): { el: HTMLDialogElement; open: () => void } {
  const error = h("p", { class: "notice bad", hidden: true, role: "alert" });
  const folder = h("input", { name: "cwd", required: true, list: "project-folders", placeholder: "~/Projects/my-app", autocomplete: "off" }) as HTMLInputElement;
  const folders = h("datalist", { id: "project-folders" });
  const mode = h("select", { name: "mode", "aria-label": "Permission mode" }, ...MODES.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  const el = h("dialog", { "aria-label": "New session" }) as HTMLDialogElement;
  el.append(
    h(
      "form",
      {
        onsubmit: async (ev: Event) => {
          ev.preventDefault();
          try {
            const v = (await post("/api/live", { cwd: folder.value, mode: mode.value })) as { id: string; cwd: string };
            el.close();
            error.hidden = true;
            started(v.id, v.cwd);
          } catch (err) {
            error.textContent = (err as Error).message;
            error.hidden = false;
          }
        },
      },
      h("h2", {}, "New session"),
      h("p", {}, "Claude Code in a folder you choose, on your own settings, the way the terminal runs it. Tools that need your yes show as cards."),
      error,
      h("div", { class: "field" }, h("label", {}, "Folder", folder), folders),
      h("div", { class: "field" }, h("label", {}, "Permissions", mode)),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Start the session"), h("button", { class: "btn ghost", type: "button", onclick: () => el.close() }, "Cancel")),
    ),
  );
  return {
    el,
    async open() {
      el.showModal();
      folder.focus();
      try {
        const [projects, live] = await Promise.all([apiFetch("/api/projects").then((r) => r.json()), apiFetch("/api/live").then((r) => r.json())]);
        const home = (projects as string[])[0]?.match(/^\/Users\/[^/]+/)?.[0] ?? "";
        folders.replaceChildren(...(projects as string[]).map((p) => h("option", { value: home && p.startsWith(home) ? `~${p.slice(home.length)}` : p })));
        mode.value = (live as { defaultMode: string }).defaultMode;
      } catch {
        // suggestions are a convenience; typing a folder still works
      }
    },
  };
}
