/**
 * Server-Sent Events: GET /api/events/stream.
 *
 *   id: <seq>\nevent: <type>\ndata: <CompanyEvent json>\n\n
 *
 * Reconnects send `Last-Event-ID`; the missed events are replayed from the
 * append-only events table before live events flow. Replay is asynchronous, in
 * pages of REPLAY_PAGE events up to the head, and waits for `drain` whenever the
 * socket's buffer is full — so a big backlog never blocks the event loop and the
 * slow-client guard (MAX_BUFFERED_BYTES) only trips on clients that genuinely
 * cannot keep up with LIVE traffic. Live events are held back while replaying and
 * picked up by the next page (they are persisted before they are broadcast), so
 * nothing is lost or duplicated. When the backlog cannot be replayed exactly (the
 * events table no longer has the next event), a `resync` event tells the console
 * to refetch its state instead of silently skipping events.
 *
 * A `Last-Event-ID` ahead of the head (the server restarted on a fresh database)
 * means the client is new: no replay, live events flow (plus a `resync`).
 * Concurrent streams are capped (`maxClients`, 503 beyond). A comment heartbeat
 * every 15 s keeps proxies from closing idle streams.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CompanyEvent } from "../../../../packages/shared/src/index.ts";

export const HEARTBEAT_MS = 15_000;
/** Events per replay page (one DB query, then a yield to the event loop). */
export const REPLAY_PAGE = 500;
/** Default cap on concurrent SSE clients (SSE_MAX_CLIENTS). */
export const DEFAULT_MAX_SSE_CLIENTS = 50;
/** A client whose socket buffers this much unsent LIVE data is dropped (it will reconnect and replay). */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const frame = (event: CompanyEvent): string => `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** What the broadcaster needs from the EventBus. */
export interface SseSource {
  since(seq: number, limit?: number): CompanyEvent[];
  subscribe(listener: (event: CompanyEvent) => void): () => void;
  /** Highest seq written (optional: probed through `since` when absent). */
  head?(): number;
}

export interface SseOptions {
  maxClients?: number;
}

export class SseBroadcaster {
  private readonly bus: SseSource;
  private readonly heartbeatMs: number;
  private readonly maxClients: number;
  private readonly clients = new Set<ServerResponse>();

  constructor(bus: SseSource, heartbeatMs = HEARTBEAT_MS, options: SseOptions = {}) {
    this.bus = bus;
    this.heartbeatMs = heartbeatMs;
    this.maxClients = Math.max(1, options.maxClients ?? DEFAULT_MAX_SSE_CLIENTS);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** True when `lastId` names an event this database never wrote (e.g. after a restart on a fresh DB). */
  private aheadOfHead(lastId: number): boolean {
    if (lastId <= 0) return false;
    if (typeof this.bus.head === "function") return lastId > this.bus.head();
    // No head(): the event `lastId` exists iff since(lastId − 1) starts with it.
    return this.bus.since(lastId - 1, 1)[0]?.seq !== lastId;
  }

  /** Takes over the response and streams events until the client disconnects. */
  connect(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
    if (this.clients.size >= this.maxClients) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "retry-after": "5", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: { code: "too_many_streams", message: `At most ${this.maxClients} live event streams; retry shortly or poll /api/events.` } }));
      return;
    }
    const header = req.headers["last-event-id"];
    const raw = (Array.isArray(header) ? header[0] : header) ?? query.get("lastEventId") ?? "";
    const parsed = Number.parseInt(raw, 10);
    let lastSent = Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
    let resync = false;
    if (lastSent > 0 && this.aheadOfHead(lastSent)) {
      // The client remembers another database's ids: treat it as a new client.
      lastSent = -1;
      resync = true;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n: connected\n\n");
    this.clients.add(res);

    let closed = false;
    let replaying = lastSent >= 0;
    const sendResync = (reason: string): void => {
      res.write(`event: resync\ndata: ${JSON.stringify({ reason })}\n\n`);
    };
    if (resync) sendResync("last-event-id is ahead of this server's event log");

    const unsubscribe = this.bus.subscribe((event) => {
      if (closed || replaying || event.seq <= lastSent) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) return close();
      lastSent = event.seq;
      res.write(frame(event));
    });
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, this.heartbeatMs);
    heartbeat.unref();

    function close(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    }
    const cleanup = (): void => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.clients.delete(res);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);

    if (replaying) {
      const caughtUp = (): void => {
        // Called in the same synchronous step as the empty last page: live from here on, no gap.
        replaying = false;
      };
      this.replay(res, () => closed, lastSent, (seq) => (lastSent = seq), sendResync, caughtUp).catch(() => close());
    }
  }

  /** Pages through the backlog after `from` up to the head, honouring backpressure. */
  private async replay(
    res: ServerResponse,
    isClosed: () => boolean,
    from: number,
    advance: (seq: number) => void,
    resync: (reason: string) => void,
    caughtUp: () => void,
  ): Promise<void> {
    let cursor = from;
    for (;;) {
      if (isClosed()) return;
      const page = this.bus.since(cursor, REPLAY_PAGE);
      if (page.length === 0) return caughtUp();
      if (page[0]!.seq !== cursor + 1 && cursor > 0) resync(`events ${cursor + 1}..${page[0]!.seq - 1} are no longer available`);
      let full = false;
      for (const event of page) {
        full = !res.write(frame(event)) || full;
        cursor = event.seq;
      }
      advance(cursor);
      if (full) await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });
      else await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Ends every open stream (server shutdown). */
  closeAll(): void {
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
