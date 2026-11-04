# 02 - Organisational structure from the world's largest companies

Checked 2026-11-04. **Method and honesty note:** the ranking below is real (companiesmarketcap.com, cached 2026-11-04). Leadership pages were actually read for six companies (Apple, Microsoft, Meta, Alphabet, Walmart, Berkshire Hathaway). The other 44 were not read individually; frequencies below combine those six with general corporate-governance knowledge and are labelled approximate. Delegation thresholds and spans are recommended defaults, not sourced facts.

## 1. List used (top 50 by market cap, 2026-11-04)

NVIDIA, Apple, Microsoft, Alphabet, Amazon, TSMC, SpaceX, Saudi Aramco, Meta, Broadcom, Tesla, Eli Lilly, Berkshire Hathaway, Samsung, Walmart, Micron, JPMorgan Chase, AMD, Visa, SK Hynix, Exxon Mobil, Johnson & Johnson, ASML, Mastercard, AbbVie, CXMT, China Construction Bank, Tencent, Costco, Chevron, Palantir, Coca-Cola, Cisco, Agricultural Bank of China, Roche, Oracle, Procter & Gamble, UnitedHealth, Merck, ICBC, Bank of America, Home Depot, GE, Bank of China, Philip Morris, Intel, Applied Materials, Novartis, Shell, Morgan Stanley (cutoff about $291B). Mix: about 20 tech/semis, 8 banks, 6 pharma/health, 5 energy, rest consumer/industrial. The list differs from older rankings (SpaceX, Micron, SK Hynix and CXMT are now in the top 30).

## 2. Structural archetypes observed

| Archetype | Evidence | Lesson for AgentCo |
|---|---|---|
| Functional | Apple's leadership page is organised by function: hardware, software engineering, services, marketing, design, retail+people, plus CFO, COO, general counsel | Few product lines, so one shared function per discipline; simplest and cheapest |
| Divisional / segment | Walmart: separate CEOs for U.S., International and Sam's Club, each with its own CFO, people chief and merchandising chief, plus global corporate functions (legal, tech, security, audit, ethics, sustainability). Microsoft: a CEO of the commercial business under the Chairman/CEO; Alphabet: Google plus a Chief Business Officer | Add "business units" later; each unit gets its own mini-C-suite while shared services stay central |
| Decentralised holding | Berkshire's 10-K says operating subsidiaries are managed on an "unusually decentralized basis" with few centralised functions; the CEO is the chief operating decision maker | Useful model for agent *teams* that run semi-independently under a thin HQ |
| Matrix | Common in banks and pharma (function x region/product); not verified per company here | Avoid at start; agents handle dual reporting poorly. Use dotted lines only for audit, security, legal |

## 3. Recurring executive roles (approximate frequency)

| Role | Frequency in top-50 | Evidence |
|---|---|---|
| CEO, CFO | all | every page read |
| General Counsel / Chief Legal Officer | nearly all | Apple, Alphabet, Meta, Walmart |
| Chief People Officer / HR | most | Microsoft, Meta, Walmart; Apple folds it into "Retail + People" |
| Chief Marketing / Brand | most consumer and tech | Microsoft, Meta, Apple, Walmart US |
| COO | about half | Apple, Meta, Walmart segments; absent at Microsoft and Alphabet |
| CTO / Chief Technology | about half (tech and retail heavy) | Meta, Walmart |
| Product (CPO) | some, tech only | Meta |
| Revenue / Sales (CRO, Chief Business Officer) | some, B2B-leaning | Alphabet CBO, Microsoft commercial CEO, Apple VP worldwide sales |
| CISO / security | most large caps | Walmart; disclosure rules push this to the top |
| Chief Strategy / Growth / Corp Dev | some | Meta Chief Strategy Officer, Walmart Chief Growth Officer |
| Chief Data / AI Officer | emerging, some | Meta Chief AI Officer and Chief Data Officer; Walmart EVP AI acceleration |
| Chief Communications / Global Affairs | about half at C-level, else VP | Meta Chief Global Affairs; Apple VP communications |
| Chief Audit Executive | nearly all listed firms (stock-exchange rule) | Walmart; general knowledge elsewhere |
| CIO | declining as a separate role, often merged under CTO | general knowledge |

## 4. Standard departments and sub-teams (typical)

Engineering: platform, backend, frontend, QA, SRE/DevOps, security engineering. Product and Design: product management, UX, research. Marketing: brand, growth/performance, content, PR/communications. Sales: SDR, account executives, solutions engineering, customer success. Finance: FP&A, accounting, treasury, tax, procurement, investor relations. People: recruiting, learning and development, HR business partners, compensation. Legal: commercial contracts, compliance, IP, privacy. Operations: program management, process, vendor management. Support: tiers 1-3, knowledge base. Data and Analytics: BI, data engineering, ML/evals. Strategy and Corp Dev. Internal Audit (reports to the board's audit committee, not management).

## 5. Governance mechanisms that matter for agents

- **Board and committees:** audit, compensation and nominating/governance are universal (Meta's proxy shows "Audit & Privacy" and "Compensation, Nominating & Governance"); risk and technology committees are common in banks and tech. For AgentCo the human founder acts as the board, and the "approval queue" is the committee.
- **Delegation of authority:** spend and decision limits by level. Recommended defaults per action: worker up to $1, manager up to $25, executive up to $250, CEO up to $1,000, anything above or irreversible (hiring/firing agents, external contracts, public statements, legal commitments) goes to the human board. Make these configurable and enforce at the tool gateway.
- **Planning cycle:** annual plan, quarterly OKRs, monthly close, weekly business review, daily digest. Map each to a scheduled executive run (heartbeat) that reads KPIs and writes a decision log.
- **Separation of duties:** finance approves spend, security approves access, legal approves external commitments, internal audit samples all of it and reports to the board.
- **Span of control (rules of thumb, not sourced):** CEO 8-12 direct reports (Walmart's list is far longer, a warning sign); executives 3-8; managers 3-6 workers. Cap agent managers at about 6 because each report adds context cost.

## 6. Recommended canonical org for AgentCo (46 roles)

Board (human founder + approval queue) -> CEO. "Cog" = cognition: **brain** (high-level thinking, strong model) or **reflex** (cheap, low-level). Tier hint maps to report 03: F = frontier, S = standard, E = economy. Dotted lines: `internal-audit` to board; `ciso` and `clo` have a veto on risky actions.

| id | Title | Reports to | Tier | Mandate | KPIs | Cog / model |
|---|---|---|---|---|---|---|
| `ceo` | Chief Executive Officer | board | executive | Set goals, allocate budget, resolve cross-department conflicts | goal attainment; spend vs plan; decision latency | brain / F |
| `chief-of-staff` | Chief of Staff | ceo | manager | Route work, run cadences, quality gate for CEO | queue age; escalations resolved; briefing quality | brain / S |
| `internal-audit` | Internal Audit Lead | board | manager | Independent sampling of runs, spend and policy | findings closed; audit coverage; policy breaches | brain / S |
| `coo` | Chief Operating Officer | ceo | executive | Run day-to-day operations and workflows | on-time delivery; cycle time; cost per task | brain / F |
| `operations-manager` | Operations Manager | coo | manager | Scheduling, workflow health, vendor/tool ops | SLA hit rate; stuck tasks; tool uptime | brain / S |
| `ops-coordinator` | Operations Coordinator | operations-manager | worker | Dispatch and track tasks, chase blockers | tasks routed; blocker age; handoff errors | reflex / E |
| `support-manager` | Support Manager | coo | manager | Own customer support quality and escalation | CSAT; first-response time; escalation rate | brain / S |
| `support-l1` | Support Agent L1 | support-manager | worker | Answer common tickets from knowledge base | resolution rate; handle time; reopen rate | reflex / E |
| `triage-agent` | Ticket Triage Agent | support-manager | worker | Classify and route inbound requests | routing accuracy; latency; misroutes | reflex / E |
| `cfo` | Chief Financial Officer | ceo | executive | Budgets, cost control, financial reporting | burn vs budget; forecast error; cost per outcome | brain / F |
| `finance-manager` | Finance Manager | cfo | manager | Run FP&A, accounting, procurement | close time; variance; PO cycle time | brain / S |
| `fpa-analyst` | FP&A Analyst | finance-manager | worker | Track token and cash spend, forecasts, alerts | alert precision; forecast error; report timeliness | reflex / E |
| `bookkeeper` | Bookkeeper | finance-manager | worker | Record transactions, reconcile | reconciliation rate; posting errors; days to close | reflex / E |
| `cto` | Chief Technology Officer | ceo | executive | Architecture, platform, engineering delivery | deploy frequency; incident rate; tech debt | brain / F |
| `eng-manager` | Engineering Manager | cto | manager | Plan and review engineering work | cycle time; escaped defects; PR review time | brain / S |
| `backend-engineer` | Backend Engineer | eng-manager | worker | Implement services and APIs | PRs merged; test pass; defect rate | reflex / S* |
| `frontend-engineer` | Frontend Engineer | eng-manager | worker | Implement UI and dashboards | PRs merged; accessibility pass; defect rate | reflex / S* |
| `qa-engineer` | QA Engineer | eng-manager | worker | Test, regress, verify releases | coverage; bugs caught pre-release; flake rate | reflex / E |
| `ciso` | Chief Information Security Officer | cto | executive | Security policy, access, incident response | open vulns; MTTR; access-review completion | brain / F |
| `security-manager` | Security Manager | ciso | manager | Monitoring, access reviews, guardrails | alert triage time; false positives; policy coverage | brain / S |
| `security-analyst` | Security Analyst | security-manager | worker | Watch logs and tool calls for abuse | detections; false-positive rate; response time | reflex / S* |
| `cdao` | Chief Data and AI Officer | cto | executive | Data quality, evals, model and prompt performance | eval pass rate; data freshness; model cost per success | brain / F |
| `data-manager` | Data Manager | cdao | manager | Run analytics and evaluation pipelines | report timeliness; eval coverage; defects | brain / S |
| `data-analyst` | Data Analyst | data-manager | worker | Build reports and metrics from traces | query accuracy; turnaround; dashboard adoption | reflex / E |
| `cpo` | Chief Product Officer | ceo | executive | Product vision, roadmap, design | roadmap hit rate; adoption; satisfaction | brain / F |
| `product-manager` | Product Manager | cpo | manager | Specs, prioritisation, design reviews | spec quality; scope churn; ship rate | brain / S |
| `spec-writer` | Spec Writer | product-manager | worker | Draft requirements and acceptance criteria | specs accepted first pass; clarity score; turnaround | reflex / S* |
| `ux-designer` | UX Designer | product-manager | worker | Produce layouts and copy | design approvals; usability issues; rework | reflex / S* |
| `cmo` | Chief Marketing Officer | ceo | executive | Brand, demand, communications | pipeline sourced; brand reach; CAC | brain / F |
| `marketing-manager` | Marketing Manager | cmo | manager | Plan campaigns, content, PR | campaign ROI; content cadence; approvals | brain / S |
| `content-writer` | Content Writer | marketing-manager | worker | Draft posts, docs, emails | on-time output; edit distance; engagement | reflex / E |
| `growth-analyst` | Growth Analyst | marketing-manager | worker | Funnel analysis, experiments | experiments run; lift; report accuracy | reflex / E |
| `cro` | Chief Revenue Officer | ceo | executive | Sales, customer success, revenue | revenue vs plan; win rate; net retention | brain / F |
| `sales-manager` | Sales Manager | cro | manager | Pipeline and deal reviews | pipeline coverage; cycle length; forecast accuracy | brain / S |
| `sdr-prospector` | SDR Prospector | sales-manager | worker | Research and qualify leads | qualified leads; reply rate; data accuracy | reflex / E |
| `account-executive` | Account Executive | sales-manager | worker | Run deals, proposals | win rate; deal size; follow-up lag | reflex / S* |
| `cs-manager` | Customer Success Manager | cro | manager | Onboarding, renewals, health | retention; time to value; NPS | brain / S |
| `onboarding-agent` | Onboarding Agent | cs-manager | worker | Walk new customers through setup | activation rate; setup time; tickets per account | reflex / E |
| `chro` | Chief People Officer | ceo | executive | Agent lifecycle: hire, train, review, retire | time to productive; retention of agents; review completion | brain / F |
| `people-manager` | People Operations Manager | chro | manager | Run hiring, training, performance cycles | fill time; review SLA; training pass | brain / S |
| `recruiter-agent` | Recruiter Agent | people-manager | worker | Draft role specs, spawn and onboard agents | agents created on time; spec quality; rework | reflex / E |
| `clo` | General Counsel | ceo | executive | Contracts, compliance, privacy, IP | contract turnaround; compliance gaps; incidents | brain / F |
| `legal-manager` | Legal and Compliance Manager | clo | manager | Review commitments, run compliance checks | review SLA; policy coverage; exceptions | brain / S |
| `contracts-analyst` | Contracts Analyst | legal-manager | worker | Redline and summarise agreements | clauses flagged; turnaround; miss rate | reflex / S* |
| `cso` | Chief Strategy Officer | ceo | executive | Strategy, market intelligence, corp dev | strategic initiatives on track; decision quality; insight use | brain / F |
| `market-researcher` | Market Researcher | cso | worker | Gather competitor and market data | briefs delivered; source accuracy; freshness | reflex / E |

*S\* = reflex worker that should default to the standard tier because errors are costly (code, contracts, security, specs); everything else defaults to economy.

Counts: 12 executives, 14 managers (12 department managers plus chief of staff and internal audit), 20 workers = 46 roles; the two easiest cuts to reach 44 are `ops-coordinator` and `growth-analyst` (CEO has 10 direct reports: coo, cfo, cto, cpo, cmo, cro, chro, clo, cso, chief-of-staff).

**Optional expansion roles** (add when load justifies): `treasury-analyst`, `tax-analyst`, `procurement-buyer` (finance); `sre-engineer`, `devops-engineer`, `data-engineer` (tech); `solutions-engineer`, `partnerships-manager` (sales); `brand-designer`, `pr-writer`, `seo-specialist` (marketing); `learning-coach`, `agent-performance-reviewer` (people); `ip-counsel`, `privacy-officer` (legal); `cio` (only if IT sprawls); `chief-communications` (when external presence grows); `investor-relations`; `vendor-manager`; per-business-unit mini-C-suites (divisional pattern); a `board-secretary` agent to prepare approval packs.

## Sources
- https://companiesmarketcap.com/ (ranking, cached 2026-11-04)
- https://www.apple.com/leadership/
- https://news.microsoft.com/leadership/
- https://investor.atmeta.com/leadership-and-governance/
- https://www.sec.gov/Archives/edgar/data/1326801/000162828026025532/meta-20260416.htm (Meta proxy, committees)
- https://s206.q4cdn.com/479360582/files/doc_downloads/2026/GOOG_PXY_2026_WO27_WKV_WR-IR.pdf (Alphabet 2026 proxy)
- https://corporate.walmart.com/about/leadership
- https://www.berkshirehathaway.com/2025ar/2025ar.pdf (Berkshire 2025 annual report and 10-K)
- https://www.berkshirehathaway.com/owners.html
