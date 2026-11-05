/**
 * Environment → AppConfig. Zero dependencies; every value has a default and
 * every invalid value produces one clear error line naming the variable.
 *
 * Model configuration (MODEL_*, provider keys, prices, stage routing) is parsed
 * separately by `models/config.ts` (cognition) from the same environment.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export type OrgTemplateId = "startup" | "enterprise";

export interface AppConfig {
  port: number;
  host: string;
  authToken: string;
  /** True when HOST is not a loopback address: bearer auth is enforced. */
  authRequired: boolean;
  dataDir: string;
  companyName: string;
  orgTemplate: OrgTemplateId;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  maxConcurrentRuns: number;
  maxHeadcount: number;
  hiringRequiresApproval: boolean;
  heartbeatMinutes: number;
  runTimeoutMs: number;
  reflexMaxSteps: number;
  brainMaxRevisions: number;
  contextTriggerPct: number;
  contextCarryTurns: number;
  webFetchEnabled: boolean;
  schedulerTickMs: number;
  /** Directory with the built console; defaults to apps/web/dist. */
  webDistDir: string;
  /** Secret literals (API keys, auth token) the redactor always masks. */
  secretLiterals: string[];
  /** Env keys that were explicitly set; those override persisted company settings at boot. */
  explicitKeys: ReadonlySet<string>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

/** Reads `.env` (if present) into process.env without overriding variables already set. */
export function loadDotEnv(path = resolve(process.cwd(), ".env"), env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
}

/** Parses and validates the environment. Throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];
  const reader = createReader(env, errors);
  const host = reader.str("HOST", "127.0.0.1");
  const authToken = reader.str("APP_AUTH_TOKEN", "");
  const authRequired = !LOOPBACK.has(host);
  if (authRequired && authToken.length < 24) {
    errors.push(`APP_AUTH_TOKEN must be at least 24 characters when HOST (${host}) is not loopback`);
  }
  const config: AppConfig = {
    port: reader.int("PORT", 3000, 0, 65535),
    host,
    authToken,
    authRequired,
    dataDir: resolve(reader.str("DATA_DIR", "./data")),
    companyName: reader.str("COMPANY_NAME", "AgentCo"),
    orgTemplate: reader.oneOf("ORG_TEMPLATE", ["startup", "enterprise"] as const, "startup"),
    dailyBudgetUsd: reader.num("DAILY_BUDGET_USD", 5, 0),
    monthlyBudgetUsd: reader.num("MONTHLY_BUDGET_USD", 100, 0),
    maxConcurrentRuns: reader.int("MAX_CONCURRENT_RUNS", 4, 1, 64),
    maxHeadcount: reader.int("MAX_HEADCOUNT", 60, 1, 10_000),
    hiringRequiresApproval: reader.bool("HIRING_REQUIRES_APPROVAL", true),
    heartbeatMinutes: reader.num("HEARTBEAT_MINUTES", 0, 0),
    runTimeoutMs: reader.int("RUN_TIMEOUT_MS", 300_000, 1_000, 86_400_000),
    reflexMaxSteps: reader.int("REFLEX_MAX_STEPS", 8, 1, 100),
    brainMaxRevisions: reader.int("BRAIN_MAX_REVISIONS", 2, 0, 20),
    contextTriggerPct: reader.num("CONTEXT_TRIGGER_PCT", 0.7, 0.1, 0.95),
    contextCarryTurns: reader.int("CONTEXT_CARRY_TURNS", 6, 1, 200),
    webFetchEnabled: reader.bool("WEB_FETCH_ENABLED", false),
    schedulerTickMs: reader.int("SCHEDULER_TICK_MS", 750, 10, 60_000),
    webDistDir: resolve(reader.str("WEB_DIST_DIR", defaultWebDist())),
    secretLiterals: collectSecrets(env),
    explicitKeys: new Set(Object.keys(env).filter((k) => (env[k] ?? "").trim() !== "")),
  };
  if (errors.length > 0) throw new ConfigError("Invalid configuration:\n  - " + errors.join("\n  - "));
  return config;
}

function defaultWebDist(): string {
  return new URL("../../web/dist", import.meta.url).pathname;
}

/** Every *_API_KEY / *_TOKEN value is a literal the redactor must mask. */
function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => /(_API_KEY|_TOKEN|_SECRET)$/.test(key) && typeof value === "string" && value.trim().length >= 8)
    .map(([, value]) => (value as string).trim());
}

interface EnvReader {
  str(key: string, fallback: string): string;
  num(key: string, fallback: number, min?: number, max?: number): number;
  int(key: string, fallback: number, min: number, max: number): number;
  bool(key: string, fallback: boolean): boolean;
  oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T;
}

function createReader(env: NodeJS.ProcessEnv, errors: string[]): EnvReader {
  const raw = (key: string): string | undefined => {
    const value = env[key]?.trim();
    return value ? value : undefined;
  };
  const num = (key: string, fallback: number, min = -Infinity, max = Infinity): number => {
    const value = raw(key);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      errors.push(`${key}=${value} must be a number in [${min}, ${max}]`);
      return fallback;
    }
    return parsed;
  };
  return {
    str: (key, fallback) => raw(key) ?? fallback,
    num,
    int(key, fallback, min, max) {
      const value = num(key, fallback, min, max);
      if (!Number.isInteger(value)) {
        errors.push(`${key} must be an integer`);
        return fallback;
      }
      return value;
    },
    bool(key, fallback) {
      const value = raw(key)?.toLowerCase();
      if (value === undefined) return fallback;
      if (["true", "1", "yes", "on"].includes(value)) return true;
      if (["false", "0", "no", "off"].includes(value)) return false;
      errors.push(`${key}=${value} must be true or false`);
      return fallback;
    },
    oneOf(key, allowed, fallback) {
      const value = raw(key);
      if (value === undefined) return fallback;
      if ((allowed as readonly string[]).includes(value)) return value as (typeof allowed)[number];
      errors.push(`${key}=${value} must be one of ${allowed.join(", ")}`);
      return fallback;
    },
  };
}
