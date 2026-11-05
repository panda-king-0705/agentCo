// Memory: global knowledge search (kind filter) and the shared blackboard (list + edit).
import { useEffect, useState } from "react";
import { api } from "../api";
import { useApi } from "../live";
import { AgentLink, Button, Empty, ErrorNote, Field, Panel, RelTime, SearchInput, Skeleton, useAction } from "../ui/kit";
import type { BlackboardEntry, MemoryKind } from "../types";
import { PageHead } from "./common";
import { MemoryList } from "./agent";

const KINDS: (MemoryKind | "")[] = ["", "episodic", "semantic", "procedural", "conceptual"];

function BlackboardRow({ e, onSaved }: { e: BlackboardEntry; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(e.value);
  const { busy, run } = useAction();
  useEffect(() => setValue(e.value), [e.value]);
  const save = async () => {
    const r = await run(() => api.putBlackboard(e.key, value), `Saved ${e.key}`);
    if (r) {
      setEditing(false);
      onSaved();
    }
  };
  return (
    <li className="bb-row" data-key={e.key}>
      <div className="row"><code className="bb-key">{e.key}</code><span className="grow" /><span className="muted tiny">by {e.updatedBy === "human" ? "Board" : <AgentLink id={e.updatedBy} size={14} />} <RelTime iso={e.updatedAt} className="rel" /></span>
        {!editing ? <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)} aria-label={`Edit ${e.key}`}>Edit</Button> : null}</div>
      {editing ? (
        <div className="stack tight">
          <textarea rows={3} value={value} onChange={(ev) => setValue(ev.target.value)} aria-label={`Value of ${e.key}`} />
          <div className="row"><Button size="sm" variant="primary" onClick={save} disabled={busy}>Save</Button><Button size="sm" onClick={() => { setValue(e.value); setEditing(false); }}>Cancel</Button></div>
        </div>
      ) : <p className="bb-val">{e.value}</p>}
    </li>
  );
}

export function MemoryView() {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [kind, setKind] = useState<MemoryKind | "">("");
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const { busy, run } = useAction();
  useEffect(() => {
    const t = window.setTimeout(() => setDq(q), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const mem = useApi(`global-mem:${dq}:${kind}`, () => api.memory({ q: dq, kind }), { refreshOn: ["memory.written"], throttleMs: 3000 });
  const bb = useApi("blackboard", () => api.blackboard(), { refreshOn: ["memory.written"], throttleMs: 2000 });
  const add = async () => {
    const r = await run(() => api.putBlackboard(newKey.trim(), newVal), `Added ${newKey.trim()}`);
    if (r) {
      setNewKey("");
      setNewVal("");
      bb.reload();
    }
  };
  return (
    <>
      <PageHead title="Memory" sub="What the whole company knows: long-term knowledge and the shared blackboard" />
      <div className="grid-2 wide-left">
        <Panel title="Global knowledge" actions={<SearchInput value={q} onChange={setQ} placeholder="Search knowledge" width={220} />}>
          <div className="row wrap" style={{ marginBottom: 10 }} role="group" aria-label="Filter by kind">
            {KINDS.map((k) => <button key={k || "all"} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{k || "All"}</button>)}
          </div>
          {mem.loading ? <Skeleton rows={5} /> : mem.error ? <ErrorNote error={mem.error} onRetry={mem.reload} /> : mem.data?.length ? <MemoryList items={mem.data} /> : <Empty title="Nothing matches" icon="memory">Managers write lessons and company facts here as work is evaluated.</Empty>}
        </Panel>
        <Panel title="Blackboard (global working memory)" actions={<span className="muted small">{bb.data?.length ?? 0} keys</span>}>
          {bb.loading ? <Skeleton rows={4} /> : bb.error ? <ErrorNote error={bb.error} onRetry={bb.reload} /> : (
            <ul className="bb-list">
              {bb.data?.map((e) => <BlackboardRow key={e.key} e={e} onSaved={bb.reload} />)}
              {!bb.data?.length ? <li className="muted">The blackboard is empty.</li> : null}
            </ul>
          )}
          <div className="bb-new">
            <h3 className="section-title">Add or overwrite a key</h3>
            <div className="stack tight">
              <Field label="Key"><input type="text" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="pricing.policy" /></Field>
              <Field label="Value"><textarea rows={2} value={newVal} onChange={(e) => setNewVal(e.target.value)} /></Field>
              <div><Button variant="primary" icon="plus" onClick={add} disabled={!newKey.trim() || !newVal.trim() || busy}>Save to blackboard</Button></div>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
