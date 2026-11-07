/**
 * Brain plumbing (not a diagram block): the per-run state every block reads,
 * the block runner (span with `agentco.brain.block` + setActivity), and the
 * JSON/text model-call helpers that put the identity charter in every prompt.
 */
import { isProviderOutage } from "../../models/outage.ts";
import type { Agent, BrainBlockId, ModelTier, Task } from "../../../../../packages/shared/src/index.ts";
import type { ChatMessage, ChatResponse, EngineContext, PlatformServices, SpanHandle } from "../../contracts.ts";
import type { SpanAttributes } from "../../../../../packages/shared/src/index.ts";
import { isAbortError, isBudgetError } from "../../models/router.ts";
import { obj, type Json } from "../coerce.ts";
import { jsonContract, systemPrompt, type AgentFacts } from "../prompt.ts";
import { truncate } from "../text.ts";
import type { EscalationState } from "./escalation.ts";
import type { Drives } from "./self-management/identity.ts";

/** Local working memory for one task pass; the serialisable part persists in task.state. */
export interface WorkingMemory {
  [key: string]: unknown;
}

/** One model call made in this run, timed by the engine (OOD Monitoring profiles these). */
export interface CallRecord {
  stage: string;
  block: BrainBlockId | null;
  tier: ModelTier;
  profileId: string;
  contextWindow: number | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  jsonOk: boolean | null;
  checked: boolean;
}

/** OOD Monitoring → Online Learning: profile-guided optimization insight. */
export interface OptimizationInsight {
  block: string;
  tier: string;
  symptom: string;
  remedy: string;
}

export interface BrainRun {
  ctx: EngineContext;
  platform: PlatformServices;
  agent: Agent;
  /** Agent used for model routing (a Self-ability fallback may upgrade its tier for this run). */
  routingAgent: Agent;
  facts: AgentFacts;
  task: Task | null;
  charter: string;
  drives: Drives;
  wm: WorkingMemory;
  visited: BrainBlockId[];
  costUsd: number;
  maxRevisions: number;
  calls: CallRecord[];
  insights: OptimizationInsight[];
  /** Run time limit (RUN_TIMEOUT_MS) for the constraint-pressure signal and the time guard. */
  runTimeoutMs: number;
  /** Wall-clock start of this engine run (Date.now()): the time guard measures from here. */
  startedMs: number;
  /** Phase span the next blocks hang under (§3 grouping), else the run span. */
  parent: SpanHandle | null;
  /** The block currently executing (for call records). */
  currentBlock: BrainBlockId | null;
  /** Escalation budget of the task (escalation.ts); absent on message runs. */
  escalation?: EscalationState;
  /** Set when Solving starts: from then on the run is never interrupted (it finishes the step first). */
  solvingStarted?: boolean;
}

export function blockSpanName(id: BrainBlockId): string {
  return `brain.${id}`;
}

/** Runs one diagram block inside its own span (child of `parent`, default the run span). */
export async function block<T>(
  run: BrainRun,
  id: BrainBlockId,
  activity: string,
  fn: (span: SpanHandle) => Promise<T> | T,
  options: { parent?: SpanHandle; attributes?: SpanAttributes; status?: "thinking" | "acting" } = {},
): Promise<T> {
  const parent = options.parent ?? run.parent ?? run.ctx.span;
  const span = parent.child({
    kind: "stage",
    name: blockSpanName(id),
    attributes: { "agentco.brain.block": id, ...(options.attributes ?? {}) },
  });
  run.visited.push(id);
  run.platform.agents.setActivity(run.agent.id, options.status ?? "thinking", activity, id);
  const previousBlock = run.currentBlock;
  run.currentBlock = id;
  try {
    const result = await fn(span);
    span.end({ status: "ok", output: summarize(result) });
    return result;
  } catch (err) {
    const cancelled = isAbortError(err, run.ctx.signal) || err instanceof YieldSignal;
    span.end({ status: cancelled ? "cancelled" : "error", error: (err as Error).message });
    throw err;
  } finally {
    run.currentBlock = previousBlock;
  }
}

/**
 * A §3 phase ("brain.target_understanding", "brain.planning", "brain.evaluation", …):
 * a stage span grouping the blocks run inside `fn`, so the trace reads at two zoom levels.
 */
export async function phase<T>(run: BrainRun, name: string, fn: () => Promise<T>): Promise<T> {
  const parent = run.parent ?? run.ctx.span;
  const span = parent.child({ kind: "stage", name: `brain.${name}`, attributes: { "agentco.brain.phase": name } });
  const previous = run.parent;
  run.parent = span;
  try {
    const result = await fn();
    span.end({ status: "ok" });
    return result;
  } catch (err) {
    const cancelled = isAbortError(err, run.ctx.signal) || err instanceof YieldSignal;
    span.end({ status: cancelled ? "cancelled" : "error", error: (err as Error).message });
    throw err;
  } finally {
    run.parent = previous;
  }
}

export function recordCall(run: BrainRun, stage: string, response: ChatResponse, latencyMs: number, jsonOk: boolean | null): void {
  run.costUsd += response.costUsd;
  run.calls.push({
    stage,
    block: run.currentBlock,
    tier: response.profile.tier,
    profileId: response.profile.id,
    contextWindow: response.profile.contextWindow,
    latencyMs,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: response.costUsd,
    jsonOk,
    checked: false,
  });
}

function summarize(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.slice(0, 1500);
  try {
    return JSON.stringify(v).slice(0, 1500);
  } catch {
    return undefined;
  }
}

/** Thrown between blocks when the TODO list is interrupted (→ outcome "yielded"). */
export class YieldSignal extends Error {
  readonly nextBlock: BrainBlockId;
  readonly reason: string;
  constructor(nextBlock: BrainBlockId, reason: string) {
    super(`yielded before ${nextBlock}: ${reason}`);
    this.name = "YieldSignal";
    this.nextBlock = nextBlock;
    this.reason = reason;
  }
}

export interface LlmOptions {
  stage: string;
  span: SpanHandle;
  instructions: string;
  shape: string;
  context: Record<string, unknown>;
  user?: string;
  maxOutputTokens?: number;
  /** Override the routed tier (rare). */
  tier?: ModelTier;
}

function tierFor(run: BrainRun, stage: string): ModelTier {
  return run.platform.models.tierForStage(stage, run.routingAgent);
}

/**
 * One JSON-mode model call under `span`. Garbage output degrades to {} (the
 * caller's coercion supplies defaults) and marks the span; budget errors,
 * aborts and provider failures (after the router's fallback) propagate.
 */
export async function llmJson(run: BrainRun, o: LlmOptions): Promise<Json> {
  const tier = o.tier ?? tierFor(run, o.stage);
  const maxOutputTokens = o.maxOutputTokens ?? 700;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(o.stage, [run.charter, o.instructions, jsonContract(o.shape), sizeBudget(maxOutputTokens)], o.context) },
    { role: "user", content: o.user ?? "Go." },
  ];
  let started = Date.now();
  let response = await run.platform.models.chat(
    { tier, modelOverride: run.routingAgent.modelOverride, messages, responseFormat: "json", maxOutputTokens, temperature: 0.2 },
    callContext(run, o.span, o.stage),
  );
  recordCall(run, o.stage, response, Date.now() - started, response.json !== null);
  if (!response.json) {
    // One repair attempt: unparseable output (cut off, or prose around it) silently became defaults
    // downstream — e.g. Feedback's "revise", which re-ran finished work.
    o.span.setAttributes({ "agentco.json_retry": true });
    started = Date.now();
    response = await run.platform.models.chat(
      {
        tier,
        modelOverride: run.routingAgent.modelOverride,
        messages: [
          ...messages,
          { role: "assistant", content: truncate(response.content || "(empty)", 2000) },
          { role: "user", content: "That was not one complete JSON object (it may have been cut off). Reply with ONLY the JSON object, keeping strings short." },
        ],
        responseFormat: "json",
        maxOutputTokens: Math.max(1200, maxOutputTokens * 2),
        temperature: 0.2,
      },
      callContext(run, o.span, o.stage),
    );
    recordCall(run, o.stage, response, Date.now() - started, response.json !== null);
  }
  if (!response.json) o.span.setAttributes({ "agentco.degraded": true });
  return obj(response.json);
}

/**
 * Say the reply's size up front. Raising the output limits did not help (2026-11-07, test 4: 16
 * replies still filled whatever room they had, were cut off and asked again — 22% of the run's
 * cost): the models write to the room they are given unless told the budget.
 */
export function sizeBudget(maxOutputTokens: number): string {
  const words = Math.max(60, Math.round((maxOutputTokens * 0.45) / 10) * 10);
  return `Keep the whole reply under about ${words} words: one or two short sentences per string, and no more list items than asked for.`;
}

export async function llmText(run: BrainRun, o: Omit<LlmOptions, "shape">): Promise<string> {
  const tier = o.tier ?? tierFor(run, o.stage);
  const started = Date.now();
  const response = await run.platform.models.chat(
    {
      tier,
      modelOverride: run.routingAgent.modelOverride,
      messages: [
        { role: "system", content: systemPrompt(o.stage, [run.charter, o.instructions], o.context) },
        { role: "user", content: o.user ?? "Go." },
      ],
      maxOutputTokens: o.maxOutputTokens ?? 600,
      temperature: 0.5,
    },
    callContext(run, o.span, o.stage),
  );
  recordCall(run, o.stage, response, Date.now() - started, null);
  return response.content.trim();
}

export function callContext(run: BrainRun, span: SpanHandle, stage: string) {
  return {
    agentId: run.agent.id,
    runId: run.ctx.run.id,
    traceId: run.ctx.run.traceId,
    parentSpanId: span.spanId,
    taskId: run.task?.id ?? null,
    stage,
    signal: run.ctx.signal,
  };
}

export function toolContext(run: BrainRun, span: SpanHandle) {
  return {
    agent: run.agent,
    runId: run.ctx.run.id,
    traceId: run.ctx.run.traceId,
    parentSpanId: span.spanId,
    taskId: run.task?.id ?? null,
    conversationId: run.ctx.input.trigger === "message" ? run.ctx.input.history.conversation.id : null,
    signal: run.ctx.signal,
  };
}

/** Errors a block must never swallow. */
export function mustPropagate(err: unknown, signal: AbortSignal): boolean {
  return isBudgetError(err) || isAbortError(err, signal) || err instanceof YieldSignal || isProviderOutage(err);
}
