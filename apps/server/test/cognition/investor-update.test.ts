// 2026-11-08 — two traces from the founder's tests:
//
// trc_6ee6… "Email our investors this month's update" ($1.45, 10 tasks): the CEO put "goal attainment
// 26%", later "35%", in the update — her own OKR gauge, which the platform moves as she finishes
// tasks; the figures were handed to the General Counsel instead of Finance; Eva re-reviewed edits she
// had just made; the CEO's fix started its own edit → re-review → redo cycle; the opening note read
// "email account.."; and "Send the update" was listed three times in the final report.
//
// trc_ba61… "compare the pricing pages … using Firecrawl" ($0.71): agents were told colleagues can
// "search and read the web", never that the company has Firecrawl or who holds it, so the CEO's first
// reply made a Firecrawl account a possible Board step; and the fix inside the CEO's fix went another
// round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrainEngine, openedReply, sameStep, uniqueSteps, withBoardSteps } from "../../src/cognition/brain/index.ts";
import { fieldOwners, insideFix } from "../../src/cognition/brain/metacognition/cognitive-control.ts";
import { coerceProblem } from "../../src/cognition/brain/metacognition/target-understanding.ts";
import { renderCharter } from "../../src/cognition/brain/self-management/identity.ts";
import { limitsLine, realBoardSteps, servicesLine, type ConnectedService } from "../../src/org/capabilities.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import { readContext, readStage } from "../../src/models/protocol.ts";
import type { EngineResult, ModelProvider, SavedFiles } from "../../src/contracts.ts";
import type { Agent, Task } from "../../../../packages/shared/src/index.ts";
import { FakePlatform, makeAgent, makeTask, taskInput } from "./fakes.ts";

const BRAIN_TOOLS = ["delegate_task", "send_message", "escalate", "ask_human", "memory_search", "memory_write", "workspace_write_file", "blackboard_write"];

type Reply = (ctx: Record<string, unknown>, n: number) => unknown;

function provider(json: Record<string, Reply>): ModelProvider {
  const mock = new MockProvider({ latencyMs: 0 });
  const counts = new Map<string, number>();
  return {
    name: "mock",
    async complete(profile, request, signal) {
      const r = await mock.complete(profile, request, signal);
      if (request.responseFormat !== "json") return r;
      const stage = readStage(request.messages) ?? "";
      const n = (counts.get(stage) ?? 0) + 1;
      counts.set(stage, n);
      const f = json[stage];
      const v = f ? f(readContext(request.messages), n) : undefined;
      return v === undefined ? r : { ...r, content: typeof v === "string" ? v : JSON.stringify(v) };
    },
  };
}

const CANDIDATES = [
  { name: "high_cost", approach: "thorough", estCostUsd: 5, expectedValue: 100, meetsCriteria: true },
  { name: "low_cost", approach: "same scope, cheaper", estCostUsd: 0.01, expectedValue: 900, meetsCriteria: true },
  { name: "low_effort", approach: "smallest change", estCostUsd: 0.02, expectedValue: 100, meetsCriteria: true },
];
const part = (title: string, assigneeId: string, extra: Record<string, unknown> = {}) => ({ title, description: `${title}.`, assigneeId, value: 300, estCostUsd: 0.05, acceptanceCriteria: "Done and saved.", ...extra });

function company(p: FakePlatform, options: { secondAnalyst?: boolean } = {}) {
  p.addDepartment("dep_exec", "executive", "Executive");
  p.addDepartment("dep_fin", "finance", "Finance");
  p.addDepartment("dep_legal", "legal", "Legal & Compliance");
  const brain = (id: string, name: string, title: string, departmentId: string, managerId: string | null, mission: string): Agent =>
    p.addAgent(makeAgent({ id, name, title, departmentId, managerId, tier: "executive", cognition: "brain", modelTier: "frontier", tools: BRAIN_TOOLS, identity: { mission } as never }));
  const worker = (id: string, name: string, title: string, departmentId: string, managerId: string): Agent =>
    p.addAgent(makeAgent({ id, name, title, departmentId, managerId, tier: "worker", cognition: "reflex", modelTier: "economy", tools: ["workspace_write_file", "complete_task"], identity: { mission: "Draft contracts and reviews." } as never }));
  const ceo = brain("agt_ceo", "Ava Chen", "Chief Executive Officer", "dep_exec", null, "Set direction and deliver the Board's objectives.");
  const cfo = brain("agt_cfo", "Elena Petrova", "Chief Financial Officer", "dep_fin", ceo.id, "Own finance, budget and the company's numbers.");
  const gc = brain("agt_gc", "Victoria Hughes", "General Counsel", "dep_legal", ceo.id, "Own legal review, contracts and compliance.");
  const eva = worker("agt_eva", "Eva Schmidt", "Contracts Analyst", "dep_legal", gc.id);
  const sam = options.secondAnalyst ? worker("agt_sam", "Sam Ortiz", "Compliance Analyst", "dep_legal", gc.id) : null;
  return { ceo, cfo, gc, eva, sam };
}

const apply = (task: Task, r: EngineResult) => {
  if (r.taskState) task.state = { ...task.state, ...r.taskState };
};

test("the OKR gauge is shown as a gauge, never as '35% of quarterly goal', and figures need a source", () => {
  const agent = makeAgent({
    id: "agt_ceo",
    name: "Ava Chen",
    title: "Chief Executive Officer",
    tier: "executive",
    cognition: "brain",
    identity: { mission: "Deliver.", okrs: [{ objective: "Run an honest, frugal company", keyResults: [{ description: "Improve goal attainment", target: 100, current: 35, unit: "% of quarterly goal" }] }] } as never,
  });
  const charter = renderCharter(agent, { department: "Executive", departmentSlug: "executive" });
  assert.match(charter, /OKRs \(a private gauge the platform moves as you finish tasks — not a measured company result: never quote it as a figure\): Run an honest, frugal company \[Improve goal attainment: gauge 35\/100\]/);
  assert.doesNotMatch(charter, /35\/100%|% of quarterly goal/);
  assert.match(charter, /Company figures come only from a file, a tool result or the Board, named as the source; with none, say the figure is not available yet — never estimate one/);
});

test("a part about the numbers goes to Finance, not the General Counsel the plan suggested; the legal review stays with Legal", async () => {
  const plan = {
    mode: "delegate",
    subprocesses: [
      part("Confirm figures, finalize draft and recipient list", "agt_gc"),
      part("Legal review of the final draft", "agt_gc", { round: 2 }),
    ],
    candidates: CANDIDATES,
    rationale: "Figures, then legal.",
  };
  const p = new FakePlatform({ providers: { mock: provider({ "metacognition.cognitive_control": () => plan }) } });
  const { ceo, cfo, gc } = company(p);
  const task = p.addTask(makeTask({ id: "tsk_260", number: 260, title: "Draft the monthly investor update", description: "Email our investors this month's update.", assigneeId: ceo.id, value: 800, estCostUsd: 0.5 }));
  const r = await new BrainEngine().run(p.context(ceo, taskInput(task)));
  assert.equal(r.outcome, "waiting", r.error ?? r.output);
  apply(task, r);
  assert.deepEqual(p.tasks.children(task.id).map((c) => [c.title, c.assigneeId]), [["Confirm figures, finalize draft and recipient list", cfo.id]]);
  const saved = (task.state.plan as { subprocesses: { title: string; assigneeId: string }[] }).subprocesses;
  assert.equal(saved.find((s) => s.title === "Legal review of the final draft")!.assigneeId, gc.id);

  // The rule itself: titles that name no one; never inside Finance's own plan.
  const cands = [cfo, gc].map((agent) => ({ agent, departmentName: p.departments.get(agent.departmentId)!.name, catalogProfile: null }));
  assert.deepEqual(fieldOwners("Verify the 26% and 14% figures", cands, "Executive"), [cfo.id]);
  assert.deepEqual(fieldOwners("Q4 budget vs spend", cands, "Executive"), [cfo.id]);
  assert.deepEqual(fieldOwners("Legal review of the final draft", cands, "Executive"), []);
  assert.deepEqual(fieldOwners("Verify the figures", cands, "Finance"), []);
});

test("a review never goes to whoever did the work: with no one else in that field, the Legal head reviews it herself", async () => {
  const plan = {
    mode: "delegate",
    subprocesses: [
      part("Apply Legal's eight edits to investor-updates/2026-11-investor-update.md", "agt_eva"),
      part("Re-review the edited draft and save the Legal verdict", "agt_eva", { round: 2 }),
    ],
    candidates: CANDIDATES,
    rationale: "Edit, then re-review.",
  };
  const p = new FakePlatform({ providers: { mock: provider({ "metacognition.cognitive_control": () => plan }) } });
  const { gc, eva } = company(p);
  const task = p.addTask(makeTask({ id: "tsk_273", number: 273, title: "Apply Legal's edits and re-review the saved draft", description: "Apply the eight edits and re-review.", assigneeId: gc.id, value: 600, estCostUsd: 0.3 }));
  const r = await new BrainEngine().run(p.context(gc, taskInput(task)));
  assert.equal(r.outcome, "waiting", r.error ?? r.output);
  apply(task, r);
  assert.deepEqual(p.tasks.children(task.id).map((c) => c.assigneeId), [eva.id]);
  const saved = (task.state.plan as { subprocesses: { title: string }[] }).subprocesses;
  assert.deepEqual(saved.map((s) => s.title), ["Apply Legal's eight edits to investor-updates/2026-11-investor-update.md"], "the self-review is not planned: Victoria reviews on resume");
  const arranged = p.tracer.spans.find((s) => s.attributes["agentco.role_arrangement.independent_review"]);
  assert.match(String(arranged?.attributes["agentco.role_arrangement.independent_review"]), /Eva Schmidt wrote it → left for the leader/);
});

test("…and with a second analyst, the review goes to them", async () => {
  const plan = {
    mode: "delegate",
    subprocesses: [part("Apply Legal's eight edits", "agt_eva"), part("Re-review the edited draft and save the Legal verdict", "agt_eva", { round: 2 })],
    candidates: CANDIDATES,
    rationale: "Edit, then re-review.",
  };
  const p = new FakePlatform({ providers: { mock: provider({ "metacognition.cognitive_control": () => plan }) } });
  const { gc, sam } = company(p, { secondAnalyst: true });
  const task = p.addTask(makeTask({ id: "tsk_273", number: 273, title: "Apply Legal's edits and re-review the saved draft", description: "Apply the eight edits and re-review.", assigneeId: gc.id, value: 600, estCostUsd: 0.3 }));
  const r = await new BrainEngine().run(p.context(gc, taskInput(task)));
  apply(task, r);
  const saved = (task.state.plan as { subprocesses: { title: string; assigneeId: string }[] }).subprocesses;
  assert.equal(saved.find((s) => s.title.startsWith("Re-review"))!.assigneeId, sam!.id);
});

test("a review of a file someone saved on this objective does not go to its author", async () => {
  const plan = { mode: "delegate", subprocesses: [part("Draft legal review of investor-updates/2026-11-investor-update.md", "agt_eva")], candidates: CANDIDATES, rationale: "Eva drafts the review." };
  const p = new FakePlatform({ providers: { mock: provider({ "metacognition.cognitive_control": () => plan }) } });
  const { gc, eva } = company(p);
  const task = p.addTask(makeTask({ id: "tsk_270", number: 270, title: "Legal review of the final draft", description: "Review investor-updates/2026-11-investor-update.md.", assigneeId: gc.id, value: 600, estCostUsd: 0.3 }));
  const drive: SavedFiles = {
    written: (traceId) => (traceId === task.traceId ? [{ agentId: eva.id, taskId: "tsk_267", display: "shared/investor-updates/2026-11-investor-update.md", at: "2026-11-07T16:45:33.000Z" }] : []),
    read: () => ({ content: "# Investor update", truncated: false }),
    recent: () => [],
  };
  (p as unknown as { drive: SavedFiles }).drive = drive;
  const r = await new BrainEngine().run(p.context(gc, taskInput(task)));
  assert.equal(p.tasks.children(task.id).filter((c) => c.assigneeId === eva.id).length, 0, `Eva wrote the draft (${r.outcome})`);
  const arranged = p.tracer.spans.find((s) => s.attributes["agentco.role_arrangement.independent_review"]);
  assert.match(String(arranged?.attributes["agentco.role_arrangement.independent_review"]), /Eva Schmidt wrote it/);
});

test("a fix handed down is the fix round: whoever gets it reports what is still short instead of starting another round", async () => {
  const verdict = { score: 0.5, truthful: 0.9, good: false, issues: ["the 35% figure has no source"], openPoints: [], decision: "revise", summary: "Seven of eight edits applied." };
  const plan = { mode: "delegate", subprocesses: [part("Apply Legal's eight edits", "agt_eva")], candidates: CANDIDATES, rationale: "Eva edits." };
  const fixPlan = { mode: "delegate", subprocesses: [part("Mark the goal-attainment figure as not available", "agt_eva")], candidates: CANDIDATES, rationale: "One fix." };
  const run = async (title: string) => {
    const p = new FakePlatform({ providers: { mock: provider({ "metacognition.cognitive_control": (_c, n) => (n === 1 ? plan : fixPlan), "metacognition.solving_evaluation.feedback": () => verdict }) } });
    const { ceo, gc } = company(p);
    const parent = p.addTask(makeTask({ id: "tsk_260", number: 260, title: "Draft the monthly investor update", assigneeId: ceo.id }));
    const task = p.addTask(makeTask({ id: "tsk_273", number: 273, title, description: "Apply the eight edits.", assigneeId: gc.id, parentTaskId: parent.id, rootTaskId: parent.id, value: 600, estCostUsd: 0.3 }));
    const brain = new BrainEngine({ maxRevisions: 2 });
    apply(task, await brain.run(p.context(gc, taskInput(task))));
    for (const c of p.tasks.children(task.id)) {
      c.status = "done";
      c.result = "PARTIAL: seven of the eight edits are applied; the 35% figure has no source, so I did not insert it.";
    }
    const r = await brain.run(p.context(gc, taskInput(task, "subtasks_completed", { subtasks: p.tasks.children(task.id) })));
    return { r, children: p.tasks.children(task.id).length, titles: p.tasks.children(task.id).map((c) => c.title) };
  };
  const fix = await run("Fix: apply Legal's eight edits and re-review the saved draft");
  assert.equal(fix.r.outcome, "completed", fix.r.error ?? fix.r.output);
  assert.equal(fix.children, 1, "no second fix round under the fix");
  assert.match(fix.r.output, /## Open points for the Board\n- the 35% figure has no source/);
  const ordinary = await run("Apply Legal's eight edits and re-review the saved draft");
  assert.equal(ordinary.r.outcome, "waiting", "an ordinary task still gets its one round of fixes");
  assert.equal(ordinary.children, 2);
  assert.equal(ordinary.titles[1], "Fix: Mark the goal-attainment figure as not available", "a part handed out in a fix round is titled as a fix");

  const tasks = new Map<string, { title: string; parentTaskId: string | null }>([
    ["a", { title: "Draft the monthly investor update", parentTaskId: null }],
    ["b", { title: "Fix: apply the edits", parentTaskId: "a" }],
    ["c", { title: "Re-review the draft", parentTaskId: "b" }],
  ]);
  assert.equal(insideFix(tasks.get("c")!, (id) => tasks.get(id) ?? null), true, "anything under a fix is part of it");
  assert.equal(insideFix(tasks.get("a")!, (id) => tasks.get(id) ?? null), false);
});

test("Board steps: one period, said once, not repeated as open points", () => {
  assert.equal(
    openedReply({ number: 260, title: "Draft the monthly investor update" }, ["Send the monthly investor update to the investors from the email account."]),
    "Opened T-260: Draft the monthly investor update. I'll work it through and report back here when it's done. One thing up front: this company can't do this step, so it is left to you: Send the monthly investor update to the investors from the email account. I'll prepare everything up to it.",
  );
  assert.ok(sameStep("Send the update to the investors.", "Send the monthly investor update to the investors from the email account."));
  assert.ok(!sameStep("Supply investor names and email addresses for the recipient list.", "Send the monthly investor update to the investors from the email account."));
  assert.deepEqual(uniqueSteps(["Send the update to the investors.", "Send the monthly investor update to the investors from the email account.", "Sign the lease."]), [
    "Send the monthly investor update to the investors from the email account.",
    "Sign the lease.",
  ]);
  const out = withBoardSteps("# Done", ["Send the update to the investors.", "Send the monthly investor update to the investors from the email account."], true);
  assert.equal(out.match(/^- /gm)?.length, 1);
  assert.match(out, /This company can't do this, so it is yours to do:\n- Send the monthly investor update to the investors from the email account\.$/);
});

test("a connected service is named with who holds it, and never becomes a Board step", () => {
  const services: ConnectedService[] = [
    { name: "firecrawl", grants: ["web"], holders: ["Morgan Patel", "Kenji Tanaka"] },
    { name: "github", grants: ["git"], holders: [] },
  ];
  assert.equal(
    servicesLine(services),
    "Connected services the company already has: firecrawl (search and read the web) — Morgan Patel, Kenji Tanaka. A request that names one is work the company can do — give that part to someone who has it (or their manager); it is never a Board step.",
  );
  assert.match(limitsLine(new Set(["web"]), new Set(), services), /Colleagues with the right tools can: search and read the web — delegate or ask them\. Connected services the company already has: firecrawl/);
  assert.deepEqual(realBoardSteps(["If Firecrawl needs a new outside account or payment, the Board must set it up.", "Send the update to the investors."], services), ["Send the update to the investors."]);
  assert.deepEqual(realBoardSteps(["Set up a Firecrawl account and pay for it."], services), []);

  const problem = coerceProblem(
    {
      title: "Compare pricing of the top 3 AI meeting-notes apps",
      problem: "A sourced pricing comparison.",
      successCriteria: ["research/competitors.md compares three apps with a link to every source"],
      boardSteps: ["If Firecrawl needs a new outside account or payment, the Board must set it up; otherwise Olivia will use public web reading tools instead."],
    },
    "Compare pricing",
    "work",
    new Set(["web"]),
    services,
  );
  assert.deepEqual(problem.boardSteps, []);
});
