/**
 * Schema migrations. Each entry is applied once, in order, inside a
 * transaction; `schema_version` records the highest applied version.
 * Append new migrations — never edit an applied one.
 */
export const MIGRATIONS: readonly string[] = [
  /* v1 — initial schema */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

  CREATE TABLE departments (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mandate TEXT NOT NULL,
    parent_id TEXT REFERENCES departments(id), head_agent_id TEXT, color TEXT NOT NULL,
    monthly_budget_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );

  CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, role_id TEXT NOT NULL,
    department_id TEXT NOT NULL REFERENCES departments(id), manager_id TEXT REFERENCES agents(id),
    tier TEXT NOT NULL, cognition TEXT NOT NULL, model_tier TEXT NOT NULL, model_override TEXT,
    status TEXT NOT NULL, activity TEXT, brain_block TEXT, current_task_id TEXT, current_run_id TEXT,
    identity TEXT NOT NULL, persona TEXT NOT NULL, affect TEXT NOT NULL, calibration TEXT NOT NULL,
    tools TEXT NOT NULL, monthly_budget_usd REAL NOT NULL, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminated_at TEXT
  );
  CREATE INDEX agents_manager ON agents(manager_id);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, trace_id TEXT NOT NULL,
    parent_task_id TEXT REFERENCES tasks(id), root_task_id TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, acceptance_criteria TEXT,
    created_by TEXT NOT NULL, assignee_id TEXT REFERENCES agents(id), department_id TEXT,
    status TEXT NOT NULL, value REAL NOT NULL, est_cost_usd REAL NOT NULL, actual_cost_usd REAL NOT NULL DEFAULT 0,
    priority REAL NOT NULL, result TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
    origin_conversation_id TEXT, state TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
  );
  CREATE INDEX tasks_assignee_status ON tasks(assignee_id, status);
  CREATE INDEX tasks_trace ON tasks(trace_id);
  CREATE INDEX tasks_parent ON tasks(parent_task_id);
  CREATE INDEX tasks_root ON tasks(root_task_id);
  CREATE INDEX tasks_status_priority ON tasks(status, priority DESC, created_at);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), task_id TEXT, conversation_id TEXT,
    trace_id TEXT NOT NULL, root_span_id TEXT NOT NULL, trigger TEXT NOT NULL, engine TEXT NOT NULL,
    status TEXT NOT NULL, output TEXT, error TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0, llm_calls INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
    failing_span_id TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX runs_agent_created ON runs(agent_id, created_at);
  CREATE INDEX runs_task ON runs(task_id);
  CREATE INDEX runs_trace ON runs(trace_id);
  CREATE INDEX runs_status ON runs(status);

  CREATE TABLE spans (
    id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
    status TEXT NOT NULL, agent_id TEXT, run_id TEXT, task_id TEXT,
    started_at TEXT NOT NULL, ended_at TEXT, duration_ms REAL,
    input TEXT, output TEXT, error TEXT, model TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, attributes TEXT NOT NULL
  );
  CREATE INDEX spans_trace ON spans(trace_id, started_at);
  CREATE INDEX spans_run ON spans(run_id);
  CREATE INDEX spans_status ON spans(status);

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, participant_ids TEXT NOT NULL,
    created_at TEXT NOT NULL, last_message_at TEXT
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), sender_id TEXT NOT NULL,
    content TEXT NOT NULL, run_id TEXT, task_id TEXT, trace_id TEXT, read_at TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, created_at);
  CREATE INDEX messages_pending ON messages(sender_id, run_id);

  CREATE TABLE memories (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL, importance REAL NOT NULL, source_run_id TEXT, source_task_id TEXT,
    access_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_accessed_at TEXT
  );
  CREATE INDEX memories_agent ON memories(agent_id, created_at);
  CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, memory_id UNINDEXED);

  CREATE TABLE blackboard (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL,
    task_id TEXT, trace_id TEXT, summary TEXT NOT NULL, payload TEXT NOT NULL,
    decided_by TEXT, note TEXT, created_at TEXT NOT NULL, decided_at TEXT
  );
  CREATE INDEX approvals_status ON approvals(status, created_at);

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL,
    agent_id TEXT, task_id TEXT, run_id TEXT, trace_id TEXT, summary TEXT NOT NULL, data TEXT NOT NULL
  );

  CREATE TABLE spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, department_id TEXT, run_id TEXT, trace_id TEXT,
    span_id TEXT, task_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, profile_id TEXT NOT NULL,
    tier TEXT NOT NULL, stage TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, frontier_cost_usd REAL NOT NULL, at TEXT NOT NULL
  );
  CREATE INDEX spend_agent_at ON spend(agent_id, at);
  CREATE INDEX spend_at ON spend(at);
  `,
];
