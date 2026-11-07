/**
 * BrainEngine — executives and managers. One run = one pass of the founder's
 * diagram (docs/BRAIN.md §3):
 *
 *   TODO List: select / resume checkpoint
 *   Self-management: charter = identity + drives (desire → motivation ← emotion, needs)
 *   Metacognition: Target Understanding → Self-ability → Monitoring (OOD, calibration)
 *     → Confidence ⇄ Fallback (evaluation) → Early stop?
 *     → Data-driven Analysis → Cognitive Control (decomposition + Role Arrangement │ candidates)
 *     → Economic Concepts → Reverse Thinking → Solving → Feedback
 *       (accept → Report · revise → Reflection/Replanning · rollback → Rollback/Failure Recovery)
 *   Report → Feedback/Update (Human Nature → Emotion, OKRs, self-narrative) · Online Learning · Global Memory
 *   interruptFor() between phases → outcome "yielded" with task.state.checkpoint.
 *
 * Blocks are grouped under §3 phase spans (brain.target_understanding,
 * brain.confidence, brain.planning, brain.solving, brain.evaluation, brain.report).
 */
import type { Approval, CalibrationStats, Okr, Task } from "../../../../../packages/shared/src/index.ts";
import type { CognitiveEngine, CognitiveStatePatch, EngineContext, EngineResult, SpanHandle, ToolEffect } from "../../contracts.ts";
import { arr, num, obj, str, strArr } from "../coerce.ts";
import { agentFacts } from "../prompt.ts";
import { oneLine, truncate } from "../text.ts";
import { canEscalate, escalationSettled, hasEscalationTools, readEscalation } from "./escalation.ts";
import { writeReport } from "./global-memory.ts";
import { CANDIDATE_NAMES, Q2_OOD, Q3_FALLBACK, Q4_CONTROL, Q8_HUMAN_NATURE, type CandidateName } from "./interpretation.ts";
import { assessConfidence, fallbackTarget, proceedOnAssumptions, shouldEarlyStop, type ConfidenceAssessment, type FallbackTarget } from "./metacognition/confidence.ts";
import { cognitiveControl, type ControlOutput, type Subprocess } from "./metacognition/cognitive-control.ts";
import { oodMonitoring, reverseThinking, updateCalibration, type OodReport } from "./metacognition/monitoring.ts";
import {
  dataDrivenAnalysis,
  economicConcepts,
  inspectSubtasks,
  nextCandidate,
  onlineLearning,
  reflectionReplanning,
  rollbackRecovery,
} from "./metacognition/project-management.ts";
import { selfAbility, type Competence } from "./metacognition/self-ability.ts";
import { delegateParts, feedback, filesUnderTasks, integrateResults, reviewFiles, solving, type FeedbackResult, type Solution } from "./metacognition/solving-evaluation.ts";
import { analysis, literatureReview, problemDefinition, requestText, type ProblemDefinition, type Understanding } from "./metacognition/target-understanding.ts";
import { block, llmJson, mustPropagate, phase, toolContext, YieldSignal, type BrainRun } from "./runtime.ts";
import { feedbackUpdate } from "./self-management/emotion.ts";
import { eventsFromSubtasks, recognition, type ProcessEvent } from "./self-management/human-nature.ts";
import { computeDrives, selfManagementPass } from "./self-management/identity.ts";
import { isAligned, okrProgress, proposeFromOkrs } from "./self-management/okr.ts";
import { generateNarrative, narrativeDue } from "./self-management/self-narrative.ts";
import { checkpointState, interruptCheck, resumeWorkingMemory, selectSubprocess, type Checkpoint } from "./todo-list.ts";

export interface BrainOptions {
  maxRevisions?: number;
  runTimeoutMs?: number;
}

/** The plan persisted to task.state.plan (local working memory across runs). */
export interface PersistedPlan {
  problem: string;
  title: string;
  successCriteria: string[];
  understanding: string;
  uncertainty: number;
  confidence: number;
  controlLevel: number;
  chosen: CandidateName;
  mode: "direct" | "delegate";
  subprocesses: Subprocess[];
  candidates: { name: string; estCostUsd: number; expectedValue: number }[];
  estimateUsd: number;
  revision: number;
  rejected: CandidateName[];
  feedback: string[];
  costSoFarUsd: number;
}

function readPlan(task: Task): PersistedPlan | null {
  const p = obj(task.state.plan);
  if (!p.problem) return null;
  const rejected = strArr(p.rejected, 3, 20).filter((n): n is CandidateName => (CANDIDATE_NAMES as readonly string[]).includes(n));
  const chosen = (CANDIDATE_NAMES as readonly string[]).includes(String(p.chosen)) ? (p.chosen as CandidateName) : "low_cost";
  return {
    problem: str(p.problem, task.title, 600),
    title: str(p.title, task.title, 140),
    successCriteria: strArr(p.successCriteria, 6, 200),
    understanding: str(p.understanding, "", 600),
    uncertainty: num(p.uncertainty, 0.4, 0, 1),
    confidence: num(p.confidence, 0.6, 0, 1),
    controlLevel: num(p.controlLevel, 0.4, 0, 1),
    chosen,
    mode: p.mode === "delegate" ? "delegate" : "direct",
    subprocesses: arr(p.subprocesses).map((s) => obj(s) as unknown as Subprocess),
    candidates: arr(p.candidates).map((c) => {
      const o = obj(c);
      return { name: str(o.name, "", 20), estCostUsd: num(o.estCostUsd, 0), expectedValue: num(o.expectedValue, 0) };
    }),
    estimateUsd: num(p.estimateUsd, task.estCostUsd, 0),
    revision: num(p.revision, 0, 0, 10),
    rejected,
    feedback: strArr(p.feedback, 8, 240),
    costSoFarUsd: num(p.costSoFarUsd, 0, 0),
  };
}

interface Understood {
  problem: ProblemDefinition;
  literature: string[];
  understanding: Understanding;
  competence: Competence;
  ood: OodReport;
  confidence: ConfidenceAssessment;
}

/** Checkpoint reason marking a run that is waiting on its manager's answer. */
const ESCALATION_CHECKPOINT = "escalated to manager";
/** Checkpoint reason marking a run blocked on the Board's answer (resumed on human_answer). */
const BOARD_CHECKPOINT = "asked the Board";

/** Every task result carries the escalation budget so the next run (and the reviewer) sees it. */
function withEscalationState(run: BrainRun, result: EngineResult): EngineResult {
  if (!run.escalation) return result;
  return { ...result, taskState: { ...(result.taskState ?? {}), escalation: { ...run.escalation } } };
}

function solutionEscalation(solution: Solution): { approvalId: string | null; subtaskId: string | null } {
  return { approvalId: solution.escalation?.approvalId ?? null, subtaskId: solution.escalation?.subtaskId ?? null };
}

export class BrainEngine implements CognitiveEngine {
  readonly kind = "brain" as const;
  private readonly maxRevisions: number;
  private readonly runTimeoutMs: number;

  constructor(options: BrainOptions = {}) {
    this.maxRevisions = Math.max(0, options.maxRevisions ?? 2);
    this.runTimeoutMs = options.runTimeoutMs ?? 300_000;
  }

  async run(ctx: EngineContext): Promise<EngineResult> {
    const input = ctx.input;
    const task = input.trigger === "message" ? null : input.task;
    const run: BrainRun = {
      ctx,
      platform: ctx.platform,
      agent: ctx.agent,
      routingAgent: ctx.agent,
      facts: agentFacts(ctx.platform, ctx.agent),
      task,
      charter: "",
      drives: computeDrives(ctx.agent.identity, ctx.agent.affect, ctx.platform.org.needs(ctx.agent.id)),
      wm: {},
      visited: [],
      costUsd: 0,
      maxRevisions: this.maxRevisions,
      calls: [],
      insights: [],
      runTimeoutMs: this.runTimeoutMs,
      startedMs: Date.now(),
      parent: null,
      currentBlock: null,
      ...(input.trigger === "message" ? {} : { escalation: readEscalation(input.task, input.subtasks, ctx.agent.id) }),
    };
    try {
      if (input.trigger === "message") return await this.onMessage(run);
      return withEscalationState(run, await this.onTask(run));
    } catch (err) {
      if (err instanceof YieldSignal) {
        ctx.span.setAttributes({ "agentco.yielded_before": err.nextBlock, "agentco.yield_reason": truncate(err.reason, 200) });
        return withEscalationState(run, {
          outcome: "yielded",
          output: `Paused T-${task?.number ?? "?"} at ${err.nextBlock} for more urgent work (${oneLine(err.reason, 120)}); will resume from here.`,
          taskState: checkpointState(run, err),
        });
      }
      throw err;
    } finally {
      ctx.span.setAttributes({ "agentco.brain.visited": run.visited.length, "agentco.brain.cost_usd": Math.round(run.costUsd * 1e6) / 1e6 });
      ctx.platform.agents.setActivity(ctx.agent.id, "idle", null, null);
    }
  }

  // ───────────────────────────── Message trigger ─────────────────────────────

  private async onMessage(run: BrainRun): Promise<EngineResult> {
    const input = run.ctx.input;
    if (input.trigger !== "message") throw new Error("unreachable");
    await phase(run, "self_management", () => selfManagementPass(run));
    const { problem, literature } = await phase(run, "target_understanding", async () => {
      const problem = await problemDefinition(run);
      const literature = await literatureReview(run, `${problem.problem} ${input.message.content}`, Math.max(2, Math.floor(run.drives.recallK / 2)));
      return { problem, literature };
    });

    const openObjective = (title: string) =>
      block(run, "todo_list", "Adding the request to my TODO list", (span) => {
        const t = run.platform.tasks.createObjective({
          title,
          description: `${input.message.content.trim()}\n\nProblem as understood: ${problem.problem}`,
          assigneeId: run.agent.id,
          createdBy: run.agent.id,
          traceId: run.ctx.run.traceId,
          parentSpanId: run.ctx.span.spanId,
          originConversationId: input.history.conversation.id,
          acceptanceCriteria: problem.successCriteria.join("; ") || null,
        });
        span.setAttributes({ "agentco.task.id": t.id, "agentco.task.number": t.number });
        return t;
      });

    if (problem.intent === "work") {
      const task = await openObjective(problem.title);
      return { outcome: "completed", output: `Opened T-${task.number}: ${task.title}. I'll work it through and report back here when it's done.` };
    }

    // A chat reply has no tools: it cannot act. The reply model also says whether the message asks
    // for action after all — then the objective is opened instead of a reply that only PROMISES to act
    // ("I'm writing it to the knowledge base myself…" with nothing ever written).
    const out = await block(run, "metacognition.solving_evaluation.solving", "Writing a reply", (span) =>
      llmJson(run, {
        stage: "chat.reply",
        span,
        instructions:
          `${requestText(run)}\n\nWhat you know:\n${literature.slice(0, 6).join("\n") || "(nothing specific)"}\n\n` +
          "Reply to the latest message in your own voice: brief, specific, honest about what you don't know. " +
          "You cannot take any action in this reply (no tools): never say you are doing, have done or will do something yourself. " +
          "needsTask = true if the message asks for anything to be done or changed (even a small action such as recording or saving something); the task is then opened for you.",
        shape: '{"reply":string,"needsTask":boolean}',
        context: { mode: "message", message: input.message.content, agent: { name: run.agent.name, title: run.agent.title, department: run.facts.department } },
        maxOutputTokens: 700,
      }),
    );
    if (out.needsTask === true) {
      run.ctx.span.setAttributes({ "agentco.chat.needs_task": true });
      const task = await openObjective(problem.title);
      return { outcome: "completed", output: `Opened T-${task.number}: ${task.title}. I'll work it through and report back here when it's done.` };
    }
    const reply = typeof out.reply === "string" ? out.reply.trim() : "";
    return { outcome: "completed", output: reply || "Noted — I'll follow up." };
  }

  // ───────────────────────────── Task triggers ─────────────────────────────

  private async onTask(run: BrainRun): Promise<EngineResult> {
    const input = run.ctx.input;
    if (input.trigger === "message") throw new Error("unreachable");
    let task = input.task;
    const selection = await selectSubprocess(run);
    await phase(run, "self_management", () => selfManagementPass(run));

    if (selection.entry === "heartbeat") return this.heartbeat(run);

    // human_answer: resume at the checkpointed block with the Board's answer in local working memory.
    let boardGuidance: string | null = null;
    if (selection.entry === "human_answer") {
      const a: Approval | undefined = input.answeredApproval;
      const patch: Record<string, unknown> = { checkpoint: null };
      if (a) patch.answers = [...arr(task.state.answers), { approvalId: a.id, kind: a.kind, status: a.status, note: a.note }].slice(-5);
      task = this.patch(run, patch); // the returned row, not the stale input snapshot
      const cp = selection.checkpoint;
      if (cp) {
        run.wm = resumeWorkingMemory(cp, "answer");
        run.ctx.span.setAttributes({ "agentco.resumed_at": cp.block });
      }
      if (a) {
        run.wm.boardAnswer = { approvalId: a.id, kind: a.kind, status: a.status, note: a.note };
        // The Board answered this task's question: no asking again (escalation.ts).
        if (a.kind === "question" && run.escalation) run.escalation.answered = true;
        boardGuidance = `Answer from the Board (${a.status}): ${truncate(a.note ?? "(no note)", 400)}`;
        run.ctx.span.setAttributes({ "agentco.board_answer": a.status });
      }
    }
    let plan = readPlan(task);
    if (selection.entry === "resume" && selection.checkpoint) {
      // Resume AT the checkpointed block: working memory keeps what the earlier blocks produced
      // (understanding, competence, confidence, the chosen plan), so no earlier model call is redone.
      run.wm = resumeWorkingMemory(selection.checkpoint, "yield");
      run.ctx.span.setAttributes({ "agentco.resumed_at": selection.checkpoint.block, "agentco.resumed_wm": Object.keys(run.wm).sort().join(",") });
    }

    if (selection.entry === "recovery") {
      const inspection = await phase(run, "recovery", () => rollbackRecovery(run, input.recoveryNotice ?? "recovery"));
      if (inspection.open.length > 0) {
        return {
          outcome: "waiting",
          output: `Recovered T-${task.number}: ${inspection.open.length} subtask(s) still open (${inspection.open.map((t) => `T-${t.number}`).join(", ")}); waiting for them instead of re-delegating.`,
          taskState: { checkpoint: null, recoveredFromRunId: obj(task.state.recovery).runId ?? null },
        };
      }
      if (inspection.finished.length > 0 && plan) return this.evaluateSubprocesses(run, plan, inspection.finished);
      return this.fullPass(run, plan, { feedback: [], rejected: plan?.rejected ?? [], revision: plan?.revision ?? 0 });
    }

    if (selection.entry === "feedback") {
      const children = input.subtasks.length > 0 ? input.subtasks : run.platform.tasks.children(task.id);
      if (!plan) plan = this.planFromTask(task);
      // An escalation to the manager was answered: treat the result like a human answer and
      // resume at the checkpointed block with the answer in local working memory.
      const cp = selection.checkpoint;
      const finishedEsc = children.filter((c) => c.state.kind === "escalation" && ["done", "failed", "cancelled"].includes(c.status));
      // Only what was answered since this checkpoint: an earlier wait or answer is old news.
      const recent = cp ? finishedEsc.filter((c) => !c.completedAt || c.completedAt >= cp.at) : finishedEsc;
      const answered = recent.length > 0 ? recent : finishedEsc;
      if (cp && cp.reason === ESCALATION_CHECKPOINT && answered.length > 0) {
        const good = answered.filter((c) => c.status === "done");
        if (good.length === 0) {
          const why = answered.map((c) => c.error ?? c.result ?? c.status).join("; ");
          this.patch(run, { checkpoint: null });
          return { outcome: "failed", output: "", error: `My manager could not answer the escalation on T-${task.number}: ${truncate(why, 300)}`, taskState: { checkpoint: null } };
        }
        const waits = good.filter((c) => c.state.inputsWait === true);
        const answers = good.filter((c) => c.state.inputsWait !== true);
        const answer = answers.map((c) => c.result ?? "").filter(Boolean).join("\n").trim();
        const inputs = waits.map((c) => c.result ?? "").filter(Boolean).join("\n").trim();
        run.wm = {
          ...resumeWorkingMemory(cp, "answer"),
          ...(answers.length ? { escalationAnswer: answer || "Proceed with your best judgment." } : {}),
          ...(inputs ? { inputsReady: inputs } : {}),
        };
        // A manager answered: no re-escalation of this task. A finished inputs wait answers nothing.
        if (run.escalation && answers.length > 0) run.escalation.answered = true;
        run.ctx.span.setAttributes({ "agentco.resumed_at": cp.block, "agentco.escalation.answered": answers.length, "agentco.inputs_ready": waits.length });
        this.patch(run, { checkpoint: null });
        const other = children.filter((c) => c.state.kind !== "escalation");
        const guidance = [
          ...(answers.length ? [`Guidance from my manager: ${truncate(answer || "Proceed with your best judgment.", 400)}`] : []),
          ...(inputs ? [`Colleague work I was waiting for is done: ${truncate(inputs, 400)}`] : []),
        ];
        if (other.length > 0 && plan.subprocesses.length > 0) {
          // Escalated while evaluating subtask results: re-evaluate them with the guidance in hand.
          return this.evaluateSubprocesses(run, { ...plan, feedback: [...plan.feedback, ...guidance].slice(-8) }, other);
        }
        return this.fullPass(run, plan, {
          feedback: [...plan.feedback, ...guidance].slice(-8),
          rejected: plan.rejected,
          revision: plan.revision,
          boardApproved: true,
          managerAnswered: true,
        });
      }
      return this.evaluateSubprocesses(run, plan, children);
    }

    return this.fullPass(run, selection.entry === "fresh" ? null : plan, {
      feedback: [...(plan?.feedback ?? []), ...(boardGuidance ? [boardGuidance] : [])].slice(-8),
      rejected: plan?.rejected ?? [],
      revision: plan?.revision ?? 0,
      boardApproved: selection.entry === "human_answer" && input.answeredApproval?.status === "approved",
    });
  }

  /** patchState that keeps run.task current (the engine must never reason over a stale snapshot). */
  private patch(run: BrainRun, patch: Record<string, unknown>): Task {
    const updated = run.platform.tasks.patchState(run.task!.id, patch);
    run.task = updated;
    return updated;
  }

  private planFromTask(task: Task): PersistedPlan {
    return {
      problem: task.title,
      title: task.title,
      successCriteria: task.acceptanceCriteria ? [task.acceptanceCriteria] : [`A concrete deliverable for "${truncate(task.title, 80)}"`],
      understanding: task.description,
      uncertainty: 0.4,
      confidence: 0.6,
      controlLevel: 0.4,
      chosen: "low_cost",
      mode: "delegate",
      subprocesses: [],
      candidates: [],
      estimateUsd: task.estCostUsd,
      revision: 0,
      rejected: [],
      feedback: [],
      costSoFarUsd: 0,
    };
  }

  /**
   * Target Understanding → Self-ability → OOD → Confidence ⇄ Fallback (evaluation). Every result is
   * kept in working memory, so a run resumed at a later block (checkpoint) skips these blocks — and
   * their interrupt checks — instead of redoing their model calls.
   */
  private async understand(run: BrainRun): Promise<Understood> {
    const task = run.task!;
    const cached = this.restoredUnderstanding(run);
    if (cached) {
      run.ctx.span.setAttributes({ "agentco.confidence": cached.confidence.calibrated, "agentco.resumed.understanding": true });
      return cached;
    }
    const tuCached = !!(run.wm.problem && run.wm.literature && run.wm.understanding);
    if (!tuCached) interruptCheck(run, "metacognition.target_understanding.problem_definition");
    const tu = await phase(run, "target_understanding", async () => {
      const problem = (run.wm.problem as ProblemDefinition | undefined) ?? (await problemDefinition(run));
      run.wm.problem = problem;
      const literature = (run.wm.literature as string[] | undefined) ?? (await literatureReview(run, `${problem.problem} ${task.title}`, run.drives.recallK));
      run.wm.literature = literature;
      const understanding = (run.wm.understanding as Understanding | undefined) ?? (await analysis(run, problem, literature, run.drives.perspectives));
      run.wm.understanding = understanding;
      return { problem, literature, understanding };
    });
    interruptCheck(run, "metacognition.self_ability");
    return phase(run, "confidence", async () => {
      let { problem, literature, understanding } = tu;
      const taskText = `${task.title} ${task.description}`;
      let competence = await selfAbility(run, taskText);
      let ood = await oodMonitoring(run, problem.problem);
      if (ood.taskOod) {
        // Task OOD → wider literature review.
        literature = [...literature, ...(await literatureReview(run, `${problem.problem} ${task.description}`, run.drives.recallK + Q2_OOD.extraRecall))];
      }
      let confidence = await assessConfidence(run, problem, understanding, competence, ood);
      const used = new Set<FallbackTarget>();
      for (let pass = 0; pass < 2; pass++) {
        const target = fallbackTarget(confidence, used);
        if (!target) break;
        used.add(target);
        if (target === "target_understanding") {
          problem = await problemDefinition(run, confidence.understandingEval.gaps);
          literature = await literatureReview(run, `${problem.problem} ${confidence.understandingEval.gaps.join(" ")}`, run.drives.recallK + Q3_FALLBACK.extraRecall);
          understanding = await analysis(run, problem, literature, run.drives.perspectives);
        } else {
          competence = await selfAbility(run, taskText, confidence.competenceEval.gaps);
        }
        const more = await oodMonitoring(run, null);
        ood = { ...ood, performance: [...ood.performance, ...more.performance], pressure: more.pressure };
        confidence = await assessConfidence(run, problem, understanding, competence, ood);
      }
      run.wm.problem = problem;
      run.wm.literature = literature;
      run.wm.understanding = understanding;
      run.wm.competence = competence;
      run.wm.ood = ood;
      run.wm.confidence = confidence;
      run.wm.routingTier = run.routingAgent.modelTier;
      run.ctx.span.setAttributes({ "agentco.confidence": confidence.calibrated, "agentco.fallbacks": [...used].join(",") || "none" });
      return { problem, literature, understanding, competence, ood, confidence };
    });
  }

  /** Understanding + competence + confidence restored from a checkpoint (resume at Cognitive Control or later). */
  private restoredUnderstanding(run: BrainRun): Understood | null {
    const wm = run.wm;
    if (!wm.problem || !wm.literature || !wm.understanding || !wm.competence || !wm.ood || !wm.confidence) return null;
    const tier = wm.routingTier;
    if (tier === "economy" || tier === "standard" || tier === "frontier") run.routingAgent = { ...run.routingAgent, modelTier: tier };
    return {
      problem: wm.problem as ProblemDefinition,
      literature: wm.literature as string[],
      understanding: wm.understanding as Understanding,
      competence: wm.competence as Competence,
      ood: wm.ood as OodReport,
      confidence: wm.confidence as ConfidenceAssessment,
    };
  }

  /** A full Metacognition pass (fresh, resumed, re-planned after a human answer or recovery). */
  private async fullPass(
    run: BrainRun,
    prior: PersistedPlan | null,
    state: { feedback: string[]; rejected: CandidateName[]; revision: number; boardApproved?: boolean; managerAnswered?: boolean },
  ): Promise<EngineResult> {
    const task = run.task!;
    const u = await this.understand(run);

    // Early Stop? (the Board's explicit go-ahead overrides a low-confidence stop once). Frustration
    // is about setbacks on THIS task: a fresh task is not stopped by frustration from other work
    // (a sticky, company-wide gate turned every new request into a Board question).
    const setbacks = taskSetbacks(run, state);
    const drives = setbacks ? run.drives : { ...run.drives, frustrationGate: false };
    if (run.drives.frustrationGate && !setbacks) run.ctx.span.setAttributes({ "agentco.frustration_gate.fresh_task": true });
    let stop = shouldEarlyStop(u.confidence.calibrated, drives);
    if (stop.stop && !drives.frustrationGate && proceedOnAssumptions(u.confidence, setbacks)) {
      run.ctx.span.setAttributes({ "agentco.early_stop.proceed_on_assumptions": true, "agentco.early_stop.skipped_reason": stop.reason });
      run.wm.assumptions = u.confidence.risks.slice(0, 3);
      stop = { stop: false, reason: "" };
    }
    // A manager's or the Board's answer to this task settles it even through the frustration gate,
    // and so does a spent escalation budget: proceed with the guidance (no re-escalation loop).
    const answered = state.managerAnswered || run.escalation?.answered === true;
    if (stop.stop && !(answered || (state.boardApproved && !drives.frustrationGate))) {
      if (!escalationSettled(run)) {
        const need = u.confidence.blocker ? `Needed: ${u.confidence.blocker}` : `Risks: ${u.confidence.risks.join("; ") || "unclear"}`;
        return this.escalateOutcome(run, `Early stop on T-${task.number}: ${stop.reason}. ${need}`, u.confidence.calibrated);
      }
    }
    if (stop.stop) run.ctx.span.setAttributes({ "agentco.early_stop.settled": true });

    const existingTitles = run.platform.tasks
      .children(task.id)
      .filter((c) => c.status !== "failed" && c.status !== "cancelled")
      .map((c) => c.title);
    let feedbackIssues = [...state.feedback];
    let rejected = [...state.rejected];
    let revision = state.revision;
    const maxRevisions = run.drives.conservation ? 0 : run.maxRevisions;
    let blockedSolves = 0;

    for (let attempt = 0; attempt < maxRevisions + CANDIDATE_NAMES.length + 1; attempt++) {
      // Resumed at Solving: the chosen plan is in working memory — no re-planning.
      const restored = attempt === 0 ? (run.wm.planned as { control: ControlOutput; chosen: CandidateName } | undefined) : undefined;
      if (!restored) interruptCheck(run, "metacognition.cognitive_control.decomposition");
      const planned = restored ?? (await this.planPhase(run, u, feedbackIssues, rejected));
      run.wm.planned = { control: planned.control, chosen: planned.chosen };
      if (restored) run.ctx.span.setAttributes({ "agentco.resumed.plan": planned.chosen });
      const persisted = this.persist(run, u, planned.control, planned.chosen, revision, rejected, feedbackIssues, prior);
      this.patch(run, { plan: persisted, checkpoint: null });

      interruptCheck(run, "metacognition.solving_evaluation.solving");
      // From here on the run is not interrupted: Solving (and its Feedback) finish first.
      run.solvingStarted = true;
      delete run.wm.planned;
      const solution = await phase(run, "solving", () =>
        solving(run, {
          mode: planned.control.mode,
          subprocesses: planned.control.subprocesses,
          candidate: planned.chosen,
          problem: Array.isArray(run.wm.assumptions) && run.wm.assumptions.length
            ? `${u.problem.problem}\nProceed on reasonable assumptions and state them in your result (open points: ${(run.wm.assumptions as string[]).join("; ")}).`
            : u.problem.problem,
          successCriteria: u.problem.successCriteria,
          memory: u.literature,
          existingTitles,
        }),
      );
      if (solution.kind === "waiting") {
        const saved = { ...persisted, subprocesses: planned.control.subprocesses, mode: "delegate" as const, costSoFarUsd: persisted.costSoFarUsd + run.costUsd };
        return {
          outcome: "waiting",
          output: `Delegated ${solution.delegated.length} part(s) of T-${task.number}: ${solution.delegated
            .map((s) => `"${truncate(s.title, 60)}" → ${run.platform.org.getAgent(s.assigneeId ?? "")?.name ?? s.assigneeId}`)
            .join("; ")}.`,
          taskState: { plan: saved, checkpoint: null },
        };
      }
      if (solution.kind === "escalated") {
        // escalate / ask_human inside the Solving loop: wait for the answer, never carry on without it.
        return this.escalateOutcome(run, `While solving T-${task.number}: ${solution.text}`, u.confidence.calibrated, [], solutionEscalation(solution), "metacognition.solving_evaluation.solving");
      }

      if (solution.kind === "failed" && solution.text.startsWith("Blocked:")) {
        // report_blocker. Blocked on a colleague's part still in progress → go on hold for it
        // (the escalate tool turns this into an inputs wait); blocked twice → re-planning will not
        // fix an outside blocker, so escalate (2026-11-07: 6–7 report_blocker rounds in one run).
        blockedSolves++;
        const blocker = solution.text.slice("Blocked:".length).trim();
        const inputs = run.platform.tasks.openInputs?.(task, run.agent.id, blocker) ?? [];
        if ((inputs.length > 0 && hasEscalationTools(run.agent)) || (blockedSolves >= 2 && canEscalate(run))) {
          run.ctx.span.setAttributes({ "agentco.blocked.escalated": true, "agentco.blocked.inputs": inputs.length });
          return this.escalateOutcome(run, `Blocked on T-${task.number}: ${truncate(blocker, 600)}`, u.confidence.calibrated, [], null, "metacognition.solving_evaluation.solving");
        }
      }

      // The reviewer sees what was saved, as it is on disk (no read-back loops).
      const saved = reviewFiles(run, solution.effects.filter((e): e is Extract<ToolEffect, { kind: "file_written" }> => e.kind === "file_written").map((e) => ({ agentId: run.agent.id, display: e.path })));
      const fb = await phase(run, "evaluation", () =>
        feedback(run, {
          files: saved,
          problem: u.problem.problem,
          successCriteria: u.problem.successCriteria,
          solution: solution.kind === "solution" ? solution.text : null,
          subtasks: [],
          controlLevel: planned.control.controlLevel,
          estimateUsd: persisted.estimateUsd,
          actualCostUsd: run.costUsd,
          revisionsLeft: Math.max(0, maxRevisions - revision),
          rollbackAvailable: rejected.length < CANDIDATE_NAMES.length - 1,
          canEscalate: canEscalate(run),
        }),
      );
      if (fb.decision === "accept") {
        const output = fb.openPoints.length ? `${solution.text}\n\n## Open points for the Board\n${fb.openPoints.map((p) => `- ${p}`).join("\n")}` : solution.text;
        return this.report(run, { outcome: "completed", output, score: fb.score, summary: fb.summary, predicted: u.confidence.calibrated, events: [], estimateUsd: persisted.estimateUsd, plan: { ...persisted, feedback: [] } });
      }
      if (fb.decision === "escalate") return this.escalateOutcome(run, `Result for T-${task.number} not acceptable: ${fb.issues.join("; ") || fb.summary}`, u.confidence.calibrated);
      if (fb.decision === "fail") {
        feedbackIssues = fb.issues.length ? fb.issues : [fb.summary];
        break;
      }
      // Not enough run time left for another full pass: hand in the best result with its open
      // issues instead of being killed mid-pass and losing the work (2026-11-07: Noah's assembly
      // runs hit the 5-minute limit twice, each time starting over).
      if (runTimeLow(run)) {
        run.ctx.span.setAttributes({ "agentco.time_guard": fb.decision });
        if (solution.kind === "solution" && solution.text.trim()) {
          return this.report(run, {
            outcome: "completed",
            output: `${solution.text}\n\nOpen issues (not fixed: run time nearly used up):\n${(fb.issues.length ? fb.issues : [fb.summary]).map((i) => `- ${i}`).join("\n")}`,
            score: fb.score,
            summary: fb.summary,
            predicted: u.confidence.calibrated,
            events: [],
            estimateUsd: persisted.estimateUsd,
            plan: { ...persisted, feedback: [] },
          });
        }
        if (canEscalate(run)) return this.escalateOutcome(run, `Out of run time on T-${task.number} without a result: ${truncate(fb.issues.join("; ") || fb.summary, 500)}`, u.confidence.calibrated);
        feedbackIssues = fb.issues.length ? fb.issues : [fb.summary];
        break;
      }
      if (fb.decision === "rollback") {
        await rollbackRecovery(run, `rollback of candidate ${planned.chosen}`);
        rejected = [...rejected, planned.chosen];
        const next = nextCandidate(planned.chosen, rejected);
        if (!next) break;
        const done = describeEffects(solution.effects);
        feedbackIssues = done ? [done, ...fb.issues].slice(0, 8) : fb.issues;
        this.patch(run, { plan: { ...persisted, revision, rejected, feedback: feedbackIssues.slice(-8) } });
        continue;
      }
      // revise → Reflection / Replanning → back into Cognitive Control with the feedback.
      revision++;
      this.patch(run, { plan: { ...persisted, revision, rejected, feedback: fb.issues.slice(-8) } });
      feedbackIssues = await reflectionReplanning(run, fb.issues, fb.summary);
      // What the attempt already changed stays changed: the next attempt builds on it, never repeats it.
      const done = describeEffects(solution.effects);
      if (done) feedbackIssues = [done, ...feedbackIssues].slice(0, 8);
      // The verdict is persisted before re-planning: a later checkpoint keeps the revise budget.
      this.patch(run, { plan: { ...persisted, revision, rejected, feedback: feedbackIssues.slice(-8) } });
    }
    return this.report(run, {
      outcome: "failed",
      output: "",
      error: `No acceptable result for T-${task.number} after ${revision} revision(s)`,
      score: 0.2,
      summary: feedbackIssues.join("; "),
      predicted: u.confidence.calibrated,
      events: [],
      estimateUsd: task.estCostUsd,
      plan: null,
    });
  }

  private async planPhase(run: BrainRun, u: Understood, feedbackIssues: string[], rejected: CandidateName[]) {
    const task = run.task!;
    return phase(run, "planning", async () => {
      const data = await dataDrivenAnalysis(run, `${u.problem.problem} ${task.title}`);
      let control = await cognitiveControl(run, {
        problem: u.problem,
        understanding: u.understanding,
        competence: u.competence,
        uncertainty: u.confidence.uncertainty,
        calibrated: u.confidence.calibrated,
        feedback: feedbackIssues,
        preferDelegation: u.competence.preferDelegation,
        pressureSignals: u.ood.pressure.length,
        lessons: data.lessons,
      });
      const pressure = u.ood.pressure.length > 0 || data.favourCheap;
      const choose = () =>
        economicConcepts(run, {
          candidates: control.candidates,
          costFactor: data.costFactor,
          visionMultiplier: run.drives.visionMultiplier,
          aligned: isAligned(`${task.title} ${task.description}`, run.agent.identity.okrs, run.agent.identity.vision),
          confidence: u.confidence.calibrated,
          conservation: run.drives.conservation,
          pressure,
          rejected,
        });
      let choice = await choose();
      if (control.controlLevel >= Q4_CONTROL.reverseThinkingAt && !run.drives.essentialOnly) {
        const premortem = await reverseThinking(
          run,
          `${choice.chosen}: ${control.candidates.find((c) => c.name === choice.chosen)?.approach ?? ""}; ${control.subprocesses.map((s) => s.title).join("; ") || "direct work"}`,
        );
        if (premortem.fatal) {
          const issues = await reflectionReplanning(run, premortem.failureModes, premortem.mitigation);
          control = await cognitiveControl(run, {
            problem: u.problem,
            understanding: u.understanding,
            competence: u.competence,
            uncertainty: u.confidence.uncertainty,
            calibrated: u.confidence.calibrated,
            feedback: [...feedbackIssues, ...issues],
            preferDelegation: u.competence.preferDelegation,
            pressureSignals: u.ood.pressure.length,
            lessons: data.lessons,
          });
          choice = await choose();
        }
      }
      return { control, chosen: choice.chosen, data };
    });
  }

  private persist(
    run: BrainRun,
    u: Understood,
    control: ControlOutput,
    chosen: CandidateName,
    revision: number,
    rejected: CandidateName[],
    feedbackIssues: string[],
    prior: PersistedPlan | null,
  ): PersistedPlan {
    const cand = control.candidates.find((c) => c.name === chosen);
    return {
      problem: u.problem.problem,
      title: u.problem.title,
      successCriteria: u.problem.successCriteria,
      understanding: u.understanding.summary,
      uncertainty: u.confidence.uncertainty,
      confidence: u.confidence.calibrated,
      controlLevel: control.controlLevel,
      chosen,
      mode: control.mode,
      subprocesses: control.subprocesses,
      candidates: control.candidates.map((c) => ({ name: c.name, estCostUsd: c.estCostUsd, expectedValue: c.expectedValue })),
      estimateUsd: cand?.estCostUsd ?? run.task!.estCostUsd,
      revision,
      rejected,
      feedback: feedbackIssues,
      costSoFarUsd: prior?.costSoFarUsd ?? 0,
    };
  }

  /** trigger subtasks_completed (and recovery with finished subtasks): Feedback on the subprocesses. */
  private async evaluateSubprocesses(run: BrainRun, plan: PersistedPlan, children: Task[]): Promise<EngineResult> {
    const task = run.task!;
    // Round 1 done → hand out the round-2 steps (assembly, review) before judging the whole.
    const round2 = await this.secondRound(run, plan, children);
    if (round2) return round2;
    const finished = children.filter((c) => ["done", "failed", "cancelled", "blocked"].includes(c.status));
    const events: ProcessEvent[] = eventsFromSubtasks(finished);
    const maxRevisions = run.drives.conservation ? 0 : run.maxRevisions;
    // The reviewer sees the files the parts saved (reports' own reports included), as on disk.
    const saved = filesUnderTasks(run, children.filter((c) => c.state.kind !== "escalation"));
    const fb: FeedbackResult = await phase(run, "evaluation", () =>
      feedback(run, {
        files: saved,
        problem: plan.problem,
        successCriteria: plan.successCriteria,
        solution: null,
        subtasks: children,
        controlLevel: plan.controlLevel,
        estimateUsd: plan.estimateUsd,
        actualCostUsd: children.reduce((n, c) => n + (c.actualCostUsd ?? 0), 0) + plan.costSoFarUsd + run.costUsd,
        revisionsLeft: Math.max(0, maxRevisions - plan.revision),
        rollbackAvailable: plan.rejected.length < CANDIDATE_NAMES.length - 1,
        canEscalate: canEscalate(run),
      }),
    );
    if (fb.decision === "accept") {
      await this.recognizeWorkers(run, children);
      const output = integrateResults(task.title, fb.summary, children, run.agent.name, {
        openPoints: fb.openPoints,
        files: saved,
        names: (id) => run.platform.org.getAgent(id ?? "")?.name ?? "someone",
      });
      return this.report(run, { outcome: "completed", output, score: fb.score, summary: fb.summary, predicted: plan.confidence, events, estimateUsd: plan.estimateUsd, plan: { ...plan, feedback: [] } });
    }
    if (fb.decision === "escalate") return this.escalateOutcome(run, `Subtasks of T-${task.number} fell short: ${fb.issues.join("; ") || fb.summary}`, plan.confidence, events);
    if (fb.decision === "fail") {
      // No revision, rollback or escalation left: settle instead of re-planning on every wake-up.
      return this.report(run, {
        outcome: "failed",
        output: "",
        error: `No acceptable result for T-${task.number}: ${truncate(fb.issues.join("; ") || fb.summary, 400)}`,
        score: fb.score,
        summary: fb.summary,
        predicted: plan.confidence,
        events,
        estimateUsd: plan.estimateUsd,
        plan,
      });
    }
    // The Feedback verdict is persisted to the plan BEFORE re-planning, so a yield inside the new
    // pass resumes with the revision count, the rejected candidates and the issues (BRAIN_MAX_REVISIONS holds).
    if (fb.decision === "rollback") {
      const next: PersistedPlan = { ...plan, feedback: fb.issues.slice(-8), rejected: [...plan.rejected, plan.chosen] };
      this.patch(run, { plan: next, checkpoint: null });
      await rollbackRecovery(run, `rollback of candidate ${plan.chosen}: ${fb.issues.join("; ")}`, { cancelOpen: true });
      return this.fullPass(run, next, { feedback: next.feedback, rejected: next.rejected, revision: next.revision });
    }
    let next: PersistedPlan = { ...plan, revision: plan.revision + 1, feedback: fb.issues.slice(-8) };
    this.patch(run, { plan: next, checkpoint: null });
    const issues = await reflectionReplanning(run, fb.issues, fb.summary);
    next = { ...next, feedback: issues.slice(-8) };
    this.patch(run, { plan: next });
    return this.fullPass(run, next, { feedback: next.feedback, rejected: next.rejected, revision: next.revision });
  }

  /**
   * Round 2 (founder, 2026-11-07): when every round-1 part is done, the steps that work on their
   * output — assembling, reconciling, reviewing — are delegated, with the round-1 results in their
   * brief. Before, the assembler started alongside the parts and spent its runs searching for
   * sections that did not exist yet. Null when there is nothing to start (no pending round-2 step,
   * or a round-1 part did not finish done): Feedback then judges the parts as usual.
   */
  private async secondRound(run: BrainRun, plan: PersistedPlan, children: Task[]): Promise<EngineResult | null> {
    const pending = plan.subprocesses.filter((s) => s.round === 2 && !s.taskId && s.assigneeId);
    if (pending.length === 0) return null;
    const parts = children.filter((c) => c.state.kind !== "escalation");
    // This plan's round 1 gates round 2 (after a revision, earlier parts are inputs, not gates).
    const planned = new Set(plan.subprocesses.filter((s) => s.round !== 2 && s.taskId).map((s) => s.taskId));
    const current = parts.filter((c) => planned.has(c.id));
    const gate = current.length > 0 ? current : parts;
    if (gate.length === 0 || !gate.every((c) => c.status === "done")) return null;
    const task = run.task!;
    const who = (id: string | null) => run.platform.org.getAgent(id ?? "")?.name ?? "someone";
    const inputs = parts
      .filter((c) => c.status === "done")
      .map((c) => `- T-${c.number} "${truncate(c.title, 80)}" by ${who(c.assigneeId)}: ${truncate(oneLine(c.result ?? ""), 700)}`)
      .join("\n");
    const briefed = pending.map((s) => ({ ...s, description: `${s.description}\n\nRound-1 results to work from (their files are on the company drive):\n${inputs}` }));
    const out = await block(run, "metacognition.solving_evaluation.solving", `Delegating round 2 of T-${task.number}`, async (span) => {
      const r = await delegateParts(run, span, briefed, children.map((c) => c.title));
      span.setAttributes({ "agentco.delegated": r.delegated.length, "agentco.round": 2 });
      return r;
    });
    if (out.delegated.length === 0) return null;
    const started = new Map(out.delegated.map((s) => [s.title, s.taskId]));
    const subprocesses = plan.subprocesses.map((s) => (s.round === 2 && !s.taskId && started.has(s.title) ? { ...s, taskId: started.get(s.title) ?? null } : s));
    return {
      outcome: "waiting",
      output: `Round 1 of T-${task.number} is done (${gate.length} part(s)); delegated round 2: ${out.delegated.map((s) => `"${truncate(s.title, 60)}" → ${who(s.assigneeId)}`).join("; ")}.`,
      taskState: { plan: { ...plan, subprocesses, costSoFarUsd: plan.costSoFarUsd + run.costUsd }, checkpoint: null },
    };
  }

  /**
   * Human Nature › recognition: the manager's Feedback accepted these subtasks, which moves each
   * WORKER's valence (recognizedBy "manager"). Each worker is updated once per acceptance.
   */
  private async recognizeWorkers(run: BrainRun, children: Task[]): Promise<void> {
    const workers = [...new Set(children.filter((c) => c.status === "done" && c.state.kind !== "escalation" && c.assigneeId && c.assigneeId !== run.agent.id).map((c) => c.assigneeId as string))];
    if (workers.length === 0) return;
    await block(run, "self_management.human_nature", `Recognising ${workers.length} report(s) for accepted work`, (span) => {
      const done: string[] = [];
      for (const id of workers) {
        const worker = run.platform.org.getAgent(id);
        if (!worker || worker.status === "terminated") continue;
        try {
          run.platform.agents.updateCognitiveState(id, { affect: recognition(worker.affect, "manager") });
          done.push(id);
        } catch (err) {
          if (mustPropagate(err, run.ctx.signal)) throw err;
        }
      }
      span.setAttributes({ "agentco.recognized": done.join(","), "agentco.recognized_by": "manager" });
      return done;
    });
  }

  /**
   * Early stop / escalate decision. A manager's escalate tool creates an escalation subtask for
   * ITS manager: outcome "waiting" with a checkpoint, resumed by subtasks_completed. The CEO
   * (no manager) asks the Board: outcome "blocked" on the question approval.
   */
  private async escalateOutcome(
    run: BrainRun,
    reason: string,
    predicted: number,
    events: ProcessEvent[] = [],
    opened: { approvalId: string | null; subtaskId: string | null } | null = null,
    resumeBlock: Checkpoint["block"] = "metacognition.confidence",
  ): Promise<EngineResult> {
    const task = run.task!;
    // `opened`: the Solving loop already escalated (reuse it, never open a second one).
    const esc =
      opened ??
      (await block(run, "metacognition.confidence", "Early stop: escalating", async (span) => {
        span.setAttributes({ "agentco.early_stop": true, "agentco.early_stop.reason": truncate(reason, 300) });
        return this.escalate(run, reason, span);
      }));
    const onHold = !!esc.subtaskId && run.platform.tasks.get(esc.subtaskId)?.state.inputsWait === true;
    if ((esc.approvalId || esc.subtaskId) && run.escalation && !onHold) run.escalation.count += 1;
    const approvalId = esc.approvalId;
    const plan = readPlan(run.task!);
    const result = await this.report(run, {
      outcome: "blocked",
      output: onHold ? `Waiting for colleagues' work before continuing T-${task.number} "${task.title}": ${reason}` : `I need guidance on T-${task.number} "${task.title}": ${reason}`,
      score: 0.3,
      summary: reason,
      predicted,
      events: onHold ? events : [...events, { outcome: "escalated", source: "own", recognizedBy: "self" }],
      estimateUsd: plan?.estimateUsd ?? task.estCostUsd,
      plan,
    });
    const at = run.platform.now().toISOString();
    if (esc.subtaskId) {
      const checkpoint: Checkpoint = { block: resumeBlock, reason: ESCALATION_CHECKPOINT, at, wm: run.wm };
      return {
        outcome: "waiting",
        output: `Escalated T-${task.number} to my manager and waiting for the answer: ${reason}`,
        taskState: { ...result.taskState, checkpoint },
      };
    }
    if (!approvalId) return { outcome: "failed", output: "", error: `Escalated without an approval or subtask to wait on: ${reason}`, taskState: result.taskState };
    // Blocked on the Board: checkpoint so the human_answer run resumes here (docs/BRAIN.md §3).
    const checkpoint: Checkpoint = { block: resumeBlock, reason: BOARD_CHECKPOINT, at, wm: run.wm };
    return { ...result, approvalId, taskState: { ...result.taskState, checkpoint } };
  }

  private async escalate(run: BrainRun, reason: string, span: SpanHandle): Promise<{ approvalId: string | null; subtaskId: string | null }> {
    const task = run.task!;
    const question = `T-${task.number} "${truncate(task.title, 80)}": ${truncate(reason, 400)} How should I proceed?`;
    const tools = run.agent.tools;
    const order: string[] = [];
    if (tools.includes("escalate")) order.push("escalate");
    if (tools.includes("ask_human")) order.push("ask_human");
    for (const name of order) {
      const r = await run.platform.tools.execute({ id: `${name}_${run.ctx.run.id}`, name, arguments: name === "escalate" ? { reason, question } : { question } }, toolContext(run, span));
      for (const e of r.effects) {
        if (e.kind === "task_created") return { approvalId: null, subtaskId: e.taskId };
        if (e.kind === "approval_requested") return { approvalId: e.approvalId, subtaskId: null };
      }
    }
    return { approvalId: null, subtaskId: null };
  }

  private async heartbeat(run: BrainRun): Promise<EngineResult> {
    const proposal = await phase(run, "planning", () => proposeFromOkrs(run));
    if (!proposal) return { outcome: "completed", output: "OKRs reviewed: no key result needs a new objective right now." };
    const created = await block(run, "todo_list", "Adding an OKR-driven objective to my TODO list", () =>
      run.platform.tasks.createObjective({
        title: proposal.title,
        description: proposal.description,
        assigneeId: run.agent.id,
        createdBy: run.agent.id,
        traceId: run.ctx.run.traceId,
        parentSpanId: run.ctx.span.spanId,
        originConversationId: null,
        value: proposal.value,
      }),
    );
    return { outcome: "completed", output: `Proposed T-${created.number}: ${created.title}` };
  }

  // ───────────────────────────── Report ─────────────────────────────

  private async report(
    run: BrainRun,
    r: {
      outcome: "completed" | "failed" | "blocked";
      output: string;
      error?: string;
      score: number;
      summary: string;
      predicted: number;
      events: ProcessEvent[];
      estimateUsd: number;
      plan: PersistedPlan | null;
    },
  ): Promise<EngineResult> {
    const task = run.task!;
    await phase(run, "report", async () => {
      const own: ProcessEvent[] =
        r.outcome === "completed"
          ? [{ outcome: "done", source: "own", recognizedBy: run.ctx.input.trigger === "human_answer" && run.ctx.input.answeredApproval?.status === "approved" ? "board" : "self" }]
          : r.outcome === "failed"
            ? [{ outcome: "failed", source: "own", recognizedBy: "self" }]
            : [];
      const openItems = run.platform.tasks.children(task.id).filter((c) => !["done", "failed", "cancelled"].includes(c.status)).length;
      // Fatigue: the real run streak (runs without idle time) and the idle time before this run.
      const streak = run.platform.metrics.runStreak?.(run.agent.id, Q8_HUMAN_NATURE.fatigueIdleGapMs, Q8_HUMAN_NATURE.fatigueMaxRuns) ?? { consecutiveRuns: 1, idleMsBefore: 0 };
      const affect = await feedbackUpdate(run, [...r.events, ...own], { openItems, consecutiveRuns: streak.consecutiveRuns, idleMs: streak.idleMsBefore });
      await oodMonitoring(run, null);
      const learning = await onlineLearning(run, { outcome: r.outcome, summary: `${task.title}: ${r.summary}`, resultCount: r.events.length });
      let calibration: CalibrationStats | undefined;
      if (r.outcome !== "blocked") {
        calibration = await block(run, "metacognition.monitoring.calibration", "Updating calibration with the outcome", (span) => {
          const next = updateCalibration(run.agent.calibration, r.predicted, r.outcome === "completed");
          span.setAttributes({ "agentco.calibration.samples": next.samples, "agentco.calibration.brier": next.brier, "agentco.confidence.predicted": r.predicted });
          return next;
        });
      }
      let okrs: Okr[] | null = null;
      if (r.outcome === "completed") okrs = await okrProgress(run, `${task.title} ${r.summary}`, r.score);
      let narrative: { narrative: string; assets: string[]; resourceConnections: string[] } | null = null;
      const notable = r.outcome !== "completed" || r.score >= 0.9;
      if (!run.drives.essentialOnly && narrativeDue(run.agent.calibration.samples + 1, notable)) {
        const collaborators = r.plan?.subprocesses.map((s) => run.platform.org.getAgent(s.assigneeId ?? "")?.name ?? "").filter(Boolean) ?? [];
        narrative = await generateNarrative(run, r.summary, r.outcome, [...new Set(collaborators)]);
      }
      // Assets / resource connections ride along; CognitiveStatePatch has no field for them yet (see report).
      const patch: CognitiveStatePatch & { assets?: string[]; resourceConnections?: string[] } = { affect };
      if (calibration) patch.calibration = calibration;
      if (okrs) patch.okrs = okrs;
      if (narrative) {
        patch.narrative = narrative.narrative;
        patch.assets = narrative.assets;
        patch.resourceConnections = narrative.resourceConnections;
      }
      try {
        run.platform.agents.updateCognitiveState(run.agent.id, patch);
      } catch (err) {
        if (mustPropagate(err, run.ctx.signal)) throw err;
      }
      await writeReport(run, {
        outcome: r.outcome,
        score: r.score,
        costUsd: (r.plan?.costSoFarUsd ?? 0) + run.costUsd,
        estCostUsd: r.estimateUsd,
        summary: r.summary || r.output,
        lesson: learning.lesson,
        generalizes: learning.generalizes,
        conceptual: learning.conceptual,
      });
    });
    const taskState: Record<string, unknown> = { checkpoint: null };
    if (r.plan) taskState.plan = r.plan;
    if (r.outcome === "completed") return { outcome: "completed", output: r.output, taskState };
    if (r.outcome === "blocked") return { outcome: "blocked", output: r.output, taskState };
    return { outcome: "failed", output: r.output, error: r.error ?? r.summary, taskState };
  }
}

/** Less than Q2_OOD.anotherPassMinTimeShare of the run's time limit left (wall clock since the engine started). */
export function runTimeLow(run: BrainRun): boolean {
  if (!(run.runTimeoutMs > 0)) return false;
  const left = (run.runTimeoutMs - (Date.now() - run.startedMs)) / run.runTimeoutMs;
  return left < Q2_OOD.anotherPassMinTimeShare;
}

/** Has THIS task had setbacks (a failed attempt, an escalation, a rejected or failed plan, a failed/blocked subtask)? */
export function taskSetbacks(run: BrainRun, state: { feedback: string[]; rejected: string[]; revision: number }): boolean {
  const task = run.task;
  if (!task) return true;
  if (task.attempts > 1 || (run.escalation?.count ?? 0) > 0) return true;
  if (state.feedback.length > 0 || state.rejected.length > 0 || state.revision > 0) return true;
  return run.platform.tasks.children(task.id).some((c) => c.status === "failed" || c.status === "blocked" || c.status === "cancelled");
}

/**
 * The side effects an attempt already made, as feedback for the next one ("do not repeat"):
 * a revise used to re-run Solving from scratch and re-write the same memory, file or message.
 */
export function describeEffects(effects: readonly ToolEffect[]): string | null {
  const parts = effects.flatMap((e) => {
    switch (e.kind) {
      case "memory_written":
        return [`memory ${e.memoryId} written`];
      case "file_written":
        return [`file ${e.path} written`];
      case "message_sent":
        return ["a message sent"];
      case "task_created":
        return [`task ${e.taskId} created`];
      case "agent_hired":
        return [`agent ${e.agentId} hired`];
      default:
        return [];
    }
  });
  if (!parts.length) return null;
  return truncate(`Already done by an earlier attempt — do not repeat it; update or build on it instead: ${[...new Set(parts)].join("; ")}.`, 240);
}
