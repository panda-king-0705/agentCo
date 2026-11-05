import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";
import { createRedactor } from "../../src/middleware/redact.ts";

const KEY = "sk-abcdefghijklmnopqrstuvwx0123456789";
const GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

test("redactor: whole-match tier for prose, heuristic tier only for machine content, literals always", () => {
  const r = createRedactor(["hunter2-supersecret"]);
  assert.equal(r.redact(`key ${KEY} end`), "key [REDACTED] end");
  assert.equal(r.redact("literal hunter2-supersecret here"), "literal [REDACTED] here");
  assert.equal(r.redact("Remember this token: ORDER-4471-ZULU"), "Remember this token: ORDER-4471-ZULU", "prose is not mangled by heuristics");
  assert.match(r.redactMachine("api_key = abcdefgh12345678"), /\[REDACTED\]/);
});

test("no secret reaches the database: spans, run output, task result, messages, memory", async () => {
  const t = await createTestApp({
    env: { OPENAI_API_KEY: "configured-literal-secret-9999" },
    brain: async (ctx) => {
      if (ctx.input.trigger === "message") return done(`Your key is ${KEY}`);
      await callTool(ctx, "memory_write", { content: `deploy token ${GH} and api_key=abcdefgh12345678`, kind: "episodic", scope: "agent" });
      await callTool(ctx, "workspace_write_file", { path: "notes.txt", content: `literal configured-literal-secret-9999 and ${KEY}` });
      const span = ctx.span.child({ kind: "llm", name: "llm.chat", input: `Authorization: Bearer ${KEY}` });
      span.setAttributes({ note: `leaked ${KEY}` });
      span.end({ status: "ok", output: `echo ${KEY}` });
      return done(`result mentions ${KEY} and configured-literal-secret-9999`);
    },
  });
  try {
    const { platform } = t.app;
    const task = rootTask(t, t.agentByRole("cto").id, `Task with ${KEY} in the title`);
    const dm = platform.conversations.directMessage(t.agentByRole("cto"));
    platform.conversations.postHuman(dm.id, `my key is ${KEY}`);
    await t.drain();

    const tables = ["spans", "runs", "tasks", "messages", "memories", "events", "approvals"];
    for (const table of tables) {
      const rows = platform.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      assert.ok(rows.length > 0 || table === "approvals", `${table} has rows`);
      const dump = JSON.stringify(rows);
      // the key=value heuristic tier is machine-content only (spans); prose tables get the high-precision tier
      const secrets = [KEY, GH, "configured-literal-secret-9999", ...(table === "spans" ? ["abcdefgh12345678"] : [])];
      for (const secret of secrets) {
        assert.ok(!dump.includes(secret), `${table} must not contain ${secret.slice(0, 8)}…`);
      }
    }
    const result = platform.tasks.require(task.id).result ?? "";
    assert.ok(!result.includes(KEY) && result.includes("[REDACTED]"), "the task result is redacted");
    assert.ok(platform.tasks.require(task.id).title.includes("[REDACTED]"), "Board-typed task titles are redacted too");
    const spans = platform.repos.spans.byTrace(task.traceId);
    assert.ok(spans.some((s) => s.kind === "llm" && s.input?.includes("[REDACTED]")), "the llm span input was redacted");
    assert.ok(spans.every((s) => !JSON.stringify(s).includes("sk-abcdefgh")));
  } finally {
    await t.close();
  }
});
