/** Builds an agent's identity/persona from a role template + seed (pure). */
import type { AgentIdentity, AgentTier, Okr, Persona, RoleTemplate } from "../../../../packages/shared/src/index.ts";
import type { RoleSeed } from "./templates.ts";

const DESIRES: Record<AgentTier, [number, number, number, number]> = {
  executive: [0.65, 0.6, 0.7, 0.7],
  manager: [0.75, 0.45, 0.65, 0.5],
  worker: [0.85, 0.3, 0.6, 0.3],
};
const MOTIVATION: Record<AgentTier, [number, number, number]> = {
  executive: [0.75, 0.8, 0.85],
  manager: [0.55, 0.75, 0.7],
  worker: [0.4, 0.7, 0.6],
};

export interface IdentityInput {
  tier: AgentTier;
  title: string;
  mandate: string;
  kpis: string[];
  seed: RoleSeed | null;
}

/** OKRs derived from KPIs: one objective (the vision), up to three key results. */
export function okrsFromKpis(objective: string, kpis: string[]): Okr[] {
  if (kpis.length === 0) return [];
  return [{ objective, keyResults: kpis.slice(0, 3).map((kpi) => ({ description: `Improve ${kpi}`, target: 100, current: 0, unit: "% of quarterly goal" })) }];
}

export function buildIdentity(input: IdentityInput): AgentIdentity {
  const { tier, title, mandate, seed } = input;
  const [taskDriven, curiosity, epistemic, vision] = seed?.desires ?? DESIRES[tier];
  const [autonomy, competence, purpose] = seed?.motivation ?? MOTIVATION[tier];
  const visionText = seed?.vision ?? `Be the most dependable ${title} the company has had.`;
  const isBrain = tier !== "worker";
  return {
    mission: mandate,
    worldview: seed?.worldview ?? (isBrain ? `My domain succeeds when ${lowerFirst(mandate)}` : ""),
    lifeView: seed?.lifeView ?? (isBrain ? "Good work is useful work, done honestly and on time." : ""),
    values: seed?.values ?? ["quality", "honesty", "ownership"],
    vision: isBrain ? visionText : "",
    desires: { taskDriven, curiosity, epistemic, vision },
    motivation: { autonomy, competence, purpose },
    okrs: isBrain ? okrsFromKpis(visionText, input.kpis) : [],
    narrative: `I am the ${title}. ${mandate}`,
    assets: seed?.assets ?? [mandate],
    resourceConnections: seed?.connections ?? [],
  };
}

/** Personality used when an agent has no role seed (custom hires), so role arrangement always has a type. */
const FALLBACK_MBTI: Record<AgentTier, string> = { executive: "ENTJ", manager: "ESTJ", worker: "ISTJ" };

export function buildPersona(seed: RoleSeed | null, override: Partial<Persona> = {}, tier: AgentTier = "worker"): Persona {
  return {
    style: override.style ?? seed?.style ?? "Clear, brief and professional.",
    traits: override.traits ?? seed?.traits ?? [],
    personalityType: override.personalityType ?? seed?.mbti ?? FALLBACK_MBTI[tier],
    baZi: override.baZi ?? null,
  };
}

/** Identity input for a template role. */
export function identityForRole(role: RoleTemplate, seed: RoleSeed | null): IdentityInput {
  return { tier: role.tier, title: role.title, mandate: role.mandate, kpis: role.kpis, seed };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1).replace(/\.$/, ".");
}
