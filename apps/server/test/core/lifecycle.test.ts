import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, createTestApp, done, gate, rootTask, waitFor } from "./helpers/harness.ts";

test("destroying an agent aborts its run, re-assigns tasks and reports to the manager, keeps the row for audit", async () => {
  const hold = gate();
  const t = await createTestApp({ reflex: async () => (await hold.promise, done("never delivered")) });
  try {
    const { platform } = t.app;
    const cto = t.agentByRole("cto");
    const manager = platform.org.getAgent(t.agentByRole("backend-engineer").managerId as string);
    assert.equal(manager?.id, cto.id);
    // a manager-ish agent with reports and tasks: hire a lead under the CTO, give it a report and two tasks
    const lead = platform.org.createAgent({ title: "Platform Lead", departmentId: cto.departmentId, managerId: cto.id, tier: "manager" }, "human");
    const intern = platform.org.createAgent({ title: "Intern", departmentId: cto.departmentId, managerId: lead.id, tier: "worker", cognition: "reflex" }, "human");
    const running = rootTask(t, lead.id, "in flight");
    const queued = rootTask(t, lead.id, "queued behind it");
    platform.repos.agents.update(lead.id, { cognition: "reflex" }); // so the held reflex engine runs it
    platform.scheduler.tick();
    await waitFor("lead busy", () => platform.runs.isBusy(lead.id));

    const result = platform.org.destroyAgent(lead.id);
    assert.deepEqual({ ...result }, { agentId: lead.id, cancelledRuns: 1, reassignedTasks: 2, reassignedReports: 1 });
    await platform.runs.idle();

    const gone = platform.org.getAgent(lead.id);
    assert.equal(gone?.status, "terminated");
    assert.ok(gone?.terminatedAt);
    assert.equal(platform.org.getAgent(intern.id)?.managerId, cto.id, "the report moved to the manager");
    for (const id of [running.id, queued.id]) {
      const task = platform.tasks.require(id);
      assert.equal(task.assigneeId, cto.id);
      assert.equal(task.status, "todo");
    }
    const [run] = platform.repos.runs.list({ agentId: lead.id });
    assert.equal(run?.status, "cancelled");
    assert.match(run?.error ?? "", /terminated/);
    assert.ok(platform.org.listActiveAgents().every((a) => a.id !== lead.id));
    assert.throws(() => platform.org.destroyAgent(lead.id), /already terminated/);
    hold.open();
  } finally {
    await t.close();
  }
});

test("the CEO cannot be destroyed while it has reports (409), and delegating to a terminated agent is refused", async () => {
  const outcome: { content?: string; ok?: boolean } = {};
  let deadId = "agt_unknown";
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger === "message") return done();
      const r = await callTool(ctx, "delegate_task", { assigneeId: deadId, title: "x", description: "y" });
      Object.assign(outcome, r);
      return done();
    },
  });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    assert.throws(
      () => platform.org.destroyAgent(ceo.id),
      (error: { status?: number }) => error.status === 409,
    );
    const worker = t.agentByRole("content-writer");
    platform.org.destroyAgent(worker.id);
    deadId = worker.id;
    const r = await (async () => {
      rootTask(t, ceo.id, "delegate to a dead agent");
      await t.drain();
      return outcome;
    })();
    assert.equal(r.ok, false);
    assert.match(r.content ?? "", /No single active agent matches/);
    assert.throws(() => platform.tasks.createRoot({ title: "t", description: "d", assigneeId: worker.id }), /terminated/);
  } finally {
    await t.close();
  }
});

test("pausing an agent aborts its run and returns the task to the queue without burning an attempt", async () => {
  const hold = gate();
  const t = await createTestApp({ reflex: async () => (await hold.promise, done()) });
  try {
    const { platform } = t.app;
    const dev = t.agentByRole("backend-engineer");
    const task = rootTask(t, dev.id, "pausable");
    platform.scheduler.tick();
    await waitFor("busy", () => platform.runs.isBusy(dev.id));
    const paused = platform.org.pauseAgent(dev.id);
    assert.equal(paused.status, "paused");
    await platform.runs.idle();
    assert.equal(platform.tasks.require(task.id).status, "todo");
    assert.equal(platform.tasks.require(task.id).attempts, 0);
    assert.equal(platform.org.getAgent(dev.id)?.status, "paused", "the finishing run does not un-pause the agent");
    hold.open();
  } finally {
    await t.close();
  }
});
