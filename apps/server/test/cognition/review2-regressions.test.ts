// Review 2 regressions (brain): yields keep the Feedback verdict and resume AT the checkpointed
// block; the yield budget; and the spec drift fixed in docs/BRAIN.md §2 (purpose → OKR weighting,
// recognition, fatigue, valence decay, belonging).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrainEngine } from "../../src/cognition/brain/index.ts";
import { alignmentMultiplier, Q8_HUMAN_NATURE, TODO_YIELD } from "../../src/cognition/brain/interpretation.ts";
import { resumeWorkingMemory } from "../../src/cognition/brain/todo-list.ts";
import { computeDrives } from "../../src/cognition/brain/self-management/identity.ts";
import { decayValence, recognition, updateAffect } from "../../src/cognition/brain/self-management/human-nature.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import { readStage } from "../../src/models/protocol.ts";
import type { EngineResult, ModelProvider } from "../../src/contracts.ts";
import type { Agent, NeedsState, Task } from "../../../../packages/shared/src/index.ts";
import { FakePlatform, makeAgent, makeTask, taskInput } from "./fakes.ts";

const TOOLS = ["delegate_task", "send_message", "escalate", "ask_human", "memory_search", "memory_write", "workspace_write_file", "blackboard_write"];
const needsOk: NeedsState = { physiological: "ok", safety: "ok", belonging: "ok", esteem: "ok", selfActualization: 0.5 };

/** Mock provider whose Feedback verdict is fixed (null = the mock's own). */
function provider(verdict: Record<string, unknown> | null): ModelProvider {
  const mock = new MockProvider({ latencyMs: 0 });
  return {
    name: "mock",
    async complete(profile, request, signal) {
      const r = await mock.complete(profile, request, signal);
      if (request.responseFormat !== "json" || !verdict) return r;
      if (readStage(request.messages) === "metacognition.solving_evaluation.feedback") return { ...r, content: JSON.stringify(verdict) };
      return r;
    },
  };
}

function setup(verdict: Record<string, unknown> | null = null) {
  const p = new FakePlatform(verdict ? { providers: { mock: provider(verdict) } } : {});
  p.addDepartment("dep_exec", "executive", "Executive");
  p.addDepartment("dep_mkt", "marketing", "Marketing");
  const ceo: Agent = p.addAgent(makeAgent({ id: "agt_ceo", name: "Ava", title: "Chief Executive Officer", departmentId: "dep_exec", tier: "executive", cognition: "brain", modelTier: "frontier", tools: TOOLS, identity: { mission: "Deliver the Board's objectives." } as never }));
  const cmo: Agent = p.addAgent(makeAgent({ id: "agt_cmo", name: "Maya", title: "Chief Marketing Officer", departmentId: "dep_mkt", managerId: ceo.id, tier: "executive", cognition: "brain", modelTier: "frontier", tools: TOOLS, identity: { mission: "Own marketing and launch campaigns." } as never }));
  const task = p.addTask(makeTask({ id: "tsk_root", number: 7, title: "Launch plan", description: "Plan the launch of our product with marketing input.", assigneeId: ceo.id, value: 800, estCostUsd: 0.5 }));
  return { p, ceo, cmo, task };
}
const apply = (p: FakePlatform, id: string, r: EngineResult) => {
  const t = p.taskMap.get(id)!;
  if (r.taskState) t.state = { ...t.state, ...r.taskState };
  return t;
};
type Interruptible = { interruptFor: (a?: string, prio?: number) => string | null };
const stageCalls = (p: FakePlatform, s: string) => p.tracer.byKind("llm").filter((x) => x.attributes["agentco.stage"] === s).length;

// ───────────────────────────── finding 1: yield during a re-plan ─────────────────────────────

// A yield inside the fullPass started by a "revise" on subtask results lost the revision counter and
// the feedback issues, so the revise budget (BRAIN_MAX_REVISIONS) never ran out.
test("R2 brain: a yield during a revise-replan keeps the revision count and the issues (revise budget runs out)", async () => {
  const { p, ceo, task } = setup({ score: 0.3, truthful: 0.9, good: false, issues: ["pricing section missing"], decision: "revise", summary: "Not there yet." });
  const brain = new BrainEngine({ maxRevisions: 2 });
  const tasks = p.tasks as unknown as Interruptible;
  tasks.interruptFor = () => null;
  let r = await brain.run(p.context(ceo, taskInput(task)));
  assert.equal(r.outcome, "waiting");
  apply(p, task.id, r);
  const outcomes: string[] = [];
  let yields = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    for (const c of p.tasks.children(task.id)) if (c.status !== "done") { c.status = "done"; c.result = "Draft positioning."; }
    // subtasks_completed: Feedback says revise → re-plan, but a Board message arrives → yield
    tasks.interruptFor = () => "Unanswered message from the Board";
    r = await brain.run(p.context(ceo, taskInput({ ...p.taskMap.get(task.id)! }, "subtasks_completed", { subtasks: p.tasks.children(task.id) })));
    outcomes.push(r.outcome);
    if (r.outcome !== "yielded") break;
    yields++;
    apply(p, task.id, r);
    const st = p.taskMap.get(task.id)!.state as { plan: { revision: number; feedback: string[] }; checkpoint: { block: string } };
    assert.equal(st.plan.revision, cycle + 1, "the verdict (revision + 1) is persisted before re-planning");
    assert.ok(st.plan.feedback.includes("pricing section missing"), "the Feedback issues survive the yield");
    tasks.interruptFor = () => null;
    r = await brain.run(p.context(ceo, taskInput({ ...p.taskMap.get(task.id)! }, "task", { subtasks: p.tasks.children(task.id) })));
    apply(p, task.id, r);
    outcomes.push(r.outcome);
    assert.ok((p.taskMap.get(task.id)!.state.plan as { revision: number }).revision >= cycle + 1, "the resumed pass starts from the persisted revision");
    if (r.outcome !== "waiting") break;
  }
  const plan = p.taskMap.get(task.id)!.state.plan as { revision: number };
  assert.ok(yields >= 1);
  assert.ok(plan.revision <= 2 + 1, `revision ${plan.revision} within BRAIN_MAX_REVISIONS`);
  assert.ok(!outcomes.slice(-1).includes("yielded") && !outcomes.slice(-1).includes("waiting"), `the revise budget ran out and the task settled: ${outcomes.join(",")}`);
});

// ───────────────────────────── finding 2: resume AT the checkpointed block ─────────────────────────────

test("R2 brain: a yield before Solving resumes AT Solving (no Confidence or Cognitive Control redone)", async () => {
  const { p, ceo, task } = setup();
  const tasks = p.tasks as unknown as Interruptible;
  // checks: problem_definition(1), self_ability(2), decomposition(3), solving(4) → interrupt at the 4th
  let polls = 0;
  tasks.interruptFor = () => (++polls === 4 ? "Unanswered message from the Board" : null);
  const r = await new BrainEngine().run(p.context(ceo, taskInput(task)));
  assert.equal(r.outcome, "yielded");
  const cp = r.taskState!.checkpoint as { block: string; wm: Record<string, unknown> };
  assert.equal(cp.block, "metacognition.solving_evaluation.solving");
  for (const k of ["problem", "understanding", "competence", "confidence", "planned"]) assert.ok(cp.wm[k], `working memory keeps ${k}`);
  assert.equal(r.taskState!.yields, 1);
  Object.assign(task.state, r.taskState);
  const before = { pd: stageCalls(p, "metacognition.target_understanding.problem_definition"), conf: stageCalls(p, "metacognition.confidence"), cc: stageCalls(p, "metacognition.cognitive_control") };
  tasks.interruptFor = () => null;
  const resumed = await new BrainEngine().run(p.context(ceo, taskInput({ ...task })));
  const redo = {
    pd: stageCalls(p, "metacognition.target_understanding.problem_definition") - before.pd,
    conf: stageCalls(p, "metacognition.confidence") - before.conf,
    cc: stageCalls(p, "metacognition.cognitive_control") - before.cc,
  };
  assert.deepEqual(redo, { pd: 0, conf: 0, cc: 0 }, "resume re-ran earlier blocks instead of resuming at Solving");
  assert.ok(["waiting", "completed"].includes(resumed.outcome), resumed.outcome);
  assert.ok(p.tracer.spans.some((s) => s.attributes["agentco.brain.block"] === "metacognition.solving_evaluation.solving"));
});

test("R2 brain: a yield before Cognitive Control resumes there with understanding, competence and confidence restored", async () => {
  const { p, ceo, task } = setup();
  const tasks = p.tasks as unknown as Interruptible;
  let polls = 0;
  tasks.interruptFor = () => (++polls === 3 ? "A higher-priority task is ready" : null);
  const r = await new BrainEngine().run(p.context(ceo, taskInput(task)));
  assert.equal((r.taskState!.checkpoint as { block: string }).block, "metacognition.cognitive_control.decomposition");
  Object.assign(task.state, r.taskState);
  const conf = stageCalls(p, "metacognition.confidence");
  const cc = stageCalls(p, "metacognition.cognitive_control");
  tasks.interruptFor = () => null;
  await new BrainEngine().run(p.context(ceo, taskInput({ ...task })));
  assert.equal(stageCalls(p, "metacognition.confidence") - conf, 0, "Confidence not redone");
  assert.ok(stageCalls(p, "metacognition.cognitive_control") - cc >= 1, "Cognitive Control runs (the checkpointed block)");
});

test("R2 brain: resumeWorkingMemory keeps what earlier blocks produced; an answer re-assesses from Self-ability", () => {
  const wm = { problem: 1, literature: 2, understanding: 3, competence: 4, ood: 5, confidence: 6, routingTier: "standard", planned: 7, boardAnswer: 8 };
  const cp = (block: string) => ({ block: block as never, reason: "r", at: "", wm });
  assert.deepEqual(Object.keys(resumeWorkingMemory(cp("metacognition.solving_evaluation.solving"), "yield")).sort(), Object.keys(wm).sort());
  assert.deepEqual(Object.keys(resumeWorkingMemory(cp("metacognition.cognitive_control.decomposition"), "yield")).sort(), ["boardAnswer", "competence", "confidence", "literature", "ood", "problem", "routingTier", "understanding"]);
  assert.deepEqual(Object.keys(resumeWorkingMemory(cp("metacognition.self_ability"), "yield")).sort(), ["boardAnswer", "literature", "problem", "understanding"]);
  assert.deepEqual(Object.keys(resumeWorkingMemory(cp("metacognition.target_understanding.problem_definition"), "yield")), ["boardAnswer"]);
  assert.deepEqual(Object.keys(resumeWorkingMemory(cp("metacognition.solving_evaluation.solving"), "answer")).sort(), ["boardAnswer", "literature", "problem", "understanding"]);
});

// A message landing in every planning phase used to starve the task (no yield cap, re-planning each time).
test("R2 brain: a Board message arriving during every planning phase cannot stop the objective (yield cap, resume at block)", async () => {
  const { p, ceo, task } = setup();
  const tasks = p.tasks as unknown as Interruptible;
  const outcomes: string[] = [];
  for (let i = 0; i < 6; i++) {
    let polls = 0;
    // a new Board message lands while this run is planning (from the 2nd interrupt check on)
    tasks.interruptFor = () => (++polls >= 2 ? "Unanswered message from the Board" : null);
    const r = await new BrainEngine().run(p.context(ceo, taskInput({ ...task })));
    Object.assign(task.state, r.taskState);
    outcomes.push(r.outcome);
    if (r.outcome !== "yielded") break;
  }
  const solved = p.tracer.spans.filter((s) => s.attributes["agentco.brain.block"] === "metacognition.solving_evaluation.solving").length;
  assert.ok(solved > 0, `Solving never reached: ${outcomes.join(",")}`);
  assert.ok(outcomes.filter((o) => o === "yielded").length <= TODO_YIELD.maxPerTask, `at most ${TODO_YIELD.maxPerTask} yields: ${outcomes.join(",")}`);
  assert.ok(["waiting", "completed"].includes(outcomes.at(-1)!), outcomes.join(","));
});

test("R2 brain: never yields once Solving has started (a revise loop finishes its pass)", async () => {
  const { p, ceo } = setup({ score: 0.3, truthful: 0.9, good: false, issues: ["thin"], decision: "revise", summary: "Again." });
  // A lone agent (no reports) solves directly; Feedback says revise; an interrupt arrives after Solving.
  const solo = p.addAgent(makeAgent({ id: "agt_solo", name: "Sol", title: "Chief of Staff", departmentId: "dep_exec", managerId: ceo.id, tier: "manager", cognition: "brain", modelTier: "standard", tools: ["memory_search", "workspace_write_file"] }));
  const t = p.addTask(makeTask({ id: "tsk_solo", number: 9, title: "Write the weekly memo", description: "Summarise the week.", assigneeId: solo.id, value: 300, estCostUsd: 0.05 }));
  let solvingSeen = false;
  (p.tasks as unknown as Interruptible).interruptFor = () => {
    solvingSeen ||= p.tracer.spans.some((s) => s.attributes["agentco.brain.block"] === "metacognition.solving_evaluation.solving");
    return solvingSeen ? "Unanswered message from the Board" : null;
  };
  const r = await new BrainEngine({ maxRevisions: 1 }).run(p.context(solo, taskInput(t)));
  assert.notEqual(r.outcome, "yielded", "the run finished its pass instead of yielding after Solving started");
});

// ───────────────────────────── finding 9: spec drift ─────────────────────────────

test("R2 spec (a): Motivation › Purpose scales the OKR/vision alignment multiplier", () => {
  const agent = makeAgent({ id: "a" });
  const at = (purpose: number) => computeDrives({ ...agent.identity, desires: { ...agent.identity.desires, vision: 0.8 }, motivation: { ...agent.identity.motivation, purpose } }, agent.affect, needsOk).visionMultiplier;
  assert.equal(at(0.5), 1 + 0.5 * 0.8, "purpose 0.5 = the plain 1 + 0.5·vision");
  assert.ok(at(1) > at(0.5) && at(0.5) > at(0), "more purpose → more weight on OKR/vision-aligned work");
  assert.equal(at(0), alignmentMultiplier(0.8, 0));
  assert.equal(alignmentMultiplier(0, 1), 1, "no vision, no multiplier");
});

test("R2 spec (b): a manager's Feedback accepting a subtask recognises the WORKER (recognizedBy manager)", async () => {
  const { p, ceo, cmo, task } = setup({ score: 0.95, truthful: 0.95, good: true, issues: [], decision: "accept", summary: "Great work." });
  (p.tasks as unknown as Interruptible).interruptFor = () => null;
  const brain = new BrainEngine();
  let r = await brain.run(p.context(ceo, taskInput(task)));
  assert.equal(r.outcome, "waiting");
  apply(p, task.id, r);
  const children = p.tasks.children(task.id);
  assert.ok(children.length > 0 && children.every((c) => c.assigneeId === cmo.id));
  for (const c of children) { c.status = "done"; c.result = "Positioning and pricing drafted."; }
  const before = cmo.affect.valence;
  r = await brain.run(p.context(ceo, taskInput({ ...p.taskMap.get(task.id)! }, "subtasks_completed", { subtasks: children })));
  assert.equal(r.outcome, "completed");
  const patch = p.patches.find((x) => x.agentId === cmo.id);
  assert.ok(patch?.patch.affect, "the worker's affect was updated");
  assert.ok(cmo.affect.valence > before, "recognition moves the worker's valence up");
  const span = p.tracer.spans.find((s) => s.attributes["agentco.recognized_by"] === "manager");
  assert.ok(span && String(span.attributes["agentco.recognized"]).includes(cmo.id));
  // Recognition tops self-acceptance up to recognitionMultiplier× (1× own + 1× recognition from neutral).
  const neutral = { valence: 0, arousal: 0.3, frustration: 0.2 };
  const own = updateAffect(neutral, [{ outcome: "done", source: "own", recognizedBy: "self" }], { openItems: 0, consecutiveRuns: 1 });
  const recognised = recognition(neutral, "manager");
  assert.ok(Math.abs(recognised.valence - own.valence * (Q8_HUMAN_NATURE.recognitionMultiplier - 1)) < 1e-9);
  assert.ok(recognition(neutral, "board").frustration < recognised.frustration, "the Board's acceptance counts more");
});

test("R2 spec (c): fatigue uses the real run streak from the platform", async () => {
  const neutral = { valence: 0, arousal: 0.3, frustration: 0 };
  const fresh = updateAffect(neutral, [], { openItems: 2, consecutiveRuns: 1 });
  const tired = updateAffect(neutral, [], { openItems: 2, consecutiveRuns: 8 });
  assert.ok(tired.arousal > fresh.arousal, "more consecutive runs → more arousal");
  // The brain asks MetricsView.runStreak for it.
  const { p, ceo, task } = setup({ score: 0.95, truthful: 0.95, good: true, issues: [], decision: "accept", summary: "ok" });
  (p.tasks as unknown as Interruptible).interruptFor = () => null;
  const asked: { agentId: string; gap: number }[] = [];
  (p.metrics as { runStreak?: unknown }).runStreak = (agentId: string, gap: number) => {
    asked.push({ agentId, gap });
    return { consecutiveRuns: 5, idleMsBefore: 0 };
  };
  const r = await new BrainEngine().run(p.context(ceo, taskInput(task)));
  apply(p, task.id, r);
  for (const c of p.tasks.children(task.id)) c.status = "done";
  await new BrainEngine().run(p.context(ceo, taskInput({ ...p.taskMap.get(task.id)! }, "subtasks_completed", { subtasks: p.tasks.children(task.id) })));
  assert.ok(asked.some((a) => a.agentId === ceo.id && a.gap === Q8_HUMAN_NATURE.fatigueIdleGapMs));
  const hn = p.tracer.spans.filter((s) => s.name === "brain.self_management.human_nature" && s.attributes["agentco.fatigue.consecutive_runs"] !== undefined);
  assert.ok(hn.length > 0 && hn.every((s) => s.attributes["agentco.fatigue.consecutive_runs"] === 5));
});

test("R2 spec (d): valence decays toward 0 over runs and idle time, so the curiosity boost fades", () => {
  const agent = makeAgent({ id: "a" });
  let affect = { valence: 0.9, arousal: 0.3, frustration: 0 };
  assert.ok(computeDrives(agent.identity, affect, needsOk).notes.some((n) => n.includes("curiosity")));
  assert.ok(decayValence(0.9) < 0.9 && decayValence(-0.9) > -0.9, "both signs relax toward 0");
  assert.ok(Math.abs(decayValence(0.8, Q8_HUMAN_NATURE.valenceHalfLifeMs) - 0.8 * (1 - Q8_HUMAN_NATURE.valenceDecayPerRun) * 0.5) < 1e-9, "idle time halves it per half-life");
  let reports = 0;
  while (affect.valence > 0.3 && reports < 20) {
    affect = updateAffect(affect, [], { openItems: 0, consecutiveRuns: 1 });
    reports++;
  }
  assert.ok(reports < 10, `the boost fades after ${reports} quiet reports`);
  assert.ok(!computeDrives(agent.identity, affect, needsOk).notes.some((n) => n.includes("positive valence")));
  // Steady success no longer pins valence at the ceiling.
  let busy = { valence: 0, arousal: 0.3, frustration: 0 };
  for (let i = 0; i < 50; i++) busy = updateAffect(busy, [{ outcome: "done", source: "own", recognizedBy: "self" }], { openItems: 1, consecutiveRuns: 1 });
  assert.ok(busy.valence < 1, `steady-state valence ${busy.valence}`);
});

test("R2 spec (e): belonging low because the manager is gone → check in with the next active ancestor", async () => {
  const { p, ceo, cmo } = setup();
  (p.tasks as unknown as Interruptible).interruptFor = () => null;
  const head = p.addAgent(makeAgent({ id: "agt_head", name: "Hal", title: "Head of Brand", departmentId: "dep_mkt", managerId: cmo.id, tier: "manager", cognition: "brain", modelTier: "standard", tools: TOOLS }));
  p.addAgent(makeAgent({ id: "agt_w", name: "Wes", title: "Brand Designer", departmentId: "dep_mkt", managerId: head.id, tier: "worker" }));
  cmo.status = "terminated";
  p.needsOverride.set(head.id, { belonging: "low", selfActualization: 1 });
  const t = p.addTask(makeTask({ id: "tsk_h", number: 11, title: "Brand refresh", description: "Refresh the brand guide.", assigneeId: head.id, value: 400, estCostUsd: 0.1 }));
  await new BrainEngine().run(p.context(head, taskInput(t)));
  const checkin = p.toolCalls.find((c) => c.name === "send_message" && String(c.args.content).startsWith("Checking in"));
  assert.ok(checkin, "a check-in was sent");
  assert.equal(checkin!.args.toAgentId, ceo.id, "to the next ACTIVE ancestor, not the terminated manager");
  const motivation = p.tracer.spans.find((s) => s.name === "brain.self_management.identity.motivation" && s.agentId === head.id);
  assert.equal(motivation?.attributes["agentco.belonging"], "manager_missing");
});

test("R2 spec (e): belonging low because a leader's reports are unreachable → noted in Self-ability", async () => {
  const { p, cmo } = setup();
  (p.tasks as unknown as Interruptible).interruptFor = () => null;
  const head = p.addAgent(makeAgent({ id: "agt_head", name: "Hal", title: "Head of Brand", departmentId: "dep_mkt", managerId: cmo.id, tier: "manager", cognition: "brain", modelTier: "standard", tools: TOOLS }));
  p.addAgent(makeAgent({ id: "agt_w", name: "Wes", title: "Brand Designer", departmentId: "dep_mkt", managerId: head.id, tier: "worker", status: "paused" }));
  p.needsOverride.set(head.id, { belonging: "low", selfActualization: 1 });
  const t = p.addTask(makeTask({ id: "tsk_h", number: 12, title: "Brand refresh", description: "Refresh the brand guide.", assigneeId: head.id, value: 400, estCostUsd: 0.1 }));
  const r = await new BrainEngine().run(p.context(head, taskInput(t)));
  const ability = p.tracer.spans.find((s) => s.name === "brain.metacognition.self_ability" && s.agentId === head.id);
  assert.equal(ability?.attributes["agentco.belonging"], "reports_unreachable");
  assert.ok(String(ability?.output).includes("direct reports unreachable"), "the gap is in the competence assessment");
  // Its manager is fine: the check-in still goes to the manager.
  assert.equal(p.toolCalls.find((c) => c.name === "send_message" && String(c.args.content).startsWith("Checking in"))?.args.toAgentId, cmo.id);
  // No delegation to the paused report.
  assert.ok(!p.tasks.children(t.id).some((c: Task) => c.assigneeId === "agt_w"));
  assert.ok(r.outcome !== "yielded");
});
