// Agent detail: Brain (brain-cognition agents), Overview, Work, Memory, Chat.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { compact, dateTime, duration, money, pct } from "../format";
import { href, navigate, setQuery, useRoute } from "../router";
import { seed, useApi, useLive } from "../live";
import { Gauge } from "../ui/charts";
import { Markdown } from "../ui/markdown";
import { AgentLink, Avatar, Badge, Button, CognitionBadge, Empty, ErrorNote, Field, KV, Meter, ModelTierBadge, Panel, RelTime, SearchInput, Skeleton, StatusBadge, Tabs, TierLabel, useAction } from "../ui/kit";
import type { AgentDetail, MemoryKind, ModelTier, Run } from "../types";
import { BrainView } from "./brain";
import { ChatThread } from "./chat";
import { PageHead, TaskRef, useDeptName } from "./common";
import { useAgentActions } from "./org";
import { TaskStatusBadge } from "../ui/kit";

type TabId = "brain" | "overview" | "work" | "memory" | "chat";

export function AgentView({ agentId }: { agentId: string }) {
  const route = useRoute();
  const detail = useApi<AgentDetail>(`agent:${agentId}`, () => api.agent(agentId), {
    refreshOn: ["agent.updated", "task.updated", "run.completed", "run.started"],
    refreshIf: (ev) => ev.agentId === agentId || ev.type === "task.updated",
    throttleMs: 3000,
  });
  const live = useLive((s) => s.agents[agentId]);
  const actions = useAgentActions();
  const agent = live ?? detail.data?.agent;
  const isBrain = agent?.cognition === "brain";
  const wanted = route.query.get("tab") as TabId | null;
  const tab: TabId = wanted && (wanted !== "brain" || isBrain) ? wanted : isBrain ? "brain" : "overview";
  const deptName = useDeptName(agent?.departmentId);

  if (detail.error && !detail.data) return <><PageHead title="Agent" /><ErrorNote error={detail.error} onRetry={detail.reload} /></>;
  if (!agent || !detail.data) return <><PageHead title="Agent" /><Skeleton rows={8} height={18} /></>;
  const d = detail.data;
  const paused = agent.status === "paused";
  const gone = agent.status === "terminated";
  return (
    <>
      <PageHead
        crumbs={<><a href={href("/org")}>Org chart</a><span>/</span><span>{agent.name}</span></>}
        title={<span className="row"><Avatar agent={agent} size={34} /> {agent.name}</span>}
        sub={<span className="row wrap">{agent.title} · {deptName} <StatusBadge status={agent.status} /> <TierLabel tier={agent.tier} /> <CognitionBadge kind={agent.cognition} /> <ModelTierBadge tier={agent.modelTier} override={agent.modelOverride} /></span>}
      >
        {!gone ? (
          <>
            <Button icon="chat" onClick={() => actions.chat(agent)}>Chat</Button>
            <Button icon={paused ? "play" : "pause"} onClick={() => actions.togglePause(agent)}>{paused ? "Resume" : "Pause"}</Button>
            <Button variant="danger" icon="trash" onClick={() => actions.askDestroy(agent)}>Destroy</Button>
          </>
        ) : <Badge tone="danger">Terminated</Badge>}
      </PageHead>
      {agent.activity && !gone ? <div className="agent-activity"><StatusBadge status={agent.status} compact /> {agent.activity}</div> : null}
      <Tabs
        label="Agent sections"
        value={tab}
        onChange={(t) => setQuery("tab", t)}
        tabs={[
          ...(isBrain ? [{ id: "brain" as TabId, label: "Brain" }] : []),
          { id: "overview", label: "Overview" },
          { id: "work", label: "Work", count: d.openTasks.length },
          { id: "memory", label: "Memory" },
          { id: "chat", label: "Chat" },
        ]}
      />
      <div className="tab-body">
        {tab === "brain" ? <BrainView detail={{ ...d, agent }} /> : null}
        {tab === "overview" ? <OverviewTab d={{ ...d, agent }} /> : null}
        {tab === "work" ? <WorkTab d={d} /> : null}
        {tab === "memory" ? <MemoryTab agentId={agentId} /> : null}
        {tab === "chat" ? <ChatTab agentId={agentId} /> : null}
      </div>
      {actions.dialogs}
    </>
  );
}

function OverviewTab({ d }: { d: AgentDetail }) {
  const { agent, stats, needs } = d;
  const isBrain = agent.cognition === "brain";
  const id = agent.identity;
  const month = stats.spentMonthUsd;
  return (
    <div className="grid-2 wide-left">
      <div className="stack">
        <Panel title="Identity">
          <KV
            rows={[
              ["Mission", id.mission],
              ["Worldview", id.worldview || "—"],
              ["Life view", id.lifeView || "—"],
              ["Values", id.values.length ? <ul className="plain-list">{id.values.map((v) => <li key={v}>{v}</li>)}</ul> : "—"],
              ["Vision", id.vision || "—"],
              ["Persona", `${agent.persona.style}${agent.persona.traits.length ? ` (${agent.persona.traits.join(", ")})` : ""}`],
              ...(isBrain ? ([["Personality (MBTI)", agent.persona.personalityType ?? "—"]] as [string, string][]) : []),
              ["Tools", <span key="t" className="tool-list">{agent.tools.map((t) => <code key={t}>{t}</code>)}</span>],
            ]}
          />
        </Panel>
        {isBrain ? (
          <>
            <Panel title="Objectives and key results">
              {id.okrs.length ? (
                <div className="stack">
                  {id.okrs.map((o) => (
                    <div key={o.objective}>
                      <div className="okr-obj">{o.objective}</div>
                      {o.keyResults.map((k) => (
                        <div key={k.description} className="okr-kr">
                          <div className="row small"><span className="grow">{k.description}</span><span className="num muted">{k.current} / {k.target} {k.unit}</span></div>
                          <Meter value={k.current} max={k.target || 1} warnAt={2} dangerAt={3} label={k.description} small />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : <p className="muted">No objectives set.</p>}
            </Panel>
            <Panel title="Self-narrative">
              {id.narrative ? <Markdown text={id.narrative} /> : <p className="muted">Written after the agent finishes a few objectives.</p>}
              {id.assets.length ? <p className="small muted" style={{ marginTop: 8 }}>Assets: {id.assets.join(", ")}</p> : null}
            </Panel>
          </>
        ) : null}
      </div>
      <div className="stack">
        <Panel title="Budget and activity">
          <div className="small row"><span className="grow muted">This month</span><strong className="num">{money(month)}</strong><span className="muted num">/ {money(agent.monthlyBudgetUsd)}</span></div>
          <Meter value={month} max={agent.monthlyBudgetUsd || 1} label="Monthly budget used" />
          <KV rows={[
            ["Spent today", money(stats.spentTodayUsd)],
            ["Runs", `${stats.runsTotal} (${stats.runsFailed} failed)`],
            ["Tasks done / open", `${stats.tasksDone} / ${stats.tasksOpen}`],
            ["Tokens", `${compact(stats.inputTokens)} in, ${compact(stats.outputTokens)} out`],
            ["Last active", <RelTime key="l" iso={stats.lastActiveAt} />],
            ["Manager", d.manager ? <AgentLink id={d.manager.id} /> : "The Board"],
            ["Reports", d.reports.length ? <span className="row wrap">{d.reports.map((r) => <AgentLink key={r.id} id={r.id} />)}</span> : "None"],
          ]} />
        </Panel>
        {isBrain ? (
          <>
            <Panel title="Sensibility / emotion">
              <div className="stack tight">
                <Gauge label="Valence" value={agent.affect.valence} min={-1} max={1} diverging format={(v) => v.toFixed(2)} />
                <Gauge label="Arousal" value={agent.affect.arousal} format={(v) => v.toFixed(2)} />
                <Gauge label="Frustration (escalates above 0.7)" value={agent.affect.frustration} threshold={0.7} format={(v) => v.toFixed(2)} />
              </div>
            </Panel>
            <Panel title="Motivation and needs">
              <div className="stack tight">
                <Gauge label="Freedom (autonomy)" value={id.motivation.autonomy} />
                <Gauge label="Competence" value={id.motivation.competence} />
                <Gauge label="Purpose" value={id.motivation.purpose} />
              </div>
              <div className="needs">
                {(["physiological", "safety", "belonging", "esteem"] as const).map((n) => (
                  <span key={n} className={`need ${needs[n]}`}>{needs[n] === "ok" ? "✓" : "!"} {n[0]!.toUpperCase() + n.slice(1)} {needs[n]}</span>
                ))}
              </div>
              <Gauge label="Self-actualisation" value={needs.selfActualization} format={pct} />
            </Panel>
            <Panel title="Calibration">
              <KV rows={[
                ["Samples", `${agent.calibration.samples}`],
                ["Mean confidence", agent.calibration.meanConfidence.toFixed(2)],
                ["Observed success", pct(agent.calibration.successRate)],
                ["Brier score", agent.calibration.brier.toFixed(3)],
              ]} />
            </Panel>
          </>
        ) : null}
        <EditPanel d={d} />
      </div>
    </div>
  );
}

function EditPanel({ d }: { d: AgentDetail }) {
  const { agent } = d;
  const models = useApi("models", () => api.models());
  const agents = useLive((s) => s.agents);
  const { busy, run } = useAction();
  const [tier, setTier] = useState<ModelTier>(agent.modelTier);
  const [override, setOverride] = useState(agent.modelOverride ?? "");
  const [budget, setBudget] = useState(String(agent.monthlyBudgetUsd));
  const [manager, setManager] = useState(agent.managerId ?? "");
  useEffect(() => {
    setTier(agent.modelTier);
    setOverride(agent.modelOverride ?? "");
    setBudget(String(agent.monthlyBudgetUsd));
    setManager(agent.managerId ?? "");
  }, [agent.modelTier, agent.modelOverride, agent.monthlyBudgetUsd, agent.managerId]);
  const dirty = tier !== agent.modelTier || override !== (agent.modelOverride ?? "") || Number(budget) !== agent.monthlyBudgetUsd || manager !== (agent.managerId ?? "");
  const candidates = Object.values(agents).filter((a) => a.status !== "terminated" && a.id !== agent.id && a.tier !== "worker");
  const save = async () => {
    const a = await run(
      () => api.updateAgent(agent.id, { modelTier: tier, modelOverride: override || null, monthlyBudgetUsd: Number(budget), managerId: manager || null }),
      "Saved",
    );
    if (a) seed.agent(a);
  };
  return (
    <Panel title="Settings">
      <div className="form-grid">
        <Field label="Model tier">
          <select value={tier} onChange={(e) => setTier(e.target.value as ModelTier)}>
            <option value="frontier">Frontier</option><option value="standard">Standard</option><option value="economy">Economy</option>
          </select>
        </Field>
        <Field label="Model override">
          <select value={override} onChange={(e) => setOverride(e.target.value)}>
            <option value="">Tier default</option>
            {models.data?.profiles.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
          </select>
        </Field>
        <Field label="Monthly budget (USD)"><input type="number" min="0" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
        <Field label="Manager">
          <select value={manager} onChange={(e) => setManager(e.target.value)}>
            <option value="">The Board</option>
            {candidates.map((a) => <option key={a.id} value={a.id}>{a.name}, {a.title}</option>)}
          </select>
        </Field>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <Button variant="primary" onClick={save} disabled={!dirty || busy}>{busy ? "Saving…" : "Save changes"}</Button>
        {dirty ? <Button variant="ghost" onClick={() => { setTier(agent.modelTier); setOverride(agent.modelOverride ?? ""); setBudget(String(agent.monthlyBudgetUsd)); setManager(agent.managerId ?? ""); }}>Reset</Button> : null}
      </div>
    </Panel>
  );
}

function RunsTable({ runs }: { runs: Run[] }) {
  if (!runs.length) return <Empty title="No runs yet" icon="bolt" />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th className="r">LLM</th><th className="r">Tools</th><th className="r">Cost</th><th className="r">Time</th><th /></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => navigate(`/traces/${r.traceId}?run=${r.id}`)}>
              <td><RelTime iso={r.startedAt ?? r.createdAt} /></td>
              <td>{r.trigger.replace("_", " ")}</td>
              <td><span className={`status rs-${r.status}`}>{r.status}</span></td>
              <td className="r num">{r.llmCalls}</td>
              <td className="r num">{r.toolCalls}</td>
              <td className="r num">{money(r.costUsd)}</td>
              <td className="r num">{r.startedAt && r.completedAt ? duration(Date.parse(r.completedAt) - Date.parse(r.startedAt)) : "—"}</td>
              <td><a href={href(`/traces/${r.traceId}`, { run: r.id })} onClick={(e) => e.stopPropagation()}>Trace</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkTab({ d }: { d: AgentDetail }) {
  return (
    <div className="stack">
      <Panel title="Current task">
        {d.currentTask ? (
          <div className="row wrap">
            <TaskRef task={d.currentTask} /> <strong>{d.currentTask.title}</strong> <TaskStatusBadge status={d.currentTask.status} />
            <span className="muted small">value {d.currentTask.value}, est. {money(d.currentTask.estCostUsd)}, actual {money(d.currentTask.actualCostUsd)}</span>
          </div>
        ) : <p className="muted">Nothing in progress.</p>}
      </Panel>
      <Panel title={`Open tasks (${d.openTasks.length})`} flush>
        {d.openTasks.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Task</th><th>Status</th><th className="r">Value</th><th className="r">Est. cost</th><th className="r">Priority</th></tr></thead>
            <tbody>
              {d.openTasks.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => navigate(`/tasks/${t.id}`)}>
                  <td><TaskRef task={t} /> {t.title}</td><td><TaskStatusBadge status={t.status} /></td>
                  <td className="r num">{t.value}</td><td className="r num">{money(t.estCostUsd)}</td><td className="r num">{t.priority.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : <Empty title="No open tasks" icon="tasks" />}
      </Panel>
      <Panel title="Recent runs" flush><RunsTable runs={d.recentRuns} /></Panel>
    </div>
  );
}

const KINDS: (MemoryKind | "")[] = ["", "episodic", "semantic", "procedural", "conceptual", "working"];
export function MemoryList({ items }: { items: { id: string; kind: string; content: string; tags: string[]; importance: number; createdAt: string }[] }) {
  return (
    <ul className="mem-list">
      {items.map((m) => (
        <li key={m.id} className="mem-item">
          <div className="row"><Badge tone="accent">{m.kind}</Badge><span className="muted tiny">importance {m.importance.toFixed(2)}</span><span className="grow" /><RelTime iso={m.createdAt} className="rel muted tiny" /></div>
          <p>{m.content}</p>
          {m.tags.length ? <div className="row wrap">{m.tags.map((t) => <span key={t} className="tag">#{t}</span>)}</div> : null}
        </li>
      ))}
    </ul>
  );
}
function MemoryTab({ agentId }: { agentId: string }) {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [kind, setKind] = useState<MemoryKind | "">("");
  useEffect(() => {
    const t = window.setTimeout(() => setDq(q), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const mem = useApi(`agent-mem:${agentId}:${dq}:${kind}`, () => api.agentMemory(agentId, { q: dq, kind }));
  return (
    <Panel title="Agent memory" actions={<SearchInput value={q} onChange={setQ} placeholder="Search memory" width={220} />}>
      <div className="row wrap" style={{ marginBottom: 10 }} role="group" aria-label="Filter by kind">
        {KINDS.map((k) => <button key={k || "all"} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{k || "All"}</button>)}
      </div>
      {mem.loading ? <Skeleton rows={4} /> : mem.error ? <ErrorNote error={mem.error} onRetry={mem.reload} /> : mem.data?.length ? <MemoryList items={mem.data} /> : <Empty title="No memories match" icon="memory">Memories are written as the agent finishes work.</Empty>}
    </Panel>
  );
}

function ChatTab({ agentId }: { agentId: string }) {
  const conv = useApi(`dm:${agentId}`, () => api.openConversation(agentId));
  if (conv.error) return <ErrorNote error={conv.error} onRetry={conv.reload} />;
  if (!conv.data) return <Skeleton rows={5} height={30} />;
  return (
    <Panel className="embedded-chat" flush>
      <ChatThread key={conv.data.id} conversationId={conv.data.id} conversation={conv.data} />
    </Panel>
  );
}
