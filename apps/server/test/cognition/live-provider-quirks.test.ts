/**
 * Regressions from the first live run (2026-11-06): Claude 5.5 on Anthropic's
 * OpenAI-compatible endpoint rejects `temperature`, and GPT-6 Luna spends its
 * output budget reasoning before it answers. The fake server reproduces the
 * providers' exact error bodies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleProvider, LENGTH_RETRY_MIN_TOKENS } from "../../src/models/providers/openai.ts";
import { classifyFailure } from "../../src/models/check.ts";
import type { ModelProfile } from "../../../../packages/shared/src/index.ts";
import type { ChatRequest } from "../../src/contracts.ts";

type Reply = { status: number; json: unknown };

async function withServer(respond: (body: Record<string, unknown>, n: number) => Reply, fn: (base: string, bodies: Record<string, unknown>[]) => Promise<void>) {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw) as Record<string, unknown>;
    bodies.push(body);
    const r = respond(body, bodies.length);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.json));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

const ok = (content: string, finish = "stop"): Reply => ({ status: 200, json: { choices: [{ finish_reason: finish, message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 2 } } });
const profile = (provider: string): ModelProfile => ({ id: `${provider}:m`, provider, model: "m", tier: "economy", inputPerMTokUsd: 1, outputPerMTokUsd: 1, cachedInputPerMTokUsd: null, contextWindow: null, supportsTools: true });
const request: ChatRequest = { tier: "economy", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 64, temperature: 0.3 };
const TEMP_400: Reply = { status: 400, json: { error: { code: "invalid_request_error", message: "`temperature` is deprecated for this model.", type: "invalid_request_error", param: null } } };
const LIMIT_400: Reply = { status: 400, json: { error: { message: "Could not finish the message because max_tokens or model output limit was reached. Please try again with higher max_tokens.", type: "invalid_request_error", param: null, code: null } } };

test("anthropic: temperature is never sent", async () => {
  await withServer(() => ok("OK"), async (base, bodies) => {
    const p = new OpenAICompatibleProvider({ providers: { anthropic: { name: "anthropic", baseUrl: base, apiKey: "k" } } } as never);
    const r = await p.complete(profile("anthropic"), request, new AbortController().signal);
    assert.equal(r.content, "OK");
    assert.equal(bodies[0]?.temperature, undefined);
    assert.equal(bodies[0]?.max_tokens, 64);
  });
});

test("any provider: a 400 rejecting temperature is retried once without it, then remembered", async () => {
  await withServer((body) => ("temperature" in body ? TEMP_400 : ok("OK")), async (base, bodies) => {
    const p = new OpenAICompatibleProvider({ providers: { other: { name: "other", baseUrl: base, apiKey: "k" } } } as never);
    const r1 = await p.complete(profile("other"), request, new AbortController().signal);
    assert.equal(r1.content, "OK");
    assert.equal(bodies.length, 2);
    await p.complete(profile("other"), request, new AbortController().signal);
    assert.equal(bodies.length, 3, "second call skips temperature up front");
    assert.equal(bodies[2]?.temperature, undefined);
  });
});

test("reasoning models: an output-limit 400 is retried with a larger budget", async () => {
  await withServer((_b, n) => (n === 1 ? LIMIT_400 : ok("OK")), async (base, bodies) => {
    const p = new OpenAICompatibleProvider({ providers: { openai: { name: "openai", baseUrl: base, apiKey: "k" } } } as never);
    const r = await p.complete(profile("openai"), request, new AbortController().signal);
    assert.equal(r.content, "OK");
    assert.equal(bodies[0]?.max_completion_tokens, 64);
    assert.equal(bodies[1]?.max_completion_tokens, LENGTH_RETRY_MIN_TOKENS);
  });
});

test("reasoning models: an empty answer cut off by length is retried with a larger budget", async () => {
  await withServer((_b, n) => (n === 1 ? ok("", "length") : ok("OK")), async (base, bodies) => {
    const p = new OpenAICompatibleProvider({ providers: { openai: { name: "openai", baseUrl: base, apiKey: "k" } } } as never);
    const r = await p.complete(profile("openai"), request, new AbortController().signal);
    assert.equal(r.content, "OK");
    assert.equal(bodies.length, 2);
  });
});

test("retries are bounded: a provider that always fails surfaces the error", async () => {
  await withServer(() => LIMIT_400, async (base, bodies) => {
    const p = new OpenAICompatibleProvider({ providers: { openai: { name: "openai", baseUrl: base, apiKey: "k" } } } as never);
    await assert.rejects(p.complete(profile("openai"), request, new AbortController().signal), /HTTP 400/);
    assert.equal(bodies.length, 3);
  });
});

test("check:models no longer labels any 400 mentioning 'model' as a missing model", () => {
  assert.equal(classifyFailure("anthropic m: HTTP 400 Bad Request — `temperature` is deprecated for this model."), "other");
  assert.equal(classifyFailure("openai m: HTTP 400 — The model `gpt-x` does not exist"), "model");
  assert.equal(classifyFailure("openai m: HTTP 404 Not Found"), "model");
});

const FORMAT_400: Reply = { status: 400, json: { error: { code: "invalid_request_error", message: "response_format.type: Input should be 'json_schema'", type: "invalid_request_error", param: null } } };

test("anthropic: JSON requests carry no response_format (its compat endpoint only takes json_schema)", async () => {
  await withServer(() => ok('{"a":1}'), async (base, bodies) => {
    const p = new OpenAICompatibleProvider({ providers: { anthropic: { name: "anthropic", baseUrl: base, apiKey: "k" } } } as never);
    const r = await p.complete(profile("anthropic"), { ...request, responseFormat: "json" }, new AbortController().signal);
    assert.equal(r.content, '{"a":1}');
    assert.equal(bodies.length, 1);
    assert.equal("response_format" in bodies[0]!, false);
  });
});

test("any provider: a 400 rejecting response_format is retried without it and remembered", async () => {
  await withServer((body) => ("response_format" in body ? FORMAT_400 : ok('{"a":1}')), async (base, bodies) => {
    const p = new OpenAICompatibleProvider({ providers: { custom: { name: "custom", baseUrl: base, apiKey: "k" } } } as never);
    const json = { ...request, responseFormat: "json" as const };
    const r = await p.complete(profile("custom"), json, new AbortController().signal);
    assert.equal(r.content, '{"a":1}');
    assert.equal(bodies.length, 2, "one rejected call, one retry");
    await p.complete(profile("custom"), json, new AbortController().signal);
    assert.equal(bodies.length, 3, "remembered: no second rejection");
    assert.equal("response_format" in bodies[2]!, false);
  });
});

// Live (2026-11-07, test 5): with Anthropic out of credit, the standard tier fell back to gpt-6.1-sol,
// which refuses function tools on /v1/chat/completions unless reasoning is turned off — every tool step failed.
const TOOLS_REASONING_400: Reply = {
  status: 400,
  json: { error: { message: "Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", type: "invalid_request_error", param: "reasoning_effort", code: null } },
};

test("openai: tools refused while reasoning is on → retried with reasoning_effort 'none', remembered; plain requests unchanged", async () => {
  const tools = [{ name: "workspace_write_file", description: "save", parameters: { type: "object", properties: {} } }];
  await withServer((body) => (body.tools && body.reasoning_effort !== "none" ? TOOLS_REASONING_400 : ok("OK")), async (base, bodies) => {
    const p = new OpenAICompatibleProvider({ providers: { openai: { name: "openai", baseUrl: base, apiKey: "k" } } } as never);
    const r1 = await p.complete(profile("openai"), { ...request, tools }, new AbortController().signal);
    assert.equal(r1.content, "OK");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1]?.reasoning_effort, "none");
    await p.complete(profile("openai"), { ...request, tools }, new AbortController().signal);
    assert.equal(bodies.length, 3, "the next tool call sends reasoning_effort 'none' up front");
    assert.equal(bodies[2]?.reasoning_effort, "none");
    await p.complete(profile("openai"), request, new AbortController().signal);
    assert.equal(bodies[3]?.reasoning_effort, undefined, "requests without tools keep the model's own reasoning");
  });
});

// Live (2026-11-08, trc_92d7…): gpt-6.1-sol and gpt-6-astra now refuse "none" as well ("Supported values
// are: 'low', 'medium', 'high', and 'xhigh'"), so on /v1/chat/completions they cannot take tools at all.
// Their tool calls go through /v1/responses (checked live: a function_call came back).
const NONE_400: Reply = {
  status: 400,
  json: { error: { message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_value" } },
};

test("openai: a model that refuses tools with reasoning AND refuses 'none' takes its tool calls through the Responses API (remembered)", async () => {
  const tools = [{ name: "workspace_write_file", description: "save", parameters: { type: "object", properties: { path: { type: "string" } } } }];
  const responsesReply: Reply = {
    status: 200,
    json: {
      status: "completed",
      output: [
        { type: "reasoning", summary: [] },
        { type: "function_call", call_id: "call_abc", name: "workspace_write_file", arguments: '{"path":"a.md"}' },
      ],
      usage: { input_tokens: 44, output_tokens: 14, input_tokens_details: { cached_tokens: 4 } },
    },
  };
  await withServer(
    (body) => ("input" in body ? responsesReply : body.tools ? (body.reasoning_effort === "none" ? NONE_400 : TOOLS_REASONING_400) : ok("plain")),
    async (base, bodies) => {
      const p = new OpenAICompatibleProvider({ providers: { openai: { name: "openai", baseUrl: base, apiKey: "k" } } } as never);
      const history = [
        { role: "system" as const, content: "You are Kenji." },
        { role: "user" as const, content: "Save it." },
        { role: "assistant" as const, content: "", toolCalls: [{ id: "call_1", name: "workspace_list", arguments: { dir: "" } }] },
        { role: "tool" as const, toolCallId: "call_1", name: "workspace_list", content: "docs/" },
      ];
      const r = await p.complete(profile("openai"), { ...request, messages: history, tools }, new AbortController().signal);
      assert.deepEqual(r.toolCalls, [{ id: "call_abc", name: "workspace_write_file", arguments: { path: "a.md" } }]);
      assert.equal(r.finishReason, "tool_calls");
      assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.cachedInputTokens], [44, 14, 4]);
      assert.equal(bodies.length, 3, "chat completions, then 'none', then the Responses API");
      const sent = bodies[2]!;
      assert.deepEqual(sent.reasoning, { effort: "low" });
      assert.equal(sent.max_output_tokens, 64);
      assert.deepEqual(sent.tools, [{ type: "function", name: "workspace_write_file", description: "save", parameters: { type: "object", properties: { path: { type: "string" } } } }]);
      assert.deepEqual(sent.input, [
        { role: "system", content: "You are Kenji." },
        { role: "user", content: "Save it." },
        { type: "function_call", call_id: "call_1", name: "workspace_list", arguments: '{"dir":""}' },
        { type: "function_call_output", call_id: "call_1", output: "docs/" },
      ]);
      await p.complete(profile("openai"), { ...request, tools }, new AbortController().signal);
      assert.equal(bodies.length, 4, "the next tool call goes straight to the Responses API");
      assert.ok("input" in bodies[3]!);
      const plain = await p.complete(profile("openai"), request, new AbortController().signal);
      assert.equal(plain.content, "plain", "requests without tools stay on chat completions");
    },
  );
});

test("openai: a Responses API reply with text, or cut off by the output limit", async () => {
  const { parseResponsesBody } = await import("../../src/models/providers/openai.ts");
  const text = parseResponsesBody({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }], usage: { input_tokens: 5, output_tokens: 2 } });
  assert.deepEqual([text.content, text.finishReason, text.toolCalls.length], ["Done.", "stop", 0]);
  const cut = parseResponsesBody({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
  assert.equal(cut.finishReason, "length");
});
