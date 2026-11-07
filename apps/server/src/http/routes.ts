/** Every route of the API table in docs/ARCHITECTURE.md → API (the SSE stream is wired by server.ts). */
import type {
  AgentDetail,
  CatalogAgentDetail,
  CatalogListResponse,
  CreateAgentInput,
  CreateTaskInput,
  DecideApprovalInput,
  DecideManyInput,
  MemoryKind,
  DeleteConversationResult,
  PostMessageResult,
  RoleTemplate,
  TaskDetail,
  UpdateAgentInput,
} from "../../../../packages/shared/src/index.ts";
import { MEMORY_KINDS } from "../memory/service.ts";
import { ensureBoardroom } from "../org/bootstrap.ts";
import { ROLE_TEMPLATES } from "../org/templates.ts";
import type { Platform } from "../platform.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { created, Router, type RouteContext } from "./router.ts";

export function buildRouter(platform: Platform): Router {
  const router = new Router();
  const { org, tasks, runs, conversations, approvals, memory, repos, company, metrics, traces, bus } = platform;

  router.get("/api/health", () => ({ ok: true, name: company.settings().name, paused: company.settings().paused, time: platform.services.now().toISOString() }));

  // ───────────── company ─────────────
  router.get("/api/company", () => platform.snapshot());
  router.patch("/api/company", ({ body }) => {
    const patch = object(body);
    company.update(patch);
    if (patch.paused === true) runs.abortAll("company_pause");
    platform.scheduler.nudge();
    return platform.snapshot();
  });
  router.post("/api/company/pause", () => {
    platform.pauseCompany();
    return platform.snapshot();
  });
  router.post("/api/company/resume", () => {
    platform.resumeCompany();
    return platform.snapshot();
  });
  // Clears every agent's frustration and negative mood (a fresh start after a stuck stretch).
  router.post("/api/company/reset-mood", () => {
    let reset = 0;
    for (const agent of org.listActiveAgents()) {
      if (agent.affect.frustration === 0 && agent.affect.valence >= 0) continue;
      org.updateCognitiveState(agent.id, { affect: { ...agent.affect, frustration: 0, valence: Math.max(0, agent.affect.valence) } });
      reset++;
    }
    return { reset };
  });
  router.get("/api/org", () => ({ departments: org.listDepartments(), agents: org.listActiveAgents() }));
  router.get("/api/roles", (): RoleTemplate[] => [...ROLE_TEMPLATES]);
  router.get("/api/models", () => platform.modelsInfo());

  // ───────────── specialist catalog (docs/CATALOG.md) ─────────────
  const hiredCounts = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const a of org.listActiveAgents()) if (a.catalogId) counts.set(a.catalogId, (counts.get(a.catalogId) ?? 0) + 1);
    return counts;
  };
  const catalogContext = () => {
    const counts = hiredCounts();
    return { departmentName: (slug: string) => org.departmentNameForSlug(slug), hiredCount: (id: string) => counts.get(id) ?? 0 };
  };
  router.get("/api/catalog", ({ query }): CatalogListResponse => {
    const { catalog } = platform;
    const division = query.get("division") || null;
    if (division && !catalog.divisions().some((d) => d.id === division)) throw badRequest(`unknown division: ${division}`);
    const context = catalogContext();
    const agents = catalog.list({ division, q: query.get("q") }).map((a) => catalog.summary(a, context));
    return { source: catalog.source(), divisions: catalog.divisions(), agents, total: catalog.size };
  });
  const catalogDetail = (id: string): CatalogAgentDetail => {
    const { catalog } = platform;
    const agent = catalog.get(id);
    if (!agent) throw notFound("catalog agent", id);
    return {
      agent,
      summary: catalog.summary(agent, catalogContext()),
      body: catalog.body(id),
      playbook: catalog.playbook(id)!,
      expertise: catalog.expertise(id) ?? "",
      placement: org.catalogPlacement(id),
    };
  };
  // Ids contain a slash ("engineering/engineering-backend-architect"): accept it encoded or as two segments.
  router.get("/api/catalog/:id", ({ params }) => catalogDetail(param(params, "id")));
  router.get("/api/catalog/:division/:slug", ({ params }) => catalogDetail(`${param(params, "division")}/${param(params, "slug")}`));

  // ───────────── agents ─────────────
  router.get("/api/agents", ({ query }) => org.listAgents({ ...opt("status", query.get("status")), ...opt("departmentId", query.get("departmentId")) }));
  router.post("/api/agents", ({ body }) => created(org.createAgent(object(body) as CreateAgentInput, "human")));
  router.get("/api/agents/:id", ({ params }): AgentDetail => {
    const agent = org.requireAgent(param(params, "id"));
    return {
      agent,
      stats: org.stats(agent.id),
      needs: org.needs(agent.id),
      manager: agent.managerId ? org.getAgent(agent.managerId) : null,
      reports: org.directReports(agent.id),
      currentTask: agent.currentTaskId ? tasks.get(agent.currentTaskId) : null,
      recentRuns: repos.runs.list({ agentId: agent.id, limit: 10 }),
      openTasks: repos.tasks.openForAssignee(agent.id),
    };
  });
  router.patch("/api/agents/:id", ({ params, body }) => org.updateAgent(param(params, "id"), object(body) as UpdateAgentInput));
  router.post("/api/agents/:id/pause", ({ params }) => org.pauseAgent(param(params, "id")));
  router.post("/api/agents/:id/resume", ({ params }) => {
    const agent = org.resumeAgent(param(params, "id"));
    platform.scheduler.nudge();
    return agent;
  });
  router.delete("/api/agents/:id", ({ params }) => org.destroyAgent(param(params, "id")));
  router.get("/api/agents/:id/memory", ({ params, query }) => {
    const agent = org.requireAgent(param(params, "id"));
    return findMemory(platform, { agentId: agent.id, scopes: ["agent"], q: query.get("q"), kind: query.get("kind") });
  });

  // ───────────── conversations ─────────────
  router.get("/api/conversations", ({ query }) => conversations.list(query.get("agentId") || undefined));
  router.post("/api/conversations", ({ body }) => {
    const input = object(body);
    if (input.kind === "boardroom") return ensureBoardroom(repos, org, platform.services.now);
    if (typeof input.agentId !== "string" || !input.agentId) throw badRequest("agentId is required");
    const agent = input.agentId === "ceo" ? org.ceo() : org.requireAgent(input.agentId);
    if (!agent) throw notFound("agent", input.agentId);
    return conversations.directMessage(agent);
  });
  router.get("/api/conversations/:id/messages", ({ params, query }) => conversations.messages(param(params, "id"), query.get("after") || undefined));
  // Deleted for good (the Boardroom is cleared instead): messages, the agent's notes from it, its context summary.
  router.delete("/api/conversations/:id", ({ params }): DeleteConversationResult => platform.chats.deleteConversation(param(params, "id")));
  router.post("/api/conversations/:id/messages", ({ params, body }): PostMessageResult => {
    const content = object(body).content;
    if (typeof content !== "string") throw badRequest("content must be a non-empty string");
    const conversation = conversations.require(param(params, "id"));
    const posted = conversations.postHuman(conversation.id, content);
    // "Reply here": a reply where the Board's open questions were asked answers them, and the
    // blocked tasks resume with it — instead of a new chat run that leaves them blocked.
    const answered = conversation.kind === "agent_dm" ? [] : approvals.answerFromConversation(conversation, posted.content);
    if (answered.length) {
      conversations.attachRun(posted.id, null);
      const refs = answered.map((a) => (a.taskId ? tasks.get(a.taskId) : null)).filter((t) => t !== null).map((t) => `T-${t.number}`);
      conversations.postAs(conversation.id, "system", `Your reply was passed on as the answer to ${answered.length} open question${answered.length === 1 ? "" : "s"}${refs.length ? ` (${[...new Set(refs)].join(", ")})` : ""}; the work resumes from there.`);
      platform.scheduler.nudge();
      return { message: repos.conversations.getMessage(posted.id) ?? posted, runId: null, answeredApprovalIds: answered.map((a) => a.id) };
    }
    const run = runs.startMessageRun(posted);
    platform.scheduler.nudge();
    return { message: repos.conversations.getMessage(posted.id) ?? posted, runId: run?.id ?? null };
  });

  // ───────────── tasks ─────────────
  router.get("/api/tasks", ({ query }) =>
    tasks.list({
      ...opt("status", query.get("status")),
      ...opt("assigneeId", query.get("assigneeId")),
      ...opt("rootTaskId", query.get("rootTaskId")),
      ...opt("traceId", query.get("traceId")),
      ...(query.get("limit") ? { limit: intParam(query, "limit", 500) } : {}),
      // Cleared (archived) trees are hidden from the board unless asked for.
      archived: archivedParam(query.get("archived")),
    }),
  );
  router.post("/api/tasks/archive-finished", () => tasks.archiveFinished());
  router.post("/api/tasks/unarchive", ({ body }) => {
    const input = body === undefined || body === null ? {} : object(body);
    if (input.batch !== undefined && input.batch !== null && typeof input.batch !== "string") throw badRequest("batch must be a string");
    return tasks.unarchive(typeof input.batch === "string" ? input.batch : null);
  });
  router.post("/api/tasks", ({ body }) => created(tasks.createRoot(object(body) as unknown as CreateTaskInput, "human")));
  router.get("/api/tasks/:id", ({ params }): TaskDetail => {
    const task = tasks.require(param(params, "id"));
    return {
      task,
      subtasks: tasks.children(task.id),
      runs: repos.runs.list({ taskId: task.id, limit: 100 }),
      assignee: task.assigneeId ? org.getAgent(task.assigneeId) : null,
      approvals: approvals.forTask(task.id),
    };
  });
  router.post("/api/tasks/:id/cancel", ({ params }) => {
    const task = tasks.require(param(params, "id"));
    if (["done", "failed", "cancelled"].includes(task.status)) throw conflict(`T-${task.number} is already ${task.status}`);
    const tree = new Set<string>();
    const walk = (id: string): void => {
      tree.add(id);
      for (const c of tasks.children(id)) walk(c.id);
    };
    walk(task.id);
    const cancelled = tasks.cancel(task.id);
    // Their open approvals (questions, hires, budget asks) would otherwise sit in the Board's queue forever.
    approvals.closeForTasks(tree, `T-${task.number} was cancelled`);
    return cancelled;
  });
  router.post("/api/tasks/:id/retry", ({ params }) => {
    const task = tasks.retry(param(params, "id"));
    platform.scheduler.nudge();
    return task;
  });

  // ───────────── runs & traces ─────────────
  router.get("/api/runs", ({ query }) =>
    repos.runs.list({ ...opt("agentId", query.get("agentId")), ...opt("taskId", query.get("taskId")), ...opt("status", query.get("status")), limit: intParam(query, "limit", 100) }),
  );
  router.get("/api/runs/:id", ({ params }) => {
    const run = repos.runs.get(param(params, "id"));
    if (!run) throw notFound("run", param(params, "id"));
    return { run, spans: repos.spans.byRun(run.id) };
  });
  router.post("/api/runs/:id/cancel", async ({ params }) => {
    const id = param(params, "id");
    if (!repos.runs.get(id)) throw notFound("run", id);
    const run = await runs.cancelRun(id);
    if (!run) throw conflict(`run ${id} is not running`);
    return run;
  });
  router.get("/api/traces", ({ query }) => traces.list(intParam(query, "limit", 50)));
  router.get("/api/traces/:traceId", ({ params }) => traces.detail(param(params, "traceId")));

  // ───────────── approvals, blackboard, memory ─────────────
  // Cleared history is hidden unless asked for (?archived=include|only).
  router.get("/api/approvals", ({ query }) => approvals.list(query.get("status") || undefined, archivedParam(query.get("archived"))));
  router.post("/api/approvals/archive-decided", () => approvals.archiveDecided());
  router.post("/api/approvals/unarchive", ({ body }) => {
    const input = body === undefined || body === null ? {} : object(body);
    if (input.batch !== undefined && input.batch !== null && typeof input.batch !== "string") throw badRequest("batch must be a string");
    return approvals.unarchive(typeof input.batch === "string" ? input.batch : null);
  });
  router.post("/api/approvals/:id/decide", ({ params, body }) => {
    const input = object(body);
    if (input.decision !== "approved" && input.decision !== "rejected") throw badRequest('decision must be "approved" or "rejected"');
    if (input.note !== undefined && typeof input.note !== "string") throw badRequest("note must be a string");
    return approvals.decide(param(params, "id"), input as unknown as DecideApprovalInput);
  });
  router.post("/api/approvals/decide-many", ({ body }) => {
    const input = object(body);
    if (input.decision !== "approved" && input.decision !== "rejected") throw badRequest('decision must be "approved" or "rejected"');
    if (input.note !== undefined && typeof input.note !== "string") throw badRequest("note must be a string");
    if (input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.some((i) => typeof i !== "string"))) throw badRequest("ids must be an array of strings");
    if (input.kind !== undefined && typeof input.kind !== "string") throw badRequest("kind must be a string");
    if (input.ids === undefined && input.kind === undefined) throw badRequest("pass ids or kind");
    const { ids, kind, ...decision } = input as unknown as DecideManyInput;
    const decided = approvals.decideMany({ ...(ids ? { ids } : {}), ...(kind ? { kind } : {}) }, decision);
    platform.scheduler.nudge();
    return decided;
  });
  // The company handbook new hires receive (org/handbook.ts); ?agentId= personalises it.
  router.get("/api/handbook", ({ query }) => {
    const agentId = query.get("agentId");
    const agent = agentId ? org.getAgent(agentId) : null;
    if (agentId && !agent) throw notFound("agent", agentId);
    return { text: platform.services.handbook ? platform.services.handbook(agent) : "" };
  });
  router.get("/api/blackboard", () => memory.blackboardList());
  router.put("/api/blackboard/:key", ({ params, body }) => {
    const value = object(body).value;
    if (typeof value !== "string") throw badRequest("value must be a string");
    return memory.blackboardSet(param(params, "key"), value, "human");
  });
  router.get("/api/memory", ({ query }) => findMemory(platform, { agentId: null, scopes: ["global"], q: query.get("q"), kind: query.get("kind") }));

  // ───────────── metrics & events ─────────────
  router.get("/api/metrics/overview", () => metrics.overview());
  router.get("/api/metrics/timeseries", ({ query }) => metrics.timeseries(query.get("metric") || "cost", intParam(query, "hours", 24)));
  // With `since`: everything after it (catch-up). Without: the NEWEST `limit` events. (Returning the
  // oldest made the console seed its stream position from the start of history and then replay
  // days-old task/agent updates over the current state: cancelled tasks back "In progress".)
  router.get("/api/events", ({ query }) =>
    query.get("since") === null ? bus.tail(intParam(query, "limit", 120)) : bus.since(intParam(query, "since", 0), intParam(query, "limit", 500)),
  );
  return router;
}

// ───────────── helpers ─────────────

function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("request body must be a JSON object");
  return body as Record<string, unknown>;
}

function param(params: RouteContext["params"], name: string): string {
  const value = params[name];
  if (!value) throw badRequest(`missing path parameter ${name}`);
  return value;
}

/** `{ key: value }` when the query value is non-empty, else `{}` (exactly-optional filters). */
function opt<K extends string>(key: K, value: string | null): { [P in K]?: string } {
  return value ? ({ [key]: value } as { [P in K]?: string }) : {};
}

function archivedParam(raw: string | null): "include" | "exclude" | "only" {
  if (raw === null || raw === "" || raw === "exclude") return "exclude";
  if (raw === "include" || raw === "only") return raw;
  throw badRequest('archived must be "exclude", "include" or "only"');
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw badRequest(`${name} must be a number`);
  return Math.floor(value);
}

function findMemory(platform: Platform, f: { agentId: string | null; scopes: ("agent" | "global")[]; q: string | null; kind: string | null }) {
  let kinds: MemoryKind[] | undefined;
  if (f.kind) {
    if (!MEMORY_KINDS.includes(f.kind as MemoryKind)) throw badRequest(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
    kinds = [f.kind as MemoryKind];
  }
  const { memory } = platform;
  // Console browsing must not inflate accessCount (it feeds retrieval ranking).
  if (f.q) return memory.search({ query: f.q, agentId: f.agentId, scopes: f.scopes, ...(kinds ? { kinds } : {}), limit: 100 }, { bump: false });
  return memory.recent({ agentId: f.agentId, scopes: f.scopes, kinds: kinds ?? null, limit: 100 });
}
