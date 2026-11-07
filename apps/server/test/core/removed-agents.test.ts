// 2026-11-07: after the Board removed an agent, the console still showed its thread like a live one,
// and only the tools checked that a sender was still employed. Now nothing can post as a removed
// agent, nobody can open or write in a DM with one, and the console marks the thread closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";

test("a removed agent can neither send nor receive; its threads are kept, closed", async () => {
  const seen: Record<string, { ok: boolean; content: string }> = {};
  let ids = { cmo: "", gone: "" };
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger === "task" && ctx.agent.id === ids.cmo) seen.send = await callTool(ctx, "send_message", { toAgentId: ids.gone, content: "Are you there?" });
      return done();
    },
  });
  try {
    const { platform } = t.app;
    const cmo = t.agentByRole("cmo");
    const gone = platform.org.createAgent({ title: "SEO Specialist", departmentId: cmo.departmentId, managerId: cmo.id, tier: "worker", name: "Riley Chen" }, "human");
    ids = { cmo: cmo.id, gone: gone.id };
    const humanDm = platform.conversations.directMessage(gone);
    const agentDm = platform.conversations.sendAgentMessage(gone, cmo, "Keyword brief saved.").conversationId;
    const before = platform.conversations.messages(agentDm).length; // the manager's welcome + this one

    platform.org.destroyAgent(gone.id);

    assert.throws(() => platform.conversations.postAs(agentDm, gone.id, "One more thing"), /Riley Chen was removed and can no longer send messages/);
    assert.throws(() => platform.conversations.sendAgentMessage(cmo, platform.org.getAgent(gone.id)!, "Hi"), /Riley Chen was removed and can no longer send or receive messages/);
    assert.throws(() => platform.conversations.postHuman(humanDm.id, "Hello?"), /Riley Chen was removed; this conversation is kept for the record and cannot receive new messages/);
    assert.throws(() => platform.conversations.directMessage(platform.org.getAgent(gone.id)!), /is terminated/);
    assert.equal(platform.conversations.messages(agentDm).length, before, "the history is kept, nothing added");

    rootTask(t, cmo.id, "Check in with the SEO specialist");
    await t.drain();
    assert.equal(seen.send?.ok, false);
    assert.match(seen.send!.content, /^No single active agent matches/);
  } finally {
    await t.close();
  }
});
