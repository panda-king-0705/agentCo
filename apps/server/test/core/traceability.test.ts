import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";

test("delegation is permission-checked against the reporting subtree", async () => {
  const results: Record<string, { ok: boolean; content: string }> = {};
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger === "message") return done();
      const org = ctx.platform.org;
      const find = (role: string) => org.listActiveAgents().find((a) => a.roleId === role)?.id;
      if (ctx.agent.roleId === "cto") {
        results.ownWorker = await callTool(ctx, "delegate_task", { assigneeId: find("backend-engineer"), title: "own worker", description: "ok" });
        results.otherDepartment = await callTool(ctx, "delegate_task", { assigneeId: find("content-writer"), title: "marketing's worker", description: "no" });
        results.peer = await callTool(ctx, "delegate_task", { assigneeId: find("cmo"), title: "a peer", description: "no" });
        results.boss = await callTool(ctx, "delegate_task", { assigneeId: find("ceo"), title: "the boss", description: "no" });
        results.self = await callTool(ctx, "delegate_task", { assigneeId: ctx.agent.id, title: "myself", description: "no" });
        return done("checked");
      }
      results.ceoAnyone = await callTool(ctx, "delegate_task", { assigneeId: find("content-writer"), title: "ceo reaches anyone", description: "yes" });
      return done("checked");
    },
    reflex: async (ctx) => {
      // workers have no delegate_task at all
      results.workerTool = await callTool(ctx, "delegate_task", { assigneeId: ctx.agent.id, title: "x", description: "y" });
      return done();
    },
  });
  try {
    rootTask(t, t.agentByRole("cto").id, "cto run");
    rootTask(t, t.agentByRole("ceo").id, "ceo run");
    await t.drain();
    assert.equal(results.ownWorker?.ok, true);
    for (const key of ["otherDepartment", "peer", "boss", "self"]) assert.equal(results[key]?.ok, false, `${key} must be refused: ${results[key]?.content}`);
    assert.match(results.otherDepartment?.content ?? "", /not in your reporting subtree/);
    assert.equal(results.ceoAnyone?.ok, true, "the CEO may delegate to anyone");
    assert.equal(results.workerTool?.ok, false);
    assert.match(results.workerTool?.content ?? "", /not available/);
  } finally {
    await t.close();
  }
});

test("span parentage: one traceId across agents, run span hangs under the delegation span", async () => {
  const t = await createTestApp({
    brain: async (ctx) => {
      const input = ctx.input;
      if (input.trigger === "task" && ctx.agent.roleId === "ceo") {
        const cto = ctx.platform.org.listActiveAgents().find((a) => a.roleId === "cto");
        await callTool(ctx, "delegate_task", { assigneeId: cto?.id, title: "Engineering plan", description: "plan" });
        return { outcome: "waiting", output: "delegated" };
      }
      if (input.trigger === "task") {
        const dev = ctx.platform.org.listActiveAgents().find((a) => a.roleId === "backend-engineer");
        await callTool(ctx, "delegate_task", { assigneeId: dev?.id, title: "Implement", description: "code" });
        return { outcome: "waiting", output: "delegated" };
      }
      return done("evaluated");
    },
  });
  try {
    const objective = rootTask(t, t.agentByRole("ceo").id, "Launch");
    await t.drain();
    const spans = t.app.platform.repos.spans.byTrace(objective.traceId);
    const byId = new Map(spans.map((s) => [s.id, s]));
    assert.ok(spans.every((s) => s.traceId === objective.traceId));
    assert.ok(new Set(spans.map((s) => s.agentId).filter(Boolean)).size >= 3, "CEO, CTO and an engineer are in one trace");
    for (const s of spans) if (s.parentSpanId) assert.ok(byId.has(s.parentSpanId), `${s.name} has its parent in the trace`);
    assert.ok(spans.every((s) => s.status !== "running"), "no span is left running");

    const objectiveSpan = spans.find((s) => s.kind === "objective");
    assert.ok(objectiveSpan);
    assert.equal(objectiveSpan.parentSpanId, null);
    const ceoRun = spans.find((s) => s.kind === "run" && s.agentId === t.agentByRole("ceo").id);
    assert.equal(ceoRun?.parentSpanId, objectiveSpan.id, "root task's first run hangs under the objective span");

    const delegations = spans.filter((s) => s.kind === "delegation");
    assert.equal(delegations.length, 2);
    for (const d of delegations) {
      assert.equal(byId.get(d.parentSpanId as string)?.kind, "tool", "delegation hangs under the delegate_task tool span");
      assert.equal(byId.get(d.parentSpanId as string)?.name, "tool.delegate_task");
      const taskId = d.attributes["agentco.task.id"];
      const childRun = spans.find((s) => s.kind === "run" && s.taskId === taskId && s.parentSpanId === d.id);
      assert.ok(childRun, "the delegate's run span has the delegation span as its parent");
      assert.equal(t.app.platform.tasks.require(taskId as string).state.delegationSpanId, d.id);
    }
    // the first tool span sits under the delegating agent's run span
    const tool = spans.find((s) => s.name === "tool.delegate_task");
    assert.equal(byId.get(tool?.parentSpanId as string)?.kind, "run");
    // the objective span closed with the task
    assert.equal(objectiveSpan.status, "ok");
  } finally {
    await t.close();
  }
});

test("a Board chat message starts a new trace: objective span → run span; a spawned objective joins the same trace", async () => {
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger === "message") {
        const task = ctx.platform.tasks.createObjective({
          title: "Write the plan", description: ctx.input.message.content, assigneeId: ctx.agent.id, createdBy: ctx.agent.id,
          traceId: ctx.run.traceId, parentSpanId: ctx.span.spanId, originConversationId: ctx.input.message.conversationId,
        });
        return done(`Opened T-${task.number}`);
      }
      return done("The finished plan: a long enough report for the Board to read.");
    },
  });
  try {
    const { platform } = t.app;
    const boardroom = platform.conversations.boardroom();
    assert.ok(boardroom);
    const message = platform.conversations.postHuman(boardroom.id, "Please plan the launch");
    await t.drain();
    const messages = platform.conversations.messages(boardroom.id);
    const chatRunRow = platform.repos.runs.list({}).find((r) => r.trigger === "message");
    const task = platform.repos.tasks.list({ traceId: chatRunRow?.traceId })[0];
    assert.ok(task);
    const runMessage = messages.find((m) => m.senderId !== "human");
    assert.match(runMessage?.content ?? "", /Opened T-/);
    const spans = platform.repos.spans.byTrace(task.traceId);
    const root = spans.find((s) => s.parentSpanId === null);
    assert.equal(root?.kind, "objective");
    assert.match(root?.name ?? "", /^chat: Please plan the launch/);
    const chatRun = spans.find((s) => s.kind === "run" && s.parentSpanId === root?.id);
    assert.ok(chatRun, "the chat run hangs under the chat objective");
    const taskObjective = spans.find((s) => s.kind === "objective" && s.id !== root?.id);
    assert.equal(taskObjective?.parentSpanId, chatRun.id, "the spawned objective hangs under the chat run");
    assert.ok(spans.every((s) => s.status !== "running"), "all spans closed once the objective finished");
    // the final report landed in the Boardroom, attributed to the assignee and the task
    const report = messages.find((m) => m.taskId === task.id);
    assert.match(report?.content ?? "", /finished plan/);
    assert.equal(report?.senderId, task.assigneeId);
    assert.equal(message.senderId, "human");
  } finally {
    await t.close();
  }
});
