/**
 * Budget governor (implements BudgetGate from contracts.ts).
 *
 * Caps, checked before every model call by the router:
 *   agent monthly (Agent.monthlyBudgetUsd, 0 = no per-agent cap),
 *   department monthly (Department.monthlyBudgetUsd, 0 = no cap),
 *   company daily and monthly (CompanySettings).
 * recordSpend writes the `spend` row and rolls cost up into the run and task.
 */
import type { CompanySettings } from "../../../../packages/shared/src/index.ts";
import type { BudgetExceededErrorShape, BudgetGate, SpendEntry } from "../contracts.ts";
import type { Repositories } from "../db/index.ts";
import type { EventBus } from "../events/bus.ts";

export type BudgetScope = BudgetExceededErrorShape["scope"];
export type BudgetPeriod = "daily" | "monthly";

export class BudgetExceededError extends Error implements BudgetExceededErrorShape {
  override readonly name = "BudgetExceededError" as const;
  readonly scope: BudgetScope;
  readonly period: BudgetPeriod;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly agentId: string | null;
  readonly departmentId: string | null;

  constructor(input: { scope: BudgetScope; period: BudgetPeriod; limitUsd: number; spentUsd: number; agentId?: string | null; departmentId?: string | null }) {
    super(`${input.scope} ${input.period} budget exhausted: spent $${input.spentUsd.toFixed(4)} of $${input.limitUsd.toFixed(2)}`);
    this.scope = input.scope;
    this.period = input.period;
    this.limitUsd = input.limitUsd;
    this.spentUsd = input.spentUsd;
    this.agentId = input.agentId ?? null;
    this.departmentId = input.departmentId ?? null;
  }
}

/** Structural check (errors may cross module boundaries as plain Errors). */
export function isBudgetExceeded(error: unknown): error is Error & BudgetExceededErrorShape & { period?: BudgetPeriod; agentId?: string | null; departmentId?: string | null } {
  return error instanceof Error && error.name === "BudgetExceededError";
}

export function dayStart(now: Date): string {
  return now.toISOString().slice(0, 10) + "T00:00:00.000Z";
}

export function monthStart(now: Date): string {
  return now.toISOString().slice(0, 7) + "-01T00:00:00.000Z";
}

export interface BudgetDeps {
  repos: Repositories;
  bus: EventBus;
  settings: () => CompanySettings;
  now: () => Date;
}

export class BudgetService implements BudgetGate {
  private readonly deps: BudgetDeps;

  constructor(deps: BudgetDeps) {
    this.deps = deps;
  }

  /** Throws BudgetExceededError when spent + estimate would pass any cap. */
  assertCanSpend(agentId: string, estimateUsd: number): void {
    const estimate = Math.max(0, estimateUsd);
    const settings = this.deps.settings();
    const now = this.deps.now();
    const check = (scope: BudgetScope, period: BudgetPeriod, limit: number, spent: number, ids: { agentId?: string; departmentId?: string } = {}) => {
      if (spent + estimate > limit) throw new BudgetExceededError({ scope, period, limitUsd: limit, spentUsd: spent, ...ids });
    };
    check("company", "daily", settings.dailyBudgetUsd, this.companySpent(dayStart(now)));
    check("company", "monthly", settings.monthlyBudgetUsd, this.companySpent(monthStart(now)));
    const agent = this.deps.repos.agents.get(agentId);
    if (!agent) return;
    if (agent.monthlyBudgetUsd > 0) check("agent", "monthly", agent.monthlyBudgetUsd, this.agentSpent(agentId, monthStart(now)), { agentId });
    const department = this.deps.repos.departments.get(agent.departmentId);
    if (department && department.monthlyBudgetUsd > 0) {
      check("department", "monthly", department.monthlyBudgetUsd, this.departmentSpent(department.id, monthStart(now)), { departmentId: department.id });
    }
  }

  /** Writes the spend row, adds usage/cost to the run and cost to the task; emits budget.alert at 80 %. */
  recordSpend(entry: SpendEntry): void {
    const { repos } = this.deps;
    const at = this.deps.now().toISOString();
    const agent = repos.agents.get(entry.agentId);
    repos.tx(() => {
      repos.spend.insert({
        agentId: entry.agentId, runId: entry.runId, traceId: entry.traceId, spanId: entry.spanId, taskId: entry.taskId,
        provider: entry.provider, model: entry.model, profileId: entry.profileId, tier: entry.tier, stage: entry.stage,
        inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, cachedInputTokens: entry.cachedInputTokens,
        costUsd: entry.costUsd, frontierCostUsd: entry.frontierCostUsd, departmentId: agent?.departmentId ?? null, at,
      });
      repos.runs.addUsage(entry.runId, { ...entry });
      if (entry.taskId) repos.tasks.addCost(entry.taskId, entry.costUsd);
    });
    this.maybeAlert();
  }

  companySpent(fromIso: string): number {
    return this.deps.repos.spend.totals(fromIso).costUsd;
  }

  agentSpent(agentId: string, fromIso: string): number {
    return this.deps.repos.spend.totals(fromIso, { agentId }).costUsd;
  }

  departmentSpent(departmentId: string, fromIso: string): number {
    return this.deps.repos.spend.totals(fromIso, { departmentId }).costUsd;
  }

  /** Remaining USD the agent can spend now: the tightest of all caps that apply (≥ 0). */
  remainingFor(agentId: string): number {
    const now = this.deps.now();
    const settings = this.deps.settings();
    const caps = [
      settings.dailyBudgetUsd - this.companySpent(dayStart(now)),
      settings.monthlyBudgetUsd - this.companySpent(monthStart(now)),
    ];
    const agent = this.deps.repos.agents.get(agentId);
    if (agent && agent.monthlyBudgetUsd > 0) caps.push(agent.monthlyBudgetUsd - this.agentSpent(agentId, monthStart(now)));
    const department = agent ? this.deps.repos.departments.get(agent.departmentId) : null;
    if (department && department.monthlyBudgetUsd > 0) caps.push(department.monthlyBudgetUsd - this.departmentSpent(department.id, monthStart(now)));
    return Math.max(0, Math.min(...caps));
  }

  /** The cap the remaining figure is measured against (for headroom ratios). */
  limitFor(agentId: string): number {
    const settings = this.deps.settings();
    const agent = this.deps.repos.agents.get(agentId);
    const limits = [settings.dailyBudgetUsd];
    if (agent && agent.monthlyBudgetUsd > 0) limits.push(agent.monthlyBudgetUsd);
    return Math.max(0, Math.min(...limits));
  }

  private maybeAlert(): void {
    const now = this.deps.now();
    const settings = this.deps.settings();
    const spent = this.companySpent(dayStart(now));
    if (settings.dailyBudgetUsd <= 0 || spent < 0.8 * settings.dailyBudgetUsd) return;
    const key = `budget.alert.${dayStart(now).slice(0, 10)}`;
    if (this.deps.repos.settings.has(key)) return;
    this.deps.repos.settings.set(key, { at: now.toISOString(), spent });
    this.deps.bus.emit("budget.alert", {
      summary: `Company has spent $${spent.toFixed(4)} of its $${settings.dailyBudgetUsd.toFixed(2)} daily budget (≥ 80 %)`,
      data: { scope: "company", period: "daily", spentUsd: spent, limitUsd: settings.dailyBudgetUsd },
    });
  }
}
