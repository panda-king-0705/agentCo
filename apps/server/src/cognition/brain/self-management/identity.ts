/**
 * Self-management › Identity: Self-Identity → Desire → Motivation (drives).
 *
 * Self-Identity (worldview, life view → value, BIO/assets, resource
 * connection) becomes the identity charter at the top of every brain prompt.
 * Desire and Motivation become numeric drives that change behaviour; Emotion
 * (Sensibility) and Maslow's needs modulate Motivation.
 */
import type { Agent, AgentIdentity, AffectState, NeedsState } from "../../../../../../packages/shared/src/index.ts";
import { clamp, round } from "../../coerce.ts";
import { truncate } from "../../text.ts";
import type { AgentFacts } from "../../prompt.ts";
import { alignmentMultiplier, Q1_LABELS, Q5_BIO_ASSETS_LABEL } from "../interpretation.ts";
import { block, toolContext, type BrainRun } from "../runtime.ts";
import { toneFor } from "./personality.ts";

export type NeedLevel = "physiological" | "safety" | "belonging" | "esteem" | "self_actualization";

export interface Drives {
  // Desire (effective, 0..1)
  taskDriven: number;
  curiosity: number;
  epistemic: number;
  vision: number;
  // Motivation (effective, 0..1)
  autonomy: number;
  competence: number;
  purpose: number;
  needs: NeedsState;
  lowestUnmetNeed: NeedLevel | null;
  /** physiological low: only essential work (skip optional model calls, minimal plans). */
  essentialOnly: boolean;
  /** safety low (or physiological): cheapest acceptable candidate, no revisions. */
  conservation: boolean;
  /** belonging low: reach out to the manager chain first. */
  reachOutFirst: boolean;
  /** esteem low: stricter self-evaluation. */
  strictSelfEvaluation: boolean;
  // Derived behaviour
  recallK: number; // literature review breadth: 4 + 4·curiosity
  perspectives: number; // 2 + round(2·curiosity), −1 when strongly task-driven
  truthfulGate: number; // 0.6 + 0.3·epistemic
  visionMultiplier: number; // 1 + 0.5·vision·(0.5 + purpose) for vision/OKR-aligned work (Purpose → OKR weighting)
  earlyStopThreshold: number; // 0.25, +0.1 when autonomy is low
  maxSolveSteps: number; // ≤ 8, shorter when strongly task-driven
  frustrationGate: boolean; // frustration > 0.7 forces the early stop
  /** Notes explaining every modulation, for the trace. */
  notes: string[];
}

export const EARLY_STOP_BASE = 0.25;
export const LOW_AUTONOMY = 0.4;
export const FRUSTRATION_LIMIT = 0.7;

/** Maslow: the lowest unmet need steers behaviour. */
export function lowestUnmetNeed(needs: NeedsState): NeedLevel | null {
  if (needs.physiological === "low") return "physiological";
  if (needs.safety === "low") return "safety";
  if (needs.belonging === "low") return "belonging";
  if (needs.esteem === "low") return "esteem";
  if (needs.selfActualization < 1) return "self_actualization";
  return null;
}

/** Desire → Motivation ← Emotion, needs. Pure. */
export function computeDrives(identity: AgentIdentity, affect: AffectState, needs: NeedsState): Drives {
  const notes: string[] = [];
  let curiosity = identity.desires.curiosity;
  let autonomy = identity.motivation.autonomy;
  // Sensibility/Emotion → Motivation.
  if (affect.valence < -0.3) {
    autonomy -= 0.1;
    notes.push("negative valence lowers autonomy by 0.1");
  }
  if (affect.valence > 0.3) {
    curiosity += 0.1;
    notes.push("positive valence raises curiosity by 0.1");
  }
  const lowest = lowestUnmetNeed(needs);
  if (lowest === "self_actualization") {
    curiosity += 0.1;
    notes.push("self-actualisation need raises curiosity by 0.1");
  }
  curiosity = clamp(curiosity, 0, 1);
  autonomy = clamp(autonomy, 0, 1);
  const taskDriven = clamp(identity.desires.taskDriven, 0, 1);
  const epistemic = clamp(identity.desires.epistemic, 0, 1);
  const vision = clamp(identity.desires.vision ?? 0.5, 0, 1);
  const essentialOnly = needs.physiological === "low";
  const conservation = essentialOnly || needs.safety === "low";
  if (essentialOnly) notes.push("physiological need low: essential work only");
  else if (conservation) notes.push("safety need low: conservation mode");
  const reachOutFirst = lowest === "belonging";
  const strictSelfEvaluation = needs.esteem === "low";
  const lowAutonomy = autonomy < LOW_AUTONOMY;
  if (lowAutonomy) notes.push("low autonomy: early-stop threshold +0.1");
  const perspectives = clamp(2 + Math.round(2 * curiosity) - (taskDriven > 0.7 ? 1 : 0), 1, 4);
  const purpose = clamp(identity.motivation.purpose, 0, 1);
  return {
    taskDriven,
    curiosity: round(curiosity, 3),
    epistemic,
    vision,
    autonomy: round(autonomy, 3),
    competence: clamp(identity.motivation.competence, 0, 1),
    purpose,
    needs,
    lowestUnmetNeed: lowest,
    essentialOnly,
    conservation,
    reachOutFirst,
    strictSelfEvaluation,
    recallK: Math.round(4 + 4 * curiosity),
    perspectives: essentialOnly ? 1 : perspectives,
    truthfulGate: round(0.6 + 0.3 * epistemic, 3),
    // Motivation › Purpose → OKR weighting: purpose scales the vision/OKR alignment multiplier.
    visionMultiplier: round(alignmentMultiplier(vision, purpose), 3),
    earlyStopThreshold: round(EARLY_STOP_BASE + (lowAutonomy ? 0.1 : 0), 3),
    // 2026-11-07 (test 4): 4 steps were not enough to read three sections and save a page — the
    // assembler handed in unsaved pages six times. Room for read, write and finish, then a margin.
    maxSolveSteps: clamp(8 - (taskDriven > 0.7 ? 2 : 0), 4, 8),
    frustrationGate: affect.frustration > FRUSTRATION_LIMIT,
    notes,
  };
}

/** Self-Identity → the charter at the top of every brain prompt (tight: it is paid on every call). */
export function renderCharter(agent: Agent, facts: AgentFacts): string {
  const id = agent.identity;
  const okrs = id.okrs
    .slice(0, 2)
    .map((o) => `${truncate(o.objective, 80)} [${o.keyResults.slice(0, 2).map((k) => `${truncate(k.description, 50)} ${k.current}/${k.target}${k.unit}`).join("; ")}]`)
    .join(" | ");
  const lines = [
    `You are ${agent.name}, ${agent.title} (${facts.department}) at an AI-run company; the human Board oversees it.`,
    `Mission: ${truncate(id.mission, 200)}`,
    id.worldview ? `Worldview: ${truncate(id.worldview, 160)}` : "",
    id.lifeView ? `Life view: ${truncate(id.lifeView, 160)}${id.values.length ? ` — hence values: ${id.values.slice(0, 5).join(", ")}` : ""}` : id.values.length ? `Values: ${id.values.slice(0, 5).join(", ")}` : "",
    id.vision ? `Vision: ${truncate(id.vision, 160)}` : "",
    okrs ? `OKRs: ${okrs}` : "",
    id.narrative ? `Self-narrative: ${truncate(id.narrative, 240)}` : "",
    id.assets.length ? `${Q5_BIO_ASSETS_LABEL}: ${id.assets.slice(-5).map((a) => truncate(a, 40)).join(", ")}` : "",
    id.resourceConnections.length ? `Connections: ${id.resourceConnections.slice(-5).map((a) => truncate(a, 40)).join(", ")}` : "",
    // Catalog specialist as optional domain expertise (docs/CATALOG.md); short, it is paid on every stage.
    facts.expertise ? truncate(facts.expertise, 600) : "",
    `Style: ${truncate(agent.persona.style || "clear and direct", 100)}${toneFor(agent.persona.personalityType)}`,
    facts.today ?? "",
    facts.contacts ?? "",
    operatingRules(agent.tools),
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Grounding: the company's own systems and when to ask the Board. Without it, live models treat
 * every plain request ("set my custodian ID to …") as an unknown external system to verify and
 * escalate it, and each answer spawns more questions.
 */
export function operatingRules(tools: readonly string[]): string {
  const stores = [
    tools.includes("memory_write") ? "knowledge base (memory_write/memory_search)" : "",
    tools.includes("blackboard_write") || tools.includes("blackboard_read") ? "blackboard (shared working memory)" : "",
    tools.includes("workspace_write_file") ? "shared workspace files" : "",
  ].filter(Boolean);
  if (!stores.length) return "";
  return (
    `Your tools: ${tools.join(", ")}. Company systems you own: ${stores.join(", ")}. When the Board gives you a fact or asks you to set/record something, store it there and report it done; do not ask which system or for verification. ` +
    "Act on reasonable assumptions and state them. Ask the Board only for decisions that are irreversible, spend real money, touch real outside accounts or are outside your mandate — and ask once, all points together."
  );
}

// ── Maslow › Belonging: who to reach out to, and why belonging is low.

export interface BelongingResponse {
  /** ok · manager_missing (manager missing/terminated) · reports_unreachable (a leader's reports all paused/terminated). */
  kind: "ok" | "manager_missing" | "reports_unreachable";
  /** Check-in target: the manager, else the next ACTIVE ancestor; null = the Board (CEO, or no active ancestor). */
  reachOut: Agent | null;
}

/**
 * Coherent response to low belonging: with no (active) manager the agent turns to the next active
 * ancestor — the Board when there is none (the CEO) — which is also where `escalate` goes; when
 * its reports are unreachable, Self-ability notes the gap (no delegation this run).
 */
export function belongingResponse(run: BrainRun): BelongingResponse {
  const agent = run.agent;
  const active = (a: Agent | null | undefined): a is Agent => !!a && a.status !== "terminated";
  const manager = agent.managerId ? run.platform.org.getAgent(agent.managerId) : null;
  const reachOut = active(manager) ? manager : (run.platform.org.managerChain(agent.id).find(active) ?? null);
  if (agent.managerId && !active(manager)) return { kind: "manager_missing", reachOut };
  if (run.drives.needs.belonging === "low") return { kind: "reports_unreachable", reachOut };
  return { kind: "ok", reachOut };
}

// ── Blocks: the Self-management pass at the start of every run.


/** Self-Identity → Desire → Motivation (← Emotion, needs). Sets run.charter and run.drives. */
export async function selfManagementPass(run: BrainRun): Promise<void> {
  await block(run, "self_management.identity.self_identity", "Grounding in my identity", (span) => {
    run.charter = renderCharter(run.agent, run.facts);
    span.setAttributes({ "agentco.values": run.agent.identity.values.join(", "), "agentco.charter_chars": run.charter.length });
    return run.charter;
  });
  const needs = run.platform.org.needs(run.agent.id);
  run.drives = computeDrives(run.agent.identity, run.agent.affect, needs);
  await block(run, "self_management.identity.desire", "Weighing what I want from this", (span) => {
    const d = run.drives;
    span.setAttributes({
      "agentco.label": Q1_LABELS.desire,
      "agentco.desire.task_driven": d.taskDriven,
      "agentco.desire.curiosity": d.curiosity,
      "agentco.desire.epistemic": d.epistemic,
      "agentco.desire.vision": d.vision,
      "agentco.recall_k": d.recallK,
      "agentco.perspectives": d.perspectives,
    });
    return { curiosity: d.curiosity, epistemic: d.epistemic, vision: d.vision };
  });
  await block(run, "self_management.identity.motivation", "Checking motivation and needs", async (span) => {
    const d = run.drives;
    span.setAttributes({
      "agentco.label": Q1_LABELS.motivation,
      "agentco.motivation.autonomy": d.autonomy,
      "agentco.needs.lowest": d.lowestUnmetNeed ?? "none",
      "agentco.conservation": d.conservation,
      "agentco.essential_only": d.essentialOnly,
      "agentco.early_stop_threshold": d.earlyStopThreshold,
      "agentco.frustration_gate": d.frustrationGate,
      "agentco.modulations": d.notes.join("; ") || "none",
    });
    // Belonging is the lowest unmet need → reach out first, coherently with WHY it is low.
    const belonging = belongingResponse(run);
    span.setAttributes({ "agentco.belonging": belonging.kind, ...(belonging.reachOut ? { "agentco.belonging.reach_out": belonging.reachOut.id } : {}) });
    if (d.reachOutFirst && run.task && belonging.reachOut && run.agent.tools.includes("send_message")) {
      const why = belonging.kind === "manager_missing" ? " (my manager is no longer active, so I'm checking in with you)" : "";
      await run.platform.tools.execute(
        {
          id: `checkin_${run.ctx.run.id}`,
          name: "send_message",
          arguments: { toAgentId: belonging.reachOut.id, content: `Checking in${why}: I'm starting T-${run.task.number} "${truncate(run.task.title, 80)}". Anything I should know first?` },
        },
        toolContext(run, span),
      );
    }
    return { needs: d.needs, conservation: d.conservation, belonging: belonging.kind };
  });
}
