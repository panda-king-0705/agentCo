/** One-line activity-feed summaries for events. */
import type { Agent, Approval, Message, Run, Span, Task } from "../../../../packages/shared/src/index.ts";
import { oneLine } from "./bus.ts";

export const taskRef = (task: Pick<Task, "number" | "title">): string => `T-${task.number} "${oneLine(task.title, 60)}"`;

export const summaries = {
  agentCreated: (a: Agent) => `${a.name} joined as ${a.title}`,
  agentUpdated: (a: Agent) => `${a.name} (${a.title}) updated`,
  agentStatus: (a: Agent) => `${a.name}: ${a.status}${a.activity ? ` — ${oneLine(a.activity, 80)}` : ""}`,
  agentTerminated: (a: Agent) => `${a.name} (${a.title}) was terminated`,
  taskCreated: (t: Task, by: string) => `${by} opened ${taskRef(t)}`,
  taskUpdated: (t: Task) => `${taskRef(t)} → ${t.status}`,
  runStarted: (r: Run, a: Agent) => `${a.name} started a ${r.engine} run (${r.trigger})`,
  runCompleted: (r: Run, a: Agent) => `${a.name}'s run ${r.status}${r.error ? `: ${oneLine(r.error, 80)}` : ""}`,
  spanStarted: (s: Span) => `${s.kind} ${s.name} started`,
  spanEnded: (s: Span) => `${s.kind} ${s.name} ${s.status}${s.durationMs !== null ? ` in ${Math.round(s.durationMs)} ms` : ""}`,
  messageCreated: (m: Message, sender: string) => `${sender}: ${oneLine(m.content, 100)}`,
  approvalCreated: (a: Approval) => `Approval requested (${a.kind}): ${oneLine(a.summary, 100)}`,
  approvalDecided: (a: Approval) => `Board ${a.status} ${a.kind}: ${oneLine(a.summary, 100)}`,
};
