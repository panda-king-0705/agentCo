/**
 * Role Arrangement › Personality / MBTI: task-kind fit for role arrangement,
 * a tone hint for prompts, and a persona suggestion for new hires.
 */
import { Q8_MBTI_TASK_TABLE } from "../interpretation.ts";

export function taskKinds(text: string): { kind: string; prefers: string[] }[] {
  const t = text.toLowerCase();
  return Q8_MBTI_TASK_TABLE.filter((row) => row.pattern.test(t)).map((row) => ({ kind: row.kind, prefers: row.prefers }));
}

/** 0..1: share of the task kinds' preferred letters present in the type; 0.5 when unknown. */
export function mbtiFit(personalityType: string | null | undefined, text: string): number {
  const type = (personalityType ?? "").toUpperCase();
  if (!/^[EI][SN][TF][JP]$/.test(type)) return 0.5;
  const kinds = taskKinds(text);
  if (kinds.length === 0) return 0.5;
  let hit = 0;
  let total = 0;
  for (const k of kinds) {
    for (const letter of k.prefers) {
      total++;
      if (type.includes(letter)) hit++;
    }
  }
  return total === 0 ? 0.5 : hit / total;
}

const TONES: Record<string, string> = {
  E: "outgoing",
  I: "reserved",
  S: "concrete",
  N: "big-picture",
  T: "logical",
  F: "people-minded",
  J: "decisive",
  P: "flexible",
};

/** Personality shapes tone only (", tone: logical, decisive"). */
export function toneFor(personalityType: string | null | undefined): string {
  const type = (personalityType ?? "").toUpperCase();
  if (!/^[EI][SN][TF][JP]$/.test(type)) return "";
  return ` (${type}: ${[type[0], type[2], type[3]].map((l) => TONES[l!]).join(", ")})`;
}

/** For hire_agent: the MBTI type that best fits a mandate (ties → INTJ-ish defaults). */
export function suggestPersonalityType(mandate: string): string {
  const kinds = taskKinds(mandate);
  const votes: Record<string, number> = {};
  for (const k of kinds) for (const l of k.prefers) votes[l] = (votes[l] ?? 0) + 1;
  const pick = (a: string, b: string, def: string) => ((votes[a] ?? 0) > (votes[b] ?? 0) ? a : (votes[b] ?? 0) > (votes[a] ?? 0) ? b : def);
  return `${pick("E", "I", "I")}${pick("S", "N", "N")}${pick("T", "F", "T")}${pick("J", "P", "J")}`;
}
