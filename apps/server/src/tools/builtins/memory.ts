/** memory_search, memory_write, blackboard_read, blackboard_write. */
import type { MemoryKind, MemoryScope } from "../../../../../packages/shared/src/index.ts";
import { oneLine } from "../../events/bus.ts";
import { MEMORY_KINDS } from "../../memory/service.ts";
import { ALL_TIERS, fail, LEADS, ok, type ToolDefinition } from "../types.ts";

export const memorySearch: ToolDefinition = {
  name: "memory_search",
  description: "Search long-term memory (your own and the company's), ranked by relevance, importance and recency.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 1000 },
      scope: { type: "string", enum: ["agent", "global", "all"] },
      kind: { type: "string", enum: [...MEMORY_KINDS] },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query"],
  },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const scope = args.scope === "agent" || args.scope === "global" ? [args.scope as MemoryScope] : (["agent", "global"] as MemoryScope[]);
    const items = ctx.services.memory.search({
      query: String(args.query),
      agentId: ctx.agent.id,
      scopes: scope,
      ...(typeof args.kind === "string" ? { kinds: [args.kind as MemoryKind] } : {}),
      limit: typeof args.limit === "number" ? args.limit : 6,
    });
    if (items.length === 0) return ok("No matching memories.", [], { items: [] });
    const lines = items.map((m, i) => `${i + 1}. [${m.scope}/${m.kind}] ${oneLine(m.content, 400)}${m.tags.length ? ` (tags: ${m.tags.join(", ")})` : ""}`);
    return ok(lines.join("\n"), [], { items });
  },
};

export const memoryWrite: ToolDefinition = {
  name: "memory_write",
  description: "Write a long-term memory. scope=agent is private; scope=global is shared (semantic/procedural/conceptual global memories need a manager or executive).",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", maxLength: 8000 },
      kind: { type: "string", enum: [...MEMORY_KINDS] },
      scope: { type: "string", enum: ["agent", "global"] },
      tags: { type: "array", items: { type: "string", maxLength: 40 } },
      importance: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["content", "kind", "scope"],
  },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const kind = args.kind as MemoryKind;
    const scope = args.scope as MemoryScope;
    if (scope === "global" && ctx.agent.tier === "worker" && kind !== "episodic" && kind !== "working") {
      return fail("Workers may only write global episodic memories; ask your manager to record semantic/procedural knowledge.");
    }
    const item = ctx.services.memory.write({
      scope,
      agentId: ctx.agent.id,
      kind,
      content: String(args.content),
      tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
      ...(typeof args.importance === "number" ? { importance: args.importance } : {}),
      sourceRunId: ctx.runId,
      sourceTaskId: ctx.taskId,
    });
    return ok(`Stored ${scope} ${kind} memory ${item.id}.`, [{ kind: "memory_written", memoryId: item.id }], { id: item.id });
  },
};

export const blackboardRead: ToolDefinition = {
  name: "blackboard_read",
  description: "Read the company blackboard (shared working memory). Omit key to list every entry.",
  parameters: { type: "object", properties: { key: { type: "string", maxLength: 80 } } },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const memory = ctx.services.memory;
    if (typeof args.key === "string" && args.key) {
      const entry = memory.blackboardGet(args.key);
      return entry ? ok(`${entry.key} = ${entry.value}`, [], entry) : fail(`No blackboard entry "${args.key}".`);
    }
    const entries = memory.blackboardList();
    return ok(entries.length ? entries.map((e) => `- ${e.key}: ${oneLine(e.value, 300)}`).join("\n") : "The blackboard is empty.", [], { entries });
  },
};

export const blackboardWrite: ToolDefinition = {
  name: "blackboard_write",
  description: "Write a key on the company blackboard (shared working memory) for everyone to see.",
  parameters: {
    type: "object",
    properties: { key: { type: "string", maxLength: 80 }, value: { type: "string", maxLength: 20000 } },
    required: ["key", "value"],
  },
  tiers: LEADS,
  run(args, ctx) {
    const entry = ctx.services.memory.blackboardSet(String(args.key), String(args.value), ctx.agent.id);
    return ok(`Blackboard "${entry.key}" updated.`, [], entry);
  },
};
