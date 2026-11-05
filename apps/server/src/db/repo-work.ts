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
}

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
    return all(this.db, `SELECT * FROM tasks ${where.sql} ORDER BY created_at DESC, number DESC LIMIT ${limit}`, ...where.params).map(toTask);
  }

  children(parentId: string): Task[] {
    return all(this.db, "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY number", parentId).map(toTask);
  }

  /** Ready work in scheduling order: priority desc, then oldest first. */
  ready(limit = 200): Task[] {
    return all(
      this.db,
      `SELECT * FROM tasks WHERE status = 'todo' AND assignee_id IS NOT NULL ORDER BY priority DESC, created_at ASC, number ASC LIMIT ${limit}`,
    ).map(toTask);
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
