import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineContext } from "../../src/contracts.ts";
import { createTestApp, done, type TestApp } from "./helpers/harness.ts";

const OBJECTIVE = "Remember this token: ORDER-4471-ZULU and plan the quarter";

/** A DM with `turns` earlier exchanges (already answered), then the live Board message. */
function seedConversation(t: TestApp, turns: number) {
  const { conversations } = t.app.platform;
  const agent = t.agentByRole("cto");
  const dm = conversations.directMessage(agent);
  for (let i = 0; i < turns; i++) {
    const human = conversations.postAs(dm.id, "human", i === 0 ? OBJECTIVE : `Follow-up question number ${i} about the roadmap and its many details`, {});
    conversations.attachRun(human.id, "run_old");
    conversations.postAs(dm.id, agent.id, `Answer ${i}: ` + "a considered reply with plenty of words in it. ".repeat(4), { runId: "run_old" });
  }
  const live = conversations.postHuman(dm.id, "And what is the one thing to do tomorrow?");
  return { agent, dm, live };
}

const calls = (t: TestApp): EngineContext[] => t.brain.calls;

test("compaction folds old turns: objective verbatim, user message last, transcript saved", async () => {
  const t = await createTestApp({ contextWindow: 600, env: { CONTEXT_CARRY_TURNS: "4" } });
  try {
    const { dm, live } = seedConversation(t, 10);
    await t.drain();
    const input = calls(t)[0]?.input;
    assert.equal(input?.trigger, "message");
    if (input?.trigger !== "message") return;
    assert.equal(input.history.compacted, true);
    const messages = input.history.messages;
    assert.ok(messages.length <= 5, `history shrank to a preamble + the carried tail (got ${messages.length})`);
    assert.equal(messages[0]?.senderId, "system");
    assert.ok(messages[0]?.content.includes(OBJECTIVE), "the first Board message survives verbatim in the checkpoint");
    assert.equal(messages.at(-1)?.id, live.id, "the user's message is always last");
    assert.equal(messages.at(-1)?.content, "And what is the one thing to do tomorrow?");
    const transcript = join(t.dataDir, "artifacts", dm.id, "transcript_v1.md");
    assert.ok(existsSync(transcript), "the full transcript is saved");
    assert.ok(readFileSync(transcript, "utf8").includes("Follow-up question number 1"));
    const span = t.app.platform.repos.spans.byTrace(input.message.traceId as string).find((s) => s.name === "compaction");
    assert.ok(span, "compaction is traced");
    assert.equal(span.parentSpanId, calls(t)[0]?.run.rootSpanId);
  } finally {
    await t.close();
  }
});

test("small conversations are not compacted", async () => {
  const t = await createTestApp({ contextWindow: 128_000 });
  try {
    seedConversation(t, 3);
    await t.drain();
    const input = calls(t)[0]?.input;
    assert.ok(input?.trigger === "message");
    if (input?.trigger === "message") {
      assert.equal(input.history.compacted, false);
      assert.equal(input.history.messages.length, 7);
    }
  } finally {
    await t.close();
  }
});

test("fail closed: contextWindow null disables compaction and says so once", async () => {
  const t = await createTestApp({ contextWindow: null, env: { CONTEXT_CARRY_TURNS: "2" } });
  try {
    const { dm } = seedConversation(t, 12);
    await t.drain();
    const input = calls(t)[0]?.input;
    assert.ok(input?.trigger === "message");
    if (input?.trigger !== "message") return;
    assert.equal(input.history.compacted, false);
    assert.equal(input.history.messages.length, 25, "nothing was folded");
    assert.equal(input.history.messages[0]?.content, OBJECTIVE);
    assert.ok(!existsSync(join(t.dataDir, "artifacts", dm.id)), "no transcript, no checkpoint");
    // a second message in the same conversation does not repeat the span
    t.app.platform.conversations.postHuman(dm.id, "one more");
    await t.drain();
    const disabled = t.app.platform.repos.spans.byTrace(input.message.traceId as string).concat(t.app.platform.repos.spans.byRun(calls(t)[1]?.run.id as string)).filter((s) => s.name === "compaction_disabled");
    assert.equal(new Set(disabled.map((s) => s.id)).size, 1, "compaction_disabled is reported once per conversation");
    assert.equal(disabled[0]?.kind, "system");
  } finally {
    await t.close();
  }
});
