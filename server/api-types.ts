// The shapes the browser reads. Shared by the server and web/ so the two cannot drift.

import type { BourneEvent } from "./events.ts";

export type Mode = "with_you" | "autonomous";

export type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";

export interface AgentView {
  id: string;
  role: "lead" | "worker" | "reviewer";
  name: string;
  desk: number;
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
  settings: {
    wakeEvery: string;
    maxRunsPerHour: number | null;
    quietHours: string | null;
    backOffWhenIdle: boolean;
    askBefore: string[];
  };
}

export interface StateView {
  wings: WingView[];
  lastEventId: number;
  recent: BourneEvent[];
}
