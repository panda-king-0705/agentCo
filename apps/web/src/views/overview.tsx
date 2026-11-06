// Overview: company state, KPI row, live floor, activity feed, sparklines, recent traces.
import { memo, useMemo, useState } from "react";
import { api } from "../api";
import { clockTime, compact, duration, money, pct } from "../format";
import { href, navigate } from "../router";
import { seed, useLive, useApi } from "../live";
import { Sparkline } from "../ui/charts";
import { AgentLink, Badge, Button, CognitionBadge, ConfirmDialog, Empty, Meter, ModelTierBadge, Panel, RelTime, Skeleton, StatusGlyph, AGENT_STATUS, SpanStatusBadge, useAction } from "../ui/kit";
import type { Agent, CompanyEvent } from "../types";
import { PageHead, blockLabel, byTier, liveAgents } from "./common";

function Kpi({ label, value, sub, href: to, tone }: { label: string; value: string; sub?: string; href?: string; tone?: "warn" | "bad" }) {
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value num${tone ? ` ${tone}` : ""}`}>{value}</div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </>
  );
  return to ? (
    <a className="kpi" href={to}>
      {body}
    </a>
  ) : (
    <div className="kpi">{body}</div>
  );
}

export const AgentChip = memo(function AgentChip({ agent }: { agent: Agent }) {
  const live = agent.status === "thinking" || agent.status === "acting";
  return (
    <a className={`agent-chip st-${agent.status}${live ? " live" : ""}`} href={href(`/agents/${agent.id}`)} title={`${agent.name}, ${agent.title}`}>
      <div className="ac-top">
        <StatusGlyph status={agent.status} size={11} />
        <span className="ac-name ellipsis">{agent.name}</span>
        <span className="ac-status">{AGENT_STATUS[agent.status]}</span>
      </div>
      <div className="ac-title ellipsis">{agent.title}</div>
      <div className="ac-act" title={agent.activity ?? undefined}>
        {agent.activity ?? <span className="muted">No current activity</span>}
      </div>
      <div className="ac-badges">
        <CognitionBadge kind={agent.cognition} />
        <ModelTierBadge tier={agent.modelTier} override={agent.modelOverride} />
        {agent.brainBlock ? <span className="badge b-block" title={agent.brainBlock}>{blockLabel(agent.brainBlock)}</span> : null}
      </div>
    </a>
  );
});

function Floor() {
  const agents = useLive((s) => s.agents);
  const departments = useLive((s) => s.departments);
  const lanes = useMemo(() => {
    const by: Record<string, Agent[]> = {};
    for (const a of liveAgents(agents)) (by[a.departmentId] ??= []).push(a);
    return Object.values(departments)
      .map((d) => ({ d, list: (by[d.id] ?? []).sort(byTier) }))
      .filter((l) => l.list.length)
      .sort((a, b) => (a.d.slug === "executive" ? -1 : b.d.slug === "executive" ? 1 : b.list.length - a.list.length));
  }, [agents, departments]);
  if (!lanes.length) return <Empty title="No agents yet" icon="org">Hire the first agent from the Org chart.</Empty>;
  return (
    <div className="floor">
      {lanes.map(({ d, list }) => {
        const busy = list.filter((a) => a.status === "thinking" || a.status === "acting").length;
        return (
          <section key={d.id} className="lane" style={{ ["--dc" as string]: d.color }} aria-label={`${d.name} department`}>
            <header className="lane-head">
              <span className="lane-dot" aria-hidden="true" />
              <strong>{d.name}</strong>
              <span className="muted small">{list.length} agent{list.length === 1 ? "" : "s"}{busy ? `, ${busy} working` : ""}</span>
            </header>
            <div className="lane-chips">
              {list.map((a) => (
                <AgentChip key={a.id} agent={a} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

type FeedFilter = "all" | "agents" | "tasks" | "runs" | "messages" | "approvals" | "spans";
const FEED_FILTERS: { id: FeedFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "tasks", label: "Tasks" },
  { id: "runs", label: "Runs" },
  { id: "messages", label: "Messages" },
  { id: "approvals", label: "Approvals" },
  { id: "spans", label: "Spans" },
];
function feedGroup(ev: CompanyEvent): FeedFilter | "other" {
  const t = ev.type.split(".")[0];
  switch (t) {
    case "agent": return "agents";
    case "task": return "tasks";
    case "run": return "runs";
    case "message": return "messages";
    case "approval": return "approvals";
    case "span": return "spans";
    default: return "other";
  }
}
function evLink(ev: CompanyEvent): string | null {
  if (ev.taskId) return href(`/tasks/${ev.taskId}`);
  if (ev.traceId) return href(`/traces/${ev.traceId}`);
  if (ev.type.startsWith("approval")) return href("/approvals");
  return null;
}

function Feed() {
  const events = useLive((s) => s.events);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const shown = useMemo(() => events.filter((e) => (filter === "all" ? feedGroup(e) !== "spans" : feedGroup(e) === filter)).slice(0, 60), [events, filter]);
  return (
    <Panel
      title="Live activity"
      className="feed-panel"
      actions={
        <div className="row wrap" role="group" aria-label="Filter activity by type">
          {FEED_FILTERS.map((f) => (
            <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      }
      flush
    >
      {shown.length ? (
        <ul className="feed" aria-live="off">
          {shown.map((e) => {
            const to = evLink(e);
            return (
              <li key={e.seq} className={`feed-item g-${feedGroup(e)}`}>
                <span className="feed-time num">{clockTime(e.at)}</span>
                <span className="feed-type">{e.type}</span>
                <span className="feed-sum">
                  {e.agentId ? <AgentLink id={e.agentId} size={16} /> : null} {to ? <a href={to}>{e.summary}</a> : e.summary}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty title="Nothing yet" icon="bolt">Events appear here as agents work.</Empty>
      )}
    </Panel>
  );
}

function KillSwitch() {
  const company = useLive((s) => s.company);
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAction();
  if (!company) return null;
  const paused = company.settings.paused;
  const act = async () => {
    await run(() => (paused ? api.resumeCompany() : api.pauseCompany()), paused ? "Company resumed" : "Company paused");
    try {
      seed.company(await api.company({ quiet: true }));
    } catch {
      /* the event stream will catch up */
    }
    setConfirm(false);
  };
  return (
    <>
      <Button variant={paused ? "primary" : "danger"} icon={paused ? "play" : "power"} onClick={() => setConfirm(true)}>
        {paused ? "Resume all" : "Pause all"}
      </Button>
      {confirm ? (
        <ConfirmDialog
          title={paused ? "Resume the company?" : "Pause the whole company?"}
          confirmLabel={paused ? "Resume all agents" : "Pause all agents"}
          danger={!paused}
          busy={busy}
          onConfirm={act}
          onClose={() => setConfirm(false)}
        >
          {paused ? (
            <p>Agents pick up their queued work again. Nothing that was aborted comes back by itself.</p>
          ) : (
            <p>This is the kill switch. Every running run is aborted, no new run starts, and agents show as paused until you resume. Tasks and conversations are kept.</p>
          )}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Clears frustration and negative mood company-wide (after a stuck stretch every new task early-stopped). */
function ResetMood() {
  const agents = useLive((s) => s.agents);
  const { busy, run } = useAction();
  const frustrated = Object.values(agents).filter((a) => a.status !== "terminated" && a.affect && a.affect.frustration > 0.7).length;
  if (!frustrated) return null;
  const act = async () => {
    const res = await run(() => api.resetMood(), "Moods reset");
    if (res) seed.agents((await api.org()).agents);
  };
  return (
    <Button icon="refresh" onClick={act} disabled={busy} title={`${frustrated} agent(s) are frustrated enough to stop every task early`}>
      Reset moods ({frustrated})
    </Button>
  );
}

export function Overview() {
  const company = useLive((s) => s.company);
  const agents = useLive((s) => s.agents);
  const tasks = useLive((s) => s.tasks);
  const approvals = useLive((s) => s.approvals);
  const metrics = useApi("metrics", () => api.metricsOverview({ quiet: true }), { refreshOn: ["run.completed", "task.updated"], intervalMs: 20000 });
  const cost = useApi("ts-cost", () => api.timeseries("cost", 24), { refreshOn: ["run.completed"], throttleMs: 5000, intervalMs: 60000 });
  const runs = useApi("ts-runs", () => api.timeseries("runs", 24), { refreshOn: ["run.completed"], throttleMs: 5000, intervalMs: 60000 });
  const traces = useApi("traces-recent", () => api.traces(6), { refreshOn: ["run.completed", "run.started"], throttleMs: 4000 });

  const stats = useMemo(() => {
    const list = liveAgents(agents);
    const working = list.filter((a) => a.status === "thinking" || a.status === "acting").length;
    const open = Object.values(tasks).filter((t) => !["done", "failed", "cancelled"].includes(t.status)).length;
    const pending = Object.values(approvals).filter((a) => a.status === "pending").length;
    return { headcount: list.length, working, open, pending };
  }, [agents, tasks, approvals]);

  if (!company) return (
    <>
      <PageHead title="Overview" />
      <Skeleton rows={8} height={18} />
    </>
  );
  const s = company.settings;
  const m = metrics.data;
  const burn = s.dailyBudgetUsd > 0 ? company.spentTodayUsd / s.dailyBudgetUsd : 0;
  return (
    <>
      <PageHead
        title={s.name}
        sub={s.mission}
      >
        <Badge tone={company.models.live ? "live" : "mock"} title={company.models.live ? "Agents call real model providers" : "Every tier resolves to the mock provider; no real spend"}>
          {company.models.live ? "LIVE models" : "MOCK models"}
        </Badge>
        {s.paused ? <Badge tone="warn">Paused</Badge> : null}
        <div className="burn" title={`${money(company.spentTodayUsd)} of ${money(s.dailyBudgetUsd)} daily budget`}>
          <div className="burn-text small">
            <span className="muted">Daily budget</span> <strong className="num">{money(company.spentTodayUsd)}</strong> <span className="muted num">/ {money(s.dailyBudgetUsd)}</span>
          </div>
          <Meter value={company.spentTodayUsd} max={s.dailyBudgetUsd} label="Daily budget burn" small />
          <span className="sr-only">{pct(burn)} of daily budget used</span>
        </div>
        <ResetMood />
        <KillSwitch />
      </PageHead>

      <div className="kpis">
        <Kpi label="Headcount" value={`${stats.headcount}`} sub={`${stats.working} working now`} href={href("/org")} />
        <Kpi label="Open tasks" value={`${stats.open}`} sub={m ? `${m.tasksByStatus.blocked ?? 0} blocked` : undefined} href={href("/tasks")} />
        <Kpi label="Pending approvals" value={`${stats.pending}`} sub={stats.pending ? "Waiting on you" : "All clear"} href={href("/approvals")} tone={stats.pending ? "warn" : undefined} />
        <Kpi label="Spend today" value={money(company.spentTodayUsd)} sub={`${pct(burn)} of daily`} href={href("/costs")} />
        <Kpi label="Spend this month" value={money(company.spentMonthUsd)} sub={`of ${money(s.monthlyBudgetUsd)}`} href={href("/costs")} />
        <Kpi label="Run success rate" value={m?.runSuccessRate == null ? "—" : pct(m.runSuccessRate)} sub={m ? `${m.runs24h} runs, avg ${duration(m.avgRunMs)}` : undefined} />
        <Kpi label="Routing savings" value={m ? money(m.routingSavingsUsd) : "—"} sub="this month, vs all-frontier" href={href("/costs")} />
      </div>

      <Panel title="Live floor" className="mt" actions={<span className="muted small">Agents by department, updated as events arrive</span>}>
        <Floor />
      </Panel>

      <div className="grid-2 mt">
        <Feed />
        <div className="stack">
          <Panel title="Cost, last 24 h" actions={<span className="num small">{money(cost.data?.reduce((n, p) => n + p.value, 0))}</span>}>
            {cost.data ? <Sparkline points={cost.data} format={money} label="Model cost per hour over the last 24 hours" height={56} /> : <Skeleton rows={2} />}
          </Panel>
          <Panel title="Runs, last 24 h" actions={<span className="num small">{compact(runs.data?.reduce((n, p) => n + p.value, 0))}</span>}>
            {runs.data ? <Sparkline points={runs.data} format={(v) => `${Math.round(v)} runs`} label="Runs per hour over the last 24 hours" height={56} color="var(--series-2)" /> : <Skeleton rows={2} />}
          </Panel>
          <Panel title="Recent traces" actions={<a href={href("/traces")} className="small">All traces</a>} flush>
            {traces.data?.length ? (
              <ul className="list">
                {traces.data.map((t) => (
                  <li key={t.traceId}>
                    <a className="list-row" href={href(`/traces/${t.traceId}`)} onClick={(e) => { e.preventDefault(); navigate(`/traces/${t.traceId}`); }}>
                      <span className="grow ellipsis">{t.title}</span>
                      <SpanStatusBadge status={t.status} />
                      <span className="num muted small">{money(t.costUsd)}</span>
                      <RelTime iso={t.startedAt} className="rel small muted" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : traces.loading ? <Skeleton rows={3} /> : <Empty title="No traces yet" icon="traces" />}
          </Panel>
        </div>
      </div>
    </>
  );
}
