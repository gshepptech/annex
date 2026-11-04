# Getting started with Annex

You were handed `Annex.dmg`. This page takes you from that file to Claude working in one of your
projects, without opening Terminal.app.

## 1. Install it

1. Open `Annex.dmg` and drag Annex to Applications.
2. Open Annex from Applications.

The build is not signed with an Apple Developer ID, so the first time macOS says it cannot check
the app. Right-click (or Control-click) Annex in Applications and choose **Open**, then **Open**
again. On macOS 15 and later that menu no longer lets it through: try to open Annex once, then go
to System Settings › Privacy & Security and click **Open Anyway** next to Annex. Either way you do
this once.

The first launch takes a minute or two: Annex installs its login service and sets up the engine
its offices run on. After that it starts when you log in, and the app just opens.

## 2. The setup screen

When something Annex needs is missing, **Set up Annex** opens by itself, and the top bar shows
**Finish setup** until it is all there. It checks four things:

| Check | Needed? | What Fix does |
|---|---|---|
| Claude Code installed | Yes | Runs Claude Code's official installer |
| Signed in to Claude | Yes | Runs `claude auth login`, which opens your browser to sign in |
| Git (Command Line Tools) | Yes | Asks macOS to install its Command Line Tools |
| GitHub CLI signed in | Only for private repositories | Signs in with `gh` (installing it first when Homebrew is there) |

Each **Fix** opens a terminal inside Annex and runs that one step. Follow what it asks; when it
prints "Done", close that terminal, open **Finish setup** and press **Check again**. Do them top
to bottom: signing in needs Claude Code installed first.

Annex uses your own Claude subscription (Pro or Max), exactly as `claude` would in a terminal.

## 3. Add a project

Open **Projects** in the top bar. A project is any folder; it does not have to be in a particular
place.

- **Add a folder…** picks a folder you already have.
- **New project…** makes a folder (in `~/Projects` unless you choose another) and starts it as a
  git repository with a README.
- **Clone…** copies a repository from an address such as `https://github.com/you/app.git`, into
  `~/Projects` or a folder you choose. Private repositories need the GitHub step above.

Git repositories directly inside `~/Projects`, and folders you have recently run Claude Code in,
show up on their own. **Forget** takes a project off the list; the folder and its files are left
exactly as they are, and **Add a folder…** brings it back.

## 4. Start a session

Choose **Start a session here** on a project, or **New session** in the top bar and pick its
folder. This is Claude Code in that folder, on your own settings. Type what you want; when Claude
wants to run a command or change a file, it asks first with a card (Allow, Allow for the session,
or Deny). **Stop** ends a turn.

If a session says **Claude Code is signed out**, press **Log in** there, finish in the terminal it
opens, and send your message again.

## 5. Start an office

An office is a room with a lead, a crew and a reviewer working on one project. Choose
**+ New office** in the sidebar, name it, and give the folder of a project (or tick the box to
start a new, empty one). Then give it a goal in its Goals tab; the lead plans the work, the crew
does it in their own copies, and work counts as done only when its check passes and the reviewer
approves. You merge finished work yourself from **Ready to merge**.

## Where your things are

- Your projects stay where they are. Annex never moves them, and offices never touch your own
  checkout or push anything.
- Annex's own data is in `~/Library/Application Support/Annex`: offices in `wings/`, its database
  and logs in `.annex/`.
- Its key, which lets the app (and only browsers you pair) talk to it, is in `~/.config/annex/`.
- Claude Code keeps its own settings and conversations in `~/.claude`, as it always does.

To keep Annex's data somewhere else, put that folder's path in `~/.config/annex/home` before the
first launch.
