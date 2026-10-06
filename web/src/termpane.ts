// A terminal pane: a real terminal on this machine (your login shell in a folder, or a
// conversation continued in `claude --resume`), drawn with xterm.js. Output streams in as events;
// keystrokes and the window size go back as requests, one at a time so they arrive in order.
// Every terminal you opened keeps its stream while another is shown, so switching back is instant.

import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { TerminalView, TerminalUpdate } from "../../server/api-types.ts";
import { post, withKey } from "./api.ts";
import { h } from "./dom.ts";

interface Tty {
  view: TerminalView;
  xterm: XTerm;
  fit: FitAddon;
  source: EventSource;
  host: HTMLElement;
  opened: boolean;
  pending: string;
  sending: boolean;
  resizeTimer: ReturnType<typeof setTimeout> | null;
  // the command to type for you, from a live session's "Open in terminal"
  hint: string | null;
  error: string | null;
}

export class TermPane {
  readonly el = h("section", { class: "terminal role-you tty-pane", "aria-label": "Terminal" });
  private head = h("header", { class: "term-head" });
  private ttys = new Map<string, Tty>();
  private current: Tty | null = null;
  private onBack: () => void;
  private onOpenLive: (sessionId: string) => void;
  private onChange: () => void;

  constructor(onBack: () => void, onOpenLive: (sessionId: string) => void, onChange: () => void) {
    this.onBack = onBack;
    this.onOpenLive = onOpenLive;
    this.onChange = onChange;
  }

  get shownId(): string | null {
    return this.current?.view.id ?? null;
  }

  async show(v: TerminalView, typeHint: string | null = null) {
    let t = this.ttys.get(v.id);
    if (!t) {
      t = this.create(v);
      this.ttys.set(v.id, t);
    }
    if (typeHint) t.hint = typeHint;
    this.current = t;
    this.el.replaceChildren(this.head, t.host);
    this.drawHead();
    if (!t.opened) {
      t.opened = true;
      // the cell size is measured when the terminal opens, so the font must be ready first
      await document.fonts.load('13px "JetBrains Mono Variable"').catch(() => []);
      t.xterm.open(t.host);
      this.fitNow(t);
      // the fit may land on the size the terminal started with; tell the server once anyway
      void post(`/api/terminals/${t.view.id}/resize`, { cols: t.xterm.cols, rows: t.xterm.rows }).catch(() => {});
    }
    if (this.current !== t) return;
    this.fitNow(t);
    t.xterm.refresh(0, t.xterm.rows - 1);
    t.xterm.focus();
  }

  hide() {
    this.current = null;
  }

  // Close this terminal's stream and drop its screen (after it was closed, or it is gone).
  forget(id: string) {
    const t = this.ttys.get(id);
    if (!t) return;
    t.source.close();
    t.xterm.dispose();
    t.host.remove();
    this.ttys.delete(id);
    if (this.current === t) this.current = null;
  }

  private create(v: TerminalView): Tty {
    const css = getComputedStyle(document.documentElement);
    const token = (n: string) => css.getPropertyValue(n).trim();
    // always dark, like the transcript screen
    const xterm = new XTerm({
      fontFamily: token("--term") || "monospace",
      fontSize: 13,
      scrollback: 5000,
      cursorBlink: true,
      theme: { background: token("--term-bg"), foreground: token("--term-text"), cursor: token("--term-text"), cursorAccent: token("--term-bg"), selectionBackground: `${token("--term-dim")}66` },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new WebLinksAddon());
    const host = h("div", { class: "tty-host" });
    const t: Tty = { view: v, xterm, fit, host, opened: false, pending: "", sending: false, resizeTimer: null, hint: null, error: null, source: new EventSource(withKey(`/api/terminals/${v.id}/events`)) };
    // the browser resumes from the last event id by itself after a dropped connection
    t.source.onmessage = (m) => {
      const u = JSON.parse(m.data) as TerminalUpdate;
      if (u.type === "output") {
        if (u.reset) xterm.reset();
        xterm.write(u.data);
        return;
      }
      xterm.write(`\r\n\x1b[2m[exited${u.exitCode === null ? "" : ` ${u.exitCode}`}]\x1b[0m\r\n`);
      t.view = { ...t.view, status: "exited", exitCode: u.exitCode };
      // nothing more will come
      t.source.close();
      this.ended(t);
    };
    t.source.onerror = () => {
      if (t.source.readyState !== EventSource.CLOSED || t.view.status !== "running") return;
      xterm.write("\r\n\x1b[2mBourne restarted or the terminal was closed; this terminal ended.\x1b[0m\r\n");
      t.view = { ...t.view, status: "exited" };
      this.ended(t);
    };
    xterm.onData((d) => this.queue(t, d));
    xterm.onResize(({ cols, rows }) => {
      if (t.resizeTimer) clearTimeout(t.resizeTimer);
      t.resizeTimer = setTimeout(() => void post(`/api/terminals/${t.view.id}/resize`, { cols, rows }).catch(() => {}), 120);
    });
    new ResizeObserver(() => {
      if (this.current === t && t.opened) requestAnimationFrame(() => this.fitNow(t));
    }).observe(host);
    return t;
  }

  private fitNow(t: Tty) {
    if (!t.host.isConnected || !t.host.clientWidth) return;
    t.fit.fit();
  }

  private ended(t: Tty) {
    if (this.current === t) this.drawHead();
    this.onChange();
  }

  private queue(t: Tty, data: string) {
    if (t.view.status !== "running") return;
    t.pending += data;
    if (!t.sending) void this.flush(t);
  }

  // One request at a time, so keystrokes arrive in the order you typed them.
  private async flush(t: Tty) {
    t.sending = true;
    while (t.pending) {
      const data = t.pending;
      t.pending = "";
      try {
        await post(`/api/terminals/${t.view.id}/input`, { data });
        if (t.error) {
          t.error = null;
          if (this.current === t) this.drawHead();
        }
      } catch (err) {
        t.pending = "";
        t.error = (err as Error).message;
        if (this.current === t) this.drawHead();
        break;
      }
    }
    t.sending = false;
  }

  private drawHead() {
    const t = this.current;
    if (!t) return;
    const v = t.view;
    const name = v.cwd.split("/").filter(Boolean).pop() ?? v.cwd;
    const running = v.status === "running";
    const parts: (HTMLElement | null)[] = [
      h("button", { class: "back", type: "button", onclick: () => this.onBack() }, "← Offices"),
      h("h2", {}, name),
      h(
        "div",
        { class: "meta" },
        h("span", { class: "badge" }, "Terminal"),
        h("span", { title: v.cwd }, shortPath(v.cwd)),
        h("span", {}, v.title),
        h("span", { class: running ? "live" : "" }, running ? "Running" : `Exited${v.exitCode === null ? "" : ` ${v.exitCode}`}`),
      ),
      h(
        "div",
        { class: "row live-controls" },
        t.hint && running
          ? h("button", { class: "btn", type: "button", title: "Types it for you; press Enter in the terminal to run it", onclick: () => { this.queue(t, t.hint!); t.hint = null; this.drawHead(); t.xterm.focus(); } }, `Type ${t.hint}`)
          : null,
        !running && v.kind === "claude" && v.sessionId
          ? h("button", { class: "btn primary", type: "button", onclick: () => this.onOpenLive(v.sessionId!) }, "Open live again")
          : null,
        h("button", { class: "btn ghost", type: "button", onclick: () => void this.close(t) }, "Close terminal"),
      ),
      t.error ? h("p", { class: "notice bad", role: "alert" }, t.error) : null,
    ];
    this.head.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  }

  private async close(t: Tty) {
    try {
      await post(`/api/terminals/${t.view.id}/close`);
    } catch {
      // gone already (Annex restarted); drop it here too
    }
    this.forget(t.view.id);
    this.onChange();
    this.onBack();
  }
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : p;
}
