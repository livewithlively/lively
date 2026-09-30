# Lively deployment (self-hosted)

*[한국어](README.ko.md)*

Packaging that lets an operator put Lively on a single host **without code**. Supports both Linux and macOS.

## Topology — Option 2 (store = Docker / gateway = native)

```
 ┌─ Host (EC2 Linux · or Mac) ─────────────────────────────────────────┐
 │                                                                     │
 │   gateway (native: systemd | launchd)                               │
 │     · MCP(/mcp) · web UI(/ui) · delivery(/install) · central box    │
 │       (web terminal)                                                │
 │     · node dist/index.js  ←─ .env                                   │
 │            │ localhost:5432                                         │
 │            ▼                                                        │
 │   store (docker compose)                                            │
 │     · items-db = pgvector/pgvector:pg18  (knowledge·v6·domain map)  │
 │     · embeddings = Ollama (optional, profile)                       │
 │                                                                     │
 │   docker (host)  ←─ used directly by central-box sessions (no DinD) │
 └─────────────────────────────────────────────────────────────────────┘
```

**Why is the gateway native?** The gateway spawns central-box (web terminal) sessions *inside its own process* with tmux/PTY.
Put the gateway in a container and those sessions are in the container too → building team repos or running `docker compose` falls into the **DinD trap**.
Run it natively and sessions use the host docker directly. (Rationale: `knowledge_get central-box-design`)

> Full-docker (the gateway in a container too = Option 1) can be previewed with `docker compose --profile gateway up`,
> but using the central box requires splitting out the runner first (later).

## One-line install (bootstrap.sh) — "without code"

`bootstrap.sh` does **code acquisition → install.sh** in one go. The operator needs no source, git clone, or build — just one line:

```bash
curl -fsSL https://raw.githubusercontent.com/livewithlively/lively/main/deploy/bootstrap.sh | PUBLIC_URL=http://<host>:8080 BOOTSTRAP_ADMIN_EMAIL=you@org.com ORG_DOMAIN=org.com bash
```

### Structure — code acquisition (swappable) ↔ install (delivery-agnostic)

```
 bootstrap.sh ─ code acquisition ─────────────┐       install.sh ─ install (doesn't know how the code arrived)
   online : git clone | LIVELY_CODE_URL(tgz)  │  →    1 deps  2 .env  3 store  4 build
   offline: LIVELY_BUNDLE(local tgz)          │        5 service  6 bootstrap  7 kit
   → extract into APP_DIR, run install.sh ────┘       (OFFLINE=1 skips network steps)
```

**The install logic (install.sh) doesn't depend on how the code was delivered** → switch between online and offline by changing only code acquisition (install.sh unchanged).

| | Online (default, current) | Offline (air-gapped — structure only, bundle CI later) |
|---|---|---|
| Code acquisition | `git clone` / `LIVELY_CODE_URL` tgz | `LIVELY_BUNDLE` local tgz |
| node·deps | install.sh installs them + `npm ci` (`--omit=dev` for release bundles, node-pty automatic) | node_modules shipped in the bundle → `OFFLINE=1` skips `npm ci` |
| Internet | Required (npm·nodejs·github) | Not required |
| Artifact | Small (code only) | Large (node_modules·dist·runtime included) |

- **Currently online.** Offline is **already branched by flags (`LIVELY_BUNDLE` + `OFFLINE=1`)** — all that's left is *CI that bakes a fat bundle (with node_modules)* (to be added when there's demand for air-gapped installs).
- **Private repo** download: add `LIVELY_CODE_TOKEN` (Bearer). The public (OSS) repo needs no token (`git clone` by default).
- Fetch the code only, for verification: `LIVELY_FETCH_ONLY=1`.

### Publishing a release (maintainers — tag push)

On a **`vX.Y.Z` tag push**, `.github/workflows/release.yml` **automatically** builds → packs `lively.tgz` (dist+public+kit+deploy+docker-compose.yml+package*+apps/builtin+a few ops scripts; no source or node_modules = arch-independent) → publishes a GitHub Release.

```bash
git tag v0.1.0 && git push origin v0.1.0     # → Actions publishes Release v0.1.0 + asset (lively.tgz)
```

Then the operator only has to give a version — bootstrap builds the asset URL automatically:
```bash
curl -fsSL https://raw.githubusercontent.com/livewithlively/lively/main/deploy/bootstrap.sh | LIVELY_VERSION=latest PUBLIC_URL=… BOOTSTRAP_ADMIN_EMAIL=… bash
```
(The repo is public, so no token is needed. Only when pulling releases from a private fork do you need `LIVELY_CODE_TOKEN` (Bearer) — bootstrap then downloads through the GitHub API asset endpoint.)

#### The same tag **also ships the desktop app** — and that takes a while

`release-desktop.yml` also triggers on the same `v*` tag, builds the mac/win/linux apps, and **attaches them to the same release**. So one tag = server bundle + desktop app.

⚠ **The mac job is the long pole.** It's universal (x64+arm64 combined), so it builds both archs and merges them.
Measured on v0.1.355 (before universal): mac 4 min · win 1 min · linux 0 min (matrix in parallel). Since universal, budget **roughly 2× for mac only**.
For why mac must be universal, see the header of `release-desktop.yml` — onboarding «앱 받기» (Get the app) can't tell the arch apart.

★ **If you're going to wait, don't block.** Neither a person nor an AI has any reason to sit in front of a tag after pushing it.
Push, **do other work**, and get notified when it completes. Verifying once after the release finishes is enough.

```bash
git tag -a v0.1.1 -m "…" && git push origin v0.1.1
# ↓ wait in the background until it completes (don't hold the turn), then just look at the result
#   for an AI, use Bash(run_in_background: true) — a foreground sleep loop blocks the conversation for that long
until [ "$(gh run list --limit 20 --json headBranch,status         --jq '[.[]|select(.headBranch=="v0.1.1")|select(.status!="completed")]|length')" = 0 ]; do sleep 60; done
gh release view v0.1.1 --json assets --jq '.assets[].name'
```

Two things to check after publishing:
- **Onboarding [앱 받기] (Get the app)** has no version baked into the code and asks `releases/latest` each time → a new release becomes the latest automatically (no deploy needed). But `latest` **skips drafts and prereleases**.
- **Auto-update** checks whether `version:` in `latest-mac.yml` has the new value. If the tag fails to overwrite the version in `desktop/package.json`, the updater decides "already up to date" forever.

## First install (new box — install.sh)

> Overall flow: deliver the code (release bundle `lively.tgz` — see [Quick start](../README.md#quick-start-self-hosted) — or rsync/git clone) → `install.sh` below → log in to `claude`.
> On EC2, infrastructure provisioning (`terraform apply`, etc.) comes first. (For infrastructure and rsync commands, see your organization's infrastructure repo docs.)

```bash
# on the host (with the code already there)
PUBLIC_URL=http://<host>:8080 BOOTSTRAP_ADMIN_EMAIL=you@org.com ORG_DOMAIN=org.com \
  bash deploy/install.sh
```

`install.sh` detects the OS and runs 7 steps (all idempotent and non-destructive):

| Step | What it does |
|---|---|
| 1 Dependencies | docker · node22 · tmux · build-deps · Claude Code (`deploy/<os>/provision.sh`). On mac, Homebrew and Docker (Docker Desktop or colima) must already be present |
| 2 .env | If missing, generated with secrets (`openssl rand`) — **preserved if it exists** |
| 3 store | `docker compose up -d --wait items-db` (pgvector, bound to 127.0.0.1) |
| 4 Build | Source deploy (git clone/rsync): `npm ci && npm run build`. Release bundle (ships `dist`, no `src`): build skipped, only `npm ci --omit=dev` |
| 5 Service + TLS | (Linux) memory safety — creates a swap file if there's no swap, plus earlyoom (`LIVELY_SWAP_SIZE`, default 8G · skip with `LIVELY_MEM_SAFETY=off`) → register and start systemd (Linux) / launchd (Mac) + `/healthz` (listen) + **wait for `/readyz` `schema=ready`** (through schema self-migration and the first-boot self-restart) + automatic HTTPS via Caddy if `LIVELY_DOMAIN` is set |
| 6 Bootstrap | Seeds the first admin (web session login account) · anonymous baseline · default connectors — `deploy/bootstrap-*.mjs` (⚠ after the readiness wait · retries itself for ≤60s if the schema isn't ready). **If any of them fails, it shows as ✗ in the summary and install.sh exits non-zero** — the gateway is up, so just rerun the command for the ✗ item |
| 7 Central-box kit | Installs lively into the host claude (MCP + hooks + context) — `deploy/install-kit.sh`. **Web terminal sessions can then CRUD context.** |

Environment variables: `LIVELY_DOMAIN` (automatic HTTPS when set — see [TLS](#tls-automatic-https--caddy) below) · `PUBLIC_URL` · `BOOTSTRAP_ADMIN_EMAIL`
· `BOOTSTRAP_ADMIN_PASSWORD` (random if omitted) · `ORG_DOMAIN` · `WITH_EMBEDDINGS=1` (embeddings sidecar + provider=http + backfill at the end of install, end to end — t4g.large+ recommended) · `FORCE=1` (ignore an existing gateway detected on :8080).

## Turning on embeddings (vector search #172)

Off by default (search = grep fallback). Once the provider is on, the gateway fills in unembedded items (**including existing knowledge**) with an automatic backfill sweep (30 s after boot · every 10 min · after connector syncs — #669; can be paused from the admin screen). The paths below run the **existing-knowledge backfill** right away instead of waiting for that cycle.

- **Existing box, one shot:** `bash deploy/enable-embeddings.sh` — start the local Ollama sidecar (bge-m3) → `.env` `EMBEDDINGS_PROVIDER=http` → restart the gateway → backfill existing knowledge. On a 4GB box the RAM guard stops it (→ upsize / external endpoint / `FORCE=1`).
  - External endpoint (no sidecar): `EMBEDDINGS_BASE_URL=<host> EMBEDDINGS_MODEL=<m> [EMBEDDINGS_AUTH_ENV=<name-of-env-var-holding-the-key>] bash deploy/enable-embeddings.sh --external`
- **Web UI (admins):** the ‘의미 검색 (임베딩)’ (semantic search / embeddings) section under [수집 · 증류 ▸ AI 주입 설정] (Collect · Distill ▸ AI injection settings) — save provider/base_url/model/dim (no restart) + the [기존 지식 임베딩(백필)] (embed existing knowledge / backfill) button (with progress) + pause/resume of the automatic backfill.
- **From the start:** `WITH_EMBEDDINGS=1 bash deploy/install.sh`.

Turning it off: `bash deploy/disable-embeddings.sh` (provider off + sidecar down — vector data is kept). Swapping models: after changing `EMBEDDINGS_MODEL`, run `node --env-file-if-exists=.env scripts/backfill-embeddings.mjs --model-changed` (`--all` if the dimension differs).

## Updating (existing box — update.sh)

This is different from the first install: **dependencies, `.env`, data (volumes), claude auth, and admin/baseline stay as they are, and the code is updated** (the service unit is re-rendered from the template, keeping the service user).
Bootstrap (admin, baseline) is idempotent, so there's no need to rerun it (only the default-connector seed runs again, to pick up new default connectors). The schema self-migrates when the gateway boots (restarts).

```bash
# 1) Deliver the new code — rsync from a 'clean main' on the operator machine (don't mix in WIP: git clone or a worktree at origin/main).
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude logs \
  --exclude backups --exclude '.env*' --exclude '*.bak*' --exclude var/repos \
  -e "ssh -i ~/.ssh/<key>" <clean-main>/  ubuntu@<host>:<APP_DIR>/

# 2) Apply on the box — build → store (idempotent) → restart → healthz. Add --kit if kit/ changed.
ssh -i ~/.ssh/<key> ubuntu@<host> 'cd <APP_DIR> && bash deploy/update.sh --kit'
```

> `<APP_DIR>` = the actual install path on that box. If you installed per [Quick start](../README.md#quick-start-self-hosted) it's `/opt/lively`; the `bootstrap.sh` default is `~/lively` (`LIVELY_APP_DIR`); **boxes installed before the repo rename stay at
> `~/context-ontology`** (see below — the directory is not moved).

| | First install (`install.sh`) | Update (`update.sh`) |
|---|---|---|
| Dependencies (docker·node·tmux·claude) | Installed | Untouched |
| `.env`, secrets | Created if missing | Preserved |
| store (pgvector) | Created | Applied idempotently (image/compose changes only) |
| Memory safety (Linux swap·earlyoom) | Configured | Reapplied idempotently (existing settings respected) |
| Build, service | Registered and started | Build, re-render the unit (user kept) + **restart** |
| First admin, baseline | Seeded | Skipped (idempotent, already exists) |
| Default connectors | Seeded | Only missing ones seeded (existing ones kept) |
| Central-box kit | Installed | Updated only with `--kit` |

- **If the build fails**: `update.sh` stops before restarting → the existing gateway keeps running (no downtime).
- **Rollback**: rsync the previous main commit, then run `update.sh` again.
- On a **git clone box**, replace 1) with `git pull`, then run `update.sh`.
- On a **release bundle box** (installed from `lively.tgz`), replace 1) by extracting the new bundle into `<APP_DIR>` (`curl -fsSL https://github.com/livewithlively/lively/releases/latest/download/lively.tgz | tar -xz -C <APP_DIR>` — `.env` and data aren't in the bundle, so they're preserved), then run `update.sh` — it skips the build and only runs `npm ci --omit=dev`.
- ⚠ **On a blue-green box, `update.sh` refuses to run** — that box deploys with `deploy-release.sh` (next section).

## Zero-downtime deploy (blue-green) — **opt-in · AWS ALB front end only**

The default deploy (`update.sh`) **restarts the gateway in place**, so there are a few seconds of downtime. Because the gateway
holds the web terminal PTY/tmux inside its process, that blip matters on a live surface where the whole organization plus
session MCP connections are attached. Blue-green removes the blip by **alternating two colors (blue/green) within one box**.

### Scope — not a feature to turn on for just any self-hosted box

| Prerequisite | Details |
|---|---|
| OS | Linux/systemd only (mac is a single launchd unit — the script `die`s) |
| Front end | An **AWS ALB must connect directly to instance targets**. The flip primitive itself is *swapping target ports in the ALB target group*, so it won't run without `--tg-arn` (Caddy/nginx/traefik front ends are not supported) |
| TG settings | The health check must use `traffic-port` (with a fixed port, per-port health can't be judged and a flip causes a full outage). A preflight asserts this before starting and aborts otherwise |
| IAM | The box's instance role needs, scoped to that TG, `elbv2:RegisterTargets` · `DeregisterTargets` · `DescribeTargetHealth` · `DescribeTargetGroups` |
| Release | The code to deploy (dist + node_modules) must already be on the box as a **prepared directory**. Creating the release directory (build, delivery) is outside this script |

In short, this mode is an **opt-in path limited to deployments that run Lively behind an AWS ALB**. Boxes that haven't run
the one-time migration are unaffected (no layout, no units are created).

### Topology

```
ALB:443 ─▶ instance targets (blue:8081 | green:8082)     flip = ALB target port swap
localhost:8080 ─▶ loopback alias ─▶ current active color   fixed entry point for session client pins (~/.lively/gateway-url)
```

`:8080` leaves the flip pool and becomes a **loopback alias only** (`systemd-socket-proxyd`). This keeps the
`localhost:8080` that sessions have pinned pointing at the current active color even when the port changes — without it, a flip
breaks reconnection for every session (a real incident on 2026-08-03).

### Layout (`${LIVELY_ROOT:-/opt/lively}`)

```
releases/<id>/            per-release code (dist·node_modules)
shared/{.env,data}        shared state (kept across deploys). items-db is a docker named volume, so it's outside this anyway
logs/gateway-<color>.log  shared logs       color-env/<color>.env   per-color PORT
<color> → releases/<id>   color→release     active-color            state file (blue|green)
current / previous        convenience symlinks (previous = instant rollback target)
```

### Procedure

```bash
# ① One-time migration — move an existing single-unit install into the blue-green layout. Backup first, no flip (the old unit keeps serving).
bash deploy/migrate-to-bluegreen.sh              # plan only (dry-run)
bash deploy/migrate-to-bluegreen.sh --confirm

# ② Every deploy after that — bring it up on the idle color, and flip the ALB only after local /readyz passes.
bash deploy/deploy-release.sh --release <prepared release dir> --tg-arn <ALB target group ARN>

# ③ Rollback — rerun the same command with previous (a few seconds, no rebuild).
bash deploy/deploy-release.sh --release "$LIVELY_ROOT/previous" --tg-arn <ALB target group ARN>
```

**Rollback safety invariant**: ALB register (+ healthy check) comes **before** deregistering the old port, the active-color
commit comes **after** a successful deregister, and stopping the old unit comes **last**. Whichever step fails, the old color keeps serving
(= not flipping is itself the automatic rollback). The pure decision logic is in `deploy/lib/bluegreen.sh`, and
`deploy/bluegreen-logic.test.mjs` locks the contract.

### What zero-downtime actually covers (no overselling)

| Path | Guarantee |
|---|---|
| ALB → HTTP·MCP | Zero downtime. The two ports overlap for a while, and the old port drains for the ALB dereg delay (default 300s) |
| Web terminal WS | **Drops → reconnects.** tmux sessions survive thanks to `KillMode=process` and re-attach as they were |
| `localhost:8080` pin | New connections see no downtime (the socket always listens). **In-flight connections at the moment of the flip are dropped** (repointing the forwarder = restarting the proxy) |
| `--drain-seconds` (default 5) | Stops the old unit after 5 seconds — much shorter than the ALB's 300s draining. To let long connections drain fully, keep it with `--keep-old` and stop it manually later (meanwhile two gateways = 2× memory) |

### Service rename (first update after the repo was renamed to `lively`)

When the repo was renamed from `context-ontology` to `lively`, the service names changed with it.
**Existing boxes switch over automatically the first time you run `update.sh` — there's nothing to do by hand.**

| | Before | After |
|---|---|---|
| systemd unit | `context-ontology-gateway` | **`lively-gateway`** |
| launchd label (mac) | `io.lvly.context-ontology` | **`io.lvly.lively`** |
| Release asset | `context-ontology.tgz` | **`lively.tgz`** |
| Install directory (`APP_DIR`) | — | **Left as is** |
| docker compose project name | — | **Left as is** |

What `update.sh` does automatically:

1. **Inherits** the service user (`User=`) from the old unit (so the user on a non-isolated box doesn't change).
2. `disable --now` the old unit → delete the unit file → `daemon-reload`.
3. Render the unit under the new name, `enable` + `restart` → check `/healthz`.

**Why the directory and compose project name are deliberately left alone**: moving the install directory breaks running tmux sessions
and log append paths. Renaming the compose project changes the named volume name (`<project>_items-db-data`), so
**items-db is created fresh as an empty DB** (knowledge and project data lost). In both cases only the name differs and behavior is unaffected,
so leaving them is the safer choice.

Verifying the switch:

```bash
systemctl status lively-gateway                      # active (running)
systemctl list-unit-files | grep context-ontology    # should print nothing
curl -fsS localhost:8080/healthz                     # {"ok":true}  — liveness (listen). Not a schema-complete signal
curl -s localhost:8080/readyz | grep -o '"schema":"[a-z]*"'   # "schema":"ready" — migration and seeding done (503 if pending/restarting)
journalctl -u lively-gateway -n 50 --no-pager
```

⚠ The gateway pauses briefly during the switch (old unit stop → new start). tmux sessions survive because of `KillMode=process`,
and re-attach in the web terminal after the restart.

## TLS (automatic HTTPS — Caddy)

**`LIVELY_DOMAIN` is all it takes.** When set, `install.sh` (step 5) starts the Caddy reverse proxy (profile=proxy), which
**issues and renews Let's Encrypt certificates automatically**, terminates `:443`, and proxies to the native gateway (`localhost:8080`).
`PUBLIC_URL` automatically becomes `https://<domain>` (→ session cookie `Secure`), and Caddy handles HTTP→HTTPS redirects and WebSocket (web terminal) transparently.

```bash
# HTTPS from the first install (issuance requires the domain's A record to point at this host)
LIVELY_DOMAIN=gw.org.com BOOTSTRAP_ADMIN_EMAIL=you@org.com ORG_DOMAIN=org.com \
  bash deploy/install.sh
```

**Adding TLS to an existing box:** add one line, `LIVELY_DOMAIN=gw.org.com`, to `.env` (and `PUBLIC_URL=https://gw.org.com` if needed) → `bash deploy/update.sh`. `proxy_up` starts Caddy.

- **Prerequisite:** the domain's A (or AAAA) record must point at this host's public IP (ACME HTTP-01). Open `80` and `443` in the firewall/SG. There's no need to expose `8080` directly (block it in the SG; for debugging use `ssh -L 8080:localhost:8080`).
- **Certificate persistence:** the `caddy-data` volume (ACME account, certificates). Deleting it forces reissuance (watch the Let's Encrypt rate limit).
- **No domain (IP only):** leave `LIVELY_DOMAIN` empty and there's no proxy — use `:8080` directly (restrict the SG to trusted IPs) or an SSH tunnel. Let's Encrypt doesn't issue IP certificates, so a public service needs a domain.
- **Custom proxy / internal CA:** edit `deploy/Caddyfile`, or put a separate proxy (nginx, etc.) in front of `localhost:8080`.
  - ⚠ **Long request timeouts are required (nginx, etc.):** project repo provisioning (`POST /api/ui/v6/projects/:id/provision`),
    unless called with `async:true` (which only starts it and answers 202 right away — #1180), runs `git clone`/`fetch`/`worktree` on the box **synchronously** (internal budget 180s/op). With nginx's default `proxy_read_timeout` (60s),
    a first clone or a slow network is cut off before the response and you get **504 Gateway Time-out** (the backend git keeps going → a retry succeeds).
    Give the front proxy a generous timeout. Caddy has no limit by default, so it's unaffected; for nginx:
    ```nginx
    # generous only on long-running git paths such as provision (scoping recommended)
    location /api/ui/v6/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_read_timeout    600s;
        proxy_send_timeout    600s;
        proxy_connect_timeout 60s;
        # pass WebSocket Upgrade — the web terminal (xterm) WS is /terminal/ws, outside this location:
        #  put the three lines below in the location that serves that path (usually /) as well
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    ```
    To apply: add the block inside server{} → `nginx -t && nginx -s reload`. (Async mode landed in #1180 — only synchronous call paths need this timeout.)

## Central-box kit (why install it on the host too)

The gateway's **central-box (web terminal) sessions run claude on this host.** For those sessions to CRUD organizational context
through the lively MCP, **the host's claude needs the lively kit installed too**, just like a member's local PC. That's why step 7 of the install
includes `install-kit.sh` (same end state as a member's local install, except gateway=localhost and an OS-agnostic path).

- Members install with `curl <gateway>/cli | sh` → the lively CLI. The central box has a different token and paths, so `install-kit.sh`
  runs the OS-agnostic install engine from the gateway's `/install` bundle (`setup/user-install.mjs` + `setup/register-clients.sh`) directly.
- Result: `~/.lively/{token,gateway-url,context.md,hooks/…}` + the lively CLI (`~/.lively/bin/lively`) + `~/.claude/settings.json` (non-destructive hook merge, auto-approve)
  + a user-scope MCP registration (`mcpServers` in `~/.claude.json` — the same result as `claude mcp add --scope user`). Verify: `claude mcp list | grep lively` → `✔ Connected`.
- Standalone reinstall: `bash deploy/install-kit.sh` (env: `LIVELY_TOKEN`·`LIVELY_GATEWAY`·`KIT_HARNESS=claude,codex`).
- The Claude account for web terminal sessions is per member: by default (multi-profile #346) a session starts with a member-specific `CLAUDE_CONFIG_DIR` (`~/.lively/profiles/<slug>/claude`),
  and the member logs in once in that session (`LIVELY_MULTIPROFILE=0` = shared mode for single-user boxes). On Linux you can also opt into per-member OS user isolation
  (`sudo bash deploy/linux/install-isolation.sh`, #524).

## Directory layout (Linux/Mac parity shows in the structure — main files only)

```
deploy/
  bootstrap.sh        # one-line install entry point (curl|bash): code acquisition (online/offline) → install.sh
  install.sh          # install engine (detect OS → <os>/provision.sh, 7 steps). Delivery-agnostic.
  update.sh           # update an existing box (build→restart→healthz, --kit)
  uninstall.sh        # removal (inverse of install): removes service·containers·kit / --purge = volumes·.env·directory too
  lib/common.sh       # shared: logging·OS detection·secrets·non-destructive .env creation·store_up·healthz·proxy_up(TLS)
  lib/bluegreen.sh    # blue-green pure decision logic (sourced by deploy-release.sh)
  Caddyfile           # Caddy reverse proxy config (automatic HTTPS — LIVELY_DOMAIN)
  env.example         # .env documentation (no secrets)
  initdb/01-init.sh   # pgvector first-time init: creates the domainmap DB
  bootstrap-admin.mjs # seeds the first admin (session login)
  bootstrap-baseline.mjs # seeds the anonymous org baseline (persona·rules) — only when empty
  bootstrap-connectors.mjs # seeds the default connector catalog — only missing ones
  install-kit.sh      # central-box kit — installs lively (MCP+hooks+context) into the host claude
  enable-embeddings.sh  # turn on embeddings (vector search) — sidecar→provider=http→restart→backfill existing knowledge (existing box, idempotent)
  disable-embeddings.sh # turn off embeddings — provider off + sidecar down (vector data kept)
  migrate-to-bluegreen.sh # one-time blue-green migration (opt-in)
  deploy-release.sh   # blue-green deploy·rollback (ALB flip)
  linux/              # ── Linux support ──
    provision.sh                          # apt·docker·node·claude / systemd install
    lively-gateway.service      # systemd unit template
    lively-gateway@.service     # blue-green template unit (color instances)
    lively-loopback.{socket,service} # blue-green :8080 loopback alias
    install-isolation.sh        # per-member OS user isolation (opt-in, #524)
  mac/                # ── macOS support ──
    provision.sh                          # brew (tmux·node)·docker check·claude / launchd install
    io.lvly.lively.plist        # launchd plist template
../docker-compose.yml # store (items-db) + embeddings (profile) + gateway (profile) + caddy (profile=proxy, TLS)
../Dockerfile         # gateway image (for full-docker / Option 1)
```

## Operations

| Task | Linux (systemd) | macOS (launchd) |
|---|---|---|
| Status | `systemctl status lively-gateway` | `launchctl print gui/$(id -u)/io.lvly.lively` |
| Logs | `journalctl -u lively-gateway -f` or `tail -f logs/gateway.log` | `tail -f logs/gateway.log` |
| Restart | `sudo systemctl restart lively-gateway` | `launchctl kickstart -k gui/$(id -u)/io.lvly.lively` |
| Apply code | `bash deploy/update.sh` (on a source checkout, `npm run build && sudo systemctl restart …` also works) | `bash deploy/update.sh` (on a source checkout, `scripts/restart-gateway.sh`) |
| store | `docker compose ps` · `docker compose logs items-db` | Same |

**Backups (important):** all of the organization's knowledge lives in the `items-db-data` volume.
`docker compose exec -T items-db pg_dump -U lively items > backup.sql` (+ domainmap). On EC2, take EBS snapshots as well.

## Security notes

- store (pgvector) binds to `127.0.0.1` — not exposed externally.
- **TLS:** with `LIVELY_DOMAIN` set, Caddy provides automatic HTTPS (see [TLS](#tls-automatic-https--caddy) above) — recommended for a public service. If unset (direct IP), restrict :8080 to trusted IPs with the SG/firewall.
- `.env` (secrets) is 0600 and listed in `.gitignore`. Static tokens can't get admin/runtime (kill switch) — people are managed through session login.

## Later (TODO)

- Option 1 (split out the runner → containerize the gateway), air-gapped offline bundle.
