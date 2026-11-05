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

  list(status?: string): Approval[] {
    if (status !== undefined && !["pending", "approved", "rejected"].includes(status)) throw badRequest("status must be pending, approved or rejected");
    return this.deps.repos.approvals.list(status);
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
