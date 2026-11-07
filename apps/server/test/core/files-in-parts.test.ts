// 2026-11-07 (test 6, trc_1a51…): a worker's claim-by-claim table was longer than one reply, so the
// save arrived cut off; the error said "missing required argument path" (the path was there), and
// she sent the same long save again until the run timed out — twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";

test("a cut-off save says so and nothing is written; a long file can be saved in parts with append", async () => {
  const out: { ok: boolean; content: string }[] = [];
  let worker = "";
  const t = await createTestApp({
    reflex: async (ctx) => {
      if (ctx.input.trigger !== "task" || ctx.agent.id !== worker) return done();
      out.push(await callTool(ctx, "workspace_write_file", { _raw: '{"path":"investor-updates/reconciliation.md","content":"# Reconciliation\\n| claim | source |' }));
      out.push(await callTool(ctx, "workspace_write_file", { path: "investor-updates/reconciliation.md", content: "# Reconciliation\n| claim | source |\n|---|---|\n| ARR | finance.md |" }));
      out.push(await callTool(ctx, "workspace_write_file", { path: "investor-updates/reconciliation.md", content: "| Runway | budget.md |", append: true }));
      out.push(await callTool(ctx, "workspace_read_file", { path: "investor-updates/reconciliation.md" }));
      return done("Saved in two parts.");
    },
  });
  try {
    worker = t.agentByRole("backend-engineer").id;
    rootTask(t, worker, "Reconcile the claims");
    await t.drain();
    assert.equal(out[0]!.ok, false);
    assert.match(out[0]!.content, /your workspace_write_file call was cut off before it finished \(the reply hit its length limit\), so nothing happened\. Save the file in parts: write the first part, then add each next part with append: true/);
    assert.equal(out[1]!.ok, true);
    assert.equal(out[2]!.ok, true, out[2]!.content);
    assert.match(out[2]!.content, /^Added 22 chars to shared\/investor-updates\/reconciliation\.md; the whole file is now \d+ chars, \d+ words, 5 lines\. Saved and verified on disk\./);
    assert.match(out[3]!.content, /^# Reconciliation\n\| claim \| source \|\n\|---\|---\|\n\| ARR \| finance\.md \|\n\| Runway \| budget\.md \|\n\[read tool's note, not part of the file: end of shared\/investor-updates\/reconciliation\.md — complete:/);
  } finally {
    await t.close();
  }
});
