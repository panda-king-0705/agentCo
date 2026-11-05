import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrate, constraintPressure, insightContent, parseInsight, profileCall, updateCalibration } from "../../src/cognition/brain/metacognition/monitoring.ts";
import { chooseCandidate, costRatios, inspectSubtasks, newestInsights } from "../../src/cognition/brain/metacognition/project-management.ts";
import { coerceCandidates, coerceSubprocesses, controlLevel, maxSubprocessesFor } from "../../src/cognition/brain/metacognition/cognitive-control.ts";
import { coerceConfidence, fallbackTarget } from "../../src/cognition/brain/metacognition/confidence.ts";
import { decide, acceptThreshold } from "../../src/cognition/brain/metacognition/solving-evaluation.ts";
import { planRemedies } from "../../src/cognition/brain/metacognition/self-ability.ts";
import { computeDrives, lowestUnmetNeed } from "../../src/cognition/brain/self-management/identity.ts";
import { eventsFromSubtasks, updateAffect } from "../../src/cognition/brain/self-management/human-nature.ts";
import { scoreCandidates, candidatePool } from "../../src/cognition/brain/self-management/role-arrangement.ts";
import { mbtiFit, suggestPersonalityType } from "../../src/cognition/brain/self-management/personality.ts";
import { advanceOkrs, largestGap } from "../../src/cognition/brain/self-management/okr.ts";
import { computeBaZi } from "../../src/cognition/brain/self-management/bazi.ts";
import { num, oneOf, str, strArr, unit } from "../../src/cognition/coerce.ts";
import { makeAgent, makeTask } from "./fakes.ts";

const needsOk = { physiological: "ok", safety: "ok", belonging: "ok", esteem: "ok", selfActualization: 0.5 } as const;

test("coerce: every field has a default", () => {
  assert.equal(num("3", 0), 3);
  assert.equal(num("x", 7), 7);
  assert.equal(num(50, 0, 0, 10), 10);
  assert.equal(unit(75, 0.1), 0.75);
  assert.equal(unit("nope", 0.4), 0.4);
  assert.equal(unit(-2, 0.4), 0);
  assert.equal(str(null, "d"), "d");
  assert.deepEqual(strArr(["a", 3, { title: "t" }, ""]), ["a", "t"]);
  assert.equal(oneOf("Low-Cost", ["low_cost", "high_cost"] as const, "high_cost"), "low_cost");
});

test("calibration: bias correction weighted by samples; running Brier", () => {
  assert.equal(calibrate(0.8, { samples: 0, meanConfidence: 0.9, successRate: 0.2, brier: 0 }), 0.8);
  // Over-confident agent with 20+ samples: 0.8 − (0.9 − 0.5) = 0.4
  assert.equal(calibrate(0.8, { samples: 40, meanConfidence: 0.9, successRate: 0.5, brier: 0 }), 0.4);
  // 10 samples → half weight
  assert.equal(calibrate(0.8, { samples: 10, meanConfidence: 0.9, successRate: 0.5, brier: 0 }), 0.6);
  const c = updateCalibration({ samples: 1, meanConfidence: 0.6, successRate: 1, brier: 0.16 }, 0.8, false);
  assert.deepEqual(c, { samples: 2, meanConfidence: 0.7, successRate: 0.5, brier: 0.4 });
});

test("drives: desire → motivation ← emotion, needs (identity → behaviour)", () => {
  const agent = makeAgent({ id: "a" });
  const base = computeDrives(agent.identity, agent.affect, needsOk);
  assert.equal(base.recallK, Math.round(4 + 4 * base.curiosity));
  assert.equal(base.truthfulGate, 0.6 + 0.3 * 0.5);
  assert.equal(base.earlyStopThreshold, 0.25);
  assert.equal(base.conservation, false);
  const happy = computeDrives(agent.identity, { valence: 0.5, arousal: 0.3, frustration: 0 }, needsOk);
  assert.ok(happy.curiosity > base.curiosity, "positive valence raises curiosity");
  const sad = computeDrives({ ...agent.identity, motivation: { autonomy: 0.45, competence: 0.5, purpose: 0.5 } }, { valence: -0.5, arousal: 0.3, frustration: 0.8 }, needsOk);
  assert.equal(sad.earlyStopThreshold, 0.35, "negative valence lowers autonomy below 0.4 → +0.1");
  assert.equal(sad.frustrationGate, true);
  const poor = computeDrives(agent.identity, agent.affect, { ...needsOk, safety: "low" });
  assert.equal(poor.conservation, true);
  assert.equal(lowestUnmetNeed({ ...needsOk, belonging: "low", esteem: "low" }), "belonging");
  const broke = computeDrives(agent.identity, agent.affect, { ...needsOk, physiological: "low" });
  assert.equal(broke.essentialOnly, true);
  assert.equal(broke.perspectives, 1);
});

test("human nature (Q8): fed by finished processes; negativity bias, recognition, habituation", () => {
  const neutral = { valence: 0, arousal: 0.3, frustration: 0 };
  const ok = updateAffect(neutral, [{ outcome: "done", source: "own", recognizedBy: "self" }], { openItems: 0, consecutiveRuns: 1 });
  const bad = updateAffect(neutral, [{ outcome: "failed", source: "own", recognizedBy: "self" }], { openItems: 0, consecutiveRuns: 1 });
  assert.ok(Math.abs(bad.valence) > Math.abs(ok.valence) * 1.4, "failure moves valence 1.5× a success");
  assert.equal(bad.frustration, 0.25);
  const praised = updateAffect(neutral, [{ outcome: "done", source: "own", recognizedBy: "board" }], { openItems: 0, consecutiveRuns: 1 });
  assert.ok(praised.valence > ok.valence * 1.9, "recognition 2×");
  const again = updateAffect({ ...ok }, [{ outcome: "done", source: "own", recognizedBy: "self" }], { openItems: 0, consecutiveRuns: 1 });
  assert.ok(again.valence - ok.valence < ok.valence, "habituation: repeat counts less");
  const subtasks = [
    makeTask({ id: "1", status: "done" }),
    makeTask({ id: "2", status: "failed" }),
    makeTask({ id: "3", status: "cancelled" }),
    makeTask({ id: "4", status: "blocked" }),
    makeTask({ id: "5", status: "in_progress" }),
  ];
  assert.deepEqual(eventsFromSubtasks(subtasks).map((e) => e.outcome), ["done", "failed", "cancelled", "escalated"]);
  const busy = updateAffect(neutral, [], { openItems: 5, consecutiveRuns: 3 });
  assert.ok(busy.arousal > neutral.arousal, "fatigue raises arousal");
});

test("role arrangement (Q9): 0.75 mandate + 0.25 MBTI; BaZi only breaks ties within 0.05", () => {
  const fire = computeBaZi("2026-05-28T12:00:00Z"); // any chart; we override the element counts
  const mk = (id: string, title: string, mission: string, mbti: string | null, elements: Record<string, number>) =>
    makeAgent({ id, title, identity: { mission } as never, persona: { style: "", traits: [], personalityType: mbti, baZi: { ...fire, elements: elements as never } } });
  const a = mk("a", "Growth Marketer", "Run launch campaigns", "ENFP", { wood: 0, fire: 1, earth: 2, metal: 1, water: 4 });
  const b = mk("b", "Growth Marketer", "Run launch campaigns", "ENFP", { wood: 0, fire: 4, earth: 1, metal: 1, water: 2 });
  const c = mk("c", "Backend Engineer", "Build APIs", "ISTJ", { wood: 0, fire: 4, earth: 0, metal: 0, water: 0 });
  const cands = [a, b, c].map((agent) => ({ agent, departmentName: agent.id === "c" ? "Engineering" : "Marketing" }));
  const ranked = scoreCandidates("Launch campaign for marketing", cands, { fallbackDepartment: "Marketing" });
  // a and b tie on fit; marketing is a fire department → b (fire-heavy) wins the tie.
  assert.equal(ranked[0]!.agentId, "b");
  assert.equal(ranked[0]!.tieBroken, true);
  // c has the best element but a much worse fit → never chosen by BaZi alone.
  assert.notEqual(ranked[0]!.agentId, "c");
  assert.ok(ranked.find((r) => r.agentId === "c")!.fit < ranked[0]!.fit - 0.05);
  // Without a tie, BaZi does nothing: give a a clearly better mandate.
  const a2 = mk("a", "Launch Campaign Marketer", "Launch campaigns and marketing launches", "ENFP", { wood: 0, fire: 0, earth: 4, metal: 0, water: 4 });
  const b2 = mk("b", "Growth Marketer", "Run social posts", "ENFP", { wood: 0, fire: 4, earth: 1, metal: 1, water: 2 });
  const ranked2 = scoreCandidates("Launch campaign for marketing", [a2, b2].map((agent) => ({ agent, departmentName: "Marketing" })), { fallbackDepartment: "Marketing" });
  assert.equal(ranked2[0]!.agentId, "a");
  assert.equal(ranked2[0]!.tieBroken, false);
  // Pool: only active reports; the CEO may use a suggested agent outside its reports.
  const ceo = makeAgent({ id: "ceo", managerId: null });
  const mgr = makeAgent({ id: "m", managerId: "ceo" });
  const paused = makeAgent({ id: "p", managerId: "m", status: "paused" });
  assert.deepEqual(candidatePool(mgr, [paused, a], [a, b], ["b"]).map((x) => x.id), ["a"]);
  assert.deepEqual(candidatePool(ceo, [a], [a, b], ["b"]).map((x) => x.id), ["a", "b"]);
});

test("personality: MBTI fit and hire suggestion", () => {
  assert.equal(mbtiFit("INTJ", "financial analysis and forecast"), 1);
  assert.equal(mbtiFit(null, "anything"), 0.5);
  assert.equal(suggestPersonalityType("Run social campaigns and partner outreach"), "ENFJ");
});

test("confidence (Q3): evaluations default to block scores; < 0.5 sends that block back once", () => {
  const defaults = { understanding: { score: 0.8, gaps: [] }, competence: { score: 0.7, gaps: ["budget"] } };
  const c = coerceConfidence({ confidence: 0.9, understandingEval: { score: 0.3, gaps: ["who is the customer?"] } }, defaults, { taskOod: true, pressureSignals: 0 });
  assert.equal(c.raw, 0.6, "task OOD caps confidence at 0.6");
  assert.deepEqual(c.understandingEval, { score: 0.3, gaps: ["who is the customer?"] });
  assert.deepEqual(c.competenceEval, { score: 0.7, gaps: ["budget"] });
  const used = new Set<"target_understanding" | "self_ability">();
  assert.equal(fallbackTarget(c, used), "target_understanding");
  used.add("target_understanding");
  assert.equal(fallbackTarget(c, used), null, "at most one pass each");
  const pressured = coerceConfidence({ confidence: 0.9 }, defaults, { taskOod: false, pressureSignals: 2 });
  assert.equal(pressured.raw, 0.74, "constraint pressure lowers confidence");
  const garbage = coerceConfidence({ confidence: "very", risks: "many" }, defaults, { taskOod: false, pressureSignals: 0 });
  assert.equal(garbage.raw, 0.5);
  assert.deepEqual(garbage.risks, []);
});

test("self-ability remedies target the evaluation's gaps", () => {
  const r = planRemedies(["missing domain skill", "budget is tight", "model capability"], { tier: "standard", budgetRemainingUsd: 10, estCostUsd: 0.1, hasReports: true, hasManager: true });
  assert.equal(r.upgrade, "frontier");
  assert.equal(r.preferDelegation, true);
  assert.equal(r.budgetRequest, true);
  const poor = planRemedies(["model capability"], { tier: "economy", budgetRemainingUsd: 0.01, estCostUsd: 0.1, hasReports: false, hasManager: false });
  assert.equal(poor.upgrade, null, "no upgrade without budget");
});

test("OOD (Q2): performance OOD against the block profile, constraint pressure, insight round-trip", () => {
  const profile = { block: "s", calls: 10, p50Ms: 100, p95Ms: 200, p95InputTokens: 1000, p95OutputTokens: 300, meanCostUsd: 0.001, errorRate: 0 };
  const call = { stage: "metacognition.confidence", tier: "economy" as const, latencyMs: 500, inputTokens: 5000, outputTokens: 100, costUsd: 0.01, jsonOk: false };
  const events = profileCall(call, profile);
  assert.deepEqual(events.map((e) => e.symptom.split(" ")[0]), ["invalid", "latency", "input", "cost"]);
  assert.equal(profileCall(call, { ...profile, calls: 2 }).length, 1, "too little history: only the JSON check");
  const pressure = constraintPressure({ maxContextShare: 0.8, budgetRemainingUsd: 1, monthlyBudgetUsd: 10, elapsedMs: 250_000, runTimeoutMs: 300_000 });
  assert.deepEqual(pressure.map((p) => p.kind), ["context", "budget", "time"]);
  assert.equal(constraintPressure({ maxContextShare: 0.1, budgetRemainingUsd: 9, monthlyBudgetUsd: 10, elapsedMs: 0, runTimeoutMs: 300_000 }).length, 0);
  const insight = { block: "metacognition.cognitive_control", tier: "frontier", symptom: "latency 900ms > p95 300ms", remedy: "use a cheaper tier" };
  assert.deepEqual(parseInsight(insightContent(insight)), insight);
});

test("cognitive control (Q4): c = clamp(α·uncertainty) + pressure; granularity; candidates always the three", () => {
  assert.equal(controlLevel(0.3), 0.3);
  assert.equal(controlLevel(0.3, 2), 0.6);
  assert.equal(controlLevel(2), 1);
  assert.equal(maxSubprocessesFor(0, false), 1);
  assert.equal(maxSubprocessesFor(1, false), 4);
  assert.equal(maxSubprocessesFor(1, true), 1);
  const cands = coerceCandidates({ candidates: "garbage" }, 400, 0.1);
  assert.deepEqual(cands.map((c) => c.name), ["high_cost", "low_cost", "low_effort"]);
  assert.ok(cands[0]!.estCostUsd > cands[1]!.estCostUsd && cands[1]!.estCostUsd > cands[2]!.estCostUsd);
  assert.deepEqual(coerceSubprocesses({ subprocesses: [{ title: "" }, { title: "A", value: "9000" }, 5] }, 3, 100).map((s) => [s.title, s.value]), [["A", 1000]]);
});

test("economic concepts: margin choice; conservation → cheapest; pressure excludes High Cost; rollback skips rejected", () => {
  const candidates = [
    { name: "high_cost" as const, label: "", approach: "", estCostUsd: 0.2, expectedValue: 900, meetsCriteria: true },
    { name: "low_cost" as const, label: "", approach: "", estCostUsd: 0.05, expectedValue: 500, meetsCriteria: true },
    { name: "low_effort" as const, label: "", approach: "", estCostUsd: 0.01, expectedValue: 100, meetsCriteria: true },
  ];
  const base = { candidates, costFactor: 1, visionMultiplier: 1.25, aligned: false, confidence: 1, conservation: false, pressure: false, rejected: [] };
  assert.equal(chooseCandidate(base).chosen, "high_cost"); // 0.9−0.2=0.7 > 0.5−0.05
  assert.equal(chooseCandidate({ ...base, conservation: true }).chosen, "low_effort");
  assert.equal(chooseCandidate({ ...base, pressure: true }).chosen, "low_cost");
  assert.equal(chooseCandidate({ ...base, rejected: ["high_cost"] }).chosen, "low_cost");
  assert.equal(chooseCandidate({ ...base, costFactor: 3, confidence: 0.5 }).chosen, "low_cost"); // corrected costs + risk
  assert.deepEqual(costRatios([{ content: "T-1: completed cost $0.0200 (est $0.0100)" }, { content: "x" }]), [2]);
});

test("feedback decision rules", () => {
  const teg = (truthful: boolean, good: boolean) => ({ truthful, efficient: true, good });
  const base = { modelDecision: "accept" as const, score: 0.8, revisionsLeft: 1, rollbackAvailable: true, canEscalate: true };
  assert.equal(decide({ ...base, teg: teg(true, true) }), "accept");
  assert.equal(decide({ ...base, teg: teg(false, true) }), "revise", "untruthful result is revised");
  assert.equal(decide({ ...base, modelDecision: "rollback", teg: teg(true, false) }), "rollback");
  assert.equal(decide({ ...base, revisionsLeft: 0, score: 0.5, teg: teg(true, false) }), "accept", "partial accept once revisions are exhausted");
  assert.equal(decide({ ...base, revisionsLeft: 0, rollbackAvailable: false, score: 0.1, teg: teg(false, false) }), "escalate");
  assert.equal(acceptThreshold(0, false), 0.55);
  assert.equal(acceptThreshold(1, true), 0.75);
});

test("OKRs, insights recall and recovery inspection", () => {
  const okrs = [{ objective: "Launch the product", keyResults: [{ description: "Sign 20 design partners", target: 20, current: 2, unit: "" }, { description: "Ship v1", target: 1, current: 1, unit: "" }] }];
  assert.equal(largestGap(okrs)!.kr.description, "Sign 20 design partners");
  const advanced = advanceOkrs(okrs, "We signed design partners for the launch", 0.9);
  assert.equal(advanced.advanced, "Sign 20 design partners");
  assert.ok(advanced.okrs[0]!.keyResults[0]!.current > 2);
  assert.equal(okrs[0]!.keyResults[0]!.current, 2, "pure");
  const mem = (content: string, createdAt: string) => ({ id: createdAt, scope: "agent" as const, agentId: "a", kind: "procedural" as const, content, tags: ["optimization"], importance: 0.5, sourceRunId: null, sourceTaskId: null, accessCount: 0, createdAt, lastAccessedAt: null });
  const insights = newestInsights([mem("optimization insight [b1] tier=economy: s1 → r1", "2026-01-01"), mem("optimization insight [b2] tier=economy: s2 → r2", "2026-02-01"), mem("lesson", "2026-03-01")], 1);
  assert.deepEqual(insights.map((i) => i.block), ["b2"]);
  const r = inspectSubtasks([makeTask({ id: "1", status: "todo", title: "A" }), makeTask({ id: "2", status: "done", title: "B" })]);
  assert.equal(r.open.length, 1);
  assert.deepEqual(r.existingTitles, ["a", "b"]);
});
