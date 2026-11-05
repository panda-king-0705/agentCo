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
  return tier === "executive" ? [...mgr, "hire_agent"] : mgr;
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
