/**
 * Brain plumbing (not a diagram block): the per-run state every block reads,
 * the block runner (span with `agentco.brain.block` + setActivity), and the
 * JSON/text model-call helpers that put the identity charter in every prompt.
 */
import type { Agent, BrainBlockId, ModelTier, Task } from "../../../../../packages/shared/src/index.ts";
import type { EngineContext, PlatformServices, SpanHandle } from "../../contracts.ts";
import type { SpanAttributes } from "../../../../../packages/shared/src/index.ts";
import { isAbortError, isBudgetError } from "../../models/router.ts";
import { obj, type Json } from "../coerce.ts";
import { jsonContract, systemPrompt, type AgentFacts } from "../prompt.ts";
import type { Drives } from "./self-management/identity.ts";

/** Local working memory for one task pass; the serialisable part persists in task.state. */
export interface WorkingMemory {
  [key: string]: unknown;
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
  const parent = options.parent ?? run.ctx.span;
  const span = parent.child({
    kind: "stage",
    name: blockSpanName(id),
    attributes: { "agentco.brain.block": id, ...(options.attributes ?? {}) },
  });
  run.visited.push(id);
  run.platform.agents.setActivity(run.agent.id, options.status ?? "thinking", activity, id);
  try {
    const result = await fn(span);
    span.end({ status: "ok", output: summarize(result) });
    return result;
  } catch (err) {
    const cancelled = isAbortError(err, run.ctx.signal) || err instanceof YieldSignal;
    span.end({ status: cancelled ? "cancelled" : "error", error: (err as Error).message });
    throw err;
  }
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
  const response = await run.platform.models.chat(
    {
      tier,
      modelOverride: run.routingAgent.modelOverride,
      messages: [
        { role: "system", content: systemPrompt(o.stage, [run.charter, o.instructions, jsonContract(o.shape)], o.context) },
        { role: "user", content: o.user ?? "Go." },
      ],
      responseFormat: "json",
      maxOutputTokens: o.maxOutputTokens ?? 700,
      temperature: 0.2,
    },
    callContext(run, o.span, o.stage),
  );
  run.costUsd += response.costUsd;
  if (!response.json) o.span.setAttributes({ "agentco.degraded": true });
  return obj(response.json);
}

export async function llmText(run: BrainRun, o: Omit<LlmOptions, "shape">): Promise<string> {
  const tier = o.tier ?? tierFor(run, o.stage);
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
  run.costUsd += response.costUsd;
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
  return isBudgetError(err) || isAbortError(err, signal) || err instanceof YieldSignal;
}
