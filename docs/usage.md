# Using Annex

A tour of every screen, and the full `wing.toml` reference. To install Annex, start with
[getting-started.md](getting-started.md); for how the code fits together, see
[architecture.md](architecture.md).

## Your own sessions and projects

- **New session** (top bar): Claude Code in any folder, on your own settings, the way `claude`
  starts in a terminal. The answer streams in; a tool that needs your yes shows as a card (Allow,
  Allow for the session, Deny with a reason); Stop ends a turn; the mode switches between asking,
  accepting edits and planning; `/` completes slash commands, plugin commands included. Any of
  your sessions under Your desk can be opened live once it has been quiet for a few minutes.
- **Run the app**: in a live session ("Run the app") or an office's Run tab: package.json scripts
  as buttons or any command, the output as it comes, the address it serves on, Stop.
- **Ready to merge**: every file an office changed, each file's diff, and **Merge**, which merges
  the exact commit you looked at, checks for conflicts first, and never touches a dirty checkout.
- **Projects** (top bar): any folder can be a project. **Add a folder…**, **New project…** (a
  new git repo wherever you choose) and **Clone…** (into `~/Projects` or a folder you choose); in
  Annex.app folders are chosen in the Mac's own folder panel. Git repos directly in `~/Projects`, your offices'
  repos and folders your recent sessions ran in are listed too; **Forget** takes one off the list
  and never touches its files. Then: switch or create branches, **Publish** (push and
  open a pull request; the commands are shown first, never a force-push), edit CLAUDE.md, the
  project's and your own Claude settings and `.mcp.json` (validated, backed up, refused if the
  file changed meanwhile), add or remove MCP servers, and turn plugins on for yourself.
- **Files** (in Projects, or click a file path in a session, or **Open in your checkout** on a
  file in Ready to merge): the project's files as a tree, with Find, and an editor (CodeMirror,
  highlighting for TypeScript, JavaScript, JSON, Markdown, CSS, HTML, Python and Go, in both
  themes). Cmd/Ctrl+S saves. The list is git's (tracked and untracked, not ignored). A save keeps
  the file's line endings and BOM, backs up the old version (the newest 20 per file) and is
  refused if the file changed on disk since you opened it, with Reload or Overwrite to choose
  from. Binary, non-UTF-8 and files over 1 MB are not opened; paths never leave the project, and
  `.git` and Annex's key folder are never opened.
- **Terminal** (top bar, "Open a terminal here" in Projects): a real terminal in the page, your
  login shell in a folder, with colours, full-screen programs and resizing. Several can be open;
  each is listed under Your desk, keeps its recent output for when you come back, and ends when
  you close it or Annex stops. Commands that only work in Claude Code's own screen (`/config`,
  `/login`, `/status`, `/resume` and the like) show "opens in a terminal" in a live session's `/`
  menu; choosing one, or **Open in terminal**, closes the live session and continues the same
  conversation in `claude --resume` there. Terminals use `node-pty`: `npm install` warns that its
  install script is not approved, which is fine; Annex needs only its prebuilt binary.
- **Usage and alerts**: the top bar shows your plan's five-hour and weekly use as Claude last
  reported it; each office shows its runs and minutes in the last five hours; **Turn on alerts**
  for desktop notifications when something needs you while the tab is in the background.

## The offices on screen

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
- **Plugins**: `plugins = ["lint-kit@acme"]` in a wing file (or the Plugins field in Settings)
  turns those Claude Code plugins on for that office's lead and crew only. Install them in Claude
  Code first. Annex enables them in the office's own agent settings, allows their MCP tools and
  subagents, and tells the lead and crew which commands they bring. Nobody answers a plugin's
  questions mid-run, so plugins that interview you fit an office you work
  with rather than one on its own. Reviewers never get plugins.


## The wing file


A wing is one file, `wings/<id>/wing.toml` in your Annex data folder (`examples/wings/upkeep` in the repo is one to copy). **+ New wing** and the Settings tab write it for you,
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
path = "~/Projects/shop"
base_branch = "main"
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

