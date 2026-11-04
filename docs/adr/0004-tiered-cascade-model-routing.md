# ADR-0004: Tiered, stage-aware model routing with fallback

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-7, FR-11, NFR-2

## Context
Frontier calls cost roughly 40× economy calls (docs/research/03-model-tiers.md,
prices checked 2026-11-04). Not every step of a leader's thinking needs the
strongest model.

## Decision
Three tiers (frontier, standard, economy) map to `provider:model` profiles
from env. Agents have a default tier; each cognitive stage maps to a tier or
to "agent" (planning and solving use the agent's own tier; understanding and
evaluation use standard; risk assessment and learning use economy). Each tier
has a fallback profile used once on provider error. Every call is priced and
recorded with what it would have cost on frontier, giving a measured
`routingSavingsUsd`.

## Consequences
+ Cost is controlled by config, visible per stage, and measurable.
+ Any OpenAI-compatible provider works through one adapter.
− Anthropic's OpenAI-compatible layer lacks prompt caching and rejects forced
  tool choice on some models; we use `tool_choice: auto` and accept no caching
  through that path (native adapter is a follow-up).
