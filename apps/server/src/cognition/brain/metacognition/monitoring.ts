/**
 * Metacognition › Monitoring: OOD Monitoring (NCU/NKX) · Calibration ·
 * Reverse Thinking · Truthful / Efficient / Good.
 *
 * OOD Monitoring is profile-guided (founder, Q2): the agent profiles its own
 * deployment like a kernel — every model call's latency (timed by the
 * engine), tokens, context-window use, cost and JSON validity — against the
 * block's history (platform.metrics.blockProfile) and hard constraints.
 * Signals: task OOD, performance OOD, constraint pressure. Each event becomes
 * an optimization insight {block, tier, symptom, remedy} for Online Learning.
 */
import type { BlockProfile } from "../../../contracts.ts";
import type { CalibrationStats } from "../../../../../../packages/shared/src/index.ts";
import { bool, clamp, round, str, strArr } from "../../coerce.ts";
import { truncate } from "../../text.ts";
import { Q2_OOD } from "../interpretation.ts";
import { block, llmJson, type BrainRun, type CallRecord, type OptimizationInsight } from "../runtime.ts";

// ── Calibration (pure)

/** calibrated = raw − (meanConfidence − successRate)·min(1, samples/20) */
export function calibrate(raw: number, cal: CalibrationStats): number {
  const bias = cal.meanConfidence - cal.successRate;
  const weight = Math.min(1, Math.max(0, cal.samples) / 20);
  return round(clamp(raw - bias * weight, 0, 1), 4);
}

/** One more sample: predicted confidence vs observed outcome. Running means + Brier score. */
export function updateCalibration(cal: CalibrationStats, predicted: number, success: boolean): CalibrationStats {
  const n = Math.max(0, cal.samples);
  const o = success ? 1 : 0;
  const p = clamp(predicted, 0, 1);
  const next = n + 1;
  return {
    samples: next,
    meanConfidence: round((cal.meanConfidence * n + p) / next, 4),
    successRate: round((cal.successRate * n + o) / next, 4),
    brier: round((cal.brier * n + (p - o) ** 2) / next, 4),
  };
}

export async function calibration(run: BrainRun, raw: number): Promise<number> {
  return block(run, "metacognition.monitoring.calibration", "Calibrating confidence against my track record", (span) => {
    const c = calibrate(raw, run.agent.calibration);
    span.setAttributes({ "agentco.confidence.raw": raw, "agentco.confidence": c, "agentco.calibration.samples": run.agent.calibration.samples });
    return c;
  });
}

// ── OOD Monitoring (pure parts)

export interface PerformanceEvent {
  stage: string;
  tier: string;
  symptom: string;
  remedy: string;
}

/** Performance OOD for one call against its block's history. */
export function profileCall(call: Pick<CallRecord, "stage" | "tier" | "latencyMs" | "inputTokens" | "outputTokens" | "costUsd" | "jsonOk">, profile: BlockProfile): PerformanceEvent[] {
  const out: PerformanceEvent[] = [];
  const ev = (symptom: string, remedy: string) => out.push({ stage: call.stage, tier: call.tier, symptom, remedy });
  if (call.jsonOk === false) ev("invalid JSON output", "simplify the JSON shape for this block or route it one tier up");
  if (profile.calls < Q2_OOD.minHistoryCalls) return out;
  const f = Q2_OOD.p95Factor;
  if (profile.p95Ms !== null && call.latencyMs > profile.p95Ms * f) ev(`latency ${call.latencyMs}ms > p95 ${profile.p95Ms}ms`, "shorter prompt or a faster, cheaper tier for this block");
  if (profile.p95InputTokens !== null && call.inputTokens > profile.p95InputTokens * f)
    ev(`input ${call.inputTokens} tok > p95 ${profile.p95InputTokens}`, "trim recalled context and perspectives for this block");
  if (profile.p95OutputTokens !== null && call.outputTokens > profile.p95OutputTokens * f)
    ev(`output ${call.outputTokens} tok > p95 ${profile.p95OutputTokens}`, "lower max output tokens; ask for terser output");
  if (profile.meanCostUsd !== null && profile.meanCostUsd > 0 && call.costUsd > profile.meanCostUsd * 2)
    ev(`cost $${call.costUsd.toFixed(5)} > 2× mean $${profile.meanCostUsd.toFixed(5)}`, "route this block to a cheaper tier or prefer Low Cost / Low Effort");
  return out;
}

export interface PressureInputs {
  maxContextShare: number; // max over calls of inputTokens / contextWindow (0 when unknown)
  budgetRemainingUsd: number;
  monthlyBudgetUsd: number;
  elapsedMs: number;
  runTimeoutMs: number;
}

export interface PressureSignal {
  kind: "context" | "budget" | "time";
  symptom: string;
  remedy: string;
}

export function constraintPressure(i: PressureInputs): PressureSignal[] {
  const out: PressureSignal[] = [];
  if (i.maxContextShare > Q2_OOD.contextShare)
    out.push({ kind: "context", symptom: `prompt uses ${Math.round(i.maxContextShare * 100)}% of the context window`, remedy: "decompose finer and compact the context" });
  if (i.monthlyBudgetUsd > 0 && i.budgetRemainingUsd / i.monthlyBudgetUsd < Q2_OOD.budgetShare)
    out.push({ kind: "budget", symptom: `budget left ${Math.round((i.budgetRemainingUsd / i.monthlyBudgetUsd) * 100)}%`, remedy: "conservation: prefer Low Cost / Low Effort candidates" });
  if (i.runTimeoutMs > 0 && (i.runTimeoutMs - i.elapsedMs) / i.runTimeoutMs < Q2_OOD.timeShare)
    out.push({ kind: "time", symptom: `${Math.max(0, Math.round((i.runTimeoutMs - i.elapsedMs) / 1000))}s of run time left`, remedy: "fewer solving steps; delegate or checkpoint" });
  return out;
}

export function pressureConfidencePenalty(signals: number): number {
  return Math.min(Q2_OOD.confidencePenaltyMax, Q2_OOD.confidencePenaltyPerSignal * signals);
}

export function insightContent(i: OptimizationInsight): string {
  return `optimization insight [${i.block}] tier=${i.tier}: ${i.symptom} → ${i.remedy}`;
}

/** Parses insight memories back ("optimization insight [block] tier=x: symptom → remedy"). */
export function parseInsight(content: string): OptimizationInsight | null {
  const m = /^optimization insight \[([^\]]+)\] tier=([a-z]+): (.+?) → (.+)$/.exec(content.trim());
  return m ? { block: m[1]!, tier: m[2]!, symptom: m[3]!, remedy: m[4]! } : null;
}

// ── OOD Monitoring (block)

export interface OodReport {
  taskOod: boolean;
  similarEpisodes: number;
  performance: PerformanceEvent[];
  pressure: PressureSignal[];
}

function addInsight(run: BrainRun, i: OptimizationInsight): void {
  if (!run.insights.some((x) => x.block === i.block && x.symptom.split(" ")[0] === i.symptom.split(" ")[0])) run.insights.push(i);
}

/**
 * Block: profiles the run's unchecked model calls against history and
 * constraints. `problem` (when given) also runs the task-OOD check.
 */
export async function oodMonitoring(run: BrainRun, problem: string | null): Promise<OodReport> {
  return block(run, "metacognition.monitoring.ood", "Profiling my calls against history and constraints", (span) => {
    let taskOod = false;
    let similar = -1;
    if (problem !== null) {
      similar = run.platform.memory.search({ query: problem, agentId: run.agent.id, scopes: ["agent"], kinds: ["episodic"], limit: 3 }).length;
      taskOod = similar < Q2_OOD.minSimilarEpisodes;
      if (taskOod) addInsight(run, { block: "metacognition.target_understanding", tier: run.routingAgent.modelTier, symptom: "task OOD: no similar past episode", remedy: "wider literature review; delegate to a report with matching skills" });
    }
    const performance: PerformanceEvent[] = [];
    const profiles = new Map<string, BlockProfile>();
    for (const call of run.calls) {
      if (call.checked) continue;
      call.checked = true;
      let profile = profiles.get(call.stage);
      if (!profile) {
        profile = run.platform.metrics.blockProfile(run.agent.id, call.stage);
        profiles.set(call.stage, profile);
      }
      for (const e of profileCall(call, profile)) {
        performance.push(e);
        addInsight(run, { block: e.stage, tier: e.tier, symptom: e.symptom, remedy: e.remedy });
      }
    }
    const started = Date.parse(run.ctx.run.startedAt ?? run.ctx.run.createdAt);
    const maxContextShare = Math.max(0, ...run.calls.map((c) => (c.contextWindow ? c.inputTokens / c.contextWindow : 0)));
    const pressure = constraintPressure({
      maxContextShare,
      budgetRemainingUsd: run.platform.org.budgetRemainingUsd(run.agent.id),
      monthlyBudgetUsd: run.agent.monthlyBudgetUsd,
      elapsedMs: Number.isNaN(started) ? 0 : Math.max(0, run.platform.now().getTime() - started),
      runTimeoutMs: run.runTimeoutMs,
    });
    for (const p of pressure) addInsight(run, { block: run.currentBlock ?? "metacognition", tier: run.routingAgent.modelTier, symptom: `${p.kind} pressure: ${p.symptom}`, remedy: p.remedy });
    span.setAttributes({
      "agentco.ood": taskOod,
      "agentco.ood.similar": similar,
      "agentco.ood.performance": performance.length,
      "agentco.ood.pressure": pressure.map((p) => p.kind).join(",") || "none",
    });
    return { taskOod, similarEpisodes: similar, performance, pressure };
  });
}

// ── Reverse thinking (economy)

export interface ReverseThinking {
  failureModes: string[];
  fatal: boolean;
  mitigation: string;
}

export async function reverseThinking(run: BrainRun, planSummary: string): Promise<ReverseThinking> {
  return block(run, "metacognition.monitoring.reverse_thinking", "Premortem: assuming the plan failed", async (span) => {
    const json = await llmJson(run, {
      stage: "metacognition.monitoring.reverse_thinking",
      span,
      instructions: `Plan: ${truncate(planSummary, 900)}\n\nAssume this plan failed. Why? List the most likely failure modes; fatal = true only if the plan cannot work as stated.`,
      shape: '{"failureModes": string[], "fatal": boolean, "mitigation": string}',
      context: { mode: "task", task: run.task ? { title: run.task.title } : undefined },
      maxOutputTokens: 300,
    });
    const r = { failureModes: strArr(json.failureModes, 4, 200), fatal: bool(json.fatal, false), mitigation: str(json.mitigation, "", 300) };
    span.setAttributes({ "agentco.premortem.fatal": r.fatal });
    return r;
  });
}

// ── Truthful / Efficient / Good (computed gates on Feedback)

export interface TegInput {
  truthfulScore: number;
  truthfulGate: number;
  actualCostUsd: number;
  estimateUsd: number;
  goodFromModel: boolean;
  score: number;
  acceptThreshold: number;
}

export interface TegResult {
  truthful: boolean;
  efficient: boolean;
  good: boolean;
}

export function tegGates(i: TegInput): TegResult {
  return {
    truthful: i.truthfulScore >= i.truthfulGate,
    efficient: i.estimateUsd <= 0 ? true : i.actualCostUsd <= 1.5 * i.estimateUsd,
    good: i.goodFromModel && i.score >= i.acceptThreshold,
  };
}

export async function truthfulEfficientGood(run: BrainRun, input: TegInput): Promise<TegResult> {
  return block(run, "metacognition.monitoring.truthful_efficient_good", "Checking truthful / efficient / good", (span) => {
    const r = tegGates(input);
    span.setAttributes({
      "agentco.teg.truthful": r.truthful,
      "agentco.teg.efficient": r.efficient,
      "agentco.teg.good": r.good,
      "agentco.teg.truthful_gate": input.truthfulGate,
      "agentco.teg.accept_threshold": input.acceptThreshold,
    });
    return r;
  });
}
