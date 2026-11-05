// Tasks: kanban by status (terminal ones collapsed), filters, detail drawer, new task form.
import { useMemo, useState } from "react";
import { api } from "../api";
import { dateTime, duration, money } from "../format";
import { href, navigate } from "../router";
import { seed, useApi, useLive } from "../live";
import { Markdown } from "../ui/markdown";
import { AgentLink, Badge, Button, ConfirmDialog, Drawer, Empty, ErrorNote, Field, KV, Modal, RelTime, SearchInput, Skeleton, TaskStatusBadge, TASK_STATUS, useAction } from "../ui/kit";
import type { Task, TaskDetail, TaskStatus } from "../types";
import { PageHead, liveAgents } from "./common";

const ACTIVE_COLS: TaskStatus[] = ["todo", "in_progress", "waiting", "blocked"];
const DONE_COLS: TaskStatus[] = ["done", "failed", "cancelled"];

function TaskCard({ t, subCount }: { t: Task; subCount: number }) {
  return (
    <div className={`tcard ts-${t.status}`} role="link" tabIndex={0} data-task={t.id} onClick={() => navigate(`/tasks/${t.id}`)} onKeyDown={(e) => { if (e.key === "Enter") navigate(`/tasks/${t.id}`); }}>
      <div className="row">
        <span className="task-ref">T-{t.number}</span>
        {t.parentTaskId ? <span className="tiny muted">subtask</span> : null}
        <span className="grow" />
        {subCount ? <span className="tiny muted" title={`${subCount} subtasks`}>{subCount} sub</span> : null}
      </div>
      <div className="tcard-title">{t.title}</div>
      <div className="row small">
        {t.assigneeId ? <AgentLink id={t.assigneeId} size={18} /> : <span className="muted">Unassigned</span>}
      </div>
      <div className="tcard-meta tiny">
        <span title="Business value">Value <b className="num">{t.value}</b></span>
        <span title="Estimated cost">Est. <b className="num">{money(t.estCostUsd)}</b></span>
        <span title="Priority = value / cost">Pri <b className="num">{t.priority.toFixed(1)}</b></span>
        <span title="Actual cost so far">Spent <b className="num">{money(t.actualCostUsd)}</b></span>
      </div>
    </div>
  );
}

export function TasksView({ taskId }: { taskId: string | null }) {
  const tasks = useLive((s) => s.tasks);
  const agents = useLive((s) => s.agents);
  const [q, setQ] = useState("");
  const [assignee, setAssignee] = useState("");
  const [rootsOnly, setRootsOnly] = useState(false);
  const [openDone, setOpenDone] = useState<Set<TaskStatus>>(new Set());
  const [creating, setCreating] = useState(false);

  const subCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of Object.values(tasks)) if (t.parentTaskId) m.set(t.parentTaskId, (m.get(t.parentTaskId) ?? 0) + 1);
    return m;
  }, [tasks]);
  const filtered = useMemo(() => {
    const n = q.toLowerCase();
    return Object.values(tasks)
      .filter((t) => (!n || t.title.toLowerCase().includes(n) || `t-${t.number}`.includes(n)) && (!assignee || t.assigneeId === assignee) && (!rootsOnly || !t.parentTaskId))
      .sort((a, b) => b.priority - a.priority || b.number - a.number);
  }, [tasks, q, assignee, rootsOnly]);
  const by = (s: TaskStatus) => filtered.filter((t) => t.status === s);
  const assignees = useMemo(() => liveAgents(agents).filter((a) => Object.values(tasks).some((t) => t.assigneeId === a.id)), [agents, tasks]);
  const toggleDone = (s: TaskStatus) => setOpenDone((p) => { const n = new Set(p); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const total = Object.keys(tasks).length;

  return (
    <>
      <PageHead title="Tasks" sub={`${total} tasks. Priority is value divided by cost.`}>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Filter by assignee">
          <option value="">All assignees</option>
          {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button type="button" className="chip" aria-pressed={rootsOnly} onClick={() => setRootsOnly((r) => !r)}>Objectives only</button>
        <SearchInput value={q} onChange={setQ} placeholder="Search tasks" width={200} />
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New task</Button>
      </PageHead>
      {!total ? (
        <Empty title="No tasks yet" icon="tasks" action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Create the first task</Button>}>Tasks created here go to the CEO unless you pick someone else.</Empty>
      ) : (
        <>
          <div className="kanban">
            {ACTIVE_COLS.map((s) => (
              <section key={s} className={`kcol ts-${s}`} aria-label={TASK_STATUS[s]}>
                <header className="kcol-head"><TaskStatusBadge status={s} /><span className="count num">{by(s).length}</span></header>
                <div className="kcol-body">
                  {by(s).map((t) => <TaskCard key={t.id} t={t} subCount={subCounts.get(t.id) ?? 0} />)}
                  {!by(s).length ? <div className="kempty muted small">Nothing here</div> : null}
                </div>
              </section>
            ))}
          </div>
          <div className="done-row">
            {DONE_COLS.map((s) => (
              <section key={s} className={`dcol ts-${s}`}>
                <button type="button" className="dcol-head" aria-expanded={openDone.has(s)} onClick={() => toggleDone(s)}>
                  <TaskStatusBadge status={s} /><span className="count num">{by(s).length}</span>
                  <span className="muted small">{openDone.has(s) ? "Hide" : "Show"}</span>
                </button>
                {openDone.has(s) ? <div className="dcol-body">{by(s).map((t) => <TaskCard key={t.id} t={t} subCount={subCounts.get(t.id) ?? 0} />)}</div> : null}
              </section>
            ))}
          </div>
        </>
      )}
      {taskId ? <TaskDrawer taskId={taskId} /> : null}
      {creating ? <NewTaskModal onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function SubtaskTree({ root, all }: { root: string; all: Task[] }) {
  const kids = all.filter((t) => t.parentTaskId === root).sort((a, b) => a.number - b.number);
  if (!kids.length) return null;
  return (
    <ul className="subtree">
      {kids.map((t) => (
        <li key={t.id}>
          <a href={href(`/tasks/${t.id}`)} className="row"><span className="task-ref">T-{t.number}</span><span className="grow ellipsis">{t.title}</span><TaskStatusBadge status={t.status} /></a>
          <div className="row small muted" style={{ paddingLeft: 4 }}>{t.assigneeId ? <AgentLink id={t.assigneeId} size={16} /> : "Unassigned"}</div>
          <SubtaskTree root={t.id} all={all} />
        </li>
      ))}
    </ul>
  );
}

function TaskDrawer({ taskId }: { taskId: string }) {
  const detail = useApi<TaskDetail>(`task:${taskId}`, () => api.task(taskId), {
    refreshOn: ["task.updated", "run.completed", "approval.decided"],
    refreshIf: (ev) => ev.taskId === taskId || ev.type === "task.updated",
    throttleMs: 2000,
  });
  const { busy, run } = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const close = () => navigate("/tasks");
  const d = detail.data;
  const act = async (kind: "cancel" | "retry") => {
    const t = await run(() => (kind === "cancel" ? api.cancelTask(taskId) : api.retryTask(taskId)), kind === "cancel" ? "Task cancelled" : "Task re-queued");
    if (t) {
      seed.tasks([t]);
      detail.reload();
    }
    setConfirmCancel(false);
  };
  const t = d?.task;
  const terminal = t ? ["done", "failed", "cancelled"].includes(t.status) : false;
  return (
    <Drawer
      onClose={close}
      width={620}
      title={t ? <span className="row wrap"><span className="task-ref">T-{t.number}</span> <span>{t.title}</span></span> : "Task"}
      actions={t ? (
        <>
          {terminal && t.status !== "done" ? <Button size="sm" icon="refresh" onClick={() => act("retry")} disabled={busy}>Retry</Button> : null}
          {!terminal ? <Button size="sm" variant="danger" onClick={() => setConfirmCancel(true)} disabled={busy}>Cancel task</Button> : null}
        </>
      ) : null}
    >
      {detail.error && !d ? <ErrorNote error={detail.error} onRetry={detail.reload} /> : !d || !t ? <Skeleton rows={8} height={16} /> : (
        <div className="stack">
          <div className="row wrap"><TaskStatusBadge status={t.status} /> <Badge>attempt {t.attempts}/{t.maxAttempts}</Badge> <span className="muted small">created <RelTime iso={t.createdAt} /></span></div>
          <KV rows={[
            ["Assignee", d.assignee ? <AgentLink key="a" id={d.assignee.id} showTitle /> : "Unassigned"],
            ["Created by", t.createdBy === "human" ? "Board" : <AgentLink key="c" id={t.createdBy} />],
            ["Value / est. cost", `${t.value} / ${money(t.estCostUsd)} (priority ${t.priority.toFixed(1)})`],
            ["Actual cost", money(t.actualCostUsd)],
            ["Started", dateTime(t.startedAt)],
            ["Completed", dateTime(t.completedAt)],
            ["Trace", <a key="tr" href={href(`/traces/${t.traceId}`)}>Open the full trace</a>],
            ...(t.parentTaskId ? ([["Parent", <a key="p" href={href(`/tasks/${t.parentTaskId}`)}>Parent task</a>]] as [string, React.ReactNode][]) : []),
          ]} />
          <section><h3 className="section-title">Description</h3><Markdown text={t.description || "No description."} /></section>
          {t.acceptanceCriteria ? <section><h3 className="section-title">Acceptance criteria</h3><Markdown text={t.acceptanceCriteria} /></section> : null}
          {t.result ? <section><h3 className="section-title">Result</h3><div className="result-box"><Markdown text={t.result} /></div></section> : null}
          {t.error ? <div className="callout danger" role="alert"><div><strong>Error.</strong> {t.error}</div></div> : null}
          <section>
            <h3 className="section-title">Subtasks ({d.subtasks.length})</h3>
            {d.subtasks.length ? <SubtaskTree root={t.id} all={d.subtasks} /> : <p className="muted small">None. This task is not split up.</p>}
          </section>
          <section>
            <h3 className="section-title">Runs ({d.runs.length})</h3>
            {d.runs.length ? (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Agent</th><th>Trigger</th><th>Status</th><th className="r">Cost</th><th className="r">Time</th><th /></tr></thead>
                <tbody>
                  {d.runs.map((r) => (
                    <tr key={r.id}>
                      <td><AgentLink id={r.agentId} size={16} /></td><td>{r.trigger.replace("_", " ")}</td><td><span className={`status rs-${r.status}`}>{r.status}</span></td>
                      <td className="r num">{money(r.costUsd)}</td>
                      <td className="r num">{r.startedAt && r.completedAt ? duration(Date.parse(r.completedAt) - Date.parse(r.startedAt)) : "—"}</td>
                      <td><a href={href(`/traces/${r.traceId}`, { run: r.id })}>Trace</a></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            ) : <p className="muted small">No runs yet.</p>}
          </section>
          <section>
            <h3 className="section-title">Approvals ({d.approvals.length})</h3>
            {d.approvals.length ? (
              <ul className="plain-list">
                {d.approvals.map((a) => <li key={a.id}><a href={href("/approvals")}>{a.summary}</a> <Badge tone={a.status === "pending" ? "warn" : a.status === "approved" ? "good" : "danger"}>{a.status}</Badge></li>)}
              </ul>
            ) : <p className="muted small">None.</p>}
          </section>
        </div>
      )}
      {confirmCancel ? (
        <ConfirmDialog title="Cancel this task?" confirmLabel="Cancel task" danger busy={busy} onConfirm={() => act("cancel")} onClose={() => setConfirmCancel(false)}>
          <p>Any run working on it is interrupted and its open subtasks are cancelled.</p>
        </ConfirmDialog>
      ) : null}
    </Drawer>
  );
}

function NewTaskModal({ onClose }: { onClose: () => void }) {
  const agents = useLive((s) => s.agents);
  const list = liveAgents(agents);
  const ceo = list.find((a) => a.roleId === "ceo");
  const [f, setF] = useState({ title: "", description: "", assigneeId: ceo?.id ?? "", criteria: "", value: "100", cost: "0.5" });
  const { busy, run } = useAction();
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    const t = await run(() => api.createTask({
      title: f.title.trim(),
      description: f.description.trim(),
      assigneeId: f.assigneeId || undefined,
      acceptanceCriteria: f.criteria.trim() || null,
      value: Number(f.value) || undefined,
      estCostUsd: Number(f.cost) || undefined,
    }), "Task created");
    if (t) {
      seed.tasks([t]);
      onClose();
      navigate(`/tasks/${t.id}`);
    }
  };
  return (
    <Modal title="New task" onClose={onClose} width={600} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={!f.title.trim() || busy}>{busy ? "Creating…" : "Create task"}</Button></>}>
      <div className="form-grid">
        <Field label="Title" wide><input type="text" value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Launch the pricing page" /></Field>
        <Field label="Description" wide><textarea rows={4} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="What needs to happen and why" /></Field>
        <Field label="Assignee" hint="Defaults to the CEO, who decomposes and delegates.">
          <select value={f.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}>
            {list.map((a) => <option key={a.id} value={a.id}>{a.name}, {a.title}</option>)}
          </select>
        </Field>
        <Field label="Acceptance criteria"><input type="text" value={f.criteria} onChange={(e) => set("criteria", e.target.value)} placeholder="How we know it is done" /></Field>
        <Field label="Value (0 to 1000)"><input type="number" min="0" max="1000" value={f.value} onChange={(e) => set("value", e.target.value)} /></Field>
        <Field label="Estimated cost (USD)"><input type="number" min="0" step="0.1" value={f.cost} onChange={(e) => set("cost", e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
