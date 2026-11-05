/**
 * Catalog specialists in cognition (docs/CATALOG.md): the reflex system prompt carries the compiled
 * playbook, the brain charter carries a leader's domain expertise, and Role Arrangement's mandateFit
 * reads a catalog worker's description + mission without changing the Q9 tie-break.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatRequest, ModelProvider } from "../../src/contracts.ts";
import type { ModelProfile } from "../../../../packages/shared/src/index.ts";
import { createCatalog } from "../../src/catalog/service.ts";
import { ReflexEngine } from "../../src/cognition/reflex.ts";
import { agentFacts } from "../../src/cognition/prompt.ts";
import { renderCharter } from "../../src/cognition/brain/self-management/identity.ts";
import { profileText, scoreCandidates } from "../../src/cognition/brain/self-management/role-arrangement.ts";
import { computeBaZi } from "../../src/cognition/brain/self-management/bazi.ts";
import { MockProvider } from "../../src/models/providers/mock.ts";
import { FakePlatform, makeAgent, makeTask, taskInput } from "./fakes.ts";

const catalog = createCatalog({ log: () => {} });

class CapturingProvider implements ModelProvider {
  readonly name = "mock";
  readonly systems: string[] = [];
  private readonly inner = new MockProvider({ latencyMs: 0 });
  complete(profile: ModelProfile, request: ChatRequest, signal: AbortSignal) {
    this.systems.push(request.messages.find((m) => m.role === "system")?.content ?? "");
    return this.inner.complete(profile, request, signal);
  }
}

function setup(catalogId: string | null) {
  const provider = new CapturingProvider();
  const platform = new FakePlatform({ providers: { mock: provider } });
  Object.assign(platform, { catalog });
  platform.addDepartment("dep_mkt", "marketing", "Marketing");
  const cmo = platform.addAgent(makeAgent({ id: "agt_cmo", name: "Maya Ortiz", title: "Chief Marketing Officer", departmentId: "dep_mkt", tier: "executive", cognition: "brain", modelTier: "frontier", catalogId: "design/design-brand-guardian" }));
  const worker = platform.addAgent(
    makeAgent({ id: "agt_writer", name: "Sam Lee", title: "Content Writer", departmentId: "dep_mkt", managerId: cmo.id, catalogId, tools: ["workspace_write_file", "memory_search"] }),
  );
  const task = platform.addTask(makeTask({ id: "tsk_w", number: 7, title: "Write the launch blog post", description: "Announce the product.", assigneeId: worker.id }));
  return { platform, provider, worker, cmo, task };
}

test("reflex: a catalog worker's system prompt carries its compiled specialist playbook, after the charter", async () => {
  const { platform, provider, worker, task } = setup("marketing/marketing-content-creator");
  const result = await new ReflexEngine().run(platform.context(worker, taskInput(task)));
  assert.equal(result.outcome, "completed");
  assert.ok(provider.systems.length >= 1);
  const playbook = catalog.playbook("marketing/marketing-content-creator")!;
  for (const system of provider.systems) {
    assert.ok(system.includes(playbook.text), "the whole compiled playbook is in the prompt");
    assert.ok(system.indexOf("You are Sam Lee, Content Writer") < system.indexOf("Specialist playbook — "), "charter first, then the playbook");
    assert.ok(system.indexOf("Specialist playbook — ") < system.indexOf("Task T-7"), "then the task");
    assert.match(system, /"specialist":"marketing\/marketing-content-creator"/, "the context block names the specialist");
  }
  assert.ok(playbook.tokens <= 900);
});

test("reflex: a worker without a catalogId (or with an unknown one) has no playbook", async () => {
  for (const id of [null, "marketing/not-in-the-catalog"]) {
    const { platform, provider, worker, task } = setup(id);
    await new ReflexEngine().run(platform.context(worker, taskInput(task)));
    assert.ok(provider.systems.every((s) => !s.includes("Specialist playbook")), String(id));
  }
});

test("brain: an executive with a catalogId gets a short domain-expertise line in its charter (no playbook)", () => {
  const { platform, cmo, worker } = setup("marketing/marketing-content-creator");
  const facts = agentFacts(platform, cmo);
  assert.equal(facts.playbook, undefined);
  assert.match(facts.expertise ?? "", /^Domain expertise \(Brand Guardian, agency-agents\): /);
  const charter = renderCharter(cmo, facts);
  assert.ok(charter.includes(facts.expertise!));
  assert.ok(Math.ceil(facts.expertise!.length / 4) <= 120, "kept short: the charter is paid on every stage");
  assert.equal(agentFacts(platform, worker).expertise, undefined, "workers get the playbook instead");
  const plain = { ...cmo, catalogId: null };
  assert.ok(!renderCharter(plain, agentFacts(platform, plain)).includes("Domain expertise"));
});

test("role arrangement: mandateFit reads a catalog worker's description + mission; Q9 tie-break unchanged", () => {
  const chart = computeBaZi("2026-05-28T12:00:00Z");
  const mk = (id: string, catalogId: string | null, elements: Record<string, number>, tier: "worker" | "manager" = "worker") =>
    makeAgent({ id, title: "Analyst", tier, catalogId, identity: { mission: "Support the team with analysis.", assets: [] } as never, persona: { style: "", traits: [], personalityType: "INTJ", baZi: { ...chart, elements: elements as never } } });
  const cand = (agent: ReturnType<typeof mk>) => ({ agent, departmentName: "Strategy", catalogProfile: catalog.profileFor(agent) });
  const subprocess = "Build a value-based pricing model and competitor price benchmark for the enterprise tier";

  // Same title/mission: the pricing specialist's catalog text decides.
  const generic = mk("generic", null, { wood: 4, fire: 0, earth: 0, metal: 0, water: 0 });
  const pricing = mk("pricing", "specialized/specialized-pricing-analyst", { wood: 0, fire: 0, earth: 0, metal: 0, water: 4 });
  assert.match(profileText(cand(pricing)), /pricing/i);
  assert.ok(!/pricing/i.test(profileText(cand(generic))));
  const ranked = scoreCandidates(subprocess, [cand(generic), cand(pricing)], { fallbackDepartment: "Strategy" });
  assert.equal(ranked[0]!.agentId, "pricing");
  assert.ok(ranked[0]!.mandateFit > ranked[1]!.mandateFit + 0.05, "a clear fit, not a tie");
  assert.equal(ranked[0]!.tieBroken, false);

  // Two workers staffed from the same specialist tie on fit → BaZi (element) breaks the tie, as before.
  const twinA = mk("twin-a", "specialized/specialized-pricing-analyst", { wood: 0, fire: 0, earth: 0, metal: 0, water: 4 });
  const twinB = mk("twin-b", "specialized/specialized-pricing-analyst", { wood: 4, fire: 0, earth: 0, metal: 0, water: 0 });
  const twins = scoreCandidates(subprocess, [cand(twinA), cand(twinB)], { fallbackDepartment: "Strategy" });
  assert.equal(twins[0]!.fit, twins[1]!.fit);
  assert.equal(twins[0]!.agentId, "twin-b", "Strategy is a wood department: the wood-heavy twin wins the tie");
  assert.equal(twins[0]!.tieBroken, true);

  // Leaders' catalog ids are domain expertise, not mandate text.
  const lead = mk("lead", "specialized/specialized-pricing-analyst", { wood: 1, fire: 1, earth: 1, metal: 1, water: 1 }, "manager");
  assert.equal(catalog.profileFor(lead), null);
  assert.ok(!/pricing/i.test(profileText({ agent: lead, departmentName: "Strategy", catalogProfile: "pricing pricing" })));
});
