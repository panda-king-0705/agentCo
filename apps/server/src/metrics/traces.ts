/** Trace summaries and details for the Glass Box explorer (GET /api/traces). */
import type { Span, SpanStatus, TraceDetail, TraceSummary } from "../../../../packages/shared/src/index.ts";
import type { Repositories } from "../db/index.ts";
import type { Row } from "../db/mappers.ts";
import { notFound } from "../http/errors.ts";

export class TraceService {
  private readonly repos: Repositories;

  constructor(repos: Repositories) {
    this.repos = repos;
  }

  list(limit = 50): TraceSummary[] {
    const capped = Math.min(Math.max(Math.floor(limit) || 50, 1), 500);
    return this.repos.spans.traceAggregates(capped).map((row) => this.summarize(row));
  }

  detail(traceId: string): TraceDetail {
    const aggregate = this.repos.spans.traceAggregate(traceId);
    if (!aggregate) throw notFound("trace", traceId);
    return { summary: this.summarize(aggregate), spans: this.repos.spans.byTrace(traceId), tasks: this.repos.tasks.list({ traceId, limit: 5000 }).reverse() };
  }

  private summarize(row: Row): TraceSummary {
    const traceId = String(row.trace_id);
    const roots = this.repos.spans.roots(traceId);
    const rootTask = this.repos.tasks.list({ traceId, parentTaskId: null, limit: 50 }).at(-1) ?? null;
    return {
      traceId,
      title: roots[0]?.name ?? rootTask?.title ?? traceId,
      rootTaskId: rootTask?.id ?? null,
      status: statusOf(roots, Number(row.running ?? 0)),
      startedAt: String(row.started_at),
      endedAt: Number(row.running ?? 0) > 0 || !row.ended_at ? null : String(row.ended_at),
      agentIds: String(row.agent_ids ?? "").split(",").filter(Boolean),
      spanCount: Number(row.span_count ?? 0),
      llmCalls: Number(row.llm_calls ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
    };
  }
}

/** running while anything is open; else error if a root errored, cancelled if every root was, else ok. */
function statusOf(roots: Span[], running: number): SpanStatus {
  if (running > 0) return "running";
  if (roots.some((s) => s.status === "error")) return "error";
  if (roots.length > 0 && roots.every((s) => s.status === "cancelled")) return "cancelled";
  return "ok";
}
