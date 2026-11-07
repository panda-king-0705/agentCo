// 2026-11-07 (trc_617b…): the PC's hotspot dropped for six minutes. The CEO's final check failed on
// both providers, the task retried 0.4 s later, failed again and used its last attempt — the objective
// ended "failed" with every part done. Now an outage holds the work: no attempts are used, nothing
// starts until the next try (30 s, 1, 2, then every 5 min), the Board is told once, and work resumes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OutageGate, ProviderOutageError, isNetworkError, isProviderOutage, watchOutages } from "../../src/models/outage.ts";
import type { ModelRouter } from "../../src/contracts.ts";
import { createTestApp, done, rootTask } from "./helpers/harness.ts";

const unreachable = () => new ProviderOutageError(["anthropic: fetch failed", "openai: fetch failed"]);

test("an outage holds a task instead of failing it; the Board is told once; work resumes", async () => {
  let clock = new Date("2026-11-07T05:41:00Z");
  let failures = 3;
  const t = await createTestApp({
    overrides: { now: () => clock },
    brain: async (ctx) => {
      if (ctx.input.trigger === "message") return done();
      if (failures > 0) {
        failures -= 1;
        throw unreachable();
      }
      return done("Final check passed.");
    },
  });
  try {
    const { platform } = t.app;
    const later = (ms: number) => (clock = new Date(clock.getTime() + ms));
    const room = platform.conversations.boardroom()!;
    const notices = () => platform.conversations.messages(room.id).filter((m) => m.senderId === "system").map((m) => m.content);
    const task = rootTask(t, t.agentByRole("ceo").id, "Final check");

    await t.drain();
    const held = platform.tasks.get(task.id)!;
    assert.equal(held.status, "todo");
    assert.equal(held.attempts, 0, "the attempt is refunded");
    assert.match(held.error ?? "", /^Waiting for the AI providers to be reachable again: AI providers unreachable/);
    assert.ok(platform.outage.heldUntil());
    assert.equal(platform.scheduler.tick(), 0, "nothing starts while held");
    assert.deepEqual(notices(), [], "one failed try is not worth a message");

    later(31_000); // second try fails: the outage is lasting — tell the Board, once
    await t.drain();
    assert.equal(notices().length, 1);
    assert.match(notices()[0]!, /^The company can't reach its AI providers \(since \d\d:\d\d; is the network down\?\)\. All work is on hold, nothing is lost and no attempts are used up\./);
    later(30_000);
    assert.equal(platform.scheduler.tick(), 0, "the second wait is a minute");
    later(31_000); // third try fails
    await t.drain();
    assert.equal(notices().length, 1, "told once");
    assert.equal(platform.outage.status()!.strikes, 3);

    later(121_000); // the providers answer
    await t.drain();
    const finished = platform.tasks.get(task.id)!;
    assert.equal(finished.status, "done");
    assert.equal(finished.attempts, 1, "only the run that reached a provider counted");
    platform.outage.clear(); // what the first answering model call does (watchOutages)
    assert.equal(notices().length, 2);
    assert.match(notices()[1]!, /^The AI providers are reachable again \(down \d\d:\d\d–\d\d:\d\d\)\. Work has resumed\./);
    assert.equal(platform.outage.heldUntil(), null);
  } finally {
    await t.close();
  }
});

test("a chat message that hits an outage is kept and answered once the providers are back", async () => {
  let clock = new Date("2026-11-07T05:41:00Z");
  let failures = 1;
  const t = await createTestApp({
    overrides: { now: () => clock },
    brain: async (ctx) => {
      if (ctx.input.trigger !== "message") return done();
      if (failures > 0) {
        failures -= 1;
        throw unreachable();
      }
      return done("The launch plan is on the drive.");
    },
  });
  try {
    const { platform } = t.app;
    const room = platform.conversations.boardroom()!;
    const asked = platform.conversations.postHuman(room.id, "Where is the launch plan?");
    await t.drain();
    assert.equal(platform.repos.conversations.getMessage(asked.id)!.runId, null, "back in the queue");
    const texts = () => platform.conversations.messages(room.id).map((m) => `${m.senderId === "system" ? "system" : m.senderId === "human" ? "board" : "ceo"}: ${m.content}`);
    assert.equal(texts().length, 2);
    assert.match(texts()[1]!, /^system: Couldn't reach the AI providers just now/);
    clock = new Date(clock.getTime() + 31_000);
    await t.drain();
    assert.equal(texts().at(-1), "ceo: The launch plan is on the drive.");
    assert.equal(texts().filter((x) => /Couldn't reach/.test(x)).length, 1);
  } finally {
    await t.close();
  }
});

test("outage helpers: network errors, the gate's backoff, and a model call that answers clears it", async () => {
  assert.ok(isNetworkError(new Error("openai request to https://api.openai.com/v1/chat/completions failed: fetch failed")));
  assert.ok(isNetworkError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })));
  assert.ok(!isNetworkError(new Error("HTTP 503 upstream overloaded")));
  assert.ok(isProviderOutage(unreachable()) && isProviderOutage(unreachable().message) && !isProviderOutage(new Error("boom")));

  let ms = 0;
  const gate = new OutageGate(() => ms);
  gate.trip("x");
  gate.trip("y"); // runs failing together during one wait count once
  assert.deepEqual([gate.status()!.strikes, gate.heldUntil()], [1, 30_000]);
  for (const [at, wait] of [[30_000, 60_000], [90_000, 120_000], [210_000, 300_000], [510_000, 300_000]] as const) {
    ms = at;
    gate.trip("z");
    assert.equal(gate.heldUntil(), at + wait);
  }
  const router = { chat: async () => ({ content: "ok" }), isLive: () => true, resolve: () => null, tierForStage: () => "economy" } as unknown as ModelRouter;
  const watched = watchOutages(router, gate);
  assert.equal(watched.isLive(), true);
  await watched.chat({} as never, {} as never);
  assert.equal(gate.status(), null);
});
