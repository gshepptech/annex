// Annex's own HTTP surface: the state snapshot, a resumable event stream, and the handful of
// things a person can do to a wing. Bound to loopback; there is no login because nothing here is
// reachable from another machine.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Store } from "./db.ts";
import type { StateView, WingEdit, NewWing, TranscriptView } from "./api-types.ts";

export interface Bureau {
  state(): Promise<StateView>;
  chat(wingId: string, text: string): Promise<void>;
  handoff(wingId: string): Promise<void>;
  approveBrief(wingId: string, briefId: number): Promise<void>;
  comeBack(wingId: string): Promise<void>;
  dropIn(wingId: string, title: string, detail: string): Promise<{ taskId: string }>;
  transcript(agentId: string): Promise<TranscriptView>;
  updateWing(wingId: string, edit: WingEdit): Promise<void>;
  createWing(n: NewWing): Promise<{ id: string }>;
  decideAsk(wingId: string, askId: number, approve: boolean): Promise<void>;
  pause(wingId: string): void;
  resume(wingId: string): void;
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

export function startHttp(opts: { bureau: Bureau; store: Store; port: number; webDir: string }): Promise<Server> {
  const { bureau, store, webDir } = opts;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/api/state") return json(res, 200, await bureau.state());
      if (req.method === "GET" && path === "/api/stream") return streamEvents(req, res, store, Number(url.searchParams.get("after") ?? 0));

      const agent = /^\/api\/agents\/([^/]+)\/transcript$/.exec(path);
      if (req.method === "GET" && agent) return json(res, 200, await bureau.transcript(decodeURIComponent(agent[1]!)));

      if (req.method === "POST" && path === "/api/wings") {
        const body = await readJson(req);
        return json(res, 201, await bureau.createWing({
          id: str(body.id, "id"),
          name: str(body.name, "name"),
          charter: typeof body.charter === "string" ? body.charter : undefined,
          repoPath: typeof body.repoPath === "string" ? body.repoPath : undefined,
          baseBranch: typeof body.baseBranch === "string" ? body.baseBranch : undefined,
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
      if (err instanceof UserError) return json(res, err.status, { error: err.message });
      console.error("[annex] request failed", err);
      return json(res, 500, { error: `Annex hit an error: ${(err as Error).message}` });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
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

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new UserError("Request body is too large", 413);
  }
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
