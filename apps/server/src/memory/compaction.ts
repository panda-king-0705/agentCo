/**
 * Context governance for DM/Boardroom histories handed to engines.
 *
 * Adapted from Volc Agent Launchpad — Glass Box middleware (memory/compactor.ts
 * + interceptor.ts), MIT. Deterministic, extractive, no model call: estimated
 * tokens (chars/4) over contextWindow × triggerPct → checkpoint with
 *   - the first Board message VERBATIM (the objective),
 *   - one progress line per earlier exchange,
 *   - the last `carryTurns` messages verbatim (the triggering message last),
 *   - the full folded transcript saved to data/artifacts/<conversationId>/transcript_vN.md.
 * Fail closed: contextWindow = null → no compaction and one `compaction_disabled`
 * system span per conversation. Checkpoints are epochs (persisted), so a
 * conversation is only re-folded when the checkpoint + tail overflows again.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, Message } from "../../../../packages/shared/src/index.ts";
import type { ConversationHistory, SpanHandle } from "../contracts.ts";
import type { SettingsRepo } from "../db/repo-org.ts";
import { compactionTrigger, estimateTokens } from "../middleware/context-limit.ts";

export interface CompactionConfig {
  dataDir: string;
  triggerPct: number;
  carryTurns: number;
  maxProgressLines?: number;
  maxPreambleChars?: number;
}

export interface CheckpointState {
  version: number;
  /** Number of leading messages folded into the checkpoint. */
  throughIndex: number;
  objective: string;
  progress: string[];
  exchanges: number;
  transcriptPath: string;
}

const ELISION = "- [older exchanges elided; full detail in the transcript artifacts]";
const PROMPT_EXCERPT = 160;
const OUTPUT_EXCERPT = 320;

export class ContextGovernor {
  private readonly settings: SettingsRepo;
  private readonly config: Required<CompactionConfig>;
  private readonly now: () => Date;

  constructor(settings: SettingsRepo, config: CompactionConfig, now: () => Date) {
    this.settings = settings;
    this.config = { maxProgressLines: 40, maxPreambleChars: 12_000, ...config };
    this.now = now;
  }

  /**
   * Governs `messages` (oldest → newest; the triggering message last) for a
   * model whose context window is `contextWindow`. Spans hang under `span`.
   */
  govern(conversation: Conversation, messages: Message[], contextWindow: number | null, span: SpanHandle | null): ConversationHistory {
    if (contextWindow === null) {
      this.reportDisabled(conversation, span);
      return { conversation, messages, compacted: false };
    }
    const trigger = compactionTrigger(contextWindow, this.config.triggerPct);
    const state = this.load(conversation.id);
    const view = state ? [this.preambleMessage(conversation, state, messages), ...messages.slice(state.throughIndex)] : messages;
    const before = tokensOf(view);
    if (before <= trigger) return { conversation, messages: view, compacted: state !== null };
    const next = this.fold(conversation, messages, state);
    if (!next) return { conversation, messages: view, compacted: state !== null };
    const compactedView = [this.preambleMessage(conversation, next, messages), ...messages.slice(next.throughIndex)];
    this.traceCompaction(span, next, before, tokensOf(compactedView), trigger, contextWindow);
    return { conversation, messages: compactedView, compacted: true };
  }

  /** The persisted checkpoint for a conversation, if any. */
  load(conversationId: string): CheckpointState | null {
    return this.settings.get<CheckpointState | null>(`compaction:${conversationId}`, null);
  }

  private fold(conversation: Conversation, messages: Message[], previous: CheckpointState | null): CheckpointState | null {
    const from = previous?.throughIndex ?? 0;
    const to = messages.length - this.config.carryTurns;
    if (to <= from) return null; // the carried tail alone overflows: turn-level governance cannot help
    const folded = messages.slice(from, to);
    const version = (previous?.version ?? 0) + 1;
    const { lines, exchanges } = progressLines(folded, previous?.exchanges ?? 0);
    const progress = [...(previous?.progress.filter((l) => l !== ELISION) ?? []), ...lines];
    const trimmed = progress.length > this.config.maxProgressLines ? [ELISION, ...progress.slice(-this.config.maxProgressLines)] : progress;
    const objective = previous?.objective ?? messages.find((m) => m.senderId === "human")?.content ?? "(no Board message recorded before the first compaction)";
    const transcriptPath = this.writeTranscript(conversation, version, folded, previous);
    const state: CheckpointState = { version, throughIndex: to, objective, progress: trimmed, exchanges, transcriptPath };
    this.settings.set(`compaction:${conversation.id}`, state);
    return state;
  }

  private writeTranscript(conversation: Conversation, version: number, folded: Message[], previous: CheckpointState | null): string {
    const relative = join("artifacts", conversation.id, `transcript_v${version}.md`);
    const lines = [`# Transcript before checkpoint v${version}`, "", `Conversation: ${conversation.title} (${conversation.id})`, `Written: ${this.now().toISOString()}`, `Messages: ${folded.length}`, ""];
    if (previous) lines.push(`Earlier messages are in the previous transcript: ${previous.transcriptPath}`, "");
    for (const message of folded) lines.push(`## ${message.senderId} · ${message.createdAt}`, "", message.content, "");
    const absolute = join(this.config.dataDir, relative);
    mkdirSync(join(this.config.dataDir, "artifacts", conversation.id), { recursive: true });
    writeFileSync(absolute, lines.join("\n"), "utf8");
    return relative;
  }

  private preambleMessage(conversation: Conversation, state: CheckpointState, messages: Message[]): Message {
    const first = messages[state.throughIndex];
    return {
      id: `msg_checkpoint_v${state.version}`,
      conversationId: conversation.id,
      senderId: "system",
      content: renderPreamble(state, this.config.maxPreambleChars),
      runId: null,
      taskId: null,
      traceId: null,
      readAt: null,
      createdAt: first?.createdAt ?? this.now().toISOString(),
    };
  }

  private reportDisabled(conversation: Conversation, span: SpanHandle | null): void {
    const key = `compaction_disabled:${conversation.id}`;
    if (!span || this.settings.has(key)) return;
    this.settings.set(key, { at: this.now().toISOString() });
    span
      .child({ kind: "system", name: "compaction_disabled", attributes: { "agentco.conversation.id": conversation.id } })
      .end({ status: "ok", output: "Context window unknown for the resolved model; compaction disabled (fail closed). Set contextWindow in MODEL_PRICES_JSON to enable it." });
  }

  private traceCompaction(span: SpanHandle | null, state: CheckpointState, before: number, after: number, trigger: number, window: number): void {
    span
      ?.child({
        kind: "system",
        name: "compaction",
        attributes: {
          "agentco.checkpoint.version": state.version,
          "agentco.checkpoint.through_index": state.throughIndex,
          "agentco.context.tokens_before": before,
          "agentco.context.tokens_after": after,
          "agentco.context.trigger": trigger,
          "agentco.context.window": window,
          "agentco.checkpoint.transcript": state.transcriptPath,
        },
      })
      .end({ status: "ok", output: `Compacted to checkpoint v${state.version}: ~${before} → ~${after} tokens (trigger ${trigger})` });
  }
}

function tokensOf(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

function oneLine(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : flat.slice(0, Math.max(0, limit - 1)) + "…";
}

/** One line per exchange (a Board message + the replies that follow it). */
export function progressLines(folded: Message[], startAt: number): { lines: string[]; exchanges: number } {
  const lines: string[] = [];
  let exchanges = startAt;
  let index = 0;
  while (index < folded.length) {
    const message = folded[index] as Message;
    if (message.senderId !== "human") {
      lines.push(`- ${message.senderId}: ${oneLine(message.content, OUTPUT_EXCERPT)}`);
      index++;
      continue;
    }
    const replies: string[] = [];
    let next = index + 1;
    while (next < folded.length && (folded[next] as Message).senderId !== "human") replies.push((folded[next++] as Message).content);
    exchanges++;
    lines.push(`- Exchange ${exchanges}: ${oneLine(message.content, PROMPT_EXCERPT)} -> ${replies.length ? oneLine(replies.join(" / "), OUTPUT_EXCERPT) : "(no reply)"}`);
    index = next;
  }
  return { lines, exchanges };
}

export function renderPreamble(state: CheckpointState, maxChars: number): string {
  const text = [
    "# Restored conversation context",
    "",
    "Earlier messages of this conversation are not in your context; the summary below and the transcript artifact are the record of them.",
    "",
    "## Objective (verbatim, from the first Board message)",
    "",
    state.objective,
    "",
    `## Progress so far (${state.throughIndex} earlier messages compacted, checkpoint v${state.version})`,
    "",
    ...(state.progress.length ? state.progress : ["- (no exchanges recorded)"]),
    "",
    "## Exact recall",
    "",
    `The full pre-compaction transcript is saved at ${state.transcriptPath}. Ask for it rather than guessing an exact earlier value.`,
  ].join("\n");
  return text.length <= maxChars ? text : text.slice(0, maxChars) + `\n\n[preamble truncated to ${maxChars} characters]\n`;
}
