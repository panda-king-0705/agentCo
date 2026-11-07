import { test } from "node:test";
import { isAccountError } from "../../src/models/router.ts";
import assert from "node:assert/strict";
import { loadModelConfig, modelsInfo } from "../../src/models/config.ts";
import { costUsd, lookupPrice, normalizeModelKey } from "../../src/models/pricing.ts";
import { parseJsonObject, parseToolArguments } from "../../src/models/json.ts";
import { contextBlock, readContext, readStage, stageMarker } from "../../src/models/protocol.ts";
import { classifyIntent } from "../../src/models/providers/mock-stages.ts";
import type { ChatRequest, ModelProvider } from "../../src/contracts.ts";
import { FakePlatform, makeAgent } from "./fakes.ts";

const quiet = { log: () => {} };

test("config: defaults are all mock, live=false, stage routing per BRAIN.md §4", () => {
  const config = loadModelConfig({}, quiet);
  const info = modelsInfo(config);
  assert.equal(info.live, false);
  assert.equal(info.tiers.frontier.primary, "mock:frontier");
  assert.equal(info.tiers.economy.fallback, null);
  assert.equal(info.stageRouting["metacognition.cognitive_control"], "agent");
  assert.equal(info.stageRouting["metacognition.confidence"], "economy");
  assert.equal(info.stageRouting["chat.reply"], "standard");
  assert.equal(config.mockLatencyMs, 400);
  // Mock tiers are priced like the recommended primaries so savings are visible.
  assert.ok(config.tiers.frontier.primary.inputPerMTokUsd > config.tiers.economy.primary.inputPerMTokUsd);
});

test("config: a tier whose provider has no key falls back to the mock (with a warning)", () => {
  const lines: string[] = [];
  const config = loadModelConfig({ MODEL_ECONOMY: "openai:gpt-6-luna", MODEL_STANDARD: "deepseek:deepseek-flash", DEEPSEEK_API_KEY: "sk-x" }, { log: (l) => lines.push(l) });
  assert.equal(config.tiers.economy.primary.provider, "mock");
  assert.equal(config.tiers.standard.primary.id, "deepseek:deepseek-flash");
  assert.equal(config.tiers.standard.primary.inputPerMTokUsd, 0.3);
  assert.ok(lines.some((l) => l.includes("MODEL_ECONOMY") && l.includes("mock")));
  assert.equal(modelsInfo(config).live, true);
});

test("config: MODEL_PRICES_JSON overrides price and context window; unknown context → null; STAGE_ROUTING merges", () => {
  const config = loadModelConfig(
    {
      MODEL_FRONTIER: "openrouter:acme/unknown-model",
      OPENROUTER_API_KEY: "k",
      MODEL_ECONOMY: "ark:seed-2-0-mini-260428",
      ARK_API_KEY: "k",
      MODEL_PRICES_JSON: JSON.stringify({ "seed-2-0-mini-260428": { inputPerMTokUsd: 0.2, contextWindow: 64000 } }),
      STAGE_ROUTING: JSON.stringify({ "metacognition.confidence": "standard", bogus: "huge" }),
    },
    quiet,
  );
  assert.equal(config.tiers.economy.primary.inputPerMTokUsd, 0.2);
  assert.equal(config.tiers.economy.primary.outputPerMTokUsd, 0.4);
  assert.equal(config.tiers.economy.primary.contextWindow, 64000);
  assert.equal(config.tiers.frontier.primary.contextWindow, null);
  assert.ok(config.tiers.frontier.primary.inputPerMTokUsd > 0, "unknown price assumes the tier reference price");
  assert.equal(config.stageRouting["metacognition.confidence"], "standard");
  assert.equal(config.stageRouting.bogus, undefined);
  assert.ok(config.warnings.some((w) => w.includes("STAGE_ROUTING")));
});

test("pricing: normalised lookup, scheduled changes, cached-token cost math", () => {
  assert.equal(normalizeModelKey("anthropic/Claude-Opus-5.5"), "claude-opus-5-5");
  assert.equal(lookupPrice("gemini-4-argon", new Date("2026-11-05"))!.inputPerMTokUsd, 2);
  assert.equal(lookupPrice("gemini-4-argon", new Date("2026-12-02"))!.inputPerMTokUsd, 4);
  assert.equal(lookupPrice("nope"), null);
  const price = { inputPerMTokUsd: 2, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 0.1 };
  // 1M input of which 400k cached, 100k output: 600k·2 + 400k·0.1 + 100k·10 = 1.2 + 0.04 + 1.0
  assert.equal(costUsd(price, { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 400_000 }), 2.24);
  // No cached price → cached tokens at the input price.
  assert.equal(costUsd({ ...price, cachedInputPerMTokUsd: null }, { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 }), 2);
});

test("json: robust parsing of model output", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('Sure!\n```json\n{"a": {"b": "}"}}\n```\nDone.'), { a: { b: "}" } });
  assert.deepEqual(parseJsonObject('Here: {"x": [1,2]} and {"y": 2}'), { x: [1, 2] });
  assert.deepEqual(parseJsonObject("noise {bad json} then {\"ok\":true}"), { ok: true });
  assert.equal(parseJsonObject("[1,2,3]"), null);
  assert.equal(parseJsonObject("not json at all"), null);
  assert.equal(parseJsonObject(""), null);
  // A reply cut off mid-object is NOT parsed into one of its nested objects (live: a truncated plan came
  // back as its first candidate, dropping mode and subprocesses) — null, so llmJson repairs it.
  const cut = '{"mode":"delegate","subprocesses":[{"title":"Marketing","assigneeId":"agt_cmo"}],"candidates":[{"name":"high_cost","approach":"x","estCostUsd":0.1},{"name":"low_co';
  assert.equal(parseJsonObject(cut), null);
  assert.equal(parseJsonObject("```json\n" + cut), null);
  assert.deepEqual(parseToolArguments('{"path":"a.md"}'), { path: "a.md" });
  assert.deepEqual(parseToolArguments("{oops"), { _raw: "{oops" });
});

test("protocol: stage marker and context block round-trip (incl. ']]' inside strings)", () => {
  const sys = `${stageMarker("metacognition.confidence")}\nYou are…\n${contextBlock({ task: { title: "a]]b" }, n: [[1]] })}`;
  const msgs = [{ role: "system" as const, content: sys }, { role: "user" as const, content: "go" }];
  assert.equal(readStage(msgs), "metacognition.confidence");
  assert.deepEqual(readContext(msgs), { task: { title: "a]]b" }, n: [[1]] });
});

test("mock: chat intent classification", () => {
  assert.equal(classifyIntent("Plan and prepare the launch of our first product."), "work");
  assert.equal(classifyIntent("Can you draft a pricing page?"), "work");
  assert.equal(classifyIntent("Hi there!"), "chat");
  assert.equal(classifyIntent("How is the launch going?"), "chat");
  assert.equal(classifyIntent("What do you think about our vision?"), "chat");
});

// ───────────────────────────── Router ─────────────────────────────

const agent = makeAgent({ id: "agt_r", modelTier: "standard" });
function ctx(platform: FakePlatform, stage = "test.stage") {
  const span = platform.tracer.startSpan({ traceId: "trc_r", parentSpanId: null, kind: "run", name: "run" });
  return { agentId: agent.id, runId: "run_r", traceId: "trc_r", parentSpanId: span.spanId, taskId: "tsk_r", stage, signal: new AbortController().signal };
}
const req = (extra: Partial<ChatRequest> = {}): ChatRequest => ({ tier: "standard", messages: [{ role: "system", content: "x".repeat(4000) }, { role: "user", content: "hi" }], ...extra });

function scripted(results: (Error | { content: string; inputTokens?: number; outputTokens?: number; cached?: number })[]): ModelProvider & { calls: number } {
  const p = {
    name: "scripted",
    calls: 0,
    async complete() {
      const r = results[Math.min(p.calls, results.length - 1)]!;
      p.calls++;
      if (r instanceof Error) throw r;
      return {
        content: r.content,
        toolCalls: [],
        usage: { inputTokens: r.inputTokens ?? 1000, outputTokens: r.outputTokens ?? 100, cachedInputTokens: r.cached ?? 0 },
        finishReason: "stop" as const,
      };
    },
  };
  return p;
}

const liveEnv = {
  MODEL_FRONTIER: "openai:gpt-6-astra",
  MODEL_STANDARD: "openai:gpt-6.1-sol",
  MODEL_STANDARD_FALLBACK: "deepseek:deepseek-v4-pro",
  MODEL_ECONOMY: "openai:gpt-6-luna",
  OPENAI_API_KEY: "sk-test",
  DEEPSEEK_API_KEY: "sk-test2",
};

test("router: cost math with cached tokens, frontierCostUsd, span attributes and parentage", async () => {
  const provider = scripted([{ content: "ok", inputTokens: 1_000_000, outputTokens: 10_000, cached: 200_000 }]);
  const platform = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": provider } });
  const c = ctx(platform, "metacognition.confidence");
  platform.addAgent(agent);
  const res = await platform.models.chat(req(), c);
  // gpt-6.1-sol: 800k·2 + 200k·0.1 + 10k·10 = 1.6 + 0.02 + 0.1
  assert.equal(res.costUsd, 1.72);
  const entry = platform.budget.entries[0]!;
  assert.equal(entry.costUsd, 1.72);
  // frontier gpt-6-astra: 800k·10 + 200k·1 + 10k·50 = 8 + 0.2 + 0.5
  assert.equal(entry.frontierCostUsd, 8.7);
  assert.equal(entry.cachedInputTokens, 200_000);
  assert.equal(entry.stage, "metacognition.confidence");
  const span = platform.tracer.byKind("llm")[0]!;
  assert.equal(span.parentSpanId, c.parentSpanId);
  assert.equal(span.status, "ok");
  assert.equal(span.attributes["gen_ai.operation.name"], "chat");
  assert.equal(span.attributes["gen_ai.provider.name"], "openai");
  assert.equal(span.attributes["gen_ai.request.model"], "gpt-6.1-sol");
  assert.equal(span.attributes["gen_ai.usage.input_tokens"], 1_000_000);
  assert.equal(span.attributes["agentco.tier"], "standard");
  assert.equal(span.attributes["agentco.cost_usd"], 1.72);
  assert.equal(span.costUsd, 1.72);
  assert.equal(res.spanId, span.id);
  assert.ok(platform.budget.asserts[0]!.estimateUsd > 0, "estimate checked before the call");
});

test("router: provider error → error span, retry once on the fallback profile (second span ok)", async () => {
  const provider = scripted([new Error("HTTP 503 upstream"), { content: "from fallback" }]);
  const platform = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": provider } });
  const res = await platform.models.chat(req(), ctx(platform));
  assert.equal(res.content, "from fallback");
  assert.equal(res.profile.id, "deepseek:deepseek-v4-pro");
  const llm = platform.tracer.byKind("llm");
  assert.equal(llm.length, 2);
  assert.equal(llm[0]!.status, "error");
  assert.match(llm[0]!.error ?? "", /503/);
  assert.equal(llm[1]!.status, "ok");
  assert.equal(llm[1]!.attributes["agentco.fallback_from"], "openai:gpt-6.1-sol");
  assert.equal(platform.budget.entries.length, 1);
});

// 2026-11-07 (trc_617b…): a dropped hotspot made both providers fail with "fetch failed"; that is an
// outage the platform waits out (models/outage.ts), not a task failure.
test("router: no provider reachable → ProviderOutageError; one unreachable with an answer from the other → no error", async () => {
  const down = (p: string) => new Error(`${p} request to https://api.${p}.com/v1/chat/completions failed: fetch failed`);
  const both = scripted([down("openai"), down("deepseek")]);
  const p1 = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": both } });
  await assert.rejects(p1.models.chat(req(), ctx(p1)), (err: Error) => err.name === "ProviderOutageError" && /^AI providers unreachable \(.*fetch failed; .*fetch failed\)/.test(err.message));
  const one = scripted([down("openai"), { content: "from fallback" }]);
  const p2 = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": one } });
  assert.equal((await p2.models.chat(req(), ctx(p2))).content, "from fallback");
  const solo = scripted([down("openai")]);
  const p3 = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": solo } });
  await assert.rejects(p3.models.chat(req({ tier: "economy" }), ctx(p3)), (err: Error) => err.name === "ProviderOutageError", "no fallback: the only provider is unreachable");
  const busy = scripted([new Error("HTTP 503 upstream"), new Error("HTTP 503 upstream")]);
  const p4 = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": busy } });
  await assert.rejects(p4.models.chat(req(), ctx(p4)), (err: Error) => err.name !== "ProviderOutageError" && /503/.test(err.message), "a provider that answers with an error is not an outage");
});

test("router: error without a fallback propagates", async () => {
  const provider = scripted([new Error("boom")]);
  const platform = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": provider } });
  await assert.rejects(platform.models.chat(req({ tier: "economy" }), ctx(platform)), /boom/);
  assert.equal(provider.calls, 1);
});

test("router: BudgetExceededError propagates and the provider is never called", async () => {
  const provider = scripted([{ content: "should not happen" }]);
  const platform = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": provider } });
  platform.budget.limitUsd = 0;
  await assert.rejects(platform.models.chat(req(), ctx(platform)), (err: Error) => err.name === "BudgetExceededError");
  assert.equal(provider.calls, 0);
  assert.equal(platform.tracer.byKind("llm").length, 0);
});

test("router: stage routing (exact, prefix, agent) and overrides", () => {
  const platform = new FakePlatform({ env: { STAGE_ROUTING: '{"metacognition.monitoring":"frontier"}' } });
  const exec = makeAgent({ id: "agt_e", modelTier: "frontier" });
  const worker = makeAgent({ id: "agt_w", modelTier: "economy" });
  assert.equal(platform.models.tierForStage("metacognition.target_understanding.problem_definition", exec), "economy");
  assert.equal(platform.models.tierForStage("metacognition.cognitive_control", exec), "frontier");
  assert.equal(platform.models.tierForStage("metacognition.cognitive_control", worker), "economy");
  assert.equal(platform.models.tierForStage("metacognition.monitoring.ood", worker), "frontier", "prefix match");
  assert.equal(platform.models.tierForStage("reflex.step", worker), "economy");
  assert.equal(platform.models.tierForStage("unknown.stage", exec), "frontier", "unknown → agent tier");
  assert.equal(platform.models.resolve("economy").id, "mock:economy");
  assert.equal(platform.models.resolve("economy", "mock:frontier").id, "mock:frontier");
  assert.equal(platform.models.isLive(), false);
});

test("router: json responses parse robustly; garbage → json null", async () => {
  const provider = scripted([{ content: "```json\n{\"confidence\":0.7}\n```" }, { content: "I cannot comply" }]);
  const platform = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": provider } });
  const a = await platform.models.chat(req({ responseFormat: "json", tier: "economy" }), ctx(platform));
  assert.deepEqual(a.json, { confidence: 0.7 });
  const b = await platform.models.chat(req({ responseFormat: "json", tier: "economy" }), ctx(platform));
  assert.equal(b.json, null);
  assert.equal(b.content, "I cannot comply");
});

test("router: abort is respected and not retried", async () => {
  const platform = new FakePlatform({ env: { MOCK_LATENCY_MS: "200" } });
  const controller = new AbortController();
  const c = { ...ctx(platform), signal: controller.signal };
  const p = platform.models.chat(req({ tier: "economy" }), c);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(p);
  const llm = platform.tracer.byKind("llm");
  assert.equal(llm.length, 1);
  assert.equal(llm[0]!.status, "cancelled");
  assert.equal(platform.budget.entries.length, 0);
});

test("mock provider: usage = ceil(chars/4), deterministic stage JSON", async () => {
  const platform = new FakePlatform();
  const messages = [
    { role: "system" as const, content: `${stageMarker("metacognition.confidence")}\n${contextBlock({ ood: true })}` },
    { role: "user" as const, content: "assess" },
  ];
  const r1 = await platform.models.chat({ tier: "economy", messages, responseFormat: "json" }, ctx(platform));
  const r2 = await platform.models.chat({ tier: "economy", messages, responseFormat: "json" }, ctx(platform));
  assert.deepEqual(r1.json, r2.json);
  assert.equal(r1.json!.uncertainty, 0.5);
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  assert.equal(r1.usage.inputTokens, Math.ceil(chars / 4));
  assert.ok(r1.costUsd > 0, "mock calls are priced");
  assert.equal(r1.profile.provider, "mock");
});

// Live (2026-11-07, test 5): the Anthropic account ran out of credit. Every call failed on Anthropic
// first and then went to the fallback — a wasted round trip each time.
test("router: an account error (no credit) skips that provider for a while and goes straight to the fallback", async () => {
  const provider = scripted([
    new Error('openai gpt-6.1-sol: HTTP 400 Bad Request — {"error":{"message":"Your credit balance is too low to access the API."}}'),
    { content: "fallback 1" },
    { content: "fallback 2" },
  ]);
  const platform = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": provider } });
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  try {
    assert.equal((await platform.models.chat(req(), ctx(platform))).content, "fallback 1");
    assert.equal((await platform.models.chat(req(), ctx(platform))).content, "fallback 2");
  } finally {
    console.warn = warn;
  }
  assert.equal(provider.calls, 3, "the second call never tried the provider without credit");
  const llm = platform.tracer.byKind("llm");
  assert.equal(llm.length, 3);
  assert.equal(llm[2]!.attributes["agentco.primary_skipped"], "credit balance too low (top up the provider account)");
  assert.equal(llm[2]!.attributes["agentco.fallback_from"], "openai:gpt-6.1-sol");
  assert.equal(warned.length, 1, "one warning per outage");
  assert.match(warned[0]!, /openai: credit balance too low .* using fallback models for 10 minutes/);
});

test("router: an ordinary provider error does not take the provider out of rotation", async () => {
  const provider = scripted([new Error("HTTP 503 upstream"), { content: "fallback" }, { content: "primary again" }]);
  const platform = new FakePlatform({ env: liveEnv, providers: { "openai-compatible": provider } });
  await platform.models.chat(req(), ctx(platform));
  const second = await platform.models.chat(req(), ctx(platform));
  assert.equal(second.profile.id, "openai:gpt-6.1-sol");
  assert.equal(provider.calls, 3);
});

test("isAccountError: credit, quota and rejected keys — not rate limits or outages", () => {
  for (const m of ["Your credit balance is too low", "insufficient_quota", "HTTP 401 Unauthorized", "invalid x-api-key"]) assert.ok(isAccountError(new Error(m)), m);
  for (const m of ["HTTP 429 Too Many Requests", "HTTP 503 upstream", "HTTP 400 Bad Request — temperature"]) assert.ok(!isAccountError(new Error(m)), m);
});
