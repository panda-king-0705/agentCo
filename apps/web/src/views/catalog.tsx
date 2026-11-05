// Specialist catalog (agency-agents, docs/CATALOG.md): browse and search by division, read a specialist's
// compiled playbook and full text in a drawer, and hire one into a department under a manager.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { compact } from "../format";
import { href, navigate, setQuery, useRoute } from "../router";
import { refreshDepartments, seed, useApi, useLive } from "../live";
import { Markdown } from "../ui/markdown";
import { Badge, Button, Drawer, Empty, ErrorNote, Field, Icon, KV, Meter, Modal, SearchInput, Skeleton, Tabs, useAction } from "../ui/kit";
import type { Agent, CatalogAgentDetail, CatalogAgentSummary, CatalogDivision, CreateAgentInput } from "../types";
import { PageHead, liveAgents } from "./common";

/** Division colours come from divisions.json; anything else (named CSS colours) is passed through. */
const tint = (c: string | undefined) => c || "var(--muted)";

export function CatalogView() {
  const route = useRoute();
  const division = route.query.get("division") ?? "";
  const openId = route.query.get("id");
  const [q, setQ] = useState(route.query.get("q") ?? "");
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 180);
    return () => window.clearTimeout(t);
  }, [q]);
  const all = useApi("catalog:all", () => api.catalog(), { refreshOn: ["agent.created", "agent.terminated"], throttleMs: 4000 });
  const filtered = useApi(debounced || division ? `catalog:${division}:${debounced}` : null, () => api.catalog({ division: division || undefined, q: debounced || undefined }));
  const list = debounced || division ? filtered.data?.agents : all.data?.agents;
  const divisions = all.data?.divisions ?? [];
  const source = all.data?.source;
  const loading = !list && (all.loading || filtered.loading);
  const error = all.error ?? filtered.error;
  const [hiring, setHiring] = useState<string | null>(null);
  const setDivision = (d: string) => setQuery("division", d || null);
  const colorOf = useMemo(() => new Map(divisions.map((d) => [d.id, d.color])), [divisions]);

  return (
    <>
      <PageHead
        title="Catalog"
        sub={
          source ? (
            <span>
              {source.agents} specialists from{" "}
              <a href={source.repo} target="_blank" rel="noreferrer">agency-agents</a> · {source.license} · <span className="mono">{source.commit.slice(0, 7)}</span>
              {source.skipped ? ` · ${source.skipped} skipped` : ""}
            </span>
          ) : "Specialists you can hire"
        }
      >
        <SearchInput value={q} onChange={setQ} placeholder="Search skills, roles, tools" width={300} />
      </PageHead>
      <div className="cat-layout">
        <nav className="cat-divisions" aria-label="Divisions">
          <button type="button" className={`cat-div${division ? "" : " on"}`} aria-pressed={!division} onClick={() => setDivision("")}>
            <span className="cat-dot" style={{ background: "var(--ink-2)" }} />
            <span className="grow">All divisions</span>
            <span className="num muted">{source?.agents ?? ""}</span>
          </button>
          {divisions.map((d) => (
            <DivisionButton key={d.id} d={d} on={division === d.id} onClick={() => setDivision(division === d.id ? "" : d.id)} />
          ))}
        </nav>
        <section className="cat-main" aria-live="polite">
          {error && !list ? <ErrorNote error={error} onRetry={() => (all.error ? all.reload() : filtered.reload())} /> : null}
          {loading ? <Skeleton rows={8} height={60} /> : null}
          {list ? (
            <>
              <div className="cat-count small muted">
                {list.length} {list.length === 1 ? "specialist" : "specialists"}
                {division ? ` in ${divisions.find((d) => d.id === division)?.label ?? division}` : ""}
                {debounced ? ` matching “${debounced}”` : ""}
              </div>
              {list.length ? (
                <div className="cat-grid" data-testid="catalog-grid">
                  {list.map((a) => (
                    <CatalogCard key={a.id} a={a} color={colorOf.get(a.division)} onOpen={() => setQuery("id", a.id)} onHire={() => setHiring(a.id)} />
                  ))}
                </div>
              ) : (
                <Empty title="No specialists match" icon="search">Try a broader word, or clear the division filter.</Empty>
              )}
            </>
          ) : null}
        </section>
      </div>
      {openId ? <CatalogDrawer id={openId} onClose={() => setQuery("id", null)} onHire={() => setHiring(openId)} /> : null}
      {hiring ? <CatalogHireModal catalogId={hiring} onClose={() => setHiring(null)} /> : null}
    </>
  );
}

function DivisionButton({ d, on, onClick }: { d: CatalogDivision; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`cat-div${on ? " on" : ""}`} aria-pressed={on} onClick={onClick} title={d.optional ? "Hiring here creates an optional department" : undefined}>
      <span className="cat-dot" style={{ background: tint(d.color) }} />
      <span className="grow ellipsis">{d.label}</span>
      {d.optional ? <span className="cat-new" aria-label="optional department">new</span> : null}
      <span className="num muted">{d.count}</span>
    </button>
  );
}

function CatalogCard({ a, color, onOpen, onHire }: { a: CatalogAgentSummary; color: string | undefined; onOpen: () => void; onHire: () => void }) {
  return (
    <article className="cat-card" style={{ ["--dc" as string]: tint(color) }} data-catalog={a.id}>
      <button type="button" className="cat-card-open" onClick={onOpen} aria-label={`Open ${a.name}`}>
        <div className="cat-card-head">
          <span className="cat-emoji" aria-hidden="true">{a.emoji || "◆"}</span>
          <div className="grow">
            <div className="cat-name">{a.name}</div>
            <div className="cat-meta tiny">{a.divisionLabel}</div>
          </div>
        </div>
        {a.vibe ? <div className="cat-vibe">{a.vibe}</div> : null}
        <div className="cat-desc">{a.description}</div>
      </button>
      <footer className="cat-card-foot">
        <span className="cat-dept small" title="Department a hire lands in">
          <Icon name="org" size={12} /> {a.departmentName}
          {a.optionalDepartment ? <span className="cat-new">new</span> : null}
        </span>
        {a.hiredCount ? <Badge tone="good" title="Active agents staffed from this specialist">{a.hiredCount} on staff</Badge> : null}
        <span className="grow" />
        <Button size="sm" onClick={onHire}>Hire into…</Button>
      </footer>
    </article>
  );
}

/** The compiled specialist playbook with its token budget (what a worker carries in every prompt). */
export function PlaybookBlock({ playbook }: { playbook: CatalogAgentDetail["playbook"] }) {
  return (
    <div className="playbook" data-testid="playbook">
      <div className="row small playbook-meter">
        <span className="grow muted">Compiled for the economy tier{playbook.truncated ? " (trimmed by section priority)" : ""}</span>
        <span className="num">{compact(playbook.tokens)} / {compact(playbook.maxTokens)} tokens</span>
      </div>
      <Meter value={playbook.tokens} max={playbook.maxTokens} warnAt={0.95} dangerAt={1.01} label="Playbook tokens used" small />
      <pre className="playbook-text">{playbook.text}</pre>
    </div>
  );
}

function CatalogDrawer({ id, onClose, onHire }: { id: string; onClose: () => void; onHire: () => void }) {
  const detail = useApi(`catalog-agent:${id}`, () => api.catalogAgent(id));
  const agents = useLive((s) => s.agents);
  const [tab, setTab] = useState<"playbook" | "full">("playbook");
  const d = detail.data;
  const lead = d?.placement.managerId ? agents[d.placement.managerId] : undefined;
  const staffed = useMemo(() => liveAgents(agents).filter((a) => a.catalogId === id), [agents, id]);
  return (
    <Drawer
      width={720}
      onClose={onClose}
      title={
        d ? (
          <div className="cat-drawer-title">
            <span className="cat-emoji lg" aria-hidden="true">{d.agent.emoji || "◆"}</span>
            <div>
              <h2>{d.agent.name}</h2>
              <div className="small muted">{d.summary.divisionLabel} · <span className="mono">{d.agent.id}</span></div>
            </div>
          </div>
        ) : "Specialist"
      }
      actions={d ? <Button variant="primary" icon="plus" onClick={onHire}>Hire into…</Button> : null}
    >
      {detail.error && !d ? <ErrorNote error={detail.error} onRetry={detail.reload} /> : null}
      {!d && !detail.error ? <Skeleton rows={10} /> : null}
      {d ? (
        <>
          {d.agent.vibe ? <p className="quote cat-vibe-lg">{d.agent.vibe}</p> : null}
          <p>{d.agent.description}</p>
          <KV
            rows={[
              ["Lands in", <span key="d">{d.placement.departmentName}{d.placement.createsDepartment ? <> <Badge tone="warn">created on hire</Badge></> : null}</span>],
              ["Reports to", lead ? <a key="l" href={href(`/agents/${lead.id}`)}>{lead.name}, {lead.title}</a> : "Department lead"],
              ["Runs as", "Worker · reflex · economy model"],
              ["On staff", staffed.length ? <span key="s" className="row wrap">{staffed.map((a) => <a key={a.id} href={href(`/agents/${a.id}`)}>{a.name}</a>)}</span> : "Nobody yet"],
              ["Source", `${compact(d.agent.wordCount)} words`],
            ]}
          />
          <Tabs
            label="Specialist text"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "playbook", label: "Playbook" },
              { id: "full", label: "Full text" },
            ]}
          />
          {tab === "playbook" ? (
            <>
              <PlaybookBlock playbook={d.playbook} />
              <p className="small muted">
                Leaders staffed from this specialist carry only a short domain-expertise line: <em>{d.expertise}</em>
              </p>
            </>
          ) : (
            <div className="cat-full"><Markdown text={d.body} /></div>
          )}
        </>
      ) : null}
    </Drawer>
  );
}

/** Department + manager pickers and the create call, shared by the Catalog view and the org chart's Hire modal. */
export function CatalogHireFields({ catalogId, onHired, footer }: { catalogId: string; onHired: (a: Agent) => void; footer: (submit: () => void, busy: boolean, ready: boolean) => React.ReactNode }) {
  const detail = useApi(`catalog-agent:${catalogId}`, () => api.catalogAgent(catalogId));
  const departments = useLive((s) => s.departments);
  const agents = useLive((s) => s.agents);
  const { busy, run } = useAction();
  const d = detail.data;
  const NEW = "__new__";
  const [departmentId, setDepartmentId] = useState("");
  const [managerId, setManagerId] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    if (!d) return;
    setDepartmentId(d.placement.departmentId ?? NEW);
    setManagerId(d.placement.managerId ?? "");
  }, [d?.agent.id, d?.placement.departmentId, d?.placement.managerId]);
  const leaders = liveAgents(agents).filter((a) => a.tier !== "worker");
  const submit = async () => {
    if (!d) return;
    const input: CreateAgentInput = {
      catalogId,
      ...(departmentId && departmentId !== NEW ? { departmentId } : {}),
      ...(managerId ? { managerId } : {}),
      ...(name.trim() ? { name: name.trim() } : {}),
    };
    const a = await run(() => api.createAgent(input), `${name.trim() || d.agent.name} hired`);
    if (a) {
      seed.agent(a);
      if (!departments[a.departmentId]) refreshDepartments();
      onHired(a);
    }
  };
  if (detail.error && !d) return <ErrorNote error={detail.error} onRetry={detail.reload} />;
  if (!d) return <Skeleton rows={4} />;
  return (
    <>
      <div className="cat-hire-head">
        <span className="cat-emoji lg" aria-hidden="true">{d.agent.emoji || "◆"}</span>
        <div className="grow">
          <div className="cat-name">{d.agent.name}</div>
          <div className="small muted">{d.agent.description}</div>
        </div>
      </div>
      <div className="form-grid">
        <Field label="Department" hint={departmentId === NEW ? `${d.placement.departmentName} does not exist yet; hiring creates it.` : "From the division mapping; any department works."}>
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department">
            {d.placement.createsDepartment ? <option value={NEW}>{d.placement.departmentName} (new)</option> : null}
            {Object.values(departments).map((dep) => <option key={dep.id} value={dep.id}>{dep.name}</option>)}
          </select>
        </Field>
        <Field label="Manager" hint="Defaults to the department's lead.">
          <select value={managerId} onChange={(e) => setManagerId(e.target.value)} aria-label="Manager">
            <option value="">Department lead</option>
            {leaders.map((a) => <option key={a.id} value={a.id}>{a.name}, {a.title}</option>)}
          </select>
        </Field>
        <Field label="Name" hint="Optional; one is picked for you."><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Auto" /></Field>
        <Field label="Runs as" hint={`Its ${d.playbook.tokens}-token playbook rides in every prompt.`}><input type="text" value="Worker · reflex · economy model" readOnly /></Field>
      </div>
      {footer(submit, busy, true)}
    </>
  );
}

function CatalogHireModal({ catalogId, onClose }: { catalogId: string; onClose: () => void }) {
  const [hired, setHired] = useState<Agent | null>(null);
  if (hired) {
    return (
      <Modal title="Specialist hired" onClose={onClose} width={440} footer={<><Button onClick={onClose}>Done</Button><Button variant="primary" onClick={() => navigate(`/agents/${hired.id}`)}>Open {hired.name}</Button></>}>
        <p><strong>{hired.persona.emoji ? `${hired.persona.emoji} ` : ""}{hired.name}</strong> joined as {hired.title}.</p>
      </Modal>
    );
  }
  return (
    <Modal title="Hire into…" onClose={onClose} width={620}>
      <CatalogHireFields
        catalogId={catalogId}
        onHired={setHired}
        footer={(submit, busy) => (
          <div className="row cat-hire-foot">
            <span className="grow" />
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={busy}>{busy ? "Hiring…" : "Hire specialist"}</Button>
          </div>
        )}
      />
    </Modal>
  );
}

/** Org chart Hire modal tab: search the catalog, pick one, place and hire. */
export function CatalogPicker({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [division, setDivision] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 180);
    return () => window.clearTimeout(t);
  }, [q]);
  const list = useApi(`catalog:${division}:${debounced}`, () => api.catalog({ division: division || undefined, q: debounced || undefined }));
  const divisions = useApi("catalog:all", () => api.catalog()).data?.divisions ?? [];
  if (picked) {
    return (
      <CatalogHireFields
        catalogId={picked}
        onHired={() => onClose()}
        footer={(submit, busy) => (
          <div className="row cat-hire-foot">
            <Button variant="ghost" icon="chevronLeft" onClick={() => setPicked(null)}>Back to the catalog</Button>
            <span className="grow" />
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={busy}>{busy ? "Hiring…" : "Hire specialist"}</Button>
          </div>
        )}
      />
    );
  }
  return (
    <div className="stack tight">
      <div className="row">
        <label className="search grow">
          <Icon name="search" size={14} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search specialists" aria-label="Search specialists" data-autofocus />
        </label>
        <select value={division} onChange={(e) => setDivision(e.target.value)} aria-label="Division">
          <option value="">All divisions</option>
          {divisions.map((d) => <option key={d.id} value={d.id}>{d.label} ({d.count})</option>)}
        </select>
      </div>
      {list.error && !list.data ? <ErrorNote error={list.error} onRetry={list.reload} /> : null}
      {!list.data ? <Skeleton rows={6} /> : (
        <ul className="list cat-pick-list" aria-label="Specialists">
          {list.data.agents.slice(0, 60).map((a) => (
            <li key={a.id}>
              <button type="button" className="list-row cat-pick" onClick={() => setPicked(a.id)} data-catalog={a.id}>
                <span className="cat-emoji" aria-hidden="true">{a.emoji || "◆"}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="cat-name">{a.name}</span> <span className="tiny muted">{a.divisionLabel} → {a.departmentName}</span>
                  <span className="cat-pick-desc small muted">{a.description}</span>
                </span>
                {a.hiredCount ? <Badge tone="good">{a.hiredCount}</Badge> : null}
                <Icon name="chevronRight" size={14} />
              </button>
            </li>
          ))}
          {list.data.agents.length === 0 ? <li><div className="list-row static muted">No specialists match.</div></li> : null}
        </ul>
      )}
      <div className="row cat-hire-foot">
        <a className="small" href={href("/catalog")} onClick={onClose}>Browse the full catalog</a>
        <span className="grow" />
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

/** Agent detail: the specialist a catalog agent is staffed from (playbook for workers, expertise for leaders). */
export function SpecialistPanel({ agent }: { agent: Agent }) {
  const detail = useApi(agent.catalogId ? `catalog-agent:${agent.catalogId}` : null, () => api.catalogAgent(agent.catalogId!));
  if (!agent.catalogId) return null;
  const d = detail.data;
  const worker = agent.tier === "worker";
  return (
    <section className="panel" data-testid="specialist-panel">
      <header className="panel-head">
        <h2>{worker ? "Specialist playbook" : "Domain expertise"}</h2>
        <div className="panel-actions">
          <a className="small" href={href("/catalog", { id: agent.catalogId })}>{d ? `${d.agent.emoji} ${d.agent.name}` : agent.catalogId} in the catalog</a>
        </div>
      </header>
      <div className="panel-body">
        {detail.error && !d ? <ErrorNote error={detail.error} onRetry={detail.reload} /> : null}
        {!d && !detail.error ? <Skeleton rows={5} /> : null}
        {d ? (
          worker ? (
            <>
              <p className="small muted" style={{ marginTop: 0 }}>Rides in this worker's system prompt on every step (agency-agents <span className="mono">{d.agent.id}</span>).</p>
              <PlaybookBlock playbook={d.playbook} />
            </>
          ) : (
            <p className="small" style={{ margin: 0 }}>{d.expertise}</p>
          )
        ) : null}
      </div>
    </section>
  );
}
