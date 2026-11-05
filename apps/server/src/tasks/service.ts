/**
 * TaskService — the company TODO list and its state machine:
 *
 *   todo ──▶ in_progress ──▶ done | failed
 *                │  ├──▶ waiting ──all children terminal──▶ todo (trigger subtasks_completed)
 *                │  └──▶ blocked ──approval decided──▶ todo (trigger human_answer)
 *                └──(interrupt/cancel)──▶ cancelled
 *
 * Priority = value / max(estCostUsd, 0.01). Root tasks get a fresh traceId and
 * an `objective` span; subtasks inherit the trace. Platform-owned keys in
 * task.state: objectiveSpanId, delegationSpanId, nextTrigger, recovery,
 * blockedOnApprovalId, answeredApprovalId, emptyWaits.
 */
import type { Approval, CreateTaskInput, RunTrigger, Task, TaskStatus } from "../../../../packages/shared/src/index.ts";
import type { CreateObjectiveInput, TaskView } from "../contracts.ts";
import type { Repositories } from "../db/index.ts";
import { newId, newTraceId } from "../db/ids.ts";
import type { EventBus } from "../events/bus.ts";
import { summaries, taskRef } from "../events/summary.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";
import type { Redactor } from "../middleware/redact.ts";
import type { TracerImpl } from "../middleware/tracer.ts";
import type { OrgService } from "../org/service.ts";
import type { ConversationService } from "../runs/conversations.ts";
import type { TaskFilter } from "../db/repo-work.ts";

export const TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "failed", "cancelled"]);
export const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_VALUE = 100;
const DEFAULT_EST_COST = 0.05;

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress", "cancelled", "blocked"],
  in_progress: ["done", "failed", "waiting", "blocked", "todo", "cancelled"],
  waiting: ["todo", "cancelled", "done", "failed"],
  blocked: ["todo", "cancelled"],
  done: [],
  failed: ["todo"],
  cancelled: ["todo"],
};

export function computePriority(value: number, estCostUsd: number): number {
  return value / Math.max(estCostUsd, 0.01);
}

export interface SubtaskInput {
  id?: string;
  parent: Task | null;
  traceId: string;
  assigneeId: string;
  createdBy: string;
  title: string;
  description: string;
  acceptanceCriteria?: string | null;
  value?: number;
  estCostUsd?: number;
  originConversationId?: string | null;
  state?: Record<string, unknown>;
}

export type TerminalListener = (task: Task) => void;

export interface TaskDeps {
  repos: Repositories;
  bus: EventBus;
  tracer: TracerImpl;
  org: OrgService;
  conversations: ConversationService;
  now: () => Date;
  /** Board/agent-authored titles and descriptions are redacted (high-precision tier) before they are stored. */
  redactor?: Redactor;
}

export class TaskService implements TaskView {
  private readonly deps: TaskDeps;
  private readonly terminalListeners: TerminalListener[] = [];

  constructor(deps: TaskDeps) {
    this.deps = deps;
  }

  /** Subscribe to tasks reaching done/failed/cancelled. */
  onTerminal(listener: TerminalListener): void {
    this.terminalListeners.push(listener);
  }

  get(id: string): Task | null {
    return this.deps.repos.tasks.get(id);
  }

  require(id: string): Task {
    const task = this.get(id);
    if (!task) throw notFound("task", id);
    return task;
  }

  list(filter: TaskFilter = {}): Task[] {
    return this.deps.repos.tasks.list(filter);
  }

  children(id: string): Task[] {
    return this.deps.repos.tasks.children(id);
  }

  // ───────────── creation ─────────────

  /** POST /api/tasks: a root task with a fresh trace and an `objective` trace-root span. Assignee defaults to the CEO. */
  createRoot(input: CreateTaskInput, createdBy = "human"): Task {
    const assigneeId = input.assigneeId ?? this.deps.org.ceo()?.id;
    if (!assigneeId) throw conflict("there is no CEO to assign the task to");
    return this.createRootTask({ ...input, assigneeId, createdBy, traceId: newTraceId(), parentSpanId: null, originConversationId: null });
  }

  /** TaskView: a root task (todo) under an existing trace, e.g. from a chat message. */
  createObjective(input: CreateObjectiveInput): Task {
    return this.createRootTask({ ...input, parentSpanId: input.parentSpanId ?? null });
  }

  /** A child task (delegation) inheriting the parent's trace; a root task when parent is null. */
  createSubtask(input: SubtaskInput): Task {
    const assignee = this.activeAssignee(input.assigneeId);
    const id = input.id ?? newId("tsk");
    const task = this.buildTask({
      id,
      traceId: input.parent?.traceId ?? input.traceId,
      parentTaskId: input.parent?.id ?? null,
      rootTaskId: input.parent?.rootTaskId ?? id,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      createdBy: input.createdBy,
      assigneeId: assignee.id,
      departmentId: assignee.departmentId,
      value: input.value,
      estCostUsd: input.estCostUsd,
      originConversationId: input.originConversationId ?? null,
      state: input.state ?? {},
    });
    return this.insert(task);
  }

  // ───────────── TaskView ─────────────

  patchState(taskId: string, patch: Record<string, unknown>): Task {
    const task = this.require(taskId);
    this.deps.repos.tasks.update(taskId, { state: { ...task.state, ...patch }, updatedAt: this.iso() });
    return this.require(taskId);
  }

  /** A reason when something more urgent than `currentPriority` waits for the agent, else null. */
  interruptFor(agentId: string, currentPriority: number): string | null {
    const ceoId = this.deps.org.ceo()?.id ?? null;
    for (const message of this.deps.repos.conversations.pendingHumanMessages()) {
      const conversation = this.deps.repos.conversations.get(message.conversationId);
      if (conversation && this.deps.conversations.responderFor(conversation, ceoId) === agentId) {
        return `Unanswered message from the Board in ${conversation.title}`;
      }
    }
    const urgent = this.deps.repos.tasks.openForAssignee(agentId).find((t) => t.status === "todo" && t.priority > currentPriority);
    return urgent ? `${taskRef(urgent)} (priority ${urgent.priority.toFixed(1)}) is ready` : null;
  }

  // ───────────── transitions (RunService / API) ─────────────

  /** todo → in_progress at run start. Continuations (subtasks_completed, human_answer) don't count an attempt. */
  begin(taskId: string, trigger: RunTrigger): Task {
    const task = this.require(taskId);
    const counts = trigger === "task" || trigger === "recovery" || trigger === "heartbeat";
    const { nextTrigger: _t, recovery: _r, answeredApprovalId: _a, ...state } = task.state;
    return this.transition(task, "in_progress", {
      attempts: task.attempts + (counts ? 1 : 0),
      startedAt: task.startedAt ?? this.iso(),
      state: { ...state, lastTrigger: trigger, lastAttemptCounted: counts },
    });
  }

  complete(taskId: string, result: string, state?: Record<string, unknown>): Task {
    const task = this.require(taskId);
    return this.transition(task, "done", { result, error: null, completedAt: this.iso(), state: merge(task, state) });
  }

  /** in_progress → waiting; straight back to todo if every child already finished. */
  waitOnChildren(taskId: string, state?: Record<string, unknown>): Task {
    const task = this.require(taskId);
    const children = this.children(taskId);
    if (children.length === 0) {
      const emptyWaits = Number(task.state.emptyWaits ?? 0) + 1;
      if (emptyWaits >= 2) return this.fail(taskId, "engine reported waiting twice without delegating any subtask", state);
      return this.transition(task, "todo", { state: { ...merge(task, state), emptyWaits, nextTrigger: "subtasks_completed" } });
    }
    const waiting = this.transition(task, "waiting", { state: merge(task, state) });
    return children.every((c) => TERMINAL.has(c.status)) ? this.wake(waiting) : waiting;
  }

  /** in_progress → blocked on an approval; unblocks immediately if it was already decided. */
  block(taskId: string, approvalId: string, state?: Record<string, unknown>): Task {
    const task = this.require(taskId);
    const blocked = this.transition(task, "blocked", { state: { ...merge(task, state), blockedOnApprovalId: approvalId } });
    const approval = this.deps.repos.approvals.get(approvalId);
    return approval && approval.status !== "pending" ? this.answer(blocked, approval) : blocked;
  }

  /** Engine yielded for more urgent work: back to todo, checkpoint kept, attempt not counted. */
  yieldBack(taskId: string, state?: Record<string, unknown>): Task {
    return this.requeue(taskId, { ...(state ?? {}), nextTrigger: "task" });
  }

  /** Back to todo after an abort that is not the task's fault (pause, company pause); the attempt is refunded. */
  requeue(taskId: string, state?: Record<string, unknown>): Task {
    const task = this.require(taskId);
    if (task.status !== "in_progress") return task;
    const refund = task.state.lastAttemptCounted === true ? 1 : 0;
    return this.transition(task, "todo", { attempts: Math.max(0, task.attempts - refund), state: merge(task, state) });
  }

  /**
   * Crash recovery: an in_progress task whose run was killed goes back to todo with
   * `state.recovery = { runId }` (next run: trigger "recovery"); the lost attempt is refunded.
   */
  recover(taskId: string, runId: string): Task {
    const task = this.require(taskId);
    if (task.status !== "in_progress") return task;
    const refund = task.state.lastAttemptCounted === true ? 1 : 0;
    return this.transition(task, "todo", { attempts: Math.max(0, task.attempts - refund), state: { ...task.state, recovery: { runId } } });
  }

  /** A failed run: retry (todo) while attempts < maxAttempts, else failed + escalation to the manager. */
  fail(taskId: string, error: string, state?: Record<string, unknown>): Task {
    const task = this.require(taskId);
    if (task.attempts < task.maxAttempts) {
      return this.transition(task, "todo", { error, state: { ...merge(task, state), nextTrigger: "task" } });
    }
    const failed = this.transition(task, "failed", { error, completedAt: this.iso(), state: merge(task, state) });
    this.escalateFailure(failed);
    return failed;
  }

  /** Cancels the task and every open descendant (runs are aborted by RunService's terminal listener). */
  cancel(taskId: string, reason = "Cancelled by the Board"): Task {
    const task = this.require(taskId);
    if (TERMINAL.has(task.status)) throw conflict(`${taskRef(task)} is already ${task.status}`);
    for (const child of this.children(taskId)) if (!TERMINAL.has(child.status)) this.cancel(child.id, `Parent ${taskRef(task)} was cancelled`);
    return this.transition(this.require(taskId), "cancelled", { error: reason, completedAt: this.iso() });
  }

  /** failed/cancelled/blocked → todo with a fresh attempt budget. */
  retry(taskId: string): Task {
    const task = this.require(taskId);
    if (!["failed", "cancelled", "blocked"].includes(task.status)) throw conflict(`${taskRef(task)} is ${task.status}; only failed, cancelled or blocked tasks can be retried`);
    const { blockedOnApprovalId: _b, ...state } = task.state;
    return this.transition(task, "todo", { attempts: 0, error: null, completedAt: null, state: { ...state, nextTrigger: "task" } });
  }

  /** Wakes every task blocked on the decided approval (trigger human_answer). */
  answerApproval(approval: Approval): Task[] {
    return this.deps.repos.tasks.blockedOn(approval.id).map((task) => this.answer(task, approval));
  }

  // ───────────── internals ─────────────

  private createRootTask(input: CreateObjectiveInput & { parentSpanId: string | null }): Task {
    const assignee = this.activeAssignee(input.assigneeId);
    const id = newId("tsk");
    const task = this.buildTask({ ...input, id, parentTaskId: null, rootTaskId: id, assigneeId: assignee.id, departmentId: assignee.departmentId, state: {} });
    const span = this.deps.tracer.startSpan({
      traceId: input.traceId,
      parentSpanId: input.parentSpanId,
      kind: "objective",
      name: `T-${task.number}: ${task.title}`.slice(0, 120),
      agentId: assignee.id,
      taskId: id,
      input: `${task.title}\n\n${task.description}`,
      attributes: { "agentco.task.id": id, "agentco.task.number": task.number, "agentco.created_by": input.createdBy },
    });
    task.state = { objectiveSpanId: span.spanId };
    return this.insert(task);
  }

  private buildTask(input: {
    id: string; traceId: string; parentTaskId: string | null; rootTaskId: string; title: string; description: string;
    acceptanceCriteria?: string | null; createdBy: string; assigneeId: string; departmentId: string | null;
    value?: number; estCostUsd?: number; originConversationId: string | null; state: Record<string, unknown>;
  }): Task {
    const value = clampNumber(input.value ?? DEFAULT_VALUE, 0, 1000, "value");
    const estCostUsd = clampNumber(input.estCostUsd ?? DEFAULT_EST_COST, 0, 1_000_000, "estCostUsd");
    const at = this.iso();
    return {
      id: input.id,
      number: this.deps.repos.settings.nextCounter("task_number"),
      traceId: input.traceId,
      parentTaskId: input.parentTaskId,
      rootTaskId: input.rootTaskId,
      title: this.clean(requireText(input.title, "title", 300)),
      description: this.clean(requireText(input.description, "description", 20_000)),
      acceptanceCriteria: input.acceptanceCriteria ? this.clean(input.acceptanceCriteria) : null,
      createdBy: input.createdBy,
      assigneeId: input.assigneeId,
      departmentId: input.departmentId,
      status: "todo",
      value,
      estCostUsd,
      actualCostUsd: 0,
      priority: computePriority(value, estCostUsd),
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      originConversationId: input.originConversationId,
      state: input.state,
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      completedAt: null,
    };
  }

  private insert(task: Task): Task {
    this.deps.repos.tasks.insert(task);
    const by = task.createdBy === "human" ? "Board" : (this.deps.repos.agents.get(task.createdBy)?.name ?? task.createdBy);
    this.deps.bus.emit("task.created", { agentId: task.assigneeId, taskId: task.id, traceId: task.traceId, summary: summaries.taskCreated(task, by), data: task });
    return task;
  }

  private activeAssignee(assigneeId: string) {
    const agent = this.deps.org.getAgent(assigneeId);
    if (!agent) throw badRequest(`unknown assignee ${assigneeId}`);
    if (agent.status === "terminated") throw badRequest(`assignee ${agent.name} is terminated`);
    return agent;
  }

  /** Validated status change + patch; emits task.updated and runs terminal hooks. */
  private transition(task: Task, to: TaskStatus, patch: Partial<Task> = {}): Task {
    if (task.status !== to && !ALLOWED[task.status].includes(to)) throw conflict(`illegal task transition ${task.status} → ${to} for ${taskRef(task)}`);
    this.deps.repos.tasks.update(task.id, { ...patch, status: to, updatedAt: this.iso() });
    const updated = this.require(task.id);
    this.deps.bus.emit("task.updated", { agentId: updated.assigneeId, taskId: updated.id, traceId: updated.traceId, summary: summaries.taskUpdated(updated), data: updated });
    if (TERMINAL.has(to) && !TERMINAL.has(task.status)) this.afterTerminal(updated);
    return updated;
  }

  private afterTerminal(task: Task): void {
    if (task.parentTaskId) this.maybeWakeParent(task.parentTaskId);
    else this.endObjectiveSpans(task);
    for (const listener of this.terminalListeners) {
      try {
        listener(task);
      } catch {
        // listeners (reporting, run aborts) must not break the state machine
      }
    }
  }

  private maybeWakeParent(parentId: string): void {
    const parent = this.get(parentId);
    if (!parent || parent.status !== "waiting") return;
    if (this.children(parentId).every((c) => TERMINAL.has(c.status))) this.wake(parent);
  }

  private wake(parent: Task): Task {
    return this.transition(parent, "todo", { state: { ...parent.state, nextTrigger: "subtasks_completed" } });
  }

  private answer(task: Task, approval: Approval): Task {
    const { blockedOnApprovalId: _b, ...state } = task.state;
    return this.transition(task, "todo", { state: { ...state, nextTrigger: "human_answer", answeredApprovalId: approval.id } });
  }

  /** Root task finished: end its objective span and any trace-root objective spans with no open root tasks left. */
  private endObjectiveSpans(task: Task): void {
    const status = task.status === "done" ? "ok" : task.status === "cancelled" ? "cancelled" : "error";
    const objectiveSpanId = task.state.objectiveSpanId;
    if (typeof objectiveSpanId === "string") this.deps.tracer.endById(objectiveSpanId, { status, output: task.result ?? task.error ?? task.status });
    const openRoots = this.deps.repos.tasks.list({ traceId: task.traceId, parentTaskId: null }).filter((t) => !TERMINAL.has(t.status));
    if (openRoots.length > 0) return;
    for (const root of this.deps.repos.spans.roots(task.traceId)) {
      if (root.kind === "objective" && root.status === "running") this.deps.tracer.endById(root.id, { status, output: `${taskRef(task)} ${task.status}` });
    }
  }

  private escalateFailure(task: Task): void {
    const assignee = task.assigneeId ? this.deps.org.getAgent(task.assigneeId) : null;
    const manager = assignee?.managerId ? this.deps.org.getAgent(assignee.managerId) : null;
    if (!assignee || !manager || manager.status === "terminated") return;
    const content = `Escalation: ${taskRef(task)} failed after ${task.attempts} attempt(s). Last error: ${task.error ?? "unknown"}. Please decide how to proceed.`;
    this.deps.conversations.sendAgentMessage(assignee, manager, content, { taskId: task.id, traceId: task.traceId });
  }

  private clean(text: string): string {
    return this.deps.redactor ? this.deps.redactor.redact(text) : text;
  }

  private iso(): string {
    return this.deps.now().toISOString();
  }
}

function merge(task: Task, state?: Record<string, unknown>): Record<string, unknown> {
  return state ? { ...task.state, ...state } : task.state;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  if (value.length > max) throw badRequest(`${field} exceeds ${max} characters`);
  return value.trim();
}

function clampNumber(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw badRequest(`${field} must be a number in [${min}, ${max}]`);
  return value;
}
