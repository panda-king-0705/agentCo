/** Small pure text helpers shared by the engines and the mock provider. */

const STOPWORDS = new Set(
  (
    "the and for with that this from into onto our your their its are was were will would shall should can could " +
    "have has had not but all any each per via about over under than then them they you who what when where why how " +
    "a an of to in on at by or as is be it we us me my mine so do does did done make made get got one two three " +
    "first new plan prepare write draft create build input task work team"
  ).split(/\s+/),
);

/** Lower-case content words (≥3 chars, no stopwords), crudely stemmed to 6 chars. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [])
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => w.slice(0, 6));
}

/** Number of distinct tokens of `a` that also appear in `b`. */
export function overlap(a: string, b: string): number {
  const bs = new Set(tokens(b));
  let n = 0;
  for (const t of new Set(tokens(a))) if (bs.has(t)) n++;
  return n;
}

/** Overlap normalised by the size of `a` (0..1). */
export function overlapRatio(a: string, b: string): number {
  const ta = new Set(tokens(a));
  if (ta.size === 0) return 0;
  return overlap(a, b) / ta.size;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function slugify(text: string, max = 48): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (s.slice(0, max).replace(/-+$/g, "") || "note");
}

export function firstSentence(text: string, max = 200): string {
  const t = text.trim().replace(/\s+/g, " ");
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return truncate(m && m[1] ? m[1] : t, max);
}

export function oneLine(text: string, max = 160): string {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}
