# AgentCo — Architecture

A company whose Board is a human and whose every employee — CEO to support
agent — is an AI agent. The platform is a single-node control plane:

```
 Human (Board / Founder)
   │  browser
   ▼
┌───────────────────────── Console (apps/web, React) ─────────────────────────┐
│ Overview · Org chart · Agents (create/pause/destroy) · Chat (Boardroom + DMs)│
│ Task board · Trace explorer (waterfall) · Costs · Approvals · Memory         │
└──────────────▲──────────────────────────────────────────────▲───────────────┘
               │ REST /api/*                                   │ SSE /api/events/stream
┌──────────────┴─────────────── API (node:http, zero deps) ────┴───────────────┐
│ auth (bearer token off-loopback) · validation · routes · SSE broadcaster     │
└──────────────┬───────────────────────────────────────────────────────────────┘
┌──────────────┴──────────── Orchestration ────────────────────────────────────┐
│ OrgService (departments, agents, hire/fire)   TaskService (TODO board)       │
│ Scheduler (value/cost priority, concurrency, pause, budget gate)             │
│ RunService (builds EngineContext, applies EngineResult, crash recovery)      │
│ ApprovalService (human-in-the-loop) · EventBus (persist + fan-out)           │
└──────────────┬───────────────────────────────────────────────────────────────┘
┌──────────────┴──────────── Agent runtime ────────────────────────────────────┐
│ BrainEngine  (executives/managers) — brain-inspired cognitive cycle          │
│ ReflexEngine (workers)            — bounded tool loop on cheap models        │
│ ModelRouter  — tiers frontier/standard/economy, stage cascade, fallback,     │
│                cost + budget, providers: openai-compatible | mock            │
│ ToolExecutor — delegate, message, escalate, ask_human, memory, files, hire   │
└──────────────┬───────────────────────────────────────────────────────────────┘
┌──────────────┴──────────── Glass Box middleware (ported) ────────────────────┐
│ Tracer (OTel-GenAI spans, cross-agent traceId) · Redactor (2-tier, verbatim  │
│ port) · Context governance (extractive compaction, fail-closed limit) ·      │
│ Crash recovery (interrupted-run notice) · Budget governor                    │
└──────────────┬───────────────────────────────────────────────────────────────┘
┌──────────────┴──────────── Memory & storage (node:sqlite, WAL) ──────────────┐
│ Local working memory (task.state) · Agent LTM (episodic/semantic/procedural) │
│ Global working memory (blackboard) · Global LTM (FTS5 knowledge base)        │
│ Workspaces: data/workspaces/<agentId>/ and data/workspaces/shared/           │
└──────────────────────────────────────────────────────────────────────────────┘
```

Mapping to the reference diagram (Cazton): *User Interface → API* = Console +
API; *Agent Orchestration (Prompt, Chain, Manage, Monitor)* = Orchestration +
Tracer; *Agent Selection* = Scheduler + delegation routing; *Agents
(Orchestrator / Specialist / Data Access)* = CEO & managers (orchestrators),
workers (specialists), Data & Analytics agents with memory tools (data access);
*Agent Processing (Vector DBs, Function Calling, Internet)* = memory FTS,
ToolExecutor, optional `web_fetch`; *Enterprise System* = tool/MCP seam.

## Runtime constraints (deliberate)

- **Server has zero npm runtime dependencies.** Node ≥ 22.18 runs the
  TypeScript directly (type stripping), `node:sqlite` is the database,
  `node:http` the server, global `fetch` the provider client, `node:test` the
  test runner. Consequences for code: erasable TS only (no `enum`,
  `namespace`, parameter properties), relative imports end in `.ts`,
  type-only imports use `import type`. Start with
  `node --disable-warning=ExperimentalWarning apps/server/src/index.ts`.
- `packages/shared` is **types only**; never import a runtime value from it.
- Console: React 19 + TSX bundled by esbuild (`apps/web/build.mjs`) into
  `apps/web/dist/`, which the server serves statically.

## Repository layout and ownership

```
packages/shared/src/index.ts        domain + API + event types (lead)
apps/server/src/contracts.ts        internal seams (lead)
apps/server/src/
  index.ts config.ts                boot, config/env                    [core]
  db/                               schema, migrations, repositories    [core]
  http/                             router, routes, sse, static         [core]
  events/                           EventBus                            [core]
  org/                              role templates, bootstrap, OrgService[core]
  tasks/                            TaskService, Scheduler              [core]
  runs/                             RunService, recovery                [core]
  tools/                            registry + built-in tools           [core]
  memory/                           MemoryService, compaction           [core]
  middleware/                       redact (port), tracer, budget,
                                    context-limit (port)                [core]
  models/                           router, pricing, providers/         [cognition]
  cognition/                        reflex.ts, brain/*                  [cognition]
apps/server/test/*.test.ts          node:test                           [both]
apps/web/                           console                             [web]
```

The boot file wires concrete classes: `createPlatform(config)` (core) returns
the services, then `new ModelRouterImpl(...)`, `new BrainEngine()`,
`new ReflexEngine()` (cognition) are injected into RunService. The core
engineer owns `index.ts` and imports `createModelRouter(deps)` from
`models/router.ts` and `createEngines()` from `cognition/index.ts` — those two
factory signatures are fixed:

```ts
// models/config.ts  (cognition)
export interface ModelConfig { /* tiers, profiles, providers, stageRouting */ }
export function loadModelConfig(env: NodeJS.ProcessEnv): ModelConfig;
export function modelsInfo(config: ModelConfig): ModelsInfo;     // for GET /api/models
// models/router.ts  (cognition)
export function createModelRouter(deps: ModelRouterDeps & { config: ModelConfig }): ModelRouter;
// cognition/index.ts  (cognition)
export function createEngines(options?: { reflexMaxSteps?: number; brainMaxRevisions?: number })
  : Record<CognitionKind, CognitiveEngine>;
// middleware/budget.ts  (core) implements BudgetGate (contracts.ts):
//   assertCanSpend throws Error{name:"BudgetExceededError", scope, limitUsd, spentUsd}
//   recordSpend(SpendEntry) writes the spend table, adds cost to the run and the task
```

## Organisation

Role templates (`org/templates.ts`) are data: id, title, department,
reports-to role, tier, cognition, model tier, mandate, KPIs, tools, default
names, and whether the role is in the *startup* org. Two org templates:

- **startup** (default, ~18 agents): Board(human) → CEO → CTO, CPO, CFO, COO,
  CMO, CRO, CHRO, General Counsel, each with 1-2 workers; Chief of Staff.
- **enterprise** (~45 agents): adds managers (Eng Manager, Support Lead,
  Sales Manager, Growth Manager…), CISO, Chief Data Officer, Internal Audit,
  and more workers per department.

The functional-C-suite-with-matrix-pods shape follows the recurring pattern
across the largest companies (see `docs/research/02-org-structure.md`).
Executives & managers → `cognition: brain`; workers → `cognition: reflex`.
Default model tiers: CEO/C-suite `frontier`, managers `standard`, workers
`economy`.

**Lifecycle.** Create (from template or custom), pause/resume, destroy.
Destroy = terminate: abort active run, cancel its queued runs, re-assign its
open tasks and its direct reports to its manager (CEO can't be destroyed while
it has reports — 409), set status `terminated`, keep rows for audit, archive
its workspace to `data/workspaces/.terminated/<agentId>`. (Fixes the reference
repo's orphaned-memory limitation with an explicit policy.)

**Hiring by agents.** `hire_agent` (executives only) creates an approval when
`hiringRequiresApproval` or headcount ≥ `maxHeadcount`; on approval the agent
is created under the requested manager.

## Work model — the company TODO list

A **Task** is a ticket. Priority = `value / max(estCostUsd, 0.01)` (the
brain diagram's *Subprocess value/cost* list); ties by createdAt.

```
todo ──▶ in_progress ──▶ done | failed
             │  ├──▶ waiting  (delegated subtasks) ──all children terminal──▶ todo (trigger subtasks_completed)
             │  └──▶ blocked  (ask_human/escalation) ──approval decided──▶ todo (trigger human_answer)
             └──(interrupt/cancel)──▶ cancelled
```

- A root task gets a fresh `traceId`; subtasks inherit it, so one objective is
  one trace across every agent that touched it.
- Failure of a subtask does not auto-fail the parent: the parent's engine
  evaluates the children and decides (accept partial / re-plan / fail).
- `attempts` increments per run; a task failing `maxAttempts` (default 2) is
  `failed` and an escalation message goes to the assignee's manager.

**Scheduler** (tick 750 ms): if company not paused, pick `todo` tasks by
priority whose assignee is active (not paused/terminated/busy) and within
budget, up to `maxConcurrentRuns` (default 4) total and 1 run per agent.
Chat messages bypass the queue (a run starts immediately if the agent is free;
otherwise the message waits and is picked first when it frees up).

**RunService** owns the run lifecycle: create Run + root `run` span (child of
the task's delegation span when there is one, else of the trace's objective
span), build `EngineContext`, call `engines[agent.cognition].run(ctx)` with a
timeout (`RUN_TIMEOUT_MS`, default 300 s) and an AbortController registered so
interrupt/pause/destroy can abort it, then apply the result:

| outcome | task | conversation (trigger=message) |
|---|---|---|
| completed | `done`, result=output; if root & originConversationId → post the result there as the assignee | post reply |
| waiting | `waiting` | post reply |
| blocked | `blocked` | post reply |
| failed | attempts<max → `todo` else `failed` + escalate | post "I hit an error: …" |

Errors thrown by the engine (incl. BudgetExceededError) → run `failed`,
`failingSpanId` = first span in the run with status error.

**Crash recovery (ported).** On boot, every run still `running` becomes
`interrupted`; its task goes back to `todo` with `state.recovery = { runId }`;
the next run gets `trigger: "recovery"` and `recoveryNotice`:

> Run <id> was terminated before it reported a result, so its side effects may
> be fully applied, partially applied, or absent. Establish the real state
> (subtasks, files, messages) before acting; do not assume it failed and do
> not blindly repeat it.

## Cognition

### ReflexEngine — workers (low-level thinking, cheap)

1. System prompt: role/title/department, mandate, persona style, the task (or
   message), acceptance criteria, top-3 procedural memories for the role,
   unread inbox, available tools. Recovery notice if present.
2. Loop ≤ `REFLEX_MAX_STEPS` (default 8) on `tierForStage("reflex.step")`
   (= agent tier, economy by default) with tool specs + two terminal tools the
   engine handles itself: `complete_task {result}` and `report_blocker
   {reason}`. Non-terminal tool calls go to ToolExecutor.
3. A plain text answer with no tool calls also completes (messages always end
   this way).
4. **Model cascade fallback:** if the loop errors or exhausts steps, retry
   once on the next tier up (economy → standard). Then fail.
5. After completion write one episodic memory (task + outcome, 1-2 lines).

### BrainEngine — executives & managers (high-level thinking)

One run = one pass of the cycle; every stage is a `stage` span named
`brain.<stage>` with its model calls as children. JSON-mode outputs, validated
with defaults on parse failure.

| # | Stage (span) | Diagram block | Model tier (default) | Output / effect |
|---|---|---|---|---|
| 0 | `brain.recall` | Memory: local/long-term, Literature review | none (FTS) | memories (k = 4 + 4·curiosity), blackboard, inbox, subtask results |
| 1 | `brain.target_understanding` | Target Understanding: problem definition, literature review, analysis (perspectives) | standard | `{problem, successCriteria[], perspectives[], unknowns[], intent: "chat"|"work"}` — perspectives count 2-4 from curiosity |
| 2 | `brain.self_assessment` | Self-ability Understanding: LLM capability, tools/MCP, budget/resource → Competence | none (computed) | `{tools, reports:[{id,title,skills}], budgetRemaining, needs, modelTier}` |
| 3 | `brain.risk_assessment` | Confidence · Risk/Uncertainty · Monitoring (OOD, calibration, reverse thinking) | economy | `{confidence, risks[], premortem, outOfDistribution}` → **calibrated** confidence = raw − bias·min(1, n/20), bias = meanConfidence − successRate |
| 3b | gate | Early stop / Fallback | — | calibrated < 0.25 or (OOD && confidence < 0.5) or frustration > 0.7 → escalate to manager / `question` approval to the Board for the CEO → outcome `blocked` |
| 4 | `brain.planning` | Cognitive Control: decomposition, candidate solutions (high-cost / low-cost / low-effort), Project mgmt: economic concepts | **agent tier** | `{candidates:[{name, approach, estCostUsd, value}], chosen, mode: "direct"|"delegate", subtasks:[{title, description, assigneeId, value, estCostUsd, acceptanceCriteria}]}`; chosen = max value/cost (needs.safety=low ⇒ cheapest acceptable); TODO list persisted to task.state.plan |
| 5 | `brain.solving` | Solving | agent tier | direct: bounded tool loop (≤ 6 steps) producing a result; delegate: `delegate_task` per subtask (delegation spans) → outcome `waiting` |
| 6 | `brain.evaluation` | Solving & Evaluation: feedback; Monitoring: truthful / efficient / good (真·善·美) | standard | runs on direct results and on trigger=subtasks_completed: `{score, meetsCriteria, truthful, efficient, good, issues[], decision: accept|revise|rollback|escalate}`; revise → back to 4 with feedback (≤ `BRAIN_MAX_REVISIONS`=2); rollback → cancel open subtasks, re-plan |
| 7 | `brain.learning` | Reflection/replanning, Online learning/evolving, Self-narrative generator, OKRs, Emotion feedback | economy | `{lesson, narrative, okrProgress}` → procedural memory (lesson), episodic memory, calibration update (predicted confidence vs outcome), affect update, narrative + OKR progress |

Message trigger: stages 0-1 run; `intent: chat` → reply directly (standard
tier, persona-styled); `intent: work` → `tasks.createObjective` assigned to
itself (originConversationId set), reply "Opened T-n: … I'll report back", and
the scheduler picks the objective next. This is how a Boardroom request flows
CEO → C-suite → workers and the final report lands back in the Boardroom.

**Identity → behaviour (so the diagram has teeth, not decoration):**

- identity (mission, worldview, values, vision, OKRs, narrative) is the
  system-prompt charter for every brain stage;
- `desires.curiosity` → perspectives count and recall breadth;
  `desires.epistemic` → evaluation strictness (accept requires score ≥ 0.6 +
  0.3·epistemic);
- `motivation.autonomy` low → escalate more (gate threshold +0.1);
- `needs.safety = low` (budget < 20 %) → conservation mode: cheapest
  acceptable candidate, no revisions;
- `affect.frustration` rises 0.25 per failed/rejected outcome, decays 0.15
  per success; > 0.7 forces the escalate gate (Emotion → Feedback/Update);
- **Role arrangement**: delegation picks assignees among direct reports by
  role/mandate fit (LLM proposes, engine validates it's a real active report,
  else picks by keyword overlap with mandate). Personality type shapes tone
  only. "Eight Characters & Five Elements" from the diagram is not used for
  assignment — it has no predictive value for role fit; `persona.traits`
  can carry it as flavour if wanted.

### ModelRouter

- Tiers → profiles from env (`MODEL_FRONTIER`, `MODEL_STANDARD`,
  `MODEL_ECONOMY`, each `provider:model`), provider credentials
  (`OPENAI_API_KEY`/`OPENAI_BASE_URL`, `ARK_API_KEY`/`ARK_BASE_URL`,
  `OPENROUTER_API_KEY`, …), price table defaults in `models/pricing.ts`
  overridable by `MODEL_PRICES_JSON`.
- Everything defaults to the **mock** provider when no key is configured, so
  the whole company runs offline, deterministically, for demos and tests.
  The console shows a "MOCK MODELS" badge when `live=false`.
- Stage cascade (`STAGE_ROUTING` env JSON overrides):
  target_understanding→standard, risk_assessment→economy, planning→agent,
  solving→agent, evaluation→standard, learning→economy, reflex.step→agent,
  chat.reply→standard.
- Budget check before each call (estimate = prompt chars/4 × input price +
  maxOutput × output price), actual cost recorded after.
- `routingSavingsUsd` metric = Σ(cost if call had run on frontier − actual).

**Mock provider** (deterministic, `models/providers/mock.ts`): reads the
stage marker `[[stage:<name>]]` the engines put in the system prompt and a
machine-readable `[[context:{...json...}]]` block (direct reports, task
title, tools) and returns plausible stage JSON; for tool loops it emits a
`delegate_task`/`memory_write`/`workspace_write_file` call when the context
lists them and then `complete_task` with a synthesized deliverable. Usage =
chars/4, so cost dashboards are populated (labelled mock).

## Tools (built-in registry)

| tool | who | effect |
|---|---|---|
| `delegate_task {assigneeId, title, description, acceptanceCriteria?, value?, estCostUsd?}` | managers, executives | subtask under the current task (or a new objective if none), assignee must be in the caller's reporting subtree (CEO: anyone); `delegation` span; parent → waiting |
| `send_message {toAgentId, content}` | all | agent_dm conversation; lands in recipient inbox (does not trigger a run) |
| `escalate {reason, question}` | all | message to manager + inbox; CEO → `question` approval to the Board |
| `ask_human {question}` | managers, executives | `question` approval; outcome blocked |
| `memory_search {query, scope?, kind?, limit?}` | all | ranked memories |
| `memory_write {content, kind, scope, tags?}` | all (global semantic/procedural: managers+) | stored + `memory.written` event |
| `blackboard_read {key?}` / `blackboard_write {key, value}` | all / managers+ | global working memory |
| `workspace_write_file {path, content}` / `workspace_read_file {path}` / `workspace_list {dir?}` | all | own workspace; `shared/…` paths go to the company drive; path traversal rejected |
| `hire_agent {roleId?, title, departmentId, managerId, tier, justification}` | executives | approval or direct create (policy) |
| `web_fetch {url}` | opt-in (`WEB_FETCH_ENABLED`) | GET, text only, 20 kB cap |

## Traceability

Span parentage rules (core implements; this is what makes one objective one
cross-agent tree):

- Chat message from the human → new `traceId`, root span kind `objective`
  named `chat: <first 60 chars>`, the message run's `run` span under it.
- `tasks.createObjective({traceId, parentSpanId})` and `POST /api/tasks`
  create an `objective` span for the root task (child of `parentSpanId` when
  given, else a trace root) and store its id in `task.state.objectiveSpanId`.
- `delegate_task` creates a `tool` span and, under it, a `delegation` span
  (attributes `agentco.delegate.to`, `agentco.task.id`) whose id is stored in
  the subtask's `state.delegationSpanId`.
- A task run's `run` span parent = `state.delegationSpanId` ??
  `state.objectiveSpanId`. Brain stages are children of the run span; `llm`
  spans are children of the stage (or of the run span for reflex); `tool`
  spans likewise.

- Every span carries `traceId`, `parentSpanId`, `agentId`, `runId`,
  `taskId`; spans persist on start (status running) and update on end, so a
  crashed run still leaves a body.
- Trace tree for one objective: `objective` → (`run` CEO → `stage`… →
  `delegation` → `run` CTO → … → `run` worker → `llm`/`tool`).
- `run.failingSpanId` names the first errored span (Glass Box).
- Inputs/outputs are redacted (port of the reference `redact.ts`:
  `redact()` for prose, `redactMachine()` for tool args / llm I/O) and
  truncated to 2000 chars before persistence.
- Events table is append-only; SSE replays from `Last-Event-ID`.

## Context governance (ported)

DM/Boardroom histories passed to engines are governed by
`memory/compaction.ts`: estimated tokens (chars/4) over
`contextWindow × CONTEXT_TRIGGER_PCT (0.7)` of the agent's resolved model →
extractive checkpoint: the first human message **verbatim** (objective), one
progress line per earlier exchange, the last `CONTEXT_CARRY_TURNS` (6) messages
verbatim, full transcript saved to `data/artifacts/<conversationId>/transcript_vN.md`.
Fail closed: `contextWindow = null` → no compaction, `compaction_disabled`
system span once. User's message is always last.

## Storage (SQLite, `data/agentco.db`, WAL)

Tables: `settings`, `departments`, `agents`, `tasks`, `runs`, `spans`,
`conversations`, `messages`, `memories` (+ `memories_fts` FTS5),
`blackboard`, `approvals`, `events`, `spend` (agentId, runId, model, tier,
costUsd, frontierCostUsd, inputTokens, outputTokens, at). JSON columns for
identity/persona/affect/calibration/state/attributes. Indexes on
traceId, runId, assigneeId+status, agentId+at.

## API

All JSON; errors `{error:{code,message}}`; bearer `APP_AUTH_TOKEN` required
when bound off loopback.

```
GET    /api/health
GET    /api/company                       CompanySnapshot
PATCH  /api/company                       Partial<CompanySettings>
POST   /api/company/pause | /resume       kill switch (aborts running runs)
GET    /api/org                           OrgResponse
GET    /api/roles                         RoleTemplate[]
GET    /api/models                        ModelsInfo
GET    /api/agents                        Agent[]   (?status=&departmentId=)
POST   /api/agents                        CreateAgentInput → Agent
GET    /api/agents/:id                    AgentDetail
PATCH  /api/agents/:id                    UpdateAgentInput → Agent
POST   /api/agents/:id/pause | /resume    Agent
DELETE /api/agents/:id                    DestroyAgentResult
GET    /api/agents/:id/memory             MemoryItem[] (?q=&kind=)
GET    /api/conversations                 Conversation[] (?agentId=)
POST   /api/conversations                 {agentId} → Conversation (get-or-create DM; agentId="ceo" or kind boardroom)
GET    /api/conversations/:id/messages    Message[] (?after=<iso>)
POST   /api/conversations/:id/messages    {content} → PostMessageResult
GET    /api/tasks                         Task[] (?status=&assigneeId=&rootTaskId=&traceId=)
POST   /api/tasks                         CreateTaskInput → Task
GET    /api/tasks/:id                     TaskDetail
POST   /api/tasks/:id/cancel | /retry     Task
GET    /api/runs                          Run[] (?agentId=&taskId=&limit=)
GET    /api/runs/:id                      RunDetail
POST   /api/runs/:id/cancel               Run   (interrupt)
GET    /api/traces                        TraceSummary[] (?limit=)
GET    /api/traces/:traceId               TraceDetail
GET    /api/approvals                     Approval[] (?status=)
POST   /api/approvals/:id/decide          DecideApprovalInput → Approval
GET    /api/blackboard                    BlackboardEntry[]
PUT    /api/blackboard/:key               {value} → BlackboardEntry
GET    /api/memory                        MemoryItem[] global (?q=&kind=)
GET    /api/metrics/overview              MetricsOverview
GET    /api/metrics/timeseries            TimeseriesPoint[] (?metric=cost|runs|tokens&hours=24)
GET    /api/events                        CompanyEvent[] (?since=<seq>&limit=)
GET    /api/events/stream                 SSE: `id: <seq>`, `event: <type>`, `data: <CompanyEvent json>`; heartbeat comment every 15 s
GET    /*                                 console (apps/web/dist), SPA fallback to index.html
```

## Configuration (env)

```
PORT=3000 HOST=127.0.0.1 APP_AUTH_TOKEN=
DATA_DIR=./data
ORG_TEMPLATE=startup|enterprise  COMPANY_NAME=AgentCo
DAILY_BUDGET_USD=5 MONTHLY_BUDGET_USD=100 MAX_CONCURRENT_RUNS=4 MAX_HEADCOUNT=60
RUN_TIMEOUT_MS=300000 REFLEX_MAX_STEPS=8 BRAIN_MAX_REVISIONS=2
CONTEXT_TRIGGER_PCT=0.7 CONTEXT_CARRY_TURNS=6
MODEL_FRONTIER=mock:frontier MODEL_STANDARD=mock:standard MODEL_ECONOMY=mock:economy
MODEL_FRONTIER_FALLBACK= MODEL_STANDARD_FALLBACK= MODEL_ECONOMY_FALLBACK=
OPENAI_API_KEY= OPENAI_BASE_URL=https://api.openai.com/v1
ARK_API_KEY= ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3
OPENROUTER_API_KEY= DEEPSEEK_API_KEY= ANTHROPIC_API_KEY=(via OpenAI-compatible endpoint)
MODEL_PRICES_JSON= STAGE_ROUTING=
WEB_FETCH_ENABLED=false HEARTBEAT_MINUTES=0 MOCK_LATENCY_MS=400
```

## Trade-offs and what to revisit at scale

- **Single node, in-process scheduler & locks.** Fine for tens of agents.
  Beyond: move tasks to a queue (Postgres SKIP LOCKED / Redis streams), runs to
  workers, SSE behind a pub/sub.
- **SQLite + FTS5 instead of a vector DB.** Zero ops, transparent BM25 — good
  enough for a company KB of thousands of items; add embeddings (sqlite-vec /
  pgvector) when recall quality matters more than determinism.
- **Turn-level context governance** (inherited limitation): it cannot stop a
  single huge turn from overflowing.
- **Brain stages cost more calls than a single prompt.** Cascade routing puts
  3 of 7 stages on cheap tiers and 2 need no model at all; measure with the
  `routingSavingsUsd` metric and the per-stage cost breakdown in traces.
- **Mock-by-default** keeps demos free and tests deterministic but can make the
  company look smarter than it is; the console labels it.
- **No multi-tenant auth** (as in the reference): one Board, one token.
