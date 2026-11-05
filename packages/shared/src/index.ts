/**
 * AgentCo shared contracts — TYPES ONLY.
 *
 * Imported by the server (erased by Node type stripping) and by the web
 * console (erased by esbuild). Never export a runtime value from this file:
 * the server runs without a bundler and would fail to resolve it.
 *
 * Conventions
 * - ids are prefixed strings: agt_, dep_, tsk_, run_, spn_, trc_, cnv_, msg_,
 *   mem_, apr_, evt_ (events also carry a numeric `seq`).
 * - timestamps are ISO-8601 strings (UTC).
 * - money is USD as a JS number (not cents); display with 4 decimals.
 */

// ───────────────────────────── Org ─────────────────────────────

export type AgentTier = "executive" | "manager" | "worker";
/** brain = brain-inspired cognitive cycle (leaders); reflex = cheap tool loop (workers). */
export type CognitionKind = "brain" | "reflex";
export type ModelTier = "frontier" | "standard" | "economy";

export type AgentStatus =
  | "idle" // nothing to do
  | "thinking" // inside an LLM call / cognitive stage
  | "acting" // executing a tool
  | "waiting" // blocked on subtasks it delegated
  | "blocked" // needs a human / escalation answer
  | "paused" // paused by a human (kill switch)
  | "error" // last run failed
  | "terminated"; // destroyed; kept for audit

export interface Department {
  id: string;
  slug: string; // "engineering"
  name: string; // "Engineering"
  mandate: string;
  parentId: string | null; // sub-departments (e.g. "support" under "operations")
  headAgentId: string | null;
  color: string; // hex, used by the console for swimlanes
  monthlyBudgetUsd: number;
  createdAt: string;
}

export interface OkrKeyResult {
  description: string;
  target: number;
  current: number;
  unit: string;
}
export interface Okr {
  objective: string;
  keyResults: OkrKeyResult[];
}

/**
 * Self-management / Identity block of the brain-inspired architecture.
 * Workers carry a minimal identity (mission + values) and ignore the rest.
 */
export interface AgentIdentity {
  mission: string; // the role's mandate, one line
  worldview: string; // Self-Identity › Worldview: how it sees its domain
  lifeView: string; // Self-Identity › Life View: what a good working life is for this agent (informs Value)
  values: string[]; // Self-Identity › Value
  vision: string; // Desire › Vision (text); weight in desires.vision
  /**
   * Desire weights, 0..1 (docs/BRAIN.md). taskDriven narrows focus; curiosity widens
   * literature review and perspectives; epistemic tightens the truthful gate;
   * vision up-weights subprocesses aligned with the vision/OKRs.
   */
  desires: { taskDriven: number; curiosity: number; epistemic: number; vision: number };
  /** Self-determination motivation, 0..1. autonomy = "freedom". */
  motivation: { autonomy: number; competence: number; purpose: number };
  okrs: Okr[];
  /** Self-narrative generator output, refreshed after cycles. */
  narrative: string;
  /** "BIO / Assets" — skills and owned resources. */
  assets: string[];
  /** "Resource connection" — systems / people it can reach. */
  resourceConnections: string[];
}

/** Sensibility / Emotion: a control signal derived from outcomes, not a feeling. */
export interface AffectState {
  valence: number; // -1..1 recent outcome quality
  arousal: number; // 0..1 workload / urgency
  frustration: number; // 0..1 rises with consecutive failures; >0.7 forces escalation
}

/** Maslow-style needs computed from platform facts (never LLM-reported). */
export interface NeedsState {
  physiological: "ok" | "low"; // any budget/compute left at all; "low" = only essential work
  safety: "ok" | "low"; // budget headroom; "low" = conservation mode (prefer cheap candidates)
  belonging: "ok" | "low"; // has a manager / reports reachable
  esteem: "ok" | "low"; // recent success rate
  selfActualization: number; // 0..1 mean OKR progress
}

export interface CalibrationStats {
  samples: number;
  meanConfidence: number; // mean predicted confidence
  successRate: number; // observed success rate
  brier: number; // mean squared error of confidence vs outcome
}

export type FiveElement = "wood" | "fire" | "earth" | "metal" | "water";

/** Role Arrangement › Eight Characters and Five Elements (八字五行), computed from the agent's "birth" (createdAt). */
export interface BaZiChart {
  birth: string; // ISO timestamp the chart was cast from
  pillars: [string, string, string, string]; // year, month, day, hour, e.g. "甲子"
  pinyin: [string, string, string, string]; // "jia-zi"
  dayMaster: string; // day stem, e.g. "甲"
  dayMasterElement: FiveElement;
  elements: Record<FiveElement, number>; // count over the 8 characters
}

export interface Persona {
  style: string; // communication style, one line
  traits: string[];
  /** Role Arrangement › Personality / MBTI, e.g. "INTJ". Used by role arrangement (docs/BRAIN.md). */
  personalityType: string | null;
  /** Role Arrangement › Eight Characters and Five Elements. Weight in role arrangement is configurable. */
  baZi: BaZiChart | null;
  /** Seeded from the agent's catalog specialist (docs/CATALOG.md); absent for non-catalog agents. */
  emoji?: string | null;
  vibe?: string | null;
}

/**
 * One block of the founder's brain-inspired architecture diagram (docs/BRAIN.md).
 * Spans carry it as attribute `agentco.brain.block`; the console lights the block up.
 */
export type BrainBlockId =
  | "self_management.identity.self_identity"
  | "self_management.identity.desire"
  | "self_management.identity.motivation"
  | "self_management.identity.self_narrative"
  | "self_management.identity.okr"
  | "self_management.role_arrangement"
  | "self_management.sensibility_emotion"
  | "self_management.human_nature"
  | "todo_list"
  | "metacognition.project_management.data_driven_analysis"
  | "metacognition.project_management.economic_concepts"
  | "metacognition.project_management.rollback_failure_recovery"
  | "metacognition.project_management.reflection_replanning"
  | "metacognition.project_management.online_learning"
  | "metacognition.monitoring.ood"
  | "metacognition.monitoring.calibration"
  | "metacognition.monitoring.reverse_thinking"
  | "metacognition.monitoring.truthful_efficient_good"
  | "metacognition.self_ability"
  | "metacognition.target_understanding.problem_definition"
  | "metacognition.target_understanding.literature_review"
  | "metacognition.target_understanding.analysis"
  | "metacognition.confidence"
  | "metacognition.cognitive_control.decomposition"
  | "metacognition.cognitive_control.candidate_solutions"
  | "metacognition.solving_evaluation.solving"
  | "metacognition.solving_evaluation.feedback"
  | "metacognition.memory.local_working"
  | "metacognition.memory.long_term"
  | "global_memory.working"
  | "global_memory.episodic"
  | "global_memory.procedural"
  | "global_memory.conceptual";

export interface Agent {
  id: string;
  name: string; // "Ava Chen"
  title: string; // "Chief Executive Officer"
  roleId: string; // role template slug: "ceo", "backend-engineer"
  /**
   * Catalog specialist (agency-agents id "division/slug", docs/CATALOG.md) or null. Workers run with its
   * compiled specialist playbook; executives/managers get a short "domain expertise" line from it.
   */
  catalogId: string | null;
  departmentId: string;
  managerId: string | null; // null only for the CEO (reports to the human Board)
  tier: AgentTier;
  cognition: CognitionKind;
  modelTier: ModelTier;
  modelOverride: string | null; // ModelProfile.id
  status: AgentStatus;
  activity: string | null; // human-readable "Decomposing T-12 into 3 subtasks"
  /** The diagram block the agent is in right now (brain agents), for the live brain view. */
  brainBlock: BrainBlockId | null;
  currentTaskId: string | null;
  currentRunId: string | null;
  identity: AgentIdentity;
  persona: Persona;
  affect: AffectState;
  calibration: CalibrationStats;
  tools: string[]; // allowed tool names
  monthlyBudgetUsd: number;
  createdBy: "system" | "human" | string; // or the hiring agent id
  createdAt: string;
  updatedAt: string;
  terminatedAt: string | null;
}

export interface AgentStats {
  spentTodayUsd: number;
  spentMonthUsd: number;
  runsTotal: number;
  runsFailed: number;
  tasksDone: number;
  tasksOpen: number;
  inputTokens: number;
  outputTokens: number;
  lastActiveAt: string | null;
}

export interface RoleTemplate {
  id: string; // slug
  title: string;
  departmentSlug: string;
  reportsToRoleId: string | null;
  tier: AgentTier;
  cognition: CognitionKind;
  modelTier: ModelTier;
  mandate: string;
  kpis: string[];
  tools: string[];
  defaultNames: string[];
  inStarterOrg: boolean; // part of the default "startup" org
  /** Catalog specialist the role is staffed from (workers: playbook; leaders: domain expertise), or null. */
  catalogId: string | null;
}

// ───────────────────────────── Work ─────────────────────────────

export type TaskStatus =
  | "todo" // ready to be picked up by its assignee
  | "in_progress" // a run is executing it
  | "waiting" // assignee delegated subtasks and waits for them
  | "blocked" // needs a human answer / approval
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  number: number; // human-friendly T-12
  traceId: string;
  parentTaskId: string | null;
  rootTaskId: string; // == id for root tasks
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  createdBy: "human" | string; // agent id
  assigneeId: string | null;
  departmentId: string | null;
  status: TaskStatus;
  /** TODO-list economics from the brain diagram: priority = value / max(estCostUsd, 0.01). */
  value: number; // 0..1000 business value
  estCostUsd: number;
  actualCostUsd: number;
  priority: number;
  result: string | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  /** Conversation that spawned this objective; its final report is posted there. */
  originConversationId: string | null;
  /** Persisted working memory for the assignee's engine (plan, iteration, human answers). */
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type RunTrigger = "message" | "task" | "subtasks_completed" | "human_answer" | "recovery" | "heartbeat";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface Run {
  id: string;
  agentId: string;
  taskId: string | null;
  conversationId: string | null;
  traceId: string;
  rootSpanId: string;
  trigger: RunTrigger;
  engine: CognitionKind;
  status: RunStatus;
  output: string | null;
  error: string | null;
  usage: Usage;
  costUsd: number;
  llmCalls: number;
  toolCalls: number;
  failingSpanId: string | null; // Glass Box: names the step that broke
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// ───────────────────────────── Traceability ─────────────────────────────

export type SpanKind =
  | "objective" // root of a trace (a human request or objective task)
  | "run" // one engine invocation of one agent
  | "stage" // brain cognitive stage
  | "llm" // one model call
  | "tool" // one tool call
  | "delegation" // task handed to another agent
  | "memory" // recall / write
  | "system"; // scheduler, compaction, recovery, budget

export type SpanStatus = "running" | "ok" | "error" | "cancelled";
export type SpanAttributes = Record<string, string | number | boolean | null>;

/**
 * OTel-GenAI-shaped span. Attribute keys follow gen_ai.* where one exists:
 * gen_ai.operation.name, gen_ai.provider.name, gen_ai.request.model,
 * gen_ai.usage.input_tokens, gen_ai.usage.output_tokens, gen_ai.agent.id,
 * gen_ai.agent.name, gen_ai.tool.name, gen_ai.tool.call.id; AgentCo-specific
 * keys use the agentco.* prefix (agentco.tier, agentco.stage, agentco.cost_usd,
 * agentco.confidence, agentco.task.id, agentco.delegate.to ...).
 */
export interface Span {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  name: string; // "brain.planning", "llm.chat", "tool.delegate_task"
  status: SpanStatus;
  agentId: string | null;
  runId: string | null;
  taskId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** Redacted, truncated previews (<= 2000 chars). */
  input: string | null;
  output: string | null;
  error: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  attributes: SpanAttributes;
}

export interface TraceSummary {
  traceId: string;
  title: string;
  rootTaskId: string | null;
  status: SpanStatus;
  startedAt: string;
  endedAt: string | null;
  agentIds: string[];
  spanCount: number;
  llmCalls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

// ───────────────────────────── Conversation ─────────────────────────────

export type ConversationKind = "boardroom" | "dm" | "agent_dm";

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  /** "human" and/or agent ids. A dm is [human, agentId]; agent_dm is [agentA, agentB]. */
  participantIds: string[];
  createdAt: string;
  lastMessageAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: "human" | "system" | string; // agent id
  content: string;
  runId: string | null;
  taskId: string | null;
  traceId: string | null;
  readAt: string | null; // for agent inboxes
  createdAt: string;
}

// ───────────────────────────── Memory ─────────────────────────────

export type MemoryScope = "agent" | "global";
/** Memory tiers from the brain diagram. "working" items are per-run scratch. */
export type MemoryKind = "episodic" | "semantic" | "procedural" | "conceptual" | "working";

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  agentId: string | null; // owner for scope=agent; author for scope=global
  kind: MemoryKind;
  content: string;
  tags: string[];
  importance: number; // 0..1
  sourceRunId: string | null;
  sourceTaskId: string | null;
  accessCount: number;
  createdAt: string;
  lastAccessedAt: string | null;
}

/** Global working memory (shared blackboard). */
export interface BlackboardEntry {
  key: string;
  value: string;
  updatedBy: "human" | string;
  updatedAt: string;
}

// ───────────────────────────── Governance ─────────────────────────────

export type ApprovalKind = "hire_agent" | "terminate_agent" | "budget_increase" | "question" | "external_action";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  requestedBy: string; // agent id
  taskId: string | null;
  traceId: string | null;
  summary: string; // one line shown in the queue
  payload: Record<string, unknown>;
  decidedBy: "human" | null;
  note: string | null; // the human's answer for kind=question
  createdAt: string;
  decidedAt: string | null;
}

export interface CompanySettings {
  name: string;
  mission: string;
  paused: boolean; // company-wide kill switch
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  maxConcurrentRuns: number;
  maxHeadcount: number;
  hiringRequiresApproval: boolean;
  heartbeatMinutes: number; // 0 = off
  /** agency = startup leadership + 2-4 catalog specialists per department (docs/CATALOG.md). */
  orgTemplate: "startup" | "enterprise" | "agency";
}

// ───────────────────────────── Models ─────────────────────────────

export interface ModelProfile {
  id: string; // config id, e.g. "economy-default"
  provider: string; // "mock" | "openai" | "ark" | "openrouter" | ...
  model: string; // provider model name / endpoint id
  tier: ModelTier;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cachedInputPerMTokUsd: number | null;
  contextWindow: number | null; // null = unknown → compaction disabled (fail closed)
  supportsTools: boolean;
}

export interface ModelsInfo {
  live: boolean; // false when every tier resolves to the mock provider
  tiers: Record<ModelTier, { primary: string; fallback: string | null }>;
  profiles: ModelProfile[];
  /** Which tier each cognitive stage uses (cascade routing). */
  stageRouting: Record<string, ModelTier | "agent">;
}

// ───────────────────────────── Events (SSE) ─────────────────────────────

export type CompanyEventType =
  | "agent.created"
  | "agent.updated"
  | "agent.status"
  | "agent.terminated"
  | "task.created"
  | "task.updated"
  | "run.started"
  | "run.completed"
  | "span.started"
  | "span.ended"
  | "message.created"
  | "approval.created"
  | "approval.decided"
  | "memory.written"
  | "budget.alert"
  | "company.updated";

export interface CompanyEvent {
  seq: number; // monotonic; SSE id
  id: string;
  type: CompanyEventType;
  at: string;
  agentId: string | null;
  taskId: string | null;
  runId: string | null;
  traceId: string | null;
  /** One-line human summary for the activity feed. */
  summary: string;
  /**
   * The changed entity (Agent, Task, Run, Span, Message, Approval, ...). span.* events carry the
   * Span WITHOUT `input`/`output` (fetch the detail from /api/runs/:id or /api/traces/:id).
   */
  data: unknown;
}

// ───────────────────────────── API DTOs ─────────────────────────────

export interface ApiError {
  error: { code: string; message: string };
}

export interface CompanySnapshot {
  settings: CompanySettings;
  headcount: number;
  activeAgents: number;
  openTasks: number;
  pendingApprovals: number;
  spentTodayUsd: number;
  spentMonthUsd: number;
  models: ModelsInfo;
}

export interface OrgResponse {
  departments: Department[];
  agents: Agent[];
}

export interface AgentDetail {
  agent: Agent;
  stats: AgentStats;
  needs: NeedsState;
  manager: Agent | null;
  reports: Agent[];
  currentTask: Task | null;
  recentRuns: Run[];
  openTasks: Task[];
}

export interface CreateAgentInput {
  roleId?: string; // start from a template; other fields override it
  /**
   * Hire a catalog specialist ("division/slug"): fills title, department (division mapping), tier worker,
   * cognition reflex, economy model, persona and playbook; the manager defaults to the department's lead.
   * Explicit fields still win. The department is created on demand when it does not exist yet.
   */
  catalogId?: string;
  name?: string;
  title?: string;
  departmentId?: string;
  managerId?: string | null;
  tier?: AgentTier;
  cognition?: CognitionKind;
  modelTier?: ModelTier;
  modelOverride?: string | null;
  mandate?: string; // becomes identity.mission
  tools?: string[];
  monthlyBudgetUsd?: number;
  persona?: Partial<Persona>;
}

export interface UpdateAgentInput {
  name?: string;
  title?: string;
  managerId?: string | null;
  departmentId?: string;
  modelTier?: ModelTier;
  modelOverride?: string | null;
  monthlyBudgetUsd?: number;
  tools?: string[];
  persona?: Partial<Persona>;
  identity?: Partial<AgentIdentity>;
}

export interface DestroyAgentResult {
  agentId: string;
  cancelledRuns: number;
  reassignedTasks: number; // open tasks handed to the manager
  reassignedReports: number; // direct reports re-parented to the manager
}

export interface CreateTaskInput {
  title: string;
  description: string;
  assigneeId?: string | null; // default: CEO
  acceptanceCriteria?: string | null;
  value?: number;
  estCostUsd?: number;
}

export interface TaskDetail {
  task: Task;
  subtasks: Task[];
  runs: Run[];
  assignee: Agent | null;
  approvals: Approval[];
}

export interface PostMessageResult {
  message: Message;
  runId: string | null;
}

export interface RunDetail {
  run: Run;
  spans: Span[];
}

export interface TraceDetail {
  summary: TraceSummary;
  spans: Span[];
  tasks: Task[];
}

export interface MetricsOverview {
  agentsByStatus: Record<AgentStatus, number>;
  tasksByStatus: Record<TaskStatus, number>;
  spentTodayUsd: number;
  spentMonthUsd: number;
  spendByTier: Record<ModelTier, number>;
  spendByModel: { model: string; costUsd: number; calls: number }[];
  spendByDepartment: { departmentId: string; costUsd: number }[];
  runs24h: number;
  runSuccessRate: number | null; // null when no finished runs
  avgRunMs: number | null;
  tokens24h: { input: number; output: number };
  /** Cost saved this calendar month (same window as spentMonthUsd) by routing to cheaper tiers vs. running every call on frontier. */
  routingSavingsUsd: number;
}

export interface TimeseriesPoint {
  t: string; // bucket start
  value: number;
}

export interface DecideApprovalInput {
  decision: "approved" | "rejected";
  note?: string;
}

// ───────────────────────────── Specialist catalog (docs/CATALOG.md) ─────────────────────────────

/** Body sections of a catalog agent, classified by heading (markdown, headings stripped). */
export interface CatalogSections {
  identity: string;
  mission: string;
  rules: string;
  deliverables: string;
  workflow: string;
  metrics: string;
  other: string;
}

/** One agency-agents specialist, parsed from its markdown file. */
export interface CatalogAgent {
  id: string; // "division/slug", e.g. "engineering/engineering-backend-architect"
  division: string;
  name: string;
  description: string;
  emoji: string;
  vibe: string;
  color: string;
  sections: CatalogSections;
  wordCount: number;
}

export interface CatalogDivision {
  id: string;
  label: string;
  color: string;
  icon: string; // Lucide icon name from divisions.json
  count: number;
  /** Default AgentCo department slug for the division. */
  departmentSlug: string;
  /** True when the division's department is an optional one created on demand. */
  optional: boolean;
}

/** Where a catalog hire lands by default. */
export interface CatalogPlacement {
  departmentSlug: string;
  departmentName: string;
  /** null when the department does not exist yet (hiring creates it). */
  departmentId: string | null;
  createsDepartment: boolean;
  /** Default manager (the department's lead); null when nobody can lead it yet. */
  managerId: string | null;
}

/** List row: no section text. */
export interface CatalogAgentSummary {
  id: string;
  division: string;
  divisionLabel: string;
  name: string;
  description: string;
  emoji: string;
  vibe: string;
  color: string;
  wordCount: number;
  departmentSlug: string;
  departmentName: string;
  optionalDepartment: boolean;
  /** Active agents staffed from this specialist. */
  hiredCount: number;
}

export interface CompiledPlaybook {
  text: string;
  /** Estimated tokens (chars/4, as the platform estimates everywhere). */
  tokens: number;
  maxTokens: number;
  /** True when lower-priority content was dropped to fit the cap. */
  truncated: boolean;
  /** Sections that made it in, in order. */
  sections: string[];
}

export interface CatalogSource {
  repo: string;
  commit: string;
  license: string;
  agents: number;
  /** Malformed files skipped at load. */
  skipped: number;
}

export interface CatalogListResponse {
  source: CatalogSource;
  divisions: CatalogDivision[];
  agents: CatalogAgentSummary[];
  total: number;
}

export interface CatalogAgentDetail {
  agent: CatalogAgent;
  summary: CatalogAgentSummary;
  /** The full markdown body (frontmatter removed). */
  body: string;
  /** What a worker staffed from it carries in its system prompt. */
  playbook: CompiledPlaybook;
  /** What an executive/manager carries as "domain expertise". */
  expertise: string;
  placement: CatalogPlacement;
}
