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

## Traceability matrix

Filled at release — maps each requirement to design section, code and tests.

| id | Design (ARCHITECTURE.md) | Code | Tests |
|---|---|---|---|
| _filled at v0.1.0_ | | | |
