import { test } from "node:test";
import assert from "node:assert/strict";
import { BrainEngine } from "../../src/cognition/brain/index.ts";
import { createEngines } from "../../src/cognition/index.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import { readContext, readStage } from "../../src/models/protocol.ts";
import type { EngineResult, ModelProvider } from "../../src/contracts.ts";
import type { Agent, Task } from "../../../../packages/shared/src/index.ts";
import { FakePlatform, makeAgent, makeTask, messageInput, taskInput } from "./fakes.ts";

const BRAIN_TOOLS = ["delegate_task", "send_message", "escalate", "ask_human", "memory_search", "memory_write", "workspace_write_file", "blackboard_write"];
const WORKER_TOOLS = ["workspace_write_file", "memory_search", "escalate"];

type Override = (ctx: Record<string, unknown>, n: number) => unknown;

/** Mock provider with per-stage JSON overrides (string → raw content). */
function withOverrides(overrides: Record<string, Override>, allJson?: (stage: string) => string | null): ModelProvider {
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
      const raw = allJson?.(stage);
      if (raw !== undefined && raw !== null) return { ...r, content: raw };
      const f = overrides[stage];
      if (!f) return r;
      const v = f(readContext(request.messages), n);
      if (v === undefined) return r;
      return { ...r, content: typeof v === "string" ? v : JSON.stringify(v) };
    },
  };
}

function company(options: { providers?: Record<string, ModelProvider> } = {}) {
  const p = new FakePlatform({ providers: options.providers });
  p.addDepartment("dep_exec", "executive", "Executive");
  p.addDepartment("dep_mkt", "marketing", "Marketing");
  p.addDepartment("dep_fin", "finance", "Finance");
  p.addDepartment("dep_eng", "engineering", "Engineering");
  const exec = (id: string, name: string, title: string, departmentId: string, managerId: string | null, mission: string): Agent =>
    p.addAgent(makeAgent({ id, name, title, departmentId, managerId, tier: "executive", cognition: "brain", modelTier: "frontier", tools: BRAIN_TOOLS, identity: { mission } as never }));
  const worker = (id: string, name: string, title: string, departmentId: string, managerId: string, mission: string): Agent =>
    p.addAgent(makeAgent({ id, name, title, departmentId, managerId, tools: WORKER_TOOLS, identity: { mission } as never }));
  const ceo = exec("agt_ceo", "Ava Chen", "Chief Executive Officer", "dep_exec", null, "Set direction and deliver the Board's objectives.");
  const cmo = exec("agt_cmo", "Maya Ortiz", "Chief Marketing Officer", "dep_mkt", ceo.id, "Own marketing, brand, positioning and launch campaigns.");
  const cfo = exec("agt_cfo", "Raj Patel", "Chief Financial Officer", "dep_fin", ceo.id, "Own finance, budget, pricing and unit economics.");
  const cto = exec("agt_cto", "Lena Fischer", "Chief Technology Officer", "dep_eng", ceo.id, "Own engineering, architecture and platform delivery.");
  worker("agt_mw", "Sam Lee", "Content Marketer", "dep_mkt", cmo.id, "Write launch content and marketing campaigns.");
  worker("agt_fw", "Kim Wu", "Financial Analyst", "dep_fin", cfo.id, "Build budgets, pricing models and financial analysis.");
  worker("agt_ew", "Ola Berg", "Backend Engineer", "dep_eng", cto.id, "Build and ship backend services and engineering plans.");
  return { p, ceo, cmo, cfo, cto };
}

const LAUNCH = "Plan and prepare the launch of our first product, an AI meeting-notes app. Write a launch plan with marketing, engineering and finance input.";

function rootTask(p: FakePlatform, assigneeId: string, title = "Launch plan for the AI meeting-notes app", description = LAUNCH, attempts?: number): Task {
  return p.addTask(makeTask({ id: `tsk_${Math.random().toString(36).slice(2, 8)}`, number: 7, title, description, assigneeId, value: 800, estCostUsd: 0.5, ...(attempts !== undefined ? { attempts } : {}) }));
}

function apply(task: Task, r: EngineResult): void {
  if (r.taskState) task.state = { ...task.state, ...r.taskState };
}

const brain = () => new BrainEngine({ maxRevisions: 2, runTimeoutMs: 300_000 });

test("brain: message → chat reply (no task) vs work → objective with the run's traceId + parentSpanId", async () => {
  const { p, ceo } = company();
  const chatCtx = p.context(ceo, messageInput("Hi there! How are you today?"));
  const chat = await brain().run(chatCtx);
  assert.equal(chat.outcome, "completed");
  assert.match(chat.output, /Ava Chen/);
  assert.equal(p.taskMap.size, 0);
  assert.ok(p.tracer.byKind("llm").some((s) => s.attributes["agentco.stage"] === "chat.reply" && s.attributes["agentco.tier"] === "standard"));

  const workCtx = p.context(ceo, messageInput(LAUNCH), { traceId: "trc_board" });
  const work = await brain().run(workCtx);
  assert.equal(work.outcome, "completed");
  assert.match(work.output, /^Opened T-\d+: /);
  const [objective] = [...p.taskMap.values()];
  assert.ok(objective);
  assert.equal(objective.traceId, "trc_board");
  assert.equal(objective.state.objectiveParentSpanId, workCtx.span.spanId);
  assert.equal(objective.assigneeId, ceo.id);
  assert.equal(objective.originConversationId, "cnv_board");
  // Every block span carries its diagram block id; the chat path walks Target Understanding.
  const blocks = p.tracer.blocks();
  for (const b of ["self_management.identity.self_identity", "metacognition.target_understanding.problem_definition", "metacognition.target_understanding.literature_review", "todo_list"]) {
    assert.ok(blocks.includes(b), `visited ${b}`);
  }
  assert.ok(p.activity.some((a) => a.block === "metacognition.target_understanding.problem_definition"));
});

test("brain: task → delegates to direct reports (Role Arrangement) → waiting, plan persisted", async () => {
  const { p, ceo, cmo, cfo, cto } = company();
  const task = rootTask(p, ceo.id);
  const ctx = p.context(ceo, taskInput(task));
  const r = await brain().run(ctx);
  assert.equal(r.outcome, "waiting", r.error ?? r.output);
  const children = p.tasks.children(task.id);
  assert.ok(children.length >= 1 && children.length <= 4);
  for (const c of children) assert.ok([cmo.id, cfo.id, cto.id].includes(c.assigneeId!), "assignees are real direct reports");
  assert.ok(children.some((c) => c.assigneeId === cmo.id), "marketing work goes to the CMO");
  const plan = (r.taskState?.plan ?? {}) as Record<string, unknown>;
  assert.equal(plan.mode, "delegate");
  assert.ok(["high_cost", "low_cost", "low_effort"].includes(String(plan.chosen)));
  assert.equal((plan.subprocesses as unknown[]).length, children.length);
  assert.ok((p.tasks.get(task.id)!.state.plan as Record<string, unknown>).problem, "plan persisted via patchState before solving");
  // Trace: phases + blocks + delegation spans; every stage span is a block or a phase.
  const names = new Set(p.tracer.spans.map((s) => s.name));
  for (const n of ["brain.target_understanding", "brain.confidence", "brain.planning", "brain.solving"]) assert.ok(names.has(n), n);
  for (const s of p.tracer.byKind("stage")) assert.ok(s.attributes["agentco.brain.block"] || s.attributes["agentco.brain.phase"], `${s.name} tagged`);
  assert.equal(p.tracer.byKind("delegation").length, children.length);
  const blocks = new Set(p.tracer.blocks());
  for (const b of [
    "todo_list",
    "self_management.identity.desire",
    "self_management.identity.motivation",
    "metacognition.target_understanding.analysis",
    "metacognition.self_ability",
    "metacognition.monitoring.ood",
    "metacognition.monitoring.calibration",
    "metacognition.confidence",
    "metacognition.project_management.data_driven_analysis",
    "metacognition.cognitive_control.decomposition",
    "self_management.role_arrangement",
    "metacognition.cognitive_control.candidate_solutions",
    "metacognition.project_management.economic_concepts",
    "metacognition.solving_evaluation.solving",
  ])
    assert.ok(blocks.has(b), `visited ${b}`);
  // Stage routing: cheap stages on cheap tiers, planning on the agent's tier.
  const tierOf = (stage: string) => p.tracer.byKind("llm").find((s) => s.attributes["agentco.stage"] === stage)?.attributes["agentco.tier"];
  assert.equal(tierOf("metacognition.target_understanding.problem_definition"), "economy");
  assert.equal(tierOf("metacognition.target_understanding.analysis"), "standard");
  assert.equal(tierOf("metacognition.confidence"), "economy");
  assert.equal(tierOf("metacognition.cognitive_control"), "frontier");
  // llm spans hang under block spans.
  const stageIds = new Set(p.tracer.byKind("stage").map((s) => s.id));
  for (const s of p.tracer.byKind("llm")) assert.ok(stageIds.has(s.parentSpanId!), "llm under a block");
});

test("brain: subtasks_completed → evaluation → completed; learning writes memory, calibration and affect", async () => {
  const { p, ceo } = company();
  ceo.calibration = { samples: 2, meanConfidence: 0.7, successRate: 1, brier: 0.09 }; // 3rd report → narrative due
  const task = rootTask(p, ceo.id);
  const first = await brain().run(p.context(ceo, taskInput(task)));
  apply(task, first);
  const children = p.tasks.children(task.id);
  for (const c of children) {
    c.status = "done";
    c.result = `Deliverable for ${c.title}: positioning, budget, milestones, owners and risks for the launch.`;
  }
  const ctx = p.context(ceo, taskInput(task, "subtasks_completed", { subtasks: children }));
  const r = await brain().run(ctx);
  assert.equal(r.outcome, "completed", r.error ?? "");
  assert.ok(r.output.length > 200);
  assert.match(r.output, /## Contributions/);
  const names = new Set(p.tracer.spans.map((s) => s.name));
  assert.ok(names.has("brain.evaluation") && names.has("brain.report"));
  const blocks = new Set(p.tracer.blocks());
  for (const b of [
    "metacognition.solving_evaluation.feedback",
    "metacognition.monitoring.truthful_efficient_good",
    "self_management.human_nature",
    "self_management.sensibility_emotion",
    "metacognition.project_management.online_learning",
    "global_memory.episodic",
    "global_memory.procedural",
    "self_management.identity.self_narrative",
  ])
    assert.ok(blocks.has(b), `visited ${b}`);
  assert.ok(p.memories.some((m) => m.kind === "procedural" && m.scope === "agent" && m.agentId === ceo.id), "procedural lesson");
  assert.ok(p.memories.some((m) => m.kind === "episodic" && /cost \$/.test(m.content)), "episode with cost for data-driven analysis");
  assert.ok(p.memories.some((m) => m.kind === "procedural" && m.scope === "global"), "executive shares the lesson");
  const patch = p.patches.at(-1)!.patch;
  assert.equal(patch.calibration?.samples, 3);
  assert.ok((patch.affect?.valence ?? 0) > 0, "finished processes lift valence");
  assert.ok(patch.narrative && patch.narrative.length > 20, "narrative refreshed (every 3rd report)");
  assert.equal((r.taskState as Record<string, unknown>).checkpoint, null);
  assert.ok(p.board.has(`objective:T-${task.number}`), "status posted to the blackboard");
});

test("brain: low calibrated confidence → early stop → blocked with the Board approval (CEO)", async () => {
  const provider = withOverrides({ "metacognition.confidence": () => ({ confidence: 0.1, uncertainty: 0.9, risks: ["no data"] }) });
  const { p, ceo } = company({ providers: { mock: provider } });
  const task = rootTask(p, ceo.id);
  const r = await brain().run(p.context(ceo, taskInput(task)));
  assert.equal(r.outcome, "blocked");
  assert.ok(r.approvalId);
  assert.equal(r.approvalId, p.approvals[0]!.id, "approvalId comes from the tool effect");
  assert.equal(p.tasks.children(task.id).length, 0, "nothing delegated");
  const stop = p.tracer.spans.find((s) => s.attributes["agentco.early_stop"] === true);
  assert.ok(stop);
  assert.equal(p.patches.at(-1)!.patch.affect!.frustration > 0, true, "escalation is a process event for Human Nature");
});

test("brain: high frustration forces the early stop; a manager escalates up the chain and waits (outcome waiting)", async () => {
  const { p, cmo, ceo } = company();
  cmo.affect = { valence: -0.4, arousal: 0.5, frustration: 0.8 };
  // A second attempt: frustration only gates a task that has had setbacks of its own.
  const task = rootTask(p, cmo.id, "Launch campaign", "Prepare the launch campaign.", 2);
  const r = await brain().run(p.context(cmo, taskInput(task)));
  assert.equal(r.outcome, "waiting");
  assert.equal(r.approvalId, undefined, "no Board approval for a manager");
  assert.equal(p.sent[0]!.to, ceo.id, "escalated to the manager");
  assert.equal(p.approvals.length, 0);
  const [esc] = p.tasks.children(task.id);
  assert.equal(esc!.assigneeId, ceo.id);
  assert.equal(esc!.state.kind, "escalation");
  assert.equal(esc!.state.escalatedBy, cmo.id);
  const cp = r.taskState?.checkpoint as { block: string; reason: string } | null;
  assert.ok(cp && cp.block === "metacognition.confidence", "checkpointed at the Confidence block");
});

test("brain: frustration from other work does not early-stop a fresh task (no Board/manager question)", async () => {
  const { p, cmo } = company();
  cmo.affect = { valence: -0.4, arousal: 0.5, frustration: 1 };
  const task = rootTask(p, cmo.id, "Launch campaign", "Prepare the launch campaign.");
  const r = await brain().run(p.context(cmo, taskInput(task)));
  assert.equal(p.tasks.children(task.id).filter((c) => c.state.kind === "escalation").length, 0, "no escalation subtask");
  assert.equal(p.approvals.length, 0, "no Board question");
  assert.notEqual(r.outcome, "failed");
  assert.ok(p.tracer.spans.some((s) => s.attributes["agentco.frustration_gate.fresh_task"] === true), "the bypass is traced");
  assert.equal(p.tracer.spans.some((s) => s.attributes["agentco.early_stop"] === true), false);
});

test("brain: escalation answered (subtasks_completed) resumes at the checkpoint with the answer in working memory", async () => {
  const { p, cmo } = company();
  cmo.affect = { valence: -0.4, arousal: 0.5, frustration: 0.8 };
  // A second attempt: frustration only gates a task that has had setbacks of its own.
  const task = rootTask(p, cmo.id, "Launch campaign", "Prepare the launch campaign.", 2);
  const first = await brain().run(p.context(cmo, taskInput(task)));
  assert.equal(first.outcome, "waiting");
  p.tasks.patchState(task.id, first.taskState as Record<string, unknown>);
  const esc = p.tasks.children(task.id)[0]!;
  esc.status = "done";
  esc.result = "Go ahead: target SMB teams first and keep the budget under $2k.";
  const fresh = p.tasks.get(task.id)!;
  const r = await brain().run(p.context(cmo, taskInput(fresh, "subtasks_completed", { subtasks: p.tasks.children(task.id) })));
  assert.equal(p.escalations.length, 1, "does not escalate the same question again");
  assert.notEqual(r.outcome, "failed");
  assert.equal(p.tasks.get(task.id)!.state.checkpoint, null, "checkpoint consumed");
  const resumed = p.tracer.spans.find((s) => s.attributes["agentco.escalation.answered"] === 1);
  assert.ok(resumed, "resume recorded on the run span");
  assert.equal(resumed!.attributes["agentco.resumed_at"], "metacognition.confidence");
});

test("brain: a failed escalation fails the task with the reason instead of looping", async () => {
  const { p, cmo } = company();
  cmo.affect = { valence: -0.4, arousal: 0.5, frustration: 0.8 };
  // A second attempt: frustration only gates a task that has had setbacks of its own.
  const task = rootTask(p, cmo.id, "Launch campaign", "Prepare the launch campaign.", 2);
  const first = await brain().run(p.context(cmo, taskInput(task)));
  p.tasks.patchState(task.id, first.taskState as Record<string, unknown>);
  const esc = p.tasks.children(task.id)[0]!;
  esc.status = "failed";
  esc.error = "No capacity";
  const r = await brain().run(p.context(cmo, taskInput(p.tasks.get(task.id)!, "subtasks_completed", { subtasks: p.tasks.children(task.id) })));
  assert.equal(r.outcome, "failed");
  assert.match(r.error ?? "", /No capacity/);
  assert.equal(p.escalations.length, 1);
});

test("brain: rollback cancels still-open subtasks through platform.tasks.cancel before re-planning", async () => {
  const { p, ceo, cmo } = company();
  const task = rootTask(p, ceo.id);
  const open = p.addTask(makeTask({ id: "tsk_o", number: 8, parentTaskId: task.id, rootTaskId: task.id, title: "Marketing input: launch", assigneeId: cmo.id, status: "in_progress" }));
  const grand = p.addTask(makeTask({ id: "tsk_g", number: 9, parentTaskId: open.id, rootTaskId: task.id, title: "Draft", assigneeId: cmo.id, status: "todo" }));
  const { rollbackRecovery } = await import("../../src/cognition/brain/metacognition/project-management.ts");
  const run = { ctx: p.context(ceo, taskInput(task)), platform: p, agent: ceo, task, wm: {}, visited: [], costUsd: 0, calls: [], insights: [], currentBlock: null, parent: null } as never;
  const kept = await rollbackRecovery(run, "recovery check");
  assert.equal(kept.open.length, 1, "plain inspection never cancels");
  assert.equal(p.cancelled.length, 0);
  const r = await rollbackRecovery(run, "rollback of candidate low_cost: too thin", { cancelOpen: true });
  assert.equal(r.open.length, 0);
  assert.deepEqual(p.cancelled.map((c) => c.taskId), [grand.id, open.id]);
  assert.equal(p.tasks.get(open.id)!.status, "cancelled");
  assert.match(p.cancelled[1]!.reason, /Superseded/);
});

test("brain: conservation mode (safety need low) picks the cheapest candidate and allows no revisions", async () => {
  const { p, ceo } = company();
  p.needsOverride.set(ceo.id, { safety: "low" });
  const task = rootTask(p, ceo.id);
  const r = await brain().run(p.context(ceo, taskInput(task)));
  const plan = (r.taskState?.plan ?? {}) as Record<string, unknown>;
  assert.equal(plan.chosen, "low_effort");
  const econ = p.tracer.spans.find((s) => s.attributes["agentco.brain.block"] === "metacognition.project_management.economic_concepts")!;
  assert.equal(econ.attributes["agentco.conservation"], true);
  const motivation = p.tracer.spans.find((s) => s.attributes["agentco.brain.block"] === "self_management.identity.motivation")!;
  assert.equal(motivation.attributes["agentco.conservation"], true);
});

test("brain: recovery inspects subtasks and never duplicates them", async () => {
  const { p, ceo, cmo } = company();
  const task = rootTask(p, ceo.id);
  p.addTask(makeTask({ id: "tsk_open", number: 8, parentTaskId: task.id, rootTaskId: task.id, title: "Marketing input: launch", assigneeId: cmo.id, status: "in_progress" }));
  const notice = "Run run_x was terminated before it reported a result …";
  const r = await brain().run(p.context(ceo, taskInput(task, "recovery", { recoveryNotice: notice })));
  assert.equal(r.outcome, "waiting");
  assert.equal(p.tasks.children(task.id).length, 1, "no duplicate delegation");
  assert.ok(p.tracer.blocks().includes("metacognition.project_management.rollback_failure_recovery"));
  assert.equal(p.toolCalls.filter((c) => c.name === "delegate_task").length, 0);

  // All children finished before the crash → straight to Feedback on them.
  const open = p.taskMap.get("tsk_open")!;
  open.status = "done";
  open.result = "Marketing plan: positioning, channels, timeline and metrics for the launch.";
  task.state.plan = { problem: "Launch plan", successCriteria: ["a plan"], chosen: "low_cost", mode: "delegate", subprocesses: [], confidence: 0.7 };
  const r2 = await brain().run(p.context(ceo, taskInput(task, "recovery", { recoveryNotice: notice })));
  assert.equal(r2.outcome, "completed", r2.error ?? "");
  assert.equal(p.tasks.children(task.id).length, 1);
});

test("brain: recovery with no subtasks re-plans without duplicating delegations of the same title", async () => {
  const { p, ceo } = company();
  const task = rootTask(p, ceo.id);
  const first = await brain().run(p.context(ceo, taskInput(task)));
  apply(task, first);
  const before = p.tasks.children(task.id).length;
  // Crash after delegating: the children are still open.
  const r = await brain().run(p.context(ceo, taskInput(task, "recovery", { recoveryNotice: "terminated" })));
  assert.equal(r.outcome, "waiting");
  assert.equal(p.tasks.children(task.id).length, before);
});

test("brain: garbage JSON from the model degrades gracefully (no crash)", async () => {
  const provider = withOverrides({}, () => "lol, I am not JSON }{");
  const { p, ceo } = company({ providers: { mock: provider } });
  const task = rootTask(p, ceo.id);
  const r = await brain().run(p.context(ceo, taskInput(task)));
  assert.ok(["completed", "waiting", "blocked", "failed"].includes(r.outcome), r.outcome);
  assert.ok(p.tracer.spans.some((s) => s.attributes["agentco.degraded"] === true), "degraded calls are marked");
  assert.ok(!p.tracer.spans.some((s) => s.kind === "stage" && s.status === "error"), "no block crashed");
  // Message path too.
  const m = await brain().run(p.context(ceo, messageInput("Can you draft a pricing page?")));
  assert.equal(m.outcome, "completed");
});

test("brain (Q3): a low understanding evaluation re-runs Target Understanding WITH its gaps, once", async () => {
  const provider = withOverrides({
    "metacognition.confidence": (_ctx, n) =>
      n === 1 ? { confidence: 0.7, uncertainty: 0.3, understandingEval: { score: 0.2, gaps: ["Which customer segment comes first?"] }, competenceEval: { score: 0.9, gaps: [] } } : undefined,
  });
  const { p, ceo } = company({ providers: { mock: provider } });
  const task = rootTask(p, ceo.id);
  await brain().run(p.context(ceo, taskInput(task)));
  const pd = p.tracer.byKind("llm").filter((s) => s.attributes["agentco.stage"] === "metacognition.target_understanding.problem_definition");
  assert.equal(pd.length, 2, "one fallback pass");
  assert.ok(pd[1]!.input!.includes("Which customer segment comes first?"), "gaps passed to the re-run");
  const blockSpans = p.tracer.spans.filter((s) => s.attributes["agentco.brain.block"] === "metacognition.target_understanding.problem_definition");
  assert.equal(blockSpans[1]!.attributes["agentco.fallback.gaps"], 1);
  assert.equal(p.tracer.byKind("llm").filter((s) => s.attributes["agentco.stage"] === "metacognition.confidence").length, 2);
});

test("brain (Q3): a low competence evaluation re-runs Self-ability with its gaps and applies remedies", async () => {
  const provider = withOverrides({
    "metacognition.confidence": (_ctx, n) =>
      n === 1 ? { confidence: 0.6, uncertainty: 0.4, competenceEval: { score: 0.3, gaps: ["missing domain skill in finance"] } } : undefined,
  });
  const { p, ceo } = company({ providers: { mock: provider } });
  await brain().run(p.context(ceo, taskInput(rootTask(p, ceo.id))));
  const sa = p.tracer.spans.filter((s) => s.attributes["agentco.brain.block"] === "metacognition.self_ability");
  assert.equal(sa.length, 2);
  assert.match(String(sa[1]!.attributes["agentco.remedies"]), /delegate to a report/);
});

test("brain (Q2): constraint pressure lowers confidence and decomposes finer", async () => {
  const { p, ceo } = company();
  p.budgetRemaining = 1; // 10% of the 10 USD monthly budget
  await brain().run(p.context(ceo, taskInput(rootTask(p, ceo.id))));
  const ood = p.tracer.spans.find((s) => s.attributes["agentco.brain.block"] === "metacognition.monitoring.ood")!;
  assert.equal(ood.attributes["agentco.ood.pressure"], "budget");
  const conf = p.tracer.spans.find((s) => s.attributes["agentco.brain.block"] === "metacognition.confidence")!;
  assert.ok(Number(conf.attributes["agentco.pressure_penalty"]) > 0);
  const econ = p.tracer.spans.find((s) => s.attributes["agentco.brain.block"] === "metacognition.project_management.economic_concepts")!;
  assert.equal(econ.attributes["agentco.pressure"], true);
  assert.notEqual(econ.attributes["agentco.chosen"], "high_cost");
});

test("brain (Q2): performance OOD → optimization insight stored by Online Learning, recalled by Data-driven Analysis", async () => {
  const { p } = company();
  // A Chief of Staff with no reports solves directly.
  const cos = p.addAgent(makeAgent({ id: "agt_cos", name: "Noor Haddad", title: "Chief of Staff", departmentId: "dep_exec", managerId: "agt_ceo", tier: "executive", cognition: "brain", modelTier: "frontier", tools: BRAIN_TOOLS }));
  p.profiles.set("metacognition.cognitive_control", { block: "metacognition.cognitive_control", calls: 20, p50Ms: 1, p95Ms: 1_000_000, p95InputTokens: 10, p95OutputTokens: 1_000_000, meanCostUsd: 1, errorRate: 0 });
  const t1 = rootTask(p, cos.id, "Weekly operating review memo", "Write the weekly operating review memo for the leadership team.");
  const r1 = await brain().run(p.context(cos, taskInput(t1)));
  assert.equal(r1.outcome, "completed", r1.error ?? "");
  const insights = p.memories.filter((m) => m.tags.includes("optimization"));
  const perf = insights.find((m) => m.content.includes("[metacognition.cognitive_control]"));
  assert.ok(perf, "performance-OOD insight stored");
  assert.match(perf.content, /^optimization insight \[metacognition\.cognitive_control\] tier=frontier: input \d+ tok > p95 10 → /);
  assert.equal(perf.kind, "procedural");
  assert.ok(insights.some((m) => m.content.includes("task OOD")), "task-OOD insight stored too");
  // Next time the same block runs, Data-driven Analysis recalls it and favours cheap candidates.
  p.profiles.clear();
  const t2 = rootTask(p, cos.id, "Weekly operating review memo, next week", "Write the next weekly operating review memo for the leadership team.");
  await brain().run(p.context(cos, taskInput(t2)));
  const dda = p.tracer.spans.filter((s) => s.attributes["agentco.brain.block"] === "metacognition.project_management.data_driven_analysis").at(-1)!;
  assert.ok(Number(dda.attributes["agentco.insights"]) >= 1);
  assert.equal(dda.attributes["agentco.favour_cheap"], true);
  // And no duplicate insight is stored for the same symptom text.
  const contents = p.memories.filter((m) => m.tags.includes("optimization")).map((m) => m.content);
  assert.equal(new Set(contents).size, contents.length);
});

test("brain: TODO list interrupt → yielded with checkpoint; the next run resumes at the checkpointed block", async () => {
  const { p, ceo } = company();
  const task = rootTask(p, ceo.id);
  let polls = 0;
  (p.tasks as { interruptFor: (a: string, prio: number) => string | null }).interruptFor = () => (++polls === 2 ? "unanswered message from the Board" : null);
  const r = await brain().run(p.context(ceo, taskInput(task)));
  assert.equal(r.outcome, "yielded");
  const cp = (r.taskState?.checkpoint ?? {}) as Record<string, unknown>;
  assert.equal(cp.block, "metacognition.self_ability");
  assert.ok((cp.wm as Record<string, unknown>).problem, "partial results kept");
  apply(task, r);
  (p.tasks as { interruptFor: (a: string, prio: number) => string | null }).interruptFor = () => null;
  const resumed = await brain().run(p.context(ceo, taskInput(task)));
  assert.equal(resumed.outcome, "waiting");
  const pd = p.tracer.byKind("llm").filter((s) => s.attributes["agentco.stage"] === "metacognition.target_understanding.problem_definition");
  assert.equal(pd.length, 1, "problem definition was not redone");
  const todo = p.tracer.spans.filter((s) => s.attributes["agentco.brain.block"] === "todo_list").at(-1)!;
  assert.equal(todo.attributes["agentco.todo.entry"], "resume");
  assert.equal((resumed.taskState as Record<string, unknown>).checkpoint, null);
});

test("brain: human_answer resumes with the answer in local working memory; Board approval overrides a low-confidence stop", async () => {
  const provider = withOverrides({ "metacognition.confidence": () => ({ confidence: 0.1, uncertainty: 0.8 }) });
  const { p, ceo } = company({ providers: { mock: provider } });
  const task = rootTask(p, ceo.id);
  const blocked = await brain().run(p.context(ceo, taskInput(task)));
  assert.equal(blocked.outcome, "blocked");
  apply(task, blocked);
  const approval = { ...p.approvals[0]!, status: "approved" as const, note: "Go ahead, focus on the US market first." };
  const before = p.tracer.byKind("llm").length;
  const r = await brain().run(p.context(ceo, taskInput(task, "human_answer", { answeredApproval: approval })));
  assert.equal(r.outcome, "waiting");
  assert.equal((p.tasks.get(task.id)!.state.answers as unknown[]).length, 1, "answer stored in local working memory (task.state)");
  // Resumed at the checkpointed Confidence block: Target Understanding is not redone…
  const todo = p.tracer.spans.filter((s) => s.attributes["agentco.brain.block"] === "todo_list").at(-1)!;
  assert.equal(todo.attributes["agentco.todo.checkpoint"], "metacognition.confidence");
  const resumedCalls = p.tracer.byKind("llm").slice(before);
  assert.ok(!resumedCalls.some((s) => s.attributes["agentco.stage"] === "metacognition.target_understanding.problem_definition"), "problem definition not redone");
  // …and the Board's answer reaches the planning prompt of the run it triggered.
  const control = resumedCalls.find((s) => s.attributes["agentco.stage"] === "metacognition.cognitive_control")!;
  assert.ok(control.input!.includes("focus on the US market"), "answer in the cognitive-control prompt");
  assert.deepEqual((r.taskState as Record<string, unknown>).escalation, { count: 1, answered: true });
});

test("brain: abort propagates; budget errors propagate", async () => {
  const { p, ceo } = company();
  const c = new AbortController();
  c.abort();
  await assert.rejects(brain().run(p.context(ceo, taskInput(rootTask(p, ceo.id)), { signal: c.signal })), (e: Error) => e.name === "AbortError");
  p.budget.limitUsd = 0;
  await assert.rejects(brain().run(p.context(ceo, taskInput(rootTask(p, ceo.id)))), (e: Error) => e.name === "BudgetExceededError");
});

// ───────────────────────────── A whole company, offline ─────────────────────────────

test("company end-to-end on the mock: Board → CEO → C-suite → workers → evaluations → CEO report", async () => {
  const { p, ceo } = company();
  const engines = createEngines({ reflexMaxSteps: 8, brainMaxRevisions: 2, runTimeoutMs: 300_000 });
  const chat = await engines.brain.run(p.context(ceo, messageInput(LAUNCH), { traceId: "trc_launch" }));
  assert.match(chat.output, /^Opened T-/);
  const first = [...p.taskMap.values()].find((t) => t.parentTaskId === null)!;
  const pending = new Map<string, "task" | "subtasks_completed">([[first.id, "task"]]);
  for (let guard = 0; guard < 200 && pending.size > 0; guard++) {
    const [id, trigger] = [...pending.entries()][0]!;
    pending.delete(id);
    let task = p.taskMap.get(id)!;
    const agent = p.agentMap.get(task.assigneeId!)!;
    task.status = "in_progress";
    const r = await engines[agent.cognition].run(p.context(agent, taskInput({ ...task, state: { ...task.state } }, trigger, { subtasks: p.tasks.children(task.id) })));
    // Like RunService: apply the result to the current row (patchState may have replaced it).
    task = p.taskMap.get(id)!;
    apply(task, r);
    if (r.outcome === "completed") {
      task.status = "done";
      task.result = r.output;
    } else if (r.outcome === "waiting") {
      task.status = "waiting";
      for (const c of p.tasks.children(task.id)) if (c.status === "todo") pending.set(c.id, "task");
    } else if (r.outcome === "yielded") {
      task.status = "todo";
      pending.set(task.id, "task");
    } else {
      task.status = r.outcome === "blocked" ? "blocked" : "failed";
      task.error = r.error ?? r.output;
    }
    if (["done", "failed", "blocked"].includes(task.status) && task.parentTaskId) {
      const parent = p.taskMap.get(task.parentTaskId)!;
      if (parent.status === "waiting" && p.tasks.children(parent.id).every((c) => ["done", "failed", "cancelled", "blocked"].includes(c.status))) {
        parent.status = "todo";
        pending.set(parent.id, "subtasks_completed");
      }
    }
  }
  const root = p.taskMap.get(first.id)!;
  assert.equal(root.status, "done", `root ended ${root.status}: ${root.error ?? ""}`);
  const all = [...p.taskMap.values()];
  const children = all.filter((t) => t.parentTaskId === root.id);
  const grandchildren = all.filter((t) => children.some((c) => c.id === t.parentTaskId));
  assert.ok(children.length >= 2, "CEO delegated to the C-suite");
  assert.ok(grandchildren.length >= 2, "executives delegated to workers");
  assert.ok(all.every((t) => t.status === "done"), all.map((t) => `${t.title}:${t.status}`).join(", "));
  assert.ok(root.result!.length > 500, "a substantive final report");
  assert.ok(p.files.size >= 2, "workers wrote deliverables to the shared drive");
  assert.ok([...p.files.keys()].every((f) => f.startsWith("shared/")));
  // Cost lands on cheap tiers, and would have been far more on frontier.
  const byTier = p.budget.entries.reduce<Record<string, number>>((m, e) => ((m[e.tier] = (m[e.tier] ?? 0) + e.costUsd), m), {});
  assert.ok((byTier.economy ?? 0) > 0 && (byTier.standard ?? 0) > 0 && (byTier.frontier ?? 0) > 0);
  const savings = p.budget.entries.reduce((n, e) => n + (e.frontierCostUsd - e.costUsd), 0);
  assert.ok(savings > 0, "routing saved money vs all-frontier");
  const names = new Set(p.tracer.spans.map((s) => s.name));
  for (const n of ["brain.target_understanding", "brain.planning", "brain.evaluation"]) assert.ok(names.has(n), n);
});
