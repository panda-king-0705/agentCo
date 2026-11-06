// Live store: one EventSource to /api/events/stream patches cached entities by event type.
// Falls back to polling /api/events?since= when SSE keeps failing (e.g. bearer auth off-loopback).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, streamUrl } from "./api";
import type {
  Agent, Approval, CompanyEvent, CompanyEventType, CompanySettings, CompanySnapshot, Department, Message, Run, Span, Task,
} from "./types";

export type Connection = "connecting" | "live" | "reconnecting" | "polling";

export interface LiveState {
  connection: Connection;
  lastSeq: number;
  company: CompanySnapshot | null;
  departments: Record<string, Department>;
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  runs: Record<string, Run>;
  spans: Record<string, Span>;
  messages: Record<string, Message[]>; // by conversationId, ascending
  approvals: Record<string, Approval>;
  events: CompanyEvent[]; // newest first
}

let state: LiveState = {
  connection: "connecting",
  lastSeq: 0,
  company: null,
  departments: {},
  agents: {},
  tasks: {},
  runs: {},
  spans: {},
  messages: {},
  approvals: {},
  events: [],
};

const listeners = new Set<() => void>();
let scheduled = false;
function notify() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const l of listeners) l();
  });
}
function set(patch: Partial<LiveState>) {
  state = { ...state, ...patch };
  notify();
}
export function getLive(): LiveState {
  return state;
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
/** Select a slice of live state. Selectors must return stable references (a field, not a new array). */
export function useLive<T>(selector: (s: LiveState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

// ───────────── seeding (initial GETs) ─────────────
function byId<T extends { id: string }>(list: T[], into: Record<string, T> = {}): Record<string, T> {
  const out = { ...into };
  for (const x of list) out[x.id] = x;
  return out;
}
export const seed = {
  company: (c: CompanySnapshot) => set({ company: c }),
  departments: (list: Department[]) => set({ departments: byId(list) }),
  agents: (list: Agent[]) => set({ agents: byId(list, state.agents) }),
  agent: (a: Agent) => set({ agents: { ...state.agents, [a.id]: a } }),
  tasks: (list: Task[]) => set({ tasks: byId(list, state.tasks) }),
  runs: (list: Run[]) => set({ runs: byId(list, state.runs) }),
  spans: (list: Span[]) => set({ spans: byId(list, state.spans) }),
  approvals: (list: Approval[]) => set({ approvals: byId(list, state.approvals) }),
  messages: (conversationId: string, list: Message[]) => {
    const merged = mergeMessages(state.messages[conversationId] ?? [], list);
    set({ messages: { ...state.messages, [conversationId]: merged } });
  },
  events: (list: CompanyEvent[]) => {
    const known = new Set(state.events.map((e) => e.seq));
    const merged = [...state.events, ...list.filter((e) => !known.has(e.seq))].sort((a, b) => b.seq - a.seq).slice(0, 400);
    set({ events: merged, lastSeq: Math.max(state.lastSeq, ...list.map((e) => e.seq)) });
  },
};

function mergeMessages(prev: Message[], add: Message[]): Message[] {
  const map = new Map(prev.map((m) => [m.id, m]));
  for (const m of add) map.set(m.id, m);
  return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

let departmentsTimer: number | null = null;
let companyTimer: number | null = null;
/** Spend changes don't carry the totals: refetch the company snapshot (throttled to one GET per ~2 s). */
export function refreshCompany(): void {
  if (companyTimer != null) return;
  companyTimer = window.setTimeout(() => {
    companyTimer = null;
    api.company().then((c) => seed.company(c), () => undefined);
  }, 2000);
}
/** Events after which spend, open-task or approval counts in the company snapshot may have moved. */
const COMPANY_REFRESH: ReadonlySet<CompanyEventType> = new Set<CompanyEventType>(["run.completed", "span.ended", "approval.created", "approval.decided", "budget.alert"]);
/** Refetches the departments (throttled): a hire can create one on demand (docs/CATALOG.md). */
export function refreshDepartments(): void {
  if (departmentsTimer != null) return;
  departmentsTimer = window.setTimeout(() => {
    departmentsTimer = null;
    api.org().then((o) => seed.departments(o.departments), () => undefined);
  }, 150);
}

// ───────────── applying events ─────────────
type EventListener = (ev: CompanyEvent) => void;
const eventListeners = new Set<EventListener>();
export function onEvent(fn: EventListener): () => void {
  eventListeners.add(fn);
  return () => {
    eventListeners.delete(fn);
  };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export function applyEvent(ev: CompanyEvent): void {
  if (ev.seq <= state.lastSeq) return;
  const patch: Partial<LiveState> = { lastSeq: ev.seq, events: [ev, ...state.events].slice(0, 400) };
  const d = ev.data;
  switch (ev.type) {
    case "agent.created":
    case "agent.updated":
    case "agent.status":
    case "agent.terminated": {
      const agentId = isObj(d) && typeof d.id === "string" ? d.id : ev.agentId;
      if (agentId) {
        const prev = state.agents[agentId];
        const next = { ...(prev ?? {}), ...(isObj(d) ? d : {}) } as Agent;
        if (ev.type === "agent.terminated") next.status = "terminated";
        if (prev || (isObj(d) && "name" in d)) patch.agents = { ...state.agents, [agentId]: next };
        // A catalog hire can create its department on demand: fetch departments we don't know yet.
        if (ev.type === "agent.created" && next.departmentId && !state.departments[next.departmentId]) refreshDepartments();
      }
      break;
    }
    case "task.created":
    case "task.updated":
      if (isObj(d) && typeof d.id === "string") patch.tasks = { ...state.tasks, [d.id]: { ...(state.tasks[d.id] ?? {}), ...d } as Task };
      break;
    case "run.started":
    case "run.completed":
      if (isObj(d) && typeof d.id === "string") patch.runs = { ...state.runs, [d.id]: { ...(state.runs[d.id] ?? {}), ...d } as Run };
      break;
    case "span.started":
    case "span.ended":
      // Slim payload (no input/output previews): merged over what we have; detail is fetched on demand.
      if (isObj(d) && typeof d.id === "string") patch.spans = { ...state.spans, [d.id]: { ...(state.spans[d.id] ?? {}), ...d } as Span };
      break;
    case "message.created":
      if (isObj(d) && typeof d.conversationId === "string") {
        const m = d as unknown as Message;
        patch.messages = { ...state.messages, [m.conversationId]: mergeMessages(state.messages[m.conversationId] ?? [], [m]) };
      }
      break;
    case "approval.created":
    case "approval.decided":
      if (isObj(d) && typeof d.id === "string") patch.approvals = { ...state.approvals, [d.id]: d as unknown as Approval };
      break;
    case "company.updated":
      if (state.company && isObj(d)) {
        const settings = ("settings" in d ? d.settings : d) as Partial<CompanySettings>;
        patch.company = { ...state.company, settings: { ...state.company.settings, ...settings } };
      }
      break;
    default:
      break;
  }
  set(patch);
  if (COMPANY_REFRESH.has(ev.type) && (ev.type !== "span.ended" || (isObj(d) && d.kind === "llm"))) refreshCompany();
  for (const fn of eventListeners) fn(ev);
}

// ───────────── connection ─────────────
const EVENT_TYPES: CompanyEventType[] = [
  "agent.created", "agent.updated", "agent.status", "agent.terminated", "task.created", "task.updated", "run.started",
  "run.completed", "span.started", "span.ended", "message.created", "approval.created", "approval.decided",
  "memory.written", "budget.alert", "company.updated",
];

let source: EventSource | null = null;
let pollTimer: number | null = null;
let retrySseTimer: number | null = null;
let failures = 0;
let started = false;

function handleFrame(e: MessageEvent<string>) {
  try {
    applyEvent(JSON.parse(e.data) as CompanyEvent);
  } catch {
    /* ignore malformed frame */
  }
}

function openSse() {
  if (typeof EventSource === "undefined") return startPolling();
  source?.close();
  const es = new EventSource(streamUrl());
  source = es;
  for (const t of EVENT_TYPES) es.addEventListener(t, handleFrame as (e: Event) => void);
  es.onmessage = handleFrame;
  // The server could not replay exactly (gap in its log, or our Last-Event-ID is from another
  // database after a restart): refetch the state instead of trusting the stream position.
  es.addEventListener("resync", () => void resync());
  es.onopen = () => {
    failures = 0;
    stopPolling();
    set({ connection: "live" });
    // Catch up on anything missed while disconnected.
    void catchUp();
  };
  es.onerror = () => {
    failures++;
    if (failures >= 3 || es.readyState === EventSource.CLOSED) {
      es.close();
      source = null;
      startPolling();
    } else set({ connection: "reconnecting" });
  };
}

let resyncing = false;
/** Refetches company, org, tasks, approvals and recent events, replacing the cached state. */
async function resync() {
  if (resyncing) return;
  resyncing = true;
  try {
    const [company, org, tasks, approvals, events] = await Promise.all([api.company(), api.org(), api.tasks(), api.approvals(), api.events({ limit: 120 }, { quiet: true })]);
    const byIdOf = <T extends { id: string }>(list: T[]) => byId(list);
    set({
      company,
      departments: byIdOf(org.departments),
      agents: byIdOf(org.agents),
      tasks: byIdOf(tasks),
      approvals: byIdOf(approvals),
      runs: {},
      spans: {},
      events: [...events].sort((a, b) => b.seq - a.seq).slice(0, 400),
      // The stream position restarts from what this server has (it may be behind ours after a restart).
      lastSeq: events.reduce((n, e) => Math.max(n, e.seq), 0),
    });
  } catch {
    /* the next resync / catch-up will retry */
  } finally {
    resyncing = false;
  }
}

async function catchUp() {
  try {
    const evs = await api.events({ since: state.lastSeq, limit: 500 }, { quiet: true });
    for (const ev of evs.sort((a, b) => a.seq - b.seq)) applyEvent(ev);
  } catch {
    /* next tick will retry */
  }
}

function startPolling() {
  if (pollTimer != null) return;
  set({ connection: "polling" });
  pollTimer = window.setInterval(async () => {
    try {
      await catchUp();
      if (state.connection !== "polling") set({ connection: "polling" });
    } catch {
      set({ connection: "reconnecting" });
    }
  }, 2000);
  // Try SSE again every 30 s.
  retrySseTimer = window.setTimeout(() => {
    retrySseTimer = null;
    failures = 0;
    openSse();
  }, 30_000);
}
function stopPolling() {
  if (pollTimer != null) window.clearInterval(pollTimer);
  if (retrySseTimer != null) window.clearTimeout(retrySseTimer);
  pollTimer = null;
  retrySseTimer = null;
}

/** Boot: seed the store with the company, org, tasks, approvals and recent events, then stream. */
export async function startLive(): Promise<void> {
  if (started) return;
  started = true;
  const results = await Promise.allSettled([api.company(), api.org(), api.tasks(), api.approvals(), api.events({ limit: 120 }, { quiet: true })]);
  const [company, org, tasks, approvals, events] = results;
  if (company.status === "fulfilled") seed.company(company.value);
  if (org.status === "fulfilled") {
    seed.departments(org.value.departments);
    seed.agents(org.value.agents);
  }
  if (tasks.status === "fulfilled") seed.tasks(tasks.value);
  if (approvals.status === "fulfilled") seed.approvals(approvals.value);
  if (events.status === "fulfilled") seed.events(events.value);
  openSse();
}

// ───────────── data hooks ─────────────
const cache = new Map<string, unknown>();

export interface ApiState<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

interface UseApiOptions {
  /** Refetch (throttled) when one of these event types arrives, optionally filtered. */
  refreshOn?: CompanyEventType[];
  refreshIf?: (ev: CompanyEvent) => boolean;
  /** Background refresh interval. */
  intervalMs?: number;
  /** Minimum gap between event-driven refreshes. */
  throttleMs?: number;
}

/** Stale-while-revalidate fetch keyed by `key`; null key = disabled. */
export function useApi<T>(key: string | null, fetcher: () => Promise<T>, opts: UseApiOptions = {}): ApiState<T> {
  const [data, setData] = useState<T | undefined>(() => (key ? (cache.get(key) as T | undefined) : undefined));
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(key != null && !cache.has(key));
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const keyRef = useRef(key);
  keyRef.current = key;
  const lastRun = useRef(0);
  const pending = useRef<number | null>(null);

  const load = useCallback(() => {
    const k = keyRef.current;
    if (!k) return;
    lastRun.current = Date.now();
    fetchRef.current().then(
      (v) => {
        cache.set(k, v);
        if (keyRef.current === k) {
          setData(v);
          setError(null);
          setLoading(false);
        }
      },
      (e: Error) => {
        if (keyRef.current === k) {
          setError(e);
          setLoading(false);
        }
      },
    );
  }, []);

  useEffect(() => {
    if (!key) {
      setData(undefined);
      setLoading(false);
      return;
    }
    setData(cache.get(key) as T | undefined);
    setLoading(!cache.has(key));
    setError(null);
    load();
  }, [key, load]);

  const { refreshOn, refreshIf, intervalMs, throttleMs = 1500 } = opts;
  const refreshKey = refreshOn?.join(",") ?? "";
  const refreshIfRef = useRef(refreshIf);
  refreshIfRef.current = refreshIf;
  useEffect(() => {
    if (!key || !refreshKey) return;
    const types = new Set(refreshKey.split(","));
    const off = onEvent((ev) => {
      if (!types.has(ev.type)) return;
      if (refreshIfRef.current && !refreshIfRef.current(ev)) return;
      if (pending.current != null) return;
      const wait = Math.max(0, throttleMs - (Date.now() - lastRun.current));
      pending.current = window.setTimeout(() => {
        pending.current = null;
        load();
      }, wait);
    });
    return () => {
      off();
      if (pending.current != null) window.clearTimeout(pending.current);
      pending.current = null;
    };
  }, [key, refreshKey, throttleMs, load]);

  useEffect(() => {
    if (!key || !intervalMs) return;
    const t = window.setInterval(load, intervalMs);
    return () => window.clearInterval(t);
  }, [key, intervalMs, load]);

  return { data, error, loading, reload: load };
}

// Shared clock so relative times re-render every 10 s.
let nowTick = Date.now();
const tickListeners = new Set<() => void>();
window.setInterval(() => {
  nowTick = Date.now();
  for (const l of tickListeners) l();
}, 10_000);
export function useNow(): number {
  return useSyncExternalStore(
    (cb) => {
      tickListeners.add(cb);
      return () => tickListeners.delete(cb);
    },
    () => nowTick,
  );
}
