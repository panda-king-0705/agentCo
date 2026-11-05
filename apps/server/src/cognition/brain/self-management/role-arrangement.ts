/**
 * Role Arrangement (Master of My Destiny) → "Assign Suitable Role to Workers".
 *
 * fit = w_mandate·mandateFit + w_mbti·mbtiFit + w_bazi·elementFit (weights in
 * interpretation.ts, Q8). The LLM's proposed assignee is one input (a bonus),
 * never trusted blindly: the assignee must be an active direct report (the
 * CEO may delegate to anyone active).
 */
import type { Agent, FiveElement } from "../../../../../../packages/shared/src/index.ts";
import { overlapRatio } from "../../text.ts";
import {
  Q8_DEFAULT_ELEMENT,
  Q8_DEPARTMENT_ELEMENT,
  Q8_LLM_SUGGESTION_BONUS,
  Q8_REPEAT_ASSIGNEE_PENALTY,
  Q8_ROLE_WEIGHTS,
} from "../interpretation.ts";
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
}

export function departmentElement(departmentText: string): FiveElement {
  const t = departmentText.toLowerCase();
  return Q8_DEPARTMENT_ELEMENT.find((row) => row.pattern.test(t))?.element ?? Q8_DEFAULT_ELEMENT;
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

export function scoreCandidates(
  subprocessText: string,
  candidates: Candidate[],
  options: { suggestedId?: string | null; usedCounts?: Map<string, number>; fallbackDepartment: string },
): FitScore[] {
  const element = subprocessElement(subprocessText, candidates, options.fallbackDepartment);
  return candidates
    .map((c) => {
      const mandate = Math.min(1, overlapRatio(subprocessText, profileText(c)) * 1.5);
      const mbti = mbtiFit(c.agent.persona.personalityType, subprocessText);
      const el = elementFit(c.agent, element);
      const suggested = !!options.suggestedId && options.suggestedId === c.agent.id;
      const used = options.usedCounts?.get(c.agent.id) ?? 0;
      const fit =
        Q8_ROLE_WEIGHTS.mandate * mandate +
        Q8_ROLE_WEIGHTS.mbti * mbti +
        Q8_ROLE_WEIGHTS.bazi * el +
        (suggested ? Q8_LLM_SUGGESTION_BONUS : 0) -
        used * Q8_REPEAT_ASSIGNEE_PENALTY;
      return { agentId: c.agent.id, fit: Math.round(fit * 1000) / 1000, mandateFit: mandate, mbtiFit: mbti, elementFit: el, suggested };
    })
    .sort((a, b) => b.fit - a.fit);
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
