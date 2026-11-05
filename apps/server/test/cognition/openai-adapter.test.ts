import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleProvider } from "../../src/models/providers/openai.ts";
import type { ModelProfile } from "../../../../packages/shared/src/index.ts";
import type { ChatRequest } from "../../src/contracts.ts";

interface Captured {
  url: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

async function withServer(
  respond: (body: Record<string, unknown>) => { status: number; json?: unknown; text?: string },
  fn: (baseUrl: string, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    captured.push({ url: req.url ?? "", auth: req.headers.authorization, body });
    const r = respond(body);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.text ?? JSON.stringify(r.json));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/v1`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function profile(provider: string): ModelProfile {
  return { id: `${provider}:m`, provider, model: "test-model", tier: "economy", inputPerMTokUsd: 1, outputPerMTokUsd: 1, cachedInputPerMTokUsd: null, contextWindow: null, supportsTools: true };
}

const toolRequest: ChatRequest = {
  tier: "economy",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "write it" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "workspace_write_file", arguments: { path: "shared/a.md", content: "x" } }] },
    { role: "tool", content: "Wrote shared/a.md", toolCallId: "call_1", name: "workspace_write_file" },
  ],
  tools: [{ name: "complete_task", description: "finish", parameters: { type: "object", properties: { result: { type: "string" } } } }],
  responseFormat: "json",
  maxOutputTokens: 256,
  temperature: 0.3,
};

test("openai adapter: request mapping and tool-call round trip", async () => {
  await withServer(
    () => ({
      status: 200,
      json: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_2", type: "function", function: { name: "complete_task", arguments: '{"result":"done"}' } },
                { id: "call_3", type: "function", function: { name: "complete_task", arguments: "{not json" } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 64 } },
      },
    }),
    async (baseUrl, captured) => {
      const provider = new OpenAICompatibleProvider({ providers: { deepseek: { name: "deepseek", baseUrl, apiKey: "sk-secret" } } });
      const out = await provider.complete(profile("deepseek"), toolRequest, new AbortController().signal);
      const c = captured[0]!;
      assert.equal(c.url, "/v1/chat/completions");
      assert.equal(c.auth, "Bearer sk-secret");
      assert.equal(c.body.model, "test-model");
      assert.equal(c.body.tool_choice, "auto");
      assert.equal(c.body.response_format, undefined, "no response_format when tools are present");
      assert.equal(c.body.max_tokens, 256);
      assert.equal(c.body.temperature, 0.3);
      const msgs = c.body.messages as Record<string, unknown>[];
      assert.deepEqual(msgs[2], {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "workspace_write_file", arguments: '{"path":"shared/a.md","content":"x"}' } }],
      });
      assert.deepEqual(msgs[3], { role: "tool", tool_call_id: "call_1", content: "Wrote shared/a.md" });
      assert.deepEqual((c.body.tools as unknown[])[0], { type: "function", function: toolRequest.tools![0] });

      assert.equal(out.finishReason, "tool_calls");
      assert.deepEqual(out.toolCalls[0], { id: "call_2", name: "complete_task", arguments: { result: "done" } });
      assert.deepEqual(out.toolCalls[1]!.arguments, { _raw: "{not json" }, "bad JSON arguments tolerated");
      assert.deepEqual(out.usage, { inputTokens: 120, outputTokens: 30, cachedInputTokens: 64 });
    },
  );
});

test("openai adapter: json mode without tools, OpenAI quirks", async () => {
  await withServer(
    () => ({ status: 200, json: { choices: [{ finish_reason: "stop", message: { content: '{"a":1}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } } }),
    async (baseUrl, captured) => {
      const provider = new OpenAICompatibleProvider({ providers: { openai: { name: "openai", baseUrl, apiKey: "k" } } });
      const out = await provider.complete(profile("openai"), { tier: "economy", messages: [{ role: "user", content: "x" }], responseFormat: "json", maxOutputTokens: 50, temperature: 0.2 }, new AbortController().signal);
      const body = captured[0]!.body;
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.max_completion_tokens, 50);
      assert.equal(body.max_tokens, undefined);
      assert.equal(body.temperature, undefined);
      assert.equal(out.content, '{"a":1}');
      assert.equal(out.finishReason, "stop");
    },
  );
});

test("openai adapter: HTTP errors carry the status and never the key", async () => {
  await withServer(
    () => ({ status: 401, text: '{"error":{"message":"bad key sk-secret"}}' }),
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ providers: { ark: { name: "ark", baseUrl, apiKey: "sk-secret" } } });
      await assert.rejects(provider.complete(profile("ark"), { tier: "economy", messages: [{ role: "user", content: "x" }] }, new AbortController().signal), (err: Error) => {
        assert.match(err.message, /HTTP 401/);
        assert.ok(!err.message.includes("sk-secret"));
        return true;
      });
    },
  );
});

test("openai adapter: abort via signal", async () => {
  const controller = new AbortController();
  const provider = new OpenAICompatibleProvider({
    providers: { openai: { name: "openai", baseUrl: "http://127.0.0.1:9", apiKey: "k" } },
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  });
  const p = provider.complete(profile("openai"), { tier: "economy", messages: [{ role: "user", content: "x" }] }, controller.signal);
  controller.abort();
  await assert.rejects(p, (err: Error) => err.name === "AbortError");
});
