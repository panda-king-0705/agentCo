# ADR-0002: SQLite (WAL) with FTS5 for state and memory, not a vector DB

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-6, FR-9, FR-12, NFR-3

## Context
We need durable agents/tasks/runs/spans, an append-only event log, and
retrieval over agent and company memories. The reference repo used JSON files
with atomic rename, which does not support the trace queries a dashboard needs.

## Decision
One SQLite database in WAL mode. Memories are indexed with FTS5 (BM25),
blended with importance and recency at query time. Spans are written at start
and updated at end so a crashed run leaves its partial timeline.

## Consequences
+ Transactional, queryable, zero-ops, inspectable with any SQLite client.
+ Deterministic retrieval — tests can assert exact recall.
− Lexical recall misses paraphrases; add embeddings (sqlite-vec / pgvector)
  when the knowledge base grows (revisit trigger: > 10k memories or recall
  complaints in evaluations).
− Single writer; fine for one node.
