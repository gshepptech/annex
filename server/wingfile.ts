// Writes a wing back to its file. The file stays the source of truth: the settings form in the
// office edits it, and anyone can still edit it by hand. Output is laid out the way a person
// would write it, with every optional limit present as a commented example when it is off.

import type { Wing } from "./wing.ts";
import type { WingEdit } from "./api-types.ts";
import { homedir } from "node:os";

export function applyEdit(w: Wing, e: WingEdit): Wing {
  const repo =
    e.repoPath === null
      ? null
      : e.repoPath !== undefined || e.baseBranch !== undefined
        ? {
            path: e.repoPath ?? w.repo?.path ?? "",
            baseBranch: e.baseBranch ?? w.repo?.baseBranch ?? "main",
            integrationBranch: w.repo?.integrationBranch ?? `annex/${w.id}`,
          }
        : w.repo;
  return {
    ...w,
    name: e.name ?? w.name,
    charter: e.charter ?? w.charter,
    doneCheck: e.doneCheck === undefined ? w.doneCheck : e.doneCheck || null,
    setup: e.setup === undefined ? w.setup : e.setup || null,
    repo,
    crew: {
      workers: e.workers ?? w.crew.workers,
      leadModel: e.leadModel ?? w.crew.leadModel,
      workerModel: e.workerModel ?? w.crew.workerModel,
      reviewerModel: e.reviewerModel ?? w.crew.reviewerModel,
    },
    allow: e.allow ?? w.allow,
  };
}

const q = (s: string) => JSON.stringify(s);
const tilde = (p: string) => (p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);

export function toToml(w: Wing, settings: { wakeEvery: string; maxRunsPerHour: number | null; quietHours: string | null; backOffWhenIdle: boolean; askBefore: string[] }): string {
  const out: string[] = [
    `# ${w.name}. Edited in Annex's office or by hand; Annex applies changes without a restart.`,
    "",
    `name = ${q(w.name)}`,
    `mode = ${q(w.initialMode)}`,
  ];
  if (w.charter) {
    out.push(w.charter.includes('"""') ? `charter = ${q(w.charter)}` : `charter = """\n${w.charter.trim()}\n"""`);
  }
  if (w.doneCheck) out.push(`done_check = ${q(w.doneCheck)}`);
  if (w.setup) out.push(`setup = ${q(w.setup)}`);
  if (w.repo) {
    out.push("", "[repo]", `path = ${q(tilde(w.repo.path))}`, `base_branch = ${q(w.repo.baseBranch)}`, `integration_branch = ${q(w.repo.integrationBranch)}`);
  }
  for (const s of w.signals) out.push("", "[[signals]]", `name = ${q(s.name)}`, `run = ${q(s.run)}`);
  out.push("", "[crew]", `workers = ${w.crew.workers}`, `lead_model = ${q(w.crew.leadModel)}`, `worker_model = ${q(w.crew.workerModel)}`, `reviewer_model = ${q(w.crew.reviewerModel)}`);
  out.push("", "# Every limit is optional and off unless set.", "[settings]", `wake_every = ${q(settings.wakeEvery)}`);
  out.push(settings.maxRunsPerHour === null ? "# max_runs_per_hour = 6" : `max_runs_per_hour = ${settings.maxRunsPerHour}`);
  out.push(settings.quietHours ? `quiet_hours = ${q(settings.quietHours)}` : `# quiet_hours = "00:00-07:00"`);
  out.push(settings.backOffWhenIdle ? "back_off_when_idle = true" : "# back_off_when_idle = true");
  out.push(settings.askBefore.length ? `ask_before = [${settings.askBefore.map(q).join(", ")}]` : `# ask_before = ["adding a new dependency"]`);
  if (w.allow.length) out.push("", "[permissions]", `allow = [${w.allow.map(q).join(", ")}]`);
  return out.join("\n") + "\n";
}
