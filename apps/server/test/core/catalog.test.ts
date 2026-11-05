/**
 * Specialist catalog (docs/CATALOG.md): parsing real agency-agents files (including the odd ones),
 * malformed-file tolerance, the playbook compiler's token cap, the division → department mapping
 * and the role templates' catalog ids.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileExpertise, compilePlaybook, estimateTokens, toUnits } from "../../src/catalog/compile.ts";
import { classifyHeading, CatalogParseError, parseAgentFile, parseFrontmatter, splitFrontmatter, splitSections } from "../../src/catalog/parse.ts";
import { Catalog, createCatalog, DEFAULT_CATALOG_DIR, loadCatalogDir, loadDivisionMap } from "../../src/catalog/service.ts";
import { AGENCY_STAFFING, DEPARTMENT_TEMPLATES, ROLE_CATALOG, ROLE_TEMPLATES } from "../../src/org/templates.ts";

const catalog = createCatalog({ log: () => {} });
const read = (rel: string) => readFileSync(join(DEFAULT_CATALOG_DIR, rel), "utf8");
const parse = (rel: string) => parseAgentFile(rel, read(rel));

test("catalog: the vendored catalog loads every division file with nothing skipped", () => {
  const divisions = JSON.parse(read("divisions.json")).divisions as Record<string, unknown>;
  assert.ok(catalog.size >= 250, `~280 specialists (got ${catalog.size})`);
  assert.deepEqual(catalog.skipped, []);
  assert.deepEqual(new Set(catalog.all().map((a) => a.division)), new Set(Object.keys(divisions)));
  for (const nonDivision of ["strategy", "integrations", "examples", "scripts"]) assert.ok(!catalog.all().some((a) => a.division === nonDivision), `${nonDivision}/ is not a division`);
  const ids = catalog.all().map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const a of catalog.all()) {
    assert.match(a.id, /^[a-z-]+\/[a-z0-9-]+$/);
    assert.ok(a.name && a.description, `${a.id} has name + description`);
    assert.ok(a.sections.identity, `${a.id} has an identity (preamble or section)`);
    assert.ok(a.wordCount > 50);
  }
  assert.match(catalog.source().commit, /^[0-9a-f]{40}$/, "commit read from VENDOR.md");
});

test("catalog: a standard file — frontmatter fields and classified sections", () => {
  const { agent } = parse("engineering/engineering-backend-architect.md");
  assert.equal(agent.id, "engineering/engineering-backend-architect");
  assert.equal(agent.division, "engineering");
  assert.equal(agent.name, "Backend Architect");
  assert.equal(agent.emoji, "🏗️");
  assert.equal(agent.color, "blue");
  assert.match(agent.vibe, /hold everything up/);
  assert.match(agent.sections.identity, /You are \*\*Backend Architect\*\*/);
  assert.match(agent.sections.identity, /Strategic, security-focused/);
  assert.match(agent.sections.mission, /Data\/Schema Engineering Excellence/);
  assert.match(agent.sections.rules, /Security-First Architecture/);
  assert.match(agent.sections.deliverables, /System Architecture Design/);
  assert.match(agent.sections.other, /### .*Communication Style/);
});

test("catalog: odd files — no vibe, aligned multi-line values, quoted values, services lists, nested folders", () => {
  // No vibe at all.
  const cms = parse("engineering/engineering-cms-developer.md").agent;
  assert.equal(cms.vibe, "");
  assert.equal(cms.emoji, "🧱");
  // Aligned "key:        value" and a plain description continued on indented lines; quoted, padded colour.
  const health = parse("healthcare/healthcare-innovation-strategist.md").agent;
  assert.equal(health.name, "Healthcare Innovation Strategist");
  assert.match(health.description, /^Strategic narrative architect for healthcare founders operating at the intersection of clinical credibility/);
  assert.match(health.description, /builds trust with doctors and patients simultaneously\.$/);
  assert.ok(!health.description.includes("\n"));
  assert.equal(health.color, "#1B4F72");
  assert.equal(health.emoji, "🧭");
  // Double-quoted description with a colon inside.
  const tooling = parse("engineering/engineering-developer-tooling-engineer.md").agent;
  assert.match(tooling.description, /^Expert developer-tooling and CLI engineer — .*great DX: intuitive/);
  assert.ok(!tooling.description.startsWith('"'));
  // services: list between keys; quoted hex colour.
  const carousel = parse("marketing/marketing-carousel-growth-engine.md");
  assert.equal(carousel.agent.color, "#FF0050");
  assert.equal(carousel.agent.emoji, "🎠");
  assert.match(carousel.frontmatter.services ?? "", /- name: Gemini API/);
  const gate = parse("design/design-ui-finish-gate-reviewer.md").agent;
  assert.match(gate.vibe, /^Allergic to dashboards/);
  // Nested division folder: the id keeps division/slug.
  assert.equal(parse("game-development/unity/unity-architect.md").agent.id, "game-development/unity-architect");
  assert.ok(catalog.get("game-development/unity-architect"));
});

test("catalog: headings inside fenced templates are content, not sections", () => {
  const body = parse("product/product-manager.md").body;
  const headings = splitSections(body).sections.map((s) => s.heading);
  assert.ok(!headings.some((h) => /Problem Statement/.test(h)), "the PRD template's ## headings stay inside the deliverables");
  const pm = catalog.get("product/product-manager")!;
  assert.match(pm.sections.deliverables, /## 1\. Problem Statement/);
  assert.match(toUnits(pm.sections.deliverables, { keepFenceOutline: true }).join("\n"), /Template outline: PRD: .*Problem Statement/);
});

test("catalog: heading classification", () => {
  const cases: [string, string][] = [
    ["🧠 Your Identity & Memory", "identity"],
    ["Identity & Role Definition", "identity"],
    ["🎯 Your Core Mission", "mission"],
    ["Your Core Mission & Key Tasks", "mission"],
    ["Core Capabilities", "mission"],
    ["🚨 Critical Rules You Must Follow", "rules"],
    ['🚫 Your "AUTOMATIC FAIL" Triggers', "rules"],
    ["What This Agent Does Not Do", "rules"],
    ["📋 Your Technical Deliverables", "deliverables"],
    ["Your Deliverable Template", "deliverables"],
    ["🔄 Your Workflow Process", "workflow"],
    ["Your Mandatory Process", "workflow"],
    ["🎯 Your Success Metrics", "metrics"],
    ["💭 Your Communication Style", "other"],
    ["🔄 Learning & Memory", "other"],
    ["🚀 Advanced Capabilities", "other"],
  ];
  for (const [heading, key] of cases) assert.equal(classifyHeading(heading), key, heading);
});

test("catalog: malformed files are skipped and counted, never fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentco-catalog-"));
  try {
    writeFileSync(join(dir, "divisions.json"), JSON.stringify({ divisions: { alpha: { label: "Alpha", icon: "Box", color: "#111111" } } }));
    mkdirSync(join(dir, "alpha"));
    const good = "---\nname: Good Agent\ndescription: Does good work.\nemoji: ✅\n---\n\n# Good\n\nYou are good.\n\n## Critical Rules\n- Be good\n";
    writeFileSync(join(dir, "alpha", "alpha-good.md"), good);
    writeFileSync(join(dir, "alpha", "no-frontmatter.md"), "# Just a heading\n\nNo frontmatter here.\n");
    writeFileSync(join(dir, "alpha", "unclosed.md"), "---\nname: Broken\ndescription: never closed\n\n# Body\n");
    writeFileSync(join(dir, "alpha", "no-name.md"), "---\ndescription: nameless\n---\n\nBody text.\n");
    writeFileSync(join(dir, "alpha", "empty-body.md"), "---\nname: Empty\ndescription: nothing below\n---\n");
    writeFileSync(join(dir, "alpha", "notes.txt"), "not markdown");
    const loaded = loadCatalogDir(dir);
    assert.deepEqual(loaded.agents.map((a) => a.id), ["alpha/alpha-good"]);
    assert.equal(loaded.skipped.length, 4);
    assert.deepEqual(loaded.skipped.map((s) => s.path).sort(), ["alpha/empty-body.md", "alpha/no-frontmatter.md", "alpha/no-name.md", "alpha/unclosed.md"]);
    const small = new Catalog(loaded, loadDivisionMap());
    assert.equal(small.source().skipped, 4);
    assert.match(small.playbook("alpha/alpha-good")!.text, /Critical rules:\n- Be good/);
    // A missing directory is an empty catalog, not an error.
    assert.equal(loadCatalogDir(join(dir, "missing")).agents.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => splitFrontmatter("no frontmatter"), CatalogParseError);
  assert.throws(() => parseAgentFile("alpha/x.md", "---\nname: X\n---\nbody"), /no description/);
  assert.deepEqual(parseFrontmatter("name: 'It''s fine'\ndescription: >\n  folded\n  text\n"), { name: "It's fine", description: "folded text" });
});

test("catalog: the playbook compiler holds its cap for every specialist and keeps priority order", () => {
  for (const cap of [900, 400, 150]) {
    for (const a of catalog.all()) {
      const p = compilePlaybook(a, cap);
      assert.ok(p.tokens <= cap, `${a.id} at cap ${cap}: ${p.tokens} tokens`);
      assert.equal(p.tokens, estimateTokens(p.text));
      assert.equal(p.sections[0], "identity", `${a.id}: identity always leads`);
    }
  }
  const pm = catalog.get("product/product-manager")!;
  const full = compilePlaybook(pm, 900);
  assert.deepEqual(full.sections, ["identity", "mission", "rules", "deliverables"]);
  const order = ["Identity:", "Mission:", "Critical rules:", "Deliverable formats:"].map((h) => full.text.indexOf(h));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections appear in priority order");
  assert.match(full.text, /^Specialist playbook — 🧭 Product Manager \(agency-agents product\/product-manager\)\nVibe: /);
  assert.match(full.text, /Lead with the problem, not the solution/);
  assert.match(full.text, /Template outline: PRD/);
  assert.ok(full.truncated, "the 30 kB source does not fit in 900 tokens");
  // Tight cap: lower priorities are trimmed first.
  const tight = compilePlaybook(pm, 200);
  assert.ok(tight.tokens <= 200 && tight.truncated);
  assert.ok(tight.text.includes("Identity:"));
  assert.ok(tight.text.length < full.text.length);
  // Workflow, metrics and the rest are left to the full text in the console.
  assert.ok(!/\n(Workflow|Success metrics):/i.test(full.text));
  // The configurable cap reaches the catalog.
  const small = createCatalog({ playbookTokens: 300, log: () => {} });
  assert.ok(small.playbook("product/product-manager")!.tokens <= 300);
  // Expertise for leaders stays short.
  for (const id of new Set(Object.values(ROLE_CATALOG))) assert.ok(estimateTokens(compileExpertise(catalog.get(id)!)) <= 120, id);
  assert.match(catalog.expertise("engineering/engineering-software-architect")!, /^Domain expertise \(Software Architect, agency-agents\): /);
});

test("catalog: every division maps to a department; overrides and optional departments are valid", () => {
  const map = loadDivisionMap();
  const standard = new Set(DEPARTMENT_TEMPLATES.map((d) => d.slug));
  const optional = new Set(Object.keys(map.optionalDepartments));
  const known = (slug: string) => standard.has(slug) || optional.has(slug);
  for (const division of catalog.divisions()) {
    const entry = map.divisions[division.id];
    assert.ok(entry, `division ${division.id} has a mapping`);
    assert.ok(known(entry.department), `${division.id} → ${entry.department} is a known department`);
    assert.equal(division.optional, optional.has(entry.department));
  }
  for (const [id, slug] of Object.entries(map.agentOverrides)) {
    assert.ok(catalog.has(id), `override ${id} names a catalog agent`);
    assert.ok(known(slug), `override ${id} → ${slug} is a known department`);
  }
  // The whole specialized division is placed one by one.
  for (const a of catalog.all().filter((x) => x.division === "specialized")) assert.ok(map.agentOverrides[a.id], `${a.id} has a best-fit department`);
  // Optional departments have an executive owner and only exist for homeless divisions.
  for (const [slug, d] of Object.entries(map.optionalDepartments)) {
    assert.ok(!standard.has(slug), `${slug} does not shadow a standard department`);
    assert.ok(d.ownerRoleIds.length > 0 && d.ownerRoleIds.every((r) => ROLE_TEMPLATES.some((t) => t.id === r && t.tier === "executive")), `${slug} has executive owners`);
  }
  assert.deepEqual([...optional].sort(), ["game-studio", "geospatial", "healthcare", "spatial-computing"]);
  // Spot checks from the brief.
  const dept = (id: string) => catalog.departmentSlugFor(id);
  assert.equal(dept("design/design-ui-designer"), "product");
  assert.equal(dept("paid-media/paid-media-ppc-strategist"), "marketing");
  assert.equal(dept("sales/sales-coach"), "revenue");
  assert.equal(dept("security/security-architect"), "security");
  assert.equal(dept("testing/testing-api-tester"), "engineering");
  assert.equal(dept("project-management/project-management-project-shepherd"), "operations");
  assert.equal(dept("research/research-synthesist"), "strategy");
  assert.equal(dept("academic/academic-statistician"), "data");
  assert.equal(dept("specialized/legal-document-review"), "legal");
  assert.equal(dept("game-development/unity-architect"), "game-studio");
});

test("catalog: every role template's catalogId exists; every worker template has one", () => {
  for (const role of ROLE_TEMPLATES) {
    if (role.tier === "worker") assert.ok(role.catalogId, `worker ${role.id} is staffed from a catalog specialist`);
    if (role.catalogId) assert.ok(catalog.has(role.catalogId), `${role.id} → ${role.catalogId} exists in the catalog`);
  }
  for (const [roleId, catalogId] of Object.entries(ROLE_CATALOG)) {
    assert.ok(ROLE_TEMPLATES.some((r) => r.id === roleId), `ROLE_CATALOG names a real role (${roleId})`);
    assert.ok(catalog.has(catalogId), catalogId);
  }
  for (const [slug, ids] of Object.entries(AGENCY_STAFFING)) {
    assert.ok(DEPARTMENT_TEMPLATES.some((d) => d.slug === slug), `agency staffs a real department (${slug})`);
    assert.ok(ids.length >= 2 && ids.length <= 4, `${slug}: 2-4 specialists`);
    for (const id of ids) assert.ok(catalog.has(id), id);
  }
});

test("catalog: search ranks by name, then description, and filters by division", () => {
  const hits = catalog.search("backend architect");
  assert.equal(hits[0]?.id, "engineering/engineering-backend-architect");
  const tiktok = catalog.search("tiktok", { division: "marketing" });
  assert.ok(tiktok.length > 0 && tiktok.every((a) => a.division === "marketing"));
  assert.equal(tiktok[0]?.id, "marketing/marketing-tiktok-strategist");
  assert.ok(catalog.list({ division: "security" }).every((a) => a.division === "security"));
  assert.equal(catalog.search("zzqqxx").length, 0);
  // Seeds: persona and assets from the specialist.
  const seed = catalog.seed("engineering/engineering-backend-architect")!;
  assert.equal(seed.title, "Backend Architect");
  assert.deepEqual(seed.traits, ["strategic", "security-focused", "scalability-minded", "reliability-obsessed"]);
  assert.match(seed.personalityType, /^[EI][SN][TF][JP]$/);
  assert.match(seed.assets[0]!, /Backend Architect playbook/);
});
