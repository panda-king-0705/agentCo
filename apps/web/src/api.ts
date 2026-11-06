// Typed fetch wrapper for every console route (same origin). Errors surface as toasts via setErrorHandler.
import type {
  Agent, AgentDetail, Approval, BlackboardEntry, CompanyEvent, CompanySettings, CompanySnapshot, Conversation,
  CreateAgentInput, CreateTaskInput, DecideApprovalInput, DecideManyInput, DestroyAgentResult, MemoryItem, MemoryKind, Message,
  MetricsOverview, ModelsInfo, OrgResponse, PostMessageResult, RoleTemplate, Run, RunDetail, Task, TaskDetail,
  TaskStatus, AgentStatus, TimeseriesPoint, TraceDetail, TraceSummary, UpdateAgentInput, ApprovalStatus,
  CatalogAgentDetail, CatalogListResponse, ArchiveResult,
} from "./types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let errorHandler: ((err: ApiError, label: string) => void) | null = null;
export function setErrorHandler(fn: (err: ApiError, label: string) => void): void {
  errorHandler = fn;
}

// ───────────── access token (APP_AUTH_TOKEN off loopback) ─────────────
// Stored in localStorage "agentco.token" for this origin. A `?token=…` link stores it once and is
// then removed from the address bar; a 401 asks for it (TokenGate in ui/token-gate.tsx).
const TOKEN_KEY = "agentco.token";

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the token lives only for this page */
  }
}

/** `?token=…` in the URL (before the #route): store it once and strip it from the address bar. */
function captureTokenFromUrl(): void {
  if (typeof location === "undefined") return;
  const params = new URLSearchParams(location.search);
  const token = params.get("token")?.trim();
  if (!token) return;
  saveToken(token);
  params.delete("token");
  const search = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
}
captureTokenFromUrl();

/** The SSE stream URL (EventSource cannot send headers, so the token goes in the query). */
export function streamUrl(): string {
  const token = readToken();
  return token ? `/api/events/stream?token=${encodeURIComponent(token)}` : "/api/events/stream";
}

let unauthorizedHandler: (() => void) | null = null;
/** Called (instead of a toast) when the API answers 401: the server wants APP_AUTH_TOKEN. */
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

type Query = Record<string, string | number | null | undefined>;
function qs(q?: Query): string {
  if (!q) return "";
  const parts = Object.entries(q).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

interface Opts {
  /** Don't toast on failure (polling, background refresh). */
  quiet?: boolean;
}

async function request<T>(method: string, path: string, body?: unknown, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const token = readToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    const err = new ApiError("network", "Can't reach the AgentCo server. Check that it is running.", 0);
    if (!opts.quiet) errorHandler?.(err, `${method} ${path}`);
    throw err;
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
    const err = new ApiError(e?.code ?? `http_${res.status}`, e?.message ?? `${method} ${path} failed with ${res.status}`, res.status);
    if (res.status === 401 && unauthorizedHandler) unauthorizedHandler();
    else if (!opts.quiet) errorHandler?.(err, `${method} ${path}`);
    throw err;
  }
  return json as T;
}

const get = <T,>(path: string, q?: Query, opts?: Opts) => request<T>("GET", path + qs(q), undefined, opts);
const post = <T,>(path: string, body: unknown = {}) => request<T>("POST", path, body);
const id = encodeURIComponent;

export const api = {
  health: () => get<{ ok: boolean }>("/api/health"),
  company: (opts?: Opts) => get<CompanySnapshot>("/api/company", undefined, opts),
  updateCompany: (patch: Partial<CompanySettings>) => request<unknown>("PATCH", "/api/company", patch),
  pauseCompany: () => post<unknown>("/api/company/pause"),
  resumeCompany: () => post<unknown>("/api/company/resume"),
  resetMood: () => post<{ reset: number }>("/api/company/reset-mood"),
  org: () => get<OrgResponse>("/api/org"),
  roles: () => get<RoleTemplate[]>("/api/roles"),
  models: () => get<ModelsInfo>("/api/models"),
  agents: (q?: { status?: AgentStatus; departmentId?: string }) => get<Agent[]>("/api/agents", q),
  createAgent: (input: CreateAgentInput) => post<Agent>("/api/agents", input),
  agent: (agentId: string) => get<AgentDetail>(`/api/agents/${id(agentId)}`),
  updateAgent: (agentId: string, input: UpdateAgentInput) => request<Agent>("PATCH", `/api/agents/${id(agentId)}`, input),
  pauseAgent: (agentId: string) => post<Agent>(`/api/agents/${id(agentId)}/pause`),
  resumeAgent: (agentId: string) => post<Agent>(`/api/agents/${id(agentId)}/resume`),
  destroyAgent: (agentId: string) => request<DestroyAgentResult>("DELETE", `/api/agents/${id(agentId)}`),
  agentMemory: (agentId: string, q?: { q?: string; kind?: MemoryKind | "" }) => get<MemoryItem[]>(`/api/agents/${id(agentId)}/memory`, q),
  conversations: (q?: { agentId?: string }) => get<Conversation[]>("/api/conversations", q),
  openConversation: (agentId: string) => post<Conversation>("/api/conversations", { agentId }),
  messages: (conversationId: string, after?: string) => get<Message[]>(`/api/conversations/${id(conversationId)}/messages`, { after }),
  postMessage: (conversationId: string, content: string) => post<PostMessageResult>(`/api/conversations/${id(conversationId)}/messages`, { content }),
  tasks: (q?: { status?: TaskStatus; assigneeId?: string; rootTaskId?: string; traceId?: string; archived?: "exclude" | "include" | "only" }) => get<Task[]>("/api/tasks", q),
  createTask: (input: CreateTaskInput) => post<Task>("/api/tasks", input),
  task: (taskId: string) => get<TaskDetail>(`/api/tasks/${id(taskId)}`),
  cancelTask: (taskId: string) => post<Task>(`/api/tasks/${id(taskId)}/cancel`),
  retryTask: (taskId: string) => post<Task>(`/api/tasks/${id(taskId)}/retry`),
  archiveFinished: () => post<ArchiveResult>("/api/tasks/archive-finished"),
  unarchiveTasks: (batch: string | null) => post<ArchiveResult>("/api/tasks/unarchive", batch ? { batch } : {}),
  runs: (q?: { agentId?: string; taskId?: string; limit?: number }) => get<Run[]>("/api/runs", q),
  run: (runId: string) => get<RunDetail>(`/api/runs/${id(runId)}`),
  cancelRun: (runId: string) => post<Run>(`/api/runs/${id(runId)}/cancel`),
  traces: (limit?: number) => get<TraceSummary[]>("/api/traces", { limit }),
  trace: (traceId: string) => get<TraceDetail>(`/api/traces/${id(traceId)}`),
  approvals: (status?: ApprovalStatus) => get<Approval[]>("/api/approvals", { status }),
  decideApproval: (approvalId: string, input: DecideApprovalInput) => post<Approval>(`/api/approvals/${id(approvalId)}/decide`, input),
  decideMany: (input: DecideManyInput) => post<Approval[]>("/api/approvals/decide-many", input),
  blackboard: () => get<BlackboardEntry[]>("/api/blackboard"),
  putBlackboard: (key: string, value: string) => request<BlackboardEntry>("PUT", `/api/blackboard/${id(key)}`, { value }),
  memory: (q?: { q?: string; kind?: MemoryKind | "" }) => get<MemoryItem[]>("/api/memory", q),
  metricsOverview: (opts?: Opts) => get<MetricsOverview>("/api/metrics/overview", undefined, opts),
  timeseries: (metric: "cost" | "runs" | "tokens", hours = 24) => get<TimeseriesPoint[]>("/api/metrics/timeseries", { metric, hours }),
  events: (q?: { since?: number; limit?: number }, opts?: Opts) => get<CompanyEvent[]>("/api/events", q, opts),
  catalog: (q?: { division?: string; q?: string }) => get<CatalogListResponse>("/api/catalog", q),
  // Ids contain a slash ("engineering/engineering-backend-architect"): sent encoded as one segment.
  catalogAgent: (catalogId: string) => get<CatalogAgentDetail>(`/api/catalog/${id(catalogId)}`),
};

/** Every route the console calls — kept here so the backend can be checked against it. */
export const ROUTES_USED = [
  "GET /api/health",
  "GET /api/company", "PATCH /api/company", "POST /api/company/pause", "POST /api/company/resume", "POST /api/company/reset-mood",
  "GET /api/org", "GET /api/roles", "GET /api/models",
  "GET /api/agents", "POST /api/agents", "GET /api/agents/:id", "PATCH /api/agents/:id",
  "POST /api/agents/:id/pause", "POST /api/agents/:id/resume", "DELETE /api/agents/:id", "GET /api/agents/:id/memory",
  "GET /api/conversations", "POST /api/conversations", "GET /api/conversations/:id/messages", "POST /api/conversations/:id/messages",
  "GET /api/tasks", "POST /api/tasks", "GET /api/tasks/:id", "POST /api/tasks/:id/cancel", "POST /api/tasks/:id/retry", "POST /api/tasks/archive-finished", "POST /api/tasks/unarchive",
  "GET /api/runs", "GET /api/runs/:id", "POST /api/runs/:id/cancel",
  "GET /api/traces", "GET /api/traces/:traceId",
  "GET /api/approvals", "POST /api/approvals/:id/decide", "POST /api/approvals/decide-many",
  "GET /api/blackboard", "PUT /api/blackboard/:key", "GET /api/memory",
  "GET /api/metrics/overview", "GET /api/metrics/timeseries",
  "GET /api/events", "GET /api/events/stream (SSE)",
  "GET /api/catalog", "GET /api/catalog/:id",
] as const;
