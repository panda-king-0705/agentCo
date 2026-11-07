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

// Live (2026-11-07, trc_5831…): resumed after the Board approved the SEO Specialist, the CMO hired a
// second one for the same task; the Board approved that too.
test("one hire per role per task: a second request is refused — pending, hired or declined", async () => {
  const results: { ok: boolean; content: string; data?: unknown }[] = [];
  let ids = { cmo: "" };
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger !== "task" || ctx.agent.id !== ids.cmo) return done();
      results.push(await callTool(ctx, "hire_agent", HIRE));
      results.push(await callTool(ctx, "hire_agent", HIRE));
      results.push(await callTool(ctx, "hire_agent", { ...HIRE, catalogId: "marketing/marketing-tiktok-strategist" }));
      return { outcome: "blocked", output: "Waiting for the Board.", approvalId: (results[0]!.data as { approvalId: string }).approvalId };
    },
  });
  try {
    const { platform } = t.app;
    const cmo = t.agentByRole("cmo");
    ids = { cmo: cmo.id };
    const task = rootTask(t, cmo.id, "Hire an SEO specialist and a content creator");
    await t.drain();
    assert.match(results[0]!.content, /^Hiring request sent to the Board/);
    assert.equal(results[1]!.ok, false);
    assert.match(results[1]!.content, /^Already done for this task: a marketing\/marketing-seo-specialist hire is waiting for the Board's approval\. Do not hire again/);
    assert.match(results[2]!.content, /^Hiring request sent to the Board/, "a different role is fine");
    const pending = platform.approvals.list("pending").filter((a) => a.kind === "hire_agent");
    assert.equal(pending.length, 2);
    const seo = pending.find((a) => (a.payload.input as { catalogId: string }).catalogId === HIRE.catalogId)!;
    const other = pending.find((a) => a !== seo)!;
    platform.approvals.decide(seo.id, { decision: "approved" });
    platform.approvals.decide(other.id, { decision: "rejected", note: "Not now." });
    const hires = platform.tasks.get(task.id)!.state.hires as { role: string; status: string; name?: string; firstTaskId?: string }[];
    const seoHire = hires.find((h) => h.role === HIRE.catalogId)!;
    assert.equal(seoHire.status, "hired");
    assert.ok(seoHire.name && seoHire.firstTaskId, "who joined and their first task are on the hiring task");
    assert.equal(hires.find((h) => h.role === "marketing/marketing-tiktok-strategist")!.status, "declined");
  } finally {
    await t.close();
  }
});

test("catalog_search says specialists have no price — the hirer sets the budget", async () => {
  let out = "";
  let ids = { cmo: "" };
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger === "task" && ctx.agent.id === ids.cmo) out = (await callTool(ctx, "catalog_search", { query: "SEO" })).content;
      return done();
    },
  });
  try {
    ids = { cmo: t.agentByRole("cmo").id };
    rootTask(t, ids.cmo, "Find an SEO specialist");
    await t.drain();
    assert.match(out, /No specialist has a price: the new hire's monthly model budget is set when hiring \(hire_agent monthlyBudgetUsd\)\./);
  } finally {
    await t.close();
  }
});

// Live (2026-11-07, trc_617b…): the CMO hired on T-229, then a round-2 task of the same objective
// (T-231) asked the Board for the same specialist again; the budget was $8 though the Board said $10.
test("one hire per role per objective; someone on the team already in the role gets the work; the request's budget is the budget", async () => {
  const results: Record<string, { ok: boolean; content: string }> = {};
  let ids = { cmo: "", a: "", b: "" };
  const t = await createTestApp({
    env: { HIRING_REQUIRES_APPROVAL: "false" },
    brain: async (ctx) => {
      if (ctx.input.trigger !== "task" || ctx.agent.id !== ids.cmo) return ctx.input.trigger === "task" && ctx.input.task.parentTaskId === null ? { outcome: "waiting", output: "Waiting." } : done();
      const id = ctx.input.task.id;
      if (id === ids.a) {
        results.lower = await callTool(ctx, "hire_agent", { ...HIRE, firstTask: undefined, monthlyBudgetUsd: 8 });
        results.a = await callTool(ctx, "hire_agent", { catalogId: HIRE.catalogId, justification: "SEO for the launch page." });
      }
      if (id === ids.b) results.b = await callTool(ctx, "hire_agent", { catalogId: HIRE.catalogId, monthlyBudgetUsd: 10, justification: "SEO for the launch page." });
      return done();
    },
  });
  try {
    const { platform } = t.app;
    const cmo = t.agentByRole("cmo");
    const root = platform.tasks.createRoot({ title: "Hire an SEO specialist", description: "We need an SEO specialist in Marketing. Hire one from the specialist catalog with a $10 monthly budget.", assigneeId: cmo.id });
    const sub = (title: string) => platform.tasks.createSubtask({ parent: root, traceId: root.traceId, assigneeId: cmo.id, createdBy: cmo.id, title, description: title });
    const a = sub("Recommend and hire the SEO specialist");
    const b = sub("CMO hires SEO specialist and assigns keyword brief");
    ids = { cmo: cmo.id, a: a.id, b: b.id };
    await t.drain();
    assert.equal(results.lower!.ok, false);
    assert.match(results.lower!.content, /^The request sets a \$10 monthly budget for this hire\. Call hire_agent again with monthlyBudgetUsd 10 \(not 8\)\./);
    assert.equal(results.a!.ok, true, results.a!.content);
    assert.match(results.a!.content, /with a \$10\/month budget/, "no budget given: the request's");
    assert.equal(results.b!.ok, false);
    assert.match(results.b!.content, new RegExp(`^Already done on this objective: .* \\(${HIRE.catalogId.replace("/", "\\/")}, agt_\\w+\\) has joined \\(on T-${a.number}\\)\\. Do not hire again`));
    const seo = platform.org.listActiveAgents().filter((x) => x.catalogId === HIRE.catalogId);
    assert.equal(seo.length, 1);

    // A later objective: the role is already on the CMO's team.
    let later: { ok: boolean; content: string } | null = null;
    let extra: { ok: boolean; content: string } | null = null;
    const other = platform.tasks.createRoot({ title: "Hire for the blog", description: "Hire an SEO specialist for the blog.", assigneeId: cmo.id });
    ids = { cmo: cmo.id, a: "", b: other.id };
    t.brain.script = async (ctx) => {
      if (ctx.input.trigger === "task" && ctx.input.task.id === other.id) {
        later = await callTool(ctx, "hire_agent", { catalogId: HIRE.catalogId, justification: "Blog SEO." });
        extra = await callTool(ctx, "hire_agent", { catalogId: HIRE.catalogId, justification: "The Board asked for a second SEO specialist for the blog.", additional: true });
      }
      return done();
    };
    await t.drain();
    assert.equal(later!.ok, false);
    assert.match(later!.content, new RegExp(`^${seo[0]!.name} \\(SEO Specialist, ${seo[0]!.id}\\) already holds ${HIRE.catalogId.replace("/", "\\/")} on your team\\. Give them the work instead of hiring again\\.`));
    assert.equal(extra!.ok, true, "an explicit second hire is still possible");
  } finally {
    await t.close();
  }
});

test("helpers: a recommendation step is not a hiring request; the request's monthly budget", async () => {
  const { isHiringRequest } = await import("../../src/cognition/brain/metacognition/solving-evaluation.ts");
  const { requestedMonthlyBudget } = await import("../../src/tools/builtins/hiring.ts");
  assert.equal(isHiringRequest("Recruiter recommends SEO specialist from catalog\nHave Jasmine Lee (People recruiter) find one."), false);
  assert.equal(isHiringRequest("CMO hires SEO specialist and assigns keyword brief"), true);
  assert.equal(isHiringRequest("Recruit an SEO specialist"), true);
  assert.equal(requestedMonthlyBudget("Jasmine should hire one from the specialist catalog with a $10 monthly budget, and give them a first task."), 10);
  assert.equal(requestedMonthlyBudget("Hire a writer at $12.50/month."), 12.5);
  assert.equal(requestedMonthlyBudget("A $10 per month SEO tool and a $20 monthly hire."), null, "two figures: not for us to pick");
  assert.equal(requestedMonthlyBudget("Hire an SEO specialist."), null);
});

// Live (2026-11-07, trc_617b…): the recruiter spent 25 tool calls hunting memory and the blackboard for
// who hired the SEO specialist and at what budget, and could not look up an agent id.
test("the directory shows who hired someone, when, their budget and catalog role; ids are looked up, removed ones too", async () => {
  const out: Record<string, string> = {};
  let ids = { cmo: "", worker: "" };
  const t = await createTestApp({
    env: { HIRING_REQUIRES_APPROVAL: "false" },
    brain: async (ctx) => {
      if (ctx.input.trigger === "task" && ctx.agent.id === ids.cmo) await callTool(ctx, "hire_agent", { catalogId: HIRE.catalogId, monthlyBudgetUsd: 10, justification: "SEO." });
      return done();
    },
  });
  try {
    const { platform } = t.app;
    const cmo = t.agentByRole("cmo");
    const worker = t.agentByRole("backend-engineer");
    ids = { cmo: cmo.id, worker: "" };
    rootTask(t, cmo.id, "Hire an SEO specialist");
    await t.drain();
    const gone = platform.org.createAgent({ title: "Content Creator", departmentId: cmo.departmentId, managerId: cmo.id, tier: "worker", name: "Casey Diaz" }, "human");
    platform.org.destroyAgent(gone.id);
    ids = { cmo: "", worker: worker.id };
    t.reflex.script = async (ctx) => {
      if (ctx.input.trigger !== "task" || ctx.agent.id !== ids.worker) return done();
      for (const q of ["seo-specialist", cmo.id, gone.id]) out[q] = (await callTool(ctx, "company_directory", { query: q })).content;
      return done();
    };
    rootTask(t, worker.id, "Who hired the SEO specialist?");
    await t.drain();
    const today = new Date().toISOString().slice(0, 10);
    assert.match(out["seo-specialist"]!, new RegExp(`^1 person matching "seo-specialist":\\n- .* — SEO Specialist, Marketing \\(reports to ${cmo.name}\\) — id agt_\\w+ — joined ${today}, hired by ${cmo.name}, \\$10/month model budget, catalog role marketing/marketing-seo-specialist$`));
    assert.match(out[cmo.id]!, new RegExp(`^1 person matching "${cmo.id}":\\n- ${cmo.name} — Chief Marketing Officer, .* hired by the founding team`));
    assert.match(out[gone.id]!, new RegExp(`^${gone.id} was Casey Diaz \\(Content Creator, Marketing\\), removed ${today} — no longer in the company\\.$`));
  } finally {
    await t.close();
  }
});
