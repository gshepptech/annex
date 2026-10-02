// The bureau runs every wing: it wakes autonomous leads, turns their proposals into tasks, runs
// the done check when a task reaches Annex's review stage, merges verified work, relays chat,
// and handles the handoff between modes. Paperclip runs the agents; the bureau decides.
//
// Issue state is read from Paperclip's issues and compared with the last copy seen, on every
// relevant frame and on a slow poll, so a frame missed while Annex was down is caught up on the
// next pass instead of lost.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Store, TaskRow } from "./db.ts";
import type { Wing } from "./wing.ts";
import { inQuietHours } from "./wing.ts";
import type { StateView, WingView, TaskView } from "./api-types.ts";
import type { NewEvent } from "./events.ts";
import { BOARD_USER_ID, type Paperclip, type Issue, type Frame } from "./engine/paperclip.ts";
import { provision, type Provisioned } from "./provision.ts";
import { runCommand, type RunResult } from "./run.ts";
import { git, hasCommitsBeyond, isClean, head, mergeBranch, resetIntegration } from "./git.ts";
import { parseProposal, parseBrief, judge } from "./proposal.ts";
import { wakeIssue, taskDescription, BRIEF_FENCE } from "./prompts.ts";
import { UserError, type Bureau as BureauApi } from "./http.ts";
import { toolUses, isUsageLimit, resetTime } from "./mapping.ts";

const TICK_MS = 15_000;
const WAKE_TIMEOUT_MS = 30 * 60_000;
const CHECK_TIMEOUT_MS = 15 * 60_000;
const MAX_CHECK_ATTEMPTS = 3;
const MAX_BACKOFF_SEC = 24 * 3600;
const TOOL_EVENT_GAP_MS = 1500;
const PROPOSAL_GRACE_MS = 30_000;

interface Runtime {
  wing: Wing;
  prov: Provisioned | null;
  offline: string | null;
  issues: Map<string, Issue>;
  seeded: boolean;
  stop: (() => void) | null;
  busy: Set<string>;
  lastTool: Map<string, number>;
  startedRuns: Set<string>;
  waking: boolean;
  // Merges, setup and signal runs all use the one integration worktree, so they take turns.
  integration: Promise<unknown>;
}

export interface BureauOptions {
  store: Store;
  pc: Paperclip;
  wings: Wing[];
  stateDir: string;
  claudeCommand: string;
  settingsFile: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

export class Bureau implements BureauApi {
  private store: Store;
  private pc: Paperclip;
  private rts = new Map<string, Runtime>();
  private opts: BureauOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => Date;
  private log: (msg: string) => void;
  private ticking = false;
  private experimentsOn = false;
  private inflight = new Set<Promise<unknown>>();

  constructor(opts: BureauOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.pc = opts.pc;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((m) => console.log(`[annex] ${m}`));
    for (const wing of opts.wings) {
      this.store.ensureWing(wing.id, wing.initialMode);
      this.rts.set(wing.id, { wing, prov: null, offline: "starting", issues: new Map(), seeded: false, stop: null, busy: new Set(), lastTool: new Map(), startedRuns: new Set(), waking: false, integration: Promise.resolve() });
    }
  }

  async start() {
    await this.connectAll();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    await this.tick();
  }

  // Gates and merges run alongside the loop; this waits for the ones already started.
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<unknown>) {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  stopAll() {
    if (this.timer) clearInterval(this.timer);
    for (const rt of this.rts.values()) rt.stop?.();
  }

  private async connectAll() {
    // Without isolated workspaces Paperclip ignores the worktree policy and agents would work in
    // the person's own checkout, so no wing connects until the flag is confirmed on.
    if (!this.experimentsOn) {
      try {
        await this.pc.health();
        await this.pc.enableExperiments();
        this.experimentsOn = true;
      } catch (err) {
        for (const rt of this.rts.values()) rt.offline = (err as Error).message;
        this.log(`Paperclip is not ready; retrying on each tick. ${(err as Error).message}`);
        return;
      }
    }
    for (const rt of this.rts.values()) {
      if (rt.prov) continue;
      try {
        rt.prov = await provision({ ...this.opts, wing: rt.wing });
        rt.offline = null;
        rt.stop = this.pc.subscribe(rt.prov.companyId, (f) => void this.onFrame(rt, f).catch((e) => this.log(`frame error: ${e.message}`)));
        this.log(`${rt.wing.id}: connected (${rt.prov.workers.length} crew, mode ${this.store.wing(rt.wing.id)!.mode})`);
      } catch (err) {
        rt.offline = (err as Error).message;
        this.log(`${rt.wing.id}: not connected: ${rt.offline}`);
      }
    }
  }

  private inIntegration<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
    const run = rt.integration.then(fn, fn);
    rt.integration = run.catch(() => {});
    return run;
  }

  private emit(e: NewEvent) {
    return this.store.record(e);
  }

  private rt(wingId: string): Runtime {
    const rt = this.rts.get(wingId);
    if (!rt) throw new UserError(`There is no wing called "${wingId}"`, 404);
    return rt;
  }

  private ready(wingId: string): Runtime & { prov: Provisioned } {
    const rt = this.rt(wingId);
    if (!rt.prov) throw new UserError(`${rt.wing.name} is not connected to the engine yet: ${rt.offline ?? "starting"}`, 409);
    return rt as Runtime & { prov: Provisioned };
  }

  // ----- the slow loop ---------------------------------------------------------------------

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if ([...this.rts.values()].some((r) => !r.prov)) await this.connectAll();
      for (const rt of this.rts.values()) {
        if (!rt.prov) continue;
        try {
          await this.refreshAll(rt);
          this.releaseHold(rt);
          await this.maybeWake(rt);
          await this.expireWake(rt);
        } catch (err) {
          this.log(`${rt.wing.id}: tick failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private releaseHold(rt: Runtime) {
    const row = this.store.wing(rt.wing.id)!;
    if (row.heldUntil && new Date(row.heldUntil) <= this.now()) {
      this.store.setHold(rt.wing.id, null, null);
      this.emit({ wingId: rt.wing.id, kind: "wing.resumed", actor: "annex", taskId: null, payload: {} });
    }
  }

  private async refreshAll(rt: Runtime) {
    const seen = new Set<string>();
    for (const cur of await this.pc.issues(rt.prov!.companyId)) {
      seen.add(cur.id);
      await this.observeSafely(rt, cur, null);
    }
    // the list is capped, so open work that has scrolled past it is read one by one
    const wake = this.store.openWake(rt.wing.id);
    const open = [...this.store.tasks(rt.wing.id, { state: "open" }).map((t) => t.id), ...(wake?.issueId ? [wake.issueId] : [])];
    for (const id of open) if (!seen.has(id)) await this.refreshIssue(rt, id, null);
    rt.seeded = true;
    await this.syncChat(rt).catch((e) => this.log(`${rt.wing.id}: chat sync failed: ${e.message}`));
  }

  private async observeSafely(rt: Runtime, cur: Issue, actor: string | null) {
    try {
      await this.observe(rt, cur, actor);
    } catch (err) {
      this.log(`${rt.wing.id}: could not handle ${cur.identifier}: ${(err as Error).message}`);
    }
  }

  private async refreshIssue(rt: Runtime, issueId: string, actor: string | null) {
    let cur: Issue;
    try {
      cur = await this.pc.issue(issueId);
    } catch (err) {
      this.log(`${rt.wing.id}: could not read issue ${issueId}: ${(err as Error).message}`);
      return;
    }
    await this.observeSafely(rt, cur, actor);
  }

  // ----- frames ----------------------------------------------------------------------------

  private async onFrame(rt: Runtime, f: Frame) {
    const p = f.payload;
    if (f.type === "heartbeat.run.log" && typeof p.chunk === "string" && typeof p.agentId === "string") {
      const now = Date.now();
      for (const use of toolUses(p.chunk)) {
        if (now - (rt.lastTool.get(p.agentId) ?? 0) < TOOL_EVENT_GAP_MS) continue;
        rt.lastTool.set(p.agentId, now);
        this.emit({ wingId: rt.wing.id, kind: "agent.tool", actor: p.agentId, taskId: (p.issueId as string) ?? null, payload: { tool: use.tool, detail: use.detail } });
      }
      return;
    }
    if (f.type === "heartbeat.run.status") {
      const runId = String(p.runId ?? "");
      const issueId = typeof p.issueId === "string" ? p.issueId : null;
      const agentId = String(p.agentId ?? "");
      if (p.status === "running" && issueId && !rt.startedRuns.has(runId)) {
        const task = this.store.task(issueId);
        const agent = this.store.agent(agentId);
        if (task && agent?.role === "worker") {
          rt.startedRuns.add(runId);
          this.emit({ wingId: rt.wing.id, kind: "task.started", actor: agentId, taskId: issueId, payload: { title: task.title } });
        }
      }
      if (p.status === "failed" || p.status === "timed_out") {
        const text = `${p.errorCode ?? ""} ${p.error ?? ""} ${p.finalText ?? ""}`;
        if (isUsageLimit(text)) this.holdAll(resetTime(text, this.now()), "Claude usage limit reached");
      }
      if (issueId && (p.status === "succeeded" || p.status === "failed")) await this.refreshIssue(rt, issueId, agentId);
      return;
    }
    if (f.type === "activity.logged" && p.entityType === "issue" && typeof p.entityId === "string") {
      const actor = typeof p.actorId === "string" ? p.actorId : null;
      if (p.action === "issue.comment_added" && p.entityId === this.store.wing(rt.wing.id)!.chatIssueId) {
        await this.syncChat(rt);
        return;
      }
      await this.refreshIssue(rt, p.entityId, actor);
    }
  }

  // ----- issue transitions -----------------------------------------------------------------

  private async observe(rt: Runtime, cur: Issue, actor: string | null) {
    const prev = rt.issues.get(cur.id);
    // a copy fetched before a newer one was seen describes the past; acting on it re-runs gates
    if (prev && new Date(cur.updatedAt) < new Date(prev.updatedAt)) return;
    rt.issues.set(cur.id, cur);
    const fresh = rt.seeded && prev !== undefined;
    const changed = !prev || prev.status !== cur.status || participantKey(prev) !== participantKey(cur);

    const wake = this.store.wakeByIssue(cur.id);
    if (wake && !wake.finishedAt && (cur.status === "done" || cur.status === "cancelled" || changed)) {
      await this.finishWake(rt, cur);
      return;
    }

    const task = this.store.task(cur.id);
    if (!task || task.state !== "open") return;
    const wingId = rt.wing.id;
    const atBourne = isAtBourne(cur);
    const escalated = cur.status === "in_review" && cur.executionState?.currentParticipant?.type === "user" && !atBourne;
    if (escalated) {
      // after repeated rejections Paperclip hands the review to a person; Annex never signs that off
      this.stopAfterReview(rt, cur, task, "the reviewer rejected it repeatedly and Paperclip escalated it to the board");
      return;
    }

    if (atBourne) {
      if (fresh && changed) {
        const worker = cur.executionState?.returnAssignee?.agentId ?? actor ?? "annex";
        this.emit({ wingId, kind: "task.in_review", actor: worker, taskId: cur.id, payload: { title: task.title } });
      }
      this.track(this.gate(rt, cur, task));
      return;
    }
    if (!fresh || !changed) {
      // first sight after a restart: only finish work that was left half done
      if (cur.status === "done") this.track(this.merge(rt, cur, task));
      if (cur.status === "cancelled") this.store.closeTask(cur.id, "stopped");
      if (cur.status === "blocked") await this.replan(rt, cur, task, actor);
      return;
    }
    const reviewerId = rt.prov!.reviewer.id;
    if (cur.status === "done") {
      this.emit({ wingId, kind: "review.accepted", actor: reviewerId, taskId: cur.id, payload: { title: task.title } });
      this.track(this.merge(rt, cur, task));
    } else if (prev.status === "in_review" && cur.status === "in_progress" && prev.executionState?.currentParticipant?.agentId === reviewerId) {
      this.emit({ wingId, kind: "review.rejected", actor: reviewerId, taskId: cur.id, payload: { title: task.title, reason: await this.lastCommentBy(cur.id, reviewerId) } });
    } else if (cur.status === "blocked" && prev.status !== "blocked") {
      await this.replan(rt, cur, task, actor);
    } else if (cur.status === "cancelled") {
      this.store.closeTask(cur.id, "stopped");
      this.emit({ wingId, kind: "task.stopped", actor: actor ?? "annex", taskId: cur.id, payload: { title: task.title, reason: "cancelled in Paperclip" } });
    }
  }

  // A blocked task goes back to the lead to re-plan: the crew cannot unblock it, and the lead
  // cannot cancel tasks, so leaving it open would leave it open forever.
  private async replan(rt: Runtime, cur: Issue, task: TaskRow, actor: string | null) {
    const wingId = rt.wing.id;
    const by = cur.assigneeAgentId ?? actor ?? "annex";
    const reason = await this.lastCommentBy(cur.id, by);
    this.emit({ wingId, kind: "agent.said", actor: by, taskId: cur.id, payload: { text: `Blocked: ${reason}` } });
    this.store.closeTask(cur.id, "stopped");
    await this.pc.setStatus(cur.id, "cancelled", "Annex handed this back to the lead to re-plan.");
    this.store.addDropIn(wingId, `Re-plan ${cur.identifier} (blocked): ${task.title}`, `The worker stopped with: ${reason.slice(0, 600)}`);
    this.emit({ wingId, kind: "task.stopped", actor: "annex", taskId: cur.id, payload: { title: task.title, reason: "blocked; back to the lead" } });
  }

  private async lastCommentBy(issueId: string, agentId: string): Promise<string> {
    const comments = await this.pc.comments(issueId).catch(() => []);
    // Paperclip posts its own "Workspace Ready" note under the agent's name
    const mine = comments.filter((c) => c.authorAgentId === agentId && !c.body.startsWith("## Workspace Ready"));
    return (mine[mine.length - 1]?.body ?? "").slice(0, 400);
  }

  // ----- the done check gate (design D6) ---------------------------------------------------

  private async workspaceFor(rt: Runtime, issueId: string, includeArchived = false) {
    const all = await this.pc.executionWorkspaces(rt.prov!.companyId);
    return all.find((w) => w.sourceIssueId === issueId && (includeArchived || w.status !== "archived")) ?? null;
  }

  private async gate(rt: Runtime, seen: Issue, task: TaskRow) {
    const key = `gate:${seen.id}`;
    if (rt.busy.has(key)) return;
    rt.busy.add(key);
    const wingId = rt.wing.id;
    try {
      // the copy that triggered this may be old; only a current one at Annex's stage counts
      const issue = await this.pc.issue(seen.id);
      if (!isAtBourne(issue)) return;
      const ws = await this.workspaceFor(rt, issue.id);
      const base = ws?.baseRef ?? rt.wing.repo?.integrationBranch ?? "HEAD";
      let result: RunResult;
      let where = "";
      if (!ws || !existsSync(ws.cwd)) {
        result = fail("Annex could not find this task's worktree, so there is nothing to check.");
      } else if (rt.wing.repo && resolve(ws.cwd) === resolve(rt.wing.repo.path)) {
        result = fail("This task ran in the person's own checkout instead of its own worktree. Annex will not check or merge work done there.");
      } else if (!(await hasCommitsBeyond(ws.cwd, base))) {
        result = fail(`There are no commits on ${ws.branchName} beyond ${base}. Commit your work, then mark the task done again.`);
      } else {
        const setup = rt.wing.setup ? await runCommand(rt.wing.setup, ws.cwd, CHECK_TIMEOUT_MS) : null;
        if (setup && setup.exitCode !== 0) {
          result = { ...setup, output: `[setup \`${rt.wing.setup}\` failed]\n${setup.output}` };
        } else if (!(await isClean(ws.cwd))) {
          result = fail("The worktree has uncommitted changes. Commit or discard them so the check runs on what will be merged.");
        } else {
          where = `${ws.branchName} at ${(await head(ws.cwd)).slice(0, 8)}`;
          this.emit({ wingId, kind: "check.started", actor: "annex", taskId: issue.id, payload: { title: task.title, command: task.doneCheck } });
          result = await runCommand(task.doneCheck, ws.cwd, CHECK_TIMEOUT_MS);
        }
      }
      const run = this.store.startCheck({ wingId, taskId: issue.id, command: task.doneCheck, cwd: ws?.cwd ?? "" });
      this.store.finishCheck(run.id, result.exitCode, result.output);
      const tail = lastLines(result.output, 40);

      // the check can take minutes; decide only if the issue is still waiting on Annex
      if (!isAtBourne(await this.pc.issue(issue.id))) return;

      if (result.exitCode === 0) {
        this.emit({ wingId, kind: "check.passed", actor: "annex", taskId: issue.id, payload: { title: task.title, command: task.doneCheck } });
        await this.pc.setStatus(issue.id, "done", `Annex ran \`${task.doneCheck}\` on ${where}: it passed (exit 0). Passing to review.\n\n\`\`\`\n${tail}\n\`\`\``);
        return;
      }
      this.emit({ wingId, kind: "check.failed", actor: "annex", taskId: issue.id, payload: { title: task.title, command: task.doneCheck, exitCode: result.exitCode } });
      const why = result.timedOut ? `timed out after ${Math.round(CHECK_TIMEOUT_MS / 60_000)} minutes` : `failed (exit ${result.exitCode})`;
      if (run.attempt >= MAX_CHECK_ATTEMPTS) {
        // In review, any status but done is a send-back, so it has to leave review before it
        // can be cancelled.
        this.store.closeTask(issue.id, "stopped");
        await this.pc.setStatus(issue.id, "in_progress", `Annex ran \`${task.doneCheck}\` and it ${why}, attempt ${run.attempt} of ${MAX_CHECK_ATTEMPTS}. Annex is stopping this task; the lead will see it on its next wake.\n\n\`\`\`\n${tail}\n\`\`\``);
        await this.pc.setStatus(issue.id, "cancelled", "Stopped by Annex after repeated done check failures.");
        const after = await this.pc.issue(issue.id);
        if (after.status !== "cancelled") this.log(`${wingId}: ${issue.identifier} did not cancel (now ${after.status})`);
        this.emit({ wingId, kind: "task.stopped", actor: "annex", taskId: issue.id, payload: { title: task.title, reason: `done check failed ${run.attempt} times` } });
        return;
      }
      await this.pc.setStatus(issue.id, "in_progress", `Annex ran \`${task.doneCheck}\`${where ? ` on ${where}` : ""} and it ${why}. Attempt ${run.attempt} of ${MAX_CHECK_ATTEMPTS}. Fix this and mark the task done again.\n\n\`\`\`\n${tail}\n\`\`\``);
    } catch (err) {
      this.log(`${wingId}: gate for ${seen.identifier} failed: ${(err as Error).message}`);
    } finally {
      rt.busy.delete(key);
    }
  }

  private async runWithSetup(rt: Runtime, command: string, cwd: string): Promise<RunResult> {
    if (rt.wing.setup) {
      const setup = await runCommand(rt.wing.setup, cwd, CHECK_TIMEOUT_MS);
      if (setup.exitCode !== 0) return { ...setup, output: `[setup \`${rt.wing.setup}\` failed]\n${setup.output}` };
    }
    return runCommand(command, cwd, CHECK_TIMEOUT_MS);
  }

  // ----- merging verified work (design D7) -------------------------------------------------

  private async merge(rt: Runtime, issue: Issue, task: TaskRow) {
    const key = `merge:${issue.id}`;
    if (rt.busy.has(key)) return;
    rt.busy.add(key);
    try {
      await this.inIntegration(rt, () => this.mergeNow(rt, issue));
    } finally {
      rt.busy.delete(key);
    }
  }

  private async mergeNow(rt: Runtime, issue: Issue) {
    const task = this.store.task(issue.id);
    if (!task || task.state !== "open") return;
    const wingId = rt.wing.id;
    const ws = rt.prov!.workspace;
    try {
      if (!ws) {
        this.store.closeTask(issue.id, "merged");
        this.emit({ wingId, kind: "task.done", actor: "annex", taskId: issue.id, payload: { title: task.title } });
        return;
      }
      const ew = await this.workspaceFor(rt, issue.id, true);
      const branch = ew?.branchName ?? `${ws.integrationBranch}--${issue.identifier}`;
      // Annex owns this worktree; anything left in it is from an earlier setup or a failed run
      await cleanWorktree(ws.integrationDir);
      const before = await head(ws.integrationDir);
      const merged = await mergeBranch(ws, branch, `Merge ${issue.identifier}: ${task.title}`);
      if (!merged.ok) return this.stopAfterReview(rt, issue, task, `it no longer merges cleanly into ${ws.integrationBranch}: ${merged.reason.split("\n")[0]}`);
      const check = await this.runWithSetup(rt, task.doneCheck, ws.integrationDir);
      if (check.exitCode !== 0) {
        await resetIntegration(ws, before);
        return this.stopAfterReview(rt, issue, task, `merged, the done check failed on ${ws.integrationBranch}, so the merge was undone`);
      }
      this.store.closeTask(issue.id, "merged");
      this.emit({ wingId, kind: "task.done", actor: "annex", taskId: issue.id, payload: { title: task.title, commit: merged.commit, branch: ws.integrationBranch } });
    } catch (err) {
      this.log(`${wingId}: merge of ${issue.identifier} failed: ${(err as Error).message}`);
    }
  }

  // Approved work that cannot land goes back to the lead as a drop-in rather than being forced.
  private stopAfterReview(rt: Runtime, issue: Issue, task: TaskRow, reason: string) {
    this.store.closeTask(issue.id, "stopped");
    this.store.addDropIn(rt.wing.id, `Redo ${issue.identifier} on top of ${rt.wing.repo?.integrationBranch}: ${task.title}`, `The reviewed work was not merged: ${reason}. Its branch is still there to start from.`);
    this.emit({ wingId: rt.wing.id, kind: "task.stopped", actor: "annex", taskId: issue.id, payload: { title: task.title, reason } });
  }

  // ----- the wake routine (design D5) ------------------------------------------------------

  private async runsInLastHour(rt: Runtime): Promise<number> {
    const since = this.now().getTime() - 3600_000;
    const runs = await this.pc.companyRuns(rt.prov!.companyId);
    return runs.filter((r) => new Date(r.createdAt ?? r.startedAt ?? 0).getTime() >= since).length;
  }

  private async maybeWake(rt: Runtime) {
    const row = this.store.wing(rt.wing.id)!;
    if (row.mode !== "autonomous" || row.heldUntil || rt.waking) return;
    if (!rt.wing.repo || !rt.prov!.workspace) return;
    if (this.store.openWake(rt.wing.id)) return;
    const s = rt.wing.settings;
    if (inQuietHours(s.quietHours, this.now())) return;
    const last = this.store.lastWake(rt.wing.id);
    const interval = Math.min(s.wakeEverySec * 2 ** row.backoffLevel, MAX_BACKOFF_SEC) * 1000;
    const dropIns = this.store.pendingDropIns(rt.wing.id);
    const due = !last || this.now().getTime() - new Date(last.startedAt).getTime() >= interval || dropIns.length > 0;
    if (!due) return;
    if (s.maxRunsPerHour !== null && (await this.runsInLastHour(rt)) >= s.maxRunsPerHour) return;
    await this.wake(rt);
  }

  async wake(rt: Runtime) {
    rt.waking = true;
    const wingId = rt.wing.id;
    const ws = rt.prov!.workspace!;
    const wakeRow = this.store.startWake(wingId);
    try {
      this.emit({ wingId, kind: "lead.woke", actor: rt.prov!.lead.id, taskId: null, payload: {} });
      const signals = await this.inIntegration(rt, async () => {
        await cleanWorktree(ws.integrationDir);
        if (rt.wing.setup) await runCommand(rt.wing.setup, ws.integrationDir, CHECK_TIMEOUT_MS);
        const out = [];
        for (const sig of rt.wing.signals) {
          const r = await runCommand(sig.run, ws.integrationDir, 5 * 60_000);
          out.push({ name: sig.name, run: sig.run, exitCode: r.exitCode, output: r.output });
        }
        return out;
      });
      const week = new Date(this.now().getTime() - 7 * 86400_000).toISOString();
      const view = (t: TaskRow) => {
        const last = t.state === "stopped" ? this.store.checks(t.id).at(-1) : undefined;
        return { identifier: t.identifier, title: t.title, status: t.state === "open" ? rt.issues.get(t.id)?.status ?? "open" : t.state, why: last?.outputTail ? lastLines(last.outputTail, 8) : undefined };
      };
      const dropIns = this.store.pendingDropIns(wingId);
      const brief = this.store.currentBrief(wingId);
      const { title, description } = wakeIssue({
        wing: rt.wing,
        brief: brief?.text ?? null,
        signals,
        open: this.store.tasks(wingId, { state: "open" }).map(view),
        closed: this.store.tasks(wingId, { closedSince: week }).map(view),
        dropIns,
      });
      const issue = await this.pc.createIssue(rt.prov!.companyId, {
        title,
        description: `${description}\n\nThe repo, read only, is at \`${ws.integrationDir}\`.`,
        projectId: null,
        assigneeAgentId: rt.prov!.lead.id,
        priority: "high",
      });
      this.store.setWakeIssue(wakeRow.id, issue.id, signals.map((s) => ({ name: s.name, output: s.output })));
      this.store.takeDropIns(dropIns.map((d) => d.id));
    } catch (err) {
      this.store.finishWake(wakeRow.id, `failed: ${(err as Error).message}`);
      this.emit({ wingId, kind: "lead.idle", actor: rt.prov!.lead.id, taskId: null, payload: { reason: `the wake failed: ${(err as Error).message}` } });
    } finally {
      rt.waking = false;
    }
  }

  private async expireWake(rt: Runtime) {
    const open = this.store.openWake(rt.wing.id);
    if (!open || this.now().getTime() - new Date(open.startedAt).getTime() < WAKE_TIMEOUT_MS) return;
    if (open.issueId) {
      const issue = await this.pc.issue(open.issueId).catch(() => null);
      if (issue && (await this.finishWake(rt, issue))) return;
    }
    this.store.finishWake(open.id, "timed out");
    if (open.issueId) {
      for (const r of await this.pc.runsFor(open.issueId).catch(() => [])) {
        if (r.status === "running" || r.status === "queued") await this.pc.cancelRun(r.id).catch(() => {});
      }
      await this.pc.setStatus(open.issueId, "cancelled", "Annex closed this wake: the lead did not answer within 30 minutes.").catch(() => {});
    }
    this.emit({ wingId: rt.wing.id, kind: "lead.idle", actor: rt.prov!.lead.id, taskId: null, payload: { reason: "the lead did not answer within 30 minutes" } });
  }

  // Returns true when the wake is finished (with or without tasks).
  private async finishWake(rt: Runtime, issue: Issue): Promise<boolean> {
    const wake = this.store.wakeByIssue(issue.id);
    if (!wake || wake.finishedAt) return true;
    const key = `wake:${wake.id}`;
    if (rt.busy.has(key)) return false;
    rt.busy.add(key);
    const wingId = rt.wing.id;
    const lead = rt.prov!.lead;
    try {
      const comments = await this.pc.comments(issue.id);
      const proposalComment = [...comments].reverse().find((c) => c.authorAgentId === lead.id && c.body.includes("```annex-proposal"));
      if (!proposalComment) {
        // A status PATCH carrying the proposal as its comment announces the status before the
        // comment is listed, so "done without a proposal" is only believed after a grace period.
        const closedFor = this.now().getTime() - new Date(issue.updatedAt).getTime();
        if ((issue.status === "done" || issue.status === "cancelled") && closedFor > PROPOSAL_GRACE_MS) {
          this.store.finishWake(wake.id, "no proposal");
          this.emit({ wingId, kind: "lead.idle", actor: lead.id, taskId: null, payload: { reason: "the lead closed the wake without a proposal" } });
          return true;
        }
        return false;
      }
      const parsed = parseProposal(proposalComment.body);
      if ("error" in parsed) {
        this.store.finishWake(wake.id, `bad proposal: ${parsed.error}`);
        this.emit({ wingId, kind: "lead.idle", actor: lead.id, taskId: null, payload: { reason: `its proposal was unreadable: ${parsed.error}` } });
        return true;
      }
      const week = new Date(this.now().getTime() - 7 * 86400_000).toISOString();
      const existingTitles = [...this.store.tasks(wingId, { state: "open" }), ...this.store.tasks(wingId, { closedSince: week })].map((t) => t.title);
      const charter = [rt.wing.charter, this.store.currentBrief(wingId)?.text ?? ""].join("\n");
      const signals = this.store.wakeSignals(wake.id) ?? [];
      const verdicts = judge(parsed.tasks, { charter, signals, existingTitles });

      let created = 0;
      for (const v of verdicts) {
        if (!v.ok) {
          this.emit({ wingId, kind: "agent.said", actor: "annex", taskId: null, payload: { text: `Threw away "${v.task.title || "untitled"}": ${v.reason}` } });
          continue;
        }
        await this.createTask(rt, { ...v.task, source: "lead" });
        created++;
      }
      if (created === 0) {
        this.emit({ wingId, kind: "lead.idle", actor: lead.id, taskId: null, payload: { reason: parsed.note || "nothing worth doing" } });
      } else if (parsed.note) {
        this.emit({ wingId, kind: "agent.said", actor: lead.id, taskId: null, payload: { text: parsed.note } });
      }
      const row = this.store.wing(wingId)!;
      if (rt.wing.settings.backOffWhenIdle) this.store.setBackoff(wingId, created === 0 ? row.backoffLevel + 1 : 0);
      this.store.finishWake(wake.id, `${created} task(s) created, ${verdicts.length - created} thrown away`);
      if (issue.status !== "done" && issue.status !== "cancelled") await this.pc.setStatus(issue.id, "done", `Annex read the proposal: ${created} task(s) created.`).catch(() => {});
      return true;
    } finally {
      rt.busy.delete(key);
    }
  }

  private async createTask(rt: Runtime, t: { title: string; charterLine: string; evidence: string; doneCheck: string; size: string; details: string; source: "lead" | "you" }) {
    const prov = rt.prov!;
    const open = this.store.tasks(rt.wing.id, { state: "open" });
    const load = (id: string) => open.filter((x) => rt.issues.get(x.id)?.assigneeAgentId === id).length;
    const worker = [...prov.workers].sort((a, b) => load(a.id) - load(b.id))[0]!;
    const setupNote = rt.wing.setup ? `\n\nStart by running \`${rt.wing.setup}\` in your worktree.` : "";
    const issue = await this.pc.createIssue(prov.companyId, {
      title: t.title,
      description: taskDescription({ ...t, base: rt.wing.repo?.integrationBranch ?? "" }) + setupNote,
      projectId: prov.projectId,
      assigneeAgentId: worker.id,
      reviewStages: [
        { type: "user", userId: BOARD_USER_ID, agentId: null },
        { type: "agent", agentId: prov.reviewer.id, userId: null },
      ],
    });
    rt.issues.set(issue.id, issue);
    this.store.addTask({ id: issue.id, wingId: rt.wing.id, identifier: issue.identifier, title: t.title, doneCheck: t.doneCheck, charterLine: t.charterLine, evidence: t.evidence, source: t.source });
    this.emit({ wingId: rt.wing.id, kind: "task.created", actor: t.source === "you" ? "you" : prov.lead.id, taskId: issue.id, payload: { title: t.title, assigneeId: worker.id, charterLine: t.charterLine } });
    return issue;
  }

  // ----- holds -----------------------------------------------------------------------------

  private holdAll(until: Date, reason: string) {
    for (const rt of this.rts.values()) {
      const row = this.store.wing(rt.wing.id)!;
      if (row.heldUntil && new Date(row.heldUntil) >= until) continue;
      this.store.setHold(rt.wing.id, until.toISOString(), reason);
      this.emit({ wingId: rt.wing.id, kind: "wing.held", actor: "annex", taskId: null, payload: { until: until.toISOString(), reason } });
    }
  }

  // ----- chat and the handoff (design D3, D4) ----------------------------------------------

  private async chatIssue(rt: Runtime & { prov: Provisioned }): Promise<string> {
    const row = this.store.wing(rt.wing.id)!;
    if (row.chatIssueId) return row.chatIssueId;
    const chat = await this.pc.openChat(rt.prov.companyId, rt.prov.lead.id);
    this.store.setChatIssue(rt.wing.id, chat.id);
    return chat.id;
  }

  private async say(rt: Runtime & { prov: Provisioned }, text: string, show: boolean) {
    const issueId = await this.chatIssue(rt);
    const comment = await this.pc.comment(issueId, text, randomUUID());
    // Annex's own prompts to the lead go through the same chat issue but are not shown as the
    // person's words; the chat sync only ever reads the lead's comments back.
    if (show) {
      this.store.addChat(rt.wing.id, "you", text, comment.id);
      this.emit({ wingId: rt.wing.id, kind: "chat.message", actor: "you", taskId: null, payload: { who: "you", text } });
    }
  }

  private async syncChat(rt: Runtime) {
    const row = this.store.wing(rt.wing.id)!;
    if (!row.chatIssueId || !rt.prov) return;
    const leadId = rt.prov.lead.id;
    for (const c of await this.pc.comments(row.chatIssueId)) {
      if (c.authorAgentId !== leadId || this.store.hasChatComment(c.id)) continue;
      const brief = parseBrief(c.body);
      const shown = brief ? c.body.replace(new RegExp("```" + BRIEF_FENCE + "[\\s\\S]*?```"), "(Brief drafted. See the Brief tab.)").trim() : c.body;
      if (!this.store.addChat(rt.wing.id, "lead", shown, c.id)) continue;
      this.emit({ wingId: rt.wing.id, kind: "chat.message", actor: leadId, taskId: null, payload: { who: "lead", text: shown.slice(0, 500) } });
      if (brief) await this.draftBrief(rt as Runtime & { prov: Provisioned }, brief);
    }
  }

  private async draftBrief(rt: Runtime & { prov: Provisioned }, text: string) {
    // Approved in Annex, not as a Paperclip approval: approving one of those wakes the lead with
    // no task (spike gotcha 5).
    const draft = this.store.addBrief(rt.wing.id, text);
    this.emit({ wingId: rt.wing.id, kind: "approval.requested", actor: rt.prov.lead.id, taskId: null, payload: { title: `Approve the handoff brief (v${draft.version})`, briefId: draft.id } });
  }

  async chat(wingId: string, text: string) {
    const rt = this.ready(wingId);
    if (this.store.wing(wingId)!.mode !== "with_you") throw new UserError(`${rt.wing.name} is on its own. Come back in to talk with its lead.`, 409);
    await this.say(rt, text, true);
  }

  async handoff(wingId: string) {
    const rt = this.ready(wingId);
    if (this.store.wing(wingId)!.mode !== "with_you") throw new UserError(`${rt.wing.name} is already on its own.`, 409);
    if (!rt.wing.repo) throw new UserError(`${rt.wing.name} has no repo, so Annex has nothing to check its work against. Add a [repo] section to wings/${wingId}/wing.toml, then hand off.`, 409);
    await this.say(rt, `The person is ready to hand this wing off to you. Write the handoff brief now: one fenced block tagged \`${BRIEF_FENCE}\` with the headings ## Goal, ## Decided, ## Off limits, ## Call me back when. Write only what this conversation settled.`, false);
    this.emit({ wingId, kind: "agent.said", actor: "you", taskId: null, payload: { text: "Asked the lead to write the handoff brief" } });
  }

  async approveBrief(wingId: string, briefId: number) {
    const rt = this.ready(wingId);
    const brief = this.store.brief(briefId);
    if (!brief || brief.wingId !== wingId) throw new UserError("That brief does not belong to this wing", 404);
    if (brief.status !== "draft") throw new UserError(`Brief v${brief.version} is already ${brief.status}`, 409);
    if (!rt.wing.repo) throw new UserError(`Add a [repo] section to wings/${wingId}/wing.toml before handing ${rt.wing.name} off.`, 409);
    this.store.approveBrief(briefId);
    this.store.setMode(wingId, "autonomous");
    this.emit({ wingId, kind: "approval.decided", actor: "you", taskId: null, payload: { decision: "approved", title: `handoff brief v${brief.version}` } });
    this.emit({ wingId, kind: "wing.mode_changed", actor: "you", taskId: null, payload: { mode: "autonomous" } });
  }

  async comeBack(wingId: string) {
    const rt = this.ready(wingId);
    if (this.store.wing(wingId)!.mode !== "autonomous") throw new UserError(`${rt.wing.name} is already with you.`, 409);
    this.store.setMode(wingId, "with_you");
    this.emit({ wingId, kind: "wing.mode_changed", actor: "you", taskId: null, payload: { mode: "with_you" } });
    const open = this.store.tasks(wingId, { state: "open" }).length;
    await this.say(rt, `The person has come back in. In a few lines, tell them what this wing did while it ran on its own, and what is still open (${open} task(s)). Then wait for them.`, false);
  }

  async dropIn(wingId: string, title: string, detail: string) {
    const rt = this.ready(wingId);
    const d = this.store.addDropIn(wingId, title, detail);
    this.emit({ wingId, kind: "agent.said", actor: "you", taskId: null, payload: { text: `Dropped in: ${title}` } });
    if (this.store.wing(wingId)!.mode === "with_you") {
      await this.say(rt, `The person dropped in a task: "${title}"${detail ? `\n\n${detail}` : ""}\n\nTalk it through with them.`, false);
      this.store.takeDropIns([d.id]);
    } else {
      // an autonomous lead triages drop-ins on its next wake; make that now rather than in 15m
      this.track(this.tick());
    }
    return { taskId: `drop-${d.id}` };
  }

  // ----- the snapshot the browser draws from -----------------------------------------------

  async state(): Promise<StateView> {
    const wings: WingView[] = [];
    for (const rt of this.rts.values()) {
      const row = this.store.wing(rt.wing.id)!;
      const tasks: TaskView[] = this.store
        .tasks(rt.wing.id, { state: "open" })
        .map((t) => {
          const i = rt.issues.get(t.id);
          return { id: t.id, key: t.identifier, title: t.title, status: i?.status ?? "todo", assigneeId: i?.assigneeAgentId ?? null };
        });
      const merged = this.store.tasks(rt.wing.id, { state: "merged" }).length;
      const brief = this.store.currentBrief(rt.wing.id);
      const draft = this.store.latestDraft(rt.wing.id);
      const s = rt.wing.settings;
      const q = s.quietHours;
      const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      wings.push({
        id: rt.wing.id,
        name: rt.wing.name,
        mode: row.mode,
        charter: rt.wing.charter,
        repo: rt.wing.repo?.path ?? null,
        integrationBranch: rt.wing.repo?.integrationBranch ?? null,
        held: row.heldUntil ? { until: row.heldUntil, reason: row.heldReason ?? "held" } : null,
        offline: rt.offline,
        agents: this.store.agents(rt.wing.id).map((a) => ({ id: a.id, role: a.role, name: a.name, desk: a.desk })),
        tasks,
        filedCount: merged,
        brief: brief ? { id: brief.id, version: brief.version, text: brief.text, status: brief.status } : null,
        draft: draft ? { id: draft.id, version: draft.version, text: draft.text, status: draft.status } : null,
        chat: this.store.chat(rt.wing.id).map((c) => ({ id: c.id, at: c.at, who: c.who, text: c.text })),
        settings: {
          wakeEvery: formatSec(Math.min(s.wakeEverySec * 2 ** row.backoffLevel, MAX_BACKOFF_SEC)),
          maxRunsPerHour: s.maxRunsPerHour,
          quietHours: q ? `${hhmm(q.startMin)}-${hhmm(q.endMin)}` : null,
          backOffWhenIdle: s.backOffWhenIdle,
          askBefore: s.askBefore,
        },
      });
    }
    const recent = this.store.recentEvents(400);
    return { wings, lastEventId: recent[recent.length - 1]?.id ?? 0, recent };
  }
}

// Annex's own stage is the first one, held by the board user. A later user stage is an
// escalation to a person, which Annex must not sign off.
function isAtBourne(i: Issue): boolean {
  const p = i.executionState?.currentParticipant;
  return i.status === "in_review" && p?.type === "user" && p.userId === BOARD_USER_ID && (i.executionState?.currentStageIndex ?? 0) === 0;
}

async function cleanWorktree(dir: string) {
  await git(dir, "reset", "--hard");
  await git(dir, "clean", "-fd");
}

function participantKey(i: Issue): string {
  const p = i.executionState?.currentParticipant;
  return p ? `${p.type}:${p.agentId ?? p.userId}` : "";
}

function fail(output: string): RunResult {
  return { exitCode: 1, output, timedOut: false, durationMs: 0 };
}

function lastLines(text: string, n: number): string {
  return text.trimEnd().split("\n").slice(-n).join("\n").replace(/```/g, "'''");
}

function formatSec(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h${Math.round((sec % 3600) / 60)}m`;
  return `${Math.round(sec / 60)}m`;
}

