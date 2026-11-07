/**
 * ApprovalService — the Board's human-in-the-loop queue. Deciding an approval
 * applies its effect (hire, terminate, budget raise) and wakes every task
 * blocked on it with trigger `human_answer`.
 */
import type { Approval, ApprovalKind, CreateAgentInput, DecideApprovalInput } from "../../../../packages/shared/src/index.ts";
import type { Repositories } from "../db/index.ts";
import { newId } from "../db/ids.ts";
import type { EventBus } from "../events/bus.ts";
import { summaries } from "../events/summary.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";
import type { BudgetPeriod } from "../middleware/budget.ts";
import type { Redactor } from "../middleware/redact.ts";
import { redactDeep } from "../middleware/redact-deep.ts";
import type { CompanyService } from "../org/company.ts";
import type { OrgService } from "../org/service.ts";
import type { TaskService } from "./service.ts";
import { hiresOf, readFirstTask, withHire } from "../tools/builtins/hiring.ts";

/** The role a hire_agent approval is for (catalogId, else the title). */
function hireRole(p: Record<string, unknown>): string {
  const input = (p.input ?? {}) as { catalogId?: unknown; title?: unknown };
  return typeof input.catalogId === "string" ? input.catalogId : typeof input.title === "string" ? input.title : "agent";
}

export interface CreateApprovalInput {
  kind: ApprovalKind;
  requestedBy: string;
  taskId?: string | null;
  traceId?: string | null;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface BudgetIncreaseRequest {
  scope: "agent" | "department" | "company";
  period: BudgetPeriod;
  limitUsd: number;
  spentUsd: number;
  agentId: string;
  departmentId: string | null;
  taskId: string | null;
  traceId: string | null;
}

export interface ApprovalDeps {
  repos: Repositories;
  bus: EventBus;
  org: OrgService;
  tasks: TaskService;
  company: CompanyService;
  now: () => Date;
  redactor?: Redactor;
}

export class ApprovalService {
  private readonly deps: ApprovalDeps;

  constructor(deps: ApprovalDeps) {
    this.deps = deps;
  }

  list(status?: string, archived: "include" | "exclude" | "only" = "include"): Approval[] {
    if (status !== undefined && !["pending", "approved", "rejected"].includes(status)) throw badRequest("status must be pending, approved or rejected");
    return this.deps.repos.approvals.list(status, archived);
  }

  /** "Clear history" on the Approvals page: hides every decided approval; nothing is deleted. */
  archiveDecided(): { count: number; batch: string | null } {
    const batch = this.deps.now().toISOString();
    const count = this.deps.repos.approvals.archiveDecided(batch);
    return { count, batch: count ? batch : null };
  }

  /** Undo a clear (its batch stamp), or restore all cleared history. */
  unarchive(batch: string | null): { count: number; batch: string | null } {
    return { count: this.deps.repos.approvals.unarchive(batch), batch };
  }

  require(id: string): Approval {
    const approval = this.deps.repos.approvals.get(id);
    if (!approval) throw notFound("approval", id);
    return approval;
  }

  forTask(taskId: string): Approval[] {
    return this.deps.repos.approvals.forTask(taskId);
  }

  /** Opens a pending approval and emits approval.created. */
  create(input: CreateApprovalInput): Approval {
    const approval: Approval = {
      id: newId("apr"),
      kind: input.kind,
      status: "pending",
      requestedBy: input.requestedBy,
      taskId: input.taskId ?? null,
      traceId: input.traceId ?? null,
      summary: this.clean(input.summary).slice(0, 500),
      payload: this.deps.redactor ? redactDeep(input.payload ?? {}, this.deps.redactor) : (input.payload ?? {}),
      decidedBy: null,
      note: null,
      createdAt: this.deps.now().toISOString(),
      decidedAt: null,
    };
    this.deps.repos.approvals.insert(approval);
    this.deps.bus.emit("approval.created", { agentId: approval.requestedBy, taskId: approval.taskId, traceId: approval.traceId, summary: summaries.approvalCreated(approval), data: approval });
    return approval;
  }

  private clean(text: string): string {
    return this.deps.redactor ? this.deps.redactor.redact(text) : text;
  }

  /**
   * Board questions a reply in this conversation answers: those posted there, those raised under an
   * objective that came from it, and — in a DM — any the DM partner asked.
   */
  questionsForConversation(conversation: { id: string; kind: string; participantIds: string[] }): Approval[] {
    const partner = conversation.kind === "dm" ? conversation.participantIds.find((p) => p !== "human") ?? null : null;
    return this.deps.repos.approvals.list("pending").filter((a) => {
      if (a.kind !== "question") return false;
      if (a.payload.conversationId === conversation.id) return true;
      if (partner && a.requestedBy === partner) return true;
      const task = a.taskId ? this.deps.tasks.get(a.taskId) : null;
      const root = task ? (task.rootTaskId === task.id ? task : this.deps.tasks.get(task.rootTaskId)) : null;
      return root?.originConversationId === conversation.id;
    });
  }

  /** A Board reply in a conversation answers the open questions linked to it (see questionsForConversation). */
  answerFromConversation(conversation: { id: string; kind: string; participantIds: string[] }, answer: string): Approval[] {
    return this.questionsForConversation(conversation).map((a) => this.decide(a.id, { decision: "approved", note: answer }));
  }

  /**
   * Bulk triage: decide every pending approval matching the filter (ids and/or kind). Answering a
   * question needs a note; questions rejected without one are dismissed ("declined to answer").
   */
  decideMany(filter: { ids?: string[]; kind?: ApprovalKind }, input: DecideApprovalInput): Approval[] {
    if (input.decision === "approved" && filter.kind === "question" && !input.note?.trim()) throw badRequest("answering questions needs a note");
    const ids = filter.ids ? new Set(filter.ids) : null;
    const targets = this.deps.repos.approvals.list("pending").filter((a) => (!ids || ids.has(a.id)) && (!filter.kind || a.kind === filter.kind));
    return targets.map((a) => this.decide(a.id, input));
  }

  /** Closes the pending approvals of tasks that no longer need them (cancelled), without waking anything. */
  closeForTasks(taskIds: ReadonlySet<string>, note: string): Approval[] {
    const closed: Approval[] = [];
    for (const a of this.deps.repos.approvals.list("pending")) {
      if (!a.taskId || !taskIds.has(a.taskId)) continue;
      if (this.deps.tasks.get(a.taskId)?.status !== "cancelled") continue;
      this.deps.repos.approvals.update(a.id, { status: "rejected", decidedBy: "system", note, decidedAt: this.deps.now().toISOString() });
      const decided = this.require(a.id);
      this.deps.bus.emit("approval.decided", { agentId: decided.requestedBy, taskId: decided.taskId, traceId: decided.traceId, summary: summaries.approvalDecided(decided), data: decided });
      closed.push(decided);
    }
    return closed;
  }

  /**
   * Withdraws what a removed agent was still asking the Board (questions, hires, budget): rejected
   * by the system with a note saying why, and the blocked task — now its manager's — wakes with it.
   * Never the approval being decided right now (a terminate_agent request about the agent itself).
   */
  withdrawRequestsBy(agent: { id: string; name: string }): number {
    const note = `Withdrawn: ${agent.name} was removed, so this request no longer stands. Ask again if the work still needs it.`;
    let n = 0;
    for (const a of this.deps.repos.approvals.list("pending")) {
      if (a.requestedBy !== agent.id || (a.kind === "terminate_agent" && a.payload.agentId === agent.id)) continue;
      if (a.kind === "hire_agent" && a.taskId) {
        const asker = this.deps.tasks.get(a.taskId);
        if (asker) this.deps.tasks.patchState(asker.id, { hires: withHire(hiresOf(asker), { role: hireRole(a.payload), status: "declined", approvalId: a.id }) });
      }
      this.deps.repos.approvals.update(a.id, { status: "rejected", decidedBy: "system", note, decidedAt: this.deps.now().toISOString() });
      const decided = this.require(a.id);
      this.deps.bus.emit("approval.decided", { agentId: decided.requestedBy, taskId: decided.taskId, traceId: decided.traceId, summary: summaries.approvalDecided(decided), data: decided });
      this.deps.tasks.answerApproval(decided);
      n += 1;
    }
    return n;
  }

  /** The open Board question for an objective (root task), if any. */
  pendingQuestionFor(rootTaskId: string): Approval | null {
    return this.deps.repos.approvals.findPending("question", "rootTaskId", rootTaskId);
  }

  /** One pending budget_increase per scope target (deduped); returns the existing one if present. */
  requestBudgetIncrease(request: BudgetIncreaseRequest): Approval {
    const target = request.scope === "agent" ? request.agentId : request.scope === "department" ? (request.departmentId ?? "") : "company";
    const dedupeKey = `${request.scope}:${request.period}:${target}`;
    const existing = this.deps.repos.approvals.findPending("budget_increase", "dedupeKey", dedupeKey);
    if (existing) return existing;
    const suggested = Math.max(request.limitUsd * 2, request.spentUsd + 1);
    return this.create({
      kind: "budget_increase",
      requestedBy: request.agentId,
      taskId: request.taskId,
      traceId: request.traceId,
      summary: `${request.scope} ${request.period} budget exhausted ($${request.spentUsd.toFixed(4)} of $${request.limitUsd.toFixed(2)}); raise to $${suggested.toFixed(2)}?`,
      payload: { ...request, dedupeKey, suggestedLimitUsd: Math.round(suggested * 100) / 100 },
    });
  }

  /** Records the Board's decision, applies its effect and wakes blocked tasks. */
  decide(id: string, input: DecideApprovalInput): Approval {
    const approval = this.require(id);
    if (approval.status !== "pending") throw conflict(`approval ${id} was already ${approval.status}`);
    let payload = approval.payload;
    if (input.decision === "approved") payload = { ...payload, ...this.applyEffect(approval) };
    else if (approval.kind === "hire_agent" && approval.taskId) {
      // A declined hire is recorded on the asking task, so it is not requested again.
      const asker = this.deps.tasks.get(approval.taskId);
      if (asker) this.deps.tasks.patchState(asker.id, { hires: withHire(hiresOf(asker), { role: hireRole(approval.payload), status: "declined", approvalId: approval.id }) });
    }
    this.deps.repos.approvals.update(id, { status: input.decision, decidedBy: "human", note: input.note?.trim() ? this.clean(input.note.trim()) : null, decidedAt: this.deps.now().toISOString(), payload });
    const decided = this.require(id);
    this.deps.bus.emit("approval.decided", { agentId: decided.requestedBy, taskId: decided.taskId, traceId: decided.traceId, summary: summaries.approvalDecided(decided), data: decided });
    this.deps.tasks.answerApproval(decided);
    return decided;
  }

  private applyEffect(approval: Approval): Record<string, unknown> {
    const p = approval.payload;
    switch (approval.kind) {
      case "hire_agent": {
        const agent = this.deps.org.createAgent(p.input as CreateAgentInput, approval.requestedBy, { ignoreHeadcount: true });
        const recordHire = (firstTaskId?: string) => {
          const asker = approval.taskId ? this.deps.tasks.get(approval.taskId) : null;
          if (!asker) return;
          this.deps.tasks.patchState(asker.id, { hires: withHire(hiresOf(asker), { role: hireRole(p), status: "hired", approvalId: approval.id, agentId: agent.id, name: agent.name, ...(firstTaskId ? { firstTaskId } : {}) }) });
        };
        // The hiring manager's first task for them (hire_agent firstTask): assigned now, under the
        // hiring task, so the manager resumes when it is done.
        const first = readFirstTask(p.firstTask);
        const parent = first && typeof p.firstTaskParentId === "string" ? this.deps.tasks.get(p.firstTaskParentId) : null;
        if (first && parent && !["done", "failed", "cancelled"].includes(parent.status)) {
          const sub = this.deps.tasks.createSubtask({
            parent,
            traceId: parent.traceId,
            assigneeId: agent.id,
            createdBy: approval.requestedBy,
            title: first.title,
            description: first.description,
            ...(first.acceptanceCriteria ? { acceptanceCriteria: first.acceptanceCriteria } : {}),
            state: { firstTask: true },
          });
          recordHire(sub.id);
          return { hiredAgentId: agent.id, firstTaskId: sub.id };
        }
        recordHire();
        return { hiredAgentId: agent.id };
      }
      case "terminate_agent": {
        const result = this.deps.org.destroyAgent(String(p.agentId));
        return { destroyResult: result };
      }
      case "budget_increase":
        return { appliedLimitUsd: this.raiseBudget(p) };
      default:
        return {};
    }
  }

  private raiseBudget(p: Record<string, unknown>): number {
    const limit = Number(p.suggestedLimitUsd);
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    if (p.scope === "agent" && typeof p.agentId === "string") this.deps.org.updateAgent(p.agentId, { monthlyBudgetUsd: limit });
    else if (p.scope === "department" && typeof p.departmentId === "string") this.deps.repos.departments.update(p.departmentId, { monthlyBudgetUsd: limit });
    else if (p.scope === "company") this.deps.company.update(p.period === "daily" ? { dailyBudgetUsd: limit } : { monthlyBudgetUsd: limit });
    return limit;
  }
}
