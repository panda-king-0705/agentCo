/**
 * RunService — owns the run lifecycle.
 *
 *   start  : create Run + root `run` span (parentage rules: docs/ARCHITECTURE.md → Traceability),
 *            build the EngineContext, call engines[agent.cognition].run(ctx) with a timeout and an
 *            AbortController that interrupt / pause / destroy / company pause can trigger;
 *   finish : apply the EngineResult (outcome table), report the objective's result to the
 *            conversation that spawned it, post chat replies, update the agent;
 *   boot   : crash recovery (running → interrupted, task → todo with a recovery notice).
 */
import type { Agent, CognitionKind, Message, Run, RunStatus, RunTrigger, Task } from "../../../../packages/shared/src/index.ts";
import type { CognitiveEngine, EngineContext, EngineInput, EngineResult, PlatformServices, SpanHandle } from "../contracts.ts";
import type { Repositories } from "../db/index.ts";
import { newId, newTraceId } from "../db/ids.ts";
import type { EventBus } from "../events/bus.ts";
import { oneLine } from "../events/bus.ts";
import { summaries, taskRef } from "../events/summary.ts";
import { isBudgetExceeded } from "../middleware/budget.ts";
import type { Redactor } from "../middleware/redact.ts";
import { isAbortError, type TracerImpl } from "../middleware/tracer.ts";
import type { OrgService } from "../org/service.ts";
import type { ApprovalService } from "../tasks/approvals.ts";
import type { TaskService } from "../tasks/service.ts";
import type { ContextGovernor } from "../memory/compaction.ts";
import { ABORT_MESSAGES, RunAbortedError, type AbortReason, type RunControl } from "./abort.ts";
import { MAX_MESSAGE_CHARS, type ConversationService } from "./conversations.ts";

export const RECOVERY_NOTICE = (runId: string): string =>
  `Run ${runId} was terminated before it reported a result, so its side effects may be fully applied, partially applied, or absent. ` +
  "Establish the real state (subtasks, files, messages) before acting; do not assume it failed and do not blindly repeat it.";

export interface RunServiceDeps {
  repos: Repositories;
  bus: EventBus;
  tracer: TracerImpl;
  org: OrgService;
  tasks: TaskService;
  conversations: ConversationService;
  approvals: ApprovalService;
  governor: ContextGovernor;
  redactor: Redactor;
  engines: Record<CognitionKind, CognitiveEngine>;
  /** Late-bound (PlatformServices needs the router, which needs the budget gate…). */
  platform: () => PlatformServices;
  runTimeoutMs: number;
  isPaused: () => boolean;
  /** Company-wide cap on concurrent runs (settings.maxConcurrentRuns); absent = uncapped. */
  maxConcurrentRuns?: () => number;
  now: () => Date;
}

interface ActiveRun {
  run: Run;
  agentId: string;
  controller: AbortController;
  reason: AbortReason | null;
  timer: ReturnType<typeof setTimeout> | null;
  span: SpanHandle;
  messageId: string | null;
  objectiveSpanId: string | null;
  promise: Promise<void>;
}

type Outcome = { result: EngineResult } | { error: unknown };

export class RunService implements RunControl {
  private readonly deps: RunServiceDeps;
  private readonly active = new Map<string, ActiveRun>();
  private readonly byAgent = new Map<string, string>();
  private onSettled: (() => void) | null = null;

  constructor(deps: RunServiceDeps) {
    this.deps = deps;
    // A cancelled task aborts its running run (the Board's "cancel" button).
    deps.tasks.onTerminal((task) => {
      if (task.status === "cancelled") this.abortTask(task.id, "interrupt");
    });
    // A task handed to someone else (destroy) must not keep running under its old assignee.
    deps.tasks.onReassign((task) => {
      this.abortTask(task.id, "destroy");
    });
  }

  /** Called after every run settles (the scheduler uses it to start the next piece of work). */
  setSettledHook(hook: () => void): void {
    this.onSettled = hook;
  }

  // ───────────── RunControl / queries ─────────────

  isBusy(agentId: string): boolean {
    return this.byAgent.has(agentId);
  }

  busyAgentIds(): string[] {
    return [...this.byAgent.keys()];
  }

  activeCount(): number {
    return this.active.size;
  }

  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  abortAgent(agentId: string, reason: AbortReason): number {
    const runId = this.byAgent.get(agentId);
    const active = runId ? this.active.get(runId) : undefined;
    if (!active) return 0;
    this.abort(active, reason);
    return 1;
  }

  abortAll(reason: AbortReason): number {
    let n = 0;
    for (const active of this.active.values()) {
      if (!active.reason) n += 1;
      this.abort(active, reason);
    }
    return n;
  }

  abortTask(taskId: string, reason: AbortReason): number {
    let n = 0;
    for (const active of this.active.values()) {
      if (active.run.taskId === taskId) {
        this.abort(active, reason);
        n += 1;
      }
    }
    return n;
  }

  /** Interrupts one run (POST /api/runs/:id/cancel); resolves with the finished run. */
  async cancelRun(runId: string): Promise<Run | null> {
    const active = this.active.get(runId);
    if (!active) return null;
    this.abort(active, "interrupt");
    await active.promise;
    return this.deps.repos.runs.get(runId);
  }

  /** Resolves when no run is active (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()].map((a) => a.promise));
  }

  /** Aborts everything and waits (bounded) for the runs to settle. */
  async shutdown(waitMs = 3000): Promise<void> {
    this.abortAll("shutdown");
    await Promise.race([this.idle(), new Promise((resolve) => setTimeout(resolve, waitMs).unref())]);
  }

  // ───────────── start ─────────────

  /** Starts a run for a ready task, or returns null (agent busy/unavailable, task no longer todo). */
  startTaskRun(task: Task): Run | null {
    const { repos, tasks, org, tracer, bus } = this.deps;
    const agent = task.assigneeId ? org.getAgent(task.assigneeId) : null;
    if (!agent || agent.status === "terminated" || agent.status === "paused" || this.isBusy(agent.id)) return null;
    const fresh = tasks.get(task.id);
    if (!fresh || fresh.status !== "todo") return null;

    const trigger = triggerFor(fresh);
    const answered = typeof fresh.state.answeredApprovalId === "string" ? repos.approvals.get(fresh.state.answeredApprovalId) : null;
    const recovery = fresh.state.recovery as { runId?: string } | undefined;
    let began: Task;
    try {
      began = tasks.begin(fresh.id, trigger);
    } catch {
      return null;
    }
    const parentSpanId = stringOrNull(fresh.state.delegationSpanId) ?? stringOrNull(fresh.state.objectiveSpanId);
    const runId = newId("run");
    const span = tracer.startSpan({
      traceId: began.traceId,
      parentSpanId,
      kind: "run",
      name: `run · ${agent.name} · T-${began.number}`,
      agentId: agent.id,
      runId,
      taskId: began.id,
      input: `${began.title}\n\n${began.description}`,
      attributes: this.runAttributes(agent, trigger),
    });
    let run: Run | null = null;
    try {
      run = this.insertRun(runId, agent, began.traceId, span, trigger, { taskId: began.id, conversationId: null });
      const input: EngineInput = {
        trigger: trigger as Exclude<RunTrigger, "message">,
        task: began,
        subtasks: tasks.children(began.id),
        ...(trigger === "recovery" ? { recoveryNotice: RECOVERY_NOTICE(recovery?.runId ?? "unknown") } : {}),
        ...(answered ? { answeredApproval: answered } : {}),
      };
      bus.emit("run.started", { agentId: agent.id, taskId: began.id, runId, traceId: began.traceId, summary: summaries.runStarted(run, agent), data: run });
      org.setActivity(agent.id, "thinking", `Starting ${taskRef(began)}`, null);
      return this.launch(agent, run, span, input, { messageId: null, objectiveSpanId: null });
    } catch (error) {
      this.abandonStart({ runId, run, span, objective: null, agent, error, taskId: began.id, conversationId: null });
      return null;
    }
  }

  /**
   * Starts a chat run for an unanswered human message, or returns null (agent busy/paused, company
   * paused, or no capacity under maxConcurrentRuns — the message then stays queued and the
   * scheduler, which serves queued chat first, starts it when a slot frees up).
   */
  startMessageRun(message: Message): Run | null {
    const { repos, org, tracer, conversations, bus, governor } = this.deps;
    if (this.deps.isPaused()) return null;
    if (this.deps.maxConcurrentRuns && this.activeCount() >= this.deps.maxConcurrentRuns()) return null;
    const stored = repos.conversations.getMessage(message.id);
    if (!stored || stored.runId !== null || stored.senderId !== "human") return null;
    const conversation = repos.conversations.get(stored.conversationId);
    if (!conversation) return null;
    const agentId = conversations.responderFor(conversation, org.ceo()?.id ?? null);
    const agent = agentId ? org.getAgent(agentId) : null;
    if (!agent || agent.status === "terminated" || agent.status === "paused" || this.isBusy(agent.id)) return null;

    const traceId = newTraceId();
    const objective = tracer.startSpan({
      traceId,
      parentSpanId: null,
      kind: "objective",
      name: `chat: ${oneLine(stored.content, 60)}`,
      agentId: agent.id,
      input: stored.content,
      attributes: { "agentco.conversation.id": conversation.id, "agentco.conversation.kind": conversation.kind },
    });
    const runId = newId("run");
    const span = tracer.startSpan({
      traceId,
      parentSpanId: objective.spanId,
      kind: "run",
      name: `run · ${agent.name} · chat`,
      agentId: agent.id,
      runId,
      input: stored.content,
      attributes: this.runAttributes(agent, "message"),
    });
    let run: Run | null = null;
    try {
      run = this.insertRun(runId, agent, traceId, span, "message", { taskId: null, conversationId: conversation.id });
      conversations.attachRun(stored.id, runId, traceId);
      const window = this.deps.platform().models.resolve(agent.modelTier, agent.modelOverride).contextWindow;
      const history = governor.govern(conversation, repos.conversations.historyThrough(conversation.id, stored.id), window, span);
      const input: EngineInput = { trigger: "message", history, message: { ...stored, runId, traceId } };
      bus.emit("run.started", { agentId: agent.id, runId, traceId, summary: summaries.runStarted(run, agent), data: run });
      org.setActivity(agent.id, "thinking", `Reading a message in ${conversation.title}`, null);
      return this.launch(agent, run, span, input, { messageId: stored.id, objectiveSpanId: objective.spanId });
    } catch (error) {
      this.abandonStart({ runId, run, span, objective, agent, error, taskId: null, conversationId: conversation.id });
      return null;
    }
  }

  /**
   * Something threw while a run was being started (after its span and maybe its row exist):
   * fail it cleanly — run row failed, spans closed, the agent freed, and the work answered:
   * a chat gets an error reply (the message stays answered, no retry loop), a task a failed attempt.
   */
  private abandonStart(o: { runId: string; run: Run | null; span: SpanHandle; objective: SpanHandle | null; agent: Agent; error: unknown; taskId: string | null; conversationId: string | null }): void {
    const { repos, tracer, org, bus, conversations, tasks } = this.deps;
    const message = this.deps.redactor.redact(`could not start the run: ${errorText(o.error)}`);
    console.error(`[runs] ${message}`);
    const active = this.active.get(o.runId);
    if (active?.timer) clearTimeout(active.timer);
    this.active.delete(o.runId);
    if (this.byAgent.get(o.agent.id) === o.runId) this.byAgent.delete(o.agent.id);
    const step = (fn: () => void): void => {
      try {
        fn();
      } catch (stepError) {
        console.error("[runs] cleanup step failed:", stepError instanceof Error ? stepError.message : stepError);
      }
    };
    step(() => {
      for (const open of repos.spans.runningForRun(o.runId)) if (open.id !== o.span.spanId) tracer.endById(open.id, { status: "cancelled", error: message });
    });
    step(() => o.span.end({ status: "error", error: message }));
    step(() => o.objective?.end({ status: "error", error: message }));
    if (o.run) {
      step(() => repos.runs.update(o.runId, { status: "failed", error: message, failingSpanId: o.span.spanId, completedAt: this.deps.now().toISOString() }));
    }
    step(() => repos.agents.update(o.agent.id, { currentRunId: null, currentTaskId: null, brainBlock: null }));
    step(() => org.setActivity(o.agent.id, "error", null, null));
    if (o.conversationId) step(() => conversations.postAs(o.conversationId as string, o.agent.id, `I hit an error: ${message}`, o.run ? { runId: o.runId, traceId: o.run.traceId } : {}));
    if (o.taskId) {
      step(() => {
        const task = tasks.get(o.taskId as string);
        if (task?.status === "in_progress") tasks.fail(task.id, message);
      });
    }
    if (o.run) {
      step(() => {
        const finished = repos.runs.get(o.runId);
        bus.emit("run.completed", { agentId: o.agent.id, taskId: o.taskId, runId: o.runId, traceId: o.run!.traceId, summary: `${o.agent.name}'s run failed to start`, data: finished });
      });
    }
  }

  // ───────────── crash recovery ─────────────

  /** Boot: every run left running/queued becomes interrupted; its task returns to todo with a recovery notice. */
  recoverOnBoot(): number {
    const { repos, tasks, tracer, bus, org, conversations } = this.deps;
    const at = this.deps.now().toISOString();
    const unfinished = repos.runs.unfinished();
    for (const run of unfinished) {
      const failing = repos.spans.firstErrorInRun(run.id)?.id ?? null;
      for (const span of repos.spans.runningForRun(run.id)) {
        tracer.endById(span.id, { status: "cancelled", error: "interrupted: the server stopped before this step finished" });
      }
      const root = repos.spans.get(run.rootSpanId);
      if (root?.parentSpanId && !run.taskId) tracer.endById(root.parentSpanId, { status: "cancelled", output: "interrupted by a restart" });
      repos.runs.update(run.id, { status: "interrupted", error: "Run interrupted by a server restart", failingSpanId: failing, completedAt: at });
      if (run.taskId) {
        const task = tasks.get(run.taskId);
        if (task?.status === "in_progress") tasks.recover(task.id, run.id);
      } else if (run.conversationId) {
        const message = [...repos.conversations.messages(run.conversationId, { limit: 200 })].reverse().find((m) => m.runId === run.id);
        if (message) conversations.attachRun(message.id, null); // answered again by a fresh run
      }
      const agent = org.getAgent(run.agentId);
      bus.emit("run.completed", { agentId: run.agentId, taskId: run.taskId, runId: run.id, traceId: run.traceId, summary: `${agent?.name ?? run.agentId}'s run interrupted by a restart`, data: repos.runs.get(run.id) });
    }
    for (const agent of repos.agents.list({ includeTerminated: false })) {
      if (agent.status === "paused") continue;
      if (agent.status !== "idle" || agent.currentRunId || agent.currentTaskId || agent.brainBlock) {
        repos.agents.update(agent.id, { status: "idle", activity: null, brainBlock: null, currentRunId: null, currentTaskId: null });
      }
    }
    return unfinished.length;
  }

  // ───────────── execution ─────────────

  private launch(agent: Agent, run: Run, span: SpanHandle, input: EngineInput, extra: { messageId: string | null; objectiveSpanId: string | null }): Run {
    const controller = new AbortController();
    const active: ActiveRun = { run, agentId: agent.id, controller, reason: null, timer: null, span, ...extra, promise: Promise.resolve() };
    this.active.set(run.id, active);
    this.byAgent.set(agent.id, run.id);
    this.deps.repos.agents.update(agent.id, { currentRunId: run.id, currentTaskId: run.taskId });
    active.timer = setTimeout(() => this.abort(active, "timeout"), this.deps.runTimeoutMs);
    active.timer.unref();
    const ctx: EngineContext = { agent, run, input, platform: runScoped(this.deps.platform(), controller.signal), span, signal: controller.signal };
    active.promise = this.execute(active, agent, ctx);
    return run;
  }

  private async execute(active: ActiveRun, agent: Agent, ctx: EngineContext): Promise<void> {
    let outcome: Outcome;
    try {
      const engine = this.deps.engines[agent.cognition];
      if (!engine) throw new Error(`no ${agent.cognition} engine is registered`);
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new RunAbortedError(active.reason ?? "interrupt"));
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });
      });
      aborted.catch(() => {});
      const work = engine.run(ctx);
      work.catch(() => {}); // a late rejection after an abort must not become an unhandled rejection
      outcome = { result: await Promise.race([work, aborted]) };
    } catch (error) {
      outcome = { error };
    }
    try {
      this.finish(active, outcome);
    } catch (error) {
      console.error(`[runs] failed to finish run ${active.run.id}:`, error instanceof Error ? error.stack : error);
      this.forceClose(active, error);
    } finally {
      if (active.timer) clearTimeout(active.timer);
      this.active.delete(active.run.id);
      if (this.byAgent.get(active.agentId) === active.run.id) this.byAgent.delete(active.agentId);
      try {
        this.onSettled?.();
      } catch {
        // the hook is a wake-up only
      }
    }
  }

  private abort(active: ActiveRun, reason: AbortReason): void {
    if (active.reason || active.controller.signal.aborted) return;
    active.reason = reason;
    active.controller.abort(new RunAbortedError(reason));
  }

  // ───────────── applying results ─────────────

  private finish(active: ActiveRun, outcome: Outcome): void {
    const { repos, tracer, bus, org } = this.deps;
    const { run } = active;
    const reason = active.reason;
    const agent = org.getAgent(run.agentId);
    const result = "result" in outcome ? outcome.result : null;
    const thrown = "error" in outcome ? outcome.error : null;

    let status: RunStatus;
    let output: string | null = null;
    let error: string | null = null;
    if (reason) {
      status = reason === "timeout" ? "failed" : reason === "shutdown" ? "interrupted" : "cancelled";
      error = ABORT_MESSAGES[reason];
    } else if (thrown !== null) {
      status = "failed";
      error = errorText(thrown);
    } else if (result) {
      status = result.outcome === "failed" ? "failed" : "completed";
      output = this.deps.redactor.redact(result.output ?? "");
      if (result.outcome === "failed") error = this.deps.redactor.redact(result.error ?? (result.output || "the engine reported a failure"));
    } else {
      status = "failed";
      error = "the engine returned no result";
    }
    if (error) error = this.deps.redactor.redact(error);

    // Apply to the task or the conversation (the run row is already final in spirit; spans close below).
    let agentStatus: Agent["status"] = status === "failed" ? "error" : "idle";
    try {
      if (run.taskId) agentStatus = this.applyToTask(active, agent, reason, result, thrown, output, error) ?? agentStatus;
      else this.applyToConversation(active, agent, reason, thrown, output, error);
    } catch (applyError) {
      console.error(`[runs] applying the result of ${run.id} failed:`, applyError instanceof Error ? applyError.stack : applyError);
      status = "failed";
      error = error ?? errorText(applyError);
    }

    // Glass Box: name the first errored step *before* the root span is closed.
    const failingSpanId = status === "failed" ? (repos.spans.firstErrorInRun(run.id)?.id ?? run.rootSpanId) : null;
    for (const span of repos.spans.runningForRun(run.id)) {
      if (span.id === run.rootSpanId) continue;
      tracer.endById(span.id, { status: "cancelled", error: "step was still open when the run ended" });
    }
    const spanStatus = status === "completed" ? "ok" : status === "failed" ? "error" : "cancelled";
    active.span.end({ status: spanStatus, output: output ?? error ?? status, ...(error ? { error } : {}) });
    if (active.objectiveSpanId) this.closeChatObjective(active, spanStatus);

    const completedAt = this.deps.now().toISOString();
    repos.runs.update(run.id, { status, output, error, failingSpanId, completedAt });
    const finished = repos.runs.get(run.id) as Run;
    if (agent && agent.status !== "terminated") {
      repos.agents.update(agent.id, { currentRunId: null, currentTaskId: null, brainBlock: null });
      org.setActivity(agent.id, agentStatus, null, null);
    }
    bus.emit("run.completed", {
      agentId: run.agentId,
      taskId: run.taskId,
      runId: run.id,
      traceId: run.traceId,
      summary: agent ? summaries.runCompleted(finished, agent) : `run ${finished.status}`,
      data: finished,
    });
  }

  /** Returns the agent status to show after the run (null = default from the run status). */
  private applyToTask(
    active: ActiveRun,
    agent: Agent | null,
    reason: AbortReason | null,
    result: EngineResult | null,
    thrown: unknown,
    output: string | null,
    error: string | null,
  ): Agent["status"] | null {
    const { tasks, repos, approvals } = this.deps;
    const { run } = active;
    const task = tasks.get(run.taskId as string);
    if (!task || task.status !== "in_progress") return null; // cancelled, re-assigned (destroy) or finished elsewhere
    if (reason) {
      switch (reason) {
        case "interrupt":
          tasks.cancel(task.id, "Interrupted by the Board");
          break;
        case "pause":
        case "company_pause":
          tasks.requeue(task.id, task.state.lastTrigger === "subtasks_completed" ? { nextTrigger: "subtasks_completed" } : {});
          break;
        case "shutdown":
          tasks.recover(task.id, run.id);
          break;
        case "timeout":
          this.failTask(task, error ?? "Run timed out", agent, run);
          return "error";
        case "destroy":
          break;
      }
      return "idle";
    }
    if (thrown !== null) {
      if (isBudgetExceeded(thrown)) {
        const approval = approvals.requestBudgetIncrease({
          scope: thrown.scope,
          period: thrown.period ?? "daily",
          limitUsd: thrown.limitUsd,
          spentUsd: thrown.spentUsd,
          agentId: run.agentId,
          departmentId: thrown.departmentId ?? agent?.departmentId ?? null,
          taskId: task.id,
          traceId: task.traceId,
        });
        tasks.block(task.id, approval.id, { budgetBlocked: true });
        return "blocked";
      }
      this.failTask(task, error ?? errorText(thrown), agent, run);
      return "error";
    }
    if (!result) return null;
    const state = result.taskState;
    switch (result.outcome) {
      case "completed": {
        const text = output || `${taskRef(task)} is complete.`;
        tasks.complete(task.id, text, state);
        if (!task.parentTaskId && task.originConversationId && agent) this.report(task, agent, run, text);
        return "idle";
      }
      case "yielded":
        tasks.yieldBack(task.id, state);
        return "idle";
      case "waiting":
        tasks.waitOnChildren(task.id, state);
        return "waiting";
      case "blocked": {
        const approvalId = result.approvalId ?? repos.approvals.forTask(task.id).filter((a) => a.status === "pending").at(-1)?.id;
        if (!approvalId) {
          this.failTask(task, "the engine reported blocked without opening an approval", agent, run, state);
          return "error";
        }
        tasks.block(task.id, approvalId, state);
        this.announceQuestion(task, approvalId, agent, run);
        return "blocked";
      }
      case "failed":
        this.failTask(task, error ?? "the engine reported a failure", agent, run, state);
        return "error";
    }
    return null;
  }

  private failTask(task: Task, error: string, agent: Agent | null, run: Run, state?: Record<string, unknown>): void {
    const failed = this.deps.tasks.fail(task.id, error, state);
    if (failed.status === "failed" && !failed.parentTaskId && failed.originConversationId && agent) {
      this.report(failed, agent, run, `I could not complete ${taskRef(failed)}: ${error}`);
    }
  }

  /**
   * A Board question raised under an objective that came from a conversation is posted there once,
   * so the Board sees it where it asked — and a reply in that conversation answers it
   * (ApprovalService.answerFromConversation).
   */
  private announceQuestion(task: Task, approvalId: string, agent: Agent | null, run: Run): void {
    const { repos, conversations } = this.deps;
    const approval = repos.approvals.get(approvalId);
    if (!approval || approval.kind !== "question" || approval.status !== "pending" || approval.payload.conversationId || !agent) return;
    const root = task.rootTaskId === task.id ? task : repos.tasks.get(task.rootTaskId);
    const conversationId = root?.originConversationId;
    if (!conversationId) return;
    try {
      repos.approvals.update(approvalId, { payload: { ...approval.payload, conversationId } });
      const question = typeof approval.payload.question === "string" ? approval.payload.question : approval.summary;
      conversations.postAs(conversationId, agent.id, `Question for the Board on ${taskRef(task)}: ${question}\n\nReply here to answer it (or use Approvals).`.slice(0, MAX_MESSAGE_CHARS), {
        runId: run.id,
        taskId: task.id,
        traceId: task.traceId,
      });
    } catch (error) {
      console.error("[runs] could not post the Board question:", error instanceof Error ? error.message : error);
    }
  }

  /** The assignee's final word on a root objective, posted to the conversation that spawned it. */
  private report(task: Task, agent: Agent, run: Run, text: string): void {
    try {
      this.deps.conversations.postAs(task.originConversationId as string, agent.id, text.slice(0, MAX_MESSAGE_CHARS), { runId: run.id, taskId: task.id, traceId: task.traceId });
    } catch (error) {
      console.error("[runs] could not post the objective report:", error instanceof Error ? error.message : error);
    }
  }

  private applyToConversation(active: ActiveRun, agent: Agent | null, reason: AbortReason | null, thrown: unknown, output: string | null, error: string | null): void {
    const { conversations, approvals } = this.deps;
    const { run } = active;
    if (!agent || !run.conversationId) return;
    const reply = (text: string): void => {
      conversations.postAs(run.conversationId as string, agent.id, text.slice(0, MAX_MESSAGE_CHARS), { runId: run.id, traceId: run.traceId });
    };
    if (reason) {
      // An abort that is not the message's fault puts it back in the queue; destroy/interrupt leave it answered.
      if ((reason === "pause" || reason === "company_pause" || reason === "shutdown") && active.messageId) conversations.attachRun(active.messageId, null);
      else if (reason === "timeout") reply(`I hit an error: ${error ?? "the run timed out"}`);
      return;
    }
    if (thrown !== null) {
      if (isBudgetExceeded(thrown)) {
        const approval = approvals.requestBudgetIncrease({
          scope: thrown.scope,
          period: thrown.period ?? "daily",
          limitUsd: thrown.limitUsd,
          spentUsd: thrown.spentUsd,
          agentId: run.agentId,
          departmentId: thrown.departmentId ?? agent.departmentId,
          taskId: null,
          traceId: run.traceId,
        });
        reply(`I hit an error: ${error ?? "budget exhausted"}. I asked the Board to raise the limit (approval ${approval.id}).`);
        return;
      }
      reply(`I hit an error: ${error ?? errorText(thrown)}`);
      return;
    }
    if (error) reply(`I hit an error: ${error}`);
    else reply(output && output.trim() ? output : "(no reply)");
  }

  /** The chat's trace-root objective span ends with the run unless an objective it spawned is still open. */
  private closeChatObjective(active: ActiveRun, status: "ok" | "error" | "cancelled"): void {
    const roots = this.deps.repos.tasks.list({ traceId: active.run.traceId, parentTaskId: null });
    if (roots.some((t) => t.status !== "done" && t.status !== "failed" && t.status !== "cancelled")) return;
    this.deps.tracer.endById(active.objectiveSpanId as string, { status, output: status === "ok" ? "answered" : status });
  }

  /** Last resort when finish() itself threw: never leave the run, its span or the agent stuck. */
  private forceClose(active: ActiveRun, error: unknown): void {
    const { repos, tracer } = this.deps;
    try {
      tracer.endById(active.run.rootSpanId, { status: "error", error: errorText(error) });
      repos.runs.update(active.run.id, { status: "failed", error: errorText(error), completedAt: this.deps.now().toISOString() });
      repos.agents.update(active.agentId, { currentRunId: null, currentTaskId: null, status: "error", brainBlock: null });
    } catch {
      // nothing more can be done
    }
  }

  private insertRun(runId: string, agent: Agent, traceId: string, span: SpanHandle, trigger: RunTrigger, link: { taskId: string | null; conversationId: string | null }): Run {
    const at = this.deps.now().toISOString();
    const run: Run = {
      id: runId,
      agentId: agent.id,
      taskId: link.taskId,
      conversationId: link.conversationId,
      traceId,
      rootSpanId: span.spanId,
      trigger,
      engine: agent.cognition,
      status: "running",
      output: null,
      error: null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      costUsd: 0,
      llmCalls: 0,
      toolCalls: 0,
      failingSpanId: null,
      startedAt: at,
      completedAt: null,
      createdAt: at,
    };
    this.deps.repos.runs.insert(run);
    return run;
  }

  private runAttributes(agent: Agent, trigger: RunTrigger) {
    return {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": agent.id,
      "gen_ai.agent.name": agent.name,
      "agentco.trigger": trigger,
      "agentco.engine": agent.cognition,
      "agentco.tier": agent.modelTier,
    };
  }
}

/**
 * The PlatformServices one run's engine sees. Once the run is aborted its result is already
 * applied (or deliberately dropped) by RunService, but the engine may still be unwinding:
 * from then on its status/activity and cognitive-state writes and its task-state patches are
 * ignored, and it cannot open new objectives (models.chat and tools.execute already refuse).
 */
export function runScoped(platform: PlatformServices, signal: AbortSignal): PlatformServices {
  const { agents, tasks } = platform;
  const abortError = (): Error => (signal.reason instanceof Error ? signal.reason : new RunAbortedError("interrupt"));
  return {
    ...platform,
    agents: {
      setActivity(agentId, status, activity, block) {
        if (signal.aborted) return;
        agents.setActivity(agentId, status, activity, block);
      },
      updateCognitiveState(agentId, patch) {
        if (signal.aborted) throw abortError();
        return agents.updateCognitiveState(agentId, patch);
      },
    },
    tasks: {
      get: (id) => tasks.get(id),
      children: (id) => tasks.children(id),
      interruptFor: (agentId, priority) => tasks.interruptFor(agentId, priority),
      createObjective(input) {
        if (signal.aborted) throw abortError();
        return tasks.createObjective(input);
      },
      patchState(taskId, patch) {
        if (signal.aborted) {
          const current = tasks.get(taskId);
          if (current) return current;
        }
        return tasks.patchState(taskId, patch);
      },
      cancel(taskId, reason) {
        if (signal.aborted) return;
        tasks.cancel(taskId, reason);
      },
    },
  };
}

/** Trigger of the next run: recovery notice > explicit nextTrigger > plain task. */
export function triggerFor(task: Task): RunTrigger {
  if (task.state.recovery) return "recovery";
  const next = task.state.nextTrigger;
  if (next === "subtasks_completed" || next === "human_answer" || next === "heartbeat" || next === "task") return next;
  return "task";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function errorText(error: unknown): string {
  if (isAbortError(error)) return error instanceof Error ? error.message : "aborted";
  return error instanceof Error ? error.message : String(error);
}
