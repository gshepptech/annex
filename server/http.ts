// Annex's own HTTP surface: the state snapshot, a resumable event stream, and the handful of
// things a person can do to a wing. Bound to loopback; every API call carries Annex's key, which a
// browser gets from `npm run open` or by pairing with one that already has it. Live sessions,
// terminals, app runs and projects have their own route files under routes/.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Store } from "./db.ts";
import type { Logger } from "./logger.ts";
import type { StateView, WingEdit, NewWing, TranscriptView } from "./api-types.ts";
import { listSessions, sessionTranscript, replyToSession, SessionBusy } from "./sessions.ts";
import { health } from "./upkeep.ts";
import { RunError, type Runner } from "./runner.ts";
import * as P from "./projects.ts";
import { sameKey } from "./key.ts";
import { Pairing } from "./pair.ts";
import { LiveError, type LiveSessions } from "./live.ts";
import { TerminalError, type Terminals } from "./terminals.ts";
import { setupChecker, type SetupCheck } from "./setup.ts";
import { UserError, json, readJson, str } from "./routes/respond.ts";
import { IN_TERMINAL, claudeTerminalIn, under } from "./routes/inuse.ts";
import { liveRoutes } from "./routes/live.ts";
import { projectRoutes } from "./routes/projects.ts";
import { runRoutes } from "./routes/run.ts";
import { terminalRoutes } from "./routes/terminals.ts";

export { UserError };

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

export interface HttpOptions {
  bureau: Bureau;
  store: Store;
  logger?: Logger;
  port: number;
  webDir: string;
  claudeCommand?: string;
  engineUrl?: string;
  startedAt?: Date;
  live?: LiveSessions;
  key?: string;
  runner?: Runner;
  backupsDir?: string;
  terminals?: Terminals;
  pairing?: Pairing;
  setup?: (fresh?: boolean) => Promise<SetupCheck[]>;
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

export function startHttp(opts: HttpOptions): Promise<Server> {
  const { bureau, store, webDir, logger } = opts;
  const pairing = opts.pairing ?? new Pairing();
  const setup = opts.setup ?? setupChecker();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const refused = refuseForeign(req);
      if (refused) return json(res, 403, { error: refused });
      // every API call carries the key, except the health check and the live sessions' own
      // permission channel, which has its own token, and a pairing claim, which carries a one-time
      // code instead; an event stream passes it in the query because EventSource cannot send headers
      if (opts.key && path.startsWith("/api/") && path !== "/api/health" && !/^\/api\/live\/[0-9a-f-]{36}\/permission$/.test(path) && !(req.method === "POST" && path === "/api/pair/claim")) {
        const given = (req.headers["x-annex-key"] as string | undefined) ?? url.searchParams.get("key");
        if (!sameKey(given, opts.key)) return json(res, 401, { error: "Annex needs its key. Run `npm run open`, or pair this browser from one that has Annex open (Pair a browser in the top bar)." });
      }

      if (req.method === "GET" && path === "/api/state") return json(res, 200, await bureau.state());
      // first-run setup: Claude Code, its login, git and GitHub; ?fresh=1 is "Check again"
      if (req.method === "GET" && path === "/api/setup") return json(res, 200, await setup(url.searchParams.get("fresh") === "1"));
      // a pairing link for another browser on this machine; the code and the key are never logged
      if (req.method === "POST" && path === "/api/pair") {
        if (!opts.key) throw new UserError("Annex has no key, so there is nothing to pair", 404);
        logger?.info(null, "made a pairing link (works once, for five minutes)");
        return json(res, 201, pairing.mint());
      }
      if (req.method === "POST" && path === "/api/pair/claim") {
        const body = await readJson(req, 4096);
        // expired, used, wrong or absent all get the same answer, so it cannot test guesses
        if (!opts.key || !pairing.claim(body.code)) {
          logger?.warn(null, "a pairing link was refused (expired, used or wrong)");
          throw new UserError("This pairing link has expired or was already used. Make a new one in a browser that has Annex open (Pair a browser in the top bar).", 410);
        }
        logger?.info(null, "paired a browser");
        return json(res, 200, { key: opts.key }, { "cache-control": "no-store" });
      }
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
