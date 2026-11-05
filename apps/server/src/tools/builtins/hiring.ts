/** hire_agent — executives only; approval when policy or headcount requires it. */
import type { AgentTier, CreateAgentInput } from "../../../../../packages/shared/src/index.ts";
import { roleTemplate } from "../../org/templates.ts";
import { EXECUTIVES, fail, ok, type ToolDefinition } from "../types.ts";

export const hireAgent: ToolDefinition = {
  name: "hire_agent",
  description:
    "Hire a new agent under a manager in your subtree. Requires Board approval when hiring approval is on or headcount is at the cap.",
  parameters: {
    type: "object",
    properties: {
      roleId: { type: "string", description: "Optional role template id (see the org's roles)." },
      title: { type: "string", maxLength: 120 },
      departmentId: { type: "string" },
      managerId: { type: "string" },
      tier: { type: "string", enum: ["executive", "manager", "worker"] },
      justification: { type: "string", maxLength: 4000 },
    },
    required: ["title", "departmentId", "managerId", "tier", "justification"],
  },
  tiers: EXECUTIVES,
  run(args, ctx) {
    const { org, approvals, company } = ctx.services;
    const managerId = String(args.managerId);
    if (managerId !== ctx.agent.id && !org.isInSubtree(ctx.agent.id, managerId)) return fail("The new hire's manager must be you or someone in your subtree.");
    if (typeof args.roleId === "string" && !roleTemplate(args.roleId)) return fail(`Unknown roleId ${args.roleId}.`);
    if (!org.department(String(args.departmentId))) return fail(`Unknown departmentId ${String(args.departmentId)}.`);
    const input: CreateAgentInput = {
      ...(typeof args.roleId === "string" ? { roleId: args.roleId } : {}),
      title: String(args.title),
      departmentId: String(args.departmentId),
      managerId,
      tier: args.tier as AgentTier,
    };
    const settings = company.settings();
    const atCap = org.listActiveAgents().length >= settings.maxHeadcount;
    if (settings.hiringRequiresApproval || atCap) {
      const approval = approvals.create({
        kind: "hire_agent",
        requestedBy: ctx.agent.id,
        taskId: ctx.taskId,
        traceId: ctx.traceId,
        summary: `${ctx.agent.name} wants to hire a ${String(args.title)} (${String(args.tier)})${atCap ? " — headcount cap reached" : ""}: ${String(args.justification).slice(0, 200)}`,
        payload: { input, justification: String(args.justification) },
      });
      return ok(`Hiring request sent to the Board (approval ${approval.id}).`, [{ kind: "approval_requested", approvalId: approval.id }], { approvalId: approval.id });
    }
    const agent = org.createAgent(input, ctx.agent.id);
    return ok(`Hired ${agent.name} as ${agent.title} (${agent.id}).`, [{ kind: "agent_hired", agentId: agent.id }], { agentId: agent.id });
  },
};
