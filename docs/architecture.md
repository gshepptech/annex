# How Annex fits together

Annex is a Mac app for working with Claude Code without a terminal: your own Claude sessions, and
offices of agents (a lead, a crew and a reviewer) that work on a project in their own branches.
This page is for someone changing the code. To use Annex, start with `getting-started.md`.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Annex.app | `app/main.swift` | A native window (WebKit) on the local server. Reads the key, installs the login service on first launch, turns page alerts into notifications and a Dock badge, opens the folder picker. |
| Login service | `scripts/service.ts`, `scripts/up.ts` | A macOS LaunchAgent (`dev.annex.office`) that starts the engine, then the server, at login and after a crash. |
| Server | `server/` | Node (24.11 or newer; the app bundles 26) runs the TypeScript files directly. Plain `node:http` with server-sent events, `node:sqlite` for state. Listens on 127.0.0.1:4300. |
| Page | `web/src/` | Plain TypeScript and DOM (`dom.ts`), built by Vite. The offices are drawn on a canvas (`web/src/office`). |
| Engine | `runtime/` | Paperclip, pinned. It runs the agents' heartbeats and holds their issues; it listens on 127.0.0.1:3100 and keeps its own embedded Postgres. |

Inside Annex.app, `Contents/Resources` carries the official Node binary, the server, the built page
and the engine, so a Mac needs only Claude Code. `scripts/app.ts` builds it.

## Where data lives

Code and data are separate (`server/paths.ts`). Data is in `ANNEX_HOME`: by default
`~/Library/Application Support/Annex` for the app, or the checkout itself when run with `npm run up`.

- `wings/<id>/wing.toml`: one file per office (`server/wing.ts` reads it, `wingfile.ts` writes it).
  `examples/wings/` has one to copy.
- `.annex/annex.db`: offices, tasks, goals, chat, asks, the projects list. Copied daily to
  `.annex/backups`.
- `.annex/logs`: Annex's own log, the engine's log, the service's log.
- `.paperclip/`: the engine's database and agent workspaces.
- `~/.config/annex/key`: the key every API call must carry (`server/key.ts`). Outside the data
  folder on purpose, so agents can be denied it.

## Your own sessions

- **Your desk** lists Claude Code sessions from `~/.claude/projects` (`sessions.ts`, `transcript.ts`).
- **A live session** (`live.ts`) runs `claude -p` with stream-json in and out. Questions and
  permission requests come back through a small MCP server (`agent-tools/approve-mcp.mjs`) and
  show as cards.
- **Terminals** (`terminals.ts`, node-pty) are real shells. CLI-only slash commands and the
  setup fixes open in one.
- **Projects** (`projects.ts`, `files.ts`): clone, branches, commit, publish, the CLAUDE.md and
  settings editor, and the code editor.
- **First-run setup** is `setup.ts`.

## Offices

- **The bureau** (`bureau.ts`) reacts to engine events and polls every 15 seconds:
  - it reads each office's state from the engine (`engine/paperclip.ts`);
  - it wakes leads, files the tasks they propose (`proposal.ts`) and runs each task's done check
    in its worktree;
  - it hands the work to the reviewer, then merges verified work into the office's integration
    branch.
- **Your base branch** is never touched by agents: you merge from the Ready to merge tab
  (`git.ts`).
- **The director** (`director.ts`) answers questions about all offices and routes work to them.
- **Agent setup:** `provision.ts` writes each office's agents and their Claude Code settings:
  - what they may run, and the denies;
  - the OS sandbox, which keeps the key folder unreadable and limits network and writes;
  - the office's plugins.

  `prompts.ts` holds what they are told.
- **Agent reports:** agents report back only through `agent-tools/report.mjs`.

## Checks

```sh
npm run typecheck && npm test && npm run web:build
```

Tests are `node --test` files beside the code (`*.test.ts`).
