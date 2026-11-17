import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import type { LiveSessions } from "../live.ts";
import { isReplying } from "../sessions.ts";
import type { Terminals } from "../terminals.ts";
import { expandHome } from "../paths.ts";
import { UserError, json, readJson } from "./respond.ts";

// Terminals: your login shell in a folder, or a conversation moved out of a live session into
// `claude --resume`. Output streams as events whose id is an offset into what the terminal printed,
// so a browser that reconnects (it sends Last-Event-ID by itself) gets only what it missed.
export async function terminalRoutes(req: IncomingMessage, res: ServerResponse, url: URL, terms: Terminals, live?: LiveSessions): Promise<boolean> {
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
    // a setup fix, named by its id; the command comes from setup.ts, never from the request
    if (typeof body.setup === "string") return (json(res, 201, terms.open({ cwd: homedir(), setup: body.setup })), true);
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
