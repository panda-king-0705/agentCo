# Security

AgentCo v0.x is a **single-user proof of concept** (same posture as the
reference Volc Agent Launchpad).

- Bind to loopback by default. Off loopback, `APP_AUTH_TOKEN` (24+ random
  characters) is required; it is a shared demo token, not identity.
- Agents act with tools you enable. `web_fetch` is off by default; workspace
  tools are confined to `DATA_DIR/workspaces` (path traversal rejected).
- Persisted traces, messages and memories pass through a two-tier redactor
  (provider-key shapes, configured literals, key/value heuristics for
  machine output). It is best-effort, not DLP — do not use production
  secrets or data.
- Budgets hard-stop model spend at agent, department and company level;
  the company kill switch aborts all runs.
- No multi-tenant isolation, RBAC or audit-grade immutability is claimed.

## Browser attacks on the loopback API

On loopback the API has no token, so any web page the founder visits could
otherwise drive it. The server (`apps/server/src/http/guard.ts`) therefore:

- **Checks Host (DNS rebinding).** Every request's `Host` must be a loopback
  name (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`), the configured
  `HOST`, or an `ALLOWED_HOSTS` entry; anything else is `403 forbidden_host`.
  A rebinding page talks to 127.0.0.1 under the attacker's name, so its
  requests (reads included) are refused. With a wildcard bind (`HOST=0.0.0.0`
  or `::`) any Host is accepted, because the bearer token is enforced there.
- **Blocks cross-site writes (CSRF).** On `POST`, `PUT`, `PATCH` and `DELETE`:
  - an `Origin` header, when present, must be this server's own origin (same
    host:port), the Vite dev origin (`http://localhost:5173`,
    `http://127.0.0.1:5173`) or an `ALLOWED_ORIGINS` entry, else
    `403 forbidden_origin` (`Origin: null` is refused);
  - the body must be `Content-Type: application/json` (a page on another site
    cannot send that without a CORS preflight, which is not granted), else
    `415`. A request with no body and no Content-Type (curl, the console's
    `DELETE`) is accepted; a browser always sends `Origin` on such a
    cross-site request, so it is refused by the rule above.
- `GET`/`HEAD` (the console, `/api/events/stream`) are only subject to the
  Host check; browsers do not let other origins read the responses.

Put the console behind another origin (reverse proxy, custom domain) by
listing it in `ALLOWED_ORIGINS` and its host name in `ALLOWED_HOSTS`.

## Agent tools

- `web_fetch` (off by default) resolves every host with `node:dns` and refuses
  the request if **any** address is private, loopback, link-local (cloud
  metadata), CGNAT, unspecified, multicast/reserved, or an IPv6 form that
  embeds one (IPv4-mapped `::ffff:a.b.c.d`, IPv4-compatible, NAT64, 6to4);
  literal IPs are checked in every spelling the URL parser accepts.
  Redirects are followed manually (at most 5) and every hop is re-checked.
  Residual risk: `fetch` resolves the name again when it connects, so a
  DNS-rebinding host with a near-zero TTL can still race the check; keep
  `web_fetch` off where internal services matter.
- Engine-written task state (`task.state`) and the Board's approval notes are
  deep-redacted before they are stored, emitted or put in a prompt.

Report vulnerabilities privately to the maintainers; do not open public
issues for them.
