// 2026-11-08 (trc_6ee6…): the first attempt at the investor email (T-247) was cancelled, but its
// blackboard note — "blocked: … No email was sent…" — stayed, and the next attempt's agents read it
// eight times. A cancelled objective's note is out of date: agents no longer see it in the list,
// reading it by key says so, and the Board's console still shows everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blackboardRead } from "../../src/tools/builtins/memory.ts";
import type { ToolRunContext } from "../../src/tools/types.ts";
import { createTestApp, rootTask } from "./helpers/harness.ts";

test("a cancelled objective's blackboard note is left out of what agents read", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const before = platform.memory.blackboardList().map((e) => e.key);
    const old = rootTask(t, ceo.id, "Send monthly investor update");
    const live = rootTask(t, ceo.id, "Draft the monthly investor update");
    platform.memory.blackboardSet(`objective:T-${old.number}`, "blocked: No email was sent and no send confirmation exists.", ceo.id);
    platform.memory.blackboardSet(`objective:T-${live.number}`, "in progress", ceo.id);
    platform.memory.blackboardSet("office-hours", "Tue 10:00", ceo.id);
    assert.equal(platform.memory.blackboardCurrent().length, before.length + 3);

    platform.tasks.cancel(old.id);
    const keys = platform.memory.blackboardCurrent().map((e) => e.key).sort();
    assert.deepEqual(keys, [...before, `objective:T-${live.number}`, "office-hours"].sort());
    assert.equal(platform.memory.blackboardList().length, before.length + 3, "the Board's console still lists it");

    const ctx = { services: { memory: platform.memory } } as unknown as ToolRunContext;
    const listed = await blackboardRead.run({}, ctx);
    assert.doesNotMatch(listed.content, /No email was sent/);
    assert.match(listed.content, /office-hours: Tue 10:00/);
    const byKey = await blackboardRead.run({ key: `objective:T-${old.number}` }, ctx);
    assert.match(byKey.content, /^objective:T-\d+ = \[out of date: that objective was cancelled — do not rely on this note\] blocked: No email was sent/);
    assert.match(platform.services.handbook!(ceo), new RegExp(`objective:T-${live.number}`));
    assert.doesNotMatch(platform.services.handbook!(ceo), new RegExp(`objective:T-${old.number}\\b`));
  } finally {
    await t.close();
  }
});
