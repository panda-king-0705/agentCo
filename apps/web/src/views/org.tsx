// Org chart: Board → CEO → C-suite → managers → workers. Collapsible; hire / chat / pause / destroy.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { href, navigate } from "../router";
import { seed, useApi, useLive } from "../live";
import { Avatar, Badge, Button, CognitionBadge, ConfirmDialog, Field, Icon, IconButton, Modal, ModelTierBadge, StatusBadge, Tabs, TierLabel, toast, useAction } from "../ui/kit";
import type { Agent, AgentTier, CognitionKind, CreateAgentInput, DestroyAgentResult, ModelTier } from "../types";
import { PageHead, liveAgents } from "./common";
import { CatalogPicker } from "./catalog";
import { Markdown } from "../ui/markdown";

export function useAgentActions() {
  const { busy, run } = useAction();
  const [destroying, setDestroying] = useState<Agent | null>(null);
  const [result, setResult] = useState<{ agent: Agent; res: DestroyAgentResult } | null>(null);
  const chat = async (a: Agent) => {
    const c = await run(() => api.openConversation(a.id));
    if (c) navigate(`/chat/${c.id}`);
  };
  const togglePause = async (a: Agent) => {
    const paused = a.status === "paused";
    const next = await run(() => (paused ? api.resumeAgent(a.id) : api.pauseAgent(a.id)), paused ? `${a.name} resumed` : `${a.name} paused`);
    if (next) seed.agent(next);
  };
  const confirmDestroy = async () => {
    if (!destroying) return;
    const res = await run(() => api.destroyAgent(destroying.id));
    if (res) {
      setResult({ agent: destroying, res });
      seed.agent({ ...destroying, status: "terminated", activity: null, brainBlock: null });
    }
    setDestroying(null);
  };
  const dialogs = (
    <>
      {destroying ? (
        <ConfirmDialog title={`Destroy ${destroying.name}?`} confirmLabel="Destroy agent" danger busy={busy} onConfirm={confirmDestroy} onClose={() => setDestroying(null)}>
          <p>
            <strong>{destroying.name}</strong> ({destroying.title}) will be terminated and kept in the audit trail.
          </p>
          <ul className="plain-list">
            <li>Any run in progress is aborted.</li>
            <li>Open tasks and direct reports move to their manager.</li>
            <li>Their traces, memory and spend stay readable.</li>
          </ul>
          <p className="muted small">This cannot be undone. Hire a new agent if you need the role back.</p>
        </ConfirmDialog>
      ) : null}
      {result ? (
        <Modal title="Agent destroyed" onClose={() => setResult(null)} width={440} footer={<Button variant="primary" onClick={() => setResult(null)}>Done</Button>}>
          <p>
            <strong>{result.agent.name}</strong> was terminated.
          </p>
          <dl className="kv" data-testid="destroy-result">
            <div className="kv-row"><dt>Runs cancelled</dt><dd className="num">{result.res.cancelledRuns}</dd></div>
            <div className="kv-row"><dt>Tasks moved to manager</dt><dd className="num">{result.res.reassignedTasks}</dd></div>
            <div className="kv-row"><dt>Reports re-parented</dt><dd className="num">{result.res.reassignedReports}</dd></div>
          </dl>
        </Modal>
      ) : null}
    </>
  );
  return { busy, chat, togglePause, askDestroy: setDestroying, dialogs };
}

interface TreeNode {
  agent: Agent;
  children: TreeNode[];
}
function buildTree(agents: Agent[]): TreeNode[] {
  const ids = new Set(agents.map((a) => a.id));
  const kids = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const a of agents) {
    if (a.managerId && ids.has(a.managerId)) {
      const l = kids.get(a.managerId) ?? [];
      l.push(a);
      kids.set(a.managerId, l);
    } else roots.push(a);
  }
  const order = { executive: 0, manager: 1, worker: 2 } as const;
  const make = (a: Agent): TreeNode => ({
    agent: a,
    children: (kids.get(a.id) ?? []).sort((x, y) => order[x.tier] - order[y.tier] || x.name.localeCompare(y.name)).map(make),
  });
  return roots.sort((x, y) => order[x.tier] - order[y.tier]).map(make);
}

const OrgCard = memo(function OrgCard({ agent, collapsed, hasKids, kidCount, onToggle, actions }: {
  agent: Agent;
  collapsed: boolean;
  hasKids: boolean;
  kidCount: number;
  onToggle: () => void;
  actions: ReturnType<typeof useAgentActions>;
}) {
  const color = useLive((s) => s.departments[agent.departmentId]?.color) ?? "var(--muted)";
  const paused = agent.status === "paused";
  return (
    <div className={`org-card st-${agent.status} tier-${agent.tier}`} style={{ ["--dc" as string]: color }} data-agent={agent.id}>
      <div className="oc-main">
        <Avatar agent={agent} size={30} />
        <div className="grow">
          <a className="oc-name ellipsis" href={href(`/agents/${agent.id}`)}>{agent.name}</a>
          {/* Titles wrap instead of being cut off (the CEO's especially). */}
          <div className="oc-title">{agent.title}</div>
        </div>
        {hasKids ? (
          <button type="button" className="oc-toggle" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Collapse"} ${agent.name}'s reports`} onClick={onToggle}>
            <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={13} />
            <span className="num">{kidCount}</span>
          </button>
        ) : null}
      </div>
      <div className="oc-badges">
        <TierLabel tier={agent.tier} />
        <CognitionBadge kind={agent.cognition} />
        <ModelTierBadge tier={agent.modelTier} override={agent.modelOverride} />
      </div>
      <div className="oc-status">
        <StatusBadge status={agent.status} />
      </div>
      <div className="oc-act" title={agent.activity ?? undefined}>{agent.activity ?? <span className="muted">Nothing in progress</span>}</div>
      <CardActions agent={agent} actions={actions} paused={paused} />
    </div>
  );
});

function CardActions({ agent, actions, paused }: { agent: Agent; actions: ReturnType<typeof useAgentActions>; paused: boolean }) {
  return (
    <div className="oc-actions">
      <IconButton icon="chat" label={`Chat with ${agent.name}`} onClick={() => actions.chat(agent)} />
      <IconButton icon={paused ? "play" : "pause"} label={paused ? `Resume ${agent.name}` : `Pause ${agent.name}`} onClick={() => actions.togglePause(agent)} />
      <IconButton icon="trash" tone="danger" label={`Destroy ${agent.name}`} onClick={() => actions.askDestroy(agent)} />
    </div>
  );
}

/** Overview card: name, full title (wrapped, never cut), status; actions appear on hover / focus (always on touch). */
const CompactCard = memo(function CompactCard({ agent, actions, lead }: { agent: Agent; actions: ReturnType<typeof useAgentActions>; lead?: boolean }) {
  const color = useLive((s) => s.departments[agent.departmentId]?.color) ?? "var(--muted)";
  return (
    <div className={`org-card compact st-${agent.status} tier-${agent.tier}${lead ? " lead" : ""}`} style={{ ["--dc" as string]: color }} data-agent={agent.id} title={agent.activity ?? undefined}>
      <div className="occ-head">
        <StatusBadge status={agent.status} compact />
        <a className="oc-name" href={href(`/agents/${agent.id}`)}>{agent.name}</a>
      </div>
      <div className="oc-title">{agent.title}</div>
      <CardActions agent={agent} actions={actions} paused={agent.status === "paused"} />
    </div>
  );
});

function Branch({ node, collapsed, toggle, actions }: { node: TreeNode; collapsed: Set<string>; toggle: (id: string) => void; actions: ReturnType<typeof useAgentActions> }) {
  const isCollapsed = collapsed.has(node.agent.id);
  const allLeaves = node.children.length > 0 && node.children.every((c) => c.children.length === 0);
  return (
    <li className="org-node">
      <OrgCard agent={node.agent} collapsed={isCollapsed} hasKids={node.children.length > 0} kidCount={countDescendants(node)} onToggle={() => toggle(node.agent.id)} actions={actions} />
      {node.children.length && !isCollapsed ? (
        <ul className={`org-kids${allLeaves ? " stacked" : ""}`}>
          {node.children.map((c) => (
            <Branch key={c.agent.id} node={c} collapsed={collapsed} toggle={toggle} actions={actions} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const countDescendants = (n: TreeNode): number => n.children.reduce((s, c) => s + 1 + countDescendants(c), 0);

function BoardCard() {
  return (
    <div className="org-card board-card">
      <div className="oc-main">
        <Avatar id="human" size={30} />
        <div className="grow">
          <div className="oc-name">Board</div>
          <div className="oc-title">Human founder</div>
        </div>
      </div>
      <div className="oc-act muted">Approves hires, budgets and answers questions</div>
    </div>
  );
}

// ───────────── overview: the whole company fitted to the width ─────────────

/** Above this headcount the org chart opens in the overview (departments as columns). */
const OVERVIEW_AT = 20;
type Mode = "overview" | "tree";
const MODE_KEY = "agentco.org.mode";
function readMode(): Mode | null {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "overview" || v === "tree" ? v : null;
  } catch {
    return null;
  }
}
function writeMode(m: Mode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* per-viewer convenience only */
  }
}

function SubTree({ nodes, actions }: { nodes: TreeNode[]; actions: ReturnType<typeof useAgentActions> }) {
  return (
    <ul className="oo-list">
      {nodes.map((n) => (
        <li key={n.agent.id}>
          <CompactCard agent={n.agent} actions={actions} />
          {n.children.length ? <SubTree nodes={n.children} actions={actions} /> : null}
        </li>
      ))}
    </ul>
  );
}

function OrgOverview({ tree, actions }: { tree: TreeNode[]; actions: ReturnType<typeof useAgentActions> }) {
  const departments = useLive((s) => s.departments);
  // The main root is the CEO (the biggest tree); any other root reports to the Board directly.
  const [main, ...others] = [...tree].sort((a, b) => countDescendants(b) - countDescendants(a));
  if (!main) return <div className="empty">No agents yet.</div>;
  const isColumn = (n: TreeNode) => n.children.length > 0 || n.agent.tier === "executive";
  const staff = main.children.filter((n) => !isColumn(n));
  // Columns follow the department order of the legend (ties: bigger organisation first).
  const deptOrder = new Map(Object.keys(departments).map((id, i) => [id, i]));
  const columns = [...main.children.filter(isColumn), ...others].sort(
    (a, b) => (deptOrder.get(a.agent.departmentId) ?? 999) - (deptOrder.get(b.agent.departmentId) ?? 999) || countDescendants(b) - countDescendants(a),
  );
  return (
    <div className="org-overview" data-testid="org-overview">
      <div className="oo-top">
        <div className="oo-board"><BoardCard /></div>
        <Icon name="chevronRight" size={16} className="oo-arrow" />
        <div className="oo-ceo">
          <OrgCard agent={main.agent} collapsed={false} hasKids={false} kidCount={0} onToggle={() => undefined} actions={actions} />
        </div>
        {staff.length ? (
          <div className="oo-staff" aria-label={`Reporting to ${main.agent.name} directly`}>
            <div className="oo-staff-label muted tiny">Office of the {main.agent.title.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 4) || "CEO"}</div>
            <div className="oo-staff-cards">
              {staff.map((n) => <CompactCard key={n.agent.id} agent={n.agent} actions={actions} />)}
            </div>
          </div>
        ) : null}
      </div>
      <div className="oo-cols" style={{ ["--cols" as string]: String(Math.max(1, columns.length)) }}>
        {columns.map((n) => {
          const dept = departments[n.agent.departmentId];
          return (
            <section key={n.agent.id} className="oo-col" style={{ ["--dc" as string]: dept?.color ?? "var(--muted)" }} aria-label={`${dept?.name ?? "Team"}: ${n.agent.name}'s organisation, ${countDescendants(n) + 1} agents`}>
              <header className="oo-col-head">
                <span className="oo-col-name">{dept?.name ?? "Team"}</span>
                <span className="num muted">{countDescendants(n) + 1}</span>
              </header>
              <CompactCard agent={n.agent} actions={actions} lead />
              {n.children.length ? <SubTree nodes={n.children} actions={actions} /> : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ───────────── tree: the detailed hierarchy, zoomable, with a visible scroll affordance ─────────────

const ZOOMS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3];

function OrgTree({ tree, collapsed, toggle, actions, zoom, setZoom, fit, setFit }: {
  tree: TreeNode[];
  collapsed: Set<string>;
  toggle: (id: string) => void;
  actions: ReturnType<typeof useAgentActions>;
  zoom: number | null;
  setZoom: (z: number | null) => void;
  fit: number;
  setFit: (z: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false, hidden: 0 });
  const z = zoom ?? fit;
  const zRef = useRef(z);
  zRef.current = z;

  const measure = useCallback(() => {
    const el = scroller.current;
    const ul = root.current;
    if (!el || !ul) return;
    const box = el.getBoundingClientRect();
    let hidden = 0;
    for (const card of ul.querySelectorAll<HTMLElement>(".org-card[data-agent]")) {
      const r = card.getBoundingClientRect();
      if (r.right > box.right + 2 || r.left < box.left - 2) hidden++;
    }
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((p) => (p.left === left && p.right === right && p.hidden === hidden ? p : { left, right, hidden }));
  }, []);

  // Fit: the zoom at which the whole chart is as wide as the viewport (bounded; beyond it, scroll).
  useLayoutEffect(() => {
    const el = scroller.current;
    const ul = root.current;
    if (!el || !ul) return;
    const compute = () => {
      // The Board's subtree is a centred flex item: its on-screen width / zoom = the chart's natural width.
      const content = ul.firstElementChild as HTMLElement | null;
      if (!content) return;
      const natural = content.getBoundingClientRect().width / (zRef.current || 1) + 24;
      const f = Math.max(ZOOMS[0]!, Math.min(1, (el.clientWidth - 8) / Math.max(1, natural)));
      setFit(Math.floor(f * 100) / 100);
      requestAnimationFrame(measure);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tree, collapsed, measure, setFit]);

  useEffect(() => {
    // Centre on the CEO when the chart is wider than the viewport.
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
    measure();
  }, [z, measure]);

  const scrollBy = (dir: -1 | 1) => scroller.current?.scrollBy({ left: dir * Math.round((scroller.current?.clientWidth ?? 600) * 0.7), behavior: "smooth" });
  return (
    <div className={`org-scroll-wrap${edges.left ? " can-left" : ""}${edges.right ? " can-right" : ""}`}>
      <div className="org-scroll" ref={scroller} onScroll={measure} tabIndex={0} aria-label="Org chart (scrolls sideways when wider than the screen)">
        <ul className="org-root" ref={root} style={{ zoom: z }}>
          <li className="org-node board">
            <BoardCard />
            <ul className="org-kids">
              {tree.map((n) => (
                <Branch key={n.agent.id} node={n} collapsed={collapsed} toggle={toggle} actions={actions} />
              ))}
            </ul>
          </li>
        </ul>
      </div>
      {edges.left ? <button type="button" className="org-edge left" aria-label="Scroll the org chart left" onClick={() => scrollBy(-1)}><Icon name="chevronLeft" size={18} /></button> : null}
      {edges.right ? <button type="button" className="org-edge right" aria-label="Scroll the org chart right" onClick={() => scrollBy(1)}><Icon name="chevronRight" size={18} /></button> : null}
      {edges.hidden > 0 ? (
        <div className="org-offscreen small" role="status">
          {edges.hidden} agent{edges.hidden === 1 ? "" : "s"} off-screen — scroll sideways or{" "}
          <button type="button" className="linklike" onClick={() => setZoom(null)}>fit to width</button>
        </div>
      ) : null}
    </div>
  );
}

function ZoomControls({ zoom, fit, setZoom }: { zoom: number | null; fit: number; setZoom: (z: number | null) => void }) {
  const z = zoom ?? fit;
  const step = (dir: -1 | 1) => {
    const next = dir > 0 ? ZOOMS.find((v) => v > z + 0.001) : [...ZOOMS].reverse().find((v) => v < z - 0.001);
    if (next !== undefined) setZoom(next);
  };
  return (
    <div className="org-zoom" role="group" aria-label="Zoom the org chart">
      <IconButton icon="minus" label="Zoom out" onClick={() => step(-1)} disabled={z <= ZOOMS[0]! + 0.001} />
      <span className="num small zoom-val" aria-live="polite">{Math.round(z * 100)}%</span>
      <IconButton icon="plus" label="Zoom in" onClick={() => step(1)} disabled={z >= ZOOMS.at(-1)! - 0.001} />
      <Button size="sm" icon="fit" onClick={() => setZoom(null)} aria-pressed={zoom === null}>Fit</Button>
    </div>
  );
}

/** The company handbook every new hire gets from its manager (generated live on the server). */
function HandbookModal({ onClose }: { onClose: () => void }) {
  const hb = useApi("handbook", () => api.handbook());
  return (
    <Modal title="Company handbook" onClose={onClose} width={720}>
      <p className="muted small">Every new hire finds this in its inbox from its manager, and any agent can re-read it with the company_handbook tool. It is generated from live data: the org, open objectives and key company knowledge.</p>
      {hb.data ? <Markdown text={hb.data.text} /> : <p className="muted small">Loading…</p>}
    </Modal>
  );
}

export function OrgView() {
  const agents = useLive((s) => s.agents);
  const departments = useLive((s) => s.departments);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hiring, setHiring] = useState(false);
  const [handbook, setHandbook] = useState(false);
  const [modeChoice, setModeChoice] = useState<Mode | null>(readMode);
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  const actions = useAgentActions();
  const list = useMemo(() => liveAgents(agents), [agents]);
  const tree = useMemo(() => buildTree(list), [list]);
  const mode: Mode = modeChoice ?? (list.length > OVERVIEW_AT ? "overview" : "tree");
  const chooseMode = (m: Mode) => {
    setModeChoice(m);
    writeMode(m);
  };
  const toggle = (id: string) =>
    setCollapsed((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const managers = list.filter((a) => list.some((x) => x.managerId === a.id));
  return (
    <>
      <PageHead title="Org chart" sub={`${list.length} agents across ${Object.keys(departments).length} departments`}>
        <div className="row org-mode" role="group" aria-label="Org chart layout">
          <button type="button" className="chip" aria-pressed={mode === "overview"} onClick={() => chooseMode("overview")}>Overview</button>
          <button type="button" className="chip" aria-pressed={mode === "tree"} onClick={() => chooseMode("tree")}>Tree</button>
        </div>
        {mode === "tree" ? (
          <>
            <ZoomControls zoom={zoom} fit={fit} setZoom={setZoom} />
            <Button size="sm" onClick={() => setCollapsed(new Set(list.filter((a) => a.tier === "manager" || (a.tier === "executive" && a.managerId)).filter((a) => list.some((x) => x.managerId === a.id)).map((a) => a.id)))}>
              Collapse teams
            </Button>
            <Button size="sm" onClick={() => setCollapsed(new Set())} disabled={!collapsed.size}>Expand all</Button>
          </>
        ) : null}
        <Button onClick={() => setHandbook(true)} title="What every new hire receives on day one">Handbook</Button>
        <Button variant="primary" icon="plus" onClick={() => setHiring(true)}>Hire agent</Button>
      </PageHead>
      <div className="legend row wrap small">
        {Object.values(departments).filter((d) => list.some((a) => a.departmentId === d.id)).map((d) => (
          <span key={d.id} className="legend-item"><i style={{ background: d.color }} />{d.name}</span>
        ))}
        <span className="muted">{managers.length} team leads</span>
      </div>
      {mode === "overview" ? <OrgOverview tree={tree} actions={actions} /> : <OrgTree tree={tree} collapsed={collapsed} toggle={toggle} actions={actions} zoom={zoom} setZoom={setZoom} fit={fit} setFit={setFit} />}
      {actions.dialogs}
      {hiring ? <HireModal onClose={() => setHiring(false)} /> : null}
      {handbook ? <HandbookModal onClose={() => setHandbook(false)} /> : null}
    </>
  );
}

/** Hire: a catalog specialist (default) or a role template / custom role. */
export function HireModal({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState<"catalog" | "role">("catalog");
  if (source === "role") return <RoleHireModal onClose={onClose} tabs={<HireTabs value={source} onChange={setSource} />} />;
  return (
    <Modal title="Hire agent" onClose={onClose} width={680}>
      <HireTabs value={source} onChange={setSource} />
      <div className="tab-body">
        <CatalogPicker onClose={onClose} />
      </div>
    </Modal>
  );
}

function HireTabs({ value, onChange }: { value: "catalog" | "role"; onChange: (v: "catalog" | "role") => void }) {
  return (
    <Tabs
      label="Hire from"
      value={value}
      onChange={onChange}
      tabs={[
        { id: "catalog", label: "From catalog" },
        { id: "role", label: "Role template / custom" },
      ]}
    />
  );
}

function RoleHireModal({ onClose, tabs }: { onClose: () => void; tabs: React.ReactNode }) {
  const roles = useApi("roles", () => api.roles());
  const models = useApi("models", () => api.models());
  const departments = useLive((s) => s.departments);
  const agents = useLive((s) => s.agents);
  const { busy, run } = useAction();
  const [roleId, setRoleId] = useState("");
  const [f, setF] = useState({
    name: "",
    title: "",
    departmentId: "",
    managerId: "",
    tier: "worker" as AgentTier,
    cognition: "reflex" as CognitionKind,
    modelTier: "economy" as ModelTier,
    modelOverride: "",
    budget: "5",
    style: "",
    mandate: "",
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const live = liveAgents(agents);
  const pickRole = (id: string) => {
    setRoleId(id);
    const r = roles.data?.find((x) => x.id === id);
    if (!r) return;
    const dept = Object.values(departments).find((d) => d.slug === r.departmentSlug);
    const mgr = r.reportsToRoleId ? live.find((a) => a.roleId === r.reportsToRoleId) : undefined;
    setF((p) => ({
      ...p,
      title: r.title,
      name: r.defaultNames.find((n) => !live.some((a) => a.name === n)) ?? r.defaultNames[0] ?? p.name,
      departmentId: dept?.id ?? p.departmentId,
      managerId: mgr?.id ?? p.managerId,
      tier: r.tier,
      cognition: r.cognition,
      modelTier: r.modelTier,
      mandate: r.mandate,
    }));
  };
  const valid = f.name.trim() && f.title.trim() && f.departmentId;
  const submit = async () => {
    const input: CreateAgentInput = {
      roleId: roleId || undefined,
      name: f.name.trim(),
      title: f.title.trim(),
      departmentId: f.departmentId,
      managerId: f.managerId || null,
      tier: f.tier,
      cognition: f.cognition,
      modelTier: f.modelTier,
      modelOverride: f.modelOverride || null,
      mandate: f.mandate.trim() || undefined,
      monthlyBudgetUsd: Number(f.budget) || undefined,
      persona: f.style.trim() ? { style: f.style.trim() } : undefined,
    };
    const a = await run(() => api.createAgent(input), `${f.name.trim()} hired`);
    if (a) {
      seed.agent(a);
      onClose();
    }
  };
  return (
    <Modal
      title="Hire agent"
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!valid || busy}>{busy ? "Hiring…" : "Hire agent"}</Button>
        </>
      }
    >
      {tabs}
      <div className="form-grid tab-body">
        <Field label="Role template" hint="Pre-fills the fields below; every one can still be changed." wide>
          <select value={roleId} onChange={(e) => pickRole(e.target.value)} disabled={roles.loading}>
            <option value="">Custom role</option>
            {roles.data?.map((r) => (
              <option key={r.id} value={r.id}>{r.title} ({r.departmentSlug})</option>
            ))}
          </select>
        </Field>
        <Field label="Name"><input type="text" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Jordan Lee" /></Field>
        <Field label="Title"><input type="text" value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Support Engineer" /></Field>
        <Field label="Department">
          <select value={f.departmentId} onChange={(e) => set("departmentId", e.target.value)}>
            <option value="">Choose…</option>
            {Object.values(departments).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Manager">
          <select value={f.managerId} onChange={(e) => set("managerId", e.target.value)}>
            <option value="">None (reports to the Board)</option>
            {live.filter((a) => a.tier !== "worker").map((a) => <option key={a.id} value={a.id}>{a.name}, {a.title}</option>)}
          </select>
        </Field>
        <Field label="Tier">
          <select value={f.tier} onChange={(e) => set("tier", e.target.value as AgentTier)}>
            <option value="executive">Executive</option>
            <option value="manager">Manager</option>
            <option value="worker">Worker</option>
          </select>
        </Field>
        <Field label="Cognition" hint="Brain runs the full cognitive cycle; reflex is a cheap tool loop.">
          <select value={f.cognition} onChange={(e) => set("cognition", e.target.value as CognitionKind)}>
            <option value="brain">Brain</option>
            <option value="reflex">Reflex</option>
          </select>
        </Field>
        <Field label="Model tier">
          <select value={f.modelTier} onChange={(e) => set("modelTier", e.target.value as ModelTier)}>
            <option value="frontier">Frontier</option>
            <option value="standard">Standard</option>
            <option value="economy">Economy</option>
          </select>
        </Field>
        <Field label="Model override" hint="Optional; pins one model profile.">
          <select value={f.modelOverride} onChange={(e) => set("modelOverride", e.target.value)}>
            <option value="">Use the tier default</option>
            {models.data?.profiles.map((p) => <option key={p.id} value={p.id}>{p.id} ({p.tier}, {p.provider})</option>)}
          </select>
        </Field>
        <Field label="Monthly budget (USD)"><input type="number" min="0" step="0.5" value={f.budget} onChange={(e) => set("budget", e.target.value)} /></Field>
        <Field label="Persona style" hint="How they write and decide, one line."><input type="text" value={f.style} onChange={(e) => set("style", e.target.value)} placeholder="Terse, evidence first" /></Field>
        <Field label="Mandate" wide><textarea rows={2} value={f.mandate} onChange={(e) => set("mandate", e.target.value)} placeholder="What this agent is accountable for" /></Field>
      </div>
      {live.length >= 1 && f.tier === "worker" && f.cognition === "brain" ? <p className="muted small" style={{ marginTop: 10 }}><Badge tone="warn">Note</Badge> Brain cognition on a worker costs more per run.</p> : null}
    </Modal>
  );
}
