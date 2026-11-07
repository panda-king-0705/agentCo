/**
 * Conversations: the Boardroom (Board ↔ CEO), human DMs and agent-to-agent
 * DMs (agent inboxes). Message content is redacted (high-precision tier)
 * before it is persisted.
 */
import type { Agent, Conversation, Message } from "../../../../packages/shared/src/index.ts";
import type { Repositories } from "../db/index.ts";
import { newId } from "../db/ids.ts";
import type { EventBus } from "../events/bus.ts";
import { summaries } from "../events/summary.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";
import type { Redactor } from "../middleware/redact.ts";

export interface MessageMeta {
  runId?: string | null;
  taskId?: string | null;
  traceId?: string | null;
}

export const MAX_MESSAGE_CHARS = 50_000;

export class ConversationService {
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

  list(agentId?: string): Conversation[] {
    return this.repos.conversations.list(agentId);
  }

  require(id: string): Conversation {
    const conversation = this.repos.conversations.get(id);
    if (!conversation) throw notFound("conversation", id);
    return conversation;
  }

  boardroom(): Conversation | null {
    return this.repos.conversations.boardroom();
  }

  /** Get-or-create the human ↔ agent DM. */
  directMessage(agent: Agent): Conversation {
    if (agent.status === "terminated") throw conflict(`${agent.name} is terminated`);
    return this.getOrCreate("dm", ["human", agent.id], `DM · ${agent.name}`);
  }

  /** Get-or-create the agent ↔ agent DM (participants sorted). Never with a removed agent. */
  agentDirectMessage(a: Agent, b: Agent): Conversation {
    for (const x of [a, b]) if (this.isRemoved(x.id)) throw conflict(`${x.name} was removed and can no longer send or receive messages`);
    return this.getOrCreate("agent_dm", [a.id, b.id].sort(), `${a.name} ↔ ${b.name}`);
  }

  /**
   * A terminated agent is out of the company: nothing may post as them, and their DMs are kept for
   * the record but closed (2026-11-07: after an agent was removed, the console still offered their
   * thread as if they could answer, and no layer below the tools checked the sender).
   */
  private isRemoved(agentId: string): boolean {
    return this.repos.agents.get(agentId)?.status === "terminated";
  }

  messages(conversationId: string, after?: string): Message[] {
    this.require(conversationId);
    return this.repos.conversations.messages(conversationId, after ? { after } : {});
  }

  /** The agent that answers human messages in this conversation (DM partner; the CEO in the Boardroom). */
  responderFor(conversation: Conversation, ceoId: string | null): string | null {
    if (conversation.kind === "boardroom") return ceoId ?? conversation.participantIds.find((p) => p !== "human") ?? null;
    if (conversation.kind === "dm") return conversation.participantIds.find((p) => p !== "human") ?? null;
    return null;
  }

  /** Stores a human message in a Boardroom/DM conversation. */
  postHuman(conversationId: string, content: string): Message {
    const conversation = this.require(conversationId);
    if (conversation.kind === "agent_dm") throw conflict("agent-to-agent conversations are read-only for the Board");
    const removed = conversation.kind === "dm" ? conversation.participantIds.find((p) => p !== "human" && this.isRemoved(p)) : undefined;
    if (removed) throw conflict(`${this.repos.agents.get(removed)?.name ?? removed} was removed; this conversation is kept for the record and cannot receive new messages`);
    return this.post(conversation, "human", content, {});
  }

  postAs(conversationId: string, senderId: string, content: string, meta: MessageMeta = {}): Message {
    return this.post(this.require(conversationId), senderId, content, meta);
  }

  /** Agent → agent message; lands unread in the recipient's inbox. */
  sendAgentMessage(from: Agent, to: Agent, content: string, meta: MessageMeta = {}): Message {
    return this.post(this.agentDirectMessage(from, to), from.id, content, meta);
  }

  /** Links a human message to the run that answers it (marks it picked up). */
  attachRun(messageId: string, runId: string | null, traceId?: string | null): void {
    this.repos.conversations.updateMessage(messageId, { runId, ...(traceId !== undefined ? { traceId } : {}) });
  }

  private post(conversation: Conversation, senderId: string, content: string, meta: MessageMeta): Message {
    if (senderId !== "human" && senderId !== "system" && this.isRemoved(senderId)) {
      throw conflict(`${this.repos.agents.get(senderId)?.name ?? senderId} was removed and can no longer send messages`);
    }
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) throw badRequest("content must be a non-empty string");
    if (text.length > MAX_MESSAGE_CHARS) throw badRequest(`content exceeds ${MAX_MESSAGE_CHARS} characters`);
    const message: Message = {
      id: newId("msg"),
      conversationId: conversation.id,
      senderId,
      content: this.redactor.redact(text),
      runId: meta.runId ?? null,
      taskId: meta.taskId ?? null,
      traceId: meta.traceId ?? null,
      readAt: null,
      createdAt: this.now().toISOString(),
    };
    this.repos.conversations.insertMessage(message);
    this.repos.conversations.touch(conversation.id, message.createdAt);
    const sender = senderId === "human" ? "Board" : senderId === "system" ? "System" : (this.repos.agents.get(senderId)?.name ?? senderId);
    this.bus.emit("message.created", {
      agentId: senderId.startsWith("agt_") ? senderId : null,
      taskId: message.taskId,
      runId: message.runId,
      traceId: message.traceId,
      summary: summaries.messageCreated(message, sender),
      data: message,
    });
    return message;
  }

  private getOrCreate(kind: Conversation["kind"], participants: string[], title: string): Conversation {
    const existing = this.repos.conversations.findByParticipants(kind, participants);
    if (existing) return existing;
    const conversation: Conversation = { id: newId("cnv"), kind, title, participantIds: participants, createdAt: this.now().toISOString(), lastMessageAt: null };
    this.repos.conversations.insert(conversation);
    return conversation;
  }
}
