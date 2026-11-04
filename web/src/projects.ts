// Projects: your repos and your Claude setup. Pick a project for its branch, publishing, config
// files and MCP servers, or "You" for your own Claude settings and plugins. Every change says
// exactly what it will do first. A project can be any folder: add one you have, make a new one,
// or clone one, wherever you like; Forget only takes it off this list.

import { get, post, put } from "./api.ts";
import { h } from "./dom.ts";
import { RunPanel } from "./runpanel.ts";
import { canPickFolder, pickFolder } from "./pickfolder.ts";

const KINDS: [string, string][] = [["claude-md", "CLAUDE.md"], ["project-settings", "Settings (shared)"], ["project-local", "Settings (just you)"], ["mcp-json", ".mcp.json"]];
const YOU = "you";

interface Branches {
  current: string | null;
  branches: string[];
  dirty: boolean;
  changes: string[];
  busy: string | null;
  remote: string | null;
  ahead: number | null;
  defaultBranch: string | null;
}

export class ProjectsDialog {
  readonly el = h("dialog", { class: "wide projects", "aria-label": "Projects" }) as HTMLDialogElement;
  private list = h("nav", { class: "project-list" });
  private detail = h("div", { class: "project-detail" });
  private projects: string[] = [];
  private chosen: string = YOU;
  private note = "";
  private run = new RunPanel();
  private startSession: (folder: string) => void;
  private openTerminal: (folder: string) => void;
  private openFiles: (folder: string) => void;

  constructor(startSession: (folder: string) => void, openFiles: (folder: string) => void, openTerminal: (folder: string) => void) {
    this.startSession = startSession;
    this.openFiles = openFiles;
    this.openTerminal = openTerminal;
    this.el.append(
      h(
        "div",
        { class: "pad" },
        h("div", { class: "row" }, h("h2", {}, "Projects"), h("span", { style: "margin-left: auto" }), h("button", { class: "btn", type: "button", onclick: () => this.close() }, "Close")),
        h(
          "div",
          { class: "project-grid" },
          h(
            "div",
            {},
            this.list,
            h(
              "div",
              { class: "row adders" },
              h("button", { class: "btn", type: "button", onclick: () => void this.addFolder() }, "Add a folder…"),
              h("button", { class: "btn", type: "button", onclick: () => this.showForm("new") }, "New project…"),
              h("button", { class: "btn", type: "button", onclick: () => this.showForm("clone") }, "Clone…"),
            ),
            this.form,
            this.formMsg,
          ),
          this.detail,
        ),
      ),
    );
    this.el.addEventListener("close", () => this.run.hide());
  }

  async open() {
    this.el.showModal();
    await this.loadList();
    void this.show(this.chosen);
  }

  close() {
    this.run.hide();
    this.el.close();
  }

  private async loadList() {
    try {
      this.projects = await get<string[]>("/api/projects");
    } catch (err) {
      this.note = (err as Error).message;
    }
    this.list.replaceChildren(
      h("button", { type: "button", class: `project${this.chosen === YOU ? " open" : ""}`, onclick: () => void this.show(YOU) }, h("b", {}, "You"), h("span", {}, "Claude settings and plugins")),
      ...this.projects.map((p) =>
        h(
          "div",
          { class: "project-row" },
          h("button", { type: "button", class: `project${this.chosen === p ? " open" : ""}`, onclick: () => void this.show(p) }, h("b", {}, p.split("/").pop()!), h("span", {}, short(p))),
          h("button", { type: "button", class: "forget", "aria-label": `Forget ${short(p)}`, onclick: () => void this.forget(p) }, "Forget"),
        ),
      ),
    );
  }

  // Adding, making and cloning a project: one small form at a time under the list; what Annex
  // refuses is said there, where you are looking.
  private form = h("div", {});
  private formMsg = h("p", { class: "hint", role: "status" });

  private showForm(which: "add" | "new" | "clone") {
    this.formMsg.textContent = "";
    const submit = (label: string, run: () => Promise<void>, fields: HTMLElement[], title: string) =>
      h("form", { class: "clone", onsubmit: (ev: Event) => { ev.preventDefault(); void run(); } }, h("h3", {}, title), ...fields, h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, label), h("button", { class: "btn ghost", type: "button", onclick: () => this.form.replaceChildren() }, "Cancel")));
    if (which === "add") {
      const folder = folderField("~/Code/my-app", "Folder");
      this.form.replaceChildren(submit("Add", () => this.add(folder.input.value), [folder.el], "Add a folder"));
      folder.input.focus();
    } else if (which === "new") {
      const parent = folderField("~/Projects", "Make it in");
      parent.input.value = "~/Projects";
      const name = h("input", { placeholder: "my-app", "aria-label": "Project name", required: true }) as HTMLInputElement;
      const run = async () => {
        this.formMsg.textContent = "Making it…";
        try {
          const r = (await post("/api/projects/create", { parent: parent.input.value, name: name.value })) as { folder: string };
          this.done(`Made ${short(r.folder)}: a git repo with a README and one commit.`, r.folder);
        } catch (err) {
          this.formMsg.textContent = (err as Error).message;
        }
      };
      this.form.replaceChildren(submit("Create", run, [parent.el, h("div", { class: "field" }, h("label", {}, "Name", name))], "New project"));
      name.focus();
    } else {
      const url = h("input", { placeholder: "https://github.com/you/app.git", "aria-label": "Repository address", required: true }) as HTMLInputElement;
      const parent = folderField("~/Projects", "Clone into");
      parent.input.value = "~/Projects";
      const name = h("input", { placeholder: "folder name (optional)", "aria-label": "Folder name" }) as HTMLInputElement;
      const run = async () => {
        const folder = name.value.trim() || url.value.trim().split("/").pop()?.replace(/\.git$/, "") || "";
        const into = `${parent.input.value.trim().replace(/\/+$/, "")}/${folder}`;
        if (!confirm(`Clone ${url.value.trim()} into ${into}?\n\nRuns: git clone -- ${url.value.trim()} ${into}`)) return;
        this.formMsg.textContent = "Cloning…";
        try {
          const r = (await post("/api/projects/clone", { url: url.value, name: name.value, parent: parent.input.value })) as { folder: string };
          this.done(`Cloned into ${r.folder}.`, r.folder);
        } catch (err) {
          this.formMsg.textContent = (err as Error).message;
        }
      };
      this.form.replaceChildren(submit("Clone", run, [url, parent.el, name], "Clone a repository"));
      url.focus();
    }
  }

  // In Annex.app the Mac's folder panel opens at once; in a browser the folder is typed.
  private async addFolder() {
    if (!canPickFolder) return this.showForm("add");
    const path = await pickFolder();
    if (path) await this.add(path);
  }

  private async add(path: string) {
    try {
      const r = (await post("/api/projects/add", { path })) as { folder: string };
      this.done(`Added ${short(r.folder)}.`, r.folder);
    } catch (err) {
      this.formMsg.textContent = (err as Error).message;
    }
  }

  private done(note: string, folder: string) {
    this.form.replaceChildren();
    this.formMsg.textContent = "";
    this.note = note;
    void this.show(folder);
  }

  private async forget(p: string) {
    if (!confirm(`Forget ${short(p)}?\n\nAnnex stops listing it. The folder and its files stay exactly as they are, and Add a folder brings it back.`)) return;
    try {
      await post("/api/projects/forget", { path: p });
      this.note = `Annex no longer lists ${short(p)}. Nothing in the folder changed.`;
      void this.show(this.chosen === p ? YOU : this.chosen);
    } catch (err) {
      this.formMsg.textContent = (err as Error).message;
    }
  }

  private async show(target: string) {
    this.chosen = target;
    this.run.hide();
    await this.loadList();
    const note = this.note ? h("p", { class: "notice", role: "status" }, this.note) : null;
    this.note = "";
    if (target === YOU) {
      this.detail.replaceChildren(h("h3", {}, "Your Claude settings"), ...(note ? [note] : []), await this.editor("user-settings", null), await this.plugins());
      return;
    }
    const parts: HTMLElement[] = [h("h3", {}, target.split("/").pop()!), h("p", { class: "where" }, target)];
    if (note) parts.push(note);
    parts.push(h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", onclick: () => { this.close(); this.startSession(target); } }, "Start a session here"), h("button", { class: "btn", type: "button", onclick: () => { this.close(); this.openFiles(target); } }, "Files"), h("button", { class: "btn", type: "button", onclick: () => { this.close(); this.openTerminal(target); } }, "Open a terminal here")));
    parts.push(await this.branchBlock(target));
    const runBox = h("details", { class: "run-box" }, h("summary", {}, "Run the app"), this.run.el);
    runBox.addEventListener("toggle", () => (runBox.open ? this.run.show({ folder: target }) : this.run.hide()));
    parts.push(runBox);
    const files = h("div", {});
    const tabs = h("div", { class: "row file-tabs" }, ...KINDS.map(([k, label]) => h("button", { class: "btn ghost", type: "button", onclick: async () => files.replaceChildren(await this.editor(k, target)) }, label)));
    files.replaceChildren(await this.editor("claude-md", target));
    parts.push(h("h3", {}, "Claude for this project"), tabs, files, await this.mcp(target));
    this.detail.replaceChildren(...parts);
  }

  // Branch, switch or create one, and publish: push and, off the default branch, a pull request.
  private async branchBlock(root: string): Promise<HTMLElement> {
    let b: Branches;
    try {
      b = await get<Branches>(`/api/projects/branches?root=${encodeURIComponent(root)}`);
    } catch (err) {
      return h("p", { class: "notice bad" }, (err as Error).message);
    }
    const msg = h("p", { class: "notice", role: "status", hidden: true });
    const say = (text: string) => {
      msg.textContent = text;
      msg.hidden = false;
      msg.scrollIntoView({ block: "nearest" });
    };
    const pick = h("select", { "aria-label": "Branch" }, ...b.branches.map((x) => h("option", { value: x, selected: x === b.current }, x))) as HTMLSelectElement;
    const fresh = h("input", { placeholder: "new-branch-name", "aria-label": "New branch name" }) as HTMLInputElement;
    const sw = async (branch: string, create: boolean) => {
      if (!confirm(`${create ? "Create the branch" : "Switch the checkout to"} ${branch} in ${root.split("/").pop()}?\n\nRuns: git switch ${create ? "-c " : ""}${branch}`)) return;
      try {
        await post("/api/projects/switch", { root, branch, create });
        this.note = create ? `Created and switched to ${branch}.` : `Switched to ${branch}.`;
        void this.show(root);
      } catch (err) {
        say((err as Error).message);
      }
    };
    const commitMsg = h("input", { placeholder: "What changed, in a sentence", "aria-label": "Commit message" }) as HTMLInputElement;
    const commit = async () => {
      if (!commitMsg.value.trim()) return say("Write a commit message first.");
      if (!confirm(`Commit these ${b.changes.length} change${b.changes.length === 1 ? "" : "s"} on ${b.current}?\n\n${b.changes.slice(0, 25).join("\n")}${b.changes.length > 25 ? `\n…and ${b.changes.length - 25} more` : ""}\n\nRuns: git add -A && git commit -m "${commitMsg.value.trim()}"`)) return;
      try {
        const r = (await post("/api/projects/commit", { root, message: commitMsg.value, changes: b.changes })) as { commit: string };
        this.note = `Committed ${r.commit}.`;
        void this.show(root);
      } catch (err) {
        say((err as Error).message);
      }
    };
    const state = [b.changes.length ? `${b.changes.length} uncommitted change${b.changes.length === 1 ? "" : "s"}` : "nothing to commit", b.busy ? `in the middle of a ${b.busy}` : "", b.ahead !== null ? `${b.ahead} commit${b.ahead === 1 ? "" : "s"} not pushed` : b.remote ? "not pushed yet" : "no remote"].filter(Boolean).join(", ");
    const publishArea = h("div", {});
    const showPlan = async () => {
      try {
        const plan = await get<{ branch: string; commands: string[]; pr: boolean }>(`/api/projects/publish?root=${encodeURIComponent(root)}`);
        publishArea.replaceChildren(
          h(
            "div",
            { class: "confirm" },
            h("p", {}, "Annex will run, in this project:"),
            h("pre", { class: "brief" }, plan.commands.join("\n")),
            h("p", { class: "hint" }, plan.pr ? "It never force-pushes." : "It never force-pushes. No pull request: this is the default branch, or the remote's default branch is not known here."),
            h(
              "div",
              { class: "row" },
              h("button", { class: "btn primary", type: "button", onclick: async () => {
                try {
                  const r = (await post("/api/projects/publish", { root, branch: plan.branch })) as { pushed: string; pr: string | null };
                  this.note = r.pr ? `Pushed ${r.pushed}. Pull request: ${r.pr}` : `Pushed ${r.pushed} (no pull request opened).`;
                  void this.show(root);
                } catch (err) {
                  publishArea.replaceChildren(h("p", { class: "notice bad" }, (err as Error).message));
                }
              } }, "Publish"),
              h("button", { class: "btn ghost", type: "button", onclick: () => publishArea.replaceChildren() }, "Cancel"),
            ),
          ),
        );
      } catch (err) {
        publishArea.replaceChildren(h("p", { class: "notice bad" }, (err as Error).message));
      }
    };
    return h(
      "div",
      { class: "branch-block" },
      h("p", {}, "On ", h("b", {}, b.current ?? "no branch"), `: ${state}.`),
      msg,
      b.changes.length ? h("details", {}, h("summary", {}, "What changed"), h("pre", { class: "brief" }, b.changes.join("\n"))) : null,
      b.changes.length ? h("form", { class: "row", onsubmit: (ev: Event) => { ev.preventDefault(); void commit(); } }, commitMsg, h("button", { class: "btn", type: "submit" }, "Commit all")) : null,
      h("div", { class: "row" }, pick, h("button", { class: "btn", type: "button", onclick: () => void sw(pick.value, false) }, "Switch")),
      h("form", { class: "row", onsubmit: (ev: Event) => { ev.preventDefault(); if (fresh.value.trim()) void sw(fresh.value.trim(), true); } }, fresh, h("button", { class: "btn", type: "submit" }, "Create branch")),
      h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !b.remote, title: b.remote ? "" : "This repo has no remote", onclick: () => void showPlan() }, b.defaultBranch && b.current !== b.defaultBranch ? "Publish (push and open a PR)" : "Publish (push)")),
      publishArea,
    );
  }

  // One config file: read it, edit it, save it; Annex refuses broken JSON and someone else's change.
  private async editor(kind: string, root: string | null): Promise<HTMLElement> {
    let f: { path: string; text: string; hash: string; exists: boolean };
    try {
      f = await get(`/api/config?kind=${kind}${root ? `&root=${encodeURIComponent(root)}` : ""}`);
    } catch (err) {
      return h("p", { class: "notice bad" }, (err as Error).message);
    }
    const area = h("textarea", { class: "config-text", rows: 14, spellcheck: false, "aria-label": f.path }) as HTMLTextAreaElement;
    area.value = f.text;
    const msg = h("span", { class: "hint" }, f.exists ? f.path : `${f.path} (does not exist yet; saving creates it)`);
    let hash = f.hash;
    return h(
      "form",
      { class: "config-form", onsubmit: async (ev: Event) => {
        ev.preventDefault();
        try {
          const r = (await put("/api/config", { kind, root, text: area.value, hash })) as { hash: string; backup: string | null };
          hash = r.hash;
          msg.textContent = r.backup ? `Saved. The previous version is in ${r.backup}.` : "Saved.";
        } catch (err) {
          msg.textContent = (err as Error).message;
        }
      } },
      area,
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Save"), msg),
    );
  }

  private async mcp(root: string): Promise<HTMLElement> {
    type Row = { name: string; target: string; status: string; ok: boolean; yours: boolean };
    const list = h("ol", { class: "mcp-rows" }, h("li", { class: "hint" }, "Checking MCP servers…"));
    const note = h("p", { class: "hint", role: "status" });
    const name = h("input", { placeholder: "name", "aria-label": "Server name" }) as HTMLInputElement;
    const cmd = h("input", { placeholder: "command and arguments, e.g. npx -y @modelcontextprotocol/server-github", "aria-label": "Command" }) as HTMLInputElement;
    const scope = h("select", { "aria-label": "Scope" }, h("option", { value: "local" }, "Just you, this project"), h("option", { value: "project" }, "Everyone, this project (.mcp.json)"), h("option", { value: "user" }, "You, every project")) as HTMLSelectElement;
    const load = async () => {
      try {
        const rows = (await get<{ rows: Row[] }>(`/api/mcp?root=${encodeURIComponent(root)}`)).rows;
        list.replaceChildren(
          ...(rows.length ? rows : []).map((r) =>
            h(
              "li",
              {},
              h("b", {}, r.name),
              h("span", { class: `mcp-st ${r.ok ? "ok" : "bad"}` }, r.status),
              h("code", {}, r.target),
              r.yours
                ? h("button", { class: "btn ghost", type: "button", onclick: async () => {
                    if (!confirm(`Remove the MCP server "${r.name}"?\n\nRuns: claude mcp remove ${r.name}`)) return;
                    try {
                      note.textContent = ((await post("/api/mcp/remove", { root, name: r.name })) as { text: string }).text;
                    } catch (err) {
                      note.textContent = (err as Error).message;
                    }
                    void load();
                  } }, "Remove")
                : h("span", { class: "hint" }, r.name.startsWith("plugin:") ? "from a plugin" : "from claude.ai"),
            ),
          ),
        );
        if (!rows.length) list.replaceChildren(h("li", { class: "hint" }, "No MCP servers."));
      } catch (err) {
        list.replaceChildren(h("li", { class: "notice bad" }, (err as Error).message));
      }
    };
    void load();
    return h(
      "div",
      {},
      h("h3", {}, "MCP servers"),
      list,
      note,
      h(
        "form",
        { class: "row", onsubmit: async (ev: Event) => {
          ev.preventDefault();
          const [command, ...args] = cmd.value.trim().split(/\s+/);
          if (!confirm(`Add the MCP server "${name.value}"?\n\nRuns: claude mcp add --scope ${scope.value} ${name.value} -- ${cmd.value.trim()}`)) return;
          try {
            note.textContent = ((await post("/api/mcp", { root, name: name.value, scope: scope.value, command, args })) as { text: string }).text;
            name.value = "";
            cmd.value = "";
          } catch (err) {
            note.textContent = (err as Error).message;
          }
          void load();
        } },
        name,
        cmd,
        scope,
        h("button", { class: "btn", type: "submit" }, "Add server"),
      ),
    );
  }

  private async plugins(): Promise<HTMLElement> {
    let rows: { id: string; version: string | null; enabledForYou: boolean; offices: string[] }[] = [];
    try {
      rows = await get("/api/plugins");
    } catch (err) {
      return h("p", { class: "notice bad" }, (err as Error).message);
    }
    return h(
      "div",
      {},
      h("h3", {}, "Plugins"),
      h("p", { class: "hint" }, "Installed with /plugin in Claude Code. On for you means your own sessions load it; offices turn plugins on in their Settings tab."),
      h(
        "ol",
        { class: "plugins" },
        ...rows.map((p) =>
          h(
            "li",
            {},
            h("b", {}, p.id),
            h("span", { class: "hint" }, [p.version ? `v${p.version}` : "", p.offices.length ? `used by ${p.offices.join(", ")}` : ""].filter(Boolean).join(", ")),
            h("button", { class: `switch${p.enabledForYou ? " on" : ""}`, type: "button", role: "switch", "aria-checked": String(p.enabledForYou), onclick: async () => {
              if (!confirm(`${p.enabledForYou ? "Turn off" : "Turn on"} ${p.id} for your own Claude sessions? This changes ~/.claude/settings.json (a backup is kept).`)) return;
              try {
                await post("/api/plugins/you", { id: p.id, on: !p.enabledForYou });
              } catch (err) {
                this.note = (err as Error).message;
              }
              void this.show(YOU);
            } }, h("span", { class: "track", "aria-hidden": "true" }, h("i", {})), "On for you"),
          ),
        ),
      ),
    );
  }
}

const short = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

// A folder typed as a path, with Choose… for the Mac's folder panel inside Annex.app.
function folderField(placeholder: string, label: string): { el: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { placeholder, "aria-label": label, autocomplete: "off", required: true }) as HTMLInputElement;
  const choose = canPickFolder
    ? h("button", { class: "btn", type: "button", onclick: async () => {
        const p = await pickFolder();
        if (p) input.value = p;
      } }, "Choose…")
    : null;
  return { el: h("div", { class: "field" }, h("label", {}, label, h("div", { class: "row folder-pick" }, input, choose))), input };
}
