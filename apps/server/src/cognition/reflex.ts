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
 * report_blocker: the engine escalates via the `escalate` tool when the agent
 * has it; an approval effect → outcome "blocked" (re-run on human_answer);
 * otherwise → "failed" with the reason, so the manager's evaluation sees it.
 */
import type { ModelTier, Task } from "../../../../packages/shared/src/index.ts";
import type { CognitiveEngine, EngineContext, EngineResult, ToolSpec } from "../contracts.ts";
import { agentFacts, systemPrompt, workerCharter } from "./prompt.ts";
import { isAbortError, isBudgetError } from "../models/router.ts";
import { runToolLoop, type ToolLoopResult } from "./tool-loop.ts";
import { oneLine, truncate } from "./text.ts";

const NEXT_TIER: Record<ModelTier, ModelTier | null> = { economy: "standard", standard: "frontier", frontier: null };

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
    const tools: ToolSpec[] = platform.tools.specsFor(agent);

    const parts: string[] = [workerCharter(agent, facts)];
    if (task) {
      parts.push(
        `Task T-${task.number}: ${task.title}\n${truncate(task.description, 1500)}` +
          (task.acceptanceCriteria ? `\nAcceptance criteria: ${truncate(task.acceptanceCriteria, 500)}` : ""),
      );
      parts.push(
        "Do the work with your tools (save substantial documents under shared/<your-department>/), then call complete_task with the concrete deliverable. Call report_blocker only if the task truly cannot be done.",
      );
    } else if (input.trigger === "message") {
      const recent = input.history.messages.slice(-6).map((m) => `${m.senderId === agent.id ? "you" : m.senderId}: ${oneLine(m.content, 300)}`);
      parts.push(`Conversation (latest last):\n${recent.join("\n")}`);
      parts.push("Reply to the latest message directly and briefly, in your own voice.");
    }
    if (lessons.length) parts.push(`Lessons from past work:\n${lessons.map((m) => `- ${oneLine(m.content, 200)}`).join("\n")}`);
    if (inbox.length) parts.push(`Unread messages:\n${inbox.map((m) => `- ${m.senderId}: ${oneLine(m.content, 200)}`).join("\n")}`);
    if (input.trigger !== "message" && input.recoveryNotice) parts.push(`RECOVERY NOTICE: ${input.recoveryNotice}`);
    if (input.trigger === "human_answer" && input.answeredApproval) {
      parts.push(`Answer to your question: ${input.answeredApproval.note ?? input.answeredApproval.status}`);
    }

    const context = {
      mode: task ? "task" : "message",
      agent: { name: agent.name, title: agent.title, department: facts.department, departmentSlug: facts.departmentSlug },
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
        });
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

    if (loop.status === "blocked") {
      let approvalId: string | undefined;
      if (task && agent.tools.includes("escalate")) {
        const r = await platform.tools.execute(
          { id: `blocker_${ctx.run.id}`, name: "escalate", arguments: { reason: loop.reason, question: `Blocked on T-${task.number} "${task.title}": ${loop.reason}` } },
          { agent, runId: ctx.run.id, traceId: ctx.run.traceId, parentSpanId: ctx.span.spanId, taskId: task.id, conversationId: null, signal: ctx.signal },
        );
        for (const e of r.effects) if (e.kind === "approval_requested") approvalId = e.approvalId;
      }
      this.remember(ctx, task, "blocked", loop.reason);
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
