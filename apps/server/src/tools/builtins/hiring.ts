/**
 * hire_agent — executives only; approval when policy or headcount requires it.
 *
 * With `catalogId` (a specialist found with catalog_search) the new hire is a catalog worker: title,
 * department (division mapping, created on demand at hire time) and persona come from the catalog,
 * tier worker / cognition reflex / economy model, and the manager defaults to the department's lead —
 * which must be the caller or someone in the caller's subtree. The approval policy is unchanged.
 */
import type { AgentTier, CreateAgentInput } from "../../../../../packages/shared/src/index.ts";
import { roleTemplate } from "../../org/templates.ts";
import { EXECUTIVES, fail, ok, type ToolDefinition } from "../types.ts";

export const hireAgent: ToolDefinition = {
  name: "hire_agent",
  description:
    "Hire a new agent under a manager in your subtree. For a specialist worker pass catalogId (find one with catalog_search); " +
    "title, department and persona then come from the catalog and the manager defaults to the department's lead. " +
    "Otherwise give title, departmentId, managerId and tier. Requires Board approval when hiring approval is on or headcount is at the cap.",
  parameters: {
    type: "object",
    properties: {
      catalogId: { type: "string", maxLength: 120, description: "Catalog specialist id (division/slug) from catalog_search." },
      roleId: { type: "string", description: "Optional role template id (see the org's roles)." },
      title: { type: "string", maxLength: 120 },
      departmentId: { type: "string" },
      managerId: { type: "string" },
      tier: { type: "string", enum: ["executive", "manager", "worker"] },
      justification: { type: "string", maxLength: 4000 },
    },
    required: ["justification"],
  },
  tiers: EXECUTIVES,
  run(args, ctx) {
    const { org, approvals, company, catalog } = ctx.services;
    const str = (k: string): string | undefined => (typeof args[k] === "string" && (args[k] as string).trim() ? (args[k] as string).trim() : undefined);
    const catalogId = str("catalogId");
    if (typeof args.roleId === "string" && !roleTemplate(args.roleId)) return fail(`Unknown roleId ${args.roleId}.`);

    let input: CreateAgentInput;
    let label: string;
    if (catalogId) {
      const spec = catalog?.get(catalogId);
      if (!spec) return fail(`Unknown catalogId ${catalogId}. Use catalog_search to find a specialist.`);
      if (args.tier !== undefined && args.tier !== "worker") return fail("Catalog specialists are hired as workers; omit tier or pass tier worker.");
      const departmentId = str("departmentId");
      const explicitDepartment = departmentId ? (org.department(departmentId) ?? org.listDepartments().find((d) => d.slug === departmentId) ?? null) : null;
      if (departmentId && !explicitDepartment) return fail(`Unknown departmentId ${departmentId}.`);
      const placement = org.catalogPlacement(catalogId);
      const defaultLead = explicitDepartment ? org.departmentLead(explicitDepartment.slug)?.id : placement.managerId;
      const managerId = str("managerId") ?? defaultLead ?? ctx.agent.id;
      if (managerId !== ctx.agent.id && !org.isInSubtree(ctx.agent.id, managerId)) {
        const lead = org.getAgent(managerId);
        return fail(
          `${spec.name} would report to ${lead ? `${lead.name} (${lead.title})` : managerId}, who is not in your subtree. ` +
            "Pass managerId = yourself or one of your reports, or ask that department's executive to hire.",
        );
      }
      input = { catalogId: spec.id, managerId, ...(departmentId ? { departmentId } : {}), ...(str("title") ? { title: str("title") } : {}) };
      const where = explicitDepartment ? explicitDepartment.name : `${placement.departmentName}${placement.createsDepartment ? ", new department" : ""}`;
      label = `${spec.emoji ? `${spec.emoji} ` : ""}${str("title") ?? spec.name} (catalog specialist, ${where})`;
    } else {
      const missing = ["title", "departmentId", "managerId", "tier"].filter((k) => !str(k));
      if (missing.length) return fail(`Missing ${missing.join(", ")} (or pass catalogId to hire a catalog specialist).`);
      const managerId = str("managerId") as string;
      if (managerId !== ctx.agent.id && !org.isInSubtree(ctx.agent.id, managerId)) return fail("The new hire's manager must be you or someone in your subtree.");
      if (!org.department(String(args.departmentId))) return fail(`Unknown departmentId ${String(args.departmentId)}.`);
      input = {
        ...(typeof args.roleId === "string" ? { roleId: args.roleId } : {}),
        title: String(args.title),
        departmentId: String(args.departmentId),
        managerId,
        tier: args.tier as AgentTier,
      };
      label = `${String(args.title)} (${String(args.tier)})`;
    }

    const settings = company.settings();
    const atCap = org.listActiveAgents().length >= settings.maxHeadcount;
    if (settings.hiringRequiresApproval || atCap) {
      const approval = approvals.create({
        kind: "hire_agent",
        requestedBy: ctx.agent.id,
        taskId: ctx.taskId,
        traceId: ctx.traceId,
        summary: `${ctx.agent.name} wants to hire a ${label}${atCap ? " — headcount cap reached" : ""}: ${String(args.justification).slice(0, 200)}`,
        payload: { input, justification: String(args.justification), ...(catalogId ? { catalogId: input.catalogId } : {}) },
      });
      return ok(`Hiring request sent to the Board (approval ${approval.id}).`, [{ kind: "approval_requested", approvalId: approval.id }], { approvalId: approval.id });
    }
    const agent = org.createAgent(input, ctx.agent.id);
    return ok(`Hired ${agent.name} as ${agent.title} (${agent.id}).`, [{ kind: "agent_hired", agentId: agent.id }], { agentId: agent.id });
  },
};
