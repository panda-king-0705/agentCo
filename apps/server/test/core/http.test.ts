import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  Agent, Conversation, DestroyAgentResult, Message, PostMessageResult, RunDetail, Run, TraceDetail, ApiError, OrgResponse, CompanySnapshot,
} from "../../../../packages/shared/src/index.ts";
import { buildRouter } from "../../src/http/routes.ts";
import { api, createTestApp } from "./helpers/harness.ts";

const live = { overrides: { autoStart: true }, listen: true } as const;

test("HTTP smoke: create agent → DM with a fake engine → message, run and spans via the API → pause/resume → destroy", async () => {
  const t = await createTestApp(live);
  try {
    const org = (await api<OrgResponse>(t.url, "/api/org")).body;
    const cto = org.agents.find((a) => a.roleId === "cto") as Agent;
    assert.ok(org.departments.length >= 6 && org.agents.length >= 12);

    const created = await api<Agent>(t.url, "/api/agents", { method: "POST", body: { title: "Social Media Specialist", departmentId: cto.departmentId, managerId: cto.id, tier: "worker", mandate: "Draft posts." } });
    assert.equal(created.status, 201);
    const agent = created.body;
    assert.equal(agent.cognition, "reflex");
    assert.ok(agent.persona.baZi && agent.persona.baZi.pillars.length === 4, "persona.baZi is cast at creation");
    assert.ok(agent.persona.personalityType, "every agent has a personality type");

    const dm = (await api<Conversation>(t.url, "/api/conversations", { method: "POST", body: { agentId: agent.id } })).body;
    assert.equal(dm.kind, "dm");
    const again = (await api<Conversation>(t.url, "/api/conversations", { method: "POST", body: { agentId: agent.id } })).body;
    assert.equal(again.id, dm.id, "get-or-create");

    const posted = (await api<PostMessageResult>(t.url, `/api/conversations/${dm.id}/messages`, { method: "POST", body: { content: "Hi! What is your job here?" } })).body;
    assert.ok(posted.message.id);
    assert.ok(posted.runId, "an idle agent starts the run immediately");
    const messages = await pollMessages(t.url, dm.id, (m) => m.some((x) => x.senderId === agent.id));
    const answer = messages.find((m) => m.senderId === agent.id) as Message;
    assert.equal(answer.content, "Reply from " + agent.name + ": Hi! What is your job here?");
    assert.equal(answer.runId, posted.runId);

    const detail = (await api<RunDetail>(t.url, `/api/runs/${posted.runId}`)).body;
    assert.equal(detail.run.status, "completed");
    assert.equal(detail.run.trigger, "message");
    assert.ok(detail.spans.some((s) => s.kind === "run" && s.id === detail.run.rootSpanId));
    const runs = (await api<Run[]>(t.url, `/api/runs?agentId=${agent.id}`)).body;
    assert.equal(runs.length, 1);
    const trace = (await api<TraceDetail>(t.url, `/api/traces/${detail.run.traceId}`)).body;
    assert.equal(trace.summary.status, "ok");
    assert.match(trace.summary.title, /^chat: Hi!/);
    assert.ok(trace.spans.some((s) => s.kind === "objective"));

    const paused = (await api<Agent>(t.url, `/api/agents/${agent.id}/pause`, { method: "POST" })).body;
    assert.equal(paused.status, "paused");
    const resumed = (await api<Agent>(t.url, `/api/agents/${agent.id}/resume`, { method: "POST" })).body;
    assert.notEqual(resumed.status, "paused");
    const patched = (await api<Agent>(t.url, `/api/agents/${agent.id}`, { method: "PATCH", body: { title: "Social Lead" } })).body;
    assert.equal(patched.title, "Social Lead");

    const destroyed = (await api<DestroyAgentResult>(t.url, `/api/agents/${agent.id}`, { method: "DELETE" })).body;
    assert.equal(destroyed.agentId, agent.id);
    const list = (await api<Agent[]>(t.url, "/api/agents")).body;
    assert.equal(list.find((a) => a.id === agent.id)?.status, "terminated");
    const ceo = org.agents.find((a) => a.roleId === "ceo") as Agent;
    assert.equal((await api<ApiError>(t.url, `/api/agents/${ceo.id}`, { method: "DELETE" })).status, 409);
  } finally {
    await t.close();
  }
});

async function pollMessages(base: string, conversationId: string, ok: (m: Message[]) => boolean): Promise<Message[]> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const messages = (await api<Message[]>(base, `/api/conversations/${conversationId}/messages`)).body;
    if (ok(messages)) return messages;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out polling messages");
}

test("a Board request to the Boardroom flows through the API: task, approvals, blackboard, metrics, events", async () => {
  const t = await createTestApp({ ...live, brain: (ctx) => ({ outcome: "completed", output: ctx.input.trigger === "message" ? "On it." : `Done: ${ctx.input.task.title}` }) });
  try {
    const company = (await api<CompanySnapshot>(t.url, "/api/company")).body;
    assert.ok(company.headcount >= 12 && company.settings.paused === false && company.models.live === false);
    const task = (await api<{ id: string; traceId: string }>(t.url, "/api/tasks", { method: "POST", body: { title: "Write the memo", description: "Two paragraphs." } })).body;
    const finished = await waitForTask(t.url, task.id, "done");
    assert.equal(finished.task.result, "Done: Write the memo");
    assert.equal(finished.runs.length, 1);
    assert.equal(finished.assignee?.roleId, "ceo", "tasks default to the CEO");

    assert.equal((await api<unknown>(t.url, "/api/tasks", { method: "POST", body: { title: "", description: "x" } })).status, 400);
    assert.equal((await api<unknown>(t.url, "/api/tasks/nope")).status, 404);
    assert.equal((await api<unknown>(t.url, "/api/tasks/" + task.id + "/cancel", { method: "POST" })).status, 409, "a finished task cannot be cancelled");

    const put = await api<{ key: string; value: string; updatedBy: string }>(t.url, "/api/blackboard/priorities", { method: "PUT", body: { value: "Ship the memo" } });
    assert.equal(put.body.updatedBy, "human");
    assert.ok((await api<{ key: string }[]>(t.url, "/api/blackboard")).body.some((e) => e.key === "priorities"));
    assert.equal((await api<unknown>(t.url, "/api/blackboard/x", { method: "PUT", body: { value: 3 } })).status, 400);

    const overview = (await api<{ runs24h: number; tasksByStatus: Record<string, number>; agentsByStatus: Record<string, number> }>(t.url, "/api/metrics/overview")).body;
    assert.ok(overview.runs24h >= 1 && (overview.tasksByStatus.done ?? 0) >= 1 && (overview.agentsByStatus.idle ?? 0) >= 1);
    const series = (await api<{ t: string; value: number }[]>(t.url, "/api/metrics/timeseries?metric=runs&hours=6")).body;
    assert.equal(series.length, 6);
    assert.ok(series.reduce((a, p) => a + p.value, 0) >= 1);
    assert.equal((await api<unknown>(t.url, "/api/metrics/timeseries?metric=bogus")).status, 400);

    const events = (await api<{ seq: number; type: string }[]>(t.url, "/api/events?since=0&limit=1000")).body;
    assert.ok(events.length > 5 && events.every((e, i) => i === 0 || e.seq > (events[i - 1]?.seq ?? 0)));
    assert.ok(["task.created", "run.started", "run.completed", "span.ended"].every((type) => events.some((e) => e.type === type)));

    // the company kill switch over HTTP
    const paused = (await api<CompanySnapshot>(t.url, "/api/company/pause", { method: "POST" })).body;
    assert.equal(paused.settings.paused, true);
    const t2 = (await api<{ id: string }>(t.url, "/api/tasks", { method: "POST", body: { title: "Held", description: "while paused" } })).body;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await api<{ task: { status: string } }>(t.url, `/api/tasks/${t2.id}`)).body.task.status, "todo");
    await api<unknown>(t.url, "/api/company/resume", { method: "POST" });
    await waitForTask(t.url, t2.id, "done");
  } finally {
    await t.close();
  }
});

async function waitForTask(base: string, id: string, status: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const detail = (await api<{ task: { status: string; result: string | null }; runs: unknown[]; assignee: Agent | null }>(base, `/api/tasks/${id}`)).body;
    if (detail.task.status === status) return detail;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`task ${id} never reached ${status}`);
}

test("every route the console calls exists in the API", async () => {
  const t = await createTestApp();
  try {
    const web = readFileSync(resolve(import.meta.dirname, "../../../web/src/api.ts"), "utf8");
    const block = /ROUTES_USED = \[([\s\S]*?)\] as const/.exec(web)?.[1] ?? "";
    const routes = [...block.matchAll(/"([A-Z]+) (\/api\/[^" ]+)/g)].map((m) => [m[1] as string, m[2] as string] as const);
    assert.ok(routes.length > 30, `parsed ${routes.length} routes from the console`);
    const router = buildRouter(t.app.platform);
    for (const [method, path] of routes) {
      if (path === "/api/events/stream") continue; // wired by the server (SSE)
      const match = router.match(method, path.replace(/:\w+/g, "x"));
      assert.ok(match && match !== "method_not_allowed", `${method} ${path} is routed`);
    }
  } finally {
    await t.close();
  }
});

test("auth: bearer token required off loopback (health stays open); CORS only for the Vite dev origin", async () => {
  const token = "t".repeat(32);
  const t = await createTestApp({ listen: true, config: { authRequired: true, authToken: token } });
  try {
    assert.equal((await api<ApiError>(t.url, "/api/org")).status, 401);
    assert.equal((await api<ApiError>(t.url, "/api/org", { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await api<unknown>(t.url, "/api/org", { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await api<unknown>(t.url, "/api/health")).status, 200);
    assert.equal((await api<ApiError>(t.url, "/api/org")).body.error.code, "unauthorized");
    const preflight = await fetch(t.url + "/api/org", { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const evil = await fetch(t.url + "/api/health", { headers: { origin: "http://evil.example" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  } finally {
    await t.close();
  }
});

test("errors are { error: { code, message } }; unknown routes 404; bad JSON 400; wrong method 405", async () => {
  const t = await createTestApp({ listen: true });
  try {
    const missing = await api<ApiError>(t.url, "/api/nope");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "not_found");
    const raw = await fetch(t.url + "/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(raw.status, 400);
    assert.equal(((await raw.json()) as ApiError).error.code, "validation_error");
    assert.equal((await api<ApiError>(t.url, "/api/org", { method: "POST", body: {} })).status, 405);
    assert.equal((await api<ApiError>(t.url, "/api/agents", { method: "POST", body: { roleId: "no-such-role" } })).status, 400);
    assert.equal((await api<ApiError>(t.url, "/api/approvals/x/decide", { method: "POST", body: { decision: "maybe" } })).status, 400);
  } finally {
    await t.close();
  }
});

test("static console: friendly page when dist is missing; SPA fallback and asset serving when built; no traversal", async () => {
  const dist = mkdtempSync(join(tmpdir(), "agentco-dist-"));
  const missing = await createTestApp({ listen: true, config: { webDistDir: join(dist, "nope") } });
  try {
    const page = await (await fetch(missing.url + "/")).text();
    assert.match(page, /npm run build:web/);
    assert.equal((await fetch(missing.url + "/some/route")).status, 200);
  } finally {
    await missing.close();
  }
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>console</title><div id=root></div>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log('app')");
  const built = await createTestApp({ listen: true, config: { webDistDir: dist } });
  try {
    assert.match(await (await fetch(built.url + "/")).text(), /id=root/);
    assert.match(await (await fetch(built.url + "/org/chart/deep")).text(), /id=root/, "client-side routes fall back to index.html");
    const js = await fetch(built.url + "/assets/app.js");
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.equal((await fetch(built.url + "/assets/missing.js")).status, 404);
    const traversal = await (await fetch(built.url + "/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd")).text();
    assert.ok(!traversal.includes("root:"), "path traversal is contained");
    assert.equal((await api<unknown>(built.url, "/api/health")).status, 200);
  } finally {
    await built.close();
    rmSync(dist, { recursive: true, force: true });
  }
});
