# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/);
versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed (test 5 rerun, trc_617b…)
- **A network outage no longer fails work.** When no AI provider can be reached (the PC's hotspot
  dropped for six minutes), the run's task goes back in the queue with its attempt refunded, and
  nothing starts until the next try: 30 seconds, then 1, 2 and every 5 minutes. The first answer
  from a provider ends the hold. If the outage lasts, the Boardroom gets one message saying so, and
  another when it is over. A chat message hit by an outage is kept and answered later. Before, the
  CEO's last step failed twice in 0.4 seconds and the objective ended "failed" with every part done.
- **Steps reach the person the plan meant.** The recruiter's step had been handed to the CMO because
  the request also named Marketing and Jasmine didn't count as named. Now a person the request
  names counts, and the leader's pick stands when the step names someone on that pick's team.
- **Hiring.** A hire made on one step of an objective blocks asking for the same specialist on
  another. If the role is already on the team, the hire is refused and the person named, unless the
  request asks for another. The budget the request states is the budget ($10 was turned into
  "no more than $10", then $8). Recommendation steps no longer get the hire tool. A round-2 step that
  round 1 already did is built on, not redone.
- **Credit.** The handbook and both kinds of agent now say: never put a colleague's name on work they
  didn't do. The CMO had written the recommendation herself under the recruiter's name, and the hire
  request to the Board said the recruiter recommended it.
- **Company directory.** Entries show when someone joined, who hired them, their monthly model budget
  and catalog role; the directory finds people by catalog role and looks up an agent id, including
  someone who has left.

### Added
- **Delete a chat.** Every chat has a "Delete chat" button (the Boardroom has "Clear chat"). A
  deleted chat is gone for good: its messages, the notes the agent wrote while answering in it,
  and the context summary it would otherwise be shown again. A reply in progress stops; work the
  chat started keeps going, and its results show on the Tasks page. Company-wide knowledge and
  files stay. The Boardroom keeps existing and is only emptied. `DELETE /api/conversations/:id`.

### Changed
- **Removing an agent cleans up after it.** Their chats (with the Board and with other agents)
  and their private memories are deleted, and anything they were still asking the Board is
  withdrawn: the request is closed with a note saying why, and the task, now their manager's,
  wakes with it instead of waiting forever. Their past work stays in traces, tasks and costs,
  marked removed, so spending totals stay correct. The removal dialog says so and reports what
  was cleaned up. Agents removed earlier (Riley Chen, Casey Diaz) are cleaned up at the next start.

### Fixed
- **Removed agents are out of the conversation.** The conversation layer now refuses any message
  sent as a removed agent, and won't open or write to an agent-to-agent thread with one. Messages
  from the Board into a removed agent's thread are refused too: it would never be answered. A
  run's final reply and failure notes skip a removed agent instead of erroring. In the console,
  removed agents are marked "(removed)" in the chat list and on their messages, and their threads
  show a "kept for the record" note instead of the message box. Agent-to-agent threads now say
  they are read-only instead of failing on send.
- **CI's e2e job has passed for the first time.** It had failed on every run since CI was added.
  `apps/web/dev/e2e.mjs` loaded Playwright from one developer machine's global path, launched
  `/usr/bin/google-chrome` and wrote screenshots to that machine's scratch folder. A shared
  `apps/web/dev/browser.mjs` now finds Playwright in the project, `PLAYWRIGHT_MODULE` or the global
  npm root. It uses the bundled Chromium with `E2E_BROWSER=chromium` (as in CI), and writes
  screenshots to the OS temp folder. `e2e-live.mjs` uses the same helper.
- Hiring loop (2026-11-07, test 5 rerun). Resumed after the Board approved a hire, the CMO gave
  the new hire a duplicate task and then hired the same specialist again; the Board approved
  that too.
  - **One hire per role per task.** Each hire is recorded on the hiring task (requested, hired or
    declined). `hire_agent` refuses the same role twice.
  - **The task says who already joined.** Solving and planning stop offering the hire and name
    who has joined.
  - **Waiting comes first.** A manager waits for an open first task before planning anything,
    whether the work was handed out or done by the manager.
  - **The hiring manager hands the work over.** They are told to give the work to the new hire
    as their first task, not to do it first.
  - **`catalog_search` says specialists have no price.** The hirer sets the budget; a recruiter
    had searched 11 times for one.
- Model outages (2026-11-07, test 5):
  - **Account errors skip the provider.** When a provider fails on the account (no credit, quota
    used up, key refused), the router skips it for 10 minutes and goes straight to the fallback,
    with one warning in the log and `agentco.primary_skipped` on each span. Before, every call
    paid a failed round trip first.
  - **The OpenAI fallback can use tools.** gpt-6.1-sol refuses function tools on chat completions
    while its default reasoning is on, so every tool step failed. The adapter now retries with
    `reasoning_effort: "none"` and remembers that per model, the same way it already handles the
    temperature and response_format quirks.
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
- Test 4, second run ($3.88, 25 min). The new structure held, but checking work kept looping:
  - **Word counts now come from the tools.** Leaders asked for "a word count from a tool" and no
    tool gave one, so every section failed that check. `workspace_write_file` and
    `workspace_read_file` now report words, lines and characters (bullets and table bars don't
    count as words). A save is read back on disk before the tool says "Saved and verified".
    Leaders are told to set only checks these tools can do.
  - **Read-backs come back whole.** The model saw at most 3,000 characters of any tool result, so
    re-reading a 3.5k page always came back cut off and the reviewer rejected it as "truncated".
    The limit is now one whole file read (21,000), and a read ends with "[end of … — complete]".
  - **A revision fixes, it doesn't redo.** Sending delivered parts back re-planned the whole
    objective, so all four parts were done twice (about $1.90). The re-plan is now told which parts
    are delivered and where, and to send a fix only to the owner it concerns, doing small fixes
    itself. Named owners get no extra slots in a fix round.
  - **Open points for the Board are not defects.** The reviewer no longer sends work back over
    decisions only the Board can make (prices, trade-offs), data nobody has, or clearly labelled
    estimates. It lists them as open points.
  - **No redo without time to finish it.** With less than 40% of the run's time limit left, an
    agent hands in its best result with the open issues listed. Before, the assembler hit the
    5-minute limit twice and lost the work each time.
  - **More room to answer.** Reviews, problem definitions, analyses and plans were often cut off
    and had to be asked again; their output limits are higher. Tool-loop steps get 4,000 tokens,
    so a whole document fits in one save.
- Test 4, fourth run (a copy of the plan already on the drive; $1.78 and 18 min, unfinished):
  - **Exact paths, updated in place.** Planning now sees the newest files on the company drive.
    Leaders name the exact file each part saves to, and reuse a document's path when it already
    exists. Every agent saves exactly there and never starts a second copy under another name;
    the previous version is kept automatically. Before, briefs named no path, so each section got
    a second and third copy, and the conflicting Finance versions caused a correction round
    (about $0.52 and 8 minutes).
  - **The assembler's brief carries the section files.** The round-2 brief includes the current
    versions of the round-1 files, so nothing needs reading and older copies can't creep in.
  - **Enough steps, used well.** The tool loop states the step budget up front and says to batch
    reads. The last step may save and call complete_task in one reply. Step allowances went from
    2/4/6 to 4/6/8 (max 8). The assembler had handed in unsaved pages six times, its four steps
    spent re-reading files.
  - `archive-trace-files.mjs --private` also archives an abandoned objective's private drafts.
- Test 4, third run ($1.03, 5 min 19 s, accepted on the first review). Remaining waste:
  - **Reviewers see the saved files.** Feedback now gets the files the work saved, as they are on
    disk. That includes files from a report's own reports, so a manager reviewing a worker's
    output sees it too. The reviewer no longer asks for read-backs. It judges substance, not
    formatting: the Finance section went round three times over "three headings, criteria say
    exactly two", which was $0.48 of the run. Leaders write content criteria, and agents and
    workers are told their reviewer sees the files. The handbook says so, so new hires learn it
    from day one.
  - **Replies are told their size.** Sixteen JSON replies filled whatever room they had, were cut
    off and were asked again, costing 22% of the run. Each stage now states its word budget up front.
  - **Short report to the Board.** The summary, "Open points for the Board" (a new Feedback field),
    the files saved, and one line per contribution. Before, every contribution was pasted in full,
    with nested reports.
  - **Old drafts archived.** `scripts/maintenance/archive-trace-files.mjs` moves the drive files of
    abandoned objectives to `/data/archive/`. It is reversible.
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
- Hiring: managers hire, and recruiters source candidates (founder's choice after test 5).
  - **Who hires.** The head of the team a new hire joins makes the hire. `hire_agent` takes a
    monthly budget and a first task. The first task is assigned at once, or when the Board
    approves the hire. The hiring manager waits for it and reviews it.
  - **Recruiters search the catalog.** Recruiters get `catalog_search`. Existing ones get it at
    the next start.
  - **Planning follows the hiring flow.** It sends a person the request names (e.g. "Jasmine…")
    to the direct report whose team they are in. It splits a hiring request into sourcing by
    People (round 1) and the hire by the receiving department's head (round 2).
  - **Brains can actually hire.** `hire_agent` was never offered in Solving. It now is, on
    hiring tasks only.
  - **The handbook explains hiring,** so new hires learn the rule.
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
