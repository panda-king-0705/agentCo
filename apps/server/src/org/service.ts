/**
 * OrgService: departments, agents, reporting lines and the agent lifecycle
 * (create / update / pause / resume / destroy). Implements OrgView and
 * AgentStateWriter for the engines.
 */
import type {
  Agent,
  AgentStats,
  BaZiChart,
  BrainBlockId,
  CreateAgentInput,
  Department,
  DestroyAgentResult,
  NeedsState,
  RoleTemplate,
  Task,
  UpdateAgentInput,
} from "../../../../packages/shared/src/index.ts";
import type { AgentStateWriter, CognitiveStatePatch, OrgView } from "../contracts.ts";
import type { Repositories } from "../db/index.ts";
import type { EventBus } from "../events/bus.ts";
import { summaries } from "../events/summary.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";
import { dayStart, monthStart, type BudgetService } from "../middleware/budget.ts";
import type { RunControl } from "../runs/abort.ts";
import type { Workspaces } from "../tools/workspace.ts";
import { buildAgent, pickName } from "./agent-factory.ts";
import type { CompanyService } from "./company.ts";
import { computeNeeds } from "./needs.ts";
import { roleTemplate } from "./templates.ts";

export interface OrgDeps {
  repos: Repositories;
  bus: EventBus;
  company: CompanyService;
  budget: BudgetService;
  workspaces: Workspaces;
  now: () => Date;
  castBaZi: (birthIso: string) => BaZiChart | null;
  /** Names of every registered tool (for validating agent.tools). */
  knownTools: () => string[];
  /** Ids of the configured model profiles (for validating modelOverride); absent = not checked. */
  knownProfiles?: () => string[];
}

/** Hands an open task to a new assignee (TaskService.reassign): refund, clean state, keep it schedulable. */
export type TaskReassigner = (taskId: string, assigneeId: string, reason: string) => Task;

const MODEL_TIERS: readonly string[] = ["frontier", "standard", "economy"];
const AGENT_TIERS: readonly string[] = ["executive", "manager", "worker"];
const COGNITIONS: readonly string[] = ["brain", "reflex"];

const OPEN = new Set<Task["status"]>(["todo", "in_progress", "waiting", "blocked"]);
const STATUS_THROTTLE_MS = 250;

export class OrgService implements OrgView, AgentStateWriter {
  private readonly deps: OrgDeps;
  private runControl: RunControl | null = null;
  private reassignTask: TaskReassigner | null = null;
  private readonly lastStatusEmit = new Map<string, { at: number; key: string }>();

  constructor(deps: OrgDeps) {
    this.deps = deps;
  }

  /** Late-bound: RunService is created after OrgService. */
  attachRunControl(control: RunControl): void {
    this.runControl = control;
  }

  /** Late-bound: TaskService is created after OrgService; destroy routes re-assignment through it. */
  attachTaskReassigner(reassign: TaskReassigner): void {
    this.reassignTask = reassign;
  }

  // ───────────── queries (OrgView) ─────────────

  getAgent(id: string): Agent | null {
    return this.deps.repos.agents.get(id);
  }

  /** The agent or a 404 AppError. */
  requireAgent(id: string): Agent {
    const agent = this.getAgent(id);
    if (!agent) throw notFound("agent", id);
    return agent;
  }

  listAgents(filter: { status?: string; departmentId?: string } = {}): Agent[] {
    return this.deps.repos.agents.list(filter);
  }

  listActiveAgents(): Agent[] {
    return this.deps.repos.agents.list({ includeTerminated: false });
  }

  listDepartments(): Department[] {
    return this.deps.repos.departments.list();
  }

  department(departmentId: string): Department | null {
    return this.deps.repos.departments.get(departmentId);
  }

  departmentName(departmentId: string): string {
    return this.department(departmentId)?.name ?? "Unknown department";
  }

  directReports(agentId: string): Agent[] {
    return this.deps.repos.agents.directReports(agentId);
  }

  /** Managers from the direct manager up to the CEO (cycle-safe). */
  managerChain(agentId: string): Agent[] {
    const chain: Agent[] = [];
    const seen = new Set<string>([agentId]);
    let current = this.getAgent(agentId);
    while (current?.managerId && !seen.has(current.managerId)) {
      seen.add(current.managerId);
      const manager = this.getAgent(current.managerId);
      if (!manager) break;
      chain.push(manager);
      current = manager;
    }
    return chain;
  }

  /** The root of the org (reports to the Board). */
  ceo(): Agent | null {
    return this.deps.repos.agents.byRole("ceo") ?? this.listActiveAgents().find((a) => a.managerId === null) ?? null;
  }

  /** True when `agentId` is in `managerId`'s reporting subtree (the CEO reaches everyone). */
  isInSubtree(managerId: string, agentId: string): boolean {
    if (managerId === agentId) return false;
    const manager = this.getAgent(managerId);
    if (!manager) return false;
    if (manager.managerId === null) return true;
    return this.managerChain(agentId).some((m) => m.id === managerId);
  }

  needs(agentId: string): NeedsState {
    const agent = this.requireAgent(agentId);
    return computeNeeds({
      agent,
      manager: agent.managerId ? this.getAgent(agent.managerId) : null,
      reports: this.directReports(agentId),
      reportsEver: this.deps.repos.agents.reportCount(agentId),
      remainingUsd: this.budgetRemainingUsd(agentId),
      limitUsd: this.deps.budget.limitFor(agentId),
      recentRuns: this.deps.repos.runs.list({ agentId, limit: 10 }),
    });
  }

  budgetRemainingUsd(agentId: string): number {
    return this.deps.budget.remainingFor(agentId);
  }

  stats(agentId: string): AgentStats {
    const { repos, budget, now } = this.deps;
    const at = now();
    const month = repos.spend.totals(monthStart(at), { agentId });
    const runs = repos.runs.list({ agentId, limit: 2000 });
    const tasks = repos.tasks.list({ assigneeId: agentId, limit: 5000 });
    return {
      spentTodayUsd: budget.agentSpent(agentId, dayStart(at)),
      spentMonthUsd: month.costUsd,
      runsTotal: runs.length,
      runsFailed: runs.filter((r) => r.status === "failed").length,
      tasksDone: tasks.filter((t) => t.status === "done").length,
      tasksOpen: tasks.filter((t) => OPEN.has(t.status)).length,
      inputTokens: month.inputTokens,
      outputTokens: month.outputTokens,
      lastActiveAt: runs[0]?.completedAt ?? runs[0]?.startedAt ?? null,
    };
  }

  // ───────────── lifecycle ─────────────

  /**
   * Creates an agent from a role template and/or explicit fields. Validates the
   * department, the manager (must be active) and headcount; casts persona.baZi.
   */
  createAgent(input: CreateAgentInput, createdBy: string, options: { ignoreHeadcount?: boolean } = {}): Agent {
    const role = this.resolveRole(input.roleId);
    this.validateModelFields(input);
    if (input.tier !== undefined && !AGENT_TIERS.includes(input.tier)) throw badRequest(`unknown tier: ${String(input.tier)}`);
    if (input.cognition !== undefined && !COGNITIONS.includes(input.cognition)) throw badRequest(`unknown cognition: ${String(input.cognition)}`);
    if (!options.ignoreHeadcount && this.deps.repos.agents.countActive() >= this.deps.company.settings().maxHeadcount) {
      throw conflict(`headcount limit (${this.deps.company.settings().maxHeadcount}) reached; raise maxHeadcount first`);
    }
    const departmentId = this.resolveDepartment(input.departmentId, role);
    const managerId = this.resolveManager(input.managerId, role, departmentId);
    this.validateTools(input.tools);
    const name = pickName(input.name, role, this.deps.repos.agents.names());
    const agent = buildAgent({ role, input, departmentId, managerId, name, createdBy }, this.deps.now(), this.deps.castBaZi);
    this.deps.repos.agents.insert(agent);
    this.deps.workspaces.ensure(agent.id);
    this.deps.bus.emit("agent.created", { agentId: agent.id, summary: summaries.agentCreated(agent), data: agent });
    return agent;
  }

  /** Applies an UpdateAgentInput (validated); a manager change may not create a cycle. */
  updateAgent(id: string, input: UpdateAgentInput): Agent {
    const agent = this.requireAgent(id);
    if (agent.status === "terminated") throw conflict("a terminated agent cannot be edited");
    this.validateModelFields(input);
    const patch: Partial<Agent> = { updatedAt: this.deps.now().toISOString() };
    if (input.name !== undefined) patch.name = nonEmpty(input.name, "name");
    if (input.title !== undefined) patch.title = nonEmpty(input.title, "title");
    if (input.departmentId !== undefined) patch.departmentId = this.resolveDepartment(input.departmentId, null);
    if (input.managerId !== undefined) patch.managerId = this.validateManagerChange(agent, input.managerId);
    if (input.modelTier !== undefined) patch.modelTier = input.modelTier;
    if (input.modelOverride !== undefined) patch.modelOverride = input.modelOverride;
    if (input.monthlyBudgetUsd !== undefined) patch.monthlyBudgetUsd = input.monthlyBudgetUsd;
    if (input.tools !== undefined) patch.tools = this.validateTools(input.tools) ?? agent.tools;
    if (input.persona !== undefined) patch.persona = { ...agent.persona, ...input.persona };
    if (input.identity !== undefined) patch.identity = { ...agent.identity, ...input.identity };
    this.deps.repos.agents.update(id, patch);
    return this.emitUpdated(id);
  }

  /** Pauses the agent (aborting its active run; the task returns to todo). */
  pauseAgent(id: string): Agent {
    const agent = this.requireAgent(id);
    if (agent.status === "terminated") throw conflict("a terminated agent cannot be paused");
    this.deps.repos.agents.update(id, { status: "paused", activity: "Paused by the Board", brainBlock: null, updatedAt: this.deps.now().toISOString() });
    this.runControl?.abortAgent(id, "pause");
    return this.emitStatus(id, true);
  }

  resumeAgent(id: string): Agent {
    const agent = this.requireAgent(id);
    if (agent.status === "terminated") throw conflict("a terminated agent cannot be resumed");
    if (agent.status !== "paused") return agent;
    this.deps.repos.agents.update(id, { status: "idle", activity: null, updatedAt: this.deps.now().toISOString() });
    return this.emitStatus(id, true);
  }

  /**
   * Destroy = terminate (docs/ARCHITECTURE.md → Lifecycle): abort the active run, re-assign
   * open tasks (through TaskService: attempt refunded, run-scoped state cleaned) and direct
   * reports to the manager, mark terminated (rows kept for audit) and archive the workspace.
   * With no active manager to inherit (the CEO reports to the Board) it is refused with 409
   * while it still has direct reports or open tasks — never orphan work.
   */
  destroyAgent(id: string): DestroyAgentResult {
    const agent = this.requireAgent(id);
    if (agent.status === "terminated") throw conflict(`${agent.name} is already terminated`);
    const reports = this.directReports(id);
    const heir = agent.managerId ? this.getAgent(agent.managerId) : null;
    const inheritor = heir && heir.status !== "terminated" ? heir : null;
    if (!inheritor && reports.length > 0) {
      throw conflict(`${agent.name} reports to the Board and still has ${reports.length} direct reports; re-assign them first`);
    }
    const open = this.deps.repos.tasks.openForAssignee(id);
    if (!inheritor && open.length > 0) {
      throw conflict(
        `${agent.name} has ${open.length} open task(s) (${open
          .slice(0, 5)
          .map((t) => `T-${t.number}`)
          .join(", ")}${open.length > 5 ? ", …" : ""}) and no manager to inherit them; cancel or re-assign them first`,
      );
    }
    this.deps.repos.agents.update(id, { status: "terminated", activity: null, brainBlock: null });
    const cancelledRuns = this.runControl?.abortAgent(id, "destroy") ?? 0;
    const { reassignedTasks, reassignedReports } = this.deps.repos.tx(() => this.reassignAll(agent, inheritor, reports));
    const terminated = this.terminateRow(agent);
    this.deps.workspaces.archive(id);
    this.deps.bus.emit("agent.terminated", { agentId: id, summary: summaries.agentTerminated(terminated), data: terminated });
    return { agentId: id, cancelledRuns, reassignedTasks, reassignedReports };
  }

  // ───────────── AgentStateWriter ─────────────

  /** Updates status/activity/brain block (ignored while paused/terminated); agent.status is throttled. */
  setActivity(agentId: string, status: Agent["status"], activity: string | null, block?: BrainBlockId | null): void {
    const agent = this.getAgent(agentId);
    if (!agent || ((agent.status === "paused" || agent.status === "terminated") && status !== agent.status)) return;
    const patch: Partial<Agent> = { status, activity, updatedAt: this.deps.now().toISOString() };
    if (block !== undefined) patch.brainBlock = block;
    this.deps.repos.agents.update(agentId, patch);
    this.emitStatus(agentId, false);
  }

  updateCognitiveState(agentId: string, patch: CognitiveStatePatch): Agent {
    const agent = this.requireAgent(agentId);
    const identity = { ...agent.identity };
    if (patch.narrative !== undefined) identity.narrative = patch.narrative;
    if (patch.okrs !== undefined) identity.okrs = patch.okrs;
    if (patch.assets !== undefined) identity.assets = [...patch.assets];
    if (patch.resourceConnections !== undefined) identity.resourceConnections = [...patch.resourceConnections];
    this.deps.repos.agents.update(agentId, {
      identity,
      affect: patch.affect ?? agent.affect,
      calibration: patch.calibration ?? agent.calibration,
      updatedAt: this.deps.now().toISOString(),
    });
    return this.emitUpdated(agentId);
  }

  // ───────────── helpers ─────────────

  private reassignAll(agent: Agent, inheritor: Agent | null, reports: Agent[]): { reassignedTasks: number; reassignedReports: number } {
    const { repos, now } = this.deps;
    const at = now().toISOString();
    const tasks = repos.tasks.openForAssignee(agent.id);
    if (tasks.length > 0) {
      if (!inheritor) throw conflict(`${agent.name} has open tasks and no manager to inherit them`);
      if (!this.reassignTask) throw new Error("OrgService: no task re-assigner attached");
      for (const task of tasks) this.reassignTask(task.id, inheritor.id, `re-assigned from ${agent.name} (terminated)`);
    }
    for (const report of reports) {
      repos.agents.update(report.id, { managerId: inheritor?.id ?? null, updatedAt: at });
      this.emitUpdated(report.id);
    }
    for (const department of repos.departments.list().filter((d) => d.headAgentId === agent.id)) {
      repos.departments.update(department.id, { headAgentId: inheritor?.id ?? null });
    }
    return { reassignedTasks: tasks.length, reassignedReports: reports.length };
  }

  private terminateRow(agent: Agent): Agent {
    const at = this.deps.now().toISOString();
    this.deps.repos.agents.update(agent.id, { status: "terminated", activity: null, brainBlock: null, currentRunId: null, currentTaskId: null, terminatedAt: at, updatedAt: at });
    return this.requireAgent(agent.id);
  }

  private resolveRole(roleId: string | undefined): RoleTemplate | null {
    if (roleId === undefined) return null;
    const role = roleTemplate(roleId);
    if (!role) throw badRequest(`unknown roleId: ${roleId}`);
    return role;
  }

  private resolveDepartment(departmentId: string | undefined, role: RoleTemplate | null): string {
    if (departmentId) {
      const department = this.department(departmentId) ?? this.deps.repos.departments.bySlug(departmentId);
      if (!department) throw badRequest(`unknown departmentId: ${departmentId}`);
      return department.id;
    }
    const bySlug = role ? this.deps.repos.departments.bySlug(role.departmentSlug) : null;
    if (bySlug) return bySlug.id;
    const fallback = this.ceo()?.departmentId ?? this.listDepartments()[0]?.id;
    if (!fallback) throw badRequest("departmentId is required");
    return fallback;
  }

  private resolveManager(managerId: string | null | undefined, role: RoleTemplate | null, departmentId: string): string | null {
    if (managerId === null) {
      if (this.ceo()) throw badRequest("only the CEO reports to the Board; give a managerId");
      return null;
    }
    if (managerId) return this.requireActiveManager(managerId).id;
    for (let r = role; r?.reportsToRoleId; r = roleTemplate(r.reportsToRoleId) ?? null) {
      const holder = this.deps.repos.agents.byRole(r.reportsToRoleId);
      if (holder) return holder.id;
    }
    const head = this.department(departmentId)?.headAgentId;
    if (head && this.getAgent(head)?.status !== "terminated") return head;
    return this.ceo()?.id ?? null;
  }

  private requireActiveManager(managerId: string): Agent {
    const manager = this.getAgent(managerId);
    if (!manager) throw badRequest(`unknown managerId: ${managerId}`);
    if (manager.status === "terminated") throw badRequest(`manager ${manager.name} is terminated`);
    return manager;
  }

  private validateManagerChange(agent: Agent, managerId: string | null): string | null {
    if (managerId === null) {
      if (agent.managerId !== null) throw badRequest("only the CEO reports to the Board");
      return null;
    }
    const manager = this.requireActiveManager(managerId);
    if (manager.id === agent.id || this.managerChain(manager.id).some((m) => m.id === agent.id)) throw badRequest("that manager change would create a reporting cycle");
    return manager.id;
  }

  /** modelTier, modelOverride and monthlyBudgetUsd of a create/update input (400 on anything unknown or not a budget). */
  private validateModelFields(input: { modelTier?: unknown; modelOverride?: unknown; monthlyBudgetUsd?: unknown }): void {
    if (input.modelTier !== undefined && (typeof input.modelTier !== "string" || !MODEL_TIERS.includes(input.modelTier))) {
      throw badRequest(`unknown modelTier: ${String(input.modelTier)} (expected ${MODEL_TIERS.join(", ")})`);
    }
    if (input.modelOverride !== undefined && input.modelOverride !== null) {
      if (typeof input.modelOverride !== "string" || !input.modelOverride.trim()) throw badRequest("modelOverride must be a model profile id or null");
      const known = this.deps.knownProfiles?.();
      if (known && !known.includes(input.modelOverride)) throw badRequest(`unknown modelOverride profile: ${input.modelOverride} (known: ${known.join(", ") || "none"})`);
    }
    if (input.monthlyBudgetUsd !== undefined) {
      const budget = input.monthlyBudgetUsd;
      if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) throw badRequest("monthlyBudgetUsd must be a finite number ≥ 0 (0 = no per-agent cap)");
    }
  }

  private validateTools(tools: string[] | undefined): string[] | undefined {
    if (tools === undefined) return undefined;
    const known = new Set(this.deps.knownTools());
    const unknown = tools.filter((t) => !known.has(t));
    if (unknown.length) throw badRequest(`unknown tools: ${unknown.join(", ")}`);
    return [...new Set(tools)];
  }

  private emitUpdated(id: string): Agent {
    const agent = this.requireAgent(id);
    this.deps.bus.emit("agent.updated", { agentId: id, summary: summaries.agentUpdated(agent), data: agent });
    return agent;
  }

  private emitStatus(id: string, force: boolean): Agent {
    const agent = this.requireAgent(id);
    const key = `${agent.status}|${agent.activity ?? ""}|${agent.brainBlock ?? ""}`;
    const last = this.lastStatusEmit.get(id);
    const nowMs = this.deps.now().getTime();
    const statusChanged = !last || !last.key.startsWith(agent.status + "|");
    if (force || statusChanged || (last.key !== key && nowMs - last.at >= STATUS_THROTTLE_MS)) {
      this.lastStatusEmit.set(id, { at: nowMs, key });
      this.deps.bus.emit("agent.status", { agentId: id, summary: summaries.agentStatus(agent), data: { ...agent, block: agent.brainBlock } });
    }
    return agent;
  }
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  return value.trim();
}
