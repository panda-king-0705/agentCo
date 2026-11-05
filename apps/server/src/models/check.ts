/**
 * `npm run check:models`: one tiny real call per configured live tier (max_tokens 16) to prove the
 * keys and model ids work before the company spends real money. Prints model, latency, tokens and
 * cost per tier; exits 1 on an auth / model / network error and 2 when no live model is configured
 * (it refuses to run without keys). Keys are never printed.
 *
 * Calls the provider adapter directly — no budget ledger, no traces, no database.
 */
import type { ModelProfile, ModelTier } from "../../../../packages/shared/src/index.ts";
import { loadModelConfig, parseModelSpec, TIERS, type ModelConfig } from "./config.ts";
import { costUsd } from "./pricing.ts";
import { OpenAICompatibleProvider } from "./providers/openai.ts";

export const CHECK_MAX_TOKENS = 16;

export interface CheckModelsOptions {
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Also call each live fallback profile. */
  includeFallbacks?: boolean;
  timeoutMs?: number;
}

export type CheckFailure = "auth" | "model" | "network" | "other";

export interface CheckResult {
  tier: ModelTier;
  role: "primary" | "fallback";
  profileId: string;
  ok: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  reply: string;
  failure: CheckFailure | null;
  error: string | null;
}

export interface CheckModelsReport {
  exitCode: 0 | 1 | 2;
  results: CheckResult[];
}

/** HTTP 401/403 → auth; 404 or a 400 naming the model → model; fetch failure/timeout → network. */
export function classifyFailure(message: string): CheckFailure {
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status === "401" || status === "403") return "auth";
  if (status === "404") return "model";
  if (status === "400" && /model/i.test(message)) return "model";
  if (!status && /failed|timeout|timed out|abort|ECONN|ENOTFOUND|fetch/i.test(message)) return "network";
  return "other";
}

const HINT: Record<CheckFailure, string> = {
  auth: "the API key was rejected — check the *_API_KEY in .env (and that it belongs to this provider)",
  model: "the model id was not found or not allowed — check MODEL_* in .env",
  network: "could not reach the provider — check the network / *_BASE_URL",
  other: "unexpected provider error",
};

/** Tiers whose MODEL_* (explicit or default) names a real provider but resolved to the mock (no key). */
function silentlyMocked(config: ModelConfig, env: NodeJS.ProcessEnv): ModelTier[] {
  return TIERS.filter((tier) => {
    const spec = parseModelSpec((env[`MODEL_${tier.toUpperCase()}`] ?? "").trim());
    return spec !== null && spec.provider !== "mock" && config.tiers[tier].primary.provider === "mock";
  });
}

function usd(n: number): string {
  return `$${n.toFixed(6)}`;
}

export async function checkModels(env: NodeJS.ProcessEnv, options: CheckModelsOptions = {}): Promise<CheckModelsReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warnings: string[] = [];
  const config = loadModelConfig(env, { log: (w) => warnings.push(w) });

  const targets: { tier: ModelTier; role: "primary" | "fallback"; profile: ModelProfile }[] = [];
  for (const tier of TIERS) {
    const { primary, fallback } = config.tiers[tier];
    if (primary.provider !== "mock") targets.push({ tier, role: "primary", profile: primary });
    if (options.includeFallbacks && fallback && fallback.provider !== "mock") targets.push({ tier, role: "fallback", profile: fallback });
  }

  if (targets.length === 0) {
    log("check:models refused: no live model is configured, so there is nothing to check (and nothing is spent).");
    log("  Put your key in .env (never in chat or git): ANTHROPIC_API_KEY=...");
    log("  With only that key, the tiers default to claude-opus-5-5 / claude-sonnet-5-5 / claude-haiku-5-5.");
    for (const w of warnings) log(`  ${w}`);
    return { exitCode: 2, results: [] };
  }

  const mocked = silentlyMocked(config, env);
  for (const w of warnings) log(w);
  for (const tier of mocked) log(`[models] ${tier}: MODEL_${tier.toUpperCase()} has no key, so this tier would run on the offline mock — not checked`);

  const provider = new OpenAICompatibleProvider({ providers: config.providers, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const timeoutMs = options.timeoutMs ?? 30_000;
  log(`check:models — ${targets.length} live call(s), max_tokens ${CHECK_MAX_TOKENS} each`);
  const results: CheckResult[] = [];
  for (const { tier, role, profile } of targets) {
    const started = performance.now();
    const label = `${tier.padEnd(8)} ${role === "fallback" ? "fallback " : ""}${profile.id}`;
    try {
      const out = await provider.complete(
        profile,
        {
          tier,
          messages: [
            { role: "system", content: "You are a connectivity check. Reply with the single word OK." },
            { role: "user", content: "ping" },
          ],
          maxOutputTokens: CHECK_MAX_TOKENS,
          temperature: 0,
        },
        AbortSignal.timeout(timeoutMs),
      );
      const latencyMs = Math.round(performance.now() - started);
      const cost = costUsd(profile, out.usage);
      const reply = out.content.replace(/\s+/g, " ").trim().slice(0, 40);
      results.push({
        tier, role, profileId: profile.id, ok: true, latencyMs,
        inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, costUsd: cost, reply, failure: null, error: null,
      });
      log(`  OK    ${label}  ${latencyMs} ms  in ${out.usage.inputTokens} / out ${out.usage.outputTokens} tok  ${usd(cost)}  reply "${reply}"`);
    } catch (err) {
      const latencyMs = Math.round(performance.now() - started);
      const message = err instanceof Error ? err.message : String(err);
      const failure = classifyFailure(message);
      results.push({ tier, role, profileId: profile.id, ok: false, latencyMs, inputTokens: 0, outputTokens: 0, costUsd: 0, reply: "", failure, error: message });
      log(`  FAIL  ${label}  ${latencyMs} ms  ${failure}: ${HINT[failure]}`);
      log(`        ${message.slice(0, 300)}`);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  const total = results.reduce((n, r) => n + r.costUsd, 0);
  log(failed === 0 ? `all ${results.length} live call(s) OK · total ${usd(total)}` : `${failed} of ${results.length} live call(s) FAILED · total ${usd(total)}`);
  return { exitCode: failed === 0 ? 0 : 1, results };
}
