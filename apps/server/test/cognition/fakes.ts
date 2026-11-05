/**
 * In-memory fakes for cognition tests: a recording Tracer, a BudgetGate, and a
 * FakePlatform implementing PlatformServices with the real ModelRouter on the
 * mock provider (latency 0).
 */
import type {
  Agent,
  Approval,
  BlackboardEntry,
  BrainBlockId,
  Department,
  MemoryItem,
  Message,
  NeedsState,
  Run,
  SpanAttributes,
  SpanKind,
  SpanStatus,
  Task,
} from "../../../../packages/shared/src/index.ts";
import type {
  AgentStateWriter,
  BlockProfile,
  BudgetGate,
  CognitiveStatePatch,
  CreateObjectiveInput,
  EndSpanOptions,
  EngineContext,
  EngineInput,
  MemorySearchQuery,
  MemoryService,
  MemoryWriteInput,
  MetricsView,
  ModelProvider,
  ModelRouter,
  OrgView,
  PlatformServices,
  SpanHandle,
  SpendEntry,
  StartSpanOptions,
  TaskView,
  ToolCall,
  ToolCallContext,
  ToolExecutor,
  ToolResult,
  ToolSpec,
  Tracer,
} from "../../src/contracts.ts";
import { loadModelConfig, type ModelConfig } from "../../src/models/config.ts";
import { createModelRouter } from "../../src/models/router.ts";
import { tokens } from "../../src/cognition/text.ts";

// ───────────────────────────── Tracer ─────────────────────────────

export interface RecordedSpan {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  agentId: string | null;
  runId: string | null;
  taskId: string | null;
  attributes: SpanAttributes;
  input: string | null;
  output: string | null;
  error: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

let seq = 0;
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36).padStart(4, "0")}`;
}

export class RecordingTracer implements Tracer {
  spans: RecordedSpan[] = [];

  startSpan(options: StartSpanOptions): SpanHandle {
    const span: RecordedSpan = {
      id: nextId("spn"),
      traceId: options.traceId,
      parentSpanId: options.parentSpanId,
      kind: options.kind,
      name: options.name,
      status: "running",
      agentId: options.agentId ?? null,
      runId: options.runId ?? null,
      taskId: options.taskId ?? null,
      attributes: { ...(options.attributes ?? {}) },
      input: options.input ?? null,
      output: null,
      error: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    };
    this.spans.push(span);
    return this.handle(span);
  }

  private handle(span: RecordedSpan): SpanHandle {
    const tracer = this;
    return {
      spanId: span.id,
      traceId: span.traceId,
      setAttributes(attributes: SpanAttributes) {
        Object.assign(span.attributes, attributes);
      },
      end(options: EndSpanOptions = {}) {
        if (span.status !== "running") return;
        span.status = options.status ?? "ok";
        span.output = options.output ?? null;
        span.error = options.error ?? null;
        if (options.attributes) Object.assign(span.attributes, options.attributes);
        span.model = options.model ?? span.model;
        span.inputTokens = options.inputTokens ?? span.inputTokens;
        span.outputTokens = options.outputTokens ?? span.outputTokens;
        span.costUsd = options.costUsd ?? span.costUsd;
      },
      child(options) {
        return tracer.startSpan({
          ...options,
          traceId: span.traceId,
          parentSpanId: span.id,
          agentId: options.agentId ?? span.agentId,
          runId: options.runId ?? span.runId,
          taskId: options.taskId ?? span.taskId,
        });
      },
    };
  }

  async withSpan<T>(options: StartSpanOptions, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    const span = this.startSpan(options);
    try {
      const v = await fn(span);
      span.end({ status: "ok" });
      return v;
    } catch (err) {
      span.end({ status: (err as Error).name === "AbortError" ? "cancelled" : "error", error: (err as Error).message });
      throw err;
    }
  }

  byKind(kind: SpanKind): RecordedSpan[] {
    return this.spans.filter((s) => s.kind === kind);
  }
  blocks(): string[] {
    return this.spans.map((s) => s.attributes["agentco.brain.block"]).filter((b): b is string => typeof b === "string");
  }
}

// ───────────────────────────── Budget ─────────────────────────────

export class FakeBudget implements BudgetGate {
  entries: SpendEntry[] = [];
  asserts: { agentId: string; estimateUsd: number }[] = [];
  limitUsd = Infinity;

  assertCanSpend(agentId: string, estimateUsd: number): void {
    this.asserts.push({ agentId, estimateUsd });
    const spent = this.entries.reduce((n, e) => n + e.costUsd, 0);
    if (spent + estimateUsd > this.limitUsd) {
      throw Object.assign(new Error(`budget exceeded: ${spent} + ${estimateUsd} > ${this.limitUsd}`), {
        name: "BudgetExceededError",
        scope: "company",
        limitUsd: this.limitUsd,
        spentUsd: spent,
      });
    }
  }
  recordSpend(entry: SpendEntry): void {
    this.entries.push(entry);
  }
  total(): number {
    return this.entries.reduce((n, e) => n + e.costUsd, 0);
  }
}

// ───────────────────────────── Factories ─────────────────────────────

export function makeAgent(partial: Partial<Agent> & { id: string }): Agent {
  const now = "2026-11-01T09:00:00.000Z";
  const base: Agent = {
    id: partial.id,
    name: "Test Agent",
    title: "Agent",
    roleId: "agent",
    catalogId: null,
    departmentId: "dep_general",
    managerId: null,
    tier: "worker",
    cognition: "reflex",
    modelTier: "economy",
    modelOverride: null,
    status: "idle",
    activity: null,
    brainBlock: null,
    currentTaskId: null,
    currentRunId: null,
    identity: {
      mission: "Do good work.",
      worldview: "Work is a series of experiments.",
      lifeView: "A good working life is useful, honest work.",
      values: ["honesty", "ownership"],
      vision: "A company that ships what it promises.",
      desires: { taskDriven: 0.6, curiosity: 0.5, epistemic: 0.5, vision: 0.5 },
      motivation: { autonomy: 0.6, competence: 0.6, purpose: 0.6 },
      okrs: [],
      narrative: "",
      assets: [],
      resourceConnections: [],
    },
    persona: { style: "concise and warm", traits: ["pragmatic"], personalityType: null, baZi: null },
    affect: { valence: 0, arousal: 0.3, frustration: 0 },
    calibration: { samples: 0, meanConfidence: 0.7, successRate: 0.7, brier: 0 },
    tools: [],
    monthlyBudgetUsd: 10,
    createdBy: "system",
    createdAt: now,
    updatedAt: now,
    terminatedAt: null,
  };
  return { ...base, ...partial, identity: { ...base.identity, ...(partial.identity ?? {}) } };
}

export function makeTask(partial: Partial<Task> & { id: string }): Task {
  const now = "2026-11-01T09:00:00.000Z";
  return {
    number: 1,
    traceId: "trc_test",
    parentTaskId: null,
    rootTaskId: partial.rootTaskId ?? partial.id,
    title: "Task",
    description: "Do the task.",
    acceptanceCriteria: null,
    createdBy: "human",
    assigneeId: null,
    departmentId: null,
    status: "in_progress",
    value: 100,
    estCostUsd: 0.1,
    actualCostUsd: 0,
    priority: 1000,
    result: null,
    error: null,
    attempts: 1,
    maxAttempts: 2,
    originConversationId: null,
    state: {},
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    ...partial,
    id: partial.id,
  };
}

// ───────────────────────────── Platform ─────────────────────────────

export interface FakePlatformOptions {
  env?: NodeJS.ProcessEnv;
  providers?: Record<string, ModelProvider>;
  config?: ModelConfig;
}

export class FakePlatform implements PlatformServices {
  readonly tracer = new RecordingTracer();
  readonly budget = new FakeBudget();
  readonly config: ModelConfig;
  readonly models: ModelRouter;
  readonly agentMap = new Map<string, Agent>();
  readonly taskMap = new Map<string, Task>();
  readonly departments = new Map<string, Department>();
  readonly memories: MemoryItem[] = [];
  readonly board = new Map<string, BlackboardEntry>();
  readonly files = new Map<string, string>();
  readonly approvals: Approval[] = [];
  readonly sent: { from: string; to: string; content: string }[] = [];
  readonly toolCalls: { name: string; args: Record<string, unknown>; agentId: string; parentSpanId: string }[] = [];
  readonly activity: { agentId: string; status: Agent["status"]; activity: string | null; block: BrainBlockId | null }[] = [];
  readonly patches: { agentId: string; patch: CognitiveStatePatch }[] = [];
  needsOverride = new Map<string, Partial<NeedsState>>();
  budgetRemaining = 50;
  interruptReason: string | null = null;
  /** Make the next N calls of a tool return ok:false. */
  failTool = new Map<string, number>();
  inboxMessages: Message[] = [];
  private taskNumber = 100;
  /** Escalation subtask ids created by the fake escalate tool. */
  readonly escalations: string[] = [];

  constructor(options: FakePlatformOptions = {}) {
    this.config = options.config ?? loadModelConfig({ MOCK_LATENCY_MS: "0", ...(options.env ?? {}) }, { log: () => {} });
    this.models = createModelRouter({
      config: this.config,
      tracer: this.tracer,
      budget: this.budget,
      getAgent: (id) => this.agentMap.get(id) ?? null,
      providers: options.providers,
    });
  }

  now(): Date {
    return new Date("2026-11-05T10:00:00.000Z");
  }

  addAgent(agent: Agent): Agent {
    this.agentMap.set(agent.id, agent);
    return agent;
  }
  addDepartment(id: string, slug: string, name: string): void {
    this.departments.set(id, {
      id,
      slug,
      name,
      mandate: `${name} work`,
      parentId: null,
      headAgentId: null,
      color: "#888888",
      monthlyBudgetUsd: 100,
      createdAt: "2026-11-01T00:00:00.000Z",
    });
  }
  addTask(task: Task): Task {
    this.taskMap.set(task.id, task);
    return task;
  }

  // ── MetricsView: test-set profiles, else computed from recorded llm spans (no latency in the fake tracer).
  readonly profiles = new Map<string, BlockProfile>();
  readonly metrics: MetricsView = {
    blockProfile: (agentId, blockName) => {
      const set = this.profiles.get(blockName);
      if (set) return set;
      const spans = this.tracer.spans.filter((s) => s.kind === "llm" && s.agentId === agentId && s.attributes["agentco.stage"] === blockName && s.status !== "running");
      const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]! : null);
      const ok = spans.filter((s) => s.status === "ok");
      return {
        block: blockName,
        calls: spans.length,
        p50Ms: null,
        p95Ms: null,
        p95InputTokens: p95(ok.map((s) => s.inputTokens ?? 0)),
        p95OutputTokens: p95(ok.map((s) => s.outputTokens ?? 0)),
        meanCostUsd: ok.length ? ok.reduce((n, s) => n + (s.costUsd ?? 0), 0) / ok.length : null,
        errorRate: spans.length ? spans.filter((s) => s.status === "error").length / spans.length : null,
      };
    },
  };

  // ── OrgView
  readonly org: OrgView = {
    getAgent: (id) => this.agentMap.get(id) ?? null,
    directReports: (id) => [...this.agentMap.values()].filter((a) => a.managerId === id && a.status !== "terminated"),
    managerChain: (id) => {
      const chain: Agent[] = [];
      let cur = this.agentMap.get(id);
      while (cur?.managerId) {
        const m = this.agentMap.get(cur.managerId);
        if (!m) break;
        chain.push(m);
        cur = m;
      }
      return chain;
    },
    listActiveAgents: () => [...this.agentMap.values()].filter((a) => a.status !== "terminated" && a.status !== "paused"),
    departmentName: (id) => this.departments.get(id)?.name ?? "General",
    department: (id) => this.departments.get(id) ?? null,
    needs: (id) => ({
      physiological: "ok",
      safety: "ok",
      belonging: this.agentMap.get(id)?.managerId || [...this.agentMap.values()].some((a) => a.managerId === id) ? "ok" : "low",
      esteem: "ok",
      selfActualization: 0.3,
      ...(this.needsOverride.get(id) ?? {}),
    }),
    budgetRemainingUsd: () => this.budgetRemaining,
  };

  // ── TaskView
  readonly tasks: TaskView = {
    get: (id) => this.taskMap.get(id) ?? null,
    children: (id) => [...this.taskMap.values()].filter((t) => t.parentTaskId === id),
    createObjective: (input: CreateObjectiveInput) => {
      const id = nextId("tsk");
      const task = makeTask({
        id,
        number: ++this.taskNumber,
        traceId: input.traceId,
        title: input.title,
        description: input.description,
        assigneeId: input.assigneeId,
        createdBy: input.createdBy,
        originConversationId: input.originConversationId,
        acceptanceCriteria: input.acceptanceCriteria ?? null,
        value: input.value ?? 100,
        estCostUsd: input.estCostUsd ?? 0.1,
        status: "todo",
        state: { objectiveParentSpanId: input.parentSpanId ?? null },
      });
      this.taskMap.set(id, task);
      return task;
    },
    // Like the real TaskService: the stored row is replaced and a fresh copy returned, so an
    // engine holding the run's input snapshot does NOT see the patch unless it uses the result.
    patchState: (taskId, patch) => {
      const t = this.taskMap.get(taskId);
      if (!t) throw new Error(`no task ${taskId}`);
      const next: Task = { ...t, state: { ...t.state, ...patch } };
      this.taskMap.set(taskId, next);
      return { ...next, state: { ...next.state } };
    },
    interruptFor: () => this.interruptReason,
    cancel: (taskId, reason) => {
      const t = this.taskMap.get(taskId);
      if (!t) throw new Error(`no task ${taskId}`);
      if (["done", "failed", "cancelled"].includes(t.status)) return t;
      for (const c of [...this.taskMap.values()].filter((x) => x.parentTaskId === taskId)) this.tasks.cancel(c.id, reason);
      t.status = "cancelled";
      t.error = reason;
      this.cancelled.push({ taskId, reason });
      return t;
    },
  };
  /** Tasks cancelled through TaskView.cancel (in order). */
  readonly cancelled: { taskId: string; reason: string }[] = [];

  // ── AgentStateWriter
  readonly agents: AgentStateWriter = {
    setActivity: (agentId, status, activity, block) => {
      this.activity.push({ agentId, status, activity, block: block ?? null });
      const a = this.agentMap.get(agentId);
      if (a) {
        a.status = status;
        a.activity = activity;
        if (block !== undefined) a.brainBlock = block;
      }
    },
    updateCognitiveState: (agentId, patch) => {
      this.patches.push({ agentId, patch });
      const a = this.agentMap.get(agentId);
      if (!a) throw new Error(`no agent ${agentId}`);
      if (patch.affect) a.affect = patch.affect;
      if (patch.calibration) a.calibration = patch.calibration;
      if (patch.narrative !== undefined) a.identity.narrative = patch.narrative;
      if (patch.okrs) a.identity.okrs = patch.okrs;
      return a;
    },
  };

  // ── MemoryService
  readonly memory: MemoryService = {
    search: (q: MemorySearchQuery) => {
      const qt = new Set(tokens(q.query));
      const scopes = q.scopes ?? ["agent", "global"];
      return this.memories
        .filter((m) => scopes.includes(m.scope) && (m.scope === "global" || m.agentId === q.agentId))
        .filter((m) => !q.kinds || q.kinds.includes(m.kind))
        .map((m) => ({ m, score: tokens(m.content).filter((t) => qt.has(t)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, q.limit ?? 6)
        .map((x) => x.m);
    },
    write: (input: MemoryWriteInput) => {
      const item: MemoryItem = {
        id: nextId("mem"),
        scope: input.scope,
        agentId: input.agentId,
        kind: input.kind,
        content: input.content,
        tags: input.tags ?? [],
        importance: input.importance ?? 0.5,
        sourceRunId: input.sourceRunId ?? null,
        sourceTaskId: input.sourceTaskId ?? null,
        accessCount: 0,
        createdAt: this.now().toISOString(),
        lastAccessedAt: null,
      };
      this.memories.push(item);
      return item;
    },
    blackboardList: () => [...this.board.values()],
    blackboardGet: (key) => this.board.get(key) ?? null,
    blackboardSet: (key, value, updatedBy) => {
      const e = { key, value, updatedBy, updatedAt: this.now().toISOString() };
      this.board.set(key, e);
      return e;
    },
    inbox: () => this.inboxMessages.filter((m) => !m.readAt),
    markRead: (ids) => {
      for (const m of this.inboxMessages) if (ids.includes(m.id)) m.readAt = this.now().toISOString();
    },
  };

  // ── ToolExecutor
  readonly tools: ToolExecutor = {
    specsFor: (agent: Agent): ToolSpec[] =>
      agent.tools.map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } })),
    execute: async (call: ToolCall, ctx: ToolCallContext): Promise<ToolResult> => {
      const span = this.tracer.startSpan({
        traceId: ctx.traceId,
        parentSpanId: ctx.parentSpanId,
        kind: "tool",
        name: `tool.${call.name}`,
        agentId: ctx.agent.id,
        runId: ctx.runId,
        taskId: ctx.taskId,
        attributes: { "gen_ai.tool.name": call.name },
      });
      this.toolCalls.push({ name: call.name, args: call.arguments, agentId: ctx.agent.id, parentSpanId: ctx.parentSpanId });
      const failures = this.failTool.get(call.name) ?? 0;
      if (failures > 0) {
        this.failTool.set(call.name, failures - 1);
        span.end({ status: "error", error: "forced failure" });
        return { ok: false, content: `${call.name} failed (forced)`, effects: [] };
      }
      const result = this.runTool(call, ctx, span);
      span.end({ status: result.ok ? "ok" : "error" });
      return result;
    },
  };

  private runTool(call: ToolCall, ctx: ToolCallContext, span: SpanHandle): ToolResult {
    const a = call.arguments;
    switch (call.name) {
      case "delegate_task": {
        const assignee = this.agentMap.get(String(a.assigneeId));
        if (!assignee) return { ok: false, content: `unknown assignee ${String(a.assigneeId)}`, effects: [] };
        const parent = ctx.taskId ? this.taskMap.get(ctx.taskId) : undefined;
        const delegation = span.child({ kind: "delegation", name: `delegate → ${assignee.name}`, attributes: { "agentco.delegate.to": assignee.id } });
        const id = nextId("tsk");
        this.taskMap.set(
          id,
          makeTask({
            id,
            number: ++this.taskNumber,
            traceId: ctx.traceId,
            parentTaskId: parent?.id ?? null,
            rootTaskId: parent?.rootTaskId ?? id,
            title: String(a.title ?? "subtask"),
            description: String(a.description ?? ""),
            acceptanceCriteria: typeof a.acceptanceCriteria === "string" ? a.acceptanceCriteria : null,
            assigneeId: assignee.id,
            createdBy: ctx.agent.id,
            status: "todo",
            value: typeof a.value === "number" ? a.value : 100,
            estCostUsd: typeof a.estCostUsd === "number" ? a.estCostUsd : 0.1,
            state: { delegationSpanId: delegation.spanId },
          }),
        );
        delegation.end({ status: "ok" });
        return { ok: true, content: `Delegated T-${this.taskNumber} to ${assignee.name}`, data: { taskId: id }, effects: [{ kind: "task_created", taskId: id, assigneeId: assignee.id }] };
      }
      case "workspace_write_file": {
        const path = String(a.path ?? "");
        if (!path || path.includes("..")) return { ok: false, content: "bad path", effects: [] };
        this.files.set(path, String(a.content ?? ""));
        return { ok: true, content: `Wrote ${path}`, effects: [{ kind: "file_written", path }] };
      }
      case "workspace_read_file": {
        const path = String(a.path ?? "");
        const content = this.files.get(path);
        return content === undefined ? { ok: false, content: `no such file ${path}`, effects: [] } : { ok: true, content, effects: [] };
      }
      case "escalate":
      case "ask_human": {
        const approval: Approval = {
          id: nextId("apr"),
          kind: "question",
          status: "pending",
          requestedBy: ctx.agent.id,
          taskId: ctx.taskId,
          traceId: ctx.traceId,
          summary: String(a.question ?? a.reason ?? "question"),
          payload: { ...a },
          decidedBy: null,
          note: null,
          createdAt: this.now().toISOString(),
          decidedAt: null,
        };
        const manager = ctx.agent.managerId ? this.agentMap.get(ctx.agent.managerId) : null;
        if (call.name === "escalate" && manager) {
          this.sent.push({ from: ctx.agent.id, to: manager.id, content: String(a.question ?? a.reason ?? "") });
          const effects: ToolResult["effects"] = [{ kind: "message_sent", messageId: nextId("msg"), conversationId: "cnv_x" }];
          const parent = ctx.taskId ? this.taskMap.get(ctx.taskId) : undefined;
          if (parent) {
            // Mirrors the real tool: an escalation SUBTASK of the caller's task, assigned to the manager.
            const id = nextId("tsk");
            this.taskMap.set(
              id,
              makeTask({
                id,
                number: ++this.taskNumber,
                traceId: ctx.traceId,
                parentTaskId: parent.id,
                rootTaskId: parent.rootTaskId,
                title: `Escalation from ${ctx.agent.name}: ${String(a.question ?? a.reason ?? "").slice(0, 200)}`,
                description: String(a.reason ?? ""),
                assigneeId: manager.id,
                createdBy: ctx.agent.id,
                status: "todo",
                value: 900,
                state: { kind: "escalation", escalatedBy: ctx.agent.id },
              }),
            );
            this.escalations.push(id);
            effects.push({ kind: "task_created", taskId: id, assigneeId: manager.id });
          }
          return { ok: true, content: `Escalated to ${manager.name}`, effects };
        }
        this.approvals.push(approval);
        return { ok: true, content: `Asked the Board (${approval.id})`, effects: [{ kind: "approval_requested", approvalId: approval.id }] };
      }
      case "send_message": {
        this.sent.push({ from: ctx.agent.id, to: String(a.toAgentId), content: String(a.content ?? "") });
        return { ok: true, content: "sent", effects: [{ kind: "message_sent", messageId: nextId("msg"), conversationId: "cnv_x" }] };
      }
      case "memory_write": {
        const m = this.memory.write({ scope: a.scope === "global" ? "global" : "agent", agentId: ctx.agent.id, kind: "semantic", content: String(a.content ?? "") });
        return { ok: true, content: "stored", effects: [{ kind: "memory_written", memoryId: m.id }] };
      }
      case "memory_search":
        return { ok: true, content: JSON.stringify(this.memory.search({ query: String(a.query ?? ""), agentId: ctx.agent.id })), effects: [] };
      case "blackboard_write":
        this.memory.blackboardSet(String(a.key), String(a.value), ctx.agent.id);
        return { ok: true, content: "ok", effects: [] };
      case "blackboard_read":
        return { ok: true, content: JSON.stringify(this.memory.blackboardList()), effects: [] };
      default:
        return { ok: false, content: `unknown tool ${call.name}`, effects: [] };
    }
  }

  /** Builds an EngineContext with a fresh run span. */
  context(agent: Agent, input: EngineInput, options: { signal?: AbortSignal; traceId?: string } = {}): EngineContext {
    const traceId = options.traceId ?? ("task" in input ? input.task.traceId : "trc_chat");
    const taskId = "task" in input ? input.task.id : null;
    const runId = nextId("run");
    const span = this.tracer.startSpan({ traceId, parentSpanId: null, kind: "run", name: `run ${agent.name}`, agentId: agent.id, runId, taskId });
    const run: Run = {
      id: runId,
      agentId: agent.id,
      taskId,
      conversationId: input.trigger === "message" ? input.history.conversation.id : null,
      traceId,
      rootSpanId: span.spanId,
      trigger: input.trigger,
      engine: agent.cognition,
      status: "running",
      output: null,
      error: null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      costUsd: 0,
      llmCalls: 0,
      toolCalls: 0,
      failingSpanId: null,
      startedAt: this.now().toISOString(),
      completedAt: null,
      createdAt: this.now().toISOString(),
    };
    return { agent, run, input, platform: this, span, signal: options.signal ?? new AbortController().signal };
  }
}

export function messageInput(content: string, conversationId = "cnv_board"): EngineInput {
  const message: Message = {
    id: nextId("msg"),
    conversationId,
    senderId: "human",
    content,
    runId: null,
    taskId: null,
    traceId: "trc_chat",
    readAt: null,
    createdAt: "2026-11-05T10:00:00.000Z",
  };
  return {
    trigger: "message",
    message,
    history: {
      conversation: { id: conversationId, kind: "boardroom", title: "Boardroom", participantIds: ["human"], createdAt: message.createdAt, lastMessageAt: message.createdAt },
      messages: [message],
      compacted: false,
    },
  };
}

export function taskInput(task: Task, trigger: Exclude<EngineInput["trigger"], "message"> = "task", extra: Partial<Extract<EngineInput, { task: Task }>> = {}): EngineInput {
  return { trigger, task, subtasks: [], ...extra } as EngineInput;
}
