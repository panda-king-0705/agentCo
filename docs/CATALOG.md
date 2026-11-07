# Specialist catalog (agency-agents)

AgentCo's worker agents are staffed from **[msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)**
(MIT), a catalog of ~280 specialist agents. Each one is a markdown file with frontmatter (`name`,
`description`, `emoji`, `vibe`, `color`) and a body of sections (Identity & Memory, Core Mission,
Critical Rules, Technical Deliverables, Workflow, Success Metrics, …).

- **Workers** run with the specialist's compiled **playbook** in their system prompt.
- **Executives and managers** keep the brain engine and may carry a one-paragraph **domain expertise**
  line from a specialist in their charter.
- **New agents** can be hired straight from the catalog: by the Board (console / API) or by an
  executive's brain (`catalog_search` → `hire_agent {catalogId}`).

## Where things live

| path | what |
|---|---|
| `catalog/agency-agents/` | the vendored catalog, **unmodified**: every division's `*.md`, `LICENSE`, `divisions.json`, and `VENDOR.md` (source, commit, date, licence) |
| `scripts/update-catalog.mjs` | re-vendors from a clone: `node scripts/update-catalog.mjs <clone> [--commit <sha>]` |
| `catalog/division-map.json` | division → department mapping, per-specialist overrides, optional departments (data) |
| `apps/server/src/catalog/parse.ts` | frontmatter + section parser (pure) |
| `apps/server/src/catalog/compile.ts` | playbook and expertise compiler (pure) |
| `apps/server/src/catalog/service.ts` | `Catalog`: load once per process, list / search / detail / seeds, `CatalogView` for engines |
| `apps/server/src/org/templates.ts` | `ROLE_CATALOG` (role → specialist) and `AGENCY_STAFFING` (agency org) |
| `apps/web/src/views/catalog.tsx` | console: Catalog view, detail drawer, Hire into…, org-chart "From catalog" tab, agent playbook panel |

Only the directories listed in `divisions.json` are vendored; `strategy/`, `integrations/`, `examples/`
and `scripts/` are not agent divisions (see the `_note` there). Vendored at commit
`b37b5bb33b78f2c1d6567d98e25ca818e3259219`: 283 agents in 18 divisions.

## Loading and parsing

The catalog is read once per process at boot (`createCatalog`, cached by directory), from
`CATALOG_DIR` (default `<repo>/catalog/agency-agents`). A missing directory is an empty catalog: the
platform still runs, workers just have no playbook, and catalog hires are refused (400).

Each file becomes a `CatalogAgent` (`packages/shared`):
`{ id: "division/slug", division, name, description, emoji, vibe, color, sections, wordCount }`, where
`sections = { identity, mission, rules, deliverables, workflow, metrics, other }`. Ids keep the
division and the file's slug even for nested folders (`game-development/unity/unity-architect.md` →
`game-development/unity-architect`).

- **Frontmatter.** Plain, single- and double-quoted scalars, `>`/`|` block scalars, plain values
  continued on indented lines, aligned values (`name:        X`) and nested lists (`services:`) are
  handled. Missing `---`, an unclosed block, no `name`, no `description` or an empty body make a file
  **malformed**: it is skipped and counted (`source.skipped`, logged once at boot), never fatal.
- **Sections.** Every `##` heading starts a section, classified by keywords (identity, rules,
  metrics, deliverables, workflow, mission, else other). `#` lines **inside fenced code** (deliverable
  templates are usually fenced markdown) are content, never headings. Text before the first `##`
  (the "You are **X** …" preamble) opens the identity section.

## The playbook compiler

`compilePlaybook(agent, maxTokens = 900)` turns a specialist into the text a worker carries. Workers
run on the economy tier and the prompt is paid on every step, so it is capped
(`CATALOG_PLAYBOOK_TOKENS`, default 900, estimated as chars/4 like every estimate in the platform)
and trimmed by section priority:

1. **Identity** (min 2 units, max 5): "Memory: you remember …" lines are dropped (the platform provides memory)
2. **Mission** (min 3, max 8)
3. **Critical rules** (min 4, max 14)
4. **Deliverable formats** (min 3, max 12): fenced templates become a one-line heading outline
   (`Template outline: PRD › 1. Problem Statement › …`), code examples are dropped

A unit is one bullet, sub-heading or paragraph (≤ 220 chars). Every part first gets its minimum,
then the remaining budget goes to the parts in priority order. Workflow, metrics and the rest stay in
the full text, which the console shows. The result (`CompiledPlaybook`) reports `tokens`,
`maxTokens`, `truncated` and the sections included; the cap holds for every vendored specialist at
900, 400 and 150 tokens (tested). Across the catalog the median playbook is ~750 tokens.

`compileExpertise` is the leaders' version: the description's first sentence and up to three critical
rules, ≤ 120 tokens, because a brain charter is paid on every cognitive stage.

## In the engines

`PlatformServices.catalog` (`CatalogView` in `contracts.ts`; optional for test fakes):

- **ReflexEngine.** `agentFacts()` adds `playbook` for workers with a `catalogId`; the reflex system
  prompt is *charter → playbook → task*. The mock provider's context block names the specialist.
- **BrainEngine.** `agentFacts()` adds `expertise` for executives/managers with a `catalogId`;
  `renderCharter` appends it as the last charter line.
- **Role Arrangement.** For a worker with a `catalogId`, mandateFit's profile text also contains the
  specialist's description and mission (first 600 chars). The Q9 formula
  (`0.75·mandateFit + 0.25·mbtiFit`, ties within 0.05 broken by BaZi element fit) is unchanged.

## Worker → catalog mapping

Chosen by hand against each role's mandate and KPIs (`ROLE_CATALOG` in `org/templates.ts`). A
worker created from its role template gets the specialist's emoji, vibe and BIO/assets (playbook +
deliverable formats); the curated role seed keeps its style, traits and MBTI type.

| worker role | specialist | why |
|---|---|---|
| ops-coordinator | project-management/project-management-project-shepherd | cross-functional coordination, timelines, chasing blockers |
| support-l1 | specialized/customer-service | answers common questions in any industry; empathy-first rules |
| triage-agent | support/support-support-responder | tiered/priority routing and escalation procedures |
| fpa-analyst | finance/finance-fpa-analyst | exact match: budgeting, variance, forecasting |
| bookkeeper | finance/finance-bookkeeper-controller | reconciliation, close, books |
| backend-engineer | engineering/engineering-backend-architect | services, APIs, data models; API contract rules |
| frontend-engineer | engineering/engineering-frontend-developer | UI, dashboards, accessibility |
| qa-engineer | testing/testing-test-automation-engineer | regression suites, flake rate (a KPI of the role) |
| security-analyst | security/security-threat-detection-engineer | detections and false-positive rate, the role's KPIs |
| data-analyst | support/support-analytics-reporter | reports, dashboards and KPIs from raw data |
| spec-writer | product/product-manager | its PRD template is exactly requirements + acceptance criteria |
| ux-designer | design/design-ux-architect | layouts, flows and implementation-ready foundations |
| content-writer | marketing/marketing-content-creator | posts, docs, emails, editorial calendars |
| growth-analyst | marketing/marketing-growth-hacker | funnels and growth experiments |
| sdr-prospector | sales/sales-outbound-strategist | ICP definition, signal-based prospecting, qualification |
| account-executive | sales/sales-deal-strategist | MEDDPICC deal running and win plans |
| onboarding-agent | specialized/customer-success-manager | onboarding, activation, health scoring |
| recruiter-agent | specialized/hr-onboarding | onboarding new hires; the alternative, recruitment-specialist, is China-market specific |
| contracts-analyst | specialized/legal-document-review | contract review and summaries |
| market-researcher | product/product-trend-researcher | market intelligence and competitive analysis |

Leaders with domain expertise: chief-of-staff → specialized-chief-of-staff · internal-audit →
security-compliance-auditor · coo → operations-manager · operations-manager → studio-operations ·
cfo → chief-financial-officer · finance-manager → finance-financial-analyst · cto →
engineering-software-architect · eng-manager → engineering-code-reviewer · ciso → security-architect ·
security-manager → security-incident-responder · cdao → specialized-model-qa · data-manager →
engineering-data-engineer · cpo → product-manager · product-manager → product-sprint-prioritizer ·
cmo → design-brand-guardian · marketing-manager → marketing-pr-communications-manager · cro →
sales-pipeline-analyst · sales-manager → sales-coach · cs-manager → sales-account-strategist · chro →
organizational-psychologist · people-manager → corporate-training-designer · clo →
support-legal-compliance-checker · legal-manager → data-privacy-officer · cso → business-strategist.
The CEO and the Support Manager have none (no good match).

## Division → department mapping

`catalog/division-map.json` (tested: every division maps to a known department; every override names
a real specialist and department).

| division | AgentCo department |
|---|---|
| engineering | Engineering |
| testing | Engineering (QA) |
| design | Product & Design |
| product | Product & Design |
| project-management | Operations |
| marketing, paid-media | Marketing |
| sales | Sales & Customer Success |
| support | Customer Support |
| finance | Finance |
| security | Security (under the CTO; the CISO when hired) |
| research, academic | Strategy (academic-statistician → Data & AI) |
| specialized | placed one by one (see below); default Operations |
| game-development | **Game Studio** (optional; owner CTO, then CEO) |
| gis | **Geospatial** (optional; owner CDAO, then CTO, then CEO) |
| healthcare | **Healthcare Practice** (optional; owner CSO, then CEO) |
| spatial-computing | **Spatial Computing** (optional; owner CTO, then CEO) |

Per-specialist overrides: the *support* division also holds non-support specialists
(analytics-reporter → Data & AI, executive-summary-generator → Strategy, finance-tracker → Finance,
infrastructure-maintainer → Engineering, legal-compliance-checker → Legal & Compliance), and
product-trend-researcher → Strategy. All 59 *specialized* agents are placed by best fit, e.g.
accounts-payable → Finance, data-privacy-officer → Legal, hr-onboarding → People, customer-service →
Support, customer-success-manager → Sales & CS, specialized-chief-of-staff → Executive Office,
mcp-builder → Engineering, model-qa → Data & AI, healthcare-* → Healthcare / Support / Legal.

**Departments on demand.** A department that does not exist yet (any template department missing
from the startup org, such as Security, Data & AI, Strategy, or one of the optional ones) is created
when the first specialist is hired into it. Its head is its **lead**: the department's head when that
is an active executive/manager; else the holder of the template's head role or of an ancestor of it
(support-manager → COO); else the optional department's first present owner role; else the parent
department's lead; else the CEO. A worker is never a lead. Hiring through an approval creates nothing
until the Board approves.

## Hiring from the catalog

**API.**

```
GET  /api/catalog                 CatalogListResponse (?division=&q=): summaries, no section text; divisions; source
GET  /api/catalog/:id             CatalogAgentDetail: agent, full body, playbook, expertise, default placement
                                  (the id contains "/": send it URL-encoded, or as /api/catalog/:division/:slug)
POST /api/agents {catalogId, departmentId?, managerId?, name?, title?, …}
```

A catalog hire is a **worker / reflex / economy** agent with the specialist's title, description as
mandate, persona (style from its Communication Style section, traits from "Personality:", emoji,
vibe, an MBTI type suggested from its mission) and playbook. The department comes from the mapping
(created on demand); the manager defaults to that department's lead. Explicit fields win.

**Brain.** Executives, and recruiters (to recommend candidates to the hiring manager), get `catalog_search {query, division?}` (compact: id, name, department, one-line
description, how many are on staff) and `hire_agent` accepts `catalogId` (title/department/tier then
optional; the default manager must be the caller or in its subtree). The approval policy is unchanged:
an approval when `HIRING_REQUIRES_APPROVAL` is on or headcount is at the cap; the payload carries the
`catalogId`, and the agent is created on approval. Existing databases are backfilled at boot: agents
get their role's `catalogId`, and executives that can hire get `catalog_search`.

**Guards** (2026-11-07). One hire per role per *objective*: hire records are read across every task
under the same root, so a later step cannot ask for the same specialist again. If someone on the
receiving team already holds the catalog role, `hire_agent` refuses and names them, unless the
request explicitly asks for another person in that role (`additional: true`). When the request states
one monthly budget ("a $10 monthly budget"), that is the budget: a different figure is refused, and
an omitted one is filled in. `hire_agent` is offered only on steps that ask to hire, not on a
recruiter's recommendation step. The justification must name who recommended the pick only if they
did. `company_directory` shows each person's join date, hirer, monthly budget and catalog role, finds
people by catalog role, and looks up an agent id — including someone who has left. `managerId`
accepts "me" or a report's name. Hire records keep the budget and first task, and reviews (Feedback)
are shown every hire on the objective as verified evidence.

**Console.** `#/catalog` browses by division (optional departments are marked *new*) and searches; a
card opens a drawer with the compiled playbook (with its token meter) and the full text; *Hire into…*
picks department and manager. The org chart's Hire modal opens on a **From catalog** tab (the role
template form is the second tab). An agent staffed from a specialist shows a *Specialist playbook*
(workers) or *Domain expertise* (leaders) panel on its Overview tab.

## Agency org (`ORG_TEMPLATE=agency`)

The startup leadership and workers (19 agents) plus catalog specialists so that every department
has **2-4 specialists** (`AGENCY_STAFFING` in `org/templates.ts`): Executive Office 2, Operations 3,
Support 2, Finance 3, Engineering 4, Product & Design 4, Marketing 4, Sales & CS 4, People 2, Legal 2,
Security 2, Data & AI 2, Strategy 2. Specialists a startup worker already staffs count towards the set;
Security, Data & AI and Strategy are created on demand. That is **46 agents**, inside the default
`MAX_HEADCOUNT=60`; hires stop at `MAX_HEADCOUNT` (the rest are logged as skipped), so the cap always
holds. Like the other templates it applies at first boot only.

## Configuration

| variable | default | meaning |
|---|---|---|
| `CATALOG_DIR` | `<repo>/catalog/agency-agents` | vendored catalog directory |
| `CATALOG_PLAYBOOK_TOKENS` | `900` (150-8000) | worker playbook cap |
| `ORG_TEMPLATE` | `startup` | now also `agency` |

## Updating the catalog

```bash
git clone --depth 1 https://github.com/msitarzewski/agency-agents /tmp/agency-agents
node scripts/update-catalog.mjs /tmp/agency-agents
node --disable-warning=ExperimentalWarning --test "apps/server/test/core/catalog*.test.ts" apps/server/test/cognition/catalog-prompts.test.ts
```

The tests fail if a role's `catalogId`, an agency specialist or a mapping override disappeared
upstream, or a new division has no department.

## Known limits

- Section classification is keyword-based; a file with unusual headings may get a thin mission or
  rules part (the identity preamble always exists). The full text is always shown in the console.
- Playbooks are compiled from the vendored English text; a few specialists are market-specific
  (China platforms, US federal), which the mapping avoids for template roles.
- Agents keep a `catalogId`, not a snapshot: re-vendoring changes the playbook of existing agents on
  the next boot (by design; pin a commit in `VENDOR.md` to control this).
