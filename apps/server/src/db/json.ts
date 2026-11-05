/** JSON column helpers. Corrupt JSON never throws into a request path. */
export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text.length === 0) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** SQLite returns numbers for REAL/INTEGER; coerce null-safe. */
export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : fallback;
}

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
