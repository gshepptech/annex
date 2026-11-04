// Choosing a folder. Inside Annex.app the page asks the app, which shows the Mac's own folder panel
// (app/main.swift) and answers through window.annexPicked; a plain browser has no such panel, so
// there the folder is typed into a field and `canPickFolder` is false.

type Bridge = { postMessage(m: unknown): void };
const bridge = (window as { webkit?: { messageHandlers?: { annex?: Bridge } } }).webkit?.messageHandlers?.annex;

export const canPickFolder = !!bridge;

const waiting = new Map<number, (path: string | null) => void>();
let next = 0;
(window as { annexPicked?: (id: number, path: string | null) => void }).annexPicked = (id, path) => {
  waiting.get(id)?.(path);
  waiting.delete(id);
};

// The folder chosen, or null when the panel was cancelled (or there is no panel here).
export function pickFolder(): Promise<string | null> {
  if (!bridge) return Promise.resolve(null);
  const id = ++next;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    bridge.postMessage({ kind: "pickFolder", id });
  });
}
