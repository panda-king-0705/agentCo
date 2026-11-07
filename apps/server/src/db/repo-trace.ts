/** Spans, events and spend (append-mostly observability tables). */
import type { CompanyEvent, Span } from "../../../../packages/shared/src/index.ts";
import type { SpendEntry } from "../contracts.ts";
import type { Db } from "./database.ts";
import { toEvent, toSpan, type Row } from "./mappers.ts";
import { all, insertRow, one, updateRow } from "./sql.ts";

export interface FileWrite {
  agentId: string;
  /** The task the file was saved under (null for chat runs). */
  taskId: string | null;
  area: "shared" | "private";
  /** Path inside the area. */
  rel: string;
  display: string;
  at: string;
}

export class SpanRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(span: Span): void {
    insertRow(this.db, "spans", { ...span });
  }

  update(id: string, patch: Partial<Span>): void {
    updateRow(this.db, "spans", id, patch);
  }

  get(id: string): Span | null {
    const row = one(this.db, "SELECT * FROM spans WHERE id = ?", id);
    return row ? toSpan(row) : null;
  }

  /** Calls that ran (status ok) an agent made to tools whose names start with `prefix` since a time (MCP daily limits). */
  countToolCalls(agentId: string, prefix: string, sinceIso: string): number {
    const row = one(this.db, "SELECT count(*) AS n FROM spans WHERE kind = 'tool' AND status = 'ok' AND agent_id = ? AND name LIKE ? ESCAPE '\\' AND started_at >= ? AND attributes NOT LIKE ?", agentId, `tool.${prefix.replace(/[%_]/g, (c) => `\\${c}`)}%`, sinceIso, '%"agentco.mcp.approval":true%');
    return Number(row?.n ?? 0);
  }

  byTrace(traceId: string): Span[] {
    return all(this.db, "SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at, rowid", traceId).map(toSpan);
  }

  /**
   * Files saved with workspace_write_file (or changed with workspace_edit_file) in a trace (an objective), oldest first: who wrote what,
   * where. New spans carry agentco.file.path; older ones are parsed from "Wrote <path> (…)." — a
   * path without an area prefix was written before the drive became the default, i.e. privately.
   */
  filesWritten(traceId: string): FileWrite[] {
    const rows = all(
      this.db,
      "SELECT agent_id, task_id, output, attributes, started_at FROM spans WHERE trace_id = ? AND kind = 'tool' AND name IN ('tool.workspace_write_file', 'tool.workspace_edit_file') AND status = 'ok' ORDER BY started_at, rowid",
      traceId,
    );
    const out: FileWrite[] = [];
    for (const r of rows) {
      let attrs: Record<string, unknown> = {};
      try {
        attrs = JSON.parse(String(r.attributes ?? "{}")) as Record<string, unknown>;
      } catch {
        attrs = {};
      }
      const path = typeof attrs["agentco.file.path"] === "string" ? (attrs["agentco.file.path"] as string) : (/^Wrote (\S+) \(/.exec(String(r.output ?? ""))?.[1] ?? "");
      if (!path || !r.agent_id) continue;
      const area = path.startsWith("shared/") ? "shared" : "private";
      const rel = path.replace(/^(shared|private)\//, "");
      out.push({ agentId: String(r.agent_id), taskId: r.task_id ? String(r.task_id) : null, area, rel, display: `${area}/${rel}`, at: String(r.started_at) });
    }
    return out;
  }

  /**
   * Successful tool calls on a task, oldest first, outside one run (the current one): what earlier
   * attempts already did. Callers keep the ones that change something (tool-loop.ts, WRITE_TOOL).
   */
  toolCallsForTask(taskId: string, excludeRunId: string | null): { at: string; agentId: string | null; runId: string | null; name: string; output: string; attributes: Record<string, unknown> }[] {
    const rows = all(
      this.db,
      "SELECT started_at, agent_id, run_id, name, output, attributes FROM spans WHERE task_id = ? AND kind = 'tool' AND status = 'ok' AND (run_id IS NULL OR run_id != ?) ORDER BY started_at, rowid",
      taskId,
      excludeRunId ?? "",
    );
    return rows.map((r) => {
      let attributes: Record<string, unknown> = {};
      try {
        attributes = JSON.parse(String(r.attributes ?? "{}")) as Record<string, unknown>;
      } catch {
        attributes = {};
      }
      return { at: String(r.started_at), agentId: r.agent_id ? String(r.agent_id) : null, runId: r.run_id ? String(r.run_id) : null, name: String(r.name).replace(/^tool\./, ""), output: String(r.output ?? ""), attributes };
    });
  }

  /** Successful outside writes (MCP tools) on a trace that name a repository path, oldest first (mcp/tools.ts). */
  repoWrites(traceId: string): { server: string; repo: string; branch: string; paths: string[] }[] {
    const rows = all(this.db, "SELECT attributes FROM spans WHERE trace_id = ? AND kind = 'tool' AND status = 'ok' AND attributes LIKE '%agentco.mcp.paths%' ORDER BY started_at, rowid", traceId);
    const out: { server: string; repo: string; branch: string; paths: string[] }[] = [];
    for (const r of rows) {
      try {
        const a = JSON.parse(String(r.attributes ?? "{}")) as Record<string, unknown>;
        const paths = String(a["agentco.mcp.paths"] ?? "").split("\n").filter(Boolean);
        if (typeof a["agentco.mcp.server"] === "string" && typeof a["agentco.mcp.repo"] === "string" && paths.length) {
          out.push({ server: a["agentco.mcp.server"] as string, repo: a["agentco.mcp.repo"] as string, branch: String(a["agentco.mcp.branch"] ?? ""), paths });
        }
      } catch {
        /* skip unreadable rows */
      }
    }
    return out;
  }

  byRun(runId: string): Span[] {
    return all(this.db, "SELECT * FROM spans WHERE run_id = ? ORDER BY started_at, rowid", runId).map(toSpan);
  }

  /** First span of the run that ended in error (Glass Box failing step). */
  firstErrorInRun(runId: string): Span | null {
    const row = one(this.db, "SELECT * FROM spans WHERE run_id = ? AND status = 'error' ORDER BY started_at, rowid LIMIT 1", runId);
    return row ? toSpan(row) : null;
  }

  /** Spans still `running` for the given run (crash recovery closes them). */
  runningForRun(runId: string): Span[] {
    return all(this.db, "SELECT * FROM spans WHERE run_id = ? AND status = 'running'", runId).map(toSpan);
  }

  /** Per-trace aggregates, newest first. */
  traceAggregates(limit: number): Row[] {
    return all(
      this.db,
      `SELECT trace_id, MIN(started_at) AS started_at, MAX(ended_at) AS ended_at, COUNT(*) AS span_count,
              SUM(kind = 'llm') AS llm_calls, SUM(CASE WHEN kind = 'llm' THEN COALESCE(cost_usd, 0) ELSE 0 END) AS cost_usd,
              SUM(CASE WHEN kind = 'llm' THEN COALESCE(input_tokens, 0) ELSE 0 END) AS input_tokens,
              SUM(CASE WHEN kind = 'llm' THEN COALESCE(output_tokens, 0) ELSE 0 END) AS output_tokens,
              SUM(status = 'running') AS running, GROUP_CONCAT(DISTINCT agent_id) AS agent_ids
       FROM spans GROUP BY trace_id ORDER BY MIN(started_at) DESC LIMIT ?`,
      limit,
    );
  }

  traceAggregate(traceId: string): Row | undefined {
    return one(
      this.db,
      `SELECT trace_id, MIN(started_at) AS started_at, MAX(ended_at) AS ended_at, COUNT(*) AS span_count,
              SUM(kind = 'llm') AS llm_calls, SUM(CASE WHEN kind = 'llm' THEN COALESCE(cost_usd, 0) ELSE 0 END) AS cost_usd,
              SUM(CASE WHEN kind = 'llm' THEN COALESCE(input_tokens, 0) ELSE 0 END) AS input_tokens,
              SUM(CASE WHEN kind = 'llm' THEN COALESCE(output_tokens, 0) ELSE 0 END) AS output_tokens,
              SUM(status = 'running') AS running, GROUP_CONCAT(DISTINCT agent_id) AS agent_ids
       FROM spans WHERE trace_id = ? GROUP BY trace_id`,
      traceId,
    );
  }

  /** Root spans (no parent) of a trace. */
  roots(traceId: string): Span[] {
    return all(this.db, "SELECT * FROM spans WHERE trace_id = ? AND parent_span_id IS NULL ORDER BY started_at", traceId).map(toSpan);
  }
}

export class EventRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Appends one event and returns its monotonic seq. */
  append(event: Omit<CompanyEvent, "seq">): number {
    const row = one(
      this.db,
      `INSERT INTO events (id, type, at, agent_id, task_id, run_id, trace_id, summary, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      event.id,
      event.type,
      event.at,
      event.agentId,
      event.taskId,
      event.runId,
      event.traceId,
      event.summary,
      JSON.stringify(event.data ?? null),
    );
    return Number(row?.seq);
  }

  since(seq: number, limit: number): CompanyEvent[] {
    return all(this.db, "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", seq, limit).map(toEvent);
  }

  /** The newest `limit` events, oldest first (the console's boot/resync window). */
  tail(limit: number): CompanyEvent[] {
    return all(this.db, "SELECT * FROM (SELECT * FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq", limit).map(toEvent);
  }

  latestSeq(): number {
    return Number(one(this.db, "SELECT MAX(seq) AS s FROM events")?.s ?? 0);
  }
}

export interface SpendTotals {
  costUsd: number;
  frontierCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export class SpendRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(entry: SpendEntry & { departmentId: string | null; at: string }): void {
    insertRow(this.db, "spend", { ...entry });
  }

  /** Totals since `fromIso`, optionally for one agent or department. */
  totals(fromIso: string, scope: { agentId?: string; departmentId?: string } = {}): SpendTotals {
    const clauses = ["at >= ?"];
    const params: string[] = [fromIso];
    if (scope.agentId) {
      clauses.push("agent_id = ?");
      params.push(scope.agentId);
    }
    if (scope.departmentId) {
      clauses.push("department_id = ?");
      params.push(scope.departmentId);
    }
    const row = one(
      this.db,
      `SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(frontier_cost_usd),0) AS f, COALESCE(SUM(input_tokens),0) AS i,
              COALESCE(SUM(output_tokens),0) AS o, COUNT(*) AS n FROM spend WHERE ${clauses.join(" AND ")}`,
      ...params,
    );
    return {
      costUsd: Number(row?.c ?? 0),
      frontierCostUsd: Number(row?.f ?? 0),
      inputTokens: Number(row?.i ?? 0),
      outputTokens: Number(row?.o ?? 0),
      calls: Number(row?.n ?? 0),
    };
  }

  groupBy(column: "tier" | "model" | "department_id", fromIso: string): Row[] {
    return all(
      this.db,
      `SELECT ${column} AS k, COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS calls FROM spend WHERE at >= ? GROUP BY ${column} ORDER BY cost DESC`,
      fromIso,
    );
  }

  /** Hourly buckets (bucket = substr(at,1,13)) of cost/tokens since `fromIso`. */
  hourly(fromIso: string): Row[] {
    return all(
      this.db,
      `SELECT substr(at, 1, 13) AS bucket, SUM(cost_usd) AS cost, SUM(input_tokens + output_tokens) AS tokens
       FROM spend WHERE at >= ? GROUP BY bucket`,
      fromIso,
    );
  }
}
