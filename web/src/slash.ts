// Claude Code commands that only have an interactive screen (2.1.280: type "local-jsx" with no
// non-interactive twin, or marked terminal-only), so `claude -p` drops them from a live session.
// They run in a terminal instead.
export const TERMINAL_ONLY = ["config", "login", "logout", "doctor", "permissions", "resume", "memory", "hooks", "plugin", "status", "help", "export", "theme", "ide", "terminal-setup", "privacy-settings", "install-github-app", "keybindings", "workflows"];

// The command to open in a terminal, or null. A name the session itself lists still goes to it,
// except a bare /config (its -p twin needs key=value; the bare form is the settings screen).
export function needsTerminal(text: string, sessionCommands: string[]): string | null {
  const m = /^\/([\w:.-]+)(\s[\s\S]*)?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!;
  if (name === "config" && !m[2]?.trim()) return "/config";
  return TERMINAL_ONLY.includes(name) && !sessionCommands.includes(name) ? text.trim() : null;
}
