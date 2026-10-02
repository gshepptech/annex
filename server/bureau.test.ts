// The bureau against a fake Paperclip and a real git repo. The fake plays the agents' parts by
// hand, so every decision Annex makes (what to create, when to run the check, what to merge) is
// exercised without spending any Claude usage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db.ts";
import { parseWing } from "./wing.ts";
import { git } from "./git.ts";
import { Bureau } from "./bureau.ts";
import type { Paperclip, Issue, Comment, ExecutionWorkspace, Principal } from "./engine/paperclip.ts";

class FakePaperclip {
  issues = new Map<string, Issue & { stages: Principal[]; stageIndex: number }>();
  comments = new Map<string, Comment[]>();
  workspaces: ExecutionWorkspace[] = [];
  agentsList: { id: string; name: string; role: string; status: string; reportsTo: null; adapterConfig: {}; runtimeConfig: {} }[] = [];
  statusCalls: { id: string; status: string; comment: string }[] = [];
  private n = 0;
  id = (p: string) => `${p}${++this.n}`;

  async health() { return { status: "ok", version: "fake" }; }
  async enableExperiments() { return {}; }
  async companies() { return [{ id: "C1", name: "c", issuePrefix: "UP" }]; }
  async createCompany() { return { id: "C1", name: "c", issuePrefix: "UP" }; }
  async createProject() { return { projectId: "P1", workspaceId: "W1" }; }
  async projects() { return [{ id: "P1", name: "p" }]; }
  async createAgent(_c: string, a: { name: string; role: string }) {
    const agent = { id: this.id("A"), name: a.name, role: a.role, status: "idle", reportsTo: null, adapterConfig: {}, runtimeConfig: {} };
    this.agentsList.push(agent);
    return agent;
  }
  async syncAgent() { return {}; }
  async agents() { return this.agentsList; }
  async createIssue(_c: string, i: { title: string; description: string; assigneeAgentId: string; reviewStages?: Principal[] }) {
    const id = this.id("I");
    const issue = {
      id, identifier: `UP-${this.n}`, companyId: "C1", projectId: "P1", parentId: null, title: i.title, description: i.description,
      status: "todo" as const, assigneeAgentId: i.assigneeAgentId, assigneeUserId: null, executionState: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stages: i.reviewStages ?? [], stageIndex: -1,
    };
    this.issues.set(id, issue);
    return structuredClone(issue);
  }
  async issue(id: string) { return structuredClone(this.issues.get(id)!); }
  async issues_() { return structuredClone([...this.issues.values()]); }
  async setStatus(id: string, status: Issue["status"], comment: string) {
    this.statusCalls.push({ id, status, comment });
    const i = this.issues.get(id)!;
    // the review policy, as Paperclip applies it: `done` approves the current stage
    if (i.status === "in_review" && status === "done" && i.stageIndex + 1 < i.stages.length) this.enterStage(i, i.stageIndex + 1);
    else if (i.status === "in_review" && status !== "done") this.sendBack(i);
    else i.status = status;
    return i;
  }
  async comments_(id: string) { return this.comments.get(id) ?? []; }
  async comment(id: string, body: string) {
    const c = { id: this.id("M"), body, authorAgentId: null, authorUserId: "local-board", createdAt: new Date().toISOString() };
    this.comments.set(id, [...(this.comments.get(id) ?? []), c]);
    return c;
  }
  async openChat() { return { id: "CHAT" }; }
  async createApproval() { return { id: "AP1", status: "pending" }; }
  async approve() { return { id: "AP1", status: "approved" }; }
  async executionWorkspaces() { return this.workspaces; }
  async companyRuns() { return []; }
  subscribe() { return () => {}; }

  // playing the agents

  agentComment(issueId: string, agentId: string, body: string) {
    const c = { id: this.id("M"), body, authorAgentId: agentId, authorUserId: null, createdAt: new Date().toISOString() };
    this.comments.set(issueId, [...(this.comments.get(issueId) ?? []), c]);
  }
  workerFinishes(id: string) {
    const i = this.issues.get(id)!;
    i.executionState = { status: "pending", currentStageId: "s", currentStageIndex: 0, currentStageType: "review", currentParticipant: null, returnAssignee: { type: "agent", agentId: i.assigneeAgentId, userId: null }, lastDecisionOutcome: null, changesRequestedCount: 0 };
    this.enterStage(i, 0);
  }
  private enterStage(i: Issue & { stages: Principal[]; stageIndex: number }, n: number) {
    i.stageIndex = n;
    i.status = "in_review";
    i.executionState = { ...i.executionState!, currentStageIndex: n, currentParticipant: i.stages[n]! };
  }
  private sendBack(i: Issue & { stageIndex: number }) {
    i.status = "in_progress";
    i.stageIndex = -1;
    i.executionState = { ...i.executionState!, currentParticipant: null, lastDecisionOutcome: "changes_requested" };
  }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "annex-bureau-"));
  const repo = join(dir, "repo");
  await git(dir, "init", "-q", "-b", "main", repo);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"]]) await git(repo, "config", k!, v!);
  writeFileSync(join(repo, "README.md"), "hi\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");

  const wing = parseWing("upkeep", `
name = "Upkeep"
mode = "autonomous"
charter = """
1. done.txt exists on the integration branch.
"""
done_check = "test -f done.txt"
[repo]
path = "${repo}"
base_branch = "main"
[[signals]]
name = "files"
run = "ls -1 && echo 'missing: done.txt (needed by charter)'"
[crew]
workers = 1
`);
  const pc = new FakePaperclip();
  // route the client method names the bureau uses onto the fake's maps
  const client = new Proxy(pc, {
    get(t, k) {
      if (k === "issues") return () => t.issues_();
      if (k === "comments") return (id: string) => t.comments_(id);
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as unknown as Paperclip;
  const store = new Store(":memory:");
  const bureau = new Bureau({ store, pc: client, wings: [wing], stateDir: join(dir, "state"), claudeCommand: "claude", settingsFile: "/dev/null", log: () => {} });
  await bureau.start();
  bureau.stopAll();
  return { dir, repo, pc, store, bureau };
}

const kinds = (store: Store) => store.eventsSince(0).map((e) => e.kind);

test("wake -> proposal -> task -> failed check -> passed check -> review -> merged", async () => {
  const { repo, pc, store, bureau } = await setup();
  const lead = store.agents("upkeep").find((a) => a.role === "lead")!;
  const worker = store.agents("upkeep").find((a) => a.role === "worker")!;
  const reviewer = store.agents("upkeep").find((a) => a.role === "reviewer")!;

  // start() ran a tick: the lead was woken with the signal output in its issue
  const wakeIssue = [...pc.issues.values()].find((i) => i.title.startsWith("Wake:"))!;
  assert.ok(wakeIssue, "a wake issue was created");
  assert.equal(wakeIssue.assigneeAgentId, lead.id);
  assert.match(wakeIssue.description!, /missing: done.txt/);
  assert.ok(kinds(store).includes("lead.woke"));

  // the lead answers with one good task and one that breaks the rules
  pc.agentComment(wakeIssue.id, lead.id, "```annex-proposal\n" + JSON.stringify({
    note: "done.txt is missing",
    tasks: [
      { title: "Add done.txt", charter_line: "done.txt exists on the integration branch.", evidence: "missing: done.txt (needed by charter)", done_check: "test -f done.txt", size: "S" },
      { title: "Rewrite everything in Rust", charter_line: "Be modern", evidence: "vibes", done_check: "true", size: "L" },
    ],
  }) + "\n```");
  wakeIssue.status = "done";
  await bureau.tick();

  const task = [...pc.issues.values()].find((i) => i.title === "Add done.txt")!;
  assert.ok(task, "the good task was created");
  assert.equal([...pc.issues.values()].some((i) => i.title.includes("Rust")), false, "the bad one was thrown away");
  assert.equal(task.assigneeAgentId, worker.id);
  assert.deepEqual(task.stages.map((s) => s.type), ["user", "agent"], "Annex reviews first, then the reviewer");
  assert.ok(store.eventsSince(0).some((e) => e.kind === "agent.said" && /Threw away "Rewrite everything in Rust"/.test(String(e.payload.text))));

  // the worker's worktree, the way Paperclip makes it
  const branch = `annex/upkeep--${task.identifier}`;
  const wt = join(repo, "..", "wt");
  await git(repo, "worktree", "add", "-q", "-b", branch, wt, "annex/upkeep");
  pc.workspaces.push({ id: "EW1", sourceIssueId: task.id, cwd: wt, branchName: branch, baseRef: "annex/upkeep", status: "active" });

  // first attempt: marks done without committing anything
  pc.workerFinishes(task.id);
  await bureau.tick();
  await bureau.idle();
  assert.equal(pc.statusCalls.at(-1)!.status, "in_progress", "sent back");
  assert.match(pc.statusCalls.at(-1)!.comment, /no commits/);
  assert.equal(pc.issues.get(task.id)!.status, "in_progress");

  // second attempt: commits the file
  writeFileSync(join(wt, "done.txt"), "yes\n");
  await git(wt, "add", ".");
  await git(wt, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "add done.txt");
  pc.workerFinishes(task.id);
  await bureau.tick();
  await bureau.idle();
  assert.equal(pc.statusCalls.at(-1)!.status, "done", "Annex approved its stage");
  assert.equal(pc.issues.get(task.id)!.executionState!.currentParticipant!.agentId, reviewer.id, "now with the reviewer");
  assert.ok(kinds(store).includes("check.passed"));

  // the reviewer approves
  pc.issues.get(task.id)!.status = "done";
  await bureau.tick();
  await bureau.idle();
  const integration = join((await bureau.state()).wings[0]!.repo!, "..", "state", "wings", "upkeep", "integration");
  assert.equal(existsSync(join(integration, "done.txt")), true, "merged into annex/upkeep");
  assert.equal(existsSync(join(repo, "done.txt")), false, "the person's checkout is untouched");
  assert.equal(await git(repo, "rev-list", "--count", "main"), "1", "main is untouched");
  const ks = kinds(store);
  for (const k of ["task.created", "task.in_review", "check.failed", "check.passed", "review.accepted", "task.done"] as const) assert.ok(ks.includes(k), `missing ${k}`);
  assert.ok(ks.indexOf("review.accepted") < ks.indexOf("task.done"));
  assert.equal((await bureau.state()).wings[0]!.filedCount, 1);
});

test("an idle lead is a correct answer, and the next wake waits for the interval", async () => {
  const { pc, store, bureau } = await setup();
  const lead = store.agents("upkeep").find((a) => a.role === "lead")!;
  const wakeIssue = [...pc.issues.values()].find((i) => i.title.startsWith("Wake:"))!;
  // done first, comment visible a moment later: the race seen live
  wakeIssue.status = "done";
  wakeIssue.updatedAt = new Date().toISOString();
  await bureau.tick();
  assert.equal(store.eventsSince(0).some((e) => e.kind === "lead.idle"), false, "not judged before the comment shows up");
  pc.agentComment(wakeIssue.id, lead.id, '```annex-proposal\n{"note":"all good","tasks":[]}\n```');
  await bureau.tick();
  assert.ok(store.eventsSince(0).some((e) => e.kind === "lead.idle" && e.payload.reason === "all good"));
  await bureau.tick();
  assert.equal([...pc.issues.values()].filter((i) => i.title.startsWith("Wake:")).length, 1, "no second wake before 15m");
});

test("a drop-in wakes the lead early and reaches it in the wake issue", async () => {
  const { pc, store, bureau } = await setup();
  const lead = store.agents("upkeep").find((a) => a.role === "lead")!;
  const first = [...pc.issues.values()].find((i) => i.title.startsWith("Wake:"))!;
  pc.agentComment(first.id, lead.id, '```annex-proposal\n{"note":"","tasks":[]}\n```');
  first.status = "done";
  await bureau.tick();
  await bureau.dropIn("upkeep", "Check the README", "It mentions a flag that is gone");
  await bureau.idle();
  const wakes = [...pc.issues.values()].filter((i) => i.title.startsWith("Wake:"));
  assert.equal(wakes.length, 2);
  assert.match(wakes[1]!.description!, /Check the README/);
});

test("handing off needs a repo, and coming back flips the mode", async () => {
  const { store, bureau } = await setup();
  await bureau.comeBack("upkeep");
  assert.equal(store.wing("upkeep")!.mode, "with_you");
  await assert.rejects(bureau.comeBack("upkeep"), /already with you/);
  await assert.rejects(bureau.chat("nope", "hi"), /no wing called/);
});


// Shared setup for the review-finding tests: one accepted task with a worktree the test controls.
async function oneTask() {
  const env = await setup();
  const { pc, store, bureau, repo } = env;
  const lead = store.agents("upkeep").find((a) => a.role === "lead")!;
  const wakeIssue = [...pc.issues.values()].find((i) => i.title.startsWith("Wake:"))!;
  pc.agentComment(wakeIssue.id, lead.id, "```annex-proposal\n" + JSON.stringify({ note: "", tasks: [
    { title: "Add done.txt", charter_line: "done.txt exists on the integration branch.", evidence: "missing: done.txt (needed by charter)", done_check: "test -f done.txt", size: "S" },
  ] }) + "\n```");
  wakeIssue.status = "done";
  await bureau.tick();
  const task = [...pc.issues.values()].find((i) => i.title === "Add done.txt")!;
  const branch = `annex/upkeep--${task.identifier}`;
  const wt = join(repo, "..", "wt");
  await git(repo, "worktree", "add", "-q", "-b", branch, wt, "annex/upkeep");
  pc.workspaces.push({ id: "EW1", sourceIssueId: task.id, cwd: wt, branchName: branch, baseRef: "annex/upkeep", status: "active" });
  return { ...env, task, wt };
}

test("three failed checks stop the task: sent back out of review first, then cancelled", async () => {
  const { pc, store, bureau, task, wt } = await oneTask();
  writeFileSync(join(wt, "other.txt"), "not the file\n");
  await git(wt, "add", ".");
  await git(wt, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "wrong file");
  for (let i = 0; i < 3; i++) {
    pc.workerFinishes(task.id);
    await bureau.tick();
    await bureau.idle();
  }
  assert.equal(pc.issues.get(task.id)!.status, "cancelled", "really cancelled in Paperclip");
  assert.equal(store.task(task.id)!.state, "stopped");
  assert.deepEqual(pc.statusCalls.slice(-2).map((c) => c.status), ["in_progress", "cancelled"]);
  assert.ok(store.eventsSince(0).some((e) => e.kind === "task.stopped"));
});

test("Annex never signs off a review that was escalated to the board", async () => {
  const { pc, store, bureau, task } = await oneTask();
  const i = pc.issues.get(task.id)!;
  i.status = "in_review";
  i.executionState = { status: "pending", currentStageId: "s2", currentStageIndex: 1, currentStageType: "review", currentParticipant: { type: "user", userId: "local-board", agentId: null }, returnAssignee: { type: "agent", agentId: i.assigneeAgentId, userId: null }, lastDecisionOutcome: "changes_requested", changesRequestedCount: 3 };
  i.updatedAt = new Date(Date.now() + 1000).toISOString();
  await bureau.tick();
  await bureau.idle();
  assert.equal(pc.statusCalls.some((c) => c.id === task.id && c.status === "done"), false, "no approval");
  assert.equal(store.task(task.id)!.state, "stopped");
  // the redo goes to the lead: the drop-in makes the next wake due at once
  const wakes = [...pc.issues.values()].filter((x) => x.title.startsWith("Wake:"));
  assert.match(wakes.at(-1)!.description!, new RegExp(`Redo ${task.identifier}`));
});

test("a stale copy of an issue does not re-run the gate", async () => {
  const { pc, bureau, task, wt } = await oneTask();
  writeFileSync(join(wt, "done.txt"), "yes\n");
  await git(wt, "add", ".");
  await git(wt, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "add done.txt");
  pc.workerFinishes(task.id);
  const stale = structuredClone(pc.issues.get(task.id)!);
  await bureau.tick();
  await bureau.idle();
  const approvals = pc.statusCalls.filter((c) => c.id === task.id && c.status === "done").length;
  assert.equal(approvals, 1);
  // the newer copy is now with the reviewer; replaying the older one must change nothing
  pc.issues.get(task.id)!.updatedAt = new Date(Date.now() + 5000).toISOString();
  await bureau.tick();
  await (bureau as unknown as { observe: (rt: unknown, i: unknown, a: null) => Promise<void> }).observe(
    (bureau as unknown as { rts: Map<string, unknown> }).rts.get("upkeep"), stale, null);
  await bureau.idle();
  assert.equal(pc.statusCalls.filter((c) => c.id === task.id && c.status === "done").length, approvals);
});
