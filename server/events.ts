// The office only moves when one of these happens. Paperclip's own events are mapped
// onto this vocabulary before they are stored, so the browser never needs to know Paperclip.

export const EVENT_KINDS = [
  "lead.woke",
  "lead.idle",
  "task.created",
  "task.started",
  "task.in_review",
  "agent.tool",
  "agent.said",
  "check.started",
  "check.passed",
  "check.failed",
  "review.accepted",
  "review.rejected",
  "task.done",
  "task.stopped",
  "approval.requested",
  "approval.decided",
  "wing.mode_changed",
  "wing.held",
  "wing.resumed",
  "chat.message",
  "agent.hired",
  "goal.added",
  "goal.done",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface AnnexEvent {
  id: number;
  wingId: string;
  at: string;
  kind: EventKind;
  // Paperclip agent id, "you" for the person, or "annex" for Annex's own actions.
  actor: string;
  // Paperclip issue id when the event is about a task.
  taskId: string | null;
  payload: Record<string, unknown>;
}

export type NewEvent = Omit<AnnexEvent, "id" | "at"> & { at?: string };

export function isEventKind(k: string): k is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(k);
}
