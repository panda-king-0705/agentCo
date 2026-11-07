// 2026-11-08 (trc_92d7…, the forex scalper: $2.75, 0 of 4 met, no code in the repository):
// - an engineer marked the whole code package "done" with "Nothing has been written yet";
// - saves cut off by the reply's length limit were resent 20+ times at the same size;
// - a retried engineer took his own earlier commit for the founder's and stopped to ask;
// - "Wire the risk manager…" went to Finance, which cannot commit to the repository;
// - the independent check marked a committed spec missing: it could only see the company drive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReflexEngine } from "../../src/cognition/reflex.ts";
import { BrainEngine } from "../../src/cognition/brain/index.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import { readStage } from "../../src/models/protocol.ts";
import type { ChatRequest, ModelProvider, ToolCall, ToolResult } from "../../src/contracts.ts";
import type { Agent } from "../../../../packages/shared/src/index.ts";
import { FakePlatform, makeAgent, makeTask, taskInput } from "./fakes.ts";

type Step = { content?: string; toolCalls?: ToolCall[] };

/** A provider that answers reflex steps from a script and records each request. */
function scripted(steps: Step[], seen: ChatRequest[]): ModelProvider {
  const mock = new MockProvider({ latencyMs: 0 });
  let i = 0;
  return {
    name: "mock",
    async complete(profile, request, signal) {
      if (readStage(request.messages) !== "reflex.step") return mock.complete(profile, request, signal);
      seen.push(request);
      const s = steps[Math.min(i++, steps.length - 1)]!;
      return { content: s.content ?? "", toolCalls: s.toolCalls ?? [], usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }, finishReason: s.toolCalls?.length ? ("tool_calls" as const) : ("stop" as const) };
    },
  };
}
const call = (name: string, args: Record<string, unknown>, id = `c_${Math.random().toString(36).slice(2, 8)}`): ToolCall => ({ id, name, arguments: args });
const toolMessages = (r: ChatRequest) => r.messages.filter((m) => m.role === "tool").map((m) => m.content);

function worker(p: FakePlatform): Agent {
  p.addDepartment("dep_eng", "engineering", "Engineering");
  const cto = p.addAgent(makeAgent({ id: "agt_cto", name: "Kenji Tanaka", title: "Chief Technology Officer", departmentId: "dep_eng", tier: "executive", cognition: "brain", tools: ["delegate_task"] }));
  return p.addAgent(makeAgent({ id: "agt_arjun", name: "Arjun Mehta", title: "Backend Engineer", departmentId: "dep_eng", managerId: cto.id, tier: "worker", cognition: "reflex", tools: ["workspace_write_file", "workspace_read_file", "escalate"] }));
}
const BRIEF = { title: "Write fx_scalper/signals.py", description: "Write the signal module and commit it on branch t-308-fx-scalper.", acceptanceCriteria: "Committed." };

test("a brief that asks for commits: finishing with nothing saved is refused once; after a save it completes", async () => {
  const seen: ChatRequest[] = [];
  const p = new FakePlatform({
    providers: {
      mock: scripted(
        [
          { toolCalls: [call("complete_task", { result: "Plan: I will write signals.py next." })] },
          { toolCalls: [call("workspace_write_file", { path: "fx_scalper/signals.py", content: "def signal(): ..." })] },
          { toolCalls: [call("complete_task", { result: "Saved fx_scalper/signals.py." })] },
        ],
        seen,
      ),
    },
  });
  const arjun = worker(p);
  const task = p.addTask(makeTask({ id: "tsk_310", number: 310, ...BRIEF, assigneeId: arjun.id }));
  const r = await new ReflexEngine({ maxSteps: 6 }).run(p.context(arjun, taskInput(task)));
  assert.equal(r.outcome, "completed", r.error ?? r.output);
  assert.equal(r.output, "Saved fx_scalper/signals.py.");
  assert.match(toolMessages(seen[1]!).join("\n"), /^Error: Not done yet: your brief asks for saved or committed work, and nothing has been saved or committed for this task\./m);
  assert.ok(p.tracer.spans.some((s) => s.attributes["agentco.empty_done_refused"] === true));

  // Insisting (a task that truly needed no save) completes on the second call.
  const seen2: ChatRequest[] = [];
  const q = new FakePlatform({ providers: { mock: scripted([{ toolCalls: [call("complete_task", { result: "Nothing to change: the module already exists." })] }], seen2) } });
  const a2 = worker(q);
  const t2 = q.addTask(makeTask({ id: "tsk_311", number: 311, ...BRIEF, assigneeId: a2.id }));
  const r2 = await new ReflexEngine({ maxSteps: 6 }).run(q.context(a2, taskInput(t2)));
  assert.equal(r2.outcome, "completed");
  assert.equal(seen2.length, 2);
});

test("out of steps with nothing saved is a blocker for the manager, not a 'done'", async () => {
  const seen: ChatRequest[] = [];
  const p = new FakePlatform({ providers: { mock: scripted([{ toolCalls: [call("workspace_read_file", { path: "docs/fx-scalper/spec.md" })] }, { content: "Nothing has been written yet; the branch is reachable." }], seen) } });
  const arjun = worker(p);
  p.files.set("docs/fx-scalper/spec.md", "# Spec");
  const task = p.addTask(makeTask({ id: "tsk_312", number: 312, ...BRIEF, assigneeId: arjun.id }));
  const r = await new ReflexEngine({ maxSteps: 2 }).run(p.context(arjun, taskInput(task)));
  assert.notEqual(r.outcome, "completed", "never 'done' with nothing saved");
  assert.match(`${r.output} ${r.error ?? ""} ${p.escalations.join(" ")} ${p.approvals.map((a) => a.summary).join(" ")}`, /Ran out of steps before saving or committing anything for this task\. Where I got to: Nothing has been written yet/);
});

test("a cut-off call gives the next replies more room, and says so", async () => {
  const seen: ChatRequest[] = [];
  const p = new FakePlatform({
    providers: {
      mock: scripted(
        [
          { toolCalls: [call("workspace_write_file", { path: "fx_scalper/executor.py", content: "x" })] },
          { toolCalls: [call("workspace_write_file", { path: "fx_scalper/executor.py", content: "y" })] },
          { toolCalls: [call("complete_task", { result: "Saved." })] },
        ],
        seen,
      ),
    },
  });
  const arjun = worker(p);
  let first = true;
  const execute = p.tools.execute.bind(p.tools);
  (p.tools as { execute: typeof execute }).execute = async (c, ctx): Promise<ToolResult> => {
    if (c.name === "workspace_write_file" && first) {
      first = false;
      return { ok: false, content: "your workspace_write_file call was cut off before it finished (the reply hit its length limit), so nothing happened. Save the file in parts.", effects: [] };
    }
    return execute(c, ctx);
  };
  const task = p.addTask(makeTask({ id: "tsk_313", number: 313, ...BRIEF, assigneeId: arjun.id }));
  const r = await new ReflexEngine({ maxSteps: 6 }).run(p.context(arjun, taskInput(task)));
  assert.equal(r.outcome, "completed", r.error ?? r.output);
  assert.deepEqual(seen.map((s) => s.maxOutputTokens), [4000, 8000, 8000]);
  assert.match(toolMessages(seen[1]!)[0]!, /Your next replies have room for about 5,600 words in total — still send long content in parts\.$/);
});

test("a retry is told what its earlier attempt already did, and that work counts as saved", async () => {
  const seen: ChatRequest[] = [];
  const p = new FakePlatform({ providers: { mock: scripted([{ toolCalls: [call("complete_task", { result: "The spec is committed (my earlier attempt); next is the code." })] }], seen) } });
  const arjun = worker(p);
  (p as unknown as { taskWrites: () => unknown[] }).taskWrites = () => [
    { at: "2026-11-07T20:08:13.000Z", agent: "Arjun Mehta", tool: "github_create_branch", what: "t-308-fx-scalper" },
    { at: "2026-11-07T20:09:21.000Z", agent: "Arjun Mehta", tool: "github_create_or_update_file", what: "panda-king-0705/Agent-Co-Agent-Codespace@t-308-fx-scalper: docs/fx-scalper/spec.md" },
  ];
  const task = p.addTask(makeTask({ id: "tsk_310", number: 310, ...BRIEF, assigneeId: arjun.id, attempts: 2 }));
  const r = await new ReflexEngine({ maxSteps: 6 }).run(p.context(arjun, taskInput(task)));
  assert.equal(r.outcome, "completed");
  assert.equal(seen.length, 1, "earlier commits count: no refusal");
  const system = seen[0]!.messages[0]!.content;
  assert.match(system, /Already done on this task by earlier attempts \(these stand: build on them, don't redo them, and don't mistake them for someone else's work\):\n- 20:08 UTC Arjun Mehta: github_create_branch — t-308-fx-scalper\n- 20:09 UTC Arjun Mehta: github_create_or_update_file — panda-king-0705\/Agent-Co-Agent-Codespace@t-308-fx-scalper: docs\/fx-scalper\/spec\.md/);
});

test("a part that writes code goes to someone who can commit it, not the department the plan suggested", async () => {
  const plan = {
    mode: "delegate",
    subprocesses: [{ title: "Wire risk manager to Finance limits in risk.md", description: "Make the risk manager enforce the limits.", assigneeId: "agt_cfo", value: 300, estCostUsd: 0.05, acceptanceCriteria: "Enforced." }],
    candidates: [
      { name: "high_cost", approach: "a", estCostUsd: 5, expectedValue: 100, meetsCriteria: true },
      { name: "low_cost", approach: "b", estCostUsd: 0.01, expectedValue: 900, meetsCriteria: true },
      { name: "low_effort", approach: "c", estCostUsd: 0.02, expectedValue: 100, meetsCriteria: true },
    ],
    rationale: "Finance knows the limits.",
  };
  const mock = new MockProvider({ latencyMs: 0 });
  const p = new FakePlatform({
    providers: {
      mock: {
        name: "mock",
        async complete(profile, request, signal) {
          const r = await mock.complete(profile, request, signal);
          return readStage(request.messages) === "metacognition.cognitive_control" ? { ...r, content: JSON.stringify(plan) } : r;
        },
      },
    },
  });
  p.addDepartment("dep_exec", "executive", "Executive");
  p.addDepartment("dep_fin", "finance", "Finance");
  p.addDepartment("dep_eng", "engineering", "Engineering");
  const brain = (id: string, name: string, title: string, departmentId: string, managerId: string | null) =>
    p.addAgent(makeAgent({ id, name, title, departmentId, managerId, tier: "executive", cognition: "brain", modelTier: "frontier", tools: ["delegate_task"], identity: { mission: `${title} work.` } as never }));
  const ceo = brain("agt_ceo", "Ava Chen", "Chief Executive Officer", "dep_exec", null);
  brain("agt_cfo", "Elena Petrova", "Chief Financial Officer", "dep_fin", ceo.id);
  const cto = brain("agt_cto", "Kenji Tanaka", "Chief Technology Officer", "dep_eng", ceo.id);
  (p as unknown as { capabilities: unknown }).capabilities = { company: () => new Set(["git"]), of: (a: Agent) => new Set(a.id === cto.id ? ["git"] : []), services: () => [] };
  const task = p.addTask(makeTask({ id: "tsk_313", number: 313, title: "Forex bot", description: "Build it.", assigneeId: ceo.id, createdBy: "system" }));
  const r = await new BrainEngine().run(p.context(ceo, taskInput(task)));
  assert.equal(r.outcome, "waiting", r.error ?? r.output);
  assert.deepEqual(p.tasks.children(task.id).map((c) => c.assigneeId), [cto.id]);
});

test("reviews and the independent check see what was committed to the repository", async () => {
  const seenPrompts: string[] = [];
  const mock = new MockProvider({ latencyMs: 0 });
  const p = new FakePlatform({
    providers: {
      mock: {
        name: "mock",
        async complete(profile, request, signal) {
          const stage = readStage(request.messages) ?? "";
          if (stage === "metacognition.solving_evaluation.validation" || stage === "metacognition.solving_evaluation.feedback") seenPrompts.push(request.messages.map((m) => m.content).join("\n"));
          return mock.complete(profile, request, signal);
        },
      },
    },
  });
  p.addDepartment("dep_exec", "executive", "Executive");
  const ceo = p.addAgent(makeAgent({ id: "agt_ceo", name: "Ava Chen", title: "Chief Executive Officer", departmentId: "dep_exec", tier: "executive", cognition: "brain", modelTier: "frontier", tools: ["workspace_write_file"], identity: { mission: "Deliver." } as never }));
  (p as unknown as { outsideFiles: () => Promise<unknown[]> }).outsideFiles = async () => [{ display: "acme/bot@t-308-fx-scalper:docs/fx-scalper/spec.md", by: "the repository", content: "# Spec\nEUR/USD, 1-minute candles, EMA 9/21 with RSI(14)", truncated: false, words: 8, lines: 2 }];
  const task = p.addTask(makeTask({ id: "tsk_1", number: 1, title: "Write the spec", description: "Write the spec and commit it.", assigneeId: ceo.id }));
  task.state.contract = [{ id: "A1", text: "docs/fx-scalper/spec.md defines the pair and timeframe" }];
  await new BrainEngine().run(p.context(ceo, taskInput(task)));
  assert.ok(seenPrompts.length >= 2, "the check and the leader's review both ran");
  for (const prompt of seenPrompts) assert.match(prompt, /=== acme\/bot@t-308-fx-scalper:docs\/fx-scalper\/spec\.md/);
});
