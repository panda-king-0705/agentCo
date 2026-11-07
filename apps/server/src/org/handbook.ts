// The company handbook: how AgentCo works, generated from live data (no model call, never stale).
// New hires get it as a welcome message from their manager on day one; every agent can re-read it
// with the company_handbook tool; the Board sees the same text in the console (GET /api/handbook).
import type { Agent, CompanySettings, MemoryItem, Task } from "../../../../packages/shared/src/index.ts";
import type { OrgView } from "../contracts.ts";
import { todayLine } from "../cognition/prompt.ts";

export interface HandbookSource {
  settings(): CompanySettings;
  org: OrgView;
  /** Open objectives (root tasks not done/failed/cancelled), most valuable first. */
  openObjectives(limit: number): Task[];
  /** The company's most important shared knowledge (global semantic/procedural memories). */
  keyKnowledge(limit: number): MemoryItem[];
  blackboardKeys(): string[];
  /** What is left of an agent's own monthly budget (null = no per-agent cap). */
  agentMonthlyLeftUsd(agentId: string): number | null;
  now(): Date;
}

const cut = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Plain-text handbook (markdown-ish), ~2–3k characters; personalised when `agent` is given. */
export function buildHandbook(src: HandbookSource, agent: Agent | null): string {
  const s = src.settings();
  const org = src.org;
  const agents = org.listActiveAgents();
  const ceo = agents.find((a) => !a.managerId && a.tier === "executive") ?? null;
  const heads = agents.filter((a) => a.managerId === ceo?.id && a.tier === "executive");
  const lines: string[] = [];

  lines.push(`# ${s.name} — company handbook`);
  lines.push(todayLine(src.now()));
  lines.push(`Mission: ${cut(s.mission, 300)}`);

  if (agent) {
    const manager = agent.managerId ? org.getAgent(agent.managerId) : null;
    const reports = org.directReports(agent.id).filter((r) => r.status !== "terminated");
    lines.push(
      "",
      "## You",
      `${agent.name}, ${agent.title} in ${org.departmentName(agent.departmentId)} (id ${agent.id}).` +
        (manager ? ` You report to ${manager.name}, ${manager.title} (id ${manager.id}).` : " You report to the Board.") +
        (reports.length ? ` Your reports: ${reports.map((r) => `${r.name} (${r.title}, id ${r.id})`).join(", ")}.` : ""),
      (() => {
        const left = src.agentMonthlyLeftUsd(agent.id);
        const h = org.budgetHeadroom?.(agent.id);
        const own = left === null ? "No personal monthly cap." : `Your monthly budget: $${left.toFixed(2)} left of $${agent.monthlyBudgetUsd.toFixed(2)}.`;
        return h && h.label !== "your monthly budget" && h.share < 1 ? `${own} Tightest limit right now: the ${h.label}, $${h.remainingUsd.toFixed(2)} of $${h.limitUsd.toFixed(2)} left.` : own;
      })(),
    );
  }

  lines.push(
    "",
    "## Who's who",
    "- The Board is the human founder: it sets direction in the Boardroom chat and answers questions in Approvals.",
    ceo ? `- CEO: ${ceo.name} (id ${ceo.id}) — turns the Board's requests into objectives and delegates them.` : "- CEO: (vacant)",
    ...heads.map((h) => `- ${org.departmentName(h.departmentId)}: ${h.name}, ${h.title} (id ${h.id})`),
    `- ${agents.length} people in all. Look anyone up with company_directory (name, title, department or role word).`,
  );

  lines.push(
    "",
    "## How work flows",
    "- Every request becomes a task (T-number) with an owner. Your result goes back to whoever assigned it automatically — no need to message them.",
    "- Delegate only to your own reports (delegate_task), one part per owner; work that needs another department goes through your manager.",
    "- Blocked? Escalate to your manager with ONE specific question. Only the CEO asks the Board, and only for decisions that are irreversible, spend real money, touch outside accounts or are outside the mandate.",
    "- Act on reasonable assumptions and state them. Do the work with your tools rather than asking for permission you already have.",
    "- Facts go in the knowledge base (memory_write: global for company facts, agent for your own notes); shared working notes on the blackboard. Files you save go on the company drive, where colleagues can read them — use the exact path your brief names; private/… is for scratch notes only.",
    "- Work that combines other people's parts (assembling, reconciling, reviewing) starts after those parts are done. If you are waiting on a colleague's part that is still in progress, escalating puts you on hold until it is finished — you are resumed with their result.",
    `- Money: the company spends at most $${s.dailyBudgetUsd}/day and $${s.monthlyBudgetUsd}/month on models. Prefer the cheapest approach that meets the success criteria.`,
  );

  const objectives = src.openObjectives(6);
  lines.push("", "## Current objectives");
  if (objectives.length) {
    for (const t of objectives) {
      const owner = t.assigneeId ? org.getAgent(t.assigneeId) : null;
      lines.push(`- T-${t.number} ${cut(t.title, 90)} — ${owner ? owner.name : "unassigned"}, ${t.status.replace("_", " ")}`);
    }
  } else lines.push("- None open right now.");

  const knowledge = src.keyKnowledge(6);
  if (knowledge.length) {
    lines.push("", "## Key company knowledge");
    for (const m of knowledge) lines.push(`- ${cut(m.content, 180)}`);
  }
  const keys = src.blackboardKeys().filter((k) => k !== "welcome").slice(0, 10);
  if (keys.length) lines.push("", `## Blackboard keys`, `${keys.join(", ")} (read them with blackboard_read).`);

  return lines.join("\n");
}
