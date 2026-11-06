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

test("onboarding: a new hire finds the handbook in its inbox from its manager; company_handbook and GET /api/handbook serve it", async () => {
  const t = await createTestApp({
    listen: true,
    reflex: async (ctx) => {
      const r = await callTool(ctx, "company_handbook", {});
      return done(r.content);
    },
  });
  try {
    const { platform } = t.app;
    const cfo = t.agentByRole("cfo");
    platform.memory.write({ scope: "global", agentId: null, kind: "semantic", content: "Board custodian ID: U2522199H.", tags: ["board"], importance: 0.9 });
    const hire = platform.org.createAgent({ roleId: "fpa-analyst", name: "Nia Okoye", managerId: cfo.id }, "human");
    const inbox = platform.memory.inbox(hire.id, 5);
    assert.equal(inbox.length, 1, "one welcome message");
    assert.equal(inbox[0]!.senderId, cfo.id, "from the hire's manager");
    const text = inbox[0]!.content;
    assert.match(text, /^Welcome to AgentCo, Nia Okoye!/);
    for (const section of ["## You", "## Who's who", "## How work flows", "## Current objectives", "## Key company knowledge"]) assert.ok(text.includes(section), section);
    assert.match(text, new RegExp(`You report to ${cfo.name}, Chief Financial Officer \\(id ${cfo.id}\\)`));
    assert.match(text, /Board custodian ID: U2522199H/);
    assert.match(text, /Today: \w+day \d{4}-\d{2}-\d{2}/);

    const task = rootTask(t, hire.id, "Read the handbook");
    await t.drain();
    assert.match(platform.tasks.require(task.id).result ?? "", /# AgentCo — company handbook/);

    const api1 = await api<{ text: string }>(t.url, `/api/handbook?agentId=${hire.id}`);
    assert.match(api1.body.text, /## You\nNia Okoye/);
    const general = await api<{ text: string }>(t.url, "/api/handbook");
    assert.ok(!general.body.text.includes("## You"), "the Board's view is not personalised");
    assert.equal((await api<unknown>(t.url, "/api/handbook?agentId=nope")).status, 404);
  } finally {
    await t.close();
  }
});

test("expected misses are answers, not errors: blackboard_read of an unwritten key, workspace_read_file of a file not there yet", async () => {
  const t = await createTestApp({
    reflex: async (ctx) => {
      const bb = await callTool(ctx, "blackboard_read", { key: "objective:T-999" });
      const file = await callTool(ctx, "workspace_read_file", { path: "shared/engineering/not-yet.md" });
      return done(`${bb.ok}|${bb.content}\n${file.ok}|${file.content}`);
    },
  });
  try {
    const { platform } = t.app;
    platform.memory.blackboardSet("office_hours", "9-6 SGT", "system");
    const worker = t.agentByRole("backend-engineer");
    const task = rootTask(t, worker.id, "Look things up");
    await t.drain();
    const [bb, file] = (platform.tasks.require(task.id).result ?? "").split("\n");
    assert.match(bb!, /^true\|No blackboard entry "objective:T-999" \(nobody has written it yet\)\. Existing keys: .*office_hours/);
    assert.match(file!, /^true\|No file "shared\/engineering\/not-yet\.md" yet\./);
  } finally {
    await t.close();
  }
});

test("role arrangement: the leader's pick wins unless another mandate fits clearly better; a department named in the TITLE decides", async () => {
  const { scoreCandidates } = await import("../../src/cognition/brain/self-management/role-arrangement.ts");
  const t = await createTestApp({});
  try {
    const { platform } = t.app;
    const cands = platform.org.directReports(t.agentByRole("ceo").id).map((agent) => ({ agent, departmentName: platform.org.departmentName(agent.departmentId) }));
    const cos = t.agentByRole("chief-of-staff");
    const cto = t.agentByRole("cto");
    const text = "Independently verify figures and assemble final one-page plan (engineering scope, pricing, marketing)";
    const ranked = scoreCandidates(text, cands, { suggestedId: cos.id, fallbackDepartment: "Executive Office" });
    assert.equal(ranked[0]!.agentId, cos.id, "the leader's pick (Chief of Staff) is kept");
    const titled = scoreCandidates("Engineering scope for the chosen pricing lever", cands, { suggestedId: cos.id, fallbackDepartment: "Executive Office", namedIds: namedCandidates("Engineering scope for the chosen pricing lever", cands) });
    assert.equal(titled[0]!.agentId, cto.id, "a part titled for Engineering goes to Engineering");
  } finally {
    await t.close();
  }
});

test("Clear history on Approvals hides decided approvals only; undo and restore bring them back", async () => {
  const t = await createTestApp({
    listen: true,
    brain: async (ctx) => {
      if (ctx.input.trigger !== "task") return done("ok");
      await callTool(ctx, "ask_human", { question: `About ${ctx.input.task.title}?` });
      return done("asked");
    },
  });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    rootTask(t, ceo.id, "First");
    rootTask(t, ceo.id, "Second");
    rootTask(t, ceo.id, "Third");
    await t.drain();
    const [a, b] = platform.approvals.list("pending");
    platform.approvals.decide(a!.id, { decision: "approved", note: "yes" });
    platform.approvals.decide(b!.id, { decision: "rejected" });
    const cleared = (await api<{ count: number; batch: string }>(t.url, "/api/approvals/archive-decided", { method: "POST" })).body;
    assert.equal(cleared.count, 2);
    const visible = (await api<{ id: string; status: string }[]>(t.url, "/api/approvals")).body;
    assert.deepEqual(visible.map((x) => x.status), ["pending"], "the pending one stays; history is cleared");
    assert.equal((await api<unknown[]>(t.url, "/api/approvals?archived=only")).body.length, 2);
    const undone = (await api<{ count: number }>(t.url, "/api/approvals/unarchive", { method: "POST", body: { batch: cleared.batch } })).body;
    assert.equal(undone.count, 2);
    assert.equal((await api<unknown[]>(t.url, "/api/approvals")).body.length, 3);
    await api(t.url, "/api/approvals/archive-decided", { method: "POST" });
    assert.equal((await api<{ count: number }>(t.url, "/api/approvals/unarchive", { method: "POST" })).body.count, 2, "restore all");
    assert.equal(platform.approvals.list("pending").length, 1, "internal views still see everything");
  } finally {
    await t.close();
  }
});
