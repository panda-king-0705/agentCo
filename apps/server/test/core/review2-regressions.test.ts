// Review 2 regressions (core): compaction order, message runs vs maxConcurrentRuns, routing savings
// window, SSE replay (paging, ahead-of-head, backpressure, client cap, slim span events).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompanyEvent } from "../../../../packages/shared/src/index.ts";
import { ContextGovernor } from "../../src/memory/compaction.ts";
import { SseBroadcaster } from "../../src/http/sse.ts";
import { api, createTestApp, done, gate, rootTask, waitFor } from "./helpers/harness.ts";

// ───────────────────────────── compaction ─────────────────────────────

// The compaction checkpoint's throughIndex is an index into historyThrough(trigger message).
// If an OLDER pending message is answered after a newer one already folded the conversation
// (route handler starts the new message while the old one waits for the scheduler), the view
// must still end with the triggering message and never summarise messages after it.
test("R2 compaction: user message stays last even when an older message is governed after a fold", () => {
  const store = new Map<string, unknown>();
  const settings = { get: (k: string, d: unknown) => (store.has(k) ? store.get(k) : d), set: (k: string, v: unknown) => store.set(k, v), has: (k: string) => store.has(k) } as any;
  const conv = { id: "cnv_1", kind: "boardroom", title: "Boardroom" } as any;
  const msgs = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, conversationId: "cnv_1", senderId: i % 2 ? "agt_ceo" : "human", content: `message ${i} ` + "x".repeat(400), runId: null, taskId: null, traceId: null, readAt: null, createdAt: new Date(2026, 0, 1, 0, i).toISOString() }));
  const dir = mkdtempSync(join(tmpdir(), "cmp-"));
  const g = new ContextGovernor(settings, { dataDir: dir, triggerPct: 0.7, carryTurns: 6 }, () => new Date());
  const newer = g.govern(conv, msgs.slice(0, 19), 1000, null); // newest Board message m18 folds the conversation
  assert.equal(newer.messages.at(-1)!.id, "m18");
  const persisted = g.load("cnv_1")!;
  const older = g.govern(conv, msgs.slice(0, 11), 1000, null); // older pending Board message m10, answered next
  assert.equal(older.messages.at(-1)!.id, "m10", "the triggering message is not in the governed history");
  // The summary covers only messages before the triggering one (never m11..m18).
  const preamble = older.messages[0]!;
  assert.equal(preamble.senderId, "system");
  for (const later of ["message 11", "message 12", "message 18"]) assert.ok(!preamble.content.includes(later), `the summary must not describe ${later}`);
  assert.ok(older.messages.every((m) => m.id === preamble.id || Number(m.id.slice(1)) <= 10));
  // The persisted epoch is untouched (the newer conversation keeps its checkpoint).
  assert.deepEqual(g.load("cnv_1"), persisted);
  const again = g.govern(conv, msgs.slice(0, 19), 1000, null);
  assert.equal(again.messages.at(-1)!.id, "m18");
});

// ───────────────────────────── message runs vs capacity ─────────────────────────────

// POST /api/conversations/:id/messages used to start a run directly (RunService.startMessageRun),
// bypassing the scheduler's maxConcurrentRuns cap.
test("R2 runs: posting a Board message respects maxConcurrentRuns (queued, then answered by the scheduler)", async () => {
  const hold = gate();
  const t = await createTestApp({ listen: true, config: { maxConcurrentRuns: 1 } as never });
  try {
    const ceo = t.agentByRole("ceo");
    const other = t.app.platform.repos.agents.list().find((a) => a.id !== ceo.id && a.status !== "terminated")!;
    t.brain.script = t.reflex.script = async (ctx) => {
      if (ctx.input.trigger !== "message" && ctx.agent.id === other.id) await hold.promise;
      if (ctx.input.trigger === "message") await new Promise((r) => setTimeout(r, 200));
      return done();
    };
    rootTask(t, other.id, "Long work");
    t.app.platform.scheduler.tick();
    assert.equal(t.app.platform.runs.activeCount(), 1, "the only slot is taken");
    const conv = (await api<{ id: string }>(t.url, "/api/conversations", { method: "POST", body: { kind: "boardroom" } })).body;
    const posted = await api<{ runId: string | null; message: { id: string } }>(t.url, `/api/conversations/${conv.id}/messages`, { method: "POST", body: { content: "hello" } });
    const active = t.app.platform.runs.activeCount();
    assert.ok(posted.status >= 200 && posted.status < 300, "the post itself succeeds");
    assert.equal(posted.body.runId, null, "no capacity: the message stays queued");
    assert.ok(active <= 1, `${active} runs active with maxConcurrentRuns = 1`);
    hold.open();
    // The scheduler (queued chat first) answers it once the slot frees up.
    await waitFor("the queued message gets its run", () => {
      t.app.platform.scheduler.tick();
      return t.app.platform.repos.conversations.getMessage(posted.body.message.id)?.runId ?? null;
    });
    assert.ok(t.app.platform.runs.activeCount() <= 1);
  } finally {
    hold.open();
    await t.close();
  }
});

// ───────────────────────────── routing savings window ─────────────────────────────

// routingSavingsUsd summed the whole spend table (all time) while every spend figure next to it
// (spentMonthUsd, spendByTier) is this month; the Costs page divides one by the other.
test("R2 metrics: routing savings use the same window as the spend they are compared with", async () => {
  const t = await createTestApp();
  try {
    const repos = t.app.platform.repos;
    const ceo = t.agentByRole("ceo");
    const row = (at: string, cost: number, frontier: number) =>
      repos.spend.insert({ agentId: ceo.id, runId: "run_x", traceId: "trc_x", spanId: `spn_${at}`, taskId: null, provider: "mock", model: "m", profileId: "p", tier: "economy", stage: "s",
        inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: cost, frontierCostUsd: frontier, departmentId: ceo.departmentId, at });
    const lastYear = new Date(Date.now() - 400 * 86_400_000).toISOString();
    row(lastYear, 1, 101); // last year's savings: $100
    row(new Date().toISOString(), 1, 2); // this month: $1 spent, $1 saved
    const m = t.app.platform.metrics.overview();
    assert.equal(m.spentMonthUsd, 1);
    assert.equal(m.routingSavingsUsd, 1, "savings include spend from outside the month the page compares them with");
  } finally {
    await t.close();
  }
});

// ───────────────────────────── SSE ─────────────────────────────

function fakeBus(head: number) {
  let seq = head;
  const listeners = new Set<(e: any) => void>();
  const ev = (s: number) => ({ id: `e${s}`, seq: s, type: "task.updated", at: "", agentId: null, taskId: null, runId: null, traceId: null, summary: "x", data: null });
  return {
    since: (from: number, limit: number) => { const out = []; for (let s = from + 1; s <= Math.min(seq, from + Math.min(limit, 5000)); s++) out.push(ev(s)); return out; },
    subscribe: (l: (e: any) => void) => { listeners.add(l); return () => listeners.delete(l); },
    emit: () => { seq += 1; for (const l of listeners) l(ev(seq)); },
  };
}
function fakeRes(options: { full?: () => boolean } = {}) {
  const r = new EventEmitter() as any;
  r.ids = [] as number[];
  r.frames = [] as string[];
  r.writableLength = 0;
  r.status = 0;
  r.writeHead = (status: number) => { r.status = status; };
  r.write = (chunk: string) => { r.frames.push(chunk); for (const m of chunk.matchAll(/^id: (\d+)$/gm)) r.ids.push(Number(m[1])); return !(options.full?.() ?? false); };
  r.end = () => {};
  return r;
}
const connect = (sse: SseBroadcaster, lastId: string | null, res = fakeRes()) => {
  const req = new EventEmitter() as any; req.headers = lastId === null ? {} : { "last-event-id": lastId };
  sse.connect(req, res, new URLSearchParams());
  return res;
};
const gaps = (ids: number[]) => ids.slice(1).filter((id, i) => id !== ids[i]! + 1).length;

// Replay used to stop at MAX_REPLAY (5000) and silently skip the rest of the backlog.
// Assertion adjusted: replay is now asynchronous (paged, drain-aware), so the test waits for it to
// reach the live event instead of checking synchronously right after connect.
test("R2 SSE: reconnect 12000 events behind: paged replay up to the head, then live, no gap", async () => {
  const bus = fakeBus(12000);
  const res = connect(new SseBroadcaster(bus as any, 1e9), "0");
  bus.emit(); // seq 12001 lands while the replay is still paging: picked up, never skipped
  await waitFor("replay reaches the live event", () => res.ids.includes(12001));
  bus.emit(); // 12002, live
  const ids: number[] = res.ids;
  assert.equal(gaps(ids), 0, `gap in ${ids.length} ids`);
  assert.equal(ids[0], 1);
  assert.equal(ids.at(-1), 12002);
  assert.equal(new Set(ids).size, ids.length, "no duplicates");
});

// A Last-Event-ID ahead of the head (server restarted on a fresh DB) filtered every live event.
test("R2 SSE: Last-Event-ID ahead of the head (fresh DB after restart): treated as a new client, live events flow", () => {
  const bus = fakeBus(10); // new server, seq restarted
  const res = connect(new SseBroadcaster(bus as any, 1e9), "50000"); // browser's EventSource remembers the old server's id
  for (let i = 0; i < 20; i++) bus.emit();
  assert.deepEqual(res.ids, Array.from({ length: 20 }, (_, i) => 11 + i), "all 20 live events delivered, nothing replayed");
  assert.ok(res.frames.some((f: string) => f.startsWith("event: resync")), "the console is told to refetch its state");
});

test("R2 SSE: replay waits for drain (backpressure) instead of buffering the whole backlog", async () => {
  const bus = fakeBus(3000);
  let full = true;
  const res = fakeRes({ full: () => full });
  connect(new SseBroadcaster(bus as any, 1e9), "0", res);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(res.ids.length, 500, "one page written, then the replay waits for drain");
  full = false;
  res.emit("drain");
  await waitFor("replay finishes after drain", () => res.ids.length === 3000);
  assert.equal(gaps(res.ids), 0);
});

test("R2 SSE: concurrent streams are capped (503 beyond maxClients)", () => {
  const sse = new SseBroadcaster(fakeBus(0) as any, 1e9, { maxClients: 2 });
  const a = connect(sse, null);
  const b = connect(sse, null);
  const c = connect(sse, null);
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 503]);
  assert.equal(sse.clientCount, 2);
});

test("R2 SSE: span.* events carry a summary without the input/output previews", async () => {
  const t = await createTestApp({ listen: true });
  try {
    const span = t.app.platform.tracer.startSpan({ traceId: "trc_slim", parentSpanId: null, kind: "llm", name: "llm.chat", input: "secret-free prompt ".repeat(100) });
    span.end({ status: "ok", output: "a long answer ".repeat(100) });
    const events = (await api<CompanyEvent[]>(t.url, "/api/events?since=0&limit=1000")).body.filter((e) => e.type.startsWith("span.") && e.traceId === "trc_slim");
    assert.equal(events.length, 2);
    for (const e of events) {
      const d = e.data as Record<string, unknown>;
      assert.equal(d.id, span.spanId);
      assert.ok(!("input" in d) && !("output" in d), "no I/O previews in the event");
      assert.ok("attributes" in d && "status" in d && "kind" in d, "summary fields kept");
    }
    // The detail is still available on demand.
    const trace = (await api<{ spans: { id: string; input: string | null; output: string | null }[] }>(t.url, "/api/traces/trc_slim")).body;
    const full = trace.spans.find((s) => s.id === span.spanId)!;
    assert.ok(full.input && full.output);
  } finally {
    await t.close();
  }
});
