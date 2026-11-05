/**
 * Self-management › Sensibility / Emotion (+ Feedback / Update from the
 * Report). Applies Human Nature's rules to the agent's affect; the effect on
 * Motivation is read back by identity.computeDrives on the next run
 * (frustration > 0.7 forces the early stop, valence modulates autonomy/curiosity).
 */
import type { AffectState } from "../../../../../../packages/shared/src/index.ts";
import { block, type BrainRun } from "../runtime.ts";
import { updateAffect, type ProcessEvent, type Workload } from "./human-nature.ts";

export async function feedbackUpdate(run: BrainRun, events: ProcessEvent[], workload: Workload): Promise<AffectState> {
  const next = await block(run, "self_management.human_nature", `Human nature: ${events.length} finished process(es)`, () => updateAffect(run.agent.affect, events, workload), {
    attributes: {
      "agentco.events": events.map((e) => `${e.source}:${e.outcome}`).join(","),
      "agentco.fatigue.consecutive_runs": workload.consecutiveRuns,
      "agentco.fatigue.open_items": workload.openItems,
      "agentco.idle_ms": Math.round(workload.idleMs ?? 0),
    },
  });
  return block(run, "self_management.sensibility_emotion", "Updating emotion from feedback", () => next, {
    attributes: { "agentco.valence": next.valence, "agentco.frustration": next.frustration, "agentco.arousal": next.arousal },
  });
}
