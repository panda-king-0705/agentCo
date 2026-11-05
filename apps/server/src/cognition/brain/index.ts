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
import type { Agent, Approval, CalibrationStats, Okr, Task } from "../../../../../packages/shared/src/index.ts";
import type { CognitiveEngine, CognitiveStatePatch, EngineContext, EngineResult, SpanHandle } from "../../contracts.ts";
import { arr, num, obj, str, strArr } from "../coerce.ts";
import { agentFacts } from "../prompt.ts";
import { oneLine, truncate } from "../text.ts";
import { writeReport } from "./global-memory.ts";
import { CANDIDATE_NAMES, Q2_OOD, Q3_FALLBACK, Q4_CONTROL, type CandidateName } from "./interpretation.ts";
import { assessConfidence, fallbackTarget, shouldEarlyStop, type ConfidenceAssessment, type FallbackTarget } from "./metacognition/confidence.ts";
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
import { feedback, integrateResults, solving, type FeedbackResult } from "./metacognition/solving-evaluation.ts";
import { analysis, literatureReview, problemDefinition, requestText, type ProblemDefinition, type Understanding } from "./metacognition/target-understanding.ts";
import { block, llmText, mustPropagate, phase, toolContext, YieldSignal, type BrainRun } from "./runtime.ts";
import { feedbackUpdate } from "./self-management/emotion.ts";
import { eventsFromSubtasks, type ProcessEvent } from "./self-management/human-nature.ts";
import { computeDrives, selfManagementPass } from "./self-management/identity.ts";
import { isAligned, okrProgress, proposeFromOkrs } from "./self-management/okr.ts";
import { generateNarrative, narrativeDue } from "./self-management/self-narrative.ts";
import { checkpointState, interruptCheck, selectSubprocess, type Checkpoint } from "./todo-list.ts";

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
      parent: null,
      currentBlock: null,
    };
    try {
      if (input.trigger === "message") return await this.onMessage(run);
      return await this.onTask(run);
    } catch (err) {
      if (err instanceof YieldSignal) {
        ctx.span.setAttributes({ "agentco.yielded_before": err.nextBlock, "agentco.yield_reason": truncate(err.reason, 200) });
        return {
          outcome: "yielded",
          output: `Paused T-${task?.number ?? "?"} at ${err.nextBlock} for more urgent work (${oneLine(err.reason, 120)}); will resume from here.`,
          taskState: checkpointState(run, err),
        };
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

    if (problem.intent === "work") {
      const task = await block(run, "todo_list", "Adding the request to my TODO list", (span) => {
        const t = run.platform.tasks.createObjective({
          title: problem.title,
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
      return { outcome: "completed", output: `Opened T-${task.number}: ${task.title}. I'll work it through with the team and report back here when it's done.` };
    }

    const reply = await block(run, "metacognition.solving_evaluation.solving", "Writing a reply", (span) =>
      llmText(run, {
        stage: "chat.reply",
        span,
        instructions:
          `${requestText(run)}\n\nWhat you know:\n${literature.slice(0, 6).join("\n") || "(nothing specific)"}\n\n` +
          "Reply to the latest message in your own voice: brief, specific, honest about what you don't know. If they want work done, say you'll open a task.",
        context: { mode: "message", message: input.message.content, agent: { name: run.agent.name, title: run.agent.title, department: run.facts.department } },
        maxOutputTokens: 400,
      }),
    );
    return { outcome: "completed", output: reply || "Noted — I'll follow up." };
  }

  // ───────────────────────────── Task triggers ─────────────────────────────

  private async onTask(run: BrainRun): Promise<EngineResult> {
    const input = run.ctx.input;
    if (input.trigger === "message") throw new Error("unreachable");
    const task = input.task;
    const selection = await selectSubprocess(run);
    await phase(run, "self_management", () => selfManagementPass(run));

    if (selection.entry === "heartbeat") return this.heartbeat(run);

    let plan = readPlan(task);
    if (selection.entry === "human_answer" && input.answeredApproval) {
      const a: Approval = input.answeredApproval;
      const answers = [...arr(task.state.answers), { approvalId: a.id, status: a.status, note: a.note }].slice(-5);
      run.platform.tasks.patchState(task.id, { answers });
    }
    if (selection.entry === "resume" && selection.checkpoint) {
      run.wm = { ...selection.checkpoint.wm };
      run.ctx.span.setAttributes({ "agentco.resumed_at": selection.checkpoint.block });
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
      const answered = children.filter((c) => c.state.kind === "escalation" && ["done", "failed", "cancelled"].includes(c.status));
      if (cp && cp.reason === ESCALATION_CHECKPOINT && answered.length > 0) {
        const good = answered.filter((c) => c.status === "done");
        if (good.length === 0) {
          const why = answered.map((c) => c.error ?? c.result ?? c.status).join("; ");
          run.platform.tasks.patchState(task.id, { checkpoint: null });
          return { outcome: "failed", output: "", error: `My manager could not answer the escalation on T-${task.number}: ${truncate(why, 300)}`, taskState: { checkpoint: null } };
        }
        const answer = good.map((c) => c.result ?? "").filter(Boolean).join("\n").trim() || "Proceed with your best judgment.";
        run.wm = { ...cp.wm, escalationAnswer: answer };
        run.ctx.span.setAttributes({ "agentco.resumed_at": cp.block, "agentco.escalation.answered": good.length });
        run.platform.tasks.patchState(task.id, { checkpoint: null });
        const other = children.filter((c) => c.state.kind !== "escalation");
        if (other.length > 0 && plan.subprocesses.length > 0) {
          // Escalated while evaluating subtask results: re-evaluate them with the guidance in hand.
          return this.evaluateSubprocesses(run, { ...plan, feedback: [...plan.feedback, `Guidance from my manager: ${truncate(answer, 400)}`].slice(-8) }, other);
        }
        return this.fullPass(run, plan, {
          feedback: [...plan.feedback, `Guidance from my manager: ${truncate(answer, 400)}`].slice(-8),
          rejected: plan.rejected,
          revision: plan.revision,
          boardApproved: true,
          managerAnswered: true,
        });
      }
      return this.evaluateSubprocesses(run, plan, children);
    }

    return this.fullPass(run, selection.entry === "fresh" ? null : plan, {
      feedback: plan?.feedback ?? [],
      rejected: plan?.rejected ?? [],
      revision: plan?.revision ?? 0,
      boardApproved: selection.entry === "human_answer" && input.answeredApproval?.status === "approved",
    });
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

  /** Target Understanding → Self-ability → OOD → Confidence ⇄ Fallback (evaluation). Cached in wm for resume. */
  private async understand(run: BrainRun): Promise<Understood> {
    const task = run.task!;
    interruptCheck(run, "metacognition.target_understanding.problem_definition");
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
      run.wm.understanding = understanding;
      run.ctx.span.setAttributes({ "agentco.confidence": confidence.calibrated, "agentco.fallbacks": [...used].join(",") || "none" });
      return { problem, literature, understanding, competence, ood, confidence };
    });
  }

  /** A full Metacognition pass (fresh, resumed, re-planned after a human answer or recovery). */
  private async fullPass(
    run: BrainRun,
    prior: PersistedPlan | null,
    state: { feedback: string[]; rejected: CandidateName[]; revision: number; boardApproved?: boolean; managerAnswered?: boolean },
  ): Promise<EngineResult> {
    const task = run.task!;
    const u = await this.understand(run);

    // Early Stop? (the Board's explicit go-ahead overrides a low-confidence stop once).
    const stop = shouldEarlyStop(u.confidence.calibrated, run.drives);
    // A manager's answer to this very escalation settles it even through the frustration gate (no re-escalation loop).
    if (stop.stop && !(state.managerAnswered || (state.boardApproved && !run.drives.frustrationGate))) {
      return this.escalateOutcome(run, `Early stop on T-${task.number}: ${stop.reason}. Risks: ${u.confidence.risks.join("; ") || "unclear"}`, u.confidence.calibrated);
    }

    const existingTitles = run.platform.tasks
      .children(task.id)
      .filter((c) => c.status !== "failed" && c.status !== "cancelled")
      .map((c) => c.title);
    let feedbackIssues = [...state.feedback];
    let rejected = [...state.rejected];
    let revision = state.revision;
    const maxRevisions = run.drives.conservation ? 0 : run.maxRevisions;

    for (let attempt = 0; attempt < maxRevisions + CANDIDATE_NAMES.length + 1; attempt++) {
      interruptCheck(run, "metacognition.cognitive_control.decomposition");
      const planned = await this.planPhase(run, u, feedbackIssues, rejected);
      const persisted = this.persist(run, u, planned.control, planned.chosen, revision, rejected, feedbackIssues, prior);
      run.platform.tasks.patchState(task.id, { plan: persisted, checkpoint: null });

      interruptCheck(run, "metacognition.solving_evaluation.solving");
      const solution = await phase(run, "solving", () =>
        solving(run, {
          mode: planned.control.mode,
          subprocesses: planned.control.subprocesses,
          candidate: planned.chosen,
          problem: u.problem.problem,
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

      const fb = await phase(run, "evaluation", () =>
        feedback(run, {
          problem: u.problem.problem,
          successCriteria: u.problem.successCriteria,
          solution: solution.kind === "solution" ? solution.text : null,
          subtasks: [],
          controlLevel: planned.control.controlLevel,
          estimateUsd: persisted.estimateUsd,
          actualCostUsd: run.costUsd,
          revisionsLeft: Math.max(0, maxRevisions - revision),
          rollbackAvailable: rejected.length < CANDIDATE_NAMES.length - 1,
          canEscalate: this.canEscalate(run.agent),
        }),
      );
      if (fb.decision === "accept") {
        return this.report(run, { outcome: "completed", output: solution.text, score: fb.score, summary: fb.summary, predicted: u.confidence.calibrated, events: [], estimateUsd: persisted.estimateUsd, plan: { ...persisted, feedback: [] } });
      }
      if (fb.decision === "escalate") return this.escalateOutcome(run, `Result for T-${task.number} not acceptable: ${fb.issues.join("; ") || fb.summary}`, u.confidence.calibrated);
      if (fb.decision === "rollback") {
        await rollbackRecovery(run, `rollback of candidate ${planned.chosen}`);
        rejected = [...rejected, planned.chosen];
        const next = nextCandidate(planned.chosen, rejected);
        if (!next) break;
        feedbackIssues = fb.issues;
        continue;
      }
      // revise → Reflection / Replanning → back into Cognitive Control with the feedback.
      revision++;
      feedbackIssues = await reflectionReplanning(run, fb.issues, fb.summary);
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
    const finished = children.filter((c) => ["done", "failed", "cancelled", "blocked"].includes(c.status));
    const events: ProcessEvent[] = eventsFromSubtasks(finished);
    const maxRevisions = run.drives.conservation ? 0 : run.maxRevisions;
    const fb: FeedbackResult = await phase(run, "evaluation", () =>
      feedback(run, {
        problem: plan.problem,
        successCriteria: plan.successCriteria,
        solution: null,
        subtasks: children,
        controlLevel: plan.controlLevel,
        estimateUsd: plan.estimateUsd,
        actualCostUsd: children.reduce((n, c) => n + (c.actualCostUsd ?? 0), 0) + plan.costSoFarUsd + run.costUsd,
        revisionsLeft: Math.max(0, maxRevisions - plan.revision),
        rollbackAvailable: plan.rejected.length < CANDIDATE_NAMES.length - 1,
        canEscalate: this.canEscalate(run.agent),
      }),
    );
    if (fb.decision === "accept") {
      const output = integrateResults(task.title, fb.summary, children, run.agent.name);
      return this.report(run, { outcome: "completed", output, score: fb.score, summary: fb.summary, predicted: plan.confidence, events, estimateUsd: plan.estimateUsd, plan: { ...plan, feedback: [] } });
    }
    if (fb.decision === "escalate") return this.escalateOutcome(run, `Subtasks of T-${task.number} fell short: ${fb.issues.join("; ") || fb.summary}`, plan.confidence, events);
    if (fb.decision === "rollback") {
      await rollbackRecovery(run, `rollback of candidate ${plan.chosen}: ${fb.issues.join("; ")}`, { cancelOpen: true });
      return this.fullPass(run, plan, { feedback: fb.issues, rejected: [...plan.rejected, plan.chosen], revision: plan.revision });
    }
    const issues = await reflectionReplanning(run, fb.issues, fb.summary);
    return this.fullPass(run, plan, { feedback: issues, rejected: plan.rejected, revision: plan.revision + 1 });
  }

  private canEscalate(agent: Agent): boolean {
    return agent.tools.includes("escalate") || agent.tools.includes("ask_human");
  }

  /**
   * Early stop / escalate decision. A manager's escalate tool creates an escalation subtask for
   * ITS manager: outcome "waiting" with a checkpoint, resumed by subtasks_completed. The CEO
   * (no manager) asks the Board: outcome "blocked" on the question approval.
   */
  private async escalateOutcome(run: BrainRun, reason: string, predicted: number, events: ProcessEvent[] = []): Promise<EngineResult> {
    const task = run.task!;
    const esc = await block(run, "metacognition.confidence", "Early stop: escalating", async (span) => {
      span.setAttributes({ "agentco.early_stop": true, "agentco.early_stop.reason": truncate(reason, 300) });
      return this.escalate(run, reason, span);
    });
    const approvalId = esc.approvalId;
    const plan = readPlan(task);
    const result = await this.report(run, {
      outcome: "blocked",
      output: `I need guidance on T-${task.number} "${task.title}": ${reason}`,
      score: 0.3,
      summary: reason,
      predicted,
      events: [...events, { outcome: "escalated", source: "own", recognizedBy: "self" }],
      estimateUsd: plan?.estimateUsd ?? task.estCostUsd,
      plan,
    });
    if (esc.subtaskId) {
      const checkpoint: Checkpoint = { block: "metacognition.confidence", reason: ESCALATION_CHECKPOINT, at: run.platform.now().toISOString(), wm: run.wm };
      return {
        outcome: "waiting",
        output: `Escalated T-${task.number} to my manager and waiting for the answer: ${reason}`,
        taskState: { ...result.taskState, checkpoint },
      };
    }
    if (!approvalId) return { outcome: "failed", output: "", error: `Escalated without an approval or subtask to wait on: ${reason}`, taskState: result.taskState };
    return { ...result, approvalId };
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
      const affect = await feedbackUpdate(run, [...r.events, ...own], { openItems, consecutiveRuns: 1 });
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

