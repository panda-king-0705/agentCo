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
  /**
   * Workers staffed from a catalog specialist: its description + mission (CatalogView.profileFor),
   * added to the mandateFit text so the specialist's real scope counts (docs/CATALOG.md).
   */
  catalogProfile?: string | null;
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
  /** The request named this candidate's department or role ("Have Finance…", "ask the CTO…"). */
  named?: boolean;
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

/** mandateFit text: title, department, mission, assets — plus the catalog specialist's description and mission for catalog workers. */
export function profileText(c: Candidate): string {
  const a = c.agent;
  const catalog = a.tier === "worker" && c.catalogProfile ? ` ${c.catalogProfile}` : "";
  return `${a.title} ${c.departmentName} ${a.identity.mission}${catalog} ${a.identity.assets.join(" ")}`;
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
  options: { suggestedId?: string | null; usedCounts?: Map<string, number>; fallbackDepartment: string; namedIds?: ReadonlySet<string> },
): FitScore[] {
  const element = subprocessElement(subprocessText, candidates, options.fallbackDepartment);
  const scored: FitScore[] = candidates.map((c) => {
    const mandate = Math.min(1, overlapRatio(subprocessText, profileText(c)) * 1.5);
    const mbti = mbtiFit(c.agent.persona.personalityType, subprocessText);
    const suggested = !!options.suggestedId && options.suggestedId === c.agent.id;
    const used = options.usedCounts?.get(c.agent.id) ?? 0;
    const named = options.namedIds?.has(c.agent.id) ?? false;
    const fit =
      Q9_ROLE.mandate * mandate + Q9_ROLE.mbti * mbti + (suggested ? Q9_ROLE.llmSuggestionBonus : 0) + (named ? Q9_ROLE.namedBonus : 0) - used * Q9_ROLE.repeatAssigneePenalty;
    return { agentId: c.agent.id, fit: r3(fit), mandateFit: r3(mandate), mbtiFit: r3(mbti), elementFit: r3(elementFit(c.agent, element)), suggested, tieBroken: false, named };
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

const ROLE_ACRONYMS: Record<string, string> = {
  "chief executive officer": "ceo",
  "chief financial officer": "cfo",
  "chief technology officer": "cto",
  "chief operating officer": "coo",
  "chief marketing officer": "cmo",
  "chief people officer": "cpo",
  "chief product officer": "cpo",
  "chief revenue officer": "cro",
};

/**
 * Candidates whose department, role or full name the text names explicitly — "Have Finance write…",
 * "ask the CTO", "engineering should…", "Noah Patel assembles". Keyword fit put a finance budget with
 * the CTO because it mentioned "model spend"; an explicit name from the Board now decides
 * (Q9_ROLE.namedBonus). The leader's own department is not matched by its department name (the CEO's
 * "executive summary" is not a request for the Executive Office's Chief of Staff).
 */
export function namedCandidates(text: string, candidates: Candidate[], options: { ownDepartment?: string | null } = {}): Set<string> {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const t = ` ${norm(text)} `;
  const has = (w: string) => w.length >= 3 && t.includes(` ${w} `);
  const own = options.ownDepartment ? norm(options.ownDepartment) : null;
  const ids = new Set<string>();
  for (const c of candidates) {
    const dept = norm(c.departmentName);
    const title = norm(c.agent.title);
    const acronym = ROLE_ACRONYMS[title];
    const byDept = !!dept && dept !== own && (has(dept) || (has(dept.split(" ")[0]!) && dept.split(" ")[0]!.length >= 5));
    if (byDept || has(title) || (acronym && has(acronym)) || has(norm(c.agent.name))) ids.add(c.agent.id);
  }
  return ids;
}
