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
  const path = join(home, ".claude", "plugins", "cache", "tavern", "smith", "1.0.0");
  mkdirSync(join(path, ".claude-plugin"), { recursive: true });
  mkdirSync(join(path, "commands"), { recursive: true });
  mkdirSync(join(path, "skills", "prove"), { recursive: true });
  writeFileSync(join(path, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "smith", mcpServers: { smith: { command: "uv" } } }));
  writeFileSync(join(path, "commands", "start.md"), "# start");
  writeFileSync(join(path, "skills", "prove", "SKILL.md"), "# prove");
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "smith@the-tavern": [{ installPath: path }] } }));
  return home;
}

test("an installed plugin is found with its MCP servers and commands", () => {
  const p = findPlugin("smith@the-tavern", fakeHome());
  assert.ok(p);
  assert.deepEqual(p.mcpServers, ["smith"]);
  assert.deepEqual(p.commands.sort(), ["smith:prove", "smith:start"]);
  assert.equal(findPlugin("sage@the-tavern", fakeHome()), null);
});

test("an office's plugins are enabled in its settings and their tools allowed for the crew", () => {
  const p = findPlugin("smith@the-tavern", fakeHome())!;
  const file = writeAgentSettings(mkdtempSync(join(tmpdir(), "annex-set-")), [p.id]);
  const settings = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(settings.enabledPlugins, { "smith@the-tavern": true });
  assert.ok(settings.permissions.deny.includes("Bash(git push:*)"));
  const wing = parseWing("w", 'name = "W"\nplugins = ["smith@the-tavern"]\n');
  assert.deepEqual(wing.plugins, ["smith@the-tavern"]);
  const tools = toolsFor("worker", wing, [p]);
  assert.ok(tools.includes(mcpRule("smith", "smith")));
  assert.ok(tools.includes("Agent"));
  assert.ok(!toolsFor("worker", wing).includes("Agent"));
});

test("a plugin entry must name its marketplace", () => {
  assert.throws(() => parseWing("w", 'name = "W"\nplugins = ["smith"]\n'), /smith@the-tavern/);
});
