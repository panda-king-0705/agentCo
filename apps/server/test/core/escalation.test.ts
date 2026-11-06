import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";

test("escalate: a worker's escalation becomes a subtask for its manager; the answer wakes the worker", async () => {
  let effects: { kind: string }[] = [];
  const triggers: string[] = [];
  const t = await createTestApp({
    reflex: async (ctx) => {
      triggers.push(ctx.input.trigger);
      if (ctx.input.trigger === "subtasks_completed") {
        const esc = ctx.input.subtasks.find((s) => s.state.kind === "escalation");
        return done(`Proceeded with: ${esc?.result}`);
      }
      const r = await callTool(ctx, "escalate", { reason: "unclear scope", question: "Which API version?" });
      effects = r.effects;
      return { outcome: "waiting", output: "waiting for my manager" };
    },
    brain: async (ctx) => done(ctx.input.trigger === "message" ? "hi" : "Use API v2."),
  });
  try {
    const { platform } = t.app;
    const worker = t.agentByRole("backend-engineer");
    const task = rootTask(t, worker.id, "Build the endpoint");
    await t.drain();

    assert.deepEqual(effects.map((e) => e.kind).sort(), ["message_sent", "task_created"]);
    const [esc] = platform.tasks.children(task.id);
    assert.ok(esc, "escalation subtask exists");
    assert.equal(esc.assigneeId, worker.managerId);
    assert.equal(esc.value, 900);
    assert.equal(esc.state.kind, "escalation");
    assert.equal(esc.state.escalatedBy, worker.id);
    assert.equal(esc.status, "done");
    assert.equal(esc.result, "Use API v2.");
    assert.deepEqual(triggers, ["task", "subtasks_completed"]);
    const after = platform.tasks.require(task.id);
    assert.equal(after.status, "done");
    assert.match(after.result ?? "", /Use API v2\./);
    const spans = platform.repos.spans.byTrace(task.traceId);
    assert.ok(spans.some((s) => s.kind === "delegation" && /escalate/.test(s.name)), "escalation has a delegation span");
  } finally {
    await t.close();
  }
});

test("escalate: the CEO (no manager) asks the Board with a question approval instead", async () => {
  let effects: { kind: string }[] = [];
  const t = await createTestApp({
    brain: async (ctx) => {
      const r = await callTool(ctx, "escalate", { reason: "needs the Board", question: "Approve the pivot?" });
      effects = r.effects;
      return done();
    },
  });
  try {
    const ceo = t.agentByRole("ceo");
    const task = rootTask(t, ceo.id, "Decide strategy");
    await t.drain();
    assert.ok(effects.some((e) => e.kind === "approval_requested"));
    assert.equal(t.app.platform.tasks.children(task.id).length, 0);
  } finally {
    await t.close();
  }
});

test("TaskView.cancel cascades to open subtasks and is a no-op on terminal tasks", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const cto = t.agentByRole("cto");
    const parent = rootTask(t, cto.id, "parent");
    const open = platform.tasks.createSubtask({ parent, title: "open child", description: "d", assigneeId: cto.id, traceId: parent.traceId, createdBy: cto.id });
    const finished = platform.tasks.createSubtask({ parent, title: "finished child", description: "d", assigneeId: cto.id, traceId: parent.traceId, createdBy: cto.id });
    platform.tasks.cancel(finished.id, "pre-cancelled");
    const grand = platform.tasks.createSubtask({ parent: open, title: "grandchild", description: "d", assigneeId: cto.id, traceId: parent.traceId, createdBy: cto.id });

    const result = platform.tasks.cancel(parent.id, "rolled back");
    assert.equal(result.status, "cancelled");
    for (const id of [open.id, grand.id]) assert.equal(platform.tasks.require(id).status, "cancelled", id);
    assert.equal(platform.tasks.require(finished.id).error, "pre-cancelled", "terminal child untouched");
    assert.match(platform.tasks.require(open.id).error ?? "", /was cancelled/);

    const again = platform.tasks.cancel(parent.id, "second time");
    assert.equal(again.status, "cancelled");
    assert.equal(again.error, "rolled back", "no-op on terminal tasks");
  } finally {
    await t.close();
  }
});

test("updateCognitiveState persists assets and resourceConnections", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const cto = t.agentByRole("cto");
    platform.org.updateCognitiveState(cto.id, { assets: ["design docs"], resourceConnections: ["Finance team"] });
    const reloaded = platform.org.getAgent(cto.id)!;
    assert.deepEqual(reloaded.identity.assets, ["design docs"]);
    assert.deepEqual(reloaded.identity.resourceConnections, ["Finance team"]);
    platform.org.updateCognitiveState(cto.id, { narrative: "only narrative" });
    assert.deepEqual(platform.org.getAgent(cto.id)!.identity.assets, ["design docs"], "omitted fields are left alone");
  } finally {
    await t.close();
  }
});

test("escalate: the escalation carries the stuck task's own text and the original request (nothing is lost on the way up)", async () => {
  const t = await createTestApp({
    reflex: async (ctx) => {
      if (ctx.input.trigger === "subtasks_completed") return done("ok");
      await callTool(ctx, "escalate", { reason: "write access unclear", question: "Where do I store it?" });
      return { outcome: "waiting", output: "waiting for my manager" };
    },
    brain: async () => done("Store it in the knowledge base."),
  });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const worker = t.agentByRole("backend-engineer");
    const root = platform.tasks.createRoot({ title: "Record custodian ID", description: "Board: record my custodian ID U2522199H in the company knowledge base.", assigneeId: ceo.id });
    const sub = platform.tasks.createSubtask({
      parent: root, title: "Persist the ID", description: "Save custodian ID U2522199H as a global semantic memory and confirm.", acceptanceCriteria: "Memory id returned",
      assigneeId: worker.id, traceId: root.traceId, createdBy: ceo.id,
    });
    await t.drain();
    const esc = platform.tasks.children(sub.id).find((c) => c.state.kind === "escalation");
    assert.ok(esc, "escalation subtask exists");
    assert.match(esc.description, /What T-\d+ asks \(as assigned to [^)]+\):\nSave custodian ID U2522199H/);
    assert.match(esc.description, /Acceptance criteria: Memory id returned/);
    assert.match(esc.description, /Original request T-\d+ "Record custodian ID":\nBoard: record my custodian ID U2522199H/);
    assert.match(esc.description, /Why: write access unclear/);
  } finally {
    await t.close();
  }
});

test("ask_human: the Board's question shows what the objective is about (payload.context)", async () => {
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger !== "task") return done("hi");
      await callTool(ctx, "ask_human", { question: "Which market first?" });
      return done();
    },
  });
  try {
    const ceo = t.agentByRole("ceo");
    rootTask(t, ceo.id, "Pick a launch market");
    await t.drain();
    const [q] = t.app.platform.approvals.list("pending");
    assert.ok(q);
    assert.match(String(q.payload.context), /^On T-\d+ "Pick a launch market": Description of Pick a launch market/);
  } finally {
    await t.close();
  }
});
