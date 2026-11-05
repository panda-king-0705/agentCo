/**
 * Metacognition › Self-ability Understanding:
 * LLM Capability · Tools/MCP Capability · Budget/Resource → Competence. Computed.
 *
 * On the Q3 fallback (Confidence's competence evaluation < 0.5) it re-runs
 * with the evaluation's gaps and applies targeted remedies: a one-tier model
 * upgrade for this run if the budget allows, preferring a report with the
 * missing skill (delegation), and a budget request to the manager.
 */
import type { Agent, ModelProfile, ModelTier } from "../../../../../../packages/shared/src/index.ts";
import { clamp, round } from "../../coerce.ts";
import { overlapRatio, truncate } from "../../text.ts";
import { BELONGING } from "../interpretation.ts";
import { block, toolContext, type BrainRun } from "../runtime.ts";
import { belongingResponse } from "../self-management/identity.ts";

export interface Competence {
  score: number;
  gaps: string[];
  model: { profile: string; tier: string; contextWindow: number | null; supportsTools: boolean };
  tools: string[];
  reports: { id: string; title: string; mandate: string; department: string }[];
  budgetRemainingUsd: number;
  skillCoverage: number;
  remedies: string[];
  preferDelegation: boolean;
}

const TIER_CAPABILITY: Record<string, number> = { frontier: 1, standard: 0.8, economy: 0.6 };
const TIER_UP: Record<ModelTier, ModelTier | null> = { economy: "standard", standard: "frontier", frontier: null };

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
export function assessCompetence(i: CompetenceInputs): { score: number; gaps: string[]; skillCoverage: number; parts: Record<string, number> } {
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
  return { score, gaps, skillCoverage: round(skillCoverage, 3), parts: { llm, toolScore, budgetScore, teamScore } };
}

/** Remedy planning for the fallback pass (pure). */
export function planRemedies(gaps: string[], o: { tier: ModelTier; budgetRemainingUsd: number; estCostUsd: number; hasReports: boolean; hasManager: boolean }) {
  const text = gaps.join(" ").toLowerCase();
  const upgradeTo = TIER_UP[o.tier];
  const canAffordUpgrade = o.budgetRemainingUsd >= Math.max(0.1, 10 * o.estCostUsd);
  const remedies: string[] = [];
  let upgrade: ModelTier | null = null;
  if (/model|capab|reason|tier|quality|complex|skill|expert/.test(text) && upgradeTo && canAffordUpgrade) {
    upgrade = upgradeTo;
    remedies.push(`one-tier model upgrade for this run (${o.tier} → ${upgradeTo})`);
  }
  const preferDelegation = o.hasReports && /skill|expert|domain|knowledge|capacity|time|team|overlap/.test(text);
  if (preferDelegation) remedies.push("delegate to a report with the missing skill");
  const budgetRequest = /budget|cost|resource|fund/.test(text) && o.hasManager;
  if (budgetRequest) remedies.push("request budget from the manager");
  if (remedies.length === 0 && upgradeTo && canAffordUpgrade) {
    upgrade = upgradeTo;
    remedies.push(`one-tier model upgrade for this run (${o.tier} → ${upgradeTo})`);
  }
  return { upgrade, preferDelegation, budgetRequest, remedies };
}

/** Block. `gaps` present = the Q3 fallback pass with the competence evaluation's gaps. */
export async function selfAbility(run: BrainRun, taskText: string, gaps: string[] = []): Promise<Competence> {
  return block(run, "metacognition.self_ability", gaps.length ? "Re-assessing competence and applying remedies" : "Assessing my competence for this", async (span) => {
    const budget = run.platform.org.budgetRemainingUsd(run.agent.id);
    const reports = run.platform.org.directReports(run.agent.id).filter((a) => a.status !== "terminated" && a.status !== "paused");
    // Belonging low because the leader's reports are unreachable (Maslow): note it as a gap.
    const unreachable = run.drives.needs.belonging === "low" && BELONGING.leaderTiers.includes(run.agent.tier) && reports.length === 0 && belongingResponse(run).kind === "reports_unreachable";
    const remedy = gaps.length
      ? planRemedies(gaps, {
          tier: run.routingAgent.modelTier,
          budgetRemainingUsd: budget,
          estCostUsd: run.task?.estCostUsd ?? 0.05,
          hasReports: reports.length > 0,
          hasManager: !!run.agent.managerId,
        })
      : { upgrade: null, preferDelegation: false, budgetRequest: false, remedies: [] as string[] };
    if (remedy.upgrade) run.routingAgent = { ...run.routingAgent, modelTier: remedy.upgrade };
    if (remedy.budgetRequest && run.agent.managerId && run.agent.tools.includes("send_message")) {
      await run.platform.tools.execute(
        {
          id: `budget_${run.ctx.run.id}`,
          name: "send_message",
          arguments: { toAgentId: run.agent.managerId, content: `Budget request for ${run.task ? `T-${run.task.number} "${truncate(run.task.title, 80)}"` : "current work"}: ${gaps.join("; ")}` },
        },
        toolContext(run, span),
      );
    }
    const tier = run.platform.models.tierForStage("metacognition.solving_evaluation.solving", run.routingAgent);
    const profile = run.platform.models.resolve(tier, run.routingAgent.modelOverride);
    const tools = run.platform.tools.specsFor(run.agent).map((t) => t.name);
    const reportDepartments = reports.map((r) => run.platform.org.departmentName(r.departmentId));
    const a = assessCompetence({
      profile,
      tools,
      reports,
      reportDepartments,
      budgetRemainingUsd: budget,
      estCostUsd: run.task?.estCostUsd ?? 0.05,
      taskText: `${taskText} ${gaps.join(" ")}`,
      ownProfile: `${run.agent.title} ${run.facts.department} ${run.agent.identity.mission} ${run.agent.identity.assets.join(" ")}`,
      motivationCompetence: run.drives.competence,
    });
    // Remedies raise competence: delegation covers missing skills, an upgrade covers model capability.
    const boost = (remedy.upgrade ? 0.1 : 0) + (remedy.preferDelegation ? 0.1 : 0);
    const score = round(clamp(a.score + boost, 0, 1), 3);
    span.setAttributes({
      "agentco.competence": score,
      "agentco.budget_remaining_usd": round(budget, 4),
      "agentco.reports": reports.length,
      ...(gaps.length ? { "agentco.fallback.gaps": gaps.length, "agentco.remedies": remedy.remedies.join("; ") || "none" } : {}),
    });
    if (unreachable) span.setAttributes({ "agentco.belonging": "reports_unreachable" });
    return {
      score,
      gaps: unreachable ? [...a.gaps.filter((g) => g !== "no direct reports to delegate to"), BELONGING.unreachableReportsGap] : a.gaps,
      budgetRemainingUsd: budget,
      skillCoverage: a.skillCoverage,
      model: { profile: profile.id, tier: profile.tier, contextWindow: profile.contextWindow, supportsTools: profile.supportsTools },
      tools,
      reports: reports.map((r, i) => ({ id: r.id, title: r.title, mandate: r.identity.mission, department: reportDepartments[i] ?? "" })),
      remedies: remedy.remedies,
      preferDelegation: remedy.preferDelegation,
    };
  });
}
