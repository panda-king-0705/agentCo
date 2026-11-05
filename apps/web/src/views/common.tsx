// Small shared view helpers.
import type { ReactNode } from "react";
import { href } from "../router";
import { useLive } from "../live";
import type { Agent, Task } from "../types";

export function PageHead({ title, sub, children, crumbs }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; crumbs?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumbs ? <div className="crumbs">{crumbs}</div> : null}
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      <div className="spacer" />
      {children}
    </div>
  );
}

export function useDeptColor(departmentId: string | null | undefined): string {
  return useLive((s) => (departmentId ? s.departments[departmentId]?.color : undefined)) ?? "var(--muted)";
}

export function useDeptName(departmentId: string | null | undefined): string {
  return useLive((s) => (departmentId ? s.departments[departmentId]?.name : undefined)) ?? "—";
}

export function TaskRef({ task }: { task: Pick<Task, "id" | "number"> | undefined | null }) {
  if (!task) return null;
  return (
    <a className="task-ref" href={href(`/tasks/${task.id}`)} onClick={(e) => e.stopPropagation()}>
      T-{task.number}
    </a>
  );
}

export function TaskLinkById({ id }: { id: string | null | undefined }) {
  const task = useLive((s) => (id ? s.tasks[id] : undefined));
  if (!id) return null;
  return task ? <TaskRef task={task} /> : <a className="task-ref" href={href(`/tasks/${id}`)}>{id}</a>;
}

export const ACTIVE_STATUSES = new Set(["thinking", "acting", "waiting", "blocked"]);

export function liveAgents(agents: Record<string, Agent>): Agent[] {
  return Object.values(agents).filter((a) => a.status !== "terminated");
}

const TIER_ORDER = { executive: 0, manager: 1, worker: 2 } as const;
export function byTier(a: Agent, b: Agent): number {
  return TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.name.localeCompare(b.name);
}

/** Pretty label for a brain block id: "metacognition.project_management.online_learning" → "Online learning". */
export function blockLabel(id: string | null | undefined): string {
  if (!id) return "—";
  const last = id.split(".").pop() ?? id;
  return last.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function useAgentName(id: string | null | undefined): string {
  return useLive((s) => (id ? (id === "human" ? "Board" : s.agents[id]?.name) : undefined)) ?? id ?? "—";
}
