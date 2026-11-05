// Traces: list, then a Glass Box detail: waterfall, filters, span panel, cost summaries, delegation graph.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { compact, dateTime, duration, money } from "../format";
import { href, navigate, setQuery, useRoute } from "../router";
import { useApi, useLive, useNow } from "../live";
import { HBars, type BarItem } from "../ui/charts";
import { AgentLink, Avatar, Badge, Button, Empty, ErrorNote, Icon, KV, KindSwatch, Panel, RelTime, SearchInput, Skeleton, SPAN_KINDS, SPAN_KIND_LABEL, SpanStatusBadge } from "../ui/kit";
import type { Agent, Span, SpanKind, TraceDetail, TraceSummary } from "../types";
import { PageHead, TaskLinkById, blockLabel } from "./common";
import { spanBlock } from "./brain";

function traceDuration(t: TraceSummary, now: number): number {
  const end = t.endedAt ? Date.parse(t.endedAt) : now;
  return Math.max(0, end - Date.parse(t.startedAt));
}

function AgentStack({ ids }: { ids: string[] }) {
  const agents = useLive((s) => s.agents);
  return (
    <span className="avatar-stack">
      {ids.slice(0, 5).map((id) => <Avatar key={id} agent={agents[id]} id={id} size={22} />)}
      {ids.length > 5 ? <span className="more">+{ids.length - 5}</span> : null}
    </span>
  );
}

function TraceList() {
  const traces = useApi("traces-list", () => api.traces(200), { refreshOn: ["run.started", "run.completed", "span.ended"], throttleMs: 4000 });
  const now = useNow();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "running" | "error" | "ok">("");
  const rows = useMemo(() => (traces.data ?? []).filter((t) => (!q || t.title.toLowerCase().includes(q.toLowerCase())) && (!status || t.status === status)), [traces.data, q, status]);
  return (
    <>
      <PageHead title="Traces" sub="One row per objective. Open one to see every agent, model call and tool call under it.">
        <div className="row wrap" role="group" aria-label="Filter by status">
          {([["", "All"], ["running", "Running"], ["error", "Errors"], ["ok", "OK"]] as const).map(([v, l]) => <button key={v} type="button" className="chip" aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>)}
        </div>
        <SearchInput value={q} onChange={setQ} placeholder="Search traces" width={220} />
      </PageHead>
      <Panel flush>
        {traces.error && !traces.data ? <ErrorNote error={traces.error} onRetry={traces.reload} /> : traces.loading ? <Skeleton rows={8} height={18} /> : rows.length ? (
          <div className="table-wrap">
            <table className="table" data-testid="trace-table">
              <thead><tr><th>Trace</th><th>Status</th><th>Agents</th><th className="r">Spans</th><th className="r">LLM calls</th><th className="r">Tokens</th><th className="r">Cost</th><th className="r">Duration</th><th>Started</th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.traceId} className="clickable" onClick={() => navigate(`/traces/${t.traceId}`)}>
                    <td className="trace-title"><a href={href(`/traces/${t.traceId}`)} onClick={(e) => e.stopPropagation()}>{t.title}</a></td>
                    <td><SpanStatusBadge status={t.status} /></td>
                    <td><AgentStack ids={t.agentIds} /></td>
                    <td className="r num">{t.spanCount}</td>
                    <td className="r num">{t.llmCalls}</td>
                    <td className="r num">{compact(t.inputTokens + t.outputTokens)}</td>
                    <td className="r num">{money(t.costUsd)}</td>
                    <td className="r num">{duration(traceDuration(t, now))}</td>
                    <td><RelTime iso={t.startedAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty title="No traces match" icon="traces">Send the CEO a message or create a task to start one.</Empty>}
      </Panel>
    </>
  );
}

// ───────────── detail ─────────────
interface Node {
  span: Span;
  children: Node[];
  depth: number;
}
function buildTree(spans: Span[]): { roots: Node[]; byId: Map<string, Node> } {
  const byId = new Map<string, Node>();
  for (const s of spans) byId.set(s.id, { span: s, children: [], depth: 0 });
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const p = n.span.parentSpanId ? byId.get(n.span.parentSpanId) : undefined;
    if (p) p.children.push(n);
    else roots.push(n);
  }
  const sortRec = (list: Node[], depth: number) => {
    list.sort((a, b) => a.span.startedAt.localeCompare(b.span.startedAt));
    for (const n of list) {
      n.depth = depth;
      sortRec(n.children, depth + 1);
    }
  };
  sortRec(roots, 0);
  return { roots, byId };
}

function inheritedBlock(span: Span, byId: Map<string, Node>): string | null {
  let cur: Span | undefined = span;
  for (let i = 0; cur && i < 12; i++) {
    const b = spanBlock(cur);
    if (b) return b;
    cur = cur.parentSpanId ? byId.get(cur.parentSpanId)?.span : undefined;
  }
  return null;
}

function Waterfall({ detail, selectedId, onSelect }: { detail: TraceDetail; selectedId: string | null; onSelect: (id: string) => void }) {
  const agents = useLive((s) => s.agents);
  const departments = useLive((s) => s.departments);
  const now = useNow();
  const route = useRoute();
  const runFilter = route.query.get("run");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [agentF, setAgentF] = useState("");
  const [kinds, setKinds] = useState<Set<SpanKind>>(new Set());
  const [errorsOnly, setErrorsOnly] = useState(false);
  const { roots, byId } = useMemo(() => buildTree(detail.spans), [detail.spans]);
  const firstError = useMemo(() => [...detail.spans].filter((s) => s.status === "error").sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]?.id ?? null, [detail.spans]);

  const t0 = useMemo(() => Math.min(...detail.spans.map((s) => Date.parse(s.startedAt))), [detail.spans]);
  const t1 = useMemo(() => Math.max(t0 + 1, ...detail.spans.map((s) => (s.endedAt ? Date.parse(s.endedAt) : Math.max(now, Date.parse(s.startedAt) + 1)))), [detail.spans, now, t0]);
  const total = t1 - t0;

  const filtering = !!agentF || kinds.size > 0 || errorsOnly || !!runFilter;
  const matches = useMemo(() => {
    const m = new Set<string>();
    for (const s of detail.spans) {
      if (agentF && s.agentId !== agentF) continue;
      if (kinds.size && !kinds.has(s.kind)) continue;
      if (errorsOnly && s.status !== "error") continue;
      if (runFilter && s.runId !== runFilter) continue;
      m.add(s.id);
    }
    return m;
  }, [detail.spans, agentF, kinds, errorsOnly, runFilter]);
  const visible = useMemo(() => {
    if (!filtering) return null;
    const v = new Set<string>();
    for (const id of matches) {
      let cur = byId.get(id);
      while (cur) {
        v.add(cur.span.id);
        cur = cur.span.parentSpanId ? byId.get(cur.span.parentSpanId) : undefined;
      }
    }
    return v;
  }, [filtering, matches, byId]);

  const rows: Node[] = [];
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (visible && !visible.has(n.span.id)) continue;
      rows.push(n);
      if (!collapsed.has(n.span.id) || visible) walk(n.children);
    }
  };
  walk(roots);

  const toggle = (id: string) => setCollapsed((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <Panel
      title={`Waterfall (${rows.length}${filtering ? ` of ${detail.spans.length}` : ""} spans)`}
      flush
    >
      <div className="wf-filters">
        <div className="row wrap">
          <select value={agentF} onChange={(e) => setAgentF(e.target.value)} aria-label="Filter by agent">
            <option value="">All agents</option>
            {detail.summary.agentIds.map((id) => <option key={id} value={id}>{agents[id]?.name ?? id}</option>)}
          </select>
          {SPAN_KINDS.map((k) => (
            <button key={k} type="button" className="chip" aria-pressed={kinds.has(k)} onClick={() => setKinds((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>
              <KindSwatch kind={k} /> {SPAN_KIND_LABEL[k]}
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={errorsOnly} onClick={() => setErrorsOnly((e) => !e)}><Icon name="alert" size={12} /> Errors only</button>
          {runFilter ? <button type="button" className="chip" aria-pressed onClick={() => setQuery("run", null)}>Run {runFilter.slice(-6)} <Icon name="x" size={11} /></button> : null}
        </div>
      </div>
      <div className="wf" role="treegrid" aria-label="Span waterfall">
        <div className="wf-head">
          <div className="wf-name muted small">Span</div>
          <div className="wf-axis">
            {ticks.map((t) => <span key={t} style={{ left: `${t * 100}%` }} className="num">{duration(total * t)}</span>)}
          </div>
        </div>
        {rows.map((n) => {
          const s = n.span;
          const a = s.agentId ? agents[s.agentId] : undefined;
          const color = a ? departments[a.departmentId]?.color ?? "var(--muted)" : "var(--line-strong)";
          const start = Date.parse(s.startedAt);
          const end = s.endedAt ? Date.parse(s.endedAt) : Math.max(now, start + 1);
          const left = ((start - t0) / total) * 100;
          const width = Math.max(((end - start) / total) * 100, 0.35);
          const dim = filtering && !matches.has(s.id);
          const hasKids = n.children.length > 0;
          const block = spanBlock(s);
          return (
            <div
              key={s.id}
              role="row"
              tabIndex={0}
              aria-selected={selectedId === s.id}
              data-span={s.id}
              className={`wf-row${selectedId === s.id ? " sel" : ""}${s.status === "error" ? " err" : ""}${s.id === firstError ? " first-err" : ""}${dim ? " dim" : ""}`}
              style={{ ["--lane" as string]: color }}
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s.id); } }}
            >
              <div className="wf-name" style={{ paddingLeft: 8 + n.depth * 14 }}>
                {hasKids ? (
                  <button type="button" className="wf-caret" aria-expanded={!collapsed.has(s.id)} aria-label={`${collapsed.has(s.id) ? "Expand" : "Collapse"} ${s.name}`} onClick={(e) => { e.stopPropagation(); toggle(s.id); }}>
                    <Icon name={collapsed.has(s.id) ? "chevronRight" : "chevronDown"} size={12} />
                  </button>
                ) : <span className="wf-caret spacer" />}
                <KindSwatch kind={s.kind} />
                <span className="wf-label ellipsis" title={s.name}>{s.name}</span>
                {a ? <span className="wf-agent tiny muted ellipsis">{a.name.split(" ")[0]}</span> : null}
                {s.status === "error" ? <span className="wf-flag" title={s.error ?? "Failed"}>{s.id === firstError ? "FAILED" : "error"}</span> : null}
                {block && s.kind === "stage" ? <span className="wf-block tiny muted ellipsis">{blockLabel(block)}</span> : null}
              </div>
              <div className="wf-bars">
                <span className={`wf-bar k-${s.kind}${s.status === "running" ? " running" : ""}${s.status === "error" ? " bad" : ""}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${s.name}: ${duration(s.durationMs ?? end - start)}`} />
                <span className="wf-dur tiny num" style={{ left: `min(${left + width}%, calc(100% - 52px))` }}>{duration(s.durationMs ?? end - start)}</span>
              </div>
            </div>
          );
        })}
        {!rows.length ? <Empty title="No spans match these filters" icon="filter" /> : null}
      </div>
    </Panel>
  );
}

function SpanPanel({ span, detail, onClose }: { span: Span; detail: TraceDetail; onClose: () => void }) {
  const attrs = Object.entries(span.attributes ?? {});
  const block = spanBlock(span);
  return (
    <aside className="span-panel panel" aria-label="Span details">
      <header className="panel-head">
        <h2><KindSwatch kind={span.kind} /> <span className="mono ellipsis">{span.name}</span></h2>
        <Button size="sm" variant="ghost" icon="x" onClick={onClose} aria-label="Close span details" />
      </header>
      <div className="panel-body">
        {span.error ? <div className="callout danger" role="alert"><Icon name="alert" /> <div><strong>Failed.</strong> {span.error}</div></div> : null}
        <KV
          rows={[
            ["Status", <SpanStatusBadge key="s" status={span.status} />],
            ["Kind", SPAN_KIND_LABEL[span.kind]],
            ["Agent", span.agentId ? <AgentLink id={span.agentId} /> : "—"],
            ["Task", span.taskId ? <TaskLinkById id={span.taskId} /> : "—"],
            ["Run", span.runId ? <span className="mono tiny">{span.runId}</span> : "—"],
            ["Started", dateTime(span.startedAt)],
            ["Duration", duration(span.durationMs)],
            ["Model", span.model ?? "—"],
            ["Tokens", span.inputTokens != null || span.outputTokens != null ? `${compact(span.inputTokens)} in, ${compact(span.outputTokens)} out` : "—"],
            ["Cost", span.costUsd != null ? money(span.costUsd) : "—"],
            ["Brain block", block ? <span key="b"><code>{block}</code></span> : "—"],
          ]}
        />
        <h3 className="section-title" style={{ marginTop: 14 }}>Attributes</h3>
        <table className="table attr-table">
          <tbody>
            {attrs.map(([k, v]) => (
              <tr key={k} className={k === "agentco.brain.block" ? "hl" : undefined}><td className="mono">{k}</td><td className="mono">{String(v)}</td></tr>
            ))}
            {!attrs.length ? <tr><td className="muted">No attributes</td></tr> : null}
          </tbody>
        </table>
        <h3 className="section-title" style={{ marginTop: 14 }}>Input <span className="muted tiny">redacted, truncated</span></h3>
        <pre className="io">{span.input ?? "—"}</pre>
        <h3 className="section-title" style={{ marginTop: 10 }}>Output</h3>
        <pre className="io">{span.output ?? "—"}</pre>
        <p className="tiny muted" style={{ marginTop: 8 }}>Trace {detail.summary.traceId}</p>
      </div>
    </aside>
  );
}

function DelegationGraph({ detail }: { detail: TraceDetail }) {
  const agents = useLive((s) => s.agents);
  const departments = useLive((s) => s.departments);
  const { nodes, edges, w, h } = useMemo(() => {
    const byId = new Map(detail.spans.map((s) => [s.id, s]));
    const edgeMap = new Map<string, number>();
    const depth = new Map<string, number>();
    const order: string[] = [];
    const add = (id: string) => { if (!depth.has(id)) { depth.set(id, 0); order.push(id); } };
    for (const s of [...detail.spans].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      if (!s.agentId) continue;
      add(s.agentId);
      if (s.kind !== "run") continue;
      let p = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
      while (p && (!p.agentId || p.agentId === s.agentId)) p = p.parentSpanId ? byId.get(p.parentSpanId) : undefined;
      if (p?.agentId) {
        const key = `${p.agentId}>${s.agentId}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, 0);
          depth.set(s.agentId, Math.max(depth.get(s.agentId) ?? 0, (depth.get(p.agentId) ?? 0) + 1));
        }
        edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
      }
    }
    const layers = new Map<number, string[]>();
    for (const id of order) { const d = depth.get(id) ?? 0; layers.set(d, [...(layers.get(d) ?? []), id]); }
    const maxLayer = Math.max(...layers.keys(), 0);
    const maxPer = Math.max(...[...layers.values()].map((l) => l.length), 1);
    const W = 300;
    const H = Math.max(80, (maxLayer + 1) * 64);
    const pos = new Map<string, { x: number; y: number }>();
    for (const [d, ids] of layers) ids.forEach((id, i) => pos.set(id, { x: ((i + 1) / (ids.length + 1)) * W, y: 28 + d * 64 }));
    return {
      nodes: order.map((id) => ({ id, ...pos.get(id)! })),
      edges: [...edgeMap.entries()].map(([k, n]) => { const [a, b] = k.split(">") as [string, string]; return { a: pos.get(a)!, b: pos.get(b)!, n, key: k }; }),
      w: W,
      h: H + (maxPer > 4 ? 0 : 0),
    };
  }, [detail.spans]);
  if (nodes.length < 2) return <p className="muted small">Single agent: no delegation in this trace.</p>;
  return (
    <svg className="deleg" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label={`Delegation graph: ${nodes.length} agents, ${edges.length} hand-offs`}>
      <defs><marker id="dg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,1 L9,5 L0,9z" fill="var(--brain-arrow)" /></marker></defs>
      {edges.map((e) => <line key={e.key} x1={e.a.x} y1={e.a.y + 14} x2={e.b.x} y2={e.b.y - 15} stroke="var(--brain-arrow)" strokeWidth={1.4} markerEnd="url(#dg)" />)}
      {nodes.map((n) => {
        const a: Agent | undefined = agents[n.id];
        const c = a ? departments[a.departmentId]?.color ?? "var(--muted)" : "var(--muted)";
        return (
          <a key={n.id} href={href(`/agents/${n.id}`)}>
            <circle cx={n.x} cy={n.y} r={14} fill="var(--surface)" stroke={c} strokeWidth={2.5} />
            <text x={n.x} y={n.y + 3.5} textAnchor="middle" fontSize="9.5" fontWeight="650" fill="var(--ink)">{a ? a.name.split(" ").map((p) => p[0]).join("") : "?"}</text>
            <text x={n.x} y={n.y + 27} textAnchor="middle" fontSize="9" fill="var(--muted)">{a ? a.name.split(" ")[0] : n.id}</text>
            <title>{a ? `${a.name}, ${a.title}` : n.id}</title>
          </a>
        );
      })}
    </svg>
  );
}

function TraceDetailView({ traceId }: { traceId: string }) {
  const route = useRoute();
  const detail = useApi<TraceDetail>(`trace:${traceId}`, () => api.trace(traceId), {
    refreshOn: ["span.started", "span.ended", "run.started", "run.completed", "task.updated"],
    refreshIf: (ev) => ev.traceId === traceId,
    throttleMs: 1500,
  });
  const agents = useLive((s) => s.agents);
  const spanId = route.query.get("span");
  const now = useNow();
  useEffect(() => {
    if (!spanId) return;
    document.querySelector(`[data-span="${CSS.escape(spanId)}"]`)?.scrollIntoView({ block: "center" });
  }, [spanId, detail.data?.spans.length]);

  const d = detail.data;
  const byAgent = useMemo<BarItem[]>(() => {
    if (!d) return [];
    const m = new Map<string, number>();
    for (const s of d.spans) if (s.agentId && s.costUsd) m.set(s.agentId, (m.get(s.agentId) ?? 0) + s.costUsd);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id, v]) => ({ key: id, label: agents[id]?.name ?? id, value: v }));
  }, [d, agents]);
  const byBlock = useMemo<BarItem[]>(() => {
    if (!d) return [];
    const byId = new Map(d.spans.map((s) => [s.id, { span: s, children: [], depth: 0 } as Node]));
    const m = new Map<string, number>();
    for (const s of d.spans) {
      if (!s.costUsd) continue;
      const b = inheritedBlock(s, byId);
      if (b) m.set(b, (m.get(b) ?? 0) + s.costUsd);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([b, v]) => ({ key: b, label: blockLabel(b), value: v, title: b }));
  }, [d]);

  if (detail.error && !d) return <><PageHead title="Trace" /><ErrorNote error={detail.error} onRetry={detail.reload} /></>;
  if (!d) return <><PageHead title="Trace" /><Skeleton rows={10} height={18} /></>;
  const s = d.summary;
  const span = spanId ? d.spans.find((x) => x.id === spanId) ?? null : null;
  const cards: [string, string, string?][] = [
    ["Cost", money(s.costUsd)],
    ["Duration", duration(traceDuration(s, now))],
    ["Spans", String(s.spanCount)],
    ["LLM calls", String(s.llmCalls)],
    ["Tokens", `${compact(s.inputTokens)} in / ${compact(s.outputTokens)} out`],
    ["Agents", String(s.agentIds.length)],
  ];
  return (
    <>
      <PageHead
        crumbs={<><a href={href("/traces")}>Traces</a><span>/</span><span className="mono">{s.traceId}</span></>}
        title={s.title}
        sub={<span className="row wrap"><SpanStatusBadge status={s.status} /> started <RelTime iso={s.startedAt} /> {s.rootTaskId ? <>· task <TaskLinkById id={s.rootTaskId} /></> : null}</span>}
      >
        <Button icon="refresh" size="sm" onClick={detail.reload}>Refresh</Button>
      </PageHead>
      <div className="kpis small-kpis">
        {cards.map(([l, v]) => <div key={l} className="kpi"><div className="kpi-label">{l}</div><div className="kpi-value num">{v}</div></div>)}
      </div>
      <div className={`trace-layout${span ? " with-panel" : ""} mt`}>
        <div className="stack">
          <Waterfall detail={d} selectedId={spanId} onSelect={(id) => setQuery("span", id)} />
          <div className="grid-3">
            <Panel title="Cost per agent"><HBars items={byAgent} format={money} empty="No model cost yet" /></Panel>
            <Panel title="Cost per brain block"><HBars items={byBlock} format={money} empty="No brain-block cost" /></Panel>
            <Panel title="Delegation"><DelegationGraph detail={d} /></Panel>
          </div>
        </div>
        {span ? <SpanPanel span={span} detail={d} onClose={() => setQuery("span", null)} /> : null}
      </div>
    </>
  );
}

export function TracesView({ traceId }: { traceId: string | null }) {
  return traceId ? <TraceDetailView traceId={traceId} /> : <TraceList />;
}
