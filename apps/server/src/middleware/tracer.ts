/**
 * Tracer: OTel-GenAI-shaped spans persisted to SQLite.
 *
 * A span row is inserted at start (status `running`) and updated at end, so a
 * crashed run still leaves a body (Glass Box). Inputs/outputs/errors are
 * redacted — `redactMachine` for llm/tool spans, `redact` otherwise — and
 * truncated to 2000 chars before they reach the database or the event stream.
 */
import type { Span, SpanAttributes, SpanKind } from "../../../../packages/shared/src/index.ts";
import type { EndSpanOptions, SpanHandle, StartSpanOptions, Tracer } from "../contracts.ts";
import type { SpanRepo } from "../db/repo-trace.ts";
import type { EventBus } from "../events/bus.ts";
import { summaries } from "../events/summary.ts";
import { newId } from "../db/ids.ts";
import type { Redactor } from "./redact.ts";

export const PREVIEW_LIMIT = 2000;

export interface TracerDeps {
  spans: SpanRepo;
  bus: EventBus;
  redactor: Redactor;
  now?: () => Date;
}

/** True for errors produced by aborting an AbortSignal. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "RunAbortedError");
}

export function truncate(text: string, limit = PREVIEW_LIMIT): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
}

export class TracerImpl implements Tracer {
  private readonly deps: TracerDeps;
  private readonly now: () => Date;

  constructor(deps: TracerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Starts and persists a span (status running) and emits span.started. */
  startSpan(options: StartSpanOptions): SpanHandle {
    const span: Span = {
      id: newId("spn"),
      traceId: options.traceId,
      parentSpanId: options.parentSpanId,
      kind: options.kind,
      name: truncate(this.deps.redactor.redact(options.name), 200),
      status: "running",
      agentId: options.agentId ?? null,
      runId: options.runId ?? null,
      taskId: options.taskId ?? null,
      startedAt: this.now().toISOString(),
      endedAt: null,
      durationMs: null,
      input: options.input === undefined ? null : this.clean(options.kind, options.input),
      output: null,
      error: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      attributes: this.cleanAttributes(options.attributes ?? {}),
    };
    this.deps.spans.insert(span);
    this.deps.bus.emit("span.started", this.eventInput(span, summaries.spanStarted(span)));
    return new SpanHandleImpl(this, span);
  }

  /** Runs fn inside a span; ok on resolve, error (or cancelled on abort) on reject, then re-throws. */
  async withSpan<T>(options: StartSpanOptions, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    const span = this.startSpan(options);
    try {
      const result = await fn(span);
      span.end({ status: "ok" });
      return result;
    } catch (error) {
      span.end(endOptionsForError(error));
      throw error;
    }
  }

  /**
   * Ends a still-running span by id (e.g. an objective span that outlives the
   * run that opened it, or spans left running by a crash). No-op if ended.
   */
  endById(spanId: string, options: EndSpanOptions = {}): void {
    const span = this.deps.spans.get(spanId);
    if (!span || span.status !== "running") return;
    this.finish(span, options);
  }

  /** @internal persists attribute changes */
  persistAttributes(span: Span): void {
    this.deps.spans.update(span.id, { attributes: span.attributes });
  }

  /** @internal finalises a span row and emits span.ended */
  finish(span: Span, options: EndSpanOptions): void {
    const ended = this.now();
    span.status = options.status ?? "ok";
    span.endedAt = ended.toISOString();
    span.durationMs = Math.max(0, ended.getTime() - Date.parse(span.startedAt));
    if (options.output !== undefined) span.output = this.clean(span.kind, options.output);
    if (options.error !== undefined) span.error = truncate(this.deps.redactor.redact(options.error));
    if (options.attributes) span.attributes = { ...span.attributes, ...this.cleanAttributes(options.attributes) };
    if (options.model !== undefined) span.model = options.model;
    if (options.inputTokens !== undefined) span.inputTokens = options.inputTokens;
    if (options.outputTokens !== undefined) span.outputTokens = options.outputTokens;
    if (options.costUsd !== undefined) span.costUsd = options.costUsd;
    const { id, ...patch } = span;
    this.deps.spans.update(id, patch);
    this.deps.bus.emit("span.ended", this.eventInput(span, summaries.spanEnded(span)));
  }

  /** @internal */
  cleanAttributes(attributes: SpanAttributes): SpanAttributes {
    const out: SpanAttributes = {};
    for (const [key, value] of Object.entries(attributes)) {
      out[key] = typeof value === "string" ? truncate(this.deps.redactor.redactMachine(value), 500) : value;
    }
    return out;
  }

  private clean(kind: SpanKind, text: string): string {
    const redactor = this.deps.redactor;
    const redacted = kind === "llm" || kind === "tool" ? redactor.redactMachine(text) : redactor.redact(text);
    return truncate(redacted);
  }

  private eventInput(span: Span, summary: string) {
    return { agentId: span.agentId, taskId: span.taskId, runId: span.runId, traceId: span.traceId, summary, data: { ...span } };
  }
}

class SpanHandleImpl implements SpanHandle {
  private readonly tracer: TracerImpl;
  private readonly span: Span;
  private ended = false;

  constructor(tracer: TracerImpl, span: Span) {
    this.tracer = tracer;
    this.span = span;
  }

  get spanId(): string {
    return this.span.id;
  }

  get traceId(): string {
    return this.span.traceId;
  }

  setAttributes(attributes: SpanAttributes): void {
    this.span.attributes = { ...this.span.attributes, ...this.tracer.cleanAttributes(attributes) };
    if (!this.ended) this.tracer.persistAttributes(this.span);
  }

  end(options: EndSpanOptions = {}): void {
    if (this.ended) return;
    this.ended = true;
    this.tracer.finish(this.span, options);
  }

  child(options: Omit<StartSpanOptions, "traceId" | "parentSpanId">): SpanHandle {
    return this.tracer.startSpan({
      agentId: this.span.agentId,
      runId: this.span.runId,
      taskId: this.span.taskId,
      ...options,
      traceId: this.span.traceId,
      parentSpanId: this.span.id,
    });
  }
}

export function endOptionsForError(error: unknown): EndSpanOptions {
  const message = error instanceof Error ? error.message : String(error);
  return isAbortError(error) ? { status: "cancelled", error: message } : { status: "error", error: message };
}
