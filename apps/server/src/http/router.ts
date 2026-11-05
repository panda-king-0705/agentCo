/** A tiny method + path-pattern router (":param" segments) with JSON replies. Zero dependencies. */
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpReply {
  readonly status: number;
  readonly body: unknown;
  constructor(body: unknown, status = 200) {
    this.status = status;
    this.body = body;
  }
}

export const created = (body: unknown): HttpReply => new HttpReply(body, 201);

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body (undefined when the request had none). */
  body: unknown;
}

/** Return a value (JSON 200), an HttpReply, or undefined after writing the response yourself (SSE). */
export type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: split(pattern), handler });
  }

  get = (pattern: string, handler: Handler): void => this.add("GET", pattern, handler);
  post = (pattern: string, handler: Handler): void => this.add("POST", pattern, handler);
  patch = (pattern: string, handler: Handler): void => this.add("PATCH", pattern, handler);
  put = (pattern: string, handler: Handler): void => this.add("PUT", pattern, handler);
  delete = (pattern: string, handler: Handler): void => this.add("DELETE", pattern, handler);

  /** The matching handler + params, or "method_not_allowed" when only the method differs, or null. */
  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | "method_not_allowed" | null {
    const parts = split(pathname);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method) return { handler: route.handler, params };
    }
    return pathMatched ? "method_not_allowed" : null;
  }
}

function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (const [i, segment] of pattern.entries()) {
    const part = parts[i] as string;
    if (segment.startsWith(":")) {
      try {
        params[segment.slice(1)] = decodeURIComponent(part);
      } catch {
        return null;
      }
    } else if (segment !== part) return null;
  }
  return params;
}
