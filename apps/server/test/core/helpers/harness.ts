/**
 * Core-test harness: boots the real platform (SQLite in a temp dir, real org bootstrap,
 * real tools / tasks / scheduler / runs) with scripted fake engines and a fake model
 * router, so every test is deterministic and offline.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, CognitionKind, ModelProfile, ModelsInfo, Task } from "../../../../../packages/shared/src/index.ts";
import { createApp, type App, type AppOverrides } from "../../../src/app.ts";
import { loadConfig, type AppConfig } from "../../../src/config.ts";
import type { CognitiveEngine, EngineContext, EngineResult, ModelRouter } from "../../../src/contracts.ts";

export type EngineScript = (ctx: EngineContext) => Promise<EngineResult> | EngineResult;

export const done = (output = "done"): EngineResult => ({ outcome: "completed", output });

export class ScriptedEngine implements CognitiveEngine {
  readonly kind: CognitionKind;
  script: EngineScript;
  readonly calls: EngineContext[] = [];
  constructor(kind: CognitionKind, script: EngineScript = (ctx) => done(defaultReply(ctx))) {
    this.kind = kind;
    this.script = script;
  }
  async run(ctx: EngineContext): Promise<EngineResult> {
    this.calls.push(ctx);
    return await this.script(ctx);
  }
}

function defaultReply(ctx: EngineContext): string {
  return ctx.input.trigger === "message" ? `Reply from ${ctx.agent.name}: ${ctx.input.message.content}` : `Result from ${ctx.agent.name}: ${ctx.input.task.title}`;
}

export function fakeProfile(contextWindow: number | null): ModelProfile {
  return { id: "fake", provider: "mock", model: "fake", tier: "economy", inputPerMTokUsd: 0, outputPerMTokUsd: 0, cachedInputPerMTokUsd: null, contextWindow, supportsTools: true };
}

export function fakeRouter(contextWindow: number | null = 128_000): ModelRouter {
  return {
    resolve: () => fakeProfile(contextWindow),
    chat: () => Promise.reject(new Error("the fake router does not serve model calls")),
    tierForStage: () => "economy",
    isLive: () => false,
  };
}

export const FAKE_MODELS_INFO: ModelsInfo = {
  live: false,
  tiers: { frontier: { primary: "fake", fallback: null }, standard: { primary: "fake", fallback: null }, economy: { primary: "fake", fallback: null } },
  profiles: [fakeProfile(128_000)],
  stageRouting: {},
};

export interface TestApp {
  app: App;
  config: AppConfig;
  dataDir: string;
  brain: ScriptedEngine;
  reflex: ScriptedEngine;
  /** Base URL when `listen: true`. */
  url: string;
  agentByRole(roleId: string): Agent;
  /** Scheduler passes + waiting for runs until nothing more can start. */
  drain(maxRounds?: number): Promise<void>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  env?: Record<string, string>;
  config?: Partial<AppConfig>;
  overrides?: AppOverrides;
  /** Reuse a data dir (restart / crash-recovery tests). */
  dataDir?: string;
  listen?: boolean;
  contextWindow?: number | null;
  brain?: EngineScript;
  reflex?: EngineScript;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "agentco-core-"));
  const env: NodeJS.ProcessEnv = {
    PORT: "0",
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    ORG_TEMPLATE: "startup",
    DAILY_BUDGET_USD: "50",
    MONTHLY_BUDGET_USD: "500",
    HEARTBEAT_MINUTES: "0",
    ...options.env,
  };
  const config: AppConfig = { ...loadConfig(env), ...options.config };
  const brain = new ScriptedEngine("brain", options.brain);
  const reflex = new ScriptedEngine("reflex", options.reflex);
  const app = await createApp(config, {
    engines: { brain, reflex },
    createRouter: () => fakeRouter(options.contextWindow === undefined ? 128_000 : options.contextWindow),
    modelsInfo: () => FAKE_MODELS_INFO,
    env,
    autoStart: false,
    ...options.overrides,
  });
  const url = options.listen ? await app.listen() : "";
  const { platform } = app;
  const harness: TestApp = {
    app,
    config,
    dataDir,
    brain,
    reflex,
    url,
    agentByRole(roleId) {
      const agent = platform.repos.agents.byRole(roleId);
      if (!agent) throw new Error(`no agent with role ${roleId}`);
      return agent;
    },
    async drain(maxRounds = 200) {
      for (let round = 0; round < maxRounds; round++) {
        const started = platform.scheduler.tick();
        await platform.runs.idle();
        if (started === 0 && platform.runs.activeCount() === 0) {
          // settle a macrotask: terminal listeners / hooks may have queued follow-up work
          await new Promise((resolve) => setImmediate(resolve));
          if (platform.scheduler.tick() === 0) return;
        }
      }
      throw new Error("drain: still scheduling work after " + maxRounds + " rounds");
    },
    async close() {
      await app.close();
      if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return harness;
}

export function waitFor<T>(label: string, probe: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const value = probe();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** A promise you resolve by hand: lets a scripted engine hold a run open. */
export function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

export async function api<T>(base: string, path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: T }> {
  const response = await fetch(base + path, {
    method: init?.method ?? "GET",
    headers: { ...(init?.body === undefined ? {} : { "content-type": "application/json" }), ...init?.headers },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Creates a root task for `assigneeId` through the service layer. */
export function rootTask(t: TestApp, assigneeId: string, title = "Do the thing", extra: { value?: number; estCostUsd?: number } = {}): Task {
  return t.app.platform.tasks.createRoot({ title, description: `Description of ${title}`, assigneeId, ...extra });
}

/** The ToolCallContext an engine would build for `ctx`'s run. */
export function toolCtx(ctx: EngineContext, taskId: string | null = ctx.input.trigger === "message" ? null : ctx.input.task.id) {
  return { agent: ctx.agent, runId: ctx.run.id, traceId: ctx.run.traceId, parentSpanId: ctx.span.spanId, taskId, conversationId: ctx.run.conversationId, signal: ctx.signal };
}

/** Calls a platform tool the way an engine's tool loop does. */
export function callTool(ctx: EngineContext, name: string, args: Record<string, unknown>) {
  return ctx.platform.tools.execute({ id: `call_${name}`, name, arguments: args }, toolCtx(ctx));
}
