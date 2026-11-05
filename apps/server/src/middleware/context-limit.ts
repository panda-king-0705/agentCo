/**
 * Context-window resolution for the compaction trigger.
 *
 * Adapted from Volc Agent Launchpad — Glass Box middleware
 * (memory/context-limit.ts), MIT. Deliberately fail-closed: an unknown
 * context window (ModelProfile.contextWindow = null) disables compaction and
 * says so in the trace, instead of guessing a large number and overflowing.
 */
import type { ModelProfile } from "../../../../packages/shared/src/index.ts";

export type ContextLimitSource = "profile" | "unknown";

export interface ContextLimitResolution {
  modelName: string;
  limit: number | null;
  source: ContextLimitSource;
}

export function resolveContextLimit(profile: Pick<ModelProfile, "model" | "contextWindow"> | null): ContextLimitResolution {
  const modelName = profile?.model ?? "(unresolved)";
  const limit = profile?.contextWindow;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) return { modelName, limit, source: "profile" };
  return { modelName, limit: null, source: "unknown" };
}

/**
 * The trigger sits below the hard ceiling because the decision is made before
 * the next turn is generated: the gap between `triggerPct` and 1.0 has to
 * cover the system prompt, tool specs and generation headroom.
 */
export const DEFAULT_TRIGGER_PCT = 0.7;

export function compactionTrigger(limit: number, triggerPct: number = DEFAULT_TRIGGER_PCT): number {
  return Math.floor(limit * triggerPct);
}

/** chars/4 — the same estimate the router uses for budget checks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
