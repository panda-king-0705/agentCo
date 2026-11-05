/**
 * agency-agents markdown → CatalogAgent (pure; no I/O).
 *
 * A file is YAML-ish frontmatter (name, description, color, emoji, vibe, plus
 * optional lists such as services/tools) and a markdown body whose H2 sections
 * ("## 🧠 Your Identity & Memory", "## 🚨 Critical Rules You Must Follow", …)
 * are classified by heading into identity / mission / rules / deliverables /
 * workflow / metrics / other. Headings inside fenced code blocks (deliverable
 * templates are often fenced markdown) never start a section.
 *
 * The frontmatter reader handles the shapes found in the catalog: plain,
 * single- and double-quoted scalars, `>`/`|` block scalars, plain scalars that
 * continue on indented lines, aligned values ("name:        X") and nested lists
 * (kept raw, ignored). Anything without a closing `---`, a name or a description
 * is malformed and rejected with a reason.
 */
import type { CatalogAgent, CatalogSections } from "../../../../packages/shared/src/index.ts";

export type SectionKey = keyof CatalogSections;

export interface ParsedAgentFile {
  agent: CatalogAgent;
  /** Markdown body without the frontmatter. */
  body: string;
  /** Raw frontmatter values (strings; lists as their raw lines). */
  frontmatter: Record<string, string>;
}

export class CatalogParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogParseError";
  }
}

// ───────────────────────────── frontmatter ─────────────────────────────

const KEY_LINE = /^([A-Za-z_][\w-]*)\s*:(.*)$/;

/** Splits `---\n…\n---\n` off the top; throws CatalogParseError when it is missing/unclosed. */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!src.startsWith("---\n") && src.trim() !== "---") throw new CatalogParseError("no frontmatter (file must start with ---)");
  const end = src.indexOf("\n---", 3);
  if (end < 0) throw new CatalogParseError("unclosed frontmatter (no closing ---)");
  const after = src.indexOf("\n", end + 4);
  const closing = src.slice(end + 1, after < 0 ? undefined : after).trim();
  if (closing !== "---") throw new CatalogParseError("unclosed frontmatter (no closing ---)");
  return { frontmatter: src.slice(4, end), body: after < 0 ? "" : src.slice(after + 1) };
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\nt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Top-level `key: value` pairs. Continuation and list lines are attached to the preceding key. */
export function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^\S/.test(line) ? KEY_LINE.exec(line) : null;
    if (!m) continue; // stray indented line without a key: belongs to nothing we read
    const key = m[1] as string;
    const raw = (m[2] as string).trim();
    // Collect the indented continuation block.
    const cont: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1] as string) || (lines[i + 1] as string).trim() === "")) {
      // A blank line followed by a top-level key ends the block.
      if ((lines[i + 1] as string).trim() === "" && !/^\s+\S/.test(lines[i + 2] ?? "")) break;
      cont.push(lines[++i] as string);
    }
    if (/^[>|][+-]?$/.test(raw)) {
      const folded = raw.startsWith(">");
      const text = cont.map((l) => l.trim());
      out[key] = folded ? text.filter(Boolean).join(" ") : text.join("\n").trim();
    } else if (raw === "" && cont.some((l) => l.trim().startsWith("-"))) {
      out[key] = cont.join("\n"); // a list (services/tools): kept raw
    } else if (raw.startsWith('"') && !raw.endsWith('"') && cont.length) {
      out[key] = unquote([raw, ...cont.map((l) => l.trim())].join(" "));
    } else {
      out[key] = unquote([raw, ...cont.map((l) => l.trim())].filter(Boolean).join(" "));
    }
  }
  return out;
}

// ───────────────────────────── body sections ─────────────────────────────

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Heading text → section class (identity, mission, rules, deliverables, workflow, metrics, other). */
export function classifyHeading(heading: string): SectionKey {
  const h = heading
    .toLowerCase()
    .replace(/[^a-z0-9&/ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/identity|who you are|role definition|^your role$|^role$|^persona|about you/.test(h)) return "identity";
  if (/does not do|not to use|out of scope|boundar|guardrail|non-negotiable|anti-pattern|fail trigger|red line/.test(h)) return "rules";
  if (/^advanced|learning|memory|communication|style|example|faq|resource|reference|related|appendix|further reading|personality/.test(h)) return "other";
  if (/rule|constraint|must follow|must not|must never|principle|core beliefs|standards you/.test(h)) return "rules";
  if (/success metric|metric|kpi|measur|success criteria|how you know/.test(h)) return "metrics";
  if (/deliverable|output|template|artifact|format/.test(h)) return "deliverables";
  if (/workflow|process|methodolog|procedure|how you work|approach|playbook|operating rhythm|step/.test(h)) return "workflow";
  if (/mission|responsibilit|what you do|what you can do|capabilit|key tasks|purpose|objective|competenc|specialized skills|expertise|core focus|focus areas/.test(h)) return "mission";
  return "other";
}

export interface RawSection {
  heading: string;
  key: SectionKey;
  text: string;
}

/**
 * Splits the body into its H1 title, the preamble (text before the first H2) and
 * H2 sections; `#`-lines inside fenced code blocks are content, not headings.
 */
export function splitSections(body: string): { title: string | null; preamble: string; sections: RawSection[] } {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let fence: string | null = null;
  let title: string | null = null;
  const preamble: string[] = [];
  const sections: RawSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f) {
      const marker = (f[1] as string)[0] as string;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    } else if (fence === null) {
      const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      if (h1 && title === null && current === null && preamble.every((l) => !l.trim())) {
        title = h1[1] as string;
        continue;
      }
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      if (h2) {
        if (current) sections.push(close(current));
        current = { heading: h2[1] as string, lines: [] };
        continue;
      }
    }
    (current ? current.lines : preamble).push(line);
  }
  if (current) sections.push(close(current));
  return { title, preamble: preamble.join("\n").trim(), sections };
}

function close(s: { heading: string; lines: string[] }): RawSection {
  return { heading: s.heading, key: classifyHeading(s.heading), text: s.lines.join("\n").trim() };
}

export function emptySections(): CatalogSections {
  return { identity: "", mission: "", rules: "", deliverables: "", workflow: "", metrics: "", other: "" };
}

/** Classified sections; the preamble ("You are **X** …") opens the identity section. */
export function sectionsOf(body: string): CatalogSections {
  const { preamble, sections } = splitSections(body);
  const out = emptySections();
  const parts: Record<SectionKey, string[]> = { identity: [], mission: [], rules: [], deliverables: [], workflow: [], metrics: [], other: [] };
  if (preamble) parts.identity.push(preamble);
  const seen = new Set<SectionKey>();
  for (const s of sections) {
    if (!s.text) continue;
    // A second section of one class (and every "other" one) keeps its heading so nothing reads as run-on text.
    parts[s.key].push(s.key === "other" || seen.has(s.key) ? `### ${s.heading}\n${s.text}` : s.text);
    seen.add(s.key);
  }
  for (const key of Object.keys(parts) as SectionKey[]) out[key] = parts[key].join("\n\n").trim();
  return out;
}

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

// ───────────────────────────── one file ─────────────────────────────

/**
 * Parses one agent file. `relPath` is relative to the catalog root
 * ("engineering/engineering-cms-developer.md", "game-development/unity/unity-architect.md").
 * Throws CatalogParseError for malformed files.
 */
export function parseAgentFile(relPath: string, text: string, divisionColor?: string): ParsedAgentFile {
  const parts = relPath.replace(/\\/g, "/").split("/");
  if (parts.length < 2) throw new CatalogParseError("agent file must live in a division directory");
  const division = parts[0] as string;
  const slug = (parts[parts.length - 1] as string).replace(/\.md$/i, "");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new CatalogParseError(`unusable file name "${slug}"`);
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);
  const name = (fm.name ?? "").trim();
  const description = (fm.description ?? "").trim();
  if (!name) throw new CatalogParseError("frontmatter has no name");
  if (!description) throw new CatalogParseError("frontmatter has no description");
  if (!body.trim()) throw new CatalogParseError("empty body");
  return {
    agent: {
      id: `${division}/${slug.toLowerCase()}`,
      division,
      name,
      description: description.replace(/\s+/g, " "),
      emoji: (fm.emoji ?? "").trim(),
      vibe: (fm.vibe ?? "").trim().replace(/\s+/g, " "),
      color: normaliseColor(fm.color, divisionColor),
      sections: sectionsOf(body),
      wordCount: wordCount(body),
    },
    body,
    frontmatter: fm,
  };
}

/** Keeps hex colours; named colours ("blue", "neon-green") are passed through for CSS, unknown → division colour. */
export function normaliseColor(value: string | undefined, fallback = "#6366F1"): string {
  const v = (value ?? "").trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^[a-z]+$/i.test(v)) return v.toLowerCase();
  return fallback;
}
