/**
 * Default price table (USD per 1M tokens, list price, standard processing).
 *
 * Source: docs/research/03-model-tiers.md — prices checked 2026-11-04 on the
 * vendors' official pricing pages (OpenRouter catalogue for some context
 * windows). Override any entry at runtime with MODEL_PRICES_JSON.
 *
 * Verification legend (`verified`):
 *   "price"      price read from the vendor's official page on `asOf`;
 *                the API model id is a best guess from the display name.
 *   "price+id"   price and model id both as listed by the vendor.
 *   "none"       not verified (placeholder) — set MODEL_PRICES_JSON.
 *
 * Tiered prices are flattened to one number per model (noted per entry); when
 * the vendor has peak/off-peak or long-context surcharges we keep the HIGHER
 * figure so budget gates err on the safe side, except where the note says the
 * platform keeps prompts below the surcharge threshold.
 */
import type { ModelTier } from "../../../../packages/shared/src/index.ts";

export interface PriceEntry {
  /** Normalised model key (see normalizeModelKey). */
  key: string;
  vendor: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cachedInputPerMTokUsd: number | null;
  contextWindow: number | null;
  supportsTools: boolean;
  asOf: string;
  source: string;
  verified: "price" | "price+id" | "none";
  note?: string;
  /** A price change announced by the vendor, applied from `from` (ISO date) on. */
  scheduled?: { from: string; inputPerMTokUsd: number; outputPerMTokUsd: number; cachedInputPerMTokUsd: number | null };
}

const AS_OF = "2026-11-04";
const SRC_ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const SRC_OPENAI = "https://openai.com/api/pricing/";
const SRC_GOOGLE = "https://ai.google.dev/gemini-api/docs/pricing";
const SRC_DEEPSEEK = "https://api-docs.deepseek.com/quick_start/pricing";
const SRC_BYTEPLUS = "https://docs.byteplus.com/en/docs/modelark/model-pricing";
const SRC_ALIBABA = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";

function entry(
  key: string,
  vendor: string,
  input: number,
  output: number,
  cached: number | null,
  contextWindow: number | null,
  source: string,
  verified: PriceEntry["verified"],
  extra: Partial<PriceEntry> = {},
): PriceEntry {
  return {
    key: normalizeModelKey(key),
    vendor,
    inputPerMTokUsd: input,
    outputPerMTokUsd: output,
    cachedInputPerMTokUsd: cached,
    contextWindow,
    supportsTools: true,
    asOf: AS_OF,
    source,
    verified,
    ...extra,
  };
}

export const PRICE_TABLE: PriceEntry[] = [
  // Anthropic (via the OpenAI-compatible layer: no prompt caching there, forced tool_choice rejected on
  // Opus/Sonnet/Fable — the router only ever sends tool_choice "auto").
  entry("claude-fable-5-1", "anthropic", 10, 50, 0.25, 1_000_000, SRC_ANTHROPIC, "price"),
  entry("claude-opus-5-5", "anthropic", 4, 20, 0.2, 1_000_000, SRC_ANTHROPIC, "price+id"),
  entry("claude-sonnet-5-5", "anthropic", 2, 10, 0.1, 1_000_000, SRC_ANTHROPIC, "price+id"),
  entry("claude-haiku-5-5", "anthropic", 0.1, 0.5, 0.01, 1_000_000, SRC_ANTHROPIC, "price+id", {
    note: "Prompts >100k tokens cost 5x (0.50/2.50); AgentCo keeps worker prompts far below that.",
  }),
  // OpenAI
  entry("gpt-6-astra", "openai", 10, 50, 1, 1_050_000, SRC_OPENAI, "price", {
    note: "Price applies to contexts under 272K. Context window from the OpenRouter catalogue.",
  }),
  entry("gpt-6-1-sol", "openai", 2, 10, 0.1, 1_050_000, SRC_OPENAI, "price"),
  entry("gpt-6-1-terra", "openai", 1, 5, 0.05, 1_050_000, SRC_OPENAI, "price"),
  entry("gpt-6-luna", "openai", 0.1, 0.5, 0.01, 1_050_000, SRC_OPENAI, "price"),
  // Google Gemini (OpenAI-compatible endpoint). Cached prices for Flash models not read → null (= input price).
  entry("gemini-4-argon", "google", 2, 10, 0.1, 1_000_000, SRC_GOOGLE, "price+id", {
    note: "Introductory price until 2026-11-30.",
    scheduled: { from: "2026-12-01", inputPerMTokUsd: 4, outputPerMTokUsd: 20, cachedInputPerMTokUsd: 0.2 },
  }),
  entry("gemini-3-8-flash", "google", 0.75, 3.75, null, 1_000_000, SRC_GOOGLE, "price", {
    note: "Introductory price until 2026-12-31.",
    scheduled: { from: "2027-01-01", inputPerMTokUsd: 1.5, outputPerMTokUsd: 7.5, cachedInputPerMTokUsd: null },
  }),
  entry("gemini-3-6-flash", "google", 0.75, 3.75, null, 1_000_000, SRC_GOOGLE, "price", {
    scheduled: { from: "2027-01-01", inputPerMTokUsd: 1.5, outputPerMTokUsd: 7.5, cachedInputPerMTokUsd: null },
  }),
  entry("gemini-3-5-flash-lite", "google", 0.3, 2.5, null, 1_000_000, SRC_GOOGLE, "price+id"),
  entry("gemini-3-1-flash-lite", "google", 0.25, 1.5, null, 1_000_000, SRC_GOOGLE, "price"),
  // DeepSeek — peak prices (off-peak is half): peak = 01-04 and 06-10 UTC Mon-Fri.
  entry("deepseek-v4-pro", "deepseek", 1.32, 3.96, 0.044, 1_000_000, SRC_DEEPSEEK, "price+id", {
    note: "Peak price; off-peak 0.66/1.98.",
  }),
  entry("deepseek-flash", "deepseek", 0.3, 1.2, 0.006, 1_000_000, SRC_DEEPSEEK, "price+id", {
    note: "Peak price; off-peak 0.15/0.60.",
  }),
  // BytePlus ModelArk — ≤128K-context price (AgentCo prompts stay small); 2x above 128K.
  entry("seed-2-0-pro-260328", "byteplus", 0.5, 3, 0.1, 256_000, SRC_BYTEPLUS, "price+id"),
  entry("seed-2-0-lite-260428", "byteplus", 0.25, 2, 0.05, 256_000, SRC_BYTEPLUS, "price+id"),
  entry("seed-2-0-mini-260428", "byteplus", 0.1, 0.4, 0.02, 256_000, SRC_BYTEPLUS, "price+id"),
  entry("dola-seed-2-1-turbo", "byteplus", 0.5, 2.5, 0.1, 256_000, SRC_BYTEPLUS, "price+id"),
  entry("deepseek-v4-1-flash-economy-261017", "byteplus", 0.24, 0.96, 0.005, null, SRC_BYTEPLUS, "price+id", {
    note: "Peak price; off-peak 0.12/0.48.",
  }),
  entry("glm-5-3-flash-260828", "byteplus", 0.15, 0.5, 0.03, null, SRC_BYTEPLUS, "price+id"),
  // Alibaba Model Studio (international). Cache discounts not modelled (null = input price).
  entry("qwen3-8-max", "alibaba", 2, 6, null, 1_000_000, SRC_ALIBABA, "price+id"),
  entry("qwen3-7-plus", "alibaba", 0.4, 1.6, null, 1_000_000, SRC_ALIBABA, "price+id", { note: "≤256K price." }),
  entry("qwen3-8-flash", "alibaba", 0.15, 0.47, null, 1_000_000, SRC_ALIBABA, "price+id"),
  entry("qwen3-7-flash", "alibaba", 0.1, 0.4, null, 1_000_000, SRC_ALIBABA, "price+id", { note: "≤256K price (0.03/0.13 ≤32K)." }),
];

/**
 * The mock provider is priced like the recommended primary of its tier
 * (03-model-tiers.md §3) so cost dashboards and routing savings are realistic.
 * Spans and the console label these as mock.
 */
export const MOCK_TIER_PRICE_KEY: Record<ModelTier, string> = {
  frontier: "claude-opus-5-5",
  standard: "claude-sonnet-5-5",
  economy: "claude-haiku-5-5",
};

/**
 * Recommended live mapping (03-model-tiers.md §3), as MODEL_* env values — the founder's choice:
 * high-level models for executives (frontier, Opus) and managers (standard, Sonnet), the low-level
 * model for workers (economy, Haiku). The Anthropic ids are Anthropic's exact API model ids; they are
 * the default for an unset MODEL_<TIER> whenever ANTHROPIC_API_KEY is present (models/config.ts).
 * The fallbacks are suggestions only — never applied automatically (set MODEL_<TIER>_FALLBACK);
 * their OpenAI/Gemini ids are best guesses from display names (unverified).
 */
export const RECOMMENDED_TIERS: Record<ModelTier, { primary: string; fallback: string }> = {
  frontier: { primary: "anthropic:claude-opus-5-5", fallback: "gemini:gemini-4-argon" },
  standard: { primary: "anthropic:claude-sonnet-5-5", fallback: "openai:gpt-6.1-sol" },
  economy: { primary: "anthropic:claude-haiku-5-5", fallback: "openai:gpt-6-luna" },
};

/** "anthropic/Claude-Opus-5.5" → "claude-opus-5-5". */
export function normalizeModelKey(model: string): string {
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return bare
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ResolvedPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cachedInputPerMTokUsd: number | null;
  contextWindow: number | null;
  supportsTools: boolean;
  known: boolean;
}

/** Looks up a model's price on a date (scheduled changes applied). */
export function lookupPrice(model: string, at: Date = new Date()): ResolvedPrice | null {
  const key = normalizeModelKey(model);
  const e = PRICE_TABLE.find((p) => p.key === key);
  if (!e) return null;
  const day = at.toISOString().slice(0, 10);
  const s = e.scheduled && day >= e.scheduled.from ? e.scheduled : null;
  return {
    inputPerMTokUsd: s ? s.inputPerMTokUsd : e.inputPerMTokUsd,
    outputPerMTokUsd: s ? s.outputPerMTokUsd : e.outputPerMTokUsd,
    cachedInputPerMTokUsd: s ? s.cachedInputPerMTokUsd : e.cachedInputPerMTokUsd,
    contextWindow: e.contextWindow,
    supportsTools: e.supportsTools,
    known: true,
  };
}

/** USD for one call. Cached input tokens are a subset of inputTokens and priced separately when given. */
export function costUsd(
  price: { inputPerMTokUsd: number; outputPerMTokUsd: number; cachedInputPerMTokUsd: number | null },
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number {
  const cached = Math.max(0, Math.min(usage.cachedInputTokens, usage.inputTokens));
  const uncached = Math.max(0, usage.inputTokens - cached);
  const cachedRate = price.cachedInputPerMTokUsd ?? price.inputPerMTokUsd;
  const usd =
    (uncached * price.inputPerMTokUsd + cached * cachedRate + Math.max(0, usage.outputTokens) * price.outputPerMTokUsd) /
    1_000_000;
  return Math.round(usd * 1e9) / 1e9;
}
