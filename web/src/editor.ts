// The Files dialog: one project's files as a tree, and an editor for one of them. A save goes over
// the file only if it is still what was opened; if Claude or another program wrote it since, the
// page says so and nothing is written until you choose Reload or Overwrite.
//
// CodeMirror is loaded the first time the dialog opens, so it stays out of the first page load.

import { ApiError, get, put } from "./api.ts";
import { h } from "./dom.ts";
import { buildTree, matchFiles, type Dir } from "./filetree.ts";
import type { Editor } from "./codemirror.ts";

type CM = typeof import("./codemirror.ts");

// below this the tree sits in a fold above the editor (styles.css says the same)
const narrow = matchMedia("(max-width: 860px)");

interface Listing {
  root: string;
  git: boolean;
  files: string[];
  truncated: boolean;
}

export class FilesDialog {
  readonly el = h("dialog", { class: "files-dialog", "aria-label": "Files" }) as HTMLDialogElement;
  private title = h("h2", {}, "Files");
  private where = h("p", { class: "where" });
  private pathEl = h("span", { class: "file-path" });
  private status = h("span", { class: "hint", role: "status" });
  private saveBtn = h("button", { class: "btn primary", type: "button", disabled: true, onclick: () => void this.save() }, "Save") as HTMLButtonElement;
  private find = h("input", { type: "search", placeholder: "Find a file", "aria-label": "Find a file" }) as HTMLInputElement;
  private tree = h("div", { class: "tree" });
  private treeBox = h("details", { class: "tree-box", open: true }, h("summary", {}, "Files"));
  private notice = h("div", {});
  private host = h("div", { class: "editor-host" });
  private cm: CM | null = null;
  private ed: Editor | null = null;
  private root = "";
  private files: Listing | null = null;
  private top: Dir | null = null;
  private path = "";
  private hash = "";
  // the folders open in the tree, kept across Refresh
  private expanded = new Set<string>();
  // a save in flight: a second Cmd+S (or a held key repeating) would send the hash the first one
  // just replaced and come back as a false "changed on disk"
  private saving = false;
  // the newest file asked for; a slower earlier open must not land over it
  private opening = 0;
  private guard = (ev: BeforeUnloadEvent) => ev.preventDefault();

  constructor() {
    this.find.addEventListener("input", () => this.drawTree());
    // the tree folds away only on a narrow screen; widen the window and it is back
    narrow.addEventListener("change", () => {
      if (!narrow.matches) this.treeBox.open = true;
    });
    this.treeBox.append(
      h(
        "nav",
        { class: "file-tree", "aria-label": "Project files" },
        h("div", { class: "row" }, this.find, h("button", { class: "btn ghost", type: "button", onclick: () => void this.load() }, "Refresh")),
        this.tree,
      ),
    );
    this.el.append(
      h(
        "div",
        { class: "pad" },
        h("div", { class: "row" }, h("div", { class: "files-title" }, this.title, this.where), h("span", { style: "margin-left: auto" }), this.saveBtn, h("button", { class: "btn", type: "button", onclick: () => this.close() }, "Close")),
        h("div", { class: "row files-status" }, this.pathEl, this.status),
        h("div", { class: "files-grid" }, this.treeBox, h("div", { class: "editor-col" }, this.notice, this.host)),
      ),
    );
    // Cmd/Ctrl+S saves wherever focus is in the dialog, and never saves the page instead
    this.el.addEventListener(
      "keydown",
      (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "s") {
          ev.preventDefault();
          void this.save();
        }
      },
      true,
    );
    // Esc: CodeMirror keeps the keys it uses (closing its search panel), so this is the dialog's own
    this.el.addEventListener("cancel", (ev) => {
      if (!this.mayDiscard()) ev.preventDefault();
    });
    // closing (after any "discard?") puts the file away; the project's tree stays for next time
    this.el.addEventListener("close", () => {
      this.dropEditor();
      this.path = "";
      this.pathEl.textContent = "";
      this.say("");
      this.host.replaceChildren(h("p", { class: "empty" }, "Choose a file"));
    });
  }

  async open(root: string, path?: string): Promise<void> {
    // another file in the same project asks in openFile
    if (root !== this.root && !this.mayDiscard()) return;
    if (!this.el.open) this.el.showModal();
    if (root !== this.root) {
      this.root = root;
      this.expanded.clear();
      this.dropEditor();
      this.path = "";
      this.title.textContent = root.split("/").pop() || root;
      this.where.textContent = root.replace(/^\/Users\/[^/]+/, "~");
      this.pathEl.textContent = "";
      this.say("");
      this.host.replaceChildren(h("p", { class: "empty" }, "Choose a file"));
      await this.load();
    }
    if (path) await this.openFile(path);
  }

  // A full path from a session or a diff: Annex finds which project holds it.
  async openPath(abs: string): Promise<void> {
    try {
      const at = await get<{ root: string; path: string }>(`/api/files/locate?path=${encodeURIComponent(abs)}`);
      await this.open(at.root, at.path);
    } catch (err) {
      if (!this.el.open) this.el.showModal();
      this.notice.replaceChildren(h("p", { class: "notice bad" }, `${abs}: ${(err as Error).message}`));
    }
  }

  close() {
    if (!this.mayDiscard()) return;
    this.el.close();
  }

  private async load() {
    const root = this.root;
    this.tree.replaceChildren(h("p", { class: "empty" }, "Reading the files…"));
    try {
      const files = await get<Listing>(`/api/files?root=${encodeURIComponent(root)}`);
      // another project was opened while this one was listed
      if (root !== this.root) return;
      this.files = files;
      this.top = buildTree(files.files);
    } catch (err) {
      if (root !== this.root) return;
      this.files = null;
      this.top = null;
      this.tree.replaceChildren(h("p", { class: "notice bad" }, (err as Error).message));
      return;
    }
    this.drawTree();
  }

  private drawTree() {
    if (!this.files || !this.top) return;
    const q = this.find.value.trim();
    const out: HTMLElement[] = [];
    if (this.files.truncated) out.push(h("p", { class: "hint" }, `Showing the first ${this.files.files.length.toLocaleString("en")} files; use Find for the rest`));
    if (q) {
      const hits = matchFiles(this.files.files, q);
      out.push(...(hits.length ? hits.map((f) => this.fileBtn(f, f, 0)) : [h("p", { class: "empty" }, "No file matches")]));
    } else if (!this.files.files.length) {
      out.push(h("p", { class: "empty" }, "No files here"));
    } else {
      out.push(...this.dirItems(this.top, 0));
    }
    this.tree.replaceChildren(...out);
  }

  // A folder's own contents; a subfolder's are drawn only once it is opened, so a large tree is cheap.
  private dirItems(d: Dir, depth: number): HTMLElement[] {
    const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs.map((sub) => this.dirItem(sub, depth)), ...d.files.map((f) => this.fileBtn(f, f.slice(f.lastIndexOf("/") + 1), depth))];
  }

  private dirItem(d: Dir, depth: number): HTMLElement {
    const kids = h("div", { class: "tree-kids" });
    const btn = h("button", { type: "button", class: "tree-dir", style: `padding-left: ${8 + depth * 12}px`, "aria-expanded": "false" }, `${d.name}/`);
    const show = (on: boolean) => {
      if (on && !kids.childElementCount) kids.append(...this.dirItems(d, depth + 1));
      kids.hidden = !on;
      btn.setAttribute("aria-expanded", String(on));
      if (on) this.expanded.add(d.path);
      else this.expanded.delete(d.path);
    };
    btn.addEventListener("click", () => show(kids.hidden || !kids.childElementCount));
    show(this.expanded.has(d.path));
    return h("div", {}, btn, kids);
  }

  private fileBtn(path: string, label: string, depth: number): HTMLElement {
    return h("button", { type: "button", class: `tree-file${path === this.path ? " open" : ""}`, title: path, style: `padding-left: ${8 + depth * 12}px`, onclick: () => void this.openFile(path) }, label);
  }

  private async openFile(path: string) {
    // the file already open keeps its edits
    if (path === this.path && this.ed) return this.ed.focus();
    if (!this.mayDiscard()) return;
    // its folders open in the tree, so you can see where it is
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join("/"));
    this.dropEditor();
    const ticket = ++this.opening;
    this.path = path;
    this.pathEl.textContent = path;
    this.say("");
    this.drawTree();
    if (narrow.matches) this.treeBox.open = false;
    this.host.replaceChildren(h("p", { class: "empty" }, this.cm ? "Opening…" : "Loading the editor…"));
    try {
      this.cm ??= await import("./codemirror.ts");
      const f = await get<{ path: string; text: string; hash: string }>(`/api/files/read?root=${encodeURIComponent(this.root)}&path=${encodeURIComponent(path)}`);
      // another file (or the same one again) was chosen while this one loaded
      if (ticket !== this.opening) return;
      this.hash = f.hash;
      this.host.replaceChildren();
      this.ed = this.cm.createEditor(this.host, { text: f.text, path, onChange: (dirty) => this.setDirty(dirty) });
      this.setDirty(false);
      this.ed.focus();
    } catch (err) {
      if (ticket === this.opening) this.host.replaceChildren(h("p", { class: "notice bad" }, (err as Error).message));
    }
  }

  private async save(hash = this.hash) {
    const ed = this.ed;
    if (!ed || this.saving || (!ed.dirty() && hash === this.hash)) return;
    const text = ed.text();
    this.status.textContent = "Saving…";
    this.saving = true;
    try {
      const r = (await put("/api/files", { root: this.root, path: this.path, text, hash })) as { hash: string; backup: string | null };
      // another file was opened while this one saved: the answer is not about it
      if (this.ed !== ed) return;
      this.hash = r.hash;
      ed.markSaved(text);
      this.notice.replaceChildren();
      this.say(r.backup ? `Saved. The previous version is in ${r.backup.replace(/^\/Users\/[^/]+/, "~")}` : "Saved.");
    } catch (err) {
      if (this.ed !== ed) return;
      this.setDirty(ed.dirty());
      if (err instanceof ApiError && err.data.conflict) return this.conflict();
      this.notice.replaceChildren(h("p", { class: "notice bad" }, (err as Error).message));
    } finally {
      this.saving = false;
    }
  }

  // The file changed on disk since it was opened. Your edits stay in the editor until you choose.
  private conflict() {
    const ed = this.ed!;
    const reread = () => get<{ text: string; hash: string }>(`/api/files/read?root=${encodeURIComponent(this.root)}&path=${encodeURIComponent(this.path)}`);
    const fail = (err: unknown) => this.notice.replaceChildren(h("p", { class: "notice bad" }, (err as Error).message));
    this.notice.replaceChildren(
      h(
        "div",
        { class: "notice warn", role: "alert" },
        h("p", {}, "This file changed on disk since you opened it (Claude or another program wrote it). Your edits are still here."),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn", type: "button", onclick: async () => {
            if (!confirm("Replace your edits with the file on disk?")) return;
            try {
              const f = await reread();
              this.hash = f.hash;
              ed.replace(f.text);
              this.notice.replaceChildren();
              this.say("Reloaded from disk.");
            } catch (err) {
              fail(err);
            }
          } }, "Reload from disk"),
          h("button", { class: "btn ghost", type: "button", onclick: async () => {
            if (!confirm("Write your version over the file on disk? The disk version is kept as a backup.")) return;
            try {
              await this.save((await reread()).hash);
            } catch (err) {
              fail(err);
            }
          } }, "Overwrite with mine"),
          h("button", { class: "btn ghost", type: "button", onclick: async (ev: Event) => {
            const b = ev.currentTarget as HTMLButtonElement;
            try {
              await navigator.clipboard.writeText(ed.text());
              b.textContent = "Copied";
            } catch {
              b.textContent = "Could not copy";
            }
          } }, "Copy my version"),
        ),
      ),
    );
  }

  private mayDiscard(): boolean {
    return !this.ed?.dirty() || confirm(`Discard your unsaved changes to ${this.path}?`);
  }

  private setDirty(dirty: boolean) {
    this.saveBtn.disabled = !dirty;
    if (dirty) this.status.textContent = "Unsaved changes";
    else if (this.status.textContent === "Unsaved changes" || this.status.textContent === "Saving…") this.status.textContent = this.ed ? "Saved" : "";
    // leaving the page with unsaved edits asks first
    if (dirty) addEventListener("beforeunload", this.guard);
    else removeEventListener("beforeunload", this.guard);
  }

  private say(text: string) {
    this.status.textContent = text;
  }

  private dropEditor() {
    this.ed?.destroy();
    this.ed = null;
    this.notice.replaceChildren();
    this.setDirty(false);
  }
}
