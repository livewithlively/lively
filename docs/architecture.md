# Lively

*[한국어](architecture.ko.md)*

Lively's **unified context store** — a single in-house **MCP gateway** that every local AI tool (Claude Code · Codex · OpenCode · Antigravity CLI · Grok Build …) connects to.
It exposes organizational knowledge (WIKI) · taxonomy (category) · projects/tasks · domain context · DB (read-only)
in one place, governed by **per-user authentication + scopes**. The gateway also runs the web UI · web terminal · collectors · scheduler.

```
Local CLIs ──(Streamable HTTP /mcp, Bearer)──▶ this gateway ──▶ knowledge (WIKI) · taxonomy/projects/tasks · context · DB (read-only)
                                                   └ single boundary for auth · scopes · audit
```

> If only local CLIs and in-house browsers connect, **no public exposure is needed.** An intranet URL is enough.
> (Connecting external chat surfaces such as claude.ai or ChatGPT via OAuth requires a public address they can reach.)
> Note, however, that model inference goes to an LLM cloud, so **tool results (code, DB data) are sent out as context** —
> if compliance applies, consider PII masking or a self-hosted model.

## Structure

| Area | File | Notes |
|---|---|---|
| Entry point | `src/index.ts` · `src/boot/mcp-transport.ts` | Express + Streamable HTTP + bearer auth |
| Server assembly | `src/server.ts` · `src/mcp/dynamic-tools.ts` | Registers the capability layer — the MCP surface is auto-registered from `expose.mcp:true` capabilities (single SoT — no hard-coded count; the actual set is decided by `buildToolCandidates`/`isToolExposed` in `src/capabilities/index.ts`) + web-defined `org_tool` (http_proxy) **registered dynamically** on `/mcp` (SSRF guard) · built-in on/off gating |
| **Security boundary** | `src/context.ts` | `resolveUser → requireScope` — the first line of every tool |
| Auth | `src/auth/bearer.ts` | Static tokens (`AUTH_TOKENS_JSON`) + **DB tokens** (`auth_token`, sha256 · instant revoke · no restart needed). Tokens issued by the OAuth 2.1 authorization server (`src/org/auth/oauth-*.ts`, #1473) also land in the same `auth_token` and go through this verifier |
| **Capability layer** | `src/capabilities/*` | op = single definition of schema · scope · handler + selective exposure via `expose{mcp,rest}` — knowledge · categories · projects-v6 · task-v6 · activity · context · domainmap-curation · **delivery (web admin/delivery)** |
| **Delivery/admin** | `src/capabilities/delivery.ts` (+ `delivery/`) | The web `/ui` 'Admin' tab — org-content (enforced rules · context · WIKI index · members) · tokens · **custom hooks (`org_hook`) · AI tools (`org_tool`) · MCP servers · runtime settings**. admin/runtime scope · exposed over both REST (web) and MCP (agents) (#549 — revocable DB tokens only; every write is audited in `org_content_audit`). A per-item 'effect on members' meaning panel + auto-approve |
| **Org knowledge (WIKI)** | `src/capabilities/knowledge.ts` (+ `knowledge/`) | `knowledge_save`/`knowledge_grep`/`knowledge_search`/`knowledge_get`/`knowledge_list`/`knowledge_set_lifecycle`/`knowledge_set_wiki`/`knowledge_link_category`/`knowledge_delete` (trash · humans only) — the single `knowledge` table is the source of truth (SoT). New saves require one category + a type (page-type) (#290). See §SoT below |
| **Taxonomy (category)** | `src/capabilities/categories.ts` | `category_*` (create/update/get/list/delete · edge_*) — business · product · system taxonomy. **Product category = domain** (repo-independent, single `category` table) |
| Projects/tasks | `src/capabilities/projects-v6.ts` · `src/capabilities/task-*.ts` · `src/capabilities/activity.ts` | `project_*_v6`/`task_*_v6`/`activity_*` |
| Domain context | `src/capabilities/context.ts` | `context_overview`/`debt_list`/`repo_*`/`domainmap_proxy` — domainmap reads (direct reader functions) + repo management. (`all_domains` · `domain_list`/`domain_get` were **removed** — replaced by v6 `category_*`) |
| domainmap engine | `src/domainmap/` | Absorbed engine module — `db.ts` (re-export shim for the items DB pool — the real one is `src/db/client.ts`) · `core/` (reconcile · changelog · mappings · debts · domain-debt · refresh · refresh-fs · repos · scan-fs · schema) · `cli.ts` (host CLI) · `webhook.ts` (HMAC push-refresh) · `git-pull.ts` (scheduler polling refresh) (unified DB — `ITEMS_DATABASE_URL`) |
| DB | `src/tools/db.ts` | `db_sources` / `db_schema` / `db_query` — multiple data sources (`source` argument · registered in `org_db_source`), firewall · RLS · timeout · audit |
| DB safeguards | `src/db/firewall.ts` · `src/db/sources.ts` | Single SELECT only + blocks dangerous functions (`set_config`/`current_setting`, etc.) + denies sensitive tables (`auth_token` · `org_*`) · source registry |
| RLS example | `sql/rls-example.sql` | Read-only role + row policies |
| Client registration | `scripts/register-clients.sh` | Registers 4 clients |

> The old `memory_*` (retired 2026-06-24) · `ctx_*` (absorbed) · `search_items`/`get_item` · `propose_domain`/`domain_set_should` · old `pm_task_*` have all been merged into the `knowledge_*`/`category_*`/`task_*_v6` surfaces above. The `code_*` tools were cut.

## Code structure conventions (set by the #1313 structural refactoring campaign)

We split files that had grown to thousands of lines from features piled on top of each other, along clear axes. Know these three things before adding new code.

### ① Subsystem directories — where files live

| Directory | Responsibility |
|---|---|
| `src/capabilities/` | **Surface** — op (schema · scope · handler) definitions and `expose{mcp,rest}`. Subfolders (`knowledge/` · `delivery/`) split large surfaces |
| `src/v6/` | **Canonical store layer** — one file per entity + co-located tests. Its own conventions are in [`src/v6/README.md`](../src/v6/README.md) |
| `src/org/` | Org settings · delivery (rollout/onboarding) · credential vault · auth · collection policy stores |
| `src/db/` | The **generic** `db_query` stack (firewall · masking · source registry · access audit). It must not know the ontology — code that does lives only in `src/db/self/` |
| `src/domainmap/` | Domain map engine (`core/` + CLI + webhook + git polling. Shares the DB pool in `src/db/client.ts`) |
| `src/connectors/` | Collection connectors (Slack · Notion · GitHub … — registry in `index.ts`) + incremental sync runner (`run-sync.ts`) |
| `src/apps/` | App (agent · tool) package loader · installation · worker execution host (#1780) |
| `src/enterprise/` · `src/ee/` | The Enterprise boundary — `src/enterprise/` is the core-side hook registry and dynamic loader; `src/ee/` is the optional module (commercial license). The core never imports `src/ee/` statically |
| `src/node/` · `src/terminal/` · `src/sessions/` · `src/preview/` · `src/scheduler/` · `src/broker/` | Worker nodes · terminal · session logs · preview environments · cron · broker |
| `web/*.ts` (root) | One tab/screen module = one file |
| `web/lib/` | Framework-free **shared layer** (dom · net · format · markdown · state · overlay · avatar …). **Never imports a page** (machine-checked) |
| `web/v2/` | The new app shell (#1719) — left rail · sidebar · app instances · docked panes. Its root is `web/v2/main.ts` |
| `web/dash/` · `web/projects/` · `web/taskmodal/` · `web/editor/` · `web/terminal/` | Pieces of large screens split along their axes (home shell + widgets / board · detail parts / task modal sections / block editor / terminal parts). The same-named `web/<x>.ts` (for the dashboard, `web/dashboard-home.ts`; for the editor, `web/block-editor.ts`) is the barrel |
| `web/guide/` | The "User guide" app (#4179) — screen · body · diagrams |
| `web/standalone/` | Separate tsconfig — for classic `<script>` standalone pages. **Must not be mixed into the SPA bundle (`public/app`)** |

`public/app/` · `dist/` (+ standalone page bundles such as `public/terminal.js`) are **build outputs** — web outputs are kept out of git just like `dist/` (#2054), and `npm run build` produces them. Don't edit them by hand.

### ② The barrel pattern — keeping old import paths alive

When splitting a large file, we don't change dozens of consumers in one commit. Instead, **the original file name stays as a re-export-only barrel**
(`web/taskmodal.ts` · `web/admin.ts` are pure barrels, `web/core.ts` is a gate + barrel, `web/learn.ts` only for its UI-primitive part).

- **No logic in barrels.** The real code lives in modules whose names say what they do.
- **Don't add new symbols to barrels.** New consumers import directly from the real module — routing through a barrel creates
  **fake ownership** by passing through symbols whose ownership has already moved, and that was the main cause of circular imports.
- Barrels only **shrink**. When a barrel has zero consumers, delete the file.

### ③ Four resident gates — machines guard the structure

CI, not human eyes, catches refactors that quietly break something. If you touched the structure, run all four.

| Gate | Command | Accident it prevents |
|---|---|---|
| **Runner** | `node scripts/run-tests.mjs` | General unit regressions. Auto-discovered from source globs, so **adding a test = just creating the file** (no registration). Runs **in parallel (`-j`) and to the end even on failure**, collecting failures into one report at the end (#1431 — measured 121s→42s). Tiers and options: [`scripts/README.md`](../scripts/README.md) |
| **Surface snapshot** | `node dist/capabilities/surface-snapshot.test.js` | MCP/REST ops quietly disappearing, or schemas · paths · order changing, while files are moved and split. If this turns red in a refactoring commit, **that itself is the regression signal** — use `UPDATE_SURFACE_SNAPSHOT=1` only for intentional surface changes |
| **Boundaries** | `node scripts/check-imports.mjs` | New circular imports (known leftovers are listed with their owning item) · layer-violating edges (store→surface, store→express, generic db→ontology, `web/lib`→page) · new large files over 500 lines (warning) |
| **Bundle** | `npm run build` (built into `scripts/build-node-agent.mjs`) | DB-related modules newly landing in the worker node agent bundle — the '**no DB on nodes**' contract. There are two lists (#2165): approved `scripts/node-agent-allowed-modules.json` (what nodes actually use — a person decides and moves entries by hand) · debt `scripts/node-agent-known-debt.json` (what should come out — it only shrinks, and is re-frozen only via `UPDATE_NODE_AGENT_ALLOWLIST=1`). A module in neither list fails the build. `node scripts/node-agent-bundle-map.mjs` shows the edges to cut |

**A file's first lines (the header) are a contract.** It's the first place an AI reads, so if it's wrong, grep-based navigation goes astray entirely.
Write a one-line role + consumers + import-direction rules, and **when you move or split a file, fix its header too**
(good examples: the `web/wiki-*.ts` family). If a name doesn't match the role, rename the file.

## The source of truth (SoT) for org knowledge = the single `knowledge` table

The **only home** for **our knowledge** (decisions · designs · runbooks · curated notes) is **the v6 `knowledge` DB table**. Record the **full text** in-flow, right there, with `knowledge_save` — don't create new `.md` files in the repo or write file pointers. Injection · search · publishing · static fallback all come from **the single DB `knowledge` source**, and there is no runtime/boot path that reads a file tree as canonical. (For background and design, see the wiki: `knowledge_grep "context-os"` / `knowledge_grep "design-doc"`.)

- **`.md` files in the repo (root design docs · the former `research/*.md`) = retired from the knowledge SoT** — demoted to backups/generated output; new org knowledge goes into `knowledge`, not the repo.
- **External originals** (ClickUp · Notion · code) are owned externally → the gateway keeps them only as **mirrors (provenance=observed)**. Don't duplicate them; author only derived insights separately.
- The taxonomy is `category` (business · product · system) — **product category = domain** (repo-independent). `knowledge_link_category` links knowledge ↔ categories.

## Permission scopes (scope)

Single source of truth for allowed scopes: **`src/auth/scopes.ts`** (the types union · web `mw()` · token validation are all derived from it; `src/capabilities/scopes.ts` is a re-export shim). Scopes are granted to tokens/members and required by capabilities and MCP tools.

| scope | Meaning |
|---|---|
| `items` · `context` | Item lookup (legacy — now only a few ops such as the GitHub connection) · context (domain map · repos · taxonomy · teams) |
| `memory` | Org content — most surfaces, including knowledge · projects/tasks · sources. The default member scopes are `items` · `context` · `memory` |
| `db` (`db:<source>`) | `db_query`/`db_schema` (all sources or a specific source) |
| `admin` | Data/policy administration (sections · members · WIKI index · tokens · publishing) |
| `runtime` | **Defines what runs on member machines** — custom hooks · AI tools. Separate from admin (admin ⊉ runtime) |
| `code` | Code-work extras — preview environments · repo branches · stack profiles · broker runs |

- **Static tokens (`AUTH_TOKENS_JSON`) are refused for admin/runtime actions** (`DANGEROUS_SCOPES`) — no fleet code/policy changes with an unrevocable token (kill-switch). Only DB tokens (`auth_token`, instant revoke) can exercise admin rights.
- Web `mw()` treats unknown scopes as **fail-closed (403)** — this closes the hole where a missing branch lets a request "pass on authentication alone".

## Running

```bash
cp .env.example .env      # fill in tokens/DB
npm install
npm run build             # or: npm run dev
npm start
curl localhost:8080/healthz
```

For long-running (background) use, redirect **logs to `logs/gateway.log` (inside the repo, a durable location)**:

```bash
nohup node --env-file-if-exists=.env dist/index.js >> logs/gateway.log 2>&1 &
```

Don't redirect to `/tmp` — operational logs such as write audits vanish on reboot (per-op durable audit
is kept separately in the items DB audit table, but logs also belong in a durable location by default).

Docker: `docker compose up -d` starts only the store (items-db, pgvector) — the gateway runs natively on the host by default (`deploy/`).
To run the gateway in a container too: `docker compose --profile gateway up -d --build`

## Vector/hybrid search (optional — #172)

Knowledge search has two tools: **`knowledge_grep`** (exact text · regex matching, ripgrep-style — always works) + **`knowledge_search`** (semantic · natural-language **hybrid** — fuses vector embeddings ∪ lexical grep with **RRF** (`Σ 1/(rank+60)`)). It retrieves by meaning even when the words don't appear verbatim in the body.

**Off by default** — until embeddings are turned on, `knowledge_search` automatically falls back to grep (no downtime · backward compatible). Turning it on is opt-in:

```bash
# 1) .env: EMBEDDINGS_PROVIDER=http  (default sidecar = Ollama bge-m3, OpenAI-compatible /v1/embeddings)
# 2) Start the embeddings sidecar (+ automatic model pull)
docker compose --profile embeddings up -d
# 3) Backfill existing knowledge (later saves are embedded automatically on write)
npm run build && node --env-file-if-exists=.env scripts/backfill-embeddings.mjs
```

- **Requires pgvector** — the `vector` extension in the items DB (`ITEMS_DATABASE_URL`). At boot it idempotently creates `CREATE EXTENSION IF NOT EXISTS vector` + `knowledge.embedding_vector vector(N)` + an HNSW (cosine) index (if permissions or the extension are missing, it warns and uses **lexical fallback** — nothing breaks).
- **Inference seam = config-over-code (swap models freely).** provider/base_url/model/dimensions/auth_env are set in `org_runtime_config.embedding_config` (web · DB, no restart) or `.env` `EMBEDDINGS_*` (bootstrap seed) — the DB wins. **The contract is OpenAI-compatible `/v1/embeddings`**, so you can switch to OpenAI · local TEI/vLLM · a customer's own endpoint by changing only base_url. For secrets, `EMBEDDINGS_AUTH_ENV` = only the environment variable **name** (the value isn't stored).
- **Changing models:** change `EMBEDDINGS_MODEL` → `docker compose exec embeddings ollama pull <model>` → if the dimensions differ, also change `EMBEDDINGS_DIMENSIONS` and run `scripts/backfill-embeddings.mjs --all`. The default bge-m3 (1024d, multilingual) can be swapped losslessly for KURE-v1 (same 1024d → re-embedding only) for stronger Korean.
- To turn it off: `EMBEDDINGS_PROVIDER=off` (or org_runtime_config provider=off) → back to grep immediately.
- Korean morphological FTS (mecab-ko) and a reranker for the lexical channel are follow-ups (the lexical channel is currently ILIKE token-AND · regex, handling the exact-match half of RRF).

## How "control by permissions" is actually implemented (free-form SQL safeguards)

`db_query` accepts free-form SELECT, but makes it safe by pushing control down to the **DB layer**:

1. **Read-only replica + read-only role** — physically blocks DDL/DML (the connection URL of the registered source)
2. **Per-user RLS** — on every request the user is injected into the source's `rls` session variable (e.g. `app.current_user`) → the DB's RLS policies filter rows (`sql/rls-example.sql`)
3. **Query firewall** — single SELECT only, dangerous functions blocked (`src/db/firewall.ts`)
4. **`statement_timeout` + row limit** — protects against resource exhaustion (`.env`)
5. **Audit log of every query** (`src/db/audit.ts` — operational log lines. The durable access audit `db_access_log` is the `src/db/access-log.ts` contract + an Enterprise implementation)

> RLS = row filter, gateway = column masking (PII — Enterprise, `src/ee/db/mask.ts`). The firewall is a secondary line of defense;
> **the real permission boundary is the read-only role + RLS**.

> **Multiple data sources:** register several production DBs by name in `org_db_source` (the web Admin tab or `org_db_source_upsert`) and pick one with the
> `source` argument of `db_query`/`db_schema` (automatic registration from the `DATABASE_URL`/`DB_SOURCES_JSON` env vars was retired on 2026-06-23). If unspecified: the source named `default` → if exactly one source is registered, that one →
> if none are registered, the built-in `self` (admin only, the gateway's own items DB); otherwise it must be specified (list them with `db_sources`).
> Per-source `rls` GUC · `maxRows` · `timeoutMs` overrides — **a source without `rls` has no row-level isolation** (table-level isolation is the read-only role's job).
> Permission is scope `db` (all sources) or `db:<source>` (specific). Drivers are postgres · mysql (#715 — mysql has no RLS equivalent). (For the design, see the wiki: `knowledge_grep "멀티db 읽기"`)

## Client registration

```bash
STORE_URL=http://localhost:8080/mcp LIVELY_TOKEN=<your-token> ./scripts/register-clients.sh
```

## Version caveat

The `@modelcontextprotocol/sdk` APIs (`registerTool`, `StreamableHTTPServerTransport`,
the `requireBearerAuth` import path) can change with every minor version. If you get type errors after `npm i @modelcontextprotocol/sdk@latest`,
adjust those signatures to the installed version.
