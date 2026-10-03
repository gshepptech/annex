import type { StateView, SessionView } from "../../server/api-types.ts";
import type { BourneEvent } from "../../server/events.ts";

export async function getState(): Promise<StateView> {
  const r = await fetch("/api/state");
  if (!r.ok) throw new Error(`Annex's server answered ${r.status}`);
  return r.json();
}

export async function getSessions(): Promise<SessionView[]> {
  const r = await fetch("/api/sessions");
  if (!r.ok) throw new Error(`Annex's server answered ${r.status}`);
  return r.json();
}

export async function post(path: string, body: unknown = {}): Promise<unknown> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${r.status})`);
  return data;
}

// Server-sent events resume from the last id the browser saw, so a dropped connection loses nothing.
export function stream(after: number, onEvent: (e: BourneEvent) => void, onStatus: (connected: boolean) => void): () => void {
  let source: EventSource | null = null;
  let last = after;
  let closed = false;
  const open = () => {
    source = new EventSource(`/api/stream?after=${last}`);
    source.onopen = () => onStatus(true);
    source.onmessage = (m) => {
      const e = JSON.parse(m.data) as BourneEvent;
      last = Math.max(last, e.id);
      onEvent(e);
    };
    source.onerror = () => {
      onStatus(false);
      source?.close();
      if (!closed) setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    source?.close();
  };
}
