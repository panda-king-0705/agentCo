/**
 * First-boot bootstrap: departments (with colors), the template's agents,
 * the Boardroom conversation with the CEO and a welcome blackboard entry.
 * Idempotent: does nothing when any agent exists.
 */
import type { Conversation, Department } from "../../../../packages/shared/src/index.ts";
import type { Repositories } from "../db/index.ts";
import { newId } from "../db/ids.ts";
import type { OrgTemplateId } from "../config.ts";
import type { OrgService } from "./service.ts";
import { DEPARTMENT_TEMPLATES, roleTemplate, templateRoleIds } from "./templates.ts";

export interface BootstrapResult {
  created: boolean;
  departments: number;
  agents: number;
  boardroomId: string;
}

/** Creates the org for `template` unless agents already exist; always ensures a Boardroom. */
export function bootstrapCompany(repos: Repositories, org: OrgService, template: OrgTemplateId, now: () => Date): BootstrapResult {
  if (repos.agents.list().length > 0) {
    return { created: false, departments: repos.departments.list().length, agents: repos.agents.countActive(), boardroomId: ensureBoardroom(repos, org, now).id };
  }
  const roleIds = templateRoleIds(template);
  const departments = createDepartments(repos, roleIds, now);
  for (const roleId of roleIds) org.createAgent({ roleId }, "system", { ignoreHeadcount: true });
  assignHeads(repos, departments);
  const boardroom = ensureBoardroom(repos, org, now);
  welcome(repos, org, now);
  return { created: true, departments: departments.length, agents: roleIds.length, boardroomId: boardroom.id };
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
