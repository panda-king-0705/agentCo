# ADR-0005: Deterministic mock provider by default

- Status: accepted
- Date: 2026-11-04
- Requirements: NFR-1

## Context
Demos and tests must run without API keys or spend, and tests must be
deterministic.

## Decision
Any tier without credentials resolves to a mock provider that understands
stage markers and a structured context block in prompts, returning plausible
stage outputs and tool calls so the whole org works end to end offline. The
console shows a MOCK badge whenever models are not live.

## Consequences
+ Free, deterministic demos and CI.
− Mock output can make the company look more capable than it is; labelled.
