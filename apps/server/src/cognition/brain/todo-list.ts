/**
 * TODO List (Interruptible): subprocesses with Value and Cost.
 *
 * The agent's open tasks on the company board are the subprocesses (priority
 * value / max(cost, 0.01)). Between blocks the engine asks
 * platform.tasks.interruptFor(); when something more urgent waits it
 * checkpoints {block, partial results} into task.state.checkpoint and the run
 * ends with outcome "yielded". The next run resumes at the checkpointed block.
 */
import type { BrainBlockId, Task } from "../../../../../packages/shared/src/index.ts";
import { obj, str } from "../coerce.ts";
import { block, YieldSignal, type BrainRun, type WorkingMemory } from "./runtime.ts";

export function priority(value: number, estCostUsd: number): number {
  return value / Math.max(estCostUsd, 0.01);
}

export interface Checkpoint {
  block: BrainBlockId;
  reason: string;
  at: string;
  wm: WorkingMemory;
}

export function readCheckpoint(task: Task): Checkpoint | null {
  const c = obj(task.state.checkpoint);
  const blockId = str(c.block, "");
  if (!blockId) return null;
  return { block: blockId as BrainBlockId, reason: str(c.reason, ""), at: str(c.at, ""), wm: obj(c.wm) };
}

/** Between blocks: yield to more urgent work. Never interrupts message runs. */
export function interruptCheck(run: BrainRun, nextBlock: BrainBlockId): void {
  if (!run.task) return;
  const reason = run.platform.tasks.interruptFor(run.agent.id, run.task.priority ?? priority(run.task.value, run.task.estCostUsd));
  if (reason) throw new YieldSignal(nextBlock, reason);
}

export type Entry = "fresh" | "resume" | "feedback" | "recovery" | "human_answer" | "heartbeat";

export interface Selection {
  entry: Entry;
  checkpoint: Checkpoint | null;
}

/** Block: select the subprocess to work on now, or resume a checkpoint. */
export async function selectSubprocess(run: BrainRun): Promise<Selection> {
  const input = run.ctx.input;
  const task = run.task!;
  return block(run, "todo_list", `Selecting T-${task.number} from the TODO list`, (span) => {
    const checkpoint = readCheckpoint(task);
    let entry: Entry = "fresh";
    if (input.trigger === "subtasks_completed") entry = "feedback";
    else if (input.trigger === "recovery") entry = "recovery";
    else if (input.trigger === "human_answer") entry = "human_answer";
    else if (input.trigger === "heartbeat") entry = "heartbeat";
    else if (checkpoint) entry = "resume";
    const children = input.trigger === "message" ? [] : input.subtasks;
    span.setAttributes({
      "agentco.todo.entry": entry,
      "agentco.todo.value": task.value,
      "agentco.todo.cost": task.estCostUsd,
      "agentco.todo.priority": Math.round(priority(task.value, task.estCostUsd) * 100) / 100,
      "agentco.todo.open_subprocesses": children.filter((c) => !["done", "failed", "cancelled"].includes(c.status)).length,
      ...(checkpoint ? { "agentco.todo.checkpoint": checkpoint.block } : {}),
    });
    return { entry, checkpoint };
  });
}

export function checkpointState(run: BrainRun, signal: YieldSignal): Record<string, unknown> {
  const cp: Checkpoint = { block: signal.nextBlock, reason: signal.reason, at: run.platform.now().toISOString(), wm: run.wm };
  return { checkpoint: cp };
}
