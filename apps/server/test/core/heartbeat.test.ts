import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, done, rootTask } from "./helpers/harness.ts";
import { runHeartbeat } from "../../src/platform.ts";

test("heartbeat: idle executives get one low-value review task each (trigger heartbeat); busy ones and a paused company are skipped", async () => {
  const t = await createTestApp({ brain: (ctx) => done(`beat ${ctx.input.trigger}`) });
  try {
    const { platform } = t.app;
    const executives = platform.org.listActiveAgents().filter((a) => a.tier === "executive");
    assert.ok(executives.length >= 5);
    const busy = executives[0]!;
    rootTask(t, busy.id, "already busy");
    platform.pauseCompany();
    assert.equal(runHeartbeat(platform), 0, "no heartbeat while paused");
    platform.resumeCompany();
    assert.equal(runHeartbeat(platform), executives.length - 1);
    assert.equal(runHeartbeat(platform), 0, "agents that now have an open task are not given another");
    await t.drain();
    const beats = t.brain.calls.filter((c) => c.input.trigger === "heartbeat");
    assert.equal(beats.length, executives.length - 1);
    assert.ok(beats.every((c) => c.input.trigger === "heartbeat" && c.input.task.value === 5));
    assert.ok(beats.every((c) => c.agent.id !== busy.id));
  } finally {
    await t.close();
  }
});
