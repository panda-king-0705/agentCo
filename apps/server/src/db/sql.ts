/** Tiny SQL helpers shared by the repositories. */
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "./database.ts";
import type { Row } from "./mappers.ts";

export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

/** Converts a JS value to a bindable SQLite value (objects/arrays → JSON, booleans → 0/1). */
export function bind(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  return JSON.stringify(value);
}

/** INSERT a record whose camelCase keys map 1:1 to snake_case columns. */
export function insertRow(db: Db, table: string, record: Record<string, unknown>): void {
  const keys = Object.keys(record);
  const columns = keys.map(camelToSnake).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`).run(...keys.map((k) => bind(record[k])));
}

/** UPDATE the given camelCase fields of one row by id. No-op for an empty patch. */
export function updateRow(db: Db, table: string, id: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${camelToSnake(k)} = ?`).join(", ");
  db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(...keys.map((k) => bind(patch[k])), id);
}

export function all(db: Db, sql: string, ...params: SQLInputValue[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

export function one(db: Db, sql: string, ...params: SQLInputValue[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

/** Builds "WHERE a = ? AND b = ?" from optional equality filters (undefined/empty skipped). */
export function whereEq(filters: Record<string, string | null | undefined>): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  for (const [column, value] of Object.entries(filters)) {
    if (value === undefined || value === "") continue;
    if (value === null) clauses.push(`${column} IS NULL`);
    else {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  return { sql: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}
