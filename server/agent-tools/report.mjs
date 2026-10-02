#!/usr/bin/env node
// The one way a Annex agent reports back to Paperclip. It reads Paperclip's run variables inside
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
const res =
  action === "comment"
    ? await fetch(`${base}/api/issues/${issue}/comments`, { method: "POST", headers, body: JSON.stringify({ body }) })
    : await fetch(`${base}/api/issues/${issue}`, { method: "PATCH", headers, body: JSON.stringify({ status: action, comment: body }) });
const text = await res.text();
if (!res.ok) {
  console.error(`report.mjs: FAILED, Paperclip answered ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
const data = JSON.parse(text);
console.log(action === "comment" ? `posted comment ${data.id}` : `issue ${data.identifier ?? issue} is now ${data.status}`);
