/** Applies a Redactor's high-precision tier to every string inside a JSON-like value. */
import type { Redactor } from "./redact.ts";

export function redactDeep<T>(value: T, redactor: Redactor): T {
  if (typeof value === "string") return redactor.redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redactor)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, redactor)])) as T;
  }
  return value;
}
