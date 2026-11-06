/**
 * Budget governor (implements BudgetGate from contracts.ts).
 *
 * Caps, checked before every model call by the router:
 *   agent monthly (Agent.monthlyBudgetUsd, 0 = no per-agent cap),
 *   department monthly (Department.monthlyBudgetUsd, 0 = no cap),
 *   company daily and monthly (CompanySettings).
 * recordSpend writes the `spend` row and rolls cost up into the run and task.
 *
 * Reservation ledger: a call in flight has not written its spend row yet, so
 * concurrent calls could each pass the check and overrun a hard cap together.
 * assertCanSpend(agentId, estimate, reservationId) therefore counts every
 * outstanding reservation and, when it passes, reserves the estimate; the
 * reservation is released by recordSpend (entry.reservationId) or release()
 * when the call fails.
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

/**
 * Budget windows start at local midnight of the server's time zone (the TZ environment
 * variable, e.g. TZ=Asia/Singapore; UTC when unset), returned as a UTC ISO instant to compare
 * with the stored `at` timestamps. UTC days put a Singapore morning's spend in "yesterday".
 */
export function dayStart(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

export function monthStart(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

/** The local calendar day (YYYY-MM-DD) in the server's time zone, for per-day keys. */
export function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface BudgetDeps {
  repos: Repositories;
  bus: EventBus;
  settings: () => CompanySettings;
  now: () => Date;
}

interface Reservation {
  agentId: string;
  departmentId: string | null;
  amountUsd: number;
}

export class BudgetService implements BudgetGate {
  private readonly deps: BudgetDeps;
  private readonly reservations = new Map<string, Reservation>();

  constructor(deps: BudgetDeps) {
    this.deps = deps;
  }

  /**
   * Throws BudgetExceededError when spent + outstanding reservations + estimate would pass
   * any cap; with a reservationId the estimate is then reserved (see the module comment).
   */
  assertCanSpend(agentId: string, estimateUsd: number, reservationId?: string): void {
    const estimate = Number.isFinite(estimateUsd) ? Math.max(0, estimateUsd) : 0;
    const settings = this.deps.settings();
    const now = this.deps.now();
    const check = (scope: BudgetScope, period: BudgetPeriod, limit: number, spent: number, reserved: number, ids: { agentId?: string; departmentId?: string } = {}) => {
      if (spent + reserved + estimate > limit) throw new BudgetExceededError({ scope, period, limitUsd: limit, spentUsd: spent + reserved, ...ids });
    };
    const companyReserved = this.reserved(() => true);
    check("company", "daily", settings.dailyBudgetUsd, this.companySpent(dayStart(now)), companyReserved);
    check("company", "monthly", settings.monthlyBudgetUsd, this.companySpent(monthStart(now)), companyReserved);
    const agent = this.deps.repos.agents.get(agentId);
    if (agent) {
      if (agent.monthlyBudgetUsd > 0) {
        check("agent", "monthly", agent.monthlyBudgetUsd, this.agentSpent(agentId, monthStart(now)), this.reserved((r) => r.agentId === agentId), { agentId });
      }
      const department = this.deps.repos.departments.get(agent.departmentId);
      if (department && department.monthlyBudgetUsd > 0) {
        check("department", "monthly", department.monthlyBudgetUsd, this.departmentSpent(department.id, monthStart(now)), this.reserved((r) => r.departmentId === department.id), {
          departmentId: department.id,
        });
      }
    }
    if (reservationId) this.reservations.set(reservationId, { agentId, departmentId: agent?.departmentId ?? null, amountUsd: estimate });
  }

  /** Drops a reservation (failed or aborted call). Idempotent. */
  release(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  /** USD reserved by calls in flight (all of them, or one agent's). */
  reservedUsd(agentId?: string): number {
    return this.reserved((r) => agentId === undefined || r.agentId === agentId);
  }

  private reserved(match: (r: Reservation) => boolean): number {
    let total = 0;
    for (const r of this.reservations.values()) if (match(r)) total += r.amountUsd;
    return total;
  }

  /** Writes the spend row, adds usage/cost to the run and cost to the task, releases the call's reservation; emits budget.alert at 80 %. */
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
      const { reservationId: _r, ...usage } = entry;
      repos.runs.addUsage(entry.runId, usage);
      if (entry.taskId) repos.tasks.addCost(entry.taskId, entry.costUsd);
    });
    // The actual cost is on the books now (same tick, so the cap never sees neither).
    if (entry.reservationId) this.release(entry.reservationId);
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
    const companyReserved = this.reserved(() => true);
    const caps = [
      settings.dailyBudgetUsd - this.companySpent(dayStart(now)) - companyReserved,
      settings.monthlyBudgetUsd - this.companySpent(monthStart(now)) - companyReserved,
    ];
    const agent = this.deps.repos.agents.get(agentId);
    if (agent && agent.monthlyBudgetUsd > 0) caps.push(agent.monthlyBudgetUsd - this.agentSpent(agentId, monthStart(now)) - this.reserved((r) => r.agentId === agentId));
    const department = agent ? this.deps.repos.departments.get(agent.departmentId) : null;
    if (department && department.monthlyBudgetUsd > 0) {
      caps.push(department.monthlyBudgetUsd - this.departmentSpent(department.id, monthStart(now)) - this.reserved((r) => r.departmentId === department.id));
    }
    return Math.max(0, Math.min(...caps));
  }

  /**
   * Headroom against EACH cap that applies, as a share of that cap's own limit; the binding one is the
   * lowest share. ("$6 of the company's $10 today" used to be divided by the agent's $60 MONTHLY budget
   * and read as "10% of your budget left" — a CEO with $54 of her month unspent rationed every plan.)
   */
  headroom(agentId: string): { share: number; label: string; remainingUsd: number; limitUsd: number } {
    const now = this.deps.now();
    const settings = this.deps.settings();
    const companyReserved = this.reserved(() => true);
    const caps: { label: string; limit: number; remaining: number }[] = [
      { label: "company daily budget", limit: settings.dailyBudgetUsd, remaining: settings.dailyBudgetUsd - this.companySpent(dayStart(now)) - companyReserved },
      { label: "company monthly budget", limit: settings.monthlyBudgetUsd, remaining: settings.monthlyBudgetUsd - this.companySpent(monthStart(now)) - companyReserved },
    ];
    const agent = this.deps.repos.agents.get(agentId);
    if (agent && agent.monthlyBudgetUsd > 0) {
      caps.push({ label: "your monthly budget", limit: agent.monthlyBudgetUsd, remaining: agent.monthlyBudgetUsd - this.agentSpent(agentId, monthStart(now)) - this.reserved((r) => r.agentId === agentId) });
    }
    const department = agent ? this.deps.repos.departments.get(agent.departmentId) : null;
    if (department && department.monthlyBudgetUsd > 0) {
      caps.push({ label: "department monthly budget", limit: department.monthlyBudgetUsd, remaining: department.monthlyBudgetUsd - this.departmentSpent(department.id, monthStart(now)) - this.reserved((r) => r.departmentId === department.id) });
    }
    const live = caps.filter((c) => c.limit > 0);
    if (!live.length) return { share: 1, label: "no budget cap", remainingUsd: Infinity, limitUsd: 0 };
    const tightest = live.map((c) => ({ ...c, share: Math.max(0, c.remaining) / c.limit })).sort((a, b) => a.share - b.share)[0]!;
    return { share: tightest.share, label: tightest.label, remainingUsd: Math.max(0, tightest.remaining), limitUsd: tightest.limit };
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
    const key = `budget.alert.${localDay(now)}`;
    if (this.deps.repos.settings.has(key)) return;
    this.deps.repos.settings.set(key, { at: now.toISOString(), spent });
    this.deps.bus.emit("budget.alert", {
      summary: `Company has spent $${spent.toFixed(4)} of its $${settings.dailyBudgetUsd.toFixed(2)} daily budget (≥ 80 %)`,
      data: { scope: "company", period: "daily", spentUsd: spent, limitUsd: settings.dailyBudgetUsd },
    });
  }
}
