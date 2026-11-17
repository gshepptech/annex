import type { IncomingMessage, ServerResponse } from "node:http";
import { sessionTranscript, IDLE_MS, isReplying } from "../sessions.ts";
import { MODES, defaultMode, type LiveSessions, type Mode } from "../live.ts";
import type { Terminals } from "../terminals.ts";
import { expandHome } from "../paths.ts";
import { UserError, json, readJson, str } from "./respond.ts";
import { IN_TERMINAL } from "./inuse.ts";

// Live sessions. Starting one runs Claude in a folder you name, as you; resuming one waits until
// the session has been quiet long enough that it is not open in a terminal.
export async function liveRoutes(req: IncomingMessage, res: ServerResponse, url: URL, live: LiveSessions, terminals?: Terminals): Promise<boolean> {
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
      if (quiet < IDLE_MS && body.force !== true && !live.lastDrivenByAnnex(resume) && !terminals?.ranSession(resume)) throw new UserError("This session was active in the last few minutes and may be open in a terminal. Close it there, or wait a few minutes.", 409);
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
