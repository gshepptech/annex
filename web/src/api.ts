import type { StateView, SessionView } from "../../server/api-types.ts";
import type { BourneEvent } from "../../server/events.ts";

// Annex's API key: handed over once in the link Annex opens (#key=...) or by a pairing link
// (#pair=...), then kept in this browser. Every API call carries it; agents on this machine do not have it.
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
export let key = readKey();
// the link opened in a tab that already shows Annex only changes the #; take the key and reload
addEventListener("hashchange", () => {
  if (/[#&]key=/.test(location.hash)) {
    readKey();
    location.reload();
  } else if (/[#&]pair=/.test(location.hash)) {
    void claimPairing().then(() => location.reload());
  }
});

// A pairing link (#pair=...) made in a browser that has the key: trade the one-time code for the
// key and keep it the way #key= does. The code leaves the address bar before anything else. Plain
// fetch, so a refused code does not read as a refused key.
export async function claimPairing(): Promise<"paired" | "failed" | null> {
  const m = /[#&]pair=([\w-]+)/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  const r = await fetch("/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: m[1] }) }).catch(() => null);
  if (!r?.ok) return "failed";
  const { key: k } = (await r.json()) as { key: string };
  try {
    localStorage.setItem(KEY_STORE, k);
  } catch {
    // storage refused: the key still works for this visit
  }
  key = k;
  return "paired";
}

// a one-time link for another browser; making a new one cancels the last
export async function makePairing(): Promise<{ code: string; expiresAt: string }> {
  return (await post("/api/pair")) as { code: string; expiresAt: string };
}

// Called when Annex refuses the key, so the page can say how to fix it.
let onMissingKey: () => void = () => {};
export function whenKeyMissing(fn: () => void) {
  onMissingKey = fn;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (key) headers.set("x-annex-key", key);
  const r = await fetch(path, { ...init, headers });
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

// a refusal Annex answers with extra fields (a save over a changed file says conflict: true)
export class ApiError extends Error {
  readonly status: number;
  readonly data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function get<T>(path: string): Promise<T> {
  const r = await apiFetch(path);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((d as { error?: string }).error ?? `Annex answered ${r.status}`, r.status, d as Record<string, unknown>);
  return d as T;
}

export async function put(path: string, body: unknown): Promise<unknown> {
  const r = await apiFetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((d as { error?: string }).error ?? `Annex answered ${r.status}`, r.status, d as Record<string, unknown>);
  return d;
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
