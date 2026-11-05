/** send_message, escalate, ask_human. */
import { oneLine } from "../../events/bus.ts";
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

function askBoard(ctx: ToolRunContext, question: string, reason: string | null) {
  const approval = ctx.services.approvals.create({
    kind: "question",
    requestedBy: ctx.agent.id,
    taskId: ctx.taskId,
    traceId: ctx.traceId,
    summary: `${ctx.agent.name} asks: ${oneLine(question, 300)}`,
    payload: { question, reason },
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
    const manager = ctx.agent.managerId ? org.getAgent(ctx.agent.managerId) : null;
    if (!manager || manager.status === "terminated") return askBoard(ctx, String(args.question), String(args.reason));
    const task = ctx.taskId ? tasks.get(ctx.taskId) : null;
    const content = `Escalation${task ? ` on T-${task.number} "${task.title}"` : ""}: ${String(args.reason)}\nQuestion: ${String(args.question)}`;
    const message = conversations.sendAgentMessage(ctx.agent, manager, content, { runId: ctx.runId, taskId: ctx.taskId, traceId: ctx.traceId });
    return ok(`Escalated to ${manager.name} (${manager.title}).`, [{ kind: "message_sent", messageId: message.id, conversationId: message.conversationId }]);
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
