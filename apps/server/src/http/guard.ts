/**
 * Request guard for the unauthenticated loopback API (see SECURITY.md → "Browser attacks").
 *
 *  - DNS rebinding: the Host header must name this server — a loopback name, the configured
 *    HOST, or an ALLOWED_HOSTS entry (any Host when HOST is a wildcard bind, where the
 *    bearer token is enforced anyway). A rebinding page's requests carry the attacker's name.
 *  - Cross-site requests (CSRF): on every state-changing method (POST/PUT/PATCH/DELETE)
 *      * an Origin header, when present, must be allowed: this server's own origin
 *        (same host:port), the Vite dev origins, or an ALLOWED_ORIGINS entry;
 *      * the body must be Content-Type application/json — which a cross-site page cannot
 *        send without a CORS preflight. A request with neither a body nor a Content-Type
 *        (curl, the console's body-less DELETE) passes; with no allowed Origin it cannot
 *        come from a browser page on another site, because browsers always send Origin
 *        on cross-origin non-GET requests.
 *  GET/HEAD (the console, the SSE stream) are only subject to the Host check; browsers
 *  already keep cross-origin pages from reading the responses (no CORS grant).
 */
import type { IncomingHttpHeaders } from "node:http";
import type { AppConfig } from "../config.ts";
import { AppError } from "./errors.ts";

export const DEV_ORIGINS: readonly string[] = ["http://localhost:5173", "http://127.0.0.1:5173"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]", ""]);
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type GuardConfig = Pick<AppConfig, "host" | "allowedOrigins" | "allowedHosts">;

/** Hostname of a Host header value ("[::1]:3000" → "::1", "LocalHost:3000" → "localhost"). */
export function hostName(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : value;
  }
  const colon = value.indexOf(":");
  return (colon >= 0 && value.indexOf(":", colon + 1) < 0 ? value.slice(0, colon) : value).replace(/\.$/, "");
}

export function hostAllowed(hostHeader: string | undefined, config: GuardConfig): boolean {
  if (!hostHeader || !hostHeader.trim()) return false;
  const bind = config.host.trim().toLowerCase();
  if (WILDCARD_BINDS.has(bind)) return true;
  const name = hostName(hostHeader);
  if (LOOPBACK_HOSTS.has(name) || name.endsWith(".localhost")) return true;
  if (name === hostName(bind)) return true;
  return config.allowedHosts.some((h) => hostName(h) === name);
}

export function originAllowed(origin: string, hostHeader: string | undefined, config: GuardConfig): boolean {
  const o = origin.trim().toLowerCase().replace(/\/+$/, "");
  if (!o || o === "null") return false;
  if (DEV_ORIGINS.includes(o) || config.allowedOrigins.includes(o)) return true;
  if (!hostHeader) return false;
  const self = hostHeader.trim().toLowerCase();
  return o === `http://${self}` || o === `https://${self}`;
}

function isJson(contentType: string): boolean {
  const essence = contentType.split(";")[0]!.trim().toLowerCase();
  return essence === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(essence);
}

function hasBody(headers: IncomingHttpHeaders): boolean {
  const length = headers["content-length"];
  if (length !== undefined && Number(length) > 0) return true;
  return headers["transfer-encoding"] !== undefined;
}

/** Throws a 403/415 AppError when the request must not reach a route. */
export function guardRequest(method: string, headers: IncomingHttpHeaders, config: GuardConfig): void {
  const host = typeof headers.host === "string" ? headers.host : undefined;
  if (!hostAllowed(host, config)) {
    throw new AppError(403, "forbidden_host", `Host "${host ?? ""}" is not this server; set ALLOWED_HOSTS to accept it`);
  }
  if (!STATE_CHANGING.has(method)) return;
  const origin = typeof headers.origin === "string" ? headers.origin : undefined;
  if (origin !== undefined && !originAllowed(origin, host, config)) {
    throw new AppError(403, "forbidden_origin", `Origin ${origin} may not change state here; set ALLOWED_ORIGINS to allow it`);
  }
  const contentType = headers["content-type"];
  if (contentType === undefined || contentType === "") {
    if (hasBody(headers)) throw new AppError(415, "unsupported_media_type", "Send the body as Content-Type: application/json");
    return;
  }
  if (!isJson(contentType)) throw new AppError(415, "unsupported_media_type", `Content-Type ${contentType} is not accepted; use application/json`);
}
