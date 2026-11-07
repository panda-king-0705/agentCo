/**
 * Provider outages: when no AI provider can be reached, work waits instead of failing.
 *
 * 2026-11-07 (trc_617b…): the PC's hotspot dropped for six minutes. The CEO's final check failed on
 * both providers ("fetch failed"), the task retried 0.4 s later, failed again, used its last attempt,
 * and the objective ended "failed" with every part done.
 *
 * Now: a model call that fails on every provider with a network error throws ProviderOutageError.
 * RunService puts the work back (task attempt refunded, chat message re-queued) and trips the
 * OutageGate; the scheduler starts nothing until the gate's next try (30 s, 1, 2, then every 5 min).
 * The first successful model call clears it. If it lasts, the Board is told once in the Boardroom.
 */
import type { ChatCallContext, ChatRequest, ChatResponse, ModelRouter } from "../contracts.ts";

export const OUTAGE_MESSAGE_PREFIX = "AI providers unreachable";

export class ProviderOutageError extends Error {
  readonly code = "provider_outage";
  constructor(details: string[]) {
    super(`${OUTAGE_MESSAGE_PREFIX} (${details.join("; ")}) — the network or the providers are down; the work waits and is retried`);
    this.name = "ProviderOutageError";
  }
}

export function isProviderOutage(err: unknown): boolean {
  if (!err || typeof err !== "object") return typeof err === "string" && err.startsWith(OUTAGE_MESSAGE_PREFIX);
  const e = err as { name?: unknown; message?: unknown };
  return e.name === "ProviderOutageError" || (typeof e.message === "string" && e.message.startsWith(OUTAGE_MESSAGE_PREFIX));
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

/** The request never got an answer from the provider: no network, DNS, connection refused or reset. */
export function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } };
  if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return true;
  if (e.cause && typeof e.cause.code === "string" && NETWORK_CODES.has(e.cause.code)) return true;
  const m = typeof e.message === "string" ? e.message : "";
  return /fetch failed|getaddrinfo|socket hang up|network (?:is )?unreachable|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(m);
}

/** Waits between tries while providers are unreachable: 30 s, 1 min, 2 min, then every 5 min. */
export const OUTAGE_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000];

export interface OutageState {
  since: number;
  /** Nothing starts before this (ms). */
  until: number;
  /** Consecutive failed tries. */
  strikes: number;
  reason: string;
  /** The Board was told (once per outage). */
  notified: boolean;
}

export type OutageListener = (event: "held" | "cleared", state: OutageState) => void;

export class OutageGate {
  private state: OutageState | null = null;
  private readonly listeners: OutageListener[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** While held, the time (ms) the next try may start; null when work can run. */
  heldUntil(): number | null {
    return this.state && this.state.until > this.now() ? this.state.until : null;
  }

  status(): OutageState | null {
    return this.state ? { ...this.state } : null;
  }

  /** A run could not reach any provider. Runs failing together during one wait count once. */
  trip(reason: string): void {
    const at = this.now();
    if (this.state && this.state.until > at) return;
    const strikes = (this.state?.strikes ?? 0) + 1;
    const wait = OUTAGE_BACKOFF_MS[Math.min(strikes, OUTAGE_BACKOFF_MS.length) - 1]!;
    this.state = { since: this.state?.since ?? at, until: at + wait, strikes, reason, notified: this.state?.notified ?? false };
    this.emit("held");
  }

  /** A provider answered: the outage is over. */
  clear(): void {
    if (!this.state) return;
    const was = this.state;
    this.state = null;
    for (const fn of this.listeners) this.safe(fn, "cleared", was);
  }

  /** Marks the Board as told about the current outage. */
  markNotified(): void {
    if (this.state) this.state.notified = true;
  }

  onChange(fn: OutageListener): void {
    this.listeners.push(fn);
  }

  private emit(event: "held"): void {
    const s = this.state;
    if (!s) return;
    for (const fn of this.listeners) this.safe(fn, event, s);
  }

  private safe(fn: OutageListener, event: "held" | "cleared", s: OutageState): void {
    try {
      fn(event, s);
    } catch (error) {
      console.error("[outage] listener failed:", error instanceof Error ? error.message : error);
    }
  }
}

/** The router as engines see it: a provider that answers ends an outage. */
export function watchOutages(router: ModelRouter, gate: OutageGate): ModelRouter {
  const chat = async (request: ChatRequest, ctx: ChatCallContext): Promise<ChatResponse> => {
    const response = await router.chat(request, ctx);
    gate.clear();
    return response;
  };
  return new Proxy(router, {
    get(target, prop) {
      if (prop === "chat") return chat;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
