/**
 * Server-Sent Events: GET /api/events/stream.
 *
 *   id: <seq>\nevent: <type>\ndata: <CompanyEvent json>\n\n
 *
 * Reconnects send `Last-Event-ID`; the missed events are replayed from the
 * append-only events table before live events flow (replay and subscribe happen
 * in one synchronous step, so nothing is lost or duplicated). A comment
 * heartbeat every 15 s keeps proxies from closing idle streams.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CompanyEvent } from "../../../../packages/shared/src/index.ts";
import type { EventBus } from "../events/bus.ts";

export const HEARTBEAT_MS = 15_000;
const MAX_REPLAY = 5000;
/** A client whose socket buffers this much unsent data is dropped (it will reconnect and replay). */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export class SseBroadcaster {
  private readonly bus: EventBus;
  private readonly heartbeatMs: number;
  private readonly clients = new Set<ServerResponse>();

  constructor(bus: EventBus, heartbeatMs = HEARTBEAT_MS) {
    this.bus = bus;
    this.heartbeatMs = heartbeatMs;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Takes over the response and streams events until the client disconnects. */
  connect(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
    const header = req.headers["last-event-id"];
    const raw = (Array.isArray(header) ? header[0] : header) ?? query.get("lastEventId") ?? "";
    const lastId = Number.parseInt(raw, 10);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n: connected\n\n");
    this.clients.add(res);

    let closed = false;
    const send = (event: CompanyEvent): void => {
      if (closed) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) return close();
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    let lastSent = Number.isFinite(lastId) && lastId >= 0 ? lastId : -1;
    if (lastSent >= 0) {
      for (const event of this.bus.since(lastSent, MAX_REPLAY)) {
        send(event);
        lastSent = event.seq;
      }
    }
    const unsubscribe = this.bus.subscribe((event) => {
      if (event.seq > lastSent) {
        lastSent = event.seq;
        send(event);
      }
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
  }

  /** Ends every open stream (server shutdown). */
  closeAll(): void {
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
