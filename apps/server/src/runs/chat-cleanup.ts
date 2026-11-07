/**
 * Deleting chats, and what removing an agent clears (2026-11-07, the founder: "when you destroy an
 * agent is it destroyed cleanly — records, chat windows, agent id, everything?"; chose "clean up,
 * keep history").
 *
 * A deleted chat is gone for good: its messages, the context checkpoint and folded transcripts the
 * agent would otherwise be shown again, and the private notes agents wrote while answering in it.
 * Replies in progress are stopped. Objectives started from it keep running (their report has nowhere
 * to go). The Boardroom is never deleted, only cleared.
 *
 * Removing an agent also deletes its chats (with the Board and with other agents) and its private
 * memories, and withdraws its pending requests to the Board. Its history stays: the agent record,
 * marked removed, and its runs, traces, spend and tasks — so spending totals and traces stay true.
 */
import type { Agent, Conversation, DeleteConversationResult } from "../../../../packages/shared/src/index.ts";
import type { Repositories } from "../db/index.ts";
import type { EventBus } from "../events/bus.ts";
import { summaries } from "../events/summary.ts";
import { notFound } from "../http/errors.ts";
import type { AbortReason } from "./abort.ts";

export interface RemovalCleanup {
  deletedChats: number;
  deletedMemories: number;
  withdrawnRequests: number;
}

export interface ChatCleanupDeps {
  repos: Repositories;
  bus: EventBus;
  governor: { forget(conversationId: string): void };
  runs: { abortConversation(conversationId: string, reason: AbortReason): number };
  approvals: { withdrawRequestsBy(agent: { id: string; name: string }): number };
}

export class ChatCleanup {
  private readonly deps: ChatCleanupDeps;

  constructor(deps: ChatCleanupDeps) {
    this.deps = deps;
  }

  /** DELETE /api/conversations/:id — the Boardroom is cleared instead (it is where the Board talks to the CEO). */
  deleteConversation(id: string): DeleteConversationResult {
    const conversation = this.deps.repos.conversations.get(id);
    if (!conversation) throw notFound("conversation", id);
    return this.remove(conversation);
  }

  /** What removing an agent clears (called by OrgService.destroyAgent once the agent is terminated). */
  removeAgent(agent: Pick<Agent, "id" | "name">): RemovalCleanup {
    const { repos, approvals } = this.deps;
    let deletedChats = 0;
    let deletedMemories = 0;
    for (const conversation of repos.conversations.list(agent.id)) {
      if (conversation.kind === "boardroom") continue;
      deletedMemories += this.remove(conversation).deletedMemories;
      deletedChats += 1;
    }
    deletedMemories += repos.memories.deleteAgentScoped(agent.id);
    const withdrawnRequests = approvals.withdrawRequestsBy(agent);
    return { deletedChats, deletedMemories, withdrawnRequests };
  }

  /**
   * At boot: agents removed before removal cleaned up after them (Riley Chen and Casey Diaz,
   * 2026-11-07) get the same clean-up. Idempotent — once clean, there is nothing left to find.
   */
  cleanUpRemovedAgents(): { agents: number } & RemovalCleanup {
    const total = { agents: 0, deletedChats: 0, deletedMemories: 0, withdrawnRequests: 0 };
    for (const agent of this.deps.repos.agents.list({ status: "terminated" })) {
      const r = this.removeAgent(agent);
      if (r.deletedChats + r.deletedMemories + r.withdrawnRequests === 0) continue;
      total.agents += 1;
      total.deletedChats += r.deletedChats;
      total.deletedMemories += r.deletedMemories;
      total.withdrawnRequests += r.withdrawnRequests;
    }
    return total;
  }

  private remove(conversation: Conversation): DeleteConversationResult {
    const { repos, bus, governor, runs } = this.deps;
    const cleared = conversation.kind === "boardroom";
    // Stop replies first, in the same tick: a run settling later finds the chat gone and posts nothing.
    const abortedRuns = runs.abortConversation(conversation.id, "interrupt");
    const { deletedMessages, deletedMemories } = repos.tx(() => {
      const deletedMemories = repos.memories.deleteFromConversation(conversation.id);
      const deletedMessages = cleared ? repos.conversations.clearMessages(conversation.id) : repos.conversations.delete(conversation.id);
      return { deletedMessages, deletedMemories };
    });
    governor.forget(conversation.id);
    const title = cleared ? "the Boardroom" : conversation.title;
    bus.emit("conversation.deleted", {
      summary: summaries.conversationDeleted(title, cleared, deletedMessages),
      data: { id: conversation.id, cleared, kind: conversation.kind, participantIds: conversation.participantIds },
    });
    return { conversationId: conversation.id, cleared, deletedMessages, deletedMemories, abortedRuns };
  }
}
