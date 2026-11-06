/**
 * Metacognition › Cognitive Control (∝ from Confidence) → Decomposition and
 * Candidate Solutions (Solution 1 High Cost, Solution 2 Low Cost, Solution 3
 * Low Effort). One agent-tier model call proposes both; Role Arrangement
 * assigns each subprocess. Control level c = clamp(α·uncertainty) (Q4), raised
 * by OOD constraint pressure (finer decomposition, Q2).
 */
import type { Agent } from "../../../../../../packages/shared/src/index.ts";
import { arr, bool, num, obj, oneOf, str } from "../../coerce.ts";
import { oneLine, truncate } from "../../text.ts";
import { Q2_OOD, Q4_CONTROL, Q6_CANDIDATES, q4ControlLevel, type CandidateName } from "../interpretation.ts";
import { block, llmJson, type BrainRun } from "../runtime.ts";
import { candidatePool, namedCandidates, scoreCandidates, type Candidate } from "../self-management/role-arrangement.ts";
import type { Competence } from "./self-ability.ts";
import type { ProblemDefinition, Understanding } from "./target-understanding.ts";

export interface Subprocess {
  title: string;
  description: string;
  value: number;
  estCostUsd: number;
  acceptanceCriteria: string;
  suggestedAssigneeId: string | null;
  assigneeId: string | null;
  fit: number | null;
  taskId: string | null;
}

export interface CandidateSolution {
  name: CandidateName;
  label: string;
  approach: string;
  estCostUsd: number;
  expectedValue: number;
  meetsCriteria: boolean;
}

export interface ControlOutput {
  controlLevel: number;
  maxSubprocesses: number;
  mode: "direct" | "delegate";
  subprocesses: Subprocess[];
  candidates: CandidateSolution[];
  rationale: string;
}

/** c = clamp(α·uncertainty) + pressure boost (each constraint-pressure signal decomposes finer). */
export function controlLevel(uncertainty: number, pressureSignals = 0): number {
  return Math.min(1, q4ControlLevel(uncertainty) + Q2_OOD.controlBoostPerSignal * Math.max(0, pressureSignals));
}

export function maxSubprocessesFor(c: number, essentialOnly: boolean): number {
  return essentialOnly ? 1 : 1 + Math.round(Q4_CONTROL.granularity * c);
}

export function coerceSubprocesses(json: Record<string, unknown>, max: number, fallbackValue: number): Subprocess[] {
  const out: Subprocess[] = [];
  for (const raw of arr(json.subprocesses ?? json.subtasks)) {
    const s = obj(raw);
    const title = str(s.title, "", 140);
    if (!title) continue;
    out.push({
      title: truncate(title, 140),
      description: str(s.description, title, 2000),
      value: num(s.value, fallbackValue, 0, 1000),
      estCostUsd: num(s.estCostUsd ?? s.cost, 0.05, 0.001, 50),
      acceptanceCriteria: str(s.acceptanceCriteria, `A concrete written deliverable for "${truncate(title, 80)}"`, 600),
      suggestedAssigneeId: typeof s.assigneeId === "string" && s.assigneeId ? s.assigneeId : null,
      assigneeId: null,
      fit: null,
      taskId: null,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** Always the diagram's three candidates, in order, with defaults scaled from the task. */
export function coerceCandidates(json: Record<string, unknown>, taskValue: number, taskCost: number): CandidateSolution[] {
  const given = arr(json.candidates).map(obj);
  const scale: Record<CandidateName, { cost: number; value: number }> = {
    high_cost: { cost: 2, value: 1 },
    low_cost: { cost: 1, value: 0.8 },
    low_effort: { cost: 0.3, value: 0.5 },
  };
  return Q6_CANDIDATES.map((c, i) => {
    const match = given.find((g) => oneOf(g.name, [c.name] as const, "x" as never) === c.name) ?? given[i] ?? {};
    const d = scale[c.name];
    return {
      name: c.name,
      label: c.label,
      approach: str(match.approach, c.approach, 400),
      estCostUsd: num(match.estCostUsd ?? match.cost, Math.max(0.005, taskCost * d.cost), 0.001, 100),
      expectedValue: num(match.expectedValue ?? match.value, taskValue * d.value, 0, 1000),
      meetsCriteria: bool(match.meetsCriteria, true),
    };
  });
}

function reportView(run: BrainRun, a: Agent): { id: string; title: string; mandate: string; department: string } {
  return { id: a.id, title: a.title, mandate: truncate(a.identity.mission, 160), department: run.platform.org.departmentName(a.departmentId) };
}

export interface DecomposeArgs {
  problem: ProblemDefinition;
  understanding: Understanding;
  competence: Competence;
  uncertainty: number;
  calibrated: number;
  feedback: string[];
  preferDelegation: boolean;
  pressureSignals: number;
  /** Data-driven Analysis: optimization insights + past-cost notes for the prompt. */
  lessons: string[];
}

/** Blocks: decomposition (+ role arrangement) and candidate solutions, from one agent-tier call. */
export async function cognitiveControl(run: BrainRun, a: DecomposeArgs): Promise<ControlOutput> {
  const c = controlLevel(a.uncertainty, a.pressureSignals);
  const max = maxSubprocessesFor(c, run.drives.essentialOnly);
  const reports = run.platform.org.directReports(run.agent.id).filter((r) => r.status !== "terminated" && r.status !== "paused");
  const canDelegate = reports.length > 0 && run.platform.tools.specsFor(run.agent).some((t) => t.name === "delegate_task");
  const task = run.task!;

  const decomposition = await block(
    run,
    "metacognition.cognitive_control.decomposition",
    `Decomposing T-${task.number} (control ${c.toFixed(2)}, ≤${max} parts)`,
    async (span) => {
      const json = await llmJson(run, {
        stage: "metacognition.cognitive_control",
        span,
        instructions:
          `Problem: ${a.problem.problem}\nSuccess criteria: ${a.problem.successCriteria.join("; ")}\nUnderstanding: ${truncate(a.understanding.summary, 400)}\n` +
          (canDelegate
            ? `Your direct reports:\n${reports.map((r) => `- ${r.id}: ${r.title} — ${oneLine(r.identity.mission, 120)}`).join("\n")}\n` +
              `Decompose into at most ${max} subprocesses, each for ONE report (assigneeId), with value 0-1000, estCostUsd and acceptanceCriteria; mode "delegate". ` +
              "If the request names a department or person (\"have Finance…\", \"ask the CTO…\"), assign that part to them. " +
              "Work that spans several departments' expertise (e.g. marketing + pricing + engineering) is delegated: one part per owning report — do not write other departments' parts yourself; reports run on cheaper models, so delegating is usually cheaper than doing it all yourself. " +
              (a.preferDelegation ? "Prefer delegating: your own competence is limited here. " : "") +
              `Use mode "direct" (no subprocesses) when you can do it yourself quickly with your own tools — e.g. recording a fact, a short note or decision, a lookup — never split such a task across reports.\n` +
              (task.state.kind === "escalation" ? 'This is a report\'s escalation: answer it yourself (mode "direct") with a decision or guidance unless the fix needs another report\'s work.\n' : "")
            : `You have no one to delegate to: mode "direct", subprocesses are your own steps (at most ${max}).\n`) +
          (a.feedback.length ? `Address this feedback: ${a.feedback.join("; ")}\n` : "") +
          (a.lessons.length ? `From past runs:\n${a.lessons.slice(0, 5).map((l) => `- ${l}`).join("\n")}\n` : "") +
          "Also give exactly three candidate solutions: high_cost (thorough: higher tier, more steps, extra verification), low_cost (same scope, cheaper tiers, fewer steps), low_effort (smallest change that meets the criteria: reuse memory, existing files and subtask results); each {approach, estCostUsd, expectedValue 0-1000, meetsCriteria}.",
        shape:
          '{"mode":"delegate"|"direct","subprocesses":[{"title":string,"description":string,"assigneeId":string,"value":number,"estCostUsd":number,"acceptanceCriteria":string}],"candidates":[{"name":"high_cost"|"low_cost"|"low_effort","approach":string,"estCostUsd":number,"expectedValue":number,"meetsCriteria":boolean}],"rationale":string}',
        context: {
          mode: "task",
          task: { number: task.number, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria },
          reports: canDelegate ? reports.map((r) => reportView(run, r)) : [],
          maxSubprocesses: max,
          feedback: a.feedback,
        },
        // Room for the whole plan: a cut-off reply lost every subprocess (json.ts now returns null for it).
        maxOutputTokens: 900 + 300 * max,
      });
      const subprocesses = coerceSubprocesses(json, max, Math.max(50, Math.round(task.value / Math.max(1, max))));
      let mode = oneOf(json.mode, ["delegate", "direct"] as const, subprocesses.length > 0 && canDelegate ? "delegate" : "direct");
      if (!canDelegate || subprocesses.length === 0) mode = "direct";
      if (mode === "delegate") await arrangeRoles(run, subprocesses, reports);
      const assigned = subprocesses.filter((s) => s.assigneeId);
      if (mode === "delegate" && assigned.length === 0) mode = "direct";
      span.setAttributes({ "agentco.control_level": c, "agentco.decomposition.mode": mode, "agentco.decomposition.count": subprocesses.length });
      return { json, subprocesses: mode === "delegate" ? assigned : subprocesses, mode, rationale: str(json.rationale, "", 400) };
    },
    { attributes: { "agentco.control_level": c, "agentco.uncertainty": a.uncertainty } },
  );

  const candidates = await block(run, "metacognition.cognitive_control.candidate_solutions", "Weighing candidate solutions", (span) => {
    const list = coerceCandidates(decomposition.json, task.value, task.estCostUsd);
    span.setAttributes({ "agentco.candidates": list.map((x) => `${x.name}:$${x.estCostUsd}/${x.expectedValue}`).join(" ") });
    return list;
  });

  return { controlLevel: c, maxSubprocesses: max, mode: decomposition.mode, subprocesses: decomposition.subprocesses, candidates, rationale: decomposition.rationale };
}

/** Block: Role Arrangement assigns each subprocess ("Assign Suitable Role to Workers"). */
export async function arrangeRoles(run: BrainRun, subprocesses: Subprocess[], reports: Agent[]): Promise<void> {
  await block(run, "self_management.role_arrangement", `Assigning ${subprocesses.length} subprocess(es) to the best-fit roles`, (span) => {
    const pool = candidatePool(run.agent, reports, run.platform.org.listActiveAgents(), subprocesses.map((s) => s.suggestedAssigneeId ?? "").filter(Boolean));
    const candidates: Candidate[] = pool.map((agent) => ({
      agent,
      departmentName: run.platform.org.departmentName(agent.departmentId),
      catalogProfile: run.platform.catalog?.profileFor(agent) ?? null,
    }));
    const used = new Map<string, number>();
    // A department/role named in the request (the Board's words) routes a subprocess that names none itself.
    const task = run.task;
    const namedInRequest = task ? namedCandidates(`${task.title} ${task.description}`, candidates) : new Set<string>();
    for (const s of subprocesses) {
      if (candidates.length === 0) break;
      // The part's TITLE says whose it is ("Engineering scope…"); descriptions mention other departments in passing.
      const own = namedCandidates(s.title, candidates);
      const namedIds = own.size ? own : namedInRequest.size === 1 ? namedInRequest : undefined;
      const scores = scoreCandidates(`${s.title} ${s.description}`, candidates, { suggestedId: s.suggestedAssigneeId, usedCounts: used, fallbackDepartment: run.facts.department, ...(namedIds ? { namedIds } : {}) });
      const best = scores[0]!;
      s.assigneeId = best.agentId;
      s.fit = best.fit;
      used.set(best.agentId, (used.get(best.agentId) ?? 0) + 1);
    }
    span.setAttributes({
      "agentco.role_arrangement": subprocesses.map((s) => `${truncate(s.title, 30)}→${s.assigneeId}(${s.fit})`).join("; "),
      "agentco.role_arrangement.overrode_llm": subprocesses.filter((s) => s.suggestedAssigneeId && s.suggestedAssigneeId !== s.assigneeId).length,
      "agentco.role_arrangement.named": [...namedInRequest].join(","),
    });
  });
}
