// 2026-11-07: after the Board removed an agent, the console still showed its thread like a live one,
// and only the tools checked that a sender was still employed. Then the founder asked whether removal
// is clean ("records, chat windows, agent id, everything") and chose "clean up, keep history": removal
// deletes the agent's chats and private memories and withdraws its pending requests; its record,
// runs, traces, spend and tasks stay so history and spending totals stay true.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompanyEvent } from "../../../../packages/shared/src/index.ts";
import type { ApprovalService } from "../../src/tasks/approvals.ts";
import { callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";

test("removing an agent deletes their chats and private memories, withdraws their requests, keeps their history", async () => {
  const seen: Record<string, { ok: boolean; content: string }> = {};
  const triggers: string[] = [];
  let ids = { cmo: "", gone: "" };
  let approvals: ApprovalService | null = null;
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.agent.id !== ids.cmo || ctx.input.trigger === "message") return done();
      triggers.push(ctx.input.trigger);
      if (ctx.input.task.title === "Check in with the SEO specialist") seen.send = await callTool(ctx, "send_message", { toAgentId: ids.gone, content: "Are you there?" });
      return done();
    },
    reflex: async (ctx) => {
      if (ctx.input.trigger !== "task" || ctx.agent.id !== ids.gone) return done();
      await callTool(ctx, "memory_write", { content: "Search Console access is pending.", kind: "episodic", scope: "agent" });
      await callTool(ctx, "memory_write", { content: "Launch keyword set is saved at launch-plan/seo-keywords.md.", kind: "episodic", scope: "global" });
      // A request still open for the Board (what Riley actually left: "approval to buy a keyword tool").
      const asked = approvals!.create({ kind: "question", requestedBy: ctx.agent.id, taskId: ctx.input.task.id, traceId: ctx.run.traceId, summary: "Riley Chen asks: may I buy a keyword tool?", payload: { question: "May I buy a keyword tool within the $10/month SEO budget?" } });
      return { outcome: "blocked", output: "Waiting for the Board.", approvalId: asked.id };
    },
  });
  try {
    const { platform } = t.app;
    approvals = platform.approvals;
    const events: CompanyEvent[] = [];
    platform.bus.subscribe((ev) => events.push(ev));
    const cmo = t.agentByRole("cmo");
    const gone = platform.org.createAgent({ title: "SEO Specialist", departmentId: cmo.departmentId, managerId: cmo.id, tier: "worker", name: "Riley Chen" }, "human");
    ids = { cmo: cmo.id, gone: gone.id };
    const humanDm = platform.conversations.directMessage(gone);
    platform.conversations.postHuman(humanDm.id, "Welcome aboard.");
    const agentDm = platform.conversations.sendAgentMessage(gone, cmo, "Keyword brief saved.").conversationId;
    const work = rootTask(t, gone.id, "SEO keyword brief");
    await t.drain();
    assert.equal(platform.tasks.get(work.id)!.status, "blocked");
    const asked = platform.approvals.list("pending").find((a) => a.requestedBy === gone.id)!;
    assert.ok(asked, "Riley asked the Board");
    const runsBefore = platform.repos.runs.list({ agentId: gone.id }).length;
    assert.ok(runsBefore > 0);

    const result = platform.org.destroyAgent(gone.id);

    assert.equal(result.deletedChats, 2, "the Board's DM and the DM with the manager");
    assert.equal(result.deletedMemories, 1, "the private memory; the company-wide one stays");
    assert.equal(result.withdrawnRequests, 1);
    assert.equal(platform.repos.conversations.get(humanDm.id), null);
    assert.equal(platform.repos.conversations.get(agentDm), null);
    assert.deepEqual(platform.conversations.list(gone.id), []);
    assert.equal(platform.repos.memories.recent({ agentId: gone.id, scopes: ["agent"], kinds: null }, 10).length, 0);
    assert.ok(platform.repos.memories.recent({ agentId: null, scopes: ["global"], kinds: null }, 50).some((m) => m.agentId === gone.id), "company knowledge they wrote stays");
    const withdrawn = platform.approvals.require(asked.id);
    assert.equal(withdrawn.status, "rejected");
    assert.equal(withdrawn.decidedBy, "system");
    assert.match(withdrawn.note ?? "", /^Withdrawn: Riley Chen was removed/);
    assert.equal(events.filter((e) => e.type === "conversation.deleted").length, 2);

    // History stays: the record (marked removed), runs and the task they worked on.
    assert.equal(platform.org.getAgent(gone.id)!.status, "terminated");
    assert.equal(platform.repos.runs.list({ agentId: gone.id }).length, runsBefore);
    const moved = platform.tasks.get(work.id)!;
    assert.equal(moved.assigneeId, cmo.id, "the work moved to the manager");

    // The manager wakes with the withdrawal instead of waiting on a request nobody will answer.
    await t.drain();
    assert.ok(triggers.includes("human_answer"), triggers.join(","));
    assert.equal(platform.tasks.get(work.id)!.status, "done");

    // Nothing can reach them, or speak as them.
    assert.throws(() => platform.conversations.sendAgentMessage(cmo, platform.org.getAgent(gone.id)!, "Hi"), /Riley Chen was removed and can no longer send or receive messages/);
    assert.throws(() => platform.conversations.directMessage(platform.org.getAgent(gone.id)!), /is terminated/);
    const boardroom = platform.conversations.boardroom()!;
    assert.throws(() => platform.conversations.postAs(boardroom.id, gone.id, "One more thing"), /Riley Chen was removed and can no longer send messages/);
    rootTask(t, cmo.id, "Check in with the SEO specialist");
    await t.drain();
    assert.equal(seen.send?.ok, false);
    assert.match(seen.send!.content, /^No single active agent matches/);
  } finally {
    await t.close();
  }
});

test("agents removed before the clean-up existed are cleaned up at boot, once", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const cmo = t.agentByRole("cmo");
    const old = platform.org.createAgent({ title: "Content Creator", departmentId: cmo.departmentId, managerId: cmo.id, tier: "worker", name: "Casey Diaz" }, "human");
    platform.conversations.postHuman(platform.conversations.directMessage(old).id, "Hello?");
    platform.memory.upsert({ scope: "agent", agentId: old.id, kind: "episodic", content: "Drafted the launch post.", tags: [], sourceRunId: null, sourceTaskId: null });
    // Removed the old way: marked terminated, nothing else touched (Riley and Casey, 2026-11-07).
    platform.repos.agents.update(old.id, { status: "terminated", terminatedAt: new Date().toISOString() });

    const first = platform.chats.cleanUpRemovedAgents();
    assert.deepEqual(first, { agents: 1, deletedChats: 2, deletedMemories: 1, withdrawnRequests: 0 }, "the Board's DM and the manager's welcome DM");
    assert.deepEqual(platform.conversations.list(old.id), []);
    assert.deepEqual(platform.chats.cleanUpRemovedAgents(), { agents: 0, deletedChats: 0, deletedMemories: 0, withdrawnRequests: 0 });
  } finally {
    await t.close();
  }
});
