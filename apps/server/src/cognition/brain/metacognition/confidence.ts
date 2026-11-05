/**
 * Metacognition › Confidence · Risk/Uncertainty.
 *
 * Inputs: Competence (Self-ability), Understanding (Target Understanding),
 * ⇓ Calibration, OOD signals. The arrows to Self-ability and Target
 * Understanding are double-sided (Q3, "Fallback (EL)" = evaluation):
 * Confidence returns understandingEval / competenceEval {score, gaps[]}; a
 * block scoring below 0.5 re-runs WITH those gaps (at most once each).
 * Early Stop? → escalate → blocked.
 */
import { arr, obj, round, strArr, unit } from "../../coerce.ts";
import { truncate } from "../../text.ts";
import { Q2_OOD, Q3_FALLBACK } from "../interpretation.ts";
import { block, llmJson, type BrainRun } from "../runtime.ts";
import type { Drives } from "../self-management/identity.ts";
import { calibration, pressureConfidencePenalty, type OodReport } from "./monitoring.ts";
import type { Competence } from "./self-ability.ts";
import type { ProblemDefinition, Understanding } from "./target-understanding.ts";

export interface Evaluation {
  score: number;
  gaps: string[];
}

export interface ConfidenceAssessment {
  raw: number;
  calibrated: number;
  uncertainty: number;
  risks: string[];
  understandingEval: Evaluation;
  competenceEval: Evaluation;
  pressurePenalty: number;
}

function coerceEval(v: unknown, defaultScore: number, defaultGaps: string[]): Evaluation {
  const o = obj(v);
  const gaps = arr(o.gaps).length > 0 ? strArr(o.gaps, 5, 200) : defaultGaps;
  return { score: unit(o.score, defaultScore), gaps };
}

/** Pure: model JSON → assessment before calibration (task-OOD cap and pressure penalty applied). */
export function coerceConfidence(
  json: Record<string, unknown>,
  defaults: { understanding: Evaluation; competence: Evaluation },
  ood: { taskOod: boolean; pressureSignals: number },
): Omit<ConfidenceAssessment, "calibrated"> {
  let raw = unit(json.confidence, 0.5);
  if (ood.taskOod) raw = Math.min(raw, Q2_OOD.confidenceCap);
  const pressurePenalty = pressureConfidencePenalty(ood.pressureSignals);
  raw = round(Math.max(0, raw - pressurePenalty), 4);
  const uncertainty = unit(json.uncertainty, round(1 - raw, 3));
  return {
    raw,
    uncertainty,
    risks: strArr(json.risks, 5, 200),
    understandingEval: coerceEval(json.understandingEval, defaults.understanding.score, defaults.understanding.gaps),
    competenceEval: coerceEval(json.competenceEval, defaults.competence.score, defaults.competence.gaps),
    pressurePenalty,
  };
}

export async function assessConfidence(
  run: BrainRun,
  problem: ProblemDefinition,
  understanding: Understanding,
  competence: Competence,
  ood: OodReport,
): Promise<ConfidenceAssessment> {
  return block(run, "metacognition.confidence", "Weighing confidence, risk and uncertainty", async (span) => {
    const pressure = ood.pressure.map((p) => `${p.kind}: ${p.symptom}`);
    const json = await llmJson(run, {
      stage: "metacognition.confidence",
      span,
      instructions:
        `Problem: ${truncate(problem.problem, 400)}\nUnderstanding (${understanding.score.toFixed(2)}): ${truncate(understanding.summary, 400)}\n` +
        `Competence (${competence.score.toFixed(2)}); gaps: ${competence.gaps.join("; ") || "none"}\nUnknowns: ${problem.unknowns.join("; ") || "none"}\n` +
        (ood.taskOod ? "This is new territory for you (no similar past episodes).\n" : "") +
        (pressure.length ? `Constraint pressure: ${pressure.join("; ")}\n` : "") +
        "Estimate confidence of success and uncertainty (0-1), the top risks, and evaluate your understanding and your competence for this task: each {score 0-1, gaps[] = what is missing}.",
      shape: '{"confidence":number,"uncertainty":number,"risks":string[],"understandingEval":{"score":number,"gaps":string[]},"competenceEval":{"score":number,"gaps":string[]}}',
      context: { mode: "task", ood: ood.taskOod, pressure: ood.pressure.map((p) => p.kind), task: run.task ? { title: run.task.title } : undefined },
      maxOutputTokens: 350,
    });
    const c = coerceConfidence(
      json,
      { understanding: { score: understanding.score, gaps: problem.unknowns.slice(0, 3) }, competence: { score: competence.score, gaps: competence.gaps } },
      { taskOod: ood.taskOod, pressureSignals: ood.pressure.length },
    );
    const calibrated = await calibration(run, c.raw);
    span.setAttributes({
      "agentco.confidence": calibrated,
      "agentco.confidence.raw": c.raw,
      "agentco.uncertainty": c.uncertainty,
      "agentco.eval.understanding": c.understandingEval.score,
      "agentco.eval.competence": c.competenceEval.score,
      "agentco.pressure_penalty": c.pressurePenalty,
    });
    return { ...c, calibrated };
  });
}

export type FallbackTarget = "target_understanding" | "self_ability";

/** Which evaluation sends its block back for one more pass (each at most once per run). */
export function fallbackTarget(a: Pick<ConfidenceAssessment, "understandingEval" | "competenceEval">, used: Set<FallbackTarget>): FallbackTarget | null {
  if (a.understandingEval.score < Q3_FALLBACK.evaluationBelow && !used.has("target_understanding")) return "target_understanding";
  if (a.competenceEval.score < Q3_FALLBACK.evaluationBelow && !used.has("self_ability")) return "self_ability";
  return null;
}

/** Early Stop?: calibrated confidence below the threshold, or frustration over the limit. */
export function shouldEarlyStop(calibrated: number, drives: Drives): { stop: boolean; reason: string } {
  if (drives.frustrationGate) return { stop: true, reason: "frustration is above 0.7 after repeated setbacks" };
  if (calibrated < drives.earlyStopThreshold) {
    return { stop: true, reason: `calibrated confidence ${calibrated.toFixed(2)} is below ${drives.earlyStopThreshold.toFixed(2)}` };
  }
  return { stop: false, reason: "" };
}
