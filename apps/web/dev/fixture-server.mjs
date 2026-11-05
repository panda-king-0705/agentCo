// Dependency-free fixture server for the console: serves apps/web/dist and answers every /api route
// from docs/ARCHITECTURE.md with in-memory fixture data, plus a live SSE stream.
//
//   node apps/web/dev/fixture-server.mjs [--port 5173] [--org startup|enterprise] [--live]
//
// Env: FIXTURE_PORT, FIXTURE_ORG, FIXTURE_LIVE=1, FIXTURE_LATENCY_MS (default 60), FIXTURE_TICK_MS (default 1000)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAIN_SEQUENCE, LLM_BLOCKS, ROLE_TEMPLATES, castBaZi, createFixtureState, makeAgent, rollupRun, toolsFor } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");
const HOUR = 3_600_000;
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const STATUSES = ["idle", "thinking", "acting", "waiting", "blocked", "paused", "error", "terminated"];
const TASK_STATUSES = ["todo", "in_progress", "waiting", "blocked", "done", "failed", "cancelled"];
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function startFixtureServer({ port = 5173, host = "127.0.0.1", org = "startup", live = false, latencyMs = 60, tickMs = 1000, quiet = false } = {}) {
  const S = createFixtureState({ org, live });
  const clients = new Set();
  const log = (...a) => !quiet && console.log("[fixture]", ...a);

  // ───────────── helpers ─────────────
  const now = () => Date.now();
  const iso = (t = now()) => new Date(t).toISOString();
  const agent = (id) => S.agents.find((a) => a.id === id);
  const nameOf = (id) => (id === "human" ? "Board" : agent(id)?.name ?? id);
  const task = (id) => S.tasks.find((t) => t.id === id);
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const profile = (tier) => S.models.profiles.find((p) => p.id === S.models.tiers[tier].primary);

  function emit(type, summary, data, extra = {}) {
    const ev = {
      seq: ++S.seq,
      id: `evt_${String(S.seq).padStart(5, "0")}`,
      type,
      at: iso(),
      agentId: extra.agentId ?? (type.startsWith("agent.") ? data?.id : data?.agentId) ?? null,
      taskId: extra.taskId ?? (type.startsWith("task.") ? data?.id : data?.taskId) ?? null,
      runId: extra.runId ?? (type.startsWith("run.") ? data?.id : data?.runId) ?? null,
      traceId: extra.traceId ?? data?.traceId ?? null,
      summary,
      data,
    };
    S.events.push(ev);
    if (S.events.length > 3000) S.events.splice(0, S.events.length - 3000);
    const frame = `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(frame);
    return ev;
  }
  const touchAgent = (a, patch, summary) => {
    Object.assign(a, patch, { updatedAt: iso() });
    emit("agent.status", summary ?? `${a.name} is ${a.status}${a.activity ? `: ${a.activity}` : ""}`, structuredClone(a));
  };
  const touchTask = (t, patch, summary) => {
    Object.assign(t, patch, { updatedAt: iso() });
    if (TERMINAL.has(t.status) && !t.completedAt) t.completedAt = iso();
    emit("task.updated", summary ?? `T-${t.number} is now ${t.status.replace("_", " ")}`, structuredClone(t));
  };

  function newSpan(o) {
    const s = {
      id: S.nextId("spn"),
      traceId: o.traceId,
      parentSpanId: o.parent ?? null,
      kind: o.kind,
      name: o.name,
      status: "running",
      agentId: o.agentId ?? null,
      runId: o.runId ?? null,
      taskId: o.taskId ?? null,
      startedAt: iso(),
      endedAt: null,
      durationMs: null,
      input: o.input ?? null,
      output: null,
      error: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      attributes: { ...(o.attrs ?? {}) },
    };
    if (o.block) s.attributes["agentco.brain.block"] = o.block;
    if (o.agentId) {
      s.attributes["gen_ai.agent.id"] = o.agentId;
      s.attributes["gen_ai.agent.name"] = nameOf(o.agentId);
    }
    S.spans.push(s);
    emit("span.started", `${nameOf(s.agentId)}: ${s.name} started`, structuredClone(s));
    return s;
  }
  function endSpan(s, o = {}) {
    if (s.status !== "running") return s;
    s.status = o.status ?? "ok";
    s.endedAt = iso();
    s.durationMs = Date.parse(s.endedAt) - Date.parse(s.startedAt);
    if (o.output) s.output = o.output;
    if (o.error) s.error = o.error;
    Object.assign(s.attributes, o.attrs ?? {});
    if (s.kind === "llm") {
      const a = agent(s.agentId);
      const tier = o.tier === "agent" || !o.tier ? a?.modelTier ?? "standard" : o.tier;
      const p = profile(tier);
      const fr = profile("frontier");
      const inTok = 1200 + Math.round(Math.random() * 3000);
      const outTok = 150 + Math.round(Math.random() * 500);
      const cost = (inTok * p.inputPerMTokUsd + outTok * p.outputPerMTokUsd) / 1e6;
      Object.assign(s, { model: p.model, inputTokens: inTok, outputTokens: outTok, costUsd: round6(cost) });
      Object.assign(s.attributes, { "gen_ai.operation.name": "chat", "gen_ai.provider.name": p.provider, "gen_ai.request.model": p.model, "gen_ai.usage.input_tokens": inTok, "gen_ai.usage.output_tokens": outTok, "agentco.tier": tier, "agentco.cost_usd": round6(cost) });
      S.spend.push({ agentId: s.agentId, runId: s.runId, model: p.model, tier, costUsd: cost, frontierCostUsd: (inTok * fr.inputPerMTokUsd + outTok * fr.outputPerMTokUsd) / 1e6, inputTokens: inTok, outputTokens: outTok, at: s.endedAt });
      const r = S.runs.find((x) => x.id === s.runId);
      if (r) rollupRun(S, r);
      const t = task(s.taskId);
      if (t) t.actualCostUsd = round6(t.actualCostUsd + cost);
    }
    emit("span.ended", `${nameOf(s.agentId)}: ${s.name} ${s.status === "error" ? "failed" : "finished"}`, structuredClone(s));
    return s;
  }
  function newRun({ agentId, taskId = null, traceId, parent, trigger, conversationId = null }) {
    const a = agent(agentId);
    const runId = S.nextId("run");
    const root = newSpan({ traceId, parent, kind: "run", name: `run ${a.title}`, agentId, runId, taskId, attrs: { "agentco.run.trigger": trigger, "gen_ai.operation.name": "invoke_agent" } });
    const run = { id: runId, agentId, taskId, conversationId, traceId, rootSpanId: root.id, trigger, engine: a.cognition, status: "running", output: null, error: null, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, costUsd: 0, llmCalls: 0, toolCalls: 0, failingSpanId: null, startedAt: iso(), completedAt: null, createdAt: iso() };
    S.runs.push(run);
    emit("run.started", `${a.name} started a ${trigger} run`, structuredClone(run));
    return { run, root };
  }
  function endRun(run, root, status = "completed", output = null, error = null) {
    endSpan(root, { status: status === "failed" ? "error" : status === "cancelled" ? "cancelled" : "ok" });
    for (const s of S.spans) if (s.runId === run.id && s.status === "running") endSpan(s, { status: status === "cancelled" ? "cancelled" : "ok" });
    Object.assign(run, { status, output, error, completedAt: iso() });
    rollupRun(S, run);
    emit("run.completed", `${nameOf(run.agentId)} ${status === "completed" ? "completed" : status} a run${error ? `: ${error}` : ""}`, structuredClone(run));
  }
  function objectiveSpan(traceId, title, taskId = null) {
    return newSpan({ traceId, kind: "objective", name: title, taskId, attrs: { "gen_ai.operation.name": "invoke_workflow", "gen_ai.workflow.name": title } });
  }
  function postMessage(conversationId, senderId, content, extra = {}) {
    const m = { id: S.nextId("msg"), conversationId, senderId, content, runId: extra.runId ?? null, taskId: extra.taskId ?? null, traceId: extra.traceId ?? null, readAt: null, createdAt: iso() };
    S.messages.push(m);
    const c = S.conversations.find((x) => x.id === conversationId);
    if (c) c.lastMessageAt = m.createdAt;
    emit("message.created", `${nameOf(senderId)}: ${content.replace(/[*`#]/g, "").slice(0, 90)}`, structuredClone(m), { agentId: senderId === "human" ? null : senderId });
    return m;
  }
  function createTask({ title, description = "", assigneeId, acceptanceCriteria = null, value = 100, estCostUsd = 0.2, parentTaskId = null, createdBy = "human", originConversationId = null }) {
    const parent = parentTaskId ? task(parentTaskId) : null;
    const id = S.nextId("tsk");
    const traceId = parent?.traceId ?? `trc_${id.slice(4)}${Math.random().toString(36).slice(2, 6)}`;
    const t = { id, number: Math.max(0, ...S.tasks.map((x) => x.number)) + 1, traceId, parentTaskId: parent?.id ?? null, rootTaskId: parent?.rootTaskId ?? id, title, description, acceptanceCriteria, createdBy, assigneeId, departmentId: agent(assigneeId)?.departmentId ?? null, status: "todo", value, estCostUsd, actualCostUsd: 0, priority: Math.round((value / Math.max(estCostUsd, 0.01)) * 100) / 100, result: null, error: null, attempts: 0, maxAttempts: 2, originConversationId, state: {}, createdAt: iso(), updatedAt: iso(), startedAt: null, completedAt: null };
    S.tasks.push(t);
    if (!parent) t.state.objectiveSpanId = objectiveSpan(traceId, title, id).id;
    emit("task.created", `${nameOf(assigneeId)} was assigned T-${t.number}: ${title}`, structuredClone(t));
    return t;
  }

  // ───────────── derived views ─────────────
  const since24h = () => now() - 24 * HOUR;
  function agentStats(a) {
    const mine = S.spend.filter((s) => s.agentId === a.id);
    const today = mine.filter((s) => Date.parse(s.at) >= since24h());
    const runs = S.runs.filter((r) => r.agentId === a.id);
    const last = [...runs].sort((x, y) => (y.startedAt ?? "").localeCompare(x.startedAt ?? ""))[0];
    return {
      spentTodayUsd: round6(today.reduce((n, s) => n + s.costUsd, 0)),
      spentMonthUsd: round6((S.history.agentMonthBase[a.id] ?? 0) + mine.reduce((n, s) => n + s.costUsd, 0)),
      runsTotal: runs.length + Math.round((S.history.agentMonthBase[a.id] ?? 0) * 3),
      runsFailed: runs.filter((r) => r.status === "failed").length,
      tasksDone: S.tasks.filter((t) => t.assigneeId === a.id && t.status === "done").length,
      tasksOpen: S.tasks.filter((t) => t.assigneeId === a.id && !TERMINAL.has(t.status)).length,
      inputTokens: mine.reduce((n, s) => n + s.inputTokens, 0),
      outputTokens: mine.reduce((n, s) => n + s.outputTokens, 0),
      lastActiveAt: last?.completedAt ?? last?.startedAt ?? a.updatedAt,
    };
  }
  function needs(a, stats) {
    const left = a.monthlyBudgetUsd - stats.spentMonthUsd;
    const okrs = a.identity.okrs.flatMap((o) => o.keyResults);
    const prog = okrs.length ? okrs.reduce((n, kr) => n + Math.min(1, kr.current / (kr.target || 1)), 0) / okrs.length : 0;
    return {
      physiological: left > 0 ? "ok" : "low",
      safety: left / Math.max(a.monthlyBudgetUsd, 0.01) >= 0.2 && a.affect.frustration < 0.7 ? "ok" : "low",
      belonging: a.managerId || S.agents.some((x) => x.managerId === a.id && x.status !== "terminated") ? "ok" : "low",
      esteem: a.calibration.successRate >= 0.6 ? "ok" : "low",
      selfActualization: Math.round(prog * 100) / 100,
    };
  }
  function traceSummary(traceId) {
    const spans = S.spans.filter((s) => s.traceId === traceId);
    if (!spans.length) return null;
    const root = spans.find((s) => !s.parentSpanId) ?? spans[0];
    const rootTask = S.tasks.find((t) => t.traceId === traceId && !t.parentTaskId);
    const llm = spans.filter((s) => s.kind === "llm");
    const ends = spans.map((s) => s.endedAt).filter(Boolean).sort();
    const running = spans.some((s) => s.status === "running");
    return {
      traceId,
      title: root.name,
      rootTaskId: rootTask?.id ?? null,
      status: root.status === "running" || running ? (spans.some((s) => s.status === "error") && root.status !== "running" ? "error" : "running") : spans.some((s) => s.status === "error") ? "error" : root.status,
      startedAt: spans.map((s) => s.startedAt).sort()[0],
      endedAt: running ? null : ends[ends.length - 1] ?? null,
      agentIds: [...new Set(spans.map((s) => s.agentId).filter(Boolean))],
      spanCount: spans.length,
      llmCalls: llm.length,
      costUsd: round6(llm.reduce((n, s) => n + (s.costUsd ?? 0), 0)),
      inputTokens: llm.reduce((n, s) => n + (s.inputTokens ?? 0), 0),
      outputTokens: llm.reduce((n, s) => n + (s.outputTokens ?? 0), 0),
    };
  }
  function metrics() {
    const day = S.spend.filter((s) => Date.parse(s.at) >= since24h());
    const sum = (arr, f) => arr.reduce((n, x) => n + f(x), 0);
    const byTier = { frontier: 0, standard: 0, economy: 0 };
    for (const s of S.spend) byTier[s.tier] += s.costUsd;
    const models = new Map();
    for (const s of S.spend) {
      const m = models.get(s.model) ?? { model: s.model, costUsd: 0, calls: 0 };
      m.costUsd += s.costUsd;
      m.calls++;
      models.set(s.model, m);
    }
    const deps = new Map(S.departments.map((d) => [d.id, 0]));
    for (const a of S.agents) deps.set(a.departmentId, (deps.get(a.departmentId) ?? 0) + (S.history.agentMonthBase[a.id] ?? 0));
    for (const s of S.spend) {
      const d = agent(s.agentId)?.departmentId;
      if (d) deps.set(d, (deps.get(d) ?? 0) + s.costUsd);
    }
    const realRuns = S.runs.filter((r) => r.startedAt && Date.parse(r.startedAt) >= since24h());
    const finished = [...S.history.runs24h.map((r) => ({ ok: r.ok, ms: r.ms })), ...realRuns.filter((r) => r.completedAt).map((r) => ({ ok: r.status === "completed", ms: Date.parse(r.completedAt) - Date.parse(r.startedAt) }))];
    const agentsByStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const a of S.agents) agentsByStatus[a.status]++;
    const tasksByStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0]));
    for (const t of S.tasks) tasksByStatus[t.status]++;
    const tierScale = (S.history.monthBaseUsd) / Math.max(sum(S.spend, (s) => s.costUsd), 0.01);
    return {
      agentsByStatus,
      tasksByStatus,
      spentTodayUsd: round6(sum(day, (s) => s.costUsd)),
      spentMonthUsd: round6(S.history.monthBaseUsd + sum(S.spend, (s) => s.costUsd)),
      spendByTier: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, round6(v * (1 + tierScale))])),
      spendByModel: [...models.values()].map((m) => ({ ...m, costUsd: round6(m.costUsd * (1 + tierScale)) })).sort((a, b) => b.costUsd - a.costUsd),
      spendByDepartment: [...deps.entries()].map(([departmentId, costUsd]) => ({ departmentId, costUsd: round6(costUsd) })).sort((a, b) => b.costUsd - a.costUsd),
      runs24h: S.history.runs24h.length + realRuns.length,
      runSuccessRate: finished.length ? finished.filter((r) => r.ok).length / finished.length : null,
      avgRunMs: finished.length ? Math.round(sum(finished, (r) => r.ms) / finished.length) : null,
      tokens24h: { input: sum(day, (s) => s.inputTokens), output: sum(day, (s) => s.outputTokens) },
      routingSavingsUsd: round6((S.history.savingsBaseUsd ?? 0) + sum(S.spend, (s) => s.frontierCostUsd - s.costUsd)),
    };
  }
  function timeseries(metric, hours) {
    const end = now() - (now() % HOUR) + HOUR;
    const pts = [];
    for (let i = hours; i > 0; i--) {
      const t0 = end - i * HOUR;
      const t1 = t0 + HOUR;
      const inB = (at) => {
        const t = Date.parse(at);
        return t >= t0 && t < t1;
      };
      let value = 0;
      if (metric === "cost") value = round6(S.spend.filter((s) => inB(s.at)).reduce((n, s) => n + s.costUsd, 0));
      else if (metric === "tokens") value = S.spend.filter((s) => inB(s.at)).reduce((n, s) => n + s.inputTokens + s.outputTokens, 0);
      else value = S.history.runs24h.filter((r) => inB(r.at)).length + S.runs.filter((r) => r.startedAt && inB(r.startedAt)).length;
      pts.push({ t: new Date(t0).toISOString(), value });
    }
    return pts;
  }
  function snapshot() {
    const m = metrics();
    return {
      settings: S.settings,
      headcount: S.agents.filter((a) => a.status !== "terminated").length,
      activeAgents: S.agents.filter((a) => ["thinking", "acting", "waiting"].includes(a.status)).length,
      openTasks: S.tasks.filter((t) => !TERMINAL.has(t.status)).length,
      pendingApprovals: S.approvals.filter((a) => a.status === "pending").length,
      spentTodayUsd: m.spentTodayUsd,
      spentMonthUsd: m.spentMonthUsd,
      models: S.models,
    };
  }

  // ───────────── mutations ─────────────
  function destroyAgent(id) {
    const a = agent(id);
    if (!a || a.status === "terminated") throw new HttpError(404, "not_found", `Agent ${id} not found`);
    const reports = S.agents.filter((x) => x.managerId === id && x.status !== "terminated");
    if (!a.managerId && reports.length) throw new HttpError(409, "conflict", "The CEO can't be destroyed while it has direct reports. Reassign them first.");
    let cancelledRuns = 0;
    for (const r of S.runs.filter((r) => r.agentId === id && (r.status === "running" || r.status === "queued"))) {
      const root = S.spans.find((s) => s.id === r.rootSpanId);
      if (root) endRun(r, root, "cancelled", null, "Agent terminated");
      else r.status = "cancelled";
      cancelledRuns++;
    }
    let reassignedTasks = 0;
    for (const t of S.tasks.filter((t) => t.assigneeId === id && !TERMINAL.has(t.status))) {
      touchTask(t, { assigneeId: a.managerId, status: t.status === "in_progress" ? "todo" : t.status }, `T-${t.number} moved to ${nameOf(a.managerId)}`);
      reassignedTasks++;
    }
    for (const r of reports) {
      Object.assign(r, { managerId: a.managerId, updatedAt: iso() });
      emit("agent.updated", `${r.name} now reports to ${nameOf(a.managerId)}`, structuredClone(r));
    }
    Object.assign(a, { status: "terminated", terminatedAt: iso(), activity: null, brainBlock: null, currentRunId: null, currentTaskId: null, updatedAt: iso() });
    emit("agent.terminated", `${a.name} (${a.title}) was terminated`, structuredClone(a));
    return { agentId: id, cancelledRuns, reassignedTasks, reassignedReports: reports.length };
  }
  function createAgent(input, createdBy = "human") {
    const role = input.roleId ? ROLE_TEMPLATES.find((r) => r.id === input.roleId) : null;
    if (input.roleId && !role) throw new HttpError(400, "bad_request", `Unknown role template ${input.roleId}`);
    const title = input.title ?? role?.title;
    if (!title) throw new HttpError(400, "bad_request", "title or roleId is required");
    const dep = input.departmentId ?? S.departments.find((d) => d.slug === role?.departmentSlug)?.id ?? "dep_executive";
    if (!S.departments.some((d) => d.id === dep)) throw new HttpError(400, "bad_request", `Unknown department ${dep}`);
    const managerId = input.managerId === undefined ? S.departments.find((d) => d.id === dep)?.headAgentId ?? "agt_ceo" : input.managerId;
    if (managerId && !agent(managerId)) throw new HttpError(400, "bad_request", `Unknown manager ${managerId}`);
    if (S.agents.filter((a) => a.status !== "terminated").length >= S.settings.maxHeadcount) throw new HttpError(409, "headcount_limit", `Headcount limit of ${S.settings.maxHeadcount} reached`);
    const tier = input.tier ?? role?.tier ?? "worker";
    const createdAt = iso();
    const a = makeAgent({ id: S.nextId("agt"), name: input.name || role?.defaultNames?.[0] || "New Agent", title, roleId: input.roleId ?? title.toLowerCase().replace(/[^a-z]+/g, "-"), departmentId: dep, managerId, tier, cognition: input.cognition ?? role?.cognition ?? (tier === "worker" ? "reflex" : "brain"), modelTier: input.modelTier ?? role?.modelTier ?? "economy", mbti: input.persona?.personalityType ?? null, budget: input.monthlyBudgetUsd ?? 10, createdAt });
    a.modelOverride = input.modelOverride ?? null;
    if (input.mandate) a.identity.mission = input.mandate;
    else if (role) a.identity.mission = role.mandate;
    a.tools = input.tools ?? role?.tools ?? toolsFor(tier);
    if (input.persona?.style) a.persona.style = input.persona.style;
    if (input.persona?.traits) a.persona.traits = input.persona.traits;
    a.persona.baZi = castBaZi(createdAt);
    a.createdBy = createdBy;
    a.calibration = { samples: 0, meanConfidence: 0, successRate: 0, brier: 0 };
    S.agents.push(a);
    S.history.agentMonthBase[a.id] = 0;
    emit("agent.created", `${a.name} joined as ${a.title}`, structuredClone(a));
    return a;
  }

  /** Simulated agent reply to a human message, with its own traced run. */
  function replyTo(conv, humanMsg) {
    const responderId = conv.kind === "boardroom" ? "agt_ceo" : conv.participantIds.find((p) => p !== "human");
    const a = agent(responderId);
    if (!a || a.status === "terminated") return null;
    if (a.status === "paused" || S.settings.paused) {
      setTimeout(() => postMessage(conv.id, "system", `${a.name} is paused. The message will be picked up when ${a.status === "paused" ? "the agent" : "the company"} resumes.`), 300);
      return null;
    }
    const traceId = `trc_chat${Math.random().toString(36).slice(2, 8)}`;
    const obj = objectiveSpan(traceId, `chat: ${humanMsg.content.slice(0, 60)}`);
    const { run, root } = newRun({ agentId: a.id, traceId, parent: obj.id, trigger: "message", conversationId: conv.id });
    const prev = { status: a.status, activity: a.activity, brainBlock: a.brainBlock };
    const brain = a.cognition === "brain";
    touchAgent(a, { status: "thinking", activity: `Reading the Board's message`, brainBlock: brain ? "metacognition.target_understanding.problem_definition" : null, currentRunId: run.id });
    const stage = brain ? newSpan({ traceId, parent: root.id, kind: "stage", name: "brain.target_understanding.problem_definition", agentId: a.id, runId: run.id, block: "metacognition.target_understanding.problem_definition" }) : null;
    const llm = newSpan({ traceId, parent: stage?.id ?? root.id, kind: "llm", name: "llm.chat", agentId: a.id, runId: run.id, input: humanMsg.content.slice(0, 400) });
    const work = /\b(please|build|launch|write|draft|prepare|create|fix|ship|plan|review|analy[sz]e)\b/i.test(humanMsg.content) && brain;
    setTimeout(() => {
      endSpan(llm, { tier: "economy" });
      if (stage) endSpan(stage);
      touchAgent(a, { status: "acting", activity: work ? "Opening an objective on the TODO list" : "Writing a reply", brainBlock: brain ? (work ? "todo_list" : "metacognition.solving_evaluation.solving") : null });
    }, 900);
    setTimeout(() => {
      let content;
      let taskId = null;
      if (work) {
        const title = humanMsg.content.replace(/^(please|can you|could you)\s+/i, "").replace(/[.?!].*$/s, "").slice(0, 70);
        const t = createTask({ title: title.charAt(0).toUpperCase() + title.slice(1), description: humanMsg.content, assigneeId: a.id, createdBy: "human", originConversationId: conv.id, value: 200, estCostUsd: 0.3 });
        taskId = t.id;
        content = `Opened **T-${t.number}: ${t.title}**. I'll plan it, delegate where it fits, and report back here.`;
      } else if (/spend|cost|budget/i.test(humanMsg.content)) {
        const m = metrics();
        content = `Spend in the last 24 h is **$${m.spentTodayUsd.toFixed(2)}**; month to date **$${m.spentMonthUsd.toFixed(2)}** of $${S.settings.monthlyBudgetUsd}. Cheaper-tier routing has avoided about $${m.routingSavingsUsd.toFixed(2)} this month.`;
      } else if (/status|progress|update/i.test(humanMsg.content)) {
        const open = S.tasks.filter((t) => t.assigneeId === a.id && !TERMINAL.has(t.status));
        content = open.length ? `Here's where my work stands:\n\n${open.map((t) => `- T-${t.number} ${t.title}: ${t.status.replace("_", " ")}`).join("\n")}` : "Nothing open on my list right now.";
      } else {
        content = `Understood. ${a.identity.values?.[0] ? `My guiding value here is "${a.identity.values[0]}". ` : ""}I'll keep the Board posted in this thread if anything changes.`;
      }
      const reply = newSpan({ traceId, parent: root.id, kind: "llm", name: "llm.chat", agentId: a.id, runId: run.id, attrs: { "agentco.stage": "chat.reply" } });
      endSpan(reply, { tier: "standard", output: content.slice(0, 300) });
      endRun(run, root, "completed", content);
      endSpan(obj);
      postMessage(conv.id, a.id, content, { runId: run.id, traceId, taskId });
      touchAgent(a, { ...prev, currentRunId: null });
    }, 2200);
    return run.id;
  }

  // ───────────── simulation (SSE every tick) ─────────────
  const walkers = [
    { agentId: "agt_cto", cooldown: 0, title: "Heartbeat: review checkout reliability OKR" },
    { agentId: "agt_ceo", cooldown: 12, title: "Heartbeat: weekly OKR gap review" },
  ].map((w) => ({ ...w, run: null, root: null, obj: null, step: 0, spans: [], llm: null, traces: [], saved: null }));

  function walkerTick(w) {
    const a = agent(w.agentId);
    if (!a || a.status === "terminated" || a.status === "paused") return;
    if (!w.run) {
      if (w.cooldown-- > 0) return;
      const traceId = `trc_hb${Math.random().toString(36).slice(2, 8)}`;
      w.obj = objectiveSpan(traceId, w.title);
      const { run, root } = newRun({ agentId: a.id, traceId, parent: w.obj.id, trigger: "heartbeat" });
      Object.assign(w, { run, root, step: 0, spans: [], llm: null, saved: { status: a.status, activity: a.activity, currentRunId: a.currentRunId } });
      w.traces.push(traceId);
      if (w.traces.length > 2) {
        const drop = w.traces.shift();
        const runIds = new Set(S.runs.filter((r) => r.traceId === drop).map((r) => r.id));
        S.spans = S.spans.filter((s) => s.traceId !== drop);
        S.runs = S.runs.filter((r) => !runIds.has(r.id));
      }
      touchAgent(a, { currentRunId: run.id });
      return;
    }
    const prev = w.spans[w.spans.length - 1];
    if (w.llm) endSpan(w.llm, { tier: LLM_BLOCKS[prev?.attributes["agentco.brain.block"]] });
    if (prev) endSpan(prev, { attrs: blockAttrs(prev.attributes["agentco.brain.block"]) });
    w.llm = null;
    if (w.step >= BRAIN_SEQUENCE.length) {
      endRun(w.run, w.root, "completed", "Heartbeat review complete: OKRs on track, no new objectives opened.");
      endSpan(w.obj);
      a.calibration.samples += 1;
      touchAgent(a, { ...w.saved, brainBlock: null, currentRunId: null }, `${a.name} finished a heartbeat review`);
      Object.assign(w, { run: null, root: null, obj: null, cooldown: 4 });
      return;
    }
    const [block, activity, status] = BRAIN_SEQUENCE[w.step++];
    const s = newSpan({ traceId: w.run.traceId, parent: w.root.id, kind: "stage", name: `brain.${block.replace(/^metacognition\.|^self_management\./, "")}`, agentId: a.id, runId: w.run.id, block, attrs: { "agentco.stage": block } });
    w.spans.push(s);
    if (LLM_BLOCKS[block]) w.llm = newSpan({ traceId: w.run.traceId, parent: s.id, kind: "llm", name: "llm.chat", agentId: a.id, runId: w.run.id, input: `[[stage:${block}]] (redacted)` });
    if (block === "self_management.sensibility_emotion") {
      a.affect.valence = Math.max(-1, Math.min(1, Math.round((a.affect.valence + 0.05) * 100) / 100));
      a.affect.frustration = Math.max(0, Math.round((a.affect.frustration - 0.03) * 100) / 100);
    }
    touchAgent(a, { status, activity, brainBlock: block });
  }
  function blockAttrs(block) {
    switch (block) {
      case "metacognition.confidence":
        return { "agentco.confidence": Math.round((0.6 + Math.random() * 0.25) * 100) / 100 };
      case "metacognition.monitoring.ood":
        return { "agentco.ood": false };
      case "metacognition.cognitive_control.candidate_solutions":
        return { "agentco.candidates": "High Cost: full load-test suite | Low Cost: stub + contract tests | Low Effect: retry on failure" };
      case "metacognition.project_management.economic_concepts":
        return { "agentco.candidate.chosen": "low_cost" };
      case "metacognition.solving_evaluation.feedback":
        return { "agentco.eval.score": 0.82, "agentco.eval.decision": "accept" };
      default:
        return {};
    }
  }

  // Scripted launch story + ambient activity, one beat per tick.
  let tick = 0;
  const be2 = () => S.runs.find((r) => r.agentId === "agt_be" && r.status === "running");
  const feRun = { run: null, root: null, steps: 0 };
  const supportLines = ["Answering ticket #4183: SSO setup", "Answering ticket #4184: invoice address", "Searching the KB for refund policy", "Answering ticket #4186: plan downgrade", "Drafting a reply about annual billing"];
  const chatter = [
    ["cnv_adm_cto_be", "agt_be", "Contract tests green locally with the stub; pushing the run now."],
    ["cnv_adm_ceo_cfo", "agt_cfo", "Launch spend so far is well inside the $8 stop-and-ask line."],
    ["cnv_adm_cto_be", "agt_cto", "Good. Add the stub to the shared test kit so the UI tests can use it."],
    ["cnv_boardroom", "agt_cmo", "Launch post is scheduled for Friday 09:00 pending the checkout green light."],
  ];
  function ambient() {
    tick++;
    const be = agent("agt_be");
    const fe = agent("agt_fe");
    const sup = agent("agt_sup");
    const fpa = agent("agt_fpa");
    // Backend retry run streams spans then finishes T-5.
    const r = be2();
    if (r && be.status !== "paused" && be.status !== "terminated") {
      const running = S.spans.filter((s) => s.runId === r.id && s.status === "running" && s.kind !== "run");
      if (tick % 3 === 1) {
        for (const s of running) endSpan(s, { tier: "standard" });
        const n = S.spans.filter((s) => s.runId === r.id).length;
        if (n < 9) {
          const tool = n % 2 === 0;
          newSpan({ traceId: r.traceId, parent: r.rootSpanId, kind: tool ? "tool" : "llm", name: tool ? "tool.run_tests" : "llm.chat", agentId: be.id, runId: r.id, taskId: r.taskId, input: tool ? '{"suite":"checkout.spec.ts"}' : null });
          touchAgent(be, { status: tool ? "acting" : "thinking", activity: tool ? "Running checkout.spec.ts with the stubbed provider" : "Reading test output" });
        } else {
          const root = S.spans.find((s) => s.id === r.rootSpanId);
          endRun(r, root, "completed", "GET /pricing/plans and POST /checkout/session implemented; 14/14 checkout tests pass.");
          const t5 = task("tsk_api");
          if (t5 && t5.assigneeId === be.id) touchTask(t5, { status: "done", result: "GET /pricing/plans and POST /checkout/session implemented; 14/14 checkout tests pass." }, `${be.name} completed T-${t5.number}: ${t5.title}`);
          touchAgent(be, { status: "idle", activity: null, currentRunId: null, currentTaskId: null });
          postMessage("cnv_adm_cto_be", be.id, "T-5 is done: both endpoints live, 14/14 checkout tests passing.", { taskId: "tsk_api", traceId: r.traceId });
        }
      }
    }
    // Frontend picks up T-6 once T-5 is done.
    const t6 = task("tsk_ui");
    if (t6 && t6.status === "todo" && task("tsk_api")?.status === "done" && fe && fe.status === "idle" && !S.settings.paused) {
      touchTask(t6, { status: "in_progress", startedAt: iso(), attempts: 1 }, `${fe.name} started T-${t6.number}: ${t6.title}`);
      const parent = t6.state.delegationSpanId;
      const { run, root } = newRun({ agentId: fe.id, taskId: t6.id, traceId: t6.traceId, parent, trigger: "task" });
      Object.assign(feRun, { run, root, steps: 0 });
      touchAgent(fe, { status: "thinking", activity: "Planning the pricing page layout", currentTaskId: t6.id, currentRunId: run.id });
    } else if (feRun.run && feRun.run.status === "running" && tick % 2 === 0 && fe.status !== "paused" && fe.status !== "terminated") {
      for (const s of S.spans.filter((s) => s.runId === feRun.run.id && s.status === "running" && s.kind !== "run")) endSpan(s);
      const steps = ["llm.chat", "tool.workspace_read_file", "llm.chat", "tool.workspace_write_file", "llm.chat", "tool.workspace_write_file"];
      const name = steps[feRun.steps++ % steps.length];
      newSpan({ traceId: feRun.run.traceId, parent: feRun.root.id, kind: name.startsWith("tool") ? "tool" : "llm", name, agentId: fe.id, runId: feRun.run.id, taskId: t6.id });
      touchAgent(fe, { status: name.startsWith("tool") ? "acting" : "thinking", activity: name.startsWith("tool") ? "Writing src/pages/pricing.tsx" : "Laying out three plan cards" });
      if (feRun.steps > 24) {
        const ended = S.spans.filter((s) => s.runId === feRun.run.id);
        S.spans = S.spans.filter((s) => !(s.runId === feRun.run.id && s.kind !== "run" && ended.indexOf(s) < ended.length - 6));
        feRun.steps = 6;
      }
    }
    // Ambient worker activity.
    if (tick % 4 === 2 && sup && sup.status !== "paused" && sup.status !== "terminated") {
      touchAgent(sup, { status: tick % 8 === 2 ? "thinking" : "acting", activity: supportLines[(tick / 4) % supportLines.length | 0] });
      const tt = task("tsk_tickets");
      if (tt && !TERMINAL.has(tt.status)) touchTask(tt, { actualCostUsd: round6(tt.actualCostUsd + 0.0004) }, `${sup.name} answered a ticket on T-${tt.number}`);
    }
    if (tick % 9 === 5 && fpa && fpa.status !== "paused" && fpa.status !== "terminated") {
      touchAgent(fpa, fpa.status === "idle" ? { status: "thinking", activity: "Refreshing the hourly spend forecast" } : { status: "idle", activity: null });
    }
    if (tick % 15 === 7) {
      const [c, who, text] = chatter[(tick / 15) % chatter.length | 0];
      if (agent(who)?.status !== "terminated") postMessage(c, who, text);
    }
  }

  const timer = setInterval(() => {
    if (S.settings.paused) return;
    for (const w of walkers) walkerTick(w);
    ambient();
  }, tickMs);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": heartbeat\n\n");
  }, 15_000);

  // ───────────── routing ─────────────
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler });
  const need = (v, what) => {
    if (!v) throw new HttpError(404, "not_found", `${what} not found`);
    return v;
  };

  route("GET", "/api/health", () => ({ ok: true, fixture: true, org }));
  route("GET", "/api/company", () => snapshot());
  route("PATCH", "/api/company", ({ body }) => {
    const allowed = ["name", "mission", "dailyBudgetUsd", "monthlyBudgetUsd", "maxConcurrentRuns", "maxHeadcount", "hiringRequiresApproval", "heartbeatMinutes"];
    for (const k of allowed) if (k in body) S.settings[k] = body[k];
    emit("company.updated", "Board updated company settings", structuredClone(S.settings));
    return S.settings;
  });
  route("POST", "/api/company/pause", () => {
    S.settings.paused = true;
    for (const r of S.runs.filter((r) => r.status === "running")) {
      const root = S.spans.find((s) => s.id === r.rootSpanId);
      if (root) endRun(r, root, "interrupted", null, "Company paused by the Board");
    }
    for (const w of walkers) Object.assign(w, { run: null, root: null, obj: null, cooldown: 2 });
    for (const a of S.agents) if (["thinking", "acting"].includes(a.status)) touchAgent(a, { status: "idle", activity: "Company paused", brainBlock: null, currentRunId: null });
    emit("company.updated", "Board paused the company: all runs stopped", structuredClone(S.settings));
    return snapshot();
  });
  route("POST", "/api/company/resume", () => {
    S.settings.paused = false;
    for (const a of S.agents) if (a.activity === "Company paused") touchAgent(a, { activity: null });
    emit("company.updated", "Board resumed the company", structuredClone(S.settings));
    return snapshot();
  });
  route("GET", "/api/org", () => ({ departments: S.departments, agents: S.agents }));
  route("GET", "/api/roles", () => ROLE_TEMPLATES);
  route("GET", "/api/models", () => S.models);
  route("GET", "/api/agents", ({ q }) => S.agents.filter((a) => (!q.get("status") || a.status === q.get("status")) && (!q.get("departmentId") || a.departmentId === q.get("departmentId"))));
  route("POST", "/api/agents", ({ body }) => createAgent(body));
  route("GET", "/api/agents/:id", ({ p }) => {
    const a = need(agent(p.id), `Agent ${p.id}`);
    const stats = agentStats(a);
    return {
      agent: a,
      stats,
      needs: needs(a, stats),
      manager: a.managerId ? agent(a.managerId) ?? null : null,
      reports: S.agents.filter((x) => x.managerId === a.id && x.status !== "terminated"),
      currentTask: a.currentTaskId ? task(a.currentTaskId) ?? null : null,
      recentRuns: S.runs.filter((r) => r.agentId === a.id).sort((x, y) => (y.startedAt ?? "").localeCompare(x.startedAt ?? "")).slice(0, 12),
      openTasks: S.tasks.filter((t) => t.assigneeId === a.id && !TERMINAL.has(t.status)).sort((x, y) => y.priority - x.priority),
    };
  });
  route("PATCH", "/api/agents/:id", ({ p, body }) => {
    const a = need(agent(p.id), `Agent ${p.id}`);
    if (a.status === "terminated") throw new HttpError(409, "conflict", "Terminated agents can't be edited");
    if ("managerId" in body) {
      if (body.managerId === a.id) throw new HttpError(400, "bad_request", "An agent can't manage itself");
      if (body.managerId && !agent(body.managerId)) throw new HttpError(400, "bad_request", "Unknown manager");
    }
    if ("monthlyBudgetUsd" in body && !(body.monthlyBudgetUsd >= 0)) throw new HttpError(400, "bad_request", "monthlyBudgetUsd must be a non-negative number");
    for (const k of ["name", "title", "managerId", "departmentId", "modelTier", "modelOverride", "monthlyBudgetUsd", "tools"]) if (k in body) a[k] = body[k];
    if (body.persona) Object.assign(a.persona, body.persona);
    if (body.identity) Object.assign(a.identity, body.identity);
    a.updatedAt = iso();
    emit("agent.updated", `Board updated ${a.name}'s settings`, structuredClone(a));
    return a;
  });
  route("POST", "/api/agents/:id/pause", ({ p }) => {
    const a = need(agent(p.id), `Agent ${p.id}`);
    if (a.status === "terminated") throw new HttpError(409, "conflict", "Agent is terminated");
    for (const r of S.runs.filter((r) => r.agentId === a.id && r.status === "running")) {
      const root = S.spans.find((s) => s.id === r.rootSpanId);
      if (root) endRun(r, root, "interrupted", null, "Paused by the Board");
    }
    const w = walkers.find((x) => x.agentId === a.id);
    if (w) Object.assign(w, { run: null, root: null, obj: null, cooldown: 2 });
    touchAgent(a, { status: "paused", activity: "Paused by the Board", brainBlock: null, currentRunId: null }, `${a.name} was paused`);
    return a;
  });
  route("POST", "/api/agents/:id/resume", ({ p }) => {
    const a = need(agent(p.id), `Agent ${p.id}`);
    if (a.status !== "paused") throw new HttpError(409, "conflict", `${a.name} is not paused`);
    touchAgent(a, { status: "idle", activity: null }, `${a.name} was resumed`);
    return a;
  });
  route("DELETE", "/api/agents/:id", ({ p }) => destroyAgent(p.id));
  route("GET", "/api/agents/:id/memory", ({ p, q }) => searchMemory(S.memories.filter((m) => m.agentId === p.id), q));
  route("GET", "/api/conversations", ({ q }) => {
    const id = q.get("agentId");
    return S.conversations.filter((c) => !id || c.participantIds.includes(id)).sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  });
  route("POST", "/api/conversations", ({ body }) => {
    if (body.kind === "boardroom") return S.conversations.find((c) => c.kind === "boardroom");
    const id = body.agentId === "ceo" ? "agt_ceo" : body.agentId;
    const a = agent(id);
    if (!a) throw new HttpError(400, "bad_request", "agentId is required");
    if (a.status === "terminated") throw new HttpError(409, "conflict", `${a.name} is terminated`);
    let c = S.conversations.find((x) => x.kind === "dm" && x.participantIds.includes(id));
    if (!c) {
      c = { id: S.nextId("cnv"), kind: "dm", title: a.name, participantIds: ["human", id], createdAt: iso(), lastMessageAt: null };
      S.conversations.push(c);
    }
    return c;
  });
  route("GET", "/api/conversations/:id/messages", ({ p, q }) => {
    need(S.conversations.find((c) => c.id === p.id), `Conversation ${p.id}`);
    const after = q.get("after");
    return S.messages.filter((m) => m.conversationId === p.id && (!after || m.createdAt > after)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
  route("POST", "/api/conversations/:id/messages", ({ p, body }) => {
    const c = need(S.conversations.find((x) => x.id === p.id), `Conversation ${p.id}`);
    if (c.kind === "agent_dm") throw new HttpError(403, "forbidden", "Agent-to-agent threads are read-only for the Board");
    const content = String(body.content ?? "").trim();
    if (!content) throw new HttpError(400, "bad_request", "content is required");
    const m = postMessage(c.id, "human", content);
    const runId = replyTo(c, m);
    return { message: m, runId };
  });
  route("GET", "/api/tasks", ({ q }) => S.tasks.filter((t) => (!q.get("status") || t.status === q.get("status")) && (!q.get("assigneeId") || t.assigneeId === q.get("assigneeId")) && (!q.get("rootTaskId") || t.rootTaskId === q.get("rootTaskId")) && (!q.get("traceId") || t.traceId === q.get("traceId"))));
  route("POST", "/api/tasks", ({ body }) => {
    if (!body.title?.trim()) throw new HttpError(400, "bad_request", "title is required");
    const assigneeId = body.assigneeId ?? "agt_ceo";
    const a = agent(assigneeId);
    if (!a || a.status === "terminated") throw new HttpError(400, "bad_request", "Assignee must be an active agent");
    const t = createTask({ title: body.title.trim(), description: body.description ?? "", assigneeId, acceptanceCriteria: body.acceptanceCriteria ?? null, value: body.value ?? 100, estCostUsd: body.estCostUsd ?? 0.2 });
    setTimeout(() => {
      if (t.status === "todo" && !S.settings.paused && a.status !== "paused") touchTask(t, { status: "in_progress", startedAt: iso(), attempts: 1 }, `${a.name} started T-${t.number}`);
    }, 2500);
    return t;
  });
  route("GET", "/api/tasks/:id", ({ p }) => {
    const t = need(task(p.id), `Task ${p.id}`);
    return { task: t, subtasks: S.tasks.filter((x) => x.parentTaskId === t.id), runs: S.runs.filter((r) => r.taskId === t.id).sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")), assignee: t.assigneeId ? agent(t.assigneeId) ?? null : null, approvals: S.approvals.filter((a) => a.taskId === t.id) };
  });
  route("POST", "/api/tasks/:id/cancel", ({ p }) => {
    const t = need(task(p.id), `Task ${p.id}`);
    if (TERMINAL.has(t.status)) throw new HttpError(409, "conflict", `T-${t.number} is already ${t.status}`);
    const cancel = (x) => {
      for (const c of S.tasks.filter((c) => c.parentTaskId === x.id && !TERMINAL.has(c.status))) cancel(c);
      touchTask(x, { status: "cancelled" }, `Board cancelled T-${x.number}`);
    };
    cancel(t);
    return t;
  });
  route("POST", "/api/tasks/:id/retry", ({ p }) => {
    const t = need(task(p.id), `Task ${p.id}`);
    if (!["failed", "cancelled"].includes(t.status)) throw new HttpError(409, "conflict", `Only failed or cancelled tasks can be retried (T-${t.number} is ${t.status})`);
    touchTask(t, { status: "todo", error: null, attempts: 0, completedAt: null }, `Board retried T-${t.number}`);
    return t;
  });
  route("GET", "/api/runs", ({ q }) => {
    const lim = Number(q.get("limit") ?? 50);
    return S.runs.filter((r) => (!q.get("agentId") || r.agentId === q.get("agentId")) && (!q.get("taskId") || r.taskId === q.get("taskId"))).sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")).slice(0, lim);
  });
  route("GET", "/api/runs/:id", ({ p }) => {
    const r = need(S.runs.find((x) => x.id === p.id), `Run ${p.id}`);
    return { run: r, spans: S.spans.filter((s) => s.runId === r.id) };
  });
  route("POST", "/api/runs/:id/cancel", ({ p }) => {
    const r = need(S.runs.find((x) => x.id === p.id), `Run ${p.id}`);
    if (r.status !== "running") throw new HttpError(409, "conflict", `Run is ${r.status}`);
    const root = S.spans.find((s) => s.id === r.rootSpanId);
    endRun(r, root, "cancelled", null, "Interrupted by the Board");
    return r;
  });
  route("GET", "/api/traces", ({ q }) => {
    const ids = [...new Set(S.spans.map((s) => s.traceId))];
    return ids.map(traceSummary).filter(Boolean).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, Number(q.get("limit") ?? 50));
  });
  route("GET", "/api/traces/:traceId", ({ p }) => {
    const summary = traceSummary(p.traceId);
    const tasks = S.tasks.filter((t) => t.traceId === p.traceId);
    if (!summary && !tasks.length) throw new HttpError(404, "not_found", `Trace ${p.traceId} not found`);
    const root = tasks.find((t) => !t.parentTaskId);
    return { summary: summary ?? { traceId: p.traceId, title: root?.title ?? p.traceId, rootTaskId: root?.id ?? null, status: "running", startedAt: root?.createdAt ?? iso(), endedAt: null, agentIds: [], spanCount: 0, llmCalls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 }, spans: S.spans.filter((s) => s.traceId === p.traceId), tasks };
  });
  route("GET", "/api/approvals", ({ q }) => S.approvals.filter((a) => !q.get("status") || a.status === q.get("status")).sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)));
  route("POST", "/api/approvals/:id/decide", ({ p, body }) => {
    const ap = need(S.approvals.find((x) => x.id === p.id), `Approval ${p.id}`);
    if (ap.status !== "pending") throw new HttpError(409, "conflict", "This approval was already decided");
    if (!["approved", "rejected"].includes(body.decision)) throw new HttpError(400, "bad_request", "decision must be approved or rejected");
    Object.assign(ap, { status: body.decision, decidedBy: "human", note: body.note ?? null, decidedAt: iso() });
    emit("approval.decided", `Board ${ap.status} ${ap.summary}`, structuredClone(ap), { agentId: ap.requestedBy });
    if (ap.status === "approved") {
      if (ap.kind === "hire_agent") {
        const pl = ap.payload;
        createAgent({ roleId: pl.roleId, name: pl.name, title: pl.title, departmentId: pl.departmentId, managerId: pl.managerId, tier: pl.tier, cognition: pl.cognition, modelTier: pl.modelTier, monthlyBudgetUsd: pl.monthlyBudgetUsd }, ap.requestedBy);
      } else if (ap.kind === "budget_increase") {
        const dep = S.departments.find((d) => d.id === ap.payload.departmentId);
        if (dep) dep.monthlyBudgetUsd += Number(ap.payload.amountUsd ?? 0);
      } else if (ap.kind === "terminate_agent") {
        if (agent(ap.payload.agentId)?.status !== "terminated") destroyAgent(ap.payload.agentId);
      }
    }
    const t = ap.taskId ? task(ap.taskId) : null;
    if (t && t.status === "blocked") {
      touchTask(t, { status: "todo", state: { ...t.state, humanAnswer: { decision: ap.status, note: ap.note } } }, `T-${t.number} unblocked by the Board`);
      const a = agent(t.assigneeId);
      if (a && a.status === "blocked") touchAgent(a, { status: "idle", activity: `Board answered: ${ap.status}` });
    }
    return ap;
  });
  route("GET", "/api/blackboard", () => [...S.blackboard].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  route("PUT", "/api/blackboard/:key", ({ p, body }) => {
    const key = decodeURIComponent(p.key);
    if (typeof body.value !== "string") throw new HttpError(400, "bad_request", "value must be a string");
    let e = S.blackboard.find((x) => x.key === key);
    if (!e) S.blackboard.push((e = { key, value: "", updatedBy: "human", updatedAt: iso() }));
    Object.assign(e, { value: body.value, updatedBy: "human", updatedAt: iso() });
    return e;
  });
  route("GET", "/api/memory", ({ q }) => searchMemory(S.memories.filter((m) => m.scope === "global"), q));
  route("GET", "/api/metrics/overview", () => metrics());
  route("GET", "/api/metrics/timeseries", ({ q }) => timeseries(q.get("metric") ?? "cost", Math.min(168, Number(q.get("hours") ?? 24))));
  route("GET", "/api/events", ({ q }) => {
    const since = Number(q.get("since") ?? 0);
    const lim = Number(q.get("limit") ?? 100);
    const list = S.events.filter((e) => e.seq > since);
    return since ? list.slice(0, lim) : list.slice(-lim);
  });

  function searchMemory(list, q) {
    const term = (q.get("q") ?? "").toLowerCase().trim();
    const kind = q.get("kind");
    return list
      .filter((m) => (!kind || m.kind === kind) && (!term || term.split(/\s+/).every((w) => m.content.toLowerCase().includes(w) || m.tags.some((t) => t.includes(w)))))
      .sort((a, b) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt));
  }

  // ───────────── http ─────────────
  async function serveStatic(pathname, res) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, rel);
    if (!file.startsWith(DIST)) file = join(DIST, "index.html");
    try {
      const st = await stat(file);
      if (st.isDirectory()) file = join(file, "index.html");
    } catch {
      file = join(DIST, "index.html"); // SPA fallback
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Console not built. Run: node apps/web/build.mjs");
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);
    if (url.pathname === "/api/events/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 2000\n\n");
      const last = Number(req.headers["last-event-id"] ?? 0);
      if (last) for (const ev of S.events.filter((e) => e.seq > last)) res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    let body = {};
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: { code: "bad_json", message: "Request body is not valid JSON" } });
        }
      }
    }
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs * (0.5 + Math.random())));
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      try {
        return sendJson(res, 200, await r.handler({ p: m.groups ?? {}, q: url.searchParams, body }));
      } catch (err) {
        if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
        console.error("[fixture] handler error", err);
        return sendJson(res, 500, { error: { code: "internal", message: String(err?.message ?? err) } });
      }
    }
    const known = routes.some((r) => r.re.test(url.pathname));
    return sendJson(res, known ? 405 : 404, { error: { code: known ? "method_not_allowed" : "not_found", message: `${req.method} ${url.pathname} is not a route` } });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  log(`AgentCo fixture server on http://${host}:${addr.port} (org=${org}, models=${live ? "live" : "mock"})`);
  return {
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    state: S,
    close: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        clearInterval(heartbeat);
        for (const res of clients) res.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  startFixtureServer({
    port: Number(arg("port") ?? process.env.FIXTURE_PORT ?? 5173),
    org: arg("org") ?? process.env.FIXTURE_ORG ?? "startup",
    live: process.argv.includes("--live") || process.env.FIXTURE_LIVE === "1",
    latencyMs: Number(process.env.FIXTURE_LATENCY_MS ?? 60),
    tickMs: Number(process.env.FIXTURE_TICK_MS ?? 1000),
  });
}
