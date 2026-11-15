import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./db.ts";
import { Logger } from "./logger.ts";
import { Director, parseRoute, stripRoute, summarize, type Offices } from "./director.ts";
import type { Paperclip } from "./engine/paperclip.ts";
import type { StateView } from "./api-types.ts";

test("a route block is read, and stripped from what the person sees", () => {
  const body = 'Sending it to Upkeep.\n\n```annex-route\n[{"do":"drop_in","office":"upkeep","title":"Fix the README"}]\n```';
  assert.deepEqual(parseRoute(body).actions, [{ do: "drop_in", office: "upkeep", title: "Fix the README" }]);
  assert.equal(stripRoute(body), "Sending it to Upkeep.");
  assert.deepEqual(parseRoute("just talking").actions, []);
  assert.match(parseRoute("```annex-route\n{oops\n```").error!, /not valid JSON/);
});

test("the director sees one line per office, never a repo", () => {
  const state = { wings: [{ id: "upkeep", name: "Upkeep", mode: "autonomous", held: null, paused: false, offline: null, repo: "/home/me/Projects/shop", agents: [{ role: "worker", status: "running" }, { role: "lead", status: "idle" }], tasks: [{}], filedCount: 3, asks: [], charter: "Keep shop healthy.\n1. tests pass" }], director: null, lastEventId: 0, recent: [] } as unknown as StateView;
  const s = summarize(state);
  assert.equal(s.split("\n").length, 1);
  assert.match(s, /upkeep "Upkeep": on its own; ~\/Projects\/shop; crew 1, 1 working; 1 open, 3 verified/);
});

test("the director's reply is stored with what Annex did about it", async () => {
  const store = new Store(":memory:");
  store.ensureWing("director", "with_you");
  store.setChatIssue("director", "CHAT");
  const done: string[] = [];
  const offices: Offices = {
    async state() { return { wings: [], director: null, lastEventId: 0, recent: [], usage: null }; },
    async dropIn(w, t) { done.push(`drop ${w} ${t}`); },
    async addGoal(w, t) { done.push(`goal ${w} ${t}`); },
    async createWing(n) { done.push(`new ${n.id}`); },
    async hireFromOffice(w) { throw new Error(`${w} already has its most workers`); },
    pause(w) { done.push(`pause ${w}`); },
    resume() {},
    async comeBack() {},
  };
  const comments = [{ id: "c1", authorAgentId: "D", authorUserId: null, createdAt: "", body: 'On it.\n```annex-route\n[{"do":"drop_in","office":"upkeep","title":"Fix the README"},{"do":"add_goal","office":"upkeep","text":"QA test the app"},{"do":"hire","office":"upkeep"}]\n```' }];
  const pc = { comments: async () => comments } as unknown as Paperclip;
  const d = new Director({ store, pc, logger: new Logger(null, { quiet: true }), offices, claudeCommand: "claude", settingsFile: "/dev/null" });
  d.agentId = "D";
  await d.sync();
  await d.sync();
  assert.deepEqual(done, ["drop upkeep Fix the README", "goal upkeep QA test the app"]);
  const chat = d.chat();
  assert.equal(chat.length, 1, "stored once however often it is read");
  assert.match(chat[0]!.text, /On it\.\n✔ Dropped "Fix the README" into upkeep\n✔ Gave upkeep the goal "QA test the app"\n✖ Could not hire: upkeep already has its most workers/);
});
