# Annex design, draft 1

1 October 2026. Nothing here is built yet. Every decision records the alternative it beat and why,
so any of them can be reopened without re-deriving the reasoning.

## What Annex is

An office of agents you can watch. The building has wings. Each wing has a charter, a lead and a
crew. A lead is in one of two modes:

- **With you.** You plan with the lead in a chat. It creates tasks from what you agree and nothing
  else.
- **Autonomous.** The lead wakes on a timer, decides what the charter needs next, hands it to the
  crew, and only counts work that passed a check it did not run itself.

Several wings run at once, in different modes. "You're on your own after this" moves a wing from
the first mode to the second. "Come back in" moves it back.

## What only Annex does

Paperclip already runs autonomous agent companies. claude-office and Outworked already draw agents
in a pixel office. Nobody does the two modes with a handoff between them, and nobody draws an
office where every movement is a real event. That is the product. Everything else is borrowed.

## What the references taught us

Read from the code in `references/`, key claims checked by hand.

- **No reference verifies work.** Outworked counts a task as successful when no exception was
  thrown. agent-office defines `completeTask` (`MemoryStore.ts:172`) and never calls it, so tasks
  never close and its think loop runs forever.
- **Parallel agents collide.** Outworked's only protection is a sentence in the planning prompt
  (`orchestrator.ts:111`): "coordinate their work so they don't overwrite each other".
- **Fake motion is common.** Random idle wandering and a scripted 2-second "collaboration" walk in
  Outworked. In claude-office the backend and the browser each run their own agent state machine,
  which its own audit flags (ARC-004).
- **Paperclip has most of an engine.** A timer wake loop, `in_review` with a named reviewer that
  blocks Done, `blockedByIssueIds`, board-only approvals, budgets, a per-company WebSocket at
  `/api/companies/:id/events/ws` (`live-events-ws.ts:93`), and a Claude adapter that runs
  `claude --print --output-format stream-json` with `--resume` (`claude-local/.../execute.ts:849-851`).
- **Paperclip's chat is not our chat.** Board chat starts a fresh `claude -p` with
  `--dangerously-skip-permissions` (`board-chat.ts:239`), targets no agent and does not resume.
  Agent Chat (`enableAgentChat`, experimental, off by default, `doc/PRODUCT.md:191`) is close:
  one persistent conversation per person per agent, with substantial work handed to linked tasks.

## Decisions

### D1. Paperclip runs underneath, pinned and headless

Annex talks to Paperclip only through its REST API and WebSocket, and every call lives in one
module, `server/engine/`. Annex never imports Paperclip code and never forks it.

- **Why:** wake scheduling, review gates, blockers, approvals, budgets and crash recovery are
  weeks of work and Paperclip has them, built carefully.
- **Rejected, our own engine:** we would rebuild all of the above and debug it ourselves.
- **Rejected, a fork:** Paperclip ships weekly with schema migrations. A fork goes stale in a month.
- **Cost:** Node 24.11+ (this machine now has 26.10.0), a heavy install, and when a wake stalls the
  answer is inside a 30k-line `heartbeat.ts`. Pin one version and upgrade on purpose.
- **Guard:** build step 0 is a spike with pass criteria. If it fails, the fallback in the appendix
  applies and nothing else in this document changes except D1 and D4.

### D2. A wing is a Paperclip company

The lead is the company's top agent, the crew are the agents reporting to it. One Paperclip
instance runs several companies, which is exactly several wings.

### D3. Mode belongs to Annex, not to Paperclip

Paperclip has no idea of "with you". Annex stores the mode on the wing and drives Paperclip from it.

| | With you | Autonomous |
|---|---|---|
| Lead's timer wake | off | on, `intervalSec` from the wing file |
| What wakes the lead | your chat message | the timer, finished child tasks, your drop-ins |
| Who may create tasks | the lead, from what you agreed | the lead, under the wake routine (D5) |
| Where you see it | chat panel, lead at the planning table | lead walking tasks out to desks |

**Handoff.** You say you're done. The lead writes a handoff brief from the conversation: the goal,
what was decided, what is off limits, any limits from D5, and the conditions for calling you back. It goes
up as a Paperclip approval. You approve it, Annex turns the timer on. The brief is now part of what
the lead reads on every wake.

**Taking it back.** "Come back in" turns the timer off. Work already running finishes. The lead's
next wake is your message, and it opens with what it did while you were away.

**Raising a hand.** An autonomous lead that wants something outside the brief files an approval
and does not do it. On screen the lead walks to the door of the wing and waits there.

- **Rejected, one global mode:** you asked for both at once, in different wings.
- **Rejected, a mode switch with no brief:** the lead would act on a chat transcript it was never
  asked to summarise, and you would have nothing to check it against later.

### D4. The chat is Agent Chat if the spike says it works, otherwise a thin layer of our own

Spike step 0 tries Agent Chat through the API. If it holds up, Annex's chat panel is a client for
it. If not, Annex keeps the transcript itself, posts each message as a comment on the wing's
planning issue and wakes the lead with `POST /api/agents/:id/wakeup`, resuming its session.

- **Rejected, board chat:** no agent, no resume, and it skips permissions.

### D5. What "smart" means: the autonomous wake routine

This is the part every reference left out, so it is specified before anything else is built.

On each timer wake the lead:

1. **Reads** the charter, the handoff brief, open tasks, the last 20 closed tasks with their
   check results, and the wing's **signals**. A signal is a command whose output describes the
   charter's current state. For Upkeep: the test run, the build, `npm outdated`, and docs that
   name files or flags that no longer exist.
2. **Proposes at most 3 tasks.** Each must name the charter line it serves, the signal output that
   justifies it, a **done check** (a command that passes only when the task is done), and a size.
   A task with no runnable done check cannot be created in autonomous mode. That one rule stops
   most busywork.
3. **Removes duplicates** of open tasks and of tasks closed in the last 7 days.
4. **Keeps going.** A lead never stops on its own. It wakes again on its interval whether or not
   the last wake found anything. Every limit below is a setting in the wing file, and every one
   defaults to off:

   | Setting | Default | What it does when set |
   |---|---|---|
   | `wake_every` | `15m` | How long the lead waits between wakes. |
   | `max_runs_per_hour` | off | Caps how many agent runs the wing starts in an hour. |
   | `quiet_hours` | off | A window when the wing starts no new runs, for example `00:00-07:00`. |
   | `back_off_when_idle` | off | If the last 5 verified tasks changed no signal, double `wake_every`, up to 24 hours. |
   | `ask_before` | `[]` | Kinds of work the lead must ask you about first, such as adding a dependency. |

   One pause is not a setting: when Claude says your plan's usage limit is reached, no agent can
   run. Annex then holds every wing, shows the reset time, and resumes them all at that time
   without you doing anything.

You can drop a task into any wing at any time. It goes in the lead's inbox. A lead working with
you discusses it. An autonomous lead triages it on the next wake with the same rules, except that
your drop-ins skip the duplicate check.

### D6. Done means verified by something other than the worker

A crew agent finishes and the task moves to `in_review`. Two things must pass before it is Done:

1. **The done check, run by Annex.** Annex itself runs the command in the task's worktree. The
   agent's own claim that tests pass is not evidence.
2. **A review by a different agent.** Paperclip's named reviewer. A reject sends the task back to
   the worker with the reason.

A task that fails either check 3 times stops, and the lead decides whether to re-scope it or drop it.

### D7. Every task works in its own git worktree

The task's branch is cut from the wing's integration branch, `annex/<wing>`. Verified work merges
into it. Annex never pushes, never touches `main` of a target repo, and never merges the
integration branch for you. You review `annex/upkeep` and merge it yourself.

- **Rejected, one shared checkout:** the Outworked collision problem.
- **To check in the spike:** Paperclip has execution-workspace and worktree code. If it already
  isolates per task, Annex uses that instead of making its own worktrees.

### D8. The server owns state and the browser draws it

The Annex server subscribes to each company's Paperclip WebSocket, maps what it receives onto a
small Annex event vocabulary, stores it, and pushes **deltas** to the browser over server-sent
events. The browser keeps no state of its own beyond animation.

Every movement on screen has a source event:

| Event | On screen |
|---|---|
| lead wakes | lead stands up at its desk |
| task created and assigned | lead walks to the crew member's desk, a ticket appears on that desk |
| agent runs a tool | agent at its desk, speech bubble shows the tool and target |
| task moves to `in_review` | worker carries the ticket to the review desk |
| done check runs | the review desk light turns amber, then green or red |
| review rejects | the ticket goes back to the worker's desk |
| approval requested | lead walks to the wing door and waits there |
| usage limit reached, or a limit you set | lead's desk lamp turns off, reset time on the door |

Nothing else moves. An idle agent sits at its desk.

- **Rejected, full-state broadcast per event (claude-office):** it grows with history and loses
  the information about what changed.
- **Rejected, state machines on both sides:** two sources of truth for one agent.

### D9. The map is data

A wing's room is a JSON layout: desks, the lead's desk, the review desk, the planning table, the
door. The building puts wings side by side. Pathfinding is A* on the tile grid, lifted from
claude-office (MIT, `astar.ts`, `pathSmoothing.ts`). Desks are assigned from free desks, never
counted from the number of agents (claude-office `state_machine.py:795` hands out a desk that is
still taken once an agent leaves).

Art: a licensed tile pack with its licence recorded in the repo, or our own sprites. Not
claude-office's PNGs, which its own skills say were generated by an image model.

### D10. Adding work does not need code

A wing is a file, `wings/<name>/wing.toml`: charter, target repo, signals, default done check,
crew roles, the settings in D5, permissions. A new kind of work is a new wing file. A new
task for an existing wing is a drop-in from the UI.

- **Rejected, plugins with a registry:** there is one kind of wing today. The file format is the
  extension point until a second kind of wing proves it is not enough.

### D11. Stack

- **Server:** TypeScript on Node, one small HTTP server, SQLite (`better-sqlite3`) for what Annex
  owns: wing mode, handoff briefs, the event log, layouts.
- **Browser:** Vite, a canvas for the office (PixiJS, because claude-office's movement code is
  written for it), and plain TypeScript for the panels around it. No framework until the panels
  need one.
- **Rejected:** Next.js (nothing to render on a server), Electron (a localhost page first; wrap it
  later if you want an app).

### D12. Safety

- Paperclip in `local_trusted` mode, bound to loopback.
- No agent runs with `--dangerously-skip-permissions`. Each wing file lists the commands its crew
  may run. Upkeep gets `npm`, `npx vitest`, `npx tsc`, and `git` inside its worktree.
- Agents run through your own `claude` CLI login, so they use your Claude subscription, not a
  paid API key. Paperclip only falls back to API billing when `ANTHROPIC_API_KEY` is set
  (`claude-local/src/server/acp.ts:183-187`), and it is not set on this machine.
- Your plan's usage allowance is shared with your own Claude Code sessions. `max_runs_per_hour`
  and `quiet_hours` (D5) are there if you want to keep some of it for yourself. Both are off
  unless you set them.
- Nothing leaves the machine except calls to Claude.

## Annex's own data

| Table | Holds |
|---|---|
| `wing` | id, Paperclip company id, mode, interval, current backoff |
| `brief` | wing, version, text, approved at |
| `event` | id, wing, time, kind, actor, task, payload |
| `layout` | wing, JSON |

Tasks, agents, reviews, approvals and budgets stay in Paperclip. Annex does not copy them.

## The first two wings

- **Upkeep, autonomous**, on `~/Projects/reckon`, your local Claude Code spend tracker. On
  2 October 2026 its tree was clean, `npm test` passed 71 tests on Node 26, and `npm outdated`
  listed 9 packages, from small bumps (React 19.2 to 19.3) to large ones (Vite 6 to 8, Vitest 3 to
  5, TypeScript 5.9 to 7). That spread is what Upkeep needs: easy tasks to prove the loop, and
  hard ones where the done check has to catch a lead that got it wrong. Charter: keep `npm test`
  and `npm run typecheck` passing, keep dependencies current without breaking either, keep the
  docs true to the code.
- **Studio, with you.** Starts empty. Your first conversation with its lead is where you work out
  what it is for.

## Build order

One run, in the order a person would build it. No screen until the engine underneath works.

0. **Spike Paperclip.** Upgrade Node to 24.11+, run a pinned Paperclip, and through the API alone:
   create a company and two agents, assign an issue, watch a Claude run happen, receive the
   WebSocket events, take an issue through `in_review` to Done, try Agent Chat, find out whether it
   gives a task its own worktree. **Pass** means all of that works from a script. **Fail** means
   the appendix.
1. **Engine module, wing files and Annex's database.**
2. **Upkeep runs headless on reckon.** The wake routine (D5), the done check runner (D6) and
   worktrees (D7). Passes when the lead files real tasks from real signal output and one task ends
   Done on `annex/upkeep` with the check result attached.
3. **The event stream.** Paperclip events mapped onto Annex's vocabulary, stored, pushed to a
   text log in the browser.
4. **The office.** Layout, pathfinding and the movement table from D8, drawn from the stream.
5. **Studio and the handoff.** Chat, the handoff brief, approval, timer on, "come back in".
6. **Acceptance.** Both wings at once for an hour.

## Done means

1. Upkeep runs for an hour on its own and every task it creates names a charter line, a signal and
   a done check.
2. At least one Upkeep task is verified by Annex's check and a separate reviewer, and sits on
   `annex/upkeep`. Reckon's `main` is untouched.
3. A Studio conversation produces a brief. You approve it, the wing goes autonomous, and "come
   back in" returns it to you with a summary of what happened.
4. Every animation in a recorded session can be traced to a stored event.
5. A new wing is added by writing a wing file, with no code change.

## Settled with you

- Agents use your Claude subscription. No spending.
- Studio starts empty.
- Node upgraded, 2 October 2026. Homebrew installed 26.10.0, not 24.x. Paperclip asks for
  `>=24.11.0` in `package.json` but pins 24 in `.nvmrc`, so the spike checks it runs on 26 and
  falls back to `node@24` if it does not.

## Open questions for you

None.


## Appendix: fallback if the spike fails

Annex runs its own small engine instead: a wake queue in SQLite, the lead and crew run with
`claude --print --output-format stream-json --resume`, review and done checks done by Annex
directly. D2 becomes "a wing is a row in Annex's database", D4 becomes the thin chat layer, and
the rest of this document stands. This costs more than the Paperclip path, which is why it is the
fallback and not the plan.
