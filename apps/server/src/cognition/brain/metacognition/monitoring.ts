/**
 * Metacognition › Monitoring: OOD Monitoring · Calibration · Reverse Thinking ·
 * Truthful / Efficient / Good.
 */
import type { CalibrationStats } from "../../../../../../packages/shared/src/index.ts";
import { bool, clamp, round, str, strArr } from "../../coerce.ts";
import { truncate } from "../../text.ts";
import { Q2_OOD } from "../interpretation.ts";
import { block, llmJson, type BrainRun } from "../runtime.ts";

// ── Calibration (pure)

/** calibrated = raw − (meanConfidence − successRate)·min(1, samples/20) */
export function calibrate(raw: number, cal: CalibrationStats): number {
  const bias = cal.meanConfidence - cal.successRate;
  const weight = Math.min(1, Math.max(0, cal.samples) / 20);
  return round(clamp(raw - bias * weight, 0, 1), 4);
}

/** One more sample: predicted confidence vs observed outcome (1 success, 0 failure). Running means + Brier. */
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

// ── OOD (no model)

export interface OodResult {
  ood: boolean;
  similarEpisodes: number;
}

export async function oodMonitoring(run: BrainRun, problem: string): Promise<OodResult> {
  return block(run, "metacognition.monitoring.ood", "Checking whether this is new territory", (span) => {
    const similar = run.platform.memory.search({ query: problem, agentId: run.agent.id, scopes: ["agent"], kinds: ["episodic"], limit: 3 });
    const ood = similar.length < Q2_OOD.minSimilarEpisodes;
    span.setAttributes({ "agentco.ood": ood, "agentco.ood.similar": similar.length });
    return { ood, similarEpisodes: similar.length };
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
