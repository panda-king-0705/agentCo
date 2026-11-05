import { test } from "node:test";
import assert from "node:assert/strict";
import type { Span } from "../../../../packages/shared/src/index.ts";
import { createTestApp, done, rootTask } from "./helpers/harness.ts";
import { percentile } from "../../src/metrics/service.ts";

function llmSpan(agentId: string, stage: string, over: Partial<Span>): Span {
  const at = new Date().toISOString();
  return {
    id: `spn_${Math.random().toString(36).slice(2)}`, traceId: "trc_m", parentSpanId: null, kind: "llm", name: "llm.chat", status: "ok", agentId, runId: null, taskId: null,
    startedAt: at, endedAt: at, durationMs: 100, input: null, output: null, error: null, model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.001,
    attributes: { "agentco.stage": stage }, ...over,
  };
}

test("percentile is nearest-rank", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
  assert.equal(percentile([7], 0.95), 7);
});

test("blockProfile profiles one agent's llm spans for one stage over the window", async () => {
  const t = await createTestApp();
  try {
    const { repos, metrics } = t.app.platform;
    const cto = t.agentByRole("cto").id;
    const cfo = t.agentByRole("cfo").id;
    for (const [ms, tokens, cost, status] of [[100, 10, 0.001, "ok"], [200, 20, 0.002, "ok"], [300, 30, 0.003, "ok"], [1000, 400, 0.01, "error"]] as const) {
      repos.spans.insert(llmSpan(cto, "brain.planning", { durationMs: ms, inputTokens: tokens, outputTokens: tokens / 2, costUsd: cost, status }));
    }
    repos.spans.insert(llmSpan(cto, "brain.evaluation", { durationMs: 5 })); // other stage
    repos.spans.insert(llmSpan(cfo, "brain.planning", { durationMs: 5 })); // other agent
    repos.spans.insert(llmSpan(cto, "brain.planning", { durationMs: 5, startedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() })); // outside 14 days
    repos.spans.insert({ ...llmSpan(cto, "brain.planning", {}), kind: "tool" }); // not an llm span

    const p = metrics.blockProfile(cto, "brain.planning");
    assert.equal(p.calls, 4);
    assert.equal(p.p50Ms, 200);
    assert.equal(p.p95Ms, 1000);
    assert.equal(p.p95InputTokens, 400);
    assert.equal(p.p95OutputTokens, 200);
    assert.ok(Math.abs((p.meanCostUsd ?? 0) - 0.004) < 1e-9);
    assert.equal(p.errorRate, 0.25);
    assert.equal(metrics.blockProfile(cto, "brain.planning", 60).calls, 5, "a longer window sees the old span");
    const empty = metrics.blockProfile(cto, "no.such.block");
    assert.deepEqual({ ...empty }, { block: "no.such.block", calls: 0, p50Ms: null, p95Ms: null, p95InputTokens: null, p95OutputTokens: null, meanCostUsd: null, errorRate: null });
    // the engines see the same view through PlatformServices
    assert.equal(t.app.platform.services.metrics.blockProfile(cto, "brain.planning").calls, 4);
  } finally {
    await t.close();
  }
});

test("overview and timeseries aggregate spend, savings, runs and tasks", async () => {
  const t = await createTestApp({ reflex: () => done("ok") });
  try {
    const { platform } = t.app;
    const dev = t.agentByRole("backend-engineer");
    const task = rootTask(t, dev.id, "metered");
    await t.drain();
    const run = platform.repos.runs.list({ taskId: task.id })[0];
    const entry = (tier: "frontier" | "economy", cost: number, frontier: number) => ({
      agentId: dev.id, runId: run?.id as string, traceId: task.traceId, spanId: "spn_x", taskId: task.id, provider: "mock", model: `${tier}-model`, profileId: tier, tier, stage: "reflex.step",
      inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costUsd: cost, frontierCostUsd: frontier,
    });
    platform.budget.recordSpend(entry("economy", 0.01, 0.2));
    platform.budget.recordSpend(entry("economy", 0.02, 0.3));
    platform.budget.recordSpend(entry("frontier", 0.5, 0.5));

    const o = platform.metrics.overview();
    assert.ok(Math.abs(o.routingSavingsUsd - 0.47) < 1e-9, `routingSavingsUsd = Σ(frontier − actual) = ${o.routingSavingsUsd}`);
    assert.ok(Math.abs(o.spendByTier.economy - 0.03) < 1e-9);
    assert.ok(Math.abs(o.spendByTier.frontier - 0.5) < 1e-9);
    assert.ok(Math.abs(o.spentTodayUsd - 0.53) < 1e-9);
    assert.deepEqual(o.tokens24h, { input: 300, output: 150 });
    assert.equal(o.spendByModel.find((m) => m.model === "economy-model")?.calls, 2);
    assert.equal(o.spendByDepartment[0]?.departmentId, dev.departmentId);
    assert.equal(o.runs24h, 1);
    assert.equal(o.runSuccessRate, 1);
    assert.equal(o.tasksByStatus.done, 1);
    assert.equal(o.agentsByStatus.idle >= 12, true);
    assert.equal(o.agentsByStatus.terminated, 0);
    assert.ok(platform.snapshot().spentTodayUsd > 0.5);

    const cost = platform.metrics.timeseries("cost", 3);
    assert.equal(cost.length, 3);
    assert.ok(Math.abs(cost.reduce((a, p) => a + p.value, 0) - 0.53) < 1e-9);
    assert.equal(platform.metrics.timeseries("tokens", 2).reduce((a, p) => a + p.value, 0), 450);
    assert.equal(platform.metrics.timeseries("runs", 24).reduce((a, p) => a + p.value, 0), 1);
    assert.throws(() => platform.metrics.timeseries("cost", 0), /hours/);
  } finally {
    await t.close();
  }
});
