import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineContext, EngineResult } from "../../src/contracts.ts";
import { callTool, createTestApp, done, rootTask, waitFor, gate } from "./helpers/harness.ts";

const triggersOf = (calls: EngineContext[], taskId: string) => calls.filter((c) => c.input.trigger !== "message" && c.input.task.id === taskId).map((c) => c.input.trigger);

test("task state machine: delegation waits, children finishing wakes the parent (CEO → CTO → engineer)", async () => {
  const t = await createTestApp({
    brain: async (ctx): Promise<EngineResult> => {
      const input = ctx.input;
      if (input.trigger === "task" && input.task.title.startsWith("Objective")) {
        const cto = ctx.platform.org.listActiveAgents().find((a) => a.roleId === "cto");
        const r = await callTool(ctx, "delegate_task", { assigneeId: cto?.id, title: "Build it", description: "Build the thing" });
        assert.ok(r.ok, r.content);
        return { outcome: "waiting", output: "delegated to the CTO" };
      }
      if (input.trigger === "task" && input.task.title === "Build it") {
        const dev = ctx.platform.org.listActiveAgents().find((a) => a.roleId === "backend-engineer");
        const r = await callTool(ctx, "delegate_task", { assigneeId: dev?.id, title: "Code it", description: "Write the code" });
        assert.ok(r.ok, r.content);
        return { outcome: "waiting", output: "delegated to engineering" };
      }
      return done(`evaluated ${input.trigger === "message" ? 0 : input.subtasks.length} subtask(s)`);
    },
  });
  try {
    const ceo = t.agentByRole("ceo");
    const { tasks } = t.app.platform;
    const objective = rootTask(t, ceo.id, "Objective: ship");
    await t.drain();

    const all = tasks.list({ rootTaskId: objective.id });
    assert.equal(all.length, 3);
    for (const task of all) assert.equal(task.status, "done", `${task.title} is ${task.status}`);
    assert.ok(all.every((x) => x.traceId === objective.traceId), "one objective is one trace");
    assert.deepEqual(triggersOf(t.brain.calls, objective.id), ["task", "subtasks_completed"]);
    assert.equal(tasks.require(objective.id).attempts, 1, "waking on subtasks does not count an attempt");
    assert.match(tasks.require(objective.id).result ?? "", /evaluated 1 subtask/);
    const sub = tasks.children(objective.id)[0];
    assert.equal(sub?.parentTaskId, objective.id);
    assert.equal(sub?.rootTaskId, objective.id);
  } finally {
    await t.close();
  }
});

test("a waiting task stays waiting while any child is open", async () => {
  const hold = gate();
  const t = await createTestApp({
    brain: async (ctx) => {
      const input = ctx.input;
      if (input.trigger === "task") {
        const dev = ctx.platform.org.listActiveAgents().find((a) => a.roleId === "backend-engineer");
        await callTool(ctx, "delegate_task", { assigneeId: dev?.id, title: "Slow one", description: "x" });
        return { outcome: "waiting", output: "waiting" };
      }
      return done("all children are in");
    },
    reflex: async () => {
      await hold.promise;
      return done("slow result");
    },
  });
  try {
    const cto = t.agentByRole("cto");
    const parent = rootTask(t, cto.id, "Parent");
    t.app.platform.scheduler.tick();
    await waitFor("parent waiting", () => t.app.platform.tasks.require(parent.id).status === "waiting");
    t.app.platform.scheduler.tick();
    await waitFor("child running", () => t.app.platform.tasks.children(parent.id)[0]?.status === "in_progress");
    assert.equal(t.app.platform.tasks.require(parent.id).status, "waiting");
    hold.open();
    await t.drain();
    assert.equal(t.app.platform.tasks.require(parent.id).status, "done");
  } finally {
    await t.close();
  }
});

test("failed runs retry, then fail the task and escalate to the manager", async () => {
  const t = await createTestApp({
    reflex: () => {
      throw new Error("model exploded");
    },
  });
  try {
    const dev = t.agentByRole("backend-engineer");
    const task = rootTask(t, dev.id, "Doomed");
    await t.drain();
    const final = t.app.platform.tasks.require(task.id);
    assert.equal(final.status, "failed");
    assert.equal(final.attempts, 2);
    assert.match(final.error ?? "", /model exploded/);
    const runs = t.app.platform.repos.runs.list({ taskId: task.id });
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.status === "failed" && r.failingSpanId));
    const manager = t.app.platform.org.getAgent(dev.managerId as string);
    const inbox = t.app.platform.memory.inbox(manager?.id as string);
    assert.ok(inbox.some((m) => /Escalation: .*Doomed.* failed after 2 attempt/.test(m.content)), "the manager got an escalation");
  } finally {
    await t.close();
  }
});

test("yielded keeps attempts, merges the checkpoint and re-runs", async () => {
  let runs = 0;
  const t = await createTestApp({
    brain: (ctx) => {
      runs += 1;
      if (ctx.input.trigger === "message") return done();
      if (runs === 1) return { outcome: "yielded", output: "making way for urgent work", taskState: { checkpoint: { step: 3 } } };
      assert.deepEqual(ctx.input.task.state.checkpoint, { step: 3 }, "the checkpoint survives the yield");
      return done("finished after the yield");
    },
  });
  try {
    const task = rootTask(t, t.agentByRole("cto").id, "Long job");
    t.app.platform.scheduler.tick();
    await t.app.platform.runs.idle();
    const yielded = t.app.platform.tasks.require(task.id);
    assert.equal(yielded.status, "todo");
    assert.equal(yielded.attempts, 0, "a yield does not consume an attempt");
    assert.deepEqual(yielded.state.checkpoint, { step: 3 });
    await t.drain();
    const final = t.app.platform.tasks.require(task.id);
    assert.equal(final.status, "done");
    assert.equal(final.attempts, 1);
    assert.equal(t.app.platform.repos.runs.list({ taskId: task.id }).length, 2);
  } finally {
    await t.close();
  }
});

test("reporting waiting twice without delegating fails the task instead of looping", async () => {
  const t = await createTestApp({ brain: () => ({ outcome: "waiting", output: "waiting for nobody" }) });
  try {
    const task = rootTask(t, t.agentByRole("cto").id, "Phantom wait");
    await t.drain();
    const final = t.app.platform.tasks.require(task.id);
    assert.equal(final.status, "failed");
    assert.match(final.error ?? "", /waiting twice without delegating/);
  } finally {
    await t.close();
  }
});

test("blocked on ask_human: the Board's answer wakes the task with trigger human_answer", async () => {
  const t = await createTestApp({
    brain: async (ctx) => {
      const input = ctx.input;
      if (input.trigger === "task") {
        const r = await callTool(ctx, "ask_human", { question: "Which market first?" });
        assert.ok(r.ok, r.content);
        return { outcome: "blocked", output: "asked the Board", approvalId: (r.data as { approvalId: string }).approvalId };
      }
      if (input.trigger === "human_answer") return done(`Board said: ${input.answeredApproval?.note}`);
      return done();
    },
  });
  try {
    const task = rootTask(t, t.agentByRole("cto").id, "Needs an answer");
    t.app.platform.scheduler.tick();
    await t.app.platform.runs.idle();
    assert.equal(t.app.platform.tasks.require(task.id).status, "blocked");
    const [approval] = t.app.platform.approvals.list("pending");
    assert.ok(approval);
    t.app.platform.approvals.decide(approval.id, { decision: "approved", note: "Europe" });
    assert.equal(t.app.platform.tasks.require(task.id).status, "todo");
    await t.drain();
    const final = t.app.platform.tasks.require(task.id);
    assert.equal(final.status, "done");
    assert.equal(final.result, "Board said: Europe");
    assert.equal(final.attempts, 1, "answering does not count an attempt");
  } finally {
    await t.close();
  }
});

test("cancelling a task aborts its running run", async () => {
  const hold = gate();
  const t = await createTestApp({ reflex: async () => (await hold.promise, done()) });
  try {
    const task = rootTask(t, t.agentByRole("backend-engineer").id, "Cancel me");
    t.app.platform.scheduler.tick();
    await waitFor("run active", () => t.app.platform.runs.activeCount() === 1);
    t.app.platform.tasks.cancel(task.id);
    await t.app.platform.runs.idle();
    const [run] = t.app.platform.repos.runs.list({ taskId: task.id });
    assert.equal(run?.status, "cancelled");
    assert.equal(t.app.platform.tasks.require(task.id).status, "cancelled");
    assert.equal(t.app.platform.repos.agents.get(task.assigneeId as string)?.currentRunId, null);
    hold.open();
  } finally {
    await t.close();
  }
});
