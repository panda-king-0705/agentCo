# AgentCo

A company whose **Board is one human** and whose every employee — CEO to support agent — is an AI agent.
You set direction in the Boardroom; the CEO turns it into objectives, delegates down the org, workers do the
work on cheap models, and the result is reported back to you. Everything is traceable, budgeted and
interruptible, and the whole company runs **offline on a deterministic mock model** until you add a key.

- **Org** — Board → CEO → C-suite → managers → workers (`startup` ≈ 19 agents, `enterprise` ≈ 45).
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

## Scripts

| script | what it does |
|---|---|
| `npm run dev` | `scripts/dev.mjs`: console watch-build + server with restart on change |
| `npm start` | build the console, then start the server |
| `npm run start:server` | start the server only |
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
| company | `COMPANY_NAME`, `ORG_TEMPLATE` (startup \| enterprise), `DAILY_BUDGET_USD`, `MONTHLY_BUDGET_USD`, `MAX_CONCURRENT_RUNS`, `MAX_HEADCOUNT`, `HIRING_REQUIRES_APPROVAL`, `HEARTBEAT_MINUTES` |
| runtime | `RUN_TIMEOUT_MS`, `REFLEX_MAX_STEPS`, `BRAIN_MAX_REVISIONS`, `CONTEXT_TRIGGER_PCT`, `CONTEXT_CARRY_TURNS`, `SCHEDULER_TICK_MS`, `WEB_FETCH_ENABLED`, `WEB_DIST_DIR` |
| models | `MODEL_FRONTIER` / `_STANDARD` / `_ECONOMY` (`provider:model`), `*_FALLBACK`, provider keys (`OPENAI_API_KEY`, `ARK_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`), `MODEL_PRICES_JSON`, `STAGE_ROUTING`, `MOCK_LATENCY_MS` |

Explicitly set company variables override the persisted company settings at every boot; everything else is
changed from the console (`PATCH /api/company`). **Off loopback** (`HOST` not 127.0.0.1/::1) the API requires
`Authorization: Bearer $APP_AUTH_TOKEN` (24+ characters; SSE also accepts `?token=`). CORS is open only for the
Vite dev origin `http://localhost:5173` (plus `ALLOWED_ORIGINS`). State-changing requests must be
`Content-Type: application/json` from an allowed Origin, and the Host header must name this server — see
[SECURITY.md](SECURITY.md).

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

The Glass Box middleware — two-tier secret redaction, extractive context compaction with a fail-closed context
limit, interrupted-run crash recovery and the span/trace conventions — is adapted from
**Volc Agent Launchpad** (TikTok-TechJam-2026), MIT licensed; see
[docs/REFERENCE-LICENSE-volc-agent-launchpad.txt](docs/REFERENCE-LICENSE-volc-agent-launchpad.txt).

## License

MIT — see [LICENSE](LICENSE).
