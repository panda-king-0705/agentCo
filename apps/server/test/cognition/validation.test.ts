// 2026-11-08 — the founder: "success checks the CEO writes before work starts, plus a separate checker
// who judges against them" (Factory's validation contracts and independent validators). Four runs of
// the investor update showed reviewers inventing new requirements mid-flight — per-toggle price
// captures, dated sign-offs, version reconciliations — so every round of review found something new.
//
// Now: the objective's success criteria become a numbered contract when it opens (shown to the Board),
// each part's brief carries the statements it must make true, an independent check — the contract and
// the saved work only, on another model where one is configured — judges each statement, and work goes
// back only for statements found unmet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrainEngine } from "../../src/cognition/brain/index.ts";
import { attachContract } from "../../src/cognition/brain/metacognition/cognitive-control.ts";
import { coerceChecks, contractFrom, readContract, validationSection } from "../../src/cognition/brain/metacognition/validation.ts";
import { loadModelConfig } from "../../src/models/config.ts";
import { createModelRouter } from "../../src/models/router.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import { readStage } from "../../src/models/protocol.ts";
import type { EngineResult, ModelProvider, SavedFiles } from "../../src/contracts.ts";
import type { Agent, Task } from "../../../../packages/shared/src/index.ts";
import { FakePlatform, makeAgent, makeTask, messageInput, taskInput } from "./fakes.ts";

const BRAIN_TOOLS = ["delegate_task", "send_message", "escalate", "ask_human", "memory_search", "memory_write", "workspace_write_file", "blackboard_write"];
const VALIDATION = "metacognition.solving_evaluation.validation";

interface Seen {
  stage: string;
  profile: string;
  system: string;
}

/** JSON replies per stage; records what each call saw. */
function provider(json: Record<string, (n: number) => unknown>, seen: Seen[] = []): ModelProvider {
  const mock = new MockProvider({ latencyMs: 0 });
  const counts = new Map<string, number>();
  return {
    name: "mock",
    async complete(profile, request, signal) {
      const r = await mock.complete(profile, request, signal);
      const stage = readStage(request.messages) ?? "";
      seen.push({ stage, profile: profile.id, system: request.messages.map((m) => m.content).join("\n") });
      if (request.responseFormat !== "json") return r;
      const n = (counts.get(stage) ?? 0) + 1;
      counts.set(stage, n);
      const v = json[stage]?.(n);
      return v === undefined ? r : { ...r, content: typeof v === "string" ? v : JSON.stringify(v) };
    },
  };
}

function company(p: FakePlatform) {
  p.addDepartment("dep_exec", "executive", "Executive");
  p.addDepartment("dep_fin", "finance", "Finance");
  const exec = (id: string, name: string, title: string, departmentId: string, managerId: string | null, mission: string): Agent =>
    p.addAgent(makeAgent({ id, name, title, departmentId, managerId, tier: "executive", cognition: "brain", modelTier: "frontier", tools: BRAIN_TOOLS, identity: { mission } as never }));
  const ceo = exec("agt_ceo", "Ava Chen", "Chief Executive Officer", "dep_exec", null, "Set direction and deliver the Board's objectives.");
  const cfo = exec("agt_cfo", "Elena Petrova", "Chief Financial Officer", "dep_fin", ceo.id, "Own finance, budget and the company's numbers.");
  return { ceo, cfo };
}

const CONTRACT = [
  { id: "A1", text: "The update is saved at investor/update.md and marked DRAFT" },
  { id: "A2", text: "Every figure in the update names the file it comes from" },
  { id: "A3", text: "Cash and runway are stated" },
];
const plan = (covers: string[][]) => ({
  mode: "delegate",
  subprocesses: covers.map((c, i) => ({ title: `Part ${i + 1}: investor update figures`, description: "Write the figures section in investor/update.md.", assigneeId: "agt_cfo", value: 300, estCostUsd: 0.05, acceptanceCriteria: "Saved.", covers: c })),
  candidates: [
    { name: "high_cost", approach: "thorough", estCostUsd: 5, expectedValue: 100, meetsCriteria: true },
    { name: "low_cost", approach: "same scope", estCostUsd: 0.01, expectedValue: 900, meetsCriteria: true },
    { name: "low_effort", approach: "smallest", estCostUsd: 0.02, expectedValue: 100, meetsCriteria: true },
  ],
  rationale: "Finance writes it.",
});
const apply = (task: Task, r: EngineResult) => {
  if (r.taskState) task.state = { ...task.state, ...r.taskState };
};

test("the contract: numbered from the success criteria, read back from state, checks coerced per statement", () => {
  const c = contractFrom(["The update is saved at investor/update.md and marked DRAFT.", "Every figure names its source;", "every figure names its source", "", "a", "b", "c", "d", "e"]);
  assert.deepEqual(c.slice(0, 2), [
    { id: "A1", text: "The update is saved at investor/update.md and marked DRAFT" },
    { id: "A2", text: "Every figure names its source" },
  ]);
  assert.equal(c.length, 6, "duplicates dropped, at most six");
  assert.deepEqual(readContract([{ id: "A1", text: "x" }, { id: "B", text: "y" }, "junk"]), [{ id: "A1", text: "x" }]);
  const checks = coerceChecks({ checks: [{ id: "a1", status: "MET", evidence: "investor/update.md: DRAFT" }, { id: "A3", status: "board", gap: "no file has cash or runway" }] }, CONTRACT)!;
  assert.deepEqual(checks.map((x) => [x.id, x.status]), [["A1", "met"], ["A2", "unmet"], ["A3", "board"]]);
  assert.equal(checks[1]!.gap, "the checker gave no verdict for this statement", "a statement the checker skipped is not counted met");
  assert.equal(coerceChecks({ summary: "fine" }, CONTRACT), null, "no checks: no verdict");
  const section = validationSection({ checks, unmet: [checks[1]!], board: [checks[2]!], checker: "openai:gpt-6.1-sol" });
  assert.match(section, /^## Checked against what "done" means\n1 of 3 met — checked by a model that did not do the work\.\n- ✓ A1 The update is saved at investor\/update\.md and marked DRAFT\n- ✗ A2 Every figure in the update names the file it comes from — the checker gave no verdict for this statement\n- Board A3 Cash and runway are stated — no file has cash or runway$/);
});

test("the first reply says what done means, and the objective keeps it", async () => {
  const p = new FakePlatform({
    providers: {
      mock: provider({
        "metacognition.target_understanding.problem_definition": () => ({
          intent: "work",
          title: "Draft the monthly investor update",
          problem: "Prepare the update for the Board to send.",
          successCriteria: ["The update is saved at investor/update.md and marked DRAFT", "Every figure in the update names the file it comes from"],
          boardSteps: ["Send the update to the investors"],
        }),
      }),
    },
  });
  const { ceo } = company(p);
  const r = await new BrainEngine().run(p.context(ceo, messageInput("Email our investors this month's update.")));
  assert.match(
    r.output,
    /^Opened T-\d+: Draft the monthly investor update\. I'll work it through and report back here when it's done\.\n\nDone means:\n1\. The update is saved at investor\/update\.md and marked DRAFT\n2\. Every figure in the update names the file it comes from\n\nThe finished work is checked against exactly these by a model that did not do it\.\n\nOne thing up front: this company can't do this step, so it is left to you: Send the update to the investors\./,
  );
  const objective = [...p.taskMap.values()].at(-1)!;
  assert.deepEqual(readContract(objective.state.contract).map((a) => a.id), ["A1", "A2"]);
});

test("every part's brief carries the statements it must make true; none is left uncovered", () => {
  const parts = plan([["A1"], []]).subprocesses.map((s, i) => ({ ...s, round: (i === 1 ? 2 : 1) as 1 | 2, covers: s.covers, suggestedAssigneeId: null, fit: null, taskId: null }));
  const added = attachContract(parts, CONTRACT);
  assert.deepEqual(added, ["A2", "A3"], "unclaimed statements go to the round-2 part");
  assert.deepEqual(parts.map((x) => x.covers), [["A1"], ["A2", "A3"]]);
  assert.match(parts[0]!.acceptanceCriteria, /^Saved\. This part must make true \(the objective's contract, checked independently at the end\): A1 — The update is saved at investor\/update\.md and marked DRAFT\.$/);
  assert.match(parts[1]!.acceptanceCriteria, /A2 — Every figure in the update names the file it comes from; A3 — Cash and runway are stated\.$/);

  // A fix round: only the statements the feedback names, never the whole contract again.
  const fixes = plan([[], ["A1"]]).subprocesses.map((x) => ({ ...x, round: 1 as const, covers: x.covers, suggestedAssigneeId: null, fit: null, taskId: null }));
  assert.deepEqual(attachContract(fixes, CONTRACT, ["A2"]), []);
  assert.deepEqual(fixes.map((x) => x.covers), [["A2"], []], "a part naming nothing gets the unmet statement; a statement not being fixed is dropped");
  assert.doesNotMatch(fixes[1]!.acceptanceCriteria, /must make true/);
});

async function runObjective(o: { checks: (n: number) => unknown; leader: (n: number) => unknown; seen?: Seen[]; env?: Record<string, string>; openai?: ModelProvider }) {
  const seen = o.seen ?? [];
  const replies = provider(
    {
      "metacognition.cognitive_control": (n) => (n === 1 ? plan([["A1", "A2", "A3"]]) : { ...plan([["A2"]]), subprocesses: [{ ...plan([["A2"]]).subprocesses[0]!, title: "Name the source of every figure" }] }),
      [VALIDATION]: o.checks,
      "metacognition.solving_evaluation.feedback": o.leader,
    },
    seen,
  );
  const p = new FakePlatform({ env: o.env, providers: { mock: replies, openai: o.openai ?? replies } });
  const { ceo } = company(p);
  const task = p.addTask(makeTask({ id: "tsk_300", number: 300, title: "Draft the monthly investor update", description: "Email our investors this month's update.", assigneeId: ceo.id, value: 800, estCostUsd: 0.5 }));
  task.state.contract = CONTRACT;
  const brain = new BrainEngine({ maxRevisions: 2 });
  const first = await brain.run(p.context(ceo, taskInput(task)));
  assert.equal(first.outcome, "waiting", first.error ?? first.output);
  apply(task, first);
  const done = () => {
    for (const c of p.tasks.children(task.id)) if (c.status !== "done") {
      c.status = "done";
      c.result = "Saved investor/update.md with the figures and their sources; I also double-checked everything twice.";
    }
  };
  done();
  // The drive as reviewers see it: Elena's part saved investor/update.md.
  const content = "DRAFT\n# Update\n- Spend: $1.64 (finance/monthly-report.md)\n- Cash: not available yet";
  (p as unknown as { drive: SavedFiles }).drive = {
    written: () => p.tasks.children(task.id).map((c) => ({ agentId: "agt_cfo", taskId: c.id, display: "shared/investor/update.md", at: "2026-11-08T03:00:00.000Z" })),
    read: () => ({ content, truncated: false }),
    recent: () => [],
  };
  const second = await brain.run(p.context(ceo, taskInput(task, "subtasks_completed", { subtasks: p.tasks.children(task.id) })));
  return { p, task, ceo, first, second, done, brain, seen };
}

test("all statements met: the leader's own second thoughts don't send the work back, and the report shows the check", async () => {
  const { p, task, second, seen } = await runObjective({
    checks: () => ({ checks: [{ id: "A1", status: "met", evidence: "investor/update.md: DRAFT" }, { id: "A2", status: "met", evidence: "Spend: $1.64 (finance/monthly-report.md)" }, { id: "A3", status: "board", gap: "no file in the company has cash or runway" }] }),
    leader: () => ({ score: 0.5, truthful: 0.9, good: false, issues: ["Capture prices for the monthly and annual billing toggles separately"], openPoints: [], decision: "revise", summary: "Drafted; figures sourced." }),
  });
  assert.equal(second.outcome, "completed", second.error ?? second.output);
  assert.equal(p.tasks.children(task.id).length, 1, "no fix round for a requirement nobody wrote down");
  assert.match(second.output, /## Checked against what "done" means\n2 of 3 met — checked by a model that did not do the work\.\n- ✓ A1 [^\n]+\n- ✓ A2 [^\n]+\n- Board A3 Cash and runway are stated — no file in the company has cash or runway/);
  assert.match(second.output, /## Open points for the Board\n- Cash and runway are stated — no file in the company has cash or runway/);
  // Independence: the checker saw the contract and the saved file — not the leader's charter, nor the workers' own account.
  const check = seen.find((s) => s.stage === VALIDATION)!;
  assert.match(check.system, /You are the company's independent checker\. You did not do this work/);
  assert.doesNotMatch(check.system, /You are Ava Chen/);
  assert.doesNotMatch(check.system, /double-checked everything twice/);
  assert.match(check.system, /=== shared\/investor\/update\.md/);
  assert.ok(seen.findIndex((s) => s.stage === VALIDATION) < seen.findIndex((s) => s.stage === "metacognition.solving_evaluation.feedback"), "the check comes before the leader's review");
});

test("a statement found unmet goes back — only that statement, even when the leader would have accepted — and after the one round it is reported as not finished", async () => {
  const unmet = { checks: [{ id: "A1", status: "met", evidence: "DRAFT" }, { id: "A2", status: "unmet", gap: "the cash line names no source" }, { id: "A3", status: "met", evidence: "Cash: $40,000 (finance/cash.md)" }] };
  const { p, task, second, done, brain, ceo } = await runObjective({
    checks: () => unmet,
    leader: () => ({ score: 0.9, truthful: 0.9, good: true, issues: ["Add a dated CFO sign-off"], openPoints: [], decision: "accept", summary: "Looks fine." }),
  });
  assert.equal(second.outcome, "waiting", second.error ?? second.output);
  apply(task, second);
  const fix = p.tasks.children(task.id).at(-1)!;
  assert.equal(fix.title, "Fix: Name the source of every figure");
  const plan2 = task.state.plan as { feedback: string[] };
  assert.equal(plan2.feedback[0], "A2 not met (Every figure in the update names the file it comes from): the cash line names no source");
  assert.ok(!plan2.feedback.some((f) => /sign-off/.test(f)), "only the unmet statement — not the leader's dated sign-off");
  assert.match(fix.acceptanceCriteria ?? "", /A2 — Every figure in the update names the file it comes from/);
  done();
  const third = await brain.run(p.context(ceo, taskInput(task, "subtasks_completed", { subtasks: p.tasks.children(task.id) })));
  assert.equal(third.outcome, "completed", third.error ?? third.output);
  assert.match(third.output, /## Not finished after one round of fixes\n- A2 not met \(Every figure in the update names the file it comes from\): the cash line names no source/);
  assert.match(third.output, /- ✗ A2 Every figure in the update names the file it comes from — the cash line names no source/);
});

test("the checker runs on its own model when one is set (VALIDATOR_MODEL), and on the leader's tier if that model fails", async () => {
  const seen: Seen[] = [];
  const met = () => ({ checks: CONTRACT.map((a) => ({ id: a.id, status: "met", evidence: "investor/update.md" })) });
  await runObjective({ env: { OPENAI_API_KEY: "test-key", VALIDATOR_MODEL: "openai:gpt-checker" }, checks: met, leader: () => ({ score: 0.9, truthful: 0.9, good: true, issues: [], openPoints: [], decision: "accept", summary: "Done." }), seen });
  const check = seen.find((s) => s.stage === VALIDATION)!;
  const leader = seen.find((s) => s.stage === "metacognition.solving_evaluation.feedback")!;
  assert.equal(check.profile, "openai:gpt-checker");
  assert.notEqual(check.profile, leader.profile, `the checker (${check.profile}) is not the leader's model (${leader.profile})`);

  const router = (env: Record<string, string>) => createModelRouter({ config: loadModelConfig({ MOCK_LATENCY_MS: "0", ...env }, { log: () => {} }), tracer: { startSpan: () => null } as never, budget: {} as never, getAgent: () => null });
  assert.equal(router({}).validatorProfile!(), null, "no second provider: the stage's own tier");
  assert.equal(router({ VALIDATOR_MODEL: "same" }).validatorProfile!(), null);
  assert.equal(router({ OPENAI_API_KEY: "k", VALIDATOR_MODEL: "openai:gpt-checker" }).validatorProfile!(), "openai:gpt-checker");
  assert.equal(router({ OPENAI_API_KEY: "k", MODEL_STANDARD_FALLBACK: "openai:gpt-6.1-sol" }).validatorProfile!(), "openai:gpt-6.1-sol", "by default, the standard tier's fallback on another provider checks");

  // The checker's provider fails: the check still happens, on the leader's tier.
  const failing: ModelProvider = { name: "openai", complete: async () => { throw new Error("openai: 500 internal error"); } };
  const down = await runObjective({ env: { OPENAI_API_KEY: "k", VALIDATOR_MODEL: "openai:gpt-checker" }, openai: failing, checks: met, leader: () => ({ score: 0.9, truthful: 0.9, good: true, issues: [], openPoints: [], decision: "accept", summary: "Done." }) });
  assert.equal(down.second.outcome, "completed", down.second.error ?? down.second.output);
  assert.match(down.second.output, /## Checked against what "done" means\n3 of 3 met/);
  assert.ok(down.p.tracer.spans.some((x) => x.attributes["agentco.validation.checker_failed"] === "openai:gpt-checker"));
});

test("no contract (a part handed down, a heartbeat): the review works as before, with no extra check", async () => {
  const seen: Seen[] = [];
  const p = new FakePlatform({ providers: { mock: provider({ "metacognition.cognitive_control": () => plan([["A1"]]) }, seen) } });
  const { ceo, cfo } = company(p);
  const parent = p.addTask(makeTask({ id: "tsk_1", number: 1, title: "Objective", assigneeId: ceo.id }));
  const task = p.addTask(makeTask({ id: "tsk_2", number: 2, title: "Figures section", description: "Write it.", assigneeId: cfo.id, parentTaskId: parent.id, rootTaskId: parent.id, createdBy: ceo.id }));
  const r = await new BrainEngine().run(p.context(cfo, taskInput(task)));
  assert.notEqual(r.outcome, "failed", r.error ?? "");
  assert.equal(seen.filter((s) => s.stage === VALIDATION).length, 0);
  const heartbeat = p.addTask(makeTask({ id: "tsk_3", number: 3, title: "Heartbeat: CEO reviews OKRs", assigneeId: ceo.id, createdBy: "system" }));
  await new BrainEngine().run(p.context(ceo, taskInput(heartbeat)));
  assert.equal(seen.filter((s) => s.stage === VALIDATION).length, 0);
});
