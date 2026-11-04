// The lead proposes; this decides. Every rule in design D5 that can be checked in code is checked
// here, so a lead that ignores its instructions produces rejected proposals, not busywork.

import { PROPOSAL_FENCE, BRIEF_FENCE } from "./prompts.ts";

export interface ProposedTask {
  title: string;
  charterLine: string;
  evidence: string;
  doneCheck: string;
  size: "S" | "M" | "L";
  details: string;
  // the lead wants the person's yes before this starts (ask_before, or the brief's call-backs)
  askFirst: boolean;
  askReason: string;
  // which of the repo's house rules apply and how this task keeps them
  houseRules: string;
  // the title of the person's drop-in this task comes from, when it does
  fromDropIn: string;
  // the goal this task advances, when it does
  goal: number | null;
}

// The lead's update to a goal's plan, sent with each proposal.
export interface GoalUpdate {
  id: number;
  plan: string;
  done: boolean;
  note: string;
}

// A goal the lead and the person agreed in chat.
export interface NewGoal {
  text: string;
  doneWhen: string | null;
}

export interface Proposal {
  note: string;
  tasks: ProposedTask[];
  hire: { count: number; reason: string } | null;
  goals: GoalUpdate[];
  newGoals: NewGoal[];
}

export interface Verdict {
  task: ProposedTask;
  ok: boolean;
  reason: string | null;
}

export const MAX_TASKS_PER_WAKE = 3;

export function findFence(body: string, tag: string): string | null {
  const re = new RegExp("```" + tag + "\\s*\\n([\\s\\S]*?)```", "m");
  const m = re.exec(body);
  return m ? m[1]!.trim() : null;
}

// JSON as a model writes it: a multi-line plan often arrives with real line breaks inside a
// string, which strict JSON refuses. Those are escaped before a second try; anything else that is
// broken still fails.
export function parseLenient(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (first) {
    let out = "";
    let inString = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]!;
      if (inString && c === "\\") {
        out += c + (raw[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === '"') inString = !inString;
      if (inString && c === "\n") out += "\\n";
      else if (inString && c === "\r") out += "\\r";
      else if (inString && c === "\t") out += "\\t";
      else out += c;
    }
    try {
      return JSON.parse(out);
    } catch {
      throw first;
    }
  }
}

export function parseProposal(body: string): Proposal | { error: string } {
  const raw = findFence(body, PROPOSAL_FENCE);
  if (raw === null) return { error: `no \`${PROPOSAL_FENCE}\` block in the lead's comment` };
  let data: unknown;
  try {
    data = parseLenient(raw);
  } catch (err) {
    return { error: `the \`${PROPOSAL_FENCE}\` block is not valid JSON: ${(err as Error).message}` };
  }
  if (typeof data !== "object" || data === null || !Array.isArray((data as { tasks?: unknown }).tasks)) {
    return { error: "the proposal has no `tasks` list" };
  }
  const d = data as { note?: unknown; tasks: unknown[] };
  const tasks = d.tasks.map((t): ProposedTask => {
    const o = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
    const size = s("size").toUpperCase();
    return {
      title: s("title"),
      charterLine: s("charter_line"),
      evidence: s("evidence"),
      doneCheck: s("done_check"),
      size: size === "S" || size === "M" || size === "L" ? size : "M",
      details: s("details"),
      askFirst: o.ask_first === true,
      askReason: s("ask_reason"),
      houseRules: s("house_rules"),
      fromDropIn: s("from_drop_in"),
      goal: Number.isInteger(o.goal) ? (o.goal as number) : /^\d+$/.test(s("goal")) ? Number(s("goal")) : null,
    };
  });
  const list = (k: string) => (Array.isArray((data as Record<string, unknown>)[k]) ? ((data as Record<string, unknown>)[k] as unknown[]) : []);
  const obj = (v: unknown) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const goals = list("goals")
    .map(obj)
    .filter((g) => Number.isInteger(Number(g.id)))
    .map((g): GoalUpdate => ({ id: Number(g.id), plan: str(g.plan), done: g.done === true, note: str(g.note) }));
  const newGoals = list("new_goals")
    .map(obj)
    .filter((g) => str(g.text))
    .map((g): NewGoal => ({ text: str(g.text), doneWhen: str(g.done_when) || null }));
  const h = (typeof (d as { hire?: unknown }).hire === "object" && (d as { hire?: unknown }).hire) || null;
  const hire = h ? { count: Math.max(0, Math.floor(Number((h as { count?: unknown }).count) || 0)), reason: String((h as { reason?: unknown }).reason ?? "") } : null;
  return { note: typeof d.note === "string" ? d.note.trim() : "", tasks, hire: hire && hire.count > 0 ? hire : null, goals, newGoals };
}

export function parseBrief(body: string): string | null {
  const raw = findFence(body, BRIEF_FENCE);
  if (!raw) return null;
  const required = ["## Goal", "## Decided", "## Off limits", "## Call me back when"];
  return required.every((h) => raw.includes(h)) ? raw : null;
}

export interface Context {
  // the charter and the approved brief, the text a charter line must come from
  charter: string;
  signals: { name: string; output: string }[];
  // titles of open tasks and of tasks closed in the last 7 days
  existingTitles: string[];
  // the repo's CLAUDE.md / AGENTS.md; when present every task must quote a rule it touches
  houseRules?: string | null;
  // reads a file in the repo, so evidence can quote the code as well as the signals
  readRepoFile?: (path: string) => string | null;
  // what the person dropped in for this wake; a task that names one needs no other evidence
  dropIns?: string[];
  // set when the person agreed the work in chat: no signal evidence or charter line needed
  agreedWithPerson?: boolean;
  // ids of the office's active goals; a task that names one needs no charter line or evidence
  goals?: number[];
  maxTasks?: number;
}

export function judge(tasks: ProposedTask[], ctx: Context): Verdict[] {
  const accepted: string[] = [];
  return tasks.map((task, i) => {
    const reason = rejectReason(task, ctx, [...ctx.existingTitles, ...accepted], i);
    if (!reason) accepted.push(task.title);
    return { task, ok: reason === null, reason };
  });
}

function rejectReason(t: ProposedTask, ctx: Context, taken: string[], index: number): string | null {
  const max = ctx.maxTasks ?? MAX_TASKS_PER_WAKE;
  if (index >= max) return `over the limit of ${max} tasks per wake`;
  if (!t.title) return "no title";
  if (!t.doneCheck) return "no done check";
  if (t.doneCheck.includes("\n")) return "the done check must be one command line";
  const danger = dangerous(t.doneCheck);
  if (danger) return `the done check ${danger}`;
  if (ctx.houseRules) {
    if (t.houseRules.length < 12) return "it does not say which of the repo's house rules (CLAUDE.md) apply and how it keeps them";
    if (!quotes(t.houseRules, [ctx.houseRules])) return "its house_rules does not quote any line of the repo's CLAUDE.md";
  }
  // Work the person asked for, in chat or as a drop-in, is its own justification.
  const dropIn = t.fromDropIn ? ctx.dropIns?.find((d) => similar(d, t.fromDropIn) || norm(d) === norm(t.fromDropIn)) : undefined;
  if (t.fromDropIn && !dropIn) return `"${t.fromDropIn}" is not something the person dropped in`;
  if (dropIn || ctx.agreedWithPerson) return null;
  // A step of a goal the person set is justified by the goal; it must still be new work.
  if (t.goal !== null) {
    if (!ctx.goals?.includes(t.goal)) return `goal ${t.goal} is not one of this office's active goals`;
    const dup = taken.find((x) => similar(x, t.title));
    return dup ? `duplicates "${dup}"` : null;
  }
  if (!t.charterLine) return "no charter line";
  if (!lineInText(t.charterLine, ctx.charter)) return `"${t.charterLine}" is not a line of the charter or brief`;
  if (!t.evidence) return "no evidence";
  if (!evidenceInSignals(t.evidence, ctx.signals) && !evidenceInRepo(t.evidence, ctx.readRepoFile)) {
    return "the evidence quotes neither signal output nor a file in the repo (path:line: text)";
  }
  const dup = taken.find((x) => similar(x, t.title));
  if (dup) return `duplicates "${dup}"`;
  return null;
}

// "src/x.ts:12: the line" or "README.md: the line": the quoted text must be in that file.
export function evidenceInRepo(evidence: string, read?: (path: string) => string | null): boolean {
  if (!read) return false;
  const m = /^\s*`?([\w./@-]+\.[\w]+)`?(?::\d+)?\s*[:-]\s*([\s\S]+)$/.exec(evidence);
  if (!m || m[1]!.includes("..")) return false;
  const text = read(m[1]!);
  return text !== null && quotes(m[2]!, [text]);
}

function quotes(text: string, sources: string[]): boolean {
  return evidenceInSignals(text, sources.map((output) => ({ name: "", output })));
}

// Commands a done check has no business running: it only ever checks.
function dangerous(cmd: string): string | null {
  if (/\bgit\s+(push|reset|checkout|switch|rebase|merge|commit|clean)\b/.test(cmd)) return "changes git state";
  if (/\brm\s+-[a-z]*r/.test(cmd)) return "deletes files recursively";
  if (/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/.test(cmd)) return "pipes a download into a shell";
  if (/\bnpm\s+(publish|install|i|uninstall|update)\b/.test(cmd)) return "changes dependencies";
  return null;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_"'“”‘’]/g, "")
    .replace(/^\s*(\d+[.)]|[-*])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A charter line matches when, ignoring list markers, quotes and spacing, it is contained in one
// line of the charter, or one charter line is contained in it.
export function lineInText(line: string, text: string): boolean {
  const l = norm(line);
  if (l.length < 6) return false;
  return text.split("\n").map(norm).filter((x) => x.length >= 6).some((x) => x.includes(l) || l.includes(x));
}

// Evidence must share a run of at least 12 characters with some signal's output. Quoting one line
// of `npm outdated` passes; describing the problem in your own words does not.
export function evidenceInSignals(evidence: string, signals: { name: string; output: string }[]): boolean {
  const ev = evidence.replace(/[`"“”]/g, "").replace(/\s+/g, " ");
  const outputs = signals.map((s) => s.output.replace(/\s+/g, " "));
  const RUN = 12;
  if (ev.length < RUN) return false;
  for (let i = 0; i + RUN <= ev.length; i++) {
    const piece = ev.slice(i, i + RUN);
    if (!/[a-z0-9]/i.test(piece)) continue;
    if (outputs.some((o) => o.includes(piece))) return true;
  }
  return false;
}

// Titles are duplicates when most of their meaningful words are shared, and they do not name
// different versions ("Bump x to 22.20.5" and "Bump x to 26.6.4" are different work).
export function similar(a: string, b: string): boolean {
  // the version a task moves to decides: "to 26.6.4" and "from 22.20.5 to 26.6.4" are one task,
  // "to 22.20.5" is another
  const target = (s: string) => /\bto\s+v?(\d+\.\d+(?:\.\d+)?)/i.exec(s)?.[1] ?? [...s.matchAll(/\d+\.\d+(?:\.\d+)?/g)].pop()?.[0] ?? "";
  const va = target(a);
  const vb = target(b);
  if (va && vb && va !== vb) return false;
  const words = (s: string) => new Set(norm(s).split(/[^a-z0-9.@/-]+/).filter((w) => w.length > 2 && !STOP.has(w)));
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size) >= 0.75;
}

const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "update", "fix", "make", "bump", "upgrade", "raise", "move"]);
