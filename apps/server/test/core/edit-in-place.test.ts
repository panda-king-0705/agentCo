// 2026-11-08 (trc_4469…, the investor update's third run): agents could only rewrite whole files.
// Quinn, asked to fix section 6 of a 19,845-character update, saved 6,385 characters — sections 5 to
// 7 gone, including section 6 — and Eva, asked to compare with the version Legal had approved, could
// not open earlier versions and searched until her run timed out. Now: workspace_edit_file changes a
// passage or a section in place, a rewrite that drops sections is flagged at once, and
// workspace_read_file reads earlier versions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspaces, droppedSections, sectionsOf } from "../../src/tools/workspace.ts";
import { callTool, createTestApp, done, rootTask } from "./helpers/harness.ts";

const DOC = [
  "# AgentCo Investor Update: November 2026",
  "",
  "## 1. Summary",
  "Drafted; not sent.",
  "",
  "## 5. Spend",
  "Spend to date: $1.64 [ledger].",
  "",
  "## 6. Margins",
  "Gross margin target: 60%.",
  "Up to $43.00/month gross.",
  "",
  "### 6.1 Notes",
  "Pending the 70% floor.",
  "",
  "## 7. Open items",
  "- Recipients: Board.",
].join("\n");

test("edit a passage or a whole section in place; versions are kept and readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentco-ws-"));
  try {
    const ws = new Workspaces(dir);
    ws.write("agt_a", "investor-updates/update.md", DOC);
    const a = ws.edit("agt_a", "investor-updates/update.md", { find: "Gross margin target: 60%.", replace: "Gross margin floor: 60% (finance report §4.3)." });
    assert.equal(a.changed, "replaced 1 passage");
    assert.match(a.content, /## 5\. Spend\nSpend to date: \$1\.64 \[ledger\]\.\n\n## 6\. Margins\nGross margin floor: 60% \(finance report §4\.3\)\.\nUp to \$43\.00/);
    assert.throws(() => ws.edit("agt_a", "investor-updates/update.md", { find: "not in the file", replace: "x" }), /the "find" text is not in shared\/investor-updates\/update\.md/);
    assert.throws(() => ws.edit("agt_a", "investor-updates/update.md", { find: "## ", replace: "x" }), /occurs 5 times/);

    // A whole section by its heading (with or without #s), sub-sections included; the rest untouched.
    const b = ws.edit("agt_a", "investor-updates/update.md", { section: "6. Margins", content: "## 6. Margins\nGross margin floor: 60%. The $43.00 figure is not available yet.\n" });
    assert.equal(b.changed, 'replaced section "## 6. Margins"');
    assert.equal(
      b.content,
      DOC.replace("## 6. Margins\nGross margin target: 60%.\nUp to $43.00/month gross.\n\n### 6.1 Notes\nPending the 70% floor.\n", "## 6. Margins\nGross margin floor: 60%. The $43.00 figure is not available yet.\n"),
    );
    const c = ws.edit("agt_a", "investor-updates/update.md", { section: "## 7. Open items", content: "" });
    assert.equal(c.changed, 'removed section "## 7. Open items"');
    assert.doesNotMatch(c.content, /Open items/);
    assert.match(c.content, /The \$43\.00 figure is not available yet\.\n$/);
    assert.throws(() => ws.edit("agt_a", "investor-updates/update.md", { section: "Legal conditions", content: "x" }), /no section "Legal conditions".*Its headings: # AgentCo Investor Update: November 2026 \| ## 1\. Summary/);
    assert.throws(() => ws.edit("agt_a", "investor-updates/missing.md", { find: "a", replace: "b" }), /no file at investor-updates\/missing\.md — create it with workspace_write_file/);

    // Three edits → three earlier versions, newest first; 3 back is the original.
    const versions = ws.history("agt_a", "investor-updates/update.md");
    assert.equal(versions.length, 3);
    assert.equal(ws.readVersion("agt_a", "investor-updates/update.md", 3)!.content, DOC);
    assert.match(ws.readVersion("agt_a", "investor-updates/update.md", 1)!.content, /## 7\. Open items/);
    assert.equal(ws.readVersion("agt_a", "investor-updates/update.md", 4), null);

    assert.deepEqual(sectionsOf("# T\n```\n## not a heading\n```\n## Real\ntext").map((s) => s.line), ["# T", "## Real"]);
    assert.deepEqual(droppedSections(DOC, "# AgentCo Investor Update: November 2026\n\n## 1. Summary\nShort."), ["## 5. Spend", "## 6. Margins", "### 6.1 Notes", "## 7. Open items"]);
    assert.deepEqual(droppedSections(DOC, DOC.replace("# AgentCo Investor Update: November 2026", "# AgentCo Investor Update (v2)")), [], "a renamed title is not a dropped section");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("through the tools: a rewrite that drops sections is flagged, the edit tool keeps them, earlier versions are readable, and the edit counts as a save on the objective", async () => {
  const out: Record<string, { ok: boolean; content: string }> = {};
  let worker = "";
  const t = await createTestApp({
    reflex: async (ctx) => {
      if (ctx.input.trigger !== "task" || ctx.agent.id !== worker) return done();
      out.first = await callTool(ctx, "workspace_write_file", { path: "investor-updates/2026-11-investor-update.md", content: DOC });
      out.rewrite = await callTool(ctx, "workspace_write_file", { path: "investor-updates/2026-11-investor-update.md", content: "# AgentCo Investor Update: November 2026\n\n## 1. Summary\nDrafted; not sent." });
      out.previous = await callTool(ctx, "workspace_read_file", { path: "investor-updates/2026-11-investor-update.md", version: 1 });
      out.restore = await callTool(ctx, "workspace_write_file", { path: "investor-updates/2026-11-investor-update.md", content: DOC });
      out.edit = await callTool(ctx, "workspace_edit_file", { path: "investor-updates/2026-11-investor-update.md", section: "6. Margins", content: "## 6. Margins\nGross margin floor: 60%." });
      out.both = await callTool(ctx, "workspace_edit_file", { path: "investor-updates/2026-11-investor-update.md", find: "a", replace: "b", section: "x", content: "y" });
      out.tooFar = await callTool(ctx, "workspace_read_file", { path: "investor-updates/2026-11-investor-update.md", version: 9 });
      return done("Edited section 6.");
    },
  });
  try {
    worker = t.agentByRole("backend-engineer").id;
    const task = rootTask(t, worker, "Fix section 6 of the investor update");
    await t.drain();
    assert.equal(out.rewrite!.ok, true);
    assert.match(
      out.rewrite!.content,
      /previous version kept\)\. Saved and verified on disk\. Colleagues can read it at this path\. WARNING: this version is \d+% shorter than the one it replaced and leaves out 4 section\(s\) it had: "## 5\. Spend", "## 6\. Margins", "### 6\.1 Notes", "## 7\. Open items"\. If you meant to change only part of the file, put them back now: workspace_read_file with version: 1 shows the replaced version, and workspace_edit_file changes one section without rewriting the rest\./,
    );
    assert.doesNotMatch(out.first!.content, /WARNING/);
    assert.match(out.previous!.content, /^\[Earlier version 1 of 1 of shared\/investor-updates\/2026-11-investor-update\.md, saved \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC — the current file is newer\]\n# AgentCo Investor Update: November 2026\n/);
    assert.match(out.previous!.content, /## 7\. Open items/);
    assert.equal(out.edit!.ok, true, out.edit!.content);
    assert.match(out.edit!.content, /^Edited shared\/investor-updates\/2026-11-investor-update\.md: replaced section "## 6\. Margins"\. The file is now \d+ chars, \d+ words, \d+ lines \(was \d+ chars\)\. Saved and verified on disk; previous version kept\./);
    assert.equal(out.both!.ok, false);
    assert.match(out.tooFar!.content, /has only 3 earlier versions/);

    const { platform } = t.app;
    const now = platform.workspaces.read(worker, "investor-updates/2026-11-investor-update.md").content;
    assert.match(now, /## 5\. Spend[\s\S]*## 6\. Margins\nGross margin floor: 60%\.\n\n## 7\. Open items/);
    const saves = platform.repos.spans.filesWritten(task.traceId);
    assert.equal(saves.length, 4, "three saves and the edit");
    assert.equal(saves.at(-1)!.display, "shared/investor-updates/2026-11-investor-update.md");
    assert.ok(platform.tools.canUse("workspace_edit_file", t.agentByRole("backend-engineer")), "whoever can save files can edit them");
  } finally {
    await t.close();
  }
});
