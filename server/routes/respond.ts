// Request and reply helpers every route shares: the error a person sees, JSON in and out, and a
// required string field.

import type { IncomingMessage, ServerResponse } from "node:http";

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  // joined as bytes and decoded once: a character split across two chunks stays whole
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > limit) throw new UserError("Request body is too large", 413);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    throw new UserError("Request body is not valid JSON");
  }
}

export function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new UserError(`${field} is required`);
  return v.trim();
}
