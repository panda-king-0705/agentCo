# 01 - Dashboard and multi-agent platform references

Checked 2026-11-04. Repos were shallow-cloned and read directly (licenses, schemas, UI page lists). Star counts could not be read live (the GitHub API is blocked in this sandbox), so figures below are dated third-party snapshots; "n/v" means not verified.

## 1. Project survey

| Project | License (from repo) | Stars (snapshot) | Status |
|---|---|---|---|
| paperclipai/paperclip | MIT | ~71k, late Jun 2026 (third-party review) | Very active; last commit 2026-11-04 |
| disler/claude-code-hooks-multi-agent-observability | none in repo (GitHub shows null) | ~806, Jan 2026 snapshot | Last commit Feb 2026; treat as ideas only, no license to copy |
| langfuse/langfuse | MIT core; `ee/` dirs carry separate terms; now owned by ClickHouse (Jan 2026) | n/v | Very active |
| Arize-ai/phoenix | Elastic License 2.0 (source-available, not OSI; cannot be offered as a managed service) | n/v (a 2025 snapshot said ~4.8k; Arize has since posted a 10k milestone) | Very active |
| AgentOps-AI/agentops | MIT | n/v | Last commit Jun 2026, slower |
| microsoft/autogen | CC-BY-4.0 docs + MIT code | ~57k, Apr 2026 | **Archived**; successor is Microsoft Agent Framework |
| FoundationAgents/MetaGPT | MIT | ~67k, Apr 2026 | Last commit Jan 2026; effort moved to the hosted MGX product |
| OpenBMB/ChatDev | Apache-2.0 | n/v | Active; v2.0 "DevAll" released Jan 2026 |
| crewAIInc/crewAI | MIT | ~48k, Apr 2026 | Very active |
| OneManCompany (1mancompany/onemancompany) | Apache-2.0 | n/v | Closest "AI company" simulator found |

## 2. What each offers (views, data model, UX ideas)

**Paperclip (closest analogue; read the source).**
- Screens (from `ui/src/pages`): Dashboard (plus a live variant), Org Chart, Agents and Agent Detail (tabs for budgets, costs, audit, tools, instructions, live run), Issues/Task detail, Goals, Projects, Routines, Approvals and a Decision Queue, Costs, Inbox ("what needs me"), Skills and Skill Studio, Team Catalog, Company Export/Import, Plugins, Run Transcript, Artifacts, Agent Chat and Board Chat, Timeline.
- Data model (`packages/db/src/schema`): `companies`, `agents` (role, status, reports-to), `goals` with ancestry, `issues` (tasks with parent, blockers, atomic checkout lock), `heartbeat_runs` plus `heartbeat_run_events`, `agent_wakeup_requests`, `agent_task_sessions` (resumable sessions), `cost_events`, `budget_policies` (scope, window, warn percent, hard stop) plus `budget_incidents`, `approvals` plus comments, `agent_config_revisions` (versioned, rollbackable), `activity_log`, `routines`.
- Ideas: a heartbeat is the unit of agent activity (wake on assignment, mention or schedule); budgets are scoped per company, agent, project and are enforced at wake time; hires and strategy changes need board approval; every config change is a revision; tool-gateway decisions are allow, deny, require-approval or rate-limited; export/import a whole company as a package. Reviews note weak output quality control, so we need our own QA stage.

**disler observability.** Pipeline: hook scripts POST events to a Bun server, SQLite (WAL), WebSocket, Vue client. Views: live event timeline with auto-scroll and stick-to-bottom, multi-select filters (app, session, event type), a live pulse chart, per-agent colour coding, chat transcript modal. Events cover all 12 Claude Code hook types, with tool_use_id and agent_id promoted to top-level fields. Idea: a dumb append-only event stream plus WebSocket fan-out gets a live feed cheaply.

**Langfuse.** Hierarchy: trace, observations, sessions, scores. Observation types: SPAN, EVENT, GENERATION, AGENT, TOOL, CHAIN, RETRIEVER, EMBEDDING, EVALUATOR, GUARDRAIL (read from `domain/observations.ts`). Views: traces table, trace detail with tree, timeline waterfall and agent-graph view, sessions (a conversation grouping many traces), users, scores, datasets and experiments, prompt management, custom dashboards. Ideas: typed observations so the UI picks an icon and colour per kind; sessions as the grouping above traces; scores attached to traces or observations; cost and latency computed per observation and rolled up.

**Phoenix.** Projects contain traces contain spans, with sessions on top. Uses OpenInference span kinds (LLM, CHAIN, TOOL, AGENT, RETRIEVER, EMBEDDING, RERANKER, GUARDRAIL, EVALUATOR). Strong on datasets, experiments, evals and a prompt playground. Idea: replay a stored LLM span in a playground with a different model, which suits our tier-tuning workflow.

**AgentOps.** Session-first model (a session is the root span). Views: session list, session drilldown with metadata, event graphs, waterfall and step-by-step replay, cost per session. Built on OpenTelemetry. Idea: "session replay" as a scrubber over the run.

**AutoGen / AutoGen Studio.** Archived, so only reference. Studio is a low-code team builder with a playground that streams message flow, and an explicit warning that it is a prototyping tool, not production. Idea: live message-flow view while a team runs.

**MetaGPT.** Roles (product manager, architect, project manager, engineer, QA) follow SOPs (`Code = SOP(Team)`) and communicate through a shared publish/subscribe message pool. No real dashboard in the OSS repo. Idea: define each role's inputs and outputs as typed artifacts (PRD, design, tasks) and let roles subscribe to artifact types.

**ChatDev 2.0.** Zero-code workflow platform: agents and stages arranged as a graph, run from a web console; the classic role-play software-company mode moved to a `chatdev1.0` branch. Idea: stages as nodes in a visual graph that doubles as the live run view.

**CrewAI.** Crews (role, goal, backstory agents) and Flows (event-driven orchestration). Tracing and the control plane sit in the commercial AMP product, so the OSS repo adds little UI. Idea: the role/goal/backstory trio as the agent-definition schema.

**OneManCompany and pixel-office projects** (OneManCompany, AgentOffice, claude-office, Bit Office; only OneManCompany was read in depth). A pixel-art office shows each employee at a desk in real time, plus a hierarchical task tree, multi-agent meetings the human CEO can join, diff reviews, an HR agent that hires from a marketplace, and quarterly performance reviews that can coach or dismiss. Licenses and stars for the others are n/v.

**OpenTelemetry GenAI conventions.** Now maintained in a **new repo, `open-telemetry/semantic-conventions-genai`**; the old `gen-ai` folders in the main semconv repo are deprecated and point there. Status: **Development** (names can still change). Agent spans: `create_agent`, `invoke_agent` (CLIENT or INTERNAL kind), `invoke_workflow`, `plan`, and `execute_tool` (with an "agent as a tool" refinement for handoffs). Span names: `invoke_agent {gen_ai.agent.name}`, `execute_tool {gen_ai.tool.name}`, `invoke_workflow {gen_ai.workflow.name}`; inference spans are named `{gen_ai.operation.name} {gen_ai.request.model}`. Provider attribute is `gen_ai.provider.name` (it replaced the older `gen_ai.system`).

## 3. Steal list (ranked)

1. **Heartbeat as the unit of work**: each agent wake is a run row (trigger, status, started/finished, cost) that anchors the whole trace (Paperclip).
2. **Typed spans with per-kind icon/colour** (agent, llm, tool, delegation, retrieval, eval, guardrail) (Langfuse, OpenInference).
3. **Waterfall plus tree plus agent-graph tabs** on every run detail page (Langfuse).
4. **Swimlane timeline, one lane per agent**, with delegation arrows between lanes (new; combines Langfuse timeline and disler colouring).
5. **Org chart as the home screen**, nodes showing live status, current task, spend today (Paperclip, OneManCompany).
6. **Scoped budgets with warn percent and hard stop**, burn-down bar per agent, department and company (Paperclip).
7. **Approval queue / "what needs me" inbox** for hires, spend overrides, and risky tool calls (Paperclip).
8. **Global kill switch plus per-agent pause/resume/terminate**, always visible, audit-logged.
9. **Live event feed over WebSocket** with sticky scroll, filters by agent/department/event type, and a pulse chart (disler).
10. **Goal ancestry on every task** so any span can answer "why was this done" (Paperclip).
11. **Config revisions with one-click rollback** for prompts, model tier, tools (Paperclip).
12. **Session replay scrubber** over a run (AgentOps).
13. **Scores/evals on spans** plus a "replay this LLM call on another model" action (Langfuse, Phoenix).
14. **Cost roll-up by agent, department, goal, model, tier** from per-call usage (Paperclip, Langfuse).
15. **Company export/import and ready-made team templates** (Paperclip), plus a visible pixel/office toggle as an optional skin (OneManCompany).

## 4. Recommended span attribute set

Keep OTel names verbatim where they exist; put our own under `agentco.*`. All `gen_ai.*` are Development status, so isolate them behind one mapping module.

| Span (`gen_ai.operation.name`) | Span name | Attributes |
|---|---|---|
| `invoke_workflow` (a goal or task tree) | `invoke_workflow {gen_ai.workflow.name}` | `gen_ai.workflow.name`, `gen_ai.conversation.id`, `agentco.goal.id`, `agentco.task.id` |
| `invoke_agent` (one agent wake / cognitive loop) | `invoke_agent {gen_ai.agent.name}` | `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.agent.version`, `gen_ai.agent.description`, `gen_ai.conversation.id`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `error.type`; ours: `agentco.agent.role`, `agentco.agent.tier`, `agentco.department`, `agentco.reports_to`, `agentco.heartbeat.trigger`, `agentco.run.id` |
| `plan` (brain stage: perceive, plan, reflect) | `plan {gen_ai.agent.name}` | `gen_ai.agent.id`, `agentco.loop.stage` |
| `chat` (LLM call) | `chat {gen_ai.request.model}` (per OTel) | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.request.max_tokens`, `gen_ai.request.temperature`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.usage.reasoning.output_tokens`, `server.address`, `error.type`; opt-in content via `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` (store by reference using the `*_ref` variants); ours: `agentco.cost.usd`, `agentco.model.tier`, `agentco.fallback.used` |
| `execute_tool` | `execute_tool {gen_ai.tool.name}` | `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`, `gen_ai.tool.description`, opt-in `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`, `error.type`; ours: `agentco.tool.policy_decision` (allow/deny/require_approval), `agentco.approval.id` |
| Delegation (agent-as-tool refinement) | `execute_tool delegate_task` | the `execute_tool` set plus `agentco.delegation.from_agent`, `agentco.delegation.to_agent`, `agentco.task.id`, `agentco.delegation.budget_usd` |
| `retrieval`, memory ops (`search_memory`, `create_memory`) | `{operation}` | `gen_ai.retrieval.query.text`, `gen_ai.data_source.id` |

Metrics worth emitting (names as in the new repo's docs): `gen_ai.client.operation.duration`, `gen_ai.client.inference.duration`, `gen_ai.invoke_agent.duration`, `gen_ai.execute_tool.duration`, plus the token-usage metrics in `gen-ai-token-metrics.md`. `gen_ai.usage.reasoning.output_tokens` is confirmed present in the new repo. The inference span name is `{gen_ai.operation.name} {gen_ai.request.model}`, e.g. `chat claude-sonnet-4-5`.

## Sources
- https://github.com/paperclipai/paperclip (cloned; README, `packages/db/src/schema`, `ui/src/pages`)
- https://fast.io/resources/paperclip-ai-review-2026.md
- https://github.com/disler/claude-code-hooks-multi-agent-observability
- https://awesome.ecosyste.ms/api/v1/projects/github.com%2Fdisler%2Fclaude-code-hooks-multi-agent-observability
- https://github.com/langfuse/langfuse
- https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability
- https://github.com/Arize-ai/phoenix
- https://arize.com/phoenix-10k/
- https://github.com/AgentOps-AI/agentops
- https://github.com/microsoft/autogen
- https://github.com/FoundationAgents/MetaGPT
- https://github.com/OpenBMB/ChatDev
- https://github.com/crewAIInc/crewAI
- https://fungies.io/top-github-repositories-ai-agent-frameworks-2026/
- https://github.com/1mancompany/onemancompany (README via https://cdn.jsdelivr.net/gh/1mancompany/onemancompany@main/README.md)
- https://github.com/open-telemetry/semantic-conventions-genai (docs/gen-ai/*.md)
- https://github.com/open-telemetry/semantic-conventions (CHANGELOG, deprecation pointer)
