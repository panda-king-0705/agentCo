# Contributing to AgentCo

## Lifecycle (how a change moves from idea to release)

1. **Requirement** — every change traces to an id in
   [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) (FR-n / NFR-n) or an issue.
2. **Design** — anything that changes a contract
   (`packages/shared`, `apps/server/src/contracts.ts`), storage schema, or a
   cross-cutting behaviour gets an ADR in `docs/adr/` (copy `0000-template.md`).
3. **Branch** — `feat/<short-name>`, `fix/<short-name>`, `docs/…`, `chore/…`
   from `main`. Keep branches short-lived.
4. **Implement with tests** — unit tests for pure logic, integration tests
   through the HTTP API for behaviour, Playwright e2e for console flows.
5. **Local gate** — `npm run check` (typecheck + tests + web build) must pass.
6. **Pull request** — use the PR template; link requirement ids; include
   screenshots for UI changes and a trace screenshot for behaviour changes.
7. **Review** — at least one reviewer who did not write the change.
   Reviewers check correctness, contract compatibility, security
   (redaction, auth, path handling), cost impact (model tier/stage changes)
   and tests.
8. **Merge** — squash-merge with a Conventional Commit title.
9. **Release** — bump semver in `package.json`, update `CHANGELOG.md`, tag
   `vX.Y.Z`.

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) —
  `feat(server): …`, `fix(web): …`, `docs(adr): …`, `test(cognition): …`.
  Reference requirement ids in the body (`Refs: FR-9`).
- **Contracts are versioned APIs.** Additive changes only within a minor
  version; breaking changes need an ADR and a major bump.
- **Server code** must stay runnable by Node type stripping: erasable TS only
  (no `enum`, `namespace`, parameter properties), `.ts` import extensions,
  `import type` for types. No runtime npm dependencies (ADR-0001).
- **Shared package** is types only.
- **Secrets** never in code, fixtures or logs. Persisted text goes through the
  redactor.
- **Cost-affecting changes** (prompt size, stage routing, default tiers) state
  the expected cost delta in the PR, measured with the mock token counts or a
  live trace.

## Definition of done

- [ ] Requirement / issue linked
- [ ] Tests added or updated and passing (`npm test`)
- [ ] `npm run typecheck` clean
- [ ] Console builds (`npm run build:web`); e2e passes for UI changes
- [ ] Docs updated (README, ARCHITECTURE, ADR if a decision changed)
- [ ] CHANGELOG entry under *Unreleased*

## Test pyramid

| layer | where | runs |
|---|---|---|
| unit | `apps/server/test/**/` pure modules (calibration, priority, redaction, compaction) | `npm test` |
| integration | `apps/server/test/core/` HTTP + SQLite with fake engines; `apps/server/test/cognition/` engines with fake platform | `npm test` |
| system | `apps/server/test/system/` full server + real engines on the mock provider: Board message → CEO → C-suite → workers → report | `npm test` |
| e2e (UI) | `apps/web/dev/e2e.mjs` Playwright against the fixture server or a live server | `node apps/web/dev/e2e.mjs` |
