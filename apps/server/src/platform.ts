/**
 * Platform assembly: wires every core service over one SQLite connection and
 * returns them together with the PlatformServices the engines see.
 *
 *   createPlatform(config, overrides) is the only place concrete classes meet;
 *   tests inject fake engines / a fake model router through `overrides`.
 */
import type { Agent, CognitionKind, CompanySnapshot, ModelsInfo } from "../../../packages/shared/src/index.ts";
import type { AppConfig } from "./config.ts";
import type { CognitiveEngine, ModelProvider, ModelRouter, ModelRouterDeps, PlatformServices, SavedFiles } from "./contracts.ts";
import { openDatabase, type Db } from "./db/index.ts";
import { createRepositories, type Repositories } from "./db/index.ts";
import { EventBus } from "./events/bus.ts";
import { ContextGovernor } from "./memory/compaction.ts";
import { MemoryServiceImpl } from "./memory/service.ts";
import { MetricsService } from "./metrics/service.ts";
import { TraceService } from "./metrics/traces.ts";
import { BudgetService, dayStart, monthStart } from "./middleware/budget.ts";
import { createRedactor } from "./middleware/redact.ts";
import { TracerImpl } from "./middleware/tracer.ts";
import { loadModelConfig, modelsInfo as buildModelsInfo } from "./models/config.ts";
import { createModelRouter } from "./models/router.ts";
import { computeBaZi } from "./cognition/brain/self-management/bazi.ts";
import { Catalog, createCatalog } from "./catalog/service.ts";
import { bootstrapCompany, type BootstrapResult } from "./org/bootstrap.ts";
import { CompanyService } from "./org/company.ts";
import { OrgService } from "./org/service.ts";
import { ConversationService } from "./runs/conversations.ts";
import { RunService } from "./runs/service.ts";
import { ApprovalService } from "./tasks/approvals.ts";
import { Scheduler } from "./tasks/scheduler.ts";
import { TaskService } from "./tasks/service.ts";
import { ToolExecutorImpl } from "./tools/registry.ts";
import { Workspaces } from "./tools/workspace.ts";
import { join } from "node:path";
import { buildHandbook, type HandbookSource } from "./org/handbook.ts";

export interface PlatformOverrides {
  /** Defaults to createEngines() from ./cognition/index.ts. */
  engines?: Record<CognitionKind, CognitiveEngine>;
  /** Defaults to the real ModelRouter over loadModelConfig(env). */
  createRouter?: (deps: ModelRouterDeps) => ModelRouter;
  /** Provider adapters for the default router (tests). */
  providers?: Record<string, ModelProvider>;
  modelsInfo?: () => ModelsInfo;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** ":memory:" in tests; default <dataDir>/agentco.db. */
  dbPath?: string;
  /** Skip the first-boot org bootstrap (tests that build their own org). */
  bootstrap?: boolean;
  /** The specialist catalog; default: loaded (once per process) from config.catalogDir. */
  catalog?: Catalog;
}

export interface Platform {
  config: AppConfig;
  db: Db;
  repos: Repositories;
  bus: EventBus;
  tracer: TracerImpl;
  company: CompanyService;
  budget: BudgetService;
  org: OrgService;
  conversations: ConversationService;
  memory: MemoryServiceImpl;
  tasks: TaskService;
  approvals: ApprovalService;
  tools: ToolExecutorImpl;
  models: ModelRouter;
  metrics: MetricsService;
  traces: TraceService;
  runs: RunService;
  scheduler: Scheduler;
  workspaces: Workspaces;
  /** The agency-agents specialist catalog (docs/CATALOG.md). */
  catalog: Catalog;
  services: PlatformServices;
  bootstrapResult: BootstrapResult | null;
  modelsInfo(): ModelsInfo;
  snapshot(): CompanySnapshot;
  /** Kill switch: pause the company and abort every running run. */
  pauseCompany(): void;
  resumeCompany(): void;
  /** Crash recovery, scheduler, heartbeat. */
  start(): void;
  /** Stops timers, aborts runs (they are recovered on the next boot) and closes the database. */
  stop(): Promise<void>;
}

export async function createPlatform(config: AppConfig, overrides: PlatformOverrides = {}): Promise<Platform> {
  const now = overrides.now ?? (() => new Date());
  const env = overrides.env ?? process.env;
  const db = openDatabase(overrides.dbPath ?? join(config.dataDir, "agentco.db"));
  const repos = createRepositories(db);
  const redactor = createRedactor(config.secretLiterals);
  const bus = new EventBus(repos.events, now);
  const tracer = new TracerImpl({ spans: repos.spans, bus, redactor, now });
  const company = new CompanyService(repos, bus, config);
  company.init();
  const budget = new BudgetService({ repos, bus, settings: () => company.settings(), now });
  const workspaces = new Workspaces(config.dataDir);

  const tools = new ToolExecutorImpl(config, { onCall: (runId) => repos.runs.incrementToolCalls(runId) });
  const catalog = overrides.catalog ?? createCatalog({ dir: config.catalogDir, playbookTokens: config.catalogPlaybookTokens });
  const org = new OrgService({
    repos, bus, company, budget, workspaces, now, castBaZi: computeBaZi, catalog,
    managerModelTier: config.managerModelTier,
    knownTools: () => tools.names(),
    // late-bound: modelsInfo is built below
    knownProfiles: () => modelsInfo().profiles.map((p) => p.id),
  });
  const conversations = new ConversationService(repos, bus, redactor, now);
  const memory = new MemoryServiceImpl(repos, bus, redactor, now);
  const tasks = new TaskService({ repos, bus, tracer, org, conversations, now, redactor });
  org.attachTaskReassigner((taskId, assigneeId, reason) => tasks.reassign(taskId, assigneeId, reason));
  const approvals = new ApprovalService({ repos, bus, org, tasks, company, now, redactor });
  // The company handbook (org/handbook.ts): generated from live data, for agents (tool, welcome) and the console.
  const handbookSource: HandbookSource = {
    settings: () => company.settings(),
    org,
    openObjectives: (limit) =>
      repos.tasks
        .list({ archived: "exclude", limit: 1000 })
        .filter((t) => !t.parentTaskId && !["done", "failed", "cancelled"].includes(t.status))
        .sort((a, b) => b.priority - a.priority || b.number - a.number)
        .slice(0, limit),
    keyKnowledge: (limit) =>
      repos.memories
        .recent({ agentId: null, scopes: ["global"], kinds: ["semantic", "procedural"] }, limit * 4)
        .sort((a, b) => b.importance - a.importance || b.accessCount - a.accessCount)
        .slice(0, limit),
    blackboardKeys: () => repos.blackboard.list().map((b) => b.key),
    agentMonthlyLeftUsd: (agentId) => org.agentMonthlyLeftUsd(agentId),
    now,
  };
  const handbook = (agent: Agent | null) => buildHandbook(handbookSource, agent);
  tools.bind({ config, org, tasks, approvals, conversations, memory, workspaces, company, tracer, catalog, handbook, traceFiles: (traceId) => repos.spans.filesWritten(traceId) });

  const modelConfig = overrides.createRouter && overrides.modelsInfo ? null : loadModelConfig(env);
  const routerDeps: ModelRouterDeps = { config: modelConfig, tracer, budget, getAgent: (id) => org.getAgent(id) };
  const models = overrides.createRouter
    ? overrides.createRouter(routerDeps)
    : createModelRouter({ ...routerDeps, config: modelConfig as NonNullable<typeof modelConfig>, ...(overrides.providers ? { providers: overrides.providers } : {}) });
  const modelsInfo = overrides.modelsInfo ?? (() => buildModelsInfo(modelConfig ?? loadModelConfig(env)));

  const metrics = new MetricsService(repos, now);
  const drive: SavedFiles = {
    written: (traceId) => repos.spans.filesWritten(traceId),
    recent: (limit) => workspaces.recentShared(limit),
    read: (agentId, display) => {
      try {
        if (!workspaces.exists(agentId, display)) return null;
        const r = workspaces.read(agentId, display);
        return { content: r.content, truncated: r.truncated };
      } catch {
        return null;
      }
    },
  };
  const services: PlatformServices = { models, metrics, tools, memory, tracer, org, tasks, agents: org, catalog, handbook, drive, now };
  const engines = overrides.engines ?? (await loadEngines(config));
  const governor = new ContextGovernor(repos.settings, { dataDir: config.dataDir, triggerPct: config.contextTriggerPct, carryTurns: config.contextCarryTurns }, now);
  const runs = new RunService({
    repos, bus, tracer, org, tasks, conversations, approvals, governor, redactor, engines,
    platform: () => services,
    runTimeoutMs: config.runTimeoutMs,
    isPaused: () => company.settings().paused,
    maxConcurrentRuns: () => company.settings().maxConcurrentRuns,
    now,
  });
  org.attachRunControl(runs);
  const scheduler = new Scheduler({ repos, bus, org, company, conversations, runs, tickMs: config.schedulerTickMs });
  runs.setSettledHook(() => scheduler.nudge());

  const bootstrapResult = overrides.bootstrap === false ? null : bootstrapCompany(repos, org, company.settings().orgTemplate, now, catalog);
  // Agents created before the catalog existed get their role's specialist (docs/CATALOG.md).
  if (bootstrapResult && !bootstrapResult.created) org.backfillCatalog();
  // An explicit MANAGER_MODEL_TIER also re-tiers managers created before it was set (like company env overrides).
  if (config.explicitKeys.has("MANAGER_MODEL_TIER")) org.applyManagerModelTier(config.managerModelTier);

  // Onboarding: every agent hired from now on finds the handbook in its inbox, from its manager, on day one.
  bus.subscribe((ev) => {
    if (ev.type !== "agent.created" || !ev.agentId) return;
    try {
      const hire = org.getAgent(ev.agentId);
      if (!hire || hire.status === "terminated") return;
      const from = (hire.managerId ? org.getAgent(hire.managerId) : null) ?? org.listActiveAgents().find((a) => !a.managerId && a.id !== hire.id) ?? null;
      if (!from) return;
      conversations.sendAgentMessage(from, hire, `Welcome to ${company.settings().name}, ${hire.name}! Here is how we work — re-read it any time with company_handbook.\n\n${handbook(hire)}`);
    } catch (error) {
      console.error("[onboarding] welcome message failed:", error instanceof Error ? error.message : error);
    }
  });

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lastBeat = now().getTime();

  const platform: Platform = {
    config, db, repos, bus, tracer, company, budget, org, conversations, memory, tasks, approvals, tools, models, metrics,
    traces: new TraceService(repos), runs, scheduler, workspaces, catalog, services, bootstrapResult, modelsInfo,
    snapshot() {
      const at = now();
      const agents = repos.agents.list({ includeTerminated: false });
      return {
        settings: company.settings(),
        headcount: agents.length,
        activeAgents: agents.filter((a) => a.status === "thinking" || a.status === "acting").length,
        openTasks: openCount(repos.tasks.countByStatus()),
        pendingApprovals: repos.approvals.countPending(),
        spentTodayUsd: repos.spend.totals(dayStart(at)).costUsd,
        spentMonthUsd: repos.spend.totals(monthStart(at)).costUsd,
        models: modelsInfo(),
      };
    },
    pauseCompany() {
      company.setPaused(true);
      runs.abortAll("company_pause");
    },
    resumeCompany() {
      company.setPaused(false);
      scheduler.nudge();
    },
    start() {
      runs.recoverOnBoot();
      scheduler.start();
      heartbeat = setInterval(() => {
        const minutes = company.settings().heartbeatMinutes;
        if (minutes <= 0 || now().getTime() - lastBeat < minutes * 60_000) return;
        lastBeat = now().getTime();
        try {
          runHeartbeat(platform);
        } catch (error) {
          console.error("[heartbeat] failed:", error instanceof Error ? error.message : error);
        }
      }, 15_000);
      heartbeat.unref();
    },
    async stop() {
      if (heartbeat) clearInterval(heartbeat);
      scheduler.stop();
      await runs.shutdown();
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
  return platform;
}

/** Open tasks: todo + in_progress + waiting + blocked. */
function openCount(counts: Record<string, number>): number {
  return (counts.todo ?? 0) + (counts.in_progress ?? 0) + (counts.waiting ?? 0) + (counts.blocked ?? 0);
}

/** Executives with nothing open review their OKRs: one low-value objective each (trigger "heartbeat"). */
export function runHeartbeat(platform: Platform): number {
  const { company, org, repos, tasks } = platform;
  if (company.settings().paused) return 0;
  let created = 0;
  for (const agent of org.listActiveAgents()) {
    if (agent.tier !== "executive" || agent.status === "paused") continue;
    if (repos.tasks.openForAssignee(agent.id).length > 0) continue;
    const task = tasks.createRoot(
      {
        title: `Heartbeat: ${agent.title} reviews OKRs and open work`,
        description: "Periodic review. Check your OKRs, open delegations and the blackboard; act only if something needs attention, otherwise report that all is well.",
        assigneeId: agent.id,
        value: 5,
        estCostUsd: 0.05,
      },
      "system",
    );
    tasks.patchState(task.id, { nextTrigger: "heartbeat" });
    created += 1;
  }
  return created;
}

/** Loads the real engines lazily so the platform (and its tests) work before cognition ships its index. */
async function loadEngines(config: AppConfig): Promise<Record<CognitionKind, CognitiveEngine>> {
  const specifier = "./cognition/index.ts";
  const mod = (await import(specifier)) as { createEngines: (options?: { reflexMaxSteps?: number; brainMaxRevisions?: number }) => Record<CognitionKind, CognitiveEngine> };
  return mod.createEngines({ reflexMaxSteps: config.reflexMaxSteps, brainMaxRevisions: config.brainMaxRevisions });
}
