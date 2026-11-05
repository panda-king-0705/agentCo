import { test } from "node:test";
import assert from "node:assert/strict";
import { ReflexEngine } from "../../src/cognition/reflex.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import type { ModelProvider } from "../../src/contracts.ts";
import { FakePlatform, makeAgent, makeTask, messageInput, taskInput } from "./fakes.ts";

function setup(options: { providers?: Record<string, ModelProvider>; tools?: string[] } = {}) {
  const platform = new FakePlatform({ providers: options.providers });
  platform.addDepartment("dep_mkt", "marketing", "Marketing");
  const manager = platform.addAgent(makeAgent({ id: "agt_cmo", name: "Maya Ortiz", title: "Chief Marketing Officer", departmentId: "dep_mkt", tier: "executive", cognition: "brain", modelTier: "frontier" }));
  const worker = platform.addAgent(
    makeAgent({
      id: "agt_writer",
      name: "Sam Lee",
      title: "Content Marketer",
      departmentId: "dep_mkt",
      managerId: manager.id,
      tools: options.tools ?? ["workspace_write_file", "memory_search", "escalate"],
    }),
  );
  const task = platform.addTask(
    makeTask({ id: "tsk_w", number: 12, title: "Write the launch blog post", description: "Announce the AI meeting-notes app to busy teams.", assigneeId: worker.id, acceptanceCriteria: "Under 800 words; clear call to action" }),
  );
  return { platform, worker, manager, task };
}

test("reflex: writes its deliverable with a tool, then completes with a concrete result", async () => {
  const { platform, worker, task } = setup();
  const ctx = platform.context(worker, taskInput(task));
  const result = await new ReflexEngine().run(ctx);
  assert.equal(result.outcome, "completed");
  assert.ok(result.output.length > 300, "multi-paragraph deliverable");
  assert.match(result.output, /launch blog post/i);
  const [path, content] = [...platform.files.entries()][0]!;
  assert.match(path, /^shared\/marketing\/t12-write-the-launch-blog-post\.md$/);
  assert.ok(content.includes("## Positioning"), "marketing-flavoured content");
  // Tool spans: the platform's write + the engine's terminal complete_task, both under the run span.
  const tools = platform.tracer.byKind("tool");
  assert.deepEqual(tools.map((s) => s.name), ["tool.workspace_write_file", "tool.complete_task"]);
  for (const s of [...tools, ...platform.tracer.byKind("llm")]) assert.equal(s.parentSpanId, ctx.span.spanId);
  assert.ok(platform.tracer.byKind("llm").every((s) => s.attributes["agentco.tier"] === "economy" && s.attributes["agentco.stage"] === "reflex.step"));
  // Readable activity and one episodic memory.
  assert.ok(platform.activity.some((a) => a.status === "acting" && a.activity === `Writing ${path}`));
  assert.equal(platform.activity.at(-1)!.status, "idle");
  const episodes = platform.memories.filter((m) => m.kind === "episodic");
  assert.equal(episodes.length, 1);
  assert.match(episodes[0]!.content, /T-12 .*completed/);
});

test("reflex: completes directly when it has no tools", async () => {
  const { platform, worker, task } = setup({ tools: [] });
  const result = await new ReflexEngine().run(platform.context(worker, taskInput(task)));
  assert.equal(result.outcome, "completed");
  assert.equal(platform.files.size, 0);
  assert.ok(result.output.includes("# Write the launch blog post"));
});

test("reflex: message trigger ends with a plain text reply", async () => {
  const { platform, worker } = setup();
  const result = await new ReflexEngine().run(platform.context(worker, messageInput("Hi Sam, how are you?")));
  assert.equal(result.outcome, "completed");
  assert.match(result.output, /Sam Lee/);
  assert.equal(platform.memories.length, 0, "chat replies are not episodes");
});

test("reflex: cascades economy → standard once after a failure", async () => {
  const mock = new MockProvider({ latencyMs: 0 });
  const flaky: ModelProvider = {
    name: "mock",
    complete: (profile, request, signal) => (profile.tier === "economy" ? Promise.reject(new Error("economy model overloaded")) : mock.complete(profile, request, signal)),
  };
  const { platform, worker, task } = setup({ providers: { mock: flaky } });
  const ctx = platform.context(worker, taskInput(task));
  const result = await new ReflexEngine().run(ctx);
  assert.equal(result.outcome, "completed");
  const llm = platform.tracer.byKind("llm");
  assert.equal(llm[0]!.status, "error");
  assert.equal(llm[0]!.attributes["agentco.tier"], "economy");
  assert.ok(llm.slice(1).every((s) => s.status === "ok" && s.attributes["agentco.tier"] === "standard"));
  const run = platform.tracer.spans.find((s) => s.id === ctx.span.spanId)!;
  assert.equal(run.attributes["agentco.cascade"], "economy→standard");
});

test("reflex: exhausting steps on both tiers fails", async () => {
  const { platform, worker, task } = setup();
  const result = await new ReflexEngine({ maxSteps: 1 }).run(platform.context(worker, taskInput(task)));
  assert.equal(result.outcome, "failed");
  assert.match(result.error ?? "", /after cascade/);
  const tiers = platform.tracer.byKind("llm").map((s) => s.attributes["agentco.tier"]);
  assert.deepEqual(tiers, ["economy", "standard"]);
});

function blockerProvider(): ModelProvider {
  return {
    name: "mock",
    complete: async () => ({
      content: "",
      toolCalls: [{ id: "c1", name: "report_blocker", arguments: { reason: "No product name decided" } }],
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      finishReason: "tool_calls",
    }),
  };
}

test("reflex: report_blocker escalates to the manager (escalation subtask) and returns waiting", async () => {
  const { platform, worker, task, manager } = setup({ providers: { mock: blockerProvider() } });
  const result = await new ReflexEngine().run(platform.context(worker, taskInput(task)));
  assert.equal(result.outcome, "waiting");
  assert.match(result.output, /No product name decided/);
  assert.equal(platform.sent[0]!.to, manager.id);
  const [esc] = platform.tasks.children(task.id);
  assert.equal(esc!.assigneeId, manager.id);
  assert.equal(esc!.state.kind, "escalation");
  assert.ok(platform.tracer.spans.some((s) => s.name === "tool.report_blocker" && s.kind === "tool"));
});

test("reflex: escalation answer arrives on subtasks_completed and goes into the prompt", async () => {
  const seen: string[] = [];
  const mock = new MockProvider({ latencyMs: 0 });
  const spy: ModelProvider = {
    name: "mock",
    complete: async (profile, request, signal) => {
      seen.push(request.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
      return mock.complete(profile, request, signal);
    },
  };
  const { platform, worker, task, manager } = setup({ providers: { mock: spy } });
  const esc = platform.addTask(
    makeTask({ id: "tsk_esc", number: 13, parentTaskId: task.id, rootTaskId: task.id, title: "Escalation", assigneeId: manager.id, status: "done", result: "Name it Notely.", state: { kind: "escalation", escalatedBy: worker.id } }),
  );
  const result = await new ReflexEngine().run(platform.context(worker, taskInput(task, "subtasks_completed", { subtasks: [esc] })));
  assert.ok(seen.some((m) => m.includes("Answer to your escalation") && m.includes("Name it Notely.")), "answer in the prompt");
  assert.equal(result.outcome, "completed");
});

test("reflex: respects abort and does not cascade", async () => {
  const { platform, worker, task } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new ReflexEngine().run(platform.context(worker, taskInput(task), { signal: controller.signal })), (err: Error) => err.name === "AbortError");
  assert.equal(platform.tracer.byKind("llm").length, 0);
});

test("reflex: BudgetExceededError propagates (no cascade)", async () => {
  const { platform, worker, task } = setup();
  platform.budget.limitUsd = 0;
  await assert.rejects(new ReflexEngine().run(platform.context(worker, taskInput(task))), (err: Error) => err.name === "BudgetExceededError");
});
