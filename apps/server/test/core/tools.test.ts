import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";

test("specsFor = registry ∩ agent.tools ∩ tier permission (∩ feature flags)", async () => {
  const t = await createTestApp();
  try {
    const { tools } = t.app.platform;
    const names = (role: string) => tools.specsFor(t.agentByRole(role)).map((s) => s.name);
    const ceo = names("ceo");
    assert.ok(ceo.includes("delegate_task") && ceo.includes("hire_agent") && ceo.includes("ask_human"));
    const worker = names("backend-engineer");
    for (const forbidden of ["delegate_task", "hire_agent", "ask_human", "blackboard_write"]) assert.ok(!worker.includes(forbidden), `workers must not get ${forbidden}`);
    for (const allowed of ["send_message", "escalate", "memory_search", "workspace_write_file"]) assert.ok(worker.includes(allowed), `workers get ${allowed}`);
    assert.ok(!ceo.includes("web_fetch"), "web_fetch is off unless WEB_FETCH_ENABLED");
    // agent.tools narrows further — except universal tools (the company directory), which everyone has
    const cto = t.agentByRole("cto");
    t.app.platform.repos.agents.update(cto.id, { tools: ["memory_search"] });
    assert.deepEqual(tools.specsFor(t.app.platform.org.getAgent(cto.id)!).map((s) => s.name), ["company_directory", "memory_search"]);
    assert.ok(worker.includes("company_directory"), "workers get the directory too");
    assert.ok(tools.names().includes("web_fetch"), "flagged tools are still known so they can be assigned");
  } finally {
    await t.close();
  }
});

test("execute runs inside a tool span and never throws for tool-level failures", async () => {
  const outcomes: Record<string, { ok: boolean; content: string }> = {};
  const t = await createTestApp({
    reflex: async (ctx) => {
      outcomes.good = await callTool(ctx, "memory_write", { content: "lesson learned", kind: "episodic", scope: "agent" });
      outcomes.unknown = await callTool(ctx, "does_not_exist", {});
      outcomes.badArgs = await callTool(ctx, "memory_write", { content: 42 });
      outcomes.missing = await callTool(ctx, "workspace_read_file", {});
      outcomes.traversal = await callTool(ctx, "workspace_write_file", { path: "../../etc/passwd", content: "x" });
      outcomes.forbidden = await callTool(ctx, "hire_agent", { title: "x", departmentId: "d", managerId: "m", tier: "worker", justification: "j" });
      outcomes.shared = await callTool(ctx, "workspace_write_file", { path: "shared/plan.md", content: "# plan" });
      return done();
    },
  });
  try {
    const task = rootTask(t, t.agentByRole("backend-engineer").id, "use tools");
    await t.drain();
    assert.equal(outcomes.good?.ok, true);
    assert.equal(outcomes.shared?.ok, true);
    for (const key of ["unknown", "badArgs", "missing", "traversal", "forbidden"]) assert.equal(outcomes[key]?.ok, false, `${key} → ok:false (${outcomes[key]?.content})`);
    assert.match(outcomes.badArgs?.content ?? "", /invalid arguments/);
    assert.match(outcomes.forbidden?.content ?? "", /not available/);
    const spans = t.app.platform.repos.spans.byTrace(task.traceId).filter((s) => s.kind === "tool");
    assert.equal(spans.length, 7);
    const good = spans.find((s) => s.name === "tool.memory_write" && s.status === "ok");
    assert.equal(good?.attributes["gen_ai.tool.name"], "memory_write");
    assert.ok(spans.filter((s) => s.status === "error").length === 5);
    assert.equal(t.app.platform.repos.runs.list({ taskId: task.id })[0]?.toolCalls, 7, "run.toolCalls counts every call");
    assert.ok(t.app.platform.memory.search({ query: "lesson learned", agentId: task.assigneeId }).length === 1);
  } finally {
    await t.close();
  }
});
