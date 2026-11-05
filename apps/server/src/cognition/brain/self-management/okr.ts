/**
 * Self-management › Objectives and Key Results → TODO list.
 *
 * - alignment: subprocesses aligned with the vision or a KR get the vision multiplier;
 * - Report: the KR the evaluated result maps to advances;
 * - heartbeat: the KR with the largest gap proposes a new objective (economy model).
 */
import type { Okr, OkrKeyResult } from "../../../../../../packages/shared/src/index.ts";
import { num, str } from "../../coerce.ts";
import { overlap, truncate } from "../../text.ts";
import { block, llmJson, type BrainRun } from "../runtime.ts";

export function isAligned(text: string, okrs: Okr[], vision: string): boolean {
  if (vision && overlap(text, vision) >= 2) return true;
  return okrs.some((o) => overlap(text, `${o.objective} ${o.keyResults.map((k) => k.description).join(" ")}`) >= 2);
}

export function largestGap(okrs: Okr[]): { objective: Okr; kr: OkrKeyResult; gap: number } | null {
  let best: { objective: Okr; kr: OkrKeyResult; gap: number } | null = null;
  for (const o of okrs) {
    for (const kr of o.keyResults) {
      const gap = kr.target > 0 ? Math.max(0, (kr.target - kr.current) / kr.target) : 0;
      if (gap > 0 && (!best || gap > best.gap)) best = { objective: o, kr, gap };
    }
  }
  return best;
}

/** Advances the KR the result maps to (best token overlap ≥ 1); returns a new array (pure). */
export function advanceOkrs(okrs: Okr[], resultText: string, score: number): { okrs: Okr[]; advanced: string | null } {
  let bestO = -1;
  let bestK = -1;
  let bestScore = 0;
  okrs.forEach((o, oi) =>
    o.keyResults.forEach((k, ki) => {
      const s = overlap(`${k.description} ${o.objective}`, resultText);
      if (s > bestScore) {
        bestScore = s;
        bestO = oi;
        bestK = ki;
      }
    }),
  );
  if (bestO < 0) return { okrs, advanced: null };
  const next = okrs.map((o, oi) =>
    oi !== bestO
      ? o
      : {
          ...o,
          keyResults: o.keyResults.map((k, ki) => {
            if (ki !== bestK) return k;
            const step = Math.max(1, Math.round((k.target / 10) * Math.max(0.2, score)));
            return { ...k, current: Math.min(k.target, k.current + step) };
          }),
        },
  );
  return { okrs: next, advanced: next[bestO]!.keyResults[bestK]!.description };
}

/** Block: OKR progress on Report. */
export async function okrProgress(run: BrainRun, resultText: string, score: number): Promise<Okr[] | null> {
  return block(run, "self_management.identity.okr", "Updating OKR progress", (span) => {
    const { okrs, advanced } = advanceOkrs(run.agent.identity.okrs, resultText, score);
    span.setAttributes({ "agentco.okr.advanced": advanced ?? "none" });
    return advanced ? okrs : null;
  });
}

/** Block (heartbeat): the KR with the largest gap proposes a new objective. */
export async function proposeFromOkrs(run: BrainRun): Promise<{ title: string; description: string; value: number } | null> {
  return block(run, "self_management.identity.okr", "Reviewing OKRs for the next objective", async (span) => {
    const gap = largestGap(run.agent.identity.okrs);
    if (!gap) return null;
    span.setAttributes({ "agentco.okr.gap": Math.round(gap.gap * 100) / 100 });
    const json = await llmJson(run, {
      stage: "self_management.identity.okr",
      span,
      instructions: `Key result with the largest gap: "${gap.kr.description}" (${gap.kr.current}/${gap.kr.target}${gap.kr.unit}) under objective "${gap.objective.objective}". Propose ONE concrete objective that moves it.`,
      shape: '{"title": string, "description": string, "value": number 0-1000}',
      context: { okr: { objective: gap.objective.objective, keyResult: gap.kr.description } },
      maxOutputTokens: 300,
    });
    return {
      title: truncate(str(json.title, `Advance: ${gap.kr.description}`, 140), 140),
      description: str(json.description, `Move "${gap.kr.description}" from ${gap.kr.current} toward ${gap.kr.target}${gap.kr.unit}.`, 1500),
      value: num(json.value, 300, 0, 1000),
    };
  });
}
