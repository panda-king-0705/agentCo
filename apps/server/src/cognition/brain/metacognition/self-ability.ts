/**
 * Metacognition › Self-ability Understanding:
 * LLM Capability · Tools/MCP Capability · Budget/Resource → Competence. Computed.
 */
import type { Agent, ModelProfile } from "../../../../../../packages/shared/src/index.ts";
import { clamp, round } from "../../coerce.ts";
import { overlapRatio } from "../../text.ts";
import { block, type BrainRun } from "../runtime.ts";

export interface Competence {
  score: number;
  gaps: string[];
  model: { profile: string; tier: string; contextWindow: number | null; supportsTools: boolean };
  tools: string[];
  reports: { id: string; title: string; mandate: string; department: string }[];
  budgetRemainingUsd: number;
  skillCoverage: number;
}

const TIER_CAPABILITY: Record<string, number> = { frontier: 1, standard: 0.8, economy: 0.6 };

export interface CompetenceInputs {
  profile: ModelProfile;
  tools: string[];
  reports: Agent[];
  reportDepartments: string[];
  budgetRemainingUsd: number;
  estCostUsd: number;
  taskText: string;
  ownProfile: string;
  motivationCompetence: number;
}

/** Pure competence model. */
export function assessCompetence(i: CompetenceInputs): Omit<Competence, "model" | "tools" | "reports"> & { parts: Record<string, number> } {
  const gaps: string[] = [];
  const llm = (TIER_CAPABILITY[i.profile.tier] ?? 0.6) * (i.profile.supportsTools ? 1 : 0.7);
  if (!i.profile.supportsTools) gaps.push("model lacks tool support");
  const toolScore = i.tools.length >= 3 ? 1 : i.tools.length > 0 ? 0.7 : 0.4;
  if (i.tools.length === 0) gaps.push("no tools");
  const budgetScore = i.budgetRemainingUsd <= 0 ? 0 : i.budgetRemainingUsd >= Math.max(0.05, 4 * i.estCostUsd) ? 1 : 0.5;
  if (budgetScore < 1) gaps.push("budget below a comfortable margin for this task");
  const coverageText = `${i.ownProfile} ${i.reports.map((r, idx) => `${r.title} ${i.reportDepartments[idx] ?? ""} ${r.identity.mission}`).join(" ")}`;
  const skillCoverage = clamp(overlapRatio(i.taskText, coverageText) * 2, 0, 1);
  if (skillCoverage < 0.2) gaps.push("little skill overlap with the task (self and reports)");
  if (i.reports.length === 0) gaps.push("no direct reports to delegate to");
  const teamScore = i.reports.length > 0 ? 1 : 0.6;
  const computed = 0.3 * llm + 0.15 * toolScore + 0.2 * budgetScore + 0.2 * Math.max(skillCoverage, 0.4) + 0.15 * teamScore;
  const score = round(clamp(0.8 * computed + 0.2 * i.motivationCompetence, 0, 1), 3);
  return { score, gaps, budgetRemainingUsd: i.budgetRemainingUsd, skillCoverage: round(skillCoverage, 3), parts: { llm, toolScore, budgetScore, teamScore } };
}

export async function selfAbility(run: BrainRun, taskText: string): Promise<Competence> {
  return block(run, "metacognition.self_ability", "Assessing my competence for this", (span) => {
    const tier = run.platform.models.tierForStage("metacognition.solving_evaluation.solving", run.routingAgent);
    const profile = run.platform.models.resolve(tier, run.routingAgent.modelOverride);
    const tools = run.platform.tools.specsFor(run.agent).map((t) => t.name);
    const reports = run.platform.org.directReports(run.agent.id).filter((a) => a.status !== "terminated" && a.status !== "paused");
    const reportDepartments = reports.map((r) => run.platform.org.departmentName(r.departmentId));
    const budget = run.platform.org.budgetRemainingUsd(run.agent.id);
    const a = assessCompetence({
      profile,
      tools,
      reports,
      reportDepartments,
      budgetRemainingUsd: budget,
      estCostUsd: run.task?.estCostUsd ?? 0.05,
      taskText,
      ownProfile: `${run.agent.title} ${run.facts.department} ${run.agent.identity.mission} ${run.agent.identity.assets.join(" ")}`,
      motivationCompetence: run.drives.competence,
    });
    span.setAttributes({ "agentco.competence": a.score, "agentco.budget_remaining_usd": round(budget, 4), "agentco.reports": reports.length });
    return {
      score: a.score,
      gaps: a.gaps,
      budgetRemainingUsd: budget,
      skillCoverage: a.skillCoverage,
      model: { profile: profile.id, tier: profile.tier, contextWindow: profile.contextWindow, supportsTools: profile.supportsTools },
      tools,
      reports: reports.map((r, i) => ({ id: r.id, title: r.title, mandate: r.identity.mission, department: reportDepartments[i] ?? "" })),
    };
  });
}
