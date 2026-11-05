/**
 * Self-management › Sensibility / Emotion (+ Feedback / Update from the
 * Report). Applies Human Nature's rules to the agent's affect; the effect on
 * Motivation is read back by identity.computeDrives on the next run
 * (frustration > 0.7 forces the early stop, valence modulates autonomy/curiosity).
 */
import type { AffectState } from "../../../../../../packages/shared/src/index.ts";
import { block, type BrainRun } from "../runtime.ts";
import { updateAffect, type WorkEvent } from "./human-nature.ts";

export async function feedbackUpdate(run: BrainRun, event: WorkEvent): Promise<AffectState> {
  const next = await block(run, "self_management.human_nature", "Applying human-nature update rules", () => updateAffect(run.agent.affect, event), {
    attributes: { "agentco.outcome": event.outcome, "agentco.recognized_by": event.recognizedBy },
  });
  return block(run, "self_management.sensibility_emotion", "Updating emotion from feedback", () => next, {
    attributes: { "agentco.valence": next.valence, "agentco.frustration": next.frustration, "agentco.arousal": next.arousal },
  });
}
