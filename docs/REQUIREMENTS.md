# AgentCo — Requirements

Source: founder brief, 2026-11-04 (Board = the human founder). Each
requirement has an id used in commits, tests and the traceability matrix at
the end. Priority: **M** must, **S** should, **C** could.

## Functional

| id | P | Requirement |
|---|---|---|
| FR-1 | M | The company is organised like a real company: Board (human) → CEO → C-suite → departments → managers → workers, modelled on the recurring structure of the world's top-50 companies (docs/research/02-org-structure.md). |
| FR-2 | M | Every employee and leader is an AI agent with a role, department, manager, mandate, KPIs, tools and budget. |
| FR-3 | M | The founder can **create** agents (from a role template or custom), **pause/resume** them and **destroy** them from the console; destroy has an explicit policy for open work and direct reports. |
| FR-4 | M | The founder can **chat** with the CEO in a Boardroom and with any agent in a DM. A request for work becomes an objective that flows down the org and the result is reported back in the same conversation. |
| FR-5 | M | Agents delegate work to their reports as tasks; tasks form a tree under one objective; the TODO list is prioritised by value/cost and is interruptible. |
| FR-6 | M | High-level agents (executives, managers) use the brain-inspired architecture: identity, desire, motivation, OKRs, self-narrative, target & self-ability understanding, confidence/risk gate with calibration, cognitive control (decomposition, candidate solutions), solving & evaluation, monitoring (OOD, reverse thinking, truthful/efficient/good), reflection, online learning, emotion feedback, local/global working and long-term memory. |
| FR-7 | M | Low-level agents (workers) use a cheap, bounded loop on economy models; model tiers are configurable per agent and per cognitive stage. |
| FR-8 | M | A live dashboard shows what every agent is doing right now (status, activity, current task) and company KPIs (headcount, open work, approvals, spend, success rate). |
| FR-9 | M | Full traceability: every objective is one trace across all agents; every run, cognitive stage, model call, tool call and delegation is a span with timing, model, tokens, cost, redacted I/O; the failing step of a failed run is named. |
| FR-10 | M | Human-in-the-loop governance: approvals for hiring, budget increases and agent questions; company-wide kill switch; budgets with hard stops at agent, department and company level. |
| FR-11 | S | Cost visibility by tier, model, department and agent, plus the cost avoided by routing to cheaper tiers. |
| FR-12 | S | Shared knowledge: global knowledge base (searchable) and a blackboard (shared working memory). |
| FR-13 | S | Executives can hire agents (policy-gated by approval and headcount). |
| FR-14 | C | Heartbeats: executives periodically review OKRs and team state. |
| FR-15 | C | Optional internet access (`web_fetch`) for research roles. |

## Non-functional

| id | P | Requirement |
|---|---|---|
| NFR-1 | M | Runs locally with one command; works fully offline (deterministic mock models) and with real providers by setting keys. |
| NFR-2 | M | Provider-agnostic: any OpenAI-compatible endpoint (BytePlus/Volcengine Ark, OpenAI, OpenRouter, DeepSeek, Gemini, Anthropic compat). |
| NFR-3 | M | Durable state survives restarts; a crash mid-run is detected and the next run verifies state instead of replaying (ported Glass Box behaviour). |
| NFR-4 | M | Secrets never reach persisted traces (two-tier redaction, ported). |
| NFR-5 | M | Context governance: long conversations are compacted extractively; unknown context windows fail closed. |
| NFR-6 | S | Server has zero runtime npm dependencies; console builds with esbuild. |
| NFR-7 | S | Live UI updates within ~1 s via SSE with replay after reconnect. |
| NFR-8 | S | SDLC: version control, ADRs, typed contracts, automated unit/integration/e2e tests, CI, code review, semver releases, changelog. |
| NFR-9 | S | Single-user POC security posture: bearer token off-loopback; no multi-tenant isolation claimed. |

## Out of scope (v0.1)

Multi-tenant auth and RBAC; horizontal scaling; real outbound email/payments;
sandboxed code execution for engineering agents (seam noted: the reference
repo's Codex runner can be added as a tool); embeddings/vector search.

## Traceability matrix (v0.1.0)

| id | Design | Code | Verified by |
|---|---|---|---|
| FR-1 | ARCHITECTURE › Organisation; research/02 | `org/templates.ts`, `org/bootstrap.ts` | system: company-flow (org shape); e2e enterprise run (46 agents) |
| FR-2 | ARCHITECTURE › Organisation | `org/service.ts`, `org/agent-factory.ts` | core: lifecycle, http |
| FR-3 | ARCHITECTURE › Lifecycle | `org/service.ts`, `http/routes.ts`, `web/views/org.tsx` | core: lifecycle, review-regressions (R4, F7, F10); system; e2e |
| FR-4 | ARCHITECTURE › Cognition (message trigger) | `runs/conversations.ts`, `cognition/brain/index.ts`, `web/views/chat.tsx` | system: Boardroom → report; e2e-live |
| FR-5 | ARCHITECTURE › Work model | `tasks/service.ts`, `tasks/scheduler.ts`, `tools/builtins/delegation.ts` | core: tasks, scheduler, escalation, review-regressions (R3, F5) |
| FR-6 | BRAIN.md; ADR-0007 | `cognition/brain/**` | cognition: brain, brain-pure, review-regressions, review2-regressions; review 2 block audit |
| FR-7 | ADR-0003/0004 | `cognition/reflex.ts`, `models/router.ts` | cognition: reflex, models; system (economy spend > 0) |
| FR-8 | ARCHITECTURE › Console | `web/views/overview.tsx`, `web/src/live.ts` | e2e (fixtures + live) |
| FR-9 | ARCHITECTURE › Traceability; ADR-0006 | `middleware/tracer.ts`, `runs/service.ts`, `web/views/traces.tsx` | core: traceability; system (cross-agent tree, no orphans) |
| FR-10 | ARCHITECTURE › Governance | `middleware/budget.ts`, `tasks/approvals.ts` | core: budget, review-regressions (R2, F4) |
| FR-11 | ADR-0004 | `metrics/service.ts`, `web/views/costs.tsx` | core: metrics, review2-regressions; system (routing savings > 0) |
| FR-12 | BRAIN.md › Global Memory | `memory/service.ts`, `tools/builtins/memory.ts` | core: tools; web memory view |
| FR-13 | ARCHITECTURE › Hiring | `tools/builtins/hiring.ts` | core: tools, lifecycle |
| FR-14 | BRAIN.md › OKRs | `platform.ts` (heartbeat) | core: heartbeat (timer itself untested) |
| FR-15 | ARCHITECTURE › Tools | `tools/builtins/web.ts` | review-regressions (R8, F9) |
| NFR-1 | ADR-0001, ADR-0005 | `index.ts`, `models/providers/mock.ts` | system test on mock; e2e-live |
| NFR-2 | ADR-0004 | `models/providers/openai.ts`, `models/config.ts` | cognition: openai-adapter (local fake server); live providers untested |
| NFR-3 | ARCHITECTURE › Crash recovery | `tasks/service.ts` (recover), `runs/service.ts` | core: recovery |
| NFR-4 | SECURITY.md | `middleware/redact*.ts` | core: redaction, review-regressions (R5, F8) |
| NFR-5 | ARCHITECTURE › Context governance | `memory/compaction.ts` | core: compaction, review2-regressions |
| NFR-6 | ADR-0001 | server has no runtime deps | `package.json`; boots with plain `node` |
| NFR-7 | ARCHITECTURE › API | `http/sse.ts`, `web/src/live.ts` | core: sse, review2-regressions (replay, resync, cap) |
| NFR-8 | CONTRIBUTING.md | `.github/`, `docs/adr/` | git history; 2 independent reviews; CI workflow |
| NFR-9 | SECURITY.md | `http/guard.ts`, `config.ts` | review-regressions (R7, F6) |
