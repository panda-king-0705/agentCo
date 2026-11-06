// Regressions from the first live run (2026-11-06): the spend tiles, and the question loop —
// Board questions piling up per escalation, chat replies that answered nothing, cancelled work
// leaving questions behind, and frustration that stopped every new task.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Approval, CompanySnapshot, PostMessageResult, Task } from "../../../../packages/shared/src/index.ts";
import type { EngineResult } from "../../src/contracts.ts";
import { newTraceId } from "../../src/db/ids.ts";
import { ensureBoardroom } from "../../src/org/bootstrap.ts";
import { decayFrustration, updateAffect } from "../../src/cognition/brain/self-management/human-nature.ts";
import { operatingRules } from "../../src/cognition/brain/self-management/identity.ts";
import { api, callTool, createTestApp, done, rootTask, type EngineScript } from "./helpers/harness.ts";

/** Asks the Board on its first run; finishes with the Board's note when resumed. */
const askThenFinish: EngineScript = async (ctx) => {
  if (ctx.input.trigger === "human_answer") return done(`Proceeding with: ${ctx.input.answeredApproval?.note ?? "(none)"}`);
  if (ctx.input.trigger !== "task") return done("hi");
  const r = await callTool(ctx, "ask_human", { question: `What should I do about ${ctx.input.task.title}?` });
  const asked = r.effects.find((e) => e.kind === "approval_requested") as { approvalId: string } | undefined;
  return { outcome: "blocked", output: "asked the Board", ...(asked ? { approvalId: asked.approvalId } : {}) } satisfies EngineResult;
};

test("one open Board question per objective: a second task asking under the same objective waits on the same question", async () => {
  const t = await createTestApp({ brain: askThenFinish });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const cfo = t.agentByRole("cfo");
    const root = rootTask(t, ceo.id, "Set custodian ID");
    const child = platform.tasks.createSubtask({ parent: root, title: "Check the custodian", description: "d", assigneeId: cfo.id, traceId: root.traceId, createdBy: ceo.id });
    await t.drain();
    const pending = platform.approvals.list("pending").filter((a) => a.kind === "question");
    assert.equal(pending.length, 1, "one question in the Board's queue");
    assert.equal(pending[0]!.payload.rootTaskId, root.id);
    for (const id of [root.id, child.id]) {
      const task = platform.tasks.require(id);
      assert.equal(task.status, "blocked", id);
      assert.equal(task.state.blockedOnApprovalId, pending[0]!.id, "both wait on the same question");
    }
    platform.approvals.decide(pending[0]!.id, { decision: "approved", note: "Use U123." });
    await t.drain();
    assert.match(platform.tasks.require(child.id).result ?? "", /Use U123\./, "the one answer wakes both");
  } finally {
    await t.close();
  }
});

test("chat: a question raised under a Boardroom objective is posted there, and the Board's reply there answers it", async () => {
  const t = await createTestApp({ brain: askThenFinish, listen: true });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const boardroom = ensureBoardroom(platform.repos, platform.org, platform.services.now);
    const task = platform.tasks.createObjective({ traceId: newTraceId(), assigneeId: ceo.id, createdBy: "human", title: "Set custodian ID", description: "Set it.", originConversationId: boardroom.id });
    await t.drain();
    const [question] = platform.approvals.list("pending");
    assert.ok(question && question.kind === "question");
    assert.equal(question.payload.conversationId, boardroom.id);
    const posted = platform.conversations.messages(boardroom.id);
    assert.ok(posted.some((m) => m.senderId === ceo.id && /Question for the Board on T-\d+/.test(m.content) && /Reply here/.test(m.content)), "the question is posted in the Boardroom");

    const reply = await api<PostMessageResult>(t.url, `/api/conversations/${boardroom.id}/messages`, { method: "POST", body: { content: "My custodian ID is U2522199H." } });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.answeredApprovalIds, [question.id]);
    assert.equal(reply.body.runId, null, "no new chat run: the blocked task resumes instead");
    assert.equal(platform.approvals.require(question.id).status, "approved");
    assert.equal(platform.approvals.require(question.id).note, "My custodian ID is U2522199H.");
    await t.drain();
    const after = platform.tasks.require(task.id);
    assert.equal(after.status, "done");
    assert.match(after.result ?? "", /U2522199H/);
    assert.ok(platform.conversations.messages(boardroom.id).some((m) => m.senderId === "system" && /answer to 1 open question \(T-\d+\)/.test(m.content)));

    // With no open question left, the next message is an ordinary chat run again.
    const next = await api<PostMessageResult>(t.url, `/api/conversations/${boardroom.id}/messages`, { method: "POST", body: { content: "Thanks!" } });
    assert.equal(next.body.answeredApprovalIds, undefined);
  } finally {
    await t.close();
  }
});

test("cancelling a stuck objective closes its open approvals; decide-many triages the rest; reset-mood clears frustration", async () => {
  const t = await createTestApp({ brain: askThenFinish, listen: true });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const stuck = rootTask(t, ceo.id, "Runaway objective");
    const a = rootTask(t, ceo.id, "Objective A");
    const b = rootTask(t, ceo.id, "Objective B");
    await t.drain();
    assert.equal(platform.approvals.list("pending").length, 3);

    const cancelled = await api<Task>(t.url, `/api/tasks/${stuck.id}/cancel`, { method: "POST" });
    assert.equal(cancelled.body.status, "cancelled");
    const closed = platform.approvals.list().find((x) => x.taskId === stuck.id)!;
    assert.equal(closed.status, "rejected");
    assert.equal(closed.decidedBy, "system");
    assert.match(closed.note ?? "", /was cancelled/);

    const bad = await api<unknown>(t.url, "/api/approvals/decide-many", { method: "POST", body: { decision: "approved", kind: "question" } });
    assert.equal(bad.status, 400, "answering questions needs a note");
    const triaged = await api<Approval[]>(t.url, "/api/approvals/decide-many", { method: "POST", body: { decision: "approved", kind: "question", note: "Go ahead." } });
    assert.equal(triaged.body.length, 2);
    await t.drain();
    for (const id of [a.id, b.id]) assert.equal(platform.tasks.require(id).status, "done", id);
    assert.equal(platform.approvals.list("pending").length, 0);

    platform.org.updateCognitiveState(ceo.id, { affect: { valence: -0.6, arousal: 0.5, frustration: 1 } });
    const reset = await api<{ reset: number }>(t.url, "/api/company/reset-mood", { method: "POST" });
    assert.ok(reset.body.reset >= 1);
    const calm = platform.org.requireAgent(ceo.id).affect;
    assert.equal(calm.frustration, 0);
    assert.equal(calm.valence, 0);
  } finally {
    await t.close();
  }
});

test("company snapshot reports today's and this month's spend", async () => {
  const t = await createTestApp({ listen: true });
  try {
    const { platform } = t.app;
    const cfo = t.agentByRole("cfo");
    const at = platform.services.now().toISOString();
    platform.repos.spend.insert({
      agentId: cfo.id, departmentId: cfo.departmentId, runId: null, traceId: null, spanId: null, taskId: null, provider: "anthropic", model: "m", profileId: "p",
      tier: "standard", stage: "reflex", inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.25, frontierCostUsd: 0.5, at,
    } as never);
    const snap = (await api<CompanySnapshot>(t.url, "/api/company")).body;
    assert.equal(snap.spentTodayUsd, 0.25);
    assert.equal(snap.spentMonthUsd, 0.25);
  } finally {
    await t.close();
  }
});

test("frustration relaxes on every report and over idle time", () => {
  assert.ok(decayFrustration(1) < 1);
  assert.ok(Math.abs(decayFrustration(1, 2 * 3_600_000) - 0.45) < 1e-9, "one half-life of idle time halves it (after the per-report decay)");
  const after = updateAffect({ valence: -0.5, arousal: 0.4, frustration: 1 }, [], { openItems: 0, consecutiveRuns: 1, idleMs: 4 * 3_600_000 });
  assert.ok(after.frustration <= 0.7, "a few idle hours lift the frustration gate");
});

test("charter grounding names the company's own stores and when to ask the Board", () => {
  const rules = operatingRules(["memory_write", "memory_search", "blackboard_read", "workspace_write_file", "ask_human"]);
  assert.match(rules, /knowledge base/);
  assert.match(rules, /blackboard/);
  assert.match(rules, /do not ask which system/);
  assert.match(rules, /irreversible/);
  assert.equal(operatingRules(["send_message"]), "");
});

test("budget windows start at local midnight of TZ (a Singapore morning is today, not yesterday)", async () => {
  const { dayStart, localDay, monthStart } = await import("../../src/middleware/budget.ts");
  const saved = process.env.TZ;
  try {
    process.env.TZ = "Asia/Singapore";
    const morning = new Date("2026-11-05T22:00:00.000Z"); // 06:00 on 6 Nov in Singapore
    assert.equal(dayStart(morning), "2026-11-05T16:00:00.000Z");
    assert.equal(monthStart(morning), "2026-10-31T16:00:00.000Z");
    assert.equal(localDay(morning), "2026-11-06");
    process.env.TZ = "UTC";
    assert.equal(dayStart(morning), "2026-11-05T00:00:00.000Z");
    assert.equal(monthStart(morning), "2026-11-01T00:00:00.000Z");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("memory_write within one task upserts: the same scope, kind and tags replace the earlier entry (no duplicates)", async () => {
  const t = await createTestApp({});
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const task = rootTask(t, ceo.id, "Record custodian ID");
    const base = { scope: "global" as const, agentId: ceo.id, kind: "semantic" as const, tags: ["custodian-id", "board"], sourceTaskId: task.id, upsertWithinTask: true };
    const first = platform.memory.upsert({ ...base, content: "Board custodian ID: U2522199H (first wording)." });
    const second = platform.memory.upsert({ ...base, tags: ["board", "custodian-id"], content: "Board custodian ID: U2522199H (second wording)." });
    assert.equal(first.updated, false);
    assert.equal(second.updated, true);
    assert.equal(second.item.id, first.item.id, "same entry");
    const hits = platform.memory.search({ query: "custodian U2522199H", agentId: ceo.id, scopes: ["global"], limit: 10 });
    assert.equal(hits.filter((m) => /U2522199H/.test(m.content)).length, 1, "one entry, and search finds the new wording");
    assert.match(hits[0]!.content, /second wording/);
    // Other tags, or another task, are different facts: stored separately.
    const other = platform.memory.upsert({ ...base, tags: ["custodian-id"], content: "Custodian ID format note." });
    assert.equal(other.updated, false);
    const plain = platform.memory.write({ ...base, upsertWithinTask: false, content: "Board custodian ID: U2522199H (explicit second copy)." });
    assert.notEqual(plain.id, first.item.id, "write() without upsert keeps appending (episodes, reports)");
  } finally {
    await t.close();
  }
});

test("budget pressure compares each cap with ITS OWN limit (a $6-left day is not '10% of a $60 month')", async () => {
  const { constraintPressure } = await import("../../src/cognition/brain/metacognition/monitoring.ts");
  const t = await createTestApp({});
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    platform.repos.agents.update(ceo.id, { monthlyBudgetUsd: 60 });
    platform.company.update({ dailyBudgetUsd: 10, monthlyBudgetUsd: 100 });
    const spend = (usd: number) =>
      platform.repos.spend.insert({
        agentId: ceo.id, departmentId: ceo.departmentId, runId: null, traceId: null, spanId: null, taskId: null, provider: "anthropic", model: "m", profileId: "p",
        tier: "frontier", stage: "reflex", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: usd, frontierCostUsd: usd, at: platform.services.now().toISOString(),
      } as never);
    spend(4);
    const h = platform.org.budgetHeadroom(ceo.id);
    assert.equal(h.label, "company daily budget");
    assert.ok(Math.abs(h.share - 0.6) < 1e-9);
    const base = { maxContextShare: 0, elapsedMs: 0, runTimeoutMs: 300_000, monthlyBudgetUsd: 60, budgetRemainingUsd: platform.org.budgetRemainingUsd(ceo.id) };
    assert.equal(constraintPressure({ ...base, budgetHeadroom: h }).length, 0, "60% of today's company budget left: no pressure");
    assert.equal(constraintPressure(base).length, 1, "the old ratio ($6 / $60 monthly) cried wolf");
    spend(5);
    const tight = platform.org.budgetHeadroom(ceo.id);
    const p = constraintPressure({ ...base, budgetHeadroom: tight });
    assert.equal(p.length, 1);
    assert.match(p[0]!.symptom, /^company daily budget: 10% left$/);
    assert.equal(platform.org.agentMonthlyLeftUsd(ceo.id), 51);
  } finally {
    await t.close();
  }
});
