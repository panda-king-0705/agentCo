import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, done, gate, rootTask, waitFor } from "./helpers/harness.ts";

test("priority = value / cost: the cheapest valuable task starts first, ties go to the oldest", async () => {
  const order: string[] = [];
  const t = await createTestApp({ config: {}, env: { MAX_CONCURRENT_RUNS: "1" }, reflex: (ctx) => (order.push(ctx.input.trigger === "message" ? "msg" : ctx.input.task.title), done()) });
  try {
    const dev = t.agentByRole("backend-engineer");
    const fe = t.agentByRole("frontend-engineer");
    const writer = t.agentByRole("content-writer");
    const first = rootTask(t, dev.id, "low", { value: 10, estCostUsd: 1 }); // 10
    rootTask(t, fe.id, "high", { value: 500, estCostUsd: 0.1 }); // 5000
    rootTask(t, writer.id, "mid", { value: 100, estCostUsd: 0.1 }); // 1000
    assert.equal(first.priority, 10);
    await t.drain();
    assert.deepEqual(order, ["high", "mid", "low"]);
  } finally {
    await t.close();
  }
});

test("maxConcurrentRuns caps parallelism and one agent never runs twice at once", async () => {
  const hold = gate();
  let live = 0;
  let peak = 0;
  const t = await createTestApp({
    env: { MAX_CONCURRENT_RUNS: "2" },
    reflex: async () => {
      live += 1;
      peak = Math.max(peak, live);
      await hold.promise;
      live -= 1;
      return done();
    },
  });
  try {
    const dev = t.agentByRole("backend-engineer");
    rootTask(t, dev.id, "a1");
    rootTask(t, dev.id, "a2"); // same agent: must wait for a1
    rootTask(t, t.agentByRole("frontend-engineer").id, "b");
    rootTask(t, t.agentByRole("content-writer").id, "c");
    assert.equal(t.app.platform.scheduler.tick(), 2, "two runs start (the cap), not four");
    assert.equal(t.app.platform.runs.activeCount(), 2);
    assert.equal(t.app.platform.scheduler.tick(), 0, "the cap holds on the next pass");
    const running = t.app.platform.repos.runs.list({ status: "running" });
    assert.equal(new Set(running.map((r) => r.agentId)).size, running.length, "at most one run per agent");
    hold.open();
    await t.drain();
    assert.equal(peak, 2);
    assert.equal(t.app.platform.repos.tasks.list({ status: "done" }).length, 4);
  } finally {
    await t.close();
  }
});

test("paused, terminated and over-budget agents are skipped; queued chat messages go first", async () => {
  const order: string[] = [];
  const t = await createTestApp({
    env: { MAX_CONCURRENT_RUNS: "1" },
    reflex: (ctx) => (order.push(ctx.input.trigger === "message" ? `chat:${ctx.agent.roleId}` : ctx.input.task.title), done()),
  });
  try {
    const { platform } = t.app;
    const dev = t.agentByRole("backend-engineer");
    const fe = t.agentByRole("frontend-engineer");
    const qa = t.agentByRole("content-writer");
    const broke = t.agentByRole("sdr-prospector");
    platform.org.pauseAgent(dev.id);
    platform.repos.agents.update(broke.id, { monthlyBudgetUsd: 0.01 });
    platform.budget.recordSpend({
      agentId: broke.id, runId: "run_x", traceId: "trc_x", spanId: "spn_x", taskId: null, provider: "mock", model: "m", profileId: "p", tier: "economy", stage: "s",
      inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0.01, frontierCostUsd: 0.1,
    });
    rootTask(t, dev.id, "paused-agent-task", { value: 1000, estCostUsd: 0.01 });
    rootTask(t, broke.id, "over-budget-task", { value: 1000, estCostUsd: 0.01 });
    rootTask(t, fe.id, "runnable-task", { value: 1, estCostUsd: 1 });
    const dm = platform.conversations.directMessage(qa);
    platform.conversations.postHuman(dm.id, "hello writer");
    await t.drain();
    assert.deepEqual(order, ["chat:content-writer", "runnable-task"], "chat first, then the only runnable task");
    assert.equal(platform.tasks.require(platform.repos.tasks.list({ assigneeId: dev.id })[0]?.id as string).status, "todo");
    assert.equal(platform.repos.tasks.list({ assigneeId: broke.id })[0]?.status, "todo");
    // resuming the agent releases its task
    platform.org.resumeAgent(dev.id);
    await t.drain();
    assert.ok(order.includes("paused-agent-task"));
  } finally {
    await t.close();
  }
});

test("company pause is a kill switch: it aborts running runs and nothing starts until resume", async () => {
  const hold = gate();
  const t = await createTestApp({ reflex: async (ctx) => (ctx.input.trigger !== "message" && ctx.input.task.title === "long" ? (await hold.promise, done("late")) : done("quick")) });
  try {
    const { platform } = t.app;
    const long = rootTask(t, t.agentByRole("backend-engineer").id, "long");
    platform.scheduler.tick();
    await waitFor("run active", () => platform.runs.activeCount() === 1);
    platform.pauseCompany();
    await platform.runs.idle();
    const [run] = platform.repos.runs.list({ taskId: long.id });
    assert.equal(run?.status, "cancelled");
    assert.match(run?.error ?? "", /company was paused/);
    const requeued = platform.tasks.require(long.id);
    assert.equal(requeued.status, "todo", "the task is back in the queue");
    assert.equal(requeued.attempts, 0, "a kill switch does not burn an attempt");
    rootTask(t, t.agentByRole("frontend-engineer").id, "other");
    assert.equal(platform.scheduler.tick(), 0, "nothing starts while paused");
    // chat does not bypass the kill switch either
    const dm = platform.conversations.directMessage(t.agentByRole("content-writer"));
    const posted = platform.conversations.postHuman(dm.id, "ping");
    assert.equal(platform.runs.startMessageRun(posted), null);
    hold.open();
    platform.resumeCompany();
    await t.drain();
    assert.equal(platform.tasks.require(long.id).status, "done");
    assert.equal(platform.repos.tasks.list({ status: "done" }).length, 2);
    assert.ok(platform.conversations.messages(dm.id).some((m) => m.senderId !== "human"), "the queued chat message is answered after resume");
  } finally {
    await t.close();
  }
});

test("a chat message waits while the agent is busy and is answered when it frees up", async () => {
  const hold = gate();
  const t = await createTestApp({ reflex: async (ctx) => (ctx.input.trigger !== "message" ? (await hold.promise, done("task done")) : done("chat answer")) });
  try {
    const { platform } = t.app;
    const dev = t.agentByRole("backend-engineer");
    rootTask(t, dev.id, "busywork");
    platform.scheduler.tick();
    await waitFor("busy", () => platform.runs.isBusy(dev.id));
    const dm = platform.conversations.directMessage(dev);
    const posted = platform.conversations.postHuman(dm.id, "are you free?");
    assert.equal(platform.runs.startMessageRun(posted), null, "busy agent: the message queues");
    hold.open();
    await t.drain();
    const reply = platform.conversations.messages(dm.id).find((m) => m.senderId === dev.id);
    assert.equal(reply?.content, "chat answer");
  } finally {
    await t.close();
  }
});
