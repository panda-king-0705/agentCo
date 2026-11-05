/**
 * Self-management › Human Nature: the update rules for Sensibility/Emotion,
 * fed by the finished processes (Q8): every finished subprocess — done,
 * failed, escalated, cancelled; the agent's own and its reports' — is an
 * event. Pure.
 *
 * - negativity bias: a failure moves valence 1.5× a success;
 * - habituation: an outcome in the direction valence already leans counts less;
 * - fatigue: arousal rises with open work and consecutive runs, decays when idle;
 * - recognition: acceptance by the manager or the Board moves valence 2× self-acceptance.
 */
import type { AffectState, Task } from "../../../../../../packages/shared/src/index.ts";
import { clamp, round } from "../../coerce.ts";
import { Q8_HUMAN_NATURE as H } from "../interpretation.ts";

export type ProcessOutcome = "done" | "failed" | "escalated" | "cancelled";

export interface ProcessEvent {
  outcome: ProcessOutcome;
  /** "own" = the agent's own process; "report" = a subprocess finished by a report. */
  source: "own" | "report";
  recognizedBy: "self" | "manager" | "board";
}

export interface Workload {
  /** Open items on the agent's plate (open subprocesses, interrupts). */
  openItems: number;
  /** Runs in a row without idle time. */
  consecutiveRuns: number;
}

/** Finished subprocesses (reports' tasks) → events. Blocked counts as escalated. */
export function eventsFromSubtasks(subtasks: Task[]): ProcessEvent[] {
  const out: ProcessEvent[] = [];
  for (const t of subtasks) {
    const outcome: ProcessOutcome | null =
      t.status === "done" ? "done" : t.status === "failed" ? "failed" : t.status === "cancelled" ? "cancelled" : t.status === "blocked" ? "escalated" : null;
    if (outcome) out.push({ outcome, source: "report", recognizedBy: "self" });
  }
  return out;
}

function applyOne(a: AffectState, e: ProcessEvent): AffectState {
  const w = e.source === "report" ? H.reportEventWeight : 1;
  let delta = 0;
  if (e.outcome === "done") delta = H.successValence;
  else if (e.outcome === "failed") delta = -H.successValence * H.negativityBias;
  else if (e.outcome === "escalated") delta = -H.successValence * 0.5;
  else delta = -H.successValence * 0.25;
  if (delta > 0 && e.recognizedBy !== "self") delta *= H.recognitionMultiplier;
  if (a.valence !== 0 && Math.sign(delta) === Math.sign(a.valence)) delta *= 1 - H.habituation * Math.min(1, Math.abs(a.valence));
  let frustration = a.frustration;
  if (e.outcome === "failed") frustration += H.frustrationOnFailure * w;
  else if (e.outcome === "escalated") frustration += H.frustrationOnEscalation * w;
  else if (e.outcome === "cancelled") frustration += H.frustrationOnCancel * w;
  else frustration -= H.frustrationDecayOnSuccess * w;
  return { valence: clamp(a.valence + delta * w, -1, 1), arousal: a.arousal, frustration: clamp(frustration, 0, 1) };
}

export function updateAffect(affect: AffectState, events: ProcessEvent[], workload: Workload): AffectState {
  let a = { ...affect };
  for (const e of events) a = applyOne(a, e);
  const target = H.arousalBase + H.arousalPerOpenItem * workload.openItems + H.arousalPerRun * workload.consecutiveRuns;
  const arousal = workload.openItems === 0 ? a.arousal - H.arousalIdleDecay * (a.arousal - H.arousalBase) : (a.arousal + target) / 2;
  return { valence: round(a.valence, 3), arousal: round(clamp(arousal, 0, 1), 3), frustration: round(a.frustration, 3) };
}
