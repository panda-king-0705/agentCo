// Costs: spend by tier / model / department / agent, 24 h series, routing savings, budget vs spend.
import { useMemo } from "react";
import { api } from "../api";
import { money, pct, compact } from "../format";
import { useApi, useLive } from "../live";
import { HBars, TimeChart, type BarItem } from "../ui/charts";
import { Meter, Panel, Skeleton, ErrorNote } from "../ui/kit";
import type { ModelTier } from "../types";
import { PageHead } from "./common";

const TIER_COLOR: Record<ModelTier, string> = { frontier: "var(--tier-frontier)", standard: "var(--tier-standard)", economy: "var(--tier-economy)" };

export function CostsView() {
  const m = useApi("metrics-costs", () => api.metricsOverview(), { refreshOn: ["run.completed"], throttleMs: 5000, intervalMs: 30000 });
  const series = useApi("ts-cost-costs", () => api.timeseries("cost", 24), { refreshOn: ["run.completed"], throttleMs: 8000 });
  const runs = useApi("runs-for-costs", () => api.runs({ limit: 500 }), { refreshOn: ["run.completed"], throttleMs: 8000 });
  const company = useLive((s) => s.company);
  const departments = useLive((s) => s.departments);
  const agents = useLive((s) => s.agents);

  const byTier = useMemo<BarItem[]>(() => (m.data ? (Object.keys(m.data.spendByTier) as ModelTier[]).map((t) => ({ key: t, label: t[0]!.toUpperCase() + t.slice(1), value: m.data!.spendByTier[t], color: TIER_COLOR[t] })) : []), [m.data]);
  const byModel = useMemo<BarItem[]>(() => (m.data?.spendByModel ?? []).slice().sort((a, b) => b.costUsd - a.costUsd).map((x) => ({ key: x.model, label: <span className="mono">{x.model}</span>, value: x.costUsd, sub: <span className="muted tiny num">{compact(x.calls)} calls</span> })), [m.data]);
  const byDept = useMemo<BarItem[]>(() => (m.data?.spendByDepartment ?? []).slice().sort((a, b) => b.costUsd - a.costUsd).map((x) => ({ key: x.departmentId, label: departments[x.departmentId]?.name ?? x.departmentId, value: x.costUsd, color: departments[x.departmentId]?.color })), [m.data, departments]);
  const byAgent = useMemo<BarItem[]>(() => {
    const t = new Map<string, number>();
    for (const r of runs.data ?? []) t.set(r.agentId, (t.get(r.agentId) ?? 0) + r.costUsd);
    return [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, v]) => ({ key: id, label: agents[id]?.name ?? id, value: v, color: agents[id] ? departments[agents[id]!.departmentId]?.color : undefined }));
  }, [runs.data, agents, departments]);

  if (m.error && !m.data) return <><PageHead title="Costs" /><ErrorNote error={m.error} onRetry={m.reload} /></>;
  if (!m.data || !company) return <><PageHead title="Costs" /><Skeleton rows={8} height={18} /></>;
  const d = m.data;
  const s = company.settings;
  const deptSpend = new Map(d.spendByDepartment.map((x) => [x.departmentId, x.costUsd]));
  return (
    <>
      <PageHead title="Costs" sub={`${money(d.spentTodayUsd)} today, ${money(d.spentMonthUsd)} this month`} />
      <div className="callout" style={{ marginBottom: 14 }}>
        <div>
          <strong>Routing saved {money(d.routingSavingsUsd)} this month</strong> against running every call on the frontier tier
          {d.spentMonthUsd > 0 ? <> ({pct(d.routingSavingsUsd / (d.routingSavingsUsd + d.spentMonthUsd))} lower than {money(d.routingSavingsUsd + d.spentMonthUsd)}).</> : "."} Daily budget {money(s.dailyBudgetUsd)}, monthly {money(s.monthlyBudgetUsd)}.
        </div>
      </div>
      <div className="grid-2">
        <Panel title="Cost per hour, last 24 h" actions={<span className="num small">{money(series.data?.reduce((n, p) => n + p.value, 0))}</span>}>
          {series.data ? <TimeChart points={series.data} format={money} label="Model cost per hour, last 24 hours" height={210} /> : <Skeleton rows={4} />}
        </Panel>
        <Panel title="Spend by model tier"><HBars items={byTier} format={money} empty="No spend yet" /></Panel>
        <Panel title="Spend by model"><HBars items={byModel} format={money} /></Panel>
        <Panel title="Spend by department"><HBars items={byDept} format={money} /></Panel>
        <Panel title="Spend by agent" actions={<span className="muted small">from the last {runs.data?.length ?? 0} runs</span>}><HBars items={byAgent} format={money} /></Panel>
        <Panel title="Budget vs spend, per department" actions={<span className="muted small">monthly</span>}>
          <ul className="budget-list">
            {Object.values(departments).filter((x) => x.monthlyBudgetUsd > 0 || deptSpend.has(x.id)).map((x) => {
              const spend = deptSpend.get(x.id) ?? 0;
              return (
                <li key={x.id}>
                  <div className="row small"><span className="lane-dot" style={{ background: x.color }} aria-hidden="true" /><span className="grow">{x.name}</span><span className="num">{money(spend)}</span><span className="muted num">/ {money(x.monthlyBudgetUsd)}</span></div>
                  <Meter value={spend} max={x.monthlyBudgetUsd || 1} label={`${x.name} budget used`} small />
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>
    </>
  );
}
