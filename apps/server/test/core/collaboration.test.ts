// Test 4 (2026-11-07, T-171 "one-page launch plan split across departments"): 13 tasks, $4.59 and no
// page. Four executives saved their sections where only they could see them; the assembler started
// before the sections existed, re-checked the drive 6–7 times per run and escalated to the CEO twice;
// the CEO's plan merged four named owners into two parts. Fixed here and in cognition/rounds.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Task } from "../../../../packages/shared/src/index.ts";
import { Workspaces, WorkspaceError } from "../../src/tools/workspace.ts";
import { readEscalation } from "../../src/cognition/brain/escalation.ts";
import { waitableInputs } from "../../src/tasks/inputs.ts";
import { roleWordFor } from "../../src/org/directory.ts";
import { callTool, createTestApp, done, gate, rootTask, waitFor } from "./helpers/harness.ts";

test("a plain path is the company drive; private/ is your own notes; overwrites keep the previous version", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentco-ws-"));
  try {
    const ws = new Workspaces(dir);
    const a = ws.write("agt_a", "launch-plan/gtm.md", "v1");
    assert.equal(a.display, "shared/launch-plan/gtm.md");
    assert.equal(a.area, "shared");
    assert.equal(ws.read("agt_b", "launch-plan/gtm.md").content, "v1", "a colleague reads it by the same plain path");
    assert.equal(ws.read("agt_b", "shared/launch-plan/gtm.md").content, "v1");
    const again = ws.write("agt_b", "launch-plan/gtm.md", "v2");
    assert.equal(again.replaced, true);
    assert.equal(ws.read("agt_a", "launch-plan/gtm.md").content, "v2");
    const history = readdirSync(join(dir, "workspaces", "shared", ".history", "launch-plan"));
    assert.equal(history.length, 1, "the previous version is kept");
    assert.equal(ws.write("agt_b", "launch-plan/gtm.md", "v2").replaced, false, "same content: nothing replaced");
    assert.deepEqual(ws.list("agt_a", "launch-plan"), ["gtm.md"], ".history is hidden");

    const p = ws.write("agt_a", "private/notes.md", "mine");
    assert.equal(p.display, "private/notes.md");
    assert.equal(ws.exists("agt_b", "private/notes.md"), false, "private is private");
    assert.equal(ws.exists("agt_a", "notes.md"), true, "a plain path still finds your own private file (legacy)");
    assert.deepEqual(ws.list("agt_a", ""), ["launch-plan/", "private/"], "the top level shows the drive plus your private folder");
    assert.deepEqual(ws.list("agt_b", ""), ["launch-plan/"]);
    assert.deepEqual(ws.list("agt_a", "private"), ["notes.md"]);
    assert.deepEqual(ws.recentShared(10).map((f) => f.rel), ["launch-plan/gtm.md"], "the drive's files for planning (private and .history left out)");
    assert.throws(() => ws.write("agt_a", "../escape.md", "x"), WorkspaceError);
    assert.throws(() => ws.write("agt_a", ".history/x.md", "x"), WorkspaceError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missed read finds the file a teammate saved on the same objective — even privately — and says where", async () => {
  const seen: Record<string, { ok: boolean; content: string }> = {};
  let ids: { cmo: string; cos: string; cto: string } = { cmo: "", cos: "", cto: "" };
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger !== "task") return done();
      if (ctx.agent.id === ids.cmo) {
        // Written the old way (private) and the new way (a plain path = the drive).
        await callTool(ctx, "workspace_write_file", { path: "private/launch-plan/sections/gtm.md", content: "## GTM\nLaunch 2027-01-12." });
        seen.write = await callTool(ctx, "workspace_write_file", { path: "launch-plan/exec/one-page.md", content: "# Draft page" });
        return done("GTM saved");
      }
      if (ctx.agent.id === ids.cos) {
        seen.private = await callTool(ctx, "workspace_read_file", { path: "launch-plan/sections/gtm.md" });
        seen.byName = await callTool(ctx, "workspace_read_file", { path: "shared/launch-plan/one-page.md" });
        seen.miss = await callTool(ctx, "workspace_read_file", { path: "launch-plan/mvp.md" });
        seen.list = await callTool(ctx, "workspace_list", { dir: "shared" });
        return done("assembled");
      }
      if (ctx.agent.id === ids.cto) {
        seen.otherObjective = await callTool(ctx, "workspace_read_file", { path: "launch-plan/sections/gtm.md" });
        return done();
      }
      return done();
    },
  });
  try {
    const { platform } = t.app;
    ids = { cmo: t.agentByRole("cmo").id, cos: t.agentByRole("chief-of-staff").id, cto: t.agentByRole("cto").id };
    const root = rootTask(t, t.agentByRole("ceo").id, "One-page launch plan");
    platform.repos.tasks.update(root.id, { status: "waiting" });
    const sub = (assigneeId: string, title: string) => platform.tasks.createSubtask({ parent: root, title, description: title, assigneeId, traceId: root.traceId, createdBy: root.assigneeId! });
    sub(ids.cmo, "CMO: GTM section");
    await t.drain();
    sub(ids.cos, "CoS: assemble the page");
    rootTask(t, ids.cto, "Unrelated objective");
    await t.drain();

    assert.match(seen.write!.content, /^Wrote shared\/launch-plan\/exec\/one-page\.md \(12 chars, 2 words, 1 lines\)\. Saved and verified on disk\. Colleagues can read it/);
    assert.match(seen.byName!.content, /\n\[end of shared\/launch-plan\/exec\/one-page\.md — complete: 2 words, 1 lines, 12 chars\]$/, "the read-back says it is complete, with tool counts");
    assert.equal(seen.private!.ok, true);
    assert.match(seen.private!.content, /^\[Not at launch-plan\/sections\/gtm\.md; found .*'s private file launch-plan\/sections\/gtm\.md, saved by .* on this objective\. Save a copy on the drive/);
    assert.match(seen.private!.content, /Launch 2027-01-12/);
    assert.match(seen.byName!.content, /found shared\/launch-plan\/exec\/one-page\.md/, "found by file name under another folder");
    assert.match(seen.byName!.content, /# Draft page/);
    assert.equal(seen.miss!.ok, true, "a miss is an answer, not an error");
    assert.match(seen.miss!.content, /No file "launch-plan\/mvp\.md" yet\. .*Saved on this objective so far: shared\/launch-plan\/exec\/one-page\.md \(.+\); launch-plan\/sections\/gtm\.md \(.+'s private notes\)/);
    assert.match(seen.list!.content, /^launch-plan\/\n\nSaved on this objective so far: /);
    assert.match(seen.otherObjective!.content, /^No file .*Nothing has been saved on this objective yet\./, "another objective's private files stay private");
    // What reviewers get: every save with the task it was made under, and the file as it is on disk.
    const writes = platform.services.drive!.written(root.traceId);
    assert.ok(writes.length === 2 && writes.every((w) => w.taskId), "each save knows its task");
    assert.equal(platform.services.drive!.read(ids.cmo, "shared/launch-plan/exec/one-page.md")?.content, "# Draft page");
    assert.equal(platform.services.drive!.read(ids.cos, "private/launch-plan/sections/gtm.md"), null, "private is per author");
  } finally {
    await t.close();
  }
});

test("stuck on a colleague's part that is still in progress: on hold instead of escalating, resumed with their result", async () => {
  const hold = gate();
  const outcomes: Record<string, { ok: boolean; content: string }> = {};
  let resumedWith: Task[] = [];
  let ids = { cto: "", cos: "" };
  const t = await createTestApp({
    brain: async (ctx) => {
      if (ctx.input.trigger === "message") return done();
      if (ctx.agent.id === ids.cto) {
        await hold.promise;
        return done("MVP section saved at launch-plan/mvp.md: beta 2026-12-18.");
      }
      if (ctx.agent.id === ids.cos) {
        if (ctx.input.trigger === "subtasks_completed") {
          resumedWith = ctx.input.subtasks;
          return done("Page assembled.");
        }
        outcomes.escalate = await callTool(ctx, "escalate", { reason: "The CTO's MVP section has not been delivered yet, so I cannot assemble the page.", question: "Should I wait?" });
        return { outcome: "waiting", output: "On hold for the CTO's section." };
      }
      return done();
    },
  });
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    ids = { cto: t.agentByRole("cto").id, cos: t.agentByRole("chief-of-staff").id };
    const root = rootTask(t, ceo.id, "One-page launch plan");
    platform.repos.tasks.update(root.id, { status: "waiting" });
    const ctoTask = platform.tasks.createSubtask({ parent: root, title: "CTO: MVP section", description: "Write it.", assigneeId: ids.cto, traceId: root.traceId, createdBy: ceo.id });
    const cosTask = platform.tasks.createSubtask({ parent: root, title: "CoS: assemble the page", description: "Merge the sections.", assigneeId: ids.cos, traceId: root.traceId, createdBy: ceo.id });
    platform.scheduler.tick();
    const wait = await waitFor("the inputs wait", () => platform.tasks.children(cosTask.id).find((c) => c.state.inputsWait === true));
    await waitFor("CoS on hold", () => platform.tasks.get(cosTask.id)!.status === "waiting");
    assert.match(outcomes.escalate!.content, new RegExp(`^Not escalated: colleagues are still working on this objective — T-${ctoTask.number} "CTO: MVP section"`));
    assert.equal(wait.status, "waiting");
    assert.equal(wait.assigneeId, ids.cos, "the asker is the one waiting");
    assert.match(wait.title, new RegExp(`^Waiting for T-${ctoTask.number} \\(`));
    const managerEscalations = platform.repos.tasks.list({ rootTaskId: root.id }).filter((x) => x.state.kind === "escalation" && x.assigneeId === ceo.id);
    assert.equal(managerEscalations.length, 0, "no escalation reached the CEO");

    hold.open();
    await t.drain();
    assert.equal(platform.tasks.get(wait.id)!.status, "done", "settled by the platform when the CTO finished");
    assert.equal(platform.tasks.get(cosTask.id)!.status, "done");
    const answer = resumedWith.find((c) => c.id === wait.id);
    assert.match(answer?.result ?? "", /The colleague work you were waiting for has finished:\n- T-\d+ "CTO: MVP section" — .*, done: MVP section saved at launch-plan\/mvp\.md/);
    assert.equal(platform.repos.runs.list({ taskId: wait.id }).length, 0, "no run, no model call for the wait");
    const esc = readEscalation(platform.tasks.get(cosTask.id)!, platform.tasks.children(cosTask.id), ids.cos);
    assert.deepEqual(esc, { count: 0, answered: false }, "waiting spends no escalation budget");
    assert.equal(platform.tasks.get(cosTask.id)!.state.waitedForInputs, 1);
  } finally {
    hold.open();
    await t.close();
  }
});

test("waitableInputs: only colleagues' open work on the same objective that the question is about — never in a circle", () => {
  const agent = (id: string, name: string, title: string) => ({ id, name, title }) as Agent;
  const agents = new Map([agent("a1", "Kenji Tanaka", "Chief Technology Officer"), agent("a2", "Olivia Bennett", "Chief Marketing Officer"), agent("a3", "Noah Patel", "Chief of Staff"), agent("ceo", "Ava Chen", "Chief Executive Officer")].map((a) => [a.id, a]));
  let n = 0;
  const task = (id: string, assigneeId: string, parentTaskId: string | null, status: Task["status"] = "in_progress", state: Record<string, unknown> = {}) =>
    ({ id, number: ++n + 100, rootTaskId: "root", parentTaskId, assigneeId, status, state, title: id }) as unknown as Task;
  const root = task("root", "ceo", null, "waiting");
  const mine = task("mine", "a3", "root");
  const cto = task("cto", "a1", "root");
  const cmo = task("cmo", "a2", "root", "todo");
  const myChild = task("mychild", "a1", "mine");
  const esc = task("esc", "ceo", "mine", "in_progress", { kind: "escalation" });
  const all = [root, mine, cto, cmo, myChild, esc];
  const of = (id: string) => agents.get(id) ?? null;
  assert.deepEqual(waitableInputs(all, mine, "a3", "The CTO section is not written yet", of).map((t) => t.id), ["cto"], "named by role word");
  assert.deepEqual(waitableInputs(all, mine, "a3", "Olivia's GTM draft is missing", of).map((t) => t.id), ["cmo"], "named by first name");
  assert.deepEqual(waitableInputs(all, mine, "a3", `Waiting on T-${cmo.number}`, of).map((t) => t.id), ["cmo"], "named by T-number");
  assert.deepEqual(waitableInputs(all, mine, "a3", "The sections have not been received", of).map((t) => t.id).sort(), ["cmo", "cto"], "about missing input, nobody named: all open colleague work");
  assert.deepEqual(waitableInputs(all, mine, "a3", "The Board must approve the $5k spend", of), [], "not about inputs: escalate as usual");
  // The ancestor (root), my own subtree and escalations are never waited on; nor is work already on hold.
  cto.state = {};
  const ctoHold = task("ctohold", "a1", "cto", "waiting", { kind: "escalation", inputsWait: true });
  assert.deepEqual(waitableInputs([...all, ctoHold], mine, "a3", "The sections have not been received", of).map((t) => t.id), ["cmo"], "the CTO is on hold himself: no waiting in a circle");
  assert.equal(roleWordFor("Chief Financial Officer"), "cfo");
  assert.equal(roleWordFor("Chief of Staff"), null);
});
