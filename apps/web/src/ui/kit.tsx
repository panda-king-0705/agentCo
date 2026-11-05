// Shared UI primitives. Plain React + CSS classes from styles.css; no libraries.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { href } from "../router";
import { initials, money, relTime } from "../format";
import { useLive, useNow } from "../live";
import type { Agent, AgentStatus, AgentTier, CognitionKind, ModelTier, SpanKind, SpanStatus, TaskStatus } from "../types";

// ───────────── icons ─────────────
const ICONS: Record<string, string> = {
  overview: "M3 3h6v8H3zM11 3h6v5h-6zM11 10h6v7h-6zM3 13h6v4H3z",
  org: "M8 2h4v4H8zM2 14h4v4H2zM8 14h4v4H8zM14 14h4v4h-4zM10 6v4M4 14v-4h12v4M10 10v4",
  chat: "M3 4h14v9H8l-4 3v-3H3z",
  traces: "M3 4h8M5 8h9M7 12h6M9 16h8",
  tasks: "M3 3h4v14H3zM8 3h4v9H8zM13 3h4v6h-4z",
  approvals: "M10 2l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V5zM7 10l2 2 4-4",
  costs: "M10 2a8 8 0 100 16 8 8 0 000-16zM12.5 7.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.1 0-2-.5-2.6-1.5M10 4.5v11",
  memory: "M4 4c0-1 3-2 6-2s6 1 6 2v12c0 1-3 2-6 2s-6-1-6-2zM4 4c0 1 3 2 6 2s6-1 6-2M4 10c0 1 3 2 6 2s6-1 6-2",
  search: "M8.5 3a5.5 5.5 0 104 9.4l4 4M8.5 3a5.5 5.5 0 010 11",
  plus: "M10 4v12M4 10h12",
  pause: "M7 4v12M13 4v12",
  play: "M6 4l10 6-10 6z",
  trash: "M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11",
  x: "M5 5l10 10M15 5L5 15",
  chevronRight: "M8 5l5 5-5 5",
  chevronDown: "M5 8l5 5 5-5",
  sun: "M10 6a4 4 0 100 8 4 4 0 000-8zM10 1v2M10 17v2M1 10h2M17 10h2M3.6 3.6l1.4 1.4M15 15l1.4 1.4M3.6 16.4L5 15M15 5l1.4-1.4",
  moon: "M15 12.5A6.5 6.5 0 017.5 5c0-1 .2-2 .6-2.8A7.5 7.5 0 1017.8 11.9c-.8.4-1.8.6-2.8.6z",
  monitor: "M2 4h16v10H2zM7 18h6M10 14v4",
  brain: "M7 3a3 3 0 00-3 3 3 3 0 00-1 5 3 3 0 003 4 2.5 2.5 0 004 1V4a2 2 0 00-3-1zM13 3a3 3 0 013 3 3 3 0 011 5 3 3 0 01-3 4 2.5 2.5 0 01-4 1",
  bolt: "M11 2L4 11h5l-1 7 7-9h-5z",
  alert: "M10 3l8 14H2zM10 8v4M10 14.5v.5",
  check: "M4 10l4 4 8-8",
  send: "M3 10l14-6-5 14-2-6z",
  refresh: "M16 10a6 6 0 11-2-4.5M16 3v4h-4",
  link: "M8 12l4-4M7 9l-2 2a3 3 0 004 4l2-2M13 11l2-2a3 3 0 00-4-4L9 7",
  user: "M10 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3 18c1-3.5 4-5 7-5s6 1.5 7 5",
  power: "M10 2v7M6 4.5a7 7 0 108 0",
  layers: "M10 3l7 4-7 4-7-4zM3 11l7 4 7-4",
  edit: "M4 16l1-4 8-8 3 3-8 8zM12 5l3 3",
  filter: "M3 4h14l-5 6v5l-4 2v-7z",
  graph: "M5 5a2 2 0 100 .1M15 5a2 2 0 100 .1M10 15a2 2 0 100 .1M6.5 6.5l2.5 7M13.5 6.5l-2.5 7M7 5h6",
};
export function Icon({ name, size = 16, className }: { name: keyof typeof ICONS | string; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ""}`} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d={ICONS[name] ?? ICONS.overview} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ───────────── status ─────────────
export const AGENT_STATUS: Record<AgentStatus, string> = {
  idle: "Idle",
  thinking: "Thinking",
  acting: "Acting",
  waiting: "Waiting",
  blocked: "Blocked",
  paused: "Paused",
  error: "Error",
  terminated: "Terminated",
};

/** Shape carries the status as well as colour, so it reads without colour vision. */
export function StatusGlyph({ status, size = 10 }: { status: AgentStatus; size?: number }) {
  const s = size;
  let shape: ReactNode;
  switch (status) {
    case "idle":
      shape = <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.5" />;
      break;
    case "thinking":
      shape = <circle cx="5" cy="5" r="4" fill="currentColor" />;
      break;
    case "acting":
      shape = <path d="M5 0.6L9.4 5 5 9.4 0.6 5z" fill="currentColor" />;
      break;
    case "waiting":
      shape = (
        <g>
          <circle cx="5" cy="5" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5 1.2A3.8 3.8 0 015 8.8z" fill="currentColor" />
        </g>
      );
      break;
    case "blocked":
      shape = <rect x="1.2" y="1.2" width="7.6" height="7.6" rx="1" fill="currentColor" />;
      break;
    case "paused":
      shape = (
        <g fill="currentColor">
          <rect x="1.5" y="1" width="2.6" height="8" rx="0.6" />
          <rect x="5.9" y="1" width="2.6" height="8" rx="0.6" />
        </g>
      );
      break;
    case "error":
      shape = <path d="M5 0.8L9.5 9H0.5z" fill="currentColor" />;
      break;
    case "terminated":
      shape = <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />;
      break;
  }
  return (
    <svg className={`glyph st-${status}`} width={s} height={s} viewBox="0 0 10 10" aria-hidden="true">
      {shape}
    </svg>
  );
}

export function StatusBadge({ status, compact }: { status: AgentStatus; compact?: boolean }) {
  return (
    <span className={`status st-${status}${compact ? " compact" : ""}`} title={AGENT_STATUS[status]}>
      <StatusGlyph status={status} />
      <span className={compact ? "sr-only" : undefined}>{AGENT_STATUS[status]}</span>
    </span>
  );
}

export const TASK_STATUS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  waiting: "Waiting",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
const TASK_GLYPH: Record<TaskStatus, AgentStatus> = { todo: "idle", in_progress: "acting", waiting: "waiting", blocked: "blocked", done: "idle", failed: "error", cancelled: "terminated" };
export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status ts-${status}`}>
      {status === "done" ? (
        <svg className="glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 5.2l2.3 2.3L8.5 2.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <StatusGlyph status={TASK_GLYPH[status]} />
      )}
      <span>{TASK_STATUS[status]}</span>
    </span>
  );
}

export function SpanStatusBadge({ status }: { status: SpanStatus }) {
  const map: Record<SpanStatus, [AgentStatus, string]> = { running: ["thinking", "Running"], ok: ["idle", "OK"], error: ["error", "Error"], cancelled: ["terminated", "Cancelled"] };
  const [g, label] = map[status];
  return (
    <span className={`status ss-${status}`}>
      {status === "ok" ? (
        <svg className="glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 5.2l2.3 2.3L8.5 2.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <StatusGlyph status={g} />
      )}
      <span>{label}</span>
    </span>
  );
}

export const SPAN_KINDS: SpanKind[] = ["objective", "run", "stage", "llm", "tool", "delegation", "memory", "system"];
export const SPAN_KIND_LABEL: Record<SpanKind, string> = { objective: "Objective", run: "Run", stage: "Brain block", llm: "LLM call", tool: "Tool", delegation: "Delegation", memory: "Memory", system: "System" };
export function KindSwatch({ kind }: { kind: SpanKind }) {
  return <span className={`swatch k-${kind}`} aria-hidden="true" />;
}

// ───────────── badges ─────────────
export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" | "danger" | "good" | "mock" | "live"; title?: string }) {
  return (
    <span className={`badge b-${tone}`} title={title}>
      {children}
    </span>
  );
}
const TIER_PIPS: Record<ModelTier, number> = { frontier: 3, standard: 2, economy: 1 };
export function ModelTierBadge({ tier, override }: { tier: ModelTier; override?: string | null }) {
  const n = TIER_PIPS[tier];
  return (
    <span className={`badge b-model mt-${tier}`} title={`Model tier: ${tier}${override ? ` (override: ${override})` : ""}`}>
      <span className="pips" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <i key={i} className={i < n ? "on" : ""} />
        ))}
      </span>
      {tier[0]!.toUpperCase() + tier.slice(1)}
      {override ? "*" : ""}
    </span>
  );
}
export function CognitionBadge({ kind }: { kind: CognitionKind }) {
  return (
    <span className={`badge b-cog cog-${kind}`} title={kind === "brain" ? "Brain-inspired cognitive cycle" : "Reflex tool loop (cheap)"}>
      {kind === "brain" ? "Brain" : "Reflex"}
    </span>
  );
}
export function TierLabel({ tier }: { tier: AgentTier }) {
  return <span className="tier-label">{tier === "executive" ? "Executive" : tier === "manager" ? "Manager" : "Worker"}</span>;
}

// ───────────── people ─────────────
export function Avatar({ agent, size = 28, id }: { agent?: Agent | null; size?: number; id?: string }) {
  const depts = useLive((s) => s.departments);
  if (id === "human" || (!agent && id === "human")) {
    return (
      <span className="avatar human" style={{ width: size, height: size, fontSize: size * 0.4 }} title="Board (you)">
        B
      </span>
    );
  }
  if (id === "system") {
    return (
      <span className="avatar system" style={{ width: size, height: size, fontSize: size * 0.4 }} title="System">
        <Icon name="bolt" size={size * 0.55} />
      </span>
    );
  }
  const color = agent ? depts[agent.departmentId]?.color ?? "var(--muted)" : "var(--muted)";
  return (
    <span
      className={`avatar${agent?.status === "terminated" ? " gone" : ""}`}
      style={{ width: size, height: size, fontSize: size * 0.38, ["--dc" as string]: color }}
      title={agent ? `${agent.name}, ${agent.title}` : id}
    >
      {agent ? initials(agent.name) : "?"}
    </span>
  );
}

export function AgentLink({ id, showTitle, size = 20 }: { id: string | null | undefined; showTitle?: boolean; size?: number }) {
  const agent = useLive((s) => (id ? s.agents[id] : undefined));
  if (!id) return <span className="muted">Unassigned</span>;
  if (id === "human")
    return (
      <span className="agent-link">
        <Avatar id="human" size={size} />
        <span>Board</span>
      </span>
    );
  return (
    <a className="agent-link" href={href(`/agents/${id}`)} onClick={(e) => e.stopPropagation()}>
      <Avatar agent={agent} id={id} size={size} />
      <span className="name">{agent?.name ?? id}</span>
      {showTitle && agent ? <span className="muted small">{agent.title}</span> : null}
    </a>
  );
}

export function RelTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const now = useNow();
  return (
    <time className={className ?? "rel"} dateTime={iso ?? undefined} title={iso ? new Date(iso).toLocaleString() : undefined}>
      {relTime(iso, Math.max(now, Date.now()))}
    </time>
  );
}

export function Money({ v, className }: { v: number | null | undefined; className?: string }) {
  return <span className={`num ${className ?? ""}`}>{money(v)}</span>;
}

// ───────────── controls ─────────────
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "default" | "ghost" | "danger" | "danger-solid"; size?: "sm" | "md"; icon?: string };
export function Button({ variant = "default", size = "md", icon, children, className, ...rest }: BtnProps) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size} ${className ?? ""}`} {...rest}>
      {icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children}
    </button>
  );
}
export function IconButton({ icon, label, onClick, tone, disabled }: { icon: string; label: string; onClick: (e: React.MouseEvent) => void; tone?: "danger"; disabled?: boolean }) {
  return (
    <button type="button" className={`icon-btn${tone ? ` ${tone}` : ""}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={15} />
    </button>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={`tab${value === t.id ? " on" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null ? <span className="count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A label that wraps its control, so clicking the text focuses the input without id plumbing. */
export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field${wide ? " wide" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

/** Horizontal fill meter; tone escalates past warnAt/dangerAt. */
export function Meter({ value, max, warnAt = 0.8, dangerAt = 1, label, small }: { value: number; max: number; warnAt?: number; dangerAt?: number; label?: string; small?: boolean }) {
  const ratio = max > 0 ? value / max : 0;
  const tone = ratio >= dangerAt ? "danger" : ratio >= warnAt ? "warn" : "ok";
  return (
    <div className={`meter m-${tone}${small ? " small" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className="fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
    </div>
  );
}

// ───────────── states ─────────────
export function Empty({ title, children, action, icon = "layers" }: { title: string; children?: ReactNode; action?: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      <Icon name={icon} size={22} />
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
export function Skeleton({ rows = 4, height = 14 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row" style={{ height, width: `${92 - ((i * 17) % 35)}%` }} />
      ))}
    </div>
  );
}
export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="error-note" role="alert">
      <Icon name="alert" />
      <span>{error.message}</span>
      {onRetry ? (
        <Button size="sm" variant="ghost" icon="refresh" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function Panel({ title, actions, children, className, flush, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean; id?: string }) {
  return (
    <section className={`panel${flush ? " flush" : ""} ${className ?? ""}`} id={id}>
      {title || actions ? (
        <header className="panel-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="panel-body">{children}</div>
    </section>
  );
}

// ───────────── overlays ─────────────
function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
}
function useAutofocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = el.querySelector<HTMLElement>("[data-autofocus], input:not([type=hidden]), textarea, select, button.btn-primary") ?? el;
    first.focus();
    return () => prev?.focus?.();
  }, []);
  return ref;
}

export function Modal({ title, onClose, children, footer, width = 560 }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEscape(onClose);
  const ref = useAutofocus<HTMLDivElement>();
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} style={{ width }} ref={ref} tabIndex={-1}>
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onClose, danger, busy }: { title: string; children: ReactNode; confirmLabel: string; onConfirm: () => void; onClose: () => void; danger?: boolean; busy?: boolean }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? "danger-solid" : "primary"} onClick={onConfirm} disabled={busy} data-autofocus>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

export function Drawer({ title, onClose, children, width = 560, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number; actions?: ReactNode }) {
  useEscape(onClose);
  const ref = useAutofocus<HTMLDivElement>();
  return createPortal(
    <div className="overlay drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" style={{ width }} ref={ref} tabIndex={-1}>
        <header className="drawer-head">
          <div className="drawer-title">{title}</div>
          <div className="drawer-actions">
            {actions}
            <IconButton icon="x" label="Close" onClick={onClose} />
          </div>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

// ───────────── toasts ─────────────
export interface Toast {
  id: number;
  tone: "info" | "success" | "error";
  text: string;
  detail?: string;
}
let toasts: Toast[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
function emitToasts() {
  for (const l of toastListeners) l();
}
export function toast(text: string, tone: Toast["tone"] = "info", detail?: string): void {
  const t = { id: ++toastSeq, tone, text, detail };
  toasts = [...toasts, t].slice(-4);
  emitToasts();
  window.setTimeout(() => dismiss(t.id), tone === "error" ? 7000 : 4000);
}
function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emitToasts();
}
export function ToastHost() {
  const list = useSyncExternalStore(
    (cb) => {
      toastListeners.add(cb);
      return () => toastListeners.delete(cb);
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast t-${t.tone}`}>
          <Icon name={t.tone === "error" ? "alert" : t.tone === "success" ? "check" : "bolt"} />
          <div className="toast-text">
            <div>{t.text}</div>
            {t.detail ? <div className="toast-detail">{t.detail}</div> : null}
          </div>
          <IconButton icon="x" label="Dismiss" onClick={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}

/** Run an async action with busy state; errors already toast via the API layer. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const v = await fn();
      if (success) toast(success, "success");
      return v;
    } catch {
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SearchInput({ value, onChange, placeholder, pageSearch = true, width }: { value: string; onChange: (v: string) => void; placeholder: string; pageSearch?: boolean; width?: number }) {
  return (
    <label className="search" style={width ? { width } : undefined}>
      <Icon name="search" size={14} />
      <input type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} data-page-search={pageSearch ? "" : undefined} aria-label={placeholder} />
      {pageSearch ? <kbd aria-hidden="true">/</kbd> : null}
    </label>
  );
}

export function costLabel(v: number) {
  return money(v);
}
