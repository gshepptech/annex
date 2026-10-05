import { test } from "node:test";
import assert from "node:assert/strict";
import { recordUsage, usage, usageFromRunLog } from "./usage.ts";

const info = (five: number, seven: number) => ({ status: "allowed", unifiedWindows: { five_hour: { utilization: five, resetsAt: 1791230400 }, seven_day: { utilization: seven, resetsAt: 1791694800 } } });

test("the newest usage figure wins, from a live session or an agent run's log", () => {
  recordUsage(info(0.04, 0.02), new Date("2026-10-05T10:00:00Z"));
  assert.equal(usage()!.fiveHour!.used, 0.04);
  assert.equal(usage()!.fiveHour!.resetsAt, new Date(1791230400 * 1000).toISOString());
  recordUsage(info(0.5, 0.5), new Date("2026-10-05T09:00:00Z"));
  assert.equal(usage()!.fiveHour!.used, 0.04, "an older figure read late does not replace a newer one");
  const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: info(0.31, 0.12) });
  const log = [JSON.stringify({ ts: "x", stream: "stdout", chunk: line.slice(0, 40) }), JSON.stringify({ ts: "x", stream: "stdout", chunk: line.slice(40) + "\n" })].join("\n");
  usageFromRunLog(log, new Date("2026-10-05T11:00:00Z"));
  assert.equal(usage()!.fiveHour!.used, 0.31, "a line split across log chunks is joined back");
  assert.equal(usage()!.sevenDay!.used, 0.12);
});
