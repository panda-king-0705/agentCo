// Test 4 (2026-11-07, T-171): the CEO's plan merged four named owners into two parts ("≤2 parts"),
// the assembler was handed its step at the same time as the sections it had to assemble, a blocked
// executive re-planned the same blocker 6–7 times in one run, and the out-of-steps call told a model
// with no tools to "finish with complete_task". Fixed in cognitive-control, solving, the brain's
// round 2 and blocker handling, and the tool loop; tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrainEngine } from "../../src/cognition/brain/index.ts";
import { measure } from "../../src/tools/builtins/files.ts";
import { coerceSubprocesses, isDependentStep, maxSubprocessesFor, mentionedPeople } from "../../src/cognition/brain/metacognition/cognitive-control.ts";
import { namedCandidates, type Candidate } from "../../src/cognition/brain/self-management/role-arrangement.ts";
import { ReflexEngine } from "../../src/cognition/reflex.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import { readContext, readStage } from "../../src/models/protocol.ts";
import type { EngineResult, ModelProvider, SavedFiles } from "../../src/contracts.ts";
import { gist, guidanceLines } from "../../src/cognition/brain/metacognition/solving-evaluation.ts";
import { Q6_EXECUTION } from "../../src/cognition/brain/interpretation.ts";
import type { Agent, Task } from "../../../../packages/shared/src/index.ts";
import { FakePlatform, makeAgent, makeTask, taskInput } from "./fakes.ts";

const BRAIN_TOOLS = ["delegate_task", "send_message", "escalate", "ask_human", "memory_search", "memory_write", "workspace_write_file", "blackboard_write"];
const SOLVING = "metacognition.solving_evaluation.solving";

type Reply = (ctx: Record<string, unknown>, n: number, prompt: string) => unknown;

/** Mock provider: JSON replies per stage, and (optionally) the tool calls Solving makes. */
function provider(json: Record<string, Reply>, solvingTool?: { name: string; arguments: Record<string, unknown> }): ModelProvider {
  const mock = new MockProvider({ latencyMs: 0 });
  const counts = new Map<string, number>();
  return {
    name: "mock",
    async complete(profile, request, signal) {
      const r = await mock.complete(profile, request, signal);
      const stage = readStage(request.messages) ?? "";
      if (solvingTool && stage === SOLVING && request.tools?.length) {
        return { ...r, content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2)}`, ...solvingTool }], finishReason: "tool_calls" as const };
      }
      if (request.responseFormat !== "json") return r;
      const n = (counts.get(stage) ?? 0) + 1;
      counts.set(stage, n);
      const f = json[stage];
      const v = f ? f(readContext(request.messages), n, request.messages.map((m) => m.content).join("\n")) : undefined;
      return v === undefined ? r : { ...r, content: typeof v === "string" ? v : JSON.stringify(v) };
    },
  };
}

function company(p: FakePlatform) {
  p.addDepartment("dep_exec", "executive", "Executive");
  p.addDepartment("dep_mkt", "marketing", "Marketing");
  p.addDepartment("dep_fin", "finance", "Finance");
  p.addDepartment("dep_eng", "engineering", "Engineering");
  const exec = (id: string, name: string, title: string, departmentId: string, managerId: string | null, mission: string): Agent =>
    p.addAgent(makeAgent({ id, name, title, departmentId, managerId, tier: "executive", cognition: "brain", modelTier: "frontier", tools: BRAIN_TOOLS, identity: { mission } as never }));
  const ceo = exec("agt_ceo", "Ava Chen", "Chief Executive Officer", "dep_exec", null, "Set direction and deliver the Board's objectives.");
  const cmo = exec("agt_cmo", "Olivia Bennett", "Chief Marketing Officer", "dep_mkt", ceo.id, "Own marketing, brand and launch campaigns.");
  const cfo = exec("agt_cfo", "Elena Petrova", "Chief Financial Officer", "dep_fin", ceo.id, "Own finance, budget, pricing and unit economics.");
  const cto = exec("agt_cto", "Kenji Tanaka", "Chief Technology Officer", "dep_eng", ceo.id, "Own engineering and platform delivery.");
  const cos = exec("agt_cos", "Noah Patel", "Chief of Staff", "dep_exec", ceo.id, "Coordinate the executive team and assemble cross-department documents.");
  return { ceo, cmo, cfo, cto, cos };
}

const apply = (task: Task, r: EngineResult) => {
  if (r.taskState) task.state = { ...task.state, ...r.taskState };
};

const CANDIDATES = [
  { name: "high_cost", approach: "thorough", estCostUsd: 5, expectedValue: 100, meetsCriteria: true },
  { name: "low_cost", approach: "same scope, cheaper", estCostUsd: 5, expectedValue: 100, meetsCriteria: true },
  { name: "low_effort", approach: "smallest change", estCostUsd: 0.001, expectedValue: 900, meetsCriteria: true },
];

test("named owners each get a part (even on the Low Effort candidate); assembly waits for round 2 with round-1 results in its brief", async () => {
  const seen: Record<string, unknown>[] = [];
  const plan = {
    mode: "delegate",
    subprocesses: [
      { title: "CMO: GTM section", description: "Write the GTM section.", assigneeId: "agt_cmo", value: 300, estCostUsd: 0.05, acceptanceCriteria: "Saved on the drive." },
      { title: "CFO: pricing section", description: "Write the pricing section.", assigneeId: "agt_cfo", value: 300, estCostUsd: 0.05, acceptanceCriteria: "Saved on the drive." },
      { title: "CTO: MVP scope section", description: "Write the MVP scope.", assigneeId: "agt_cto", value: 300, estCostUsd: 0.05, acceptanceCriteria: "Saved on the drive." },
      { title: "Assemble the one-page plan", description: "Merge the GTM, pricing and MVP sections into launch-plan/one-page.md.", assigneeId: "agt_cos", value: 300, estCostUsd: 0.05, acceptanceCriteria: "One page saved." },
    ],
    candidates: CANDIDATES,
    rationale: "One part per named owner, then assembly.",
  };
  const p = new FakePlatform({ providers: { mock: provider({ "metacognition.cognitive_control": (ctx) => (seen.push(ctx), plan) }) } });
  const { ceo, cmo, cfo, cto, cos } = company(p);
  const task = p.addTask(
    makeTask({
      id: "tsk_171",
      number: 171,
      title: "One-page AI meeting-notes launch plan, split across departments",
      description: "Have the CMO write the GTM section, the CFO the pricing section and the CTO the MVP scope; the Chief of Staff assembles them into launch-plan/one-page.md. Keep it to one page and add an executive summary.",
      assigneeId: ceo.id,
      value: 800,
      estCostUsd: 0.5,
    }),
  );

  const first = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task)));
  assert.equal(first.outcome, "waiting", first.error ?? first.output);
  apply(task, first);
  const ctx = seen[0]!;
  assert.deepEqual([...(ctx.namedOwners as string[])].sort(), [cfo.id, cmo.id, cos.id, cto.id].sort(), "the CMO, CFO, CTO and Chief of Staff are named — 'executive summary' does not name the Executive Office");
  assert.ok(Number(ctx.maxSubprocesses) >= 5, `room for every named owner plus a round-2 step (got ${ctx.maxSubprocesses})`);
  assert.equal(p.tracer.spans.find((s) => s.attributes["agentco.chosen"])?.attributes["agentco.chosen"], "low_effort", "the candidate that delegates only half the parts");
  const round1 = p.tasks.children(task.id);
  assert.deepEqual(round1.map((c) => c.assigneeId).sort(), [cfo.id, cmo.id, cto.id].sort(), "every named section owner got a part; the assembly was not handed out yet");
  const saved = (task.state.plan as { subprocesses: { title: string; round?: number; taskId: string | null }[] }).subprocesses;
  const assembly = saved.find((s) => s.title === "Assemble the one-page plan")!;
  assert.equal(assembly.round, 2);
  assert.equal(assembly.taskId, null);

  for (const c of round1) {
    c.status = "done";
    c.result = `${c.title} done: saved launch-plan/${c.title.split(":")[0]!.toLowerCase()}.md with dates, owners, metrics and risks for the launch.`;
  }
  const second = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task, "subtasks_completed", { subtasks: round1 })));
  assert.equal(second.outcome, "waiting", second.error ?? second.output);
  assert.match(second.output, /^Round 1 of T-171 is done \(3 part\(s\)\); delegated round 2: "Assemble the one-page plan"/);
  apply(task, second);
  const all = p.tasks.children(task.id);
  assert.equal(all.length, 4);
  const r2 = all.find((c) => c.title === "Assemble the one-page plan")!;
  assert.match(r2.description, /Round-1 results to work from \(if they show part of this step is already done — a hire made, a file saved — do not redo it: build on it and say so\):\n- T-/);
  for (const c of round1) assert.ok(r2.description.includes(`T-${c.number} "${c.title}"`), `brief includes T-${c.number}`);
  assert.equal((task.state.plan as { subprocesses: { title: string; taskId: string | null }[] }).subprocesses.find((s) => s.title === r2.title)!.taskId, r2.id);
  assert.equal(p.tracer.spans.filter((s) => s.attributes["agentco.brain.block"] === "metacognition.solving_evaluation.feedback").length, 0, "round 1 is not judged on its own");

  r2.status = "done";
  r2.result = "launch-plan/one-page.md saved: GTM, pricing and MVP sections attributed to their owners, dates reconciled, word count 480.";
  const third = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task, "subtasks_completed", { subtasks: p.tasks.children(task.id) })));
  assert.notEqual(third.outcome, "waiting", "no third round");
  assert.equal(p.tasks.children(task.id).length, 4, "nothing delegated again");
});

test("blocked twice in one run: escalate instead of re-planning the same blocker again", async () => {
  const p = new FakePlatform({
    providers: {
      mock: provider(
        {
          "metacognition.cognitive_control": () => ({ mode: "direct", subprocesses: [], candidates: CANDIDATES, rationale: "do it myself" }),
          "metacognition.solving_evaluation.feedback": () => ({ score: 0.2, truthful: 0.9, good: false, issues: ["no page yet"], decision: "revise", summary: "Try again." }),
        },
        { name: "report_blocker", arguments: { reason: "The sections do not exist yet." } },
      ),
    },
  });
  const { cos } = company(p);
  const task = p.addTask(makeTask({ id: "tsk_179", number: 179, title: "Assemble launch-plan/one-page.md", description: "Merge the sections into one page.", assigneeId: cos.id, value: 500, estCostUsd: 0.2 }));
  const r = await new BrainEngine({ maxRevisions: 4 }).run(p.context(cos, taskInput(task)));
  assert.equal(r.outcome, "waiting", r.error ?? r.output);
  const solves = p.tracer.byKind("llm").filter((s) => s.attributes["agentco.stage"] === SOLVING).length;
  assert.equal(solves, 2, "two blocked attempts, not six");
  const esc = p.tasks.children(task.id).filter((c) => c.state.kind === "escalation");
  assert.equal(esc.length, 1, "escalated to the manager");
  assert.match(esc[0]!.title, /Blocked on T-179: The sections do not exist yet\./);
});

test("out of steps: the wrap-up call says a plain-text reply completes the task (it has no tools, not even complete_task)", async () => {
  const wrapUps: string[] = [];
  const mock = new MockProvider({ latencyMs: 0 });
  const recording: ModelProvider = {
    name: "mock",
    async complete(profile, request, signal) {
      if (!request.tools?.length) wrapUps.push(request.messages.at(-1)!.content);
      return mock.complete(profile, request, signal);
    },
  };
  const p = new FakePlatform({ providers: { mock: recording } });
  p.addDepartment("dep_fin", "finance", "Finance");
  const worker = p.addAgent(makeAgent({ id: "agt_w", name: "Chloe Dubois", title: "FP&A Analyst", departmentId: "dep_fin", tools: ["workspace_write_file", "memory_search"] }));
  const task = p.addTask(makeTask({ id: "tsk_w", title: "Write the finance section", description: "Write it.", assigneeId: worker.id }));
  const r = await new ReflexEngine({ maxSteps: 1 }).run(p.context(worker, taskInput(task)));
  assert.equal(r.outcome, "completed");
  assert.equal(wrapUps.length, 1);
  assert.match(wrapUps[0]!, /your tools are now off, including complete_task\. Your plain-text reply then IS your result and completes the task — no complete_task call is needed\./);
});

test("cap, rounds and named owners: the rules", () => {
  assert.equal(maxSubprocessesFor(0.1, false), 1);
  assert.equal(maxSubprocessesFor(0.1, false, 4), 5, "four named owners + one round-2 step");
  assert.equal(maxSubprocessesFor(0.1, true, 3), 4, "the Board's explicit split beats essential-only");
  assert.equal(maxSubprocessesFor(0.1, false, 1), 1, "one named owner adds no slack");
  assert.equal(maxSubprocessesFor(1, false, 20), 8, "never more than maxParts");
  assert.ok(isDependentStep("Assemble the one-page plan", "Merge the sections"));
  assert.ok(isDependentStep("Review the drafts", "Check every section for consistency"));
  assert.ok(!isDependentStep("Review pricing strategy", "Recommend a price for the Pro tier"), "own analysis, not other parts' output");
  const parts = coerceSubprocesses(
    { subprocesses: [{ title: "CMO: GTM section" }, { title: "Reconcile the sections", description: "dates" }, { title: "Final QA", round: 1 }, { title: "CFO: pricing", round: 2 }] },
    8,
    100,
  );
  assert.deepEqual(parts.map((s) => s.round), [1, 2, 1, 2], "model-given round wins; else the step's wording");
  assert.deepEqual(coerceSubprocesses({ subprocesses: [{ title: "Assemble the sections" }] }, 8, 100).map((s) => s.round), [1], "nothing to wait for: one round");

  const agent = (id: string, name: string, title: string, departmentName: string): Candidate => ({ agent: { id, name, title } as Agent, departmentName, catalogProfile: null });
  const cands = [agent("cos", "Noah Patel", "Chief of Staff", "Executive Office"), agent("cmo", "Olivia Bennett", "Chief Marketing Officer", "Marketing")];
  assert.deepEqual([...namedCandidates("Add an executive summary", cands, { ownDepartment: "Executive Office" })], [], "the CEO's own department word names nobody");
  assert.deepEqual([...namedCandidates("Add an executive summary", cands)], ["cos"], "(without the guard it would)");
  assert.deepEqual([...namedCandidates("Noah Patel assembles the page", cands, { ownDepartment: "Executive Office" })], ["cos"], "a full name names the person");
});

// ── Second test-4 run (2026-11-07, trc_7a04…): the structure held, but checking looped — criteria no
// tool could meet ("word count from a tool"), read-backs cut at 3,000 chars, a revise that redid all
// four parts, Board decisions treated as defects, and assembly runs killed by the 5-minute limit.

test("a revision after delivered parts fixes what the feedback names — the plan is told what is done and not to redo it", async () => {
  const prompts: string[] = [];
  const ctxs: Record<string, unknown>[] = [];
  const plan = {
    mode: "delegate",
    subprocesses: [
      { title: "CMO: GTM section", description: "Write the GTM section.", assigneeId: "agt_cmo", value: 300, estCostUsd: 0.05, acceptanceCriteria: "Saved." },
      { title: "CFO: pricing section", description: "Write the pricing section.", assigneeId: "agt_cfo", value: 300, estCostUsd: 0.05, acceptanceCriteria: "Saved." },
    ],
    candidates: CANDIDATES,
    rationale: "split",
  };
  const verdict = { score: 0.6, truthful: 0.9, good: false, issues: ["The pricing section has no Free-tier line."], decision: "revise", summary: "Add the Free tier." };
  const p = new FakePlatform({
    providers: {
      mock: provider({
        "metacognition.cognitive_control": (ctx, _n, prompt) => (ctxs.push(ctx), prompts.push(prompt), plan),
        "metacognition.solving_evaluation.feedback": (_ctx, _n, prompt) => (prompts.push(prompt), verdict),
      }),
    },
  });
  const { ceo } = company(p);
  const task = p.addTask(makeTask({ id: "tsk_200", number: 200, title: "Launch plan", description: "Have the CMO write the GTM section and the CFO the pricing section.", assigneeId: ceo.id, value: 800, estCostUsd: 0.5 }));
  const first = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task)));
  apply(task, first);
  const parts = p.tasks.children(task.id);
  assert.equal(parts.length, 2);
  for (const c of parts) {
    c.status = "done";
    c.result = `${c.title}: saved launch-plan/${c.assigneeId}.md (412 words).`;
  }
  await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task, "subtasks_completed", { subtasks: parts })));
  const feedbackPrompt = prompts.find((x) => x.includes("Evaluate: score 0-1"))!;
  assert.match(feedbackPrompt, /Decisions that belong to the Board .* are NOT defects: list them in openPoints \(and mention them in the summary\)/);
  assert.match(feedbackPrompt, /Judge substance — is it correct, complete, consistent and honest\? — not formatting/);
  assert.match(feedbackPrompt, /A word, line or character count reported by a file tool, and a save the file tool confirmed, count as verified\./);
  const replan = prompts.filter((x) => x.includes("Decompose into at most")).at(-1)!;
  assert.match(replan, /Already delivered — keep these, do NOT redo them:\n- T-\d+ "CMO: GTM section" by Olivia Bennett: CMO: GTM section: saved/);
  assert.match(replan, /send a fix only to the owner whose part it concerns \(title it "Fix: …"/);
  assert.match(replan, /the file tools confirm every save and report word, line and character counts/);
  assert.ok(ctxs[0]!.namedOwners, "the first plan gives every named owner a part");
  assert.equal(ctxs.at(-1)!.namedOwners, undefined, "a fix round goes only to whoever a fix concerns");
  assert.doesNotMatch(replan, /The request names these owners/);
});

test("not enough run time for another pass: the best result is handed in with its open issues instead of starting over", async () => {
  const verdict = { score: 0.5, truthful: 0.9, good: false, issues: ["Section 4 is thin."], decision: "revise", summary: "Mostly there." };
  const p = new FakePlatform({
    providers: {
      mock: provider({
        "metacognition.cognitive_control": () => ({ mode: "direct", subprocesses: [], candidates: CANDIDATES, rationale: "myself" }),
        "metacognition.solving_evaluation.feedback": () => verdict,
      }),
    },
  });
  const { cos } = company(p);
  const task = p.addTask(makeTask({ id: "tsk_193", number: 193, title: "Assemble the one-page plan", description: "Merge the sections.", assigneeId: cos.id, value: 500, estCostUsd: 0.2 }));
  const r = await new BrainEngine({ maxRevisions: 3, runTimeoutMs: 1 }).run(p.context(cos, taskInput(task)));
  assert.equal(r.outcome, "completed", r.error ?? r.output);
  assert.match(r.output, /\n\nOpen issues \(not fixed: run time nearly used up\):\n- Section 4 is thin\./);
  assert.equal(p.tracer.spans.filter((s) => s.attributes["agentco.brain.block"] === SOLVING).length, 1, "one Solving pass, no second");
  assert.ok(p.tracer.spans.some((s) => s.attributes["agentco.time_guard"] === "revise"));
});

test("a tool result as long as one whole file read reaches the model uncut", async () => {
  const seen: string[] = [];
  let step = 0;
  const reader: ModelProvider = {
    name: "mock",
    async complete() {
      step++;
      if (step === 1) return { content: "", toolCalls: [{ id: "r1", name: "workspace_read_file", arguments: { path: "shared/launch-plan/one-page.md" } }], usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }, finishReason: "tool_calls" as const };
      return { content: "Read it.", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }, finishReason: "stop" as const };
    },
  };
  const p = new FakePlatform({ providers: { mock: { ...reader, complete: async (profile, request, signal) => (seen.push(...request.messages.filter((m) => m.role === "tool").map((m) => m.content)), reader.complete(profile, request, signal)) } } });
  p.addDepartment("dep_exec", "executive", "Executive");
  const worker = p.addAgent(makeAgent({ id: "agt_w", name: "Noah Patel", title: "Chief of Staff", departmentId: "dep_exec", tools: ["workspace_read_file"] }));
  const page = `# One-page plan\n${"Launch line with owners and dates. ".repeat(140)}\nEND-OF-PAGE`;
  assert.ok(page.length > 4000);
  p.files.set("shared/launch-plan/one-page.md", page);
  const task = p.addTask(makeTask({ id: "tsk_r", title: "Check the page", description: "Read it.", assigneeId: worker.id }));
  const r = await new ReflexEngine({ maxSteps: 3 }).run(p.context(worker, taskInput(task)));
  assert.equal(r.outcome, "completed");
  assert.ok(seen.some((c) => c.endsWith("END-OF-PAGE")), "the end of the page made it to the model");
});

test("measure: words are tokens with a letter or digit (markdown bullets and table bars don't count)", () => {
  assert.deepEqual(measure("# Plan\n\n- Launch 2027-01-12 | owner: Olivia\n- |---|\n"), { chars: 52, words: 5, lines: 4 });
  assert.deepEqual(measure(""), { chars: 0, words: 0, lines: 0 });
});

// ── Third test-4 run (2026-11-07, trc_333e…): $1.03, 5 min — but the Finance section went round three
// times because its reviewer could not see the saved file (and judged heading counts), 16 JSON
// replies filled their room and were asked again, and the Board's report pasted every contribution.

test("the reviewer sees the saved files (a report's report's included), lists open points for the Board, and the report stays short", async () => {
  const prompts: string[] = [];
  const verdict = { score: 0.9, truthful: 0.95, good: true, issues: [], openPoints: ["Raise Pro to $20 or cap it at 600 minutes a month"], decision: "accept", summary: "All three sections delivered and consistent." };
  const p = new FakePlatform({ providers: { mock: provider({ "metacognition.solving_evaluation.feedback": (_c, _n, prompt) => (prompts.push(prompt), verdict) }) } });
  const { ceo, cmo, cfo } = company(p);
  const task = p.addTask(makeTask({ id: "tsk_300", number: 300, title: "One-page launch plan", description: "Sections by Marketing and Finance.", assigneeId: ceo.id, traceId: "trc_300", value: 800, estCostUsd: 0.5 }));
  task.state.plan = { problem: "One-page plan", successCriteria: ["sections saved"], chosen: "low_cost", mode: "delegate", subprocesses: [], confidence: 0.7, feedback: [], rejected: [], revision: 0, costSoFarUsd: 0, estimateUsd: 0.5 };
  const mkt = p.addTask(makeTask({ id: "tsk_301", number: 301, parentTaskId: task.id, rootTaskId: task.id, traceId: "trc_300", title: "Marketing section", description: "GTM", assigneeId: cmo.id, status: "done", result: "# Marketing section\nGTM saved at launch-plan/marketing.md (167 words).\n\n## Contributions\n### Lily's draft\nA very long nested report that should not reach the Board." }));
  const fin = p.addTask(makeTask({ id: "tsk_302", number: 302, parentTaskId: task.id, rootTaskId: task.id, traceId: "trc_300", title: "Finance section", description: "Pricing", assigneeId: cfo.id, status: "done", result: "Finance saved at launch-plan/finance.md: Pro loses 50% at full cap." }));
  const draft = p.addTask(makeTask({ id: "tsk_303", number: 303, parentTaskId: mkt.id, rootTaskId: task.id, traceId: "trc_300", title: "Draft marketing", description: "d", assigneeId: cmo.id, status: "done", result: "drafted" }));
  const disk: Record<string, string> = {
    "shared/launch-plan/marketing.md": "## Target segment\nRemote teams of 5–50.\n## Channels\nFounder LinkedIn, SEO.",
    "shared/launch-plan/finance.md": "## Pricing tiers\nPro $12 [modeled]\n## Unit economics\nPro margin -50% [unverified]\n## Open items\n- Reset caps: Elena, 2026-11-23",
    "shared/notes/other-objective.md": "not part of this work",
  };
  (p as unknown as { drive: SavedFiles }).drive = {
    written: () => [
      { agentId: cmo.id, taskId: draft.id, display: "shared/launch-plan/marketing.md", at: "1" },
      { agentId: cfo.id, taskId: fin.id, display: "shared/launch-plan/finance.md", at: "2" },
      { agentId: ceo.id, taskId: "tsk_elsewhere", display: "shared/notes/other-objective.md", at: "3" },
    ],
    read: (_agentId, display) => (disk[display] ? { content: disk[display]!, truncated: false } : null),
    recent: () => [],
  };
  const r = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task, "subtasks_completed", { subtasks: [mkt, fin] })));
  assert.equal(r.outcome, "completed", r.error ?? r.output);
  const review = prompts[0]!;
  assert.match(review, /Files as saved on disk — this IS the read-back: judge these files themselves, and never ask the author to read a file back/);
  assert.match(review, /=== shared\/launch-plan\/finance\.md — saved by Elena Petrova \(\d+ words, 6 lines\) ===\n## Pricing tiers/);
  assert.match(review, /=== shared\/launch-plan\/marketing\.md — saved by Olivia Bennett/, "a report's own report's file is reviewed too");
  assert.doesNotMatch(review, /other-objective/, "only files saved under this work");
  assert.match(review, /Keep the whole reply under about 450 words/, "the reply's size budget is stated up front");
  assert.match(r.output, /## Open points for the Board\n- Raise Pro to \$20 or cap it at 600 minutes a month/);
  assert.match(r.output, /## Files\n- shared\/launch-plan\/finance\.md \(Elena Petrova, \d+ words\)\n- shared\/launch-plan\/marketing\.md \(Olivia Bennett, \d+ words\)/);
  assert.match(r.output, /- \*\*Marketing section\*\* \(Olivia Bennett\): GTM saved at launch-plan\/marketing\.md \(167 words\)\./);
  assert.doesNotMatch(r.output, /Lily's draft|very long nested report/, "nested reports stay out of the Board's reply");
});

test("gist: a contribution's first point, without its heading or nested contributions", () => {
  assert.equal(gist("# Title\nThe point.\n\n## Contributions\n### Inner\nNoise"), "The point.");
  assert.equal(gist("Plain result."), "Plain result.");
  assert.ok(gist("x ".repeat(400)).length <= 320);
});

// ── Fourth test-4 run (2026-11-07, trc_2f7f…: $1.78, 18 min, unfinished). A copy of the plan was already
// on the drive: briefs named no paths, so every section got a second and third copy and a correction
// round; the assembler spent its 4 steps re-reading files and handed in an unsaved page six times.

test("planning sees the drive and names exact paths; the round-2 brief carries the current section files", async () => {
  const prompts: string[] = [];
  const plan = {
    mode: "delegate",
    subprocesses: [
      { title: "CMO: GTM section", description: "Update launch-plan/marketing.md.", assigneeId: "agt_cmo", value: 300, estCostUsd: 0.05, acceptanceCriteria: "Saved." },
      { title: "CFO: pricing section", description: "Update launch-plan/finance.md.", assigneeId: "agt_cfo", value: 300, estCostUsd: 0.05, acceptanceCriteria: "Saved." },
      { title: "Assemble the one-page plan", description: "Merge the sections into launch-plan/one-page-launch-plan.md.", assigneeId: "agt_cos", value: 300, estCostUsd: 0.05, acceptanceCriteria: "Saved." },
    ],
    candidates: CANDIDATES,
    rationale: "update in place",
  };
  const p = new FakePlatform({ providers: { mock: provider({ "metacognition.cognitive_control": (_c, _n, prompt) => (prompts.push(prompt), plan) }) } });
  const { ceo } = company(p);
  const task = p.addTask(makeTask({ id: "tsk_400", number: 400, title: "One-page launch plan", description: "Have the CMO and the CFO write their sections; the Chief of Staff assembles the page.", assigneeId: ceo.id, traceId: "trc_400", value: 800, estCostUsd: 0.5 }));
  const disk: Record<string, string> = {
    "shared/launch-plan/marketing.md": "## Target segment\nRemote teams of 5–50 (updated).",
    "shared/launch-plan/finance.md": "## Pricing tiers\nPro $15 [modeled] (updated)",
    "shared/launch-plan/old-finance-copy.md": "STALE COPY from an earlier objective",
  };
  const writes: { agentId: string; taskId: string | null; display: string; at: string }[] = [{ agentId: "agt_cfo", taskId: "tsk_earlier", display: "shared/launch-plan/old-finance-copy.md", at: "0" }];
  (p as unknown as { drive: SavedFiles }).drive = {
    written: () => writes,
    read: (_a, display) => (disk[display] ? { content: disk[display]!, truncated: false } : null),
    recent: () => [
      { rel: "launch-plan/finance.md", chars: 1028, modified: "2026-11-07T01:10:00.000Z" },
      { rel: "launch-plan/one-page-launch-plan.md", chars: 3869, modified: "2026-11-07T01:11:00.000Z" },
    ],
  };
  const first = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task)));
  assert.equal(first.outcome, "waiting", first.error ?? first.output);
  apply(task, first);
  assert.match(prompts[0]!, /Name the exact file path each part saves to in its description .* reuse its path: saving replaces it and keeps the previous version\. Never ask for a second copy/);
  assert.match(prompts[0]!, /Files on the company drive \(newest first\):\n- launch-plan\/finance\.md \(1028 chars, saved 2026-11-07 01:10 UTC\)\n- launch-plan\/one-page-launch-plan\.md/);
  const round1 = p.tasks.children(task.id);
  assert.equal(round1.length, 2);
  for (const c of round1) {
    c.status = "done";
    c.result = `${c.title}: updated in place.`;
    writes.push({ agentId: c.assigneeId!, taskId: c.id, display: c.assigneeId === "agt_cmo" ? "shared/launch-plan/marketing.md" : "shared/launch-plan/finance.md", at: "1" });
  }
  const second = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task, "subtasks_completed", { subtasks: round1 })));
  assert.equal(second.outcome, "waiting", second.error ?? second.output);
  const r2 = p.tasks.children(task.id).find((c) => c.title === "Assemble the one-page plan")!;
  assert.match(r2.description, /Current versions of their files — work from these \(older files on the drive are superseded; no need to read these again\):/);
  assert.match(r2.description, /=== shared\/launch-plan\/finance\.md — by Elena Petrova \(\d+ words\) ===\n## Pricing tiers\nPro \$15 \[modeled\] \(updated\)/);
  assert.match(r2.description, /=== shared\/launch-plan\/marketing\.md — by Olivia Bennett/);
  assert.doesNotMatch(r2.description, /STALE COPY/, "only the round-1 parts' files, not older copies");
  assert.ok(r2.description.length < 20_000, "fits a task description");
});

test("the tool loop states the step budget up front, and the last step may save and finish in one reply", async () => {
  const systems: string[] = [];
  const lasts: string[] = [];
  const mock = new MockProvider({ latencyMs: 0 });
  const recording: ModelProvider = {
    name: "mock",
    async complete(profile, request, signal) {
      systems.push(request.messages[0]!.content);
      const last = request.messages.at(-1)!;
      if (last.role === "user" && last.content.startsWith("Last step")) lasts.push(last.content);
      // Keep looking things up until the steps run out, so the last-step message is sent.
      if (request.tools?.length) return { content: "", toolCalls: [{ id: `c${systems.length}`, name: "memory_search", arguments: { query: "sections" } }], usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }, finishReason: "tool_calls" as const };
      return mock.complete(profile, request, signal);
    },
  };
  const p = new FakePlatform({ providers: { mock: recording } });
  p.addDepartment("dep_exec", "executive", "Executive");
  const worker = p.addAgent(makeAgent({ id: "agt_w", name: "Noah Patel", title: "Chief of Staff", departmentId: "dep_exec", tools: ["workspace_write_file", "memory_search"] }));
  const task = p.addTask(makeTask({ id: "tsk_w", title: "Assemble the page", description: "Merge.", assigneeId: worker.id }));
  await new ReflexEngine({ maxSteps: 3 }).run(p.context(worker, taskInput(task)));
  assert.match(systems[0]!, /You have 3 tool steps; each reply is one step and may call several tools at once\. Read everything you need in one reply, save your deliverable well before the last step/);
  assert.match(lasts[0]!, /If your deliverable is not saved yet, call workspace_write_file AND complete_task together in this one reply/);
});

test("step budgets: room to read, save and finish", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(Q6_EXECUTION).map(([k, v]) => [k, v.directSteps])), { high_cost: 8, low_cost: 6, low_effort: 4 });
});

// ── Test 5 (2026-11-07): "Jasmine should hire an SEO specialist into Marketing" went to the CMO with
// "have Jasmine hire" (Jasmine is a recruiter two levels down, with no hiring tools), and a brain
// could not hire at all (hire_agent was never offered in Solving). Founder: "managers hire, recruiter sources".

function hiringCompany(p: FakePlatform) {
  const base = company(p);
  p.addDepartment("dep_ppl", "people", "People");
  const cpo = p.addAgent(makeAgent({ id: "agt_cpo", name: "Natalie Brooks", title: "Chief People Officer", departmentId: "dep_ppl", managerId: base.ceo.id, tier: "executive", cognition: "brain", modelTier: "frontier", tools: [...BRAIN_TOOLS, "hire_agent", "catalog_search"], identity: { mission: "Own the agent lifecycle." } as never }));
  const jasmine = p.addAgent(makeAgent({ id: "agt_jas", name: "Jasmine Lee", title: "Recruiter Agent", departmentId: "dep_ppl", managerId: cpo.id, tools: ["catalog_search", "workspace_write_file"], identity: { mission: "Draft role specs and onboard new agents." } as never }));
  return { ...base, cpo, jasmine };
}

test("a person named outside the leader's reports routes to the report whose team they are in; hiring requests get the hiring flow", async () => {
  const prompts: string[] = [];
  const ctxs: Record<string, unknown>[] = [];
  const p = new FakePlatform({ providers: { mock: provider({ "metacognition.cognitive_control": (c, _n, prompt) => (ctxs.push(c), prompts.push(prompt), undefined) }) } });
  const { ceo, cmo, cpo } = hiringCompany(p);
  const task = p.addTask(makeTask({ id: "tsk_217", number: 217, title: "Hire an SEO specialist", description: "We need an SEO specialist in Marketing for the meeting-notes launch. Jasmine should hire one from the specialist catalog with a $10 monthly budget, and give them a first task.", assigneeId: ceo.id, value: 600, estCostUsd: 0.3 }));
  await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task)));
  assert.deepEqual([...(ctxs[0]!.namedOwners as string[])].sort(), [cmo.id, cpo.id].sort());
  assert.match(prompts[0]!, /agt_cpo \(Chief People Officer — Jasmine Lee is in their team; the part is for them\)/);
  assert.match(prompts[0]!, /Hiring: the head of the team the new hire joins makes the hire — hire_agent places people only in the hirer's own team .* Plan the recommendation as round 1 \(to the head of People, for their recruiter\) and the hire — with budget and first task — as round 2 \(to the receiving department's head\)\./);
  assert.equal(ctxs[0]!.hiring, true);
});

// Live (2026-11-07, trc_617b…): the CEO planned the recruiter step for Natalie (Jasmine's head of People),
// but role arrangement handed it to the CMO — the request named "Marketing", and Jasmine didn't count.
test("a part naming someone on the leader's chosen team stays with that leader, even when the request names another department", async () => {
  const plan = {
    mode: "delegate",
    subprocesses: [
      { title: "Recruiter recommends SEO specialist from catalog", description: "Have Jasmine Lee (People recruiter) use catalog_search to find one SEO specialist for Marketing and save her pick.", assigneeId: "agt_cpo", round: 1, value: 350, estCostUsd: 0.02, acceptanceCriteria: "A real catalog id with reasons." },
      { title: "CMO hires SEO specialist and assigns keyword brief", description: "Using Jasmine's recommendation, hire into Marketing with a $10 budget and the first task.", assigneeId: "agt_cmo", round: 2, value: 550, estCostUsd: 0.03, acceptanceCriteria: "Hired with the brief assigned." },
    ],
    candidates: CANDIDATES,
    rationale: "Recruiter sources, the CMO hires.",
  };
  const p = new FakePlatform({ providers: { mock: provider({ "metacognition.cognitive_control": () => plan }) } });
  const { ceo, cpo } = hiringCompany(p);
  const task = p.addTask(makeTask({ id: "tsk_228", number: 228, title: "Hire SEO specialist and produce launch keyword brief", description: "We need an SEO specialist in Marketing for the meeting-notes launch. Jasmine should hire one from the specialist catalog with a $10 monthly budget, and give them a first task.", assigneeId: ceo.id, value: 600, estCostUsd: 0.3 }));
  const first = await new BrainEngine({ maxRevisions: 2 }).run(p.context(ceo, taskInput(task)));
  assert.equal(first.outcome, "waiting", first.error ?? first.output);
  const round1 = p.tasks.children(task.id);
  assert.deepEqual(round1.map((c) => [c.title, c.assigneeId]), [["Recruiter recommends SEO specialist from catalog", cpo.id]]);
  const arranged = p.tracer.spans.find((s) => s.attributes["agentco.role_arrangement"])!;
  assert.equal(arranged.attributes["agentco.role_arrangement.overrode_llm"], 0);
  assert.match(String(arranged.attributes["agentco.role_arrangement.named"]), /agt_cpo/, "Jasmine's head of People counts as named");
});

test("mentionedPeople: full names, or a capitalised first name only one person has", () => {
  const ag = (id: string, name: string) => makeAgent({ id, name });
  const people = [ag("a", "Jasmine Lee"), ag("b", "Will Turner"), ag("c", "Ava Chen"), ag("d", "Ava Stone")];
  assert.deepEqual(mentionedPeople("Jasmine should hire one", people).map((a) => a.id), ["a"]);
  assert.deepEqual(mentionedPeople("we will hire", people).map((a) => a.id), [], "a lowercase word is not a name");
  assert.deepEqual(mentionedPeople("Ava should decide", people).map((a) => a.id), [], "two Avas: the first name alone is ambiguous");
  assert.deepEqual(mentionedPeople("ask ava chen", people).map((a) => a.id), ["c"]);
});

test("Solving offers hire_agent on a hiring task only, and waits for a new hire's open first task", async () => {
  const toolSets: string[][] = [];
  const mock = new MockProvider({ latencyMs: 0 });
  const recording: ModelProvider = {
    name: "mock",
    async complete(profile, request, signal) {
      if (readStage(request.messages) === SOLVING && request.tools?.length) toolSets.push(request.tools.map((t) => t.name));
      const r = await mock.complete(profile, request, signal);
      if (request.responseFormat === "json" && readStage(request.messages) === "metacognition.cognitive_control") return { ...r, content: JSON.stringify({ mode: "direct", subprocesses: [], candidates: CANDIDATES, rationale: "myself" }) };
      return r;
    },
  };
  const p = new FakePlatform({ providers: { mock: recording } });
  const { cpo } = hiringCompany(p);
  const hireTask = p.addTask(makeTask({ id: "tsk_h", number: 501, title: "Hire an SEO specialist into Marketing", description: "Hire one from the catalog with a $10 budget.", assigneeId: cpo.id }));
  await new BrainEngine({ maxRevisions: 0 }).run(p.context(cpo, taskInput(hireTask)));
  const otherTask = p.addTask(makeTask({ id: "tsk_o", number: 502, title: "Write the onboarding checklist", description: "One page.", assigneeId: cpo.id }));
  await new BrainEngine({ maxRevisions: 0 }).run(p.context(cpo, taskInput(otherTask)));
  assert.ok(toolSets[0]!.includes("hire_agent"), "offered on the hiring task");
  assert.ok(!toolSets.at(-1)!.includes("hire_agent"), "not on other work");

  // After the Board approves a hire, its first task already exists: the manager waits, no Solving call.
  const waiting = p.addTask(makeTask({ id: "tsk_w2", number: 503, title: "Hire an SEO specialist", description: "Hire one.", assigneeId: cpo.id }));
  p.addTask(makeTask({ id: "tsk_first", number: 504, parentTaskId: waiting.id, rootTaskId: waiting.id, title: "SEO keyword brief", description: "Save launch-plan/seo-keywords.md.", assigneeId: "agt_jas", status: "todo", state: { firstTask: true } }));
  const before = toolSets.length;
  const llmBefore = p.tracer.byKind("llm").length;
  const r = await new BrainEngine({ maxRevisions: 0 }).run(p.context(cpo, taskInput(waiting)));
  assert.equal(r.outcome, "waiting", r.error ?? r.output);
  assert.match(r.output, /^Waiting for the new hire's first task: T-504 "SEO keyword brief"\.$/);
  assert.equal(toolSets.length, before, "no Solving call while the first task is open");
  assert.equal(p.tracer.byKind("llm").length, llmBefore, "no planning either: nothing new is handed out");

  // Once the hire is made, the task never offers hire_agent again and says who joined.
  const hired = p.addTask(makeTask({ id: "tsk_h2", number: 505, title: "Hire an SEO specialist into Marketing", description: "Hire one and review their brief.", assigneeId: cpo.id, state: { hires: [{ role: "marketing/marketing-seo-specialist", status: "hired", agentId: "agt_riley", name: "Riley Chen" }] } }));
  await new BrainEngine({ maxRevisions: 0 }).run(p.context(cpo, taskInput(hired)));
  assert.ok(!toolSets.at(-1)!.includes("hire_agent"), "already hired: no hire_agent");
});

test("the Board's decision on a hire reaches the hiring manager in plain words", () => {
  const run = (boardAnswer: unknown) => ({ wm: { boardAnswer } }) as never;
  assert.deepEqual(guidanceLines(run({ kind: "hire_agent", status: "approved", hired: "Sam Reyes, SEO Specialist (agt_x)", note: null })), ["The Board approved the hire: Sam Reyes, SEO Specialist (agt_x) has joined. Do not hire again."]);
  assert.match(guidanceLines(run({ kind: "hire_agent", status: "rejected", note: "Not this month." }))[0]!, /^The Board declined the hire\. Do not hire; say so in your result\. Note: Not this month\.$/);
});
