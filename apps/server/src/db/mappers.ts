/** Row ↔ domain mappers (snake_case columns, JSON columns parsed with safe fallbacks). */
import type {
  AffectState,
  Agent,
  AgentIdentity,
  Approval,
  BlackboardEntry,
  CalibrationStats,
  CompanyEvent,
  Conversation,
  Department,
  MemoryItem,
  Message,
  Persona,
  Run,
  Span,
  Task,
} from "../../../../packages/shared/src/index.ts";
import { num, numOrNull, parseJson, str, strOrNull } from "./json.ts";

export type Row = Record<string, unknown>;

export const DEFAULT_AFFECT: AffectState = { valence: 0, arousal: 0.2, frustration: 0 };
export const DEFAULT_CALIBRATION: CalibrationStats = { samples: 0, meanConfidence: 0.5, successRate: 0.5, brier: 0 };
export const EMPTY_IDENTITY: AgentIdentity = {
  mission: "",
  worldview: "",
  lifeView: "",
  values: [],
  vision: "",
  desires: { taskDriven: 0.6, curiosity: 0.4, epistemic: 0.5, vision: 0.4 },
  motivation: { autonomy: 0.5, competence: 0.5, purpose: 0.5 },
  okrs: [],
  narrative: "",
  assets: [],
  resourceConnections: [],
};
export const EMPTY_PERSONA: Persona = { style: "", traits: [], personalityType: null, baZi: null };

export function toDepartment(r: Row): Department {
  return {
    id: str(r.id),
    slug: str(r.slug),
    name: str(r.name),
    mandate: str(r.mandate),
    parentId: strOrNull(r.parent_id),
    headAgentId: strOrNull(r.head_agent_id),
    color: str(r.color),
    monthlyBudgetUsd: num(r.monthly_budget_usd),
    createdAt: str(r.created_at),
  };
}

export function toAgent(r: Row): Agent {
  return {
    id: str(r.id),
    name: str(r.name),
    title: str(r.title),
    roleId: str(r.role_id),
    catalogId: strOrNull(r.catalog_id),
    departmentId: str(r.department_id),
    managerId: strOrNull(r.manager_id),
    tier: str(r.tier) as Agent["tier"],
    cognition: str(r.cognition) as Agent["cognition"],
    modelTier: str(r.model_tier) as Agent["modelTier"],
    modelOverride: strOrNull(r.model_override),
    status: str(r.status) as Agent["status"],
    activity: strOrNull(r.activity),
    brainBlock: strOrNull(r.brain_block) as Agent["brainBlock"],
    currentTaskId: strOrNull(r.current_task_id),
    currentRunId: strOrNull(r.current_run_id),
    identity: { ...EMPTY_IDENTITY, ...parseJson<Partial<AgentIdentity>>(r.identity, {}) },
    persona: { ...EMPTY_PERSONA, ...parseJson<Partial<Persona>>(r.persona, {}) },
    affect: parseJson<AffectState>(r.affect, DEFAULT_AFFECT),
    calibration: parseJson<CalibrationStats>(r.calibration, DEFAULT_CALIBRATION),
    tools: parseJson<string[]>(r.tools, []),
    monthlyBudgetUsd: num(r.monthly_budget_usd),
    createdBy: str(r.created_by),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    terminatedAt: strOrNull(r.terminated_at),
  };
}

export function toTask(r: Row): Task {
  return {
    id: str(r.id),
    number: num(r.number),
    traceId: str(r.trace_id),
    parentTaskId: strOrNull(r.parent_task_id),
    rootTaskId: str(r.root_task_id),
    title: str(r.title),
    description: str(r.description),
    acceptanceCriteria: strOrNull(r.acceptance_criteria),
    createdBy: str(r.created_by),
    assigneeId: strOrNull(r.assignee_id),
    departmentId: strOrNull(r.department_id),
    status: str(r.status) as Task["status"],
    value: num(r.value),
    estCostUsd: num(r.est_cost_usd),
    actualCostUsd: num(r.actual_cost_usd),
    priority: num(r.priority),
    result: strOrNull(r.result),
    error: strOrNull(r.error),
    attempts: num(r.attempts),
    maxAttempts: num(r.max_attempts),
    originConversationId: strOrNull(r.origin_conversation_id),
    state: parseJson<Record<string, unknown>>(r.state, {}),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    startedAt: strOrNull(r.started_at),
    completedAt: strOrNull(r.completed_at),
    archivedAt: strOrNull(r.archived_at),
  };
}

export function toRun(r: Row): Run {
  return {
    id: str(r.id),
    agentId: str(r.agent_id),
    taskId: strOrNull(r.task_id),
    conversationId: strOrNull(r.conversation_id),
    traceId: str(r.trace_id),
    rootSpanId: str(r.root_span_id),
    trigger: str(r.trigger) as Run["trigger"],
    engine: str(r.engine) as Run["engine"],
    status: str(r.status) as Run["status"],
    output: strOrNull(r.output),
    error: strOrNull(r.error),
    usage: {
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      cachedInputTokens: num(r.cached_input_tokens),
    },
    costUsd: num(r.cost_usd),
    llmCalls: num(r.llm_calls),
    toolCalls: num(r.tool_calls),
    failingSpanId: strOrNull(r.failing_span_id),
    startedAt: strOrNull(r.started_at),
    completedAt: strOrNull(r.completed_at),
    createdAt: str(r.created_at),
  };
}

export function toSpan(r: Row): Span {
  return {
    id: str(r.id),
    traceId: str(r.trace_id),
    parentSpanId: strOrNull(r.parent_span_id),
    kind: str(r.kind) as Span["kind"],
    name: str(r.name),
    status: str(r.status) as Span["status"],
    agentId: strOrNull(r.agent_id),
    runId: strOrNull(r.run_id),
    taskId: strOrNull(r.task_id),
    startedAt: str(r.started_at),
    endedAt: strOrNull(r.ended_at),
    durationMs: numOrNull(r.duration_ms),
    input: strOrNull(r.input),
    output: strOrNull(r.output),
    error: strOrNull(r.error),
    model: strOrNull(r.model),
    inputTokens: numOrNull(r.input_tokens),
    outputTokens: numOrNull(r.output_tokens),
    costUsd: numOrNull(r.cost_usd),
    attributes: parseJson<Span["attributes"]>(r.attributes, {}),
  };
}

export function toConversation(r: Row): Conversation {
  return {
    id: str(r.id),
    kind: str(r.kind) as Conversation["kind"],
    title: str(r.title),
    participantIds: parseJson<string[]>(r.participant_ids, []),
    createdAt: str(r.created_at),
    lastMessageAt: strOrNull(r.last_message_at),
  };
}

export function toMessage(r: Row): Message {
  return {
    id: str(r.id),
    conversationId: str(r.conversation_id),
    senderId: str(r.sender_id),
    content: str(r.content),
    runId: strOrNull(r.run_id),
    taskId: strOrNull(r.task_id),
    traceId: strOrNull(r.trace_id),
    readAt: strOrNull(r.read_at),
    createdAt: str(r.created_at),
  };
}

export function toMemory(r: Row): MemoryItem {
  return {
    id: str(r.id),
    scope: str(r.scope) as MemoryItem["scope"],
    agentId: strOrNull(r.agent_id),
    kind: str(r.kind) as MemoryItem["kind"],
    content: str(r.content),
    tags: parseJson<string[]>(r.tags, []),
    importance: num(r.importance),
    sourceRunId: strOrNull(r.source_run_id),
    sourceTaskId: strOrNull(r.source_task_id),
    accessCount: num(r.access_count),
    createdAt: str(r.created_at),
    lastAccessedAt: strOrNull(r.last_accessed_at),
  };
}

export function toBlackboard(r: Row): BlackboardEntry {
  return { key: str(r.key), value: str(r.value), updatedBy: str(r.updated_by), updatedAt: str(r.updated_at) };
}

export function toApproval(r: Row): Approval {
  return {
    id: str(r.id),
    kind: str(r.kind) as Approval["kind"],
    status: str(r.status) as Approval["status"],
    requestedBy: str(r.requested_by),
    taskId: strOrNull(r.task_id),
    traceId: strOrNull(r.trace_id),
    summary: str(r.summary),
    payload: parseJson<Record<string, unknown>>(r.payload, {}),
    decidedBy: strOrNull(r.decided_by) as Approval["decidedBy"],
    note: strOrNull(r.note),
    createdAt: str(r.created_at),
    decidedAt: strOrNull(r.decided_at),
    archivedAt: strOrNull(r.archived_at),
  };
}

export function toEvent(r: Row): CompanyEvent {
  return {
    seq: num(r.seq),
    id: str(r.id),
    type: str(r.type) as CompanyEvent["type"],
    at: str(r.at),
    agentId: strOrNull(r.agent_id),
    taskId: strOrNull(r.task_id),
    runId: strOrNull(r.run_id),
    traceId: strOrNull(r.trace_id),
    summary: str(r.summary),
    data: parseJson<unknown>(r.data, null),
  };
}
