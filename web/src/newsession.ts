// "New session": a live Claude Code session in any folder, the way `claude` starts in a terminal.

import type { TerminalView } from "../../server/api-types.ts";
import { apiFetch, post } from "./api.ts";
import { h } from "./dom.ts";
import { canPickFolder, pickFolder } from "./pickfolder.ts";

export const MODELS: [string, string][] = [["default", "Your default"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["fable", "Fable"]];
const MODES: [string, string][] = [["default", "Ask before acting"], ["acceptEdits", "Accept edits"], ["plan", "Plan only"], ["bypassPermissions", "Don't ask"]];

export function newSessionDialog(started: (id: string, cwd: string) => void): { el: HTMLDialogElement; open: () => void } {
  const error = h("p", { class: "notice bad", hidden: true, role: "alert" });
  const { folder, folders, fill, choose } = folderField("project-folders");
  const mode = h("select", { name: "mode", "aria-label": "Permission mode" }, ...MODES.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  const model = h("select", { name: "model", "aria-label": "Model" }, ...MODELS.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  const el = h("dialog", { "aria-label": "New session" }) as HTMLDialogElement;
  el.append(
    h(
      "form",
      {
        onsubmit: async (ev: Event) => {
          ev.preventDefault();
          try {
            const v = (await post("/api/live", { cwd: folder.value, mode: mode.value, model: model.value })) as { id: string; cwd: string };
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
      h("div", { class: "field" }, h("label", {}, "Folder", h("div", { class: "row folder-pick" }, folder, choose)), folders),
      h("div", { class: "two" }, h("div", { class: "field" }, h("label", {}, "Permissions", mode)), h("div", { class: "field" }, h("label", {}, "Model", model))),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Start the session"), h("button", { class: "btn ghost", type: "button", onclick: () => el.close() }, "Cancel")),
    ),
  );
  return {
    el,
    async open() {
      el.showModal();
      folder.focus();
      void fill();
      try {
        mode.value = ((await apiFetch("/api/live").then((r) => r.json())) as { defaultMode: string }).defaultMode;
      } catch {
        // the mode stays at asking first
      }
    },
  };
}

// A folder input that suggests your projects (written with ~ for your home folder), with
// Choose… for the Mac's folder panel inside Annex.app.
function folderField(listId: string) {
  const folder = h("input", { name: "cwd", required: true, list: listId, placeholder: "~/Projects/my-app", autocomplete: "off" }) as HTMLInputElement;
  const choose = canPickFolder
    ? h("button", { class: "btn", type: "button", onclick: async () => {
        const p = await pickFolder();
        if (p) folder.value = p;
      } }, "Choose…")
    : null;
  const folders = h("datalist", { id: listId });
  const fill = async () => {
    try {
      const projects = (await apiFetch("/api/projects").then((r) => r.json())) as string[];
      const home = projects[0]?.match(/^\/Users\/[^/]+/)?.[0] ?? "";
      folders.replaceChildren(...projects.map((p) => h("option", { value: home && p.startsWith(home) ? `~${p.slice(home.length)}` : p })));
    } catch {
      // suggestions are a convenience; typing a folder still works
    }
  };
  return { folder, folders, fill, choose };
}

// "Terminal": your login shell in a folder, in a terminal pane.
export function newTerminalDialog(opened: (v: TerminalView) => void): { el: HTMLDialogElement; open: () => void } {
  const error = h("p", { class: "notice bad", hidden: true, role: "alert" });
  const { folder, folders, fill } = folderField("terminal-folders");
  const el = h("dialog", { "aria-label": "Terminal" }) as HTMLDialogElement;
  el.append(
    h(
      "form",
      {
        onsubmit: async (ev: Event) => {
          ev.preventDefault();
          try {
            const v = (await post("/api/terminals", { cwd: folder.value })) as TerminalView;
            el.close();
            error.hidden = true;
            opened(v);
          } catch (err) {
            error.textContent = (err as Error).message;
            error.hidden = false;
          }
        },
      },
      h("h2", {}, "Terminal"),
      h("p", {}, "Your login shell in a folder, the way a terminal window opens."),
      error,
      h("div", { class: "field" }, h("label", {}, "Folder", folder), folders),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Open the terminal"), h("button", { class: "btn ghost", type: "button", onclick: () => el.close() }, "Cancel")),
    ),
  );
  return {
    el,
    open() {
      if (!folder.value) folder.value = "~";
      el.showModal();
      folder.focus();
      folder.select();
      void fill();
    },
  };
}
