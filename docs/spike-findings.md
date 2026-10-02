# Paperclip spike findings (build step 0)

Run on 2 October 2026 against `paperclipai@2026.1001.0` (commit `8f8a0ab`), `local_trusted`,
http://127.0.0.1:3100, Claude Code CLI 2.1.280, model `claude-haiku-4-5-20251001`.
Script: `spike/spike.mjs` (`node spike/spike.mjs --fresh`, about 2 minutes end to end). State, ids
and per-step evidence: `spike/state.json`. WebSocket frames: `spike/events.jsonl`. Claude argv per
run: `spike/argv-*.json`. Console output: `spike/run.out`.

Spike company: `annex-spike-1790958581269`, id `4a5865e1-4b72-4859-9260-7b738143be39`, prefix
`BOUA`. An earlier attempt left company `98eb753a…` (prefix `BOU`), which passed the same flow; its
state is in `spike/state.first-attempt.json`.

**Verdict: PASS. D1 stands, and D4 can use Agent Chat.** But read the safety section: agents
inherit your whole `~/.claude`, and that has to be fixed before step 2.

## Results

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Throwaway repo | PASS | `.annex/spike-repo`, `main` at `6992117`, README + package.json with the `hello.txt` test |
| 2 | Company, project+workspace, two `claude_local` agents, engine=cli, lead timer off | PASS | lead `3a7ce964…` (ceo), worker `ba9e80d0…` (engineer, reportsTo lead); `GET /api/agents/:id` shows `adapterConfig.engine:"cli"`, `runtimeConfig.heartbeat:{enabled:false,intervalSec:0,maxConcurrentRuns:20}` |
| 3 | Company WebSocket logged | PASS | 300+ frames in `spike/events.jsonl`, 15 distinct types (below) |
| 4 | Issue assigned to the worker, run completes, work lands | PASS | worker run `4bf8dfc1…` started from the assignment wake. Commit `2e46866 add hello.txt` is on branch `annex/spike/BOUA-1` in worktree `.annex/spike-worktrees/annex/spike/BOUA-1`. The original checkout is untouched (`hello.txt` absent, HEAD still `6992117`). The run ended `cancelled` / `issue_reassigned` (gotcha 1) |
| 5 | in_review with the lead as named reviewer, review accepted, done | PASS | the worker's `PATCH status` put BOUA-1 into `in_review` with the lead assigned and `executionState.currentStageType:"review"`. Lead run `d67933b1…` woke on its own (`contextSource:"issue.execution_stage"`), checked the work and approved it with a comment. Result: `status:"done"`, `executionState.status:"completed"`, `lastDecisionOutcome:"approved"`. No manual wake was needed |
| 6a | Timer heartbeat on, timer wake queued, off again | PASS | PATCH set `heartbeat:{enabled:true,intervalSec:20}`. Timer run `29154b6f…` (`invocationSource:"timer"`) was queued within 5 s, and the timer was set back to `{enabled:false,intervalSec:0}`. I cancelled that run by hand (see the safety section) |
| 6b | Agent Chat over the API, with a reply in a resumed session | PASS | `enableAgentChat` was set through the experimental settings PATCH. Chat issue BOUA-2. Message 1 ("remember PELICAN") went to run `e9f9f43d…`, which made session `159369fd…`. Message 2 went to run `7f28b235…`, launched with `--resume 159369fd…`, and the reply was `"PELICAN"` |
| 7 | CLI flags recorded | PASS | the lead ran with `--dangerously-skip-permissions` (the default). The worker ran with `dangerouslySkipPermissions:false` and no skip flag, and still did the task. `--resume` showed up on the second chat wake (details below) |
| + | Approval create/approve | PASS | approval `dae830ac…` went from `pending` to `approved`. Approving it queued a wake for the requester (`approval.requester_wakeup_queued`) |

## API cheat sheet (bodies that worked)

All calls are board calls with no auth header (`local_trusted`). Every response is JSON.

**Instance flags** (these are global, not per company): `PATCH /api/instance/settings/experimental`
`{"enableIsolatedWorkspaces":true}` and `{"enableAgentChat":true}`. Both are now **on** on this instance.

**Create company:** `POST /api/companies` `{"name":"annex-spike-…","description":"…"}` returns `id` and `issuePrefix`.

**Create project + workspace + per-task worktrees:** `POST /api/companies/:cid/projects`
```json
{"name":"spike-repo","status":"in_progress",
 "workspace":{"name":"spike-repo","sourceType":"local_path","cwd":"/abs/repo","isPrimary":true},
 "executionWorkspacePolicy":{"enabled":true,"defaultMode":"isolated_workspace","allowIssueOverride":true,
   "workspaceStrategy":{"type":"git_worktree","baseRef":"main",
     "branchTemplate":"annex/spike/{{issue.identifier}}","worktreeParentDir":"/abs/worktrees"}}}
```
This returns the project `id`. Get the workspace id from `GET /api/projects/:id/workspaces` (`[0].id`).
The policy is ignored unless `enableIsolatedWorkspaces` is on.

**Create agent (Claude adapter, CLI engine, timer off):** `POST /api/companies/:cid/agents`
```json
{"name":"Lead","role":"ceo","title":"Wing lead","adapterType":"claude_local",
 "adapterConfig":{"engine":"cli","model":"claude-haiku-4-5-20251001","timeoutSec":900,"maxTurnsPerRun":40},
 "runtimeConfig":{"heartbeat":{"enabled":false,"intervalSec":0}}}
```
For a worker, add `"reportsTo":"<leadId>"`. To run without skip-permissions, add
`"dangerouslySkipPermissions":false,"extraArgs":["--permission-mode","acceptEdits","--allowedTools","Bash,Read,Write,Edit,Glob,Grep"]`.
Response fields: `id`, `status` (`idle` / `running`), `adapterConfig`, `runtimeConfig.heartbeat`.

**Update heartbeat:** `PATCH /api/agents/:id` `{"runtimeConfig":{"heartbeat":{"enabled":true,"intervalSec":20}}}`.
This merges with the existing runtimeConfig. `GET /api/instance/scheduler-heartbeats` then shows
`heartbeatEnabled:true, schedulerActive:true`. Other keys: `skipTimerWhenNoActionableWork`,
`maxDailyRuns`, `maxDailyCostCents`, `maxConcurrentRuns`.

**Create issue assigned to an agent, with the lead as reviewer:** `POST /api/companies/:cid/issues`
```json
{"title":"Create hello.txt…","description":"…","status":"todo","priority":"medium",
 "projectId":"<pid>","assigneeAgentId":"<workerId>",
 "executionPolicy":{"mode":"normal","commentRequired":true,
   "stages":[{"type":"review","participants":[{"type":"agent","agentId":"<leadId>"}]}]}}
```
Returns `id` and `identifier` (`BOUA-1`). Assigning wakes the worker straight away
(`invocationSource:"assignment"`). Statuses: `backlog todo in_progress in_review done blocked cancelled`.

**Move to in_review with the reviewer.** No separate call. When the assignee PATCHes `status`
to `done` or `in_review` (a comment is required), the policy rewrites it to `in_review`, assigns the
stage participant, and wakes them. The board can also do it: `PATCH /api/issues/:id`
`{"status":"in_review","comment":"…"}`. State to read: `executionState.{status: idle|pending|changes_requested|completed, currentStageType, currentParticipant, returnAssignee, lastDecisionOutcome: approved|changes_requested, changesRequestedCount}`.

**Accept review.** Only the current participant can do this. They send `PATCH /api/issues/:id`
`{"status":"done","comment":"Approved — …"}`. To reject, any other status plus a comment sends it
back to `returnAssignee`. After 3 rejections (`maxReviewRounds`) it escalates to the responsible
user. The board override is `POST /api/issues/:id/stalled-review-decision`
`{"action":"approve"|"request_changes"|"send_back","note":"…"}` (not exercised).

**Wake agent:** `POST /api/agents/:id/wakeup`
`{"source":"on_demand","triggerDetail":"manual","reason":"…","payload":{"issueId":"…"},"forceFreshSession":false}`.
The server accepted this body. The one call I made returned `{"status":"skipped","reason":"issue_execution_deferred",…}`
because another agent already held the issue, so I have not seen this endpoint start a run. Every
run in the spike came from assignment, the execution stage, chat, or the timer.

**Comment on issue:** `POST /api/issues/:id/comments` `{"body":"…"}` returns `id` and `authorType`.
Commenting on a `done` issue **reopens it** (gotcha 4).

**Agent Chat:** `POST /api/companies/:cid/chats/:agentIdOrUrlKey` (no body) returns the chat issue
(`status:"in_review"`, `conversationState:"waiting"`). To send a message:
`POST /api/issues/:chatIssueId/comments` `{"body":"…","clientRequestId":"<uuid>"}`. The
`clientRequestId` is required. Replies arrive as comments with `authorAgentId = lead`, from
`GET /api/issues/:id/comments`. List chats with `GET /api/companies/:cid/chats`.

**Approvals:** `POST /api/companies/:cid/approvals`
`{"type":"request_board_approval","requestedByAgentId":"<leadId>","payload":{"title":"Handoff brief v1","brief":"…"},"issueIds":["…"]}`
returns `status:"pending"`. `POST /api/approvals/:id/approve` `{"decisionNote":"…"}` returns
`status:"approved"`. Types: `hire_agent approve_ceo_strategy budget_override_required request_board_approval`.

**Runs:** `GET /api/companies/:cid/heartbeat-runs` (field `id`) and `GET /api/issues/:id/runs`
(field **`runId`**). Both carry `status` (`queued running succeeded failed cancelled timed_out`),
`invocationSource` (`assignment timer on_demand automation`), `errorCode`, `sessionIdBefore/After`.
`GET /api/heartbeat-runs/:id/events` holds the `adapter.invoke` event with `command`,
`commandArgs`, `cwd` and `env`. `GET /api/heartbeat-runs/:id/log` is NDJSON of Claude
stream-json chunks. `POST /api/heartbeat-runs/:id/cancel` `{}`.

**Execution workspaces:** `GET /api/companies/:cid/execution-workspaces` returns
`{id, sourceIssueId, mode:"isolated_workspace", strategyType:"git_worktree", cwd, branchName, baseRef, status, deliveryState:"unmerged"}`.

## WebSocket

Connect to `ws://127.0.0.1:3100/api/companies/:cid/events/ws`. No token is needed in `local_trusted`
(you are the board). Node's global `WebSocket` works. Every frame has the shape
`{id, companyId, type, createdAt, payload}`. Samples are trimmed.

| Annex meaning | Frame |
|---|---|
| run queued | `heartbeat.run.queued` `{runId, agentId, invocationSource:"assignment", triggerDetail, wakeupRequestId}` |
| run started | `heartbeat.run.status` `{runId, agentId, status:"running", startedAt}` (and `agent.status` `{agentId, status:"running"}`) |
| run finished | `heartbeat.run.status` `{runId, issueId, status:"succeeded"\|"cancelled"…, errorCode, contextSource:"issue.execution_stage", finishedAt, finalText}` |
| tool use / progress | `heartbeat.run.log` `{runId, issueId, seq, stream:"stdout", chunk:"<claude stream-json line(s)>"}`. Tool calls appear only here, as `assistant` messages with `tool_use` blocks. `heartbeat.run.progress` `{phase:"run_activity", message:"Receiving agent output", currentToolName:null}` and `heartbeat.run.event` (`lifecycle`, `adapter.invoke`, `run.presentation.resolved`) never filled `currentToolName` in this engine |
| issue status change | `activity.logged` with `action:"issue.updated"`, `details.status`, `details.assigneeAgentId`, `details.executionState`, `details.changes.status.{from,to}` |
| issue created | `activity.logged` with `action:"issue.created"`, `details.{identifier,title,status}` |
| comment added | `activity.logged` with `action:"issue.comment_added"`, `details.{commentId, bodySnippet, identifier}` |
| approval requested | `activity.logged` with `action:"approval.created"`, `details.{type, issueIds}`. Later `approval.approved` and `approval.requester_wakeup_queued` (`details.wakeRunId`) |
| other seen | `environment.lease_acquired/released` (carries `executionWorkspaceId`), `agent.updated`, `issue.conversation_opened`, `instance.settings.experimental_updated`, `company.updated` |

Sample `issue.updated`: `{"type":"activity.logged","payload":{"actorType":"agent","actorId":"ba9e…","action":"issue.updated","entityId":"073e…","runId":"4bf8…","details":{"status":"in_review","assigneeAgentId":"3a7c…","executionState":{"status":"pending","currentStageType":"review",…}}}}`

## Answers

**Worktree / isolation (D7).** Paperclip already does this, so Annex should not build its own.
Three things are needed: `enableIsolatedWorkspaces` on, a project workspace pointing at the repo, and
a project `executionWorkspacePolicy` of `isolated_workspace` + `git_worktree`. With those, each issue
gets a worktree under `worktreeParentDir` on a branch from `branchTemplate`, cut from `baseRef`. The
worker and the reviewing lead both ran with `cwd` set to that worktree, and the original checkout
stayed clean. The branch is left `deliveryState:"unmerged"` and Paperclip does not merge it. Setting
`baseRef` to `annex/<wing>` should give D7's integration branch. Merging verified work into it is
Annex's job (not tested).

**Permissions flag (D12).** By default every `claude_local` run gets
`--dangerously-skip-permissions` (`dangerouslySkipPermissions` defaults to true). Setting
`adapterConfig.dangerouslySkipPermissions:false` removes the flag
(`packages/adapters/claude-local/src/server/permissions.ts`), and `extraArgs` are appended to the
argv. The worker ran with `--permission-mode acceptEdits --allowedTools Bash,Read,Write,Edit,Glob,Grep`,
wrote the file, committed, ran `npm test` and PATCHed the issue through curl. Plain `Bash` is broad.
D12's narrower list (`Bash(npm:*)`, `Bash(git:*)`, plus `Bash(curl:*)` for the Paperclip API) was
not tested. MCP tools left off the list will be denied.

**Agent Chat (D4).** It works over the API in `local_trusted` (board user `local-board`). Each
agent/user pair gets one chat issue. Messages are comments, and replies are agent comments on the
same issue, so they also arrive on the WebSocket as `issue.comment_added`. The second message
resumed the same Claude session. Annex's chat panel can be a client for this.

**Resume.** Sessions are stored per agent per task key (`GET /api/agents/:id/task-sessions`), and
`--resume <sessionId>` is passed when that task's session is reused. This happened on the second chat
wake: run `7f28b235…`, `sessionIdBefore = sessionIdAfter = 159369fd…`. It is not guaranteed. A
later lead wake on BOUA-1 (`issue_reopened_via_comment`, run `e6659735…`) started a **fresh**
session `c623…` rather than resuming the review session `494e…`. I did not find out why. The
worker's session was never saved because its run was cancelled at handoff (`sessionIdAfter:null`).

## Safety finding: agents inherit your whole Claude setup

Runs launch your real `claude` with `HOME=/Users/you`. Every agent therefore loads your global
`~/.claude/CLAUDE.md`, your hooks, plugins and skills, and your auto-memory. The evidence:
- The chat reply opened with "- **TLDR:**", which comes from your CLAUDE.md.
- Run logs show your `SessionStart` hooks firing.
- The worker called `ToolSearch` and `Skill`.

The timer-woken lead had no task. With skip-permissions on, it read
`~/.claude/projects/-Users-you-Projects-annex/memory/*`, ran `git status` in
`~/Projects/annex`, and read `docs/design.md` and `spike/spike.mjs`. Its tool calls were 11 Bash
and 9 Read, all read-only. I cancelled it after about 2 minutes.

Also, the `claude` binary it ran is a cmux shim taken from the server's PATH
(`/var/folders/…/cmux-cli-shims/…/claude`).

Before step 2:
- Give each agent its own Claude config through `adapterConfig.env` (for example
  `CLAUDE_CONFIG_DIR`), and check that the subscription login still works.
- Set `command` to an absolute `claude` path.
- Set `skipTimerWhenNoActionableWork` or give the lead a real wake prompt.
- `filesystemScope:"workspace"` confinement needs Bubblewrap and is Linux only, so it is not an
  option on this Mac.

## Gotchas

1. **The handoff cancels the worker's own run.** When the worker PATCHes to `done`/`in_review`, the
   reassignment to the reviewer cancels the worker's still-running run (`errorCode:"issue_reassigned"`).
   Treat that as success, not failure. The run's session is lost.
2. **`/api/issues/:id/runs` uses `runId`, while `/api/companies/:cid/heartbeat-runs` uses `id`.**
3. **A timer wake fires right away when `lastHeartbeatAt` is null**, because the baseline is the
   agent's `createdAt`. The scheduler ticks every 30 s (`HEARTBEAT_SCHEDULER_INTERVAL_MS`).
4. **A comment on a `done` issue reopens it.** A board comment on BOUA-1 woke the lead
   (`wakeReason:"issue_reopened_via_comment"`) and left the issue `in_progress`. BOUA-1 is still in
   that state as evidence. Annex must not comment on closed issues casually.
5. **Approving an approval wakes the requester.** If the linked issue is already done, that wake is
   cancelled with `issue_terminal_status`.
6. **One agent runs several things at once.** The timer run and the chat run on the lead overlapped
   (`maxConcurrentRuns` defaults to 20). D5's "one wake routine" needs `maxConcurrentRuns:1` on leads.
7. **The experimental flags are instance-wide and stay on** after the spike (`enableIsolatedWorkspaces`,
   `enableAgentChat`). The original values are in `spike/state.json` as `experimentalBefore`.
8. **Approving a review requires a comment.** According to the source
   (`issue-execution-policy.ts`), a status PATCH without a comment returns 422. Not exercised.
9. **Slashes in `branchTemplate` nest the worktree directories** (`…/annex/spike/BOUA-1`).
10. **`.paperclip/schema.js` broke** once the repo root `package.json` gained `"type":"module"`.
    Run it as a `.cjs` copy.
