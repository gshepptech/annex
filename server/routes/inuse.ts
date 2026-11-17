// Whether a checkout is in use by something running in it right now.

import type { Terminals } from "../terminals.ts";

export const IN_TERMINAL = "This conversation is open in a terminal in Annex. Close that terminal first.";

export function under(folder: string, root: string): boolean {
  return folder === root || folder.startsWith(`${root}/`);
}

// Claude running in an Annex terminal in that checkout; a plain shell does not count, as a
// terminal app's would not.
export function claudeTerminalIn(terms: Terminals | undefined, root: string): boolean {
  return !!terms?.list().some((t) => t.kind === "claude" && t.status === "running" && under(t.cwd, root));
}
