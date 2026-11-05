/**
 * Escalation budget (Confidence › Early Stop? → escalate, Feedback → escalate, and an
 * escalate/ask_human call inside the Solving tool loop).
 *
 * Every escalation of one task is counted in `task.state.escalation = {count, answered}`
 * (local working memory, returned in every task result). Once a manager — or the Board,
 * for a question — has answered, the agent may not escalate that task again: early stop
 * proceeds with the guidance, Feedback settles on accept-partial or fail, and the
 * escalate/ask_human tools are withdrawn from the Solving loop. Independently of answers,
 * at most MAX_ESCALATIONS_PER_TASK escalations are opened per task.
 */
import type { Agent, Task } from "../../../../../packages/shared/src/index.ts";
import { num, obj } from "../coerce.ts";
import type { BrainRun } from "./runtime.ts";

export const MAX_ESCALATIONS_PER_TASK = 2;

export interface EscalationState {
  /** Escalations opened for this task (subtasks for the manager + questions to the Board). */
  count: number;
  /** A manager or the Board has answered one of them. */
  answered: boolean;
}

/** From task.state.escalation, cross-checked with the task's escalation subtasks (never lower). */
export function readEscalation(task: Task | null, children: Task[], agentId: string): EscalationState {
  const saved = obj(task?.state.escalation);
  const mine = children.filter((c) => c.state.kind === "escalation" && (c.state.escalatedBy ?? agentId) === agentId);
  return {
    count: Math.max(num(saved.count, 0, 0, 1000), mine.length),
    answered: saved.answered === true || mine.some((c) => c.status === "done"),
  };
}

export function hasEscalationTools(agent: Agent): boolean {
  return agent.tools.includes("escalate") || agent.tools.includes("ask_human");
}

/** May this run escalate the task (again)? */
export function canEscalate(run: BrainRun): boolean {
  const e = run.escalation;
  if (!hasEscalationTools(run.agent)) return false;
  if (!e) return true;
  return !e.answered && e.count < MAX_ESCALATIONS_PER_TASK;
}

/** True when the escalation budget, not missing tools, is what stops an escalation. */
export function escalationSettled(run: BrainRun): boolean {
  const e = run.escalation;
  return !!e && (e.answered || e.count >= MAX_ESCALATIONS_PER_TASK);
}
