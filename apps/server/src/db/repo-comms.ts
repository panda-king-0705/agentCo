/** Conversations, messages, memories (+FTS5) and the blackboard. */
import type { BlackboardEntry, Conversation, MemoryItem, Message } from "../../../../packages/shared/src/index.ts";
import type { Db } from "./database.ts";
import { toBlackboard, toConversation, toMemory, toMessage, type Row } from "./mappers.ts";
import { all, insertRow, one, updateRow } from "./sql.ts";

export class ConversationRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(conversation: Conversation): void {
    insertRow(this.db, "conversations", { ...conversation });
  }

  get(id: string): Conversation | null {
    const row = one(this.db, "SELECT * FROM conversations WHERE id = ?", id);
    return row ? toConversation(row) : null;
  }

  boardroom(): Conversation | null {
    const row = one(this.db, "SELECT * FROM conversations WHERE kind = 'boardroom' ORDER BY created_at LIMIT 1");
    return row ? toConversation(row) : null;
  }

  /** The conversation of `kind` whose participant set equals `participants` exactly. */
  findByParticipants(kind: Conversation["kind"], participants: string[]): Conversation | null {
    const key = JSON.stringify([...participants].sort());
    const rows = all(this.db, "SELECT * FROM conversations WHERE kind = ?", kind).map(toConversation);
    return rows.find((c) => JSON.stringify([...c.participantIds].sort()) === key) ?? null;
  }

  list(participantId?: string): Conversation[] {
    const sql = participantId
      ? "SELECT * FROM conversations WHERE EXISTS (SELECT 1 FROM json_each(participant_ids) WHERE value = ?)"
      : "SELECT * FROM conversations";
    const order = " ORDER BY (kind = 'boardroom') DESC, COALESCE(last_message_at, created_at) DESC";
    return (participantId ? all(this.db, sql + order, participantId) : all(this.db, sql + order)).map(toConversation);
  }

  touch(id: string, at: string): void {
    this.db.prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?").run(at, id);
  }

  insertMessage(message: Message): void {
    insertRow(this.db, "messages", { ...message });
  }

  updateMessage(id: string, patch: Partial<Message>): void {
    updateRow(this.db, "messages", id, patch);
  }

  getMessage(id: string): Message | null {
    const row = one(this.db, "SELECT * FROM messages WHERE id = ?", id);
    return row ? toMessage(row) : null;
  }

  /** Messages oldest → newest (insertion order). `after` filters by createdAt; else the newest `limit`. */
  messages(conversationId: string, options: { after?: string; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
    if (options.after) {
      return all(
        this.db,
        `SELECT * FROM messages WHERE conversation_id = ? AND created_at > ? ORDER BY rowid LIMIT ${limit}`,
        conversationId,
        options.after,
      ).map(toMessage);
    }
    const rows = all(this.db, `SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT ${limit}`, conversationId);
    return rows.reverse().map(toMessage);
  }

  /** Every message up to and including `messageId`, oldest first. */
  historyThrough(conversationId: string, messageId: string): Message[] {
    return all(
      this.db,
      `SELECT * FROM messages WHERE conversation_id = ? AND rowid <= (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid`,
      conversationId,
      messageId,
    ).map(toMessage);
  }

  /** Human messages in boardroom/dm conversations that no run has picked up yet (oldest first). */
  pendingHumanMessages(): Message[] {
    return all(
      this.db,
      `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.sender_id = 'human' AND m.run_id IS NULL AND c.kind IN ('boardroom','dm') ORDER BY m.rowid`,
    ).map(toMessage);
  }

  /** Unread agent_dm messages addressed to the agent. */
  inbox(agentId: string, limit: number): Message[] {
    return all(
      this.db,
      `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.kind = 'agent_dm' AND m.read_at IS NULL AND m.sender_id != ?
         AND EXISTS (SELECT 1 FROM json_each(c.participant_ids) WHERE value = ?)
       ORDER BY m.rowid LIMIT ?`,
      agentId,
      agentId,
      limit,
    ).map(toMessage);
  }

  markRead(ids: string[], at: string): void {
    const statement = this.db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL");
    for (const id of ids) statement.run(at, id);
  }
}

export class MemoryRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(item: MemoryItem): void {
    insertRow(this.db, "memories", { ...item });
    this.db.prepare("INSERT INTO memories_fts (content, tags, memory_id) VALUES (?, ?, ?)").run(item.content, item.tags.join(" "), item.id);
  }

  get(id: string): MemoryItem | null {
    const row = one(this.db, "SELECT * FROM memories WHERE id = ?", id);
    return row ? toMemory(row) : null;
  }

  /** This agent's earlier memory for the same task with the same scope, kind and tag set (upsert target). */
  findTaskTwin(item: Pick<MemoryItem, "scope" | "agentId" | "kind" | "tags" | "sourceTaskId">): MemoryItem | null {
    if (!item.sourceTaskId) return null;
    const key = [...item.tags].sort().join("\u0000");
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE source_task_id = ? AND scope = ? AND kind = ? AND agent_id IS ? ORDER BY created_at DESC")
      .all(item.sourceTaskId, item.scope, item.kind, item.agentId) as Row[];
    const twin = rows.map(toMemory).find((m) => [...m.tags].sort().join("\u0000") === key);
    return twin ?? null;
  }

  /** Replace a memory's content (and tags/importance), keeping its id; the FTS row follows. */
  replaceContent(id: string, patch: { content: string; tags: string[]; importance: number }): void {
    this.db.prepare("UPDATE memories SET content = ?, tags = ?, importance = ? WHERE id = ?").run(patch.content, JSON.stringify(patch.tags), patch.importance, id);
    this.db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(id);
    this.db.prepare("INSERT INTO memories_fts (content, tags, memory_id) VALUES (?, ?, ?)").run(patch.content, patch.tags.join(" "), id);
  }

  /** FTS5 match → rows with bm25 score (lower is better), filtered by visibility. */
  match(ftsQuery: string, visibility: { agentId: string | null; scopes: string[]; kinds: string[] | null }, limit: number): Row[] {
    const { clause, params } = visibilityClause(visibility);
    return all(
      this.db,
      `SELECT m.*, bm25(memories_fts) AS score FROM memories_fts JOIN memories m ON m.id = memories_fts.memory_id
       WHERE memories_fts MATCH ? ${clause} ORDER BY score LIMIT ?`,
      ftsQuery,
      ...params,
      limit,
    );
  }

  /** Most recent visible memories (no query). */
  recent(visibility: { agentId: string | null; scopes: string[]; kinds: string[] | null }, limit: number): MemoryItem[] {
    const { clause, params } = visibilityClause(visibility);
    return all(this.db, `SELECT m.* FROM memories m WHERE 1 = 1 ${clause} ORDER BY m.created_at DESC LIMIT ?`, ...params, limit).map(toMemory);
  }

  bumpAccess(ids: string[], at: string): void {
    const statement = this.db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?");
    for (const id of ids) statement.run(at, id);
  }
}

function visibilityClause(v: { agentId: string | null; scopes: string[]; kinds: string[] | null }): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  const scopeParts: string[] = [];
  if (v.scopes.includes("global")) scopeParts.push("m.scope = 'global'");
  if (v.scopes.includes("agent") && v.agentId) {
    scopeParts.push("(m.scope = 'agent' AND m.agent_id = ?)");
    params.push(v.agentId);
  }
  parts.push(scopeParts.length ? `AND (${scopeParts.join(" OR ")})` : "AND 0");
  if (v.kinds && v.kinds.length) {
    parts.push(`AND m.kind IN (${v.kinds.map(() => "?").join(",")})`);
    params.push(...v.kinds);
  }
  return { clause: parts.join(" "), params };
}

export class BlackboardRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  list(): BlackboardEntry[] {
    return all(this.db, "SELECT * FROM blackboard ORDER BY updated_at DESC").map(toBlackboard);
  }

  get(key: string): BlackboardEntry | null {
    const row = one(this.db, "SELECT * FROM blackboard WHERE key = ?", key);
    return row ? toBlackboard(row) : null;
  }

  set(entry: BlackboardEntry): void {
    this.db
      .prepare(
        `INSERT INTO blackboard (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(entry.key, entry.value, entry.updatedBy, entry.updatedAt);
  }
}
