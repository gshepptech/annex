// A repo's own rules for agents: CLAUDE.md, .claude/CLAUDE.md and AGENTS.md at its root. The lead
// plans from outside the repo, so Annex reads these and puts them in front of it on every wake.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"];
const MAX_CHARS = 16_000;

export function readHouseRules(repoDir: string): { files: string[]; text: string } | null {
  const parts: string[] = [];
  const files: string[] = [];
  for (const f of FILES) {
    const p = join(repoDir, f);
    if (!existsSync(p)) continue;
    files.push(f);
    parts.push(`### ${f}\n\n${readFileSync(p, "utf8").trim()}`);
  }
  if (!parts.length) return null;
  const text = parts.join("\n\n");
  return { files, text: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n\n[cut here; read the rest in the repo]" : text };
}
