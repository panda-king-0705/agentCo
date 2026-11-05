/** Why a run was aborted; decides what happens to its task (see RunService.finish). */
export type AbortReason = "interrupt" | "pause" | "company_pause" | "destroy" | "timeout" | "shutdown";

export class RunAbortedError extends Error {
  readonly reason: AbortReason;

  constructor(reason: AbortReason) {
    super(ABORT_MESSAGES[reason]);
    this.name = "RunAbortedError";
    this.reason = reason;
  }
}

export const ABORT_MESSAGES: Record<AbortReason, string> = {
  interrupt: "Run interrupted by the Board",
  pause: "Run aborted: the agent was paused",
  company_pause: "Run aborted: the company was paused (kill switch)",
  destroy: "Run aborted: the agent was terminated",
  timeout: "Run timed out",
  shutdown: "Run aborted: the server is shutting down",
};

/** Minimal run control the org layer needs (implemented by RunService). */
export interface RunControl {
  /** Aborts the agent's active run; returns how many runs were aborted (0/1). */
  abortAgent(agentId: string, reason: AbortReason): number;
  isBusy(agentId: string): boolean;
}
