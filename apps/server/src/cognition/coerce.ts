/**
 * Defensive coercion of model JSON: every field has a default, so a model that
 * returns garbage degrades the run instead of crashing it.
 */

export type Json = Record<string, unknown>;

export function obj(v: unknown): Json {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function num(v: unknown, def: number, min = -Infinity, max = Infinity): number {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) n = Number(v);
  else return def;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** 0..1, also accepting percentages (e.g. 75 → 0.75). */
export function unit(v: unknown, def: number): number {
  const n = num(v, Number.NaN);
  if (Number.isNaN(n)) return def;
  const scaled = n > 1 && n <= 100 ? n / 100 : n;
  return Math.min(1, Math.max(0, scaled));
}

export function str(v: unknown, def: string, maxLen = 2000): string {
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, maxLen);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return def;
}

export function strArr(v: unknown, maxItems = 8, maxLen = 300): string[] {
  const out: string[] = [];
  for (const item of arr(v)) {
    const s =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? String((item as Json).text ?? (item as Json).description ?? (item as Json).title ?? "")
          : "";
    if (s.trim()) out.push(s.trim().slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

export function bool(v: unknown, def: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "yes") return true;
  if (v === "false" || v === "no") return false;
  return def;
}

export function oneOf<T extends string>(v: unknown, options: readonly T[], def: T): T {
  if (typeof v !== "string") return def;
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (options as readonly string[]).includes(s) ? (s as T) : def;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
