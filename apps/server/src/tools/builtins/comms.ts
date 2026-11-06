/** send_message, escalate, ask_human. */
import { oneLine } from "../../events/bus.ts";
import { newId } from "../../db/ids.ts";
import type { Task } from "../../../../../packages/shared/src/index.ts";
import type { ToolEffect } from "../../contracts.ts";
import { truncate } from "../../cognition/text.ts";
import { ALL_TIERS, fail, LEADS, ok, type ToolDefinition, type ToolRunContext } from "../types.ts";

export const sendMessage: ToolDefinition = {
  name: "send_message",
  description: "Send a direct message to another agent. It lands in their inbox (it does not start a run).",
  parameters: {
    type: "object",
    properties: { toAgentId: { type: "string" }, content: { type: "string", maxLength: 8000 } },
    required: ["toAgentId", "content"],
  },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const { org, conversations } = ctx.services;
    const to = org.getAgent(String(args.toAgentId));
    if (!to || to.status === "terminated") return fail(`No active agent with id ${String(args.toAgentId)}.`);
    if (to.id === ctx.agent.id) return fail("You cannot message yourself.");
    const message = conversations.sendAgentMessage(ctx.agent, to, String(args.content), { runId: ctx.runId, taskId: ctx.taskId, traceId: ctx.traceId });
    return ok(`Message delivered to ${to.name}'s inbox.`, [{ kind: "message_sent", messageId: message.id, conversationId: message.conversationId }]);
  },
};

/** Characters of the stuck task's own text, and of the original request, carried into an escalation. */
export const ESCALATION_TASK_CHARS = 1500;
export const ESCALATION_ROOT_CHARS = 800;

/**
 * What the stuck task actually asked for — and, when it is a subtask, the original request it came
 * from. Without it the manager (or the CEO, or the Board) answering an escalation saw only the
 * summary: "Custodian ID was not supplied" while the ID was in the very task that escalated.
 */
export function escalationContext(task: Task, root: Task | null, assignee: string): string {
  const parts = [`What T-${task.number} asks (as assigned to ${assignee}):\n${truncate(task.description, ESCALATION_TASK_CHARS)}`];
  if (task.acceptanceCriteria) parts.push(`Acceptance criteria: ${truncate(task.acceptanceCriteria, 400)}`);
  if (root && root.id !== task.id && !task.description.includes(root.description.slice(0, 200))) {
    parts.push(`Original request T-${root.number} "${root.title}":\n${truncate(root.description, ESCALATION_ROOT_CHARS)}`);
  }
  return parts.join("\n\n");
}

function rootOf(ctx: ToolRunContext, task: Task | null): Task | null {
  if (!task) return null;
  return task.rootTaskId === task.id ? task : ctx.services.tasks.get(task.rootTaskId);
}

function askBoard(ctx: ToolRunContext, question: string, reason: string | null) {
  // One open Board question per objective: further questions from the same objective wait on it
  // (its answer wakes every task blocked on it) instead of piling up in the Board's queue.
  const task = ctx.taskId ? ctx.services.tasks.get(ctx.taskId) : null;
  const root = rootOf(ctx, task);
  const rootTaskId = task?.rootTaskId ?? null;
  const open = rootTaskId ? ctx.services.approvals.pendingQuestionFor(rootTaskId) : null;
  if (open) {
    return ok(
      `The Board already has an open question for this objective (approval ${open.id}): "${oneLine(String(open.payload.question ?? open.summary), 200)}". Stop here and report the task as blocked; you will be resumed with their answer.`,
      [{ kind: "approval_requested", approvalId: open.id }],
      { approvalId: open.id, deduped: true },
    );
  }
  const approval = ctx.services.approvals.create({
    kind: "question",
    requestedBy: ctx.agent.id,
    taskId: ctx.taskId,
    traceId: ctx.traceId,
    summary: `${ctx.agent.name} asks: ${oneLine(question, 300)}`,
    payload: {
      question,
      reason,
      rootTaskId,
      // Shown under the question in Approvals: what the objective is about, in its creator's words.
      ...(root ? { context: `On T-${root.number} "${root.title}": ${truncate(root.description, 400)}` } : {}),
    },
  });
  return ok(
    `Question sent to the Board (approval ${approval.id}). Stop here and report the task as blocked; you will be resumed with their answer.`,
    [{ kind: "approval_requested", approvalId: approval.id }],
    { approvalId: approval.id },
  );
}

export const escalate: ToolDefinition = {
  name: "escalate",
  description: "Escalate a problem to your manager (the CEO escalates to the Board as a question).",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", maxLength: 4000 }, question: { type: "string", maxLength: 4000 } },
    required: ["reason", "question"],
  },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const { org, conversations, tasks } = ctx.services;
    // Up the chain to the next ACTIVE ancestor (a terminated manager is skipped); the CEO — or an
    // agent with no active ancestor left — asks the Board.
    const manager = org.managerChain(ctx.agent.id).find((m) => m.status !== "terminated") ?? null;
    if (!manager) return askBoard(ctx, String(args.question), String(args.reason));
    const reason = String(args.reason);
    const question = String(args.question);
    const task = ctx.taskId ? tasks.get(ctx.taskId) : null;
    const content = `Escalation${task ? ` on T-${task.number} "${task.title}"` : ""}: ${reason}\nQuestion: ${question}`;
    const effects: ToolEffect[] = [];
    let created: { id: string; number: number } | null = null;
    if (task) {
      // Up the chain like a real company: a subtask of the caller's task, assigned to the manager.
      const taskId = newId("tsk");
      const delegation = ctx.span.child({
        kind: "delegation",
        name: `escalate → ${manager.name}`,
        input: content,
        attributes: { "agentco.delegate.to": manager.id, "agentco.delegate.to_name": manager.name, "agentco.delegate.from": ctx.agent.id, "agentco.task.id": taskId, "agentco.escalation": true },
      });
      try {
        const sub = tasks.createSubtask({
          id: taskId,
          parent: task,
          traceId: ctx.traceId,
          assigneeId: manager.id,
          createdBy: ctx.agent.id,
          title: `Escalation from ${ctx.agent.name}: ${question}`.slice(0, 300),
          description:
            `${ctx.agent.name} (${ctx.agent.title}) is stuck on T-${task.number} "${task.title}".\n\n` +
            // The brain's question already restates the reason; don't print it twice.
            (question.includes(reason.slice(0, 80)) ? "" : `Why: ${reason}\n\n`) +
            `Question: ${question}\n\n${escalationContext(task, rootOf(ctx, task), ctx.agent.name)}\n\n` +
            `Answer it (or fix the blocker); your result is handed back to ${ctx.agent.name} as the answer.`,
          value: 900,
          estCostUsd: 0.05,
          state: { kind: "escalation", escalatedBy: ctx.agent.id, delegationSpanId: delegation.spanId },
        });
        delegation.end({ status: "ok", output: `T-${sub.number} escalated to ${manager.name}` });
        created = { id: sub.id, number: sub.number };
        effects.push({ kind: "task_created", taskId: sub.id, assigneeId: manager.id });
      } catch (error) {
        delegation.end({ status: "error", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    const message = conversations.sendAgentMessage(ctx.agent, manager, content, { runId: ctx.runId, taskId: ctx.taskId, traceId: ctx.traceId });
    effects.push({ kind: "message_sent", messageId: message.id, conversationId: message.conversationId });
    return ok(
      created
        ? `Escalated to ${manager.name} (${manager.title}) as T-${created.number}. Return outcome "waiting"; you will be resumed with their answer.`
        : `Escalated to ${manager.name} (${manager.title}).`,
      effects,
      created ? { taskId: created.id, number: created.number } : undefined,
    );
  },
};

export const askHuman: ToolDefinition = {
  name: "ask_human",
  description: "Ask the human Board a question. Opens a `question` approval; your task is blocked until they answer.",
  parameters: { type: "object", properties: { question: { type: "string", maxLength: 4000 } }, required: ["question"] },
  tiers: LEADS,
  run(args, ctx) {
    return askBoard(ctx, String(args.question), null);
  },
};
