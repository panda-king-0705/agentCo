/**
 * What the deterministic mock "thinks" at each stage. Driven only by the
 * `[[stage:…]]` marker and the `[[context:{…}]]` block (models/protocol.ts).
 *
 * Context fields the engines send (all optional):
 *   mode: "message" | "task"           message: string (chat text)
 *   agent: {name, title, department, departmentSlug}
 *   task: {number, title, description, acceptanceCriteria}
 *   reports: [{id, title, mandate, department}]   tools: string[]
 *   maxSubprocesses, perspectives, ood, uncertaintyHint
 *   results: [{title, status, result}]             solution: string
 *   feedback: string[] (issues to address)         phase: string
 *   okr: {objective, keyResult}                    outcome: string
 */
import type { ChatRequest, ToolCall } from "../../contracts.ts";
import { firstSentence, overlap, slugify, tokens, truncate } from "../../cognition/text.ts";

export interface MockContext {
  mode?: string;
  message?: string;
  agent?: { name?: string; title?: string; department?: string; departmentSlug?: string };
  task?: { number?: number; title?: string; description?: string; acceptanceCriteria?: string | null };
  reports?: { id: string; title?: string; mandate?: string; department?: string }[];
  tools?: string[];
  maxSubprocesses?: number;
  perspectives?: number;
  ood?: boolean;
  results?: { title?: string; status?: string; result?: string | null }[];
  solution?: string;
  feedback?: string[];
  phase?: string;
  okr?: { objective?: string; keyResult?: string };
  outcome?: string;
}

export function asMockContext(raw: Record<string, unknown>): MockContext {
  return raw as MockContext;
}

const WORK_VERBS = [
  "build", "create", "plan", "launch", "research", "write", "analyse", "analyze", "hire", "draft", "prepare",
  "design", "fix", "develop", "implement", "organise", "organize", "produce", "review", "audit", "set up", "ship",
];

/** Chat intent: requests for work → "work"; greetings / questions / small talk → "chat". */
export function classifyIntent(text: string): "chat" | "work" {
  const t = text.trim();
  const lower = t.toLowerCase();
  const hasVerb = WORK_VERBS.some((v) => new RegExp(`\\b${v}`, "i").test(lower));
  if (!hasVerb) return "chat";
  const polite = /\b(can|could|would|will) you\b|\bplease\b|\bi need\b|\bwe need\b|\blet'?s\b/i.test(lower);
  const question = /^(what|why|how|who|when|where|which|is|are|do|does|did|have|has)\b/i.test(lower) || t.endsWith("?");
  return question && !polite ? "chat" : "work";
}

function title(ctx: MockContext): string {
  return ctx.task?.title?.trim() || firstSentence(ctx.message ?? "", 80) || "the assignment";
}

function description(ctx: MockContext): string {
  return ctx.task?.description?.trim() || ctx.message?.trim() || title(ctx);
}

function criteria(ctx: MockContext): string[] {
  const ac = ctx.task?.acceptanceCriteria?.trim();
  if (ac) {
    return ac
      .split(/\n|;|(?<=\.)\s+/)
      .map((s) => s.replace(/^[-*\d.)\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 4);
  }
  return [`A concrete, written deliverable for "${truncate(title(ctx), 60)}"`, "Clear owners, next steps and risks"];
}

const LENSES = ["customer", "economics", "execution risk", "long-term strategy", "people and process"];

/** Department-flavoured body sections so deliverables read as real work. */
function departmentSections(slug: string, subject: string): string[] {
  const s = slug.toLowerCase();
  if (/market|growth|brand|comm/.test(s)) {
    return [
      `## Positioning\n${subject} is positioned for busy teams who need outcomes, not more tools. Core message: "less admin, more decisions". Proof points: time saved per week, accuracy, privacy by default.`,
      "## Channels and timeline\n- Week -4: waitlist page, founder story, 3 customer quotes\n- Week -2: launch-day assets, press kit, partner outreach\n- Launch week: Product Hunt, LinkedIn series, webinar\n- Week +2: case study and retargeting",
      "## Metrics\nWaitlist sign-ups, activation within 7 days, cost per activated user, share of voice in target communities.",
    ];
  }
  if (/engin|tech|platform|product|dev|data|secur/.test(s)) {
    return [
      `## Scope\nMinimum lovable version of ${subject}: capture, summarise, share. Out of scope for launch: integrations beyond calendar and chat, custom vocabularies.`,
      "## Architecture and milestones\n- M1 (week 1-2): ingestion + transcription pipeline behind a feature flag\n- M2 (week 3-4): summarisation service with evaluation set and cost guardrails\n- M3 (week 5): sharing, permissions, audit log\n- M4 (week 6): load test at 10x expected launch traffic, on-call runbook",
      "## Engineering risks\nModel cost per meeting, latency on long recordings, data retention obligations. Mitigations: tiered models, async processing, 30-day default retention.",
    ];
  }
  if (/financ|account|treasur/.test(s)) {
    return [
      `## Budget\nLaunch budget for ${subject}: product and engineering 55%, marketing 30%, contingency 15%. Monthly burn tracked weekly against plan.`,
      "## Pricing and unit economics\n- Free tier: 5 meetings/month\n- Pro: $12 per user per month; Team: $20 per user per month\n- Target gross margin ≥ 75% after model costs; break-even at ~2,400 paying seats",
      "## Financial risks\nModel price changes, low free-to-paid conversion, refund rate. Controls: per-meeting cost cap, monthly cohort review.",
    ];
  }
  if (/sales|revenue|partner|customer|success|support/.test(s)) {
    return [
      `## Target accounts\nMid-size companies (50-500 staff) that run many recurring meetings. First 20 design-partner accounts for ${subject} listed by segment.`,
      "## Motion\nSelf-serve sign-up with a sales-assist trigger at 10+ seats; 30-minute demo script; objection handling for privacy and accuracy.",
      "## Targets\n20 design partners in month 1, 5 paid team plans in month 2, net revenue retention tracked from month 3.",
    ];
  }
  if (/legal|counsel|complian|risk/.test(s)) {
    return [
      `## Legal review of ${subject}\nTerms of service, privacy policy and DPA updated for recording consent and data retention.`,
      "## Compliance checklist\n- Recording-consent notice in every meeting\n- GDPR/CCPA data-subject request flow\n- Sub-processor list for model providers",
      "## Open legal risks\nTwo-party-consent jurisdictions, enterprise contract redlines, model-provider data usage terms.",
    ];
  }
  if (/people|hr|talent|recruit|culture/.test(s)) {
    return [
      `## Staffing for ${subject}\nCurrent team covers launch scope; one support specialist and one growth marketer added for launch month.`,
      "## Hiring plan\nRole profiles, interview loops, 30-60-90 day onboarding goals.",
      "## Team health\nLaunch on-call rota, workload check-ins, recognition for launch contributors.",
    ];
  }
  return [
    `## Plan\n1. Confirm the goal and success measures for ${subject}.\n2. Agree owners and dates with each function.\n3. Execute in weekly increments with a written status every Friday.`,
    "## Dependencies\nInputs from engineering, marketing and finance; decisions needed from leadership by the end of week 1.",
    "## Measures of success\nDelivered on time, within budget, with the agreed quality bar met.",
  ];
}

/** A concrete multi-paragraph deliverable tailored to the task text and department. */
export function synthesizeDeliverable(ctx: MockContext): string {
  const t = title(ctx);
  const subject = truncate(t, 80);
  const who = ctx.agent?.name ? `${ctx.agent.name}${ctx.agent.title ? `, ${ctx.agent.title}` : ""}` : "the assignee";
  const dept = ctx.agent?.departmentSlug || ctx.agent?.department || "general";
  const intro = `Prepared by ${who}. This addresses: ${firstSentence(description(ctx), 240)}`;
  const crit = criteria(ctx)
    .map((c) => `- ${c}: addressed below`)
    .join("\n");
  const risks = "## Risks and next steps\n- Main risk: dependencies slipping across teams. Mitigation: weekly checkpoint.\n- Next step: review with the requester and confirm owners.";
  return [`# ${subject}`, intro, `## Acceptance criteria\n${crit}`, ...departmentSections(dept, subject), risks].join("\n\n");
}

function deliverablePath(ctx: MockContext): string {
  const dept = slugify(ctx.agent?.departmentSlug || ctx.agent?.department || "general", 24);
  const n = ctx.task?.number ? `t${ctx.task.number}-` : "";
  return `shared/${dept}/${n}${slugify(title(ctx), 40)}.md`;
}

function chatReply(ctx: MockContext): string {
  const name = ctx.agent?.name ?? "I";
  const role = ctx.agent?.title ? `, ${ctx.agent.title}` : "";
  const msg = (ctx.message ?? "").trim();
  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(msg)) {
    return `Hello! ${name}${role} here. I'm on top of my current priorities; tell me what you need and I'll turn it into a plan.`;
  }
  if (msg.endsWith("?")) {
    return `Good question. Short answer from ${name}${role}: we're tracking it, and I'll share specifics as soon as the current work items report back. If you want a written analysis, ask me to prepare one and I'll open a task.`;
  }
  return `Noted — ${name}${role}. ${msg ? `On "${truncate(msg, 80)}": ` : ""}I'll keep it in mind and follow up if action is needed.`;
}

function pickReports(ctx: MockContext, max: number): MockContext["reports"] {
  const reports = ctx.reports ?? [];
  if (reports.length === 0) return [];
  const text = `${title(ctx)} ${description(ctx)}`;
  const scored = reports
    .map((r, i) => ({ r, i, score: overlap(text, `${r.title ?? ""} ${r.mandate ?? ""} ${r.department ?? ""}`) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const positive = scored.filter((s) => s.score > 0);
  const chosen = (positive.length > 0 ? positive : scored).slice(0, Math.max(1, max));
  return chosen.map((s) => s.r);
}

function focusFor(report: { title?: string; department?: string }): string {
  return (report.department || report.title || "team").replace(/^chief\s+/i, "").trim();
}

export function mockStageJson(stage: string, ctx: MockContext): Record<string, unknown> {
  const t = title(ctx);
  switch (stage) {
    case "chat.reply":
      return { reply: chatReply(ctx), needsTask: false };
    case "metacognition.target_understanding.problem_definition": {
      const intent = ctx.mode === "message" ? classifyIntent(ctx.message ?? "") : "work";
      return {
        intent,
        problem: ctx.mode === "message" && intent === "chat" ? `Respond helpfully to: ${truncate(ctx.message ?? "", 120)}` : `Deliver: ${truncate(t, 120)}`,
        successCriteria: criteria(ctx),
        constraints: ["Stay within the budget", "Use the existing team before hiring"],
        unknowns: ["Exact deadline", "Which trade-offs the Board prefers"],
        title: truncate(t, 80),
      };
    }
    case "metacognition.target_understanding.analysis": {
      const n = Math.max(1, Math.min(5, ctx.perspectives ?? 3));
      const perspectives = LENSES.slice(0, n).map((lens) => ({
        lens,
        insight: `From the ${lens} angle, "${truncate(t, 50)}" succeeds only if it is concrete and owned.`,
        implication: `Make the ${lens} trade-offs explicit in the plan.`,
      }));
      return { perspectives, understanding: { summary: `Deliver ${truncate(t, 80)} with clear owners, measurable outcomes and a cost cap.`, score: 0.8 } };
    }
    case "metacognition.confidence": {
      const ood = ctx.ood === true;
      return {
        confidence: ood ? 0.62 : 0.78,
        uncertainty: ood ? 0.5 : 0.3,
        risks: ["Cross-team dependencies may slip", "Requirements may change after review"],
      };
    }
    case "metacognition.cognitive_control": {
      const max = Math.max(1, Math.min(4, ctx.maxSubprocesses ?? 3));
      const chosen = pickReports(ctx, max) ?? [];
      const subprocesses = chosen.map((r, i) => {
        const focus = focusFor(r);
        return {
          title: truncate(`${focus} input: ${t}`, 110),
          description: `${focus} part of "${truncate(t, 100)}". ${firstSentence(description(ctx), 200)} Produce a written deliverable covering the ${focus.toLowerCase()} view, with owners and dates.${ctx.feedback?.length ? ` Address: ${ctx.feedback.join("; ")}` : ""}`,
          assigneeId: r.id,
          value: 300 - i * 50,
          estCostUsd: 0.05,
          acceptanceCriteria: `A written ${focus.toLowerCase()} deliverable saved to the shared drive`,
        };
      });
      const delegate = subprocesses.length > 0;
      return {
        mode: delegate ? "delegate" : "direct",
        subprocesses,
        candidates: [
          { name: "high_cost", approach: "Full plan with every function, external research and review rounds", estCostUsd: 0.4, expectedValue: 900 },
          { name: "low_cost", approach: delegate ? "Delegate focused parts to the best-fit reports and integrate" : "Write the deliverable directly from known facts", estCostUsd: 0.08, expectedValue: 700 },
          { name: "low_effort", approach: "Smallest change that meets the criteria: reuse existing documents and results", estCostUsd: 0.02, expectedValue: 150 },
        ],
        chosen: "low_cost",
        rationale: "Best value for cost given the team and budget.",
      };
    }
    case "metacognition.monitoring.reverse_thinking":
      return {
        failureModes: ["Owners misunderstand the scope", "Integration of parts is left to the last minute"],
        fatal: false,
        mitigation: "State scope and acceptance criteria in every subtask; integrate as results arrive.",
      };
    case "metacognition.solving_evaluation.feedback": {
      const results = ctx.results ?? [];
      const nonEmpty = results.filter((r) => (r.result ?? "").trim().length > 0 && r.status !== "failed" && r.status !== "cancelled");
      const hasSolution = (ctx.solution ?? "").trim().length > 0;
      const ok = results.length > 0 ? nonEmpty.length === results.length : hasSolution;
      const partial = results.length > 0 && nonEmpty.length > 0 && !ok;
      return {
        score: ok ? 0.86 : partial ? 0.55 : 0.2,
        truthful: ok ? 0.9 : 0.5,
        good: ok,
        issues: ok ? [] : results.filter((r) => !nonEmpty.includes(r)).map((r) => `No usable result for "${r.title ?? "a subtask"}"`),
        decision: ok ? "accept" : partial ? "revise" : "revise",
        summary: ok
          ? `All parts delivered for ${truncate(t, 80)}.`
          : `Missing parts for ${truncate(t, 80)}.`,
      };
    }
    case "metacognition.project_management.reflection_replanning":
      return {
        diagnosis: `Feedback shows gaps: ${(ctx.feedback ?? ["unclear scope"]).join("; ")}`,
        changes: ["Narrow the scope of each part", "Restate acceptance criteria explicitly"],
      };
    case "metacognition.project_management.online_learning":
      return {
        lesson: `For work like "${truncate(t, 60)}", split by function, give each owner explicit acceptance criteria, and integrate as results arrive.`,
        conceptual: ctx.outcome === "completed" ? `${truncate(t, 60)}: delivered with input from ${(ctx.results ?? []).length || 1} part(s).` : null,
        generalizes: true,
      };
    case "self_management.identity.self_narrative": {
      const name = ctx.agent?.name ?? "I";
      return {
        narrative: `I am ${name}${ctx.agent?.title ? `, ${ctx.agent.title}` : ""}. I turn goals into owned, measurable work and learn from every result. Most recently I delivered "${truncate(t, 70)}".`,
        assets: [truncate(t, 60)],
        connections: (ctx.reports ?? []).slice(0, 2).map((r) => r.title ?? r.id),
      };
    }
    case "self_management.identity.okr":
      return {
        title: truncate(`Advance: ${ctx.okr?.keyResult ?? ctx.okr?.objective ?? "our top key result"}`, 100),
        description: `Propose and execute the next concrete step on "${ctx.okr?.keyResult ?? "the key result"}" under objective "${ctx.okr?.objective ?? ""}".`,
        value: 400,
      };
    default:
      return { summary: `Considered "${truncate(t, 80)}".` };
  }
}

export function mockText(stage: string, ctx: MockContext): string {
  if (stage === "chat.reply" || ctx.mode === "message") return chatReply(ctx);
  return synthesizeDeliverable(ctx);
}

/** One step of a tool loop: write the deliverable, then complete; or answer in text. */
export function mockToolStep(ctx: MockContext, request: ChatRequest): { content: string; toolCalls: ToolCall[] } {
  if (ctx.mode === "message") return { content: chatReply(ctx), toolCalls: [] };
  const names = new Set((request.tools ?? []).map((t) => t.name));
  const assistantTurns = request.messages.filter((m) => m.role === "assistant");
  const called = assistantTurns.flatMap((m) => m.toolCalls ?? []).map((c) => c.name);
  const n = assistantTurns.length + 1;
  const deliverable = synthesizeDeliverable(ctx);
  const path = deliverablePath(ctx);
  if (n <= 3 && names.has("workspace_write_file") && !called.includes("workspace_write_file")) {
    return { content: "", toolCalls: [{ id: `call_${n}_write`, name: "workspace_write_file", arguments: { path, content: deliverable } }] };
  }
  const wrote = called.includes("workspace_write_file");
  const result = `${deliverable}${wrote ? `\n\nFull document: ${path}` : ""}`;
  if (names.has("complete_task")) {
    return { content: "", toolCalls: [{ id: `call_${n}_complete`, name: "complete_task", arguments: { result } }] };
  }
  return { content: result, toolCalls: [] };
}

/** Exposed for tests. */
export const _internals = { tokens, pickReports };
