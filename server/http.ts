// Annex's own HTTP surface: the state snapshot, a resumable event stream, and the handful of
// things a person can do to a wing. Bound to loopback; there is no login because nothing here is
// reachable from another machine.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Store } from "./db.ts";
import type { Logger } from "./logger.ts";
import type { StateView, WingEdit, NewWing, TranscriptView } from "./api-types.ts";
import { listSessions, sessionTranscript, replyToSession, SessionBusy } from "./sessions.ts";
import { health } from "./upkeep.ts";
import { Runner, RunError } from "./runner.ts";
import * as P from "./projects.ts";
import * as F from "./files.ts";
import { sameKey } from "./key.ts";
import { LiveSessions, LiveError, MODES, defaultMode, type Mode } from "./live.ts";
import { IDLE_MS, isReplying } from "./sessions.ts";
import { Terminals, TerminalError } from "./terminals.ts";

export interface Bureau {
  state(): Promise<StateView>;
  chat(wingId: string, text: string): Promise<void>;
  handoff(wingId: string): Promise<void>;
  approveBrief(wingId: string, briefId: number): Promise<void>;
  comeBack(wingId: string): Promise<void>;
  dropIn(wingId: string, title: string, detail: string): Promise<{ taskId: string }>;
  transcript(agentId: string, limit?: number): Promise<TranscriptView>;
  updateWing(wingId: string, edit: WingEdit): Promise<void>;
  createWing(n: NewWing): Promise<{ id: string }>;
  decideAsk(wingId: string, askId: number, approve: boolean): Promise<void>;
  hireFromOffice(wingId: string, count: number): Promise<{ hired: number }>;
  directorSay(text: string): Promise<void>;
  pause(wingId: string): void;
  resume(wingId: string): void;
  addGoal(wingId: string, text: string, doneWhen: string | null): Promise<unknown>;
  closeGoal(wingId: string, goalId: number, status: "done" | "dropped" | "active"): void;
  setAutonomy(wingId: string, on: boolean): Promise<void>;
  changes(wingId: string, opts?: { taskId?: string; file?: string }): Promise<unknown>;
  previewFolder?(wingId: string, refresh?: boolean): Promise<{ folder: string; setup: string | null }>;
  mergeIntoBase?(wingId: string, sha: string): Promise<{ commit: string; where: string }>;
  lastTickAt?: Date | null;
}

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
};

// Annex listens on 127.0.0.1 with no login, and some of its endpoints run commands and write
// files. Two browser attacks reach a localhost server: a page on another site posting to it
// (cross-site request), and a hostile domain re-pointed at 127.0.0.1 (DNS rebinding). The Host
// header must name this machine, and any Origin a browser sends must be this page itself.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
export function refuseForeign(req: IncomingMessage): string | null {
  const host = req.headers.host ?? "";
  if (!LOCAL_HOST.test(host)) return `Annex only answers requests addressed to this machine, not "${host}"`;
  const origin = req.headers.origin;
  if (origin === "null") return "Requests from a sandboxed page are not allowed";
  if (origin) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      return "Bad Origin header";
    }
    if (!LOCAL_HOST.test(o.host) || o.host !== host) return `Requests from ${origin} are not allowed`;
  }
  // a cross-site request that sends no Origin still marks itself; refuse anything not same-origin
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return "Cross-site requests are not allowed";
  return null;
}

export function startHttp(opts: { bureau: Bureau; store: Store; logger?: Logger; port: number; webDir: string; claudeCommand?: string; engineUrl?: string; startedAt?: Date; live?: LiveSessions; key?: string; runner?: Runner; backupsDir?: string; terminals?: Terminals }): Promise<Server> {
  const { bureau, store, webDir, logger } = opts;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const refused = refuseForeign(req);
      if (refused) return json(res, 403, { error: refused });
      // every API call carries the key, except the health check and the live sessions' own
      // permission channel, which has its own token; an event stream passes it in the query
      // because EventSource cannot send headers
      if (opts.key && path.startsWith("/api/") && path !== "/api/health" && !/^\/api\/live\/[0-9a-f-]{36}\/permission$/.test(path)) {
        const given = (req.headers["x-annex-key"] as string | undefined) ?? url.searchParams.get("key");
        if (!sameKey(given, opts.key)) return json(res, 401, { error: "Annex needs its key. Open it with `npm run open`, which gives this browser the key once." });
      }

      if (req.method === "GET" && path === "/api/state") return json(res, 200, await bureau.state());
      if (req.method === "GET" && path === "/api/logs") {
        return json(res, 200, { file: logger?.file ?? null, lines: logger?.since(Number(url.searchParams.get("after") ?? 0), url.searchParams.get("wing") ?? undefined) ?? [] });
      }
      if (req.method === "GET" && path === "/api/stream") return streamEvents(req, res, store, Number(url.searchParams.get("after") ?? 0));

      const agent = /^\/api\/agents\/([^/]+)\/transcript$/.exec(path);
      if (req.method === "GET" && agent) {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 8) || 8));
        return json(res, 200, await bureau.transcript(decodeURIComponent(agent[1]!), limit));
      }

      if (req.method === "POST" && path === "/api/director") {
        const body = await readJson(req);
        await bureau.directorSay(str(body.text, "text"));
        return json(res, 202, { ok: true });
      }

      if (req.method === "POST" && path === "/api/wings") {
        const body = await readJson(req);
        return json(res, 201, await bureau.createWing({
          id: str(body.id, "id"),
          name: str(body.name, "name"),
          charter: typeof body.charter === "string" ? body.charter : undefined,
          repoPath: typeof body.repoPath === "string" ? body.repoPath : undefined,
          baseBranch: typeof body.baseBranch === "string" ? body.baseBranch : undefined,
          newRepo: body.newRepo === true || body.newRepo === "on",
        }));
      }

      const wing = /^\/api\/wings\/([^/]+)$/.exec(path);
      if (req.method === "PUT" && wing) {
        await bureau.updateWing(decodeURIComponent(wing[1]!), (await readJson(req)) as WingEdit);
        return json(res, 200, { ok: true });
      }

      const ask = /^\/api\/wings\/([^/]+)\/asks\/(\d+)\/(approve|decline)$/.exec(path);
      if (req.method === "POST" && ask) {
        await bureau.decideAsk(decodeURIComponent(ask[1]!), Number(ask[2]), ask[3] === "approve");
        return json(res, 200, { ok: true });
      }

      const hire = /^\/api\/wings\/([^/]+)\/hire$/.exec(path);
      if (req.method === "POST" && hire) {
        const body = await readJson(req);
        return json(res, 200, await bureau.hireFromOffice(decodeURIComponent(hire[1]!), Number(body.count ?? 1)));
      }

      if (req.method === "GET" && path === "/api/health") {
        return json(res, 200, await health({ engineUrl: opts.engineUrl ?? "http://127.0.0.1:3100", store: opts.store, lastTick: bureau.lastTickAt ?? null, startedAt: opts.startedAt ?? new Date() }));
      }
      if (path.startsWith("/api/live")) {
        if (!opts.live) throw new UserError("Live sessions are not available", 404);
        try {
          const handled = await liveRoutes(req, res, url, opts.live, opts.terminals);
          if (handled) return;
        } catch (err) {
          if (err instanceof LiveError) throw new UserError(err.message, 409);
          throw err;
        }
      }
      if (path.startsWith("/api/terminals")) {
        if (!opts.terminals) throw new UserError("Terminals are not available", 404);
        try {
          if (await terminalRoutes(req, res, url, opts.terminals, opts.live)) return;
        } catch (err) {
          if (err instanceof TerminalError || err instanceof LiveError) throw new UserError(err.message, 409);
          throw err;
        }
      }
      if (path.startsWith("/api/run")) {
        if (!opts.runner) throw new UserError("Running apps is not available", 404);
        try {
          if (await runRoutes(req, res, url, opts.runner, bureau)) return;
        } catch (err) {
          if (err instanceof RunError) throw new UserError(err.message, 409);
          throw err;
        }
      }
      if (req.method === "GET" && path === "/api/sessions") return json(res, 200, listSessions());
      if (path.startsWith("/api/projects") || path.startsWith("/api/config") || path.startsWith("/api/mcp") || path.startsWith("/api/plugins") || path.startsWith("/api/files")) {
        try {
          if (await projectRoutes(req, res, url, opts, bureau)) return;
        } catch (err) {
          if (err instanceof P.ProjectError) throw new UserError(err.message, 409);
          throw err;
        }
      }
      const session = /^\/api\/sessions\/([0-9a-f-]{36})\/transcript$/.exec(path);
      if (req.method === "GET" && session) {
        const t = sessionTranscript(session[1]!);
        if (!t) throw new UserError("No session with that id", 404);
        return json(res, 200, t);
      }
      const reply = /^\/api\/sessions\/([0-9a-f-]{36})\/reply$/.exec(path);
      if (req.method === "POST" && reply) {
        const body = await readJson(req);
        // one conversation, one claude: a session driven live takes no one-shot replies
        if (opts.live?.bySession(reply[1]!)) throw new UserError("This session is open live in Annex; reply there.", 409);
        if (opts.terminals?.bySession(reply[1]!)) throw new UserError(IN_TERMINAL, 409);
        try {
          return json(res, 202, replyToSession(reply[1]!, str(body.text, "text"), { claude: opts.claudeCommand ?? "claude" }));
        } catch (err) {
          if (err instanceof SessionBusy) throw new UserError(err.message, 409);
          throw err;
        }
      }

      const changes = /^\/api\/wings\/([^/]+)(?:\/tasks\/([^/]+))?\/changes$/.exec(path);
      if (req.method === "GET" && changes) {
        const file = url.searchParams.get("file");
        return json(res, 200, await bureau.changes(decodeURIComponent(changes[1]!), { taskId: changes[2] ? decodeURIComponent(changes[2]) : undefined, file: file ?? undefined }));
      }

      const merge = /^\/api\/wings\/([^/]+)\/merge$/.exec(path);
      if (req.method === "POST" && merge && bureau.mergeIntoBase) {
        const body = await readJson(req);
        const wingId = decodeURIComponent(merge[1]!);
        const repo = (await bureau.state()).wings.find((w) => w.id === wingId)?.repo;
        // the checkout must not be in use by something running in it right now
        if (repo && (opts.live?.list().some((l) => l.status !== "closed" && under(l.cwd, repo)) || claudeTerminalIn(opts.terminals, repo))) {
          throw new UserError("A live session is open in that repo. Close it first, so the merge does not change files under it.", 409);
        }
        if (repo && opts.runner?.list().some((r) => r.status === "running" && (r.folder === repo || r.folder.startsWith(`${repo}/`)))) {
          throw new UserError("Something is running in that repo. Stop it first.", 409);
        }
        return json(res, 200, await bureau.mergeIntoBase(wingId, str(body.sha, "sha")));
      }

      const goals = /^\/api\/wings\/([^/]+)\/goals$/.exec(path);
      if (req.method === "POST" && goals) {
        const body = await readJson(req);
        const g = await bureau.addGoal(decodeURIComponent(goals[1]!), str(body.text, "text"), typeof body.doneWhen === "string" ? body.doneWhen : null);
        return json(res, 201, g);
      }

      const goal = /^\/api\/wings\/([^/]+)\/goals\/(\d+)\/(done|drop|reopen)$/.exec(path);
      if (req.method === "POST" && goal) {
        bureau.closeGoal(decodeURIComponent(goal[1]!), Number(goal[2]), goal[3] === "done" ? "done" : goal[3] === "drop" ? "dropped" : "active");
        return json(res, 200, { ok: true });
      }

      const autonomy = /^\/api\/wings\/([^/]+)\/autonomy$/.exec(path);
      if (req.method === "POST" && autonomy) {
        const body = await readJson(req);
        await bureau.setAutonomy(decodeURIComponent(autonomy[1]!), body.on === true);
        return json(res, 200, { ok: true });
      }

      const hold = /^\/api\/wings\/([^/]+)\/(pause|resume)$/.exec(path);
      if (req.method === "POST" && hold) {
        if (hold[2] === "pause") bureau.pause(decodeURIComponent(hold[1]!));
        else bureau.resume(decodeURIComponent(hold[1]!));
        return json(res, 200, { ok: true });
      }

      const m = /^\/api\/wings\/([^/]+)\/(chat|handoff|come-back|tasks|briefs\/(\d+)\/approve)$/.exec(path);
      if (req.method === "POST" && m) {
        const wingId = decodeURIComponent(m[1]!);
        const body = await readJson(req);
        switch (m[2]) {
          case "chat": {
            const text = str(body.text, "text");
            await bureau.chat(wingId, text);
            return json(res, 202, { ok: true });
          }
          case "handoff":
            await bureau.handoff(wingId);
            return json(res, 202, { ok: true });
          case "come-back":
            await bureau.comeBack(wingId);
            return json(res, 200, { ok: true });
          case "tasks": {
            const created = await bureau.dropIn(wingId, str(body.title, "title"), typeof body.detail === "string" ? body.detail : "");
            return json(res, 201, created);
          }
          default:
            await bureau.approveBrief(wingId, Number(m[3]));
            return json(res, 200, { ok: true });
        }
      }

      if (req.method === "GET" && !path.startsWith("/api/")) return serveStatic(res, webDir, path);
      return json(res, 404, { error: `No such route: ${req.method} ${path}` });
    } catch (err) {
      // a stream that already started cannot switch to an error reply; end it instead of crashing
      if (res.headersSent) {
        if (!(err instanceof UserError)) console.error("[annex] request failed after it started", err);
        res.end();
        return;
      }
      if (err instanceof UserError) return json(res, err.status, { error: err.message });
      console.error("[annex] request failed", err);
      return json(res, 500, { error: `Annex hit an error: ${(err as Error).message}` });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // a live session's permission question is one request held open until you answer it
    server.requestTimeout = 0;
    server.listen(opts.port, "127.0.0.1", () => resolve(server));
  });
}

// Live sessions. Starting one runs Claude in a folder you name, as you; resuming one waits until
// the session has been quiet long enough that it is not open in a terminal.
async function liveRoutes(req: IncomingMessage, res: ServerResponse, url: URL, live: LiveSessions, terminals?: Terminals): Promise<boolean> {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/live") {
    json(res, 200, { lives: live.list().map((l) => ({ id: l.id, sessionId: l.sessionId, cwd: l.cwd, status: l.status, mode: l.mode })), defaultMode: defaultMode(), modes: MODES });
    return true;
  }
  if (req.method === "POST" && path === "/api/live") {
    const body = await readJson(req);
    const resume = typeof body.resume === "string" && /^[0-9a-f-]{36}$/.test(body.resume) ? body.resume : null;
    let mode = (typeof body.mode === "string" ? body.mode : defaultMode()) as Mode;
    let cwd = typeof body.cwd === "string" ? expandHome(body.cwd.trim()) : "";
    if (cwd && !cwd.startsWith("/")) throw new UserError("Name the folder by its full path (or start it with ~/)", 400);
    let history;
    if (resume) {
      const already = live.bySession(resume);
      if (already) return (json(res, 200, already), true);
      if (terminals?.bySession(resume)) throw new UserError(IN_TERMINAL, 409);
      if (isReplying(resume)) throw new UserError("A reply from Annex is still running in this session; open it live when it finishes.", 409);
      const t = sessionTranscript(resume);
      if (!t) throw new UserError("No session with that id", 404);
      const quiet = Date.now() - new Date(t.session.updatedAt).getTime();
      // force: the person says the terminal is closed; still refused while Annex itself is replying
      if (quiet < IDLE_MS && body.force !== true && !live.lastDrivenByBourne(resume) && !terminals?.ranSession(resume)) throw new UserError("This session was active in the last few minutes and may be open in a terminal. Close it there, or wait a few minutes.", 409);
      cwd = t.session.cwd;
      history = t.entries;
      // a resumed session keeps the permission mode it had, unless one was chosen just now
      if (typeof body.mode !== "string") mode = (live.lastMode(resume) ?? (MODES.includes(t.session.permissionMode as Mode) ? t.session.permissionMode : defaultMode())) as Mode;
    }
    if (!cwd) throw new UserError("Name a folder to start the session in", 400);
    json(res, 201, live.start({ cwd, mode, resume, history, model: typeof body.model === "string" && body.model && body.model !== "default" ? body.model : null }));
    return true;
  }
  const m = /^\/api\/live\/([0-9a-f-]{36})(?:\/(events|message|interrupt|mode|model|close|answer|permission|files|shell))?$/.exec(path);
  if (!m) return false;
  const id = m[1]!;
  if (req.method === "GET" && !m[2]) {
    const v = live.get(id);
    if (!v) throw new UserError("No live session with that id", 404);
    json(res, 200, v);
    return true;
  }
  if (req.method === "GET" && m[2] === "events") {
    // a session from before Annex restarted is gone: say so before the stream starts
    if (!live.get(id)) throw new UserError("No live session with that id", 404);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const off = live.subscribe(id, (u) => res.write(`data: ${JSON.stringify(u)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      off();
      clearInterval(ping);
    });
    return true;
  }
  if (req.method === "GET" && m[2] === "files") {
    json(res, 200, await live.files(id, url.searchParams.get("q") ?? ""));
    return true;
  }
  if (req.method !== "POST") return false;
  // a message may carry pasted images (up to four, base64), so it may be larger than other requests
  const body = await readJson(req, m[2] === "message" ? 24_000_000 : 1_000_000);
  switch (m[2]) {
    case "message": {
      const images = Array.isArray(body.images) ? (body.images as { mediaType?: unknown; data?: unknown }[]) : [];
      live.send(id, typeof body.text === "string" ? body.text : "", images.map((i) => ({ mediaType: String(i.mediaType ?? ""), data: String(i.data ?? "") })));
      break;
    }
    case "shell":
      json(res, 200, await live.shell(id, str(body.command, "command")));
      return true;
    case "interrupt":
      live.interrupt(id);
      break;
    case "mode":
      live.setMode(id, str(body.mode, "mode") as Mode);
      break;
    case "model":
      live.setModel(id, str(body.model, "model"));
      break;
    case "close":
      live.close(id);
      break;
    case "answer":
      live.answer(
        id,
        str(body.promptId, "promptId"),
        body.allow === true
          ? { allow: true, always: body.always === true, ...(body.answers && typeof body.answers === "object" ? { answers: Object.fromEntries(Object.entries(body.answers as Record<string, unknown>).map(([k, v]) => [k, String(v)])) } : {}) }
          : { allow: false, message: typeof body.message === "string" ? body.message : undefined },
      );
      break;
    case "permission": {
      // only the approve MCP server Annex started for this session knows the token
      if (!live.tokenOk(id, req.headers["x-annex-token"] as string | undefined)) throw new UserError("Not allowed", 403);
      const d = await live.ask(id, str(body.tool, "tool"), (body.input ?? {}) as Record<string, unknown>);
      json(res, 200, d);
      return true;
    }
    default:
      return false;
  }
  json(res, 200, { ok: true });
  return true;
}

// Folders Annex knows as yours: every git repo directly under ~/Projects, your offices' repos,
// and the folders your recent sessions ran in. Project actions only ever take one of these.
async function projectFolders(bureau: Bureau): Promise<string[]> {
  const repos = (await bureau.state()).wings.map((w) => w.repo).filter((r): r is string => !!r);
  const sessions = listSessions({ limit: 30, withinMs: 30 * 86_400_000 }).map((s) => s.cwd);
  return P.knownProjects([...repos, ...sessions]);
}

type Opts = Parameters<typeof startHttp>[0];

async function projectRoutes(req: IncomingMessage, res: ServerResponse, url: URL, opts: Opts, bureau: Bureau): Promise<boolean> {
  const path = url.pathname;
  const known = await projectFolders(bureau);
  const backups = opts.backupsDir ?? join(process.env.HOME ?? "", ".config", "annex", "backups");
  const claude = opts.claudeCommand ?? "claude";
  const root = (v: unknown) => {
    const r = typeof v === "string" ? expandHome(v.trim()) : "";
    if (!known.includes(r)) throw new P.ProjectError("That folder is not one of your projects");
    return r;
  };
  // a checkout something is running in, or a live session is open in, is not switched under it
  const inUse = (r: string) =>
    opts.live?.list().some((l) => l.status !== "closed" && under(l.cwd, r)) ||
    claudeTerminalIn(opts.terminals, r) ||
    opts.runner?.list().some((x) => x.status === "running" && (x.folder === r || x.folder.startsWith(`${r}/`)));
  const q = (k: string) => url.searchParams.get(k);
  if (req.method === "GET" && path === "/api/projects") return (json(res, 200, known), true);
  if (req.method === "GET" && path === "/api/plugins") {
    const wings = (await bureau.state()).wings;
    return (json(res, 200, P.pluginRows().map((p) => ({ ...p, offices: wings.filter((w) => w.edit.plugins.includes(p.id)).map((w) => w.id) }))), true);
  }
  if (req.method === "GET" && path === "/api/projects/branches") return (json(res, 200, await P.branches(root(q("root")))), true);
  if (req.method === "GET" && path === "/api/projects/publish") return (json(res, 200, await P.publishPlan(root(q("root")))), true);
  if (req.method === "GET" && path === "/api/config") return (json(res, 200, P.readConfig(str(q("kind"), "kind"), q("root") ? root(q("root")) : null, known)), true);
  if (req.method === "GET" && path === "/api/mcp") return (json(res, 200, await P.mcpList(claude, root(q("root")))), true);
  if (req.method === "PUT" && path === "/api/config") {
    const b = await readJson(req);
    return (json(res, 200, P.writeConfig({ kind: str(b.kind, "kind"), root: b.root ? root(b.root) : null, text: typeof b.text === "string" ? b.text : "", hash: str(b.hash, "hash"), known, backups })), true);
  }
  // the editor: a project's files, one file read, and a save that never goes over a change on disk
  if (req.method === "GET" && path === "/api/files") return (json(res, 200, await F.listProjectFiles(root(q("root")), known)), true);
  if (req.method === "GET" && path === "/api/files/read") return (json(res, 200, F.readProjectFile(root(q("root")), str(q("path"), "path"), known)), true);
  if (req.method === "GET" && path === "/api/files/locate") return (json(res, 200, F.locateFile(str(q("path"), "path"), known)), true);
  if (req.method === "PUT" && path === "/api/files") {
    // a 1 MB file grows when written as JSON; the size of the text itself is checked in files.ts
    const b = await readJson(req, 8_000_000);
    try {
      // the text is not trimmed: str() would change the file
      return (json(res, 200, F.writeProjectFile({ root: root(b.root), path: str(b.path, "path"), text: typeof b.text === "string" ? b.text : "", hash: str(b.hash, "hash"), known, backups })), true);
    } catch (err) {
      if (err instanceof P.FileChanged) return (json(res, 409, { error: err.message, conflict: true }), true);
      throw err;
    }
  }
  if (req.method !== "POST") return false;
  const b = await readJson(req);
  switch (path) {
    case "/api/projects/clone":
      return (json(res, 201, { folder: await P.clone(str(b.url, "url"), typeof b.name === "string" ? b.name : null) }), true);
    case "/api/projects/switch": {
      const r = root(b.root);
      if (inUse(r)) throw new UserError("A live session or a run is using that folder. Close or stop it first.", 409);
      return (json(res, 200, { branch: await P.switchBranch(r, str(b.branch, "branch"), b.create === true) }), true);
    }
    case "/api/projects/commit":
      return (json(res, 200, { commit: await P.commitAll(root(b.root), str(b.message, "message"), Array.isArray(b.changes) ? b.changes.map(String) : []) }), true);
    case "/api/projects/publish":
      return (json(res, 200, await P.publish(root(b.root), str(b.branch, "branch"))), true);
    case "/api/mcp":
      return (json(res, 200, { text: await P.mcpAdd(claude, root(b.root), { name: str(b.name, "name"), scope: str(b.scope, "scope"), command: str(b.command, "command"), args: Array.isArray(b.args) ? b.args.map(String) : [] }) }), true);
    case "/api/mcp/remove":
      return (json(res, 200, { text: await P.mcpRemove(claude, root(b.root), str(b.name, "name"), typeof b.scope === "string" && b.scope ? b.scope : null) }), true);
    case "/api/plugins/you":
      P.setPluginForYou(str(b.id, "id"), b.on === true, backups);
      return (json(res, 200, { ok: true }), true);
  }
  return false;
}

// Running the app. A folder is one of yours (any folder you name, as in a terminal); an office runs
// in its preview checkout, never in the worktree Annex merges in.
async function runRoutes(req: IncomingMessage, res: ServerResponse, url: URL, runner: Runner, bureau: Bureau): Promise<boolean> {
  const path = url.pathname;
  const folderOf = async (q: { folder?: unknown; wing?: unknown }, refresh: boolean): Promise<{ folder: string; setup: string | null }> => {
    if (typeof q.wing === "string" && q.wing) {
      if (!bureau.previewFolder) throw new UserError("Offices cannot run apps here", 404);
      return bureau.previewFolder(q.wing, refresh);
    }
    const f = typeof q.folder === "string" ? expandHome(q.folder.trim()) : "";
    if (!f.startsWith("/")) throw new UserError("Name a folder by its full path", 400);
    return { folder: f, setup: null };
  };
  if (req.method === "GET" && path === "/api/run") {
    const { folder } = await folderOf({ folder: url.searchParams.get("folder"), wing: url.searchParams.get("wing") }, false);
    json(res, 200, { folder, scripts: runner.scripts(folder), runs: runner.list(folder) });
    return true;
  }
  if (req.method === "POST" && path === "/api/run") {
    const body = await readJson(req);
    const { folder, setup } = await folderOf(body, true);
    const script = typeof body.script === "string" ? body.script : undefined;
    const command = typeof body.command === "string" ? body.command : undefined;
    // an office's preview that was never set up gets its setup first (npm ci and the like)
    const run = runner.start({ folder, script, command, setup });
    json(res, 201, run);
    return true;
  }
  const m = /^\/api\/run\/([0-9a-f-]{36})\/(stop|log)$/.exec(path);
  if (!m) return false;
  if (req.method === "POST" && m[2] === "stop") {
    json(res, 200, runner.stop(m[1]!));
    return true;
  }
  if (req.method === "GET" && m[2] === "log") {
    json(res, 200, runner.log(m[1]!, Number(url.searchParams.get("after") ?? 0)));
    return true;
  }
  return false;
}

const IN_TERMINAL = "This conversation is open in a terminal in Annex. Close that terminal first.";

// Terminals: your login shell in a folder, or a conversation moved out of a live session into
// `claude --resume`. Output streams as events whose id is an offset into what the terminal printed,
// so a browser that reconnects (it sends Last-Event-ID by itself) gets only what it missed.
async function terminalRoutes(req: IncomingMessage, res: ServerResponse, url: URL, terms: Terminals, live?: LiveSessions): Promise<boolean> {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/terminals") return (json(res, 200, { terminals: terms.list() }), true);
  if (req.method === "POST" && path === "/api/terminals") {
    const body = await readJson(req);
    if (typeof body.live === "string") {
      // Open in terminal: the live session's child must be gone before claude --resume starts
      const l = live?.get(body.live);
      if (!l) throw new UserError("No live session with that id", 404);
      if (l.sessionId && isReplying(l.sessionId)) throw new UserError("A reply from Annex is still running in this session; try again when it finishes.", 409);
      const already = l.sessionId ? terms.bySession(l.sessionId) : null;
      if (already) return (json(res, 200, already), true);
      await live!.closeAndWait(l.id);
      // a second click that waited alongside this one finds the terminal the first one opened
      const opened = l.sessionId ? terms.bySession(l.sessionId) : null;
      if (opened) return (json(res, 200, opened), true);
      return (json(res, 201, terms.open({ cwd: l.cwd, claude: { resume: l.sessionId } })), true);
    }
    const cwd = typeof body.cwd === "string" ? expandHome(body.cwd.trim()) : "";
    if (!cwd.startsWith("/")) throw new UserError("Name the folder by its full path (or start it with ~/)", 400);
    return (json(res, 201, terms.open({ cwd })), true);
  }
  const m = /^\/api\/terminals\/([0-9a-f-]{36})\/(events|input|resize|close)$/.exec(path);
  if (!m) return false;
  const id = m[1]!;
  if (req.method === "GET" && m[2] === "events") {
    // a terminal from before Annex restarted is gone: say so before the stream starts
    if (!terms.get(id)) throw new UserError("No terminal with that id", 404);
    const raw = req.headers["last-event-id"] ?? url.searchParams.get("after");
    const after = raw === null || raw === undefined || raw === "" ? null : Number(raw);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let ended = false;
    const off = terms.subscribe(id, Number.isFinite(after) ? after : null, (u) => {
      if (ended) return;
      res.write(u.type === "output" ? `id: ${u.at}\ndata: ${JSON.stringify(u)}\n\n` : `data: ${JSON.stringify(u)}\n\n`);
      // a reader that cannot keep up is cut off; it reconnects and replays from what is kept
      if (res.writableLength > 4_000_000) {
        ended = true;
        res.end();
      }
    });
    const ping = setInterval(() => !ended && res.write(": ping\n\n"), 25_000);
    const stop = () => {
      ended = true;
      off();
      clearInterval(ping);
    };
    if (ended) stop();
    req.on("close", stop);
    res.on("close", stop);
    return true;
  }
  if (req.method !== "POST") return false;
  const body = await readJson(req);
  if (m[2] === "input") {
    // one keystroke is a valid body, spaces included, so this is not trimmed
    if (typeof body.data !== "string") throw new UserError("data is required");
    terms.input(id, body.data);
  } else if (m[2] === "resize") {
    terms.resize(id, Number(body.cols), Number(body.rows));
  } else {
    terms.close(id);
  }
  json(res, 200, { ok: true });
  return true;
}

function under(folder: string, root: string): boolean {
  return folder === root || folder.startsWith(`${root}/`);
}

// Claude running in a Annex terminal in that checkout; a plain shell does not count, as a
// terminal app's would not.
function claudeTerminalIn(terms: Terminals | undefined, root: string): boolean {
  return !!terms?.list().some((t) => t.kind === "claude" && t.status === "running" && under(t.cwd, root));
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? `${process.env.HOME ?? ""}${p.slice(1)}` : p;
}

function streamEvents(req: IncomingMessage, res: ServerResponse, store: Store, after: number) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let last = Number.isFinite(after) ? after : 0;
  const send = (e: { id: number }) => {
    if (e.id <= last) return;
    last = e.id;
    res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  // Subscribe before replaying so nothing recorded in between is missed; `send` drops repeats.
  const off = store.onEvent(send);
  for (const e of store.eventsSince(last, undefined, 2000)) send(e);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    off();
    clearInterval(ping);
  });
}

async function serveStatic(res: ServerResponse, webDir: string, path: string) {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  let file = join(webDir, rel);
  if (!file.startsWith(webDir) || !existsSync(file)) file = join(webDir, "index.html");
  if (!existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("The web page has not been built. Run `npm run web:build`, or use `npm run web:dev` while developing.");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  // joined as bytes and decoded once: a character split across two chunks stays whole
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > limit) throw new UserError("Request body is too large", 413);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    throw new UserError("Request body is not valid JSON");
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new UserError(`${field} is required`);
  return v.trim();
}
