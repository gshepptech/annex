// One line per event for the log, in the bureau's voice: who did what to which file.

import type { BourneEvent } from "../../server/events.ts";

export interface LogLine {
  time: string;
  who: string;
  text: string;
  tone: "plain" | "good" | "bad" | "ask";
}

export function describe(e: BourneEvent, nameOf: (agentId: string) => string, titleOf: (taskId: string) => string): LogLine {
  const who = e.actor === "you" ? "You" : e.actor === "annex" ? "Annex" : nameOf(e.actor);
  const p = e.payload;
  const title = e.taskId ? `"${(p.title as string | undefined) ?? titleOf(e.taskId)}"` : "";
  const time = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const line = (text: string, tone: LogLine["tone"] = "plain"): LogLine => ({ time, who, text, tone });

  switch (e.kind) {
    case "lead.woke":
      return line("woke and read the signals");
    case "lead.idle":
      return line(`found nothing worth doing${p.reason ? `: ${p.reason}` : ""}`);
    case "task.created":
      return line(`opened ${title}${p.assigneeId ? ` for ${nameOf(String(p.assigneeId))}` : ""}`);
    case "task.started":
      return line(`started ${title}`);
    case "task.in_review":
      return line(`sent ${title} to review`);
    case "agent.tool":
      return line(`${p.tool ?? "used a tool"}${p.detail ? `: ${p.detail}` : ""}`);
    case "agent.said":
      return line(String(p.text ?? ""));
    case "check.started":
      return line(`ran \`${p.command ?? "the done check"}\` on ${title}`);
    case "check.passed":
      return line(`done check passed on ${title}`, "good");
    case "check.failed":
      return line(`done check failed on ${title} (exit ${p.exitCode ?? "?"})`, "bad");
    case "review.accepted":
      return line(`accepted ${title}`, "good");
    case "review.rejected":
      return line(`returned ${title}${p.reason ? `: ${p.reason}` : ""}`, "bad");
    case "task.done":
      return line(`filed ${title} as verified`, "good");
    case "task.stopped":
      return line(`stopped ${title}${p.reason ? `: ${p.reason}` : ""}`, "bad");
    case "approval.requested":
      return line(`asks: ${p.title ?? "needs your say"}`, "ask");
    case "approval.decided":
      return line(`${p.decision === "approved" ? "approved" : "declined"} ${p.title ?? "the request"}`);
    case "wing.mode_changed":
      return line(p.mode === "autonomous" ? "handed the office off. It runs on its own now." : "came back in. The lead waits for you.");
    case "wing.held":
      return line(`closed the office${p.reason ? `: ${p.reason}` : ""}${p.until ? ` until ${new Date(String(p.until)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`, "ask");
    case "wing.resumed":
      return line("opened the office again");
    case "chat.message":
      return line(String(p.text ?? ""));
    case "agent.hired":
      return line(`hired ${p.name ?? "a worker"}${p.reason ? `: ${p.reason}` : ""}`, "good");
  }
}
