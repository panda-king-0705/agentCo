import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createTestApp, done, gate, rootTask, waitFor } from "./helpers/harness.ts";

test("crash recovery: running → interrupted, task → todo with a recovery notice, trigger \"recovery\"", async () => {
  const hang = gate(); // never opened: the first process "crashes" mid-run
  const first = await createTestApp({ reflex: async () => (await hang.promise, done("unreachable")) });
  let second: Awaited<ReturnType<typeof createTestApp>> | null = null;
  try {
    const dev = first.agentByRole("backend-engineer");
    const task = rootTask(first, dev.id, "Interrupted work");
    first.app.platform.scheduler.tick();
    await waitFor("run started", () => first.app.platform.runs.isBusy(dev.id));
    const [lostRun] = first.app.platform.repos.runs.list({ taskId: task.id });
    assert.equal(lostRun?.status, "running");
    first.app.platform.scheduler.stop(); // the process dies here: no finish() ever runs

    second = await createTestApp({ dataDir: first.dataDir, reflex: (ctx) => done(ctx.input.trigger === "recovery" ? `recovered ${ctx.input.recoveryNotice?.slice(0, 20)}` : "plain") });
    assert.equal(second.app.platform.repos.agents.byRole("backend-engineer")?.id, dev.id, "same company, same database");
    second.app.platform.start(); // recoverOnBoot + scheduler

    const interrupted = second.app.platform.repos.runs.get(lostRun?.id as string);
    assert.equal(interrupted?.status, "interrupted");
    assert.ok(interrupted?.completedAt);
    assert.ok(second.app.platform.repos.spans.byRun(lostRun?.id as string).every((s) => s.status !== "running"), "spans left open by the crash are closed");
    const requeued = second.app.platform.tasks.require(task.id);
    assert.equal(requeued.status, "todo");
    assert.equal(requeued.attempts, 0, "the lost attempt is refunded");
    assert.deepEqual(requeued.state.recovery, { runId: lostRun?.id });
    assert.equal(second.app.platform.repos.agents.get(dev.id)?.currentRunId, null);

    await waitFor("recovery run", () => second?.reflex.calls.length === 1);
    await second.app.platform.runs.idle();
    const call = second.reflex.calls[0];
    assert.equal(call?.input.trigger, "recovery");
    assert.ok(call?.input.trigger === "recovery" && call.input.recoveryNotice?.includes(lostRun?.id as string));
    assert.match(call?.input.trigger === "recovery" ? (call.input.recoveryNotice ?? "") : "", /do not blindly repeat it/);
    const final = second.app.platform.tasks.require(task.id);
    assert.equal(final.status, "done");
    assert.equal(final.attempts, 1);
    assert.equal(final.state.recovery, undefined, "the recovery marker is consumed by the next run");
    assert.equal(second.app.platform.repos.runs.list({ taskId: task.id }).length, 2);
  } finally {
    await second?.close();
    first.app.platform.db.close();
    rmSync(first.dataDir, { recursive: true, force: true });
  }
});

test("recovery re-queues an unanswered chat message", async () => {
  const hang = gate();
  const first = await createTestApp({ reflex: async () => (await hang.promise, done()) });
  let second: Awaited<ReturnType<typeof createTestApp>> | null = null;
  try {
    const dev = first.agentByRole("backend-engineer");
    const dm = first.app.platform.conversations.directMessage(dev);
    const message = first.app.platform.conversations.postHuman(dm.id, "status?");
    first.app.platform.scheduler.tick();
    await waitFor("chat run", () => first.app.platform.runs.isBusy(dev.id));
    assert.ok(first.app.platform.repos.conversations.getMessage(message.id)?.runId);
    first.app.platform.scheduler.stop();

    second = await createTestApp({ dataDir: first.dataDir, reflex: () => done("back online") });
    second.app.platform.start();
    await second.drain();
    const reply = second.app.platform.conversations.messages(dm.id).find((m) => m.senderId === dev.id);
    assert.equal(reply?.content, "back online");
  } finally {
    await second?.close();
    first.app.platform.db.close();
    rmSync(first.dataDir, { recursive: true, force: true });
  }
});
