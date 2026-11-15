// Every call Annex makes to Paperclip lives in this file. Request bodies are the
// ones Annex was tested against. Types cover only the fields Annex reads.

export const BOARD_USER_ID = "local-board";

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";

export interface Principal {
  type: "agent" | "user";
  agentId: string | null;
  userId: string | null;
}

export interface ExecutionState {
  status: "idle" | "pending" | "changes_requested" | "completed";
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: string | null;
  currentParticipant: Principal | null;
  returnAssignee: Principal | null;
  lastDecisionOutcome: "approved" | "changes_requested" | null;
  changesRequestedCount: number;
}

export interface Issue {
  id: string;
  identifier: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  status: IssueStatus;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionState: ExecutionState | null;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
  reportsTo: string | null;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
}

export interface ExecutionWorkspace {
  id: string;
  sourceIssueId: string | null;
  cwd: string;
  branchName: string | null;
  baseRef: string | null;
  status: string;
}

export interface Run {
  id: string;
  agentId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  invocationSource: string;
  errorCode: string | null;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface Frame {
  id: string | number;
  companyId: string;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface AgentSpec {
  name: string;
  role: "ceo" | "engineer" | "qa" | "general";
  title: string;
  reportsTo?: string;
  model: string;
  instructions: string;
  claudeCommand: string;
  // Claude settings file that hides the person's global CLAUDE.md and auto-memory
  settingsFile: string;
  allowedTools: string[];
  maxConcurrentRuns?: number;
  // directories outside its working directory the agent may read (the lead reads the repo)
  readDirs?: string[];
}

export class EngineError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class Paperclip {
  readonly base: string;

  constructor(base = "http://127.0.0.1:3100") {
    this.base = base.replace(/\/$/, "");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new EngineError(`Paperclip is not reachable at ${this.base}: ${(err as Error).message}`, 0);
    }
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? text.slice(0, 300);
      throw new EngineError(`Paperclip ${method} ${path} answered ${res.status}: ${msg}`, res.status);
    }
    return data as T;
  }

  health() {
    return this.call<{ status: string; version: string }>("GET", "/api/health");
  }

  enableExperiments() {
    return this.call("PATCH", "/api/instance/settings/experimental", { enableIsolatedWorkspaces: true, enableAgentChat: true });
  }

  companies() {
    return this.call<{ id: string; name: string; issuePrefix: string }[]>("GET", "/api/companies");
  }

  createCompany(name: string, description: string) {
    return this.call<{ id: string; name: string; issuePrefix: string }>("POST", "/api/companies", { name, description });
  }

  async createProject(companyId: string, p: { name: string; repo: string; baseRef: string; branchTemplate: string; worktreeDir: string }) {
    const project = await this.call<{ id: string }>("POST", `/api/companies/${companyId}/projects`, {
      name: p.name,
      status: "in_progress",
      workspace: { name: p.name, sourceType: "local_path", cwd: p.repo, isPrimary: true },
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        allowIssueOverride: false,
        workspaceStrategy: { type: "git_worktree", baseRef: p.baseRef, branchTemplate: p.branchTemplate, worktreeParentDir: p.worktreeDir },
      },
    });
    const workspaces = await this.call<{ id: string }[]>("GET", `/api/projects/${project.id}/workspaces`);
    return { projectId: project.id, workspaceId: workspaces[0]?.id ?? null };
  }

  projects(companyId: string) {
    return this.call<{ id: string; name: string }[]>("GET", `/api/companies/${companyId}/projects`);
  }

  createAgent(companyId: string, a: AgentSpec) {
    return this.call<Agent>("POST", `/api/companies/${companyId}/agents`, {
      name: a.name,
      role: a.role,
      title: a.title,
      ...(a.reportsTo ? { reportsTo: a.reportsTo } : {}),
      adapterType: "claude_local",
      ...agentConfig(a),
    });
  }

  // Brings an existing agent's instructions and run settings up to date with its wing file. The
  // agent PATCH accepts `instructionsBundle` but ignores it, so the file is written through its own
  // route and read back.
  async syncAgent(id: string, a: AgentSpec) {
    const { instructionsBundle: _, ...config } = agentConfig(a);
    await this.call<Agent>("PATCH", `/api/agents/${id}`, { title: a.title, ...config });
    await this.call("PUT", `/api/agents/${id}/instructions-bundle/file`, { path: "AGENTS.md", content: a.instructions });
    const stored = await this.call<{ content: string }>("GET", `/api/agents/${id}/instructions-bundle/file?path=AGENTS.md`);
    if (stored.content !== a.instructions) throw new EngineError(`Paperclip did not store the new instructions for agent ${id}`, 0);
  }

  agents(companyId: string) {
    return this.call<Agent[]>("GET", `/api/companies/${companyId}/agents`);
  }

  patchAgent(id: string, patch: Record<string, unknown>) {
    return this.call<Agent>("PATCH", `/api/agents/${id}`, patch);
  }

  createIssue(companyId: string, i: {
    title: string;
    description: string;
    projectId: string | null;
    assigneeAgentId: string;
    parentId?: string;
    // reviewers in order; each must approve before the next sees the issue
    reviewStages?: Principal[];
    priority?: "critical" | "high" | "medium" | "low";
  }) {
    return this.call<Issue>("POST", `/api/companies/${companyId}/issues`, {
      title: i.title,
      description: i.description,
      status: "todo",
      priority: i.priority ?? "medium",
      ...(i.projectId ? { projectId: i.projectId } : {}),
      ...(i.parentId ? { parentId: i.parentId } : {}),
      assigneeAgentId: i.assigneeAgentId,
      ...(i.reviewStages?.length
        ? {
            executionPolicy: {
              mode: "normal",
              commentRequired: true,
              stages: i.reviewStages.map((p) => ({
                type: "review",
                participants: [p.type === "agent" ? { type: "agent", agentId: p.agentId } : { type: "user", userId: p.userId }],
              })),
            },
          }
        : {}),
    });
  }

  issue(id: string) {
    return this.call<Issue>("GET", `/api/issues/${id}`);
  }

  issues(companyId: string) {
    return this.call<Issue[]>("GET", `/api/companies/${companyId}/issues?limit=500`);
  }

  // A status change with a comment. Reviews are decided this way: `done` approves the current
  // stage, any other status sends the issue back to the worker (found by testing "Accept review").
  setStatus(id: string, status: IssueStatus, comment: string) {
    return this.call<Issue>("PATCH", `/api/issues/${id}`, { status, comment });
  }

  comments(issueId: string) {
    return this.call<Comment[]>("GET", `/api/issues/${issueId}/comments`);
  }

  // Never call this on a closed issue: in Paperclip a comment reopens it.
  comment(issueId: string, body: string, clientRequestId?: string) {
    return this.call<Comment>("POST", `/api/issues/${issueId}/comments`, { body, ...(clientRequestId ? { clientRequestId } : {}) });
  }

  openChat(companyId: string, agentId: string) {
    return this.call<Issue>("POST", `/api/companies/${companyId}/chats/${agentId}`);
  }

  createApproval(companyId: string, a: { requestedByAgentId: string; title: string; body: string; issueIds?: string[] }) {
    return this.call<{ id: string; status: string }>("POST", `/api/companies/${companyId}/approvals`, {
      type: "request_board_approval",
      requestedByAgentId: a.requestedByAgentId,
      payload: { title: a.title, brief: a.body },
      issueIds: a.issueIds ?? [],
    });
  }

  approve(approvalId: string, note: string) {
    return this.call<{ id: string; status: string }>("POST", `/api/approvals/${approvalId}/approve`, { decisionNote: note });
  }

  executionWorkspaces(companyId: string) {
    return this.call<ExecutionWorkspace[]>("GET", `/api/companies/${companyId}/execution-workspaces`);
  }

  async runsFor(issueId: string): Promise<Run[]> {
    const rows = await this.call<(Run & { runId?: string })[]>("GET", `/api/issues/${issueId}/runs`);
    return rows.map((r) => ({ ...r, id: r.runId ?? r.id }));
  }

  companyRuns(companyId: string) {
    return this.call<Run[]>("GET", `/api/companies/${companyId}/heartbeat-runs`);
  }

  agentRuns(companyId: string, agentId: string, limit: number) {
    return this.call<(Run & { startedAt: string | null; finishedAt: string | null; contextSnapshot: Record<string, unknown> | null; logBytes: number | null })[]>(
      "GET",
      `/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=${limit}`,
    );
  }

  async runLog(runId: string): Promise<string> {
    const r = await this.call<{ content?: string }>("GET", `/api/heartbeat-runs/${runId}/log`);
    return r.content ?? "";
  }

  runEvents(runId: string) {
    return this.call<{ eventType?: string; payload?: Record<string, unknown> }[]>("GET", `/api/heartbeat-runs/${runId}/events`);
  }

  async instructions(agentId: string): Promise<string> {
    const r = await this.call<{ content?: string }>("GET", `/api/agents/${agentId}/instructions-bundle/file?path=AGENTS.md`);
    return r.content ?? "";
  }

  run(runId: string) {
    return this.call<Run & { error: string | null; agentId: string }>("GET", `/api/heartbeat-runs/${runId}`);
  }

  cancelRun(runId: string) {
    return this.call("POST", `/api/heartbeat-runs/${runId}/cancel`, {});
  }

  // Live frames for one company. Reconnects with backoff until stop() is called.
  subscribe(companyId: string, onFrame: (f: Frame) => void, onState: (connected: boolean) => void = () => {}): () => void {
    const url = this.base.replace(/^http/, "ws") + `/api/companies/${companyId}/events/ws`;
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 1000;
    const connect = () => {
      ws = new WebSocket(url);
      ws.onopen = () => {
        delay = 1000;
        onState(true);
      };
      ws.onmessage = (m) => {
        const f = safeJson(String(m.data)) as Frame | null;
        if (f && typeof f.type === "string") onFrame(f);
      };
      ws.onclose = () => {
        onState(false);
        if (stopped) return;
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      stopped = true;
      ws?.close();
    };
  }
}

function agentConfig(a: AgentSpec) {
  return {
    adapterConfig: {
      engine: "cli",
      command: a.claudeCommand,
      model: a.model,
      timeoutSec: 1800,
      maxTurnsPerRun: 80,
      dangerouslySkipPermissions: false,
      extraArgs: [
        "--setting-sources", "project,local",
        "--settings", a.settingsFile,
        "--permission-mode", "acceptEdits",
        "--allowedTools", a.allowedTools.join(","),
        ...(a.readDirs ?? []).flatMap((d) => ["--add-dir", d]),
      ],
    },
    // Annex runs the wake timer itself, so Paperclip's stays off.
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, maxConcurrentRuns: a.maxConcurrentRuns ?? 1 } },
    instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": a.instructions } },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
