/**
 * Every working assumption about words the founder's diagram leaves unclear
 * (docs/BRAIN.md §6, Q1–Q9) lives here and nowhere else. Changing an
 * interpretation must not require touching any other file: the blocks import
 * these constants and functions.
 *
 * Status: all answers PENDING the founder — values below are the documented
 * working assumptions.
 */
import type { FiveElement } from "../../../../../packages/shared/src/index.ts";

// ── Q1 — Red Chinese labels beside Desire, Motivation and at the left of Metacognition.
/** Read as labels only; no extra behaviour. Exposed for the console / trace attributes. */
export const Q1_LABELS = {
  desire: "愿力 (aspiration)",
  motivation: "心力 (drive)",
  metacognitionLeft: ["执行力 (execution)", "能力 (ability)"],
} as const;

// ── Q2 — "OOD Monitoring (NKU/NKK)".
/** Out-of-distribution = too few similar episodes in the agent's own experience; letters unread. */
export const Q2_OOD = {
  /** Fewer similar episodic memories than this → out of distribution. */
  minSimilarEpisodes: 1,
  /** Raw confidence is capped here when OOD. */
  confidenceCap: 0.6,
  /** Extra literature-review breadth (memories) when OOD. */
  extraRecall: 4,
} as const;

// ── Q3 — "Fallback (EL)" on both arrows back from Confidence.
/** A loop back to that block for one more pass; letters unread. */
export const Q3_FALLBACK = {
  maxPassesPerTarget: 1,
  understandingBelow: 0.5,
  competenceBelow: 0.5,
  /** Wider literature review on the Target Understanding fallback pass. */
  extraRecall: 4,
} as const;

// ── Q4 — Symbol between Confidence and Cognitive Control ("∝" or "α").
/** Read as "∝": control effort is proportional to uncertainty. */
export function q4ControlLevel(uncertainty: number, _calibratedConfidence: number): number {
  return Math.min(1, Math.max(0, uncertainty));
}
export const Q4_CONTROL = {
  /** max subprocesses = 1 + round(granularity · c) */
  granularity: 3,
  /** reverse thinking runs when c ≥ this */
  reverseThinkingAt: 0.4,
  /** evaluation strictness: accept threshold += strictness · c */
  strictness: 0.1,
} as const;

// ── Q5 — "BIO / Asserts…" (cut off).
/** Read as "BIO / Assets": the agent's profile, skills and deliverables (identity.assets). */
export const Q5_BIO_ASSETS_LABEL = "BIO / Assets";
export const Q5_MAX_ASSETS = 24;

// ── Q6 — "Solution 3: Low Effect".
/** Low effect (cheap, smaller impact), not "low effort". */
export const Q6_CANDIDATES = [
  { name: "high_cost", label: "Solution 1: High Cost", scope: 1 },
  { name: "low_cost", label: "Solution 2: Low Cost", scope: 2 / 3 },
  { name: "low_effect", label: "Solution 3: Low Effect", scope: 0 },
] as const;
export type CandidateName = (typeof Q6_CANDIDATES)[number]["name"];
/** Share of the decomposed subprocesses each candidate executes (0 → only the single most valuable one). */
export function q6SubprocessCount(candidate: CandidateName, decomposed: number): number {
  if (decomposed <= 0) return 0;
  const c = Q6_CANDIDATES.find((x) => x.name === candidate)!;
  return c.scope === 0 ? 1 : Math.max(1, Math.ceil(decomposed * c.scope));
}
/** Direct-solving step budget per candidate (bounded by the drives' max). */
export const Q6_DIRECT_STEPS: Record<CandidateName, number> = { high_cost: 6, low_cost: 4, low_effect: 2 };
/**
 * Economic Concepts (Cost, Margin…): value points are converted to USD to form
 * a margin with the USD cost — 1000 value points ≈ $1 (assumption).
 */
export const VALUE_USD_PER_POINT = 0.001;

// ── Q7 — Characters after "Life View" and after Truthful / Efficient / Good.
/** Labels only. */
export const Q7_LABELS = { lifeView: "(生)", truthful: "真", efficient: "善", good: "美" } as const;

// ── Q8 — Weight of Eight Characters and Five Elements in role assignment.
export const Q8_ROLE_WEIGHTS = { mandate: 0.7, mbti: 0.2, bazi: 0.1 } as const;
/** Bonus for the assignee the LLM proposed (one input, never trusted blindly). */
export const Q8_LLM_SUGGESTION_BONUS = 0.15;
/** Penalty per subprocess already given to the same assignee in this plan (spread the load). */
export const Q8_REPEAT_ASSIGNEE_PENALTY = 0.2;
/** A subprocess's element, from the department it belongs to (keyword on the department slug/name). */
export const Q8_DEPARTMENT_ELEMENT: { pattern: RegExp; element: FiveElement }[] = [
  { pattern: /engin|tech|platform|infra|secur|data|it\b/, element: "metal" },
  { pattern: /market|brand|growth|comm|sales|revenue|partner/, element: "fire" },
  { pattern: /financ|account|treasur|legal|counsel|complian|audit|risk/, element: "earth" },
  { pattern: /product|design|research|strategy|innov/, element: "wood" },
  { pattern: /people|hr|talent|culture|support|success|operat|staff/, element: "water" },
];
export const Q8_DEFAULT_ELEMENT: FiveElement = "earth";
/** Task kind → preferred MBTI letters (Personality / MBTI fit). */
export const Q8_MBTI_TASK_TABLE: { kind: string; pattern: RegExp; prefers: string[] }[] = [
  { kind: "analysis", pattern: /analy|research|data|financ|model|forecast|metric|audit|pricing|budget/, prefers: ["T", "N"] },
  { kind: "outreach", pattern: /market|sales|partner|customer|press|social|recruit|hire|communi|launch|campaign/, prefers: ["E", "F"] },
  { kind: "process", pattern: /process|operat|complian|legal|schedul|document|policy|contract|checklist/, prefers: ["S", "J"] },
  { kind: "creative", pattern: /design|brand|content|write|story|creative|blog|copy/, prefers: ["N", "F"] },
  { kind: "build", pattern: /engineer|build|code|platform|infra|implement|develop|architect|ship/, prefers: ["T", "J"] },
];

// ── Q9 — Arrow from below into Human Nature.
/** Work events (outcomes, workload) feed Human Nature's update rules. */
export const Q9_HUMAN_NATURE = {
  successValence: 0.2,
  /** Negativity bias: a failure moves valence this many times a success. */
  negativityBias: 1.5,
  /** Recognition by the manager or the Board moves valence this many times self-acceptance. */
  recognitionMultiplier: 2,
  /** Habituation: a repeat outcome (valence already leaning that way) counts less. */
  habituation: 0.5,
  frustrationOnFailure: 0.25,
  frustrationDecayOnSuccess: 0.15,
  frustrationOnEscalation: 0.1,
  /** Fatigue: arousal rises with open work and decays when idle. */
  arousalPerOpenItem: 0.08,
  arousalPerRun: 0.05,
  arousalIdleDecay: 0.2,
  arousalBase: 0.2,
} as const;
