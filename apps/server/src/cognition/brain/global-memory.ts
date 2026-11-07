/**
 * Global Memory: Global Working Memory (Shared) · Long-Term Memory ›
 * Episodic · Semantic › Procedural, Conceptual. The "Logs / General
 * Understanding" arrow: every Report logs an episode; generalisable lessons
 * and durable insights go to the company's long-term memory; managers+ post
 * objective status on the shared blackboard.
 */
import type { BlackboardEntry, MemoryItem } from "../../../../../packages/shared/src/index.ts";
import { oneLine, truncate } from "../text.ts";
import { block, type BrainRun } from "./runtime.ts";

/** Block: the shared blackboard (global working memory). */
export async function readGlobalWorking(run: BrainRun, limit = 5): Promise<BlackboardEntry[]> {
  return block(run, "global_memory.working", "Reading the shared blackboard", (span) => {
    const entries = run.platform.memory
      .blackboardCurrent()
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit);
    span.setAttributes({ "agentco.memory.hits": entries.length });
    return entries;
  });
}

/** Block: company long-term knowledge ("general understanding") relevant to the query. */
export async function readGlobalLongTerm(run: BrainRun, query: string, k: number): Promise<MemoryItem[]> {
  return block(run, "global_memory.conceptual", "Searching company knowledge", (span) => {
    const items = run.platform.memory.search({ query, scopes: ["global"], kinds: ["conceptual", "semantic", "procedural"], limit: k });
    span.setAttributes({ "agentco.memory.hits": items.length });
    return items;
  });
}

export interface ReportLog {
  outcome: "completed" | "failed" | "blocked";
  score: number;
  costUsd: number;
  estCostUsd: number;
  summary: string;
  lesson: string | null;
  generalizes: boolean;
  conceptual: string | null;
}

function isManagerPlus(run: BrainRun): boolean {
  return run.agent.tier === "manager" || run.agent.tier === "executive";
}

/** The Report's write path into global memory. Memory is best-effort: a failing write never fails the run. */
export async function writeReport(run: BrainRun, log: ReportLog): Promise<void> {
  const task = run.task;
  const label = task ? `T-${task.number} "${truncate(task.title, 80)}"` : "chat";
  const common = { sourceRunId: run.ctx.run.id, sourceTaskId: task?.id ?? null };
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* best-effort */
    }
  };
  await block(run, "global_memory.episodic", "Logging the episode", () =>
    safe(() =>
      run.platform.memory.write({
        scope: "agent",
        agentId: run.agent.id,
        kind: "episodic",
        // "cost $x (est $y)" is parsed back by Data-driven Analysis.
        content: `${label}: ${log.outcome} (score ${log.score.toFixed(2)}) cost $${log.costUsd.toFixed(4)} (est $${log.estCostUsd.toFixed(4)}) — ${oneLine(log.summary, 200)}`,
        tags: ["report", log.outcome],
        importance: log.outcome === "completed" ? 0.5 : 0.7,
        ...common,
      }),
    ),
  );
  if (log.lesson && log.generalizes && isManagerPlus(run)) {
    const lesson = log.lesson;
    await block(run, "global_memory.procedural", "Sharing a procedural lesson", () =>
      safe(() => run.platform.memory.write({ scope: "global", agentId: run.agent.id, kind: "procedural", content: lesson, tags: ["lesson"], importance: 0.6, ...common })),
    );
  }
  if (log.conceptual) {
    const insight = log.conceptual;
    await block(run, "global_memory.conceptual", "Recording general understanding", () =>
      safe(() => run.platform.memory.write({ scope: "global", agentId: run.agent.id, kind: "conceptual", content: insight, tags: ["insight"], importance: 0.5, ...common })),
    );
  }
  if (task && task.parentTaskId === null && isManagerPlus(run)) {
    await block(run, "global_memory.working", "Posting status to the blackboard", () =>
      safe(() => run.platform.memory.blackboardSet(`objective:T-${task.number}`, `${log.outcome}: ${oneLine(log.summary, 300)}`, run.agent.id)),
    );
  }
}
