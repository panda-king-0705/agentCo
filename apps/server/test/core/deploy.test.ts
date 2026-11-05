/**
 * Deployment defaults: the founder's model choice (Claude per tier when ANTHROPIC_API_KEY is set),
 * optional fallbacks that never break a primary, MANAGER_MODEL_TIER, the startup summary, the
 * fail-fast auth rule and the request guard behind a published Docker port / reverse proxy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../../src/config.ts";
import { AppError } from "../../src/http/errors.ts";
import { guardRequest } from "../../src/http/guard.ts";
import { loadModelConfig, modelsInfo, modelSummaryLines } from "../../src/models/config.ts";
import { lookupPrice } from "../../src/models/pricing.ts";
import { resolveModelTier } from "../../src/org/agent-factory.ts";
import { createTestApp } from "./helpers/harness.ts";

const quiet = { log: () => {} };
const KEY = "sk-ant-test-0123456789abcdef";

test("models: with only ANTHROPIC_API_KEY the tiers are Opus / Sonnet / Haiku (live, no fallback)", () => {
  const config = loadModelConfig({ ANTHROPIC_API_KEY: KEY }, quiet);
  assert.equal(config.tiers.frontier.primary.id, "anthropic:claude-opus-5-5");
  assert.equal(config.tiers.standard.primary.id, "anthropic:claude-sonnet-5-5");
  assert.equal(config.tiers.economy.primary.id, "anthropic:claude-haiku-5-5");
  for (const tier of ["frontier", "standard", "economy"] as const) assert.equal(config.tiers[tier].fallback, null, `${tier} has no implicit fallback`);
  assert.equal(config.providers.anthropic?.baseUrl, "https://api.anthropic.com/v1");
  assert.deepEqual(
    [config.tiers.frontier.primary, config.tiers.standard.primary, config.tiers.economy.primary].map((p) => [p.inputPerMTokUsd, p.outputPerMTokUsd]),
    [[4, 20], [2, 10], [0.1, 0.5]],
  );
  assert.equal(modelsInfo(config).live, true);
  assert.deepEqual(config.warnings, []);
});

test("models: the .env.example lines without a key run on the mock; explicit mock stays mock with a key", () => {
  const exampleLines = {
    MODEL_FRONTIER: "anthropic:claude-opus-5-5",
    MODEL_STANDARD: "anthropic:claude-sonnet-5-5",
    MODEL_ECONOMY: "anthropic:claude-haiku-5-5",
  };
  const offline = loadModelConfig({ ...exampleLines, ANTHROPIC_API_KEY: "" }, quiet);
  assert.equal(modelsInfo(offline).live, false);
  assert.equal(offline.tiers.frontier.primary.id, "mock:frontier");
  const withKey = loadModelConfig({ ...exampleLines, ANTHROPIC_API_KEY: KEY }, quiet);
  assert.equal(withKey.tiers.standard.primary.id, "anthropic:claude-sonnet-5-5");
  const pinnedMock = loadModelConfig({ ANTHROPIC_API_KEY: KEY, MODEL_ECONOMY: "mock:economy" }, quiet);
  assert.equal(pinnedMock.tiers.economy.primary.provider, "mock");
  assert.equal(pinnedMock.tiers.frontier.primary.id, "anthropic:claude-opus-5-5");
});

test("models: a fallback without its provider key is dropped and never breaks the primary", () => {
  const lines: string[] = [];
  const config = loadModelConfig(
    {
      ANTHROPIC_API_KEY: KEY,
      MODEL_FRONTIER_FALLBACK: "gemini:gemini-4-argon",
      MODEL_STANDARD_FALLBACK: "openai:gpt-6.1-sol",
      MODEL_ECONOMY_FALLBACK: "openai:gpt-6-luna",
      OPENAI_API_KEY: "",
    },
    { log: (l) => lines.push(l) },
  );
  for (const tier of ["frontier", "standard", "economy"] as const) {
    assert.equal(config.tiers[tier].primary.provider, "anthropic", `${tier} primary stays live`);
    assert.equal(config.tiers[tier].fallback, null, `${tier} fallback dropped`);
  }
  assert.ok(lines.some((l) => l.includes("MODEL_ECONOMY_FALLBACK") && l.includes("no fallback")));
  assert.ok(!lines.some((l) => l.includes(KEY)), "warnings never contain a key");
});

test("models: a fallback is used when its provider key exists", () => {
  const config = loadModelConfig({ ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: "sk-openai-test-123456", MODEL_ECONOMY_FALLBACK: "openai:gpt-6-luna" }, quiet);
  assert.equal(config.tiers.economy.primary.id, "anthropic:claude-haiku-5-5");
  assert.equal(config.tiers.economy.fallback?.id, "openai:gpt-6-luna");
  assert.equal(config.tiers.frontier.fallback, null);
});

test("models: the Anthropic ids are priced and marked verified", () => {
  assert.deepEqual([lookupPrice("claude-opus-5-5")?.inputPerMTokUsd, lookupPrice("claude-opus-5-5")?.outputPerMTokUsd], [4, 20]);
  assert.deepEqual([lookupPrice("claude-sonnet-5-5")?.inputPerMTokUsd, lookupPrice("claude-sonnet-5-5")?.outputPerMTokUsd], [2, 10]);
  assert.deepEqual([lookupPrice("claude-haiku-5-5")?.inputPerMTokUsd, lookupPrice("claude-haiku-5-5")?.outputPerMTokUsd], [0.1, 0.5]);
});

test("models: startup summary names tier → model → provider, live/mock and users, never keys", () => {
  const live = modelSummaryLines(loadModelConfig({ ANTHROPIC_API_KEY: KEY }, quiet));
  assert.equal(live.length, 3);
  assert.match(live[0]!, /^frontier → claude-opus-5-5 via anthropic\s+LIVE\s+\[executives\]$/);
  assert.match(live[1]!, /^standard → claude-sonnet-5-5 via anthropic\s+LIVE\s+\[managers\]$/);
  assert.match(live[2]!, /^economy\s+→ claude-haiku-5-5 via anthropic\s+LIVE\s+\[workers\]$/);
  for (const line of live) assert.ok(!line.includes(KEY) && !line.includes("https://"), "no key or base URL");
  const mixed = modelSummaryLines(loadModelConfig({ MODEL_ECONOMY: "openai:gpt-6-luna", OPENAI_API_KEY: "sk-openai-test-123456" }, quiet), "frontier");
  assert.match(mixed[0]!, /mock:frontier \(offline mock\)\s+MOCK\s+\[executives \+ managers\]/);
  assert.match(mixed[1]!, /MOCK\s+\[stage routing only\]/);
  assert.match(mixed[2]!, /gpt-6-luna via openai\s+LIVE\s+\[workers\]/);
});

test("MANAGER_MODEL_TIER: parsed with default standard; anything else stops the boot", () => {
  assert.equal(loadConfig({}).managerModelTier, "standard");
  assert.equal(loadConfig({ MANAGER_MODEL_TIER: "frontier" }).managerModelTier, "frontier");
  assert.throws(() => loadConfig({ MANAGER_MODEL_TIER: "economy" }), (e: Error) => e instanceof ConfigError && /MANAGER_MODEL_TIER=economy/.test(e.message));
});

test("MANAGER_MODEL_TIER: resolveModelTier moves default managers only; explicit input and other tiers win", () => {
  const managerRole = { tier: "manager", modelTier: "standard" } as Parameters<typeof resolveModelTier>[1];
  const economyRole = { tier: "manager", modelTier: "economy" } as Parameters<typeof resolveModelTier>[1];
  assert.equal(resolveModelTier("manager", managerRole, {}), "standard");
  assert.equal(resolveModelTier("manager", managerRole, {}, { managerModelTier: "frontier" }), "frontier");
  assert.equal(resolveModelTier("manager", null, { tier: "manager" }, { managerModelTier: "frontier" }), "frontier");
  assert.equal(resolveModelTier("manager", managerRole, { modelTier: "standard" }, { managerModelTier: "frontier" }), "standard", "explicit input wins");
  assert.equal(resolveModelTier("manager", economyRole, {}, { managerModelTier: "frontier" }), "economy", "a role that picked economy keeps it");
  assert.equal(resolveModelTier("worker", null, { tier: "worker" }, { managerModelTier: "frontier" }), "economy");
  assert.equal(resolveModelTier("executive", null, { tier: "executive" }, { managerModelTier: "standard" }), "frontier");
});

test("MANAGER_MODEL_TIER: bootstrap and hires use it; setting it later re-tiers existing managers at boot", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agentco-deploy-"));
  try {
    const first = await createTestApp({ dataDir });
    const agents = () => first.app.platform.repos.agents.list();
    assert.ok(agents().filter((a) => a.tier === "manager").length > 0, "the startup org has managers");
    for (const a of agents()) {
      const expected = a.tier === "executive" ? "frontier" : a.tier === "manager" ? "standard" : "economy";
      assert.equal(a.modelTier, expected, `${a.title} (${a.tier}) → ${expected}`);
    }
    // A manager the founder pinned to economy in the console keeps it later.
    const pinned = agents().find((a) => a.tier === "manager")!;
    first.app.platform.org.updateAgent(pinned.id, { modelTier: "economy" });
    await first.close();

    const second = await createTestApp({ dataDir, env: { MANAGER_MODEL_TIER: "frontier" } });
    try {
      const managers = second.app.platform.repos.agents.list({ includeTerminated: false }).filter((a) => a.tier === "manager");
      for (const m of managers) assert.equal(m.modelTier, m.id === pinned.id ? "economy" : "frontier", m.title);
      const hired = second.app.platform.org.createAgent({ tier: "manager", title: "Launch Manager" }, "human");
      assert.equal(hired.modelTier, "frontier");
      const worker = second.app.platform.org.createAgent({ tier: "worker", title: "Launch Worker" }, "human");
      assert.equal(worker.modelTier, "economy");
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("auth: off loopback a missing/short APP_AUTH_TOKEN fails fast with a fix-it message", () => {
  for (const token of [undefined, "", "short-token"]) {
    assert.throws(
      () => loadConfig({ HOST: "0.0.0.0", ...(token === undefined ? {} : { APP_AUTH_TOKEN: token }) }),
      (e: Error) => e instanceof ConfigError && /APP_AUTH_TOKEN must be at least 24 characters when HOST \(0\.0\.0\.0\)/.test(e.message) && /randomBytes\(24\)/.test(e.message),
    );
  }
  const ok = loadConfig({ HOST: "0.0.0.0", APP_AUTH_TOKEN: "a".repeat(48) });
  assert.equal(ok.authRequired, true);
});

test("guard: Docker published port — LAN IP, localhost and a remapped port pass; other origins are refused", () => {
  const docker = { host: "0.0.0.0", allowedOrigins: [] as string[], allowedHosts: [] as string[] };
  const write = (host: string, origin: string) => guardRequest("POST", { host, origin, "content-type": "application/json" }, docker);
  assert.doesNotThrow(() => write("192.168.1.92:3000", "http://192.168.1.92:3000"), "console opened on the LAN IP");
  assert.doesNotThrow(() => write("localhost:3000", "http://localhost:3000"), "console opened on the host PC");
  assert.doesNotThrow(() => write("192.168.1.92:8080", "http://192.168.1.92:8080"), "a remapped published port");
  assert.doesNotThrow(() => guardRequest("GET", { host: "192.168.1.92:3000" }, docker));
  const forbidden = (e: Error) => e instanceof AppError && e.status === 403;
  assert.throws(() => write("192.168.1.92:3000", "http://evil.example"), forbidden);
  assert.throws(() => write("192.168.1.92:3000", "http://192.168.1.92:4000"), forbidden, "another port on the same IP is another origin");
  // Explicit LAN entries (the documented .env lines) are accepted as well.
  const lan = { ...docker, allowedHosts: ["192.168.1.92", "localhost"], allowedOrigins: ["http://192.168.1.92:3000", "http://localhost:3000"] };
  assert.doesNotThrow(() => guardRequest("POST", { host: "192.168.1.92:3000", origin: "http://192.168.1.92:3000", "content-type": "application/json" }, lan));
});

test("guard: behind a TLS reverse proxy — Host preserved works; a rewritten Host needs ALLOWED_ORIGINS", () => {
  const docker = { host: "0.0.0.0", allowedOrigins: [] as string[], allowedHosts: [] as string[] };
  const body = { "content-type": "application/json" };
  // Caddy keeps the Host header: the https origin matches "this server".
  assert.doesNotThrow(() => guardRequest("POST", { host: "agentco.example.com", origin: "https://agentco.example.com", ...body }, docker));
  // A proxy that rewrites Host (nginx default) needs the public origin listed.
  assert.throws(() => guardRequest("POST", { host: "agentco:3000", origin: "https://agentco.example.com", ...body }, docker), (e: Error) => e instanceof AppError && e.status === 403);
  const listed = { ...docker, allowedOrigins: loadConfig({ ALLOWED_ORIGINS: "https://agentco.example.com" }).allowedOrigins };
  assert.doesNotThrow(() => guardRequest("POST", { host: "agentco:3000", origin: "https://agentco.example.com", ...body }, listed));
});

test(".env.example: Anthropic block first, exact model lines, conservative budgets, boots as-is", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseEnv } = await import("node:util");
  const text = readFileSync(join(import.meta.dirname, "../../../../.env.example"), "utf8");
  const firstSetting = text.split("\n").find((l) => /^[A-Z_]+=/.test(l));
  assert.equal(firstSetting, "ANTHROPIC_API_KEY=");
  for (const line of ["MODEL_FRONTIER=anthropic:claude-opus-5-5", "MODEL_STANDARD=anthropic:claude-sonnet-5-5", "MODEL_ECONOMY=anthropic:claude-haiku-5-5", "DAILY_BUDGET_USD=5", "MONTHLY_BUDGET_USD=50"]) {
    assert.ok(text.split("\n").includes(line), `has ${line}`);
  }
  assert.ok(!/^[A-Z_]+=[^#\n]*[ \t]#/m.test(text), "no trailing comments (docker --env-file keeps them in the value)");
  const env = parseEnv(text) as NodeJS.ProcessEnv;
  const config = loadConfig(env);
  assert.equal(config.authRequired, false, "copied as-is it boots on loopback");
  assert.equal(modelsInfo(loadModelConfig(env, quiet)).live, false, "no key → mock");
  const live = loadModelConfig({ ...env, ANTHROPIC_API_KEY: KEY }, quiet);
  assert.deepEqual(["frontier", "standard", "economy"].map((t) => live.tiers[t as "frontier"].primary.id), ["anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5-5", "anthropic:claude-haiku-5-5"]);
  assert.ok(["frontier", "standard", "economy"].every((t) => live.tiers[t as "frontier"].fallback === null));
});
