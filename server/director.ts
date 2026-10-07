// The director: one agent above every office. It never holds a repo, a rulebook or signal output,
// only a line per office, so its context stays small however many offices there are. You talk to
// it; it answers from that summary, asks when unsure, and routes work by returning a
// `annex-route` block that Annex carries out. Each office's lead still does the planning.

import { randomUUID } from "node:crypto";
import type { Store } from "./db.ts";
import type { Paperclip, Frame } from "./engine/paperclip.ts";
import type { Logger } from "./logger.ts";
import type { StateView, ChatView } from "./api-types.ts";
import { fenceTag, findFence, parseLenient } from "./proposal.ts";
import { REPORT_SCRIPT } from "./prompts.ts";
import { UserError } from "./http.ts";

export const DIRECTOR_ID = "director";
export const ROUTE_FENCE = "annex-route";

export type RouteAction =
  | { do: "drop_in"; office: string; title: string; detail?: string }
  | { do: "add_goal"; office: string; text: string; done_when?: string }
  | { do: "new_office"; id: string; name: string; repo?: string; base_branch?: string; charter?: string; new_repo?: boolean }
  | { do: "hire"; office: string; count?: number }
  | { do: "pause"; office: string }
  | { do: "resume"; office: string }
  | { do: "come_back"; office: string };

// What the director may ask Annex to do. Handing an office off is not here: that needs the person
// to approve the lead's brief.
export interface Offices {
  state(): Promise<StateView>;
  dropIn(wingId: string, title: string, detail: string): Promise<unknown>;
  addGoal(wingId: string, text: string, doneWhen: string | null, by: "director"): Promise<unknown>;
  createWing(n: { id: string; name: string; repoPath?: string; baseBranch?: string; charter?: string; newRepo?: boolean }): Promise<unknown>;
  hireFromOffice(wingId: string, count: number): Promise<unknown>;
  pause(wingId: string): void;
  resume(wingId: string): void;
  comeBack(wingId: string): Promise<void>;
}

export function directorInstructions(): string {
  return `# You are Annex's director

Annex runs several offices. Each office has its own lead, crew and reviewer, its own repo, and its
own rules; the leads plan, the crews do the work, Annex checks it. You sit above all of them and
talk with the person. You never open a repo or do the work yourself.

Every message from the person comes with a summary of every office, one line each, under
"Offices right now". Answer questions about how things are going from that summary, plainly.
When the person wants work done, decide which office it belongs to and route it. If it fits no
office, say so and suggest opening one; only open an office when the person asks for it. When you
are not sure which office they mean, ask.

To act, end your reply with one fenced block tagged \`${ROUTE_FENCE}\` holding a JSON list:

\`\`\`${ROUTE_FENCE}
[
  { "do": "add_goal", "office": "upkeep", "text": "QA test the whole app", "done_when": "every user flow has a passing test" },
  { "do": "drop_in", "office": "upkeep", "title": "Short imperative title", "detail": "What the lead needs to know" },
  { "do": "new_office", "id": "docs", "name": "Docs", "repo": "~/Projects/x", "base_branch": "main", "charter": "What it keeps true" },
  { "do": "new_office", "id": "printshop", "name": "Print shop", "new_repo": true, "charter": "A store selling abstract prints" },
  { "do": "hire", "office": "upkeep", "count": 1 },
  { "do": "pause", "office": "studio" },
  { "do": "resume", "office": "studio" },
  { "do": "come_back", "office": "upkeep" }
]
\`\`\`

- \`add_goal\` gives an office something to achieve; its lead plans it and keeps handing out the
  steps until \`done_when\` holds. Leave \`done_when\` out for an ongoing goal ("keep adding art").
  Use it for anything bigger than a single task. Never list the steps yourself.
- \`drop_in\` hands the office's lead one piece of work; the lead turns it into tasks under its
  own rules.
- Use the office ids from the summary.
- For a project that does not exist yet, \`new_office\` with \`"new_repo": true\` makes an empty
  repo at ~/Projects/<id>; then give it the person's idea as a goal with \`add_goal\`.
- Leave the block out when you are only answering or asking.
- Handing an office off to run on its own is the person's decision in that office's file; tell
  them where to do it rather than doing it.

Annex carries out the block and appends what happened to your reply. Keep replies short.

## Working here

There is no one to approve a refused command in these runs. Do not run shell commands. Your reply
is your final message; Annex reads it from the chat. If you ever need to post explicitly, use:
\`node ${REPORT_SCRIPT} comment <<'MD'\` ... \`MD\`.
`;
}

export function summarize(state: StateView): string {
  if (!state.wings.length) return "No offices yet.";
  return state.wings
    .map((w) => {
      const crew = w.agents.filter((a) => a.role === "worker").length;
      const working = w.agents.filter((a) => a.status === "running").length;
      const status = w.offline ? `offline (${w.offline})` : w.paused ? "paused" : w.held ? `closed until ${w.held.until ?? "?"} (${w.held.reason})` : w.mode === "autonomous" ? "on its own" : "with the person";
      const repo = w.repo ? w.repo.replace(/^\/Users\/[^/]+/, "~") : "no repo";
      return `- ${w.id} "${w.name}": ${status}; ${repo}; crew ${crew}, ${working} working; ${w.tasks.length} open, ${w.filedCount} verified; ${w.asks.length} asks waiting${w.charter ? `; charter: ${w.charter.split("\n").filter(Boolean)[0]?.slice(0, 90)}` : ""}`;
    })
    .join("\n");
}

export function parseRoute(body: string): { actions: RouteAction[]; error: string | null } {
  const raw = findFence(body, ROUTE_FENCE);
  if (raw === null) return { actions: [], error: null };
  try {
    const v = parseLenient(raw);
    const list = Array.isArray(v) ? v : [v];
    return { actions: list.filter((a) => a && typeof a === "object" && typeof a.do === "string"), error: null };
  } catch (err) {
    return { actions: [], error: `the route block is not valid JSON: ${(err as Error).message}` };
  }
}

export function stripRoute(body: string): string {
  return body.replace(new RegExp("```" + fenceTag(ROUTE_FENCE) + "[\\s\\S]*?```"), "").trim();
}

export class Director {
  private store: Store;
  private pc: Paperclip;
  private logger: Logger;
  private offices: Offices;
  private claudeCommand: string;
  private settingsFile: string;
  private model: string;
  private stop: (() => void) | null = null;
  offline: string | null = "starting";
  agentId: string | null = null;
  status = "idle";

  constructor(opts: { store: Store; pc: Paperclip; logger: Logger; offices: Offices; claudeCommand: string; settingsFile: string; model?: string }) {
    this.store = opts.store;
    this.pc = opts.pc;
    this.logger = opts.logger;
    this.offices = opts.offices;
    this.claudeCommand = opts.claudeCommand;
    this.settingsFile = opts.settingsFile;
    this.model = opts.model ?? "claude-sonnet-5";
  }

  // Creates the director's company and agent once, and re-syncs its instructions every start.
  async connect() {
    if (!this.offline) return;
    try {
      const row = this.store.ensureWing(DIRECTOR_ID, "with_you");
      let companyId = row.companyId;
      if (companyId && !(await this.pc.companies()).some((c) => c.id === companyId)) companyId = null;
      if (!companyId) {
        companyId = (await this.pc.createCompany("Annex · Director", "Annex's director: talks with the person and routes work to the offices.")).id;
        this.store.setCompany(DIRECTOR_ID, companyId);
        for (const a of this.store.agents(DIRECTOR_ID)) this.store.removeAgent(a.id);
      }
      const spec = {
        name: "Director",
        role: "ceo" as const,
        title: "Annex director",
        model: this.model,
        instructions: directorInstructions(),
        claudeCommand: this.claudeCommand,
        settingsFile: this.settingsFile,
        allowedTools: ["Read", `Bash(node ${REPORT_SCRIPT}:*)`],
      };
      const existing = new Set((await this.pc.agents(companyId)).map((a) => a.id));
      let agent = this.store.agents(DIRECTOR_ID).find((a) => existing.has(a.id));
      if (agent) {
        await this.pc.syncAgent(agent.id, spec);
      } else {
        const created = await this.pc.createAgent(companyId, spec);
        agent = this.store.addAgent({ id: created.id, wingId: DIRECTOR_ID, role: "lead", name: "Director" });
      }
      this.agentId = agent.id;
      this.stop?.();
      this.stop = this.pc.subscribe(companyId, (f) => void this.onFrame(f).catch((e) => this.logger.warn(DIRECTOR_ID, `could not handle a frame: ${e.message}`)));
      this.offline = null;
      this.logger.info(DIRECTOR_ID, "connected");
    } catch (err) {
      this.offline = (err as Error).message;
      this.logger.warn(DIRECTOR_ID, `not connected: ${this.offline}`);
    }
  }

  close() {
    this.stop?.();
  }

  chat(): ChatView[] {
    return this.store.chat(DIRECTOR_ID).map((c) => ({ id: c.id, at: c.at, who: c.who, text: c.text }));
  }

  private async chatIssue(): Promise<string> {
    const row = this.store.wing(DIRECTOR_ID)!;
    if (row.chatIssueId) return row.chatIssueId;
    const chat = await this.pc.openChat(row.companyId!, this.agentId!);
    this.store.setChatIssue(DIRECTOR_ID, chat.id);
    return chat.id;
  }

  async say(text: string) {
    if (this.offline || !this.agentId) throw new UserError(`The director is not connected: ${this.offline ?? "starting"}`, 409);
    const summary = summarize(await this.offices.state());
    const issueId = await this.chatIssue();
    const body = `${text}\n\n---\nOffices right now (from Annex):\n${summary}`;
    const comment = await this.pc.comment(issueId, body, randomUUID());
    this.store.addChat(DIRECTOR_ID, "you", text, comment.id);
    this.logger.info(DIRECTOR_ID, `you: ${text.slice(0, 160)}`);
  }

  // Reads the director's replies, carries out any route block, and stores what happened.
  async sync() {
    const row = this.store.wing(DIRECTOR_ID);
    if (!row?.chatIssueId || !this.agentId) return;
    for (const c of await this.pc.comments(row.chatIssueId)) {
      if (c.authorAgentId !== this.agentId || this.store.hasChatComment(c.id)) continue;
      const { actions, error } = parseRoute(c.body);
      const results = error ? [`✖ ${error}`] : [];
      for (const a of actions) results.push(await this.carryOut(a));
      const text = [stripRoute(c.body), ...results].filter(Boolean).join("\n");
      if (this.store.addChat(DIRECTOR_ID, "lead", text, c.id)) {
        this.logger.info(DIRECTOR_ID, `replied${actions.length ? ` and routed ${actions.length} action(s)` : ""}`);
        this.store.record({ wingId: DIRECTOR_ID, kind: "chat.message", actor: this.agentId, taskId: null, payload: { who: "lead", text: text.slice(0, 300) } });
      }
    }
  }

  private async carryOut(a: RouteAction): Promise<string> {
    try {
      switch (a.do) {
        case "add_goal":
          await this.offices.addGoal(a.office, a.text, a.done_when ?? null, "director");
          return `✔ Gave ${a.office} the goal "${a.text}"`;
        case "drop_in":
          await this.offices.dropIn(a.office, a.title, a.detail ?? "");
          return `✔ Dropped "${a.title}" into ${a.office}`;
        case "new_office":
          await this.offices.createWing({ id: a.id, name: a.name, repoPath: a.repo, baseBranch: a.base_branch, charter: a.charter, newRepo: a.new_repo === true });
          return `✔ Opened the ${a.name} office`;
        case "hire":
          await this.offices.hireFromOffice(a.office, a.count ?? 1);
          return `✔ Hired for ${a.office}`;
        case "pause":
          this.offices.pause(a.office);
          return `✔ Paused ${a.office}`;
        case "resume":
          this.offices.resume(a.office);
          return `✔ Resumed ${a.office}`;
        case "come_back":
          await this.offices.comeBack(a.office);
          return `✔ Brought ${a.office} back to you`;
        default:
          return `✖ Annex does not know how to "${(a as { do: string }).do}"`;
      }
    } catch (err) {
      this.logger.warn(DIRECTOR_ID, `could not ${a.do}: ${(err as Error).message}`);
      return `✖ Could not ${a.do.replace("_", " ")}: ${(err as Error).message}`;
    }
  }

  private async onFrame(f: Frame) {
    const p = f.payload;
    if (f.type === "agent.status" && p.agentId === this.agentId) this.status = String(p.status ?? "idle");
    if (f.type === "activity.logged" && p.action === "issue.comment_added" && p.entityId === this.store.wing(DIRECTOR_ID)?.chatIssueId) await this.sync();
  }
}
