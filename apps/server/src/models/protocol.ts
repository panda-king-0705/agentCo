/**
 * The prompt protocol between the engines and the mock provider.
 *
 *   [[stage:<stage key>]]     in the system prompt — the routing/stage key
 *                             (e.g. "metacognition.cognitive_control", "reflex.step")
 *   [[context:{...json...}]]  anywhere in the prompt — machine-readable facts the
 *                             engine already gave the model in prose (task, reports,
 *                             tools, phase, results, hints). The last block wins.
 *
 * Live models simply see two short lines of structured context; the mock reads
 * them to return deterministic, plausible output.
 */
import type { ChatMessage } from "../contracts.ts";
import { balancedObjectEnd } from "./json.ts";

const STAGE_RE = /\[\[stage:([A-Za-z0-9_.\-]+)\]\]/;
const CONTEXT_OPEN = "[[context:";

export function stageMarker(stage: string): string {
  return `[[stage:${stage}]]`;
}

export function contextBlock(context: Record<string, unknown>): string {
  return `${CONTEXT_OPEN}${JSON.stringify(context)}]]`;
}

export function readStage(messages: ChatMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== "system") continue;
    const match = STAGE_RE.exec(m.content);
    if (match && match[1]) return match[1];
  }
  return null;
}

export function readContext(messages: ChatMessage[]): Record<string, unknown> {
  let found: Record<string, unknown> = {};
  for (const m of messages) {
    if (m.role === "tool" || m.role === "assistant") continue;
    let from = 0;
    for (;;) {
      const at = m.content.indexOf(CONTEXT_OPEN, from);
      if (at < 0) break;
      const start = at + CONTEXT_OPEN.length;
      const end = m.content[start] === "{" ? balancedObjectEnd(m.content, start) : -1;
      if (end > 0) {
        try {
          const parsed = JSON.parse(m.content.slice(start, end)) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) found = parsed as Record<string, unknown>;
        } catch {
          /* ignore a malformed block */
        }
      }
      from = start;
    }
  }
  return found;
}
