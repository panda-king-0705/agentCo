/**
 * Metacognition › Memory: Local Working Memory (task.state + run scratch) and
 * Long-Term Memory (the agent's own episodic/procedural/semantic/conceptual
 * memories). Fed by Literature Review, read by Solving.
 */
import type { MemoryItem } from "../../../../../../packages/shared/src/index.ts";
import { arr, obj, str } from "../../coerce.ts";
import { oneLine } from "../../text.ts";
import { block, type BrainRun } from "../runtime.ts";

/** Block: what this task already knows (plan, answers, checkpoint, revisions). */
export async function localWorkingMemory(run: BrainRun): Promise<string[]> {
  return block(run, "metacognition.memory.local_working", "Reading local working memory", () => {
    const lines: string[] = [];
    const state = run.task?.state ?? {};
    const plan = obj(state.plan);
    if (plan.problem) lines.push(`Previous plan: ${oneLine(str(plan.problem, ""), 160)} (candidate ${str(plan.chosen, "?")}, revision ${Number(plan.revision ?? 0)})`);
    for (const s of arr(plan.subprocesses).slice(0, 6)) {
      const sp = obj(s);
      lines.push(`- subprocess "${oneLine(str(sp.title, ""), 80)}" → ${str(sp.assigneeId, "self")} ${sp.taskId ? `(${str(sp.taskId, "")})` : "(not delegated)"}`);
    }
    for (const a of arr(state.answers).slice(-3)) {
      const ans = obj(a);
      lines.push(`Board/manager answer: ${oneLine(str(ans.note, str(ans.status, "")), 200)}`);
    }
    for (const issue of arr(plan.feedback).slice(0, 4)) lines.push(`Open feedback: ${oneLine(str(issue, ""), 160)}`);
    return lines;
  });
}

/** Block: the agent's own long-term memory relevant to `query`. */
export async function longTermMemory(run: BrainRun, query: string, k: number): Promise<MemoryItem[]> {
  return block(run, "metacognition.memory.long_term", "Recalling long-term memory", (span) => {
    const items = run.platform.memory.search({ query, agentId: run.agent.id, scopes: ["agent"], limit: k });
    span.setAttributes({ "agentco.memory.hits": items.length, "agentco.memory.k": k });
    return items;
  });
}

export function memoryLine(m: MemoryItem): string {
  return `- [${m.kind}] ${oneLine(m.content, 200)}`;
}
