/** What an agent is told when the Board decides its approval (shared by both engines). */
import type { Approval } from "../../../../packages/shared/src/index.ts";
import { truncate } from "./text.ts";

export function boardAnswerText(a: Approval): string {
  const note = a.note ? ` Note from the Board: ${truncate(a.note, 400)}` : "";
  if (a.kind === "external_action") {
    const action = String(a.payload.action ?? a.payload.tool ?? "the action");
    if (a.status !== "approved") return `The Board declined ${action}; it did not run.${note} Continue without it, and say in your result that it was declined.`;
    const ran = a.payload.execution === "done";
    const result = typeof a.payload.result === "string" ? truncate(a.payload.result, 2500) : "";
    return ran ? `The Board approved ${action} and it ran. Result:\n${result}${note}` : `The Board approved ${action}, but it failed: ${result || "no result"}.${note}`;
  }
  return `Answer from the Board (${a.status}): ${truncate(a.note ?? "(no note)", 400)}`;
}
