# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/);
versioning: [SemVer](https://semver.org/).

## [Unreleased]

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
