/**
 * ReflexEngine — workers (low-level thinking on cheap models).
 *
 * One bounded tool loop on tierForStage("reflex.step") (= the agent's tier,
 * economy by default) with two engine-handled terminal tools: complete_task
 * and report_blocker. A plain text answer also completes (messages always end
 * this way). If the loop errors or exhausts its steps, it retries once on the
 * next tier up (economy → standard → frontier), then fails. Completion writes
 * one episodic memory.
 *
 * escalate / ask_human called by the model end the loop (tool-loop.ts): an
 * escalation subtask → outcome "waiting" (re-run on subtasks_completed with the
 * manager's answer in the prompt); a Board question → "blocked" with its approvalId.
 *
 * report_blocker: the engine escalates up the chain via the `escalate` tool — unless an
 * escalation for this task is still open (reused, never a second one). An escalation
 * subtask → "waiting"; an approval (only when there is no manager) → "blocked";
 * otherwise → "failed" with the reason.
 *
 * Escalation is bounded per task: once an escalation has been answered (or
 * MAX_ESCALATIONS_PER_TASK were made) the escalate/ask_human tools are withdrawn
 * and a blocker fails the task instead of asking again.
 */
import type { ModelTier, Task } from "../../../../packages/shared/src/index.ts";
import type { CognitiveEngine, EngineContext, EngineResult, ToolSpec } from "../contracts.ts";
import { agentFacts, systemPrompt, workerCharter } from "./prompt.ts";
import { isAbortError, isBudgetError } from "../models/router.ts";
import { ESCALATION_TOOLS, runToolLoop, type ToolLoopResult } from "./tool-loop.ts";
import { oneLine, truncate } from "./text.ts";

const NEXT_TIER: Record<ModelTier, ModelTier | null> = { economy: "standard", standard: "frontier", frontier: null };
/** Escalations one agent may open for one task (an answered one ends escalation for the task). */
export const MAX_ESCALATIONS_PER_TASK = 2;
const TERMINAL = new Set(["done", "failed", "cancelled"]);

export interface ReflexOptions {
  maxSteps?: number;
}

export class ReflexEngine implements CognitiveEngine {
  readonly kind = "reflex" as const;
  private readonly maxSteps: number;

  constructor(options: ReflexOptions = {}) {
    this.maxSteps = Math.max(1, options.maxSteps ?? 8);
  }

  async run(ctx: EngineContext): Promise<EngineResult> {
    const { agent, platform, input } = ctx;
    const facts = agentFacts(platform, agent);
    const task: Task | null = input.trigger === "message" ? null : input.task;
    const label = task ? `T-${task.number}: ${truncate(task.title, 60)}` : "Replying to a message";

    // ── Prompt: charter, task/message, criteria, procedural memory, inbox, tools, recovery notice.
    const query = task ? `${task.title} ${task.description}` : input.trigger === "message" ? input.message.content : "";
    const lessons = platform.memory.search({ query, agentId: agent.id, kinds: ["procedural"], limit: 3 });
    const inbox = platform.memory.inbox(agent.id, 5);
    if (inbox.length) platform.memory.markRead(inbox.map((m) => m.id));
    // Escalation budget for this task: the agent's escalation subtasks so far.
    // An inputs wait (tasks/inputs.ts) is not an escalation: it spends no budget and answers nothing.
    const escalations = task && input.trigger !== "message" ? input.subtasks.filter((c) => c.state.kind === "escalation" && c.state.inputsWait !== true && (c.state.escalatedBy ?? agent.id) === agent.id) : [];
    const openEscalation = escalations.find((c) => !TERMINAL.has(c.status)) ?? null;
    const escalationAnswered = escalations.some((c) => c.status === "done");
    const mayEscalate = !escalationAnswered && escalations.length < MAX_ESCALATIONS_PER_TASK;
    const tools: ToolSpec[] = platform.tools.specsFor(agent).filter((t) => mayEscalate || !ESCALATION_TOOLS.has(t.name));

    const parts: string[] = [workerCharter(agent, facts)];
    // Catalog specialist (docs/CATALOG.md): the compiled playbook, capped (CATALOG_PLAYBOOK_TOKENS) for the economy tier.
    if (facts.playbook) parts.push(facts.playbook);
    if (task) {
      parts.push(
        `Task T-${task.number}: ${task.title}\n${truncate(task.description, 1500)}` +
          (task.acceptanceCriteria ? `\nAcceptance criteria: ${truncate(task.acceptanceCriteria, 500)}` : ""),
      );
      parts.push(
        "Do the work with your tools, then call complete_task with the concrete deliverable. Files you save go on the company drive where colleagues can read them — use the exact paths your brief names (private/… only for scratch notes). The file tools confirm each save and report word, line and character counts: quote those counts, they are tool-verified. Whoever reviews your work sees the files you saved exactly as they are on disk: in your result, say what you saved and where — no need to read a file back or paste it. Call report_blocker only if the task truly cannot be done.",
      );
    } else if (input.trigger === "message") {
      const recent = input.history.messages.slice(-6).map((m) => `${m.senderId === agent.id ? "you" : m.senderId}: ${oneLine(m.content, 300)}`);
      parts.push(`Conversation (latest last):\n${recent.join("\n")}`);
      parts.push("Reply to the latest message directly and briefly, in your own voice.");
    }
    if (lessons.length) parts.push(`Lessons from past work:\n${lessons.map((m) => `- ${oneLine(m.content, 200)}`).join("\n")}`);
    if (inbox.length) parts.push(`Unread messages:\n${inbox.map((m) => `- ${m.senderId}: ${oneLine(m.content, 200)}`).join("\n")}`);
    if (input.trigger !== "message" && input.recoveryNotice) parts.push(`RECOVERY NOTICE: ${input.recoveryNotice}`);
    if (input.trigger === "subtasks_completed" && input.subtasks.length) {
      const answers = input.subtasks.filter((c) => c.state.kind === "escalation" && c.state.inputsWait !== true);
      const waits = input.subtasks.filter((c) => c.state.inputsWait === true && c.status === "done");
      // The newest finished wait only: earlier ones were already acted on.
      const lastWait = waits.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0];
      if (lastWait) parts.push(truncate(lastWait.result ?? "", 2400));
      for (const c of answers) {
        const who = c.assigneeId ? (platform.org.getAgent(c.assigneeId)?.name ?? "your manager") : "your manager";
        parts.push(`Answer to your escalation from ${who} (${c.status}): ${truncate(c.result ?? c.error ?? "(no answer)", 1500)}\nContinue the task using this answer; do not escalate the same question again.`);
      }
      const others = input.subtasks.filter((c) => c.state.kind !== "escalation");
      if (others.length) parts.push(`Finished subtasks:\n${others.map((c) => `- ${c.title} [${c.status}]: ${truncate(c.result ?? c.error ?? "", 300)}`).join("\n")}`);
    }
    if (input.trigger === "human_answer" && input.answeredApproval) {
      parts.push(`Answer to your question: ${input.answeredApproval.note ?? input.answeredApproval.status}`);
    }

    const context = {
      mode: task ? "task" : "message",
      agent: { name: agent.name, title: agent.title, department: facts.department, departmentSlug: facts.departmentSlug, ...(agent.catalogId ? { specialist: agent.catalogId } : {}) },
      task: task ? { number: task.number, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria } : undefined,
      message: input.trigger === "message" ? input.message.content : undefined,
      tools: tools.map((t) => t.name),
      recovery: input.trigger === "recovery",
    };
    const system = systemPrompt("reflex.step", parts, context);
    const user = task ? "Begin." : input.trigger === "message" ? input.message.content : "Begin.";

    const firstTier = platform.models.tierForStage("reflex.step", agent);
    let tier: ModelTier | null = firstTier;
    let lastError = "";
    let loop: ToolLoopResult | null = null;
    for (let attempt = 0; attempt < 2 && tier; attempt++) {
      try {
        loop = await runToolLoop({
          ctx,
          stage: "reflex.step",
          tier,
          parentSpan: ctx.span,
          system: attempt === 0 ? system : `${system}\n\nA previous attempt did not finish (${lastError}). Be direct and finish.`,
          user,
          tools,
          terminal: { complete: !!task, blocker: !!task },
          maxSteps: this.maxSteps,
          taskId: task?.id ?? null,
          conversationId: input.trigger === "message" ? input.history.conversation.id : null,
          activityLabel: label,
          // The tier cascade comes first; on the last tier, wrap up instead of failing the task.
          wrapUp: attempt === 1 || !NEXT_TIER[tier],
        });
        if (loop.wrappedUp) ctx.span.setAttributes({ "agentco.wrapped_up": true });
        if (loop.status !== "exhausted") break;
        lastError = `no result after ${loop.steps} steps`;
      } catch (err) {
        if (isBudgetError(err) || isAbortError(err, ctx.signal)) throw err;
        lastError = (err as Error).message;
        loop = null;
      }
      // Model cascade fallback: one tier up, once.
      const next: ModelTier | null = NEXT_TIER[tier];
      if (attempt === 0 && next) ctx.span.setAttributes({ "agentco.cascade": `${tier}→${next}`, "agentco.cascade_reason": truncate(lastError, 200) });
      tier = attempt === 0 ? next : null;
    }

    platform.agents.setActivity(agent.id, "idle", null, null);

    if (!loop || loop.status === "exhausted") {
      const error = `reflex loop failed after cascade: ${lastError || "no result"}`;
      this.remember(ctx, task, "failed", error);
      return { outcome: "failed", output: "", error };
    }

    if (loop.status === "waiting") {
      this.remember(ctx, task, "escalated", loop.reason);
      return { outcome: "waiting", output: `Escalated to my manager: ${loop.reason}` };
    }

    if (loop.status === "blocked" && loop.approvalId) {
      this.remember(ctx, task, "blocked", loop.reason);
      return { outcome: "blocked", output: `Asked the Board: ${loop.reason}`, approvalId: loop.approvalId };
    }

    if (loop.status === "blocked") {
      let approvalId: string | undefined;
      let escalated = false;
      if (task && openEscalation) {
        // Reuse the escalation already waiting for an answer; never open a second one.
        escalated = true;
      } else if (task && mayEscalate && agent.tools.includes("escalate")) {
        const r = await platform.tools.execute(
          { id: `blocker_${ctx.run.id}`, name: "escalate", arguments: { reason: loop.reason, question: `Blocked on T-${task.number} "${task.title}": ${loop.reason}` } },
          { agent, runId: ctx.run.id, traceId: ctx.run.traceId, parentSpanId: ctx.span.spanId, taskId: task.id, conversationId: null, signal: ctx.signal },
        );
        for (const e of r.effects) {
          if (e.kind === "approval_requested") approvalId = e.approvalId;
          if (e.kind === "task_created") escalated = true;
        }
      }
      this.remember(ctx, task, "blocked", loop.reason);
      if (escalated) return { outcome: "waiting", output: `Escalated to my manager: ${loop.reason}` };
      if (approvalId) return { outcome: "blocked", output: `Blocked: ${loop.reason}`, approvalId };
      return { outcome: "failed", output: "", error: `Blocked: ${loop.reason}` };
    }

    this.remember(ctx, task, "completed", loop.result);
    return { outcome: "completed", output: loop.result };
  }

  private remember(ctx: EngineContext, task: Task | null, outcome: string, detail: string): void {
    if (!task) return; // chat replies are not episodes
    try {
      ctx.platform.memory.write({
        scope: "agent",
        agentId: ctx.agent.id,
        kind: "episodic",
        content: `T-${task.number} "${truncate(task.title, 80)}": ${outcome} — ${oneLine(detail, 160)}`,
        tags: ["task", outcome],
        importance: outcome === "completed" ? 0.4 : 0.6,
        sourceRunId: ctx.run.id,
        sourceTaskId: task.id,
      });
    } catch {
      /* memory is best-effort; never fail a run over it */
    }
  }
}
