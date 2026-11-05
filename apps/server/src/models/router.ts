/**
 * ModelRouter: tier → profile resolution, stage routing, one traced and
 * budget-checked call per chat(), fallback once on provider error.
 *
 * chat(): budget.assertCanSpend(estimate, reservationId) → `llm` span (child of
 * ctx.parentSpanId) → provider.complete → cost from the profile's prices
 * (cached input priced separately) → budget.recordSpend (incl. what the call
 * would have cost on the frontier primary) → span end. A provider error ends
 * the span with status error and retries once on the tier's fallback profile
 * (new span). BudgetExceededError and aborts are never swallowed.
 *
 * The estimate stays reserved in the budget ledger while the call is in flight,
 * so concurrent calls cannot overrun a hard cap together; recordSpend releases
 * it, and so does any failure (release() in a finally).
 */
import type { Agent, ModelProfile, ModelTier } from "../../../../packages/shared/src/index.ts";
import type {
  ChatCallContext,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ModelRouter,
  ModelRouterDeps,
  SpanHandle,
} from "../contracts.ts";
import { buildProfile, type ModelConfig, type StageTier } from "./config.ts";
import { parseJsonObject } from "./json.ts";
import { costUsd } from "./pricing.ts";
import { MockProvider } from "./providers/mock.ts";
import { OpenAICompatibleProvider } from "./providers/openai.ts";

const PREVIEW_CHARS = 4000;

export interface ModelRouterExtras {
  /** Provider adapters by profile.provider ("mock") or "openai-compatible" for everything else. */
  providers?: Record<string, ModelProvider>;
  fetch?: typeof fetch;
}

export function isBudgetError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: unknown }).name === "BudgetExceededError";
}

/**
 * True when `err` means "the caller cancelled". With a signal, only the signal decides: a
 * provider-side AbortError/TimeoutError while the run's signal is still live is a provider
 * failure (e.g. the per-request timeout), which the router retries on the fallback profile.
 * Without a signal, the error name decides (a TimeoutError is not an abort).
 */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal) return signal.aborted;
  const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
  return name === "AbortError" || name === "RunAbortedError";
}

export function renderPrompt(messages: ChatMessage[]): string {
  const parts = messages.map((m) => {
    const calls = m.toolCalls?.length ? ` → ${m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(", ")}` : "";
    const who = m.role === "tool" ? `tool${m.name ? `:${m.name}` : ""}` : m.role;
    return `${who}: ${m.content}${calls}`;
  });
  const text = parts.join("\n");
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

function outputPreview(content: string, toolCalls: { name: string; arguments: Record<string, unknown> }[]): string {
  const calls = toolCalls.map((c) => `→ ${c.name}(${JSON.stringify(c.arguments)})`).join("\n");
  const text = [content, calls].filter(Boolean).join("\n");
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

function promptChars(request: ChatRequest): number {
  return (
    request.messages.reduce((n, m) => n + m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0) +
    (request.tools ? JSON.stringify(request.tools).length : 0)
  );
}

class ModelRouterImpl implements ModelRouter {
  private readonly deps: ModelRouterDeps & { config: ModelConfig };
  private readonly config: ModelConfig;
  private readonly providers: Record<string, ModelProvider>;
  private readonly overrideCache = new Map<string, ModelProfile | null>();
  private reservationSeq = 0;

  constructor(deps: ModelRouterDeps & { config: ModelConfig } & ModelRouterExtras) {
    this.deps = deps;
    this.config = deps.config;
    this.providers = {
      mock: new MockProvider({ latencyMs: this.config.mockLatencyMs }),
      "openai-compatible": new OpenAICompatibleProvider({ providers: this.config.providers, fetch: deps.fetch }),
      ...(deps.providers ?? {}),
    };
  }

  isLive(): boolean {
    return Object.values(this.config.tiers).some((t) => t.primary.provider !== "mock" || (t.fallback !== null && t.fallback.provider !== "mock"));
  }

  resolve(tier: ModelTier, override?: string | null): ModelProfile {
    if (override) {
      const known = this.config.profiles.find((p) => p.id === override);
      if (known) return known;
      const key = `${tier}|${override}`;
      if (!this.overrideCache.has(key)) {
        const warnings: string[] = [];
        const built = buildProfile({ providers: this.config.providers, priceOverrides: this.config.priceOverrides, warnings }, override, tier);
        if (!built) console.warn(`[models] model override "${override}" unavailable (${warnings.join("; ")}); using the ${tier} tier`);
        this.overrideCache.set(key, built);
      }
      const cached = this.overrideCache.get(key);
      if (cached) return cached;
    }
    return this.config.tiers[tier].primary;
  }

  tierForStage(stage: string, agent: Agent): ModelTier {
    let routed: StageTier | undefined;
    // Exact key, then dotted prefixes ("a.b.c" → "a.b" → "a").
    for (let key = stage; key; key = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : "") {
      routed = this.config.stageRouting[key];
      if (routed) break;
    }
    if (!routed || routed === "agent") return agent.modelTier;
    return routed;
  }

  private fallbackFor(failed: ModelProfile, tier: ModelTier): ModelProfile | null {
    const t = this.config.tiers[tier];
    if (t.fallback && t.fallback.id !== failed.id) return t.fallback;
    if (t.primary.id !== failed.id && !this.config.profiles.some((p) => p.id === failed.id && p.tier === tier)) return t.primary;
    return null;
  }

  async chat(request: ChatRequest, ctx: ChatCallContext): Promise<ChatResponse> {
    const first = this.resolve(request.tier, request.modelOverride ?? null);
    try {
      return await this.attempt(first, request, ctx, null);
    } catch (err) {
      // Only the caller's own signal is an abort; a provider timeout goes to the fallback profile.
      if (isBudgetError(err) || ctx.signal.aborted) throw err;
      const fallback = this.fallbackFor(first, request.tier);
      if (!fallback) throw err;
      return this.attempt(fallback, request, ctx, first.id);
    }
  }

  private async attempt(profile: ModelProfile, request: ChatRequest, ctx: ChatCallContext, fallbackFrom: string | null): Promise<ChatResponse> {
    if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : Object.assign(new Error("aborted"), { name: "AbortError" });
    const maxOutputTokens = request.maxOutputTokens ?? this.config.defaultMaxOutputTokens;
    const estimate =
      (Math.ceil(promptChars(request) / 4) * profile.inputPerMTokUsd + maxOutputTokens * profile.outputPerMTokUsd) / 1_000_000;
    const reservationId = `rsv_${ctx.runId}_${++this.reservationSeq}`;
    this.deps.budget.assertCanSpend(ctx.agentId, estimate, reservationId);
    try {
      return await this.call(profile, request, ctx, fallbackFrom, maxOutputTokens, estimate, reservationId);
    } finally {
      this.deps.budget.release?.(reservationId);
    }
  }

  private async call(
    profile: ModelProfile,
    request: ChatRequest,
    ctx: ChatCallContext,
    fallbackFrom: string | null,
    maxOutputTokens: number,
    estimate: number,
    reservationId: string,
  ): Promise<ChatResponse> {
    const span: SpanHandle = this.deps.tracer.startSpan({
      traceId: ctx.traceId,
      parentSpanId: ctx.parentSpanId,
      kind: "llm",
      name: "llm.chat",
      agentId: ctx.agentId,
      runId: ctx.runId,
      taskId: ctx.taskId ?? null,
      input: renderPrompt(request.messages),
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": profile.provider,
        "gen_ai.request.model": profile.model,
        "gen_ai.request.max_tokens": maxOutputTokens,
        "agentco.tier": profile.tier,
        "agentco.stage": ctx.stage,
        "agentco.profile": profile.id,
        "agentco.mock": profile.provider === "mock",
        "agentco.response_format": request.responseFormat ?? "text",
        "agentco.tools": request.tools?.length ?? 0,
        "agentco.estimate_usd": round(estimate),
        ...(fallbackFrom ? { "agentco.fallback_from": fallbackFrom } : {}),
      },
    });

    const provider = profile.provider === "mock" ? this.providers.mock : (this.providers[profile.provider] ?? this.providers["openai-compatible"]);
    let signal = ctx.signal;
    if (profile.provider !== "mock" && this.config.requestTimeoutMs > 0) {
      signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    }
    let result: Awaited<ReturnType<ModelProvider["complete"]>>;
    try {
      if (!provider) throw new Error(`no adapter for provider "${profile.provider}"`);
      result = await provider.complete(profile, { ...request, maxOutputTokens }, signal);
    } catch (err) {
      const aborted = ctx.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      span.end({ status: aborted ? "cancelled" : "error", error: message, model: profile.model });
      throw err;
    }

    const usage = result.usage;
    const cost = costUsd(profile, usage);
    const frontierCost = costUsd(this.config.tiers.frontier.primary, usage);
    const json = request.responseFormat === "json" ? parseJsonObject(result.content) : null;
    try {
      this.deps.budget.recordSpend({
        agentId: ctx.agentId,
        runId: ctx.runId,
        traceId: ctx.traceId,
        spanId: span.spanId,
        taskId: ctx.taskId ?? null,
        provider: profile.provider,
        model: profile.model,
        profileId: profile.id,
        tier: profile.tier,
        stage: ctx.stage,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        costUsd: cost,
        frontierCostUsd: frontierCost,
        reservationId,
      });
    } catch (err) {
      span.end({ status: "error", error: `recordSpend failed: ${(err as Error).message}`, model: profile.model, costUsd: cost });
      throw err;
    }
    span.end({
      status: "ok",
      output: outputPreview(result.content, result.toolCalls),
      model: profile.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: cost,
      attributes: {
        "gen_ai.usage.input_tokens": usage.inputTokens,
        "gen_ai.usage.output_tokens": usage.outputTokens,
        "gen_ai.usage.cached_input_tokens": usage.cachedInputTokens,
        "gen_ai.response.finish_reasons": result.finishReason,
        "agentco.cost_usd": cost,
        "agentco.frontier_cost_usd": frontierCost,
        ...(request.responseFormat === "json" ? { "agentco.json_parsed": json !== null } : {}),
      },
    });
    return {
      content: result.content,
      json,
      toolCalls: result.toolCalls,
      usage,
      costUsd: cost,
      profile,
      finishReason: result.finishReason,
      spanId: span.spanId,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

export function createModelRouter(deps: ModelRouterDeps & { config: ModelConfig } & ModelRouterExtras): ModelRouter {
  return new ModelRouterImpl(deps);
}
