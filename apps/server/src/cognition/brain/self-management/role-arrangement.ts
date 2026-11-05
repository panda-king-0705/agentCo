/**
 * Role Arrangement (Master of My Destiny) → "Assign Suitable Role to Workers".
 *
 * Rank by fit = 0.75·mandateFit + 0.25·mbtiFit (Q9). Eight Characters and
 * Five Elements is a tie-breaker only: candidates within 0.05 of the best fit
 * are tied and the tie goes to the best elementFit. The LLM's proposed
 * assignee is one small input, never trusted blindly; the assignee must be an
 * active direct report (the CEO may delegate to anyone active).
 */
import type { Agent, FiveElement } from "../../../../../../packages/shared/src/index.ts";
import { overlapRatio } from "../../text.ts";
import { Q9_DEFAULT_ELEMENT, Q9_DEPARTMENT_ELEMENT, Q9_ROLE } from "../interpretation.ts";
import { mbtiFit } from "./personality.ts";

export interface Candidate {
  agent: Agent;
  departmentName: string;
}

export interface FitScore {
  agentId: string;
  fit: number;
  mandateFit: number;
  mbtiFit: number;
  elementFit: number;
  suggested: boolean;
  /** True when BaZi decided between tied candidates. */
  tieBroken: boolean;
}

export function departmentElement(departmentText: string): FiveElement {
  const t = departmentText.toLowerCase();
  return Q9_DEPARTMENT_ELEMENT.find((row) => row.pattern.test(t))?.element ?? Q9_DEFAULT_ELEMENT;
}

/** 0..1: how strongly the agent's chart carries the element (relative to its strongest element); 0.5 without a chart. */
export function elementFit(agent: Agent, element: FiveElement): number {
  const chart = agent.persona.baZi;
  if (!chart) return 0.5;
  const max = Math.max(...Object.values(chart.elements));
  return max <= 0 ? 0.5 : chart.elements[element] / max;
}

function profileText(c: Candidate): string {
  const a = c.agent;
  return `${a.title} ${c.departmentName} ${a.identity.mission} ${a.identity.assets.join(" ")}`;
}

/** The subprocess's element: from the candidate department that best matches its text. */
export function subprocessElement(text: string, candidates: Candidate[], fallbackDepartment: string): FiveElement {
  let best = fallbackDepartment;
  let bestScore = 0;
  for (const c of candidates) {
    const s = overlapRatio(c.departmentName, text);
    if (s > bestScore) {
      bestScore = s;
      best = c.departmentName;
    }
  }
  return departmentElement(best);
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Ranked candidates; the first entry is the assignment (BaZi applied as tie-breaker). */
export function scoreCandidates(
  subprocessText: string,
  candidates: Candidate[],
  options: { suggestedId?: string | null; usedCounts?: Map<string, number>; fallbackDepartment: string },
): FitScore[] {
  const element = subprocessElement(subprocessText, candidates, options.fallbackDepartment);
  const scored: FitScore[] = candidates.map((c) => {
    const mandate = Math.min(1, overlapRatio(subprocessText, profileText(c)) * 1.5);
    const mbti = mbtiFit(c.agent.persona.personalityType, subprocessText);
    const suggested = !!options.suggestedId && options.suggestedId === c.agent.id;
    const used = options.usedCounts?.get(c.agent.id) ?? 0;
    const fit = Q9_ROLE.mandate * mandate + Q9_ROLE.mbti * mbti + (suggested ? Q9_ROLE.llmSuggestionBonus : 0) - used * Q9_ROLE.repeatAssigneePenalty;
    return { agentId: c.agent.id, fit: r3(fit), mandateFit: r3(mandate), mbtiFit: r3(mbti), elementFit: r3(elementFit(c.agent, element)), suggested, tieBroken: false };
  });
  scored.sort((a, b) => b.fit - a.fit);
  if (scored.length < 2) return scored;
  const best = scored[0]!.fit;
  const tied = scored.filter((s) => best - s.fit <= Q9_ROLE.tieMargin + 1e-9);
  if (tied.length < 2) return scored;
  const winner = [...tied].sort((a, b) => b.elementFit - a.elementFit || b.fit - a.fit)[0]!;
  if (winner.agentId !== scored[0]!.agentId) winner.tieBroken = true;
  return [winner, ...scored.filter((s) => s !== winner)];
}

/**
 * The candidate pool: active direct reports; the CEO (no manager) may also
 * use an LLM-suggested active agent outside its reports.
 */
export function candidatePool(self: Agent, reports: Agent[], allActive: Agent[], suggestedIds: string[]): Agent[] {
  const active = (a: Agent) => a.status !== "terminated" && a.status !== "paused" && a.id !== self.id;
  const pool = reports.filter(active);
  if (self.managerId === null) {
    for (const id of suggestedIds) {
      const a = allActive.find((x) => x.id === id);
      if (a && active(a) && !pool.some((p) => p.id === a.id)) pool.push(a);
    }
  }
  return pool;
}
