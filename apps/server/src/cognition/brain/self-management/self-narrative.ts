/**
 * Self-management › Self-Narrative Generator (linked to BIO/Assets and
 * Resource Connection). After a Report: refresh identity.narrative (2-3
 * sentences, first person) and append demonstrated deliverables to assets and
 * collaborators to resourceConnections. Runs every 3rd report or on a notable
 * event (failure, escalation, praise).
 */
import { strArr, str } from "../../coerce.ts";
import { truncate } from "../../text.ts";
import { Q5_MAX_ASSETS } from "../interpretation.ts";
import { block, llmJson, type BrainRun } from "../runtime.ts";

export const NARRATIVE_EVERY = 3;

export function narrativeDue(reportsSoFar: number, notable: boolean): boolean {
  return notable || (reportsSoFar > 0 && reportsSoFar % NARRATIVE_EVERY === 0);
}

export interface NarrativeUpdate {
  narrative: string;
  assets: string[];
  resourceConnections: string[];
}

export function mergeList(existing: string[], added: string[], max: number): string[] {
  const out = [...existing];
  for (const a of added) if (a && !out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  return out.slice(-max);
}

export async function generateNarrative(run: BrainRun, summary: string, outcome: string, collaborators: string[]): Promise<NarrativeUpdate | null> {
  return block(run, "self_management.identity.self_narrative", "Refreshing self-narrative", async (span) => {
    const id = run.agent.identity;
    const json = await llmJson(run, {
      stage: "self_management.identity.self_narrative",
      span,
      instructions: `Rewrite your self-narrative (2-3 sentences, first person) in light of this outcome (${outcome}): ${truncate(summary, 400)}. Current narrative: ${truncate(id.narrative || "(none)", 300)}. List deliverables you demonstrated (assets) and collaborators (connections).`,
      shape: '{"narrative": string, "assets": string[], "connections": string[]}',
      context: {
        agent: { name: run.agent.name, title: run.agent.title },
        task: run.task ? { title: run.task.title } : undefined,
        reports: collaborators.map((c) => ({ id: c, title: c })),
        outcome,
      },
      maxOutputTokens: 300,
    });
    const narrative = str(json.narrative, id.narrative, 600);
    if (!narrative) return null;
    return {
      narrative,
      assets: mergeList(id.assets, strArr(json.assets, 3, 80), Q5_MAX_ASSETS),
      resourceConnections: mergeList(id.resourceConnections, [...strArr(json.connections, 3, 80), ...collaborators.slice(0, 3)], Q5_MAX_ASSETS),
    };
  });
}
