// Claude Code signed out: what `claude -p` says then ("Not logged in · Please run /login", or an
// API error naming authentication). Read from the session's error, or from the last turn when that
// turn failed, so a reply that merely talks about logging in is not taken for it.

import type { Entry } from "../../server/api-types.ts";

const SIGNED_OUT = /not logged in|please run \/login|invalid api key|oauth token has (expired|been revoked)|authentication/i;

export function signedOut(entries: Entry[], error: string | null): boolean {
  if (error && SIGNED_OUT.test(error)) return true;
  let i = entries.length - 1;
  while (i >= 0 && entries[i]!.kind !== "done") i--;
  const done = entries[i];
  if (!done || done.kind !== "done" || !done.isError) return false;
  for (i--; i >= 0 && entries[i]!.kind !== "prompt"; i--) {
    const e = entries[i]!;
    if ((e.kind === "text" || e.kind === "error") && SIGNED_OUT.test(e.text)) return true;
  }
  return false;
}
