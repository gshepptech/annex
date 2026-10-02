// Reads Paperclip's raw frames for the two things Annex needs from them directly: which tools an
// agent is using, and whether a failed run hit the plan's usage limit. Issue state changes are
// read from the issue itself, not from frames (see bureau.ts).

export interface ToolUse {
  tool: string;
  detail: string;
}

// A heartbeat.run.log chunk holds one or more Claude stream-json lines.
export function toolUses(chunk: string): ToolUse[] {
  const out: ToolUse[] = [];
  for (const line of chunk.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let msg: { type?: string; message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] } };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type !== "assistant") continue;
    for (const c of msg.message?.content ?? []) {
      if (c.type !== "tool_use" || !c.name) continue;
      out.push({ tool: c.name, detail: describeInput(c.name, c.input ?? {}) });
    }
  }
  return out;
}

function describeInput(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const base = (p: string) => p.split("/").pop() ?? p;
  switch (tool) {
    case "Bash":
      return s("command").split("\n")[0]!.slice(0, 70);
    case "Read":
    case "Write":
    case "Edit":
      return base(s("file_path"));
    case "Glob":
    case "Grep":
      return s("pattern").slice(0, 50);
    case "Skill":
      return s("skill") || s("name");
    default:
      return "";
  }
}

const LIMIT = /usage limit|hit your limit|rate[ -]?limit|limit reached|out of (extra )?usage|5-hour limit|weekly limit/i;

export function isUsageLimit(text: string | null | undefined): boolean {
  return !!text && LIMIT.test(text);
}

// "resets 5pm", "resets at 17:30", "resets 3:45am (Europe/London)", or an ISO time. Falls back to
// an hour from now, so a wing is never held forever on a message Annex could not read.
export function resetTime(text: string, now: Date): Date {
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?/.exec(text);
  if (iso) {
    const d = new Date(iso[0]);
    if (d > now) return d;
  }
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    const ampm = m[3]?.toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  return new Date(now.getTime() + 60 * 60_000);
}
