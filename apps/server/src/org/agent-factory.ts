/** Builds Agent rows from a role template and/or CreateAgentInput (pure apart from the clock). */
import type { Agent, AgentTier, BaZiChart, CognitionKind, CreateAgentInput, ModelTier, RoleTemplate } from "../../../../packages/shared/src/index.ts";
import { newId } from "../db/ids.ts";
import { DEFAULT_AFFECT, DEFAULT_CALIBRATION } from "../db/mappers.ts";
import type { CatalogSeed } from "../catalog/service.ts";
import { buildIdentity, buildPersona } from "./identity.ts";
import { DEFAULT_AGENT_BUDGET_USD, NAME_POOL, ROLE_SEEDS, TOOLSETS } from "./templates.ts";

const COGNITION: Record<AgentTier, CognitionKind> = { executive: "brain", manager: "brain", worker: "reflex" };
const MODEL_TIER: Record<AgentTier, ModelTier> = { executive: "frontier", manager: "standard", worker: "economy" };

export interface ResolvedAgentInput {
  role: RoleTemplate | null;
  input: CreateAgentInput;
  departmentId: string;
  managerId: string | null;
  name: string;
  createdBy: string;
  /** The catalog specialist the agent is staffed from (catalog hire, or a role template's catalogId). */
  catalog?: CatalogSeed | null;
}

/** Picks a display name: explicit, then the role's unused defaults, then the pool, then "Agent N". */
export function pickName(explicit: string | undefined, role: RoleTemplate | null, taken: Set<string>): string {
  if (explicit && explicit.trim()) return explicit.trim();
  for (const name of [...(role?.defaultNames ?? []), ...NAME_POOL]) if (!taken.has(name)) return name;
  return `Agent ${taken.size + 1}`;
}

export interface BuildAgentOptions {
  /**
   * MANAGER_MODEL_TIER: the model tier a manager gets when neither the input nor its role picks a
   * non-default one (default "standard"; "frontier" = same model as the executives).
   */
  managerModelTier?: "frontier" | "standard";
}

/**
 * Model tier for a new agent: an explicit input.modelTier wins; otherwise the role's tier (or the
 * agent tier's default). A manager left on the default "standard" follows MANAGER_MODEL_TIER.
 */
export function resolveModelTier(tier: AgentTier, role: RoleTemplate | null, input: CreateAgentInput, options: BuildAgentOptions = {}): ModelTier {
  if (input.modelTier) return input.modelTier;
  const base = role && !input.tier ? role.modelTier : MODEL_TIER[tier];
  if (tier === "manager" && base === "standard" && options.managerModelTier) return options.managerModelTier;
  return base;
}

export function buildAgent(
  resolved: ResolvedAgentInput,
  now: Date,
  castBaZi: (iso: string) => BaZiChart | null,
  options: BuildAgentOptions = {},
): Agent {
  const { role, input } = resolved;
  const tier: AgentTier = input.tier ?? role?.tier ?? "worker";
  const cat = resolved.catalog ?? null;
  const title = input.title?.trim() || role?.title || cat?.title || "Agent";
  const mandate = input.mandate?.trim() || role?.mandate || cat?.mandate || `Do excellent work as ${title}.`;
  const seed = role ? ROLE_SEEDS[role.id] ?? null : null;
  const createdAt = now.toISOString();
  const persona = buildPersona(seed, { ...catalogPersona(cat, tier, seed !== null), ...(input.persona ?? {}) }, tier);
  persona.baZi = input.persona?.baZi ?? castBaZi(createdAt);
  const identity = buildIdentity({ tier, title, mandate, kpis: role?.kpis ?? [], seed });
  // BIO / Assets of a catalog worker: its playbook and the deliverable formats it brings.
  if (cat && tier === "worker") identity.assets = [...new Set([...(seed?.assets ?? []), ...cat.assets])];
  return {
    id: newId("agt"),
    name: resolved.name,
    title,
    roleId: role?.id ?? slugify(title),
    catalogId: cat?.catalogId ?? role?.catalogId ?? null,
    departmentId: resolved.departmentId,
    managerId: resolved.managerId,
    tier,
    cognition: input.cognition ?? (role && !input.tier ? role.cognition : COGNITION[tier]),
    modelTier: resolveModelTier(tier, role, input, options),
    modelOverride: input.modelOverride ?? null,
    status: "idle",
    activity: null,
    brainBlock: null,
    currentTaskId: null,
    currentRunId: null,
    identity,
    persona,
    affect: { ...DEFAULT_AFFECT },
    calibration: { ...DEFAULT_CALIBRATION },
    tools: input.tools ?? (role && !input.tier ? [...role.tools] : [...TOOLSETS[tier]]),
    monthlyBudgetUsd: input.monthlyBudgetUsd ?? DEFAULT_AGENT_BUDGET_USD[tier],
    createdBy: resolved.createdBy,
    createdAt,
    updatedAt: createdAt,
    terminatedAt: null,
  };
}

/**
 * Persona a catalog specialist seeds (workers only): emoji and vibe always; style, traits and an
 * MBTI type only when no role seed provides them (a curated role seed wins).
 */
function catalogPersona(cat: CatalogSeed | null, tier: AgentTier, hasRoleSeed: boolean): Partial<Agent["persona"]> {
  if (!cat || tier !== "worker") return {};
  const out: Partial<Agent["persona"]> = { emoji: cat.emoji || null, vibe: cat.vibe || null };
  if (!hasRoleSeed) {
    out.style = cat.style;
    if (cat.traits.length) out.traits = [...cat.traits];
    out.personalityType = cat.personalityType;
  }
  return out;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "agent";
}
