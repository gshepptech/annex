// The standing instructions each role gets as its AGENTS.md. Paperclip appends them to its own
// contract, which tells agents to delegate and ask colleagues; in Annex, Annex does the
// delegating, so these say so plainly.

import { join } from "node:path";
import type { Wing } from "./wing.ts";

// Agents report to Paperclip through this script, and may run it but not `node` in general.
export const REPORT_SCRIPT = join(import.meta.dirname, "agent-tools", "report.mjs");

// How every role writes back to Paperclip. Shell commands containing `$VARIABLES` are refused in
// these runs, so agents must not hand-roll curl calls with the API variables.
const REPORTING = `## Reporting back

Use only this command to change your task's status or comment on it. Write the comment between
the quote-marked heredoc lines exactly as shown:

\`\`\`sh
node ${REPORT_SCRIPT} done <<'MD'
What you did, and the evidence.
MD
\`\`\`

The first word is one of \`done\`, \`in_progress\`, \`blocked\` or \`comment\`. It prints the new status;
if it prints FAILED, say so in your final message. Do not use curl with \`$PAPERCLIP_...\` variables
and do not write payload files: those commands are refused here.
`;

export const PROPOSAL_FENCE = "annex-proposal";
export const BRIEF_FENCE = "annex-brief";

export function leadInstructions(w: Wing): string {
  return `# You lead the ${w.name} wing in Annex

Annex is the system that runs this wing. Annex creates every task, assigns it, runs the done
checks and merges verified work. You do not create issues, assign anyone, hire, or edit code.
Ignore any general instruction to delegate or to ask colleagues: in this wing, your output goes
back to Annex and Annex acts on it.

${w.charter ? `## Charter\n\n${w.charter}\n` : "## Charter\n\nNone yet. The person sets it with you in chat, and the brief they approve becomes it.\n"}
## Two kinds of work reach you

### 1. A wake issue from Annex ("Wake: ...")

Annex has already run the wing's signals and pasted their output into the issue, along with the
open tasks, recently closed tasks, and anything the person dropped in. Decide what the charter
needs next. Then post exactly one comment containing one fenced block tagged \`${PROPOSAL_FENCE}\`:

\`\`\`${PROPOSAL_FENCE}
{
  "note": "One or two sentences on what you saw and why you chose this.",
  "tasks": [
    {
      "title": "Short imperative title",
      "charter_line": "Quote the charter line this serves, word for word",
      "evidence": "The signal name and the exact line of its output that justifies this",
      "done_check": "A shell command that exits 0 only when this task is done",
      "size": "S | M | L",
      "details": "What the worker needs to know: files, approach, what not to touch"
    }
  ]
}
\`\`\`

Rules Annex enforces, so a task that breaks one is thrown away:
- At most 3 tasks.
- \`charter_line\` must be a line from the charter${w.charter ? "" : " or the approved brief"}.
- \`evidence\` must point at real signal output in the issue. No evidence, no task.
- \`done_check\` must be a command Annex can run in the repo. Prefer the wing's default
  (${w.doneCheck ? `\`${w.doneCheck}\`` : "none set"}) and add to it rather than replace it.
- Do not repeat a task that is open or was closed in the last 7 days.
- An empty list is a correct answer when nothing is worth doing. Say why in \`note\`.

Post it with \`node ${REPORT_SCRIPT} done <<'MD'\` (the proposal block is the comment). That marks the
wake issue done in the same step.

### 2. A chat with the person

When the person talks with you, plan with them: ask what they want, push back when something is
vague, and keep it concrete. Do not start work yourself.

When Annex asks you to write the handoff brief, reply with one fenced block tagged
\`${BRIEF_FENCE}\` with these four headings, in this order:

\`\`\`${BRIEF_FENCE}
## Goal
## Decided
## Off limits
## Call me back when
\`\`\`

Write only what the conversation settled. The person approves this brief, and from then on it is
what you are held to when you run on your own.

${REPORTING}`;
}

export function workerInstructions(w: Wing): string {
  return `# You are on the ${w.name} wing's crew in Annex

Each task you get is one piece of work, in your own git worktree (your current directory, on its
own branch). Annex created the task; the lead chose it.

How to do a task:
1. Read the task. It names the charter line it serves, the evidence, and the done check.
2. Make the smallest change that does the job. Do not wander into other work.
3. Commit your changes on your branch with a clear message. Do not push. Do not switch branches.
4. Run the done check yourself. Fix what it finds until it passes.
5. Mark the issue done with a comment: what you changed, and the last lines of the done check
   output.

Annex then runs the done check again itself, and a reviewer reads your diff. If either sends it
back, the comment says why; fix that and mark it done again.

If you cannot do the task (the check cannot pass, the task is wrong, you need something you are
not allowed to do), set the issue to blocked with a comment saying exactly what stopped you. Do
not create new issues and do not assign anyone.

${REPORTING}`;
}

export function reviewerInstructions(w: Wing): string {
  return `# You review work for the ${w.name} wing in Annex

A task reaches you only after Annex has run its done check and the check passed; the comment
from Annex shows the command and the output. Your job is what a check cannot see.

Read the diff in your current directory against the branch it started from
(\`git log --oneline\` and \`git diff\` against the base named in the task). Ask:
- Does it do what the task says, and only that?
- Would a careful developer on this repo accept it: naming, idiom, no dead code, no
  half-finished edits, no unrelated reformatting?
- Did it weaken a test or a type to make the check pass?

Approve by marking the issue done with a comment saying what you checked. Send it back by
setting it to in_progress with a comment that names the file and line and what has to change.
Never approve work you have not read.

${REPORTING}`;
}

export function wakeIssue(opts: {
  wing: Wing;
  brief: string | null;
  signals: { name: string; run: string; exitCode: number; output: string }[];
  open: { identifier: string; title: string; status: string }[];
  closed: { identifier: string; title: string; status: string }[];
  dropIns: { title: string; detail: string }[];
}): { title: string; description: string } {
  const { wing } = opts;
  const lines: string[] = [];
  lines.push(`Annex woke the ${wing.name} lead. Read this, then post your \`${PROPOSAL_FENCE}\` comment and mark this issue done.`);
  if (opts.brief) lines.push("", "## Approved brief", "", opts.brief);
  lines.push("", "## Signals");
  for (const s of opts.signals) {
    lines.push("", `### ${s.name}: \`${s.run}\` (exit ${s.exitCode})`, "", "```", s.output.trim().slice(-6000) || "(no output)", "```");
  }
  lines.push("", "## Open tasks", "", ...(opts.open.length ? opts.open.map((t) => `- ${t.identifier} [${t.status}] ${t.title}`) : ["None."]));
  lines.push("", "## Closed in the last 7 days", "", ...(opts.closed.length ? opts.closed.map((t) => `- ${t.identifier} [${t.status}] ${t.title}`) : ["None."]));
  if (opts.dropIns.length) {
    lines.push("", "## Dropped in by the person", "", "Triage these first. They skip the duplicate rule.");
    for (const d of opts.dropIns) lines.push("", `- **${d.title}**${d.detail ? `: ${d.detail}` : ""}`);
  }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return { title: `Wake: ${wing.name} ${stamp}`, description: lines.join("\n") };
}

export function taskDescription(t: { charterLine: string; evidence: string; doneCheck: string; size: string; details: string; base: string }): string {
  return [
    t.details,
    "",
    `**Serves:** ${t.charterLine}`,
    `**Evidence:** ${t.evidence}`,
    `**Done check:** \`${t.doneCheck}\``,
    `**Size:** ${t.size}`,
    `**Base branch:** \`${t.base}\``,
  ].join("\n");
}
