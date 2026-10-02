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

export function parseProposal(body: string): { note: string; tasks: ProposedTask[] } | { error: string } {
  const raw = findFence(body, PROPOSAL_FENCE);
  if (raw === null) return { error: `no \`${PROPOSAL_FENCE}\` block in the lead's comment` };
  let data: unknown;
  try {
    data = JSON.parse(raw);
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
    };
  });
  return { note: typeof d.note === "string" ? d.note.trim() : "", tasks };
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
  if (index >= MAX_TASKS_PER_WAKE) return `over the limit of ${MAX_TASKS_PER_WAKE} tasks per wake`;
  if (!t.title) return "no title";
  if (!t.doneCheck) return "no done check";
  if (t.doneCheck.includes("\n")) return "the done check must be one command line";
  const danger = dangerous(t.doneCheck);
  if (danger) return `the done check ${danger}`;
  if (!t.charterLine) return "no charter line";
  if (!lineInText(t.charterLine, ctx.charter)) return `"${t.charterLine}" is not a line of the charter or brief`;
  if (!t.evidence) return "no evidence";
  if (!evidenceInSignals(t.evidence, ctx.signals)) return "the evidence does not quote any signal output";
  const dup = taken.find((x) => similar(x, t.title));
  if (dup) return `duplicates "${dup}"`;
  return null;
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

// Titles are duplicates when most of their meaningful words are shared.
export function similar(a: string, b: string): boolean {
  const words = (s: string) => new Set(norm(s).split(/[^a-z0-9.@/-]+/).filter((w) => w.length > 2 && !STOP.has(w)));
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size) >= 0.75;
}

const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "update", "fix", "make"]);
