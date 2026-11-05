# Vendored: agency-agents

| | |
|---|---|
| Source | https://github.com/msitarzewski/agency-agents |
| Commit | `b37b5bb33b78f2c1d6567d98e25ca818e3259219` |
| Vendored on | 2026-11-05 |
| Files | 283 agent markdown files in 18 divisions, plus `LICENSE` and `divisions.json` |
| Licence | MIT — Copyright (c) 2025 AgentLand Contributors; full text in [`LICENSE`](LICENSE) |

The agent files are copied **unmodified**. AgentCo parses them at boot
(`apps/server/src/catalog/`) into a specialist catalog and compiles each one into
a compact "specialist playbook" for worker prompts; see [docs/CATALOG.md](../../docs/CATALOG.md).

Only the division directories listed in `divisions.json` are vendored. `strategy/`,
`integrations/`, `examples/` and `scripts/` are not agent divisions (see the
`_note` in `divisions.json`) and are left out.

## Updating

```bash
git clone --depth 1 https://github.com/msitarzewski/agency-agents /tmp/agency-agents
node scripts/update-catalog.mjs /tmp/agency-agents          # or --commit <sha> to record it explicitly
node --disable-warning=ExperimentalWarning --test "apps/server/test/core/catalog*.test.ts"
```

The script replaces this directory wholesale (so agents deleted upstream disappear) and
regenerates this file. After an update, re-run the catalog tests: they fail when a worker
template's `catalogId` or an entry of `catalog/division-map.json` no longer exists, or
when a new division has no department mapping.
