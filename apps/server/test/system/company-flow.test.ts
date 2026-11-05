/**
 * System test: boots the real server (real engines, mock provider, fresh
 * SQLite) as a child process and drives it only through the public HTTP API.
 *
 * Covers FR-1..FR-11 end to end:
 *   Board message → CEO objective → delegation to C-suite → delegation to
 *   workers → workers complete → managers evaluate → CEO reports back in the
 *   Boardroom; one trace spans every agent; spend lands on cheap tiers.
 * Then create → DM → pause → destroy an agent from the "console".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  Agent,
  CompanyEvent,
  Conversation,
  DestroyAgentResult,
  Message,
  MetricsOverview,
  OrgResponse,
  PostMessageResult,
  Task,
  TraceDetail,
  TraceSummary,
} from "../../../../packages/shared/src/index.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const SERVER = join(ROOT, "apps/server/src/index.ts");

let child: ChildProcess;
let base = "";
let dataDir = "";
let logs = "";

async function freePort(): Promise<number> {
  return await new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => ok(port));
    });
  });
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(base + path, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? {} : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function waitFor<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last error: ${String(last)})` : ""}\n--- server log tail ---\n${logs.slice(-4000)}`);
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "agentco-system-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Strip provider keys so every tier resolves to the deterministic mock.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/_API_KEY$/.test(key) || key.startsWith("MODEL_")) delete env[key];
  }
  Object.assign(env, {
    PORT: String(port),
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    ORG_TEMPLATE: "startup",
    MOCK_LATENCY_MS: "0",
    DAILY_BUDGET_USD: "50",
    MONTHLY_BUDGET_USD: "500",
    HEARTBEAT_MINUTES: "0",
  });
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SERVER], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => (logs += String(d)));
  child.stderr?.on("data", (d) => (logs += String(d)));
  await waitFor("server health", async () => (await fetch(base + "/api/health")).ok);
});

after(() => {
  child?.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
});

test("the startup org is a real company: Board → CEO → C-suite → workers", async () => {
  const org = await api<OrgResponse>("/api/org");
  const ceo = org.agents.find((a) => a.roleId === "ceo");
  assert.ok(ceo, "a CEO exists");
  assert.equal(ceo.managerId, null, "the CEO reports to the human Board");
  assert.ok(org.departments.length >= 6, `departments: ${org.departments.length}`);
  assert.ok(org.agents.length >= 12, `headcount: ${org.agents.length}`);
  const execs = org.agents.filter((a) => a.tier === "executive");
  const workers = org.agents.filter((a) => a.tier === "worker");
  assert.ok(execs.length >= 5, "several C-level executives");
  assert.ok(workers.length >= 5, "several workers");
  for (const a of execs) assert.equal(a.cognition, "brain", `${a.title} uses the brain engine`);
  for (const a of workers) assert.equal(a.cognition, "reflex", `${a.title} uses the reflex engine`);
  for (const a of workers) assert.equal(a.modelTier, "economy", `${a.title} runs on the economy tier`);
  for (const a of org.agents) if (a.managerId) assert.ok(org.agents.some((m) => m.id === a.managerId), `${a.title}'s manager exists`);
});

test("a Boardroom request flows down the org and the CEO reports back", async () => {
  const conversations = await api<Conversation[]>("/api/conversations");
  const boardroom = conversations.find((c) => c.kind === "boardroom");
  assert.ok(boardroom, "a Boardroom conversation exists");

  const posted = await api<PostMessageResult>(`/api/conversations/${boardroom.id}/messages`, {
    method: "POST",
    body: { content: "Plan and prepare the launch of our first product, an AI meeting-notes app. Write a launch plan with marketing, engineering and finance input." },
  });
  assert.ok(posted.message.id);

  // The CEO turns the request into an objective it owns.
  const objective = await waitFor("an objective task from the Boardroom", async () => {
    const tasks = await api<Task[]>("/api/tasks");
    return tasks.find((t) => t.parentTaskId === null && t.originConversationId === boardroom.id) ?? null;
  });

  // …which completes once every delegated subtask is done.
  const finished = await waitFor("the objective to finish", async () => {
    const t = (await api<{ task: Task }>(`/api/tasks/${objective.id}`)).task;
    return t.status === "done" || t.status === "failed" ? t : null;
  }, 120_000);
  assert.equal(finished.status, "done", `objective ended ${finished.status}: ${finished.error ?? ""}`);

  const all = await api<Task[]>(`/api/tasks?rootTaskId=${objective.id}`);
  const children = all.filter((t) => t.parentTaskId === objective.id);
  const grandchildren = all.filter((t) => children.some((c) => c.id === t.parentTaskId));
  assert.ok(children.length >= 1, "the CEO delegated to the C-suite");
  assert.ok(grandchildren.length >= 1, "executives delegated to their teams");
  assert.ok(all.every((t) => t.traceId === objective.traceId), "one objective is one trace");

  // The trace crosses agents and carries the brain stages, model calls and delegations.
  const trace = await api<TraceDetail>(`/api/traces/${objective.traceId}`);
  const agentsInTrace = new Set(trace.spans.map((s) => s.agentId).filter(Boolean));
  assert.ok(agentsInTrace.size >= 3, `agents in trace: ${agentsInTrace.size}`);
  const names = new Set(trace.spans.map((s) => s.name));
  for (const stage of ["brain.target_understanding", "brain.planning", "brain.evaluation"]) {
    assert.ok(names.has(stage), `trace has ${stage}`);
  }
  assert.ok(trace.spans.some((s) => s.kind === "delegation"), "delegation spans present");
  assert.ok(trace.spans.some((s) => s.kind === "llm" && (s.costUsd ?? 0) > 0), "priced llm spans present");
  // Delegation spans parent the delegate's run span (cross-agent tree).
  const delegation = trace.spans.find((s) => s.kind === "delegation");
  assert.ok(delegation);
  assert.ok(trace.spans.some((s) => s.kind === "run" && s.parentSpanId === delegation.id), "a run hangs under a delegation span");
  // No orphan parents inside the trace.
  const ids = new Set(trace.spans.map((s) => s.id));
  for (const s of trace.spans) if (s.parentSpanId) assert.ok(ids.has(s.parentSpanId), `span ${s.name} has its parent in the trace`);

  const summaries = await api<TraceSummary[]>("/api/traces");
  assert.ok(summaries.some((s) => s.traceId === objective.traceId && s.costUsd > 0));

  // The final report lands in the Boardroom.
  const report = await waitFor("the CEO's report in the Boardroom", async () => {
    const messages = await api<Message[]>(`/api/conversations/${boardroom.id}/messages`);
    return messages.find((m) => m.taskId === objective.id && m.senderId !== "human" && m.senderId !== "system" && m.content.length > 40) ?? null;
  });
  assert.ok(report.content.length > 40);

  // Cost lands on cheap tiers too, and routing saved money vs all-frontier.
  const metrics = await api<MetricsOverview>("/api/metrics/overview");
  assert.ok(metrics.spendByTier.economy > 0, "workers spent on the economy tier");
  assert.ok(metrics.routingSavingsUsd > 0, "cascade routing saved money vs frontier-only");
  assert.ok(metrics.spentTodayUsd > 0);
});

test("the console can create, chat with, pause and destroy an agent", async () => {
  const org = await api<OrgResponse>("/api/org");
  const cmo = org.agents.find((a) => a.roleId === "cmo") ?? org.agents.find((a) => a.tier === "executive" && a.roleId !== "ceo");
  assert.ok(cmo);
  const hired = await api<Agent>("/api/agents", {
    method: "POST",
    body: { title: "Social Media Specialist", departmentId: cmo.departmentId, managerId: cmo.id, tier: "worker", cognition: "reflex", modelTier: "economy", mandate: "Draft short social posts for launches." },
  });
  assert.equal(hired.managerId, cmo.id);
  assert.equal(hired.cognition, "reflex");

  const dm = await api<Conversation>("/api/conversations", { method: "POST", body: { agentId: hired.id } });
  await api<PostMessageResult>(`/api/conversations/${dm.id}/messages`, { method: "POST", body: { content: "Hi! What is your job here?" } });
  const reply = await waitFor("a DM reply", async () => {
    const messages = await api<Message[]>(`/api/conversations/${dm.id}/messages`);
    return messages.find((m) => m.senderId === hired.id) ?? null;
  });
  assert.ok(reply.content.length > 0);

  const paused = await api<Agent>(`/api/agents/${hired.id}/pause`, { method: "POST" });
  assert.equal(paused.status, "paused");
  const resumed = await api<Agent>(`/api/agents/${hired.id}/resume`, { method: "POST" });
  assert.notEqual(resumed.status, "paused");

  const destroyed = await api<DestroyAgentResult>(`/api/agents/${hired.id}`, { method: "DELETE" });
  assert.equal(destroyed.agentId, hired.id);
  const after = await api<Agent[]>("/api/agents");
  const gone = after.find((a) => a.id === hired.id);
  assert.ok(!gone || gone.status === "terminated", "destroyed agent is terminated (kept for audit) or hidden");

  // The CEO cannot be destroyed while it has reports.
  const ceo = org.agents.find((a) => a.roleId === "ceo");
  assert.ok(ceo);
  const response = await fetch(`${base}/api/agents/${ceo.id}`, { method: "DELETE" });
  assert.equal(response.status, 409);
});

test("the event log replays for the live dashboard", async () => {
  const events = await api<CompanyEvent[]>("/api/events?since=0&limit=500");
  assert.ok(events.length > 10);
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    assert.ok(prev && cur && cur.seq > prev.seq, "events are strictly ordered by seq");
  }
  const types = new Set(events.map((e) => e.type));
  for (const t of ["run.started", "run.completed", "task.created", "message.created", "span.ended"]) {
    assert.ok(types.has(t as CompanyEvent["type"]), `event type ${t} emitted`);
  }
  // SSE: connect with Last-Event-ID and read the replayed backlog.
  const lastSeq = events.at(-20)?.seq ?? 0;
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events/stream`, { headers: { "Last-Event-ID": String(lastSeq) }, signal: controller.signal });
  assert.equal(response.headers.get("content-type")?.split(";")[0], "text/event-stream");
  const reader = response.body!.getReader();
  let buffer = "";
  const deadline = Date.now() + 5000;
  while (!buffer.includes("\n\n") || !/^id: \d+/m.test(buffer)) {
    if (Date.now() > deadline) break;
    const { value, done } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
  }
  controller.abort();
  const firstId = Number(/^id: (\d+)/m.exec(buffer)?.[1]);
  assert.ok(firstId > lastSeq, `SSE replays events after Last-Event-ID (${lastSeq} → ${firstId})`);
});
