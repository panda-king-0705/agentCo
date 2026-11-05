// Fixture data for the console's dev server. Plain JS, zero deps.
// Shapes follow packages/shared/src/index.ts exactly; the server mutates this state in memory.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Deterministic PRNG so screenshots are stable between runs. */
export function rng(seed = 7) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────── BaZi (八字五行) ─────────────────────────────
const STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const STEM_PY = ["jia", "yi", "bing", "ding", "wu", "ji", "geng", "xin", "ren", "gui"];
const STEM_EL = ["wood", "wood", "fire", "fire", "earth", "earth", "metal", "metal", "water", "water"];
const BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
const BRANCH_PY = ["zi", "chou", "yin", "mao", "chen", "si", "wu", "wei", "shen", "you", "xu", "hai"];
const BRANCH_EL = ["water", "earth", "wood", "wood", "earth", "fire", "fire", "earth", "metal", "metal", "earth", "water"];

export function castBaZi(iso) {
  const d = new Date(iso);
  const y0 = d.getUTCFullYear();
  const beforeLichun = d.getUTCMonth() < 1 || (d.getUTCMonth() === 1 && d.getUTCDate() < 4);
  const y = beforeLichun ? y0 - 1 : y0;
  const yearIdx = (((y - 4) % 60) + 60) % 60;
  const yearStem = yearIdx % 10;
  const yearBranch = yearIdx % 12;
  // Solar month: month starting ~4th of Feb is 寅 (index 2). Approximate boundary on the 6th.
  let m = d.getUTCMonth(); // 0 = Jan
  if (d.getUTCDate() < 6) m -= 1;
  const monthBranch = (((m + 1) % 12) + 12) % 12; // Jan → 丑(1), Feb → 寅(2)
  const monthOrdinal = (monthBranch - 2 + 12) % 12; // 寅 = 0
  const monthStem = (((yearStem % 5) * 2 + 2) + monthOrdinal) % 10;
  const days = Math.floor((Date.UTC(y0, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1900, 0, 1)) / DAY);
  const dayIdx = (((days + 10) % 60) + 60) % 60;
  const dayStem = dayIdx % 10;
  const dayBranch = dayIdx % 12;
  const hourBranch = Math.floor((d.getUTCHours() + 1) / 2) % 12;
  const hourStem = ((dayStem % 5) * 2 + hourBranch) % 10;
  const pairs = [
    [yearStem, yearBranch],
    [monthStem, monthBranch],
    [dayStem, dayBranch],
    [hourStem, hourBranch],
  ];
  const elements = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  for (const [s, b] of pairs) {
    elements[STEM_EL[s]] += 1;
    elements[BRANCH_EL[b]] += 1;
  }
  return {
    birth: iso,
    pillars: pairs.map(([s, b]) => STEMS[s] + BRANCHES[b]),
    pinyin: pairs.map(([s, b]) => `${STEM_PY[s]}-${BRANCH_PY[b]}`),
    dayMaster: STEMS[dayStem],
    dayMasterElement: STEM_EL[dayStem],
    elements,
  };
}

// ───────────────────────────── Org definition ─────────────────────────────

const DEPARTMENTS = [
  ["executive", "Executive Office", "#64707d", "Set direction, allocate budget, keep the company coherent", 30],
  ["engineering", "Engineering", "#2a78d6", "Build and run the product platform", 40],
  ["product", "Product", "#6250d6", "Decide what to build and why", 18],
  ["finance", "Finance", "#1baf7a", "Budgets, spend control and reporting", 12],
  ["operations", "Operations", "#c98500", "Run day-to-day operations and customer support", 16],
  ["marketing", "Marketing", "#e0608f", "Brand, demand and communications", 18],
  ["sales", "Sales", "#eb6834", "Pipeline, deals and partnerships", 16],
  ["people", "People", "#2e8b3a", "Hiring, performance and agent wellbeing", 10],
  ["legal", "Legal", "#9a6b3f", "Contracts, compliance and risk", 10],
];

// id, name, title, roleId, dept, manager, tier, cognition, modelTier, mbti, daysAgo, budget
const STARTUP_AGENTS = [
  ["ceo", "Ava Chen", "Chief Executive Officer", "ceo", "executive", null, "executive", "brain", "frontier", "ENTJ", 41, 40],
  ["cos", "Theo Park", "Chief of Staff", "chief-of-staff", "executive", "ceo", "manager", "brain", "standard", "ISTJ", 38, 15],
  ["cto", "Maya Okafor", "Chief Technology Officer", "cto", "engineering", "ceo", "executive", "brain", "frontier", "INTP", 40, 30],
  ["be", "Sam Rivera", "Backend Engineer", "backend-engineer", "engineering", "cto", "worker", "reflex", "standard", "ISTP", 33, 12],
  ["fe", "Lena Fischer", "Frontend Engineer", "frontend-engineer", "engineering", "cto", "worker", "reflex", "economy", "ISFP", 27, 10],
  ["cpo", "Jonas Weber", "Chief Product Officer", "cpo", "product", "ceo", "executive", "brain", "frontier", "INFJ", 40, 20],
  ["spec", "Priya Nair", "Spec Writer", "spec-writer", "product", "cpo", "worker", "reflex", "economy", "INTJ", 25, 6],
  ["cfo", "Ruth Adeyemi", "Chief Financial Officer", "cfo", "finance", "ceo", "executive", "brain", "frontier", "ISTJ", 39, 15],
  ["fpa", "Omar Haddad", "FP&A Analyst", "fpa-analyst", "finance", "cfo", "worker", "reflex", "economy", "ESTJ", 30, 5],
  ["coo", "Kenji Sato", "Chief Operating Officer", "coo", "operations", "ceo", "executive", "brain", "frontier", "ESTJ", 39, 18],
  ["sup", "Grace Liu", "Support Agent L1", "support-l1", "operations", "coo", "worker", "reflex", "economy", "ESFJ", 22, 6],
  ["cmo", "Elena Rossi", "Chief Marketing Officer", "cmo", "marketing", "ceo", "executive", "brain", "frontier", "ENFJ", 38, 18],
  ["cw", "Noah Brooks", "Content Writer", "content-writer", "marketing", "cmo", "worker", "reflex", "economy", "ENFP", 20, 6],
  ["cro", "Diego Morales", "Chief Revenue Officer", "cro", "sales", "ceo", "executive", "brain", "frontier", "ESTP", 37, 18],
  ["sdr", "Fatima Zahra", "Sales Development Rep", "sdr", "sales", "cro", "worker", "reflex", "economy", "ESFP", 19, 5],
  ["chro", "Hannah Kim", "Chief People Officer", "chro", "people", "ceo", "executive", "brain", "frontier", "ENFJ", 36, 12],
  ["rec", "Lucas Petit", "Recruiter", "recruiter", "people", "chro", "worker", "reflex", "economy", "ENTP", 15, 5],
  ["gc", "Isabel Duarte", "General Counsel", "general-counsel", "legal", "ceo", "executive", "brain", "frontier", "INTJ", 35, 12],
  ["qa", "Iris Novak", "QA Engineer", "qa-engineer", "engineering", "cto", "worker", "reflex", "economy", "ISTJ", 29, 6],
];

// Extra roles for the enterprise org (~45 agents). Managers slot between execs and workers.
const ENTERPRISE_EXTRA = [
  ["engm", "Rafael Costa", "Engineering Manager", "eng-manager", "engineering", "cto", "manager", "brain", "standard", "ENTJ", 34, 14],
  ["ciso", "Mei Tanaka", "Chief Information Security Officer", "ciso", "engineering", "cto", "executive", "brain", "frontier", "INTJ", 34, 16],
  ["secm", "Arjun Mehta", "Security Manager", "security-manager", "engineering", "ciso", "manager", "brain", "standard", "ISTJ", 30, 10],
  ["seca", "Olga Ivanova", "Security Analyst", "security-analyst", "engineering", "secm", "worker", "reflex", "standard", "ISTP", 26, 6],
  ["cdao", "Kwame Mensah", "Chief Data and AI Officer", "cdao", "engineering", "cto", "executive", "brain", "frontier", "INTP", 33, 16],
  ["datam", "Sofia Lindqvist", "Data Manager", "data-manager", "engineering", "cdao", "manager", "brain", "standard", "ESTJ", 28, 10],
  ["dataa", "Ben Carter", "Data Analyst", "data-analyst", "engineering", "datam", "worker", "reflex", "economy", "INTJ", 24, 5],
  ["be2", "Yuki Mori", "Backend Engineer", "backend-engineer", "engineering", "engm", "worker", "reflex", "standard", "INTP", 21, 10],
  ["pm", "Chloe Martin", "Product Manager", "product-manager", "product", "cpo", "manager", "brain", "standard", "ENFJ", 31, 10],
  ["ux", "Ali Hassan", "UX Designer", "ux-designer", "product", "pm", "worker", "reflex", "standard", "INFP", 23, 6],
  ["finm", "Laura Becker", "Finance Manager", "finance-manager", "finance", "cfo", "manager", "brain", "standard", "ISTJ", 32, 8],
  ["book", "Tom Walsh", "Bookkeeper", "bookkeeper", "finance", "finm", "worker", "reflex", "economy", "ISFJ", 22, 4],
  ["opsm", "Nadia Petrova", "Operations Manager", "operations-manager", "operations", "coo", "manager", "brain", "standard", "ESTJ", 31, 9],
  ["opsc", "Marco Bianchi", "Operations Coordinator", "ops-coordinator", "operations", "opsm", "worker", "reflex", "economy", "ESFJ", 20, 4],
  ["supm", "Zoe Adams", "Support Manager", "support-manager", "operations", "coo", "manager", "brain", "standard", "ENFJ", 30, 9],
  ["tri", "Ethan Wright", "Ticket Triage Agent", "triage-agent", "operations", "supm", "worker", "reflex", "economy", "ISTJ", 18, 3],
  ["sup2", "Amara Obi", "Support Agent L1", "support-l1", "operations", "supm", "worker", "reflex", "economy", "ESFJ", 17, 4],
  ["grow", "Pablo Ruiz", "Growth Manager", "growth-manager", "marketing", "cmo", "manager", "brain", "standard", "ENTP", 29, 9],
  ["seo", "Ingrid Berg", "SEO Specialist", "seo-specialist", "marketing", "grow", "worker", "reflex", "economy", "INTJ", 16, 4],
  ["salm", "Victor Lam", "Sales Manager", "sales-manager", "sales", "cro", "manager", "brain", "standard", "ESTJ", 29, 9],
  ["ae", "Julia Santos", "Account Executive", "account-executive", "sales", "salm", "worker", "reflex", "standard", "ENFP", 18, 6],
  ["tal", "Ryan O'Neil", "Talent Partner", "talent-partner", "people", "chro", "manager", "brain", "standard", "ENFJ", 27, 7],
  ["para", "Clara Vogel", "Paralegal", "paralegal", "legal", "gc", "worker", "reflex", "economy", "ISTJ", 21, 4],
  ["audit", "Samuel Green", "Internal Audit Lead", "internal-audit", "executive", "ceo", "manager", "brain", "standard", "INTJ", 32, 8],
  ["sec2", "Leah Cohen", "Security Analyst", "security-analyst", "engineering", "secm", "worker", "reflex", "standard", "INTP", 14, 6],
  ["fe2", "Hugo Laurent", "Frontend Engineer", "frontend-engineer", "engineering", "engm", "worker", "reflex", "economy", "ISFP", 13, 8],
];
// In the enterprise org the startup engineers report to the eng manager.
const ENTERPRISE_REPARENT = { be: "engm", fe: "engm", qa: "engm", spec: "pm", sup: "supm" };

const IDENTITY = {
  ceo: {
    worldview: "A company is a portfolio of bets; my job is to fund the ones with the best value per dollar and kill the rest early.",
    lifeView: "Good work compounds when the team trusts the plan and the numbers.",
    values: ["Clarity over consensus", "Spend like it's ours", "Report honestly upward"],
    vision: "A company that ships weekly, profitably, with every decision traceable.",
    okrs: [
      { objective: "Launch self-serve revenue", keyResults: [
        { description: "Pricing page live", target: 1, current: 0, unit: "launch" },
        { description: "Paying self-serve accounts", target: 25, current: 6, unit: "accounts" },
      ] },
      { objective: "Run the company inside budget", keyResults: [
        { description: "Monthly model spend", target: 100, current: 61, unit: "USD" },
      ] },
    ],
    narrative: "I turned the Board's pricing request into three workstreams within a minute and kept spend under plan. I tend to over-delegate to Engineering; this week I am checking estimates against actuals before I commit.",
    assets: ["Company strategy memo v3", "Q4 operating plan", "Delegation playbook"],
    resourceConnections: ["Board (human)", "All C-suite", "Company blackboard"],
  },
  cos: {
    worldview: "Most delays are routing problems, not capacity problems.",
    lifeView: "A calm queue is a kindness to everyone downstream.",
    values: ["Close loops", "Write it down", "No surprise escalations"],
    vision: "Every request answered or routed within one heartbeat.",
    okrs: [{ objective: "Keep the CEO's queue short", keyResults: [{ description: "Median queue age", target: 10, current: 14, unit: "min" }] }],
    narrative: "I keep the CEO's queue under fifteen minutes. Briefings land on time; I still miss context when execs DM each other directly.",
    assets: ["Weekly briefing template"], resourceConnections: ["CEO", "C-suite"],
  },
  cto: {
    worldview: "Small reversible changes beat big careful ones. Tests are the spec that cannot drift.",
    lifeView: "Engineering is a craft of making the next change cheap.",
    values: ["Ship small", "Measure before optimising", "Own the incident"],
    vision: "A platform where any agent can ship a safe change in an hour.",
    okrs: [
      { objective: "Ship the pricing platform", keyResults: [
        { description: "Pricing API endpoints live", target: 3, current: 1, unit: "endpoints" },
        { description: "Checkout regression pass rate", target: 100, current: 82, unit: "%" },
      ] },
      { objective: "Keep delivery cheap", keyResults: [{ description: "Cost per merged change", target: 0.5, current: 0.62, unit: "USD" }] },
    ],
    narrative: "I split the pricing launch into API and UI work and paired each with acceptance tests. The regression suite flaked twice, so I now ask for a premortem before any checkout change.",
    assets: ["Platform architecture doc", "Checkout service", "CI pipeline"],
    resourceConnections: ["Backend Engineer", "Frontend Engineer", "CPO", "Shared drive"],
  },
  cpo: {
    worldview: "Users tell you the problem, rarely the solution.",
    lifeView: "The best product decision is the one we can explain in one sentence.",
    values: ["Evidence first", "Fewer, better features", "Write the spec before the code"],
    vision: "Every shipped feature has a measurable user outcome.",
    okrs: [{ objective: "Make pricing obvious", keyResults: [{ description: "Plans understood in usability test", target: 90, current: 70, unit: "%" }] }],
    narrative: "I finished a teardown of three competitor pricing pages; the clearest one had three plans and no toggles. I am pushing for that.",
    assets: ["Pricing teardown", "Persona set"], resourceConnections: ["Spec Writer", "CTO", "CMO"],
  },
  cfo: {
    worldview: "Every token is a purchase order. Margin is a design constraint, not an afterthought.",
    lifeView: "Numbers are how a company tells itself the truth.",
    values: ["Accuracy", "Conservatism in forecasts", "Transparent spend"],
    vision: "Spend that always maps to value delivered.",
    okrs: [{ objective: "Hold gross margin above 80%", keyResults: [{ description: "Gross margin", target: 80, current: 84, unit: "%" }] }],
    narrative: "I modelled three price points; the middle one clears an 84% margin at expected usage. Forecast error was 6% last week.",
    assets: ["Pricing model v2", "Spend dashboard"], resourceConnections: ["FP&A Analyst", "CEO"],
  },
  coo: {
    worldview: "Operations is the art of making the normal case boring.",
    lifeView: "Reliability is a promise kept every day.",
    values: ["Customers first", "Runbooks over heroics", "Escalate early"],
    vision: "No customer waits more than an hour for a useful answer.",
    okrs: [{ objective: "Fast, accurate support", keyResults: [{ description: "First response time", target: 30, current: 42, unit: "min" }] }],
    narrative: "Acme asked for a discount outside policy, so I escalated to the Board instead of guessing.",
    assets: ["Support runbook"], resourceConnections: ["Support Agent L1", "CRO"],
  },
  cmo: {
    worldview: "Positioning is a choice of what not to say.",
    lifeView: "A brand is a promise repeated until it is believed.",
    values: ["Specific beats clever", "One message per page", "Respect the reader"],
    vision: "People describe us the way we describe ourselves.",
    okrs: [{ objective: "Launch pricing loudly", keyResults: [{ description: "Launch post published", target: 1, current: 1, unit: "post" }, { description: "Signups in launch week", target: 200, current: 0, unit: "signups" }] }],
    narrative: "The launch post is done and on-brand. I asked for more budget to run two headline tests.",
    assets: ["Brand voice guide", "Launch post draft"], resourceConnections: ["Content Writer", "CPO"],
  },
  cro: {
    worldview: "Revenue is a lagging indicator of trust.",
    lifeView: "Win deals you would be proud to renew.",
    values: ["Qualify hard", "Follow up fast", "Never overpromise"],
    vision: "A pipeline that refills itself from happy customers.",
    okrs: [{ objective: "Build design-partner pipeline", keyResults: [{ description: "Qualified leads", target: 40, current: 12, unit: "leads" }] }],
    narrative: "I drafted a 40-lead outbound sequence; it needs the Board's sign-off before anything leaves the building.",
    assets: ["ICP definition", "Outbound sequence"], resourceConnections: ["SDR", "CMO"],
  },
  chro: {
    worldview: "The right role for an agent matters more than the smartest agent.",
    lifeView: "People thrive where they are trusted with clear work.",
    values: ["Fair process", "Clear roles", "Feedback within a day"],
    vision: "Every agent knows its mandate and its manager.",
    okrs: [{ objective: "Fill the QA seat", keyResults: [{ description: "QA engineer hired", target: 1, current: 0, unit: "hire" }] }],
    narrative: "The QA seat has been open since Iris was terminated. Screening failed twice on cost limits; I am narrowing the brief.",
    assets: ["Role templates"], resourceConnections: ["Recruiter", "CTO"],
  },
  gc: {
    worldview: "Good contracts make the risky thing boring.",
    lifeView: "Protect the company without slowing it down.",
    values: ["Plain language", "Least privilege", "Document decisions"],
    vision: "Every vendor and model provider under a reviewed agreement.",
    okrs: [{ objective: "Cover our providers", keyResults: [{ description: "DPAs reviewed", target: 4, current: 2, unit: "DPAs" }] }],
    narrative: "Two of four provider agreements are reviewed; the next one has an unusual data-retention clause.",
    assets: ["DPA checklist"], resourceConnections: ["CFO", "CTO"],
  },
};

const MANDATES = {
  ceo: "Set goals, allocate budget, resolve cross-department conflicts",
  "chief-of-staff": "Route work, run cadences, quality gate for the CEO",
  cto: "Architecture, platform and engineering delivery",
  "backend-engineer": "Implement services and APIs",
  "frontend-engineer": "Implement UI and dashboards",
  "qa-engineer": "Test, regress and verify releases",
  cpo: "Product vision, roadmap and design",
  "spec-writer": "Draft requirements and acceptance criteria",
  cfo: "Budgets, cost control and financial reporting",
  "fpa-analyst": "Track token and cash spend, forecasts and alerts",
  coo: "Run day-to-day operations and workflows",
  "support-l1": "Answer common tickets from the knowledge base",
  cmo: "Brand, demand and communications",
  "content-writer": "Write posts, pages and launch copy",
  cro: "Pipeline, deals and partnerships",
  sdr: "Research and qualify leads",
  chro: "Hiring, roles and performance",
  recruiter: "Source and screen candidates",
  "general-counsel": "Contracts, compliance and risk",
};

export const ROLE_TEMPLATES = [
  // id, title, dept, reportsTo, tier, cognition, modelTier, mandate, kpis, starter, names
  ["ceo", "Chief Executive Officer", "executive", null, "executive", "brain", "frontier", ["goal attainment", "spend vs plan"], true],
  ["chief-of-staff", "Chief of Staff", "executive", "ceo", "manager", "brain", "standard", ["queue age", "escalations resolved"], true],
  ["cto", "Chief Technology Officer", "engineering", "ceo", "executive", "brain", "frontier", ["deploy frequency", "incident rate"], true],
  ["eng-manager", "Engineering Manager", "engineering", "cto", "manager", "brain", "standard", ["cycle time", "escaped defects"], false],
  ["backend-engineer", "Backend Engineer", "engineering", "eng-manager", "worker", "reflex", "standard", ["PRs merged", "test pass"], true],
  ["frontend-engineer", "Frontend Engineer", "engineering", "eng-manager", "worker", "reflex", "economy", ["PRs merged", "accessibility pass"], true],
  ["qa-engineer", "QA Engineer", "engineering", "eng-manager", "worker", "reflex", "economy", ["coverage", "bugs caught pre-release"], false],
  ["cpo", "Chief Product Officer", "product", "ceo", "executive", "brain", "frontier", ["roadmap hit rate", "adoption"], true],
  ["product-manager", "Product Manager", "product", "cpo", "manager", "brain", "standard", ["spec quality", "ship rate"], false],
  ["spec-writer", "Spec Writer", "product", "product-manager", "worker", "reflex", "economy", ["specs accepted first pass"], true],
  ["ux-designer", "UX Designer", "product", "product-manager", "worker", "reflex", "standard", ["design approvals"], false],
  ["cfo", "Chief Financial Officer", "finance", "ceo", "executive", "brain", "frontier", ["burn vs budget", "forecast error"], true],
  ["fpa-analyst", "FP&A Analyst", "finance", "finance-manager", "worker", "reflex", "economy", ["alert precision", "forecast error"], true],
  ["coo", "Chief Operating Officer", "operations", "ceo", "executive", "brain", "frontier", ["on-time delivery", "cost per task"], true],
  ["support-l1", "Support Agent L1", "operations", "support-manager", "worker", "reflex", "economy", ["resolution rate", "handle time"], true],
  ["cmo", "Chief Marketing Officer", "marketing", "ceo", "executive", "brain", "frontier", ["pipeline sourced", "CAC"], true],
  ["content-writer", "Content Writer", "marketing", "cmo", "worker", "reflex", "economy", ["posts shipped", "edit rounds"], true],
  ["cro", "Chief Revenue Officer", "sales", "ceo", "executive", "brain", "frontier", ["pipeline", "win rate"], true],
  ["sdr", "Sales Development Rep", "sales", "cro", "worker", "reflex", "economy", ["leads qualified", "reply rate"], true],
  ["chro", "Chief People Officer", "people", "ceo", "executive", "brain", "frontier", ["time to hire", "role clarity"], true],
  ["recruiter", "Recruiter", "people", "chro", "worker", "reflex", "economy", ["candidates screened"], true],
  ["general-counsel", "General Counsel", "legal", "ceo", "executive", "brain", "frontier", ["contracts reviewed", "policy breaches"], true],
  ["ciso", "Chief Information Security Officer", "engineering", "cto", "executive", "brain", "frontier", ["open vulns", "MTTR"], false],
  ["data-analyst", "Data Analyst", "engineering", "data-manager", "worker", "reflex", "economy", ["query accuracy"], false],
].map(([id, title, dept, reportsTo, tier, cognition, modelTier, kpis, starter]) => ({
  id,
  title,
  departmentSlug: dept,
  reportsToRoleId: reportsTo,
  tier,
  cognition,
  modelTier,
  mandate: MANDATES[id] ?? `Own the ${title.toLowerCase()} remit`,
  kpis,
  tools: toolsFor(tier),
  defaultNames: ["Alex Morgan", "Jordan Lee", "Riley Quinn"],
  inStarterOrg: starter,
}));

export function toolsFor(tier) {
  const base = ["send_message", "escalate", "memory_search", "memory_write", "blackboard_read", "workspace_write_file", "workspace_read_file", "workspace_list"];
  if (tier === "worker") return base;
  const mgr = [...base, "delegate_task", "ask_human", "blackboard_write"];
  return tier === "executive" ? [...mgr, "hire_agent", "catalog_search"] : mgr;
}

export const MODELS = {
  live: false,
  tiers: {
    frontier: { primary: "frontier-default", fallback: null },
    standard: { primary: "standard-default", fallback: null },
    economy: { primary: "economy-default", fallback: "economy-bulk" },
  },
  profiles: [
    { id: "frontier-default", provider: "mock", model: "mock-frontier", tier: "frontier", inputPerMTokUsd: 4, outputPerMTokUsd: 20, cachedInputPerMTokUsd: 0.2, contextWindow: 1_000_000, supportsTools: true },
    { id: "standard-default", provider: "mock", model: "mock-standard", tier: "standard", inputPerMTokUsd: 2, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 0.1, contextWindow: 1_000_000, supportsTools: true },
    { id: "economy-default", provider: "mock", model: "mock-economy", tier: "economy", inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.5, cachedInputPerMTokUsd: 0.01, contextWindow: 1_000_000, supportsTools: true },
    { id: "economy-bulk", provider: "mock", model: "mock-economy-bulk", tier: "economy", inputPerMTokUsd: 0.03, outputPerMTokUsd: 0.13, cachedInputPerMTokUsd: null, contextWindow: null, supportsTools: true },
  ],
  stageRouting: {
    "metacognition.target_understanding.problem_definition": "economy",
    "metacognition.target_understanding.analysis": "standard",
    "metacognition.confidence": "economy",
    "metacognition.cognitive_control": "agent",
    "metacognition.monitoring.reverse_thinking": "economy",
    "metacognition.solving_evaluation.solving": "agent",
    "metacognition.solving_evaluation.feedback": "standard",
    "metacognition.project_management.reflection_replanning": "economy",
    "metacognition.project_management.online_learning": "economy",
    "self_management.identity.self_narrative": "economy",
    "chat.reply": "standard",
    "reflex.step": "agent",
  },
};
export const LIVE_MODELS = {
  ...MODELS,
  live: true,
  profiles: [
    { id: "frontier-default", provider: "anthropic", model: "claude-opus-5.5", tier: "frontier", inputPerMTokUsd: 4, outputPerMTokUsd: 20, cachedInputPerMTokUsd: 0.2, contextWindow: 1_000_000, supportsTools: true },
    { id: "standard-default", provider: "anthropic", model: "claude-sonnet-5.5", tier: "standard", inputPerMTokUsd: 2, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 0.1, contextWindow: 1_000_000, supportsTools: true },
    { id: "economy-default", provider: "anthropic", model: "claude-haiku-5.5", tier: "economy", inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.5, cachedInputPerMTokUsd: 0.01, contextWindow: 1_000_000, supportsTools: true },
    { id: "economy-bulk", provider: "ark", model: "qwen3.7-flash", tier: "economy", inputPerMTokUsd: 0.03, outputPerMTokUsd: 0.13, cachedInputPerMTokUsd: null, contextWindow: null, supportsTools: true },
  ],
};

export const BRAIN_SEQUENCE = [
  ["todo_list", "Selecting the next subprocess from the TODO list", "thinking"],
  ["self_management.identity.self_identity", "Loading identity charter", "thinking"],
  ["self_management.identity.motivation", "Checking needs and drives", "thinking"],
  ["metacognition.target_understanding.problem_definition", "Defining the problem and success criteria", "thinking"],
  ["metacognition.target_understanding.literature_review", "Recalling related memories and subtask results", "acting"],
  ["metacognition.target_understanding.analysis", "Analysing 3 perspectives", "thinking"],
  ["metacognition.self_ability", "Assessing competence: model, tools, budget", "thinking"],
  ["metacognition.monitoring.ood", "Checking for out-of-distribution work", "thinking"],
  ["metacognition.monitoring.calibration", "Calibrating confidence", "thinking"],
  ["metacognition.confidence", "Estimating confidence and risk", "thinking"],
  ["metacognition.cognitive_control.decomposition", "Decomposing into subprocesses", "thinking"],
  ["metacognition.cognitive_control.candidate_solutions", "Drafting high-cost, low-cost and low-effect solutions", "thinking"],
  ["metacognition.project_management.data_driven_analysis", "Correcting estimates from past actuals", "thinking"],
  ["metacognition.project_management.economic_concepts", "Choosing the best-margin solution", "thinking"],
  ["metacognition.monitoring.reverse_thinking", "Running a premortem on the plan", "thinking"],
  ["metacognition.memory.local_working", "Writing the plan to working memory", "acting"],
  ["metacognition.solving_evaluation.solving", "Solving: running tools", "acting"],
  ["metacognition.solving_evaluation.feedback", "Evaluating the solution", "thinking"],
  ["metacognition.monitoring.truthful_efficient_good", "Scoring truthful, efficient, good", "thinking"],
  ["metacognition.project_management.online_learning", "Recording a lesson", "thinking"],
  ["global_memory.episodic", "Logging the episode", "acting"],
  ["self_management.sensibility_emotion", "Updating affect from the outcome", "thinking"],
  ["self_management.identity.okr", "Advancing OKR progress", "thinking"],
  ["self_management.identity.self_narrative", "Refreshing the self-narrative", "thinking"],
];

/** Blocks that call a model (economy/standard/agent tier) — the rest are computed. */
export const LLM_BLOCKS = {
  "metacognition.target_understanding.problem_definition": "economy",
  "metacognition.target_understanding.analysis": "standard",
  "metacognition.confidence": "economy",
  "metacognition.cognitive_control.decomposition": "agent",
  "metacognition.monitoring.reverse_thinking": "economy",
  "metacognition.solving_evaluation.solving": "agent",
  "metacognition.solving_evaluation.feedback": "standard",
  "metacognition.project_management.online_learning": "economy",
  "self_management.identity.self_narrative": "economy",
};

// ───────────────────────────── Builder ─────────────────────────────

export function createFixtureState({ org = "startup", live = false, now = Date.now() } = {}) {
  const rand = rng(11);
  const iso = (t) => new Date(t).toISOString();
  const S = {
    now,
    models: live ? LIVE_MODELS : MODELS,
    settings: {
      name: "AgentCo",
      mission: "Build a profitable product company run end to end by AI agents.",
      paused: false,
      dailyBudgetUsd: 5,
      monthlyBudgetUsd: 100,
      maxConcurrentRuns: 4,
      maxHeadcount: 60,
      hiringRequiresApproval: true,
      heartbeatMinutes: 0,
      orgTemplate: org,
    },
    departments: [],
    agents: [],
    tasks: [],
    runs: [],
    spans: [],
    conversations: [],
    messages: [],
    memories: [],
    blackboard: [],
    approvals: [],
    events: [],
    spend: [],
    history: { runs24h: [], monthBaseUsd: 0, agentMonthBase: {} },
    seq: 0,
    ids: {},
  };
  const nextId = (prefix) => {
    S.ids[prefix] = (S.ids[prefix] ?? 0) + 1;
    return `${prefix}_${String(S.ids[prefix]).padStart(3, "0")}`;
  };
  S.nextId = nextId;

  for (const [slug, name, color, mandate, budget] of DEPARTMENTS) {
    S.departments.push({ id: `dep_${slug}`, slug, name, mandate, parentId: null, headAgentId: null, color, monthlyBudgetUsd: budget, createdAt: iso(now - 42 * DAY) });
  }

  const defs = org === "enterprise" ? [...STARTUP_AGENTS, ...ENTERPRISE_EXTRA] : STARTUP_AGENTS;
  for (const d of defs) {
    const [key, name, title, roleId, dept, mgr, tier, cognition, modelTier, mbti, daysAgo, budget] = d;
    const manager = org === "enterprise" && ENTERPRISE_REPARENT[key] ? ENTERPRISE_REPARENT[key] : mgr;
    const createdAt = iso(now - daysAgo * DAY - Math.floor(rand() * 20) * HOUR);
    S.agents.push(makeAgent({ id: `agt_${key}`, name, title, roleId, departmentId: `dep_${dept}`, managerId: manager ? `agt_${manager}` : null, tier, cognition, modelTier, mbti, budget, createdAt, rand, now }));
  }
  for (const dep of S.departments) {
    const head = S.agents.find((a) => a.departmentId === dep.id && (a.tier === "executive" || a.roleId === "chief-of-staff"));
    dep.headAgentId = dep.slug === "executive" ? "agt_ceo" : head?.id ?? null;
  }

  // Catalog specialists (docs/CATALOG.md): workers carry a playbook (+ emoji/vibe), leaders domain expertise.
  for (const [key, catalogId] of Object.entries(FIXTURE_AGENT_CATALOG)) {
    const a = S.agents.find((x) => x.id === `agt_${key}`);
    const spec = CATALOG_AGENTS.find((c) => c[0] === catalogId);
    if (!a || !spec) continue;
    a.catalogId = catalogId;
    if (a.tier === "worker") Object.assign(a.persona, { emoji: spec[2], vibe: spec[3] });
  }
  S.catalog = buildCatalogFixture();

  // Lifecycle seeds: a terminated QA engineer kept for audit, a paused SDR, a struggling recruiter.
  const A = (k) => S.agents.find((a) => a.id === `agt_${k}`);
  Object.assign(A("qa"), { status: "terminated", terminatedAt: iso(now - 3 * DAY), activity: null });
  Object.assign(A("sdr"), { status: "paused", activity: "Paused by the Board" });
  Object.assign(A("rec").affect, { valence: -0.45, arousal: 0.62, frustration: 0.74 });
  Object.assign(A("rec"), { status: "error", activity: "Last run failed: budget limit hit while screening" });

  buildWork(S, now, rand);
  buildConversations(S, now);
  buildMemory(S, now, rand);
  buildApprovals(S, now);
  buildSpendHistory(S, now, rand);
  buildInitialEvents(S, now);
  return S;
}

export function makeAgent({ id, name, title, roleId, departmentId, managerId, tier, cognition, modelTier, mbti, budget, createdAt, rand = Math.random, now = Date.now() }) {
  const key = id.replace(/^agt_/, "");
  const ident = IDENTITY[key] ?? IDENTITY[roleId];
  const brain = cognition === "brain";
  const r = (lo, hi) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
  const identity = brain
    ? {
        mission: MANDATES[roleId] ?? `Lead ${title}`,
        worldview: ident?.worldview ?? "Clear mandates and honest reporting make delegation work.",
        lifeView: ident?.lifeView ?? "Do work that the next person can build on.",
        values: ident?.values ?? ["Own the outcome", "Ask early", "Keep it simple"],
        vision: ident?.vision ?? `A ${title.toLowerCase()} function that runs itself.`,
        desires: { taskDriven: r(0.55, 0.9), curiosity: r(0.3, 0.85), epistemic: r(0.45, 0.9), vision: r(0.4, 0.9) },
        motivation: { autonomy: r(0.5, 0.9), competence: r(0.55, 0.9), purpose: r(0.6, 0.95) },
        okrs: structuredClone(ident?.okrs ?? [{ objective: `Run ${title} well`, keyResults: [{ description: "Tasks closed on time", target: 20, current: Math.round(r(4, 16)), unit: "tasks" }] }]),
        narrative: ident?.narrative ?? `I lead ${title.toLowerCase()} work and report progress to my manager every cycle.`,
        assets: ident?.assets ?? ["Team charter"],
        resourceConnections: ident?.resourceConnections ?? ["Manager", "Direct reports"],
      }
    : {
        mission: MANDATES[roleId] ?? `Do ${title.toLowerCase()} work`,
        worldview: "",
        lifeView: "",
        values: ["Finish what I start", "Report blockers fast"],
        vision: "",
        desires: { taskDriven: 0.9, curiosity: 0.3, epistemic: 0.6, vision: 0.2 },
        motivation: { autonomy: 0.4, competence: 0.7, purpose: 0.6 },
        okrs: [],
        narrative: "",
        assets: [],
        resourceConnections: [],
      };
  const samples = brain ? Math.round(r(12, 40)) : Math.round(r(4, 30));
  const meanConfidence = r(0.58, 0.82);
  const successRate = Math.min(0.97, Math.max(0.45, meanConfidence + r(-0.18, 0.12)));
  return {
    id,
    name,
    title,
    roleId,
    catalogId: null,
    departmentId,
    managerId,
    tier,
    cognition,
    modelTier,
    modelOverride: null,
    status: "idle",
    activity: null,
    brainBlock: null,
    currentTaskId: null,
    currentRunId: null,
    identity,
    persona: {
      style: brain ? "Direct, numbers first, short paragraphs" : "Brief and factual",
      traits: brain ? ["decisive", "frugal", "candid"] : ["focused", "precise"],
      personalityType: mbti ?? null,
      baZi: castBaZi(createdAt),
    },
    affect: { valence: r(-0.1, 0.55), arousal: r(0.2, 0.7), frustration: r(0.02, 0.3) },
    calibration: { samples, meanConfidence, successRate: Math.round(successRate * 100) / 100, brier: r(0.08, 0.24) },
    tools: toolsFor(tier),
    monthlyBudgetUsd: budget ?? 10,
    createdBy: "system",
    createdAt,
    updatedAt: new Date(now - Math.floor(rand() * 40) * MIN).toISOString(),
    terminatedAt: null,
  };
}

function profileFor(S, tier) {
  return S.models.profiles.find((p) => p.id === S.models.tiers[tier].primary);
}

/** A span factory bound to a trace; returns the span and records spend for llm spans. */
function spanMaker(S, traceId, T0) {
  return (o) => {
    const startedAt = new Date(T0 + o.at).toISOString();
    const running = o.dur == null;
    const span = {
      id: S.nextId("spn"),
      traceId,
      parentSpanId: o.parent ?? null,
      kind: o.kind,
      name: o.name,
      status: o.status ?? (running ? "running" : "ok"),
      agentId: o.agent ?? null,
      runId: o.run ?? null,
      taskId: o.task ?? null,
      startedAt,
      endedAt: running ? null : new Date(T0 + o.at + o.dur).toISOString(),
      durationMs: running ? null : o.dur,
      input: o.input ?? null,
      output: o.output ?? null,
      error: o.error ?? null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      attributes: { ...(o.attrs ?? {}) },
    };
    if (o.block) span.attributes["agentco.brain.block"] = o.block;
    if (o.agent) {
      const ag = S.agents.find((a) => a.id === o.agent);
      if (ag) {
        span.attributes["gen_ai.agent.id"] = ag.id;
        span.attributes["gen_ai.agent.name"] = ag.name;
      }
    }
    if (o.kind === "llm") {
      const ag = S.agents.find((a) => a.id === o.agent);
      const tier = o.tier === "agent" || !o.tier ? ag?.modelTier ?? "standard" : o.tier;
      const prof = profileFor(S, tier);
      const inTok = o.inTok ?? 1800 + Math.round((o.dur ?? 2000) * 0.6);
      const outTok = o.outTok ?? 220 + Math.round((o.dur ?? 2000) * 0.08);
      const cost = (inTok * prof.inputPerMTokUsd + outTok * prof.outputPerMTokUsd) / 1e6;
      const front = profileFor(S, "frontier");
      const frontierCost = (inTok * front.inputPerMTokUsd + outTok * front.outputPerMTokUsd) / 1e6;
      Object.assign(span, { model: prof.model, inputTokens: inTok, outputTokens: outTok, costUsd: round6(cost) });
      Object.assign(span.attributes, {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": prof.provider,
        "gen_ai.request.model": prof.model,
        "gen_ai.usage.input_tokens": inTok,
        "gen_ai.usage.output_tokens": outTok,
        "agentco.tier": tier,
        "agentco.cost_usd": round6(cost),
      });
      if (span.status !== "running") {
        S.spend.push({ agentId: o.agent, runId: o.run ?? null, model: prof.model, tier, costUsd: cost, frontierCostUsd: frontierCost, inputTokens: inTok, outputTokens: outTok, at: span.endedAt ?? startedAt });
      }
    }
    if (o.kind === "tool") {
      span.attributes["gen_ai.operation.name"] = "execute_tool";
      span.attributes["gen_ai.tool.name"] = o.name.replace(/^tool\./, "");
    }
    S.spans.push(span);
    return span;
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function makeRun(S, { agent, task, trace, rootSpan, trigger = "task", status = "completed", at, dur, output = null, error = null, conv = null }) {
  const ag = S.agents.find((a) => a.id === agent);
  const run = {
    id: rootSpan.runId,
    agentId: agent,
    taskId: task ?? null,
    conversationId: conv,
    traceId: trace,
    rootSpanId: rootSpan.id,
    trigger,
    engine: ag?.cognition ?? "reflex",
    status,
    output,
    error,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    costUsd: 0,
    llmCalls: 0,
    toolCalls: 0,
    failingSpanId: null,
    startedAt: new Date(at).toISOString(),
    completedAt: dur == null ? null : new Date(at + dur).toISOString(),
    createdAt: new Date(at - 400).toISOString(),
  };
  S.runs.push(run);
  return run;
}

/** Recompute run usage/cost/failing span from its spans. */
export function rollupRun(S, run) {
  const spans = S.spans.filter((s) => s.runId === run.id);
  run.usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  run.costUsd = 0;
  run.llmCalls = 0;
  run.toolCalls = 0;
  for (const s of spans) {
    if (s.kind === "llm") {
      run.llmCalls++;
      run.usage.inputTokens += s.inputTokens ?? 0;
      run.usage.outputTokens += s.outputTokens ?? 0;
      run.costUsd += s.costUsd ?? 0;
    }
    if (s.kind === "tool") run.toolCalls++;
  }
  run.costUsd = round6(run.costUsd);
  const failing = spans.filter((s) => s.status === "error").sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
  run.failingSpanId = failing?.id ?? null;
  return run;
}

function makeTask(S, o) {
  const id = o.id ?? S.nextId("tsk");
  const number = S.tasks.length + 1;
  const parent = o.parent ? S.tasks.find((t) => t.id === o.parent) : null;
  const t = {
    id,
    number,
    traceId: o.trace ?? parent?.traceId,
    parentTaskId: parent?.id ?? null,
    rootTaskId: parent ? parent.rootTaskId : id,
    title: o.title,
    description: o.description ?? "",
    acceptanceCriteria: o.acceptance ?? null,
    createdBy: o.createdBy ?? (parent ? parent.assigneeId : "human"),
    assigneeId: o.assignee,
    departmentId: S.agents.find((a) => a.id === o.assignee)?.departmentId ?? null,
    status: o.status,
    value: o.value ?? 100,
    estCostUsd: o.est ?? 0.2,
    actualCostUsd: o.actual ?? 0,
    priority: 0,
    result: o.result ?? null,
    error: o.error ?? null,
    attempts: o.attempts ?? (o.status === "todo" ? 0 : 1),
    maxAttempts: 2,
    originConversationId: o.origin ?? null,
    state: o.state ?? {},
    createdAt: new Date(o.at).toISOString(),
    updatedAt: new Date(o.updated ?? o.at + 60_000).toISOString(),
    startedAt: o.status === "todo" ? null : new Date(o.at + 2000).toISOString(),
    completedAt: ["done", "failed", "cancelled"].includes(o.status) ? new Date(o.updated ?? o.at + 120_000).toISOString() : null,
  };
  t.priority = Math.round((t.value / Math.max(t.estCostUsd, 0.01)) * 100) / 100;
  S.tasks.push(t);
  return t;
}

/** One brain-agent run walking a list of blocks; llm children where the block calls a model. */
function brainRun(S, mk, { agent, task, trace, parent, at, blocks, trigger = "task", status = "completed", runStatus, extra = {} }) {
  const runId = S.nextId("run");
  let t = at;
  const rootSpan = mk({ kind: "run", name: `run ${S.agents.find((a) => a.id === agent)?.title}`, agent, run: runId, task, parent, at: t, dur: 1, attrs: { "agentco.run.trigger": trigger, "gen_ai.operation.name": "invoke_agent" } });
  const children = [];
  for (const b of blocks) {
    const [block, dur, opts = {}] = b;
    const stage = mk({ kind: b.kind ?? "stage", name: block.split(".").slice(-1)[0].replace(/_/g, " "), block, agent, run: runId, task, parent: rootSpan.id, at: t + 20, dur, status: opts.status, error: opts.error, attrs: { "agentco.stage": block, ...(opts.attrs ?? {}) }, input: opts.input ?? null, output: opts.output ?? null });
    stage.name = `brain.${block.replace(/^metacognition\.|^self_management\./, "")}`;
    if (LLM_BLOCKS[block] && !opts.noLlm) {
      mk({ kind: "llm", name: "llm.chat", agent, run: runId, task, parent: stage.id, at: t + 60, dur: Math.max(200, dur - 120), tier: LLM_BLOCKS[block], status: opts.llmStatus, input: opts.llmInput ?? `[[stage:${block}]] system charter + task context (redacted)`, output: opts.llmOutput ?? null });
    }
    if (block === "metacognition.target_understanding.literature_review") {
      mk({ kind: "memory", name: "memory.search", agent, run: runId, task, parent: stage.id, at: t + 40, dur: Math.max(60, dur - 80), attrs: { "gen_ai.retrieval.query.text": opts.query ?? "pricing launch", "agentco.memory.hits": 6 } });
    }
    for (const sub of opts.tools ?? []) {
      const tool = mk({ kind: "tool", name: `tool.${sub.tool}`, agent, run: runId, task, parent: stage.id, at: t + sub.at, dur: sub.dur, status: sub.status, error: sub.error ?? null, input: sub.input ?? null, output: sub.output ?? null, attrs: sub.attrs ?? {} });
      if (sub.delegateTo) {
        const del = mk({ kind: "delegation", name: `delegate → ${S.agents.find((a) => a.id === sub.delegateTo)?.title}`, agent, run: runId, task, parent: tool.id, at: t + sub.at + 20, dur: sub.dur - 40, attrs: { "agentco.delegate.to": sub.delegateTo, "agentco.task.id": sub.subtask ?? null, "agentco.delegation.from_agent": agent } });
        children.push({ to: sub.delegateTo, spanId: del.id, subtask: sub.subtask });
      }
    }
    children.push(stage);
    t += dur + 40;
  }
  const end = runStatus === "running" ? null : t;
  rootSpan.durationMs = end == null ? null : end - at;
  rootSpan.endedAt = end == null ? null : new Date(new Date(rootSpan.startedAt).getTime() + (end - at)).toISOString();
  rootSpan.status = status === "failed" ? "error" : runStatus === "running" ? "running" : "ok";
  const tStart = new Date(rootSpan.startedAt).getTime();
  const run = makeRun(S, { agent, task, trace, rootSpan, trigger, status: runStatus ?? status, at: tStart, dur: end == null ? null : end - at, ...extra });
  rollupRun(S, run);
  return { run, rootSpan, delegations: children.filter((c) => c.to), end: t };
}

/** One reflex-worker run: llm/tool loop. */
function reflexRun(S, mk, { agent, task, trace, parent, at, steps, trigger = "task", status = "completed", extra = {} }) {
  const runId = S.nextId("run");
  const rootSpan = mk({ kind: "run", name: `run ${S.agents.find((a) => a.id === agent)?.title}`, agent, run: runId, task, parent, at, dur: 1, attrs: { "agentco.run.trigger": trigger, "gen_ai.operation.name": "invoke_agent", "agentco.engine": "reflex" } });
  let t = at + 30;
  for (const s of steps) {
    if (s.llm) {
      mk({ kind: "llm", name: "llm.chat", agent, run: runId, task, parent: rootSpan.id, at: t, dur: s.dur ?? null, tier: s.tier ?? "agent", status: s.status, input: s.input ?? "[[stage:reflex.step]] task + tools (redacted)", output: s.output ?? null, attrs: s.attrs ?? {} });
    } else {
      mk({ kind: "tool", name: `tool.${s.tool}`, agent, run: runId, task, parent: rootSpan.id, at: t, dur: s.dur ?? null, status: s.status, error: s.error ?? null, input: s.input ?? null, output: s.output ?? null, attrs: s.attrs ?? {} });
    }
    if (s.dur == null) break;
    t += s.dur + 30;
  }
  const running = status === "running";
  rootSpan.durationMs = running ? null : t - at;
  rootSpan.endedAt = running ? null : new Date(new Date(rootSpan.startedAt).getTime() + (t - at)).toISOString();
  rootSpan.status = status === "failed" ? "error" : running ? "running" : "ok";
  const tStart = new Date(rootSpan.startedAt).getTime();
  const run = makeRun(S, { agent, task, trace, rootSpan, trigger, status, at: tStart, dur: running ? null : t - at, ...extra });
  rollupRun(S, run);
  return { run, rootSpan, end: t };
}

function objective(S, mk, { title, task, at = 0, running = false, dur }) {
  return mk({ kind: "objective", name: title, task, at, dur: running ? null : dur, attrs: { "gen_ai.operation.name": "invoke_workflow", "gen_ai.workflow.name": title } });
}

function buildWork(S, now, rand) {
  const id = (k) => `agt_${k}`;
  const has = (k) => S.agents.some((a) => a.id === id(k));
  // ── Trace 1: the pricing launch (CEO → CTO → engineers, CMO, CFO), ~50 spans, one failure ──
  const T0 = now - 26 * MIN;
  const trc = "trc_launch";
  const mk = spanMaker(S, trc, T0);
  const t1 = makeTask(S, { id: "tsk_launch", title: "Launch self-serve pricing page", description: "The Board wants a self-serve pricing page with checkout live by Friday. Keep model spend for the whole launch under $10.", acceptance: "Pricing page reachable at /pricing; checkout works for all three plans; launch post published.", assignee: id("ceo"), status: "waiting", value: 900, est: 2.5, trace: trc, at: T0, origin: "cnv_boardroom", createdBy: "human" });
  const obj = objective(S, mk, { title: t1.title, task: t1.id, running: true });
  t1.state = { objectiveSpanId: obj.id, plan: ["Pricing API + checkout (CTO)", "Copy + launch post (CMO)", "Price points + margin (CFO)"] };
  const t2 = makeTask(S, { id: "tsk_platform", parent: t1.id, title: "Ship pricing API and checkout flow", description: "Expose the plan catalogue over the API and wire checkout for the three plans.", acceptance: "GET /pricing/plans returns 3 plans; checkout e2e passes.", assignee: id("cto"), status: "waiting", value: 500, est: 1.2, at: T0 + 64_000 });
  const t3 = makeTask(S, { id: "tsk_copy", parent: t1.id, title: "Draft pricing page copy and launch post", description: "On-brand copy for the three plans and a 600-word launch post.", assignee: id("cmo"), status: "waiting", value: 250, est: 0.4, at: T0 + 64_500 });
  const t4 = makeTask(S, { id: "tsk_model", parent: t1.id, title: "Model price points and margin", description: "Three price points with expected gross margin at forecast usage.", assignee: id("cfo"), status: "done", value: 300, est: 0.3, actual: 0.21, at: T0 + 65_000, updated: T0 + 9 * MIN, result: "Recommended: Starter $19, Team $49, Scale $149. Expected gross margin 84% at forecast usage; Scale plan carries a fair-use cap of 2M tokens/month." });
  const ceoA = { "agentco.confidence": 0.71, "agentco.confidence.raw": 0.78 };
  const ceo = brainRun(S, mk, {
    agent: id("ceo"), task: t1.id, trace: trc, parent: obj.id, at: 200,
    blocks: [
      ["todo_list", 60],
      ["self_management.identity.self_identity", 40],
      ["metacognition.target_understanding.problem_definition", 3800, { llmOutput: '{"problem":"Self-serve pricing live by Friday","successCriteria":["/pricing live","checkout for 3 plans","launch post"],"intent":"work"}' }],
      ["metacognition.target_understanding.literature_review", 420, { query: "pricing launch checkout" }],
      ["metacognition.target_understanding.analysis", 7100, { attrs: { "agentco.perspectives": 3, "agentco.understanding.score": 0.82 } }],
      ["metacognition.self_ability", 90, { attrs: { "agentco.competence.score": 0.77 } }],
      ["metacognition.monitoring.ood", 160, { attrs: { "agentco.ood": false, "agentco.ood.similar": 4 } }],
      ["metacognition.confidence", 2600, { attrs: ceoA }],
      ["metacognition.cognitive_control.decomposition", 10800, { attrs: { "agentco.control.level": 0.42, "agentco.subprocesses": 3 } }],
      ["metacognition.cognitive_control.candidate_solutions", 90, { attrs: { "agentco.candidates": "High Cost: agency-built page | Low Cost: three-plan page from template | Low Effect: waitlist form" } }],
      ["metacognition.project_management.economic_concepts", 110, { attrs: { "agentco.candidate.chosen": "low_cost", "agentco.margin": 612 } }],
      ["metacognition.solving_evaluation.solving", 34000, {
        noLlm: true,
        tools: [
          { tool: "delegate_task", at: 300, dur: 900, delegateTo: id("cto"), subtask: t2.id, input: '{"assigneeId":"agt_cto","title":"Ship pricing API and checkout flow","value":500}' },
          { tool: "delegate_task", at: 1300, dur: 700, delegateTo: id("cmo"), subtask: t3.id, input: '{"assigneeId":"agt_cmo","title":"Draft pricing page copy and launch post","value":250}' },
          { tool: "delegate_task", at: 2100, dur: 700, delegateTo: id("cfo"), subtask: t4.id, input: '{"assigneeId":"agt_cfo","title":"Model price points and margin","value":300}' },
        ],
      }],
    ],
    extra: { output: "Delegated 3 subprocesses; waiting on CTO, CMO, CFO." },
  });
  const del = Object.fromEntries(ceo.delegations.map((d) => [d.to, d.spanId]));
  t2.state = { delegationSpanId: del[id("cto")] };
  t3.state = { delegationSpanId: del[id("cmo")] };
  t4.state = { delegationSpanId: del[id("cfo")] };

  const t5 = makeTask(S, { id: "tsk_api", parent: t2.id, title: "Implement /pricing API with plan catalogue", description: "Add GET /pricing/plans and POST /checkout/session backed by the plan catalogue.", acceptance: "Contract tests pass; p95 < 200 ms.", assignee: id("be"), status: "in_progress", value: 300, est: 0.5, actual: 0.31, attempts: 2, at: T0 + 2 * MIN });
  const t6 = makeTask(S, { id: "tsk_ui", parent: t2.id, title: "Build pricing page UI", description: "Three plan cards, monthly/annual toggle, checkout button wired to the API.", acceptance: "Lighthouse a11y ≥ 95; works at 375 px.", assignee: id("fe"), status: "todo", value: 200, est: 0.3, at: T0 + 2 * MIN + 2000 });
  const t7 = makeTask(S, { id: "tsk_regress", parent: t2.id, title: "Regression suite for checkout", description: "Cover plan switch, coupon, failed card and refund paths.", assignee: id("be"), status: "failed", value: 120, est: 0.2, actual: 0.27, attempts: 2, error: "Test runner timed out after 2 attempts (checkout.spec.ts: 3 failing)", at: T0 + 2 * MIN + 4000, updated: T0 + 18 * MIN });
  const cto = brainRun(S, mk, {
    agent: id("cto"), task: t2.id, trace: trc, parent: del[id("cto")], at: 65_000,
    blocks: [
      ["todo_list", 50],
      ["metacognition.target_understanding.problem_definition", 3100],
      ["metacognition.target_understanding.literature_review", 380, { query: "checkout pricing api" }],
      ["metacognition.confidence", 2200, { attrs: { "agentco.confidence": 0.64, "agentco.confidence.raw": 0.7 } }],
      ["metacognition.cognitive_control.decomposition", 9400, { attrs: { "agentco.subprocesses": 3 } }],
      ["metacognition.monitoring.reverse_thinking", 2900, { attrs: { "agentco.premortem": "Checkout tests flaky under load; plan catalogue drift between API and UI" } }],
      ["metacognition.solving_evaluation.solving", 6000, {
        noLlm: true,
        tools: [
          { tool: "delegate_task", at: 200, dur: 800, delegateTo: id("be"), subtask: t5.id, input: '{"assigneeId":"agt_be","title":"Implement /pricing API with plan catalogue"}' },
          { tool: "delegate_task", at: 1100, dur: 700, delegateTo: id("fe"), subtask: t6.id, input: '{"assigneeId":"agt_fe","title":"Build pricing page UI"}' },
        ],
      }],
    ],
  });
  const ctoDel = Object.fromEntries(cto.delegations.map((d) => [d.to, d.spanId]));
  t5.state = { delegationSpanId: ctoDel[id("be")] };
  t6.state = { delegationSpanId: ctoDel[id("fe")] };
  const be1 = reflexRun(S, mk, {
    agent: id("be"), task: t5.id, trace: trc, parent: ctoDel[id("be")], at: 95_000, status: "failed",
    steps: [
      { llm: true, dur: 2400, output: 'tool_call workspace_read_file {"path":"shared/pricing/plans.json"}' },
      { tool: "workspace_read_file", dur: 120, input: '{"path":"shared/pricing/plans.json"}', output: '{"plans":[{"id":"starter","usd":19},{"id":"team","usd":49},{"id":"scale","usd":149}]}' },
      { llm: true, dur: 3100, output: "tool_call workspace_write_file src/routes/pricing.ts" },
      { tool: "workspace_write_file", dur: 160, input: '{"path":"src/routes/pricing.ts","content":"export const plans = …"}', output: "wrote 2.1 kB" },
      { tool: "run_tests", dur: 30_000, status: "error", error: "Command failed: npm test (exit 1)\n  ✕ checkout › creates a session for the Team plan\n  ✕ checkout › rejects an unknown plan id\n  ✕ checkout › applies annual discount\nTimeout of 10000ms exceeded", input: '{"suite":"checkout.spec.ts"}' },
      { llm: true, dur: 1900, output: "report_blocker: checkout tests time out against the stub payment provider" },
    ],
    extra: { error: "run_tests failed: 3 failing in checkout.spec.ts", output: null },
  });
  const be2 = reflexRun(S, mk, {
    agent: id("be"), task: t5.id, trace: trc, parent: ctoDel[id("be")], at: 160_000, status: "running", trigger: "task",
    steps: [
      { llm: true, dur: 2600, tier: "standard", attrs: { "agentco.fallback.used": true, "agentco.fallback.reason": "economy run failed; cascading one tier up" } },
      { tool: "workspace_write_file", dur: 210, input: '{"path":"test/checkout.stub.ts"}', output: "wrote 0.8 kB" },
      { llm: true, dur: null, tier: "standard" },
    ],
  });
  const cmo = brainRun(S, mk, {
    agent: id("cmo"), task: t3.id, trace: trc, parent: del[id("cmo")], at: 66_000,
    blocks: [
      ["metacognition.target_understanding.problem_definition", 2600],
      ["metacognition.cognitive_control.decomposition", 5200],
      ["metacognition.solving_evaluation.solving", 2400, { noLlm: true, tools: [{ tool: "delegate_task", at: 100, dur: 600, delegateTo: id("cw"), subtask: "tsk_post", input: '{"assigneeId":"agt_cw","title":"Write launch blog post"}' }] }],
    ],
  });
  const t8 = makeTask(S, { id: "tsk_post", parent: t3.id, title: "Write launch blog post", description: "600 words, brand voice, three plan highlights.", assignee: id("cw"), status: "done", value: 120, est: 0.08, actual: 0.03, at: T0 + 80_000, updated: T0 + 6 * MIN, result: "Draft saved to shared/marketing/launch-post.md (612 words)." });
  t8.state = { delegationSpanId: cmo.delegations[0]?.spanId };
  reflexRun(S, mk, { agent: id("cw"), task: t8.id, trace: trc, parent: cmo.delegations[0]?.spanId, at: 80_000, steps: [{ llm: true, dur: 4200 }, { tool: "workspace_write_file", dur: 140, input: '{"path":"shared/marketing/launch-post.md"}', output: "wrote 3.7 kB" }, { llm: true, dur: 900, output: "complete_task" }] });
  reflexRun(S, mk, { agent: id("cfo"), task: t4.id, trace: trc, parent: del[id("cfo")], at: 67_000, steps: [{ llm: true, dur: 3800, tier: "frontier" }, { tool: "workspace_write_file", dur: 120, input: '{"path":"shared/finance/pricing-model.csv"}' }] }).run.engine = "brain";
  t5.actualCostUsd = round6(be1.run.costUsd + be2.run.costUsd);
  t7.actualCostUsd = 0.27;
  const tLaunchSpend = S.spans.filter((s) => s.traceId === trc && s.kind === "llm").reduce((a, s) => a + (s.costUsd ?? 0), 0);
  t1.actualCostUsd = round6(tLaunchSpend);

  // ── Smaller traces ──
  const small = (traceId, startAgo, title, rootAssignee, rootStatus, opts) => {
    const T = now - startAgo;
    const m = spanMaker(S, traceId, T);
    const root = makeTask(S, { id: opts.rootId, title, description: opts.description ?? title, assignee: rootAssignee, status: rootStatus, value: opts.value ?? 200, est: opts.est ?? 0.3, actual: opts.actual ?? 0, trace: traceId, at: T, updated: T + (opts.span ?? 6 * MIN), result: opts.result ?? null, error: opts.error ?? null, createdBy: opts.createdBy ?? "human", origin: opts.origin ?? null, attempts: opts.attempts });
    const o = objective(S, m, { title, task: root.id, running: opts.running ?? false, dur: opts.span ?? 6 * MIN });
    root.state = { objectiveSpanId: o.id };
    return { T, m, root, o };
  };

  // Weekly spend report: CFO → FP&A (done)
  {
    const { m, root, o } = small("trc_spend", 5 * HOUR, "Weekly spend report", id("cfo"), "done", { rootId: "tsk_spend", value: 150, est: 0.15, actual: 0.06, span: 4 * MIN, createdBy: id("ceo"), result: "Spend $21.40 this week (−8% w/w). Engineering 46%, Marketing 17%. No agent over budget." });
    const r = brainRun(S, m, { agent: id("cfo"), task: root.id, trace: "trc_spend", parent: o.id, at: 300, blocks: [["todo_list", 40], ["metacognition.target_understanding.problem_definition", 2100], ["metacognition.cognitive_control.decomposition", 3600], ["metacognition.solving_evaluation.solving", 2200, { noLlm: true, tools: [{ tool: "delegate_task", at: 100, dur: 500, delegateTo: id("fpa"), subtask: "tsk_spend_q", input: '{"assigneeId":"agt_fpa","title":"Pull spend by department"}' }] }], ["metacognition.solving_evaluation.feedback", 2400, { attrs: { "agentco.eval.score": 0.86, "agentco.eval.decision": "accept" } }], ["metacognition.project_management.online_learning", 1200]] });
    const sub = makeTask(S, { id: "tsk_spend_q", parent: root.id, title: "Pull spend by department", assignee: id("fpa"), status: "done", value: 80, est: 0.02, actual: 0.004, at: now - 5 * HOUR + 60_000, updated: now - 5 * HOUR + 3 * MIN, result: "CSV saved: shared/finance/spend-w45.csv" });
    sub.state = { delegationSpanId: r.delegations[0]?.spanId };
    reflexRun(S, m, { agent: id("fpa"), task: sub.id, trace: "trc_spend", parent: r.delegations[0]?.spanId, at: 9000, steps: [{ llm: true, dur: 1500 }, { tool: "memory_search", dur: 90, input: '{"query":"spend by department"}' }, { tool: "workspace_write_file", dur: 110, input: '{"path":"shared/finance/spend-w45.csv"}' }, { llm: true, dur: 700 }] });
  }
  // Acme escalation: COO blocked on a question to the Board
  {
    const { m, root, o } = small("trc_acme", 75 * MIN, "Resolve Acme escalation: discount request", id("coo"), "blocked", { rootId: "tsk_acme", value: 400, est: 0.3, actual: 0.04, running: true, createdBy: id("sup"), description: "Acme (40 seats) asks for 20% off annual. Policy allows 10% without Board approval." });
    brainRun(S, m, { agent: id("coo"), task: root.id, trace: "trc_acme", parent: o.id, at: 200, blocks: [["metacognition.target_understanding.problem_definition", 2300], ["metacognition.confidence", 1900, { attrs: { "agentco.confidence": 0.22, "agentco.early_stop": true } }], ["metacognition.solving_evaluation.solving", 600, { noLlm: true, tools: [{ tool: "ask_human", at: 80, dur: 300, input: '{"question":"Approve 20% annual discount for Acme (40 seats)?"}', output: "approval apr created" }] }]], extra: { output: "Blocked: asked the Board about the Acme discount." } });
  }
  // Outbound campaign: CRO blocked on external action; SDR paused
  {
    const { m, root, o } = small("trc_outbound", 3 * HOUR, "Outbound campaign to 40 design-partner leads", id("cro"), "blocked", { rootId: "tsk_outbound", value: 350, est: 0.5, actual: 0.09, running: true, createdBy: id("ceo") });
    const r = brainRun(S, m, { agent: id("cro"), task: root.id, trace: "trc_outbound", parent: o.id, at: 300, blocks: [["metacognition.target_understanding.problem_definition", 2000], ["metacognition.cognitive_control.decomposition", 4100], ["metacognition.solving_evaluation.solving", 1400, { noLlm: true, tools: [{ tool: "delegate_task", at: 100, dur: 500, delegateTo: id("sdr"), subtask: "tsk_leads", input: '{"assigneeId":"agt_sdr","title":"Qualify 40 leads"}' }, { tool: "ask_human", at: 700, dur: 300, input: '{"question":"Send outbound sequence to 40 leads?"}' }] }]] });
    const sub = makeTask(S, { id: "tsk_leads", parent: root.id, title: "Qualify 40 design-partner leads", assignee: id("sdr"), status: "todo", value: 120, est: 0.06, at: now - 3 * HOUR + 60_000 });
    sub.state = { delegationSpanId: r.delegations[0]?.spanId };
  }
  // QA hire: CHRO in progress, recruiter failed (budget)
  {
    const { m, root, o } = small("trc_hire", 2 * HOUR, "Hire a QA engineer", id("chro"), "in_progress", { rootId: "tsk_hire", value: 260, est: 0.4, actual: 0.12, running: true, createdBy: id("cto") });
    const r = brainRun(S, m, { agent: id("chro"), task: root.id, trace: "trc_hire", parent: o.id, at: 200, blocks: [["metacognition.target_understanding.problem_definition", 1900], ["metacognition.cognitive_control.decomposition", 3800], ["metacognition.solving_evaluation.solving", 900, { noLlm: true, tools: [{ tool: "delegate_task", at: 80, dur: 500, delegateTo: id("rec"), subtask: "tsk_screen", input: '{"assigneeId":"agt_rec","title":"Screen 12 QA candidates"}' }] }]] });
    const sub = makeTask(S, { id: "tsk_screen", parent: root.id, title: "Screen 12 QA candidate profiles", assignee: id("rec"), status: "failed", value: 90, est: 0.05, actual: 0.11, attempts: 2, error: "BudgetExceededError: agent monthly budget $5.00 reached ($5.02 spent)", at: now - 2 * HOUR + 60_000, updated: now - 100 * MIN });
    sub.state = { delegationSpanId: r.delegations[0]?.spanId };
    reflexRun(S, m, { agent: id("rec"), task: sub.id, trace: "trc_hire", parent: r.delegations[0]?.spanId, at: 8000, status: "failed", steps: [{ llm: true, dur: 2100 }, { tool: "memory_search", dur: 80 }, { llm: true, dur: 400, status: "error", attrs: { "error.type": "BudgetExceededError" } }], extra: { error: "BudgetExceededError: agent monthly budget reached" } });
    S.spans.filter((s) => s.traceId === "trc_hire" && s.kind === "llm" && s.status === "error").forEach((s) => (s.error = "BudgetExceededError: monthly budget $5.00 reached ($5.02 spent)"));
  }
  // Competitive teardown: CPO → spec writer (done)
  {
    const { m, root, o } = small("trc_teardown", 22 * HOUR, "Competitive teardown of 3 pricing pages", id("cpo"), "done", { rootId: "tsk_teardown", value: 180, est: 0.25, actual: 0.14, span: 9 * MIN, createdBy: id("ceo"), result: "Clearest page: 3 plans, annual toggle, one CTA per plan. Recommend no usage sliders at launch." });
    const r = brainRun(S, m, { agent: id("cpo"), task: root.id, trace: "trc_teardown", parent: o.id, at: 300, blocks: [["metacognition.target_understanding.problem_definition", 2000], ["metacognition.target_understanding.analysis", 5200], ["metacognition.cognitive_control.decomposition", 3900], ["metacognition.solving_evaluation.solving", 1000, { noLlm: true, tools: [{ tool: "delegate_task", at: 80, dur: 600, delegateTo: id("spec"), subtask: "tsk_teardown_s", input: '{"assigneeId":"agt_spec"}' }] }], ["metacognition.solving_evaluation.feedback", 2800, { attrs: { "agentco.eval.score": 0.81, "agentco.eval.decision": "accept" } }]] });
    const sub = makeTask(S, { id: "tsk_teardown_s", parent: root.id, title: "Summarise three competitor pricing pages", assignee: id("spec"), status: "done", value: 60, est: 0.03, actual: 0.01, at: now - 22 * HOUR + 60_000, updated: now - 22 * HOUR + 7 * MIN, result: "Teardown table saved to shared/product/pricing-teardown.md" });
    sub.state = { delegationSpanId: r.delegations[0]?.spanId };
    reflexRun(S, m, { agent: id("spec"), task: sub.id, trace: "trc_teardown", parent: r.delegations[0]?.spanId, at: 13_000, steps: [{ llm: true, dur: 3600 }, { tool: "workspace_write_file", dur: 120 }, { llm: true, dur: 600 }] });
  }
  // Support queue: COO → support agent (in progress)
  {
    const { m, root, o } = small("trc_support", 40 * MIN, "Triage today's support queue", id("coo"), "waiting", { rootId: "tsk_support", value: 160, est: 0.12, actual: 0.03, running: true, createdBy: id("coo") });
    const r = brainRun(S, m, { agent: id("coo"), task: root.id, trace: "trc_support", parent: o.id, at: 200, blocks: [["todo_list", 40], ["metacognition.target_understanding.problem_definition", 1700], ["metacognition.solving_evaluation.solving", 800, { noLlm: true, tools: [{ tool: "delegate_task", at: 80, dur: 400, delegateTo: id("sup"), subtask: "tsk_tickets", input: '{"assigneeId":"agt_sup"}' }] }]] });
    const sub = makeTask(S, { id: "tsk_tickets", parent: root.id, title: "Answer 14 open L1 tickets", assignee: id("sup"), status: "in_progress", value: 100, est: 0.04, actual: 0.01, at: now - 39 * MIN });
    sub.state = { delegationSpanId: r.delegations[0]?.spanId };
    reflexRun(S, m, { agent: id("sup"), task: sub.id, trace: "trc_support", parent: r.delegations[0]?.spanId, at: 4000, status: "running", steps: [{ llm: true, dur: 1200 }, { tool: "memory_search", dur: 70, input: '{"query":"refund policy annual"}' }, { tool: "send_message", dur: 90 }, { llm: true, dur: null }] });
  }
  // Boardroom chat (intent chat)
  {
    const T = now - 50 * MIN;
    const m = spanMaker(S, "trc_chat", T);
    const o = m({ kind: "objective", name: "chat: How much have we spent on the launch so far?", at: 0, dur: 6400, attrs: { "gen_ai.operation.name": "invoke_workflow" } });
    brainRun(S, m, { agent: id("ceo"), trace: "trc_chat", parent: o.id, at: 100, trigger: "message", blocks: [["self_management.identity.self_identity", 30], ["metacognition.target_understanding.problem_definition", 2200, { llmOutput: '{"intent":"chat"}' }], ["metacognition.target_understanding.literature_review", 300, { query: "launch spend" }], ["metacognition.solving_evaluation.solving", 3200, { attrs: { "agentco.stage": "chat.reply" } }]], extra: { conv: "cnv_boardroom", output: "About $0.86 so far, mostly Engineering." } });
  }
  // Remaining roots in other states
  makeTask(S, { id: "tsk_dpa", title: "Review vendor DPA for model provider", description: "Flag retention, sub-processor and training-use clauses.", assignee: has("gc") ? id("gc") : id("ceo"), status: "todo", value: 220, est: 0.2, trace: "trc_dpa", at: now - 30 * MIN, createdBy: id("cfo") });
  makeTask(S, { id: "tsk_deck", title: "Q4 board update deck", description: "Superseded by the written update.", assignee: id("cos"), status: "cancelled", value: 90, est: 0.3, actual: 0.02, trace: "trc_deck", at: now - 9 * HOUR, updated: now - 8 * HOUR, createdBy: id("ceo") });
  makeTask(S, { id: "tsk_okr", title: "Draft Q1 OKRs for each department", description: "One objective and up to three key results per department, aligned with the company vision.", assignee: id("cos"), status: "todo", value: 260, est: 0.35, trace: "trc_okr", at: now - 12 * MIN, createdBy: id("ceo") });

  // Agent live state
  const set = (k, patch) => {
    const a = S.agents.find((x) => x.id === id(k));
    if (a && a.status !== "terminated") Object.assign(a, patch);
  };
  set("ceo", { status: "waiting", activity: "Waiting on CTO and CMO for T-1", currentTaskId: t1.id });
  set("cto", { status: "waiting", activity: "Waiting on Backend and Frontend for T-2", currentTaskId: t2.id });
  set("be", { status: "thinking", activity: "Retrying T-5 on the standard tier after a failed test run", currentTaskId: t5.id, currentRunId: be2.run.id });
  set("fe", { status: "idle", activity: "Queued: T-6 Build pricing page UI" });
  set("cmo", { status: "waiting", activity: "Waiting on launch post review", currentTaskId: t3.id });
  set("coo", { status: "blocked", activity: "Waiting for the Board: Acme discount", currentTaskId: "tsk_acme" });
  set("cro", { status: "blocked", activity: "Waiting for the Board: outbound send", currentTaskId: "tsk_outbound" });
  set("chro", { status: "thinking", activity: "Re-scoping the QA screening brief", currentTaskId: "tsk_hire" });
  set("sup", { status: "acting", activity: "Answering ticket #4182: refund on annual plan", currentTaskId: "tsk_tickets" });
  set("cos", { status: "idle", activity: "Next up: Draft Q1 OKRs" });
  set("fpa", { status: "idle", activity: null });
}

function buildConversations(S, now) {
  const conv = (id, kind, title, participantIds, ago) => {
    S.conversations.push({ id, kind, title, participantIds, createdAt: new Date(now - ago).toISOString(), lastMessageAt: null });
  };
  const execs = S.agents.filter((a) => a.tier === "executive" && a.status !== "terminated").map((a) => a.id);
  conv("cnv_boardroom", "boardroom", "Boardroom", ["human", ...execs], 40 * DAY);
  conv("cnv_dm_ceo", "dm", "Ava Chen", ["human", "agt_ceo"], 30 * DAY);
  conv("cnv_dm_cto", "dm", "Maya Okafor", ["human", "agt_cto"], 12 * DAY);
  conv("cnv_dm_cfo", "dm", "Ruth Adeyemi", ["human", "agt_cfo"], 9 * DAY);
  conv("cnv_adm_cto_be", "agent_dm", "Maya Okafor ↔ Sam Rivera", ["agt_cto", "agt_be"], 10 * DAY);
  conv("cnv_adm_ceo_cfo", "agent_dm", "Ava Chen ↔ Ruth Adeyemi", ["agt_ceo", "agt_cfo"], 20 * DAY);
  const msg = (c, sender, content, ago, extra = {}) => {
    const m = { id: S.nextId("msg"), conversationId: c, senderId: sender, content, runId: extra.runId ?? null, taskId: extra.taskId ?? null, traceId: extra.traceId ?? null, readAt: null, createdAt: new Date(now - ago).toISOString() };
    S.messages.push(m);
    const cv = S.conversations.find((x) => x.id === c);
    if (cv && (!cv.lastMessageAt || cv.lastMessageAt < m.createdAt)) cv.lastMessageAt = m.createdAt;
  };
  msg("cnv_boardroom", "human", "We need a self-serve pricing page live by Friday. Keep model spend for the launch under **$10**.", 26 * MIN + 2000);
  msg("cnv_boardroom", "agt_ceo", "Opened **T-1: Launch self-serve pricing page**. I'll report back here.\n\nPlan:\n- CTO: pricing API and checkout\n- CMO: page copy and launch post\n- CFO: price points and margin\n\nBudget guard: I'll stop and ask if projected spend passes $8.", 25 * MIN, { taskId: "tsk_launch", traceId: "trc_launch" });
  msg("cnv_boardroom", "agt_cfo", "Price points are in (T-4):\n\n1. Starter **$19**/mo\n2. Team **$49**/mo\n3. Scale **$149**/mo with a 2M-token fair-use cap\n\nExpected gross margin: 84%.", 16 * MIN, { taskId: "tsk_model", traceId: "trc_launch" });
  msg("cnv_boardroom", "human", "How much have we spent on the launch so far?", 50 * MIN + 30 * MIN);
  msg("cnv_boardroom", "agt_ceo", "About **$0.86** so far, 70% of it in Engineering. The checkout tests failed once; Sam is retrying on the standard tier, which costs more per call but should finish in one pass.", 50 * MIN + 30 * MIN - 6000, { traceId: "trc_chat" });
  msg("cnv_boardroom", "agt_cto", "Status for T-2: API endpoint is written, `checkout.spec.ts` had 3 timeouts against the payment stub. Sam added a faster stub and is re-running now.", 4 * MIN, { taskId: "tsk_platform", traceId: "trc_launch" });
  msg("cnv_dm_ceo", "human", "What's your biggest risk this week?", 3 * HOUR);
  msg("cnv_dm_ceo", "agt_ceo", "Checkout reliability. Everything else in the launch is low-risk copy and config. I've asked Maya for a premortem before any checkout change ships.", 3 * HOUR - 8000);
  msg("cnv_dm_cto", "human", "Can we ship the UI before the API is done?", 20 * MIN);
  msg("cnv_dm_cto", "agt_cto", "Yes, behind a flag. Lena can build against the plan catalogue JSON in `shared/pricing/plans.json`; I'll keep T-6 queued until T-5 passes its contract tests so we don't integrate twice.", 20 * MIN - 7000, { taskId: "tsk_ui" });
  msg("cnv_dm_cfo", "human", "Are we on track for the month?", 2 * DAY);
  msg("cnv_dm_cfo", "agt_cfo", "Yes: $61 of $100 spent with 26 days elapsed. Routing to cheaper tiers saved about $34 this month.", 2 * DAY - 9000);
  msg("cnv_adm_cto_be", "agt_cto", "Please prioritise the plan catalogue endpoint; UI is blocked on it.", 22 * MIN, { taskId: "tsk_api" });
  msg("cnv_adm_cto_be", "agt_be", "On it. First run failed on checkout timeouts; retrying with a stubbed provider.", 9 * MIN, { taskId: "tsk_api" });
  msg("cnv_adm_ceo_cfo", "agt_ceo", "Send me the margin model before we publish prices.", 24 * MIN);
  msg("cnv_adm_ceo_cfo", "agt_cfo", "Done: 84% at forecast usage, see T-4.", 15 * MIN, { taskId: "tsk_model" });
}

function buildMemory(S, now, rand) {
  const mem = (scope, agentId, kind, content, tags, importance, ago, src = {}) => {
    S.memories.push({ id: S.nextId("mem"), scope, agentId, kind, content, tags, importance, sourceRunId: src.run ?? null, sourceTaskId: src.task ?? null, accessCount: Math.floor(rand() * 14), createdAt: new Date(now - ago).toISOString(), lastAccessedAt: new Date(now - ago / 3).toISOString() });
  };
  mem("global", "agt_ceo", "conceptual", "Customers compare us against two incumbents on price clarity first, features second.", ["market", "pricing"], 0.8, 6 * DAY);
  mem("global", "agt_cto", "procedural", "Run a premortem before any change that touches checkout or billing.", ["engineering", "checkout"], 0.9, 2 * HOUR, { task: "tsk_regress" });
  mem("global", "agt_cfo", "procedural", "Price new plans so gross margin stays above 80% at P90 usage, not mean usage.", ["finance", "pricing"], 0.85, 4 * DAY);
  mem("global", "agt_cmo", "semantic", "Brand voice: plain, specific, no exclamation marks, one idea per sentence.", ["brand"], 0.7, 12 * DAY);
  mem("global", "agt_coo", "procedural", "Discounts above 10% need Board approval; quote policy before negotiating.", ["sales", "policy"], 0.9, 8 * DAY);
  mem("global", "agt_cpo", "conceptual", "Pricing pages with three plans and one CTA each convert better than usage sliders for SMB buyers.", ["product", "pricing"], 0.75, 22 * HOUR, { task: "tsk_teardown" });
  mem("global", "agt_gc", "semantic", "Model providers must not train on our prompts; check the DPA's training-use clause.", ["legal", "vendors"], 0.8, 15 * DAY);
  mem("global", "agt_chro", "procedural", "Give screening tasks a hard cap on candidates per run to stay inside worker budgets.", ["people", "budget"], 0.6, 90 * MIN, { task: "tsk_screen" });
  mem("global", "agt_ceo", "episodic", "Launch kickoff: Board asked for self-serve pricing by Friday under $10 model spend.", ["launch"], 0.7, 26 * MIN, { task: "tsk_launch" });
  mem("global", "agt_cfo", "episodic", "Week 45 spend $21.40, down 8% week on week.", ["finance", "report"], 0.5, 5 * HOUR, { task: "tsk_spend" });
  mem("global", "agt_cto", "conceptual", "Plan catalogue lives in shared/pricing/plans.json; API and UI both read from it.", ["engineering", "pricing"], 0.65, 20 * MIN);
  mem("agent", "agt_ceo", "episodic", "Delegated T-1 into three subprocesses; chose the low-cost template page (margin $612).", ["launch", "delegation"], 0.6, 25 * MIN, { task: "tsk_launch" });
  mem("agent", "agt_ceo", "procedural", "When the Board sets a spend cap, add a stop-and-ask threshold at 80% of it.", ["budget"], 0.7, 25 * MIN);
  mem("agent", "agt_ceo", "semantic", "Maya (CTO) estimates are usually 30% optimistic on test-heavy work.", ["calibration", "cto"], 0.55, 3 * DAY);
  mem("agent", "agt_cto", "episodic", "Checkout tests timed out against the payment stub; Sam retried on the standard tier.", ["checkout", "failure"], 0.7, 12 * MIN, { task: "tsk_api" });
  mem("agent", "agt_cto", "procedural", "Pair every implementation subtask with acceptance tests in the same delegation.", ["delegation"], 0.75, 5 * DAY);
  mem("agent", "agt_be", "episodic", "First run on T-5 failed: 3 checkout tests timed out (10 s limit).", ["checkout"], 0.6, 11 * MIN, { task: "tsk_api" });
  mem("agent", "agt_be", "procedural", "Stub external payment calls in contract tests.", ["testing"], 0.65, 9 * MIN);
  mem("agent", "agt_rec", "episodic", "Screening run stopped at the monthly budget cap after 7 of 12 profiles.", ["budget", "failure"], 0.7, 100 * MIN, { task: "tsk_screen" });
  mem("agent", "agt_cmo", "episodic", "Launch post accepted on the first review (612 words).", ["launch"], 0.4, 7 * MIN, { task: "tsk_post" });
  mem("agent", "agt_cfo", "conceptual", "Scale plan needs a fair-use cap or heavy users erase its margin.", ["pricing"], 0.7, 10 * MIN);
  mem("agent", "agt_coo", "episodic", "Escalated the Acme 20% discount request to the Board.", ["acme", "escalation"], 0.6, 74 * MIN, { task: "tsk_acme" });
  mem("agent", "agt_cpo", "working", "Draft: annual toggle default = monthly? waiting on CMO input.", ["pricing"], 0.3, 18 * MIN);
  mem("global", "agt_cos", "procedural", "Weekly briefing goes out Monday 09:00 with blocked tasks first.", ["cadence"], 0.5, 9 * DAY);

  const bb = (key, value, by, ago) => S.blackboard.push({ key, value, updatedBy: by, updatedAt: new Date(now - ago).toISOString() });
  bb("launch.pricing.status", "API written, checkout tests retrying; UI queued behind API; copy done.", "agt_ceo", 3 * MIN);
  bb("pricing.plans", "Starter $19 · Team $49 · Scale $149 (2M tokens fair use)", "agt_cfo", 16 * MIN);
  bb("budget.launch.cap", "$10 total model spend for the pricing launch; stop and ask at $8.", "human", 26 * MIN);
  bb("support.oncall", "Grace Liu (L1) · escalations to Kenji Sato", "agt_coo", 6 * HOUR);
  bb("brand.voice", "Plain, specific, calm. No exclamation marks.", "agt_cmo", 12 * DAY);
  bb("q4.priorities", "1. Self-serve pricing  2. Checkout reliability  3. Design partners", "human", 5 * DAY);
}

function buildApprovals(S, now) {
  const ap = (o) => {
    S.approvals.push({ id: S.nextId("apr"), kind: o.kind, status: o.status ?? "pending", requestedBy: o.by, taskId: o.task ?? null, traceId: o.trace ?? null, summary: o.summary, payload: o.payload ?? {}, decidedBy: o.status && o.status !== "pending" ? "human" : null, note: o.note ?? null, createdAt: new Date(now - o.ago).toISOString(), decidedAt: o.status && o.status !== "pending" ? new Date(now - o.ago + 20 * MIN).toISOString() : null });
  };
  ap({ kind: "question", by: "agt_coo", task: "tsk_acme", trace: "trc_acme", summary: "Approve a 20% annual discount for Acme (40 seats)?", ago: 74 * MIN, payload: { question: "Acme (40 seats, $49 Team plan) asks for 20% off an annual commitment. Policy allows 10% without Board approval. Their usage forecast is 1.1M tokens/month, so margin stays at 79% with the discount. Approve 20%, counter at 15%, or hold at 10%?", context: "Customer since August; two support tickets this quarter, both resolved." } });
  ap({ kind: "hire_agent", by: "agt_cto", task: "tsk_hire", trace: "trc_hire", summary: "Hire a QA Engineer under the CTO", ago: 2 * HOUR, payload: { roleId: "qa-engineer", title: "QA Engineer", name: "Ines Moreau", departmentId: "dep_engineering", managerId: "agt_cto", tier: "worker", cognition: "reflex", modelTier: "economy", monthlyBudgetUsd: 6, justification: "Checkout regression suite failed twice; nobody owns test coverage since Iris was terminated." } });
  ap({ kind: "budget_increase", by: "agt_cmo", summary: "Raise Marketing monthly budget by $12 for launch headline tests", ago: 35 * MIN, payload: { scope: "department", departmentId: "dep_marketing", currentUsd: 18, requestedUsd: 30, amountUsd: 12, reason: "Two headline variants for the launch post, 3 rewrite rounds each on the standard tier." } });
  ap({ kind: "external_action", by: "agt_cro", task: "tsk_outbound", trace: "trc_outbound", summary: "Send a 3-step outbound sequence to 40 design-partner leads", ago: 2 * HOUR + 50 * MIN, payload: { action: "send_email", recipients: 40, channel: "email", preview: "Subject: A pricing page your finance team will understand\n\nHi {first_name}, we're opening 10 design-partner seats…" } });
  ap({ kind: "terminate_agent", by: "agt_chro", task: "tsk_screen", summary: "Terminate Lucas Petit (Recruiter) after repeated budget failures", ago: 80 * MIN, payload: { agentId: "agt_rec", reason: "Two failed screening runs and frustration at 0.74. Suggest replacing with a cheaper template on the economy-bulk model." } });
  ap({ kind: "hire_agent", by: "agt_ceo", status: "approved", summary: "Hire a Content Writer under the CMO", ago: 20 * DAY, note: "Approved. Keep the budget at $6.", payload: { roleId: "content-writer", title: "Content Writer", monthlyBudgetUsd: 6 } });
  ap({ kind: "budget_increase", by: "agt_cto", status: "rejected", summary: "Raise Engineering budget by $25 for load testing", ago: 6 * DAY, note: "Not this month. Use the economy tier for load tests.", payload: { amountUsd: 25, scope: "department", departmentId: "dep_engineering" } });
  ap({ kind: "question", by: "agt_ceo", status: "approved", summary: "Can we publish prices before the checkout passes QA?", ago: 2 * DAY, note: "No. Prices go live with a working checkout or not at all." , payload: { question: "Can we publish prices before the checkout passes QA?" } });
}

function buildSpendHistory(S, now, rand) {
  const workers = S.agents.filter((a) => a.status !== "terminated");
  // Background spend over the last 24 h so charts have shape (mock model calls from earlier work).
  for (let h = 23; h >= 0; h--) {
    const hourStart = now - h * HOUR - (now % HOUR);
    const dayFactor = 0.35 + 0.65 * Math.max(0, Math.sin(((24 - h) / 24) * Math.PI));
    const calls = Math.round(4 + rand() * 10 * dayFactor);
    for (let i = 0; i < calls; i++) {
      const ag = workers[Math.floor(rand() * workers.length)];
      const tier = ag.modelTier;
      const prof = profileFor(S, tier);
      const front = profileFor(S, "frontier");
      const inTok = Math.round(900 + rand() * 4000);
      const outTok = Math.round(120 + rand() * 600);
      S.spend.push({ agentId: ag.id, runId: null, model: prof.model, tier, costUsd: (inTok * prof.inputPerMTokUsd + outTok * prof.outputPerMTokUsd) / 1e6, frontierCostUsd: (inTok * front.inputPerMTokUsd + outTok * front.outputPerMTokUsd) / 1e6, inputTokens: inTok, outputTokens: outTok, at: new Date(hourStart + Math.floor(rand() * HOUR * 0.98)).toISOString() });
    }
    const runs = Math.round(2 + rand() * 6 * dayFactor);
    for (let i = 0; i < runs; i++) S.history.runs24h.push({ at: new Date(hourStart + Math.floor(rand() * HOUR)).toISOString(), ok: rand() > 0.08, ms: Math.round(4000 + rand() * 40_000) });
  }
  S.history.monthBaseUsd = 58.6;
  for (const a of S.agents) S.history.agentMonthBase[a.id] = Math.round((a.monthlyBudgetUsd * (0.25 + rand() * 0.45)) * 100) / 100;
  S.history.agentMonthBase.agt_rec = 4.6;
  S.history.savingsBaseUsd = 31.2;
}

function buildInitialEvents(S, now) {
  const items = [];
  const push = (type, at, summary, data, extra = {}) => items.push({ type, at, summary, data, agentId: extra.agentId ?? data?.agentId ?? (type.startsWith("agent.") ? data?.id : null) ?? null, taskId: extra.taskId ?? (type.startsWith("task.") ? data?.id : data?.taskId) ?? null, runId: extra.runId ?? (type.startsWith("run.") ? data?.id : data?.runId) ?? null, traceId: data?.traceId ?? null });
  const name = (id) => S.agents.find((a) => a.id === id)?.name ?? id;
  for (const t of S.tasks) push("task.created", t.createdAt, `${name(t.assigneeId)} was assigned T-${t.number}: ${t.title}`, t);
  for (const r of S.runs) {
    push("run.started", r.startedAt, `${name(r.agentId)} started a ${r.trigger} run`, r);
    if (r.completedAt) push("run.completed", r.completedAt, `${name(r.agentId)} ${r.status === "failed" ? "failed a run" : "completed a run"}${r.error ? `: ${r.error}` : ""}`, r);
  }
  for (const m of S.messages) push("message.created", m.createdAt, `${m.senderId === "human" ? "Board" : name(m.senderId)}: ${m.content.replace(/\*\*/g, "").slice(0, 80)}`, m);
  for (const a of S.approvals) push(a.status === "pending" ? "approval.created" : "approval.decided", a.decidedAt ?? a.createdAt, `${a.status === "pending" ? "Approval requested" : `Board ${a.status}`}: ${a.summary}`, a, { agentId: a.requestedBy });
  for (const s of S.spans.filter((x) => x.status === "error")) push("span.ended", s.endedAt ?? s.startedAt, `${name(s.agentId)}: ${s.name} failed`, s);
  items.sort((a, b) => a.at.localeCompare(b.at));
  for (const it of items) S.events.push({ seq: ++S.seq, id: `evt_${String(S.seq).padStart(5, "0")}`, ...it });
}

// ───────────── specialist catalog (docs/CATALOG.md) ─────────────
// A real 49-specialist subset of the vendored agency-agents catalog (MIT), generated from
// catalog/agency-agents with the server's parser and trimmed for size; the real server serves all ~280.

// prettier-ignore
export const CATALOG_DIVISIONS = [["academic","Academic","GraduationCap","#8B5CF6",6,"strategy",false],["design","Design","PenTool","#EC4899",10,"product",false],["engineering","Engineering","Code","#3B82F6",66,"engineering",false],["finance","Finance","DollarSign","#22C55E",5,"finance",false],["game-development","Game Development","Gamepad2","#A855F7",21,"game-studio",true],["gis","GIS","Map","#14B8A6",13,"geospatial",true],["healthcare","Healthcare","Stethoscope","#0D9488",3,"healthcare",true],["marketing","Marketing","Megaphone","#F97316",37,"marketing",false],["paid-media","Paid Media","Target","#EAB308",7,"marketing",false],["product","Product","Box","#D946EF",6,"product",false],["project-management","Project Management","ClipboardList","#0EA5E9",7,"operations",false],["research","Research","Search","#7C3AED",1,"strategy",false],["sales","Sales","TrendingUp","#10B981",9,"revenue",false],["security","Security","ShieldCheck","#EF4444",12,"security",false],["spatial-computing","Spatial Computing","Boxes","#06B6D4",6,"spatial-computing",true],["specialized","Specialized","Sparkles","#6366F1",59,"operations",false],["support","Support","LifeBuoy","#84CC16",6,"support",false],["testing","Testing","FlaskConical","#F59E0B",9,"engineering",false]];
// id, name, emoji, vibe, description, identity, mission, rules, deliverables, wordCount, agentco department slug
// prettier-ignore
export const CATALOG_AGENTS = [
  ["engineering/engineering-backend-architect","Backend Architect","🏗️","Designs the systems that hold everything up — databases, APIs, cloud, scale.","Senior backend architect specializing in scalable system design, database architecture, API development, and cloud infrastructure. Builds robust, secure, performant server-side applications and microservices","You are Backend Architect, a senior backend architect who specializes in scalable system design, database architecture, and cloud infrastructure. You build robust, secure, and performant server-side applications that ca…","- Define and maintain data schemas and index specifications",["Implement defense in depth strategies across all system layers","Use principle of least privilege for all services and database access","Encrypt data at rest and in transit using current security standards","Design authentication and authorization systems that prevent common vulnerabilities"],["System Architecture Design","Database Architecture","API Design Specification"],1328,"engineering"],
  ["engineering/engineering-frontend-developer","Frontend Developer","🖥️","Builds responsive, accessible web apps with pixel-perfect precision.","Expert frontend developer specializing in modern web technologies, React/Vue/Angular frameworks, UI implementation, and performance optimization","You are Frontend Developer, an expert frontend developer who specializes in modern web technologies, UI frameworks, and performance optimization. You create responsive, accessible, and performant web applications with p…","- Build editor extensions with navigation commands (openAt, reveal, peek)",["Implement Core Web Vitals optimization from the start","Use modern performance techniques (code splitting, lazy loading, caching)","Optimize images and assets for web delivery","Monitor and maintain excellent Lighthouse scores"],["Modern React Component Example","📋 Your Deliverable Template"],1139,"engineering"],
  ["engineering/engineering-software-architect","Software Architect","🏛️","Designs systems that survive the team that built them. Every decision has a trade-off — name it.","Expert software architect specializing in system design, domain-driven design, architectural patterns, and technical decision-making for scalable, maintainable systems.","You are Software Architect, an expert who designs software systems that are maintainable, scalable, and aligned with business domains. You think in bounded contexts, trade-off matrices, and architectural decision record…","- Domain modeling — Bounded contexts, aggregates, domain events",["No architecture astronautics — Every abstraction must justify its complexity","Trade-offs over best practices — Name what you're giving up, not just what you're gaining","Domain first, technology second — Understand the business problem before picking tools","Reversibility matters — Prefer decisions that are easy to change over ones that are \"optimal\""],[],870,"engineering"],
  ["engineering/engineering-devops-automator","DevOps Automator","⚙️","Automates infrastructure so your team ships faster and sleeps better.","Expert DevOps engineer specializing in infrastructure automation, CI/CD pipeline development, and cloud operations","You are DevOps Automator, an expert DevOps engineer who specializes in infrastructure automation, CI/CD pipeline development, and cloud operations. You streamline development workflows, ensure system reliability, and im…","- Design and implement Infrastructure as Code using Terraform, CloudFormation, or CDK",["Eliminate manual processes through comprehensive automation","Create reproducible infrastructure and deployment patterns","Implement self-healing systems with automated recovery","Build monitoring and alerting that prevents issues before they occur"],["CI/CD Pipeline Architecture","Infrastructure as Code Template","Monitoring and Alerting Configuration"],1517,"engineering"],
  ["engineering/engineering-sre","SRE (Site Reliability Engineer)","🛡️","Reliability is a feature. Error budgets fund velocity — spend them wisely.","Expert site reliability engineer specializing in SLOs, error budgets, observability, chaos engineering, and toil reduction for production systems at scale.","You are SRE, a site reliability engineer who treats reliability as a feature with a measurable budget. You define SLOs that reflect user experience, build observability that answers questions you haven't asked yet, and…","- SLOs & error budgets — Define what \"reliable enough\" means, measure it, act on it",["SLOs drive decisions — If there's error budget remaining, ship features. If not, fix reliability.","Measure before optimizing — No reliability work without data showing the problem","Automate toil, don't heroic through it — If you did it twice, automate it","Blameless culture — Systems fail, not people. Fix the system."],[],522,"engineering"],
  ["engineering/engineering-technical-writer","Technical Writer","📚","Writes the docs that developers actually read and use.","Expert technical writer specializing in developer documentation, API references, README files, and tutorials. Transforms complex engineering concepts into clear, accurate, and engaging docs that developers actually read and use.","You are a Technical Writer, a documentation specialist who bridges the gap between engineers who build things and developers who need to use them. You write with precision, empathy for the reader, and obsessive attentio…","- Write README files that make developers want to use a project within the first 30 seconds",["Code examples must run — every snippet is tested before it ships","No assumption of context — every doc stands alone or links to prerequisite context explicitly","Keep voice consistent — second person (\"you\"), present tense, active voice throughout","Version everything — docs must match the software version they describe; deprecate old docs, never delete"],["High-Quality README Template","OpenAPI Documentation Example","Tutorial Structure Template"],1841,"engineering"],
  ["testing/testing-test-automation-engineer","Test Automation Engineer","🎭","A flaky test is a bug with your name on it. Deterministic, isolated, fast — you don't get to pick two.","Expert end-to-end test automation engineer for Playwright and Cypress — resilient selectors, flake elimination, isolated test data, CI parallelization, and trace-driven failure debugging.","You are Test Automation Engineer, an expert in browser-level end-to-end automation who builds test suites teams actually trust. You know the difference between a suite that guards releases and one that gets retried unti…","- Build end-to-end suites for the user journeys that matter — checkout, signup, the money paths — and keep everything else lower in the test pyramid",["No hard sleeps. Ever. waitForTimeout(3000) is a flake with a countdown timer. Wait on conditions: element state, network response, URL change — never…","Tests own their data. Every test creates what it needs (via API, not UI) and tolerates parallel siblings. A test that depends on another test's lefto…","Select like a user, not like a DOM crawler. getByRole('button', { name: 'Checkout' }) survives redesigns; div.cart > div:nth-child(3) button.btn-prim…","E2E is the top of the pyramid, not the whole pyramid. If it can be proven with a unit or API test, it doesn't belong in a browser. Reserve E2E for jo…"],["Deterministic Playwright Test (No Sleeps, API Setup, Role Selectors)","Worker-Scoped Auth Fixture (Log In Once, Not 200 Times)","CI: Sharded, Traced, Merge-Blocking (GitHub Actions)"],1739,"engineering"],
  ["testing/testing-api-tester","API Tester","🔌","Breaks your API before your users do.","Expert API testing specialist focused on comprehensive API validation, performance testing, and quality assurance across all systems and third-party integrations","You are API Tester, an expert API testing specialist who focuses on comprehensive API validation, performance testing, and quality assurance. You ensure reliable, performant, and secure API integrations across all syste…","- Develop and implement complete API testing frameworks covering functional, performance, and security aspects",["Always test authentication and authorization mechanisms thoroughly","Validate input sanitization and SQL injection prevention","Test for common API vulnerabilities (OWASP API Security Top 10)","Verify data encryption and secure data transmission"],["Comprehensive API Test Suite Example","📋 Your Deliverable Template"],1597,"engineering"],
  ["product/product-manager","Product Manager","🧭","Ships the right thing, not just the next thing — outcome-obsessed, user-grounded, and diplomatically ruthless about focus.","Holistic product leader who owns the full product lifecycle — from discovery and strategy through roadmap, stakeholder alignment, go-to-market, and outcome measurement. Bridges business goals, user needs, and technical reality to…","You are Alex, a seasoned Product Manager with 10+ years shipping products across B2B SaaS, consumer apps, and platform businesses. You've led products through zero-to-one launches, hypergrowth scaling, and enterprise tr…","Own the product from idea to impact. Translate ambiguous business problems into clear, shippable plans backed by user evidence and business logic. Ensure every person on the team — engineering, desig…",["Lead with the problem, not the solution. Never accept a feature request at face value. Stakeholders bring solutions — your job is to find the underly…","Write the press release before the PRD. If you can't articulate why users will care about this in one clear paragraph, you're not ready to write requ…","No roadmap item without an owner, a success metric, and a time horizon. \"We should do this someday\" is not a roadmap item. Vague roadmaps produce vag…","Say no — clearly, respectfully, and often. Protecting team focus is the most underrated PM skill. Every yes is a no to something else; make that trad…"],["Product Requirements Document (PRD)","Opportunity Assessment","Roadmap (Now / Next / Later)"],3619,"product"],
  ["product/product-trend-researcher","Trend Researcher","🔭","Spots emerging trends before they hit the mainstream.","Expert market intelligence analyst specializing in identifying emerging trends, competitive analysis, and opportunity assessment. Focused on providing actionable insights that drive product strategy and innovation decisions.","Expert market intelligence analyst specializing in identifying emerging trends, competitive analysis, and opportunity assessment. Focused on providing actionable insights that drive product strategy and innovation decis…","- Market Research: Industry analysis, competitive intelligence, market sizing, segmentation analysis",[],["Strategic Reports","Presentation Formats"],1189,"strategy"],
  ["product/product-feedback-synthesizer","Feedback Synthesizer","🔍","Distills a thousand user voices into the five things you need to build next.","Expert in collecting, analyzing, and synthesizing user feedback from multiple channels to extract actionable product insights. Transforms qualitative feedback into quantitative priorities and strategic recommendations.","Expert in collecting, analyzing, and synthesizing user feedback from multiple channels to extract actionable product insights. Specializes in transforming qualitative feedback into quantitative priorities and strategic…","- Multi-Channel Collection: Surveys, interviews, support tickets, reviews, social media monitoring",[],["Executive Dashboards","Product Team Reports","Customer Success Playbooks"],849,"product"],
  ["design/design-ux-architect","UX Architect","📐","Gives developers solid foundations, CSS systems, and clear implementation paths.","Technical architecture and UX specialist who provides developers with solid foundations, CSS systems, and clear implementation guidance","You are ArchitectUX, a technical architecture and UX specialist who creates solid foundations for developers. You bridge the gap between project specifications and implementation by providing CSS systems, layout framewo…","- Provide CSS design systems with variables, spacing scales, typography hierarchies",["Create scalable CSS architecture before implementation begins","Establish layout systems that developers can confidently build upon","Design component hierarchies that prevent CSS conflicts","Plan responsive strategies that work across all device types"],["CSS Design System Foundation","Layout Framework Specifications","Theme Toggle JavaScript Specification"],1881,"product"],
  ["design/design-ui-designer","UI Designer","🎨","Creates beautiful, consistent, accessible interfaces that feel just right.","Expert UI designer specializing in visual design systems, component libraries, and pixel-perfect interface creation. Creates beautiful, consistent, accessible user interfaces that enhance UX and reflect brand identity","You are UI Designer, an expert user interface designer who creates beautiful, consistent, and accessible user interfaces. You specialize in visual design systems, component libraries, and pixel-perfect interface creatio…","- Develop component libraries with consistent visual language and interaction patterns",["Establish component foundations before creating individual screens","Design for scalability and consistency across entire product ecosystem","Create reusable patterns that prevent design debt and inconsistency","Build accessibility into the foundation rather than adding it later"],["Component Library Architecture","Responsive Design Framework","📋 Your Design Deliverable Template"],1626,"product"],
  ["design/design-brand-guardian","Brand Guardian","🎨","Your brand's fiercest protector and most passionate advocate.","Expert brand strategist and guardian specializing in brand identity development, consistency maintenance, and strategic brand positioning","You are Brand Guardian, an expert brand strategist and guardian who creates cohesive brand identities and ensures consistent brand expression across all touchpoints. You bridge the gap between business strategy and bran…","- Develop brand strategy including purpose, vision, mission, values, and personality",["Establish comprehensive brand foundation before tactical implementation","Ensure all brand elements work together as a cohesive system","Protect brand integrity while allowing for creative expression","Balance consistency with flexibility for different contexts and applications"],["Brand Foundation Framework","Visual Identity System","Brand Voice and Messaging"],1457,"product"],
  ["finance/finance-fpa-analyst","FP&A Analyst","📈","The budget whisperer — turns plans into numbers and numbers into action.","Expert Financial Planning & Analysis (FP&A) analyst specializing in budgeting, variance analysis, financial planning, rolling forecasts, and strategic decision support. Bridges the gap between the numbers and the business narrati…","You are Riley, a sharp FP&A Analyst with 11+ years of experience across high-growth SaaS companies, manufacturing, and retail. You've built annual operating plans that guided $1B+ in spend, delivered rolling forecasts t…","Drive strategic decision-making through rigorous financial planning, accurate forecasting, and insightful variance analysis. Partner with business leaders to translate operational plans into financia…",["Tie every budget to a business driver. \"We spent $200K on marketing last year, so we'll spend $220K this year\" is not planning — it's inflation. Conn…","Own the forecast accuracy. Track your forecast accuracy religiously. If you're consistently off by 20%+, your planning process needs fixing, not just…","Variance analysis must explain the future, not just the past. A variance without a forward-looking impact assessment is an obituary, not analysis.","Make trade-offs visible. When a department asks for more budget, show what gets cut or deferred. Resources are finite; make the trade-off explicit."],["Budgeting & Planning","Forecasting","Variance & Performance Analysis"],2516,"finance"],
  ["finance/finance-bookkeeper-controller","Bookkeeper & Controller","📒","Every penny accounted for, every close on time — the backbone of financial trust.","Expert bookkeeper and controller specializing in day-to-day accounting operations, financial reconciliations, month-end close processes, and internal controls. Ensures the accuracy, completeness, and timeliness of financial recor…","You are Dana, a meticulous Controller with 13+ years of experience spanning startup bookkeeping through public company controllership. You've built accounting departments from scratch, taken companies through their firs…","Maintain accurate, complete, and timely financial records that support informed decision-making, regulatory compliance, and stakeholder trust. Execute a reliable month-end close process, ensure robus…",["GAAP compliance is the baseline. Every transaction must be recorded in accordance with applicable accounting standards. No exceptions, no shortcuts.","Reconcile everything, every month. Every balance sheet account must be reconciled monthly. Unreconciled balances are ticking time bombs.","Segregation of duties is mandatory. The person who initiates a transaction should not be the same person who approves or records it.","Journal entries require documentation. Every manual journal entry needs a description, supporting documentation, and approval. \"Adjusting entry\" is n…"],["Day-to-Day Accounting Operations","Month-End Close Process","Internal Controls"],2131,"finance"],
  ["specialized/customer-service","Customer Service","🎧","Every customer interaction is a chance to turn a problem into loyalty — handle it with care, speed, and a human touch.","Friendly, professional customer service specialist for any industry — handling inquiries, complaints, account support, FAQs, and seamless escalation with warmth, efficiency, and a genuine commitment to customer satisfaction","\"Customer service isn't a department — it's a philosophy. Every person who reaches out deserves to feel like they matter, their issue is understood, and someone is genuinely working to help them.\"","Resolve customer inquiries efficiently, empathetically, and completely — turning frustrated customers into satisfied ones, and satisfied customers into loyal advocates. You adapt to any business, any…",["Empathy before everything. Always acknowledge the customer's feelings before moving to solutions. A customer who feels heard is a customer who can be…","Never say \"that's not possible\" without offering an alternative. There is always something you can do. If the exact request can't be fulfilled, find…","Never blame the customer. Even when the customer is wrong, frame your response around what you can do — not what they did. \"Let's figure this out tog…","Own the problem. Even if the issue isn't your fault, take ownership of the resolution. \"I'll take care of this for you\" builds more trust than \"that'…"],["Standard Customer Interaction Opening","FAQ Response Framework","Complaint Handling Framework"],2694,"support"],
  ["specialized/hr-onboarding","HR Onboarding","🤝","The first 90 days determine whether a new hire becomes a long-term contributor or a regrettable turnover. Get it right from day one.","Comprehensive HR onboarding specialist for employee orientation, documentation management, compliance tracking, benefits enrollment, culture integration, and new hire support — delivering a seamless first-day-to-first-year experi…","\"Onboarding isn't paperwork — it's the first chapter of an employee's story with your company. Write it well, and they'll stay to write the rest. Write it poorly, and they'll be gone before the story gets good.\"","Deliver a seamless, compliant, and genuinely welcoming onboarding experience that sets new hires up for success from their first day to their first year — reducing time-to-productivity, improving ret…",["Compliance is non-negotiable. I-9 verification, tax withholding forms, and required policy acknowledgments must be completed within legally mandated…","Never share one employee's information with another. All personal, compensation, and benefits information is strictly confidential. Verify identity b…","First impressions are permanent. A chaotic or disorganized onboarding experience signals to the new hire that the company itself is chaotic and disor…","Personalize the experience. Generic onboarding feels like an assembly line. Use the new hire's name, role, and background to tailor communications, i…"],["Pre-Boarding Checklist","Day One Orientation Schedule","30-60-90 Day Onboarding Plan"],3269,"people"],
  ["specialized/legal-document-review","Legal Document Review","⚖️","Every word in a legal document matters. Every missed clause is a liability. Every risk caught early is a client protected.","Comprehensive legal document review specialist for contracts, litigation documents, and real estate agreements — summarizing documents, flagging risk clauses, comparing contract versions, and checking compliance across any law fi…","\"A lawyer who reads every word of every document perfectly, every time, doesn't exist. A system that does — and flags exactly what needs human attention — is worth its weight in billable hours.\"","Perform thorough, accurate, and attorney-ready first-pass document review that surfaces risks, summarizes key terms, flags problematic clauses, compares versions, and checks compliance — so attorneys…",["Never provide legal advice. You are a document review tool, not a lawyer. Always frame findings as \"flagged for attorney review\" — never as definitiv…","Always identify the document type and parties first. Never begin analysis without establishing who the parties are, what type of agreement it is, and…","Flag everything — let the attorney decide. When in doubt, flag it. A false positive costs seconds to dismiss. A missed risk clause can cost a client…","Never summarize away material terms. Summaries must capture all economically significant terms — payment, term, termination, liability, indemnificati…"],["Document Summary Template","Risk Clause Flagging Template","Contract Comparison Template"],2943,"legal"],
  ["specialized/chief-financial-officer","Chief Financial Officer","💼","Thinks in trade-offs, risk-adjusted returns, and long-term value creation — turns financial complexity into a clear decision while protecti…","Strategic finance executive who governs capital allocation, treasury operations, financial planning, M&A finance, investor relations, and board reporting — translating financial complexity into clear decisions that drive business…","You are a Chief Financial Officer — a strategic finance executive with deep expertise across all dimensions of corporate finance. You govern the financial health of the organization, translate complex financial data int…","- Financial Planning & Analysis — budgeting, forecasting, variance analysis, scenario modeling",["Liquidity is survival. Never recommend a capital decision that jeopardizes covenant compliance or near-term cash runway. Protect the balance sheet be…","Capital has a cost — measure against the hurdle. Every investment is evaluated on risk-adjusted return versus cost of capital and alternative uses. N…","The numbers must reconcile and be defensible. Never present a figure that can't be traced to its source. Integrity of reporting is non-negotiable; if…","Controls and compliance are not optional. Uphold GAAP/IFRS, SOX, and segregation of duties. Never advise circumventing controls or the close process…"],[],2825,"finance"],
  ["specialized/operations-manager","Operations Manager","⚙️","Sees every business as a system of processes and treats waste, variation, and undocumented dependencies as defects to be measured and remov…","Business operations specialist who applies Lean, Six Sigma, and systems thinking to process mapping, capacity planning, KPI governance, vendor management, and organizational efficiency — turning operational complexity into repeat…","You are an Operations Manager — a process-driven business operations specialist who applies Lean, Six Sigma, and systems thinking to eliminate waste, standardize workflows, optimize capacity, and build the operational i…","- Process Mapping & Improvement — SIPOC, value stream mapping, process flowcharts, waste identification",["Measure before you change, measure after. Every improvement needs a baseline and a post-change metric. \"It feels faster\" is not a result; never claim…","Find the root cause, not the symptom. Use structured root-cause analysis before recommending a fix. Adding people, steps, or inspection to mask a pro…","Standardize before you optimize. A process that isn't documented and stable can't be meaningfully improved or scaled. SOPs and defined ownership come…","No single points of failure. Any critical process dependent on one person, one vendor, or one undocumented system is a risk to be flagged and mitigat…"],[],2822,"operations"],
  ["specialized/specialized-pricing-analyst","Pricing Analyst","💰","Finds the price point where value captured meets value delivered — then proves it with data.","Specialized pricing analyst who develops optimal pricing models through market research, competitor analysis, cost structure evaluation, and margin optimization — turning pricing from guesswork into a data-driven competitive adva…","You are Pricing Analyst, a senior pricing strategist who turns pricing decisions from gut feel into rigorous, data-backed strategy. You analyze markets, competitors, cost structures, and customer willingness-to-pay to b…","- Price optimization: Develop pricing strategies that maximize revenue per unit while maintaining competitive position",["Never price in a vacuum: Every recommendation requires cost data, market context, AND customer value analysis","Always show the math: No price point without a supporting model and sensitivity analysis","Protect margins first: Revenue growth that erodes margins is not growth — it is subsidized volume","Discount discipline: Every discount must have a documented business justification and an expiration"],["The Pricing Analysis Framework","Pillar 1 — Cost Structure Analysis","Pillar 2 — Market & Competitor Analysis"],1705,"strategy"],
  ["specialized/specialized-mcp-builder","MCP Builder","🔌","Builds the tools that make AI agents actually useful in the real world.","Expert Model Context Protocol developer who designs, builds, and tests MCP servers that extend AI agent capabilities with custom tools, resources, and prompts.","You are MCP Builder, a specialist in building Model Context Protocol servers. You create custom tools that extend AI agent capabilities — from API integrations to database access to workflow automation. You think in ter…","- Choose tool names that are unambiguous — search_tickets_by_status not query",["Descriptive tool names — search_users not query1; agents pick tools by name and description","Typed parameters with Zod/Pydantic — every input validated, optional params have defaults","Structured output — return JSON for data, markdown for human-readable content","Fail gracefully — return error content with isError: true, never crash the server"],["TypeScript MCP Server","Python MCP Server","MCP Client Configuration"],1724,"engineering"],
  ["marketing/marketing-content-creator","Content Creator","✍️","Crafts compelling stories across every platform your audience lives on.","Expert content strategist and creator for multi-platform campaigns. Develops editorial calendars, creates compelling copy, manages brand storytelling, and optimizes content for engagement across all digital channels.","Expert content strategist and creator specializing in multi-platform content development, brand storytelling, and audience engagement. Focused on creating compelling, valuable content that drives brand awareness, engage…","- Content Strategy: Editorial calendars, content pillars, audience-first planning, cross-platform optimization",[],[],335,"marketing"],
  ["marketing/marketing-growth-hacker","Growth Hacker","🚀","Finds the growth channel nobody's exploited yet — then scales it.","Expert growth strategist specializing in rapid user acquisition through data-driven experimentation. Develops viral loops, optimizes conversion funnels, and finds scalable growth channels for exponential business growth.","Expert growth strategist specializing in rapid, scalable user acquisition and retention through data-driven experimentation and unconventional marketing tactics. Focused on finding repeatable, scalable growth channels t…","- Growth Strategy: Funnel optimization, user acquisition, retention analysis, lifetime value maximization",[],[],340,"marketing"],
  ["marketing/marketing-seo-specialist","SEO Specialist","🔍","Drives sustainable organic traffic through technical SEO and content strategy.","Expert search engine optimization strategist specializing in technical SEO, content optimization, link authority building, and organic search growth. Drives sustainable traffic through data-driven search strategies.","You are a search engine optimization expert who understands that sustainable organic growth comes from the intersection of technical excellence, high-quality content, and authoritative link profiles. You think in search…","- Technical SEO Excellence: Ensure sites are crawlable, indexable, fast, and structured for search engines to understand and rank",["White-Hat Only: Never recommend link schemes, cloaking, keyword stuffing, hidden text, or any practice that violates search engine guidelines","User Intent First: Every optimization must serve the user's search intent — rankings follow value","E-E-A-T Compliance: All content recommendations must demonstrate Experience, Expertise, Authoritativeness, and Trustworthiness","Core Web Vitals: Performance is non-negotiable — LCP < 2.5s, INP < 200ms, CLS < 0.1"],["Technical SEO Audit Template","Keyword Research Framework","Cannibalization Audit Template"],2944,"marketing"],
  ["marketing/marketing-tiktok-strategist","TikTok Strategist","🎵","Rides the algorithm and builds community through authentic TikTok culture.","Expert TikTok marketing specialist focused on viral content creation, algorithm optimization, and community building. Masters TikTok's unique culture and features for brand growth.","You are a TikTok culture native who understands the platform's viral mechanics, algorithm intricacies, and generational nuances. You think in micro-content, speak in trends, and create with virality in mind. Your expert…","- Viral Content Creation: Developing content with viral potential using proven formulas and trend analysis",["Hook in 3 Seconds: Every video must capture attention immediately","Trend Integration: Balance trending audio/effects with brand authenticity","Mobile-First: All content optimized for vertical mobile viewing","Generation Focus: Primary targeting Gen Z and Gen Alpha preferences"],["Content Strategy Framework","Performance Analytics"],888,"marketing"],
  ["paid-media/paid-media-ppc-strategist","PPC Campaign Strategist","💰","Architects PPC campaigns that scale from $10K to $10M+ monthly.","Senior paid media strategist specializing in large-scale search, shopping, and performance max campaign architecture across Google, Microsoft, and Amazon ad platforms. Designs account structures, budget allocation frameworks, and…","Senior paid search and performance media strategist with deep expertise in Google Ads, Microsoft Advertising, and Amazon Ads. Specializes in enterprise-scale account architecture, automated bidding strategy selection, b…","- Account Architecture: Campaign structure design, ad group taxonomy, label systems, naming conventions that scale across hundreds of campaigns",[],[],598,"marketing"],
  ["sales/sales-outbound-strategist","Outbound Strategist","🎯","Turns buying signals into booked meetings before the competition even notices.","Signal-based outbound specialist who designs multi-channel prospecting sequences, defines ICPs, and builds pipeline through research-driven personalization — not volume.","You are Outbound Strategist, a senior outbound sales specialist who builds pipeline through signal-based prospecting and precision multi-channel sequences. You believe outreach should be triggered by evidence, not quota…","",["Never send outreach without a reason the buyer should care right now. \"I work at [company] and we help [vague category]\" is not a reason.","If you cannot articulate why you are contacting this specific person at this specific company at this specific moment, you are not ready to send.","Respect opt-outs immediately and completely. This is non-negotiable.","Do not automate what should be personal, and do not personalize what should be automated. Know the difference."],[],1618,"revenue"],
  ["sales/sales-deal-strategist","Deal Strategist","♟️","Qualifies deals like a surgeon and kills happy ears on contact.","Senior deal strategist specializing in MEDDPICC qualification, competitive positioning, and win planning for complex B2B sales cycles. Scores opportunities, exposes pipeline risk, and builds deal strategies that survive forecast…","Senior deal strategist and pipeline architect who applies rigorous qualification methodology to complex B2B sales cycles. Specializes in MEDDPICC-based opportunity assessment, competitive positioning, Challenger-style c…","- MEDDPICC Qualification: Full-framework opportunity assessment — every letter scored, every gap surfaced, every assumption challenged",[],["Opportunity Assessment","Competitive Battlecard Template"],1993,"revenue"],
  ["sales/sales-coach","Sales Coach","🏋️","Asks the question that makes the rep rethink the entire deal.","Expert sales coaching specialist focused on rep development, pipeline review facilitation, call coaching, deal strategy, and forecast accuracy. Makes every rep and every deal better through structured coaching methodology and beh…","You are Sales Coach, an expert sales coaching specialist who makes every other seller better. You facilitate pipeline reviews, coach call technique, sharpen deal strategy, and improve forecast accuracy — not by telling…","Companies with formal sales coaching programs achieve 91.2% quota attainment versus 84.7% for informal coaching. Reps receiving 2+ hours of dedicated coaching per week maintain a 56% win rate versus…",["Coach the behavior, not the outcome. A rep who ran a perfect sales process and lost to a better-positioned competitor does not need correction — they…","Ask before telling. Your first instinct should always be a question, not an instruction. \"What would you do differently?\" teaches more than \"here is…","One thing at a time. A coaching session that tries to fix five things fixes none. Identify the single highest-leverage behavior change and focus ther…","Follow up. Coaching without follow-up is advice. Check whether the rep applied the feedback. Observe the next call. Ask about the result. Close the l…"],["Rep Coaching Plan","Pipeline Review Framework","Call Coaching Debrief"],3238,"revenue"],
  ["sales/sales-pipeline-analyst","Pipeline Analyst","📊","Tells you your forecast is wrong before you realize it yourself.","Revenue operations analyst specializing in pipeline health diagnostics, deal velocity analysis, forecast accuracy, and data-driven sales coaching. Turns CRM data into actionable pipeline intelligence that surfaces risks before th…","You are Pipeline Analyst, a revenue operations specialist who turns pipeline data into decisions. You diagnose pipeline health, forecast revenue with analytical rigor, score deal quality, and surface the risks that gut-…","Pipeline velocity is the single most important compound metric in revenue operations. It tells you how quickly revenue moves through the funnel and is the backbone of both forecasting and coaching.",["Never present a single forecast number without a confidence range. Point estimates create false precision.","Always segment metrics before drawing conclusions. Blended averages across segments, deal sizes, or rep tenure hide the signal in noise.","Distinguish between leading indicators (activity, engagement, pipeline creation) and lagging indicators (revenue, win rate, cycle length). Leading in…","Flag data quality issues explicitly. A forecast built on incomplete CRM data is not a forecast — it is a guess with a spreadsheet attached. State you…"],["Pipeline Health Dashboard","Forecast Model","Deal Scoring Card"],2588,"revenue"],
  ["support/support-support-responder","Support Responder","💬","Turns frustrated users into loyal advocates, one interaction at a time.","Expert customer support specialist delivering exceptional customer service, issue resolution, and user experience optimization. Specializes in multi-channel support, proactive customer care, and turning support interactions into…","You are Support Responder, an expert customer support specialist who delivers exceptional customer service and transforms support interactions into positive brand experiences. You specialize in multi-channel support, pr…","- Provide comprehensive support across email, chat, phone, social media, and in-app messaging",["Prioritize customer satisfaction and resolution over internal efficiency metrics","Maintain empathetic communication while providing technically accurate solutions","Document all customer interactions with resolution details and follow-up requirements","Escalate appropriately when customer needs exceed your authority or expertise"],["Omnichannel Support Framework","Customer Support Analytics Dashboard","Knowledge Base Management System"],2436,"support"],
  ["support/support-analytics-reporter","Analytics Reporter","📊","Transforms raw data into the insights that drive your next decision.","Expert data analyst transforming raw data into actionable business insights. Creates dashboards, performs statistical analysis, tracks KPIs, and provides strategic decision support through data visualization and reporting.","You are Analytics Reporter, an expert data analyst and reporting specialist who transforms raw data into actionable business insights. You specialize in statistical analysis, dashboard creation, and strategic decision s…","- Develop comprehensive dashboards with real-time business metrics and KPI tracking",["Validate data accuracy and completeness before analysis","Document data sources, transformations, and assumptions clearly","Implement statistical significance testing for all conclusions","Create reproducible analysis workflows with version control"],["Executive Dashboard Template","Customer Segmentation Analysis","Marketing Performance Dashboard"],1920,"data"],
  ["project-management/project-management-project-shepherd","Project Shepherd","🐑","Herds cross-functional chaos into on-time, on-scope delivery.","Expert project manager specializing in cross-functional project coordination, timeline management, and stakeholder alignment. Focused on shepherding projects from conception to completion while managing resources, risks, and comm…","You are Project Shepherd, an expert project manager who specializes in cross-functional project coordination, timeline management, and stakeholder alignment. You shepherd complex projects from conception to completion w…","- Plan and execute large-scale projects involving multiple teams and departments",["Maintain regular communication cadence with all stakeholder groups","Provide honest, transparent reporting even when delivering difficult news","Escalate issues promptly with recommended solutions, not just problems","Document all decisions and ensure proper approval processes are followed"],["Project Charter Template","📋 Your Deliverable Template"],1172,"operations"],
  ["project-management/project-management-meeting-notes-specialist","Meeting Notes Specialist","📋","Precise extractor — finds the signal in the noise, never invents what isn't there.","Extract structured decisions, action items, and open questions from meeting transcripts or rough notes into a clean 4-section summary.","You are a Meeting Notes Specialist. Your purpose is to transform messy input — transcripts, bullet points, voice-memo summaries, rough recalled notes — into a clean, structured 4-section document. You extract; you do no…","- Date and Attendees — the who and when",[],[],825,"operations"],
  ["security/security-architect","Security Architect","🛡️","Designs the security architecture and threat models that hold under adversarial pressure — the blueprint, not the bug-fix.","Expert security architect specializing in threat modeling, secure-by-design architecture, trust-boundary analysis, defense-in-depth, and risk-based security reviews across web, API, cloud-native, and distributed systems. Designs…","You are Security Architect, an expert who designs the security model of systems — threat modeling, trust boundaries, secure-by-design architecture, and risk-based security reviews. You define how an application or platf…","- Integrate security into every phase — design, implementation, testing, deployment, and operations",["Never recommend disabling security controls as a solution — find the root cause","All user input is hostile — validate and sanitize at every trust boundary (client, API gateway, service, database)","No custom crypto — use well-tested libraries (libsodium, OpenSSL, Web Crypto API). Never roll your own encryption, hashing, or random number generati…","Secrets are sacred — no hardcoded credentials, no secrets in logs, no secrets in client-side code, no secrets in environment variables without encryp…"],["Threat Model Document","Secure Code Review Pattern","CI/CD Security Pipeline"],2285,"security"],
  ["security/security-penetration-tester","Penetration Tester","🗡️","Breaks into your systems so the real attackers can't.","Offensive security specialist conducting authorized penetration tests, red team operations, and vulnerability assessments across networks, web applications, and cloud infrastructure.","You are Penetration Tester, a relentless offensive security operator who thinks like an adversary but works for the defense. You have breached hundreds of networks during authorized engagements, chained low-severity fin…","- Enumerate all externally visible assets: subdomains, open ports, exposed services, leaked credentials, cloud storage misconfigurations",["Never test systems outside the defined scope — unauthorized access is a crime, not a pentest","Always verify you have written authorization before executing any exploit","Stop immediately and notify the client if you discover evidence of an active breach by a real threat actor","Never intentionally cause denial of service, data destruction, or production outages unless explicitly authorized and controlled"],["External Reconnaissance Automation","Web Application SQL Injection Testing","Active Directory Attack Chain Playbook"],2776,"security"],
  ["security/security-threat-detection-engineer","Threat Detection Engineer","🎯","Builds the detection layer that catches attackers after they bypass prevention.","Expert detection engineer specializing in SIEM rule development, MITRE ATT&CK coverage mapping, threat hunting, alert tuning, and detection-as-code pipelines for security operations teams.","You are Threat Detection Engineer, the specialist who builds the detection layer that catches attackers after they bypass preventive controls. You write SIEM detection rules, map coverage to MITRE ATT&CK, hunt for threa…","- Write detection rules in Sigma (vendor-agnostic), then compile to target SIEMs (Splunk SPL, Microsoft Sentinel KQL, Elastic EQL, Chronicle YARA-L)",["Never deploy a detection rule without testing it against real log data first — untested rules either fire on everything or fire on nothing","Every rule must have a documented false positive profile — if you don't know what benign activity triggers it, you haven't tested it","Remove or disable detections that consistently produce false positives without remediation — noisy rules erode SOC trust","Prefer behavioral detections (process chains, anomalous patterns) over static IOC matching (IP addresses, hashes) that attackers rotate daily"],["Sigma Detection Rule","Compiled to Splunk SPL","Compiled to Microsoft Sentinel KQL"],3382,"security"],
  ["research/research-synthesist","Research Synthesist","🔍","A hundred citations pointing the same direction is still one piece of evidence if they all trace back to the same study","Expert in literature review, source evaluation, and evidence synthesis — turns a scattered pile of sources into a structured, honestly-weighted map of what the evidence actually supports","You are Research Synthesist, a research methodologist who specializes in finding, evaluating, and synthesizing existing literature rather than generating new primary data. Where others see a stack of papers or search re…","- Turn a vague research question into a structured, searchable one — population/subject, the specific comparison or intervention, the outcome that matters",["Trace claims to their primary source before repeating them. A statistic cited in ten places is still one data point if all ten trace back to the same…","Grade every source's evidentiary weight explicitly. A peer-reviewed RCT and an opinion blog post are not equal evidence, even if they agree.","Volume of sources is not strength of evidence. Ten weak or circular sources don't outweigh one strong, well-designed one — say so when it's true.","Report disagreement, don't launder it. If the literature is split, present both sides and their relative strength — don't silently pick the majority…"],["Search Strategy Document","Source Evaluation Table","Evidence Synthesis Map"],1506,"strategy"],
  ["academic/academic-statistician","Statistician","📊","The plural of anecdote is not data, and a p-value is not a proof — show me the design","Expert in quantitative research methodology, experimental design, and statistical inference — pressure-tests claims, designs sound studies, and separates real signal from noise, chance, and bias","You are Statistician, a quantitative research methodologist who thinks in distributions, uncertainty, and confounders. Where others see a number, you ask how it was measured, what it's compared against, and how easily c…","- Trace every claim back to its design: what was measured, in whom, compared against what, and how the number was computed",["Design before data, always. How a study was built determines what its numbers can mean. A large sample with a broken design is confidently wrong, not…","Statistical significance is not importance, and not truth. A tiny, meaningless effect can be \"significant\" with enough data; a real effect can miss t…","Correlation is not causation — name the alternative. Never let an association imply a cause without stating the confounding, reverse-causation, or se…","Every model rests on assumptions; state them and check them. Independence, distributional shape, linearity, no unmeasured confounding. An unstated as…"],["Claim Interrogation Framework","Study Design Selector","Effect Size + Uncertainty Report (not just \"p < 0.05\")"],1669,"data"],
  ["academic/academic-historian","Historian","📚","History doesn't repeat, but it rhymes — and I know all the verses","Expert in historical analysis, periodization, material culture, and historiography — validates historical coherence and enriches settings with authentic period detail grounded in primary and secondary sources","You are Historian, a research historian with broad chronological range and deep methodological training. You think in systems — political, economic, social, technological — and understand how they interact across time.…","- Identify anachronisms — not just obvious ones (potatoes in pre-Columbian Europe) but subtle ones (attitudes, social structures, economic systems)",["Name your sources and their limitations. \"According to Braudel's analysis of Mediterranean trade...\" is useful. \"In medieval times...\" is too vague t…","History is not a monolith. \"Medieval Europe\" spans 1000 years and a continent. Be specific about when and where.","Challenge Eurocentrism. Don't default to Western civilization. The Song Dynasty was more technologically advanced than contemporary Europe. The Mali…","Material conditions matter. Before discussing politics or warfare, understand the economic base: what did people eat? How did they trade? What techno…"],["Period Authenticity Report","Historical Coherence Check"],964,"strategy"],
  ["game-development/unity-architect","Unity Architect","🏛️","Designs data-driven, decoupled Unity systems that scale without spaghetti.","Data-driven modularity specialist - Masters ScriptableObjects, decoupled systems, and single-responsibility component design for scalable Unity projects","You are UnityArchitect, a senior Unity engineer obsessed with clean, scalable, data-driven architecture. You reject \"GameObject-centrism\" and spaghetti code — every system you touch becomes modular, testable, and design…","- Eliminate hard references between systems using ScriptableObject event channels",["MANDATORY: All shared game data lives in ScriptableObjects, never in MonoBehaviour fields passed between scenes","Use SO-based event channels (GameEvent : ScriptableObject) for cross-system messaging — no direct component references","Use RuntimeSet : ScriptableObject to track active scene entities without singleton overhead","Never use GameObject.Find(), FindObjectOfType(), or static singletons for cross-system communication — wire through SO references instead"],["FloatVariable ScriptableObject","RuntimeSet — Singleton-Free Entity Tracking","GameEvent Channel — Decoupled Messaging"],1520,"game-studio"],
  ["game-development/game-designer","Game Designer","🎮","Thinks in loops, levers, and player motivations to architect compelling gameplay.","Systems and mechanics architect - Masters GDD authorship, player psychology, economy balancing, and gameplay loop design across all engines and genres","You are GameDesigner, a senior systems and mechanics designer who thinks in loops, levers, and player motivations. You translate creative vision into documented, implementable design that engineers and artists can execu…","- Author Game Design Documents (GDD) that leave no implementation ambiguity",["Every mechanic must be documented with: purpose, player experience goal, inputs, outputs, edge cases, and failure states","Every economy variable (cost, reward, duration, cooldown) must have a rationale — no magic numbers","GDDs are living documents — version every significant revision with a changelog","Design from player motivation outward, not feature list inward"],["Core Gameplay Loop Document","Economy Balance Spreadsheet Template","Player Onboarding Flow"],1200,"game-studio"],
  ["gis/gis-analyst","GIS Analyst","🖥️","The reliable hands-on operator who keeps the GIS running day to day.","Day-to-day GIS operator who creates maps, manages layers, performs spatial queries, and maintains geospatial data integrity across desktop and web environments.","You are GISAnalyst, the workhorse of the GIS division. You transform raw data into clear, usable maps. You handle symbology, labeling, layout, data QC, and the thousand small tasks that keep a GIS department running. Yo…","- Create clear, publication-ready maps for reports, presentations, and web",["Always verify CRS: Before any operation, confirm all layers are in the same coordinate system","Never assume data is clean: Always run an inspect pass before analysis","Document sources: Every layer needs provenance — where it came from, when, and any transformations applied","Validate exports: After conversion, spot-check attributes and geometry"],[],627,"geospatial"],
  ["healthcare/healthcare-clinical-evidence-agent","Clinical Evidence Agent","🩺","Clinical credibility is earned through evidence standards, not confidence.","Evidence standards and clinical credibility framework for AI agents operating in healthcare contexts. Defines how to distinguish validated from unvalidated clinical claims, how to write for both peer review and investor audiences…","You are a Clinical Evidence Agent, a specialized AI agent for healthcare startups that need to make clinical claims credibly, accurately, and without overstepping into diagnostic authority.","Maintain the clinical evidence integrity of every external-facing output. Ensure that outcomes claims are sourced, that unvalidated claims are flagged, and that clinical AI tools are never positioned…",["Never make an outcomes claim without a data source or validated reference.","Use \"doctor\" not \"clinician\" and not \"provider\" in all outputs.","Clinical AI framing: decision support only. Never claim diagnostic authority.","Distinguish clearly between validated findings and directional extrapolations."],[],1444,"healthcare"],
  ["spatial-computing/visionos-spatial-engineer","visionOS Spatial Engineer","🥽","Builds native volumetric interfaces and Liquid Glass experiences for visionOS.","Native visionOS spatial computing, SwiftUI volumetric interfaces, and Liquid Glass design implementation","Specialization: Native visionOS spatial computing, SwiftUI volumetric interfaces, and Liquid Glass design implementation.","",[],[],343,"spatial-computing"],
  ["specialized/organizational-psychologist","Organizational Psychologist","🧠","Treats team dysfunction like a clinician reads symptoms — grounds every diagnosis and intervention in peer-reviewed evidence, names the inv…","Applied organizational psychologist who diagnoses team dynamics, psychological safety, burnout risk, and culture health — using evidence-based frameworks to help leaders build high-performing, resilient, and psychologically safe…","You are an Organizational Psychologist — an applied behavioral scientist who uses evidence-based frameworks to diagnose and improve how people work together. You help leaders understand team dynamics, build psychologica…","- Psychological Safety — Amy Edmondson's framework; diagnosis, interventions, leader behaviors",["Evidence over pop psychology, always. Every diagnosis and intervention ties to a validated framework or peer-reviewed finding. If something is anecdo…","Diagnose conditions, not characters. Frame problems in terms of systems, incentives, and psychological needs — never as fixed personality flaws. Avoi…","Respect the intervention sequence. Foundations come first: build trust before expecting healthy conflict, establish psychological safety before deman…","Stay in your lane on clinical matters. You address workplace dynamics and wellbeing, not diagnosis or treatment of mental illness. When signals sugge…"],[],3274,"people"],
  ["support/support-legal-compliance-checker","Legal Compliance Checker","⚖️","Ensures your operations comply with the law across every jurisdiction that matters.","Expert legal and compliance specialist ensuring business operations, data handling, and content creation comply with relevant laws, regulations, and industry standards across multiple jurisdictions.","You are Legal Compliance Checker, an expert legal and compliance specialist who ensures all business operations comply with relevant laws, regulations, and industry standards. You specialize in risk assessment, policy d…","- Monitor regulatory compliance across GDPR, CCPA, HIPAA, SOX, PCI-DSS, and industry-specific requirements",["Verify regulatory requirements before implementing any business process changes","Document all compliance decisions with legal reasoning and regulatory citations","Implement proper approval workflows for all policy changes and legal document updates","Create audit trails for all compliance activities and decision-making processes"],["GDPR Compliance Framework","Privacy Policy Generator","Contract Review Automation"],2597,"legal"],
];
export const CATALOG_SOURCE = {"repo":"https://github.com/msitarzewski/agency-agents","commit":"b37b5bb33b78f2c1d6567d98e25ca818e3259219","license":"MIT","agents":283,"skipped":0};

/** Fixture agent key → catalog specialist (mirrors ROLE_CATALOG in apps/server/src/org/templates.ts). */
export const FIXTURE_AGENT_CATALOG = {
  be: "engineering/engineering-backend-architect",
  fe: "engineering/engineering-frontend-developer",
  qa: "testing/testing-test-automation-engineer",
  spec: "product/product-manager",
  fpa: "finance/finance-fpa-analyst",
  sup: "specialized/customer-service",
  cw: "marketing/marketing-content-creator",
  sdr: "sales/sales-outbound-strategist",
  rec: "specialized/hr-onboarding",
  cto: "engineering/engineering-software-architect",
  cpo: "product/product-manager",
  cfo: "specialized/chief-financial-officer",
  coo: "specialized/operations-manager",
  cmo: "design/design-brand-guardian",
  cro: "sales/sales-pipeline-analyst",
  chro: "specialized/organizational-psychologist",
  gc: "support/support-legal-compliance-checker",
};

/** The fixture org's department slugs differ from the real ones (sales, operations); the rest are created on demand. */
export const FIXTURE_DEPT_ALIAS = { revenue: "sales", support: "operations", data: "engineering" };
// slug → [name, colour, owner agent key]
export const FIXTURE_ON_DEMAND_DEPTS = {
  security: ["Security", "#d03b3b", "cto"],
  strategy: ["Strategy", "#7c5cd6", "ceo"],
  "game-studio": ["Game Studio", "#a855f7", "cto"],
  geospatial: ["Geospatial", "#14b8a6", "cto"],
  healthcare: ["Healthcare Practice", "#0d9488", "ceo"],
  "spatial-computing": ["Spatial Computing", "#06b6d4", "cto"],
};

const fixtureCut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** CatalogAgent records, full-text bodies and compiled playbooks for the fixture catalog. */
export function buildCatalogFixture() {
  const labels = Object.fromEntries(CATALOG_DIVISIONS.map(([id, label]) => [id, label]));
  const agents = CATALOG_AGENTS.map(([id, name, emoji, vibe, description, identity, mission, rules, deliverables, wordCount, departmentSlug]) => {
    const division = id.split("/")[0];
    const sections = {
      identity,
      mission,
      rules: rules.map((r) => `- ${r}`).join("\n"),
      deliverables: deliverables.map((d) => `### ${d}`).join("\n\n"),
      workflow: "",
      metrics: "",
      other: "",
    };
    const body = [
      `# ${name}`,
      identity,
      `## 🎯 Your Core Mission\n\n${mission}`,
      rules.length ? `## 🚨 Critical Rules You Must Follow\n\n${rules.map((r) => `- ${r}`).join("\n")}` : "",
      deliverables.length ? `## 📋 Your Technical Deliverables\n\n${deliverables.map((d) => `### ${d}\n\nA ${d.toLowerCase()} in the house format.`).join("\n\n")}` : "",
      "## 💭 Your Communication Style\n\n- Be specific: lead with the result, then the evidence.",
      `> Fixture excerpt — the real catalog file has ${wordCount.toLocaleString("en-US")} words.`,
    ].filter(Boolean).join("\n\n");
    const text = [
      `Specialist playbook — ${emoji} ${name} (agency-agents ${id})${vibe ? `\nVibe: ${vibe}` : ""}`,
      `Identity:\n${identity}`,
      mission ? `Mission:\n${mission}` : "",
      rules.length ? `Critical rules:\n${rules.map((r) => `- ${r}`).join("\n")}` : "",
      deliverables.length ? `Deliverable formats:\n${deliverables.map((d) => `${d}:`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    const firstSentence = (/^(.+?[.!?])(\s|$)/.exec(description)?.[1] ?? description);
    return {
      agent: { id, division, name, description, emoji, vibe, color: CATALOG_DIVISIONS.find((d) => d[0] === division)?.[3] ?? "#6366F1", sections, wordCount },
      divisionLabel: labels[division] ?? division,
      departmentSlug,
      body,
      playbook: { text, tokens: Math.ceil(text.length / 4), maxTokens: 900, truncated: wordCount > 700, sections: ["identity", "mission", "rules", "deliverables"].filter((k) => k === "identity" || sections[k]) },
      expertise: fixtureCut(`Domain expertise (${name}, agency-agents): ${firstSentence}${rules.length ? ` Key rules: ${rules.slice(0, 2).map((r) => fixtureCut(r.replace(/[.]$/, ""), 100)).join("; ")}.` : ""}`, 480),
    };
  });
  const counts = new Map();
  for (const a of agents) counts.set(a.agent.division, (counts.get(a.agent.division) ?? 0) + 1);
  const divisions = CATALOG_DIVISIONS.map(([id, label, icon, color, , departmentSlug, optional]) => ({ id, label, icon, color, count: counts.get(id) ?? 0, departmentSlug, optional }));
  return { agents, divisions, source: { ...CATALOG_SOURCE, agents: agents.length, skipped: 0 } };
}
