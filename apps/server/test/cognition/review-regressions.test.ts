import { test } from "node:test";
import assert from "node:assert/strict";
import { BrainEngine } from "../../src/cognition/brain/index.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import { readStage } from "../../src/models/protocol.ts";
import type { ChatRequest, ModelProvider } from "../../src/contracts.ts";
import { runToolLoop } from "../../src/cognition/tool-loop.ts";
import { decide } from "../../src/cognition/brain/metacognition/solving-evaluation.ts";
import { FakePlatform, makeAgent, makeTask, taskInput } from "./fakes.ts";

const TOOLS = ["delegate_task", "send_message", "escalate", "ask_human", "memory_search", "memory_write", "workspace_write_file", "blackboard_write"];

function provider(overrides: Record<string, unknown>): ModelProvider {
  const mock = new MockProvider({ latencyMs: 0 });
  return {
    name: "mock",
    async complete(profile, request, signal) {
      const r = await mock.complete(profile, request, signal);
      const stage = readStage(request.messages) ?? "";
      if (request.responseFormat === "json" && overrides[stage] !== undefined) return { ...r, content: JSON.stringify(overrides[stage]) };
      return r;
    },
  };
}

test("R10 brain: a strict evaluator that keeps answering 'escalate' re-escalates to the manager every cycle, with no cap", async () => {
  const p = new FakePlatform({
    providers: {
      mock: provider({
        "metacognition.confidence": { confidence: 0.9, uncertainty: 0.2 },
        "metacognition.solving_evaluation.feedback": { score: 0.1, truthful: 0.1, good: false, issues: ["not good enough"], decision: "escalate", summary: "insufficient" },
      }),
    },
  });
  p.addDepartment("dep_exec", "executive", "Executive");
  p.addDepartment("dep_eng", "engineering", "Engineering");
  const ceo = p.addAgent(makeAgent({ id: "agt_ceo", name: "Ava", title: "CEO", departmentId: "dep_exec", managerId: null, tier: "executive", cognition: "brain", modelTier: "frontier", tools: TOOLS }));
  const cto = p.addAgent(makeAgent({ id: "agt_cto", name: "Lena", title: "CTO", departmentId: "dep_eng", managerId: ceo.id, tier: "executive", cognition: "brain", modelTier: "frontier", tools: TOOLS }));
  p.addAgent(makeAgent({ id: "agt_ew", name: "Ola", title: "Backend Engineer", departmentId: "dep_eng", managerId: cto.id, tools: ["workspace_write_file", "escalate"] }));
  const task = p.addTask(makeTask({ id: "tsk_root", number: 7, title: "Ship the billing API", description: "Design and ship the billing API.", assigneeId: cto.id, value: 800, estCostUsd: 0.5 }));
  const brain = new BrainEngine({ maxRevisions: 2, runTimeoutMs: 300_000 });

  let trigger: "task" | "subtasks_completed" = "task";
  const outcomes: string[] = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    // input.task is a copy, exactly like RunService (tasks.begin returns a fresh row)
    const input = taskInput({ ...task, state: { ...task.state } }, trigger, { subtasks: p.tasks.children(task.id) });
    const r = await brain.run(p.context(cto, input));
    outcomes.push(r.outcome);
    if (r.taskState) task.state = { ...task.state, ...r.taskState };
    if (r.outcome !== "waiting") break;
    for (const c of p.tasks.children(task.id)) if (!["done", "failed", "cancelled"].includes(c.status)) Object.assign(c, { status: "done", result: "Manager: proceed with option B." });
    trigger = "subtasks_completed";
  }
  const escalations = p.tasks.children(task.id).filter((c) => c.state.kind === "escalation").length;
  console.log(`R10: outcomes ${outcomes.join(" → ")}; escalation subtasks created: ${escalations}`);
  assert.ok(escalations <= 2, `${escalations} escalations for one task: the loop is unbounded`);
});

// ═════════════════════════ Fix coverage beyond the reviewer's repro ═════════════════════════

function company(providers: Record<string, ModelProvider>) {
  const p = new FakePlatform({ providers });
  p.addDepartment("dep_exec", "executive", "Executive");
  p.addDepartment("dep_eng", "engineering", "Engineering");
  const ceo = p.addAgent(makeAgent({ id: "agt_ceo", name: "Ava", title: "CEO", departmentId: "dep_exec", managerId: null, tier: "executive", cognition: "brain", modelTier: "frontier", tools: TOOLS }));
  const cto = p.addAgent(makeAgent({ id: "agt_cto", name: "Lena", title: "CTO", departmentId: "dep_eng", managerId: ceo.id, tier: "executive", cognition: "brain", modelTier: "frontier", tools: TOOLS }));
  return { p, ceo, cto };
}

/** Mock provider whose tool-loop turns call `calls(step)`; JSON stages may be overridden. */
function toolScript(calls: (step: number) => { name: string; arguments: Record<string, unknown> }[], overrides: Record<string, unknown> = {}): ModelProvider {
  const base = provider(overrides);
  let step = 0;
  return {
    name: "mock",
    async complete(profile, request: ChatRequest, signal) {
      const r = await base.complete(profile, request, signal);
      if (!request.tools?.length) return r;
      step += 1;
      return { ...r, content: "", toolCalls: calls(step).map((c, i) => ({ id: `c${step}_${i}`, ...c })), finishReason: "tool_calls" as const };
    },
  };
}

test("F1 decide: with no revision, rollback or escalation left the rule settles on fail (never an endless revise)", () => {
  const teg = { truthful: false, efficient: true, good: false } as never;
  const base = { modelDecision: "escalate" as const, score: 0.1, teg, revisionsLeft: 0, rollbackAvailable: false };
  assert.equal(decide({ ...base, canEscalate: true }), "escalate");
  assert.equal(decide({ ...base, canEscalate: false }), "fail");
  assert.equal(decide({ ...base, canEscalate: false, score: 0.5 }), "accept", "accept partial");
  assert.equal(decide({ ...base, canEscalate: false, revisionsLeft: 1 }), "revise");
});

test("F1 brain: once the Board answered, a frustrated CEO proceeds instead of asking the Board again", async () => {
  const { p, ceo } = company({ mock: provider({}) });
  ceo.affect = { valence: -0.4, arousal: 0.5, frustration: 0.9 }; // frustration gate forces the early stop
  const task = p.addTask(makeTask({ id: "tsk_f", number: 9, title: "Pick a market", description: "Pick our launch market.", assigneeId: ceo.id, value: 800, estCostUsd: 0.5 }));
  const brain = new BrainEngine({ maxRevisions: 1, runTimeoutMs: 300_000 });
  const first = await brain.run(p.context(ceo, taskInput({ ...task })));
  assert.equal(first.outcome, "blocked");
  assert.equal(p.approvals.length, 1);
  const state = { ...p.tasks.get(task.id)!.state, ...first.taskState };
  assert.equal((state.checkpoint as { reason: string }).reason, "asked the Board", "blocked on the Board with a checkpoint to resume");
  const approval = { ...p.approvals[0]!, status: "approved" as const, note: "Japan." };
  const second = await brain.run(p.context(ceo, taskInput({ ...task, state }, "human_answer", { answeredApproval: approval })));
  assert.notEqual(second.outcome, "blocked", "no second question to the Board");
  assert.equal(p.approvals.length, 1);
  assert.deepEqual((second.taskState as Record<string, unknown>).escalation, { count: 1, answered: true });
});

test("F2 fakes: patchState returns a fresh copy and never mutates the engine's input snapshot", () => {
  const p = new FakePlatform();
  const task = p.addTask(makeTask({ id: "tsk_c", state: { a: 1 } }));
  const updated = p.tasks.patchState(task.id, { b: 2 });
  assert.deepEqual(task.state, { a: 1 }, "the snapshot is untouched (as with the real TaskService)");
  assert.deepEqual(updated.state, { a: 1, b: 2 });
  assert.notEqual(updated, p.tasks.get(task.id));
  assert.deepEqual(p.tasks.get(task.id)!.state, { a: 1, b: 2 });
});

test("F3 tool loop: escalate ends the loop as waiting (subtask), ask_human as blocked (approval)", async () => {
  for (const [tool, expected] of [
    ["escalate", "waiting"],
    ["ask_human", "blocked"],
  ] as const) {
    const { p, cto } = company({ mock: toolScript((s) => (s === 1 ? [{ name: tool, arguments: { reason: "scope unclear", question: "Which DB?" } }] : [{ name: "complete_task", arguments: { result: "carried on" } }])) });
    const task = p.addTask(makeTask({ id: `tsk_${tool}`, assigneeId: cto.id }));
    const ctx = p.context(cto, taskInput(task));
    const loop = await runToolLoop({
      ctx, stage: "reflex.step", tier: "economy", parentSpan: ctx.span, system: "[[stage:reflex.step]] work", user: "Begin.",
      tools: p.tools.specsFor(cto), terminal: { complete: true, blocker: true }, maxSteps: 4, taskId: task.id, conversationId: null, activityLabel: "x",
    });
    assert.equal(loop.status, expected, tool);
    assert.equal(loop.steps, 1, "the loop stopped at the escalation");
    assert.match(loop.reason, /scope unclear/);
    if (tool === "escalate") assert.equal(loop.escalationTaskId, p.escalations[0]);
    else assert.equal(loop.approvalId, p.approvals[0]!.id);
  }
});

test("F3 brain: an escalate call inside the Solving loop → waiting on that one escalation, checkpointed at Solving", async () => {
  const { p, cto } = company({
    mock: toolScript(() => [{ name: "escalate", arguments: { reason: "need a decision", question: "Postgres or SQLite?" } }], { "metacognition.confidence": { confidence: 0.9, uncertainty: 0.2 } }),
  });
  const task = p.addTask(makeTask({ id: "tsk_s", number: 11, title: "Pick the DB", description: "Choose the database.", assigneeId: cto.id, value: 800, estCostUsd: 0.5 }));
  const r = await new BrainEngine({ maxRevisions: 1 }).run(p.context(cto, taskInput({ ...task })));
  assert.equal(r.outcome, "waiting", r.error ?? r.output);
  assert.equal(p.escalations.length, 1, "the loop's escalation is reused, not duplicated by the engine");
  const cp = r.taskState?.checkpoint as { block: string; reason: string };
  assert.equal(cp.block, "metacognition.solving_evaluation.solving");
  assert.equal(cp.reason, "escalated to manager");
  assert.deepEqual((r.taskState as Record<string, unknown>).escalation, { count: 1, answered: false });
});

test("F11 router: a provider timeout falls back to the fallback profile; a caller abort does not", async (t) => {
  const env = { MODEL_STANDARD: "openai:gpt-6.1-sol", MODEL_STANDARD_FALLBACK: "deepseek:deepseek-v4-pro", OPENAI_API_KEY: "sk-test", DEEPSEEK_API_KEY: "sk-test2", MODEL_TIMEOUT_MS: "30" };
  const served: string[] = [];
  const slowPrimary: ModelProvider = {
    name: "openai-compatible",
    complete(profile, _request, signal) {
      served.push(profile.id);
      if (profile.id === "deepseek:deepseek-v4-pro") return Promise.resolve({ content: "from fallback", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, finishReason: "stop" as const });
      // Hangs until the router's per-request timeout fires, then rejects like fetch does.
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };
  const p = new FakePlatform({ env, providers: { "openai-compatible": slowPrimary } });
  const agent = p.addAgent(makeAgent({ id: "agt_r", modelTier: "standard" }));
  const span = p.tracer.startSpan({ traceId: "trc_r", parentSpanId: null, kind: "run", name: "run" });
  const ctx = (signal: AbortSignal) => ({ agentId: agent.id, runId: "run_r", traceId: "trc_r", parentSpanId: span.spanId, taskId: null, stage: "test", signal });
  // AbortSignal.timeout() timers are unref'd: keep the event loop alive like a running server does.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const res = await p.models.chat({ tier: "standard", messages: [{ role: "user", content: "hi" }] }, ctx(new AbortController().signal));
  assert.equal(res.content, "from fallback");
  assert.deepEqual(served, ["openai:gpt-6.1-sol", "deepseek:deepseek-v4-pro"]);
  const llm = p.tracer.byKind("llm");
  assert.equal(llm[0]!.status, "error", "the timed-out attempt is an error, not a cancellation");
  assert.equal(llm[1]!.attributes["agentco.fallback_from"], "openai:gpt-6.1-sol");

  served.length = 0;
  const caller = new AbortController();
  setTimeout(() => caller.abort(Object.assign(new Error("Run interrupted by the Board"), { name: "RunAbortedError" })), 5);
  await assert.rejects(p.models.chat({ tier: "standard", messages: [{ role: "user", content: "hi" }] }, ctx(caller.signal)), /interrupted/);
  assert.deepEqual(served, ["openai:gpt-6.1-sol"], "an abort by the caller never falls back");
});
