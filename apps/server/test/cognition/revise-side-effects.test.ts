// Live regression (2026-11-06, T-154): "record my custodian ID" succeeded on the first attempt, but
// Feedback's verdict could not be read, defaulted to "revise", and each revision re-ran Solving —
// writing the same memory three times. Fixed in four places, tested here and in core/live-loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrainEngine, describeEffects } from "../../src/cognition/brain/index.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import { readStage } from "../../src/models/protocol.ts";
import type { ModelProvider } from "../../src/contracts.ts";
import { FakePlatform, makeAgent, makeTask, taskInput } from "./fakes.ts";

const TOOLS = ["memory_search", "memory_write", "workspace_write_file", "blackboard_write"];
const FEEDBACK = "metacognition.solving_evaluation.feedback";

/** Mock provider with a scripted Feedback reply per call (raw content); `prompts` records every stage's prompt. */
function provider(feedbackReplies: string[], prompts: { stage: string; text: string }[] = []): ModelProvider {
  const mock = new MockProvider({ latencyMs: 0 });
  let n = 0;
  return {
    name: "mock",
    async complete(profile, request, signal) {
      prompts.push({ stage: readStage(request.messages) ?? "", text: request.messages.map((m) => m.content).join("\n") });
      const r = await mock.complete(profile, request, signal);
      if (request.responseFormat === "json" && readStage(request.messages) === FEEDBACK) return { ...r, content: feedbackReplies[Math.min(n++, feedbackReplies.length - 1)]! };
      return r;
    },
  };
}

function solo(replies: string[], prompts: { stage: string; text: string }[] = []) {
  const p = new FakePlatform({ providers: { mock: provider(replies, prompts) } });
  p.addDepartment("dep_exec", "executive", "Executive");
  // A lone executive (no reports) solves directly.
  const ceo = p.addAgent(makeAgent({ id: "agt_ceo", name: "Ava", title: "Chief Executive Officer", departmentId: "dep_exec", tier: "executive", cognition: "brain", modelTier: "frontier", tools: TOOLS }));
  const task = p.addTask(makeTask({ id: "tsk_1", number: 154, title: "Record the custodian ID", description: "Record custodian ID U2522199H in the company knowledge base.", assigneeId: ceo.id, value: 300, estCostUsd: 0.05 }));
  return { p, ceo, task };
}
const stageCalls = (p: FakePlatform, s: string) => p.tracer.byKind("llm").filter((x) => x.attributes["agentco.stage"] === s).length;
const solvingRuns = (p: FakePlatform) => p.tracer.spans.filter((s) => s.attributes["agentco.brain.block"] === "metacognition.solving_evaluation.solving").length;

test("an unreadable Feedback verdict is repaired once, then a non-empty result is accepted — not re-solved", async () => {
  const { p, ceo, task } = solo(["Looks good overall, the ID was stored and verified by", "still not json"]);
  const r = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task)));
  assert.equal(r.outcome, "completed");
  assert.equal(stageCalls(p, FEEDBACK), 2, "the original call and one repair attempt");
  assert.equal(solvingRuns(p), 1, "Solving ran once: no revise loop");
  assert.ok(p.tracer.spans.some((s) => s.attributes["agentco.feedback.degraded"] === true));
});

test("a repaired Feedback verdict is used as normal", async () => {
  const verdict = JSON.stringify({ score: 0.9, truthful: 0.95, good: true, issues: [], decision: "accept", summary: "Stored and read back." });
  const { p, ceo, task } = solo([`{"score": 0.9, "truthful": 0.95, "issues": ["cut o`, verdict]);
  const r = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task)));
  assert.equal(r.outcome, "completed");
  assert.equal(solvingRuns(p), 1);
  assert.ok(!p.tracer.spans.some((s) => s.attributes["agentco.feedback.degraded"] === true));
});

test("a revision is told what the earlier attempt already changed, so it builds on it instead of repeating it", async () => {
  const revise = JSON.stringify({ score: 0.3, truthful: 0.9, good: false, issues: ["missing the read-back"], decision: "revise", summary: "Again." });
  const accept = JSON.stringify({ score: 0.9, truthful: 0.95, good: true, issues: [], decision: "accept", summary: "Done." });
  const prompts: { stage: string; text: string }[] = [];
  const { p, ceo, task } = solo([revise, accept], prompts);
  const r = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task)));
  assert.equal(r.outcome, "completed");
  assert.equal(solvingRuns(p), 2);
  const told = prompts.filter((x) => /Already done by an earlier attempt — do not repeat it; update or build on it instead: file \S+ written/.test(x.text)).map((x) => x.stage);
  assert.ok(told.includes("metacognition.cognitive_control"), `the re-plan sees the earlier side effects (seen in: ${told.join(", ") || "none"})`);
});

test("describeEffects lists side effects only", () => {
  assert.equal(describeEffects([]), null);
  assert.equal(describeEffects([{ kind: "approval_requested", approvalId: "a" }]), null);
  assert.match(describeEffects([{ kind: "memory_written", memoryId: "mem_1" }, { kind: "file_written", path: "shared/x.md" }, { kind: "memory_written", memoryId: "mem_1" }])!, /memory mem_1 written; file shared\/x\.md written\.$/);
});
