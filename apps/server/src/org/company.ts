/**
 * Company settings (kill switch, budgets, limits). Persisted in `settings`;
 * initialised from config on first boot. Env variables that are explicitly
 * set override the persisted value at every boot (env wins); everything else
 * is changed through PATCH /api/company.
 */
import type { CompanySettings } from "../../../../packages/shared/src/index.ts";
import type { AppConfig } from "../config.ts";
import type { Repositories } from "../db/index.ts";
import type { EventBus } from "../events/bus.ts";
import { badRequest } from "../http/errors.ts";

const KEY = "company";

const ENV_OVERRIDES: [keyof CompanySettings, string][] = [
  ["name", "COMPANY_NAME"],
  ["dailyBudgetUsd", "DAILY_BUDGET_USD"],
  ["monthlyBudgetUsd", "MONTHLY_BUDGET_USD"],
  ["maxConcurrentRuns", "MAX_CONCURRENT_RUNS"],
  ["maxHeadcount", "MAX_HEADCOUNT"],
  ["hiringRequiresApproval", "HIRING_REQUIRES_APPROVAL"],
  ["heartbeatMinutes", "HEARTBEAT_MINUTES"],
];

export class CompanyService {
  private readonly repos: Repositories;
  private readonly bus: EventBus;
  private readonly config: AppConfig;
  private cache: CompanySettings | null = null;

  constructor(repos: Repositories, bus: EventBus, config: AppConfig) {
    this.repos = repos;
    this.bus = bus;
    this.config = config;
  }

  /** Loads (or creates) the settings row and applies explicit env overrides. */
  init(): CompanySettings {
    const fromConfig = this.defaults();
    const stored = this.repos.settings.get<CompanySettings | null>(KEY, null);
    const merged: CompanySettings = stored ? { ...fromConfig, ...stored } : fromConfig;
    if (stored) {
      for (const [field, env] of ENV_OVERRIDES) {
        if (this.config.explicitKeys.has(env)) (merged as unknown as Record<string, unknown>)[field] = fromConfig[field];
      }
    }
    this.save(merged);
    return merged;
  }

  /** Current settings (cached; always a copy). */
  settings(): CompanySettings {
    if (!this.cache) this.cache = this.repos.settings.get<CompanySettings>(KEY, this.defaults());
    return { ...this.cache };
  }

  /** Validates and applies a partial update; emits company.updated. */
  update(patch: Partial<CompanySettings>): CompanySettings {
    const next = { ...this.settings(), ...validatePatch(patch) };
    this.save(next);
    this.bus.emit("company.updated", { summary: `Company settings updated (${Object.keys(patch).join(", ")})`, data: next });
    return next;
  }

  setPaused(paused: boolean): CompanySettings {
    const next = { ...this.settings(), paused };
    this.save(next);
    this.bus.emit("company.updated", { summary: paused ? "Company paused by the Board (kill switch)" : "Company resumed by the Board", data: next });
    return next;
  }

  private save(settings: CompanySettings): void {
    this.repos.settings.set(KEY, settings);
    this.cache = { ...settings };
  }

  private defaults(): CompanySettings {
    const c = this.config;
    return {
      name: c.companyName,
      mission: "Deliver real outcomes for our customers with an honest, frugal, AI-run company.",
      paused: false,
      dailyBudgetUsd: c.dailyBudgetUsd,
      monthlyBudgetUsd: c.monthlyBudgetUsd,
      maxConcurrentRuns: c.maxConcurrentRuns,
      maxHeadcount: c.maxHeadcount,
      hiringRequiresApproval: c.hiringRequiresApproval,
      heartbeatMinutes: c.heartbeatMinutes,
      orgTemplate: c.orgTemplate,
    };
  }
}

const NUMERIC: Record<string, [number, number]> = {
  dailyBudgetUsd: [0, 1_000_000],
  monthlyBudgetUsd: [0, 10_000_000],
  maxConcurrentRuns: [1, 64],
  maxHeadcount: [1, 10_000],
  heartbeatMinutes: [0, 10_080],
};

/** Accepts only known fields with valid types/ranges; throws 400 otherwise. */
export function validatePatch(patch: unknown): Partial<CompanySettings> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw badRequest("body must be an object");
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key in NUMERIC) {
      const [min, max] = NUMERIC[key] as [number, number];
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw badRequest(`${key} must be a number in [${min}, ${max}]`);
      if ((key === "maxConcurrentRuns" || key === "maxHeadcount") && !Number.isInteger(value)) throw badRequest(`${key} must be an integer`);
      out[key] = value;
    } else if (key === "name" || key === "mission") {
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 2000) throw badRequest(`${key} must be a non-empty string`);
      out[key] = value.trim();
    } else if (key === "paused" || key === "hiringRequiresApproval") {
      if (typeof value !== "boolean") throw badRequest(`${key} must be a boolean`);
      out[key] = value;
    } else if (key === "orgTemplate") {
      throw badRequest("orgTemplate is fixed at bootstrap (set ORG_TEMPLATE before first boot)");
    } else {
      throw badRequest(`unknown setting: ${key}`);
    }
  }
  return out as Partial<CompanySettings>;
}
