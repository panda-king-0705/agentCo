/**
 * Deterministic offline provider (the default). Reads the stage marker and the
 * context block (models/protocol.ts) and returns plausible stage JSON, tool
 * calls, or text. Usage = ceil(chars / 4) so cost dashboards are populated.
 */
import type { ModelProfile, Usage } from "../../../../../packages/shared/src/index.ts";
import type { ChatRequest, ChatResponse, ModelProvider, ToolCall } from "../../contracts.ts";
import { readContext, readStage } from "../protocol.ts";
import { asMockContext, mockStageJson, mockText, mockToolStep } from "./mock-stages.ts";

export interface MockProviderOptions {
  latencyMs?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return signal.aborted ? Promise.reject(abortError(signal)) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export class MockProvider implements ModelProvider {
  readonly name = "mock";
  private readonly latencyMs: number;

  constructor(options: MockProviderOptions = {}) {
    this.latencyMs = options.latencyMs ?? 400;
  }

  async complete(
    _profile: ModelProfile,
    request: ChatRequest,
    signal: AbortSignal,
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: Usage; finishReason: ChatResponse["finishReason"] }> {
    await sleep(this.latencyMs, signal);
    const stage = readStage(request.messages) ?? "unknown";
    const ctx = asMockContext(readContext(request.messages));
    let content = "";
    let toolCalls: ToolCall[] = [];
    if (request.tools && request.tools.length > 0) {
      ({ content, toolCalls } = mockToolStep(ctx, request));
    } else if (request.responseFormat === "json") {
      content = JSON.stringify(mockStageJson(stage, ctx));
    } else {
      content = mockText(stage, ctx);
    }
    const promptChars =
      request.messages.reduce((n, m) => n + m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0) +
      (request.tools ? JSON.stringify(request.tools).length : 0);
    const outputChars = content.length + (toolCalls.length ? JSON.stringify(toolCalls).length : 0);
    return {
      content,
      toolCalls,
      usage: { inputTokens: estimateTokens(promptChars), outputTokens: estimateTokens(outputChars), cachedInputTokens: 0 },
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  }
}
