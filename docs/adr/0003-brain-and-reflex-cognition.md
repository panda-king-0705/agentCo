# ADR-0003: Two cognition engines — Brain for leaders, Reflex for workers

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-6, FR-7, FR-11

## Context
The founder supplied a brain-inspired agent architecture for agents that need
high-level thinking, and asked that low-level work run on cheap models.

## Decision
`BrainEngine` implements the architecture as an explicit staged cycle (recall
→ target understanding → self-ability assessment → risk/confidence gate with
calibration → cognitive control & candidate solutions → solving/delegation →
evaluation → learning). Each stage is a traced span with its own model tier.
Identity, desires, motivation, needs and affect are wired to concrete
behaviour (recall breadth, evaluation strictness, escalation thresholds,
conservation mode) rather than decorative prompt text.
`ReflexEngine` is a bounded tool loop on the economy tier with a single
fallback to the next tier.

"Eight Characters and Five Elements" from the diagram is not used for role
assignment: there is no evidence it predicts role fit. Personality labels
shape tone only.

## Consequences
+ Leaders' reasoning is inspectable stage by stage in the trace explorer.
+ Workers stay cheap and fast; most tokens are spent where judgement matters.
− A brain cycle makes ~5 model calls vs 1-3 for a reflex task; mitigated by
  cascade routing (ADR-0004) and by two stages needing no model.
