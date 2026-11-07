# AgentCo

A company whose **Board is one human** and whose every employee — CEO to support agent — is an AI agent.
You set direction in the Boardroom; the CEO turns it into objectives, delegates down the org, workers do the
work on cheap models, and the result is reported back to you. Everything is traceable, budgeted and
interruptible, and the whole company runs **offline on a deterministic mock model** until you add a key.

- **Org** — Board → CEO → C-suite → managers → workers (`startup` ≈ 19 agents, `enterprise` ≈ 45, `agency` ≈ 46: startup leadership + 2-4 catalog specialists per department — [docs/CATALOG.md](docs/CATALOG.md)).
- **Specialist catalog** — workers are staffed from ~280 [agency-agents](https://github.com/msitarzewski/agency-agents) specialists (MIT, vendored in `catalog/`); each worker carries a compiled, token-capped playbook. Browse and hire them in the console's Catalog view.
  Create, pause/resume and destroy agents from the console; destroying re-assigns open work and reports.
- **Two kinds of mind** — leaders run a brain-inspired cognitive cycle ([docs/BRAIN.md](docs/BRAIN.md));
  workers run a bounded tool loop on the economy tier. Model tiers cascade per cognitive stage.
- **Glass box** — one objective is one trace across every agent: run → stage → model call → tool call →
  delegation, with timing, tokens, cost and redacted I/O. A failed run names its failing step.
- **Governance** — approvals (hiring, budget raises, questions to the Board), a company kill switch,
  budgets at agent / department / company level, crash recovery with a "do not blindly repeat" notice.
- **Live console** — React dashboard fed by Server-Sent Events: org chart, chat, task board, trace waterfall,
  costs, approvals, memory.

## Quick start

Requires **Node ≥ 22.18** (it runs the TypeScript directly) — no `npm install` is needed to run the server.

```bash
node --disable-warning=ExperimentalWarning apps/server/src/index.ts   # API + SSE on http://127.0.0.1:3000
npm run build:web                                                     # once: builds the console into apps/web/dist
```

or `npm start` (build the console, then start). Open <http://127.0.0.1:3000>, go to the **Boardroom** and ask
the CEO for something ("Plan the launch of our first product"). Without a built console the server still
serves the API and a small page telling you to run `npm run build:web`.

Copy [`.env.example`](.env.example) to `.env` to configure; real environment variables win over `.env`.

**Live models.** Put `ANTHROPIC_API_KEY` in `.env` (never in chat or git) and the company runs on Claude —
executives on `claude-opus-5-5` (frontier), managers on `claude-sonnet-5-5` (standard), workers on
`claude-haiku-5-5` (economy); `MANAGER_MODEL_TIER=frontier` puts managers on Opus too. `npm run check:models`
makes one tiny real call per tier to prove the key works. First-run budgets are $5/day and $50/month.

**For the whole LAN (Docker).** With Docker Desktop: copy `.env.example` to `.env`, set `ANTHROPIC_API_KEY` and
`APP_AUTH_TOKEN` (24+ random characters), then `docker compose up -d --build` and open
`http://<this PC's LAN IP>:3000` from any device; the console asks for the token once. Step-by-step for
Windows, the firewall rule, backups, updates and a cloud VPS with TLS: **[docs/DEPLOY.md](docs/DEPLOY.md)**
(which also estimates the model cost per Boardroom objective — model spend, not hosting, is the real cost).

## Scripts

| script | what it does |
|---|---|
| `npm run dev` | `scripts/dev.mjs`: console watch-build + server with restart on change |
| `npm start` | build the console, then start the server |
| `npm run start:server` | start the server only |
| `npm run check:models` | one tiny real call (max_tokens 16) per live model tier: model, latency, cost; exit 1 on auth/model errors, refuses without keys |
| `node scripts/update-catalog.mjs <clone> [--commit <sha>]` | re-vendor the agency-agents catalog from a local clone |
| `npm run build:web` | build the console (esbuild → `apps/web/dist`) |
| `npm run typecheck` | `tsc` for server and web |
| `npm test` | all server tests (`node:test`): core, cognition and the end-to-end system test |
| `npm run check` | typecheck + tests + web build |

Run a subset: `node --disable-warning=ExperimentalWarning --test --test-concurrency=1 "apps/server/test/core/**/*.test.ts"`
(also `test/cognition`, and `test/system` — the system test boots the real server and drives it over HTTP).

## Configuration

All settings are environment variables (see [`.env.example`](.env.example)); every value has a default and an
invalid one stops the boot with a message naming the variable.

| group | variables |
|---|---|
| server | `PORT` (3000), `HOST` (127.0.0.1), `APP_AUTH_TOKEN`, `ALLOWED_ORIGINS`, `ALLOWED_HOSTS`, `DATA_DIR` (./data) |
| company | `COMPANY_NAME`, `ORG_TEMPLATE` (startup \| enterprise \| agency), `DAILY_BUDGET_USD`, `MONTHLY_BUDGET_USD`, `MAX_CONCURRENT_RUNS`, `MAX_HEADCOUNT`, `HIRING_REQUIRES_APPROVAL`, `HEARTBEAT_MINUTES` |
| catalog | `CATALOG_DIR` (default `./catalog`), `CATALOG_PLAYBOOK_TOKENS` (default 900) |
| runtime | `RUN_TIMEOUT_MS`, `REFLEX_MAX_STEPS`, `BRAIN_MAX_REVISIONS`, `CONTEXT_TRIGGER_PCT`, `CONTEXT_CARRY_TURNS`, `SCHEDULER_TICK_MS`, `SSE_MAX_CLIENTS` (default 50), `WEB_FETCH_ENABLED`, `WEB_DIST_DIR` |
| models | `MODEL_FRONTIER` / `_STANDARD` / `_ECONOMY` (`provider:model`; unset = Claude Opus / Sonnet / Haiku when `ANTHROPIC_API_KEY` is set, else the mock), `*_FALLBACK` (optional, used only when that provider has a key), `MANAGER_MODEL_TIER` (standard \| frontier), provider keys (`OPENAI_API_KEY`, `ARK_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`), `MODEL_PRICES_JSON`, `STAGE_ROUTING`, `MOCK_LATENCY_MS` |

Explicitly set company variables override the persisted company settings at every boot; everything else is
changed from the console (`PATCH /api/company`). **Off loopback** (`HOST` not 127.0.0.1/::1) the API requires
`Authorization: Bearer $APP_AUTH_TOKEN` (24+ characters; SSE also accepts `?token=`); the server refuses to start
without it. The console asks for the token on the first 401 (or takes it once from a `?token=` link) and keeps
it in the browser's localStorage under `agentco.token`. CORS is open only for the
Vite dev origin `http://localhost:5173` (plus `ALLOWED_ORIGINS`). State-changing requests must be
`Content-Type: application/json` from an allowed Origin, and the Host header must name this server — see
[SECURITY.md](SECURITY.md).

### Connections and daily call limits

Outside services (MCP servers) are set up in `config/mcp.json` on the PC. That file is git-ignored;
start from [`config/mcp.example.json`](config/mcp.example.json), and see
[`config/README.md`](config/README.md) for every field. Each server has a `dailyCallLimit`: how many
calls **each agent** may make to it in any 24 hours (a rolling window, not a calendar day; `0` = no limit).

| server | `dailyCallLimit` | why |
|---|---|---|
| `github` | **1000** per agent | Engineers read many files to change one. At 100, three engineers ran out partway through a single objective (trc_7b9b…). GitHub's own limit for a token is about 5,000 requests an hour, so 1000 is still well inside it. |
| `firecrawl` | **50** per agent | Each search or page scraped uses Firecrawl credits. |
| `fmp` | **100** per agent | Market and financial data for Finance. |

- **What counts:** only calls that reach the server. A read someone made lately is answered from a
  shared copy: a file for an hour, listings for 15 minutes, until a commit changes it. Shared reads,
  failed calls and calls waiting for your approval don't count.
- **At the limit:** the agent is told when its next call frees up and not to retry. Code goes to a
  colleague who still has calls. If no one does, the review doesn't send the work back: it tells you
  when the work can go on.
- **To change a limit:** edit `config/mcp.json`, then run `docker compose restart`. The file is read at
  start-up, and no rebuild is needed.

## Architecture in one page

```
Console (apps/web, React)  ──REST /api/*, SSE /api/events/stream──▶  API (node:http, zero deps)
                                                                       │
        OrgService · TaskService · Scheduler · RunService · ApprovalService · EventBus
                                                                       │
        BrainEngine (leaders) · ReflexEngine (workers) · ModelRouter (tiers, cascade, budget)
                                                                       │
        Tracer · Redactor · Context governance · Budget governor · ToolExecutor
                                                                       │
        SQLite (node:sqlite, WAL, FTS5) · per-agent workspaces on disk
```

- **Zero runtime npm dependencies.** `node:http`, `node:sqlite`, `node:crypto`, global `fetch`, `node:test`.
  Erasable TypeScript only (no `enum` / `namespace` / parameter properties; relative imports end in `.ts`).
- **Seams.** `apps/server/src/contracts.ts` defines what the platform offers engines (`PlatformServices`) and
  what engines return (`EngineResult`, including `yielded` for interruptible work); `createApp(config, overrides)`
  lets tests inject fake engines and a fake model router.
- **Work model.** Tasks are tickets (`todo → in_progress → waiting | blocked → done | failed`), prioritised by
  `value / cost`, one trace per objective. The scheduler ticks every 750 ms (and on every relevant event),
  honours the company pause, `MAX_CONCURRENT_RUNS` and one run per agent, and answers queued chat first.

Read next: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** (the spec: API table, span parentage, storage,
trade-offs) and **[docs/BRAIN.md](docs/BRAIN.md)** (the brain-inspired cognitive architecture). Decisions are
recorded in [docs/adr](docs/adr); requirements and the traceability matrix are in
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Credits

- Specialist catalog from [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents), MIT — see `catalog/agency-agents/LICENSE`.
The Glass Box middleware — two-tier secret redaction, extractive context compaction with a fail-closed context
limit, interrupted-run crash recovery and the span/trace conventions — is adapted from
**Volc Agent Launchpad** (TikTok-TechJam-2026), MIT licensed; see
[docs/REFERENCE-LICENSE-volc-agent-launchpad.txt](docs/REFERENCE-LICENSE-volc-agent-launchpad.txt).

## License

MIT — see [LICENSE](LICENSE).
