// Running the app: the folder's package.json scripts as buttons, any command you type, each run's
// output as it comes, the address it serves on, and Stop. For an office it runs a checkout of the
// office's newest verified work; for a session, the session's own folder.

import type { AppRun } from "../../server/api-types.ts";
import { apiFetch, post } from "./api.ts";
import { h } from "./dom.ts";

type Target = { wing: string } | { folder: string };

export class RunPanel {
  readonly el = h("div", { class: "run-panel" });
  private target: Target | null = null;
  private folder = "";
  private scripts: string[] = [];
  private runs: AppRun[] = [];
  private openRun: string | null = null;
  private lines: string[] = [];
  private next = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private error = "";
  private logEl = h("pre", { class: "run-log", tabindex: "0" });
  private command = h("input", { placeholder: "Any command, e.g. npx vitest run src/cart", "aria-label": "Command to run" }) as HTMLInputElement;

  show(target: Target) {
    const same = JSON.stringify(target) === JSON.stringify(this.target);
    this.target = target;
    if (!same) {
      this.openRun = null;
      this.lines = [];
      this.next = 0;
      this.error = "";
    }
    void this.load();
  }

  hide() {
    this.target = null;
    if (this.timer) clearTimeout(this.timer);
  }

  private query(): string {
    const t = this.target!;
    return "wing" in t ? `wing=${encodeURIComponent(t.wing)}` : `folder=${encodeURIComponent(t.folder)}`;
  }

  private async load() {
    if (!this.target) return;
    if (this.timer) clearTimeout(this.timer);
    try {
      const r = await apiFetch(`/api/run?${this.query()}`);
      const data = (await r.json()) as { folder: string; scripts: string[]; runs: AppRun[]; error?: string };
      if (!r.ok) throw new Error(data.error ?? `Annex answered ${r.status}`);
      this.folder = data.folder;
      this.scripts = data.scripts;
      this.runs = data.runs;
      if (!this.openRun && this.runs.length) this.openRun = this.runs.at(-1)!.id;
      if (this.openRun) await this.pullLog();
    } catch (err) {
      this.error = (err as Error).message;
    }
    this.draw();
    const busy = this.runs.some((r) => r.status === "running");
    this.timer = setTimeout(() => void this.load(), busy ? 1000 : 4000);
  }

  private async pullLog() {
    const r = await apiFetch(`/api/run/${this.openRun}/log?after=${this.next}`);
    if (!r.ok) return;
    const d = (await r.json()) as { lines: string[]; next: number };
    this.lines.push(...d.lines);
    if (this.lines.length > 2000) this.lines.splice(0, this.lines.length - 2000);
    this.next = d.next;
  }

  private async start(body: { script?: string; command?: string }) {
    this.error = "";
    try {
      const t = this.target!;
      const run = (await post("/api/run", { ...("wing" in t ? { wing: t.wing } : { folder: t.folder }), ...body })) as AppRun;
      this.openRun = run.id;
      this.lines = [];
      this.next = 0;
    } catch (err) {
      this.error = (err as Error).message;
    }
    void this.load();
  }

  private draw() {
    const stick = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 30;
    const current = this.runs.find((r) => r.id === this.openRun) ?? null;
    this.logEl.textContent = this.lines.join("\n") || (current ? "(no output yet)" : "");
    if (stick) this.logEl.scrollTop = this.logEl.scrollHeight;
    const parts: (HTMLElement | null)[] = [
      h("p", { class: "where" }, "wing" in (this.target ?? {}) ? `Runs a checkout of this office's newest verified work: ${this.folder}` : `In ${this.folder}`),
      this.error ? h("p", { class: "notice bad", role: "alert" }, this.error) : null,
      this.scripts.length
        ? h("div", { class: "row" }, ...this.scripts.map((s) => h("button", { class: "btn", type: "button", onclick: () => void this.start({ script: s }) }, s)))
        : h("p", { class: "empty" }, "No package.json scripts here; type a command instead."),
      h("form", { class: "row run-command", onsubmit: (ev: Event) => { ev.preventDefault(); if (this.command.value.trim()) void this.start({ command: this.command.value }); } }, this.command, h("button", { class: "btn", type: "submit" }, "Run")),
      this.runs.length
        ? h(
            "ol",
            { class: "runs" },
            ...[...this.runs].reverse().map((r) =>
              h(
                "li",
                { class: r.id === this.openRun ? "open" : "" },
                h("button", { type: "button", class: "run-name", onclick: () => { this.openRun = r.id; this.lines = []; this.next = 0; void this.load(); } }, r.label),
                h("span", { class: `run-st ${r.status}` }, r.status === "running" ? "running" : r.status === "stopped" ? "stopped" : `exited ${r.exitCode ?? ""}`.trim()),
                r.url ? h("a", { href: r.url, target: "_blank", rel: "noopener" }, r.url.replace(/^https?:\/\//, "")) : null,
                r.status === "running" ? h("button", { class: "btn", type: "button", onclick: async () => { await post(`/api/run/${r.id}/stop`); void this.load(); } }, "Stop") : null,
              ),
            ),
          )
        : null,
      current ? this.logEl : null,
    ];
    this.el.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
  }
}
