/**
 * hire_agent — executives only; approval when policy or headcount requires it.
 *
 * With `catalogId` (a specialist found with catalog_search) the new hire is a catalog worker: title,
 * department (division mapping, created on demand at hire time) and persona come from the catalog,
 * tier worker / cognition reflex / economy model, and the manager defaults to the department's lead —
 * which must be the caller or someone in the caller's subtree. The approval policy is unchanged.
 *
 * The hiring manager makes the hire (founder, 2026-11-07: "managers hire, recruiter sources"):
 * `monthlyBudgetUsd` sets the new hire's budget and `firstTask` assigns their first piece of work as
 * a subtask of the hiring task — at once, or when the Board approves the hire — so the hiring
 * manager waits for it and reviews it like any delegated part.
 */
import type { AgentTier, CreateAgentInput } from "../../../../../packages/shared/src/index.ts";
import { roleTemplate } from "../../org/templates.ts";
import type { ToolEffect } from "../../contracts.ts";
import { EXECUTIVES, fail, ok, type ToolDefinition, type ToolRunContext } from "../types.ts";

/** Upper bound for a new hire's monthly model budget set by an agent (the Board can raise it). */
export const MAX_HIRE_BUDGET_USD = 50;

export interface FirstTask {
  title: string;
  description: string;
  acceptanceCriteria: string | null;
}

export function readFirstTask(v: unknown): FirstTask | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const description = typeof o.description === "string" ? o.description.trim() : "";
  if (!title || !description) return null;
  return { title: title.slice(0, 300), description: description.slice(0, 20_000), acceptanceCriteria: typeof o.acceptanceCriteria === "string" && o.acceptanceCriteria.trim() ? o.acceptanceCriteria.trim().slice(0, 4000) : null };
}

export const hireAgent: ToolDefinition = {
  name: "hire_agent",
  description:
    "Hire a new agent under a manager in your subtree. For a specialist worker pass catalogId (find one with catalog_search); " +
    "title, department and persona then come from the catalog and the manager defaults to the department's lead. " +
    "Otherwise give title, departmentId, managerId and tier. monthlyBudgetUsd sets their monthly model budget; firstTask {title, description, acceptanceCriteria} " +
    "assigns their first piece of work (name the exact file path) — you are resumed with their result. Requires Board approval when hiring approval is on or headcount is at the cap; the first task is then assigned when the Board approves.",
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
      monthlyBudgetUsd: { type: "number", minimum: 0, maximum: MAX_HIRE_BUDGET_USD, description: "Monthly model budget in USD (0 = no per-agent cap)." },
      firstTask: {
        type: "object",
        properties: { title: { type: "string", maxLength: 300 }, description: { type: "string", maxLength: 20000 }, acceptanceCriteria: { type: "string", maxLength: 4000 } },
        required: ["title", "description"],
        description: "The new hire's first task, assigned as soon as they join.",
      },
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

    if (typeof args.monthlyBudgetUsd === "number") input = { ...input, monthlyBudgetUsd: Math.round(args.monthlyBudgetUsd * 100) / 100 };
    const firstTask = readFirstTask(args.firstTask);
    if (args.firstTask !== undefined && !firstTask) return fail("firstTask needs a title and a description.");
    if (firstTask && !ctx.taskId) return fail("firstTask can only be assigned from a task (it becomes a subtask of it).");

    const settings = company.settings();
    const atCap = org.listActiveAgents().length >= settings.maxHeadcount;
    if (settings.hiringRequiresApproval || atCap) {
      const approval = approvals.create({
        kind: "hire_agent",
        requestedBy: ctx.agent.id,
        taskId: ctx.taskId,
        traceId: ctx.traceId,
        summary: `${ctx.agent.name} wants to hire a ${label}${atCap ? " — headcount cap reached" : ""}: ${String(args.justification).slice(0, 200)}`,
        payload: {
          input,
          justification: String(args.justification),
          ...(catalogId ? { catalogId: input.catalogId } : {}),
          ...(firstTask && ctx.taskId ? { firstTask, firstTaskParentId: ctx.taskId } : {}),
        },
      });
      return ok(
        `Hiring request sent to the Board (approval ${approval.id}).${firstTask ? " Their first task is assigned when the Board approves." : ""} You will be resumed with the Board's decision.`,
        [{ kind: "approval_requested", approvalId: approval.id }],
        { approvalId: approval.id },
      );
    }
    const agent = org.createAgent(input, ctx.agent.id);
    const effects: ToolEffect[] = [{ kind: "agent_hired", agentId: agent.id }];
    const first = firstTask ? assignFirstTask(ctx, agent.id, firstTask) : null;
    if (first) effects.push({ kind: "task_created", taskId: first.id, assigneeId: agent.id });
    return ok(
      `Hired ${agent.name} as ${agent.title} (${agent.id})${input.monthlyBudgetUsd !== undefined ? ` with a $${input.monthlyBudgetUsd}/month budget` : ""}.` +
        (first ? ` First task assigned as T-${first.number}; you will be resumed with their result.` : ""),
      effects,
      { agentId: agent.id, ...(first ? { firstTaskId: first.id } : {}) },
    );
  },
};

/** The new hire's first task: a subtask of the hiring task, so the hiring manager waits for it. */
function assignFirstTask(ctx: ToolRunContext, agentId: string, t: FirstTask): { id: string; number: number } | null {
  const parent = ctx.taskId ? ctx.services.tasks.get(ctx.taskId) : null;
  if (!parent) return null;
  const sub = ctx.services.tasks.createSubtask({
    parent,
    traceId: ctx.traceId,
    assigneeId: agentId,
    createdBy: ctx.agent.id,
    title: t.title,
    description: t.description,
    ...(t.acceptanceCriteria ? { acceptanceCriteria: t.acceptanceCriteria } : {}),
    state: { firstTask: true },
  });
  return { id: sub.id, number: sub.number };
}
