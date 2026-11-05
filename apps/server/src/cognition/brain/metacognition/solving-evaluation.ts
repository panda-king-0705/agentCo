/**
 * Metacognition › Solving and Evaluation: Solving → Solution → Feedback (← Memory).
 *
 * Solving: delegated subprocesses (delegate_task, one delegation span each,
 * never duplicating an existing subtask) → outcome waiting; else a bounded
 * tool loop (≤ 6 steps) with recalled memory in context → solution.
 * An escalate / ask_human call in that loop ends Solving → kind "escalated"
 * (the engine waits for the answer instead of carrying on without it).
 * Feedback: evaluate against the success criteria and the three Monitoring
 * gates (truthful / efficient / good) → accept | revise | rollback | escalate,
 * or fail once nothing is left to try (no revision, rollback or escalation).
 */
import type { ModelTier, Task } from "../../../../../../packages/shared/src/index.ts";
import type { ToolEffect } from "../../../contracts.ts";
import { oneOf, str, strArr, unit } from "../../coerce.ts";
import { oneLine, truncate } from "../../text.ts";
import { ESCALATION_TOOLS, runToolLoop } from "../../tool-loop.ts";
import { canEscalate } from "../escalation.ts";
import { Q4_CONTROL, Q6_EXECUTION, q6SubprocessCount, type CandidateName } from "../interpretation.ts";
import { block, llmJson, recordCall, toolContext, type BrainRun } from "../runtime.ts";
import type { Subprocess } from "./cognitive-control.ts";
import { truthfulEfficientGood, type TegResult } from "./monitoring.ts";

const TIERS: ModelTier[] = ["economy", "standard", "frontier"];

export function shiftTier(tier: ModelTier, shift: -1 | 0 | 1): ModelTier {
  const i = TIERS.indexOf(tier);
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, i + shift))]!;
}

export interface Solution {
  kind: "waiting" | "solution" | "failed" | "escalated";
  text: string;
  delegated: Subprocess[];
  effects: ToolEffect[];
  /** kind "escalated": the escalation subtask (manager) or approval (Board) the loop opened. */
  escalation?: { subtaskId: string | null; approvalId: string | null; reason: string };
}

/** Answers from the manager / the Board this run carries in local working memory. */
export function guidanceLines(run: BrainRun): string[] {
  const lines: string[] = [];
  const esc = run.wm.escalationAnswer;
  if (typeof esc === "string" && esc.trim()) lines.push(`Answer from your manager: ${truncate(esc, 600)}`);
  const board = run.wm.boardAnswer as { status?: unknown; note?: unknown } | undefined;
  if (board && typeof board === "object") lines.push(`Answer from the Board (${String(board.status ?? "decided")}): ${truncate(typeof board.note === "string" && board.note ? board.note : "(no note)", 600)}`);
  return lines;
}

function normTitle(t: string): string {
  return t.trim().toLowerCase();
}

/** Block: Solving. */
export async function solving(
  run: BrainRun,
  plan: { mode: "direct" | "delegate"; subprocesses: Subprocess[]; candidate: CandidateName; problem: string; successCriteria: string[]; memory: string[]; existingTitles: string[] },
): Promise<Solution> {
  const task = run.task!;
  const exec = Q6_EXECUTION[plan.candidate];
  return block(
    run,
    "metacognition.solving_evaluation.solving",
    plan.mode === "delegate" ? `Delegating T-${task.number}` : `Working on T-${task.number}`,
    async (span) => {
      if (plan.mode === "delegate") {
        const count = q6SubprocessCount(plan.candidate, plan.subprocesses.length);
        const chosen = [...plan.subprocesses].sort((a, b) => b.value / Math.max(b.estCostUsd, 0.01) - a.value / Math.max(a.estCostUsd, 0.01)).slice(0, count);
        const existing = new Set(plan.existingTitles.map(normTitle));
        const delegated: Subprocess[] = [];
        const effects: ToolEffect[] = [];
        for (const sp of chosen) {
          if (!sp.assigneeId) continue;
          if (existing.has(normTitle(sp.title))) continue; // never duplicate a subtask
          const name = run.platform.org.getAgent(sp.assigneeId)?.name ?? sp.assigneeId;
          run.platform.agents.setActivity(run.agent.id, "acting", `Delegating "${truncate(sp.title, 50)}" to ${name}`, "metacognition.solving_evaluation.solving");
          const r = await run.platform.tools.execute(
            {
              id: `delegate_${run.ctx.run.id}_${delegated.length}`,
              name: "delegate_task",
              arguments: { assigneeId: sp.assigneeId, title: sp.title, description: sp.description, acceptanceCriteria: sp.acceptanceCriteria, value: sp.value, estCostUsd: sp.estCostUsd },
            },
            toolContext(run, span),
          );
          effects.push(...r.effects);
          const created = r.effects.find((e): e is Extract<ToolEffect, { kind: "task_created" }> => e.kind === "task_created");
          if (r.ok && created) {
            sp.taskId = created.taskId;
            delegated.push(sp);
            existing.add(normTitle(sp.title));
          }
        }
        span.setAttributes({ "agentco.delegated": delegated.length, "agentco.candidate": plan.candidate });
        if (delegated.length > 0) return { kind: "waiting" as const, text: `Delegated ${delegated.length} subprocess(es).`, delegated, effects };
        // Nothing could be delegated: fall through to solving it directly.
      }
      const mayEscalate = canEscalate(run);
      const tools = run.platform.tools
        .specsFor(run.agent)
        .filter((t) => t.name !== "delegate_task" && t.name !== "hire_agent" && (mayEscalate || !ESCALATION_TOOLS.has(t.name)));
      const guidance = guidanceLines(run);
      const tier = shiftTier(run.platform.models.tierForStage("metacognition.solving_evaluation.solving", run.routingAgent), exec.tierShift);
      const steps = Math.min(run.drives.maxSolveSteps, exec.directSteps);
      const system = [
        `[[stage:metacognition.solving_evaluation.solving]]`,
        run.charter,
        `Solve: ${plan.problem}\nSuccess criteria: ${plan.successCriteria.join("; ")}\nApproach (${plan.candidate.replace("_", " ")}): ${exec.verify ? "be thorough and verify your claims" : "be efficient"}.`,
        plan.memory.length ? `What you know:\n${plan.memory.slice(0, 10).join("\n")}` : "",
        guidance.length ? `Guidance you asked for (follow it):\n${guidance.join("\n")}` : "",
        "Use your tools if useful (save substantial documents under shared/<your-department>/), then call complete_task with the full result.",
        `[[context:${JSON.stringify({
          mode: "task",
          agent: { name: run.agent.name, title: run.agent.title, department: run.facts.department, departmentSlug: run.facts.departmentSlug },
          task: { number: task.number, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria },
          tools: tools.map((t) => t.name),
        })}]]`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const loop = await runToolLoop({
        ctx: run.ctx,
        stage: "metacognition.solving_evaluation.solving",
        tier,
        parentSpan: span,
        system,
        user: "Begin.",
        tools,
        terminal: { complete: true, blocker: true },
        maxSteps: steps,
        taskId: task.id,
        conversationId: null,
        activityLabel: `Solving T-${task.number}`,
        block: "metacognition.solving_evaluation.solving",
        onResponse: (response, latencyMs) => recordCall(run, "metacognition.solving_evaluation.solving", response, latencyMs, null),
      });
      span.setAttributes({ "agentco.solve.steps": loop.steps, "agentco.solve.status": loop.status, "agentco.solve.tier": tier, "agentco.candidate": plan.candidate });
      if (loop.status === "completed") return { kind: "solution" as const, text: loop.result, delegated: [], effects: loop.effects };
      if (loop.status === "waiting" || (loop.status === "blocked" && loop.approvalId)) {
        return {
          kind: "escalated" as const,
          text: loop.reason,
          delegated: [],
          effects: loop.effects,
          escalation: { subtaskId: loop.escalationTaskId ?? null, approvalId: loop.approvalId ?? null, reason: loop.reason },
        };
      }
      return { kind: "failed" as const, text: loop.status === "blocked" ? `Blocked: ${loop.reason}` : `No result after ${loop.steps} steps`, delegated: [], effects: loop.effects };
    },
  );
}

// ── Feedback

/** The model may say accept | revise | rollback | escalate; the rule may also settle on fail. */
export type Decision = "accept" | "revise" | "rollback" | "escalate" | "fail";

export interface FeedbackResult {
  score: number;
  truthfulScore: number;
  issues: string[];
  modelDecision: Decision;
  decision: Decision;
  summary: string;
  teg: TegResult;
  acceptThreshold: number;
}

export function acceptThreshold(controlLevel: number, strictSelfEvaluation: boolean): number {
  return Math.round((0.55 + Q4_CONTROL.strictness * controlLevel + (strictSelfEvaluation ? 0.1 : 0)) * 1000) / 1000;
}

/** Pure decision rule over the model's verdict and the Monitoring gates. */
export function decide(o: {
  modelDecision: Decision;
  score: number;
  teg: TegResult;
  revisionsLeft: number;
  rollbackAvailable: boolean;
  canEscalate: boolean;
}): Decision {
  if (o.teg.truthful && o.teg.good) return "accept";
  if (o.modelDecision === "rollback" && o.rollbackAvailable) return "rollback";
  if (o.modelDecision === "escalate" && o.canEscalate) return "escalate";
  if (o.revisionsLeft > 0) return "revise";
  if (o.rollbackAvailable && o.score < 0.4) return "rollback";
  if (o.score >= 0.4) return "accept"; // accept partial once revisions are exhausted (issues are reported)
  // Nothing left to try: escalate if still allowed, else settle (a "revise" here would loop across wake-ups).
  return o.canEscalate ? "escalate" : "fail";
}

export function summarizeResults(subtasks: Task[]): { title: string; status: string; result: string | null }[] {
  return subtasks.map((s) => ({ title: s.title, status: s.status, result: s.result ?? s.error }));
}

export async function feedback(
  run: BrainRun,
  o: {
    problem: string;
    successCriteria: string[];
    solution: string | null;
    subtasks: Task[];
    controlLevel: number;
    estimateUsd: number;
    actualCostUsd: number;
    revisionsLeft: number;
    rollbackAvailable: boolean;
    canEscalate: boolean;
  },
): Promise<FeedbackResult> {
  return block(run, "metacognition.solving_evaluation.feedback", "Evaluating the result", async (span) => {
    const results = summarizeResults(o.subtasks);
    const json = await llmJson(run, {
      stage: "metacognition.solving_evaluation.feedback",
      span,
      instructions:
        `Problem: ${truncate(o.problem, 400)}\nSuccess criteria: ${o.successCriteria.join("; ")}\n` +
        (results.length
          ? `Subprocess results:\n${results.map((r) => `- [${r.status}] ${oneLine(r.title, 80)}: ${truncate((r.result ?? "").replace(/\s+/g, " "), 400)}`).join("\n")}\n`
          : `Solution:\n${truncate(o.solution ?? "(none)", 2500)}\n`) +
        "Evaluate: score 0-1 against the criteria; truthful 0-1 (claims supported by the results/sources); good (meets the criteria and our values); issues; decision accept | revise | rollback (the approach is wrong) | escalate; and a 2-4 sentence summary for the requester.",
      shape: '{"score":number,"truthful":number,"good":boolean,"issues":string[],"decision":"accept"|"revise"|"rollback"|"escalate","summary":string}',
      context: { mode: "task", task: { title: run.task?.title }, results, solution: o.solution ?? "" },
      maxOutputTokens: 500,
    });
    const nonEmpty = results.length ? results.some((r) => (r.result ?? "").trim()) : !!(o.solution ?? "").trim();
    const score = unit(json.score, nonEmpty ? 0.5 : 0.1);
    const truthfulScore = unit(json.truthful, score);
    const modelDecision: Decision = oneOf(json.decision, ["accept", "revise", "rollback", "escalate"] as const, score >= 0.6 ? "accept" : "revise");
    const threshold = acceptThreshold(o.controlLevel, run.drives.strictSelfEvaluation);
    const goodFromModel = typeof json.good === "boolean" ? json.good : modelDecision === "accept";
    const teg = await truthfulEfficientGood(run, {
      truthfulScore,
      truthfulGate: run.drives.truthfulGate,
      actualCostUsd: o.actualCostUsd,
      estimateUsd: o.estimateUsd,
      goodFromModel: goodFromModel && nonEmpty,
      score,
      acceptThreshold: threshold,
    });
    const issues = strArr(json.issues, 6, 240);
    if (!teg.efficient) issues.push(`cost $${o.actualCostUsd.toFixed(4)} exceeded 1.5× the estimate $${o.estimateUsd.toFixed(4)}`);
    const decision = decide({ modelDecision, score, teg, revisionsLeft: o.revisionsLeft, rollbackAvailable: o.rollbackAvailable, canEscalate: o.canEscalate });
    const summary = str(json.summary, results.length ? `${results.filter((r) => r.status === "done").length}/${results.length} parts delivered.` : truncate(o.solution ?? "", 300), 1200);
    span.setAttributes({ "agentco.score": score, "agentco.decision": decision, "agentco.decision.model": modelDecision, "agentco.accept_threshold": threshold });
    return { score, truthfulScore, issues, modelDecision, decision, summary, teg, acceptThreshold: threshold };
  });
}

/** The integrated deliverable a manager reports upward after accepting its subprocesses. */
export function integrateResults(title: string, summary: string, subtasks: Task[], agentName: string): string {
  const parts = subtasks
    .filter((s) => s.status === "done" && s.result)
    .map((s) => `### ${s.title}\n${truncate(s.result!.trim(), 1600)}`);
  const missing = subtasks.filter((s) => s.status !== "done").map((s) => `- ${s.title}: ${s.status}${s.error ? ` (${oneLine(s.error, 120)})` : ""}`);
  return [
    `# ${title}`,
    `${summary}`,
    parts.length ? `## Contributions\n${parts.join("\n\n")}` : "",
    missing.length ? `## Not delivered\n${missing.join("\n")}` : "",
    `— ${agentName}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

