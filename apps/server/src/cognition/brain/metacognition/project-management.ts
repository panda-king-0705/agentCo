/**
 * Metacognition › Project Management: Data-driven Analysis · Economic
 * Concepts (Cost, Margin…) · Rollback / Failure Recovery · Reflection /
 * Replanning · Online Learning / Evolving.
 */
import type { MemoryItem, Task } from "../../../../../../packages/shared/src/index.ts";
import { bool, clamp, round, str, strArr } from "../../coerce.ts";
import { oneLine, truncate } from "../../text.ts";
import { CANDIDATE_NAMES, Q2_OOD, Q6_PRESSURE_EXCLUDES, VALUE_USD_PER_POINT, type CandidateName } from "../interpretation.ts";
import { block, llmJson, type BrainRun, type OptimizationInsight } from "../runtime.ts";
import type { CandidateSolution } from "./cognitive-control.ts";
import { insightContent, parseInsight } from "./monitoring.ts";

// ── Data-driven Analysis (no model)

export interface DataAnalysis {
  costFactor: number;
  costSamples: number;
  insights: OptimizationInsight[];
  /** A recalled insight says this agent's planning/solving ran hot → avoid High Cost. */
  favourCheap: boolean;
  lessons: string[];
}

/** "cost $0.0123 (est $0.0100)" in episodic memories → actual/estimate ratios. */
export function costRatios(memories: { content: string }[]): number[] {
  const out: number[] = [];
  for (const m of memories) {
    const r = /cost \$([0-9.]+) \(est \$([0-9.]+)\)/.exec(m.content);
    if (!r) continue;
    const actual = Number(r[1]);
    const est = Number(r[2]);
    if (est > 0 && Number.isFinite(actual)) out.push(actual / est);
  }
  return out;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The newest `kept` optimization insights among procedural memories. */
export function newestInsights(memories: MemoryItem[], kept: number = Q2_OOD.insightsKept): OptimizationInsight[] {
  return memories
    .filter((m) => m.kind === "procedural" && (m.tags.includes(Q2_OOD.insightTag) || m.content.startsWith("optimization insight")))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((m) => parseInsight(m.content))
    .filter((x): x is OptimizationInsight => x !== null)
    .slice(0, kept);
}

const HOT = /latency|cost|tok|pressure/;

export async function dataDrivenAnalysis(run: BrainRun, problem: string): Promise<DataAnalysis> {
  return block(run, "metacognition.project_management.data_driven_analysis", "Checking past cost and outcomes of similar work", (span) => {
    const episodes = run.platform.memory.search({ query: problem, agentId: run.agent.id, scopes: ["agent"], kinds: ["episodic"], limit: 8 });
    const ratios = costRatios(episodes);
    const m = median(ratios);
    const costFactor = m === null ? 1 : round(clamp(m, 0.5, 3), 3);
    const memories = run.platform.memory.search({
      query: `optimization insight ${problem}`,
      agentId: run.agent.id,
      scopes: ["agent"],
      kinds: ["procedural"],
      limit: Q2_OOD.insightsKept,
    });
    const insights = newestInsights(memories);
    const relevant = insights.filter((i) => /cognitive_control|solving|metacognition$/.test(i.block) || i.symptom.includes("pressure"));
    const favourCheap = relevant.some((i) => HOT.test(i.symptom));
    const lessons = [
      ...(ratios.length ? [`similar past work cost ${costFactor}× its estimate (n=${ratios.length})`] : []),
      ...relevant.slice(0, 3).map((i) => `${i.block}: ${i.symptom} → ${i.remedy}`),
      ...run.platform.memory
        .search({ query: problem, agentId: run.agent.id, scopes: ["agent", "global"], kinds: ["procedural"], limit: 4 })
        .filter((x) => !x.content.startsWith("optimization insight"))
        .slice(0, 2)
        .map((x) => oneLine(x.content, 160)),
    ];
    span.setAttributes({ "agentco.cost_factor": costFactor, "agentco.cost_samples": ratios.length, "agentco.insights": insights.length, "agentco.favour_cheap": favourCheap });
    return { costFactor, costSamples: ratios.length, insights, favourCheap, lessons };
  });
}

// ── Economic Concepts (pure + block)

export interface EconomicInput {
  candidates: CandidateSolution[];
  costFactor: number;
  visionMultiplier: number;
  aligned: boolean;
  confidence: number;
  conservation: boolean;
  /** Constraint pressure or a profiling insight: avoid High Cost (founder, Q2). */
  pressure: boolean;
  /** Candidates already tried and rolled back. */
  rejected: CandidateName[];
}

export interface EconomicRow {
  name: CandidateName;
  estCostUsd: number;
  valueUsd: number;
  margin: number;
  eligible: boolean;
}

export interface EconomicChoice {
  chosen: CandidateName;
  rows: EconomicRow[];
  reason: string;
}

/**
 * margin = confidence · expectedValue · visionMultiplier(if aligned) · $/point − corrected cost.
 * Conservation: cheapest eligible candidate that meets the criteria. Pressure: no High Cost.
 */
export function chooseCandidate(i: EconomicInput): EconomicChoice {
  const vm = i.aligned ? i.visionMultiplier : 1;
  const rows: EconomicRow[] = i.candidates.map((c) => {
    const estCostUsd = round(c.estCostUsd * i.costFactor, 6);
    const valueUsd = round(c.expectedValue * vm * VALUE_USD_PER_POINT * i.confidence, 6);
    const eligible = !i.rejected.includes(c.name) && !(i.pressure && Q6_PRESSURE_EXCLUDES.includes(c.name));
    return { name: c.name, estCostUsd, valueUsd, margin: round(valueUsd - estCostUsd, 6), eligible };
  });
  let pool = rows.filter((r) => r.eligible);
  if (pool.length === 0) pool = rows.filter((r) => !i.rejected.includes(r.name));
  if (pool.length === 0) pool = rows;
  if (i.conservation) {
    const meets = pool.filter((r) => i.candidates.find((c) => c.name === r.name)?.meetsCriteria);
    const cheapest = [...(meets.length ? meets : pool)].sort((a, b) => a.estCostUsd - b.estCostUsd)[0]!;
    return { chosen: cheapest.name, rows, reason: "conservation mode: cheapest candidate that meets the criteria" };
  }
  const best = [...pool].sort((a, b) => b.margin - a.margin || a.estCostUsd - b.estCostUsd)[0]!;
  return { chosen: best.name, rows, reason: `highest risk-adjusted margin${i.pressure ? " (High Cost excluded under pressure)" : ""}` };
}

export async function economicConcepts(run: BrainRun, input: EconomicInput): Promise<EconomicChoice> {
  return block(run, "metacognition.project_management.economic_concepts", "Choosing the candidate with the best margin", (span) => {
    const choice = chooseCandidate(input);
    span.setAttributes({
      "agentco.chosen": choice.chosen,
      "agentco.conservation": input.conservation,
      "agentco.pressure": input.pressure,
      "agentco.margins": choice.rows.map((r) => `${r.name}:${r.margin}${r.eligible ? "" : "(x)"}`).join(" "),
    });
    return choice;
  });
}

export function nextCandidate(current: CandidateName, rejected: CandidateName[]): CandidateName | null {
  const order: CandidateName[] = ["low_cost", "low_effort", "high_cost"];
  return order.find((n) => n !== current && !rejected.includes(n)) ?? null;
}

// ── Rollback / Failure Recovery (no model)

export interface RecoveryInspection {
  open: Task[];
  finished: Task[];
  /** Titles already delegated (never duplicate). */
  existingTitles: string[];
}

export function inspectSubtasks(children: Task[]): RecoveryInspection {
  const open = children.filter((c) => !["done", "failed", "cancelled"].includes(c.status));
  const finished = children.filter((c) => ["done", "failed", "cancelled"].includes(c.status));
  return { open, finished, existingTitles: children.map((c) => c.title.trim().toLowerCase()) };
}

/**
 * Establish the real state of the subtasks before acting. With `cancelOpen` (a rollback of the
 * rejected candidate) the still-open subtasks are cancelled through platform.tasks.cancel
 * first, so the re-plan neither duplicates them nor leaves them burning budget.
 */
export async function rollbackRecovery(run: BrainRun, reason: string, options: { cancelOpen?: boolean } = {}): Promise<RecoveryInspection> {
  return block(run, "metacognition.project_management.rollback_failure_recovery", "Establishing the real state before acting", (span) => {
    let children = run.task ? run.platform.tasks.children(run.task.id) : [];
    let cancelled = 0;
    if (options.cancelOpen) {
      for (const c of inspectSubtasks(children).open) {
        run.platform.tasks.cancel(c.id, `Superseded: ${truncate(reason, 160)}`);
        cancelled++;
      }
      if (cancelled > 0 && run.task) children = run.platform.tasks.children(run.task.id);
    }
    const r = inspectSubtasks(children);
    span.setAttributes({ "agentco.recovery.cancelled": cancelled });
    span.setAttributes({ "agentco.recovery.reason": truncate(reason, 200), "agentco.recovery.open": r.open.length, "agentco.recovery.finished": r.finished.length });
    return r;
  });
}

// ── Reflection / Replanning (economy)

export async function reflectionReplanning(run: BrainRun, issues: string[], summary: string): Promise<string[]> {
  return block(run, "metacognition.project_management.reflection_replanning", "Reflecting on the feedback and replanning", async (span) => {
    const json = await llmJson(run, {
      stage: "metacognition.project_management.reflection_replanning",
      span,
      instructions: `The result was not accepted. Issues: ${issues.join("; ") || "unspecified"}. Result summary: ${truncate(summary, 500)}. Diagnose why and list the concrete changes for the next plan.`,
      shape: '{"diagnosis": string, "changes": string[]}',
      context: { mode: "task", task: run.task ? { title: run.task.title } : undefined, feedback: issues },
      maxOutputTokens: 650,
    });
    const changes = strArr(json.changes, 5, 200);
    const diagnosis = str(json.diagnosis, "", 300);
    return [...issues, ...(diagnosis ? [diagnosis] : []), ...changes].slice(0, 8);
  });
}

// ── Online Learning / Evolving (economy)

export interface Learning {
  lesson: string | null;
  conceptual: string | null;
  generalizes: boolean;
  insightsStored: number;
}

export async function onlineLearning(run: BrainRun, o: { outcome: "completed" | "failed" | "blocked"; summary: string; resultCount: number }): Promise<Learning> {
  return block(run, "metacognition.project_management.online_learning", "Learning from the outcome", async (span) => {
    let lesson: string | null = null;
    let conceptual: string | null = null;
    let generalizes = false;
    if (o.outcome === "completed" && !run.drives.essentialOnly) {
      const json = await llmJson(run, {
        stage: "metacognition.project_management.online_learning",
        span,
        instructions: `Outcome: ${o.outcome}. ${truncate(o.summary, 500)}\nWrite ONE reusable procedural lesson (how to do this kind of work better), optionally one durable conceptual insight about the company/market/product, and whether the lesson generalises beyond you.`,
        shape: '{"lesson": string, "conceptual": string|null, "generalizes": boolean}',
        context: { mode: "task", task: run.task ? { title: run.task.title } : undefined, outcome: o.outcome, results: new Array(o.resultCount).fill({}) },
        maxOutputTokens: 500,
      });
      lesson = str(json.lesson, "", 400) || null;
      conceptual = typeof json.conceptual === "string" && json.conceptual.trim() ? truncate(json.conceptual.trim(), 400) : null;
      generalizes = bool(json.generalizes, false);
      if (lesson) {
        try {
          run.platform.memory.write({
            scope: "agent",
            agentId: run.agent.id,
            kind: "procedural",
            content: lesson,
            tags: ["lesson"],
            importance: 0.6,
            sourceRunId: run.ctx.run.id,
            sourceTaskId: run.task?.id ?? null,
          });
        } catch {
          /* best-effort */
        }
      }
    }
    // Optimization insights from OOD Monitoring (profile → plan → apply → keep what worked).
    let stored = 0;
    const known = new Set(
      run.platform.memory
        .search({ query: "optimization insight", agentId: run.agent.id, scopes: ["agent"], kinds: ["procedural"], limit: Q2_OOD.insightsKept })
        .map((m) => m.content),
    );
    for (const insight of run.insights) {
      if (stored >= Q2_OOD.maxInsightsPerRun) break;
      const content = insightContent(insight);
      if (known.has(content)) continue;
      try {
        run.platform.memory.write({
          scope: "agent",
          agentId: run.agent.id,
          kind: "procedural",
          content,
          tags: [Q2_OOD.insightTag, insight.block],
          importance: 0.5,
          sourceRunId: run.ctx.run.id,
          sourceTaskId: run.task?.id ?? null,
        });
        stored++;
      } catch {
        /* best-effort */
      }
    }
    span.setAttributes({ "agentco.lesson": !!lesson, "agentco.insights_stored": stored });
    return { lesson, conceptual, generalizes, insightsStored: stored };
  });
}

export { CANDIDATE_NAMES };
