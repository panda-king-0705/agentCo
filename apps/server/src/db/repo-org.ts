/** Settings, counters, departments and agents. */
import type { Agent, Department } from "../../../../packages/shared/src/index.ts";
import type { Db } from "./database.ts";
import { parseJson } from "./json.ts";
import { toAgent, toDepartment } from "./mappers.ts";
import { all, insertRow, one, updateRow } from "./sql.ts";

export class SettingsRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get<T>(key: string, fallback: T): T {
    const row = one(this.db, "SELECT value FROM settings WHERE key = ?", key);
    return row ? parseJson<T>(row.value, fallback) : fallback;
  }

  has(key: string): boolean {
    return one(this.db, "SELECT 1 AS x FROM settings WHERE key = ?", key) !== undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  /** Atomically increments and returns a named counter (task numbers). */
  nextCounter(name: string): number {
    const row = one(
      this.db,
      "INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value",
      name,
    );
    return Number(row?.value ?? 1);
  }
}

export class DepartmentRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(department: Department): void {
    insertRow(this.db, "departments", { ...department });
  }

  update(id: string, patch: Partial<Department>): void {
    updateRow(this.db, "departments", id, patch);
  }

  get(id: string): Department | null {
    const row = one(this.db, "SELECT * FROM departments WHERE id = ?", id);
    return row ? toDepartment(row) : null;
  }

  bySlug(slug: string): Department | null {
    const row = one(this.db, "SELECT * FROM departments WHERE slug = ?", slug);
    return row ? toDepartment(row) : null;
  }

  list(): Department[] {
    return all(this.db, "SELECT * FROM departments ORDER BY created_at, slug").map(toDepartment);
  }
}

export class AgentRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(agent: Agent): void {
    insertRow(this.db, "agents", { ...agent });
  }

  update(id: string, patch: Partial<Agent>): void {
    updateRow(this.db, "agents", id, patch);
  }

  get(id: string): Agent | null {
    const row = one(this.db, "SELECT * FROM agents WHERE id = ?", id);
    return row ? toAgent(row) : null;
  }

  /** Agents ordered for display; terminated agents included unless excluded. */
  list(filter: { status?: string; departmentId?: string; includeTerminated?: boolean } = {}): Agent[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    } else if (filter.includeTerminated === false) clauses.push("status != 'terminated'");
    if (filter.departmentId) {
      clauses.push("department_id = ?");
      params.push(filter.departmentId);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    return all(this.db, `SELECT * FROM agents ${where} ORDER BY created_at, rowid`, ...params).map(toAgent);
  }

  directReports(managerId: string): Agent[] {
    return all(this.db, "SELECT * FROM agents WHERE manager_id = ? AND status != 'terminated' ORDER BY created_at, rowid", managerId).map(toAgent);
  }

  /** Every agent ever assigned to this manager, terminated included. */
  reportCount(managerId: string): number {
    return Number(one(this.db, "SELECT COUNT(*) AS n FROM agents WHERE manager_id = ?", managerId)?.n ?? 0);
  }

  byRole(roleId: string): Agent | null {
    const row = one(this.db, "SELECT * FROM agents WHERE role_id = ? AND status != 'terminated' ORDER BY created_at LIMIT 1", roleId);
    return row ? toAgent(row) : null;
  }

  countActive(): number {
    return Number(one(this.db, "SELECT COUNT(*) AS n FROM agents WHERE status != 'terminated'")?.n ?? 0);
  }

  names(): Set<string> {
    return new Set(all(this.db, "SELECT name FROM agents").map((r) => String(r.name)));
  }
}
