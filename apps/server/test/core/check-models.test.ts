/**
 * `npm run check:models` against a local fake OpenAI-compatible server: one tiny call per live
 * tier, model / latency / cost printed, non-zero exit on auth or model errors, refusal without keys,
 * and the key never printed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { CHECK_MAX_TOKENS, checkModels, classifyFailure } from "../../src/models/check.ts";

const GOOD_KEY = "sk-ant-good-0123456789abcdef";
const KNOWN = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
const ROOT = resolve(import.meta.dirname, "../../../..");

let server: Server;
let baseUrl = "";
const requests: { auth: string; body: Record<string, unknown> }[] = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      requests.push({ auth: String(req.headers.authorization ?? ""), body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url !== "/v1/chat/completions" || req.method !== "POST") return send(404, { error: { message: "no route" } });
      if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(401, { error: { type: "authentication_error", message: "invalid x-api-key" } });
      if (!KNOWN.has(String(body.model))) return send(404, { error: { type: "not_found_error", message: `model: ${String(body.model)}` } });
      send(200, {
        id: "chatcmpl-1",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 2 },
      });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => new Promise<void>((ok) => server.close(() => ok())));

function capture(): { lines: string[]; log: (l: string) => void; text: () => string } {
  const lines: string[] = [];
  return { lines, log: (l) => lines.push(l), text: () => lines.join("\n") };
}

test("check:models: one tiny call per live tier, prints model, latency and cost, exit 0", async () => {
  requests.length = 0;
  const out = capture();
  const report = await checkModels({ ANTHROPIC_API_KEY: GOOD_KEY, ANTHROPIC_BASE_URL: baseUrl }, { log: out.log });
  assert.equal(report.exitCode, 0, out.text());
  assert.equal(requests.length, 3, "exactly one call per tier");
  assert.deepEqual(requests.map((r) => r.body.model), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  for (const r of requests) {
    assert.equal(r.body.max_tokens, CHECK_MAX_TOKENS);
    assert.equal(r.body.tools, undefined);
  }
  const opus = report.results.find((r) => r.tier === "frontier")!;
  assert.equal(opus.ok, true);
  assert.equal(opus.costUsd, (20 * 4 + 2 * 20) / 1e6);
  assert.ok(opus.latencyMs >= 0);
  assert.match(out.text(), /OK\s+frontier\s+anthropic:claude-opus-5-5\s+\d+ ms\s+in 20 \/ out 2 tok\s+\$0\.000120/);
  assert.match(out.text(), /all 3 live call\(s\) OK/);
  assert.ok(!out.text().includes(GOOD_KEY), "the key is never printed");
});

test("check:models: a rejected key is an auth error → exit 1, key redacted", async () => {
  const badKey = "sk-ant-bad-0123456789abcdef";
  const out = capture();
  const report = await checkModels({ ANTHROPIC_API_KEY: badKey, ANTHROPIC_BASE_URL: baseUrl }, { log: out.log });
  assert.equal(report.exitCode, 1);
  assert.ok(report.results.every((r) => !r.ok && r.failure === "auth"));
  assert.match(out.text(), /FAIL\s+frontier.*auth: the API key was rejected/);
  assert.ok(!out.text().includes(badKey));
});

test("check:models: an unknown model id is a model error → exit 1 (other tiers still checked)", async () => {
  const out = capture();
  const report = await checkModels(
    { ANTHROPIC_API_KEY: GOOD_KEY, ANTHROPIC_BASE_URL: baseUrl, MODEL_STANDARD: "anthropic:claude-sonnet-9-9" },
    { log: out.log },
  );
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.results.map((r) => [r.tier, r.ok, r.failure]), [["frontier", true, null], ["standard", false, "model"], ["economy", true, null]]);
  assert.match(out.text(), /1 of 3 live call\(s\) FAILED/);
});

test("check:models: refuses to run without keys (exit 2, no request)", async () => {
  requests.length = 0;
  const out = capture();
  const bare = await checkModels({ ANTHROPIC_BASE_URL: baseUrl }, { log: out.log });
  const exampleWithoutKey = await checkModels(
    { MODEL_FRONTIER: "anthropic:claude-opus-5-5", MODEL_STANDARD: "anthropic:claude-sonnet-5-5", MODEL_ECONOMY: "anthropic:claude-haiku-5-5", ANTHROPIC_API_KEY: "" },
    { log: out.log },
  );
  assert.equal(bare.exitCode, 2);
  assert.equal(exampleWithoutKey.exitCode, 2);
  assert.equal(requests.length, 0);
  assert.match(out.text(), /refused: no live model is configured/);
});

test("check:models: only live tiers are called; a tier left on the mock is reported, fallbacks on request", async () => {
  requests.length = 0;
  const out = capture();
  const report = await checkModels(
    {
      ANTHROPIC_API_KEY: GOOD_KEY,
      ANTHROPIC_BASE_URL: baseUrl,
      MODEL_FRONTIER: "mock:frontier",
      MODEL_ECONOMY: "openai:gpt-6-luna", // no OPENAI_API_KEY → mock, reported
      MODEL_STANDARD_FALLBACK: "anthropic:claude-haiku-5-5",
    },
    { log: out.log, includeFallbacks: true },
  );
  assert.equal(report.exitCode, 0, out.text());
  assert.deepEqual(report.results.map((r) => `${r.tier}/${r.role}/${r.profileId}`), ["standard/primary/anthropic:claude-sonnet-5-5", "standard/fallback/anthropic:claude-haiku-5-5"]);
  assert.match(out.text(), /economy: MODEL_ECONOMY has no key/);
});

test("check:models: failure classification", () => {
  assert.equal(classifyFailure("anthropic claude-x: HTTP 401 Unauthorized — invalid x-api-key"), "auth");
  assert.equal(classifyFailure("openai m: HTTP 403 Forbidden"), "auth");
  assert.equal(classifyFailure("anthropic m: HTTP 404 Not Found — model: m"), "model");
  assert.equal(classifyFailure("openai m: HTTP 400 Bad Request — The model `m` does not exist"), "model");
  assert.equal(classifyFailure("anthropic request to https://x/v1/chat/completions failed: fetch failed"), "network");
  assert.equal(classifyFailure("openai m: HTTP 500 Internal Server Error"), "other");
});

test("npm run check:models wiring: the CLI exits 0 against the fake server and 2 without keys", async () => {
  const run = (env: NodeJS.ProcessEnv) =>
    new Promise<{ code: number | null; out: string }>((ok) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "apps/server/src/check-models.ts")], {
        cwd: join(ROOT, "apps/server/test"), // no .env here
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (out += String(d)));
      child.on("close", (code) => ok({ code, out }));
    });
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  const live = await run({ ...base, ANTHROPIC_API_KEY: GOOD_KEY, ANTHROPIC_BASE_URL: baseUrl });
  assert.equal(live.code, 0, live.out);
  assert.match(live.out, /claude-haiku-5-5/);
  assert.ok(!live.out.includes(GOOD_KEY));
  const none = await run(base);
  assert.equal(none.code, 2, none.out);
});
