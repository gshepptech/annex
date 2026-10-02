// The standing instructions each role gets as its AGENTS.md. Paperclip appends them to its own
// contract, which tells agents to delegate and ask colleagues; in Annex, Annex does the
// delegating, so these say so plainly.

import { join } from "node:path";
import type { Wing } from "./wing.ts";
import type { PluginInfo } from "./plugins.ts";

// Agents report to Paperclip through this script, and may run it but not `node` in general.
export const REPORT_SCRIPT = join(import.meta.dirname, "agent-tools", "report.mjs");

// How every role writes back to Paperclip. Shell commands containing `$VARIABLES` are refused in
// these runs, so agents must not hand-roll curl calls with the API variables.
const REPORTING = `## Working here

These runs have no one to approve a refused command, so a refused command is a wasted turn.
- Your working directory is already the right place. Never \`cd\`.
- One command per shell call. Do not chain with \`&&\`, \`;\` or pipes into commands you were not
  given; run them one at a time.
- Read files with the Read, Glob and Grep tools rather than \`cat\`, \`find\` or \`grep\` in the shell.

## Reporting back

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

// What an office's plugins add, for the lead (who plans with them) or the crew (who run them).
function pluginSection(plugins: PluginInfo[], role: "lead" | "worker"): string {
  if (!plugins.length) return "";
  const list = plugins.map((p) => `- ${p.id}: ${p.commands.length ? p.commands.map((c) => `\`${c}\``).join(", ") : "no commands"}`).join("\n");
  if (role === "lead") {
    return `## Plugins the crew has

${list}

When a task is best done with one of these, say so in the task's detail and name the command,
for example "run \`${plugins[0]!.commands[0] ?? plugins[0]!.name}\` on this". Only name one when it
fits the task; the done check and the house rules still decide whether the work is done.

`;
  }
  return `## Plugins you may use

${list}

Run a command with the Skill tool when the task names it or it clearly fits. Nobody is there to
answer a plugin's questions: pick the choice that keeps to the task and say which you picked in
your report, or set the issue to blocked if the plugin cannot go on without a person. A plugin
never changes the rules above: same worktree, same branch, no push, the done check still decides.

`;
}

export function leadInstructions(w: Wing, plugins: PluginInfo[] = []): string {
  return `# You lead the ${w.name} wing in Annex

Annex is the system that runs this wing. Annex creates every task, assigns it, runs the done
checks and merges verified work. You do not create issues, assign anyone, hire, or edit code.
Ignore any general instruction to delegate or to ask colleagues: in this wing, your output goes
back to Annex and Annex acts on it.

${w.charter ? `## Charter\n\n${w.charter}\n` : "## Charter\n\nNone yet. The person sets it with you in chat, and the brief they approve becomes it.\n"}
## Two kinds of work reach you

### 1. A wake issue from Annex ("Wake: ...")

Annex has already run the wing's signals and pasted their output into the issue, along with the
open tasks, recently closed tasks, and anything the person dropped in. The repo itself is open to
your Read, Glob and Grep tools at the path given at the end of the issue. Decide what the charter
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
      "details": "What the worker needs to know: files, approach, what not to touch",
      "house_rules": "Quote the CLAUDE.md rules this touches, and say how it keeps each one",
      "from_drop_in": "Only for work the person dropped in: its title",
      "ask_first": false,
      "ask_reason": "Only when ask_first is true: what the person is being asked to approve"
    }
  ],
  "hire": { "count": 0, "reason": "Only when more workers would finish the queued work sooner" }
}
\`\`\`

The repo's house rules come first. The wake issue carries its CLAUDE.md (and AGENTS.md). You are
their enforcer: read them in full on every wake, never propose work that would break one, and
write into each task the rules it touches so the worker and reviewer are held to them too. When a
rule and the charter disagree, the rule wins and you say so in \`note\`.

Rules Annex enforces, so a task that breaks one is thrown away:
- At most 3 tasks.
- \`charter_line\` must be a line from the charter${w.charter ? "" : " or the approved brief"}.
- \`evidence\` must point at real signal output in the issue. No evidence, no task.
- \`done_check\` must be a command Annex can run in the repo. Prefer the wing's default
  (${w.doneCheck ? `\`${w.doneCheck}\`` : "none set"}) and add to it rather than replace it.
- The done check must be able to pass once the task is done. Picture the signal output after
  the change before you write it. For example, \`npm outdated\` keeps listing a package whose
  Latest is a newer major than Wanted, so "grep finds nothing" can never pass for a within-range
  bump. A task whose check cannot pass is stopped after three tries and wastes the crew's work.
- Do not repeat a task that is open or was closed in the last 7 days.
- When the repo has house rules, \`house_rules\` must quote the rules that apply (their actual
  words) and say how the task keeps them.
- \`evidence\` may quote signal output, or a file in the repo as \`path:line: the exact text\`.
  Read the repo; real work is often in the code, docs and TODOs, not only the signals.
- For a task made from something the person dropped in, set \`from_drop_in\` to its title. Those
  need no evidence or charter line, and they skip the duplicate rule.
- An empty list is a correct answer when nothing is worth doing. Say why in \`note\`.
- Hire when open tasks are waiting for a free worker and more could run side by side without
  touching the same files: set \`hire.count\` and say why. Annex will not go past the crew limit
  in the wake issue. Do not hire for a single task.
- Set \`ask_first\` to true for a task the person must approve before it starts: anything that
  falls under the brief's "Call me back when", or under these: ${w.settings.askBefore.length ? w.settings.askBefore.map((a) => `"${a}"`).join(", ") : "(none set)"}.
  Annex holds it and shows the person your \`ask_reason\`; nothing starts until they say yes.

Post it with \`node ${REPORT_SCRIPT} done <<'MD'\` (the proposal block is the comment). That marks the
wake issue done in the same step.

### 2. A chat with the person

When the person talks with you, plan with them: ask what they want, push back when something is
vague, and keep it concrete. Do not start work yourself.

When you and the person have agreed on concrete work, put it in your reply as one
\`${PROPOSAL_FENCE}\` block, the same shape as above. Annex starts those tasks at once and tells
you what it started. Their agreement is the reason, so \`charter_line\` and \`evidence\` may be
empty, but each task still needs a \`done_check\` and, when the repo has house rules,
\`house_rules\` quoting the rules it touches. Only include work the person actually agreed to.

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

${pluginSection(plugins, "lead")}${REPORTING}`;
}

export function workerInstructions(w: Wing, plugins: PluginInfo[] = []): string {
  return `# You are on the ${w.name} wing's crew in Annex

Each task you get is one piece of work, in your own git worktree (your current directory, on its
own branch). Annex created the task; the lead chose it.

How to do a task:
1. Read the repo's CLAUDE.md (and AGENTS.md) first; they bind everything you do here, including
   your commit messages. Then read the task: it names the charter line it serves, the evidence,
   the done check and the house rules the lead flagged.
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

${pluginSection(plugins, "worker")}${REPORTING}`;
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
- Does it keep every rule in the repo's CLAUDE.md (and AGENTS.md)? Your worktree has them; read
  them first. Check the diff and the commit message against each rule. Any breach is an automatic
  send-back: quote the rule and the line that breaks it.

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
  closed: { identifier: string; title: string; status: string; why?: string }[];
  dropIns: { title: string; detail: string }[];
  houseRules?: string | null;
  crew?: { workers: number; maxWorkers: number };
}): { title: string; description: string } {
  const { wing } = opts;
  const lines: string[] = [];
  lines.push(`Annex woke the ${wing.name} lead. Read this, then post your \`${PROPOSAL_FENCE}\` comment and mark this issue done.`);
  if (opts.houseRules) {
    lines.push(
      "",
      "## House rules (the repo's own CLAUDE.md / AGENTS.md)",
      "",
      "These bind every task. Read them before you choose anything. A task that would break one is not proposed at all. Each task must name, in `house_rules`, the rules it touches and how it keeps them.",
      "",
      opts.houseRules,
    );
  }
  if (opts.brief) lines.push("", "## Approved brief", "", opts.brief);
  if (opts.crew) lines.push("", "## Crew", "", `${opts.crew.workers} worker(s) now; you may grow the crew to ${opts.crew.maxWorkers}.`);
  lines.push("", "## Signals");
  for (const s of opts.signals) {
    lines.push("", `### ${s.name}: \`${s.run}\` (exit ${s.exitCode})`, "", "```", s.output.trim().slice(-6000) || "(no output)", "```");
  }
  lines.push("", "## Open tasks", "", ...(opts.open.length ? opts.open.map((t) => `- ${t.identifier} [${t.status}] ${t.title}`) : ["None."]));
  lines.push("", "## Closed in the last 7 days", "", ...(opts.closed.length ? opts.closed.map((t) => `- ${t.identifier} [${t.status}] ${t.title}${t.why ? `\n  Why it stopped, from Annex's last check:\n  \`\`\`\n${t.why}\n  \`\`\`` : ""}`) : ["None."]));
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
