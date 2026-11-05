import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, done, rootTask } from "./helpers/harness.ts";
import { BudgetExceededError } from "../../src/middleware/budget.ts";

test("the budget gate throws before a call, a failed run opens ONE deduped approval, approving unblocks the task", async () => {
  const t = await createTestApp({
    brain: (ctx) => {
      // what the model router does before every provider call
      ctx.platform.agents.setActivity(ctx.agent.id, "thinking", "calling the model", null);
      t.app.platform.budget.assertCanSpend(ctx.agent.id, 0.5);
      return done("only reachable with budget");
    },
  });
  try {
    const { platform } = t.app;
    const cto = t.agentByRole("cto");
    platform.repos.agents.update(cto.id, { monthlyBudgetUsd: 0.1 });
    assert.throws(() => platform.budget.assertCanSpend(cto.id, 0.5), (e: Error) => e instanceof BudgetExceededError && e.scope === "agent" && e.limitUsd === 0.1);

    const first = rootTask(t, cto.id, "needs money 1");
    const second = rootTask(t, cto.id, "needs money 2");
    await t.drain();

    for (const id of [first.id, second.id]) {
      const task = platform.tasks.require(id);
      assert.equal(task.status, "blocked", "the task waits for the Board instead of looping");
      assert.equal(task.attempts, 1);
    }
    const runs = platform.repos.runs.list({ agentId: cto.id });
    assert.ok(runs.length === 2 && runs.every((r) => r.status === "failed" && /budget exhausted/.test(r.error ?? "")));
    const pending = platform.approvals.list("pending").filter((a) => a.kind === "budget_increase");
    assert.equal(pending.length, 1, "one deduped budget_increase approval for both failures");
    assert.equal(pending[0]?.payload.scope, "agent");
    assert.equal(pending[0]?.payload.agentId, cto.id);

    // The Board raises the cap; both blocked tasks wake and (now affordable) finish.
    t.brain.script = () => done("funded");
    platform.approvals.decide(pending[0]?.id as string, { decision: "approved" });
    assert.ok((platform.org.getAgent(cto.id)?.monthlyBudgetUsd ?? 0) > 0.1);
    await t.drain();
    for (const id of [first.id, second.id]) assert.equal(platform.tasks.require(id).status, "done");
  } finally {
    await t.close();
  }
});

test("company budget exhaustion: a chat message gets an honest error reply and an approval", async () => {
  const t = await createTestApp({
    env: { DAILY_BUDGET_USD: "0.0001" },
    brain: (ctx) => {
      t.app.platform.budget.assertCanSpend(ctx.agent.id, 1);
      return done();
    },
  });
  try {
    const { platform } = t.app;
    const cto = t.agentByRole("cto");
    const dm = platform.conversations.directMessage(cto);
    platform.conversations.postHuman(dm.id, "hello?");
    await t.drain();
    const reply = platform.conversations.messages(dm.id).find((m) => m.senderId === cto.id);
    assert.match(reply?.content ?? "", /I hit an error: company daily budget exhausted/);
    assert.match(reply?.content ?? "", /apr_/);
    assert.equal(platform.approvals.list("pending").filter((a) => a.kind === "budget_increase").length, 1);
  } finally {
    await t.close();
  }
});
