// Test 5 (2026-11-07): "Hire an SEO specialist with a $10 budget and give them a first task". The
// founder chose "managers hire, recruiter sources": the head of the receiving team hires (with a
// budget and a first task, now or when the Board approves), and recruiters search the catalog.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../../../../packages/shared/src/index.ts";
import { roleTemplate } from "../../src/org/templates.ts";
import { callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";

const HIRE = {
  catalogId: "marketing/marketing-seo-specialist",
  monthlyBudgetUsd: 10,
  justification: "SEO for the meeting-notes launch",
  firstTask: { title: "SEO keyword brief", description: "Write a ~150-word keyword brief and save it to launch-plan/seo-keywords.md.", acceptanceCriteria: "Saved at that path." },
};

test("the hiring manager hires with a budget and a first task; they wait for it and are resumed with the result", async () => {
  const seen: Record<string, { ok: boolean; content: string }> = {};
  let resumedWith: Task[] = [];
  let ids = { cmo: "" };
  const t = await createTestApp({
    env: { HIRING_REQUIRES_APPROVAL: "false" },
    brain: async (ctx) => {
      if (ctx.input.trigger === "message") return done();
      if (ctx.agent.id === ids.cmo && ctx.input.trigger === "task") {
        seen.hire = await callTool(ctx, "hire_agent", HIRE);
        return { outcome: "waiting", output: "Hired; waiting for the first task." };
      }
      if (ctx.agent.id === ids.cmo && ctx.input.trigger === "subtasks_completed") {
        resumedWith = ctx.input.subtasks;
        return done("Hire done; brief delivered.");
      }
      return done();
    },
    reflex: async (ctx) => {
      if (ctx.input.trigger !== "task") return done();
      await callTool(ctx, "workspace_write_file", { path: "launch-plan/seo-keywords.md", content: "meeting notes app, AI meeting summary" });
      return done("Saved launch-plan/seo-keywords.md.");
    },
  });
  try {
    const { platform } = t.app;
    const cmo = t.agentByRole("cmo");
    ids = { cmo: cmo.id };
    const task = rootTask(t, cmo.id, "Hire an SEO specialist and give them a first task");
    await t.drain();
    assert.equal(seen.hire?.ok, true, seen.hire?.content ?? "no hire call");
    assert.match(seen.hire!.content, /^Hired .* with a \$10\/month budget\. First task assigned as T-\d+; you will be resumed with their result\./);
    const hire = platform.org.listActiveAgents().find((a) => a.catalogId === HIRE.catalogId)!;
    assert.equal(hire.managerId, cmo.id, "joins the hiring manager's team");
    assert.equal(hire.monthlyBudgetUsd, 10);
    const first = platform.tasks.children(task.id).find((c) => c.state.firstTask === true)!;
    assert.equal(first.assigneeId, hire.id);
    assert.equal(first.status, "done");
    assert.ok(resumedWith.some((c) => c.id === first.id && /seo-keywords\.md/.test(c.result ?? "")), "the manager was resumed with the first task's result");
    assert.equal(platform.tasks.get(task.id)!.status, "done");
    assert.match(platform.services.handbook!(hire), /Hiring: the head of the team a new hire joins makes the hire/, "the handbook a new hire gets explains hiring");
  } finally {
    await t.close();
  }
});

test("with Board approval on, the first task is assigned when the Board approves — under the hiring task", async () => {
  const seen: Record<string, { ok: boolean; content: string; data?: unknown }> = {};
  let ids = { cmo: "" };
  let runs = 0;
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger === "message" || ctx.agent.id !== ids.cmo) return done();
      runs++;
      if (ctx.input.trigger === "task") {
        seen.hire = await callTool(ctx, "hire_agent", HIRE);
        const approvalId = (seen.hire.data as { approvalId?: string } | undefined)?.approvalId;
        return { outcome: "blocked", output: "Waiting for the Board.", approvalId };
      }
      if (ctx.input.trigger === "human_answer") return { outcome: "waiting", output: "Approved; waiting for the first task." };
      return done("Hire done; brief delivered.");
    },
    reflex: async () => done("Saved launch-plan/seo-keywords.md."),
  });
  try {
    const { platform } = t.app;
    const cmo = t.agentByRole("cmo");
    ids = { cmo: cmo.id };
    const task = rootTask(t, cmo.id, "Hire an SEO specialist and give them a first task");
    await t.drain();
    assert.match(seen.hire!.content, /^Hiring request sent to the Board .* Their first task is assigned when the Board approves\. You will be resumed with the Board's decision\./);
    assert.equal(platform.tasks.get(task.id)!.status, "blocked");
    const approval = platform.approvals.list("pending").find((a) => a.kind === "hire_agent")!;
    assert.equal((approval.payload.firstTask as { title: string }).title, "SEO keyword brief");
    const decided = platform.approvals.decide(approval.id, { decision: "approved" });
    const hiredId = decided.payload.hiredAgentId as string;
    const firstId = decided.payload.firstTaskId as string;
    assert.ok(hiredId && firstId);
    const first = platform.tasks.get(firstId)!;
    assert.equal(first.parentTaskId, task.id, "a subtask of the hiring task");
    assert.equal(first.assigneeId, hiredId);
    assert.equal(platform.org.getAgent(hiredId)!.monthlyBudgetUsd, 10);
    await t.drain();
    assert.equal(platform.tasks.get(firstId)!.status, "done");
    assert.equal(platform.tasks.get(task.id)!.status, "done", "resumed after the Board, waited for the first task, then finished");
    assert.equal(runs, 3);
  } finally {
    await t.close();
  }
});

test("recruiters can search the catalog (to recommend); only executives hire", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    assert.ok(roleTemplate("recruiter-agent")!.tools.includes("catalog_search"));
    assert.ok(!roleTemplate("recruiter-agent")!.tools.includes("hire_agent"));
    const recruiter = platform.org.createAgent({ roleId: "recruiter-agent", name: "Jasmine Lee" }, "human");
    const names = platform.tools.specsFor(recruiter).map((s) => s.name);
    assert.ok(names.includes("catalog_search") && !names.includes("hire_agent"), names.join(","));
    // An existing recruiter without it gets it at boot (backfill).
    platform.repos.agents.update(recruiter.id, { tools: recruiter.tools.filter((x) => x !== "catalog_search") });
    platform.org.backfillCatalog();
    assert.ok(platform.org.getAgent(recruiter.id)!.tools.includes("catalog_search"));
  } finally {
    await t.close();
  }
});
