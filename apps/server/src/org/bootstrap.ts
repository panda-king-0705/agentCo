/**
 * First-boot bootstrap: departments (with colors), the template's agents,
 * the Boardroom conversation with the CEO and a welcome blackboard entry.
 * Idempotent: does nothing when any agent exists.
 */
import type { Conversation, Department } from "../../../../packages/shared/src/index.ts";
import type { Repositories } from "../db/index.ts";
import { newId } from "../db/ids.ts";
import type { OrgTemplateId } from "../config.ts";
import type { Catalog } from "../catalog/service.ts";
import { AppError } from "../http/errors.ts";
import type { OrgService } from "./service.ts";
import { AGENCY_STAFFING, DEPARTMENT_TEMPLATES, roleTemplate, templateRoleIds } from "./templates.ts";

export interface BootstrapResult {
  created: boolean;
  departments: number;
  agents: number;
  boardroomId: string;
}

/** Creates the org for `template` unless agents already exist; always ensures a Boardroom. */
export function bootstrapCompany(repos: Repositories, org: OrgService, template: OrgTemplateId, now: () => Date, catalog: Catalog | null = null): BootstrapResult {
  if (repos.agents.list().length > 0) {
    return { created: false, departments: repos.departments.list().length, agents: repos.agents.countActive(), boardroomId: ensureBoardroom(repos, org, now).id };
  }
  const roleIds = templateRoleIds(template);
  const departments = createDepartments(repos, roleIds, now);
  for (const roleId of roleIds) org.createAgent({ roleId }, "system", { ignoreHeadcount: true });
  assignHeads(repos, departments);
  if (template === "agency") staffAgency(repos, org, catalog);
  const boardroom = ensureBoardroom(repos, org, now);
  welcome(repos, org, now);
  return { created: true, departments: repos.departments.list().length, agents: repos.agents.countActive(), boardroomId: boardroom.id };
}

export interface AgencyStaffingResult {
  hired: number;
  /** Specialists left out because MAX_HEADCOUNT was reached. */
  skippedForHeadcount: number;
}

/**
 * ORG_TEMPLATE=agency: brings every department to its AGENCY_STAFFING specialist set (2-4 each),
 * counting specialists a startup worker template already staffs, creating missing departments
 * (Security, Data & AI, Strategy) on demand. Hires stop at MAX_HEADCOUNT; the rest are counted.
 */
export function staffAgency(repos: Repositories, org: OrgService, catalog: Catalog | null): AgencyStaffingResult {
  const result: AgencyStaffingResult = { hired: 0, skippedForHeadcount: 0 };
  if (!catalog || catalog.size === 0) {
    console.warn("[bootstrap] ORG_TEMPLATE=agency but no catalog is loaded; staffed the startup org only");
    return result;
  }
  for (const [slug, ids] of Object.entries(AGENCY_STAFFING)) {
    for (const catalogId of ids) {
      if (!catalog.has(catalogId)) continue;
      const department = org.ensureDepartment(slug);
      const staffed = repos.agents.list({ departmentId: department.id, includeTerminated: false }).some((a) => a.tier === "worker" && a.catalogId === catalogId);
      if (staffed) continue;
      try {
        org.createAgent({ catalogId, departmentId: department.id }, "system");
        result.hired++;
      } catch (error) {
        if (error instanceof AppError && error.status === 409) result.skippedForHeadcount++;
        else throw error;
      }
    }
  }
  if (result.skippedForHeadcount) console.warn(`[bootstrap] agency org: ${result.skippedForHeadcount} specialist(s) not hired (MAX_HEADCOUNT reached)`);
  return result;
}

/** Departments that have at least one role in the template (parents first). */
function createDepartments(repos: Repositories, roleIds: string[], now: () => Date): Department[] {
  const used = new Set(roleIds.map((id) => roleTemplate(id)?.departmentSlug));
  const created: Department[] = [];
  for (const template of DEPARTMENT_TEMPLATES.filter((d) => used.has(d.slug))) {
    const parent = template.parentSlug ? repos.departments.bySlug(template.parentSlug) : null;
    const department: Department = {
      id: newId("dep"),
      slug: template.slug,
      name: template.name,
      mandate: template.mandate,
      parentId: parent?.id ?? null,
      headAgentId: null,
      color: template.color,
      monthlyBudgetUsd: 0,
      createdAt: now().toISOString(),
    };
    repos.departments.insert(department);
    created.push(department);
  }
  return created;
}

/** Department head = holder of the template's head role, else the most senior agent in it. */
function assignHeads(repos: Repositories, departments: Department[]): void {
  const rank = { executive: 0, manager: 1, worker: 2 } as const;
  for (const department of departments) {
    const template = DEPARTMENT_TEMPLATES.find((d) => d.slug === department.slug);
    const members = repos.agents.list({ departmentId: department.id });
    const head = members.find((a) => a.roleId === template?.headRoleId) ?? [...members].sort((a, b) => rank[a.tier] - rank[b.tier])[0];
    if (head) repos.departments.update(department.id, { headAgentId: head.id });
  }
}

/** The single Boardroom: the human Board and the CEO. */
export function ensureBoardroom(repos: Repositories, org: OrgService, now: () => Date): Conversation {
  const existing = repos.conversations.boardroom();
  if (existing) return existing;
  const ceo = org.ceo();
  const conversation: Conversation = {
    id: newId("cnv"),
    kind: "boardroom",
    title: "Boardroom",
    participantIds: ceo ? ["human", ceo.id] : ["human"],
    createdAt: now().toISOString(),
    lastMessageAt: null,
  };
  repos.conversations.insert(conversation);
  return conversation;
}

function welcome(repos: Repositories, org: OrgService, now: () => Date): void {
  const ceo = org.ceo();
  repos.blackboard.set({
    key: "welcome",
    value:
      `Welcome to the company. The Board (a human) sets direction in the Boardroom; ${ceo ? `${ceo.name} (CEO)` : "the CEO"} turns requests into objectives ` +
      "and delegates down the org. Keep work traceable, spend frugally, escalate early, and write durable lessons to memory.",
    updatedBy: "system",
    updatedAt: now().toISOString(),
  });
}
