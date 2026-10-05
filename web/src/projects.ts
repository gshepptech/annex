// Projects: your repos and your Claude setup. Pick a project for its branch, publishing, config
// files and MCP servers, or "You" for your own Claude settings and plugins. Every change says
// exactly what it will do first.

import { apiFetch, post } from "./api.ts";
import { h } from "./dom.ts";
import { RunPanel } from "./runpanel.ts";

const KINDS: [string, string][] = [["claude-md", "CLAUDE.md"], ["project-settings", "Settings (shared)"], ["project-local", "Settings (just you)"], ["mcp-json", ".mcp.json"]];
const YOU = "you";

interface Branches {
  current: string | null;
  branches: string[];
  dirty: boolean;
  busy: string | null;
  remote: string | null;
  ahead: number | null;
  defaultBranch: string | null;
}

async function get<T>(path: string): Promise<T> {
  const r = await apiFetch(path);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? `Annex answered ${r.status}`);
  return d as T;
}

async function put(path: string, body: unknown): Promise<unknown> {
  const r = await apiFetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? `Annex answered ${r.status}`);
  return d;
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

  constructor(startSession: (folder: string) => void) {
    this.startSession = startSession;
    const url = h("input", { placeholder: "https://github.com/you/app.git", "aria-label": "Repository address" }) as HTMLInputElement;
    const name = h("input", { placeholder: "folder name (optional)", "aria-label": "Folder name" }) as HTMLInputElement;
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
              "form",
              { class: "clone", onsubmit: (ev: Event) => { ev.preventDefault(); void this.clone(url, name); } },
              h("h3", {}, "Clone a repository"),
              url,
              name,
              h("button", { class: "btn", type: "submit" }, "Clone into ~/Projects"),
            ),
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
    const short = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
    this.list.replaceChildren(
      h("button", { type: "button", class: `project${this.chosen === YOU ? " open" : ""}`, onclick: () => void this.show(YOU) }, h("b", {}, "You"), h("span", {}, "Claude settings and plugins")),
      ...this.projects.map((p) => h("button", { type: "button", class: `project${this.chosen === p ? " open" : ""}`, onclick: () => void this.show(p) }, h("b", {}, p.split("/").pop()!), h("span", {}, short(p)))),
    );
  }

  private async clone(url: HTMLInputElement, name: HTMLInputElement) {
    try {
      const r = (await post("/api/projects/clone", { url: url.value, name: name.value })) as { folder: string };
      url.value = "";
      name.value = "";
      this.note = `Cloned into ${r.folder}.`;
      await this.loadList();
      void this.show(r.folder);
    } catch (err) {
      this.note = (err as Error).message;
      void this.show(this.chosen);
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
    parts.push(h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", onclick: () => { this.close(); this.startSession(target); } }, "Start a session here")));
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
    const pick = h("select", { "aria-label": "Branch" }, ...b.branches.map((x) => h("option", { value: x, selected: x === b.current }, x))) as HTMLSelectElement;
    const fresh = h("input", { placeholder: "new-branch-name", "aria-label": "New branch name" }) as HTMLInputElement;
    const sw = async (branch: string, create: boolean) => {
      try {
        await post("/api/projects/switch", { root, branch, create });
        this.note = create ? `Created and switched to ${branch}.` : `Switched to ${branch}.`;
      } catch (err) {
        this.note = (err as Error).message;
      }
      void this.show(root);
    };
    const state = [b.dirty ? "uncommitted changes" : "clean", b.busy ? `in the middle of a ${b.busy}` : "", b.ahead !== null ? `${b.ahead} commit${b.ahead === 1 ? "" : "s"} not pushed` : b.remote ? "not pushed yet" : "no remote"].filter(Boolean).join(", ");
    const publishArea = h("div", {});
    const showPlan = async () => {
      try {
        const plan = await get<{ branch: string; commands: string[] }>(`/api/projects/publish?root=${encodeURIComponent(root)}`);
        publishArea.replaceChildren(
          h(
            "div",
            { class: "confirm" },
            h("p", {}, "Annex will run, in this project:"),
            h("pre", { class: "brief" }, plan.commands.join("\n")),
            h("p", { class: "hint" }, "It never force-pushes."),
            h(
              "div",
              { class: "row" },
              h("button", { class: "btn primary", type: "button", onclick: async () => {
                try {
                  const r = (await post("/api/projects/publish", { root, branch: plan.branch })) as { pushed: string; pr: string | null };
                  this.note = r.pr ? `Pushed ${r.pushed}. Pull request: ${r.pr}` : `Pushed ${r.pushed}.`;
                } catch (err) {
                  this.note = (err as Error).message;
                }
                void this.show(root);
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
      h("div", { class: "row" }, pick, h("button", { class: "btn", type: "button", onclick: () => void sw(pick.value, false) }, "Switch")),
      h("form", { class: "row", onsubmit: (ev: Event) => { ev.preventDefault(); if (fresh.value.trim()) void sw(fresh.value.trim(), true); } }, fresh, h("button", { class: "btn", type: "submit" }, "Create branch")),
      h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !b.remote, title: b.remote ? "" : "This repo has no remote", onclick: () => void showPlan() }, "Publish (push and open a PR)")),
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
    const out = h("pre", { class: "brief" }, "Checking MCP servers…");
    const name = h("input", { placeholder: "name", "aria-label": "Server name" }) as HTMLInputElement;
    const cmd = h("input", { placeholder: "command and arguments, e.g. npx -y @modelcontextprotocol/server-github", "aria-label": "Command" }) as HTMLInputElement;
    const scope = h("select", { "aria-label": "Scope" }, h("option", { value: "local" }, "Just you, this project"), h("option", { value: "project" }, "Everyone, this project (.mcp.json)"), h("option", { value: "user" }, "You, every project")) as HTMLSelectElement;
    const load = async () => {
      try {
        out.textContent = (await get<{ text: string }>(`/api/mcp?root=${encodeURIComponent(root)}`)).text || "No MCP servers.";
      } catch (err) {
        out.textContent = (err as Error).message;
      }
    };
    void load();
    return h(
      "div",
      {},
      h("h3", {}, "MCP servers"),
      out,
      h(
        "form",
        { class: "row", onsubmit: async (ev: Event) => {
          ev.preventDefault();
          const [command, ...args] = cmd.value.trim().split(/\s+/);
          try {
            out.textContent = ((await post("/api/mcp", { root, name: name.value, scope: scope.value, command, args })) as { text: string }).text;
            void load();
          } catch (err) {
            out.textContent = (err as Error).message;
          }
        } },
        name,
        cmd,
        scope,
        h("button", { class: "btn", type: "submit" }, "Add"),
      ),
      h(
        "form",
        { class: "row", onsubmit: async (ev: Event) => {
          ev.preventDefault();
          try {
            out.textContent = ((await post("/api/mcp/remove", { root, name: name.value, scope: scope.value })) as { text: string }).text;
            void load();
          } catch (err) {
            out.textContent = (err as Error).message;
          }
        } },
        h("button", { class: "btn ghost", type: "submit" }, "Remove the server named above"),
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
