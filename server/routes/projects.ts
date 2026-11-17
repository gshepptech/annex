import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Store } from "../db.ts";
import type { Bureau, HttpOptions } from "../http.ts";
import { listSessions } from "../sessions.ts";
import * as P from "../projects.ts";
import * as F from "../files.ts";
import { expandHome } from "../paths.ts";
import { UserError, json, readJson, str } from "./respond.ts";
import { claudeTerminalIn, under } from "./inuse.ts";

// Folders Annex knows as yours: the ones you added, your offices' repos, the folders your recent
// sessions ran in and every git repo directly under ~/Projects, less those you forgot. Project
// actions only ever take one of these.
async function officeRepos(bureau: Bureau): Promise<string[]> {
  return (await bureau.state()).wings.map((w) => w.repo).filter((r): r is string => !!r);
}

async function projectFolders(bureau: Bureau, store: Store): Promise<string[]> {
  const sessions = listSessions({ limit: 30, withinMs: 30 * 86_400_000 }).map((s) => s.cwd);
  return P.knownProjects({ ...store.projectFolders(), offices: await officeRepos(bureau), seen: sessions });
}

export async function projectRoutes(req: IncomingMessage, res: ServerResponse, url: URL, opts: HttpOptions, bureau: Bureau): Promise<boolean> {
  const path = url.pathname;
  const known = await projectFolders(bureau, opts.store);
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
    case "/api/projects/clone": {
      const folder = await P.clone(str(b.url, "url"), typeof b.name === "string" ? b.name : null, typeof b.parent === "string" && b.parent.trim() ? expandHome(b.parent.trim()) : null);
      opts.store.addProjectFolder(folder);
      return (json(res, 201, { folder }), true);
    }
    // adding, forgetting and making projects change only Annex's list (and a new folder's own files)
    case "/api/projects/add": {
      const folder = P.existingFolder(expandHome(str(b.path, "path")));
      opts.store.addProjectFolder(folder);
      return (json(res, 201, { folder }), true);
    }
    case "/api/projects/forget": {
      const folder = expandHome(str(b.path, "path")).replace(/(.)\/+$/, "$1");
      if ((await officeRepos(bureau)).includes(folder)) throw new P.ProjectError("An office works in that folder, so it stays while the office does");
      opts.store.forgetProjectFolder(folder);
      return (json(res, 200, { ok: true }), true);
    }
    case "/api/projects/create": {
      const folder = await P.createProject(expandHome(str(b.parent, "parent")), str(b.name, "name"));
      opts.store.addProjectFolder(folder);
      return (json(res, 201, { folder }), true);
    }
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
