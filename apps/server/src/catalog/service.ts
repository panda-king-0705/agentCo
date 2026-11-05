/**
 * The specialist catalog: loads the vendored agency-agents files once per
 * process (catalog/agency-agents, docs/CATALOG.md), maps divisions onto AgentCo
 * departments (catalog/division-map.json) and serves the list / detail / search
 * used by the API, the hiring tools, the org factory and the engines
 * (CatalogView in contracts.ts).
 *
 * Malformed files are skipped and counted, never fatal; a missing catalog
 * directory yields an empty catalog (workers then run without a playbook).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Agent,
  CatalogAgent,
  CatalogAgentSummary,
  CatalogDivision,
  CatalogSource,
  CompiledPlaybook,
} from "../../../../packages/shared/src/index.ts";
import type { CatalogView } from "../contracts.ts";
import { suggestPersonalityType } from "../cognition/brain/self-management/personality.ts";
import { tokens } from "../cognition/text.ts";
import { compileExpertise, compilePlaybook, DEFAULT_EXPERTISE_TOKENS, DEFAULT_PLAYBOOK_TOKENS, inline, toUnits } from "./compile.ts";
import { CatalogParseError, parseAgentFile, splitSections } from "./parse.ts";

export const DEFAULT_CATALOG_DIR = fileURLToPath(new URL("../../../../catalog/agency-agents", import.meta.url));
export const DEFAULT_DIVISION_MAP = fileURLToPath(new URL("../../../../catalog/division-map.json", import.meta.url));
const REPO_URL = "https://github.com/msitarzewski/agency-agents";

// ───────────────────────────── division map ─────────────────────────────

export interface OptionalDepartment {
  slug: string;
  name: string;
  mandate: string;
  color: string;
  parentSlug: string | null;
  /** First holder of one of these roles owns (heads) the department. */
  ownerRoleIds: string[];
}

export interface DivisionMap {
  divisions: Record<string, { department: string; note?: string }>;
  optionalDepartments: Record<string, OptionalDepartment>;
  agentOverrides: Record<string, string>;
}

export function loadDivisionMap(path = DEFAULT_DIVISION_MAP): DivisionMap {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    divisions?: Record<string, { department: string; note?: string }>;
    optionalDepartments?: Record<string, Omit<OptionalDepartment, "slug">>;
    agentOverrides?: Record<string, string>;
  };
  const optional: Record<string, OptionalDepartment> = {};
  for (const [slug, d] of Object.entries(raw.optionalDepartments ?? {})) {
    optional[slug] = { slug, name: d.name, mandate: d.mandate, color: d.color, parentSlug: d.parentSlug ?? null, ownerRoleIds: [...(d.ownerRoleIds ?? [])] };
  }
  return { divisions: raw.divisions ?? {}, optionalDepartments: optional, agentOverrides: raw.agentOverrides ?? {} };
}

// ───────────────────────────── loading ─────────────────────────────

export interface LoadedCatalog {
  dir: string;
  agents: CatalogAgent[];
  bodies: Map<string, string>;
  divisions: Record<string, { label: string; icon: string; color: string }>;
  commit: string;
  skipped: { path: string; reason: string }[];
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...markdownFiles(p));
    else if (st.isFile() && entry.toLowerCase().endsWith(".md")) out.push(p);
  }
  return out;
}

function vendoredCommit(dir: string): string {
  const vendor = join(dir, "VENDOR.md");
  if (!existsSync(vendor)) return "unknown";
  const m = /Commit\s*\|\s*`([0-9a-f]{7,40}|unknown)`/.exec(readFileSync(vendor, "utf8"));
  return m?.[1] ?? "unknown";
}

/** Reads every division's markdown files; malformed ones are skipped with a reason. */
export function loadCatalogDir(dir: string): LoadedCatalog {
  const result: LoadedCatalog = { dir, agents: [], bodies: new Map(), divisions: {}, commit: "unknown", skipped: [] };
  const divisionsPath = join(dir, "divisions.json");
  if (!existsSync(divisionsPath)) return result;
  try {
    const doc = JSON.parse(readFileSync(divisionsPath, "utf8")) as { divisions?: Record<string, { label?: string; icon?: string; color?: string }> };
    for (const [id, d] of Object.entries(doc.divisions ?? {})) result.divisions[id] = { label: d.label ?? id, icon: d.icon ?? "Box", color: d.color ?? "#6366F1" };
  } catch (error) {
    result.skipped.push({ path: "divisions.json", reason: error instanceof Error ? error.message : String(error) });
    return result;
  }
  result.commit = vendoredCommit(dir);
  const seen = new Set<string>();
  for (const division of Object.keys(result.divisions)) {
    const ddir = join(dir, division);
    if (!existsSync(ddir)) continue;
    for (const file of markdownFiles(ddir)) {
      const rel = relative(dir, file).replace(/\\/g, "/");
      try {
        const parsed = parseAgentFile(rel, readFileSync(file, "utf8"), result.divisions[division]?.color);
        if (seen.has(parsed.agent.id)) throw new CatalogParseError(`duplicate id ${parsed.agent.id}`);
        seen.add(parsed.agent.id);
        result.agents.push(parsed.agent);
        result.bodies.set(parsed.agent.id, parsed.body);
      } catch (error) {
        result.skipped.push({ path: rel, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return result;
}

const cache = new Map<string, LoadedCatalog>();

/** Loads once per process per directory (tests boot many apps). */
export function loadCatalogCached(dir: string): LoadedCatalog {
  const key = resolve(dir);
  let loaded = cache.get(key);
  if (!loaded) {
    loaded = loadCatalogDir(key);
    cache.set(key, loaded);
  }
  return loaded;
}

// ───────────────────────────── the catalog ─────────────────────────────

export interface CatalogOptions {
  playbookTokens?: number;
  expertiseTokens?: number;
}

/** What a catalog specialist contributes to a new agent (agent-factory.ts). */
export interface CatalogSeed {
  catalogId: string;
  title: string;
  mandate: string;
  style: string;
  traits: string[];
  emoji: string;
  vibe: string;
  personalityType: string;
  assets: string[];
}

export interface CatalogFilter {
  division?: string | null;
  q?: string | null;
}

export class Catalog implements CatalogView {
  readonly map: DivisionMap;
  private readonly data: LoadedCatalog;
  private readonly byId: Map<string, CatalogAgent>;
  private readonly playbookTokens: number;
  private readonly expertiseTokens: number;
  private readonly playbooks = new Map<string, CompiledPlaybook>();
  private readonly expertiseCache = new Map<string, string>();

  constructor(data: LoadedCatalog, map: DivisionMap, options: CatalogOptions = {}) {
    this.data = data;
    this.map = map;
    this.byId = new Map(data.agents.map((a) => [a.id, a]));
    this.playbookTokens = options.playbookTokens ?? DEFAULT_PLAYBOOK_TOKENS;
    this.expertiseTokens = options.expertiseTokens ?? DEFAULT_EXPERTISE_TOKENS;
  }

  get size(): number {
    return this.data.agents.length;
  }

  get skipped(): readonly { path: string; reason: string }[] {
    return this.data.skipped;
  }

  source(): CatalogSource {
    return { repo: REPO_URL, commit: this.data.commit, license: "MIT", agents: this.size, skipped: this.data.skipped.length };
  }

  all(): readonly CatalogAgent[] {
    return this.data.agents;
  }

  get(id: string): CatalogAgent | null {
    return this.byId.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  body(id: string): string {
    return this.data.bodies.get(id) ?? "";
  }

  /** The AgentCo department slug a specialist lands in (override, else its division's default). */
  departmentSlugFor(id: string): string {
    const agent = this.get(id);
    const division = agent?.division ?? id.split("/")[0] ?? "";
    return this.map.agentOverrides[id] ?? this.map.divisions[division]?.department ?? "operations";
  }

  optionalDepartment(slug: string): OptionalDepartment | null {
    return this.map.optionalDepartments[slug] ?? null;
  }

  divisions(): CatalogDivision[] {
    const counts = new Map<string, number>();
    for (const a of this.data.agents) counts.set(a.division, (counts.get(a.division) ?? 0) + 1);
    return Object.entries(this.data.divisions).map(([id, d]) => {
      const departmentSlug = this.map.divisions[id]?.department ?? "operations";
      return { id, label: d.label, icon: d.icon, color: d.color, count: counts.get(id) ?? 0, departmentSlug, optional: departmentSlug in this.map.optionalDepartments };
    });
  }

  divisionLabel(id: string): string {
    return this.data.divisions[id]?.label ?? id;
  }

  /** Filtered list; with `q`, ranked by relevance (name ≫ description/vibe ≫ mission). */
  list(filter: CatalogFilter = {}): CatalogAgent[] {
    const division = filter.division?.trim() || null;
    const pool = division ? this.data.agents.filter((a) => a.division === division) : [...this.data.agents];
    const q = filter.q?.trim();
    if (!q) return pool;
    return this.rank(q, pool).map((r) => r.agent);
  }

  /** Relevance search for the hiring tool (catalog_search). */
  search(query: string, options: { division?: string | null; limit?: number } = {}): CatalogAgent[] {
    return this.list({ q: query, division: options.division ?? null }).slice(0, Math.max(1, options.limit ?? 8));
  }

  private rank(q: string, pool: CatalogAgent[]): { agent: CatalogAgent; score: number }[] {
    const needle = q.toLowerCase();
    const terms = [...new Set(tokens(q))];
    const out: { agent: CatalogAgent; score: number }[] = [];
    for (const agent of pool) {
      const name = agent.name.toLowerCase();
      let score = name.includes(needle) ? 10 : 0;
      if (agent.id.includes(needle)) score += 4;
      if (terms.length) {
        const nameT = new Set(tokens(`${agent.name} ${agent.id}`));
        const descT = new Set(tokens(`${agent.description} ${agent.vibe} ${this.divisionLabel(agent.division)}`));
        const missionT = new Set(tokens(agent.sections.mission.slice(0, 2000)));
        for (const t of terms) score += (nameT.has(t) ? 3 : 0) + (descT.has(t) ? 2 : 0) + (missionT.has(t) ? 0.5 : 0);
      }
      if (score > 0) out.push({ agent, score });
    }
    return out.sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name));
  }

  summary(agent: CatalogAgent, context: { departmentName: (slug: string) => string; hiredCount: (id: string) => number }): CatalogAgentSummary {
    const departmentSlug = this.departmentSlugFor(agent.id);
    return {
      id: agent.id,
      division: agent.division,
      divisionLabel: this.divisionLabel(agent.division),
      name: agent.name,
      description: agent.description,
      emoji: agent.emoji,
      vibe: agent.vibe,
      color: agent.color,
      wordCount: agent.wordCount,
      departmentSlug,
      departmentName: context.departmentName(departmentSlug),
      optionalDepartment: departmentSlug in this.map.optionalDepartments,
      hiredCount: context.hiredCount(agent.id),
    };
  }

  playbook(id: string): CompiledPlaybook | null {
    const agent = this.get(id);
    if (!agent) return null;
    let compiled = this.playbooks.get(id);
    if (!compiled) {
      compiled = compilePlaybook(agent, this.playbookTokens);
      this.playbooks.set(id, compiled);
    }
    return compiled;
  }

  expertise(id: string): string | null {
    const agent = this.get(id);
    if (!agent) return null;
    let text = this.expertiseCache.get(id);
    if (text === undefined) {
      text = compileExpertise(agent, this.expertiseTokens);
      this.expertiseCache.set(id, text);
    }
    return text;
  }

  /** Persona, title, mandate and assets a new hire takes from the specialist. */
  seed(id: string): CatalogSeed | null {
    const agent = this.get(id);
    if (!agent) return null;
    return {
      catalogId: agent.id,
      title: agent.name,
      mandate: agent.description.length > 300 ? `${agent.description.slice(0, 299).trimEnd()}…` : agent.description,
      style: this.communicationStyle(agent) || agent.vibe || "Clear, brief and professional.",
      traits: personalityTraits(agent),
      emoji: agent.emoji,
      vibe: agent.vibe,
      personalityType: suggestPersonalityType(`${agent.description} ${agent.sections.mission.slice(0, 1500)}`),
      assets: this.assets(agent),
    };
  }

  /** BIO / Assets: the playbook itself plus the deliverable formats it brings. */
  assets(agent: CatalogAgent): string[] {
    const formats = toUnits(agent.sections.deliverables)
      .filter((u) => u.endsWith(":"))
      .map((u) => u.slice(0, -1))
      .filter((u) => u.length <= 60)
      .slice(0, 3);
    return [`${agent.emoji ? `${agent.emoji} ` : ""}${agent.name} playbook (agency-agents)`, ...formats];
  }

  private communicationStyle(agent: CatalogAgent): string {
    const section = splitSections(this.body(agent.id)).sections.find((s) => /communication/i.test(s.heading));
    const first = section ? toUnits(section.text).find((u) => u.startsWith("- ") || u.length > 20) : undefined;
    if (!first) return "";
    const text = first.replace(/^- /, "");
    return text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
  }

  // ───────── CatalogView (engines) ─────────

  /** Workers: the compiled specialist playbook. */
  playbookFor(agent: Agent): string | null {
    if (!agent.catalogId || agent.tier !== "worker") return null;
    return this.playbook(agent.catalogId)?.text ?? null;
  }

  /** Executives and managers: the short domain-expertise paragraph. */
  expertiseFor(agent: Agent): string | null {
    if (!agent.catalogId || agent.tier === "worker") return null;
    return this.expertise(agent.catalogId);
  }

  /** Role Arrangement: the specialist's description and (the start of) its mission. */
  profileFor(agent: Agent): string | null {
    const spec = agent.catalogId && agent.tier === "worker" ? this.get(agent.catalogId) : null;
    if (!spec) return null;
    const mission = toUnits(spec.sections.mission).join(" ");
    return `${spec.name}. ${spec.description} ${mission.length > 600 ? mission.slice(0, 600) : mission}`;
  }
}

/** "**Personality**: Blunt, evidence-led, practical" → ["blunt", "evidence-led", "practical"]. */
export function personalityTraits(agent: CatalogAgent): string[] {
  const m = /personality\*{0,2}\s*:\s*\*{0,2}\s*([^\n]+)/i.exec(agent.sections.identity);
  if (!m) return [];
  return inline(m[1] as string)
    .split(/,|;| and /)
    .map((t) => t.trim().toLowerCase().replace(/[.]+$/, ""))
    .filter((t) => t.length > 1 && t.length <= 28 && !/^(you|your|the)\b/.test(t))
    .slice(0, 4);
}

/** Boot entry point: the cached load of `dir` plus the division map. Logs the skipped count once. */
export function createCatalog(options: CatalogOptions & { dir?: string; mapPath?: string; log?: (line: string) => void } = {}): Catalog {
  const dir = options.dir ?? DEFAULT_CATALOG_DIR;
  const fresh = !cache.has(resolve(dir));
  const data = loadCatalogCached(dir);
  const catalog = new Catalog(data, loadDivisionMap(options.mapPath ?? DEFAULT_DIVISION_MAP), options);
  if (fresh) {
    const log = options.log ?? ((line: string) => console.log(line));
    if (data.agents.length === 0) log(`[catalog] no specialists loaded from ${dir} (workers run without playbooks)`);
    else log(`[catalog] ${data.agents.length} specialists loaded${data.skipped.length ? `, ${data.skipped.length} malformed file(s) skipped` : ""}`);
  }
  return catalog;
}
