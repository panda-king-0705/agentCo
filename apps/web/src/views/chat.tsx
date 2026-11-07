// Chat: Boardroom pinned, DMs, new chat with any agent, live thinking indicator, markdown-lite messages.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { href, navigate } from "../router";
import { seed, useApi, useLive } from "../live";
import { Markdown } from "../ui/markdown";
import { Avatar, Button, Empty, Field, Icon, Modal, RelTime, Skeleton, StatusGlyph, useAction } from "../ui/kit";
import type { Agent, Conversation, Message } from "../types";
import { PageHead, byTier, liveAgents } from "./common";

function convLabel(c: Conversation, agents: Record<string, Agent>): string {
  if (c.kind === "boardroom") return "Boardroom";
  const others = c.participantIds.filter((p) => p !== "human").map((p) => (agents[p] ? `${agents[p]!.name}${agents[p]!.status === "terminated" ? " (removed)" : ""}` : p));
  return others.join(" and ") || c.title;
}

/**
 * Why the Board cannot write in this thread, or null when it can: agent-to-agent threads are
 * read-only, and a removed agent's thread is kept for the record but closed (2026-11-07).
 */
function closedReason(c: Conversation | undefined, agents: Record<string, Agent>): string | null {
  if (!c) return null;
  const removed = c.participantIds.map((p) => agents[p]).filter((a): a is Agent => !!a && a.status === "terminated");
  if (removed.length) return `${removed.map((a) => a.name).join(" and ")} ${removed.length === 1 ? "was" : "were"} removed. This conversation is kept for the record; no new messages can be sent or received.`;
  if (c.kind === "agent_dm") return "A conversation between agents: you can read it, but only they can write here.";
  return null;
}

function ThinkingIndicator({ conversation }: { conversation: Conversation }) {
  const agents = useLive((s) => s.agents);
  const working = conversation.participantIds
    .map((id) => agents[id])
    .filter((a): a is Agent => !!a && (a.status === "thinking" || a.status === "acting"));
  // In the boardroom the CEO answers; show anyone working on the thread.
  const list = conversation.kind === "boardroom" ? working : working;
  if (!list.length) return null;
  return (
    <div className="thinking" role="status" aria-live="polite">
      {list.map((a) => (
        <div key={a.id} className="thinking-row">
          <Avatar agent={a} size={20} />
          <span>
            <strong>{a.name}</strong> is {a.status === "acting" ? "acting" : "thinking"}
            {a.activity ? <span className="muted">: {a.activity}</span> : null}
          </span>
          <span className="dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
      ))}
    </div>
  );
}

function MessageRow({ m }: { m: Message }) {
  const agent = useLive((s) => (m.senderId !== "human" && m.senderId !== "system" ? s.agents[m.senderId] : undefined));
  const task = useLive((s) => (m.taskId ? s.tasks[m.taskId] : undefined));
  const mine = m.senderId === "human";
  const name = mine ? "Board" : m.senderId === "system" ? "System" : agent ? `${agent.name}${agent.status === "terminated" ? " (removed)" : ""}` : m.senderId;
  return (
    <div className={`msg${mine ? " mine" : ""}${m.senderId === "system" ? " sys" : ""}`}>
      <Avatar agent={agent} id={m.senderId} size={28} />
      <div className="msg-body">
        <div className="msg-meta">
          {agent ? <a href={href(`/agents/${agent.id}`)} className="msg-name">{name}</a> : <span className="msg-name">{name}</span>}
          <RelTime iso={m.createdAt} className="rel muted tiny" />
        </div>
        <div className="msg-bubble">
          <Markdown text={m.content} />
        </div>
        {m.taskId || m.traceId ? (
          <div className="msg-links small">
            {m.taskId ? <a href={href(`/tasks/${m.taskId}`)}><Icon name="tasks" size={12} /> {task ? `T-${task.number}` : "Task"}</a> : null}
            {m.traceId ? <a href={href(`/traces/${m.traceId}`)}><Icon name="traces" size={12} /> Trace</a> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatThread({ conversationId, conversation }: { conversationId: string; conversation?: Conversation }) {
  const messages = useLive((s) => s.messages[conversationId]);
  const [loading, setLoading] = useState(!messages);
  const [text, setText] = useState("");
  const { busy, run } = useAction();
  const endRef = useRef<HTMLDivElement>(null);
  const convs = useApi("conversations", () => api.conversations(), { refreshOn: ["message.created"] });
  const conv = conversation ?? convs.data?.find((c) => c.id === conversationId);
  const agents = useLive((s) => s.agents);
  const closed = closedReason(conv, agents);

  useEffect(() => {
    let off = false;
    setLoading(true);
    api.messages(conversationId).then(
      (list) => {
        if (off) return;
        seed.messages(conversationId, list);
        setLoading(false);
      },
      () => !off && setLoading(false),
    );
    return () => {
      off = true;
    };
  }, [conversationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages?.length, conversationId]);

  const send = async () => {
    const content = text.trim();
    if (!content || busy) return;
    const res = await run(() => api.postMessage(conversationId, content));
    if (res) {
      seed.messages(conversationId, [res.message]);
      setText("");
    }
  };

  return (
    <div className="thread">
      <div className="thread-scroll" role="log" aria-label="Messages">
        {loading && !messages ? <Skeleton rows={5} height={30} /> : null}
        {messages?.length ? messages.map((m) => <MessageRow key={m.id} m={m} />) : !loading ? <Empty title="No messages yet" icon="chat">Say something below. Agents reply as soon as they pick it up.</Empty> : null}
        {conv ? <ThinkingIndicator conversation={conv} /> : null}
        <div ref={endRef} />
      </div>
      {closed ? (
        <div className="composer closed muted small" role="note">
          <Icon name="alert" size={14} /> {closed}
        </div>
      ) : (
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={text}
          rows={2}
          aria-label="Message"
          placeholder="Write a message. Enter sends, Shift+Enter adds a line."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button variant="primary" icon="send" type="submit" disabled={!text.trim() || busy}>Send</Button>
      </form>
      )}
    </div>
  );
}

function NewChatModal({ onClose }: { onClose: () => void }) {
  const agents = useLive((s) => s.agents);
  const [agentId, setAgentId] = useState("");
  const { busy, run } = useAction();
  const list = useMemo(() => liveAgents(agents).sort(byTier), [agents]);
  const start = async () => {
    const c = await run(() => api.openConversation(agentId));
    if (c) {
      onClose();
      navigate(`/chat/${c.id}`);
    }
  };
  return (
    <Modal title="New chat" onClose={onClose} width={440} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={start} disabled={!agentId || busy}>Open chat</Button></>}>
      <Field label="Chat with" hint="Any agent, at any level. Opens the existing thread if there is one.">
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Choose an agent…</option>
          {list.map((a) => <option key={a.id} value={a.id}>{a.name}, {a.title}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

export function ChatView({ conversationId }: { conversationId: string | null }) {
  const agents = useLive((s) => s.agents);
  const convs = useApi("conversations", () => api.conversations(), { refreshOn: ["message.created"] });
  const [creating, setCreating] = useState(false);
  const sorted = useMemo(() => {
    const l = [...(convs.data ?? [])];
    return l.sort((a, b) => (a.kind === "boardroom" ? -1 : b.kind === "boardroom" ? 1 : (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt)));
  }, [convs.data]);
  const active = sorted.find((c) => c.id === conversationId) ?? (conversationId ? undefined : sorted[0]);
  const dms = sorted.filter((c) => c.kind !== "boardroom");
  return (
    <>
      <PageHead title="Chat" sub="Talk to the Boardroom or any agent directly">
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New chat</Button>
      </PageHead>
      <div className="chat-layout">
        <aside className="chat-list" aria-label="Conversations">
          {convs.loading && !convs.data ? <Skeleton rows={5} height={34} /> : null}
          {sorted.filter((c) => c.kind === "boardroom").map((c) => (
            <ConvItem key={c.id} c={c} active={active?.id === c.id} agents={agents} pinned />
          ))}
          {dms.length ? <div className="chat-group">Direct messages</div> : null}
          {dms.map((c) => (
            <ConvItem key={c.id} c={c} active={active?.id === c.id} agents={agents} />
          ))}
        </aside>
        <section className="chat-main panel">
          {active ? (
            <>
              <header className="panel-head">
                <h2>{convLabel(active, agents)}</h2>
                <span className="muted small">{active.kind === "boardroom" ? "The Board and the leadership team" : active.kind === "agent_dm" ? "Agent-to-agent (read only for you)" : "Direct message"}</span>
              </header>
              <ChatThread key={active.id} conversationId={active.id} conversation={active} />
            </>
          ) : convs.loading ? (
            <Skeleton rows={6} />
          ) : (
            <Empty title="Pick a conversation" icon="chat">Choose one on the left, or start a new chat.</Empty>
          )}
        </section>
      </div>
      {creating ? <NewChatModal onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function ConvItem({ c, active, agents, pinned }: { c: Conversation; active: boolean; agents: Record<string, Agent>; pinned?: boolean }) {
  const other = c.participantIds.find((p) => p !== "human");
  const agent = other ? agents[other] : undefined;
  return (
    <a className={`conv${active ? " on" : ""}`} href={href(`/chat/${c.id}`)} aria-current={active ? "true" : undefined}>
      {c.kind === "boardroom" ? <span className="avatar board-av"><Icon name="org" size={14} /></span> : <Avatar agent={agent} id={other} size={28} />}
      <div className="grow">
        <div className="conv-name ellipsis">{convLabel(c, agents)}{pinned ? <span className="pin muted tiny"> pinned</span> : null}</div>
        <div className="conv-sub muted tiny">
          {agent ? <><StatusGlyph status={agent.status} size={9} /> {agent.title}</> : c.lastMessageAt ? <RelTime iso={c.lastMessageAt} className="rel" /> : "No messages"}
        </div>
      </div>
    </a>
  );
}
