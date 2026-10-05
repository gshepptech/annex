// Your plan's usage, as Claude Code reports it: every session emits a rate_limit_event with how
// much of the five-hour and seven-day windows is used and when each resets. Annex keeps the
// latest one it has seen, from a live session or an agent run.

export interface UsageView {
  fiveHour: { used: number; resetsAt: string } | null;
  sevenDay: { used: number; resetsAt: string } | null;
  status: string | null;
  seenAt: string;
}

let latest: UsageView | null = null;

type Window = { utilization?: unknown; resetsAt?: unknown };

function windowOf(w: Window | undefined): { used: number; resetsAt: string } | null {
  if (!w || typeof w.utilization !== "number" || typeof w.resetsAt !== "number") return null;
  return { used: w.utilization, resetsAt: new Date(w.resetsAt * 1000).toISOString() };
}

export function recordUsage(info: unknown, now = new Date()) {
  if (!info || typeof info !== "object") return;
  const i = info as { status?: unknown; unifiedWindows?: { five_hour?: Window; seven_day?: Window } };
  const fiveHour = windowOf(i.unifiedWindows?.five_hour);
  const sevenDay = windowOf(i.unifiedWindows?.seven_day);
  if (!fiveHour && !sevenDay) return;
  latest = { fiveHour, sevenDay, status: typeof i.status === "string" ? i.status : null, seenAt: now.toISOString() };
}

export function usage(): UsageView | null {
  return latest;
}

// Agent runs log Claude's stream-json; their rate_limit_events count too.
export function usageFromLog(text: string) {
  for (const line of text.split("\n")) {
    if (!line.includes('"rate_limit_event"')) continue;
    try {
      const m = JSON.parse(line) as { type?: string; rate_limit_info?: unknown };
      if (m.type === "rate_limit_event") recordUsage(m.rate_limit_info);
    } catch {
      // a partial line
    }
  }
}
