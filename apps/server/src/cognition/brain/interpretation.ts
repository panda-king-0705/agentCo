/**
 * The founder's readings of words the diagram leaves unclear (docs/BRAIN.md §6,
 * answered 2026-11-05) live here and nowhere else. Changing a reading must not
 * require touching any other file: the blocks import these constants and
 * functions. Numeric tunings that are engineering choices (not readings) are
 * marked "tuning".
 */
import type { FiveElement } from "../../../../../packages/shared/src/index.ts";

// ── Q1 — Red Chinese labels beside Desire, Motivation and at the left of Metacognition: labels only.
export const Q1_LABELS = {
  desire: "愿力",
  motivation: "心力",
  metacognitionLeft: ["执行力", "能力"],
} as const;

// ── Q2 — "OOD Monitoring (NCU/NKI)": profile-guided OOD monitoring of each block's
// model calls against the block's history and hard constraints (in the spirit of
// Nsight Compute / NKI kernel profiling): task OOD, performance OOD, constraint pressure.
export const Q2_OOD = {
  /** Task OOD: fewer similar episodic memories than this. */
  minSimilarEpisodes: 1,
  /** Task OOD caps raw confidence here … */
  confidenceCap: 0.6,
  /** … and widens the literature review by this many memories. */
  extraRecall: 4,
  /** Performance OOD needs at least this many historical calls of the block (tuning). */
  minHistoryCalls: 5,
  /** Performance OOD: a call beyond p95 × this factor (latency, input/output tokens, cost). */
  p95Factor: 1,
  /** Constraint pressure thresholds. */
  contextShare: 0.7, // prompt tokens > 70% of the model's context window
  budgetShare: 0.2, // budget remaining < 20% of the agent's monthly budget
  timeShare: 0.25, // < 25% of the run's time limit left
  /** No new revise/rollback pass with less than this share of the run's time left (one pass ≈ 1 minute of a 5-minute run). */
  anotherPassMinTimeShare: 0.4,
  /** Each pressure signal lowers raw confidence by this much (tuning) … */
  confidencePenaltyPerSignal: 0.08,
  confidencePenaltyMax: 0.24,
  /** … and raises the control level (finer decomposition) by this much (tuning). */
  controlBoostPerSignal: 0.15,
  /** Optimization insights kept per agent (recall reads the newest ones). */
  insightsKept: 50,
  /** Memory tag of optimization insights. */
  insightTag: "optimization",
  /** At most this many new insights per run (tuning; keeps memory lean). */
  maxInsightsPerRun: 3,
} as const;

// ── Q3 — "Fallback (EL)": EL = evaluation. The arrows are double-sided: Confidence
// returns an evaluation {score, gaps[]} of Understanding and of Competence; a block
// scoring below the threshold re-runs WITH those gaps as input, at most once each.
export const Q3_FALLBACK = {
  evaluationBelow: 0.5,
  maxPassesPerTarget: 1,
  /** Wider literature review on the Target Understanding re-run. */
  extraRecall: 4,
} as const;

// ── Q4 — Symbol between Confidence and Cognitive Control: "proportional to", drawn like α.
export const Q4_ALPHA = 1;
/** c = clamp(α · uncertainty). */
export function q4ControlLevel(uncertainty: number): number {
  return Math.min(1, Math.max(0, Q4_ALPHA * uncertainty));
}
export const Q4_CONTROL = {
  /** max subprocesses = 1 + round(granularity · c) */
  granularity: 3,
  /** reverse thinking runs when c ≥ this */
  reverseThinkingAt: 0.4,
  /** evaluation strictness: accept threshold += strictness · c (tuning) */
  strictness: 0.1,
  /**
   * Owners the request names each get a part (founder, 2026-11-07): max subprocesses is at least
   * the named owners, plus one for a round-2 step (assembly/review) when two or more are named —
   * never more than maxParts. Overrides essentialOnly (the Board's explicit split wins).
   */
  namedRound2Slack: 1,
  maxParts: 8,
} as const;

// ── Q5 — "BIO / Asserts…" = BIO / Assets.
export const Q5_BIO_ASSETS_LABEL = "BIO / Assets";
export const Q5_MAX_ASSETS = 24;

// ── Q6 — "Solution 3" = Low Effort: the smallest change that meets the criteria
// (reuse memory, existing files and subtask results).
export const Q6_CANDIDATES = [
  { name: "high_cost", label: "Solution 1: High Cost", approach: "Thorough: higher tier, more steps, extra verification" },
  { name: "low_cost", label: "Solution 2: Low Cost", approach: "Same scope on cheaper tiers with fewer steps" },
  { name: "low_effort", label: "Solution 3: Low Effort", approach: "Smallest change that meets the criteria: reuse memory, existing files and subtask results" },
] as const;
export type CandidateName = (typeof Q6_CANDIDATES)[number]["name"];
export const CANDIDATE_NAMES: readonly CandidateName[] = Q6_CANDIDATES.map((c) => c.name);
/** How each candidate executes (tuning): subprocess share, direct-solving steps, tier shift. */
export const Q6_EXECUTION: Record<CandidateName, { subprocessShare: number; directSteps: number; tierShift: -1 | 0 | 1; verify: boolean }> = {
  high_cost: { subprocessShare: 1, directSteps: 8, tierShift: 1, verify: true },
  low_cost: { subprocessShare: 1, directSteps: 6, tierShift: -1, verify: false },
  low_effort: { subprocessShare: 0.5, directSteps: 4, tierShift: -1, verify: false },
};
export function q6SubprocessCount(candidate: CandidateName, decomposed: number): number {
  if (decomposed <= 0) return 0;
  return Math.max(1, Math.ceil(decomposed * Q6_EXECUTION[candidate].subprocessShare));
}
/**
 * Economic Concepts (Cost, Margin…): value points are converted to USD to form a
 * margin with the USD cost — 1000 value points ≈ $1 (tuning).
 */
export const VALUE_USD_PER_POINT = 0.001;
/** Under constraint pressure or a profiling insight, High Cost is avoided (founder: favour Low Cost / Low Effort). */
export const Q6_PRESSURE_EXCLUDES: readonly CandidateName[] = ["high_cost"];

// ── Q7 — Characters after Life View and after Truthful / Efficient / Good: labels only.
export const Q7_LABELS = { lifeView: "生", truthful: "真", efficient: "善", good: "美" } as const;

// ── Q8 — Arrow into Human Nature: fed by the finished processes — every finished
// subprocess (done, failed, escalated, cancelled; own and reports') is an event.
export const Q8_HUMAN_NATURE = {
  successValence: 0.2,
  /** Negativity bias: a failure moves valence this many times a success. */
  negativityBias: 1.5,
  /** Recognition by the manager or the Board moves valence this many times self-acceptance. */
  recognitionMultiplier: 2,
  /** Habituation: an outcome in the direction valence already leans counts less. */
  habituation: 0.5,
  frustrationOnFailure: 0.25,
  frustrationDecayOnSuccess: 0.15,
  frustrationOnEscalation: 0.1,
  frustrationOnCancel: 0.05,
  /** Frustration also relaxes on every Report (tuning) … */
  frustrationDecayPerRun: 0.1,
  /** … and halves over this much idle time before the run (tuning): setbacks are not carried forever. */
  frustrationHalfLifeMs: 2 * 3_600_000,
  /** A report's finished subprocess weighs this much relative to the agent's own outcome (tuning). */
  reportEventWeight: 0.5,
  /** Fatigue: arousal rises with open work and consecutive runs, decays when idle. */
  arousalPerOpenItem: 0.08,
  arousalPerRun: 0.05,
  arousalIdleDecay: 0.2,
  arousalBase: 0.2,
  /** Fatigue: runs separated by less idle time than this count as consecutive (tuning). */
  fatigueIdleGapMs: 10 * 60_000,
  /** Fatigue: at most this many consecutive runs are counted (tuning). */
  fatigueMaxRuns: 12,
  /** Valence decays toward 0 by this share on every Report (tuning) … */
  valenceDecayPerRun: 0.15,
  /** … and halves over this much idle time before the run (tuning), so the curiosity boost fades. */
  valenceHalfLifeMs: 24 * 3_600_000,
} as const;

// ── Motivation › Purpose → OKR weighting (tuning): purpose scales the vision/OKR alignment
// multiplier — 1 + visionWeight·vision·(purposeBase + purpose); purpose 0.5 = the plain 1 + 0.5·vision.
export const PURPOSE_WEIGHTING = {
  visionWeight: 0.5,
  purposeBase: 0.5,
} as const;
export function alignmentMultiplier(vision: number, purpose: number): number {
  const v = Math.min(1, Math.max(0, vision));
  const p = Math.min(1, Math.max(0, purpose));
  return 1 + PURPOSE_WEIGHTING.visionWeight * v * (PURPOSE_WEIGHTING.purposeBase + p);
}

// ── Motivation › Maslow › Belonging (tuning): low when the manager is missing/terminated, or when a
// leader (tier manager or executive) has direct reports and none of them is reachable (active).
// Response: check in with / escalate to the next ACTIVE ancestor (the Board when there is none, e.g.
// the CEO); unreachable reports are noted as a Self-ability gap (no delegation this run).
export const BELONGING = {
  leaderTiers: ["manager", "executive"] as readonly string[],
  unreachableReportsGap: "direct reports unreachable (paused or terminated): do the work directly or escalate",
} as const;

// ── TODO List (Interruptible): yield budget (tuning). A task may be interrupted at most this many
// times; after that it finishes its pass before the agent turns to the more urgent work, so a stream
// of messages can never starve an objective. Solving is never interrupted once it has started.
export const TODO_YIELD = {
  maxPerTask: 3,
} as const;

// ── Q9 — Eight Characters and Five Elements in role assignment: tie-breaker only.
export const Q9_ROLE = {
  /** rank by fit = mandate·mandateFit + mbti·mbtiFit */
  mandate: 0.75,
  mbti: 0.25,
  /** candidates within this of the best fit are tied; the tie goes to the best elementFit. */
  tieMargin: 0.05,
  /**
   * The leader's own choice of assignee (tuning). It was a 0.04 nudge, so keyword overlap overrode a
   * live leader's sensible pick ("verify and assemble the plan": Chief of Staff → CTO). Now it decides
   * unless another report's mandate fits clearly better.
   */
  llmSuggestionBonus: 0.3,
  /** Spread the load: penalty per subprocess already given to the same assignee in this plan (tuning). */
  repeatAssigneePenalty: 0.2,
  /** The request explicitly names the candidate's department or role: decisive over keyword fit (tuning). */
  namedBonus: 1,
} as const;
/** A subprocess's element, from the department it belongs to (keyword on the department name). */
export const Q9_DEPARTMENT_ELEMENT: { pattern: RegExp; element: FiveElement }[] = [
  { pattern: /engin|tech|platform|infra|secur|data|\bit\b/, element: "metal" },
  { pattern: /market|brand|growth|comm|sales|revenue|partner/, element: "fire" },
  { pattern: /financ|account|treasur|legal|counsel|complian|audit|risk/, element: "earth" },
  { pattern: /product|design|research|strategy|innov/, element: "wood" },
  { pattern: /people|hr|talent|culture|support|success|operat|staff/, element: "water" },
];
export const Q9_DEFAULT_ELEMENT: FiveElement = "earth";

/** Personality / MBTI: task kind → preferred letters (used by role arrangement). */
export const MBTI_TASK_TABLE: { kind: string; pattern: RegExp; prefers: string[] }[] = [
  { kind: "analysis", pattern: /analy|research|data|financ|model|forecast|metric|audit|pricing|budget/, prefers: ["T", "N"] },
  { kind: "outreach", pattern: /market|sales|partner|customer|press|social|recruit|hire|communi|launch|campaign/, prefers: ["E", "F"] },
  { kind: "process", pattern: /process|operat|complian|legal|schedul|document|policy|contract|checklist/, prefers: ["S", "J"] },
  { kind: "creative", pattern: /design|brand|content|write|story|creative|blog|copy/, prefers: ["N", "F"] },
  { kind: "build", pattern: /engineer|build|code|platform|infra|implement|develop|architect|ship/, prefers: ["T", "J"] },
];
