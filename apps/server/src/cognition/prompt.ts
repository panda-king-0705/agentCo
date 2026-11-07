/**
 * Prompt assembly shared by both engines: stage marker, identity charter,
 * instructions, and the machine-readable context block (models/protocol.ts).
 * Kept tight — every character is paid for on every call.
 */
import type { Agent } from "../../../../packages/shared/src/index.ts";
import type { PlatformServices } from "../contracts.ts";
import { contextBlock, stageMarker } from "../models/protocol.ts";
import { truncate } from "./text.ts";
import { keyContacts } from "../org/directory.ts";

export interface AgentFacts {
  department: string;
  departmentSlug: string;
  /** Workers with a catalog specialist: the compiled specialist playbook (docs/CATALOG.md). */
  playbook?: string | null;
  /** Executives/managers with a catalog specialist: a short domain-expertise line for the charter. */
  expertise?: string | null;
  /** "Today: Saturday 2026-11-07, 06:44 (Asia/Singapore)" — agents had no calendar date at all. */
  today?: string;
  /** Manager, CEO and direct reports with their ids (the company directory has everyone). */
  contacts?: string;
}

/** The current date and time in the server's time zone (TZ), for prompts. */
export function todayLine(now: Date): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const weekday = now.toLocaleDateString("en-GB", { weekday: "long" });
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Today: ${weekday} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}, ${pad(now.getHours())}:${pad(now.getMinutes())} (${tz}).`;
}

export function agentFacts(platform: PlatformServices, agent: Agent): AgentFacts {
  const dep = platform.org.department(agent.departmentId);
  const name = dep?.name ?? platform.org.departmentName(agent.departmentId) ?? "General";
  const facts: AgentFacts = {
    department: name,
    departmentSlug: dep?.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    today: todayLine(platform.now()),
    contacts: keyContacts(platform.org, agent),
  };
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
    facts.today ?? "",
    facts.contacts ?? "",
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

/** "Already done on this task by earlier attempts" — for a retry or a resumed run (tool-loop.ts WRITE_TOOL). */
export function earlierWorkNote(earlier: readonly { at: string; agent: string; tool: string; what: string }[]): string {
  return (
    "Already done on this task by earlier attempts (these stand: build on them, don't redo them, and don't mistake them for someone else's work):\n" +
    earlier
      .slice(-12)
      .map((e) => `- ${e.at.slice(11, 16)} UTC ${e.agent}: ${e.tool} — ${e.what}`)
      .join("\n")
  );
}
