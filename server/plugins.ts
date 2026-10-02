// Claude Code plugins an office may use. Agents never load the person's own settings, so a plugin
// reaches them only when the wing file names it; Annex then enables it in that office's agent
// settings and allows its MCP tools. The plugin must already be installed for the person.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

export interface PluginInfo {
  // "name@marketplace", as Claude Code names it
  id: string;
  name: string;
  path: string;
  // MCP server names the plugin starts
  mcpServers: string[];
  // its commands and skills, as "name:command"
  commands: string[];
}

export const PLUGIN_ID = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function serverNames(v: unknown, root: string): string[] {
  if (typeof v === "string") return serverNames(readJson(join(root, v)), root);
  if (!v || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  // either { mcpServers: {...} } or the map of servers itself
  const servers = o.mcpServers && typeof o.mcpServers === "object" ? (o.mcpServers as Record<string, unknown>) : o;
  return Object.keys(servers);
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Where Claude Code installed the plugin, and what it brings. Null when it is not installed.
export function findPlugin(id: string, home = homedir()): PluginInfo | null {
  const registry = readJson(join(home, ".claude", "plugins", "installed_plugins.json")) as { plugins?: Record<string, { installPath?: string }[]> } | null;
  const path = registry?.plugins?.[id]?.map((i) => i.installPath).find((p): p is string => !!p && existsSync(p));
  if (!path) return null;
  const name = id.split("@")[0]!;
  const manifest = readJson(join(path, ".claude-plugin", "plugin.json")) as { mcpServers?: unknown } | null;
  const mcpServers = [...new Set([...serverNames(manifest?.mcpServers, path), ...serverNames(readJson(join(path, ".mcp.json")), path)])];
  const commands = [
    ...entries(join(path, "commands")).filter((f) => f.endsWith(".md")).map((f) => basename(f, ".md")),
    ...entries(join(path, "skills")).filter((d) => existsSync(join(path, "skills", d, "SKILL.md"))),
  ];
  return { id, name, path, mcpServers, commands: [...new Set(commands)].map((c) => `${name}:${c}`) };
}

// The permission rule that allows every tool of one of a plugin's MCP servers.
export function mcpRule(plugin: string, server: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__plugin_${safe(plugin)}_${safe(server)}`;
}
