// 2026-11-07: the founder asked for a way to delete chat windows. A deleted chat is gone for good —
// messages, the agent's private notes from it and the context summary it would otherwise be shown
// again — while work it started keeps going. The Boardroom is cleared instead of deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeleteConversationResult, Message, PostMessageResult } from "../../../../packages/shared/src/index.ts";
import { api, callTool, createTestApp, done, gate, waitFor } from "./helpers/harness.ts";

test("deleting a chat removes it for good; the objective it started keeps going", async () => {
  const hold = gate();
  let ids = { cmo: "" };
  let objectiveId = "";
  const t = await createTestApp({
    listen: true,
    brain: async (ctx) => {
      if (ctx.agent.id !== ids.cmo) return done();
      if (ctx.input.trigger === "message") {
        await callTool(ctx, "memory_write", { content: "The Board wants the launch plan by Friday.", kind: "episodic", scope: "agent" });
        await callTool(ctx, "memory_write", { content: "Launch is planned for Q1.", kind: "semantic", scope: "global" });
        objectiveId = ctx.platform.tasks.createObjective({
          title: "Launch plan",
          description: "Draft the launch plan.",
          assigneeId: ctx.agent.id,
          createdBy: ctx.agent.id,
          traceId: ctx.run.traceId,
          originConversationId: ctx.run.conversationId,
        }).id;
        return done("On it: T-1 started.");
      }
      await hold.promise;
      return done("Launch plan saved at launch-plan/plan.md.");
    },
  });
  try {
    const { platform } = t.app;
    const cmo = t.agentByRole("cmo");
    ids = { cmo: cmo.id };
    const dm = platform.conversations.directMessage(cmo);
    const posted = await api<PostMessageResult>(t.url, `/api/conversations/${dm.id}/messages`, { method: "POST", body: { content: "Can you draft the launch plan?" } });
    assert.equal(posted.status, 200);
    await waitFor("the reply is posted", () => platform.conversations.messages(dm.id).length >= 2);
    platform.scheduler.tick();
    await waitFor("the objective is running", () => objectiveId && platform.tasks.get(objectiveId)?.status === "in_progress");
    // The context checkpoint and folded transcript a long chat leaves behind.
    platform.repos.settings.set(`compaction:${dm.id}`, { version: 1, throughIndex: 1, summary: "The Board asked for a launch plan." });
    mkdirSync(join(t.dataDir, "artifacts", dm.id), { recursive: true });
    writeFileSync(join(t.dataDir, "artifacts", dm.id, "transcript_v1.md"), "# Transcript");
    const messages = platform.conversations.messages(dm.id).length;
    assert.ok(messages >= 2);

    const res = await api<DeleteConversationResult>(t.url, `/api/conversations/${dm.id}`, { method: "DELETE" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { conversationId: dm.id, cleared: false, deletedMessages: messages, deletedMemories: 1, abortedRuns: 0 });
    assert.equal(platform.repos.conversations.get(dm.id), null);
    assert.equal(platform.repos.conversations.messages(dm.id).length, 0);
    assert.equal(platform.repos.memories.recent({ agentId: cmo.id, scopes: ["agent"], kinds: null }, 10).length, 0, "the agent's note from the chat");
    assert.ok(platform.repos.memories.recent({ agentId: null, scopes: ["global"], kinds: null }, 50).some((m) => m.content === "Launch is planned for Q1."), "company knowledge stays");
    assert.equal(platform.repos.settings.has(`compaction:${dm.id}`), false);
    assert.equal(existsSync(join(t.dataDir, "artifacts", dm.id)), false);
    assert.equal(platform.tasks.get(objectiveId)!.originConversationId, null);

    hold.open();
    await t.drain();
    assert.equal(platform.tasks.get(objectiveId)!.status, "done", "the work went on");
    assert.equal(platform.repos.conversations.get(dm.id), null, "its report did not bring the chat back");
    const fresh = platform.conversations.directMessage(cmo);
    assert.notEqual(fresh.id, dm.id);
    assert.equal(platform.conversations.messages(fresh.id).length, 0, "a new chat starts empty");

    const missing = await api<{ error: { code: string } }>(t.url, `/api/conversations/${dm.id}`, { method: "DELETE" });
    assert.equal(missing.status, 404);
  } finally {
    hold.open();
    await t.close();
  }
});

test("deleting a chat stops the reply in progress; the Boardroom is cleared, not deleted", async () => {
  const hold = gate();
  let replying = false;
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger !== "message") return done();
      replying = true;
      await hold.promise;
      return done("Here is my answer.");
    },
  });
  try {
    const { platform } = t.app;
    const boardroom = platform.conversations.boardroom()!;
    const asked: Message = platform.conversations.postHuman(boardroom.id, "Status update, please.");
    platform.runs.startMessageRun(asked);
    await waitFor("the CEO is replying", () => replying);

    const res = platform.chats.deleteConversation(boardroom.id);
    assert.deepEqual(res, { conversationId: boardroom.id, cleared: true, deletedMessages: 1, deletedMemories: 0, abortedRuns: 1 });
    hold.open();
    await t.drain();
    assert.ok(platform.repos.conversations.get(boardroom.id), "the Boardroom stays");
    assert.deepEqual(platform.conversations.messages(boardroom.id).map((m) => m.content), [], "and the stopped reply was not posted");
    assert.equal(platform.conversations.boardroom()!.lastMessageAt, null);
  } finally {
    hold.open();
    await t.close();
  }
});
