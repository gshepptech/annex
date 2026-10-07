#!/usr/bin/env node
// The one way an Annex agent reports back to Paperclip. It reads Paperclip's run variables inside
// Node, so the agent's shell command never needs `$VAR` expansion (which Claude Code will not run
// without a person to approve it), and it confirms the write actually landed.
//
//   node report.mjs done <<'MD'            mark the current task done, with a comment
//   node report.mjs in_progress <<'MD'     send it back (reviewers), with the reason
//   node report.mjs blocked <<'MD'         say what stopped you
//   node report.mjs comment <<'MD'         post a comment without changing the status

const [action = "", issueArg] = process.argv.slice(2);
const allowed = ["done", "in_progress", "blocked", "comment"];
if (!allowed.includes(action)) {
  console.error(`usage: node report.mjs <${allowed.join("|")}> [issue-id] <<'MD' ... MD`);
  process.exit(2);
}

const base = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/$/, "").replace(/\/api$/, "");
const key = process.env.PAPERCLIP_API_KEY;
const issue = issueArg ?? process.env.PAPERCLIP_TASK_ID;
if (!base || !key || !issue) {
  console.error("report.mjs: PAPERCLIP_API_URL, PAPERCLIP_API_KEY or the task id is missing from this run");
  process.exit(2);
}

let body = "";
for await (const chunk of process.stdin) body += chunk;
body = body.trim();
if (!body) {
  console.error("report.mjs: write the comment on stdin, e.g. with <<'MD' ... MD");
  process.exit(2);
}

const headers = {
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
  ...(process.env.PAPERCLIP_RUN_ID ? { "x-paperclip-run-id": process.env.PAPERCLIP_RUN_ID } : {}),
};
// Inside Claude Code's sandbox an agent cannot connect to localhost directly; its traffic goes
// through the sandbox's proxy (HTTP_PROXY), which lets through only the hosts Annex allowed, here
// the engine's own address. Outside the sandbox (no proxy) the request goes straight there.
import { request } from "node:http";

function send(method, url, payload) {
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const target = new URL(url);
  const via = proxy ? new URL(proxy) : null;
  return new Promise((resolve, reject) => {
    // the sandbox proxy names its credentials in the HTTP_PROXY address itself
    const auth = via?.username ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(via.username)}:${decodeURIComponent(via.password)}`).toString("base64")}` } : {};
    const req = request(
      via
        ? { host: via.hostname, port: via.port || 80, method, path: target.href, headers: { ...headers, ...auth, host: target.host } }
        : { host: target.hostname, port: target.port || 80, method, path: target.pathname + target.search, headers },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

const res =
  action === "comment"
    ? await send("POST", `${base}/api/issues/${issue}/comments`, { body })
    : await send("PATCH", `${base}/api/issues/${issue}`, { status: action, comment: body });
const text = res.text;
if (res.status < 200 || res.status >= 300) {
  console.error(`report.mjs: FAILED, Paperclip answered ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
const data = JSON.parse(text);
console.log(action === "comment" ? `posted comment ${data.id}` : `issue ${data.identifier ?? issue} is now ${data.status}`);
