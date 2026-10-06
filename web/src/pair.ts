// PAIR A BROWSER: a one-time link that gives another browser on this computer Annex's key, so it
// needs no `npm run open`. Each opening makes a new link and the earlier one stops working.

import { h } from "./dom.ts";
import { makePairing } from "./api.ts";

export function pairDialog() {
  const link = h("input", { class: "pair-link", readonly: true, "aria-label": "Pairing link", onfocus: () => link.select() }) as HTMLInputElement;
  const until = h("p", {});
  const err = h("p", { class: "bad" });
  const copy = h("button", { class: "btn primary", type: "button", onclick: async () => { await navigator.clipboard?.writeText(link.value).catch(() => {}); copy.textContent = "Copied"; } }, "Copy link");
  const el = h("dialog", { "aria-label": "Pair a browser" }) as HTMLDialogElement;

  const make = async () => {
    link.value = "";
    until.textContent = "Making a link…";
    err.textContent = "";
    copy.textContent = "Copy link";
    try {
      const { code, expiresAt } = await makePairing();
      // localStorage is per origin: the new browser has to open the address this one uses
      link.value = `${location.origin}/#pair=${code}`;
      const at = new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      until.textContent = `Open this link in another browser on this computer. It gives that browser Annex's key, works once, and stops working at ${at}.`;
    } catch (e) {
      until.textContent = "";
      err.textContent = `Could not make a link: ${(e as Error).message}`;
    }
  };

  el.append(
    h(
      "div",
      { class: "pad" },
      h("h2", {}, "Pair a browser"),
      until,
      link,
      h("div", { class: "row" }, copy, h("button", { class: "btn", type: "button", onclick: () => void make() }, "Make a new link"), h("button", { class: "btn", type: "button", onclick: () => el.close() }, "Close")),
      err,
    ),
  );

  return {
    el,
    open() {
      el.showModal();
      void make();
    },
  };
}
