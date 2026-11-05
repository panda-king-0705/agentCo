/**
 * EventBus: every company event is appended to the `events` table (monotonic
 * seq, the SSE id) and then fanned out to in-process subscribers (SSE
 * connections, the scheduler's wake-up hook). Subscribers never break emit.
 */
import type { CompanyEvent, CompanyEventType } from "../../../../packages/shared/src/index.ts";
import type { EventRepo } from "../db/repo-trace.ts";
import { newId } from "../db/ids.ts";

export interface EmitInput {
  agentId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  traceId?: string | null;
  summary: string;
  data?: unknown;
}

export type EventListener = (event: CompanyEvent) => void;

export class EventBus {
  private readonly repo: EventRepo;
  private readonly now: () => Date;
  private readonly listeners = new Set<EventListener>();

  constructor(repo: EventRepo, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.now = now;
  }

  /** Persists and broadcasts one event; returns it with its seq. */
  emit(type: CompanyEventType, input: EmitInput): CompanyEvent {
    const draft: Omit<CompanyEvent, "seq"> = {
      id: newId("evt"),
      type,
      at: this.now().toISOString(),
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      traceId: input.traceId ?? null,
      summary: oneLine(input.summary, 240),
      data: input.data ?? null,
    };
    const event: CompanyEvent = { ...draft, seq: this.repo.append(draft) };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must not break the platform
      }
    }
    return event;
  }

  /** Registers a listener; returns the unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events with seq > `seq`, oldest first (replay for SSE / GET /api/events). */
  since(seq: number, limit = 500): CompanyEvent[] {
    return this.repo.since(Math.max(0, seq), Math.min(Math.max(limit, 1), 5000));
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

/** Collapses whitespace and truncates to `limit` chars with an ellipsis. */
export function oneLine(text: string, limit = 120): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : flat.slice(0, Math.max(0, limit - 1)) + "…";
}
