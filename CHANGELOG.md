# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/);
versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed
- Test 4 (a one-page plan split across four executives) cost $4.59 over 13 tasks and produced no
  page. Five fixes:
  - **Files are shared by default.** A plain path (`launch-plan/gtm.md`) now saves on the company
    drive, where colleagues can read it; `private/…` is for scratch notes. Before, every section
    went to its author's private folder and the assembler never found them. Saving over a file
    keeps the previous version (`.history/`, hidden).
  - **A missed read finds a teammate's file.** When a file isn't at the path asked for, the file
    tools look at what was saved on the same objective, including older private files and the same
    file name under another folder, and return it with a note on where it is. `workspace_list` and a
    miss also list what has been saved on the objective so far.
  - **Every owner the request names gets a part.** The plan cap is at least the number of named
    owners, plus one for an assembly step. The Low Effort candidate no longer trims a named
    owner's part. The leader's own department name ("executive summary") no longer counts as naming
    someone; a full name does.
  - **Assembling and reviewing come in a second round.** A part that works on other parts' output
    (`"round": 2`, or titled e.g. "Assemble the sections") is handed out only when every round-1
    part is done, with their results in its brief.
  - **Waiting instead of escalating.** If someone escalates (or reports a blocker) about a
    colleague's part on the same objective that is still in progress, they go on hold ("Waiting for
    T-176 (Kenji Tanaka)"). They resume with that colleague's result when it is finished: no
    manager run and no escalation budget used. A brain blocked twice in one run escalates instead of
    re-planning the same blocker again.
- The out-of-steps wrap-up call (which has no tools) told the model to "finish with
  complete_task", and a worker answered that complete_task was not among its tools. It now says
  the plain-text reply is the result.
- Console showed cancelled tasks "In progress" and stale agent states: on load it seeded its event
  position from the OLDEST events and replayed days-old updates over the current state.
  `/api/events` without `since` now returns the newest events, and the console ignores updates
  older than what it holds.
- Plans cut off mid-reply lost every subprocess (the leader then did everything itself): the JSON
  extractor returned the first nested object of a truncated reply; it now returns nothing, so the
  stage is repaired and retried, and planning gets more output room. Cross-department work is
  delegated one part per owning report.
- False "budget pressure": the remaining amount under the TIGHTEST cap (often the company's daily
  $10) was divided by the agent's MONTHLY budget, so a CEO with $54 of $60 unspent read "10% left"
  and rationed every plan (no High Cost, cheapest candidate). Each cap is now compared with its own
  limit, and the symptom names the binding cap. The handbook shows the agent's own monthly remainder.
- Costs: "Budget vs spend, per department" showed "/ $0.00" in red for every department. A $0
  department cap means "no department cap"; the meter now uses the sum of its agents' monthly
  budgets (marked "agents") or says "no cap".
- Role arrangement trusts the leader's choice of assignee (keyword overlap overrode a sensible
  pick: "verify and assemble the plan" went from the Chief of Staff to the CTO); a department
  counts as named only in a part's title, not anywhere in its description.
- A blackboard key nobody wrote yet, or a workspace file not written yet, is an answer listing what
  exists, not a red tool error in the trace.
- Agents now know today's date and time (TZ); a department or role named in the request ("have
  Finance…") decides who gets the work.
- Overview: "Spend today" / "Spend this month" and the daily budget bar stayed at the value
  loaded with the page; the console now refreshes the company snapshot after model calls,
  runs and approvals; and "today" / "this month" (budgets included) start at local midnight
  of `TZ` (e.g. `TZ=Asia/Singapore`) instead of UTC midnight.
- Question loop with live models: frustration from other work no longer early-stops a fresh
  task, and it decays over reports and idle time; an objective has at most one open Board
  question (later askers wait on it, one answer wakes them all); cancelling a task closes its
  tree's pending approvals.
- Board questions raised under a chat objective are posted in that chat, and the Board's
  reply there answers them (the blocked work resumes) instead of starting an unrelated run.
- Low confidence alone no longer escalates: on a first, reversible attempt with no outside
  blocker the agent proceeds on stated assumptions; escalations ask for the named blocker.
  The confidence step now sees the agent's tools (agents claimed "no memory_write tool").
- Anthropic JSON calls: no `response_format: json_object` (its endpoint only accepts
  `json_schema`); any provider rejecting `response_format` is retried without it.
- Revisions no longer repeat finished work (the custodian ID was written three times): an
  unreadable Feedback verdict is repaired once and, failing that, a non-empty result is accepted
  instead of defaulting to "revise"; a revision is told what the earlier attempt already changed;
  `memory_write` within one task upserts (same scope, kind and tags replace the earlier entry).
  Any unparseable stage JSON gets one repair attempt.
- Chat: a request for any action (even "record X") opens a task; a chat reply has no tools and may
  no longer promise to do something itself ("I'm writing it to the knowledge base…" with nothing
  written). The reply step can still open the task if the intent check missed it.
- Escalations carry the stuck task's own text (and the original request): a manager answering one
  no longer concludes "the ID was not supplied" when it was in the very task that escalated. Board
  questions show what their objective is about.
- The task-OOD insight no longer tells leaders to delegate everything new.
- Out of tool steps, Solving (and a worker on its last model tier) gets one final no-tools call
  for the result from what it gathered, instead of discarding the run as "no result".
- Leaders do quick own-tool tasks themselves (mode "direct") and answer reports' escalations
  directly instead of fanning them out.
- Leaders' charters name the company's own stores (knowledge base, blackboard, workspace)
  and limit Board questions to irreversible, external or out-of-mandate decisions.

### Added
- Approvals: "Clear history" hides decided approvals (pending ones stay; nothing is deleted), with
  undo and "Restore cleared". Migration v4.
- Onboarding: a company handbook generated from live data (mission, who's who with ids, how work
  flows, budgets, open objectives, key knowledge). Every new hire gets it from its manager on day
  one; any agent can re-read it (`company_handbook`); the Board sees it on the Org page.
- Company directory: every agent can look colleagues up (`company_directory`, granted to all) and
  address them by id, name, title, role word ("cfo") or "manager" in `send_message` and
  `delegate_task`; each charter lists the agent's manager, the CEO and its reports with ids.
- Tasks: "Clear finished" archives every fully finished objective tree (nothing is deleted;
  undo, an Archived list with restore, and retry brings a tree back). Migration v3.
- `scripts/audit/company-audit.mjs`: read-only weekly audit data (docs/DEPLOY.md › Weekly audit).
- `scripts/maintenance/archive-stale-memory.mjs`: reversibly archive memories, blackboard entries
  and workspace files that teach a stalled habit (docs/DEPLOY.md › Maintenance).
- Approvals: answer or dismiss all open questions at once (`POST /api/approvals/decide-many`).
- Overview: "Reset moods" when agents are frustrated (`POST /api/company/reset-mood`).

## [0.2.0] - 2026-11-06

### Added
- Specialist catalog: ~280 agency-agents specialists (MIT, vendored at b37b5bb3) as the
  company's hiring pool; every worker role runs on a compiled, token-capped playbook;
  leaders get a short domain-expertise line; Catalog view, hire-from-catalog API and tool
  (`catalog_search`, `hire_agent {catalogId}`); optional departments created on demand;
  `ORG_TEMPLATE=agency`.
- Live models: Anthropic defaults when `ANTHROPIC_API_KEY` is set (Opus 5.5 for directors,
  Sonnet 5.5 for managers, Haiku 5.5 for workers); `MANAGER_MODEL_TIER=frontier` option;
  startup tier summary; `npm run check:models`.
- Docker: multi-stage image (non-root, healthcheck, `/data` volume), docker-compose for LAN,
  a VPS variant behind a TLS proxy; console token prompt; docs/DEPLOY.md with hosting and
  per-objective model cost estimates.

### Fixed
- Windows: console path resolution; fixture server entry check; LF line endings pinned.


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
