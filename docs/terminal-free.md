# Using Annex instead of the terminal

What it takes for someone to build apps with Claude and run agent workflows from Annex alone:
start projects, work in live sessions, read and merge changes, run the app, launch plugins and
workflows, configure Claude, watch usage, and leave it running. Eight gaps, each with what exists,
the design, what "done" means, and the risks. Written 5 October 2026.

## What was proven before planning (spike, 5 October)

All against the logged-in `claude` CLI (2.x), no API key:

| Question | Result |
|---|---|
| Multi-turn session driven from a program | `claude -p --input-format stream-json --output-format stream-json --verbose` takes one JSON user message per line and keeps one session across turns. `apiKeySource: none`, so it runs on the subscription. |
| Answers as they are written | `--include-partial-messages` emits `stream_event` deltas. |
| Permission prompts | `--permission-prompt-tool mcp__bourne__approve` with a small stdio MCP server: Claude asked before `Write`, the server said deny, Claude stopped and said so. |
| Stop | `{"type":"control_request","request":{"subtype":"interrupt"}}` on stdin is acknowledged and ends the turn. |
| Slash commands | `/smith:help` (plugin) and `/context` (built in) both run. `init.slash_commands` lists all 365 available. |
| Plan mode | `--permission-mode plan` starts in it; `set_permission_mode` control request switches live. |
| Usage | Every session emits `rate_limit_event` with five-hour and seven-day utilization and reset times. |

## Principles that do not change

- Agents never push, never touch the person's checkout, never get the person's global settings.
  Everything below that pushes, merges into a real branch, or edits global config is the
  **person** pressing a button, with a confirmation that shows exactly what will happen.
- A live session is the person's own session: it runs with their own Claude settings, like the
  terminal does. It is not an agent.
- Nothing destructive happens to a dirty working tree; Annex refuses and says why.

---

## 1. Live sessions

**Today.** Your desk watches sessions and can send a one-shot reply to an idle one.

**Design.**
- `server/live.ts` keeps live sessions in memory: one `claude` child per session, started with
  stream-json in and out, partial messages, the person's own settings, a permission mode, and
  `--mcp-config` pointing at `server/agent-tools/approve-mcp.mjs` as the permission prompt tool.
- New session: a folder (any folder; recent projects and offices' repos offered) and a mode.
  Resume: any of your sessions, with the same "may be open in a terminal" guard as replies.
- The approve MCP server forwards each prompt to Annex (`POST /api/live/:id/permission`, held
  open until the person answers) and returns allow or deny. The browser shows the prompt as a
  card: tool, the input (a command, a file and its diff), Allow, Allow for the rest of this
  session, Deny with an optional reason.
- Output is parsed into the terminal view's entries (the same `toEntries`), plus the partial
  text of the answer being written. The browser follows a per-session event stream.
- Controls: send (Enter with ⌘), Stop (interrupt), mode switch (default, accept edits, plan,
  bypass), close. Slash commands complete from the session's own list.
- A live session closes when Annex stops; the conversation is in Claude Code's own log, so it
  resumes like any other.

**Done when.** From the browser alone: start a session in a folder, ask for a change, approve a
file write from a card, watch the answer stream, stop a long answer, switch to plan mode, run a
slash command, close it, and resume it later with the history intact.

**Risks.** A permission prompt left unanswered holds Claude; it waits (no timeout), and the card
stays visible. Two live views of one session are allowed but only one child process exists.

## 2. Seeing the code

**Today.** A list of waiting commits and a merge command to copy.

**Design.**
- `GET /api/wings/:id/changes` gives the files changed between the base branch and the
  integration branch (status, lines added and removed), and `?file=` gives one file's patch;
  `GET /api/wings/:id/tasks/:taskId/changes` does the same for one task's branch.
- The Ready to merge tab lists commits, then the changed files; choosing a file shows its diff.
- **Merge** opens a confirmation that names the branch, the target and the commit count. Annex
  merges in the person's own checkout only when the target branch is checked out there and the
  tree is clean (otherwise it says what to do). A conflict aborts the merge, names the files, and
  offers to hand it to the lead ("bring master into annex/upkeep and resolve").

**Done when.** A person can read every change an office made, file by file, and merge it, or
learn why it cannot be merged yet, without a terminal.

**Risks.** Merging touches the person's checkout: hence the clean-tree and checked-out-branch
rules and the confirmation.

## 3. Running the app

**Design.**
- `server/runner.ts` runs named commands for a folder: the `package.json` scripts it finds
  (dev, start, test, build, and the rest), or any command typed in. Start, stop, restart; the last
  2,000 lines of output kept; the first `http://localhost:<port>` printed becomes a preview link.
- Shown in a Run panel for an office (its integration worktree, where merged work lives) and for
  a live session (its folder).
- Stopping kills the process group; Annex stopping stops them all.

**Done when.** From the browser: start `npm run dev` for a project, open its preview, read its
logs, run its tests, stop it.

## 4. Workflows and plugins on demand

**Design.**
- In a live session the prompt completes slash commands from that session's list, so
  `/smith:start`, any skill or command, and `/workflows` run as they do in the terminal.
- A Plugins view lists what is installed (`~/.claude/plugins/installed_plugins.json`), which are
  enabled for you (`~/.claude/settings.json`), and which each office uses. Turning one on or off
  for you edits your settings after a confirmation; for an office, it edits the wing file.
- An office can be handed a command as a task ("run /smith:start on spec X") from its Log tab.

**Done when.** A person can find a plugin, turn it on, and run its command in a session or an
office without the terminal.

## 5. Git and GitHub

**Design.**
- Projects: clone a repository URL into `~/Projects/<name>` (the person's own git credentials).
- Branches: list them and switch the checkout (clean tree only), create a branch.
- Publish: push the current branch and open a pull request with `gh`, after a confirmation that
  shows the exact commands. Agents still never push.

**Done when.** Clone, branch, push and open a PR happen from Annex with a confirmation each.

## 6. Configuration

**Design.** One editor for the files that configure Claude, each validated before it is saved
and backed up beside itself first: your `~/.claude/settings.json`, a project's
`.claude/settings.json` and `settings.local.json`, its `CLAUDE.md`, and its `.mcp.json`. The view
also lists the MCP servers in effect and the default model.

**Done when.** A person can change permissions, the default model, MCP servers and a project's
CLAUDE.md in Annex, and a broken JSON file is refused with the line of the error.

## 7. Usage and alerts

**Design.**
- Annex records the latest `rate_limit_event` from any live session or agent run: five-hour and
  seven-day use and when each resets. The top bar shows them.
- Which office spent it: runs and run time per office in the last five hours.
- Desktop notifications (after the person allows them) for: a request waiting, a permission
  prompt in a live session, a task stopped, a goal done, an office closed at the limit.

**Done when.** The top bar shows real plan usage, and the person is notified when something
needs them while the tab is in the background.

## 8. Always on

**Design.**
- `npm run service:install` writes a LaunchAgent that starts `npm run up` at login and restarts it
  if it exits; `npm run service:remove` takes it out.
- A daily copy of the database (`VACUUM INTO`), seven kept, under `.annex/backups`.
- `GET /api/health`: the engine reachable, the database writable, the last tick. The top bar says
  so when something is wrong.

**Done when.** After a reboot Annex is up by itself, backups exist, and a dead engine shows on
the page.

---

## Plan review, 5 October (senior reviewer), and what changed

Verdict: revise. Accepted in full:

- **Gap 0, added: an agent-proof credential.** Annex's agents may run `curl`, and the API had
  no credential, so an agent could drive the person's sessions, merges and pushes. Fix: agents
  lose `curl` (they never needed it); every request that changes anything, and every read of the
  person's own sessions, carries a key from `~/.config/annex/key` (0600, outside every repo),
  which agents' settings deny reading; the page gets the key once from a link Annex opens, and
  keeps it in the browser. The browser guard (Host and Origin) stays as the outer layer. The
  approve MCP server has its own per-process token.
- **Gap 1** split into 1a (start, resume, send, stream, stop, close, permission cards) and 1b
  (mode switch, slash-command completion). A prompt must survive a 10+ minute wait (proven, not
  assumed); the MCP server uses a request with no client timeout; anything going wrong denies; a
  stop or close settles open questions as "no". One registry: a reply is refused while a live
  session owns that conversation, and the other way round.
- **Gap 2** split: 2a read-only diffs (file names checked against the changed list and passed
  after `--`; task branches looked up, never pasted); 2b merge, which reverses design D7 for the
  person (agents still never merge into their branches): merge the exact commit shown in the
  confirmation, check for conflicts first with `git merge-tree --write-tree` so a conflicting merge
  never touches the checkout, and refuse during a merge, rebase, cherry-pick or bisect. Handing a
  conflict to the lead is dropped (agents may not merge).
- **Gap 3**: runs in its own throwaway worktree at the integration branch's head, never in the
  integration worktree Annex merges into; process groups recorded under `.annex/` and cleaned up
  on start; no `CI=1`.
- **Gap 4**: reuse `plugins.ts` and the wing file for offices; "hand an office a slash command"
  dropped (no done check, and the engine wraps the prompt so the command would not run).
- **Gap 5**: clone URLs limited to https, ssh and `git@host:path`, `--` before the URL, the folder
  one path segment, `GIT_TERMINAL_PROMPT=0`; never force-push; branch switching refused while a
  live session or a run uses that folder.
- **Gap 6**: fixed file kinds under known project roots, never a path from the client; MCP
  servers through `claude mcp list/add/remove` (user and local servers live in `~/.claude.json`);
  backups under `.annex/backups`; a save refused if the file changed since it was loaded;
  atomic writes.
- **Gap 7**: usage from live sessions and from agent run logs that carry `rate_limit_event`;
  the figure shows when it was seen.
- **Gap 8**: the service captures the installing shell's PATH; backups cover Annex's database,
  not the engine's `.paperclip` data; `up.ts` rebuilds a stale page; health checks the database
  can be written, not just read.

## Order and review



Built in the order 0, 8, 1a, 2a, 3, 1b, 7, 2b, 4, 6, 5 (read-only before anything that writes
to the person's checkout or global config). Originally planned as 8, 1, 2, 3, 4, 7, 6, 5: always-on first because everything else depends on
Annex staying up; live sessions next because they are the daily surface. Each gap is planned
here, the plan is reviewed by a senior reviewer before code, the diff is reviewed after, and a
fresh-eyes assessor checks the finished set against "Done when" in a real browser.

## Diff review of batch 1, 5 October (senior reviewer), and what changed

Verdict: revise. Fixed:

- **Crash: an event stream for a session that is gone** (a tab reconnecting after a restart)
  sent headers, then an error, and stopped Annex. The route checks first; the error handler
  ends a started response instead of replying twice; the page says the session ended.
- **Crash: writing to a session after Close.** A closing session refuses writes, writes check the
  pipe is open, and a broken pipe is caught.
- **The key and agents.** Deny rules now use a wildcard that matches the key's folder anywhere in
  a command (verified with Claude Code: `cat` by relative path, `diff` with the path second,
  `head -c` all refused). Stated plainly in `key.ts`: an office whose crew may run node, npm or
  npx runs arbitrary code as you and is not stopped; that needs an OS sandbox for agents' shells.
- **Mode switch** changes only when Claude accepts it, and shows its refusal (bypass cannot be
  switched on mid-session unless the session started that way).
- **Per-session tokens** for the permission channel, compared in constant time; closed sessions
  are forgotten after half an hour.
- A read of the Run tab no longer checks anything out; permission cards show everything they
  ask about; reopening a session Annex just closed needs no wait; an office's setup is
  validated with its script; the service uses the stable node path and fails loudly.
- Tests added: live sessions (questions, allow for the session, Stop and Close answering no,
  writes after Close, the mode switch, tokens, the stream), and the runner now proves the whole
  process group is gone after Stop.

