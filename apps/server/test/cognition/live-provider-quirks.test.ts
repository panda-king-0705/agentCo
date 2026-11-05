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
