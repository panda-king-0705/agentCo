/**
 * Maslow-style NeedsState computed from platform facts (never LLM-reported):
 *   physiological — any budget left at all (< $0.01 → low),
 *   safety        — budget headroom ≥ 20 % and no failure streak,
 *   belonging     — an active manager (or, for the CEO, the Board) AND, for a leader (tier
 *                   manager/executive) who has direct reports, at least one reachable (active) one,
 *   esteem        — recent run success rate ≥ 50 %,
 *   selfActualization — mean OKR key-result progress.
 */
import type { Agent, NeedsState, Run } from "../../../../packages/shared/src/index.ts";
import { BELONGING } from "../cognition/brain/interpretation.ts";

export interface NeedsFacts {
  agent: Agent;
  manager: Agent | null;
  /** Direct reports that are not terminated (paused ones included). */
  reports: Agent[];
  /** Direct reports ever assigned, terminated included (absent = reports.length). */
  reportsEver?: number;
  remainingUsd: number;
  limitUsd: number;
  recentRuns: Run[]; // newest first
}

export function computeNeeds(facts: NeedsFacts): NeedsState {
  const finished = facts.recentRuns.filter((r) => r.status === "completed" || r.status === "failed").slice(0, 10);
  const failures = finished.filter((r) => r.status === "failed").length;
  const streak = finished.slice(0, 3).length === 3 && finished.slice(0, 3).every((r) => r.status === "failed");
  const headroom = facts.limitUsd > 0 ? facts.remainingUsd / facts.limitUsd : facts.remainingUsd > 0 ? 1 : 0;
  const isRoot = facts.agent.managerId === null;
  const managerOk = isRoot || (facts.manager !== null && facts.manager.status !== "terminated");
  // A leader whose reports are all paused or terminated has no team to belong to.
  const hadReports = Math.max(facts.reportsEver ?? 0, facts.reports.length) > 0;
  const reportsOk = !BELONGING.leaderTiers.includes(facts.agent.tier) || !hadReports || facts.reports.some((r) => r.status !== "paused" && r.status !== "terminated");
  return {
    physiological: facts.remainingUsd < 0.01 ? "low" : "ok",
    safety: headroom < 0.2 || streak ? "low" : "ok",
    belonging: managerOk && reportsOk ? "ok" : "low",
    esteem: finished.length === 0 || (finished.length - failures) / finished.length >= 0.5 ? "ok" : "low",
    selfActualization: okrProgress(facts.agent),
  };
}

export function okrProgress(agent: Agent): number {
  const results = agent.identity.okrs.flatMap((o) => o.keyResults);
  if (results.length === 0) return 0;
  const sum = results.reduce((acc, kr) => acc + (kr.target > 0 ? Math.min(1, Math.max(0, kr.current / kr.target)) : 0), 0);
  return Math.round((sum / results.length) * 1000) / 1000;
}
