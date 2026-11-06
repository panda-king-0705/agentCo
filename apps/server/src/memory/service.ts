/**
 * MemoryService: long-term memory (FTS5 BM25 blended with importance and
 * recency; agent-private vs global scope), the shared blackboard (global
 * working memory) and agent inboxes (unread agent_dm messages).
 */
import type { BlackboardEntry, MemoryItem, MemoryKind, MemoryScope, Message } from "../../../../packages/shared/src/index.ts";
import type { MemorySearchQuery, MemoryService, MemoryWriteInput } from "../contracts.ts";
import type { Repositories } from "../db/index.ts";
import { newId } from "../db/ids.ts";
import { toMemory } from "../db/mappers.ts";
import type { EventBus } from "../events/bus.ts";
import { oneLine } from "../events/bus.ts";
import { badRequest } from "../http/errors.ts";
import type { Redactor } from "../middleware/redact.ts";

export const MEMORY_KINDS: readonly MemoryKind[] = ["episodic", "semantic", "procedural", "conceptual", "working"];
export const MEMORY_SCOPES: readonly MemoryScope[] = ["agent", "global"];
const WEIGHTS = { relevance: 0.6, importance: 0.25, recency: 0.15 };
const RECENCY_HALF_LIFE_DAYS = 30;
const MAX_CONTENT = 8000;
const BLACKBOARD_KEY = /^[A-Za-z0-9._:/-]{1,80}$/;

/** Turns free text into a safe FTS5 OR-query of quoted tokens (no operators from user input). */
export function ftsQuery(text: string): string | null {
  const tokens = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).slice(0, 16))];
  return tokens.length ? tokens.map((t) => `"${t}"`).join(" OR ") : null;
}

export class MemoryServiceImpl implements MemoryService {
  private readonly repos: Repositories;
  private readonly bus: EventBus;
  private readonly redactor: Redactor;
  private readonly now: () => Date;

  constructor(repos: Repositories, bus: EventBus, redactor: Redactor, now: () => Date) {
    this.repos = repos;
    this.bus = bus;
    this.redactor = redactor;
    this.now = now;
  }

  /** Ranked memories: 0.6·BM25 relevance + 0.25·importance + 0.15·recency. Bumps accessCount unless bump=false. */
  search(query: MemorySearchQuery, options: { bump?: boolean } = {}): MemoryItem[] {
    const limit = Math.min(Math.max(query.limit ?? 6, 1), 100);
    const visibility = { agentId: query.agentId ?? null, scopes: query.scopes ?? ["agent", "global"], kinds: query.kinds ?? null };
    const fts = ftsQuery(query.query ?? "");
    const items = fts ? this.rank(this.repos.memories.match(fts, visibility, limit * 4), limit) : this.repos.memories.recent(visibility, limit);
    if (options.bump !== false && items.length) this.repos.memories.bumpAccess(items.map((m) => m.id), this.now().toISOString());
    return items;
  }

  /** Recent memories without a query (console browsing). */
  recent(filter: { agentId?: string | null; scopes: MemoryScope[]; kinds?: MemoryKind[] | null; limit?: number }): MemoryItem[] {
    return this.repos.memories.recent({ agentId: filter.agentId ?? null, scopes: filter.scopes, kinds: filter.kinds ?? null }, filter.limit ?? 100);
  }

  /** Stores a memory (content redacted) and emits memory.written. */
  write(input: MemoryWriteInput): MemoryItem {
    return this.upsert(input).item;
  }

  /** write(), also saying whether an earlier memory of the same task was replaced (upsertWithinTask). */
  upsert(input: MemoryWriteInput): { item: MemoryItem; updated: boolean } {
    if (!MEMORY_KINDS.includes(input.kind)) throw badRequest(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
    if (!MEMORY_SCOPES.includes(input.scope)) throw badRequest("scope must be agent or global");
    if (input.scope === "agent" && !input.agentId) throw badRequest("agent-scoped memories need an agentId");
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (!content) throw badRequest("content must be a non-empty string");
    const item: MemoryItem = {
      id: newId("mem"),
      scope: input.scope,
      agentId: input.agentId,
      kind: input.kind,
      content: this.redactor.redact(content.slice(0, MAX_CONTENT)),
      tags: (input.tags ?? []).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim().slice(0, 40)).slice(0, 12),
      importance: Math.min(1, Math.max(0, input.importance ?? 0.5)),
      sourceRunId: input.sourceRunId ?? null,
      sourceTaskId: input.sourceTaskId ?? null,
      accessCount: 0,
      createdAt: this.now().toISOString(),
      lastAccessedAt: null,
    };
    if (input.upsertWithinTask) {
      const twin = this.repos.memories.findTaskTwin(item);
      if (twin) {
        this.repos.memories.replaceContent(twin.id, { content: item.content, tags: item.tags, importance: item.importance });
        const updated = { ...twin, content: item.content, tags: item.tags, importance: item.importance };
        this.bus.emit("memory.written", { agentId: updated.agentId, taskId: updated.sourceTaskId, runId: item.sourceRunId, summary: `${updated.scope} ${updated.kind} memory updated: ${oneLine(updated.content, 100)}`, data: updated });
        return { item: updated, updated: true };
      }
    }
    this.repos.memories.insert(item);
    this.bus.emit("memory.written", { agentId: item.agentId, taskId: item.sourceTaskId, runId: item.sourceRunId, summary: `${item.scope} ${item.kind} memory: ${oneLine(item.content, 100)}`, data: item });
    return { item, updated: false };
  }

  blackboardList(): BlackboardEntry[] {
    return this.repos.blackboard.list();
  }

  blackboardGet(key: string): BlackboardEntry | null {
    return this.repos.blackboard.get(key);
  }

  blackboardSet(key: string, value: string, updatedBy: string): BlackboardEntry {
    if (!BLACKBOARD_KEY.test(key)) throw badRequest("key must be 1-80 chars of letters, digits, . _ : / -");
    if (typeof value !== "string" || value.length > 20_000) throw badRequest("value must be a string of at most 20000 chars");
    const entry: BlackboardEntry = { key, value: this.redactor.redact(value), updatedBy, updatedAt: this.now().toISOString() };
    this.repos.blackboard.set(entry);
    this.bus.emit("memory.written", { agentId: updatedBy.startsWith("agt_") ? updatedBy : null, summary: `Blackboard "${key}" updated`, data: { blackboard: entry } });
    return entry;
  }

  inbox(agentId: string, limit = 10): Message[] {
    return this.repos.conversations.inbox(agentId, Math.min(Math.max(limit, 1), 100));
  }

  markRead(messageIds: string[]): void {
    this.repos.conversations.markRead(messageIds, this.now().toISOString());
  }

  private rank(rows: Record<string, unknown>[], limit: number): MemoryItem[] {
    if (rows.length === 0) return [];
    const relevance = rows.map((r) => Math.max(0, -Number(r.score ?? 0)));
    const maxRelevance = Math.max(...relevance, 1e-9);
    const nowMs = this.now().getTime();
    return rows
      .map((row, index) => {
        const item = toMemory(row);
        const ageDays = Math.max(0, (nowMs - Date.parse(item.createdAt)) / 86_400_000);
        const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
        const score = WEIGHTS.relevance * ((relevance[index] ?? 0) / maxRelevance) + WEIGHTS.importance * item.importance + WEIGHTS.recency * recency;
        return { item, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.item);
  }
}
