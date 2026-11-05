# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/);
versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-06

First release: a company run by AI agents, with a human founder as the Board.

### Added
- Org templates modelled on the recurring structure of the world's 50 largest companies:
  startup (19 agents) and enterprise (46 agents, 14 departments); role templates with
  mandates, KPIs, tools, identity seeds, MBTI and a BaZi chart per agent.
- BrainEngine for executives and managers, following the founder's brain-inspired
  architecture block for block (33 traced blocks: Self-management, interruptible TODO list,
  Metacognition, Global Memory) with the founder's readings Q1-Q9.
- ReflexEngine for workers on the economy tier with one-step cascade fallback.
- Model router: frontier / standard / economy tiers, per-block stage routing, fallback
  profiles, budget gate with reservations, frontier-cost accounting (routing savings);
  OpenAI-compatible providers (OpenAI, BytePlus/Volcengine Ark, OpenRouter, DeepSeek,
  Gemini, Anthropic compat) and a deterministic offline mock.
- Work model: value/cost-prioritised task board, delegation down the reporting line,
  escalation up the chain, approvals for hiring / budget / Board questions, kill switch.
- Traceability: OTel-GenAI-shaped spans, one trace per objective across agents,
  failing-span attribution, SSE event stream with replay.
- Ported Glass Box middleware from Volc Agent Launchpad (TikTok-TechJam-2026): two-tier
  redaction, crash recovery, fail-closed context compaction.
- Console: live floor, org chart (overview + tree), agent detail with the live Brain view,
  Boardroom and DMs, trace waterfall, tasks, approvals, costs, memory.
- SDLC: requirements with ids, ADRs 0001-0007, 168 server tests, Playwright e2e, CI.


### Fixed (independent review, 12 findings)

- Brain: escalation is bounded per task (`task.state.escalation`); after a manager's or the
  Board's answer the task is never escalated again and Feedback settles on accept-partial or
  fail instead of re-planning on every wake-up.
- Brain: the Board's answer reaches the resumed run (fresh task row, local working memory,
  planning and Solving prompts) and `human_answer` resumes at the checkpointed block.
- `escalate` / `ask_human` inside a tool loop end the loop (waiting / blocked); no orphaned or
  duplicate escalation subtasks.
- Budget: in-flight model calls reserve their estimate, so concurrent calls cannot overrun a
  hard cap (`BudgetGate.assertCanSpend(…, reservationId)`, optional `release()`).
- Scheduler: ineligible assignees are excluded in SQL and the ready list is paged.
- HTTP: Host check (DNS rebinding), Origin allow-list and JSON-only state changes (CSRF);
  new `ALLOWED_ORIGINS`, `ALLOWED_HOSTS`.
- Destroy re-assigns open tasks through `TaskService.reassign` (attempt refunded, run state
  cleaned, run aborted); 409 while open tasks have no manager to inherit them.
- Approval notes and engine-written `task.state` are deep-redacted.
- `web_fetch` resolves DNS and refuses private/loopback/link-local targets (incl. IPv6
  embeddings) on every redirect hop (max 5).
- Agent create/update validation (tier, model profile, budget, department, manager, cycles → 400);
  a run that fails while starting is closed cleanly.
- A provider timeout falls back to the fallback profile; only the run's abort cancels.
- Span `end()` is idempotent across `endById`; an aborted engine's late writes are ignored.
