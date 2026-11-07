/**
 * Scheduler (tick 750 ms, plus an event-driven nudge so work starts immediately).
 *
 *  - nothing starts while the company is paused (kill switch), or while no AI provider can be
 *    reached (an outage: retried after 30 s, 1, 2, then every 5 minutes);
 *  - at most `maxConcurrentRuns` runs in total, one run per agent;
 *  - agents that are paused, terminated, busy or out of budget are skipped (tasks) —
 *    excluded in SQL and paged past, so no backlog of an ineligible agent can starve
 *    the others (pages of READY_PAGE until the free slots are filled);
 *  - queued chat messages (humans waiting for an answer) go first, then `todo`
 *    tasks by priority = value / cost (oldest first on ties).
 */
import type { Message, Task } from "../../../../packages/shared/src/index.ts";
import type { Repositories } from "../db/index.ts";
import type { EventBus } from "../events/bus.ts";
import type { CompanyService } from "../org/company.ts";
import type { OrgService } from "../org/service.ts";
import type { ConversationService } from "../runs/conversations.ts";

/** What the scheduler needs from RunService. */
export interface RunLauncher {
  activeCount(): number;
  isBusy(agentId: string): boolean;
  startTaskRun(task: Task): unknown | null;
  startMessageRun(message: Message): unknown | null;
  /** Agents with an active run (excluded from the ready query); optional for simple launchers. */
  busyAgentIds?(): Iterable<string>;
}

export interface SchedulerDeps {
  repos: Repositories;
  bus: EventBus;
  org: OrgService;
  company: CompanyService;
  conversations: ConversationService;
  runs: RunLauncher;
  tickMs: number;
  /** While no AI provider can be reached, nothing starts until the next try (models/outage.ts). */
  outage?: { heldUntil(): number | null };
}

const WAKE_EVENTS = new Set(["task.created", "task.updated", "message.created", "run.completed", "company.updated", "agent.updated", "approval.decided"]);
/** An agent with less budget than this left is treated as out of budget. */
export const MIN_RUN_BUDGET_USD = 0.0005;
/** Ready tasks fetched per query while filling free slots. */
export const READY_PAGE = 200;

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.safeTick(), this.deps.tickMs);
    this.timer.unref();
    this.unsubscribe = this.deps.bus.subscribe((event) => {
      if (WAKE_EVENTS.has(event.type)) this.nudge();
    });
    this.nudge();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.unsubscribe?.();
    this.timer = this.nudgeTimer = this.unsubscribe = null;
  }

  /** Coalesced "something changed" wake-up (never re-enters the caller's stack). */
  nudge(): void {
    if (this.nudgeTimer || !this.timer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      this.safeTick();
    }, 0);
    this.nudgeTimer.unref();
  }

  /** One scheduling pass; returns how many runs were started. Public so tests can drive it. */
  tick(): number {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return this.pass();
    } finally {
      this.ticking = false;
    }
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (error) {
      console.error("[scheduler] tick failed:", error instanceof Error ? error.message : error);
    }
  }

  private pass(): number {
    const { company, runs, repos, org, conversations } = this.deps;
    const settings = company.settings();
    if (settings.paused) return 0;
    if (this.deps.outage?.heldUntil()) return 0;
    let free = settings.maxConcurrentRuns - runs.activeCount();
    let started = 0;
    if (free <= 0) return 0;

    // 1) queued chat messages first
    const ceoId = org.ceo()?.id ?? null;
    for (const message of repos.conversations.pendingHumanMessages()) {
      if (free <= 0) return started;
      const conversation = repos.conversations.get(message.conversationId);
      const responderId = conversation ? conversations.responderFor(conversation, ceoId) : null;
      const responder = responderId ? org.getAgent(responderId) : null;
      if (!responder || responder.status === "terminated" || responder.status === "paused" || runs.isBusy(responder.id)) continue;
      if (runs.startMessageRun(message)) {
        free -= 1;
        started += 1;
      }
    }

    // 2) ready tasks by priority, paging past agents that cannot run now
    const excluded = new Set<string>(runs.busyAgentIds?.() ?? []);
    let after: Task | null = null;
    while (free > 0) {
      const page = repos.tasks.ready({ limit: READY_PAGE, excludeAssignees: excluded, after });
      for (const task of page) {
        if (free <= 0) break;
        const assigneeId = task.assigneeId as string;
        if (excluded.has(assigneeId)) continue;
        const assignee = org.getAgent(assigneeId);
        if (!assignee || assignee.status === "terminated" || assignee.status === "paused" || runs.isBusy(assignee.id)) {
          excluded.add(assigneeId);
          continue;
        }
        if (org.budgetRemainingUsd(assignee.id) < MIN_RUN_BUDGET_USD) {
          excluded.add(assigneeId);
          continue;
        }
        if (runs.startTaskRun(task)) {
          free -= 1;
          started += 1;
          excluded.add(assigneeId); // one run per agent
        }
      }
      if (page.length < READY_PAGE) break;
      after = page[page.length - 1]!;
    }
    return started;
  }
}
