/**
 * Model configuration from env: tiers → profiles, provider credentials, price
 * table (+ MODEL_PRICES_JSON overrides) and stage routing (+ STAGE_ROUTING).
 *
 * Every provider speaks the OpenAI chat-completions protocol, so a provider is
 * just a base URL + key. A tier whose provider has no key resolves to the
 * offline mock profile for that tier (one-line warning), so the company always
 * runs. Unknown provider names work too when `<NAME>_BASE_URL` and
 * `<NAME>_API_KEY` are set.
 *
 * Defaults (the founder's choice): when MODEL_<TIER> is unset and ANTHROPIC_API_KEY
 * is present, the tiers are Claude — frontier = claude-opus-5-5 (executives),
 * standard = claude-sonnet-5-5 (managers), economy = claude-haiku-5-5 (workers).
 * Without the key an unset tier is the offline mock. Fallbacks are opt-in
 * (MODEL_<TIER>_FALLBACK) and only used when their provider has a key; a
 * fallback that cannot be built never affects the primary.
 */
import type { ModelProfile, ModelsInfo, ModelTier } from "../../../../packages/shared/src/index.ts";
import { lookupPrice, MOCK_TIER_PRICE_KEY, normalizeModelKey, RECOMMENDED_TIERS } from "./pricing.ts";

export const TIERS: ModelTier[] = ["frontier", "standard", "economy"];

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string | null;
}

export type StageTier = ModelTier | "agent";

export interface ModelConfig {
  tiers: Record<ModelTier, { primary: ModelProfile; fallback: ModelProfile | null }>;
  /** Every profile the tiers reference (unique by id). Overrides may add more at runtime. */
  profiles: ModelProfile[];
  providers: Record<string, ProviderConfig>;
  stageRouting: Record<string, StageTier>;
  /** MODEL_PRICES_JSON, keyed by profile id, model name or normalised model key. */
  priceOverrides: Record<string, PriceOverride>;
  mockLatencyMs: number;
  requestTimeoutMs: number;
  defaultMaxOutputTokens: number;
  warnings: string[];
}

export interface PriceOverride {
  inputPerMTokUsd?: number;
  outputPerMTokUsd?: number;
  cachedInputPerMTokUsd?: number | null;
  contextWindow?: number | null;
  supportsTools?: boolean;
}

/** Default base URLs (docs/research/03-model-tiers.md §2). */
export const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; keyEnv: string; baseUrlEnv: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL" },
  ark: { baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3", keyEnv: "ARK_API_KEY", baseUrlEnv: "ARK_BASE_URL" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", baseUrlEnv: "OPENROUTER_BASE_URL" },
  deepseek: { baseUrl: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    baseUrlEnv: "GEMINI_BASE_URL",
  },
};

/** docs/BRAIN.md §4 — keys are the `stage` labels engines pass to ModelRouter.chat. */
export const DEFAULT_STAGE_ROUTING: Record<string, StageTier> = {
  "metacognition.target_understanding.problem_definition": "economy",
  "metacognition.target_understanding.analysis": "standard",
  "metacognition.confidence": "economy",
  "metacognition.cognitive_control": "agent",
  "metacognition.monitoring.reverse_thinking": "economy",
  "metacognition.solving_evaluation.solving": "agent",
  "metacognition.solving_evaluation.feedback": "standard",
  "metacognition.project_management.reflection_replanning": "economy",
  "metacognition.project_management.online_learning": "economy",
  "self_management.identity.self_narrative": "economy",
  "self_management.identity.okr": "economy",
  "chat.reply": "standard",
  "reflex.step": "agent",
};

const DEFAULT_MOCK_CONTEXT_WINDOW = 128_000;

export function mockProfile(tier: ModelTier): ModelProfile {
  const price = lookupPrice(MOCK_TIER_PRICE_KEY[tier])!;
  return {
    id: `mock:${tier}`,
    provider: "mock",
    model: `mock-${tier}`,
    tier,
    inputPerMTokUsd: price.inputPerMTokUsd,
    outputPerMTokUsd: price.outputPerMTokUsd,
    cachedInputPerMTokUsd: price.cachedInputPerMTokUsd,
    contextWindow: DEFAULT_MOCK_CONTEXT_WINDOW,
    supportsTools: true,
  };
}

function providerConfig(name: string, env: NodeJS.ProcessEnv): ProviderConfig | null {
  const d = PROVIDER_DEFAULTS[name];
  const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const keyEnv = d?.keyEnv ?? `${upper}_API_KEY`;
  const baseEnv = d?.baseUrlEnv ?? `${upper}_BASE_URL`;
  const baseUrl = (env[baseEnv] ?? "").trim() || d?.baseUrl || "";
  if (!baseUrl) return null;
  const key = (env[keyEnv] ?? "").trim();
  return { name, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: key || null };
}

/** "openai:gpt-6-luna" → {provider, model}; the model may itself contain ':' or '/'. */
export function parseModelSpec(spec: string): { provider: string; model: string } | null {
  const s = spec.trim();
  const i = s.indexOf(":");
  if (i <= 0 || i === s.length - 1) return null;
  return { provider: s.slice(0, i).trim().toLowerCase(), model: s.slice(i + 1).trim() };
}

function findOverride(overrides: Record<string, PriceOverride>, id: string, model: string): PriceOverride | null {
  return overrides[id] ?? overrides[model] ?? overrides[normalizeModelKey(model)] ?? null;
}

/**
 * Builds a priced profile for a `provider:model` spec. Returns null (with a
 * warning) when the provider is unknown or has no key.
 */
export function buildProfile(
  config: Pick<ModelConfig, "providers" | "priceOverrides" | "warnings">,
  spec: string,
  tier: ModelTier,
  now: Date = new Date(),
): ModelProfile | null {
  const parsed = parseModelSpec(spec);
  if (!parsed) {
    config.warnings.push(`model spec "${spec}" is not provider:model`);
    return null;
  }
  if (parsed.provider === "mock") return mockProfile(tier);
  const provider = config.providers[parsed.provider];
  if (!provider) {
    config.warnings.push(`provider "${parsed.provider}" has no base URL (set ${parsed.provider.toUpperCase()}_BASE_URL)`);
    return null;
  }
  if (!provider.apiKey) {
    config.warnings.push(`${spec} has no API key for provider "${parsed.provider}"`);
    return null;
  }
  const id = `${parsed.provider}:${parsed.model}`;
  const base = lookupPrice(parsed.model, now);
  const ov = findOverride(config.priceOverrides, id, parsed.model);
  let input = base?.inputPerMTokUsd;
  let output = base?.outputPerMTokUsd;
  let cached = base?.cachedInputPerMTokUsd ?? null;
  if (ov?.inputPerMTokUsd !== undefined) input = ov.inputPerMTokUsd;
  if (ov?.outputPerMTokUsd !== undefined) output = ov.outputPerMTokUsd;
  if (ov?.cachedInputPerMTokUsd !== undefined) cached = ov.cachedInputPerMTokUsd;
  if (input === undefined || output === undefined) {
    // Unknown price: assume the tier's reference price so budget gates still bite.
    const ref = lookupPrice(MOCK_TIER_PRICE_KEY[tier], now)!;
    input ??= ref.inputPerMTokUsd;
    output ??= ref.outputPerMTokUsd;
    config.warnings.push(`no price for ${id}; assuming the ${tier} reference price (set MODEL_PRICES_JSON)`);
  }
  const contextWindow = ov && ov.contextWindow !== undefined ? ov.contextWindow : (base?.contextWindow ?? null);
  return {
    id,
    provider: parsed.provider,
    model: parsed.model,
    tier,
    inputPerMTokUsd: input,
    outputPerMTokUsd: output,
    cachedInputPerMTokUsd: cached,
    contextWindow,
    supportsTools: ov?.supportsTools ?? base?.supportsTools ?? true,
  };
}

function parseJsonEnv(raw: string | undefined, name: string, warnings: string[]): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    warnings.push(`${name} must be a JSON object; ignored`);
  } catch {
    warnings.push(`${name} is not valid JSON; ignored`);
  }
  return {};
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function parsePriceOverrides(raw: Record<string, unknown>, warnings: string[]): Record<string, PriceOverride> {
  const out: Record<string, PriceOverride> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") {
      warnings.push(`MODEL_PRICES_JSON["${key}"] is not an object; ignored`);
      continue;
    }
    const v = value as Record<string, unknown>;
    const o: PriceOverride = {};
    if (num(v.inputPerMTokUsd) !== undefined) o.inputPerMTokUsd = num(v.inputPerMTokUsd);
    if (num(v.outputPerMTokUsd) !== undefined) o.outputPerMTokUsd = num(v.outputPerMTokUsd);
    if (v.cachedInputPerMTokUsd === null || num(v.cachedInputPerMTokUsd) !== undefined)
      o.cachedInputPerMTokUsd = v.cachedInputPerMTokUsd === null ? null : num(v.cachedInputPerMTokUsd)!;
    if (v.contextWindow === null || num(v.contextWindow) !== undefined)
      o.contextWindow = v.contextWindow === null ? null : num(v.contextWindow)!;
    if (typeof v.supportsTools === "boolean") o.supportsTools = v.supportsTools;
    out[key] = o;
  }
  return out;
}

export interface LoadModelConfigOptions {
  /** Where one-line warnings go (default console.warn). */
  log?: (line: string) => void;
  now?: Date;
}

export function loadModelConfig(env: NodeJS.ProcessEnv, options: LoadModelConfigOptions = {}): ModelConfig {
  const warnings: string[] = [];
  const providers: Record<string, ProviderConfig> = {};
  const wanted = new Set(Object.keys(PROVIDER_DEFAULTS));
  for (const tier of TIERS) {
    for (const suffix of ["", "_FALLBACK"]) {
      const p = parseModelSpec(env[`MODEL_${tier.toUpperCase()}${suffix}`] ?? "");
      if (p && p.provider !== "mock") wanted.add(p.provider);
    }
  }
  for (const name of wanted) {
    const pc = providerConfig(name, env);
    if (pc) providers[name] = pc;
  }

  const priceOverrides = parsePriceOverrides(parseJsonEnv(env.MODEL_PRICES_JSON, "MODEL_PRICES_JSON", warnings), warnings);
  const partial = { providers, priceOverrides, warnings };

  const tiers = {} as ModelConfig["tiers"];
  for (const tier of TIERS) {
    const upper = tier.toUpperCase();
    const primarySpec = (env[`MODEL_${upper}`] ?? "").trim() || defaultSpec(tier, env);
    let primary = buildProfile(partial, primarySpec, tier, options.now);
    if (!primary) {
      warnings.push(`MODEL_${upper}=${primarySpec} unavailable; the ${tier} tier uses the offline mock`);
      primary = mockProfile(tier);
    }
    const fallbackSpec = (env[`MODEL_${upper}_FALLBACK`] ?? "").trim();
    let fallback: ModelProfile | null = null;
    if (fallbackSpec) {
      fallback = buildProfile(partial, fallbackSpec, tier, options.now);
      if (!fallback) warnings.push(`MODEL_${upper}_FALLBACK=${fallbackSpec} unavailable; the ${tier} tier has no fallback`);
      if (fallback && fallback.id === primary.id) fallback = null;
    }
    tiers[tier] = { primary, fallback };
  }

  const stageRouting: Record<string, StageTier> = { ...DEFAULT_STAGE_ROUTING };
  for (const [stage, value] of Object.entries(parseJsonEnv(env.STAGE_ROUTING, "STAGE_ROUTING", warnings))) {
    if (value === "agent" || value === "frontier" || value === "standard" || value === "economy") stageRouting[stage] = value;
    else warnings.push(`STAGE_ROUTING["${stage}"]=${JSON.stringify(value)} is not frontier|standard|economy|agent; ignored`);
  }

  const profiles: ModelProfile[] = [];
  for (const tier of TIERS) {
    for (const p of [tiers[tier].primary, tiers[tier].fallback]) {
      if (p && !profiles.some((x) => x.id === p.id)) profiles.push(p);
    }
  }

  const intEnv = (name: string, def: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
  };

  const log = options.log ?? ((line: string) => console.warn(line));
  for (const w of warnings) log(`[models] ${w}`);

  return {
    tiers,
    profiles,
    providers,
    stageRouting,
    priceOverrides,
    mockLatencyMs: intEnv("MOCK_LATENCY_MS", 400),
    requestTimeoutMs: intEnv("MODEL_TIMEOUT_MS", 120_000),
    defaultMaxOutputTokens: intEnv("MODEL_MAX_OUTPUT_TOKENS", 1200),
    warnings,
  };
}

/** Unset MODEL_<TIER>: Claude when ANTHROPIC_API_KEY is present, else the offline mock. */
export function defaultSpec(tier: ModelTier, env: NodeJS.ProcessEnv): string {
  return (env.ANTHROPIC_API_KEY ?? "").trim() ? RECOMMENDED_TIERS[tier].primary : `mock:${tier}`;
}

/** Who runs on each tier by default (org/agent-factory.ts; managers follow MANAGER_MODEL_TIER). */
export function tierUsers(managerTier: "frontier" | "standard" = "standard"): Record<ModelTier, string[]> {
  const users: Record<ModelTier, string[]> = { frontier: ["executives"], standard: [], economy: ["workers"] };
  users[managerTier].push("managers");
  return users;
}

function describeProfile(p: ModelProfile): string {
  return p.provider === "mock" ? `${p.id} (offline mock)` : `${p.model} via ${p.provider}`;
}

/**
 * Startup summary, one line per tier: tier → model → provider, live or mock, fallback, users.
 * Never includes keys or base URLs.
 */
export function modelSummaryLines(config: ModelConfig, managerTier: "frontier" | "standard" = "standard"): string[] {
  const users = tierUsers(managerTier);
  const width = Math.max(...TIERS.map((t) => describeProfile(config.tiers[t].primary).length));
  return TIERS.map((tier) => {
    const { primary, fallback } = config.tiers[tier];
    const who = users[tier].length ? users[tier].join(" + ") : "stage routing only";
    const mode = primary.provider === "mock" ? "MOCK" : "LIVE";
    const fb = fallback ? ` · fallback ${describeProfile(fallback)} (${fallback.provider === "mock" ? "MOCK" : "LIVE"})` : "";
    return `${tier.padEnd(8)} → ${describeProfile(primary).padEnd(width)}  ${mode}  [${who}]${fb}`;
  });
}

export function modelsInfo(config: ModelConfig): ModelsInfo {
  const tiers = {} as ModelsInfo["tiers"];
  let live = false;
  for (const tier of TIERS) {
    const t = config.tiers[tier];
    tiers[tier] = { primary: t.primary.id, fallback: t.fallback?.id ?? null };
    if (t.primary.provider !== "mock" || (t.fallback && t.fallback.provider !== "mock")) live = true;
  }
  return { live, tiers, profiles: config.profiles.map((p) => ({ ...p })), stageRouting: { ...config.stageRouting } };
}
