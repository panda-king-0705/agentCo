import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompanyEvent } from "../../../../packages/shared/src/index.ts";
import { api, createTestApp, type TestApp } from "./helpers/harness.ts";

/** Reads an SSE stream until `done(buffer)` or the timeout; returns the raw text and the parsed events. */
async function readSse(base: string, headers: Record<string, string>, done: (text: string) => boolean, timeoutMs = 4000) {
  const controller = new AbortController();
  const response = await fetch(base + "/api/events/stream", { headers, signal: controller.signal });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!done(text) && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 200))]);
      if (chunk.value) text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
  }
  return { response, text, events: parseSse(text) };
}

function parseSse(text: string): { id: number; type: string; data: CompanyEvent }[] {
  return text
    .split("\n\n")
    .map((block) => ({ id: /^id: (\d+)/m.exec(block)?.[1], type: /^event: (.+)$/m.exec(block)?.[1], data: /^data: (.+)$/m.exec(block)?.[1] }))
    .filter((b): b is { id: string; type: string; data: string } => !!b.id && !!b.type && !!b.data)
    .map((b) => ({ id: Number(b.id), type: b.type, data: JSON.parse(b.data) as CompanyEvent }));
}

const seed = async (t: TestApp) => {
  for (let i = 0; i < 6; i++) await api(t.url, "/api/company", { method: "PATCH", body: { maxConcurrentRuns: 2 + (i % 3) } });
};

test("SSE replays from Last-Event-ID, in order, with the SSE wire format", async () => {
  const t = await createTestApp({ listen: true });
  try {
    await seed(t);
    const all = (await api<CompanyEvent[]>(t.url, "/api/events?since=0&limit=1000")).body;
    const lastSeq = all.at(-4)?.seq as number;
    const { response, events, text } = await readSse(t.url, { "last-event-id": String(lastSeq) }, (s) => parseSse(s).length >= 3);
    assert.equal(response.headers.get("content-type")?.split(";")[0], "text/event-stream");
    assert.ok(text.startsWith("retry:"), "the stream opens with a retry hint");
    assert.deepEqual(events.map((e) => e.id), all.slice(-3).map((e) => e.seq), "exactly the events after Last-Event-ID, oldest first");
    for (const e of events) {
      assert.equal(e.data.seq, e.id);
      assert.equal(e.data.type, e.type);
    }
    // Without Last-Event-ID nothing is replayed: the stream is live-only.
    const liveOnly = await readSse(t.url, {}, () => false, 300);
    assert.equal(liveOnly.events.length, 0);
  } finally {
    await t.close();
  }
});

test("SSE streams live events after the replay without gaps or duplicates, and heartbeats", async () => {
  const t = await createTestApp({ listen: true, overrides: { heartbeatMs: 40 } });
  try {
    await seed(t);
    const first = (await api<CompanyEvent[]>(t.url, "/api/events?since=0&limit=1000")).body[0] as CompanyEvent;
    const reading = readSse(t.url, { "last-event-id": String(first.seq) }, (s) => parseSse(s).some((e) => e.data.summary.includes("(name)")) && s.includes(": heartbeat"));
    await new Promise((r) => setTimeout(r, 120));
    await api(t.url, "/api/company", { method: "PATCH", body: { name: "LIVE-MARKER Inc" } });
    const { events, text } = await reading;
    assert.ok(text.includes(": heartbeat"), "an idle stream carries heartbeat comments");
    const ids = events.map((e) => e.id);
    assert.ok(ids.length > 5);
    assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b), "strictly increasing, no duplicates");
    for (let i = 1; i < ids.length; i++) assert.equal(ids[i], (ids[i - 1] as number) + 1, "no gap between replay and live events");
    assert.ok(events.some((e) => e.type === "company.updated"), "the live company.updated event arrived on the open stream");
  } finally {
    await t.close();
  }
});
