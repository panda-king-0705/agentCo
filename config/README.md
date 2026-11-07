# Company configuration on this PC

This folder is mounted into the container read-only (`/config`). Files you create here stay on this
PC: `mcp.json` and the playbooks are git-ignored. **Keys never go in these files** — they go in `.env`
(names ending in `_API_KEY` or `_TOKEN`, so they are redacted from logs and traces), and the files
refer to them as `${NAME}`.

## Connections (MCP servers) — `mcp.json`

Copy `mcp.example.json` to `mcp.json`, keep the servers you want, add their keys to `.env`, then
`docker compose up -d` (a restart re-reads the file). A server whose key is not set is skipped.
`GET /api/health` lists the connected servers and their tool counts.

| Field | Meaning |
|---|---|
| `url` / `headers` | A remote MCP server (Streamable HTTP). Or `command`/`args`/`env` for one run inside the container. |
| `grants` | What it lets the company do: `web`, `email`, `code`, `payments`, `accounts`, `git`, `data`. Agents are told; it is no longer left to the Board. |
| `access` | Who gets its tools: `roles` (cmo, cto…), `agents` (names or ids), `departments` (marketing, engineering…), `catalog` (specialist catalog ids). Nobody else sees them. |
| `tools` | Allow-list of the server's tool names (empty = all it lists). Keep it short: every tool costs tokens on every call. |
| `noApproval` | Tools that change something but may run without your approval. Every other tool that is not read-only goes to Approvals first and runs when you approve it; destructive tools always do. |
| `dailyCallLimit` | Calls per agent per day to this server (0 = none). |
| `protectBranches` | A call whose `branch` is one of these goes to Approvals first, even for a `noApproval` tool. Default for a server that grants `git`: `["main", "master"]` (so only you put changes on main, even where GitHub's own branch protection isn't available — private repositories on the free plan). |

Notes on the examples:
- **Firecrawl** — research roles only; search and single pages (no crawls, which use credits fast).
- **GitHub** — engineering only. Create a *fine-grained* token limited to the one repository the
  engineers may work in (contents + pull requests: read/write). Merging is excluded (you merge), and
  a commit straight to main goes to Approvals. The `tools` list keeps the 12 tools engineering needs:
  the server offers 25, and every tool an agent has costs tokens on every call.
- **FMP** — market and financial data for Finance (the key travels in the URL, which FMP requires).
- Servers that need a browser sign-in (OAuth) — TextToQuant, Gmail, Google Drive, Notion through
  claude.ai — cannot be connected yet; connectors are signed in to your claude.ai account and cannot
  be copied here.

## Playbooks — `playbooks/`

Your own Claude skills, as instructions agents read with `playbook_read`: copy a skill folder (with
its `SKILL.md`) or a single `.md` file into `playbooks/`. Scripts a skill ships are not run (the
company cannot run code), so instruction-only skills carry over fully. Don't copy Anthropic's
built-in skills (docx, pptx, xlsx, pdf): they are licensed for use inside Claude.
