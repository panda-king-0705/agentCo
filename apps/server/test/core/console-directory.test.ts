// Live regressions (2026-11-07): the console replayed days-old events over current state (cancelled
// tasks back "In progress"); agents had no directory ("No active agent with id ceo"), no calendar
// date, and a finance budget was routed to the CTO; plus "Clear finished" on the Tasks board.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArchiveResult, CompanyEvent, Task } from "../../../../packages/shared/src/index.ts";
import { keyContacts, resolveAgent, searchDirectory } from "../../src/org/directory.ts";
import { agentFacts, todayLine } from "../../src/cognition/prompt.ts";
import { namedCandidates } from "../../src/cognition/brain/self-management/role-arrangement.ts";
import { api, callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";

test("GET /api/events without since returns the NEWEST events (the console seeds its position from them)", async () => {
  const t = await createTestApp({ listen: true });
  try {
    const all = (await api<CompanyEvent[]>(t.url, "/api/events?since=0&limit=5000")).body;
    assert.ok(all.length > 5, "bootstrap wrote events");
    const tail = (await api<CompanyEvent[]>(t.url, "/api/events?limit=3")).body;
    assert.deepEqual(tail.map((e) => e.seq), all.slice(-3).map((e) => e.seq), "the last three, oldest first");
    const head = (await api<CompanyEvent[]>(t.url, "/api/events?since=0&limit=2")).body;
    assert.deepEqual(head.map((e) => e.seq), all.slice(0, 2).map((e) => e.seq), "with since: catch-up from there, as before");
  } finally {
    await t.close();
  }
});

test("Clear finished archives whole finished trees only; the board hides them; undo and retry restore", async () => {
  const t = await createTestApp({ listen: true });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    const cfo = t.agentByRole("cfo");
    const finished = rootTask(t, ceo.id, "Finished objective");
    const sub = platform.tasks.createSubtask({ parent: finished, title: "Its subtask", description: "d", assigneeId: cfo.id, traceId: finished.traceId, createdBy: ceo.id });
    platform.tasks.cancel(finished.id);
    const open = rootTask(t, ceo.id, "Open objective");
    const doneSub = platform.tasks.createSubtask({ parent: open, title: "Done part", description: "d", assigneeId: cfo.id, traceId: open.traceId, createdBy: ceo.id });
    platform.repos.tasks.update(doneSub.id, { status: "done" });

    const cleared = (await api<ArchiveResult>(t.url, "/api/tasks/archive-finished", { method: "POST" })).body;
    assert.equal(cleared.objectives, 1);
    assert.equal(cleared.count, 2, "the finished root and its subtask");
    assert.ok(cleared.batch);
    const board = (await api<Task[]>(t.url, "/api/tasks")).body.map((x) => x.id);
    assert.ok(!board.includes(finished.id) && !board.includes(sub.id), "cleared from the board");
    assert.ok(board.includes(open.id) && board.includes(doneSub.id), "an open objective stays, with its done subtask");
    const archived = (await api<Task[]>(t.url, "/api/tasks?archived=only")).body.map((x) => x.id).sort();
    assert.deepEqual(archived, [finished.id, sub.id].sort());
    assert.equal((await api<unknown>(t.url, "/api/tasks?archived=bogus")).status, 400);
    assert.equal((await api<ArchiveResult>(t.url, "/api/tasks/archive-finished", { method: "POST" })).body.count, 0, "nothing more to clear");

    const undone = (await api<ArchiveResult>(t.url, "/api/tasks/unarchive", { method: "POST", body: { batch: cleared.batch } })).body;
    assert.equal(undone.count, 2);
    assert.ok((await api<Task[]>(t.url, "/api/tasks")).body.some((x) => x.id === finished.id), "undo puts it back");

    await api<ArchiveResult>(t.url, "/api/tasks/archive-finished", { method: "POST" });
    const retried = (await api<Task>(t.url, `/api/tasks/${sub.id}/retry`, { method: "POST" })).body;
    assert.equal(retried.status, "todo");
    assert.equal(retried.archivedAt, null);
    assert.ok((await api<Task[]>(t.url, "/api/tasks")).body.some((x) => x.id === finished.id), "retrying a subtask brings its objective back");
  } finally {
    await t.close();
  }
});

test("directory: everyone can look colleagues up and message them by name, title or role word", async () => {
  const t = await createTestApp({
    reflex: async (ctx) => {
      const dir = await callTool(ctx, "company_directory", { query: "finance" });
      const sent = await callTool(ctx, "send_message", { toAgentId: "ceo", content: "Budget file is at shared/finance/budget.md" });
      const toManager = await callTool(ctx, "send_message", { toAgentId: "my manager", content: "FYI" });
      const nobody = await callTool(ctx, "send_message", { toAgentId: "the janitor", content: "hi" });
      return done([dir.content, sent.content, toManager.content, nobody.content].join("\n---\n"));
    },
  });
  try {
    const { platform } = t.app;
    const worker = t.agentByRole("backend-engineer");
    const task = rootTask(t, worker.id, "Report the budget path");
    await t.drain();
    const out = platform.tasks.require(task.id).result ?? "";
    const [dir, sent, toManager, nobody] = out.split("\n---\n");
    const cfo = t.agentByRole("cfo");
    assert.match(dir!, new RegExp(`${cfo.name} — Chief Financial Officer, Finance.*id ${cfo.id}`));
    assert.match(sent!, /Message delivered to .+'s inbox/);
    assert.match(toManager!, /Message delivered/);
    assert.match(nobody!, /No single active agent matches "the janitor"/);
  } finally {
    await t.close();
  }
});

test("directory: resolution, search, key contacts and the date reach every agent's prompt", async () => {
  const t = await createTestApp({});
  try {
    const { platform } = t.app;
    const org = platform.org;
    const ceo = t.agentByRole("ceo");
    const cfo = t.agentByRole("cfo");
    const fm = t.agentByRole("fpa-analyst");
    const boss = org.getAgent(fm.managerId!)!;
    assert.equal(resolveAgent(org, "ceo")?.id, ceo.id);
    assert.equal(resolveAgent(org, "CFO")?.id, cfo.id);
    assert.equal(resolveAgent(org, cfo.name)?.id, cfo.id);
    assert.equal(resolveAgent(org, cfo.name.split(" ")[0]!)?.id, cfo.id, "first name");
    assert.equal(resolveAgent(org, "Chief Financial Officer")?.id, cfo.id);
    assert.equal(resolveAgent(org, "manager", fm)?.id, boss.id);
    assert.equal(resolveAgent(org, cfo.id)?.id, cfo.id);
    assert.equal(resolveAgent(org, "officer"), null, "ambiguous → null");
    assert.ok(searchDirectory(org, "finance").some((e) => e.id === fm.id));
    const contacts = keyContacts(org, fm);
    assert.match(contacts, new RegExp(`your manager ${boss.name} \\(${boss.title}, id ${boss.id}\\)`));
    assert.match(contacts, new RegExp(`the CEO ${ceo.name} \\(id ${ceo.id}\\)`));
    assert.match(contacts, /goes back to whoever assigned the task automatically/);
    const facts = agentFacts(platform.services, fm);
    assert.match(facts.today ?? "", /^Today: \w+day \d{4}-\d{2}-\d{2}, \d{2}:\d{2} \(.+\)\.$/);
    assert.equal(facts.contacts, contacts);
    assert.match(todayLine(new Date(2026, 10, 7, 6, 44)), /^Today: Saturday 2026-11-07, 06:44/);
  } finally {
    await t.close();
  }
});

test("role arrangement: a department or role named in the request is recognised", async () => {
  const t = await createTestApp({});
  try {
    const { platform } = t.app;
    const cands = platform.org.directReports(t.agentByRole("ceo").id).map((agent) => ({ agent, departmentName: platform.org.departmentName(agent.departmentId) }));
    const cfo = t.agentByRole("cfo");
    const cto = t.agentByRole("cto");
    assert.deepEqual([...namedCandidates("Have Finance write a one-page budget: model spend against our $100 cap", cands)], [cfo.id]);
    assert.deepEqual([...namedCandidates("Ask the CTO to review the API design", cands)], [cto.id]);
    assert.equal(namedCandidates("Write a one-page launch plan for an AI meeting-notes app", cands).size, 0);
  } finally {
    await t.close();
  }
});
