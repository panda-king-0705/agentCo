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
  /**
   * 1 = handed out now; 2 = needs the round-1 parts' output (assembling, reconciling, reviewing):
   * handed out only after every round-1 part is done, with their results in its brief.
   */
  round?: 1 | 2;
  /** The assignee is an owner the request names (never trimmed by the candidate's subprocess share). */
  named?: boolean;
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

export function maxSubprocessesFor(c: number, essentialOnly: boolean, namedOwners = 0): number {
  const base = essentialOnly ? 1 : 1 + Math.round(Q4_CONTROL.granularity * c);
  const named = namedOwners > 0 ? namedOwners + (namedOwners >= 2 ? Q4_CONTROL.namedRound2Slack : 0) : 0;
  return Math.max(base, Math.min(Q4_CONTROL.maxParts, named));
}

/** A step that works on the other parts' output: assemble/merge/reconcile/review … the sections/drafts/inputs. */
const DEPENDENT_VERB = /\b(assembl\w*|compil\w*|merg\w*|integrat\w*|consolidat\w*|reconcil\w*|review\w*|stitch\w*|collat\w*|combin\w*|proofread\w*|sign[- ]?off|final (edit|check|qa|pass))\b/i;
const DEPENDENT_OBJECT = /\b(sections?|parts?|drafts?|inputs?|outputs?|deliverables?|contributions?|results|one[- ]pager?|one[- ]page|final (plan|document|doc|page|version))\b/i;

export function isDependentStep(title: string, description: string): boolean {
  return DEPENDENT_VERB.test(title) && DEPENDENT_OBJECT.test(`${title} ${description}`);
}

/** Round 2 only makes sense with round-1 work to wait for: a plan that is all round 2 runs as one round. */
export function settleRounds(subprocesses: Subprocess[]): Subprocess[] {
  if (subprocesses.length < 2 || subprocesses.every((s) => s.round === 2)) for (const s of subprocesses) s.round = 1;
  return subprocesses;
}

export function coerceSubprocesses(json: Record<string, unknown>, max: number, fallbackValue: number): Subprocess[] {
  const out: Subprocess[] = [];
  for (const raw of arr(json.subprocesses ?? json.subtasks)) {
    const s = obj(raw);
    const title = str(s.title, "", 140);
    if (!title) continue;
    const description = str(s.description, title, 2000);
    const given = Number(s.round);
    out.push({
      round: given === 2 ? 2 : given === 1 ? 1 : isDependentStep(title, description) ? 2 : 1,
      named: false,
      title: truncate(title, 140),
      description,
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
  return settleRounds(out);
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
  const reports = run.platform.org.directReports(run.agent.id).filter((r) => r.status !== "terminated" && r.status !== "paused");
  const canDelegate = reports.length > 0 && run.platform.tools.specsFor(run.agent).some((t) => t.name === "delegate_task");
  const task = run.task!;
  // Owners the request names (the Board's split) each get a part: the cap never merges them away.
  // A revision after parts were delivered fixes what the feedback names — it does not redo them
  // (2026-11-07, test 4: a "read it back and count the words" verdict re-delegated all four parts, $1.90).
  const delivered = a.feedback.length > 0 ? deliveredParts(run, task.id) : [];
  // Owners the request names each get a part on the first plan; a fix round only goes to whoever a fix concerns.
  const named = canDelegate && task.state.kind !== "escalation" && delivered.length === 0 ? namedReports(run, reports, `${task.title} ${task.description}`) : [];
  const max = maxSubprocessesFor(c, run.drives.essentialOnly, named.length);

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
              "Write acceptance criteria about content — what must be covered, correct and consistent — not formatting (exact heading counts, tag placement, layout). Keep them checkable with the assignee's tools: the file tools confirm every save and report word, line and character counts, and the reviewer sees the saved files themselves, so never ask for a read-back, a pasted copy or a separate word count. " +
              "If the request names a department or person (\"have Finance…\", \"ask the CTO…\"), assign that part to them. " +
              (named.length
                ? `The request names these owners — give each of them their own part (at least one part each): ${named.map((r) => `${r.id} (${r.title})`).join(", ")}. `
                : "") +
              'Parts that need other parts\' output — assembling, merging, reconciling, reviewing, final QA — are round 2 ("round":2): they are handed out only after every round-1 part is done, and their owner gets those results. You may instead do the assembly yourself: you are resumed with every part\'s result when they finish. ' +
              "Work that spans several departments' expertise (e.g. marketing + pricing + engineering) is delegated: one part per owning report — do not write other departments' parts yourself; reports run on cheaper models, so delegating is usually cheaper than doing it all yourself. " +
              (a.preferDelegation ? "Prefer delegating: your own competence is limited here. " : "") +
              `Use mode "direct" (no subprocesses) when you can do it yourself quickly with your own tools — e.g. recording a fact, a short note or decision, a lookup — never split such a task across reports.\n` +
              (task.state.kind === "escalation" ? 'This is a report\'s escalation: answer it yourself (mode "direct") with a decision or guidance unless the fix needs another report\'s work.\n' : "")
            : `You have no one to delegate to: mode "direct", subprocesses are your own steps (at most ${max}).\n`) +
          (a.feedback.length ? `Address this feedback: ${a.feedback.join("; ")}\n` : "") +
          (delivered.length
            ? `Already delivered — keep these, do NOT redo them:\n${delivered.join("\n")}\n` +
              'Fix only what the feedback names, with as few parts as possible: send a fix only to the owner whose part it concerns (title it "Fix: …" and say exactly what to change), and do small fixes yourself (mode "direct"): an edit to the assembled page, a count, a note of open points. Points that only the Board can decide are not fixes — list them in your result.\n'
            : "") +
          (a.lessons.length ? `From past runs:\n${a.lessons.slice(0, 5).map((l) => `- ${l}`).join("\n")}\n` : "") +
          "Also give exactly three candidate solutions: high_cost (thorough: higher tier, more steps, extra verification), low_cost (same scope, cheaper tiers, fewer steps), low_effort (smallest change that meets the criteria: reuse memory, existing files and subtask results); each {approach, estCostUsd, expectedValue 0-1000, meetsCriteria}.",
        shape:
          '{"mode":"delegate"|"direct","subprocesses":[{"title":string,"description":string,"assigneeId":string,"round":1|2,"value":number,"estCostUsd":number,"acceptanceCriteria":string}],"candidates":[{"name":"high_cost"|"low_cost"|"low_effort","approach":string,"estCostUsd":number,"expectedValue":number,"meetsCriteria":boolean}],"rationale":string}',
        context: {
          mode: "task",
          task: { number: task.number, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria },
          reports: canDelegate ? reports.map((r) => reportView(run, r)) : [],
          maxSubprocesses: max,
          ...(named.length ? { namedOwners: named.map((r) => r.id) } : {}),
          feedback: a.feedback,
        },
        // Room for the whole plan: a cut-off reply lost every subprocess (json.ts now returns null for it).
        maxOutputTokens: 1200 + 350 * max,
      });
      const subprocesses = coerceSubprocesses(json, max, Math.max(50, Math.round(task.value / Math.max(1, max))));
      let mode = oneOf(json.mode, ["delegate", "direct"] as const, subprocesses.length > 0 && canDelegate ? "delegate" : "direct");
      if (!canDelegate || subprocesses.length === 0) mode = "direct";
      if (mode === "delegate") await arrangeRoles(run, subprocesses, reports);
      const assigned = subprocesses.filter((s) => s.assigneeId);
      if (mode === "delegate" && assigned.length === 0) mode = "direct";
      span.setAttributes({
        "agentco.control_level": c,
        "agentco.decomposition.mode": mode,
        "agentco.decomposition.count": subprocesses.length,
        "agentco.decomposition.round2": subprocesses.filter((s) => s.round === 2).length,
        ...(named.length ? { "agentco.decomposition.named_owners": named.map((r) => r.id).join(",") } : {}),
      });
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

/** Parts of this task already done by someone (escalations excluded), one line each for the re-plan. */
export function deliveredParts(run: BrainRun, taskId: string): string[] {
  return run.platform.tasks
    .children(taskId)
    .filter((c) => c.status === "done" && c.state.kind !== "escalation")
    .slice(-8)
    .map((c) => `- T-${c.number} "${truncate(c.title, 80)}" by ${run.platform.org.getAgent(c.assigneeId ?? "")?.name ?? "?"}: ${truncate(oneLine(c.result ?? "", 300), 300)}`);
}

/** The leader's direct reports whose department, role or name the request names. */
export function namedReports(run: BrainRun, reports: Agent[], text: string): Agent[] {
  const ownDepartment = run.platform.org.departmentName(run.agent.departmentId);
  const candidates: Candidate[] = reports.map((agent) => ({ agent, departmentName: run.platform.org.departmentName(agent.departmentId), catalogProfile: null }));
  const ids = namedCandidates(text, candidates, { ownDepartment });
  return reports.filter((r) => ids.has(r.id));
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
    const ownDepartment = run.platform.org.departmentName(run.agent.departmentId);
    const namedInRequest = task && task.state.kind !== "escalation" ? namedCandidates(`${task.title} ${task.description}`, candidates, { ownDepartment }) : new Set<string>();
    for (const s of subprocesses) {
      if (candidates.length === 0) break;
      // The part's TITLE says whose it is ("Engineering scope…"); descriptions mention other departments in passing.
      const own = namedCandidates(s.title, candidates, { ownDepartment });
      const namedIds = own.size ? own : namedInRequest.size === 1 ? namedInRequest : undefined;
      const scores = scoreCandidates(`${s.title} ${s.description}`, candidates, { suggestedId: s.suggestedAssigneeId, usedCounts: used, fallbackDepartment: run.facts.department, ...(namedIds ? { namedIds } : {}) });
      const best = scores[0]!;
      s.assigneeId = best.agentId;
      s.fit = best.fit;
      s.named = namedInRequest.has(best.agentId);
      used.set(best.agentId, (used.get(best.agentId) ?? 0) + 1);
    }
    span.setAttributes({
      "agentco.role_arrangement": subprocesses.map((s) => `${truncate(s.title, 30)}→${s.assigneeId}(${s.fit})`).join("; "),
      "agentco.role_arrangement.overrode_llm": subprocesses.filter((s) => s.suggestedAssigneeId && s.suggestedAssigneeId !== s.assigneeId).length,
      "agentco.role_arrangement.named": [...namedInRequest].join(","),
    });
  });
}
