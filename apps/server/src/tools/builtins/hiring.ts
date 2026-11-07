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
import type { AgentTier, CreateAgentInput, Task } from "../../../../../packages/shared/src/index.ts";
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

/**
 * Hires a task has made, on the task's state (`hires`): one per role. Test 5 (2026-11-07): resumed
 * after the Board approved a hire, the hiring manager hired the same SEO Specialist again — nothing
 * said the hire had happened — and the Board approved a duplicate.
 */
export interface HireRecord {
  /** catalogId, or the title for a non-catalog hire. */
  role: string;
  status: "requested" | "hired" | "declined";
  approvalId?: string;
  agentId?: string;
  name?: string;
  firstTaskId?: string;
  /** The task the hire was made on, when read across an objective (objectiveHires). */
  taskNumber?: number;
}

export function hiresOf(task: { state: Record<string, unknown> } | null | undefined): HireRecord[] {
  const v = task?.state.hires;
  return Array.isArray(v) ? (v.filter((h) => h && typeof h === "object" && typeof (h as HireRecord).role === "string") as HireRecord[]) : [];
}

/** Adds or updates the record for `role` (approvalId or role match). */
export function withHire(list: HireRecord[], rec: HireRecord): HireRecord[] {
  const i = list.findIndex((h) => (rec.approvalId && h.approvalId === rec.approvalId) || h.role === rec.role);
  return i >= 0 ? list.map((h, j) => (j === i ? { ...h, ...rec } : h)) : [...list, rec];
}

export function describeHire(h: HireRecord): string {
  const on = h.taskNumber !== undefined ? ` (on T-${h.taskNumber})` : "";
  if (h.status === "hired") return `${h.name ?? h.agentId ?? "someone"} (${h.role}${h.agentId ? `, ${h.agentId}` : ""}) has joined${on}${h.firstTaskId ? "; their first task is assigned" : ""}`;
  if (h.status === "requested") return `a ${h.role} hire is waiting for the Board's approval${on}`;
  return `the Board declined the ${h.role} hire${on}`;
}

/**
 * Hire records across the whole objective — every task under the same root — each with the task it
 * was made on (2026-11-07, trc_617b…: the CMO hired on T-229, then a round-2 task, T-231, asked for
 * the same specialist again; the per-task record did not see the first hire).
 */
export function objectiveHires(view: { get(id: string): Task | null; children(id: string): Task[] }, task: Task | null | undefined): HireRecord[] {
  if (!task) return [];
  const root = task.rootTaskId === task.id ? task : (view.get(task.rootTaskId) ?? task);
  const out: HireRecord[] = [];
  const seen = new Set<string>();
  const queue: Task[] = [root];
  while (queue.length && seen.size < 500) {
    const t = queue.shift()!;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const fresh = t.id === task.id ? task : t;
    for (const h of hiresOf(fresh)) out.push({ ...h, taskNumber: fresh.number });
    queue.push(...view.children(t.id));
  }
  return out;
}

/**
 * The monthly budget the request sets for the hire ("with a $10 monthly budget", "$10/month"), when it
 * states exactly one (2026-11-07: the Board said $10; a plan turned it into "no more than $10" and an
 * old memory made it $8).
 */
export function requestedMonthlyBudget(text: string): number | null {
  const re = /\$\s?(\d+(?:\.\d{1,2})?)\s*(?:\/\s*mo(?:nth)?\b|(?:a|per)\s+month\b|monthly\b)|monthly\s+(?:model\s+)?budget\s+of\s+\$\s?(\d+(?:\.\d{1,2})?)/gi;
  const found = new Set<number>();
  for (const m of text.matchAll(re)) found.add(Number(m[1] ?? m[2]));
  return found.size === 1 ? [...found][0]! : null;
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
      justification: {
        type: "string",
        maxLength: 4000,
        description: "Why this hire, in your own words. Say who recommended the pick only if they actually did (their message or file); never credit a recommendation to someone who did not make it.",
      },
      additional: { type: "boolean", description: "true only when the request explicitly asks for another person in a role your team already has (say why in justification)." },
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

    const firstTask = readFirstTask(args.firstTask);
    if (args.firstTask !== undefined && !firstTask) return fail("firstTask needs a title and a description.");
    if (firstTask && !ctx.taskId) return fail("firstTask can only be assigned from a task (it becomes a subtask of it).");
    const caller = ctx.taskId ? ctx.services.tasks.get(ctx.taskId) : null;

    // The budget the request states is the budget (not a lower one).
    const root = caller ? (caller.rootTaskId === caller.id ? caller : ctx.services.tasks.get(caller.rootTaskId)) : null;
    const asked = root ? requestedMonthlyBudget(`${root.title}\n${root.description}`) : null;
    const given = typeof args.monthlyBudgetUsd === "number" ? Math.round(args.monthlyBudgetUsd * 100) / 100 : null;
    if (asked !== null && asked <= MAX_HIRE_BUDGET_USD && given !== null && Math.abs(given - asked) >= 0.01) {
      return fail(`The request sets a $${asked} monthly budget for this hire. Call hire_agent again with monthlyBudgetUsd ${asked} (not ${given}).`);
    }
    const budget = given ?? (asked !== null && asked <= MAX_HIRE_BUDGET_USD ? asked : null);
    if (budget !== null) input = { ...input, monthlyBudgetUsd: budget };

    // One hire per role per objective: never hire (or ask the Board for) the same role twice.
    const role = input.catalogId ?? input.title ?? "agent";
    const already = objectiveHires(ctx.services.tasks, caller).find((h) => h.role === role && h.status !== "declined");
    if (already) {
      const here = already.taskNumber === caller?.number;
      return fail(
        `Already done ${here ? "for this task" : "on this objective"}: ${describeHire(here ? { ...already, taskNumber: undefined } : already)}. Do not hire again — work with them (they report to their manager). If you truly need a second ${role}, explain why to your manager.`,
      );
    }
    // Someone on the receiving team already holds this catalog role: give them the work.
    if (input.catalogId && args.additional !== true) {
      const managerId = input.managerId ?? ctx.agent.id;
      const holder = org.listActiveAgents().find((a) => a.catalogId === input.catalogId && a.managerId === managerId);
      if (holder) {
        return fail(
          `${holder.name} (${holder.title}, ${holder.id}) already holds ${input.catalogId} on ${managerId === ctx.agent.id ? "your" : "that"} team. Give them the work instead of hiring again. ` +
            "Only if the request explicitly asks for another person in this role, call hire_agent again with additional: true and say why in justification.",
        );
      }
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
        payload: {
          input,
          justification: String(args.justification),
          ...(catalogId ? { catalogId: input.catalogId } : {}),
          ...(firstTask && ctx.taskId ? { firstTask, firstTaskParentId: ctx.taskId } : {}),
        },
      });
      if (caller) ctx.services.tasks.patchState(caller.id, { hires: withHire(hiresOf(caller), { role, status: "requested", approvalId: approval.id }) });
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
    if (caller) {
      const fresh = ctx.services.tasks.get(caller.id) ?? caller;
      ctx.services.tasks.patchState(caller.id, { hires: withHire(hiresOf(fresh), { role, status: "hired", agentId: agent.id, name: agent.name, ...(first ? { firstTaskId: first.id } : {}) }) });
    }
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
