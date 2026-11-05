// Review 2 regressions (platform side of the brain spec): Maslow belonging facts, escalation to the
// next active ancestor, and the run streak behind Human Nature's fatigue.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent, Run } from "../../../../packages/shared/src/index.ts";
import { computeNeeds } from "../../src/org/needs.ts";
import { callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";

const agentOf = (over: Partial<Agent>): Agent => ({ id: "a", tier: "worker", managerId: "m", status: "idle", identity: { okrs: [] }, ...over }) as unknown as Agent;
const facts = (agent: Agent, extra: Partial<Parameters<typeof computeNeeds>[0]> = {}) => ({
  agent,
  manager: { id: "m", status: "idle" } as Agent,
  reports: [] as Agent[],
  remainingUsd: 10,
  limitUsd: 10,
  recentRuns: [] as Run[],
  ...extra,
});

test("R2 spec (e): belonging is low when the manager is missing/terminated or a leader's reports are all unreachable", () => {
  const worker = agentOf({});
  assert.equal(computeNeeds(facts(worker)).belonging, "ok");
  assert.equal(computeNeeds(facts(worker, { manager: null })).belonging, "low", "manager missing");
  assert.equal(computeNeeds(facts(worker, { manager: { id: "m", status: "terminated" } as Agent })).belonging, "low", "manager terminated");
  const lead = agentOf({ tier: "manager" });
  const paused = { id: "r", status: "paused" } as Agent;
  const active = { id: "r2", status: "idle" } as Agent;
  assert.equal(computeNeeds(facts(lead, { reports: [paused], reportsEver: 1 })).belonging, "low", "every report paused");
  assert.equal(computeNeeds(facts(lead, { reports: [], reportsEver: 2 })).belonging, "low", "every report terminated");
  assert.equal(computeNeeds(facts(lead, { reports: [paused, active], reportsEver: 2 })).belonging, "ok", "one reachable report is enough");
  assert.equal(computeNeeds(facts(lead, { reports: [], reportsEver: 0 })).belonging, "ok", "a staff role without reports is not lonely");
  const ceo = agentOf({ tier: "executive", managerId: null });
  assert.equal(computeNeeds(facts(ceo, { manager: null })).belonging, "ok", "the CEO belongs to the Board");
  assert.equal(computeNeeds(facts(ceo, { manager: null, reports: [], reportsEver: 5 })).belonging, "low", "a CEO with no reachable reports");
});

test("R2 spec (e): OrgService.needs counts terminated reports; escalate goes to the next ACTIVE ancestor", async () => {
  let effects: { kind: string; assigneeId?: string }[] = [];
  const t = await createTestApp({
    reflex: async (ctx) => {
      const r = await callTool(ctx, "escalate", { reason: "blocked", question: "Which way?" });
      effects = r.effects as typeof effects;
      return { outcome: "waiting", output: "waiting" };
    },
    brain: async () => done("Go left."),
  });
  try {
    const { platform } = t.app;
    const worker = t.agentByRole("backend-engineer");
    const manager = platform.org.getAgent(worker.managerId!)!;
    const grand = platform.org.getAgent(manager.managerId!)!;
    // Terminate the worker's manager without reassigning (as if the manager had just gone).
    platform.repos.agents.update(manager.id, { status: "terminated" });
    assert.equal(platform.org.needs(worker.id).belonging, "low");
    rootTask(t, worker.id, "Build the endpoint");
    platform.scheduler.tick();
    await platform.runs.idle();
    const created = effects.find((e) => e.kind === "task_created");
    assert.ok(created, "escalated as a subtask, not a Board question");
    assert.equal(created!.assigneeId, grand.id, "to the next active ancestor");
    // A leader all of whose reports were terminated: belonging low.
    platform.repos.agents.update(worker.id, { status: "terminated" });
    const siblings = platform.org.directReports(manager.id);
    for (const s of siblings) platform.repos.agents.update(s.id, { status: "terminated" });
    platform.repos.agents.update(manager.id, { status: "idle" });
    assert.equal(platform.org.needs(manager.id).belonging, "low");
  } finally {
    await t.close();
  }
});

test("R2 spec (c): MetricsService.runStreak counts runs without idle time and the idle time before the current run", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const base = Date.parse("2026-11-05T10:00:00.000Z");
    const at = (min: number) => new Date(base + min * 60_000).toISOString();
    let n = 0;
    const insert = (startMin: number, endMin: number | null) =>
      platform.repos.runs.insert({
        id: `run_s${++n}`, agentId: ceo.id, taskId: null, conversationId: null, traceId: `trc_s${n}`, rootSpanId: `spn_s${n}`, trigger: "task", engine: "brain",
        status: endMin === null ? "running" : "completed", output: null, error: null, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, costUsd: 0, llmCalls: 0, toolCalls: 0,
        failingSpanId: null, startedAt: at(startMin), completedAt: endMin === null ? null : at(endMin), createdAt: at(startMin),
      } as Run);
    insert(0, 5); // then 2 hours idle
    insert(125, 130);
    insert(131, 135);
    insert(136, null); // the current run
    const streak = platform.metrics.runStreak(ceo.id, 10 * 60_000);
    assert.deepEqual(streak, { consecutiveRuns: 3, idleMsBefore: 60_000 });
    assert.equal(platform.metrics.runStreak(ceo.id, 10 * 60_000, 2).consecutiveRuns, 2, "capped");
    assert.deepEqual(platform.metrics.runStreak("agt_nobody", 60_000), { consecutiveRuns: 1, idleMsBefore: 0 });
  } finally {
    await t.close();
  }
});
