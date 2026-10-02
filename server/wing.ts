// A wing is defined by wings/<id>/wing.toml. This file is the whole extension point: a new kind
// of work is a new wing file, with no code change (design D10).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "smol-toml";

import type { Mode } from "./api-types.ts";
export type { Mode };

export interface Signal {
  name: string;
  run: string;
}

export interface QuietHours {
  startMin: number;
  endMin: number;
}

export interface WingSettings {
  wakeEverySec: number;
  maxRunsPerHour: number | null;
  quietHours: QuietHours | null;
  backOffWhenIdle: boolean;
  askBefore: string[];
}

export interface Repo {
  path: string;
  baseBranch: string;
  integrationBranch: string;
}

export interface Crew {
  leadModel: string;
  workerModel: string;
  reviewerModel: string;
  workers: number;
}

export interface Wing {
  id: string;
  name: string;
  initialMode: Mode;
  charter: string;
  repo: Repo | null;
  signals: Signal[];
  doneCheck: string | null;
  // run in a fresh worktree before its checks and signals, e.g. "npm ci"
  setup: string | null;
  crew: Crew;
  settings: WingSettings;
  allow: string[];
}

export class WingFileError extends Error {}

const DEFAULT_MODEL = "claude-sonnet-5";

export function loadWings(dir: string): Wing[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "wing.toml")))
    .map((e) => parseWing(e.name, readFileSync(join(dir, e.name, "wing.toml"), "utf8")))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function parseWing(id: string, source: string): Wing {
  let raw: Record<string, unknown>;
  try {
    raw = parse(source);
  } catch (err) {
    throw new WingFileError(`wings/${id}/wing.toml is not valid TOML: ${(err as Error).message}`);
  }
  const at = (field: string) => `wings/${id}/wing.toml: ${field}`;

  const name = str(raw.name, at("name")) ?? id;
  const mode = str(raw.mode, at("mode")) ?? "with_you";
  if (mode !== "with_you" && mode !== "autonomous") {
    throw new WingFileError(`${at("mode")} must be "with_you" or "autonomous", got "${mode}"`);
  }
  const charter = (str(raw.charter, at("charter")) ?? "").trim();
  if (mode === "autonomous" && !charter) {
    throw new WingFileError(`${at("charter")} is required when mode is "autonomous"`);
  }

  const repoRaw = table(raw.repo, at("repo"));
  const repo: Repo | null = repoRaw
    ? {
        path: expandHome(required(str(repoRaw.path, at("repo.path")), at("repo.path"))),
        baseBranch: str(repoRaw.base_branch, at("repo.base_branch")) ?? "main",
        integrationBranch: str(repoRaw.integration_branch, at("repo.integration_branch")) ?? `annex/${id}`,
      }
    : null;
  if (mode === "autonomous" && !repo) {
    throw new WingFileError(`${at("repo")} is required when mode is "autonomous"`);
  }

  const signalsRaw = raw.signals ?? [];
  if (!Array.isArray(signalsRaw)) throw new WingFileError(`${at("signals")} must be an array of tables`);
  const signals = signalsRaw.map((s, i) => {
    const t = required(table(s, at(`signals[${i}]`)), at(`signals[${i}]`));
    return {
      name: required(str(t.name, at(`signals[${i}].name`)), at(`signals[${i}].name`)),
      run: required(str(t.run, at(`signals[${i}].run`)), at(`signals[${i}].run`)),
    };
  });

  const crewRaw = table(raw.crew, at("crew")) ?? {};
  const workers = num(crewRaw.workers, at("crew.workers")) ?? 2;
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
    throw new WingFileError(`${at("crew.workers")} must be a whole number from 1 to 8`);
  }
  const crew: Crew = {
    leadModel: str(crewRaw.lead_model, at("crew.lead_model")) ?? DEFAULT_MODEL,
    workerModel: str(crewRaw.worker_model, at("crew.worker_model")) ?? DEFAULT_MODEL,
    reviewerModel: str(crewRaw.reviewer_model, at("crew.reviewer_model")) ?? DEFAULT_MODEL,
    workers,
  };

  const s = table(raw.settings, at("settings")) ?? {};
  const maxRuns = s.max_runs_per_hour;
  const settings: WingSettings = {
    wakeEverySec: parseDuration(str(s.wake_every, at("settings.wake_every")) ?? "15m", at("settings.wake_every")),
    maxRunsPerHour: maxRuns === undefined || maxRuns === "off" ? null : positiveInt(maxRuns, at("settings.max_runs_per_hour")),
    quietHours: parseQuietHours(s.quiet_hours, at("settings.quiet_hours")),
    backOffWhenIdle: bool(s.back_off_when_idle, at("settings.back_off_when_idle")) ?? false,
    askBefore: strList(s.ask_before, at("settings.ask_before")),
  };

  const perms = table(raw.permissions, at("permissions")) ?? {};

  return {
    id,
    name,
    initialMode: mode,
    charter,
    repo,
    signals,
    doneCheck: str(raw.done_check, at("done_check")) ?? null,
    setup: str(raw.setup, at("setup")) ?? null,
    crew,
    settings,
    allow: strList(perms.allow, at("permissions.allow")),
  };
}

export function parseDuration(text: string, field = "duration"): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!m || text.trim() === "") throw new WingFileError(`${field} must look like "15m", "1h" or "1h30m", got "${text}"`);
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  if (sec < 60) throw new WingFileError(`${field} must be at least 1m`);
  return sec;
}

function parseQuietHours(value: unknown, field: string): QuietHours | null {
  if (value === undefined || value === "off" || value === "") return null;
  if (typeof value !== "string") throw new WingFileError(`${field} must be a string like "00:00-07:00" or "off"`);
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new WingFileError(`${field} must look like "00:00-07:00", got "${value}"`);
  const [h1, m1, h2, m2] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) throw new WingFileError(`${field} has an impossible time: "${value}"`);
  return { startMin: h1 * 60 + m1, endMin: h2 * 60 + m2 };
}

// A window that crosses midnight ("22:00-06:00") is quiet before the end or after the start.
export function inQuietHours(q: QuietHours | null, date: Date): boolean {
  if (!q) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return q.startMin <= q.endMin ? now >= q.startMin && now < q.endMin : now >= q.startMin || now < q.endMin;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function str(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new WingFileError(`${field} must be a string`);
  return v;
}

function num(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number") throw new WingFileError(`${field} must be a number`);
  return v;
}

function positiveInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new WingFileError(`${field} must be a whole number of 1 or more, or "off"`);
  }
  return v;
}

function bool(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new WingFileError(`${field} must be true or false`);
  return v;
}

function strList(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new WingFileError(`${field} must be a list of strings`);
  return v as string[];
}

function table(v: unknown, field: string): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new WingFileError(`${field} must be a table`);
  return v as Record<string, unknown>;
}

function required<T>(v: T | undefined, field: string): T {
  if (v === undefined) throw new WingFileError(`${field} is required`);
  return v;
}
