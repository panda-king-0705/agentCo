/**
 * Tool registry + ToolExecutor implementation.
 *
 * specsFor(agent)  = registry ∩ agent.tools ∩ tier permission ∩ feature flags.
 * execute(call)    = one `tool` span; arguments validated against the tool's JSON
 *                    schema; every tool-level failure (unknown tool, forbidden,
 *                    bad arguments, thrown error) is returned as ok:false — it
 *                    never throws, so a misbehaving model cannot crash a run.
 */
import type { Agent } from "../../../../packages/shared/src/index.ts";
import type { ToolCall, ToolCallContext, ToolExecutor, ToolResult, ToolSpec } from "../contracts.ts";
import type { AppConfig } from "../config.ts";
import { AppError } from "../http/errors.ts";
import { isAbortError } from "../middleware/tracer.ts";
import { askHuman, escalate, sendMessage } from "./builtins/comms.ts";
import { delegateTask } from "./builtins/delegation.ts";
import { workspaceList, workspaceReadFile, workspaceWriteFile } from "./builtins/files.ts";
import { catalogSearch } from "./builtins/catalog.ts";
import { hireAgent } from "./builtins/hiring.ts";
import { blackboardRead, blackboardWrite, memorySearch, memoryWrite } from "./builtins/memory.ts";
import { webFetch } from "./builtins/web.ts";
import { validateArgs } from "./schema.ts";
import { fail, ToolError, type ToolDefinition, type ToolServices } from "./types.ts";
import { WorkspaceError } from "./workspace.ts";

export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  delegateTask,
  sendMessage,
  escalate,
  askHuman,
  memorySearch,
  memoryWrite,
  blackboardRead,
  blackboardWrite,
  workspaceWriteFile,
  workspaceReadFile,
  workspaceList,
  hireAgent,
  catalogSearch,
  webFetch,
];

const RESULT_PREVIEW = 1500;

export interface ToolExecutorOptions {
  tools?: readonly ToolDefinition[];
  /** Called once per executed call (RunService counts tool calls on the run). */
  onCall?: (runId: string) => void;
}

export class ToolExecutorImpl implements ToolExecutor {
  private readonly tools: Map<string, ToolDefinition>;
  private readonly config: AppConfig;
  private services: ToolServices | null = null;
  private readonly onCall: ((runId: string) => void) | undefined;

  constructor(config: AppConfig, options: ToolExecutorOptions = {}) {
    this.config = config;
    this.tools = new Map((options.tools ?? BUILTIN_TOOLS).map((t) => [t.name, t]));
    this.onCall = options.onCall;
  }

  /** Late-bound: the services need the tool names (OrgService.knownTools) before they exist. */
  bind(services: ToolServices): void {
    this.services = services;
  }

  /** Names of every registered tool (feature-flagged ones included, so agents can be configured ahead of the flag). */
  names(): string[] {
    return [...this.tools.keys()];
  }

  definition(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  specsFor(agent: Agent): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const tool of this.tools.values()) {
      if (this.permitted(tool, agent)) specs.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
    }
    return specs;
  }

  async execute(call: ToolCall, ctx: ToolCallContext): Promise<ToolResult> {
    const services = this.services;
    if (!services) return fail("tool executor is not initialised");
    const span = services.tracer.startSpan({
      traceId: ctx.traceId,
      parentSpanId: ctx.parentSpanId,
      kind: "tool",
      name: `tool.${call.name}`,
      agentId: ctx.agent.id,
      runId: ctx.runId,
      taskId: ctx.taskId,
      input: safeJson(call.arguments),
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": call.name, "gen_ai.tool.call.id": call.id },
    });
    this.onCall?.(ctx.runId);
    try {
      const tool = this.tools.get(call.name);
      if (!tool || (tool.enabled && !tool.enabled(this.config))) throw new ToolError(`unknown tool "${call.name}"`);
      if (!this.permitted(tool, ctx.agent)) throw new ToolError(`tool "${call.name}" is not available to ${ctx.agent.title}`);
      const invalid = validateArgs(tool.parameters, call.arguments);
      if (invalid) throw new ToolError(`invalid arguments: ${invalid}`);
      if (ctx.signal.aborted) throw new ToolError("run was aborted before the tool started");
      const result = await tool.run(call.arguments, { ...ctx, span, services });
      span.end({
        status: result.ok ? "ok" : "error",
        output: result.content.slice(0, RESULT_PREVIEW),
        ...(result.ok ? {} : { error: result.content.slice(0, 500) }),
        attributes: { "agentco.tool.effects": result.effects.length },
      });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      span.end(isAbortError(error) ? { status: "cancelled", error: message } : { status: "error", error: message });
      return fail(message);
    }
  }

  private permitted(tool: ToolDefinition, agent: Agent): boolean {
    if (!tool.tiers.includes(agent.tier)) return false;
    if (tool.enabled && !tool.enabled(this.config)) return false;
    return agent.tools.includes(tool.name);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ToolError || error instanceof WorkspaceError || error instanceof AppError) return error.message;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
