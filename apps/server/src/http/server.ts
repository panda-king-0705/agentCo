/**
 * node:http server: Host/Origin/Content-Type guard (DNS rebinding + CSRF, see guard.ts),
 * CORS for the Vite dev origin, bearer auth off loopback, JSON bodies, the API router,
 * the SSE stream and the static console.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Platform } from "../platform.ts";
import { AppError, badRequest, notFound, unauthorized } from "./errors.ts";
import { DEV_ORIGINS, guardRequest, type GuardConfig } from "./guard.ts";
import { buildRouter } from "./routes.ts";
import { HttpReply } from "./router.ts";
import { SseBroadcaster } from "./sse.ts";
import { serveStatic } from "./static.ts";

const MAX_BODY_BYTES = 1_000_000;

export interface HttpApp {
  server: Server;
  sse: SseBroadcaster;
  /** Closes the listener and every SSE stream. */
  close(): Promise<void>;
}

export function createHttpApp(platform: Platform, options: { heartbeatMs?: number } = {}): HttpApp {
  const router = buildRouter(platform);
  const sse = new SseBroadcaster(platform.bus, options.heartbeatMs);
  const { config } = platform;

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => fail(res, error));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    guardRequest(method, req.headers, config);
    cors(req, res, config);
    if (method === "OPTIONS") {
      res.writeHead(204, { "access-control-max-age": "600" });
      res.end();
      return;
    }
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") {
      if (method !== "GET" && method !== "HEAD") throw new AppError(405, "method_not_allowed", `${method} is not allowed here`);
      await serveStatic(config.webDistDir, url.pathname, res, method === "HEAD");
      return;
    }
    if (config.authRequired && url.pathname !== "/api/health") authenticate(req, url, config.authToken);

    if (method === "GET" && url.pathname === "/api/events/stream") {
      sse.connect(req, res, url.searchParams);
      return;
    }
    const match = router.match(method, url.pathname);
    if (match === null) throw notFound("route", `${method} ${url.pathname}`);
    if (match === "method_not_allowed") throw new AppError(405, "method_not_allowed", `${method} is not allowed on ${url.pathname}`);
    const body = method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : await readJson(req);
    const result = await match.handler({ req, res, params: match.params, query: url.searchParams, body });
    if (res.headersSent) return;
    const reply = result instanceof HttpReply ? result : new HttpReply(result === undefined ? null : result);
    const payload = JSON.stringify(reply.body);
    res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
    res.end(method === "HEAD" ? undefined : payload);
  }

  return {
    server,
    sse,
    close: () =>
      new Promise<void>((resolve) => {
        sse.closeAll();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function cors(req: IncomingMessage, res: ServerResponse, config: GuardConfig): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && (DEV_ORIGINS.includes(origin) || config.allowedOrigins.includes(origin.toLowerCase()))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,authorization,last-event-id");
  }
}

function authenticate(req: IncomingMessage, url: URL, token: string): void {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : (url.searchParams.get("token") ?? "");
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new AppError(413, "payload_too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("request body is not valid JSON");
  }
}

function fail(res: ServerResponse, error: unknown): void {
  const known = error instanceof AppError;
  if (!known) console.error("[http] unhandled error:", error instanceof Error ? (error.stack ?? error.message) : error);
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = known ? error.status : 500;
  const payload = JSON.stringify({ error: { code: known ? error.code : "internal_error", message: known ? error.message : "Internal server error" } });
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}
