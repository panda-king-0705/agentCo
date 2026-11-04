# ADR-0001: Zero-dependency server on Node's built-ins

- Status: accepted
- Date: 2026-11-04
- Requirements: NFR-1, NFR-6

## Context
The reference platform (Volc Agent Launchpad) uses Fastify + zod and a tsc
build. AgentCo must run with one command, offline, and be easy to audit.
Node ≥ 22.18 strips TypeScript types natively and ships `node:sqlite`.

## Decision
The server uses only Node built-ins: `node:http`, `node:sqlite`, `fetch`,
`node:crypto`, `node:test`. TypeScript runs directly (erasable syntax only;
`.ts` import extensions; `import type`). `tsc --noEmit` is the type gate.

## Consequences
+ No install step for the server; no supply-chain surface at runtime.
+ Same code runs in tests, dev and prod; no build artefacts to drift.
− A small hand-written router, validation and SSE layer to maintain.
− Requires Node ≥ 22.18; `node:sqlite` is still flagged experimental
  (warning suppressed; API stable enough for our usage).

## Alternatives considered
Fastify + zod (reference) — familiar, but adds a build and dependencies for
little gain at this size. Bun/Deno — would change the toolchain for users.
