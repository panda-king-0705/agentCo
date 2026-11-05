/**
 * Playbook compiler: CatalogAgent → the compact "specialist playbook" a worker
 * carries in its system prompt, and the one-paragraph "domain expertise" a
 * leader carries in its charter. Pure.
 *
 * Workers run on the cheapest tier and the prompt is paid on every step of
 * every run, so the playbook is capped (default 900 tokens, chars/4 like every
 * other estimate in the platform) and trimmed by section priority:
 *
 *   1. Identity        who the specialist is (the preamble + "Identity & Memory")
 *   2. Mission         what it is for
 *   3. Critical rules  what it must / must never do
 *   4. Deliverables    the formats it produces (fenced templates → their heading outline)
 *
 * Every section first gets a minimum share (identity 2 units, mission 3, rules 4,
 * deliverables 3; a unit is one bullet, sub-heading or paragraph, ≤ 220 chars),
 * then the remaining budget is filled in priority order. Workflow, metrics and
 * the rest are left to the full text in the console.
 */
import type { CatalogAgent, CompiledPlaybook } from "../../../../packages/shared/src/index.ts";

export const DEFAULT_PLAYBOOK_TOKENS = 900;
export const DEFAULT_EXPERTISE_TOKENS = 120;
const UNIT_CHARS = 220;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

type Part = "identity" | "mission" | "rules" | "deliverables";
const PARTS: { key: Part; title: string; min: number; max: number }[] = [
  { key: "identity", title: "Identity", min: 2, max: 5 },
  { key: "mission", title: "Mission", min: 3, max: 8 },
  { key: "rules", title: "Critical rules", min: 4, max: 14 },
  { key: "deliverables", title: "Deliverable formats", min: 3, max: 12 },
];

/** Strips inline markdown (bold, code, links, images, html) from one line. */
export function inline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Markdown → prompt-ready units: bullets and numbered items stay one unit each,
 * paragraphs are joined, `###` sub-headings become "Heading:" units, tables become
 * "a | b" rows (separator rows dropped) and fenced blocks become one outline unit
 * (the headings of a fenced markdown template) or are dropped (code).
 */
export function toUnits(markdown: string, options: { keepFenceOutline?: boolean } = {}): string[] {
  const units: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) units.push(cut(inline(para.join(" ")), UNIT_CHARS));
    para = [];
  };
  let fence: { marker: string; outline: string[] } | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const marker = (f[1] as string)[0] as string;
      if (!fence) {
        flush();
        fence = { marker, outline: [] };
      } else if (fence.marker === marker) {
        if (options.keepFenceOutline && fence.outline.length) units.push(cut(`Template outline: ${fence.outline.join(" › ")}`, UNIT_CHARS));
        fence = null;
      }
      continue;
    }
    if (fence) {
      const h = /^\s*#{1,4}\s+(.+)$/.exec(line);
      if (h && fence.outline.length < 10) fence.outline.push(inline(h[1] as string).replace(/[:.]$/, ""));
      continue;
    }
    if (!line.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      continue;
    }
    const heading = /^\s*#{3,6}\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const text = inline(heading[1] as string).replace(/[:.]$/, "");
      if (text) units.push(`${cut(text, UNIT_CHARS - 1)}:`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue;
      const cells = line.split("|").map((c) => inline(c)).filter(Boolean);
      if (cells.length) units.push(cut(cells.join(" | "), UNIT_CHARS));
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      const text = inline(bullet[1] as string);
      if (text) units.push(cut(`- ${text}`, UNIT_CHARS));
      continue;
    }
    para.push(line.replace(/^\s*>\s?/, ""));
  }
  flush();
  return units.filter((u) => u.replace(/[-:\s…]/g, "").length > 1);
}

/** The units of each playbook part (identity falls back to the description). */
export function playbookUnits(agent: CatalogAgent): Record<Part, string[]> {
  const s = agent.sections;
  // "Memory: you remember …" lines describe a memory the platform provides itself; skip them.
  const identity: string[] = [];
  let skippingMemoryList = false;
  for (const u of toUnits(s.identity)) {
    if (/^(- )?(memory|you remember)\b/i.test(u)) {
      skippingMemoryList = /^you remember/i.test(u);
      continue;
    }
    if (skippingMemoryList && u.startsWith("- ")) continue;
    skippingMemoryList = false;
    identity.push(u);
  }
  return {
    identity: identity.length ? identity : [`You are ${agent.name}: ${cut(agent.description, UNIT_CHARS)}`],
    mission: toUnits(s.mission),
    rules: toUnits(s.rules),
    deliverables: toUnits(s.deliverables, { keepFenceOutline: true }),
  };
}

/**
 * Compiles the specialist playbook under `maxTokens` (≥ 120). The header names the
 * specialist and its vibe; sections appear in priority order.
 */
export function compilePlaybook(agent: CatalogAgent, maxTokens = DEFAULT_PLAYBOOK_TOKENS): CompiledPlaybook {
  const cap = Math.max(120, Math.floor(maxTokens));
  const maxChars = cap * 4;
  const header = [`Specialist playbook — ${agent.emoji ? `${agent.emoji} ` : ""}${agent.name} (agency-agents ${agent.id})`, agent.vibe ? `Vibe: ${cut(agent.vibe, 140)}` : ""]
    .filter(Boolean)
    .join("\n");
  const units = playbookUnits(agent);
  const picked: Record<Part, string[]> = { identity: [], mission: [], rules: [], deliverables: [] };
  const titleCost = (key: Part) => (picked[key].length === 0 ? `\n\n${PARTS.find((p) => p.key === key)!.title}:`.length : 0);
  let used = header.length;
  let dropped = false;

  const tryAdd = (key: Part, unit: string): boolean => {
    const cost = titleCost(key) + 1 + unit.length;
    if (used + cost <= maxChars) {
      used += cost;
      picked[key].push(unit);
      return true;
    }
    // Last resort for a section's first unit: a shortened one.
    const room = maxChars - used - titleCost(key) - 1;
    if (picked[key].length === 0 && room >= 60) {
      const short = cut(unit, room);
      used += titleCost(key) + 1 + short.length;
      picked[key].push(short);
    }
    return false;
  };

  // Phase 1: every part gets its minimum share, in priority order.
  for (const p of PARTS) {
    for (const unit of units[p.key].slice(0, p.min)) if (!tryAdd(p.key, unit)) break;
  }
  // Phase 2: the remaining budget goes to the parts in priority order, up to each part's max.
  for (const p of PARTS) {
    for (const unit of units[p.key].slice(picked[p.key].length, p.max)) if (!tryAdd(p.key, unit)) break;
  }
  for (const p of PARTS) {
    if (units[p.key].length > picked[p.key].length) dropped = true;
    // A sub-heading with nothing after it says nothing; drop trailing ones (deliverables keep them: they name formats).
    if (p.key !== "deliverables") while (picked[p.key].length > 1 && picked[p.key][picked[p.key].length - 1]!.endsWith(":")) picked[p.key].pop();
  }

  const body = PARTS.filter((p) => picked[p.key].length > 0).map((p) => `${p.title}:\n${picked[p.key].join("\n")}`);
  let text = [header, ...body].join("\n\n");
  if (text.length > maxChars) {
    text = cut(text, maxChars); // unreachable by construction; keeps the cap a hard guarantee
    dropped = true;
  }
  return { text, tokens: estimateTokens(text), maxTokens: cap, truncated: dropped, sections: PARTS.filter((p) => picked[p.key].length > 0).map((p) => p.key) };
}

/**
 * The short "domain expertise" paragraph for executives and managers (their brain
 * charter is paid on every stage, so it stays around 120 tokens): the specialist's
 * description and its top critical rules.
 */
export function compileExpertise(agent: CatalogAgent, maxTokens = DEFAULT_EXPERTISE_TOKENS): string {
  const maxChars = Math.max(160, Math.floor(maxTokens) * 4);
  const head = `Domain expertise (${agent.name}, agency-agents): ${cut(firstSentence(agent.description), 220)}`;
  const rules = toUnits(agent.sections.rules)
    .filter((u) => u.startsWith("- "))
    .map((u) => cut(firstSentence(u.slice(2)).replace(/[.!?…]+$/, ""), 110));
  let text = head;
  const picked: string[] = [];
  for (const r of rules.slice(0, 3)) {
    const next = `${head} Key rules: ${[...picked, r].join("; ")}.`;
    if (next.length > maxChars) break;
    picked.push(r);
    text = next;
  }
  return cut(text, maxChars);
}

function firstSentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return m && m[1] ? m[1] : t;
}
