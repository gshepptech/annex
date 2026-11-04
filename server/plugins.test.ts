import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPlugin, mcpRule } from "./plugins.ts";
import { toolsFor, writeAgentSettings } from "./provision.ts";
import { parseWing } from "./wing.ts";
import { readFileSync } from "node:fs";

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "annex-plug-"));
  const path = join(home, ".claude", "plugins", "cache", "acme", "lint-kit", "1.0.0");
  mkdirSync(join(path, ".claude-plugin"), { recursive: true });
  mkdirSync(join(path, "commands"), { recursive: true });
  mkdirSync(join(path, "skills", "prove"), { recursive: true });
  writeFileSync(join(path, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "lint-kit", mcpServers: { "lint-kit": { command: "uv" } } }));
  writeFileSync(join(path, "commands", "start.md"), "# start");
  writeFileSync(join(path, "skills", "prove", "SKILL.md"), "# prove");
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "lint-kit@acme": [{ installPath: path }] } }));
  return home;
}

test("an installed plugin is found with its MCP servers and commands", () => {
  const p = findPlugin("lint-kit@acme", fakeHome());
  assert.ok(p);
  assert.deepEqual(p.mcpServers, ["lint-kit"]);
  assert.deepEqual(p.commands.sort(), ["lint-kit:prove", "lint-kit:start"]);
  assert.equal(findPlugin("docs-kit@acme", fakeHome()), null);
});

test("an office's plugins are enabled in its settings and their tools allowed for the crew", () => {
  const p = findPlugin("lint-kit@acme", fakeHome())!;
  const file = writeAgentSettings(mkdtempSync(join(tmpdir(), "annex-set-")), [p.id]);
  const settings = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(settings.enabledPlugins, { "lint-kit@acme": true });
  assert.ok(settings.permissions.deny.includes("Bash(git push:*)"));
  const wing = parseWing("w", 'name = "W"\nplugins = ["lint-kit@acme"]\n');
  assert.deepEqual(wing.plugins, ["lint-kit@acme"]);
  const tools = toolsFor("worker", wing, [p]);
  assert.ok(tools.includes(mcpRule("lint-kit", "lint-kit")));
  assert.ok(tools.includes("Agent"));
  assert.ok(!toolsFor("worker", wing).includes("Agent"));
});

test("a plugin entry must name its marketplace", () => {
  assert.throws(() => parseWing("w", 'name = "W"\nplugins = ["lint-kit"]\n'), /lint-kit@acme/);
});
