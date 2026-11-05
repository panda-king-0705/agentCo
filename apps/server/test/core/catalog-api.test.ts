/**
 * Specialist catalog through the platform (docs/CATALOG.md): the catalog API, hiring a specialist
 * from the catalog (department via the division mapping, created on demand; manager = department
 * lead; worker/reflex/economy; persona and playbook), hire_agent {catalogId} under the approval
 * policy, catalog_search, the agency org template and the boot-time backfill.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent, AgentDetail, Approval, CatalogAgentDetail, CatalogListResponse } from "../../../../packages/shared/src/index.ts";
import { AGENCY_STAFFING } from "../../src/org/templates.ts";
import { api, callTool, createTestApp, done, rootTask, type TestApp } from "./helpers/harness.ts";

const ok = (status: number, expected = 200) => assert.equal(status, expected);

test("catalog API: list (no full text), filters by division and q, detail by encoded or two-segment id", async () => {
  const t = await createTestApp({ listen: true });
  try {
    const list = await api<CatalogListResponse>(t.url, "/api/catalog");
    ok(list.status);
    assert.equal(list.body.agents.length, list.body.total);
    assert.ok(list.body.total >= 250);
    assert.equal(list.body.source.license, "MIT");
    assert.equal(list.body.source.skipped, 0);
    const row = list.body.agents.find((a) => a.id === "engineering/engineering-backend-architect")!;
    assert.equal(row.departmentSlug, "engineering");
    assert.equal(row.departmentName, "Engineering");
    assert.equal(row.hiredCount, 1, "the startup backend-engineer is staffed from it");
    assert.ok(!("sections" in row) && !("body" in row), "the list omits the full text");
    const games = list.body.divisions.find((d) => d.id === "game-development")!;
    assert.equal(games.optional, true);
    assert.equal(list.body.agents.find((a) => a.division === "game-development")!.departmentName, "Game Studio");

    const security = await api<CatalogListResponse>(t.url, "/api/catalog?division=security");
    assert.ok(security.body.agents.length >= 10 && security.body.agents.every((a) => a.division === "security"));
    const q = await api<CatalogListResponse>(t.url, "/api/catalog?q=backend%20architect");
    assert.equal(q.body.agents[0]?.id, "engineering/engineering-backend-architect");
    ok((await api(t.url, "/api/catalog?division=nope")).status, 400);

    const encoded = await api<CatalogAgentDetail>(t.url, `/api/catalog/${encodeURIComponent("sales/sales-coach")}`);
    ok(encoded.status);
    const twoSegments = await api<CatalogAgentDetail>(t.url, "/api/catalog/sales/sales-coach");
    ok(twoSegments.status);
    assert.equal(encoded.body.agent.id, "sales/sales-coach");
    assert.deepEqual(twoSegments.body.agent, encoded.body.agent);
    assert.ok(encoded.body.body.length > 1000, "full markdown for the console");
    assert.ok(encoded.body.playbook.tokens <= 900);
    assert.match(encoded.body.playbook.text, /Specialist playbook — .*Sales Coach/);
    assert.match(encoded.body.expertise, /^Domain expertise \(Sales Coach/);
    assert.equal(encoded.body.placement.departmentSlug, "revenue");
    assert.equal(encoded.body.placement.managerId, t.agentByRole("cro").id);
    assert.equal(encoded.body.placement.createsDepartment, false);
    const unity = await api<CatalogAgentDetail>(t.url, "/api/catalog/game-development/unity-architect");
    assert.equal(unity.body.placement.createsDepartment, true);
    assert.equal(unity.body.placement.departmentName, "Game Studio");
    assert.equal(unity.body.placement.managerId, t.agentByRole("cto").id);
    ok((await api(t.url, "/api/catalog/engineering/nope")).status, 404);
  } finally {
    await t.close();
  }
});

test("POST /api/agents {catalogId}: department via the mapping, manager = department lead, worker/reflex/economy, persona and playbook", async () => {
  const t = await createTestApp({ listen: true });
  try {
    const before = t.app.platform.org.listDepartments().length;
    const res = await api<Agent>(t.url, "/api/agents", { method: "POST", body: { catalogId: "sales/sales-coach" } });
    ok(res.status, 201);
    const a = res.body;
    const revenue = t.app.platform.repos.departments.bySlug("revenue")!;
    assert.equal(a.catalogId, "sales/sales-coach");
    assert.equal(a.title, "Sales Coach");
    assert.equal(a.departmentId, revenue.id);
    assert.equal(a.managerId, t.agentByRole("cro").id);
    assert.equal(a.tier, "worker");
    assert.equal(a.cognition, "reflex");
    assert.equal(a.modelTier, "economy");
    assert.ok(a.persona.emoji && a.persona.vibe, "emoji and vibe from the catalog");
    assert.match(a.persona.personalityType ?? "", /^[EI][SN][TF][JP]$/);
    assert.match(a.identity.mission, /sales coaching/i);
    assert.match(a.identity.assets[0] ?? "", /Sales Coach playbook/);
    assert.ok(a.tools.includes("send_message") && !a.tools.includes("hire_agent"));
    assert.equal(t.app.platform.org.listDepartments().length, before, "an existing department is reused");
    const detail = await api<AgentDetail>(t.url, `/api/agents/${a.id}`);
    assert.equal(detail.body.agent.catalogId, "sales/sales-coach");
    // The engines see its playbook; leaders see expertise instead.
    assert.match(t.app.platform.catalog.playbookFor(a) ?? "", /Specialist playbook — .*Sales Coach/);
    assert.equal(t.app.platform.catalog.expertiseFor(a), null);

    // A startup without a Security department: created on demand under Engineering, led by the CTO.
    const sec = await api<Agent>(t.url, "/api/agents", { method: "POST", body: { catalogId: "security/security-penetration-tester" } });
    ok(sec.status, 201);
    const security = t.app.platform.repos.departments.bySlug("security")!;
    assert.ok(security, "Security created");
    assert.equal(security.parentId, t.app.platform.repos.departments.bySlug("engineering")!.id);
    assert.equal(security.headAgentId, t.agentByRole("cto").id);
    assert.equal(sec.body.departmentId, security.id);
    assert.equal(sec.body.managerId, t.agentByRole("cto").id);

    // A homeless division: an optional department with its executive owner.
    const unity = await api<Agent>(t.url, "/api/agents", { method: "POST", body: { catalogId: "game-development/unity-architect" } });
    ok(unity.status, 201);
    const studio = t.app.platform.repos.departments.bySlug("game-studio")!;
    assert.equal(studio.name, "Game Studio");
    assert.equal(studio.headAgentId, t.agentByRole("cto").id);
    assert.equal(unity.body.managerId, t.agentByRole("cto").id);
    // Healthcare's owner (CSO) is absent in the startup org: the CEO owns it.
    const care = await api<Agent>(t.url, "/api/agents", { method: "POST", body: { catalogId: "healthcare/healthcare-clinical-evidence-agent" } });
    ok(care.status, 201);
    assert.equal(care.body.managerId, t.agentByRole("ceo").id);
    assert.equal(t.app.platform.repos.departments.bySlug("healthcare")!.name, "Healthcare Practice");

    // Explicit fields win; a worker department head is never chosen as manager.
    const marketing = t.app.platform.repos.departments.bySlug("marketing")!;
    const writer = t.agentByRole("content-writer");
    const explicit = await api<Agent>(t.url, "/api/agents", { method: "POST", body: { catalogId: "engineering/engineering-technical-writer", departmentId: marketing.id, managerId: writer.id, name: "Wren Doc", title: "Docs Writer" } });
    ok(explicit.status, 201);
    assert.equal(explicit.body.departmentId, marketing.id);
    assert.equal(explicit.body.managerId, writer.id);
    assert.equal(explicit.body.name, "Wren Doc");
    assert.equal(explicit.body.title, "Docs Writer");
    const support = await api<Agent>(t.url, "/api/agents", { method: "POST", body: { catalogId: "support/support-support-responder" } });
    assert.equal(t.app.platform.org.getAgent(support.body.managerId!)!.tier !== "worker", true);
    assert.equal(support.body.managerId, t.agentByRole("coo").id, "support-manager is absent: its manager's role (COO) leads Support");

    ok((await api(t.url, "/api/agents", { method: "POST", body: { catalogId: "engineering/does-not-exist" } })).status, 400);
    ok((await api(t.url, "/api/agents", { method: "POST", body: { catalogId: 42 } })).status, 400);
  } finally {
    await t.close();
  }
});

test("catalog: template workers are staffed from their specialists at bootstrap; leaders carry expertise", async () => {
  const t = await createTestApp();
  try {
    const backend = t.agentByRole("backend-engineer");
    assert.equal(backend.catalogId, "engineering/engineering-backend-architect");
    assert.equal(backend.persona.emoji, "🏗️");
    assert.equal(backend.persona.style, "Code-first, explains trade-offs briefly.", "a curated role seed keeps its style");
    assert.equal(backend.persona.personalityType, "INTP");
    assert.ok(backend.identity.assets.some((a) => /Backend Architect playbook/.test(a)));
    for (const a of t.app.platform.org.listActiveAgents().filter((x) => x.tier === "worker")) assert.ok(a.catalogId, `${a.roleId} has a specialist`);
    const cto = t.agentByRole("cto");
    assert.equal(cto.catalogId, "engineering/engineering-software-architect");
    assert.equal(cto.persona.emoji, undefined, "leaders keep their own persona");
    assert.match(t.app.platform.catalog.expertiseFor(cto) ?? "", /^Domain expertise \(Software Architect/);
    assert.equal(t.agentByRole("ceo").catalogId, null);
  } finally {
    await t.close();
  }
});

async function ceoTool(t: TestApp, calls: [string, Record<string, unknown>][]): Promise<{ ok: boolean; content: string; data?: unknown }[]> {
  const results: { ok: boolean; content: string; data?: unknown }[] = [];
  t.brain.script = async (ctx) => {
    if (ctx.agent.roleId !== "ceo" && ctx.agent.roleId !== "cmo") return done();
    for (const [name, args] of calls) results.push(await callTool(ctx, name, args));
    return done();
  };
  return results;
}

test("hire_agent {catalogId}: approval policy kept; on approval the specialist lands in its mapped department", async () => {
  const t = await createTestApp();
  try {
    const { platform } = t.app;
    const ceo = t.agentByRole("ceo");
    assert.ok(platform.tools.specsFor(ceo).some((s) => s.name === "catalog_search"), "executives get catalog_search");
    assert.ok(!platform.tools.specsFor(t.agentByRole("backend-engineer")).some((s) => s.name === "catalog_search"), "workers do not");
    const results = await ceoTool(t, [
      ["catalog_search", { query: "penetration testing red team", division: "security" }],
      ["catalog_search", { query: "anything", division: "nope" }],
      ["hire_agent", { catalogId: "security/security-penetration-tester", justification: "We need an external-attack view before launch." }],
      ["hire_agent", { catalogId: "security/no-such-agent", justification: "x" }],
      ["hire_agent", { catalogId: "sales/sales-coach", tier: "manager", justification: "x" }],
      ["hire_agent", { title: "Analyst", justification: "missing fields" }],
    ]);
    const task = rootTask(t, ceo.id, "Staff security");
    await t.drain();
    const [search, badDivision, hire, unknown, notWorker, missing] = results;
    assert.equal(search?.ok, true);
    assert.match(search!.content, /security\/security-penetration-tester — .*Penetration Tester → Security/);
    assert.equal(badDivision?.ok, false);
    assert.equal(hire?.ok, true);
    assert.match(hire!.content, /approval apr_/, "HIRING_REQUIRES_APPROVAL defaults to true");
    assert.equal(unknown?.ok, false);
    assert.match(unknown!.content, /catalog_search/);
    assert.equal(notWorker?.ok, false);
    assert.equal(missing?.ok, false);
    assert.match(missing!.content, /catalogId/);
    const approval = platform.approvals.list("pending").find((a) => a.kind === "hire_agent") as Approval;
    assert.equal(approval.taskId, task.id);
    assert.match(approval.summary, /Penetration Tester \(catalog specialist, Security, new department\)/);
    assert.equal(platform.repos.departments.bySlug("security"), null, "nothing is created before the Board approves");
    platform.approvals.decide(approval.id, { decision: "approved" });
    const hired = platform.org.getAgent(String(platform.approvals.require(approval.id).payload.hiredAgentId))!;
    assert.equal(hired.catalogId, "security/security-penetration-tester");
    assert.equal(hired.departmentId, platform.repos.departments.bySlug("security")!.id);
    assert.equal(hired.managerId, t.agentByRole("cto").id);
    assert.equal(hired.createdBy, ceo.id);
    assert.equal(hired.cognition, "reflex");
  } finally {
    await t.close();
  }
});

test("hire_agent {catalogId}: direct hire when approval is off; the default manager must be in the caller's subtree", async () => {
  const t = await createTestApp({ env: { HIRING_REQUIRES_APPROVAL: "false" } });
  try {
    const cmo = t.agentByRole("cmo");
    const results = await ceoTool(t, [
      ["hire_agent", { catalogId: "marketing/marketing-seo-specialist", justification: "Organic search is our cheapest channel." }],
      ["hire_agent", { catalogId: "engineering/engineering-sre", justification: "Not mine to hire." }],
      ["hire_agent", { catalogId: "engineering/engineering-sre", managerId: cmo.id, justification: "Reports to me then." }],
    ]);
    rootTask(t, cmo.id, "Grow organic");
    await t.drain();
    const [seo, sre, sreMine] = results;
    assert.equal(seo?.ok, true, seo?.content ?? "no result");
    const hired = t.app.platform.org.getAgent((seo!.data as { agentId: string }).agentId)!;
    assert.equal(hired.catalogId, "marketing/marketing-seo-specialist");
    assert.equal(hired.managerId, cmo.id);
    assert.equal(hired.departmentId, t.app.platform.repos.departments.bySlug("marketing")!.id);
    assert.equal(sre?.ok, false);
    assert.match(sre!.content, /not in your subtree/);
    assert.equal(sreMine?.ok, true, "an explicit managerId in the subtree is accepted");
    assert.equal(t.app.platform.org.getAgent((sreMine!.data as { agentId: string }).agentId)!.managerId, cmo.id);
  } finally {
    await t.close();
  }
});

test("ORG_TEMPLATE=agency: startup leadership + 2-4 catalog specialists per department, within MAX_HEADCOUNT", async () => {
  const t = await createTestApp({ env: { ORG_TEMPLATE: "agency" } });
  try {
    const { org, repos, company } = t.app.platform;
    const agents = org.listActiveAgents();
    assert.equal(company.settings().orgTemplate, "agency");
    assert.ok(agents.length <= 60, `${agents.length} ≤ default MAX_HEADCOUNT 60`);
    assert.ok(agents.length >= 40, `a full agency (${agents.length})`);
    for (const [slug, ids] of Object.entries(AGENCY_STAFFING)) {
      const department = repos.departments.bySlug(slug);
      assert.ok(department, `${slug} exists`);
      const specialists = agents.filter((a) => a.departmentId === department.id && a.tier === "worker" && a.catalogId);
      assert.ok(specialists.length >= 2 && specialists.length <= 4, `${slug}: ${specialists.length} specialists`);
      for (const id of ids) assert.ok(specialists.some((a) => a.catalogId === id), `${slug} staffs ${id}`);
      for (const s of specialists) assert.notEqual(org.getAgent(s.managerId!)!.tier, "worker", `${s.title} reports to a leader`);
    }
    assert.equal(t.app.platform.bootstrapResult?.agents, agents.length);
  } finally {
    await t.close();
  }
  const capped = await createTestApp({ env: { ORG_TEMPLATE: "agency", MAX_HEADCOUNT: "25" } });
  try {
    assert.equal(capped.app.platform.org.listActiveAgents().length, 25, "agency hires stop at MAX_HEADCOUNT");
  } finally {
    await capped.close();
  }
});

test("catalog backfill: agents created before the catalog get their specialist and executives get catalog_search", async () => {
  const first = await createTestApp();
  const dataDir = first.dataDir;
  const backendId = first.agentByRole("backend-engineer").id;
  const ceoId = first.agentByRole("ceo").id;
  first.app.platform.repos.agents.update(backendId, { catalogId: null, persona: { ...first.agentByRole("backend-engineer").persona, emoji: null, vibe: null } });
  first.app.platform.repos.agents.update(ceoId, { tools: first.agentByRole("ceo").tools.filter((x) => x !== "catalog_search") });
  await first.app.close();
  const again = await createTestApp({ dataDir });
  try {
    const backend = again.app.platform.org.getAgent(backendId)!;
    assert.equal(backend.catalogId, "engineering/engineering-backend-architect");
    assert.equal(backend.persona.emoji, "🏗️");
    assert.ok(again.app.platform.org.getAgent(ceoId)!.tools.includes("catalog_search"));
  } finally {
    await again.close();
    const { rmSync } = await import("node:fs");
    rmSync(dataDir, { recursive: true, force: true });
  }
});
