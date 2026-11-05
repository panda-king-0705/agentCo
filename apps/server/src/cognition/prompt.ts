/**
 * Prompt assembly shared by both engines: stage marker, identity charter,
 * instructions, and the machine-readable context block (models/protocol.ts).
 * Kept tight — every character is paid for on every call.
 */
import type { Agent } from "../../../../packages/shared/src/index.ts";
import type { PlatformServices } from "../contracts.ts";
import { contextBlock, stageMarker } from "../models/protocol.ts";
import { truncate } from "./text.ts";

export interface AgentFacts {
  department: string;
  departmentSlug: string;
  /** Workers with a catalog specialist: the compiled specialist playbook (docs/CATALOG.md). */
  playbook?: string | null;
  /** Executives/managers with a catalog specialist: a short domain-expertise line for the charter. */
  expertise?: string | null;
}

export function agentFacts(platform: PlatformServices, agent: Agent): AgentFacts {
  const dep = platform.org.department(agent.departmentId);
  const name = dep?.name ?? platform.org.departmentName(agent.departmentId) ?? "General";
  const facts: AgentFacts = { department: name, departmentSlug: dep?.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-") };
  if (agent.catalogId && platform.catalog) {
    if (agent.tier === "worker") facts.playbook = platform.catalog.playbookFor(agent);
    else facts.expertise = platform.catalog.expertiseFor(agent);
  }
  return facts;
}

/** Minimal worker charter (mission + values + persona style); the specialist playbook, when any, follows it in the prompt. */
export function workerCharter(agent: Agent, facts: AgentFacts): string {
  const id = agent.identity;
  return [
    `You are ${agent.name}, ${agent.title} (${facts.department}).`,
    `Mandate: ${truncate(id.mission, 300)}`,
    id.values.length ? `Values: ${id.values.slice(0, 5).join(", ")}.` : "",
    agent.persona.style ? `Style: ${truncate(agent.persona.style, 120)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function systemPrompt(stage: string, parts: (string | null | undefined | false)[], context: Record<string, unknown>): string {
  return [stageMarker(stage), ...parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0), contextBlock(context)].join("\n\n");
}

/** Output contract line for JSON stages. */
export function jsonContract(shape: string): string {
  return `Reply with one JSON object only, no prose: ${shape}`;
}
