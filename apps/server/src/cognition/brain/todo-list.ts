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
import { num, obj, str } from "../coerce.ts";
import { TODO_YIELD } from "./interpretation.ts";
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

/** How many times this task has yielded so far (task.state.yields). */
export function yieldCount(task: Task): number {
  return num(task.state.yields, 0, 0);
}

/**
 * Between blocks: yield to more urgent work. Never interrupts message runs, never once Solving has
 * started (the step finishes first), and never after the task's yield budget is spent
 * (TODO_YIELD.maxPerTask) — a stream of messages cannot starve an objective.
 */
export function interruptCheck(run: BrainRun, nextBlock: BrainBlockId): void {
  if (!run.task || run.solvingStarted) return;
  if (yieldCount(run.task) >= TODO_YIELD.maxPerTask) return;
  const reason = run.platform.tasks.interruptFor(run.agent.id, run.task.priority ?? priority(run.task.value, run.task.estCostUsd));
  if (reason) throw new YieldSignal(nextBlock, reason);
}

/**
 * Working-memory keys by the block that produces them (docs/BRAIN.md §3: a resume continues AT the
 * checkpointed block). Resuming at a block keeps everything produced before it and drops the rest.
 */
const WM_STAGES: { keys: string[]; before: BrainBlockId[] }[] = [
  // Target Understanding: needed by every block from Self-ability on.
  { keys: ["problem", "literature", "understanding"], before: ["metacognition.target_understanding.problem_definition"] },
  // Self-ability → OOD → Confidence (incl. its fallbacks): needed from Cognitive Control on.
  { keys: ["competence", "ood", "confidence", "routingTier"], before: ["metacognition.target_understanding.problem_definition", "metacognition.self_ability", "metacognition.confidence"] },
  // Cognitive Control → Economic Concepts → Reverse Thinking: the chosen plan, needed by Solving.
  {
    keys: ["planned"],
    before: ["metacognition.target_understanding.problem_definition", "metacognition.self_ability", "metacognition.confidence", "metacognition.cognitive_control.decomposition"],
  },
];

/**
 * Working memory to resume with. `yield`: resume at the checkpointed block (keep what earlier blocks
 * produced). `answer`: a manager's / the Board's answer is new input to Confidence, so only Target
 * Understanding is kept and the run re-assesses from Self-ability on.
 */
export function resumeWorkingMemory(cp: Checkpoint, mode: "yield" | "answer"): WorkingMemory {
  const wm: WorkingMemory = { ...cp.wm };
  for (const [i, stage] of WM_STAGES.entries()) {
    const drop = stage.before.includes(cp.block) || (mode === "answer" && i > 0);
    if (drop) for (const k of stage.keys) delete wm[k];
  }
  return wm;
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
  return { checkpoint: cp, yields: (run.task ? yieldCount(run.task) : 0) + 1 };
}
