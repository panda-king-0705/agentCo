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

Report vulnerabilities privately to the maintainers; do not open public
issues for them.
