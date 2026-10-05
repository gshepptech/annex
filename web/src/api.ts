import type { StateView, SessionView } from "../../server/api-types.ts";
import type { BourneEvent } from "../../server/events.ts";

// Annex's API key: handed over once in the link Annex opens (#key=...), then kept in this
// browser. Every API call carries it; agents on this machine do not have it.
const KEY_STORE = "annex-key";
function readKey(): string | null {
  const m = /[#&]key=([\w-]+)/.exec(location.hash);
  if (m) {
    try {
      localStorage.setItem(KEY_STORE, m[1]!);
    } catch {
      // storage refused: the key still works for this visit
    }
    history.replaceState(null, "", location.pathname + location.search);
    return m[1]!;
  }
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}
export const key = readKey();

// Called when Annex refuses the key, so the page can say how to fix it.
let onMissingKey: () => void = () => {};
export function whenKeyMissing(fn: () => void) {
  onMissingKey = fn;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (key) headers.set("x-annex-key", key);
  const r = await apiFetch(path, { ...init, headers });
  if (r.status === 401) onMissingKey();
  return r;
}

export function withKey(url: string): string {
  return key ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}` : url;
}

export async function getState(): Promise<StateView> {
  const r = await apiFetch("/api/state");
  if (!r.ok) throw new Error(`Annex's server answered ${r.status}`);
  return r.json();
}

export async function getSessions(): Promise<SessionView[]> {
  const r = await apiFetch("/api/sessions");
  if (!r.ok) throw new Error(`Annex's server answered ${r.status}`);
  return r.json();
}

export async function post(path: string, body: unknown = {}): Promise<unknown> {
  const r = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
    source = new EventSource(withKey(`/api/stream?after=${last}`));
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
