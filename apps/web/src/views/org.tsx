// Org chart: Board → CEO → C-suite → managers → workers. Collapsible; hire / chat / pause / destroy.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { href, navigate } from "../router";
import { seed, useApi, useLive } from "../live";
import { Avatar, Badge, Button, CognitionBadge, ConfirmDialog, Field, Icon, IconButton, Modal, ModelTierBadge, StatusBadge, TierLabel, toast, useAction } from "../ui/kit";
import type { Agent, AgentTier, CognitionKind, CreateAgentInput, DestroyAgentResult, ModelTier } from "../types";
import { PageHead, liveAgents } from "./common";

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
          <div className="oc-title ellipsis" title={agent.title}>{agent.title}</div>
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
      <div className="oc-actions">
        <IconButton icon="chat" label={`Chat with ${agent.name}`} onClick={() => actions.chat(agent)} />
        <IconButton icon={paused ? "play" : "pause"} label={paused ? `Resume ${agent.name}` : `Pause ${agent.name}`} onClick={() => actions.togglePause(agent)} />
        <IconButton icon="trash" tone="danger" label={`Destroy ${agent.name}`} onClick={() => actions.askDestroy(agent)} />
      </div>
    </div>
  );
});

function Branch({ node, collapsed, toggle, actions }: { node: TreeNode; collapsed: Set<string>; toggle: (id: string) => void; actions: ReturnType<typeof useAgentActions> }) {
  const isCollapsed = collapsed.has(node.agent.id);
  const allLeaves = node.children.length > 0 && node.children.every((c) => c.children.length === 0);
  const count = (n: TreeNode): number => n.children.reduce((s, c) => s + 1 + count(c), 0);
  return (
    <li className="org-node">
      <OrgCard agent={node.agent} collapsed={isCollapsed} hasKids={node.children.length > 0} kidCount={count(node)} onToggle={() => toggle(node.agent.id)} actions={actions} />
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

export function OrgView() {
  const agents = useLive((s) => s.agents);
  const departments = useLive((s) => s.departments);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hiring, setHiring] = useState(false);
  const actions = useAgentActions();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, [Object.keys(agents).length > 0]);
  const list = useMemo(() => liveAgents(agents), [agents]);
  const tree = useMemo(() => buildTree(list), [list]);
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
        <Button size="sm" onClick={() => setCollapsed(new Set(list.filter((a) => a.tier === "manager" || (a.tier === "executive" && a.managerId)).filter((a) => list.some((x) => x.managerId === a.id)).map((a) => a.id)))}>
          Collapse teams
        </Button>
        <Button size="sm" onClick={() => setCollapsed(new Set())} disabled={!collapsed.size}>Expand all</Button>
        <Button variant="primary" icon="plus" onClick={() => setHiring(true)}>Hire agent</Button>
      </PageHead>
      <div className="legend row wrap small">
        {Object.values(departments).filter((d) => list.some((a) => a.departmentId === d.id)).map((d) => (
          <span key={d.id} className="legend-item"><i style={{ background: d.color }} />{d.name}</span>
        ))}
        <span className="muted">{managers.length} team leads</span>
      </div>
      <div className="org-scroll" ref={scroller}>
        <ul className="org-root">
          <li className="org-node board">
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
            <ul className="org-kids">
              {tree.map((n) => (
                <Branch key={n.agent.id} node={n} collapsed={collapsed} toggle={toggle} actions={actions} />
              ))}
            </ul>
          </li>
        </ul>
      </div>
      {actions.dialogs}
      {hiring ? <HireModal onClose={() => setHiring(false)} /> : null}
    </>
  );
}

export function HireModal({ onClose }: { onClose: () => void }) {
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
      <div className="form-grid">
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
