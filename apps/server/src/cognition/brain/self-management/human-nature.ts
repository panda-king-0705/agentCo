/**
 * Self-management › Human Nature: the update rules for Sensibility/Emotion,
 * fed by the finished processes (Q8): every finished subprocess — done,
 * failed, escalated, cancelled; the agent's own and its reports' — is an
 * event. Pure.
 *
 * - negativity bias: a failure moves valence 1.5× a success;
 * - habituation: an outcome in the direction valence already leans counts less;
 * - fatigue: arousal rises with open work and consecutive runs (real run streaks, from the
 *   platform's run history), decays when idle;
 * - recognition: acceptance by the manager or the Board moves valence 2× self-acceptance — the
 *   worker counts its own acceptance at its Report (1×) and the manager's Feedback (or the Board's
 *   go-ahead) tops it up through `recognition()`;
 * - decay: valence relaxes toward 0 on every Report and over idle time, so a past streak of
 *   success (or failure) does not modulate Motivation forever.
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
  /** Idle time before the current run (ms; 0 or absent when unknown). */
  idleMs?: number;
}

/** Valence decay toward 0: one Report's worth, plus the idle time before the run (half-life). */
export function decayValence(valence: number, idleMs = 0): number {
  const idle = Math.max(0, idleMs) / H.valenceHalfLifeMs;
  return valence * (1 - H.valenceDecayPerRun) * Math.pow(0.5, idle);
}

/**
 * Recognition: a manager's Feedback accepted the worker's subtask (or the Board accepted the
 * CEO's objective). The worker already counted its own acceptance (1×) when it reported; this
 * tops it up to recognitionMultiplier× (habituation applies). Arousal is untouched.
 */
export function recognition(affect: AffectState, by: "manager" | "board"): AffectState {
  let delta = H.successValence * (H.recognitionMultiplier - 1);
  if (affect.valence > 0) delta *= 1 - H.habituation * Math.min(1, affect.valence);
  return {
    valence: round(clamp(affect.valence + delta, -1, 1), 3),
    arousal: affect.arousal,
    frustration: round(clamp(affect.frustration - H.frustrationDecayOnSuccess * (by === "board" ? 1 : 0.5), 0, 1), 3),
  };
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
  let a = { ...affect, valence: decayValence(affect.valence, workload.idleMs) };
  for (const e of events) a = applyOne(a, e);
  const target = H.arousalBase + H.arousalPerOpenItem * workload.openItems + H.arousalPerRun * workload.consecutiveRuns;
  const arousal = workload.openItems === 0 ? a.arousal - H.arousalIdleDecay * (a.arousal - H.arousalBase) : (a.arousal + target) / 2;
  return { valence: round(a.valence, 3), arousal: round(clamp(arousal, 0, 1), 3), frustration: round(a.frustration, 3) };
}
