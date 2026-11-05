/**
 * Bounded tool loop shared by ReflexEngine and the brain's Solving block.
 * Terminal tools (complete_task, report_blocker) are handled here and traced
 * as `tool` spans; everything else goes through platform.tools.execute.
 */
import type { Agent, BrainBlockId, ModelTier } from "../../../../packages/shared/src/index.ts";
import type { ChatMessage, ChatResponse, EngineContext, SpanHandle, ToolCall, ToolEffect, ToolSpec } from "../contracts.ts";
import { truncate } from "./text.ts";

export const COMPLETE_TASK: ToolSpec = {
  name: "complete_task",
  description: "Finish the task. `result` is the full deliverable (or a summary plus where the full document was saved).",
  parameters: { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
};

export const REPORT_BLOCKER: ToolSpec = {
  name: "report_blocker",
  description: "Stop because the task cannot be done as specified. `reason` says what is missing.",
  parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
};

const TOOL_RESULT_CHARS = 3000;

export interface ToolLoopOptions {
  ctx: EngineContext;
  stage: string;
  tier: ModelTier;
  parentSpan: SpanHandle;
  system: string;
  user: string;
  tools: ToolSpec[];
  terminal: { complete: boolean; blocker: boolean };
  maxSteps: number;
  taskId: string | null;
  conversationId: string | null;
  activityLabel: string;
  block?: BrainBlockId | null;
  maxOutputTokens?: number;
  /** Called after every model response with its measured latency (OOD profiling). */
  onResponse?: (response: ChatResponse, latencyMs: number) => void;
}

export interface ToolLoopResult {
  status: "completed" | "blocked" | "exhausted";
  result: string;
  reason: string;
  steps: number;
  toolCalls: number;
  effects: ToolEffect[];
  costUsd: number;
}

export function abortErrorFrom(signal: AbortSignal): Error {
  const r = signal.reason;
  if (r instanceof Error) return r;
  return Object.assign(new Error(typeof r === "string" ? r : "aborted"), { name: "AbortError" });
}

export function describeToolCall(call: ToolCall, ctx: Pick<EngineContext, "platform">): string {
  const a = call.arguments;
  const s = (k: string) => truncate(typeof a[k] === "string" ? (a[k] as string) : "", 70);
  const who = (k: string) => {
    const id = typeof a[k] === "string" ? (a[k] as string) : "";
    return ctx.platform.org.getAgent(id)?.name ?? (id || "someone");
  };
  switch (call.name) {
    case "workspace_write_file":
      return `Writing ${s("path") || "a file"}`;
    case "workspace_read_file":
      return `Reading ${s("path") || "a file"}`;
    case "workspace_list":
      return `Listing ${s("dir") || "the workspace"}`;
    case "delegate_task":
      return `Delegating "${s("title")}" to ${who("assigneeId")}`;
    case "send_message":
      return `Messaging ${who("toAgentId")}`;
    case "escalate":
      return `Escalating: ${s("reason") || s("question")}`;
    case "ask_human":
      return `Asking the Board: ${s("question")}`;
    case "memory_search":
      return `Searching memory for "${s("query")}"`;
    case "memory_write":
      return "Saving a memory";
    case "blackboard_read":
      return "Reading the blackboard";
    case "blackboard_write":
      return `Updating blackboard "${s("key")}"`;
    case "hire_agent":
      return `Requesting a hire: ${s("title")}`;
    case "web_fetch":
      return `Fetching ${s("url")}`;
    case "complete_task":
      return "Delivering the result";
    case "report_blocker":
      return `Reporting a blocker: ${s("reason")}`;
    default:
      return `Using ${call.name}`;
  }
}

function terminalSpan(parent: SpanHandle, call: ToolCall, output: string, ok: boolean): void {
  const span = parent.child({
    kind: "tool",
    name: `tool.${call.name}`,
    input: JSON.stringify(call.arguments),
    attributes: { "gen_ai.tool.name": call.name, "gen_ai.tool.call.id": call.id, "agentco.terminal": true },
  });
  span.end(ok ? { status: "ok", output } : { status: "error", error: output });
}

export async function runToolLoop(o: ToolLoopOptions): Promise<ToolLoopResult> {
  const { ctx } = o;
  const agent: Agent = ctx.agent;
  const specs: ToolSpec[] = [...o.tools];
  if (o.terminal.complete) specs.push(COMPLETE_TASK);
  if (o.terminal.blocker) specs.push(REPORT_BLOCKER);
  const allowed = new Set(o.tools.map((t) => t.name));
  const messages: ChatMessage[] = [
    { role: "system", content: o.system },
    { role: "user", content: o.user },
  ];
  const out: ToolLoopResult = { status: "exhausted", result: "", reason: "", steps: 0, toolCalls: 0, effects: [], costUsd: 0 };

  for (let step = 1; step <= o.maxSteps; step++) {
    if (ctx.signal.aborted) throw abortErrorFrom(ctx.signal);
    out.steps = step;
    ctx.platform.agents.setActivity(agent.id, "thinking", `${o.activityLabel} (step ${step})`, o.block ?? null);
    const started = Date.now();
    const response = await ctx.platform.models.chat(
      {
        tier: o.tier,
        modelOverride: agent.modelOverride,
        messages,
        tools: specs.length > 0 ? specs : undefined,
        maxOutputTokens: o.maxOutputTokens ?? 2000,
      },
      { agentId: agent.id, runId: ctx.run.id, traceId: ctx.run.traceId, parentSpanId: o.parentSpan.spanId, taskId: o.taskId, stage: o.stage, signal: ctx.signal },
    );
    out.costUsd += response.costUsd;
    o.onResponse?.(response, Date.now() - started);

    if (response.toolCalls.length === 0) {
      const text = response.content.trim();
      if (text) {
        out.status = "completed";
        out.result = text;
        return out;
      }
      messages.push({ role: "assistant", content: "" });
      messages.push({ role: "user", content: o.terminal.complete ? "Call complete_task with your result." : "Reply with your answer." });
      continue;
    }

    messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });
    for (const call of response.toolCalls) {
      out.toolCalls++;
      if (o.terminal.complete && call.name === "complete_task") {
        const result = typeof call.arguments.result === "string" ? call.arguments.result.trim() : "";
        if (result) {
          terminalSpan(o.parentSpan, call, truncate(result, 2000), true);
          out.status = "completed";
          out.result = result;
          return out;
        }
        terminalSpan(o.parentSpan, call, "complete_task needs a non-empty result", false);
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: "Error: `result` must be the non-empty deliverable." });
        continue;
      }
      if (o.terminal.blocker && call.name === "report_blocker") {
        const reason = typeof call.arguments.reason === "string" && call.arguments.reason.trim() ? call.arguments.reason.trim() : "unspecified blocker";
        terminalSpan(o.parentSpan, call, reason, true);
        out.status = "blocked";
        out.reason = reason;
        return out;
      }
      if (!allowed.has(call.name)) {
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: `Error: tool ${call.name} is not available to you.` });
        continue;
      }
      if (ctx.signal.aborted) throw abortErrorFrom(ctx.signal);
      ctx.platform.agents.setActivity(agent.id, "acting", describeToolCall(call, ctx), o.block ?? null);
      const result = await ctx.platform.tools.execute(call, {
        agent,
        runId: ctx.run.id,
        traceId: ctx.run.traceId,
        parentSpanId: o.parentSpan.spanId,
        taskId: o.taskId,
        conversationId: o.conversationId,
        signal: ctx.signal,
      });
      out.effects.push(...result.effects);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: truncate(`${result.ok ? "" : "Error: "}${result.content}`, TOOL_RESULT_CHARS),
      });
    }
  }
  return out;
}
