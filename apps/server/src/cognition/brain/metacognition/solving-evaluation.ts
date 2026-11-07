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
import { limitsLine } from "../../../org/capabilities.ts";
import { EDIT_IN_PLACE_RULE, OUTSIDE_DOC_RULE, REPO_SAVED } from "../../../org/rules.ts";
import type { ModelTier, Task } from "../../../../../../packages/shared/src/index.ts";
import type { SpanHandle, ToolEffect } from "../../../contracts.ts";
import { oneOf, str, strArr, unit } from "../../coerce.ts";
import { oneLine, overlapRatio, truncate } from "../../text.ts";
import { contractList, validateContract, validationBrief, validationSection, type Assertion, type Validation } from "./validation.ts";
import { ESCALATION_TOOLS, runToolLoop } from "../../tool-loop.ts";
import { earlierWorkNote } from "../../prompt.ts";
import { canEscalate } from "../escalation.ts";
import { Q4_CONTROL, Q6_EXECUTION, q6SubprocessCount, type CandidateName } from "../interpretation.ts";
import { block, capabilities, llmJson, recordCall, toolContext, type BrainRun } from "../runtime.ts";
import type { Subprocess } from "./cognitive-control.ts";
import { truthfulEfficientGood, type TegResult } from "./monitoring.ts";
import { measure } from "../../../tools/builtins/files.ts";
import { describeHire, isHiringRequest, objectiveHires } from "../../../tools/builtins/hiring.ts";

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
  const inputs = run.wm.inputsReady;
  if (typeof inputs === "string" && inputs.trim()) lines.push(truncate(inputs, 2400));
  const board = run.wm.boardAnswer as { status?: unknown; note?: unknown; kind?: unknown; hired?: unknown } | undefined;
  if (board && typeof board === "object" && board.kind === "hire_agent") {
    const note = typeof board.note === "string" && board.note ? ` Note: ${truncate(board.note, 400)}` : "";
    lines.push(
      board.status === "approved"
        ? `The Board approved the hire: ${typeof board.hired === "string" && board.hired ? board.hired : "the new agent"} has joined. Do not hire again.${note}`
        : `The Board declined the hire. Do not hire; say so in your result.${note}`,
    );
  } else if (board && typeof board === "object") lines.push(`Answer from the Board (${String(board.status ?? "decided")}): ${truncate(typeof board.note === "string" && board.note ? board.note : "(no note)", 600)}`);
  return lines;
}

export function normTitle(t: string): string {
  return t.trim().toLowerCase();
}

/**
 * delegate_task for each part (one delegation span each), skipping parts without an assignee and
 * titles already delegated. Sets `taskId` on each delegated part.
 */
export async function delegateParts(run: BrainRun, span: SpanHandle, parts: Subprocess[], existingTitles: string[]): Promise<{ delegated: Subprocess[]; effects: ToolEffect[] }> {
  const existing = new Set(existingTitles.map(normTitle));
  const delegated: Subprocess[] = [];
  const effects: ToolEffect[] = [];
  for (const sp of parts) {
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
  return { delegated, effects };
}

export { isHiringRequest };

/** Open first tasks of agents this task hired (hire_agent firstTask). */
export function openFirstTasks(run: BrainRun): Task[] {
  const task = run.task;
  if (!task) return [];
  return run.platform.tasks.children(task.id).filter((c) => c.state.firstTask === true && !["done", "failed", "cancelled"].includes(c.status));
}

function firstTaskWait(open: Task[]): Solution {
  const delegated: Subprocess[] = open.map((c) => ({
    round: 1,
    named: false,
    title: c.title,
    description: c.description,
    value: c.value,
    estCostUsd: c.estCostUsd,
    acceptanceCriteria: c.acceptanceCriteria ?? "",
    suggestedAssigneeId: null,
    assigneeId: c.assigneeId,
    fit: null,
    taskId: c.id,
  }));
  return { kind: "waiting", text: `Waiting for the new hire's first task (${open.map((c) => `T-${c.number}`).join(", ")}).`, delegated, effects: [] };
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
        // Round 1 now; round-2 steps (assembly, review) wait for round 1's results (index.ts).
        const firstRound = plan.subprocesses.filter((s) => s.round !== 2);
        const pool = firstRound.length > 0 ? firstRound : plan.subprocesses;
        const named = pool.filter((s) => s.named);
        const others = pool.filter((s) => !s.named).sort((a, b) => b.value / Math.max(b.estCostUsd, 0.01) - a.value / Math.max(a.estCostUsd, 0.01));
        // The candidate's share trims optional parts, never a part for an owner the request names.
        const count = Math.max(q6SubprocessCount(plan.candidate, pool.length), named.length);
        const chosen = [...named, ...others].slice(0, count);
        const { delegated, effects } = await delegateParts(run, span, chosen, plan.existingTitles);
        span.setAttributes({ "agentco.delegated": delegated.length, "agentco.candidate": plan.candidate, "agentco.round2_pending": plan.subprocesses.filter((s) => s.round === 2 && !s.taskId).length });
        if (delegated.length > 0) return { kind: "waiting" as const, text: `Delegated ${delegated.length} subprocess(es).`, delegated, effects };
        // Nothing could be delegated: fall through to solving it directly.
      }
      // A new hire's first task (hire_agent firstTask) is still open: wait for it, as for a delegated
      // part (after the Board approves a hire, the first task already exists when this run starts).
      const waitingOn = openFirstTasks(run);
      if (waitingOn.length > 0) return firstTaskWait(waitingOn);
      const mayEscalate = canEscalate(run);
      // hire_agent only on a hiring task: the head of the receiving team makes the hire (founder,
      // 2026-11-07) — and only until the hire is made or requested (a resumed manager hired the same
      // specialist twice).
      const hires = objectiveHires(run.platform.tasks, run.platform.tasks.get(task.id) ?? task).filter((h) => h.status !== "declined");
      const hiring = isHiringRequest(`${task.title}\n${task.description}`) && hires.length === 0;
      const tools = run.platform.tools
        .specsFor(run.agent)
        .filter((t) => t.name !== "delegate_task" && (t.name !== "hire_agent" || hiring) && (mayEscalate || !ESCALATION_TOOLS.has(t.name)));
      const guidance = guidanceLines(run);
      const earlier = run.platform.taskWrites?.(task.id, run.ctx.run.id) ?? [];
      const tier = shiftTier(run.platform.models.tierForStage("metacognition.solving_evaluation.solving", run.routingAgent), exec.tierShift);
      const steps = Math.min(run.drives.maxSolveSteps, exec.directSteps);
      const system = [
        `[[stage:metacognition.solving_evaluation.solving]]`,
        run.charter,
        `Solve: ${plan.problem}\nSuccess criteria: ${plan.successCriteria.join("; ")}\nApproach (${plan.candidate.replace("_", " ")}): ${exec.verify ? "be thorough and verify your claims" : "be efficient"}.`,
        plan.memory.length ? `What you know:\n${plan.memory.slice(0, 10).join("\n")}` : "",
        guidance.length ? `Guidance you asked for (follow it):\n${guidance.join("\n")}` : "",
        earlier.length ? earlierWorkNote(earlier) : "",
        hires.length ? `Already done on this objective: ${hires.map(describeHire).join("; ")}. Do not hire again — work with them; they report to their manager.` : "",
        hiring
          ? "You are making a hire: call hire_agent with the recommended catalogId, monthlyBudgetUsd and firstTask (their first piece of work, with the exact file path). Give that work to the new hire as their first task — do not do it yourself first."
          : "",
        "Use your tools if useful, then call complete_task with the full result. Files you save go on the company drive where colleagues can read them — use the exact paths your brief names (private/… only for scratch notes); if a file you need is missing, workspace_read_file and workspace_list show what has been saved on this objective. The file tools confirm each save and report word, line and character counts: quote those counts, they are tool-verified. Whoever reviews your work sees the files you saved exactly as they are on disk: in your result, say what you saved and where — no need to read a file back or paste it. Save exactly at the path your brief names, even if a file is already there (it is replaced and the previous version kept). Never start a second copy of the same document under another name: to change a colleague's file, update that file. Credit work to whoever actually did it: never write a colleague's name on work they did not do (\"recommended by\", \"written by\", in files, messages or requests to the Board) — if a step meant for someone else ended up with you, say you did it. " + OUTSIDE_DOC_RULE + " " + EDIT_IN_PLACE_RULE + " " + limitsLine(capabilities(run).company, capabilities(run).mine, capabilities(run).services),
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
        wrapUp: true,
      });
      span.setAttributes({ "agentco.solve.steps": loop.steps, "agentco.solve.status": loop.status, "agentco.solve.tier": tier, "agentco.candidate": plan.candidate, "agentco.solve.wrapped_up": loop.wrappedUp === true });
      if (loop.status === "completed") {
        const hired = openFirstTasks(run);
        if (hired.length > 0) return { ...firstTaskWait(hired), effects: loop.effects };
        return { kind: "solution" as const, text: loop.result, delegated: [], effects: loop.effects };
      }
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
  /** Decisions or data only the Board (or someone outside the team) can supply — reported, never revised for. */
  openPoints: string[];
  modelDecision: Decision;
  decision: Decision;
  summary: string;
  teg: TegResult;
  acceptThreshold: number;
  /** Only when escalating: one question for the Board — what is done and where, then one decision with options. */
  boardQuestion: string;
  /** The independent check against the objective's contract (root only; null when there is none). */
  validation: Validation | null;
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
    /** The files the work saved, as they are on disk now (reviewFiles). */
    files?: ReviewFile[];
    /** Steps this company cannot do (org/capabilities.ts): the Board's, never a shortfall. */
    boardSteps?: string[];
    /** The objective's contract (validation.ts): checked independently first; only its unmet statements are sent back. */
    contract?: Assertion[];
  },
): Promise<FeedbackResult> {
  return block(run, "metacognition.solving_evaluation.feedback", "Evaluating the result", async (span) => {
    const results = summarizeResults(o.subtasks);
    // The drive's files, plus what was committed to repositories on this objective, read back now
    // (2026-11-08, trc_92d7…: a committed spec was judged missing because only the drive was visible).
    const outside = (await run.platform.outsideFiles?.(run.ctx.run.traceId, o.contract?.map((a) => a.text) ?? o.successCriteria).catch(() => [])) ?? [];
    if (outside.length) span.setAttributes({ "agentco.feedback.repo_files": outside.length });
    // The checker gets every file read back; the leader's own review a smaller share of them.
    const checkFiles = [...(o.files ?? []), ...outside];
    const files = [...(o.files ?? []), ...withinBudget(outside, 24_000)];
    // The platform's own hire records: the evidence for a hire (2026-11-07, trc_005b…: the hirer and
    // the CEO both reviewed a finished hire as "not evidenced" and the CEO re-did work to prove it).
    const hires = run.task ? objectiveHires(run.platform.tasks, run.platform.tasks.get(run.task.id) ?? run.task) : [];
    span.setAttributes({ "agentco.feedback.files": files.map((f) => f.display).join(", "), ...(hires.length ? { "agentco.feedback.hires": hires.length } : {}) });
    // The independent check comes first: the contract and the saved work only (validation.ts).
    const validation = o.contract?.length ? await validateContract(run, span, { contract: o.contract, files: checkFiles, solution: results.length ? null : o.solution, boardSteps: o.boardSteps ?? [] }) : null;
    const json = await llmJson(run, {
      stage: "metacognition.solving_evaluation.feedback",
      span,
      instructions:
        `Problem: ${truncate(o.problem, 400)}\nSuccess criteria: ${o.successCriteria.join("; ")}\n` +
        (validation
          ? `What "done" means was fixed before the work started (${contractList(o.contract!)}). An independent checker, who did not do the work, judged the saved work against it:\n${validationBrief(validation)}\n` +
            "Send work back (revise) only for statements the checker found UNMET, and name the statement in each issue (\"A2: …\"). Nothing outside these statements is a reason to revise — at most a note. Statements that need the Board go in openPoints.\n"
          : "") +
        // 2026-11-07 (test 6): "No email was sent" was the first shortfall a review reported — for a
        // company that cannot send email.
        (o.boardSteps?.length
          ? `Left to the Board — this company cannot do these, so they are never a shortfall (mention them in openPoints as the Board's step): ${o.boardSteps.join("; ")}\n`
          : "") +
        (results.length
          ? `Subprocess results:\n${results.map((r) => `- [${r.status}] ${oneLine(r.title, 80)}: ${truncate((r.result ?? "").replace(/\s+/g, " "), 400)}`).join("\n")}\n`
          : `Solution:\n${truncate(o.solution ?? "(none)", 2500)}\n`) +
        (files.length
          ? "Files as saved on disk — this IS the read-back: judge these files themselves, and never ask the author to read a file back, paste it or count its words again. " +
            (outside.length ? REPO_SAVED : "") +
            "\n" +
            files.map((f) => `=== ${f.display} — saved by ${f.by} (${f.words} words, ${f.lines} lines${f.truncated ? "; shown in part" : ""}) ===\n${f.content}`).join("\n") +
            "\n"
          : "") +
        (hires.length ? `Hires on this objective, from the platform's hire records (verified — no other proof is needed): ${hires.map(describeHire).join("; ")}.\n` : "") +
        "Evaluate: score 0-1 against the criteria; truthful 0-1 (claims supported by the results/sources); good (meets the criteria and our values); issues; decision accept | revise | rollback (the approach is wrong) | escalate; and a 2-4 sentence summary for the requester. " +
        // 2026-11-07 (test 4): a one-page plan was sent back twice for "modeled pricing" and an "open
        // caps-or-prices decision" — things only the Board can settle — and for a "tool word count"
        // no tool could give.
        "Judge only gaps this team can close with its tools. Decisions that belong to the Board (prices, budgets, go/no-go, trade-offs between options), data nobody has, and assumptions or estimates clearly labelled as such are NOT defects: list them in openPoints (and mention them in the summary), and do not revise, roll back or lower the score for them. A word, line or character count reported by a file tool, and a save the file tool confirmed, count as verified. " +
        // 2026-11-07 (test 4, third run): the Finance section went round three times over "three
        // headings, criteria say exactly two" and tag placement — $0.48 of a $1.03 run.
        "Judge substance — is it correct, complete, consistent and honest? — not formatting (exact heading counts, tag placement, wording, layout): a formatting slip is at most a note in issues, never on its own a reason to revise, unless the Board's original request demands that exact format. " +
        // 2026-11-07 (test 6): legal review went round four times over who signed, a dated
        // confirmation and "6,386 characters, but the file is 6,432".
        `Never count paperwork against the work: signatures or sign-offs, dated confirmations, who saved a file, or small differences in word or character counts (only a length limit the request itself set counts). ${limitsLine(capabilities(run).company)} ` +
        "openPoints are for the Board: each one a decision it must make or information only it can give, in one plain sentence — no task numbers, review codes or notes about file versions (those are issues for the team). " +
        "If you escalate, write boardQuestion: one question for the Board — first what is done and where it is saved, then the single decision you need, with two or three options (under 90 words).",
      shape: '{"score":number,"truthful":number,"good":boolean,"issues":string[],"openPoints":string[],"decision":"accept"|"revise"|"rollback"|"escalate","summary":string,"boardQuestion":string}',
      context: { mode: "task", task: { title: run.task?.title }, results, solution: o.solution ?? "", files: files.map((f) => f.display) },
      maxOutputTokens: 1000,
    });
    const nonEmpty = results.length ? results.some((r) => (r.result ?? "").trim()) : !!(o.solution ?? "").trim();
    const threshold = acceptThreshold(o.controlLevel, run.drives.strictSelfEvaluation);
    // No readable verdict (even after llmJson's repair attempt): don't default to "revise" — that
    // re-ran finished work with its side effects (the same memory written three times). A non-empty
    // result is accepted at the bar, with the gap reported; an empty one is still revised.
    const degraded = Object.keys(json).length === 0;
    const score = unit(json.score, nonEmpty ? (degraded ? threshold : 0.5) : 0.1);
    const truthfulScore = unit(json.truthful, degraded && nonEmpty ? Math.max(score, run.drives.truthfulGate) : score);
    const modelDecision: Decision = oneOf(json.decision, ["accept", "revise", "rollback", "escalate"] as const, (degraded && nonEmpty) || score >= 0.6 ? "accept" : "revise");
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
    if (degraded) issues.push("self-evaluation unavailable: the model's verdict could not be read");
    if (!teg.efficient) issues.push(`cost $${o.actualCostUsd.toFixed(4)} exceeded 1.5× the estimate $${o.estimateUsd.toFixed(4)}`);
    let decision = decide({ modelDecision, score, teg, revisionsLeft: o.revisionsLeft, rollbackAvailable: o.rollbackAvailable, canEscalate: o.canEscalate });
    let openPointsExtra: string[] = [];
    if (validation) {
      // The checker decides what is short, not the leader's second thoughts (2026-11-08: reviews kept
      // finding new requirements — per-toggle captures, dated sign-offs — so every round found more).
      const before = decision;
      if (validation.unmet.length === 0 && (decision === "revise" || decision === "rollback")) decision = "accept";
      else if (validation.unmet.length > 0 && decision === "accept" && o.revisionsLeft > 0) decision = "revise";
      if (decision === "revise") issues.splice(0, issues.length, ...validation.unmet.map((c) => `${c.id} not met (${truncate(c.text, 120)}): ${c.gap || "not shown in the saved work"}`));
      openPointsExtra = validation.board.map((c) => `${truncate(c.text, 140)} — ${c.gap || "needs the Board"}`);
      if (before !== decision) span.setAttributes({ "agentco.validation.decision": `${before}→${decision}` });
    }
    const summary = str(json.summary, results.length ? `${results.filter((r) => r.status === "done").length}/${results.length} parts delivered.` : truncate(o.solution ?? "", 300), 1200);
    span.setAttributes({ "agentco.score": score, "agentco.decision": decision, "agentco.decision.model": modelDecision, "agentco.accept_threshold": threshold, "agentco.feedback.degraded": degraded });
    const openPoints = strArr(json.openPoints, 8, 240);
    for (const extra of openPointsExtra) if (!openPoints.some((p) => overlapRatio(p, extra) >= 0.5)) openPoints.push(extra);
    const boardQuestion = typeof json.boardQuestion === "string" ? json.boardQuestion.trim().slice(0, 1200) : "";
    return { score, truthfulScore, issues, openPoints, modelDecision, decision, summary, teg, acceptThreshold: threshold, boardQuestion, validation };
  });
}

/**
 * The integrated deliverable a manager reports upward after accepting its subprocesses: the
 * summary, the open points for the Board, the files saved, and a few lines per contribution (the
 * files hold the detail). It used to paste every contribution in full, nested reports included, so
 * the Board's reply ran to pages (2026-11-07).
 */
export function integrateResults(
  title: string,
  summary: string,
  subtasks: Task[],
  agentName: string,
  extras: { openPoints?: string[]; unfinished?: string[]; files?: ReviewFile[]; names?: (agentId: string | null) => string; validation?: Validation | null } = {},
): string {
  const parts = subtasks
    .filter((s) => s.status === "done" && s.result && s.state.kind !== "escalation")
    .map((s) => `- **${s.title}**${extras.names ? ` (${extras.names(s.assigneeId)})` : ""}: ${gist(s.result!)}`);
  const missing = subtasks.filter((s) => s.status !== "done" && s.state.kind !== "escalation").map((s) => `- ${s.title}: ${s.status}${s.error ? ` (${oneLine(s.error, 120)})` : ""}`);
  const points = extras.openPoints ?? [];
  const files = extras.files ?? [];
  return [
    `# ${title}`,
    `${summary}`,
    extras.validation ? validationSection(extras.validation) : "",
    points.length ? `## Open points for the Board\n${points.map((p) => `- ${p}`).join("\n")}` : "",
    extras.unfinished?.length ? unfinishedSection(extras.unfinished) : "",
    files.length ? `## Files\n${files.map((f) => `- ${f.display} (${f.by}, ${f.words} words)`).join("\n")}` : "",
    parts.length ? `## Contributions\n${parts.join("\n")}` : "",
    missing.length ? `## Not delivered\n${missing.join("\n")}` : "",
    `— ${agentName}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Files cut to a total size, each keeping its share (the list of committed files always whole). */
export function withinBudget<T extends ReviewFile>(files: readonly T[], total: number): T[] {
  if (files.length === 0) return [];
  const each = Math.max(800, Math.floor(total / files.length));
  return files.map((f) => (f.content.length <= each || f.display.endsWith("committed files") ? f : { ...f, content: f.content.slice(0, each), truncated: true }));
}

/**
 * Notes the platform adds to a review's issues for its own decisions (cost over the estimate, an
 * unreadable verdict): never shown to the Board (2026-11-08, trc_4469…: "cost $0.6999 exceeded 1.5×
 * the estimate $0.0600" was listed as an open point for the Board).
 */
export function internalIssue(issue: string): boolean {
  return /^cost \$[\d.]+ exceeded 1\.5× the estimate/.test(issue) || issue.startsWith("self-evaluation unavailable");
}

/** What was still short after the one round of fixes, for the report: a few lines, the platform's own notes left out. */
export function unfinishedPoints(issues: readonly string[]): string[] {
  return issues.filter((i) => !internalIssue(i)).slice(0, 4).map((i) => oneLine(i, 220));
}

export function unfinishedSection(items: readonly string[]): string {
  return `## Not finished after one round of fixes\n${items.map((p) => `- ${p}`).join("\n")}`;
}

/** A contribution's first point: its own heading and any nested "Contributions" section dropped, one line. */
export function gist(result: string, max = 320): string {
  let text = result.trim().replace(/^#{1,3} [^\n]*\n+/, "");
  const nested = text.search(/\n#{1,3} Contributions\b/);
  if (nested >= 0) text = text.slice(0, nested);
  return oneLine(text, max);
}

export interface ReviewFile {
  display: string;
  by: string;
  content: string;
  truncated: boolean;
  words: number;
  lines: number;
}

const REVIEW_FILE_CHARS = 6000;
const REVIEW_TOTAL_CHARS = 16000;
const REVIEW_MAX_FILES = 6;

/**
 * The files a piece of work saved, newest first, as they are on disk now (one entry per location,
 * capped in count and size) — what Feedback judges instead of asking for a read-back.
 */
export interface FileCaps {
  perFile: number;
  total: number;
  maxFiles: number;
}

const REVIEW_CAPS: FileCaps = { perFile: REVIEW_FILE_CHARS, total: REVIEW_TOTAL_CHARS, maxFiles: REVIEW_MAX_FILES };

export function reviewFiles(run: BrainRun, writes: { agentId: string; display: string }[], caps: FileCaps = REVIEW_CAPS): ReviewFile[] {
  const drive = run.platform.drive;
  if (!drive || writes.length === 0) return [];
  const seen = new Set<string>();
  const out: ReviewFile[] = [];
  let total = 0;
  for (const w of [...writes].reverse()) {
    const key = w.display.startsWith("private/") ? `${w.agentId}:${w.display}` : w.display;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = drive.read(w.agentId, w.display);
    if (!file) continue;
    const room = Math.min(caps.perFile, caps.total - total);
    if (room < 500) break;
    const m = measure(file.content);
    const content = file.content.length > room ? file.content.slice(0, room) : file.content;
    total += content.length;
    out.push({ display: w.display, by: run.platform.org.getAgent(w.agentId)?.name ?? w.agentId, content, truncated: file.truncated || content.length < file.content.length, words: m.words, lines: m.lines });
    if (out.length >= caps.maxFiles) break;
  }
  return out;
}

/** Files saved under these tasks or anywhere below them (a report's own reports included). */
export function filesUnderTasks(run: BrainRun, roots: Task[], caps: FileCaps = REVIEW_CAPS): ReviewFile[] {
  const drive = run.platform.drive;
  const task = run.task;
  if (!drive || !task || roots.length === 0) return [];
  const ids = new Set<string>();
  const queue = roots.map((t) => t.id);
  while (queue.length > 0 && ids.size < 200) {
    const id = queue.shift()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const c of run.platform.tasks.children(id)) queue.push(c.id);
  }
  return reviewFiles(run, drive.written(task.traceId).filter((w) => w.taskId !== null && ids.has(w.taskId)), caps);
}

