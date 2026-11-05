/**
 * Robust JSON-object extraction for model output: strips ```json fences,
 * tolerates prose around the object, and returns null when nothing parses.
 */

/** Index just past the balanced {...} starting at `start` (text[start] must be "{"), or -1. */
export function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  let s = text.trim();
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(s);
  if (fence && fence[1]) s = fence[1].trim();
  try {
    const direct = asObject(JSON.parse(s));
    if (direct) return direct;
  } catch {
    /* fall through to scanning */
  }
  for (let i = s.indexOf("{"); i >= 0; i = s.indexOf("{", i + 1)) {
    const end = balancedObjectEnd(s, i);
    if (end < 0) continue;
    try {
      const obj = asObject(JSON.parse(s.slice(i, end)));
      if (obj) return obj;
    } catch {
      /* try the next "{" */
    }
  }
  return null;
}

/** Tool-call argument strings from providers: object, JSON string, or garbage → {}. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  const parsed = parseJsonObject(raw);
  return parsed ?? { _raw: raw.slice(0, 2000) };
}
