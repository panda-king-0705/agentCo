/** Tasks, runs and approvals. */
import type { Approval, Run, Task } from "../../../../packages/shared/src/index.ts";
import type { Db } from "./database.ts";
import { toApproval, toRun, toTask } from "./mappers.ts";
import { all, insertRow, one, updateRow, whereEq } from "./sql.ts";

export const OPEN_TASK_STATUSES = ["todo", "in_progress", "waiting", "blocked"] as const;
export const TERMINAL_TASK_STATUSES = ["done", "failed", "cancelled"] as const;

export interface TaskFilter {
  status?: string;
  assigneeId?: string;
  rootTaskId?: string;
  traceId?: string;
  parentTaskId?: string | null;
  limit?: number;
  /** Archived ("cleared") tasks: include (default), exclude, or only them. */
  archived?: "include" | "exclude" | "only";
}

const TERMINAL_SQL = "('done','failed','cancelled')";

export class TaskRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(task: Task): void {
    insertRow(this.db, "tasks", { ...task });
  }

  update(id: string, patch: Partial<Task>): void {
    updateRow(this.db, "tasks", id, patch);
  }

  get(id: string): Task | null {
    const row = one(this.db, "SELECT * FROM tasks WHERE id = ?", id);
    return row ? toTask(row) : null;
  }

  list(filter: TaskFilter = {}): Task[] {
    const where = whereEq({
      status: filter.status,
      assignee_id: filter.assigneeId,
      root_task_id: filter.rootTaskId,
      trace_id: filter.traceId,
      parent_task_id: filter.parentTaskId,
    });
    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 5000);
    const archived = filter.archived === "exclude" ? "archived_at IS NULL" : filter.archived === "only" ? "archived_at IS NOT NULL" : "";
    const sql = archived ? (where.sql ? `${where.sql} AND ${archived}` : `WHERE ${archived}`) : where.sql;
    return all(this.db, `SELECT * FROM tasks ${sql} ORDER BY created_at DESC, number DESC LIMIT ${limit}`, ...where.params).map(toTask);
  }

  /**
   * Archives every finished tree: roots that are terminal and have no open task anywhere below them
   * (an objective whose subtask is still running stays on the board). Returns the tasks touched.
   */
  archiveFinished(at: string): { count: number; objectives: number } {
    const roots = all(
      this.db,
      `SELECT id FROM tasks r WHERE r.parent_task_id IS NULL AND r.archived_at IS NULL AND r.status IN ${TERMINAL_SQL}
         AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.root_task_id = r.id AND c.status NOT IN ${TERMINAL_SQL})`,
    ).map((r) => String(r.id));
    if (!roots.length) return { count: 0, objectives: 0 };
    const marks = roots.map(() => "?").join(",");
    const res = this.db.prepare(`UPDATE tasks SET archived_at = ? WHERE archived_at IS NULL AND root_task_id IN (${marks})`).run(at, ...roots);
    return { count: Number(res.changes), objectives: roots.length };
  }

  /** Restores one archive batch (its stamp), or every archived task when no batch is given. */
  unarchive(batch: string | null): { count: number; objectives: number } {
    const where = batch ? "archived_at = ?" : "archived_at IS NOT NULL";
    const params = batch ? [batch] : [];
    const objectives = Number(one(this.db, `SELECT COUNT(*) AS n FROM tasks WHERE ${where} AND parent_task_id IS NULL`, ...params)?.n ?? 0);
    const res = this.db.prepare(`UPDATE tasks SET archived_at = NULL WHERE ${where}`).run(...params);
    return { count: Number(res.changes), objectives };
  }

  /** Un-archives a whole tree (a retried task brings its objective back to the board). */
  unarchiveTree(rootTaskId: string): void {
    this.db.prepare("UPDATE tasks SET archived_at = NULL WHERE root_task_id = ? AND archived_at IS NOT NULL").run(rootTaskId);
  }

  children(parentId: string): Task[] {
    return all(this.db, "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY number", parentId).map(toTask);
  }

  /**
   * Ready work in scheduling order (priority desc, then oldest first), one page at a time.
   * Tasks whose assignee cannot run — paused or terminated (joined), or listed in
   * `excludeAssignees` (busy, out of budget, already started this pass) — never take a slot
   * in the page, so a large backlog of an ineligible agent cannot starve everyone else.
   * `after` continues from the last task of the previous page (keyset pagination).
   */
  ready(options: { limit?: number; excludeAssignees?: Iterable<string>; after?: Pick<Task, "priority" | "createdAt" | "number"> | null } = {}): Task[] {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 200), 1), 5000);
    const excluded = [...new Set(options.excludeAssignees ?? [])];
    const params: (string | number)[] = [];
    let sql = `SELECT t.* FROM tasks t JOIN agents a ON a.id = t.assignee_id
       WHERE t.status = 'todo' AND a.status NOT IN ('paused', 'terminated')`;
    if (excluded.length > 0) {
      sql += ` AND t.assignee_id NOT IN (${excluded.map(() => "?").join(", ")})`;
      params.push(...excluded);
    }
    const after = options.after;
    if (after) {
      sql += " AND (t.priority < ? OR (t.priority = ? AND (t.created_at > ? OR (t.created_at = ? AND t.number > ?))))";
      params.push(after.priority, after.priority, after.createdAt, after.createdAt, after.number);
    }
    sql += ` ORDER BY t.priority DESC, t.created_at ASC, t.number ASC LIMIT ${limit}`;
    return all(this.db, sql, ...params).map(toTask);
  }

  openForAssignee(assigneeId: string): Task[] {
    return all(
      this.db,
      "SELECT * FROM tasks WHERE assignee_id = ? AND status IN ('todo','in_progress','waiting','blocked') ORDER BY priority DESC, created_at",
      assigneeId,
    ).map(toTask);
  }

  /** Tasks currently blocked on the given approval (state.blockedOnApprovalId). */
  blockedOn(approvalId: string): Task[] {
    return all(
      this.db,
      "SELECT * FROM tasks WHERE status = 'blocked' AND json_extract(state, '$.blockedOnApprovalId') = ?",
      approvalId,
    ).map(toTask);
  }

  countByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of all(this.db, "SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")) out[String(row.status)] = Number(row.n);
    return out;
  }

  addCost(id: string, costUsd: number): void {
    this.db.prepare("UPDATE tasks SET actual_cost_usd = actual_cost_usd + ? WHERE id = ?").run(costUsd, id);
  }
}

export interface RunFilter {
  agentId?: string;
  taskId?: string;
  status?: string;
  limit?: number;
}

export class RunRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(run: Run): void {
    const { usage, ...rest } = run;
    insertRow(this.db, "runs", {
      ...rest,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
    });
  }

  update(id: string, patch: Partial<Omit<Run, "usage">>): void {
    updateRow(this.db, "runs", id, patch);
  }

  get(id: string): Run | null {
    const row = one(this.db, "SELECT * FROM runs WHERE id = ?", id);
    return row ? toRun(row) : null;
  }

  list(filter: RunFilter = {}): Run[] {
    const where = whereEq({ agent_id: filter.agentId, task_id: filter.taskId, status: filter.status });
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 2000);
    return all(this.db, `SELECT * FROM runs ${where.sql} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`, ...where.params).map(toRun);
  }

  /** Runs left `running`/`queued` (used by crash recovery). */
  unfinished(): Run[] {
    return all(this.db, "SELECT * FROM runs WHERE status IN ('running','queued') ORDER BY created_at").map(toRun);
  }

  /** Adds one priced model call to the run's totals. */
  addUsage(id: string, usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number }): void {
    this.db
      .prepare(
        `UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
         cached_input_tokens = cached_input_tokens + ?, cost_usd = cost_usd + ?, llm_calls = llm_calls + 1 WHERE id = ?`,
      )
      .run(usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.costUsd, id);
  }

  incrementToolCalls(id: string): void {
    this.db.prepare("UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = ?").run(id);
  }
}

export class ApprovalRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(approval: Approval): void {
    insertRow(this.db, "approvals", { ...approval });
  }

  update(id: string, patch: Partial<Approval>): void {
    updateRow(this.db, "approvals", id, patch);
  }

  get(id: string): Approval | null {
    const row = one(this.db, "SELECT * FROM approvals WHERE id = ?", id);
    return row ? toApproval(row) : null;
  }

  list(status?: string): Approval[] {
    const where = whereEq({ status });
    return all(this.db, `SELECT * FROM approvals ${where.sql} ORDER BY created_at DESC LIMIT 500`, ...where.params).map(toApproval);
  }

  forTask(taskId: string): Approval[] {
    return all(this.db, "SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at", taskId).map(toApproval);
  }

  /** A pending approval of `kind` whose payload field `key` equals `value` (dedupe). */
  findPending(kind: string, key: string, value: string): Approval | null {
    const row = one(
      this.db,
      "SELECT * FROM approvals WHERE status = 'pending' AND kind = ? AND json_extract(payload, '$.' || ?) = ? LIMIT 1",
      kind,
      key,
      value,
    );
    return row ? toApproval(row) : null;
  }

  countPending(): number {
    return Number(one(this.db, "SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")?.n ?? 0);
  }
}
