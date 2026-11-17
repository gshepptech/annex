import type { IncomingMessage, ServerResponse } from "node:http";
import type { Bureau } from "../http.ts";
import type { Runner } from "../runner.ts";
import { expandHome } from "../paths.ts";
import { UserError, json, readJson } from "./respond.ts";

// Running the app. A folder is one of yours (any folder you name, as in a terminal); an office runs
// in its preview checkout, never in the worktree Annex merges in.
export async function runRoutes(req: IncomingMessage, res: ServerResponse, url: URL, runner: Runner, bureau: Bureau): Promise<boolean> {
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
