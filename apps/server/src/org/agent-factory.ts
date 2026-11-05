/** Builds Agent rows from a role template and/or CreateAgentInput (pure apart from the clock). */
import type { Agent, AgentTier, BaZiChart, CognitionKind, CreateAgentInput, ModelTier, RoleTemplate } from "../../../../packages/shared/src/index.ts";
import { newId } from "../db/ids.ts";
import { DEFAULT_AFFECT, DEFAULT_CALIBRATION } from "../db/mappers.ts";
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
}

/** Picks a display name: explicit, then the role's unused defaults, then the pool, then "Agent N". */
export function pickName(explicit: string | undefined, role: RoleTemplate | null, taken: Set<string>): string {
  if (explicit && explicit.trim()) return explicit.trim();
  for (const name of [...(role?.defaultNames ?? []), ...NAME_POOL]) if (!taken.has(name)) return name;
  return `Agent ${taken.size + 1}`;
}

export function buildAgent(resolved: ResolvedAgentInput, now: Date, castBaZi: (iso: string) => BaZiChart | null): Agent {
  const { role, input } = resolved;
  const tier: AgentTier = input.tier ?? role?.tier ?? "worker";
  const title = input.title?.trim() || role?.title || "Agent";
  const mandate = input.mandate?.trim() || role?.mandate || `Do excellent work as ${title}.`;
  const seed = role ? ROLE_SEEDS[role.id] ?? null : null;
  const createdAt = now.toISOString();
  const persona = buildPersona(seed, input.persona ?? {}, tier);
  persona.baZi = input.persona?.baZi ?? castBaZi(createdAt);
  return {
    id: newId("agt"),
    name: resolved.name,
    title,
    roleId: role?.id ?? slugify(title),
    departmentId: resolved.departmentId,
    managerId: resolved.managerId,
    tier,
    cognition: input.cognition ?? (role && !input.tier ? role.cognition : COGNITION[tier]),
    modelTier: input.modelTier ?? (role && !input.tier ? role.modelTier : MODEL_TIER[tier]),
    modelOverride: input.modelOverride ?? null,
    status: "idle",
    activity: null,
    brainBlock: null,
    currentTaskId: null,
    currentRunId: null,
    identity: buildIdentity({ tier, title, mandate, kpis: role?.kpis ?? [], seed }),
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

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "agent";
}
