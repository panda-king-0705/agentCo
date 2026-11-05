/**
 * One adapter for every provider: OpenAI-compatible chat completions
 * (OpenAI, BytePlus ModelArk, OpenRouter, DeepSeek, Anthropic's compat layer,
 * Gemini's OpenAI endpoint, or any `<NAME>_BASE_URL`).
 *
 * Notes from docs/research/03-model-tiers.md:
 * - tool_choice is always "auto": Anthropic's compat layer rejects forced tool
 *   use on Opus/Sonnet/Fable with a 400, and has no prompt caching.
 * - response_format json_object is omitted when tools are present.
 * - OpenAI's current models take `max_completion_tokens` and reject a custom
 *   temperature; other providers get `max_tokens` + temperature.
 */
import type { ModelProfile, Usage } from "../../../../../packages/shared/src/index.ts";
import type { ChatMessage, ChatRequest, ChatResponse, ModelProvider, ToolCall } from "../../contracts.ts";
import type { ProviderConfig } from "../config.ts";
import { parseToolArguments } from "../json.ts";

type FetchFn = typeof fetch;

interface ProviderQuirks {
  maxTokensField: "max_tokens" | "max_completion_tokens";
  sendTemperature: boolean;
}

const QUIRKS: Record<string, ProviderQuirks> = {
  openai: { maxTokensField: "max_completion_tokens", sendTemperature: false },
  // Claude 5.x on Anthropic's OpenAI-compatible endpoint rejects `temperature` ("deprecated for this model").
  anthropic: { maxTokensField: "max_tokens", sendTemperature: false },
};

/** Floor for the output budget after a reasoning model ran out of tokens before answering. */
export const LENGTH_RETRY_MIN_TOKENS = 2048;

/** A 400 caused by sampling parameters the model no longer accepts. */
export function isTemperatureRejection(status: number, body: string): boolean {
  return status === 400 && /temperature|top_p/i.test(body);
}

/** The model hit its output limit before producing anything usable (reasoning models spend tokens thinking first). */
export function isOutputLimitRejection(status: number, body: string): boolean {
  return status === 400 && /max_tokens|max_completion_tokens|output limit/i.test(body);
}
const DEFAULT_QUIRKS: ProviderQuirks = { maxTokensField: "max_tokens", sendTemperature: true };

export function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content ? m.content : null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        })),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    return { role: m.role, content: m.content };
  });
}

export function buildRequestBody(profile: ModelProfile, request: ChatRequest): Record<string, unknown> {
  const quirks = QUIRKS[profile.provider] ?? DEFAULT_QUIRKS;
  const body: Record<string, unknown> = { model: profile.model, messages: toOpenAIMessages(request.messages) };
  const tools = request.tools ?? [];
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = "auto";
  } else if (request.responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }
  if (request.maxOutputTokens) body[quirks.maxTokensField] = request.maxOutputTokens;
  if (request.temperature !== undefined && quirks.sendTemperature) body.temperature = request.temperature;
  return body;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

export function parseResponseBody(data: unknown): {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: ChatResponse["finishReason"];
} {
  const root = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (choice.message ?? {}) as Record<string, unknown>;
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: ToolCall[] = [];
  rawCalls.forEach((raw, i) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const fn = (c.function ?? {}) as Record<string, unknown>;
    if (typeof fn.name !== "string" || !fn.name) return;
    toolCalls.push({ id: typeof c.id === "string" && c.id ? c.id : `call_${i}`, name: fn.name, arguments: parseToolArguments(fn.arguments) });
  });
  const u = (root.usage ?? {}) as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const usage: Usage = {
    inputTokens: int(u.prompt_tokens),
    outputTokens: int(u.completion_tokens),
    // OpenAI-style details, or DeepSeek's prompt_cache_hit_tokens.
    cachedInputTokens: int(details.cached_tokens) || int(u.prompt_cache_hit_tokens),
  };
  const fr = choice.finish_reason;
  const finishReason: ChatResponse["finishReason"] =
    toolCalls.length > 0 || fr === "tool_calls" || fr === "function_call" ? "tool_calls" : fr === "length" ? "length" : "stop";
  return { content: contentText(message.content), toolCalls, usage, finishReason };
}

export interface OpenAICompatibleOptions {
  providers: Record<string, ProviderConfig>;
  fetch?: FetchFn;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = "openai-compatible";
  private readonly providers: Record<string, ProviderConfig>;
  private readonly fetchFn: FetchFn;

  constructor(options: OpenAICompatibleOptions) {
    this.providers = options.providers;
    this.fetchFn = options.fetch ?? fetch;
  }

  /** Profiles learned at runtime to reject `temperature`; never sent to them again. */
  private readonly noTemperature = new Set<string>();

  /**
   * One chat completion with two self-healing retries for live-provider quirks:
   * a 400 rejecting `temperature` is retried once without it (and remembered), and a
   * response cut off by the output limit before any content is retried once with a
   * larger budget (reasoning models spend tokens thinking before they answer).
   */
  async complete(profile: ModelProfile, request: ChatRequest, signal: AbortSignal) {
    let req = this.noTemperature.has(profile.id) ? { ...request, temperature: undefined } : request;
    for (let attempt = 0; ; attempt++) {
      const result = await this.send(profile, req, signal);
      if (result.kind === "ok") {
        const r = result.value;
        const empty = !r.content.trim() && r.toolCalls.length === 0;
        if (r.finishReason === "length" && empty && attempt < 2) {
          req = { ...req, maxOutputTokens: Math.max((req.maxOutputTokens ?? 512) * 4, LENGTH_RETRY_MIN_TOKENS) };
          continue;
        }
        return r;
      }
      if (attempt < 2 && req.temperature !== undefined && isTemperatureRejection(result.status, result.body)) {
        this.noTemperature.add(profile.id);
        req = { ...req, temperature: undefined };
        continue;
      }
      if (attempt < 2 && isOutputLimitRejection(result.status, result.body)) {
        req = { ...req, maxOutputTokens: Math.max((req.maxOutputTokens ?? 512) * 4, LENGTH_RETRY_MIN_TOKENS) };
        continue;
      }
      throw result.error;
    }
  }

  private async send(
    profile: ModelProfile,
    request: ChatRequest,
    signal: AbortSignal,
  ): Promise<
    | { kind: "ok"; value: ReturnType<typeof parseResponseBody> }
    | { kind: "http"; status: number; body: string; error: Error }
  > {
    const provider = this.providers[profile.provider];
    if (!provider) throw new Error(`provider "${profile.provider}" is not configured`);
    if (!provider.apiKey) throw new Error(`provider "${profile.provider}" has no API key`);
    const url = `${provider.baseUrl}/chat/completions`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(buildRequestBody(profile, request)),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new Error(`${profile.provider} request to ${url} failed: ${redactKey((err as Error).message, provider.apiKey)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      const snippet = redactKey(text.replace(/\s+/g, " ").slice(0, 400), provider.apiKey);
      const error = new Error(`${profile.provider} ${profile.model}: HTTP ${response.status} ${response.statusText}${snippet ? ` — ${snippet}` : ""}`);
      return { kind: "http", status: response.status, body: text, error };
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${profile.provider} ${profile.model}: HTTP ${response.status} but the body is not JSON`);
    }
    return { kind: "ok", value: parseResponseBody(data) };
  }
}

function redactKey(text: string, key: string): string {
  return key ? text.split(key).join("[redacted]") : text;
}
