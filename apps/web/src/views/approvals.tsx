// Approvals: the Board's queue, rendered per kind; history below.
import { useState } from "react";
import { api } from "../api";
import { money } from "../format";
import { href } from "../router";
import { seed, useLive } from "../live";
import { AgentLink, Badge, Button, Empty, KV, ModelTierBadge, RelTime, useAction, Panel } from "../ui/kit";
import type { Approval, ApprovalKind, ModelTier } from "../types";
import { PageHead, TaskLinkById, useDeptName } from "./common";

const KIND_LABEL: Record<ApprovalKind, string> = {
  hire_agent: "Hire",
  terminate_agent: "Terminate",
  budget_increase: "Budget",
  question: "Question",
  external_action: "External action",
};

const str = (v: unknown): string => (v == null ? "" : String(v));

function DeptName({ id }: { id: unknown }) {
  const name = useDeptName(typeof id === "string" ? id : null);
  return <>{name}</>;
}

function Detail({ a }: { a: Approval }) {
  const p = a.payload;
  switch (a.kind) {
    case "hire_agent":
      return (
        <div className="stack tight">
          <KV rows={[
            ["Role", `${str(p.title)}${p.roleId ? ` (${str(p.roleId)})` : ""}`],
            ["Name", str(p.name) || "Chosen on hire"],
            ["Department", <DeptName key="d" id={p.departmentId} />],
            ["Manager", typeof p.managerId === "string" ? <AgentLink key="m" id={p.managerId} /> : "None"],
            ["Tier and cognition", `${str(p.tier)}, ${str(p.cognition)}`],
            ["Model tier", p.modelTier ? <ModelTierBadge key="mt" tier={p.modelTier as ModelTier} /> : "—"],
            ["Monthly budget", money(Number(p.monthlyBudgetUsd ?? 0))],
          ]} />
          {p.justification ? <p className="quote">{str(p.justification)}</p> : null}
        </div>
      );
    case "budget_increase":
      return (
        <div className="stack tight">
          <KV rows={[
            ["Scope", p.departmentId ? <span key="s">Department <DeptName id={p.departmentId} /></span> : str(p.scope) || "Company"],
            ["Current", money(Number(p.currentUsd ?? 0))],
            ["Requested", money(Number(p.requestedUsd ?? 0))],
            ["Increase", <strong key="i">+{money(Number(p.amountUsd ?? 0))}</strong>],
          ]} />
          {p.reason ? <p className="quote">{str(p.reason)}</p> : null}
        </div>
      );
    case "terminate_agent":
      return (
        <div className="stack tight">
          <KV rows={[["Agent", typeof p.agentId === "string" ? <AgentLink key="a" id={p.agentId} showTitle /> : "—"]]} />
          {p.reason ? <p className="quote">{str(p.reason)}</p> : null}
        </div>
      );
    case "external_action":
      return (
        <div className="stack tight">
          <KV rows={[["Action", str(p.action)], ["Channel", str(p.channel) || "—"], ["Recipients", str(p.recipients) || "—"]]} />
          {p.preview ? <pre className="io">{str(p.preview)}</pre> : null}
        </div>
      );
    case "question":
      return (
        <div className="stack tight">
          <p className="quote">{str(p.question) || a.summary}</p>
          {p.context ? <p className="muted small">{str(p.context)}</p> : null}
        </div>
      );
  }
}

function PendingCard({ a }: { a: Approval }) {
  const [note, setNote] = useState("");
  const { busy, run } = useAction();
  const isQ = a.kind === "question";
  const decide = async (decision: "approved" | "rejected") => {
    const res = await run(() => api.decideApproval(a.id, { decision, note: note.trim() || undefined }), decision === "approved" ? (isQ ? "Answer sent" : "Approved") : "Rejected");
    if (res) seed.approvals([res]);
  };
  return (
    <article className="apr-card" data-approval={a.id}>
      <header className="row wrap">
        <Badge tone={a.kind === "question" ? "accent" : "warn"}>{KIND_LABEL[a.kind]}</Badge>
        <strong className="grow">{a.summary}</strong>
        <RelTime iso={a.createdAt} className="rel muted small" />
      </header>
      <div className="row small muted wrap">Requested by <AgentLink id={a.requestedBy} showTitle /> {a.taskId ? <>· task <TaskLinkById id={a.taskId} /></> : null} {a.traceId ? <>· <a href={href(`/traces/${a.traceId}`)}>trace</a></> : null}</div>
      <Detail a={a} />
      <label className="field">
        <span className="field-label">{isQ ? "Your answer" : "Note to the agent (optional)"}</span>
        <textarea rows={isQ ? 3 : 2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={isQ ? "Type the answer the agent should act on" : "Why, or what to change"} />
      </label>
      <div className="row">
        <Button variant="primary" icon="check" onClick={() => decide("approved")} disabled={busy || (isQ && !note.trim())}>{isQ ? "Send answer" : "Approve"}</Button>
        <Button variant="danger" onClick={() => decide("rejected")} disabled={busy}>{isQ ? "Decline to answer" : "Reject"}</Button>
      </div>
    </article>
  );
}

export function ApprovalsView() {
  const approvals = useLive((s) => s.approvals);
  const all = Object.values(approvals);
  const pending = all.filter((a) => a.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const history = all.filter((a) => a.status !== "pending").sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  return (
    <>
      <PageHead title="Approvals" sub="Hires, budget increases, risky actions and questions that need a human decision" />
      <h2 className="section-title" style={{ fontSize: 13 }}>Pending ({pending.length})</h2>
      {pending.length ? (
        <div className="apr-grid">{pending.map((a) => <PendingCard key={a.id} a={a} />)}</div>
      ) : (
        <Panel><Empty title="Nothing waiting on you" icon="approvals">Agents will queue hires, budget requests and questions here.</Empty></Panel>
      )}
      <h2 className="section-title mt" style={{ fontSize: 13 }}>History ({history.length})</h2>
      <Panel flush>
        {history.length ? (
          <ul className="list">
            {history.map((a) => (
              <li key={a.id} className="list-row static" data-history={a.id}>
                <Badge tone={a.status === "approved" ? "good" : "danger"}>{a.status}</Badge>
                <Badge>{KIND_LABEL[a.kind]}</Badge>
                <span className="grow">{a.summary}{a.note ? <span className="muted small"> — “{a.note}”</span> : null}</span>
                <AgentLink id={a.requestedBy} size={16} />
                <RelTime iso={a.decidedAt} className="rel muted small" />
              </li>
            ))}
          </ul>
        ) : <div className="pad muted">No decisions yet.</div>}
      </Panel>
    </>
  );
}
