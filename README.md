# Annex

An office of Claude agents you can watch. The building has wings; each wing has a lead, a crew
and a reviewer. A wing is either **with you**, where you plan with its lead in a chat, or **on its
own**, where the lead wakes on a timer, reads the wing's signals, and proposes work that Annex
checks before anyone starts it. "Hand off" moves a wing from the first mode to the second;
"Come back in" moves it back. Several wings run at once, in different modes.

A task counts as done only when Annex's own run of its done check passes in the task's worktree,
a separate reviewer approves the diff, and the merge into the wing's integration branch passes
the check again. On screen, that is when the red VERIFIED stamp lands.

## Run it

You need Node 24.11 or newer and Claude Code logged in with your subscription.

```sh
npm install
npm run up
```

`npm run up` starts the pinned Paperclip engine if it is not running (installing it the first
time), waits for it, builds the page if needed, and runs Annex. Open http://127.0.0.1:4300.
While working on the page, `npm run web:dev` serves it at :4301 with live reload.

To stop, press Ctrl-C where `npm run up` is running. It stops what it started; a Paperclip that
was already running is left alone. If Annex was started in the background:
`pkill -f annex/server/main.ts`.

## Playing it

- **The HUD** shows offices, crew, who is working, how much is verified, and whether Annex is
  OPEN or CLOSED (for example "CLOSED UNTIL 15:40" when your Claude usage limit is reached; it
  reopens by itself).
- **PARTY** lists every office and everyone in it. Click a member, or the person in a room, to
  open their terminal: each run in Claude Code's own grammar, the exact prompt Paperclip sent,
  the agent's standing orders, and the full system prompt.
- **Each office's plaque** counts down to its lead's next wake, or says why it will not wake.
- **An office's file**: HAND OFF / COME BACK IN, + HIRE, PAUSE / RESUME, and tabs for the LOG,
  TALK with the lead, the BRIEF, LOOT (verified commits waiting for you to merge, with the
  command) and SETTINGS (every option, applied at once).
- **Asks**: when a lead wants your yes first (anything under "Ask me before", or the brief's
  "Call me back when"), the office shows a quest to ACCEPT or DECLINE.
- **DIRECTOR**: one conversation above every office. It sees a line per office, answers how
  things are going, and routes what you ask for: drops work into an office, opens an office,
  hires, pauses, resumes, or brings an office back to you. Each lead still plans its own work.
- **SYSTEM LOG**: everything Annex decided and why, also in `.annex/logs/annex.log`.

## How the work is kept honest

- A lead never plans blind: every wake carries the repo's signals and its CLAUDE.md / AGENTS.md,
  and every proposed task must name the rules it touches, quote real signal output, and carry a
  done check. Annex throws out anything that does not.
- A task is done only when Annex runs its done check in the task's own worktree and it passes,
  a separate reviewer approves the diff (house rules included), and the merge into the office's
  integration branch passes the check again.
- Leads can hire up to an office's "Most workers"; new hires walk in through the door.

## Add work

A wing is one file, `wings/<id>/wing.toml`. **+ New wing** and the Settings tab write it for you,
and edits made by hand are picked up without a restart. To hand an existing wing a task, use
**Drop in a task** in its Log tab.

```toml
name = "Upkeep"
mode = "autonomous"              # or "with_you" (the default)
charter = """
1. `npm test` and `npm run typecheck` pass on the integration branch.
"""
done_check = "npm test && npm run typecheck"
setup = "npm ci --no-audit --no-fund"   # run in a fresh worktree before checks

[repo]
path = "~/Projects/reckon"
base_branch = "master"
integration_branch = "annex/upkeep"     # default: annex/<id>

[[signals]]                              # commands whose output the lead reads on each wake
name = "outdated"
run = "npm outdated --long"

[crew]
workers = 2                              # 1 to 8
# lead_model, worker_model, reviewer_model default to claude-sonnet-5

[settings]                               # every limit is off unless you set it
wake_every = "15m"
# max_runs_per_hour = 6
# quiet_hours = "00:00-07:00"
# back_off_when_idle = true
# ask_before = ["adding a new dependency"]

[permissions]
allow = ["npm", "npx", "node", "git"]    # shell commands the crew may run
```

## What Annex will and will not do

- It never touches your own checkout or your base branch, and it never pushes. Verified work
  lands on the integration branch; you review and merge it yourself.
- Agents run your `claude` with your subscription, without `--dangerously-skip-permissions`,
  and without your global `~/.claude/CLAUDE.md`, hooks, plugins or auto-memory.
- When Claude reports your plan's usage limit, every wing holds and starts again by itself at
  the reset time.

The design and every decision behind it are in `docs/design.md`; what the Paperclip spike found
is in `docs/spike-findings.md`.
