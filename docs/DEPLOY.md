# Deploying AgentCo

Three ways to run the company, from simplest to most public:

| option | who can open the console | needs | recommended for |
|---|---|---|---|
| **(a) Local PC** — `npm start` | this PC only (`127.0.0.1`) | Node ≥ 22.18 | trying it out, development |
| **(b) LAN with Docker Compose** | every device on your home/office network | Docker Desktop | **the default**: the founder's PC serves the whole LAN |
| **(c) Cloud VPS** | anyone with the URL and the token | a small VPS, a domain, Caddy | using it away from the office |

Whatever you choose: **model API spend, not hosting, is the real cost** (see [Costs](#costs)). Put API keys
and the access token in `.env` only — never in chat, issues, screenshots or git. `.env` is git-ignored and
excluded from the Docker image (`.dockerignore`).

## Models: the founder's choice

"High-level models for the managers and directors, low-level models for the workers." With
`ANTHROPIC_API_KEY` set, this is the default:

| agents | tier | model (Anthropic API id) | price per 1M tokens (input / output) |
|---|---|---|---|
| executives (CEO, C-suite) | frontier | `claude-opus-5-5` | $4 / $20 |
| managers | standard | `claude-sonnet-5-5` | $2 / $10 |
| workers | economy | `claude-haiku-5-5` | $0.10 / $0.50 |

- `.env.example` already contains these three `MODEL_*` lines. Without a key every tier runs on the free,
  offline, deterministic mock, so a fresh install never spends money by accident.
- **Managers on the top model too:** set `MANAGER_MODEL_TIER=frontier` (or `standard`) in `.env`. New managers
  get that tier, and at the next boot existing managers on standard/frontier are moved to it (a manager you
  put on economy or gave a model override in the console is left alone). Remove the line to stop the boot from
  touching managers. Executives always start on frontier and workers on economy.
- Some brain stages use a fixed tier whatever the agent (e.g. quick checks on economy, chat replies on
  standard; see `DEFAULT_STAGE_ROUTING` in `apps/server/src/models/config.ts` and `STAGE_ROUTING`).
- Fallbacks are optional: `MODEL_<TIER>_FALLBACK=provider:model` is tried once when the primary errors, and
  only if that provider's key is in `.env`. A fallback without a key is ignored; it never breaks the primary.
- At startup the server prints one line per tier — tier → model → provider, `LIVE` or `MOCK`, who uses it.
  Keys are never printed:

  ```
  models (managers on standard, MANAGER_MODEL_TIER):
    frontier → claude-opus-5-5 via anthropic    LIVE  [executives]
    standard → claude-sonnet-5-5 via anthropic  LIVE  [managers]
    economy  → claude-haiku-5-5 via anthropic   LIVE  [workers]
  ```

- **Check the key before the company spends anything:** `npm run check:models` (Docker:
  `docker compose exec agentco npm run check:models`) makes one tiny real call per live tier (`max_tokens`
  16, well under $0.001 in total) and prints model, latency, tokens and cost. It exits 1 on a rejected key or
  an unknown model id, and refuses to run (exit 2) when no key is configured. `-- --fallbacks` also checks
  the fallbacks.
- First-run budgets are deliberately small: `DAILY_BUDGET_USD=5`, `MONTHLY_BUDGET_USD=50` — hard stops for
  all model spend. Raise them once you trust the spend. Budget variables set in `.env` win over the console at
  every boot, so change them in `.env` (or delete the lines and manage them in the console).
- Set `TZ` in `.env` (e.g. `TZ=Asia/Singapore`) so the daily budget and "Spend today" reset at your
  local midnight; unset means UTC.

## (a) Local PC — `npm start`

```bash
cp .env.example .env            # Windows PowerShell: Copy-Item .env.example .env
# edit .env: ANTHROPIC_API_KEY=... (optional; without it everything runs on the mock)
npm install                     # once: react, react-dom and esbuild to build the console
npm start                       # builds the console, starts http://127.0.0.1:3000
npm run check:models            # optional: one tiny real call per tier
```

The server binds to `127.0.0.1`, so only this PC can open it and no token is needed. Data lives in `./data`.

## (b) LAN with Docker Compose — recommended

One container, started by Docker Desktop, serving the console and API to every device on the network.
State (SQLite database and agent workspaces) lives in the named volume `agentco_agentco-data`, so it survives
rebuilds and updates. The steps below are for the founder's PC: **Windows with Docker Desktop (WSL2 backend),
LAN IP `192.168.1.92`**.

### 1. Start Docker Desktop

Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) with the WSL2 backend
(the default), start it and wait until it says *Engine running*. In PowerShell, `docker version` must show
both Client and Server.

### 2. Get the code and create `.env`

Open PowerShell in the AgentCo folder (the one with `docker-compose.yml`):

```powershell
Copy-Item .env.example .env
notepad .env
```

In `.env` set two values (and save):

- `ANTHROPIC_API_KEY=` your Anthropic key. Type it into `.env` only — never into chat, email or git.
- `APP_AUTH_TOKEN=` a random token of 24+ characters. Because the container is reachable from the network,
  the API refuses to start without one. Generate it in PowerShell:

  ```powershell
  $b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })
  ```

  Copy the 48-character result after `APP_AUTH_TOKEN=`. Keep it like a password; it is what the console asks
  for.

Leave `HOST`, `PORT` and `DATA_DIR` as they are: Compose pins `HOST=0.0.0.0`, `PORT=3000`, `DATA_DIR=/data`
inside the container. If `APP_AUTH_TOKEN` is empty, `docker compose` stops immediately with
*"APP_AUTH_TOKEN is empty - set it in .env…"*; if it is shorter than 24 characters the container exits at boot
and `docker compose logs` says why and how to generate one.

### 3. Build and start

```powershell
docker compose up -d --build
docker compose ps                      # STATUS should become "Up … (healthy)" within ~30 s
docker compose logs --tail 20          # the model summary: LIVE for each tier once the key is set
docker compose exec agentco npm run check:models
```

### 4. Open the console

- On the PC itself: <http://localhost:3000>
- On other devices (phone, laptop) on the same network: <http://192.168.1.92:3000>

The first time each browser opens the console it asks for the **access token** (paste `APP_AUTH_TOKEN`).
To skip typing it on a phone, open the link once with the token in it —
`http://192.168.1.92:3000/?token=<your token>` — the console stores it and removes it from the address bar;
bookmark the plain address afterwards. Don't share or post that link: it contains the token.

How the console keeps the token: in the browser's **localStorage under `agentco.token`**, per origin — so
`http://localhost:3000` and `http://192.168.1.92:3000` each ask once. The console sends it as
`Authorization: Bearer …` (and as `?token=` on the live event stream, which cannot carry headers). If the
token stops matching (you changed it), the console asks again ("the saved token was rejected"). To forget it,
clear the site's data in the browser.

The request guard works behind the published port without extra settings: with the wildcard bind the server
accepts any `Host` (the bearer token is the gate), and a state-changing request is allowed from the page's own
origin — whatever address and port you opened. `ALLOWED_ORIGINS` / `ALLOWED_HOSTS` are only needed behind a
reverse proxy that rewrites the `Host` header (see option c).

### 5. Open port 3000 in Windows Firewall (Private networks only)

Docker Desktop publishes the port on all of the PC's interfaces, but Windows Firewall decides who may connect.
In **PowerShell as Administrator**:

```powershell
New-NetFirewallRule -DisplayName "AgentCo console (TCP 3000, private networks)" `
  -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

The rule applies only while the PC's network is marked *Private*. Check, and fix if it says *Public*:

```powershell
Get-NetConnectionProfile                                  # NetworkCategory should be Private
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private   # or "Ethernet"
```

Remove the rule later with `Remove-NetFirewallRule -DisplayName "AgentCo console (TCP 3000, private networks)"`.
Never forward port 3000 on the router: the LAN traffic is plain HTTP and the token is a shared secret, which
is fine at home but not on the internet — use option (c) for that. Reserve `192.168.1.92` for this PC in the
router (DHCP reservation) so the address doesn't change.

If you only want the console on this PC, change `ports` in `docker-compose.yml` to `"127.0.0.1:3000:3000"`.

### 6. Day to day

```powershell
docker compose logs -f --tail 100      # follow the logs (Ctrl+C stops following, not the server)
docker compose up -d                   # after editing .env: recreates the container with the new values
docker compose stop                    # stop the company (work in progress resumes on the next start)
docker compose start
docker compose down                    # remove the container; the data volume is KEPT
```

`docker compose down -v` **deletes the data volume** (the whole company). Don't use `-v` unless you mean it.

### 7. Back up and restore

The database is SQLite in WAL mode, so stop the container for a consistent copy (a few seconds):

```powershell
docker compose stop
docker compose cp agentco:/data "./agentco-backup-$(Get-Date -Format yyyy-MM-dd)"
docker compose start
```

That folder (`agentco.db` + `workspaces/`) is the whole company; keep copies off the PC. To restore a backup
into the volume (replaces the current state):

```powershell
docker compose stop
docker run --rm -v agentco_agentco-data:/data -v "${PWD}\agentco-backup-2026-11-06:/backup:ro" --user 1000:1000 --entrypoint sh agentco:local -c "rm -rf /data/* && cp -R /backup/. /data/"
docker compose start
```

### 8. Update

```powershell
git pull                               # or unpack the new version over the folder, keeping .env
docker compose up -d --build           # rebuilds the image, recreates the container, keeps the volume
docker image prune -f                  # optional: remove the old image layers
```

Compare `.env` with the new `.env.example` after an update; new settings have safe defaults if missing.

### Troubleshooting

| symptom | cause / fix |
|---|---|
| `required variable APP_AUTH_TOKEN is missing a value` | set `APP_AUTH_TOKEN` in `.env` (step 2) |
| container keeps restarting | `docker compose logs` — usually the token is shorter than 24 characters |
| `env file … .env not found` | run the commands in the folder with `.env` (step 2) |
| works on the PC, not on the phone | firewall rule / network profile (step 5), same Wi-Fi, correct IP (`ipconfig`) |
| console asks for the token again and again | the stored token doesn't match `.env`; paste the current one |
| `403 forbidden_origin` | you are behind a proxy that rewrites `Host`: add its origin to `ALLOWED_ORIGINS` |
| tiers show `MOCK` | no `ANTHROPIC_API_KEY` in `.env`, or `docker compose up -d` not re-run after editing |

The image is built from `node:24-slim` (override with `--build-arg NODE_IMAGE=…`). It contains only the
server source, the shared types, the built console and `catalog/` (read at runtime); the server needs no
`node_modules`. It runs as the non-root `node` user, has a `HEALTHCHECK` on `/api/health`, and only `/data`
is writable. `npm ci` is used when a `package-lock.json` is present, otherwise `npm install`.

## (c) A cloud VPS

For using the company away from the LAN. The server is light — the whole enterprise org (≈ 45 agents) peaked
at about 180 MB of memory while running a Boardroom objective — so **1–2 GB of RAM and 1 vCPU are enough**.
Indicative prices (checked 2026-11, excluding VAT):

- Hetzner Cloud **Singapore CPX12** (1 vCPU, 2 GB RAM, 40 GB disk): **€15.99/month** excl. VAT
  ([hetzner.com/cloud-singapore](https://www.hetzner.com/cloud-singapore)).
- DigitalOcean Basic droplets: about **$6.5/month for 1 GB** and **$13/month for 2 GB** (from a third-party 2026
  listing; not verified on DigitalOcean's own pricing page).

Rules: HTTPS only (a TLS reverse proxy in front), the token always required, port 3000 never exposed directly.

1. Create an Ubuntu 24.04 server, point a DNS `A` record (e.g. `agentco.example.com`) at its IP, and allow only
   SSH, HTTP and HTTPS: `ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`.
2. Install Docker Engine with the Compose plugin
   ([docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/)).
3. Copy the code to the server, create `.env` as in (b) step 2 (key + token), then start AgentCo on the
   server's loopback only:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
   ```

   `docker-compose.vps.yml` publishes the port as `127.0.0.1:3000:3000`, so only the proxy can reach it.
4. Install [Caddy](https://caddyserver.com/docs/install#debian-ubuntu-raspbian) and put this in
   `/etc/caddy/Caddyfile`, then `systemctl reload caddy`. Caddy obtains and renews the TLS certificate:

   ```
   agentco.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Caddy keeps the original `Host` header and streams Server-Sent Events, so the console, the live event
   stream and the request guard work unchanged. With another proxy that rewrites `Host` (nginx's default),
   add `ALLOWED_ORIGINS=https://agentco.example.com` to `.env`.
5. Open `https://agentco.example.com` and paste the token. Back up and update exactly as in (b), using the same
   two `-f` files for `up`.

## Maintenance: archiving stale company memory

Agents learn from what they did: lessons, episodes, blackboard notes and workspace files are recalled
into every new task. After a bad stretch (for example the question loop of 2026-11-06) that memory keeps
teaching the old habit. `scripts/maintenance/archive-stale-memory.mjs` moves it out of the agents' reach
without deleting anything. Pause the company first, then from the repo folder:

```powershell
docker cp scripts/maintenance/archive-stale-memory.mjs agentco-agentco-1:/tmp/archive.mjs
docker exec agentco-agentco-1 node /tmp/archive.mjs            # dry run: what would move, and why
docker exec agentco-agentco-1 node /tmp/archive.mjs --apply    # archive; prints the stamp
docker exec agentco-agentco-1 node /tmp/archive.mjs --restore <stamp>   # undo
```

Archived memories and blackboard entries go to the `memories_archive` / `blackboard_archive` tables of
the same database; files go to `/data/archive/<stamp>/` with a `manifest.json`. All of it stays in the
`agentco-data` volume and its backups.

## Weekly audit

`scripts/audit/company-audit.mjs` prints a read-only JSON audit of the running company: work and stuck
tasks, escalations, the Board's queue, runs and model errors, spend by tier/model/agent/day, agents that
need attention (frustration, mood, calibration drift), and company-memory hygiene (stall lessons,
blocked-outcome episodes, blackboard). It changes nothing and never prints keys or the API token.

```powershell
docker cp scripts/audit/company-audit.mjs agentco-agentco-1:/tmp/company-audit.mjs
docker exec agentco-agentco-1 node /tmp/company-audit.mjs --days 7
```

A scheduled Claude task runs it every Monday on the PC and writes the report to
`Documents\agentco-audits\audit-<date>.md` (plus a copy in the conversation). The task only reports and
recommends; acting on a recommendation is the Board's call.

## Costs

Hosting is small and fixed: the founder's PC (electricity) for (b), or roughly $6.5–€16 a month for a VPS in (c).
**Model API spend is what grows with use**, and the budgets (`DAILY_BUDGET_USD`, `MONTHLY_BUDGET_USD`) cap it.
The Costs page in the console shows the actual spend per tier, model, agent and department.

### Worked estimate: one Boardroom objective

Measured by running the system test's objective on the offline mock — *"Plan and prepare the launch of our first
product, an AI meeting-notes app. Write a launch plan with marketing, engineering and finance input."* — and
reading the spend rows of that objective's trace (per-tier calls and tokens; the same totals appear per tier in
`/api/metrics/overview` → `spendByTier`). The tokens are then priced at Opus $4/$20, Sonnet $2/$10 and
Haiku $0.10/$0.50 per million (input/output). **This is an estimate**, not a measurement of live models.

**Startup org** (19 agents; the objective used 5 agents, 7 tasks, 34 model calls):

| tier | model | calls | input tokens | output tokens | cost |
|---|---|---:|---:|---:|---:|
| frontier | Claude Opus 5.5 | 4 | 3,778 | 1,552 | $0.0462 |
| standard | Claude Sonnet 5.5 | 8 | 7,194 | 1,208 | $0.0265 |
| economy | Claude Haiku 5.5 | 22 | 16,311 | 3,327 | $0.0033 |
| **total** | | **34** | **27,283** | **6,087** | **$0.076** |

**Enterprise org** (45 agents; 7 agents incl. managers, 10 tasks, 56 calls): frontier $0.0438 (3,936 in /
1,404 out), standard $0.0625 (14,440 / 3,357), economy $0.0043 (21,965 / 4,244) — **$0.111** in total.
With `MANAGER_MODEL_TIER=frontier` the managers' Sonnet calls in that run (6,743 in / 2,149 out) would cost at
most twice as much on Opus: **≤ $0.146**.

How to read it:

- Routing matters: the same startup objective on Opus alone would cost about **$0.23** — tiering saves ~67%.
- The mock's input tokens are the real prompts the engines build, but its outputs are short and it never needs
  a retry. Live models write longer answers and workers may take more tool steps. Allowing 1.5× the input and
  4× the output gives about **$0.23 (startup) / $0.33 (enterprise)** per objective. Plan with
  **$0.10–$0.35 per objective**; chat messages that don't start work cost far less.
- With the first-run cap of `DAILY_BUDGET_USD=5` that is roughly 15–50 objectives a day before the hard stop.
  Even the €15.99 VPS costs about €0.53 a day — model spend dominates as soon as the company is busy.
- `HEARTBEAT_MINUTES>0` makes executives review OKRs on a timer and spends tokens with nobody asking; it is off
  by default.
- Anthropic's OpenAI-compatible endpoint has no prompt caching, so no cache discount is assumed.

Reproduce: start the server on the mock (`MOCK_LATENCY_MS=0`), post the request above in the Boardroom, wait
for the objective to finish, then sum `input_tokens` / `output_tokens` from the `spend` table of
`DATA_DIR/agentco.db` grouped by `tier` for that `trace_id`.
