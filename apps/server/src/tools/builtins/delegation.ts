/** delegate_task — creates a subtask + a `delegation` span (child of the tool span). */
import { newId } from "../../db/ids.ts";
import { fail, LEADS, ok, type ToolDefinition } from "../types.ts";
import { resolveAgent } from "../../org/directory.ts";

export const delegateTask: ToolDefinition = {
  name: "delegate_task",
  description:
    "Delegate a subtask to an agent in your reporting subtree (the CEO may delegate to anyone). Your current task waits until every delegated subtask is finished, then you are woken to evaluate the results.",
  parameters: {
    type: "object",
    properties: {
      assigneeId: { type: "string", description: "The assignee (one of your reports): agent id, name or title." },
      title: { type: "string", maxLength: 300, description: "Short imperative title." },
      description: { type: "string", maxLength: 20000, description: "What to do, context and constraints." },
      acceptanceCriteria: { type: "string", maxLength: 4000, description: "How the result will be judged." },
      value: { type: "number", minimum: 0, maximum: 1000, description: "Business value 0-1000 (priority = value / cost)." },
      estCostUsd: { type: "number", minimum: 0, maximum: 1000, description: "Estimated model cost in USD." },
    },
    required: ["assigneeId", "title", "description"],
  },
  tiers: LEADS,
  run(args, ctx) {
    const { org, tasks } = ctx.services;
    const assignee = resolveAgent(org, String(args.assigneeId), ctx.agent);
    if (!assignee || assignee.status === "terminated") {
      const reports = org.directReports(ctx.agent.id).filter((a) => a.status !== "terminated");
      return fail(`No single active agent matches "${String(args.assigneeId)}". Your direct reports: ${reports.map((r) => `${r.name} (${r.title}, id ${r.id})`).join("; ") || "none"}.`);
    }
    if (assignee.id === ctx.agent.id) return fail("You cannot delegate to yourself; do the work directly or pick a report.");
    if (!org.isInSubtree(ctx.agent.id, assignee.id)) {
      const reports = org.directReports(ctx.agent.id).map((r) => `${r.id} (${r.title})`).join(", ") || "none";
      return fail(`${assignee.name} is not in your reporting subtree. Your direct reports: ${reports}.`);
    }
    const parent = ctx.taskId ? tasks.get(ctx.taskId) : null;
    const taskId = newId("tsk");
    const delegation = ctx.span.child({
      kind: "delegation",
      name: `delegate → ${assignee.name}`,
      input: `${String(args.title)}\n\n${String(args.description)}`,
      attributes: { "agentco.delegate.to": assignee.id, "agentco.delegate.to_name": assignee.name, "agentco.delegate.from": ctx.agent.id, "agentco.task.id": taskId },
    });
    try {
      const task = tasks.createSubtask({
        id: taskId,
        parent,
        traceId: ctx.traceId,
        assigneeId: assignee.id,
        createdBy: ctx.agent.id,
        title: String(args.title),
        description: String(args.description),
        acceptanceCriteria: typeof args.acceptanceCriteria === "string" ? args.acceptanceCriteria : null,
        ...(typeof args.value === "number" ? { value: args.value } : {}),
        ...(typeof args.estCostUsd === "number" ? { estCostUsd: args.estCostUsd } : {}),
        originConversationId: parent ? null : ctx.conversationId,
        state: { delegationSpanId: delegation.spanId },
      });
      delegation.end({ status: "ok", output: `T-${task.number} assigned to ${assignee.name}`, attributes: { "agentco.task.number": task.number } });
      return ok(
        `Delegated T-${task.number} "${task.title}" to ${assignee.name} (${assignee.title}). ${parent ? `T-${parent.number} will wait for it.` : "It is a new objective."}`,
        [{ kind: "task_created", taskId: task.id, assigneeId: assignee.id }],
        { taskId: task.id, number: task.number },
      );
    } catch (error) {
      delegation.end({ status: "error", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
};
