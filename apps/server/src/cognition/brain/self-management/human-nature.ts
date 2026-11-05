/**
 * Self-management › Human Nature: the update rules for Sensibility/Emotion,
 * fed by work events from below (Q9). Pure.
 *
 * - negativity bias: a failure moves valence 1.5× a success;
 * - habituation: an outcome in the direction valence already leans counts less;
 * - fatigue: arousal rises with open work and consecutive runs, decays when idle;
 * - recognition: acceptance by the manager or the Board moves valence 2× self-acceptance.
 */
import type { AffectState } from "../../../../../../packages/shared/src/index.ts";
import { clamp, round } from "../../coerce.ts";
import { Q9_HUMAN_NATURE as H } from "../interpretation.ts";

export type WorkOutcome = "success" | "failure" | "escalated" | "partial";

export interface WorkEvent {
  outcome: WorkOutcome;
  recognizedBy: "self" | "manager" | "board";
  /** Open items on the agent's plate (waiting subtasks, interrupts). */
  openItems: number;
  /** Runs in a row without idle time (approximation: 1 per run). */
  consecutiveRuns: number;
}

export function updateAffect(affect: AffectState, event: WorkEvent): AffectState {
  let delta = 0;
  if (event.outcome === "success") delta = H.successValence;
  else if (event.outcome === "partial") delta = H.successValence * 0.25;
  else if (event.outcome === "failure") delta = -H.successValence * H.negativityBias;
  else delta = -H.successValence * 0.5;
  if (delta > 0 && event.recognizedBy !== "self") delta *= H.recognitionMultiplier;
  // Habituation: repeats (valence already leaning the same way) count less.
  if (Math.sign(delta) === Math.sign(affect.valence) && affect.valence !== 0) {
    delta *= 1 - H.habituation * Math.min(1, Math.abs(affect.valence));
  }
  let frustration = affect.frustration;
  if (event.outcome === "failure") frustration += H.frustrationOnFailure;
  else if (event.outcome === "escalated") frustration += H.frustrationOnEscalation;
  else if (event.outcome === "success") frustration -= H.frustrationDecayOnSuccess;
  const arousalTarget = H.arousalBase + H.arousalPerOpenItem * event.openItems + H.arousalPerRun * event.consecutiveRuns;
  const arousal = event.openItems === 0 ? affect.arousal - H.arousalIdleDecay * (affect.arousal - H.arousalBase) : (affect.arousal + arousalTarget) / 2;
  return {
    valence: round(clamp(affect.valence + delta, -1, 1), 3),
    arousal: round(clamp(arousal, 0, 1), 3),
    frustration: round(clamp(frustration, 0, 1), 3),
  };
}
