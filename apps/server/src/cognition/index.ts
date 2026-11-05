/**
 * Cognition factory (fixed signature, docs/ARCHITECTURE.md → ownership).
 * runTimeoutMs is an optional, additive option (defaults to RUN_TIMEOUT_MS or
 * 300 s); OOD Monitoring uses it for the "< 25% of run time left" pressure signal.
 */
import type { CognitionKind } from "../../../../packages/shared/src/index.ts";
import type { CognitiveEngine } from "../contracts.ts";
import { BrainEngine } from "./brain/index.ts";
import { ReflexEngine } from "./reflex.ts";

export { BrainEngine } from "./brain/index.ts";
export { ReflexEngine } from "./reflex.ts";
export { computeBaZi } from "./brain/self-management/bazi.ts";

export function createEngines(options?: { reflexMaxSteps?: number; brainMaxRevisions?: number; runTimeoutMs?: number }): Record<CognitionKind, CognitiveEngine> {
  const envTimeout = Number(process.env.RUN_TIMEOUT_MS);
  const runTimeoutMs = options?.runTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 300_000);
  return {
    brain: new BrainEngine({ maxRevisions: options?.brainMaxRevisions ?? 2, runTimeoutMs }),
    reflex: new ReflexEngine({ maxSteps: options?.reflexMaxSteps ?? 8 }),
  };
}
