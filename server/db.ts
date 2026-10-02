// What Annex owns. Tasks, agents' work, reviews, approvals and budgets stay in Paperclip; Annex
// keeps only the things Paperclip has no idea of: a wing's mode, its handoff briefs, its own done
// check results, and the event log the office is drawn from.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Mode } from "./wing.ts";
import type { BourneEvent, EventKind, NewEvent } from "./events.ts";

const MIGRATIONS: string[] = [
  `
  create table wing (
    id text primary key,
    company_id text,
    mode text not null check (mode in ('with_you', 'autonomous')),
    -- doubles when back_off_when_idle is on and recent work moved no signal; 0 means none
    backoff_level integer not null default 0,
    held_until text,
    held_reason text,
    updated_at text not null
  );

  create table agent (
    id text primary key,
    wing_id text not null references wing(id),
    role text not null check (role in ('lead', 'worker', 'reviewer')),
    name text not null,
    desk integer not null,
    unique (wing_id, desk)
  );

  create table brief (
    id integer primary key,
    wing_id text not null references wing(id),
    version integer not null,
    text text not null,
    status text not null check (status in ('draft', 'approved', 'superseded')),
    approval_id text,
    created_at text not null,
    approved_at text,
    unique (wing_id, version)
  );

  create table check_run (
    id integer primary key,
    wing_id text not null references wing(id),
    task_id text not null,
    attempt integer not null,
    command text not null,
    cwd text not null,
    exit_code integer,
    output_tail text,
    started_at text not null,
    finished_at text
  );

  create table event (
    id integer primary key,
    wing_id text not null,
    at text not null,
    kind text not null,
    actor text not null,
    task_id text,
    payload text not null default '{}'
  );
  create index event_wing on event (wing_id, id);

  create table layout (
    wing_id text primary key,
    json text not null
  );

  create table chat (
    id integer primary key,
    wing_id text not null references wing(id),
    at text not null,
    who text not null check (who in ('you', 'lead')),
    text text not null
  );
  `,
  `
  alter table wing add column project_id text;
  alter table wing add column chat_issue_id text;

  -- tasks Annex created, with what the lead claimed for them, so the done check and the
  -- duplicate rule never depend on reading prose back out of Paperclip
  create table task (
    id text primary key,
    wing_id text not null references wing(id),
    identifier text not null,
    title text not null,
    done_check text not null,
    charter_line text,
    evidence text,
    source text not null check (source in ('lead', 'you')),
    state text not null default 'open' check (state in ('open', 'merged', 'stopped')),
    created_at text not null,
    closed_at text
  );

  create table drop_in (
    id integer primary key,
    wing_id text not null references wing(id),
    title text not null,
    detail text not null default '',
    created_at text not null,
    taken_at text
  );

  create table wake (
    id integer primary key,
    wing_id text not null references wing(id),
    issue_id text,
    started_at text not null,
    finished_at text,
    outcome text
  );
  `,
  `
  -- the Paperclip comment a chat line came from, so a reply is stored once however often it is seen
  alter table chat add column comment_id text;
  create unique index chat_comment on chat (comment_id) where comment_id is not null;
  `,
  `
  -- the signal output the lead was shown, so its proposal is judged against exactly that
  alter table wake add column signals text;
  `,
  `
  -- work the lead wants the person to say yes to first: a raised hand (design D3)
  create table ask (
    id integer primary key,
    wing_id text not null references wing(id),
    task text not null,
    reason text not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
    created_at text not null,
    decided_at text
  );
  `,
];

export interface AskRow {
  id: number;
  wingId: string;
  task: Record<string, unknown>;
  reason: string;
  status: "pending" | "approved" | "declined";
  createdAt: string;
}

export interface TaskRow {
  id: string;
  wingId: string;
  identifier: string;
  title: string;
  doneCheck: string;
  charterLine: string | null;
  evidence: string | null;
  source: "lead" | "you";
  state: "open" | "merged" | "stopped";
  createdAt: string;
  closedAt: string | null;
}

export interface DropInRow {
  id: number;
  wingId: string;
  title: string;
  detail: string;
  createdAt: string;
  takenAt: string | null;
}

export interface WakeRow {
  id: number;
  wingId: string;
  issueId: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
}

export interface WingRow {
  id: string;
  companyId: string | null;
  projectId: string | null;
  chatIssueId: string | null;
  mode: Mode;
  backoffLevel: number;
  heldUntil: string | null;
  heldReason: string | null;
}

export interface AgentRow {
  id: string;
  wingId: string;
  role: "lead" | "worker" | "reviewer";
  name: string;
  desk: number;
}

export interface BriefRow {
  id: number;
  wingId: string;
  version: number;
  text: string;
  status: "draft" | "approved" | "superseded";
  approvalId: string | null;
  createdAt: string;
  approvedAt: string | null;
}

export interface CheckRunRow {
  id: number;
  wingId: string;
  taskId: string;
  attempt: number;
  command: string;
  cwd: string;
  exitCode: number | null;
  outputTail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ChatRow {
  id: number;
  wingId: string;
  at: string;
  who: "you" | "lead";
  text: string;
}

type Listener = (e: BourneEvent) => void;

export class Store {
  readonly db: DatabaseSync;
  private listeners = new Set<Listener>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
    this.migrate();
  }

  private migrate() {
    const { user_version: current } = this.db.prepare("pragma user_version").get() as { user_version: number };
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec("begin");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`pragma user_version = ${v + 1}`);
        this.db.exec("commit");
      } catch (err) {
        this.db.exec("rollback");
        throw err;
      }
    }
  }

  // Wings

  ensureWing(id: string, initialMode: Mode): WingRow {
    this.db
      .prepare("insert into wing (id, mode, updated_at) values (?, ?, ?) on conflict (id) do nothing")
      .run(id, initialMode, now());
    return this.wing(id)!;
  }

  wing(id: string): WingRow | undefined {
    const r = this.db.prepare("select * from wing where id = ?").get(id) as Record<string, unknown> | undefined;
    return r && toWing(r);
  }

  wings(): WingRow[] {
    return (this.db.prepare("select * from wing order by id").all() as Record<string, unknown>[]).map(toWing);
  }

  setCompany(id: string, companyId: string) {
    this.db.prepare("update wing set company_id = ?, updated_at = ? where id = ?").run(companyId, now(), id);
  }

  setProject(id: string, projectId: string) {
    this.db.prepare("update wing set project_id = ?, updated_at = ? where id = ?").run(projectId, now(), id);
  }

  clearProject(id: string) {
    this.db.prepare("update wing set project_id = null, updated_at = ? where id = ?").run(now(), id);
  }

  setChatIssue(id: string, issueId: string) {
    this.db.prepare("update wing set chat_issue_id = ?, updated_at = ? where id = ?").run(issueId, now(), id);
  }

  setMode(id: string, mode: Mode) {
    this.db.prepare("update wing set mode = ?, backoff_level = 0, updated_at = ? where id = ?").run(mode, now(), id);
  }

  setBackoff(id: string, level: number) {
    this.db.prepare("update wing set backoff_level = ?, updated_at = ? where id = ?").run(level, now(), id);
  }

  setHold(id: string, until: string | null, reason: string | null) {
    this.db.prepare("update wing set held_until = ?, held_reason = ?, updated_at = ? where id = ?").run(until, reason, now(), id);
  }

  // Agents

  addAgent(a: Omit<AgentRow, "desk">): AgentRow {
    const taken = new Set(this.agents(a.wingId).map((x) => x.desk));
    // The lead sits at desk 0 and the reviewer at the review desk (-1). Workers take the lowest
    // free desk from 1, so a desk is never handed out while someone is still sitting at it.
    let desk = a.role === "lead" ? 0 : a.role === "reviewer" ? -1 : 1;
    if (a.role === "worker") while (taken.has(desk)) desk++;
    this.db
      .prepare("insert into agent (id, wing_id, role, name, desk) values (?, ?, ?, ?, ?)")
      .run(a.id, a.wingId, a.role, a.name, desk);
    return { ...a, desk };
  }

  allAgents(): AgentRow[] {
    return (this.db.prepare("select * from agent order by wing_id, desk").all() as Record<string, unknown>[]).map(
      (r) => ({ id: r.id as string, wingId: r.wing_id as string, role: r.role as AgentRow["role"], name: r.name as string, desk: r.desk as number }),
    );
  }

  renameAgent(id: string, name: string) {
    this.db.prepare("update agent set name = ? where id = ?").run(name, id);
  }

  removeAgent(id: string) {
    this.db.prepare("delete from agent where id = ?").run(id);
  }

  agents(wingId: string): AgentRow[] {
    return (this.db.prepare("select * from agent where wing_id = ? order by desk").all(wingId) as Record<string, unknown>[]).map(
      (r) => ({ id: r.id as string, wingId: r.wing_id as string, role: r.role as AgentRow["role"], name: r.name as string, desk: r.desk as number }),
    );
  }

  agent(id: string): AgentRow | undefined {
    const r = this.db.prepare("select * from agent where id = ?").get(id) as Record<string, unknown> | undefined;
    return r && { id: r.id as string, wingId: r.wing_id as string, role: r.role as AgentRow["role"], name: r.name as string, desk: r.desk as number };
  }

  // Briefs

  addBrief(wingId: string, text: string): BriefRow {
    const { v } = this.db.prepare("select coalesce(max(version), 0) + 1 as v from brief where wing_id = ?").get(wingId) as { v: number };
    const r = this.db
      .prepare("insert into brief (wing_id, version, text, status, created_at) values (?, ?, ?, 'draft', ?) returning *")
      .get(wingId, v, text, now()) as Record<string, unknown>;
    return toBrief(r);
  }

  setBriefApproval(id: number, approvalId: string) {
    this.db.prepare("update brief set approval_id = ? where id = ?").run(approvalId, id);
  }

  approveBrief(id: number): BriefRow {
    const b = this.brief(id);
    if (!b) throw new Error(`no brief ${id}`);
    this.db.exec("begin");
    try {
      this.db.prepare("update brief set status = 'superseded' where wing_id = ? and status = 'approved'").run(b.wingId);
      this.db.prepare("update brief set status = 'approved', approved_at = ? where id = ?").run(now(), id);
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
    return this.brief(id)!;
  }

  brief(id: number): BriefRow | undefined {
    const r = this.db.prepare("select * from brief where id = ?").get(id) as Record<string, unknown> | undefined;
    return r && toBrief(r);
  }

  currentBrief(wingId: string): BriefRow | undefined {
    const r = this.db.prepare("select * from brief where wing_id = ? and status = 'approved'").get(wingId) as Record<string, unknown> | undefined;
    return r && toBrief(r);
  }

  latestDraft(wingId: string): BriefRow | undefined {
    const r = this.db
      .prepare("select * from brief where wing_id = ? and status = 'draft' order by version desc limit 1")
      .get(wingId) as Record<string, unknown> | undefined;
    return r && toBrief(r);
  }

  // Done checks

  startCheck(c: Pick<CheckRunRow, "wingId" | "taskId" | "command" | "cwd">): CheckRunRow {
    const { n } = this.db.prepare("select count(*) as n from check_run where task_id = ?").get(c.taskId) as { n: number };
    const r = this.db
      .prepare("insert into check_run (wing_id, task_id, attempt, command, cwd, started_at) values (?, ?, ?, ?, ?, ?) returning *")
      .get(c.wingId, c.taskId, n + 1, c.command, c.cwd, now()) as Record<string, unknown>;
    return toCheck(r);
  }

  finishCheck(id: number, exitCode: number, outputTail: string) {
    this.db.prepare("update check_run set exit_code = ?, output_tail = ?, finished_at = ? where id = ?").run(exitCode, outputTail, now(), id);
  }

  checks(taskId: string): CheckRunRow[] {
    return (this.db.prepare("select * from check_run where task_id = ? order by attempt").all(taskId) as Record<string, unknown>[]).map(toCheck);
  }

  // Chat

  // Returns undefined when that Paperclip comment is already stored.
  addChat(wingId: string, who: ChatRow["who"], text: string, commentId: string | null = null): ChatRow | undefined {
    const r = this.db
      .prepare("insert into chat (wing_id, at, who, text, comment_id) values (?, ?, ?, ?, ?) on conflict do nothing returning *")
      .get(wingId, now(), who, text, commentId) as Record<string, unknown> | undefined;
    return r && { id: r.id as number, wingId: r.wing_id as string, at: r.at as string, who: r.who as ChatRow["who"], text: r.text as string };
  }

  hasChatComment(commentId: string): boolean {
    return this.db.prepare("select 1 from chat where comment_id = ?").get(commentId) !== undefined;
  }

  chat(wingId: string, limit = 200): ChatRow[] {
    return (
      this.db.prepare("select * from (select * from chat where wing_id = ? order by id desc limit ?) order by id").all(wingId, limit) as Record<string, unknown>[]
    ).map((r) => ({ id: r.id as number, wingId: r.wing_id as string, at: r.at as string, who: r.who as ChatRow["who"], text: r.text as string }));
  }

  // Tasks Annex created

  addTask(t: Omit<TaskRow, "state" | "createdAt" | "closedAt">): TaskRow {
    this.db
      .prepare("insert into task (id, wing_id, identifier, title, done_check, charter_line, evidence, source, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.id, t.wingId, t.identifier, t.title, t.doneCheck, t.charterLine, t.evidence, t.source, now());
    return this.task(t.id)!;
  }

  task(id: string): TaskRow | undefined {
    const r = this.db.prepare("select * from task where id = ?").get(id) as Record<string, unknown> | undefined;
    return r && toTask(r);
  }

  tasks(wingId: string, opts: { state?: TaskRow["state"]; closedSince?: string } = {}): TaskRow[] {
    let sql = "select * from task where wing_id = ?";
    const args: (string | number)[] = [wingId];
    if (opts.state) {
      sql += " and state = ?";
      args.push(opts.state);
    }
    if (opts.closedSince) {
      sql += " and closed_at >= ?";
      args.push(opts.closedSince);
    }
    return (this.db.prepare(sql + " order by created_at").all(...args) as Record<string, unknown>[]).map(toTask);
  }

  // How many verified, merged tasks each worker did, from who each task was first given to.
  filedBy(wingId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `select json_extract(e.payload, '$.assigneeId') as agent, count(*) as n
         from event e join task t on t.id = e.task_id
         where e.kind = 'task.created' and e.wing_id = ? and t.state = 'merged'
         group by agent`,
      )
      .all(wingId) as { agent: string | null; n: number }[];
    return new Map(rows.filter((r) => r.agent).map((r) => [r.agent!, r.n]));
  }

  closeTask(id: string, state: "merged" | "stopped") {
    this.db.prepare("update task set state = ?, closed_at = ? where id = ?").run(state, now(), id);
  }

  // Drop-ins: work the person handed a wing directly

  addDropIn(wingId: string, title: string, detail: string): DropInRow {
    const r = this.db
      .prepare("insert into drop_in (wing_id, title, detail, created_at) values (?, ?, ?, ?) returning *")
      .get(wingId, title, detail, now()) as Record<string, unknown>;
    return toDropIn(r);
  }

  pendingDropIns(wingId: string): DropInRow[] {
    return (this.db.prepare("select * from drop_in where wing_id = ? and taken_at is null order by id").all(wingId) as Record<string, unknown>[]).map(toDropIn);
  }

  takeDropIns(ids: number[]) {
    const stmt = this.db.prepare("update drop_in set taken_at = ? where id = ?");
    for (const id of ids) stmt.run(now(), id);
  }

  // Wakes

  startWake(wingId: string): WakeRow {
    const r = this.db.prepare("insert into wake (wing_id, started_at) values (?, ?) returning *").get(wingId, now()) as Record<string, unknown>;
    return toWake(r);
  }

  // What the lead was shown on this wake: the signal output and the person's drop-ins.
  setWakeIssue(id: number, issueId: string, signals: { name: string; output: string }[], dropIns: string[] = []) {
    this.db.prepare("update wake set issue_id = ?, signals = ? where id = ?").run(issueId, JSON.stringify({ signals, dropIns }), id);
  }

  private wakeShown(id: number): { signals: { name: string; output: string }[]; dropIns: string[] } | null {
    const r = this.db.prepare("select signals from wake where id = ?").get(id) as { signals: string | null } | undefined;
    if (!r?.signals) return null;
    const v = JSON.parse(r.signals);
    // rows written before drop-ins were kept hold a bare list of signals
    return Array.isArray(v) ? { signals: v, dropIns: [] } : v;
  }

  wakeSignals(id: number): { name: string; output: string }[] | null {
    return this.wakeShown(id)?.signals ?? null;
  }

  wakeDropIns(id: number): string[] {
    return this.wakeShown(id)?.dropIns ?? [];
  }

  finishWake(id: number, outcome: string) {
    this.db.prepare("update wake set finished_at = ?, outcome = ? where id = ?").run(now(), outcome, id);
  }

  openWake(wingId: string): WakeRow | undefined {
    const r = this.db.prepare("select * from wake where wing_id = ? and finished_at is null order by id desc limit 1").get(wingId) as Record<string, unknown> | undefined;
    return r && toWake(r);
  }

  lastWake(wingId: string): WakeRow | undefined {
    const r = this.db.prepare("select * from wake where wing_id = ? order by id desc limit 1").get(wingId) as Record<string, unknown> | undefined;
    return r && toWake(r);
  }

  wakeByIssue(issueId: string): WakeRow | undefined {
    const r = this.db.prepare("select * from wake where issue_id = ?").get(issueId) as Record<string, unknown> | undefined;
    return r && toWake(r);
  }

  // Asks

  addAsk(wingId: string, task: Record<string, unknown>, reason: string): AskRow {
    const r = this.db.prepare("insert into ask (wing_id, task, reason, created_at) values (?, ?, ?, ?) returning *").get(wingId, JSON.stringify(task), reason, now()) as Record<string, unknown>;
    return toAsk(r);
  }

  asks(wingId: string, status: AskRow["status"] = "pending"): AskRow[] {
    return (this.db.prepare("select * from ask where wing_id = ? and status = ? order by id").all(wingId, status) as Record<string, unknown>[]).map(toAsk);
  }

  ask(id: number): AskRow | undefined {
    const r = this.db.prepare("select * from ask where id = ?").get(id) as Record<string, unknown> | undefined;
    return r && toAsk(r);
  }

  decideAsk(id: number, status: "approved" | "declined") {
    this.db.prepare("update ask set status = ?, decided_at = ? where id = ?").run(status, now(), id);
  }

  // Layouts

  setLayout(wingId: string, json: unknown) {
    this.db.prepare("insert into layout (wing_id, json) values (?, ?) on conflict (wing_id) do update set json = excluded.json").run(wingId, JSON.stringify(json));
  }

  layout(wingId: string): unknown | undefined {
    const r = this.db.prepare("select json from layout where wing_id = ?").get(wingId) as { json: string } | undefined;
    return r && JSON.parse(r.json);
  }

  // Events

  record(e: NewEvent): BourneEvent {
    const r = this.db
      .prepare("insert into event (wing_id, at, kind, actor, task_id, payload) values (?, ?, ?, ?, ?, ?) returning *")
      .get(e.wingId, e.at ?? now(), e.kind, e.actor, e.taskId, JSON.stringify(e.payload)) as Record<string, unknown>;
    const saved = toEvent(r);
    for (const l of this.listeners) l(saved);
    return saved;
  }

  eventsSince(afterId: number, wingId?: string, limit = 500): BourneEvent[] {
    const rows = wingId
      ? this.db.prepare("select * from event where id > ? and wing_id = ? order by id limit ?").all(afterId, wingId, limit)
      : this.db.prepare("select * from event where id > ? order by id limit ?").all(afterId, limit);
    return (rows as Record<string, unknown>[]).map(toEvent);
  }

  recentEvents(limit: number): BourneEvent[] {
    return (this.db.prepare("select * from (select * from event order by id desc limit ?) order by id").all(limit) as Record<string, unknown>[]).map(toEvent);
  }

  lastEvents(wingId: string, kinds: EventKind[], limit: number): BourneEvent[] {
    const placeholders = kinds.map(() => "?").join(",");
    return (
      this.db
        .prepare(`select * from event where wing_id = ? and kind in (${placeholders}) order by id desc limit ?`)
        .all(wingId, ...kinds, limit) as Record<string, unknown>[]
    ).map(toEvent);
  }

  onEvent(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

function now() {
  return new Date().toISOString();
}

function toWing(r: Record<string, unknown>): WingRow {
  return {
    id: r.id as string,
    companyId: (r.company_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    chatIssueId: (r.chat_issue_id as string | null) ?? null,
    mode: r.mode as Mode,
    backoffLevel: r.backoff_level as number,
    heldUntil: (r.held_until as string | null) ?? null,
    heldReason: (r.held_reason as string | null) ?? null,
  };
}

function toAsk(r: Record<string, unknown>): AskRow {
  return { id: r.id as number, wingId: r.wing_id as string, task: JSON.parse(r.task as string), reason: r.reason as string, status: r.status as AskRow["status"], createdAt: r.created_at as string };
}

function toTask(r: Record<string, unknown>): TaskRow {
  return {
    id: r.id as string,
    wingId: r.wing_id as string,
    identifier: r.identifier as string,
    title: r.title as string,
    doneCheck: r.done_check as string,
    charterLine: (r.charter_line as string | null) ?? null,
    evidence: (r.evidence as string | null) ?? null,
    source: r.source as TaskRow["source"],
    state: r.state as TaskRow["state"],
    createdAt: r.created_at as string,
    closedAt: (r.closed_at as string | null) ?? null,
  };
}

function toDropIn(r: Record<string, unknown>): DropInRow {
  return {
    id: r.id as number,
    wingId: r.wing_id as string,
    title: r.title as string,
    detail: r.detail as string,
    createdAt: r.created_at as string,
    takenAt: (r.taken_at as string | null) ?? null,
  };
}

function toWake(r: Record<string, unknown>): WakeRow {
  return {
    id: r.id as number,
    wingId: r.wing_id as string,
    issueId: (r.issue_id as string | null) ?? null,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
  };
}

function toBrief(r: Record<string, unknown>): BriefRow {
  return {
    id: r.id as number,
    wingId: r.wing_id as string,
    version: r.version as number,
    text: r.text as string,
    status: r.status as BriefRow["status"],
    approvalId: (r.approval_id as string | null) ?? null,
    createdAt: r.created_at as string,
    approvedAt: (r.approved_at as string | null) ?? null,
  };
}

function toCheck(r: Record<string, unknown>): CheckRunRow {
  return {
    id: r.id as number,
    wingId: r.wing_id as string,
    taskId: r.task_id as string,
    attempt: r.attempt as number,
    command: r.command as string,
    cwd: r.cwd as string,
    exitCode: (r.exit_code as number | null) ?? null,
    outputTail: (r.output_tail as string | null) ?? null,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function toEvent(r: Record<string, unknown>): BourneEvent {
  return {
    id: r.id as number,
    wingId: r.wing_id as string,
    at: r.at as string,
    kind: r.kind as EventKind,
    actor: r.actor as string,
    taskId: (r.task_id as string | null) ?? null,
    payload: JSON.parse(r.payload as string),
  };
}
