/**
 * Server-internal seams. TYPES ONLY (erased at runtime).
 *
 *   platform core (db, tasks, runs, tools, memory, tracer)  ── implements ──▶ PlatformServices
 *   cognition (brain, reflex)                               ── implements ──▶ CognitiveEngine
 *   models (router, providers)                              ── implements ──▶ ModelRouter
 *
 * RunService (platform) builds an EngineContext, calls engine.run(ctx) and
 * applies the EngineResult to tasks / conversations. Engines never touch the
 * database directly; everything goes through PlatformServices so every side
 * effect is traced, budgeted and redacted in one place.
 */
import type {
  Agent,
  Approval,
  BlackboardEntry,
  CognitionKind,
  Conversation,
  MemoryItem,
  MemoryKind,
  MemoryScope,
  Message,
  ModelProfile,
  ModelTier,
  NeedsState,
  Run,
  RunTrigger,
  SpanAttributes,
  SpanKind,
  SpanStatus,
  Task,
  Usage,
  AffectState,
  CalibrationStats,
  Okr,
  BrainBlockId,
  Department,
} from "../../../packages/shared/src/index.ts";

// ───────────────────────────── Tracing ─────────────────────────────

export interface StartSpanOptions {
  traceId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  name: string;
  agentId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  attributes?: SpanAttributes;
  /** Raw input; the tracer redacts (redactMachine for tool/llm, redact otherwise) and truncates. */
  input?: string;
}

export interface EndSpanOptions {
  status?: Exclude<SpanStatus, "running">; // default "ok"
  output?: string;
  error?: string;
  attributes?: SpanAttributes;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface SpanHandle {
  readonly spanId: string;
  readonly traceId: string;
  setAttributes(attributes: SpanAttributes): void;
  /** Idempotent: a second end() is ignored. */
  end(options?: EndSpanOptions): void;
  /** Convenience: start a child span inheriting traceId/agentId/runId/taskId. */
  child(options: Omit<StartSpanOptions, "traceId" | "parentSpanId">): SpanHandle;
}

export interface Tracer {
  startSpan(options: StartSpanOptions): SpanHandle;
  /** Run fn inside a span; ends it ok/error (re-throws). AbortError → cancelled. */
  withSpan<T>(options: StartSpanOptions, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
}

// ───────────────────────────── Models ─────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[]; // assistant messages that requested tools
  toolCallId?: string; // tool result messages
  name?: string; // tool name on tool messages
}

/** JSON-Schema-described function, OpenAI tools format. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface ChatRequest {
  tier: ModelTier;
  modelOverride?: string | null; // ModelProfile.id; wins over tier
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** "json" asks the provider for a JSON object (response_format) and the router parses it. */
  responseFormat?: "text" | "json";
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ChatCallContext {
  agentId: string;
  runId: string;
  traceId: string;
  parentSpanId: string;
  taskId?: string | null;
  /** Cognitive stage label for the llm span + routing stats, e.g. "brain.planning", "reflex.step". */
  stage: string;
  signal: AbortSignal;
}

export interface ChatResponse {
  content: string;
  /** Present when responseFormat="json" and the content parsed; else null. */
  json: Record<string, unknown> | null;
  toolCalls: ToolCall[];
  usage: Usage;
  costUsd: number;
  profile: ModelProfile; // the profile that actually served the call (after fallback)
  finishReason: "stop" | "tool_calls" | "length" | "error";
  spanId: string;
}

export interface ModelRouter {
  resolve(tier: ModelTier, override?: string | null): ModelProfile;
  /**
   * One traced, budget-checked model call. Creates an `llm` span (child of
   * ctx.parentSpanId), computes cost from the profile price table, records it
   * on the span, and throws BudgetExceededError *before* calling the provider
   * when the agent or company budget is exhausted. On provider error it retries
   * once on the tier's fallback profile.
   */
  chat(request: ChatRequest, ctx: ChatCallContext): Promise<ChatResponse>;
  /** The tier a stage should use, from stage routing config ("agent" = the agent's own tier). */
  tierForStage(stage: string, agent: Agent): ModelTier;
  isLive(): boolean;
}

/** One provider adapter (openai-compatible, mock, ...). */
export interface ModelProvider {
  readonly name: string;
  complete(
    profile: ModelProfile,
    request: ChatRequest,
    signal: AbortSignal,
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: Usage; finishReason: ChatResponse["finishReason"] }>;
}

// ───────────────────────────── Tools ─────────────────────────────

export interface ToolCallContext {
  agent: Agent;
  runId: string;
  traceId: string;
  parentSpanId: string;
  taskId: string | null;
  conversationId: string | null;
  signal: AbortSignal;
}

export type ToolEffect =
  | { kind: "task_created"; taskId: string; assigneeId: string | null }
  | { kind: "approval_requested"; approvalId: string }
  | { kind: "message_sent"; messageId: string; conversationId: string }
  | { kind: "agent_hired"; agentId: string }
  | { kind: "memory_written"; memoryId: string }
  | { kind: "file_written"; path: string };

export interface ToolResult {
  ok: boolean;
  /** Text returned to the model as the tool message content. */
  content: string;
  data?: unknown;
  effects: ToolEffect[];
}

export interface ToolExecutor {
  /** Tools this agent may call (agent.tools ∩ registry, filtered by tier permission). */
  specsFor(agent: Agent): ToolSpec[];
  /** Executes one call inside a `tool` span. Never throws for tool-level failures (returns ok:false). */
  execute(call: ToolCall, ctx: ToolCallContext): Promise<ToolResult>;
}

// ───────────────────────────── Memory ─────────────────────────────

export interface MemorySearchQuery {
  query: string;
  agentId?: string | null; // include this agent's private memories
  scopes?: MemoryScope[]; // default ["agent","global"]
  kinds?: MemoryKind[];
  limit?: number; // default 6
}

export interface MemoryWriteInput {
  scope: MemoryScope;
  agentId: string | null;
  kind: MemoryKind;
  content: string;
  tags?: string[];
  importance?: number;
  sourceRunId?: string | null;
  sourceTaskId?: string | null;
  /**
   * Upsert: if this agent already wrote a memory of the same scope, kind and tags for the same task,
   * replace its content instead of adding another (a revised attempt re-writing the same fact).
   */
  upsertWithinTask?: boolean;
}

export interface MemoryService {
  /** FTS5/BM25 ranked, blended with importance and recency. Bumps accessCount. */
  search(query: MemorySearchQuery): MemoryItem[];
  write(input: MemoryWriteInput): MemoryItem;
  /** write(), saying whether an earlier memory of the same task was replaced (upsertWithinTask). */
  upsert(input: MemoryWriteInput): { item: MemoryItem; updated: boolean };
  blackboardList(): BlackboardEntry[];
  blackboardGet(key: string): BlackboardEntry | null;
  blackboardSet(key: string, value: string, updatedBy: string): BlackboardEntry;
  /** Unread agent-to-agent messages addressed to this agent. */
  inbox(agentId: string, limit?: number): Message[];
  markRead(messageIds: string[]): void;
}

// ───────────────────────────── Org / Tasks (engine view) ─────────────────────────────

export interface OrgView {
  getAgent(id: string): Agent | null;
  directReports(agentId: string): Agent[];
  /** Managers from direct manager up to the CEO. */
  managerChain(agentId: string): Agent[];
  listActiveAgents(): Agent[];
  departmentName(departmentId: string): string;
  department(departmentId: string): Department | null;
  needs(agentId: string): NeedsState;
  /** Remaining monthly budget for the agent (USD), considering the company cap too. */
  budgetRemainingUsd(agentId: string): number;
}

export interface CreateObjectiveInput {
  title: string;
  description: string;
  assigneeId: string; // usually the calling agent itself
  createdBy: string;
  traceId: string;
  /** The span the objective hangs under (the chat run's root span), so chat → objective → runs is one tree. */
  parentSpanId?: string | null;
  originConversationId: string | null;
  acceptanceCriteria?: string | null;
  value?: number;
  estCostUsd?: number;
}

export interface TaskView {
  get(id: string): Task | null;
  children(id: string): Task[];
  /** Creates a root task (status todo) — used when a chat message turns into real work. */
  createObjective(input: CreateObjectiveInput): Task;
  /** Merge into task.state (persisted working memory). */
  patchState(taskId: string, patch: Record<string, unknown>): Task;
  /**
   * TODO List (Interruptible): a reason string when something more urgent is waiting
   * for this agent — an unanswered human message, or a ready task whose priority
   * exceeds `currentPriority` — else null. Brain engines poll it between blocks.
   */
  interruptFor(agentId: string, currentPriority: number): string | null;
  /**
   * Rollback / Failure Recovery: cancel an open task (and, cascading, its open
   * subtasks), aborting any running run on it. No-op on terminal tasks.
   */
  cancel(taskId: string, reason: string): void;
}

export interface CognitiveStatePatch {
  affect?: AffectState;
  calibration?: CalibrationStats;
  narrative?: string;
  okrs?: Okr[];
  /** Self-Narrative Generator › BIO / Assets (replaces the list). */
  assets?: string[];
  /** Self-Narrative Generator › Resource Connection (replaces the list). */
  resourceConnections?: string[];
}

export interface AgentStateWriter {
  /**
   * Updates status/activity (and, for brain agents, the diagram block) on the agent row
   * and emits agent.status (throttled for the UI).
   */
  setActivity(agentId: string, status: Agent["status"], activity: string | null, block?: BrainBlockId | null): void;
  updateCognitiveState(agentId: string, patch: CognitiveStatePatch): Agent;
}

// ───────────────────────────── Engines ─────────────────────────────

/** Historical profile of one block's model calls for one agent (OOD Monitoring, docs/BRAIN.md). */
export interface BlockProfile {
  block: string; // BrainBlockId or stage label, matched against llm spans' attributes["agentco.stage"]
  calls: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p95InputTokens: number | null;
  p95OutputTokens: number | null;
  meanCostUsd: number | null;
  errorRate: number | null; // share of llm spans with status error
}

/** The agent's recent run rhythm (Human Nature › fatigue, valence decay). */
export interface RunStreak {
  /** Runs in a row ending with the current one, each starting within `idleGapMs` of the previous one's end (≥ 1). */
  consecutiveRuns: number;
  /** Idle time between the previous run's end and the current run's start (ms; 0 when there is none). */
  idleMsBefore: number;
}

export interface MetricsView {
  /** Profile of this agent's llm spans whose agentco.stage = block, over the last `days` (default 14). */
  blockProfile(agentId: string, block: string, days?: number): BlockProfile;
  /** Optional (engines fall back to a streak of 1): the agent's current run streak from the runs table. */
  runStreak?(agentId: string, idleGapMs: number, maxRuns?: number): RunStreak;
}

/** The specialist catalog as the engines see it (docs/CATALOG.md); absent when no catalog is loaded. */
export interface CatalogView {
  /** Workers with a catalogId: the compiled specialist playbook for the system prompt; else null. */
  playbookFor(agent: Agent): string | null;
  /** Executives/managers with a catalogId: a short "domain expertise" line for the charter; else null. */
  expertiseFor(agent: Agent): string | null;
  /** Role Arrangement: the specialist's description + mission (mandateFit text); null without a catalogId. */
  profileFor(agent: Agent): string | null;
}

export interface PlatformServices {
  models: ModelRouter;
  metrics: MetricsView;
  tools: ToolExecutor;
  memory: MemoryService;
  tracer: Tracer;
  org: OrgView;
  tasks: TaskView;
  agents: AgentStateWriter;
  /** Optional so test fakes and older wiring keep working; the real platform always provides it. */
  catalog?: CatalogView;
  now(): Date;
}

/** Conversation history after context governance (compaction) has been applied. */
export interface ConversationHistory {
  conversation: Conversation;
  /** Oldest → newest. On a compacted conversation the first entry is a system checkpoint preamble. */
  messages: Message[];
  compacted: boolean;
}

export type EngineInput =
  | { trigger: "message"; history: ConversationHistory; message: Message }
  | {
      trigger: Exclude<RunTrigger, "message">;
      task: Task;
      subtasks: Task[]; // current children with results (for subtasks_completed)
      /** Present on trigger=recovery: the reference repo's "do not blindly repeat" notice. */
      recoveryNotice?: string;
      /** Present on trigger=human_answer. */
      answeredApproval?: Approval;
    };

export interface EngineContext {
  agent: Agent;
  run: Run;
  input: EngineInput;
  platform: PlatformServices;
  /** The run's root span; engines hang every stage/llm/tool span under it. */
  span: SpanHandle;
  /** Aborted on human interrupt, agent pause/destroy, company pause, or timeout. */
  signal: AbortSignal;
}

export type EngineOutcome =
  | "completed" // task done (result = output) / message answered (reply = output)
  | "waiting" // delegated subtasks; re-run on trigger=subtasks_completed
  | "blocked" // asked a human / escalated; re-run on trigger=human_answer
  | "yielded" // interrupted for more urgent work: task → todo, taskState kept as checkpoint, attempts NOT incremented
  | "failed";

export interface EngineResult {
  outcome: EngineOutcome;
  /** Task result, or the chat reply for trigger=message. */
  output: string;
  /** Persisted into task.state (merge). */
  taskState?: Record<string, unknown>;
  /** For blocked: the approval the engine (or a tool) opened. */
  approvalId?: string;
  error?: string;
}

export interface CognitiveEngine {
  readonly kind: CognitionKind;
  run(ctx: EngineContext): Promise<EngineResult>;
}

// ───────────────────────────── Budget + factories ─────────────────────────────

/** One priced model call, written to the `spend` table by the core budget service. */
export interface SpendEntry {
  agentId: string;
  runId: string;
  traceId: string;
  spanId: string;
  taskId: string | null;
  provider: string;
  model: string; // ModelProfile.model
  profileId: string; // ModelProfile.id
  tier: ModelTier;
  stage: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  /** What the same token counts would have cost on the frontier primary profile. */
  frontierCostUsd: number;
  /** The reservation assertCanSpend took for this call; recordSpend releases it. */
  reservationId?: string;
}

/** Implemented by core (middleware/budget.ts); consumed by the model router. */
export interface BudgetGate {
  /**
   * Throws an Error with name "BudgetExceededError" (see BudgetExceededErrorShape) when
   * spent + outstanding reservations + estimate would pass a cap. With `reservationId`
   * the estimate is reserved until recordSpend (entry.reservationId) or release(), so
   * calls in flight count against the caps.
   */
  assertCanSpend(agentId: string, estimateUsd: number, reservationId?: string): void;
  recordSpend(entry: SpendEntry): void;
  /** Drops a reservation (the call failed or was aborted). Idempotent. */
  release?(reservationId: string): void;
}

/** Fixed factory signatures (see docs/ARCHITECTURE.md → ownership). */
export interface ModelRouterDeps {
  config: unknown; // ModelConfig from models/config.ts (owned by cognition)
  tracer: Tracer;
  budget: BudgetGate;
  getAgent(id: string): Agent | null;
}

// ───────────────────────────── Errors ─────────────────────────────

/** Thrown by ModelRouter.chat before a call when spend would exceed a cap. */
export interface BudgetExceededErrorShape {
  name: "BudgetExceededError";
  scope: "agent" | "department" | "company";
  limitUsd: number;
  spentUsd: number;
}
