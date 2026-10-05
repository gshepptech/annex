// The shapes the browser reads. Shared by the server and web/ so the two cannot drift.

import type { BourneEvent } from "./events.ts";

export type Mode = "with_you" | "autonomous";

export type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";

export interface AgentView {
  id: string;
  role: "lead" | "worker" | "reviewer";
  name: string;
  desk: number;
  // Paperclip's view: "running" while a run is in progress
  status: string;
  model: string;
  // tasks this agent did that were verified and merged
  filed: number;
}

export interface ChangesView {
  // what is compared: the branch work started from, and the branch with the work
  from: string;
  to: string;
  // the commit `to` points at now; a merge confirms this exact commit
  head: string;
  files: { path: string; status: string; added: number; removed: number }[];
}

export interface GoalView {
  id: number;
  text: string;
  doneWhen: string | null;
  ongoing: boolean;
  plan: string;
  status: "active" | "done" | "dropped";
  note: string | null;
  open: number;
  finished: number;
}

export interface AskView {
  id: number;
  title: string;
  reason: string;
  details: string;
  createdAt: string;
}

export interface SettingsView {
  wakeEvery: string;
  maxRunsPerHour: number | null;
  quietHours: string | null;
  backOffWhenIdle: boolean;
  askBefore: string[];
  maxWorkers: number;
  maxTasksPerWake: number;
  checkAttempts: number;
  checkTimeout: string;
  wakeTimeout: string;
  maxBackoff: string;
}

// What the settings form edits. Every field is optional; what is left out keeps its value.
export interface WingEdit {
  name?: string;
  charter?: string;
  doneCheck?: string | null;
  setup?: string | null;
  repoPath?: string | null;
  baseBranch?: string;
  workers?: number;
  leadModel?: string;
  workerModel?: string;
  reviewerModel?: string;
  wakeEvery?: string;
  maxRunsPerHour?: number | null;
  quietHours?: string | null;
  backOffWhenIdle?: boolean;
  askBefore?: string[];
  maxWorkers?: number;
  maxTasksPerWake?: number;
  checkAttempts?: number;
  checkTimeout?: string;
  wakeTimeout?: string;
  maxBackoff?: string;
  allow?: string[];
  plugins?: string[];
}

export interface NewWing {
  id: string;
  name: string;
  charter?: string;
  repoPath?: string;
  baseBranch?: string;
  // make repoPath a new, empty git repo first (for a project that does not exist yet)
  newRepo?: boolean;
}

export type Entry =
  | { kind: "start"; at: string; model: string; cwd: string }
  | { kind: "text"; at: string; text: string }
  // what you typed, in your own sessions
  | { kind: "prompt"; at: string; text: string }
  | { kind: "tool"; at: string; id: string; name: string; summary: string; detail: string }
  | { kind: "result"; at: string; toolId: string; text: string; isError: boolean; lines: number }
  | { kind: "done"; at: string; text: string; isError: boolean; durationMs: number | null; turns: number | null }
  | { kind: "error"; at: string; text: string };

// One of your own Claude Code sessions (Your desk).
export interface SessionView {
  id: string;
  title: string;
  cwd: string;
  branch: string | null;
  model: string | null;
  // working: the log changed in the last moments; idle: it is waiting for you or finished
  status: "working" | "idle";
  updatedAt: string;
  lastPrompt: string | null;
  // the permission mode the session last ran in; a reply from Annex runs in the same one
  permissionMode: string | null;
  // a reply from Annex is running in it now
  replying: boolean;
}

export interface SessionTranscript {
  session: SessionView;
  entries: Entry[];
}

export interface RunView {
  id: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  task: { identifier: string; title: string } | null;
  reason: string;
  // exactly what Paperclip sent Claude for this run
  prompt: string | null;
  entries: Entry[];
}

export interface TranscriptView {
  agent: AgentView & { wingId: string };
  // Annex's standing instructions for this agent (its AGENTS.md)
  instructions: string;
  // the full system prompt Paperclip appended on the latest run: its own contract, then ours
  systemPrompt: string | null;
  runs: RunView[];
}

export interface TaskView {
  id: string;
  key: string;
  title: string;
  status: TaskStatus;
  assigneeId: string | null;
}

export interface BriefView {
  id: number;
  version: number;
  text: string;
  status: "draft" | "approved" | "superseded";
}

export interface ChatView {
  id: number;
  at: string;
  who: "you" | "lead";
  text: string;
}

export interface WingView {
  id: string;
  name: string;
  mode: Mode;
  charter: string;
  repo: string | null;
  integrationBranch: string | null;
  held: { until: string | null; reason: string } | null;
  // Set when the wing is not connected to the engine yet, with the reason.
  offline: string | null;
  agents: AgentView[];
  tasks: TaskView[];
  filedCount: number;
  brief: BriefView | null;
  draft: BriefView | null;
  chat: ChatView[];
  settings: SettingsView;
  asks: AskView[];
  goals: GoalView[];
  // what this office spent of your plan lately: agent runs and their minutes in the last 5 hours
  spend: { runs: number; minutes: number };
  paused: boolean;
  edit: Required<Omit<WingEdit, "wakeEvery" | "maxRunsPerHour" | "quietHours" | "backOffWhenIdle" | "askBefore" | "maxWorkers" | "maxTasksPerWake" | "checkAttempts" | "checkTimeout" | "wakeTimeout" | "maxBackoff">>;
  // when an autonomous lead next wakes, or why it will not
  nextWake: { at: string | null; blockedBy: string | null };
  houseRules: string[];
  // verified work on the integration branch that is not on the person's base branch yet
  loot: { commits: { sha: string; date: string; subject: string }[]; command: string | null };
}

export interface DirectorView {
  offline: string | null;
  status: string;
  agentId: string | null;
  chat: ChatView[];
}

export interface StateView {
  wings: WingView[];
  director: DirectorView | null;
  lastEventId: number;
  recent: BourneEvent[];
  // your plan's usage as Claude Code last reported it, and when
  usage: { fiveHour: { used: number; resetsAt: string } | null; sevenDay: { used: number; resetsAt: string } | null; status: string | null; seenAt: string } | null;
}

// Live sessions (server/live.ts): your own Claude Code sessions driven from the browser.
export const LIVE_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
export type LiveMode = (typeof LIVE_MODES)[number];

export interface LivePrompt {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  at: string;
}

export interface LiveView {
  id: string;
  sessionId: string | null;
  cwd: string;
  mode: LiveMode;
  model: string | null;
  // starting: the process is coming up; working: a turn is running; waiting: your move; closed
  status: "starting" | "working" | "waiting" | "closed";
  entries: Entry[];
  // the answer being written right now, before its message is complete
  partial: string;
  prompts: LivePrompt[];
  slashCommands: string[];
  error: string | null;
}

export interface LiveUpdate {
  // entries from this index on replace what the client has
  from: number;
  entries: Entry[];
  partial: string;
  status: LiveView["status"];
  mode: LiveMode;
  prompts: LivePrompt[];
  sessionId: string | null;
  model: string | null;
  slashCommands?: string[];
  error: string | null;
}

// One command running for the app you are building (server/runner.ts).
export interface AppRun {
  id: string;
  folder: string;
  command: string;
  label: string;
  status: "running" | "exited" | "stopped";
  // null while it runs, and for a run stopped by a signal
  exitCode: number | null;
  url: string | null;
  startedAt: string;
  endedAt: string | null;
  lines: number;
}

