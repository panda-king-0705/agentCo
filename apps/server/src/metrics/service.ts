/**
 * Metrics: the MetricsView the brain engines use (per-block llm profile over spans),
 * plus the dashboard aggregates behind GET /api/metrics/overview and /timeseries.
 */
import type { AgentStatus, MetricsOverview, ModelTier, TaskStatus, TimeseriesPoint } from "../../../../packages/shared/src/index.ts";
import type { BlockProfile, MetricsView, RunStreak } from "../contracts.ts";
import type { Repositories } from "../db/index.ts";
import { all, one } from "../db/sql.ts";
import { badRequest } from "../http/errors.ts";
import { dayStart, monthStart } from "../middleware/budget.ts";

const AGENT_STATUSES: AgentStatus[] = ["idle", "thinking", "acting", "waiting", "blocked", "paused", "error", "terminated"];
const TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "waiting", "blocked", "done", "failed", "cancelled"];
const TIERS: ModelTier[] = ["frontier", "standard", "economy"];
const HOUR_MS = 3_600_000;

/** Nearest-rank percentile of an ascending-sorted list. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? null;
}

export class MetricsService implements MetricsView {
  private readonly repos: Repositories;
  private readonly now: () => Date;

  constructor(repos: Repositories, now: () => Date) {
    this.repos = repos;
    this.now = now;
  }

  blockProfile(agentId: string, block: string, days = 14): BlockProfile {
    const since = new Date(this.now().getTime() - days * 24 * HOUR_MS).toISOString();
    const rows = all(
      this.repos.db,
      `SELECT status, duration_ms, input_tokens, output_tokens, cost_usd FROM spans
       WHERE kind = 'llm' AND agent_id = ? AND json_extract(attributes, '$."agentco.stage"') = ? AND started_at >= ?`,
      agentId,
      block,
      since,
    );
    const sorted = (key: string): number[] =>
      rows
        .map((r) => r[key])
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => a - b);
    const costs = sorted("cost_usd");
    const errors = rows.filter((r) => r.status === "error").length;
    return {
      block,
      calls: rows.length,
      p50Ms: percentile(sorted("duration_ms"), 0.5),
      p95Ms: percentile(sorted("duration_ms"), 0.95),
      p95InputTokens: percentile(sorted("input_tokens"), 0.95),
      p95OutputTokens: percentile(sorted("output_tokens"), 0.95),
      meanCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      errorRate: rows.length ? errors / rows.length : null,
    };
  }

  /**
   * Run streak for Human Nature's fatigue: walks the agent's newest runs (the current one first) and
   * counts those separated by at most `idleGapMs` of idle time (previous end → next start).
   */
  runStreak(agentId: string, idleGapMs: number, maxRuns = 12): RunStreak {
    const rows = all(
      this.repos.db,
      "SELECT started_at, completed_at, created_at FROM runs WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      agentId,
      Math.max(1, maxRuns) + 1,
    );
    const time = (v: unknown): number | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
    if (rows.length === 0) return { consecutiveRuns: 1, idleMsBefore: 0 };
    const startOf = (r: Record<string, unknown>) => time(r.started_at) ?? time(r.created_at) ?? this.now().getTime();
    let consecutiveRuns = 1;
    let idleMsBefore = 0;
    for (let i = 1; i < rows.length && consecutiveRuns < maxRuns; i++) {
      const prevEnd = time(rows[i]!.completed_at) ?? startOf(rows[i]!);
      const gap = Math.max(0, startOf(rows[i - 1]!) - prevEnd);
      if (i === 1) idleMsBefore = gap;
      if (gap > idleGapMs) break;
      consecutiveRuns++;
    }
    return { consecutiveRuns, idleMsBefore };
  }

  overview(): MetricsOverview {
    const repos = this.repos;
    const at = this.now();
    const dayAgo = new Date(at.getTime() - 24 * HOUR_MS).toISOString();
    const agentsByStatus = Object.fromEntries(AGENT_STATUSES.map((s) => [s, 0])) as Record<AgentStatus, number>;
    for (const row of all(repos.db, "SELECT status, COUNT(*) AS n FROM agents GROUP BY status")) agentsByStatus[row.status as AgentStatus] = Number(row.n);
    const tasksByStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const [status, n] of Object.entries(repos.tasks.countByStatus())) tasksByStatus[status as TaskStatus] = n;

    const month = monthStart(at);
    const spendByTier = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<ModelTier, number>;
    for (const row of repos.spend.groupBy("tier", month)) spendByTier[row.k as ModelTier] = Number(row.cost);
    const finished = all(
      repos.db,
      "SELECT status, started_at, completed_at FROM runs WHERE created_at >= ? AND status IN ('completed','failed')",
      dayAgo,
    );
    const succeeded = finished.filter((r) => r.status === "completed").length;
    const durations = finished.map((r) => Date.parse(String(r.completed_at)) - Date.parse(String(r.started_at))).filter((d) => Number.isFinite(d) && d >= 0);
    const tokens = repos.spend.totals(dayAgo);
    // Same window as spentMonthUsd / spendByTier, which the console compares it with.
    const savings = one(repos.db, "SELECT COALESCE(SUM(frontier_cost_usd - cost_usd), 0) AS s FROM spend WHERE at >= ?", month);
    return {
      agentsByStatus,
      tasksByStatus,
      spentTodayUsd: repos.spend.totals(dayStart(at)).costUsd,
      spentMonthUsd: repos.spend.totals(month).costUsd,
      spendByTier,
      spendByModel: repos.spend.groupBy("model", month).map((r) => ({ model: String(r.k), costUsd: Number(r.cost), calls: Number(r.calls) })),
      spendByDepartment: repos.spend.groupBy("department_id", month).filter((r) => r.k !== null).map((r) => ({ departmentId: String(r.k), costUsd: Number(r.cost) })),
      runs24h: Number(one(repos.db, "SELECT COUNT(*) AS n FROM runs WHERE created_at >= ?", dayAgo)?.n ?? 0),
      runSuccessRate: finished.length ? succeeded / finished.length : null,
      avgRunMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      tokens24h: { input: tokens.inputTokens, output: tokens.outputTokens },
      routingSavingsUsd: Math.max(0, Number(savings?.s ?? 0)),
    };
  }

  timeseries(metric: string, hours: number): TimeseriesPoint[] {
    if (!["cost", "runs", "tokens"].includes(metric)) throw badRequest("metric must be cost, runs or tokens");
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 31) throw badRequest("hours must be between 1 and 744");
    const end = Math.floor(this.now().getTime() / HOUR_MS) * HOUR_MS;
    const start = end - (Math.floor(hours) - 1) * HOUR_MS;
    const fromIso = new Date(start).toISOString();
    const values = new Map<string, number>();
    if (metric === "runs") {
      for (const row of all(this.repos.db, "SELECT substr(created_at, 1, 13) AS bucket, COUNT(*) AS n FROM runs WHERE created_at >= ? GROUP BY bucket", fromIso)) values.set(String(row.bucket), Number(row.n));
    } else {
      for (const row of this.repos.spend.hourly(fromIso)) values.set(String(row.bucket), Number(metric === "cost" ? row.cost : row.tokens));
    }
    const points: TimeseriesPoint[] = [];
    for (let t = start; t <= end; t += HOUR_MS) {
      const iso = new Date(t).toISOString();
      points.push({ t: iso, value: values.get(iso.slice(0, 13)) ?? 0 });
    }
    return points;
  }
}
