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

1. Start the engine (Paperclip, pinned in `runtime/`):
   ```sh
   cd runtime && npm install && npx paperclipai run --data-dir ../.paperclip
   ```
   The first run asks nothing; it binds to 127.0.0.1:3100.
2. In another terminal, start Annex and build the office page:
   ```sh
   npm install && npm run web:build && npm start
   ```
3. Open http://127.0.0.1:4300.

While working on the page, `npm run web:dev` serves it at :4301 with live reload.

## Using the office

- **Sidebar:** every wing and everyone in it. Click an agent (or the agent in a room) to open its
  terminal: every run, each tool call and what came back, the way Claude Code shows it, live while
  it works.
- **A wing's case file:** Hand off / Come back in, Pause / Resume, the log, the chat with the
  lead, the brief, and **Settings**, where every option is editable and applies at once.
- **Asks:** a lead that wants your yes first (anything under "Ask me before", or the brief's
  "Call me back when") raises its hand; approve or decline it in the case file.
- **+ New wing** opens a new room, which starts with you.

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
