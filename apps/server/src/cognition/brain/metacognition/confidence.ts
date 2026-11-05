/**
 * Metacognition › Confidence · Risk/Uncertainty (← Competence, ← Understanding,
 * ⇓ Calibration) with its Fallback arrows (to Target Understanding and to
 * Self-ability) and the "Early Stop?" exit.
 */
import { round, strArr, unit } from "../../coerce.ts";
import { truncate } from "../../text.ts";
import { Q2_OOD, Q3_FALLBACK } from "../interpretation.ts";
import { block, llmJson, type BrainRun } from "../runtime.ts";
import type { Drives } from "../self-management/identity.ts";
import { calibration } from "./monitoring.ts";
import type { Competence } from "./self-ability.ts";
import type { ProblemDefinition, Understanding } from "./target-understanding.ts";

export interface ConfidenceAssessment {
  raw: number;
  calibrated: number;
  uncertainty: number;
  risks: string[];
}

export function coerceConfidence(json: Record<string, unknown>, ood: boolean): { raw: number; uncertainty: number; risks: string[] } {
  let raw = unit(json.confidence, 0.5);
  if (ood) raw = Math.min(raw, Q2_OOD.confidenceCap);
  const uncertainty = unit(json.uncertainty, round(1 - raw, 3));
  return { raw, uncertainty, risks: strArr(json.risks, 5, 200) };
}

export async function assessConfidence(
  run: BrainRun,
  problem: ProblemDefinition,
  understanding: Understanding,
  competence: Competence,
  ood: boolean,
): Promise<ConfidenceAssessment> {
  return block(run, "metacognition.confidence", "Weighing confidence and risk", async (span) => {
    const json = await llmJson(run, {
      stage: "metacognition.confidence",
      span,
      instructions:
        `Problem: ${truncate(problem.problem, 400)}\nUnderstanding (${understanding.score.toFixed(2)}): ${truncate(understanding.summary, 400)}\n` +
        `Competence (${competence.score.toFixed(2)}); gaps: ${competence.gaps.join("; ") || "none"}\nUnknowns: ${problem.unknowns.join("; ") || "none"}\n` +
        `${ood ? "This is new territory for you (no similar past episodes).\n" : ""}How likely are you to succeed? Give confidence 0-1, uncertainty 0-1 and the top risks.`,
      shape: '{"confidence": number, "uncertainty": number, "risks": string[]}',
      context: { mode: "task", ood, task: run.task ? { title: run.task.title } : undefined },
      maxOutputTokens: 250,
    });
    const c = coerceConfidence(json, ood);
    const calibrated = await calibration(run, c.raw);
    span.setAttributes({ "agentco.confidence": calibrated, "agentco.confidence.raw": c.raw, "agentco.uncertainty": c.uncertainty });
    return { ...c, calibrated };
  });
}

export type FallbackTarget = "target_understanding" | "self_ability";

/** Which Fallback arrow to take (each at most once per run, Q3). */
export function fallbackTarget(understandingScore: number, competenceScore: number, used: Set<FallbackTarget>): FallbackTarget | null {
  if (understandingScore < Q3_FALLBACK.understandingBelow && !used.has("target_understanding")) return "target_understanding";
  if (competenceScore < Q3_FALLBACK.competenceBelow && !used.has("self_ability")) return "self_ability";
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
