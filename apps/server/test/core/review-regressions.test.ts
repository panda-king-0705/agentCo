import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createTestApp, rootTask, done, gate, waitFor, api, type TestApp } from "./helpers/harness.ts";
import { AppError } from "../../src/http/errors.ts";
import { createWebFetch, isPrivateAddress, WEB_FETCH_MAX_REDIRECTS } from "../../src/tools/builtins/web.ts";
import { createModelRouter } from "../../src/models/router.ts";
import { loadModelConfig } from "../../src/models/config.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import { readStage } from "../../src/models/protocol.ts";
import { BrainEngine, ReflexEngine } from "../../src/cognition/index.ts";
import type { ModelProvider, ModelRouterDeps, ChatRequest } from "../../src/contracts.ts";

const quiet = { log: () => {} };

/** Mock provider recording every request; per-stage JSON overrides. */
function recording(overrides: Record<string, unknown> = {}, latencyMs = 0) {
  const mock = new MockProvider({ latencyMs });
  const requests: ChatRequest[] = [];
  const provider: ModelProvider = {
    name: "mock",
    async complete(profile, request, signal) {
      requests.push(request);
      const r = await mock.complete(profile, request, signal);
      const stage = readStage(request.messages) ?? "";
      if (request.responseFormat === "json" && overrides[stage] !== undefined) return { ...r, content: JSON.stringify(overrides[stage]) };
      return r;
    },
  };
  return { provider, requests };
}

function realRouter(provider: ModelProvider) {
  return (deps: ModelRouterDeps) => createModelRouter({ ...deps, config: loadModelConfig({ MOCK_LATENCY_MS: "0" }, quiet), providers: { mock: provider } });
}

// ───────────────────────── 1. Board's answer never reaches the brain ─────────────────────────
test("R1 human_answer: the Board's note is not in any prompt of the resumed brain run (real platform)", async () => {
  const { provider, requests } = recording({ "metacognition.confidence": { confidence: 0.05, uncertainty: 0.9 } });
  const brain = new BrainEngine({ maxRevisions: 1, runTimeoutMs: 300_000 });
  const reflex = new ReflexEngine({ maxSteps: 4 } as never);
  const t = await createTestApp({ brain: (ctx) => brain.run(ctx), reflex: (ctx) => reflex.run(ctx), overrides: { createRouter: realRouter(provider) } });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const task = rootTask(t, ceo.id, "Pick our launch market");
    platform.scheduler.tick();
    await platform.runs.idle();
    const blocked = platform.tasks.get(task.id)!;
    assert.equal(blocked.status, "blocked", "CEO early-stopped and asked the Board");
    const approvalId = String(blocked.state.blockedOnApprovalId);
    requests.length = 0;
    platform.approvals.decide(approvalId, { decision: "approved", note: "PINEAPPLE-42: focus on Japan only" });
    platform.scheduler.tick(); // only the CEO's human_answer run
    await platform.runs.idle();
    const ceoRun = platform.repos.runs.list({ agentId: ceo.id, limit: 1 })[0]!;
    assert.equal(ceoRun.trigger, "human_answer");
    const prompts = requests.map((r) => r.messages.map((m) => m.content).join("\n"));
    const sawNote = prompts.some((p) => p.includes("PINEAPPLE-42"));
    const stored = platform.tasks.get(task.id)!.state.answers as unknown[];
    console.log(`R1: ${requests.length} model calls in the human_answer run; note in any prompt: ${sawNote}; task.state.answers stored: ${JSON.stringify(stored)}`);
    assert.ok(sawNote, "the Board's answer note should reach the model in the run it triggered");
  } finally {
    await t.close();
  }
});

// ───────────────────────── 2. Budget cap overshoot with concurrent calls ─────────────────────────
test("R2 budget: concurrent model calls all pass assertCanSpend and overshoot the company daily cap", async () => {
  const slow = new MockProvider({ latencyMs: 50 });
  const provider: ModelProvider = {
    name: "mock",
    async complete(profile, request, signal) {
      const r = await slow.complete(profile, request, signal);
      return { ...r, usage: { inputTokens: 1, outputTokens: request.maxOutputTokens ?? 1000, cachedInputTokens: 0 } };
    },
  };
  const t = await createTestApp({ overrides: { createRouter: realRouter(provider) } });
  try {
    const { platform } = t.app;
    const profile = platform.models.resolve("economy");
    const estimate = (1 * profile.inputPerMTokUsd + 1000 * profile.outputPerMTokUsd) / 1_000_000;
    platform.company.update({ dailyBudgetUsd: estimate * 1.5 });
    const agents = platform.org.listActiveAgents().slice(0, 4);
    const call = (agentId: string) =>
      platform.models.chat(
        { tier: "economy", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 1000 },
        { agentId, runId: "run_x", traceId: "trc_x", parentSpanId: "spn_x", taskId: null, stage: "reflex.step", signal: new AbortController().signal },
      );
    const results = await Promise.allSettled(agents.map((a) => call(a.id)));
    const spent = platform.budget.companySpent("2000-01-01T00:00:00.000Z");
    const limit = platform.company.settings().dailyBudgetUsd;
    console.log(`R2: limit $${limit.toFixed(6)}, spent $${spent.toFixed(6)} (${(spent / limit).toFixed(2)}x), fulfilled ${results.filter((r) => r.status === "fulfilled").length}/4`);
    assert.ok(spent <= limit, `spend ${spent} exceeded the hard cap ${limit}`);
  } finally {
    await t.close();
  }
});

// ───────────────────────── 3. Scheduler starvation (ready() LIMIT 200) ─────────────────────────
test("R3 scheduler: 200 high-priority todo tasks of a paused agent starve every other agent", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const cto = t.agentByRole("cto");
    const cfo = t.agentByRole("cfo");
    for (let i = 0; i < 200; i++) rootTask(t, cto.id, `CTO backlog ${i}`, { value: 1000, estCostUsd: 0.01 });
    platform.org.pauseAgent(cto.id);
    const cfoTask = rootTask(t, cfo.id, "Low-priority CFO task", { value: 1, estCostUsd: 1 });
    const started = platform.scheduler.tick();
    await platform.runs.idle();
    console.log(`R3: started ${started}; CFO task status ${platform.tasks.get(cfoTask.id)!.status}`);
    assert.equal(platform.tasks.get(cfoTask.id)!.status, "done", "an idle agent's ready task should be scheduled");
  } finally {
    await t.close();
  }
});

// ───────────────────────── 4. Destroying a report-less CEO orphans its tasks ─────────────────────────
// Adapted from the reviewer's repro: the agreed fix refuses the destroy (409) while open tasks have
// no manager to inherit them, so the assertion is that nothing is orphaned and the CEO is untouched.
test("R4 destroy: a top-level agent with open tasks and no manager to inherit them is refused (409); nothing is orphaned", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    for (;;) {
      const leaf = platform.org.listActiveAgents().find((a) => a.id !== ceo.id && platform.org.directReports(a.id).length === 0);
      if (!leaf) break;
      platform.org.destroyAgent(leaf.id);
    }
    const task = rootTask(t, ceo.id, "CEO objective");
    assert.throws(
      () => platform.org.destroyAgent(ceo.id),
      (e: Error) => e instanceof AppError && e.status === 409 && /1 open task\(s\) \(T-\d+\) and no manager to inherit them/.test(e.message),
    );
    const after = platform.tasks.get(task.id)!;
    console.log(`R4: after refused destroy assignee=${after.assigneeId} status=${after.status}; ceo status=${platform.org.getAgent(ceo.id)!.status}`);
    assert.equal(after.assigneeId, ceo.id, "open tasks must stay with someone who can run them");
    assert.notEqual(platform.org.getAgent(ceo.id)!.status, "terminated");
    // Once the work is closed the destroy goes through.
    platform.tasks.cancel(task.id, "closing before the CEO is retired");
    assert.equal(platform.org.destroyAgent(ceo.id).reassignedTasks, 0);
    assert.equal(platform.org.getAgent(ceo.id)!.status, "terminated");
  } finally {
    await t.close();
  }
});

// ───────────────────────── 5. Redaction gaps ─────────────────────────
test("R5 redaction: approval note and engine-written task.state are persisted unredacted", async () => {
  const KEY = "sk-ABCDEFGHIJKLMNOPQRSTUVWX1234";
  const t = await createTestApp({
    brain: (ctx) => (ctx.input.trigger === "message" ? done("hi") : { outcome: "waiting", output: "w", taskState: { plan: { note: `use ${KEY}` } } }),
  });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const a = platform.approvals.create({ kind: "question", requestedBy: ceo.id, summary: "q?" });
    const decided = platform.approvals.decide(a.id, { decision: "approved", note: `here is the key ${KEY}` });
    const task = rootTask(t, ceo.id, "x");
    platform.scheduler.tick();
    await platform.runs.idle();
    const state = JSON.stringify(platform.tasks.get(task.id)!.state);
    console.log(`R5: approval note stored = ${JSON.stringify(decided.note)}; task.state contains key: ${state.includes(KEY)}`);
    assert.ok(!decided.note!.includes(KEY) && !state.includes(KEY), "secrets reached the database");
  } finally {
    await t.close();
  }
});

// ───────────────────────── 6. Tool-loop escalate: orphaned / duplicated escalation subtasks ─────────────────────────
function scriptedToolProvider(script: (step: number) => { name: string; arguments: Record<string, unknown> }[]): ModelProvider {
  const mock = new MockProvider({ latencyMs: 0 });
  let step = 0;
  return {
    name: "mock",
    async complete(profile, request, signal) {
      const r = await mock.complete(profile, request, signal);
      if (!request.tools?.length) return r;
      step += 1;
      const calls = script(step).map((c, i) => ({ id: `c${step}_${i}`, ...c }));
      return { ...r, content: "", toolCalls: calls, finishReason: "tool_calls" as const };
    },
  };
}

test("R6a reflex: a worker that calls escalate and then complete_task finishes its task; the manager's escalation subtask is orphaned", async () => {
  const provider = scriptedToolProvider((s) =>
    s === 1 ? [{ name: "escalate", arguments: { reason: "unclear scope", question: "Which DB?" } }] : [{ name: "complete_task", arguments: { result: "did it anyway" } }],
  );
  const reflex = new ReflexEngine({ maxSteps: 4 } as never);
  const t = await createTestApp({ reflex: (ctx) => reflex.run(ctx), overrides: { createRouter: realRouter(provider) } });
  try {
    const { platform } = t.app;
    const eng = t.agentByRole("backend-engineer");
    const task = rootTask(t, eng.id, "Build the API");
    platform.scheduler.tick();
    await platform.runs.idle();
    const parent = platform.tasks.get(task.id)!;
    const kids = platform.tasks.children(task.id);
    console.log(`R6a: task ${parent.status}; children: ${kids.map((k) => `${k.state.kind}:${k.status}→${platform.org.getAgent(k.assigneeId!)?.title}`).join(", ")}`);
    assert.ok(!(parent.status === "done" && kids.some((k) => k.status === "todo")), "task completed while its escalation subtask is still open");
  } finally {
    await t.close();
  }
});

test("R6b reflex: escalate + report_blocker opens TWO escalation subtasks for one question", async () => {
  const provider = scriptedToolProvider((s) =>
    s === 1 ? [{ name: "escalate", arguments: { reason: "unclear scope", question: "Which DB?" } }] : [{ name: "report_blocker", arguments: { reason: "waiting on manager" } }],
  );
  const reflex = new ReflexEngine({ maxSteps: 4 } as never);
  const t = await createTestApp({ reflex: (ctx) => reflex.run(ctx), overrides: { createRouter: realRouter(provider) } });
  try {
    const { platform } = t.app;
    const eng = t.agentByRole("backend-engineer");
    const task = rootTask(t, eng.id, "Build the API");
    platform.scheduler.tick();
    await platform.runs.idle();
    const kids = platform.tasks.children(task.id).filter((k) => k.state.kind === "escalation");
    console.log(`R6b: task ${platform.tasks.get(task.id)!.status}; escalation subtasks: ${kids.length}`);
    assert.equal(kids.length, 1, "one question should create one escalation subtask");
  } finally {
    await t.close();
  }
});

// ───────────────────────── 7. CSRF on the unauthenticated loopback API ─────────────────────────
test("R7 http: a cross-site text/plain POST (no preflight) pauses the company", async () => {
  const t = await createTestApp({ listen: true });
  try {
    const u = new URL(t.url + "/api/company/pause");
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
    const paused = t.app.platform.company.settings().paused;
    console.log(`R7: status ${status}, paused=${paused}`);
    assert.ok(!paused, "cross-origin simple POST must not mutate state");
  } finally {
    await t.close();
  }
});

// ───────────────────────── 8. web_fetch private-host filter ─────────────────────────
// Rewritten from a regex-introspection repro into behaviour: the tool resolves DNS (injected
// resolver, no real DNS) and refuses private targets in every spelling and on every redirect hop.
test("R8 web_fetch: IPv4-mapped IPv6 loopback and DNS names for private IPs are refused", async () => {
  const dns: Record<string, string[]> = { "127.0.0.1.nip.io": ["127.0.0.1"], "public.example": ["93.184.215.14"], "mixed.example": ["93.184.215.14", "10.0.0.5"] };
  const fetched: string[] = [];
  const tool = createWebFetch({
    lookup: async (host) => (dns[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    fetch: async (input) => {
      fetched.push(String(input));
      return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
    },
  });
  const run = (url: string) => tool.run({ url }, { signal: new AbortController().signal } as never);
  const refused: string[] = [];
  for (const url of ["http://[::ffff:127.0.0.1]:3000/api/company", "http://127.0.0.1.nip.io/", "http://[0:0:0:0:0:0:0:1]/", "http://mixed.example/", "http://0x7f.1/", "http://localhost./"]) {
    const r = await run(url);
    if (!r.ok) refused.push(url);
  }
  console.log(`R8: refused ${refused.length}/6; fetched ${JSON.stringify(fetched)}`);
  assert.equal(refused.length, 6);
  assert.equal(fetched.length, 0, "nothing private was fetched");
  const okResult = await run("http://public.example/page");
  assert.ok(okResult.ok, okResult.content);
  assert.deepEqual(fetched, ["http://public.example/page"]);
});

// ───────────────────────── 9. Agent update validation ─────────────────────────
test("R9 org: updateAgent accepts an unknown modelTier and a negative budget (uncapped)", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const cfo = t.agentByRole("cfo");
    let accepted = true;
    try {
      platform.org.updateAgent(cfo.id, { modelTier: "bogus" as never, monthlyBudgetUsd: -1 });
    } catch {
      accepted = false;
    }
    const router = createModelRouter({ config: loadModelConfig({}, quiet), tracer: platform.tracer, budget: platform.budget, getAgent: () => null });
    let resolveError = "";
    try {
      router.resolve("bogus" as never);
    } catch (e) {
      resolveError = (e as Error).message;
    }
    console.log(`R9: accepted=${accepted}; stored tier=${platform.org.getAgent(cfo.id)!.modelTier}; router.resolve error="${resolveError}"`);
    assert.equal(accepted, false);
  } finally {
    await t.close();
  }
});

// ═════════════════════════ Fix coverage beyond the reviewer's repros ═════════════════════════

/** Raw HTTP request (fetch would add its own Origin / Host handling). */
function raw(base: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  const u = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

test("F6 http: Origin allow-list, JSON-only state changes, Host check against DNS rebinding; console GETs and SSE keep working", async () => {
  const t = await createTestApp({ listen: true, env: { ALLOWED_ORIGINS: "https://console.example" } });
  try {
    const self = new URL(t.url).host; // 127.0.0.1:<port>
    const json = { "content-type": "application/json" };
    const patch = (headers: Record<string, string>) => raw(t.url, "/api/company", { method: "PATCH", headers, body: JSON.stringify({ name: "Renamed" }) });
    // Cross-site, even with a JSON content type (a preflight would fail anyway; defence in depth).
    assert.equal((await patch({ ...json, origin: "https://evil.example" })).status, 403);
    assert.equal((await patch({ ...json, origin: "null" })).status, 403);
    // Same host:port, the Vite dev origin and ALLOWED_ORIGINS are allowed.
    assert.equal((await patch({ ...json, origin: `http://${self}` })).status, 200);
    assert.equal((await patch({ ...json, origin: "http://localhost:5173" })).status, 200);
    assert.equal((await patch({ ...json, origin: "https://console.example" })).status, 200);
    // Simple (preflight-free) content types are refused even without an Origin.
    assert.equal((await patch({ "content-type": "text/plain" })).status, 415);
    assert.equal((await patch({ "content-type": "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await raw(t.url, "/api/company/pause", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: "" })).status, 415);
    // A body without a content type is refused; a body-less POST with none (curl, the console's DELETE) passes.
    assert.equal((await raw(t.url, "/api/company/pause", { method: "POST", headers: { "content-length": "2" }, body: "{}" })).status, 415);
    assert.equal(t.app.platform.company.settings().paused, false);
    assert.equal((await raw(t.url, "/api/company/pause", { method: "POST" })).status, 200);
    assert.equal(t.app.platform.company.settings().paused, true);
    assert.equal((await raw(t.url, "/api/company/resume", { method: "POST", headers: { origin: "https://evil.example" } })).status, 403, "body-less but cross-site");
    assert.equal(t.app.platform.company.settings().paused, true);
    // DNS rebinding: the attacker's name in Host is refused for reads too.
    const rebound = await raw(t.url, "/api/company", { headers: { host: `evil.example:${new URL(t.url).port}` } });
    assert.equal(rebound.status, 403);
    assert.match(rebound.body, /forbidden_host/);
    assert.equal((await raw(t.url, "/api/company", { headers: { host: `localhost:${new URL(t.url).port}` } })).status, 200);
    // Console reads and the SSE stream (GET, same origin, no Content-Type) keep working.
    assert.equal((await api(t.url, "/api/org")).status, 200);
    const controller = new AbortController();
    const sse = await fetch(t.url + "/api/events/stream", { signal: controller.signal, headers: { accept: "text/event-stream" } });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
    controller.abort();
    await sse.body?.cancel().catch(() => undefined);
  } finally {
    await t.close();
  }
});

test("F6 http guard: host and origin rules (pure)", async () => {
  const { guardRequest, hostAllowed } = await import("../../src/http/guard.ts");
  const cfg = { host: "127.0.0.1", allowedOrigins: [], allowedHosts: ["agentco.lan"] };
  assert.ok(hostAllowed("[::1]:3000", cfg) && hostAllowed("LOCALHOST:3000", cfg) && hostAllowed("agentco.lan", cfg));
  assert.ok(!hostAllowed("127.0.0.1.nip.io:3000", cfg) && !hostAllowed(undefined, cfg));
  assert.ok(hostAllowed("192.168.1.5:3000", { ...cfg, host: "0.0.0.0" }), "wildcard bind (bearer auth enforced) accepts any Host");
  assert.doesNotThrow(() => guardRequest("DELETE", { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }, cfg));
  assert.throws(() => guardRequest("DELETE", { host: "127.0.0.1:3000", origin: "http://127.0.0.1:4000" }, cfg), (e: Error) => e instanceof AppError && e.status === 403);
  assert.doesNotThrow(() => guardRequest("POST", { host: "127.0.0.1:3000", "content-type": "application/json; charset=utf-8", origin: "http://127.0.0.1:3000" }, cfg));
});

test("F4 budget: reservations count against every cap and are released by recordSpend or release()", async () => {
  const t = await createTestApp();
  try {
    const { budget, company } = t.app.platform;
    const cfo = t.agentByRole("cfo");
    company.update({ dailyBudgetUsd: 1 });
    budget.assertCanSpend(cfo.id, 0.6, "rsv_a");
    assert.equal(budget.reservedUsd(), 0.6);
    assert.throws(() => budget.assertCanSpend(cfo.id, 0.6, "rsv_b"), (e: Error) => e.name === "BudgetExceededError");
    assert.ok(budget.remainingFor(cfo.id) <= 0.4 + 1e-9, "remaining (scheduler gate) counts reservations too");
    budget.release("rsv_a");
    budget.release("rsv_a"); // idempotent
    assert.equal(budget.reservedUsd(), 0);
    budget.assertCanSpend(cfo.id, 0.6, "rsv_c");
    budget.recordSpend({
      agentId: cfo.id, runId: "run_x", traceId: "trc_x", spanId: "spn_x", taskId: null, provider: "mock", model: "m", profileId: "mock:m", tier: "economy",
      stage: "reflex.step", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0.5, frontierCostUsd: 0.5, reservationId: "rsv_c",
    });
    assert.equal(budget.reservedUsd(), 0, "recordSpend released the reservation");
    assert.throws(() => budget.assertCanSpend(cfo.id, 0.6), (e: Error) => e.name === "BudgetExceededError", "the real spend now counts");
  } finally {
    await t.close();
  }
});

test("F4 budget: a failing or aborted model call releases its reservation", async () => {
  const failing: ModelProvider = {
    name: "mock",
    async complete() {
      throw new Error("HTTP 500 upstream");
    },
  };
  const t = await createTestApp({ overrides: { createRouter: realRouter(failing) } });
  try {
    const { platform } = t.app;
    const cfo = t.agentByRole("cfo");
    const ctx = { agentId: cfo.id, runId: "run_x", traceId: "trc_x", parentSpanId: "spn_x", taskId: null, stage: "reflex.step", signal: new AbortController().signal };
    await assert.rejects(platform.models.chat({ tier: "economy", messages: [{ role: "user", content: "hi" }] }, ctx), /HTTP 500/);
    assert.equal(platform.budget.reservedUsd(), 0);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(platform.models.chat({ tier: "economy", messages: [{ role: "user", content: "hi" }] }, { ...ctx, signal: aborted.signal }));
    assert.equal(platform.budget.reservedUsd(), 0);
  } finally {
    await t.close();
  }
});

test("F5 scheduler: a large backlog of an out-of-budget agent does not starve the others (paging)", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const cto = t.agentByRole("cto");
    const cfo = t.agentByRole("cfo");
    platform.org.updateAgent(cto.id, { monthlyBudgetUsd: 0.001 });
    platform.budget.recordSpend({
      agentId: cto.id, runId: "run_x", traceId: "trc_x", spanId: "spn_x", taskId: null, provider: "mock", model: "m", profileId: "mock:m", tier: "economy",
      stage: "reflex.step", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0.001, frontierCostUsd: 0.001,
    });
    for (let i = 0; i < 450; i++) rootTask(t, cto.id, `CTO backlog ${i}`, { value: 1000, estCostUsd: 0.01 });
    const cfoTask = rootTask(t, cfo.id, "Low-priority CFO task", { value: 1, estCostUsd: 1 });
    assert.equal(platform.scheduler.tick(), 1);
    await platform.runs.idle();
    assert.equal(platform.tasks.get(cfoTask.id)!.status, "done");
    // SQL exclusion: paused/terminated assignees never fill a page.
    platform.org.pauseAgent(cto.id);
    const page = platform.repos.tasks.ready({ limit: 10 });
    assert.ok(page.every((task) => task.assigneeId !== cto.id));
  } finally {
    await t.close();
  }
});

test("F7 destroy: a manager's in-flight task is re-assigned through TaskService (run aborted, attempt refunded, run state cleaned)", async () => {
  const hold = gate();
  let late: (() => void) | null = null;
  const t: TestApp = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger !== "message" && ctx.agent.roleId === "cto") {
        ctx.platform.tasks.patchState(ctx.input.task.id, { checkpoint: { block: "metacognition.confidence", reason: "x", at: "now", wm: { problem: "cto scratch" } } });
        late = () => ctx.platform.agents.setActivity(ctx.agent.id, "thinking", "still unwinding", null);
        await hold.promise;
      }
      return done("handled");
    },
  });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const cto = t.agentByRole("cto");
    for (const r of platform.org.directReports(cto.id)) platform.org.destroyAgent(r.id);
    const task = rootTask(t, cto.id, "Architecture review");
    platform.scheduler.tick();
    await waitFor("CTO run", () => platform.tasks.get(task.id)!.status === "in_progress" && late);
    assert.equal(platform.tasks.get(task.id)!.attempts, 1);
    const result = platform.org.destroyAgent(cto.id);
    assert.equal(result.reassignedTasks, 1);
    assert.equal(result.cancelledRuns, 1);
    const moved = platform.tasks.get(task.id)!;
    assert.equal(moved.assigneeId, ceo.id);
    assert.equal(moved.departmentId, ceo.departmentId);
    assert.equal(moved.status, "todo");
    assert.equal(moved.attempts, 0, "the aborted attempt is refunded");
    assert.equal(moved.state.checkpoint, undefined, "the old assignee's checkpoint is not handed on");
    assert.equal(moved.state.nextTrigger, "task");
    assert.equal((moved.state.reassigned as { from: string }).from, cto.id);
    hold.open();
    await platform.runs.idle();
    late!();
    assert.equal(platform.org.getAgent(cto.id)!.status, "terminated");
    await t.drain();
    const final = platform.tasks.get(task.id)!;
    assert.equal(final.status, "done");
    const runs = platform.repos.runs.list({ taskId: task.id });
    assert.equal(runs.find((r) => r.agentId === cto.id)!.status, "cancelled");
    assert.equal(runs.find((r) => r.agentId === ceo.id)!.trigger, "task");
  } finally {
    hold.open();
    await t.close();
  }
});

test("F7 destroy: waiting and blocked tasks keep their status (their wake-ups still fire) under the new assignee", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const cmo = t.agentByRole("cmo");
    const worker = platform.org.directReports(cmo.id)[0]!;
    for (const r of platform.org.directReports(cmo.id)) if (r.id !== worker.id) platform.org.destroyAgent(r.id);
    const parent = rootTask(t, cmo.id, "Campaign");
    platform.tasks.begin(parent.id, "task");
    platform.tasks.createSubtask({ parent: platform.tasks.get(parent.id), traceId: parent.traceId, assigneeId: worker.id, createdBy: cmo.id, title: "Draft", description: "d" });
    platform.tasks.waitOnChildren(parent.id, { checkpoint: { block: "x" } });
    platform.org.destroyAgent(cmo.id);
    const moved = platform.tasks.get(parent.id)!;
    assert.equal(moved.status, "waiting");
    assert.equal(moved.assigneeId, ceo.id);
    assert.equal(moved.state.checkpoint, undefined);
    assert.equal(platform.org.getAgent(worker.id)!.managerId, ceo.id);
    await t.drain();
    assert.equal(platform.tasks.get(parent.id)!.status, "done", "the child finished and woke the inherited parent");
  } finally {
    await t.close();
  }
});

test("F8 redaction: the approval.decided event and the prompt-facing answeredApproval carry the redacted note", async () => {
  const KEY = "sk-ABCDEFGHIJKLMNOPQRSTUVWX1234";
  const t = await createTestApp({
    brain: (ctx) => (ctx.input.trigger === "human_answer" ? done(`answer was: ${ctx.input.answeredApproval?.note}`) : { outcome: "waiting", output: "w" }),
  });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const events: string[] = [];
    platform.bus.subscribe((e) => {
      if (e.type === "approval.decided") events.push(JSON.stringify(e));
    });
    const task = rootTask(t, ceo.id, "x");
    const a = platform.approvals.create({ kind: "question", requestedBy: ceo.id, taskId: task.id, summary: "q?" });
    platform.tasks.begin(task.id, "task");
    platform.tasks.block(task.id, a.id, { plan: { secret: `token ${KEY}` }, nested: [{ deep: KEY }] });
    assert.ok(!JSON.stringify(platform.tasks.get(task.id)!.state).includes(KEY), "block() merge is redacted too");
    platform.approvals.decide(a.id, { decision: "approved", note: `use ${KEY}` });
    await t.drain();
    assert.equal(events.length, 1);
    assert.ok(!events[0]!.includes(KEY));
    const final = platform.tasks.get(task.id)!;
    assert.equal(final.status, "done");
    assert.ok(final.result!.includes("[REDACTED]") && !final.result!.includes(KEY));
  } finally {
    await t.close();
  }
});

test("F9 web_fetch: every redirect hop is re-checked, at most 5 hops, and address classification covers the IPv6 embeddings", async () => {
  const lookup = async (host: string) => (host === "private.example" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "93.184.215.14", family: 4 }]);
  const fetched: string[] = [];
  const redirectTo = (target: (n: number) => string) =>
    createWebFetch({
      lookup,
      fetch: async (input, init) => {
        assert.equal(init?.redirect, "manual");
        fetched.push(String(input));
        return new Response(null, { status: 302, headers: { location: target(fetched.length) } });
      },
    });
  const ctx = { signal: new AbortController().signal } as never;
  const toMetadata = await redirectTo(() => "http://private.example/latest/meta-data").run({ url: "http://public.example/" }, ctx);
  assert.equal(toMetadata.ok, false);
  assert.match(toMetadata.content, /Redirect refused/);
  assert.deepEqual(fetched, ["http://public.example/"], "the private hop was never requested");
  fetched.length = 0;
  const literal = await redirectTo(() => "http://[::ffff:a9fe:a9fe]/").run({ url: "http://public.example/" }, ctx);
  assert.equal(literal.ok, false);
  fetched.length = 0;
  const loop = await redirectTo((n) => `http://public.example/${n}`).run({ url: "http://public.example/0" }, ctx);
  assert.equal(loop.ok, false);
  assert.match(loop.content, /Too many redirects/);
  assert.equal(fetched.length, WEB_FETCH_MAX_REDIRECTS + 1);
  for (const ip of ["127.0.0.1", "10.1.2.3", "100.64.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:0:127.0.0.1", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "not-an-ip"]) {
    assert.ok(isPrivateAddress(ip), `${ip} is private`);
  }
  for (const ip of ["93.184.215.14", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.ok(!isPrivateAddress(ip), `${ip} is public`);
});

test("F10 org: create/update validation — unknown tier/profile/department/manager, bad budgets and cycles are 400", async () => {
  const t = await createTestApp();
  try {
    const { org } = t.app.platform;
    const cto = t.agentByRole("cto");
    const ceo = t.agentByRole("ceo");
    const worker = org.directReports(cto.id)[0]!;
    const bad = (input: Record<string, unknown>) =>
      assert.throws(() => org.updateAgent(cto.id, input as never), (e: Error) => e instanceof AppError && e.status === 400, JSON.stringify(input));
    bad({ modelTier: "bogus" });
    bad({ modelOverride: "nope:model" });
    bad({ monthlyBudgetUsd: -1 });
    bad({ monthlyBudgetUsd: Number.NaN });
    bad({ monthlyBudgetUsd: Number.POSITIVE_INFINITY });
    bad({ monthlyBudgetUsd: "5" });
    bad({ departmentId: "dep_missing" });
    bad({ managerId: "agt_missing" });
    bad({ managerId: worker.id }); // cycle: the CTO under its own report
    assert.throws(() => org.updateAgent(ceo.id, { managerId: cto.id }), (e: Error) => e instanceof AppError && e.status === 400);
    assert.equal(org.getAgent(cto.id)!.modelTier, "frontier", "nothing was applied");
    assert.equal(org.updateAgent(cto.id, { modelTier: "standard", modelOverride: "fake", monthlyBudgetUsd: 0 }).modelTier, "standard");
    assert.throws(() => org.createAgent({ title: "X", tier: "boss" as never, managerId: cto.id }, "human"), (e: Error) => e instanceof AppError && e.status === 400);
    assert.throws(() => org.createAgent({ title: "X", modelTier: "ultra" as never, managerId: cto.id }, "human"), (e: Error) => e instanceof AppError && e.status === 400);
  } finally {
    await t.close();
  }
});

test("F10 runs: a message run that throws after its row was inserted fails cleanly (status, spans, reply, agent freed)", async () => {
  let explode = true;
  const t = await createTestApp({
    overrides: {
      createRouter: () => ({
        resolve: () => {
          if (explode) throw new Error("profile table corrupted");
          return { id: "fake", provider: "mock", model: "fake", tier: "economy", inputPerMTokUsd: 0, outputPerMTokUsd: 0, cachedInputPerMTokUsd: null, contextWindow: 128_000, supportsTools: true };
        },
        chat: () => Promise.reject(new Error("unused")),
        tierForStage: () => "economy",
        isLive: () => false,
      }),
    },
  });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const dm = platform.conversations.directMessage(ceo);
    const message = platform.conversations.postHuman(dm.id, "status?");
    assert.equal(platform.runs.startMessageRun(message), null);
    const run = platform.repos.runs.list({ agentId: ceo.id, limit: 1 })[0]!;
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /profile table corrupted/);
    assert.ok(run.completedAt);
    assert.equal(platform.repos.spans.runningForRun(run.id).length, 0, "no span left running");
    const root = platform.repos.spans.get(run.rootSpanId)!;
    assert.equal(root.status, "error");
    assert.equal(platform.repos.spans.get(root.parentSpanId!)!.status, "error", "the chat objective span is closed");
    const reply = platform.conversations.messages(dm.id).find((m) => m.senderId === ceo.id)!;
    assert.match(reply.content, /I hit an error: could not start the run: profile table corrupted/);
    assert.equal(platform.runs.isBusy(ceo.id), false);
    assert.equal(platform.org.getAgent(ceo.id)!.currentRunId, null);
    // The message is answered (no retry loop); the next one works once the fault is gone.
    explode = false;
    platform.conversations.postHuman(dm.id, "again?");
    await t.drain();
    assert.ok(platform.conversations.messages(dm.id).some((m) => m.senderId === ceo.id && m.content.startsWith("Reply from")));
  } finally {
    await t.close();
  }
});

test("F12 runs: an aborted engine's late status writes and span ends are ignored (one span.ended per span)", async () => {
  const hold = gate();
  let unwound: Promise<void> | null = null;
  let finish!: () => void;
  const t = await createTestApp({
    reflex: (ctx) => {
      unwound = new Promise<void>((resolve) => (finish = resolve));
      const step = ctx.span.child({ kind: "stage", name: "slow step" });
      return hold.promise.then(() => {
        // The run was interrupted meanwhile; this is the engine still unwinding.
        ctx.platform.agents.setActivity(ctx.agent.id, "acting", "late write", null);
        ctx.platform.tasks.patchState((ctx.input as { task: { id: string } }).task.id, { late: true });
        step.end({ status: "ok", output: "late ok" });
        ctx.span.end({ status: "ok", output: "late root ok" });
        finish();
        return done("too late");
      });
    },
  });
  try {
    const { platform } = t.app;
    const worker = t.agentByRole("backend-engineer");
    const ended: string[] = [];
    platform.bus.subscribe((e) => {
      if (e.type === "span.ended") ended.push((e.data as { id: string }).id);
    });
    const task = rootTask(t, worker.id, "Slow job");
    platform.scheduler.tick();
    await waitFor("run", () => platform.runs.isBusy(worker.id));
    const runId = platform.repos.runs.list({ agentId: worker.id, limit: 1 })[0]!.id;
    const cancelled = await platform.runs.cancelRun(runId);
    assert.equal(cancelled!.status, "cancelled");
    assert.equal(platform.org.getAgent(worker.id)!.status, "idle");
    hold.open();
    await unwound;
    assert.equal(platform.org.getAgent(worker.id)!.status, "idle", "late setActivity ignored");
    assert.equal(platform.org.getAgent(worker.id)!.activity, null);
    assert.equal(platform.tasks.get(task.id)!.state.late, undefined, "late patchState ignored");
    assert.equal(platform.tasks.get(task.id)!.status, "cancelled");
    const root = platform.repos.spans.get(cancelled!.rootSpanId)!;
    assert.equal(root.status, "cancelled", "first end wins");
    const step = platform.repos.spans.byRun(runId).find((s) => s.name === "slow step")!;
    assert.equal(step.status, "cancelled", "closed by RunService; the engine's late ok is ignored");
    assert.equal(step.output, null);
    assert.equal(new Set(ended).size, ended.length, "no span emitted span.ended twice");
  } finally {
    hold.open();
    await t.close();
  }
});
