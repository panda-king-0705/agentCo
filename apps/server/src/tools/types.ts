/** Tool definition shape for the built-in registry. */
import type { AgentTier } from "../../../../packages/shared/src/index.ts";
import type { SpanHandle, ToolCallContext, ToolEffect, ToolResult } from "../contracts.ts";
import type { AppConfig } from "../config.ts";
import type { MemoryServiceImpl } from "../memory/service.ts";
import type { TracerImpl } from "../middleware/tracer.ts";
import type { CompanyService } from "../org/company.ts";
import type { OrgService } from "../org/service.ts";
import type { ConversationService } from "../runs/conversations.ts";
import type { ApprovalService } from "../tasks/approvals.ts";
import type { TaskService } from "../tasks/service.ts";
import type { Workspaces } from "./workspace.ts";
import type { Catalog } from "../catalog/service.ts";

export interface ToolServices {
  config: AppConfig;
  org: OrgService;
  tasks: TaskService;
  approvals: ApprovalService;
  conversations: ConversationService;
  memory: MemoryServiceImpl;
  workspaces: Workspaces;
  company: CompanyService;
  tracer: TracerImpl;
  /** The specialist catalog (catalog_search, hire_agent with catalogId); optional for test wiring. */
  catalog?: Catalog;
}

export interface ToolRunContext extends ToolCallContext {
  /** The `tool` span of this call (delegate_task hangs its `delegation` span here). */
  span: SpanHandle;
  services: ToolServices;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (object) for the arguments. */
  parameters: Record<string, unknown>;
  /** Tiers allowed to call the tool. */
  tiers: readonly AgentTier[];
  /** Feature flag (e.g. web_fetch); default enabled. */
  enabled?: (config: AppConfig) => boolean;
  /** Every agent has it, whatever its stored tool list (e.g. the company directory). */
  universal?: boolean;
  run(args: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> | ToolResult;
}

export const ALL_TIERS: readonly AgentTier[] = ["executive", "manager", "worker"];
export const LEADS: readonly AgentTier[] = ["executive", "manager"];
export const EXECUTIVES: readonly AgentTier[] = ["executive"];

export function ok(content: string, effects: ToolEffect[] = [], data?: unknown): ToolResult {
  return { ok: true, content, effects, ...(data === undefined ? {} : { data }) };
}

export function fail(content: string): ToolResult {
  return { ok: false, content, effects: [] };
}

/** Tool-level failure that the executor converts into ok:false (never thrown to engines). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
