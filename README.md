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
time), waits for it, builds the page if it is missing or out of date, and runs Annex.

**Open it with `npm run open`** the first time in a browser. Annex answers only a browser that
has its key (kept in `~/.config/annex/key`); the link gives the page the key once and the
browser keeps it. Without it the page says so.

**Keep it running:** `npm run service:install` makes Annex a login service (macOS LaunchAgent):
it starts at login and comes back by itself if it exits. `npm run service:status` and
`npm run service:remove`. Its log is `.annex/logs/service.log`; the database is copied once a day
to `.annex/backups` (seven kept). The top bar says when something is wrong (`/api/health`).

To stop a hand-started Annex, press Ctrl-C where `npm run up` runs. With the service installed,
use `npm run service:remove`. While working on the page, `npm run web:dev` serves it at :4301.

## Working without the terminal

- **New session** (top bar): Claude Code in any folder, on your own settings, the way `claude`
  starts in a terminal. The answer streams in; a tool that needs your yes shows as a card (Allow,
  Allow for the session, Deny with a reason); Stop ends a turn; the mode switches between asking,
  accepting edits and planning; `/` completes slash commands, plugin commands included. Any of
  your sessions under Your desk can be opened live once it has been quiet for a few minutes.
- **Run the app**: in a live session ("Run the app") or an office's Run tab: package.json scripts
  as buttons or any command, the output as it comes, the address it serves on, Stop.
- **Ready to merge**: every file an office changed, each file's diff, and **Merge**, which merges
  the exact commit you looked at, checks for conflicts first, and never touches a dirty checkout.
- **Projects** (top bar): clone a repository, switch or create branches, **Publish** (push and
  open a pull request; the commands are shown first, never a force-push), edit CLAUDE.md, the
  project's and your own Claude settings and `.mcp.json` (validated, backed up, refused if the
  file changed meanwhile), add or remove MCP servers, and turn plugins on for yourself.
- **Usage and alerts**: the top bar shows your plan's five-hour and weekly use as Claude last
  reported it; each office shows its runs and minutes in the last five hours; **Turn on alerts**
  for desktop notifications when something needs you while the tab is in the background.

The design, the senior reviews and what each changed are in `docs/terminal-free.md`.

## Playing it

- **The HUD** shows offices, crew, who is working, how much is verified, and whether Annex is
  OPEN or CLOSED (for example "CLOSED UNTIL 15:40" when your Claude usage limit is reached; it
  reopens by itself).
- **PARTY** lists every office and everyone in it. Click a member, or the person in a room, to
  open their terminal: each run in Claude Code's own grammar, the exact prompt Paperclip sent,
  the agent's standing orders, and the full system prompt.
- **Each office's plaque** counts down to its lead's next wake, or says why it will not wake.
- **An office's file**: Hand off / Come back in, + Hire, Pause / Resume, and tabs for the Log,
  Talk with the lead, the Brief, Ready to merge (verified commits waiting for you to merge, with
  the command) and Settings (every option, applied at once).
- **Asks**: when a lead wants your yes first (anything under "Ask me before", or the brief's
  "Call me back when"), the office shows it to Accept or Decline.
- **Director**: one conversation above every office. It sees a line per office, answers how
  things are going, and routes what you ask for: drops work into an office, opens an office,
  hires, pauses, resumes, or brings an office back to you. Each lead still plans its own work.
- **SYSTEM LOG**: everything Annex decided and why, also in `.annex/logs/annex.log`.

## Rules and plugins

- **House rules** live in the repo's `CLAUDE.md` (and `AGENTS.md`). Every wake hands them to the
  lead, every task must quote the ones it touches, and the reviewer checks the diff against them.
- **What an office is for** is its `charter`; each task cites a line of it.
- **Ask me before** (Settings tab, or `ask_before` in the wing file) makes the lead wait for your yes.
- **Plugins**: `plugins = ["smith@the-tavern"]` in a wing file (or the Plugins field in Settings)
  turns those Claude Code plugins on for that office's lead and crew only. Install them in Claude
  Code first. Annex enables them in the office's own agent settings, allows their MCP tools and
  subagents, and tells the lead and crew which commands they bring. Nobody answers a plugin's
  questions mid-run, so plugins that interview you (Forge's planning) fit an office you work
  with rather than one on its own. Reviewers never get plugins.

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

# [sandbox]                              # on by default; see below
# allowed_domains = ["api.example.com"]  # hosts beyond npm, PyPI, GitHub and Claude's own
# allow_write = ["~/.cargo"]             # folders beyond the worktree, git and package caches
# enabled = false                        # gives up the protection below
```

## What Annex will and will not do

- It never touches your own checkout or your base branch, and it never pushes. Verified work
  lands on the integration branch; you review and merge it yourself.
- Agents run your `claude` with your subscription, without `--dangerously-skip-permissions`,
  and without your global `~/.claude/CLAUDE.md`, hooks, plugins or auto-memory.
- Every agent's shell runs inside Claude Code's sandbox (the operating system's, Seatbelt on
  macOS), including anything `node` or `npm` starts. It cannot read Annex's key or live-session
  folders, cannot write outside its worktree, the repo's git folder and package caches, and can
  only reach package registries, GitHub, Claude and localhost (so tests that start a server work).
- When Claude reports your plan's usage limit, every wing holds and starts again by itself at
  the reset time.

The design and every decision behind it are in `docs/design.md`; what the Paperclip spike found
is in `docs/spike-findings.md`.
