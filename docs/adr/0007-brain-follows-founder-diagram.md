# ADR-0007: The brain engine follows the founder's diagram block for block

- Status: accepted (interpretations Q1-Q9 in docs/BRAIN.md pending the founder)
- Date: 2026-11-05
- Requirements: FR-6
- Supersedes: the stage table and the "Eight Characters not used" clause of ADR-0003

## Context
ADR-0003 condensed the brain-inspired architecture into an 8-stage pipeline
and left "Eight Characters and Five Elements" out of role assignment. The
founder asked for the architecture to follow the diagram as closely as
possible.

## Decision
- One module and one `BrainBlockId` per diagram box (33 blocks), traced as
  `agentco.brain.block`, so the trace and the console's live brain view walk
  the same diagram the founder drew.
- Every arrow is a data flow (BRAIN.md §2-3): Fallback loops, Early stop,
  Cognitive Control ∝ uncertainty, Decomposition back into the TODO list,
  Report → Feedback/Update and Interrupt.
- The TODO list is genuinely interruptible: engines poll `interruptFor()`
  between blocks and yield with a checkpoint (new outcome `yielded`).
- Role Arrangement uses mandate fit, MBTI and the BaZi five-element balance,
  with configurable weights (default 0.7 / 0.2 / 0.1, pending the founder).
- Every interpretation of an unclear label lives in
  `cognition/brain/interpretation.ts`.

## Consequences
+ The founder can audit each block's behaviour in traces and on screen.
− More spans per run (computed blocks get short spans); about a third of the
  blocks call a model, so cost per pass is similar to ADR-0003's pipeline.
− BaZi and MBTI have no established predictive validity for job fit; they
  are weighted below mandate fit by default and can be set to 0.
