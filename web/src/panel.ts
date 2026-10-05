// The case file for the selected wing: what it is doing, what the lead is asking, the chat, the
// brief, and every setting, which can be changed here and apply at once.

import type { WingView, WingEdit, ChangesView } from "../../server/api-types.ts";
import type { BourneEvent } from "../../server/events.ts";
import { describe } from "./log.ts";
import { post, apiFetch } from "./api.ts";
import { h } from "./dom.ts";
import { officeBadge } from "./sidebar.ts";
import { RunPanel } from "./runpanel.ts";

type Tab = "goals" | "log" | "talk" | "brief" | "loot" | "run" | "settings";

const MODELS = ["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"];

export class Panel {
  readonly el = h("section", { class: "panel", "aria-label": "Selected office" });
  private wing: WingView | null = null;
  private tab: Tab = "log";
  private events: BourneEvent[] = [];
  private busy = "";
  private error = "";
  private saved = "";
  private refresh: () => void;
  private runPanel = new RunPanel();
  // the Ready to merge tab's changes, kept across redraws: which office, the files, the open one
  private changes: { wing: string; view: ChangesView | null; error: string; file: string | null; patch: string } = { wing: "", view: null, error: "", file: null, patch: "" };

  constructor(refresh: () => void) {
    this.refresh = refresh;
  }

  show(wing: WingView, events: BourneEvent[]) {
    const switched = this.wing?.id !== wing.id;
    this.wing = wing;
    // tool calls belong in each agent's terminal; the office log is for decisions
    this.events = events.filter((e) => e.wingId === wing.id && e.kind !== "agent.tool");
    if (switched) {
      this.tab = wing.goals.some((g) => g.status === "active") ? "goals" : wing.mode === "with_you" ? "talk" : "log";
      this.error = "";
      this.saved = "";
    }
    // a settings form being edited is not redrawn under the person's hands
    if (!switched && this.tab === "settings" && this.el.contains(document.activeElement)) return;
    this.render();
  }

  push(e: BourneEvent) {
    if (!this.wing || e.wingId !== this.wing.id || e.kind === "agent.tool") return;
    this.events.push(e);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    if (this.tab === "log") {
      const list = this.el.querySelector(".log");
      if (list) {
        list.querySelector(".empty")?.remove();
        list.append(this.logItem(e));
        list.scrollTop = list.scrollHeight;
      }
    }
  }

  private nameOf = (id: string) => this.wing?.agents.find((a) => a.id === id)?.name ?? "someone";
  private roleOf = (id: string) => (id === "you" ? "who-you" : id === "annex" ? "who-annex" : `role-${this.wing?.agents.find((a) => a.id === id)?.role ?? "worker"}`);
  private titleOf = (id: string) => this.wing?.tasks.find((t) => t.id === id)?.title ?? "a task";

  private logItem(e: BourneEvent) {
    const l = describe(e, this.nameOf, this.titleOf);
    return h("li", { class: `tone-${l.tone} ${this.roleOf(e.actor)}` }, h("time", {}, l.time), h("b", {}, l.who), h("span", {}, l.text));
  }

  // `after` runs only when the request succeeded, before the panel redraws.
  private async act(label: string, path: string, body: unknown = {}, after?: () => void, method = "POST") {
    this.busy = label;
    this.error = "";
    this.saved = "";
    this.render();
    try {
      if (method === "POST") {
        await post(path, body);
      } else {
        const r = await apiFetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
      }
      after?.();
      this.refresh();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.busy = "";
      this.render();
    }
  }

  private render() {
    // keep anything half-typed, and the cursor, across re-renders
    const fields = new Map<string, string>();
    for (const f of this.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-keep]")) fields.set(f.dataset.keep!, f.value);
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.keep;
    this.draw();
    for (const f of this.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-keep]")) {
      const k = f.dataset.keep!;
      if (fields.has(k)) f.value = fields.get(k)!;
      if (k === focused) f.focus();
    }
  }

  private clear(...keys: string[]) {
    for (const k of keys) {
      const f = this.el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-keep="${k}"]`);
      if (f) f.value = "";
    }
  }

  private draw() {
    const w = this.wing;
    this.el.replaceChildren();
    if (!w) return;
    const base = `/api/wings/${encodeURIComponent(w.id)}`;
    const busy = !!this.busy;

    // On: the lead runs the office and finds its own work. Off: it works on what you ask for.
    const on = w.mode === "autonomous";
    const modeButton = h(
      "button",
      {
        class: `switch${on ? " on" : ""}`,
        type: "button",
        role: "switch",
        "aria-checked": String(on),
        disabled: busy || !!w.offline,
        title: on ? "The lead runs this office and finds work for its goals by itself" : "The lead works on what you ask for, then waits",
        onclick: () => this.act(on ? "Turning autonomy off" : "Turning autonomy on", `${base}/autonomy`, { on: !on }, () => (this.tab = on ? "talk" : "goals")),
      },
      h("span", { class: "track", "aria-hidden": "true" }, h("i", {})),
      "Autonomous",
    );
    const crew = w.agents.filter((a) => a.role === "worker").length;
    const hireButton = h(
      "button",
      { class: "btn", type: "button", disabled: busy || !!w.offline || crew >= w.settings.maxWorkers, title: `${crew} of ${w.settings.maxWorkers} workers`, onclick: () => this.act("Hiring", `${base}/hire`, { count: 1 }) },
      `+ Hire (${crew}/${w.settings.maxWorkers})`,
    );
    const holdButton = w.held
      ? h("button", { class: "btn", type: "button", disabled: busy, onclick: () => this.act("Resuming", `${base}/resume`) }, w.paused ? "Resume" : "Resume now")
      : h("button", { class: "btn ghost", type: "button", disabled: busy, title: "Stops wakes and new tasks; work already running finishes", onclick: () => this.act("Pausing", `${base}/pause`) }, "Pause");

    this.el.append(
      h(
        "header",
        { class: "panel-head" },
        officeBadge(w),
        h("h2", {}, w.name),
        h("p", { class: "where" }, w.repo ? `${w.repo.replace(/^\/Users\/[^/]+/, "~")} → ${w.integrationBranch}` : "No repo yet. Set one in Settings to hand this office off."),
        w.houseRules.length ? h("p", { class: "where" }, `House rules: ${w.houseRules.join(", ")} (enforced on every task)`) : null,
        h("div", { class: "actions" }, modeButton, hireButton, holdButton),
      ),
    );
    if (w.offline) this.el.append(h("p", { class: "notice bad" }, `Not connected to the engine: ${w.offline}`));
    if (w.held && !w.paused) {
      const until = w.held.until ? new Date(w.held.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
      this.el.append(h("div", { class: "notice warn" }, h("b", {}, `CLOSED${until ? ` UNTIL ${until}` : ""}. `), `${w.held.reason}. No new work starts and chat is off until then; a run Claude had queued retries at the reset. It opens again by itself, or press Resume now if the limit has reset.`));
    } else if (w.paused) {
      this.el.append(h("div", { class: "notice" }, h("b", {}, "Paused. "), "The lead won't wake and no new tasks start. Work already running finishes, and its checks and merges still happen."));
    } else if (w.mode === "autonomous" && w.nextWake.blockedBy) {
      const b = w.nextWake.blockedBy;
      // "the lead is reading the signals now" is good news, not a reason it is stuck
      this.el.append(h("div", { class: "notice" }, b.startsWith("the lead is") ? `${b[0]!.toUpperCase()}${b.slice(1)}.` : `The lead is not waking: ${b}.`));
    }
    if (this.busy) this.el.append(h("p", { class: "notice" }, `${this.busy}...`));
    if (this.error) this.el.append(h("p", { class: "notice bad", role: "alert" }, this.error));

    if (w.asks.length) {
      this.el.append(
        h(
          "div",
          { class: "quests" },
          ...w.asks.map((a) =>
            h(
              "div",
              { class: "quest" },
              h("div", { class: "label" }, "The lead asks"),
              h("h3", {}, a.title),
              h("p", {}, a.reason),
              h(
                "div",
                { class: "row" },
                h("button", { class: "btn good", type: "button", disabled: busy, onclick: () => this.act("Approving", `${base}/asks/${a.id}/approve`) }, "Accept"),
                h("button", { class: "btn bad", type: "button", disabled: busy, onclick: () => this.act("Declining", `${base}/asks/${a.id}/decline`) }, "Decline"),
              ),
            ),
          ),
        ),
      );
    }

    const active = w.goals.filter((g) => g.status === "active").length;
    const tabs: [Tab, string, number][] = [["goals", active ? `Goals ${active}` : "Goals", 0], ["log", "Log", 0], ["talk", "Talk", 0], ["brief", "Brief", w.draft ? 1 : 0], ["loot", `Ready to merge ${w.loot.commits.length}`, 0], ["run", "Run", 0], ["settings", "Settings", 0]];
    this.el.append(
      h(
        "nav",
        { class: "tabs", role: "tablist" },
        ...tabs.map(([id, label, badge]) =>
          h("button", { type: "button", role: "tab", "aria-selected": String(this.tab === id), onclick: () => { this.tab = id; this.saved = ""; this.render(); } }, label, badge ? h("span", { class: "dot" }, "●") : null),
        ),
      ),
    );
    const body = h("div", { class: "tab-body", role: "tabpanel" });
    this.el.append(body);

    if (this.tab === "goals") this.drawGoals(body, w, base, busy);
    if (this.tab === "log") this.drawLog(body, w, base, busy);
    if (this.tab === "talk") this.drawTalk(body, w, base, busy);
    if (this.tab === "brief") this.drawBrief(body, w, base, busy);
    if (this.tab === "loot") this.drawLoot(body, w);
    if (this.tab === "settings") this.drawSettings(body, w, base, busy);
    if (this.tab === "run") {
      if (w.repo) {
        this.runPanel.show({ wing: w.id });
        body.append(this.runPanel.el);
      } else {
        body.append(h("p", { class: "empty" }, "This office has no repo to run."));
      }
    } else {
      this.runPanel.hide();
    }
  }

  private drawGoals(body: HTMLElement, w: WingView, base: string, busy: boolean) {
    const text = h("textarea", { "data-keep": "goal", rows: 2, required: true, placeholder: "QA test the whole app", "aria-label": "Goal" });
    const doneWhen = h("input", { "data-keep": "doneWhen", placeholder: "Every user flow has a passing test", "aria-label": "Done when" });
    const list = h("ol", { class: "goals" });
    for (const g of w.goals) {
      const counts = [g.open ? `${g.open} running` : "", g.finished ? `${g.finished} merged` : ""].filter(Boolean).join(", ");
      list.append(
        h(
          "li",
          { class: `goal ${g.status}` },
          h("div", { class: "goal-head" }, h("span", { class: "num" }, String(g.id)), h("h3", {}, g.text), g.status !== "active" ? h("span", { class: "badge" }, g.status === "done" ? "Done" : "Dropped") : null),
          h("p", { class: "goal-meta" }, g.ongoing ? "Ongoing: the lead keeps finding the next step" : `Done when ${g.doneWhen}`, counts ? `. ${counts[0]!.toUpperCase()}${counts.slice(1)}.` : ""),
          g.plan ? h("pre", { class: "plan" }, g.plan) : g.status === "active" ? h("p", { class: "empty" }, "No plan yet. The lead writes one on its next wake.") : null,
          g.note ? h("p", { class: "goal-meta" }, g.note) : null,
          h(
            "div",
            { class: "row" },
            g.status === "active" && !g.ongoing ? h("button", { class: "btn", type: "button", disabled: busy, onclick: () => this.act("Marking it done", `${base}/goals/${g.id}/done`) }, "Mark done") : null,
            g.status === "active" ? h("button", { class: "btn ghost", type: "button", disabled: busy, onclick: () => this.act("Dropping it", `${base}/goals/${g.id}/drop`) }, "Drop") : null,
            g.status !== "active" ? h("button", { class: "btn ghost", type: "button", disabled: busy, onclick: () => this.act("Reopening it", `${base}/goals/${g.id}/reopen`) }, "Reopen") : null,
          ),
        ),
      );
    }
    if (!w.goals.length) list.append(h("li", { class: "empty" }, "No goals yet. Give this office something to achieve and its lead breaks it into tasks for the crew."));
    body.append(
      list,
      h(
        "form",
        {
          onsubmit: (ev: Event) => {
            ev.preventDefault();
            void this.act("Setting the goal", `${base}/goals`, { text: text.value, doneWhen: doneWhen.value }, () => this.clear("goal", "doneWhen"));
          },
        },
        h("h3", {}, "New goal"),
        text,
        h("div", { class: "field" }, h("label", {}, "Done when", doneWhen), h("span", { class: "hint" }, "Leave empty for an ongoing goal the lead never stops on.")),
        h("button", { class: "btn primary", type: "submit", disabled: busy || !!w.offline || !w.repo, title: w.repo ? "" : "Set a repo in Settings first" }, "Set goal"),
      ),
    );
  }

  private drawLog(body: HTMLElement, w: WingView, base: string, busy: boolean) {
    const list = h("ol", { class: "log" }, ...this.events.map((e) => this.logItem(e)));
    if (this.events.length === 0) list.append(h("li", { class: "empty" }, "Nothing has happened in this office yet."));
    const title = h("input", { "data-keep": "title", required: true, placeholder: "What needs doing", "aria-label": "Task title" });
    const detail = h("textarea", { "data-keep": "detail", rows: 2, placeholder: "Details the lead should know (optional)", "aria-label": "Task details" });
    body.append(
      list,
      h(
        "form",
        {
          onsubmit: (ev: Event) => {
            ev.preventDefault();
            void this.act("Adding it to the inbox", `${base}/tasks`, { title: title.value, detail: detail.value }, () => this.clear("title", "detail"));
          },
        },
        h("h3", {}, "Drop in a task"),
        title,
        detail,
        h("button", { class: "btn", type: "submit", disabled: busy || !!w.offline }, w.mode === "with_you" ? "Tell the lead" : "Add to the lead's inbox"),
      ),
    );
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
  }

  private drawTalk(body: HTMLElement, w: WingView, base: string, busy: boolean) {
    if (w.mode === "autonomous") {
      body.append(h("p", { class: "empty" }, `${w.name} runs on its own. Turn Autonomous off to talk with its lead, or set a goal in Goals.`));
      return;
    }
    const list = h("ol", { class: "chat" }, ...w.chat.map((m) => h("li", { class: m.who }, h("b", {}, m.who === "you" ? "You" : "Lead"), h("p", {}, m.text))));
    if (w.chat.length === 0) list.append(h("li", { class: "empty" }, "Tell the lead what you want. Small things become tasks straight away; anything bigger becomes a goal it plans and works through. Turn on Autonomous when it should also find work by itself."));
    const text = h("textarea", { "data-keep": "message", rows: 3, required: true, placeholder: "Message the lead", "aria-label": "Message the lead" });
    text.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) (ev.target as HTMLTextAreaElement).form?.requestSubmit();
    });
    body.append(
      list,
      h(
        "form",
        { onsubmit: (ev: Event) => { ev.preventDefault(); void this.act("Sending", `${base}/chat`, { text: text.value }, () => this.clear("message")); } },
        text,
        h("button", { class: "btn", type: "submit", disabled: busy || !!w.offline || (!!w.held && !w.paused), title: w.held && !w.paused ? "Closed for the usage limit" : "" }, w.held && !w.paused ? "Closed" : "Send ⌘↵"),
      ),
    );
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
  }

  private drawBrief(body: HTMLElement, w: WingView, base: string, busy: boolean) {
    if (w.draft) {
      body.append(
        h("h3", {}, `Draft brief, version ${w.draft.version}`),
        h("pre", { class: "brief draft" }, w.draft.text),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn primary", type: "button", disabled: busy, onclick: () => this.act("Approving the brief", `${base}/briefs/${w.draft!.id}/approve`) }, "Approve and turn on Autonomous"),
          h("button", { class: "btn", type: "button", onclick: () => { this.tab = "talk"; this.render(); } }, "Keep talking"),
        ),
      );
    }
    if (w.brief) body.append(h("h3", {}, `Brief in force, version ${w.brief.version}`), h("pre", { class: "brief" }, w.brief.text));
    if (!w.draft && !w.brief) {
      body.append(h("p", { class: "empty" }, w.charter ? "This office runs on its charter:" : "No brief. The charter and the Goals tab tell the lead what to work on."));
      if (w.charter) body.append(h("pre", { class: "brief" }, w.charter));
    }
  }

  // Verified work waiting on the integration branch. Annex never merges into the person's own
  // branch; this is the list and the one command to do it.
  private drawLoot(body: HTMLElement, w: WingView) {
    if (!w.loot.commits.length) {
      body.append(h("p", { class: "empty" }, w.repo ? `Nothing waiting. Verified work lands on ${w.integrationBranch}; it shows up here until you merge it.` : "This office has no repo yet."));
      return;
    }
    const cmd = w.loot.command!;
    const copy = h("button", { class: "btn", type: "button", onclick: async () => { await navigator.clipboard?.writeText(cmd).catch(() => {}); copy.textContent = "Copied"; } }, "Copy");
    body.append(
      h("h3", {}, `${w.loot.commits.length} verified commit${w.loot.commits.length === 1 ? "" : "s"} waiting on ${w.integrationBranch}`),
      h("ol", { class: "log loot" }, ...w.loot.commits.map((c) => h("li", {}, h("time", {}, c.date.slice(5)), h("b", { style: "font-family: var(--term)" }, c.sha), h("span", {}, c.subject)))),
    );
    this.drawChanges(body, w);
    body.append(
      h("p", { class: "empty" }, "Or merge it yourself in a terminal:"),
      h("div", { class: "row" }, h("pre", { class: "brief", style: "flex: 1; margin: 0" }, cmd), copy),
    );
  }

  // Every file the office changed, and any file's diff: what you are about to merge.
  private drawChanges(body: HTMLElement, w: WingView) {
    // read again whenever new work lands on the branch
    const key = `${w.id}:${w.loot.commits[0]?.sha ?? ""}`;
    if (this.changes.wing !== key) {
      this.changes = { wing: key, view: null, error: "", file: null, patch: "" };
      void this.loadChanges(w.id, key);
    }
    const c = this.changes;
    if (c.error) return body.append(h("p", { class: "notice bad" }, c.error));
    if (!c.view) return body.append(h("p", { class: "empty" }, "Reading the changes…"));
    const v = c.view;
    const total = v.files.reduce((n, f) => [n[0]! + f.added, n[1]! + f.removed], [0, 0]);
    body.append(
      h("h3", {}, `${v.files.length} file${v.files.length === 1 ? "" : "s"} changed, +${total[0]} −${total[1]}`),
      h(
        "ol",
        { class: "files" },
        ...v.files.map((f) =>
          h(
            "li",
            {},
            h(
              "button",
              { type: "button", class: `file${c.file === f.path ? " open" : ""}`, "aria-expanded": String(c.file === f.path), onclick: () => void this.openFile(w.id, f.path) },
              h("span", { class: `st st-${f.status}`, title: { A: "added", M: "changed", D: "deleted" }[f.status] ?? f.status }, f.status),
              h("span", { class: "path" }, f.path),
              h("span", { class: "n" }, h("span", { class: "add" }, `+${f.added}`), " ", h("span", { class: "del" }, `−${f.removed}`)),
            ),
            c.file === f.path ? patchView(c.patch) : null,
          ),
        ),
      ),
    );
  }

  private async loadChanges(wingId: string, key: string) {
    const r = await apiFetch(`/api/wings/${encodeURIComponent(wingId)}/changes`);
    const data = await r.json().catch(() => ({}));
    if (this.changes.wing !== key) return;
    if (r.ok) this.changes.view = data as ChangesView;
    else this.changes.error = (data as { error?: string }).error ?? `Annex answered ${r.status}`;
    this.render();
  }

  private async openFile(wingId: string, file: string) {
    if (this.changes.file === file) {
      this.changes.file = null;
      return this.render();
    }
    this.changes.file = file;
    this.changes.patch = "";
    this.render();
    const r = await apiFetch(`/api/wings/${encodeURIComponent(wingId)}/changes?file=${encodeURIComponent(file)}`);
    const data = (await r.json().catch(() => ({}))) as { patch?: string; error?: string };
    if (this.changes.file !== file) return;
    this.changes.patch = r.ok ? data.patch ?? "" : `Could not read the diff: ${data.error ?? r.status}`;
    this.render();
  }

  private drawSettings(body: HTMLElement, w: WingView, base: string, busy: boolean) {
    const e = w.edit;
    const s = w.settings;
    const input = (k: string, value: string, attrs: Record<string, string | number | boolean> = {}) => h("input", { "data-keep": `set-${k}`, name: k, value, ...attrs });
    const field = (label: string, control: HTMLElement, hint?: string) => h("div", { class: "field" }, h("label", {}, label, control), hint ? h("span", { class: "hint" }, hint) : null);
    const backoff = h("input", { type: "checkbox", name: "backOffWhenIdle", checked: s.backOffWhenIdle, id: "backoff" });
    const charter = h("textarea", { "data-keep": "set-charter", name: "charter", rows: 5 });
    charter.value = e.charter;
    const askBefore = h("textarea", { "data-keep": "set-askBefore", name: "askBefore", rows: 3, placeholder: "One per line, e.g. adding a new dependency" });
    askBefore.value = s.askBefore.join("\n");

    const form = h(
      "form",
      {
        class: "settings-form",
        onsubmit: (ev: Event) => {
          ev.preventDefault();
          const f = new FormData(ev.target as HTMLFormElement);
          const val = (k: string) => String(f.get(k) ?? "").trim();
          const edit: WingEdit = {
            name: val("name"),
            charter: val("charter"),
            repoPath: val("repoPath") || null,
            baseBranch: val("baseBranch") || "main",
            doneCheck: val("doneCheck") || null,
            setup: val("setup") || null,
            workers: Number(val("workers")),
            leadModel: val("leadModel"),
            workerModel: val("workerModel"),
            reviewerModel: val("reviewerModel"),
            wakeEvery: val("wakeEvery"),
            maxRunsPerHour: val("maxRunsPerHour") ? Number(val("maxRunsPerHour")) : null,
            quietHours: val("quietFrom") && val("quietTo") ? `${val("quietFrom")}-${val("quietTo")}` : null,
            backOffWhenIdle: backoff.checked,
            maxWorkers: Number(val("maxWorkers")),
            maxTasksPerWake: Number(val("maxTasksPerWake")),
            checkAttempts: Number(val("checkAttempts")),
            checkTimeout: val("checkTimeout"),
            wakeTimeout: val("wakeTimeout"),
            maxBackoff: val("maxBackoff"),
            askBefore: val("askBefore").split("\n"),
            allow: val("allow").split(/[,\s]+/).filter(Boolean),
            plugins: val("plugins").split(/[,\s]+/).filter(Boolean),
          };
          void this.act("Saving and applying", base, edit, () => (this.saved = "Saved. The office is using the new settings."), "PUT");
        },
      },
      h("datalist", { id: "models" }, ...MODELS.map((m) => h("option", { value: m }))),
      h(
        "fieldset",
        {},
        h("legend", {}, "The office"),
        field("Name", input("name", e.name, { required: true })),
        field("Charter", charter, "What the lead works toward. Each task must quote a line of it."),
        h("div", { class: "two" }, field("Repo", input("repoPath", e.repoPath ?? "", { placeholder: "~/Projects/my-app" })), field("Base branch", input("baseBranch", e.baseBranch))),
        field("Done check", input("doneCheck", e.doneCheck ?? "", { placeholder: "npm test" }), "Annex runs this itself before a task can count as done."),
        field("Setup", input("setup", e.setup ?? "", { placeholder: "npm ci" }), "Run in a fresh worktree before checks."),
      ),
      h(
        "fieldset",
        {},
        h("legend", {}, "The crew"),
        h("div", { class: "two" }, field("Workers", input("workers", String(e.workers), { type: "number", min: 1, max: 20 })), field("Most workers", input("maxWorkers", String(s.maxWorkers), { type: "number", min: 1, max: 20 }), "The lead may hire up to this.")),
        h("div", { class: "two" }, field("Lead model", input("leadModel", e.leadModel, { list: "models" })), field("Crew model", input("workerModel", e.workerModel, { list: "models" }))),
        field("Reviewer model", input("reviewerModel", e.reviewerModel, { list: "models" })),
        field("Commands the crew may run", input("allow", e.allow.join(", "), { placeholder: "npm, npx, node" })),
        field("Plugins", input("plugins", e.plugins.join(", "), { placeholder: "smith@the-tavern, sage@the-tavern" }), "Claude Code plugins the crew may use. Install them in Claude Code first; Annex turns them on for this office only."),
      ),
      h(
        "fieldset",
        {},
        h("legend", {}, "Pace and limits (all optional)"),
        h("div", { class: "two" }, field("Wake every", input("wakeEvery", s.wakeEvery, { placeholder: "15m" })), field("Runs per hour", input("maxRunsPerHour", s.maxRunsPerHour === null ? "" : String(s.maxRunsPerHour), { type: "number", min: 1, placeholder: "No limit" }))),
        h("div", { class: "two" }, field("Quiet from", input("quietFrom", s.quietHours?.split("-")[0] ?? "", { type: "time" })), field("Quiet until", input("quietTo", s.quietHours?.split("-")[1] ?? "", { type: "time" }))),
        h("div", { class: "field check" }, backoff, h("label", { for: "backoff" }, "Back off when idle: wait longer after wakes that found nothing")),
        field("Ask me before", askBefore, "The lead raises its hand for these instead of starting them."),
        h("div", { class: "two" }, field("Tasks per wake", input("maxTasksPerWake", String(s.maxTasksPerWake), { type: "number", min: 1, max: 20 })), field("Check attempts", input("checkAttempts", String(s.checkAttempts), { type: "number", min: 1, max: 20 }), "Then the task goes back to the lead.")),
        h("div", { class: "two" }, field("Check timeout", input("checkTimeout", s.checkTimeout, { placeholder: "15m" })), field("Wake timeout", input("wakeTimeout", s.wakeTimeout, { placeholder: "30m" }), "How long the lead has to answer.")),
        field("Longest back-off", input("maxBackoff", s.maxBackoff, { placeholder: "24h" })),
      ),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", disabled: busy }, "Save"), this.saved ? h("span", { class: "saved" }, this.saved) : null),
    );
    body.append(form);
  }
}

// A unified diff, lines coloured by what they do; the file headers are dropped.
function patchView(patch: string): HTMLElement {
  if (!patch) return h("p", { class: "empty" }, "Loading the diff…");
  const lines = patch.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l));
  return h("pre", { class: "patch" }, ...lines.map((l) => h("div", { class: l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "" }, l || " ")));
}
