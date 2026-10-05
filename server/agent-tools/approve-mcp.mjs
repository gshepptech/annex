#!/usr/bin/env node
// The permission prompt tool for Annex's live sessions: a minimal MCP server on stdio with one
// tool, "approve". Claude Code calls it whenever a tool needs your yes; it asks Annex, which holds
// the question until you answer in the browser, and passes the answer back. It knows only its own
// live session (BOURNE_LIVE) and proves it was started by Annex with BOURNE_TOKEN.

const { BOURNE_URL, BOURNE_LIVE, BOURNE_TOKEN } = process.env;
let buf = "";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, text) => out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });

// node:http, not fetch: fetch gives up on a response after five minutes, and a person may take
// longer than that to answer. Anything that goes wrong is a no.
import { request } from "node:http";

function ask(args) {
  return new Promise((resolve) => {
    const deny = (message) => resolve({ behavior: "deny", message });
    let req;
    try {
      req = request(`${BOURNE_URL}/api/live/${BOURNE_LIVE}/permission`, { method: "POST", headers: { "content-type": "application/json", "x-annex-token": BOURNE_TOKEN } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            const d = JSON.parse(body);
            if (res.statusCode !== 200) return deny(d.error ?? `Annex answered ${res.statusCode}`);
            resolve(d.allow === true ? { behavior: "allow", updatedInput: args.input ?? {} } : { behavior: "deny", message: d.message ? `The person said no, so do not do it and do not say it was done. Their reason: ${d.message}` : "The person said no, so do not do it and do not say it was done." });
          } catch {
            deny("Annex's answer could not be read.");
          }
        });
        res.on("error", () => deny("The connection to Annex broke."));
      });
    } catch (err) {
      return deny(`Could not reach Annex to ask the person: ${err.message}`);
    }
    req.on("error", (err) => deny(`Could not reach Annex to ask the person: ${err.message}`));
    req.end(JSON.stringify({ tool: args.tool_name, input: args.input ?? {} }));
  });
}

process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.method === "initialize") {
      out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bourne_live", version: "1" } } });
    } else if (m.method === "tools/list") {
      out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "approve", description: "Asks the person in Annex whether a tool may run.", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] } }] } });
    } else if (m.method === "tools/call") {
      void ask(m.params?.arguments ?? {}).then((d) => reply(m.id, JSON.stringify(d)));
    } else if (m.id !== undefined) {
      out({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  }
});
