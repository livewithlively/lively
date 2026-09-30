# Secrets manager runbook — a formal model of the secrets boundary (P8)
*[한국어](secrets.ko.md)*

> **Product principle (one sentence):** secrets *never go into any content*. Connection/provider auth is
> stored only as an **environment variable name reference** (auth_env/auth_ref), and the value lives in an external secrets manager (`.env`/1Password/
> Doppler/SOPS). Product data access is separated by **per-member DB roles** (db_query RLS).
> *Extension (#541·#746):* connector and member credentials entered through the admin tab or credential vault are stored in the DB **only as ciphertext** (no plaintext — see the credential vault under (b)).

This document formalizes the code choke-points that enforce the principle above, the procedure for adding a secret safely, and the rotation procedure after a leak.
Related auth planes: db-multi-source (`research/2026-06-16-멀티db읽기-설계.md` — internal design note, not in this repo),
embedding provider auth (`src/v6/embedding-provider.ts`).

---

## (a) No-secrets principle + enforcing choke-points

Plaintext secrets never go into content (free-text bodies written by agents and people). Enforcement is a
**hard block at the storage boundary** (not a warning) — the two functions in `src/org/ingest/redact.ts` are the single source of patterns.

| Function | Role | Behavior |
|---|---|---|
| `assertNoHardSecrets(text, field, hint?)` | **Rejects storing** high-risk plaintext secrets | Throws `HttpError(400)` on a pattern match — nothing is stored |
| `redactDeep(v)` / `redactString` | **Masks** audit logs and HTTP responses | Replaces matched strings with `[REDACTED]` (storage is allowed, but plaintext copies are blocked) |

`assertNoHardSecrets` hard-block patterns (as of 2026-09-30, #4501): Anthropic (`sk-ant-`), OpenAI (`sk-` — not when it starts
inside a word, same rule as masking), GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`)·PAT (`github_pat_`), Slack (`xox[abprs]-`),
AWS (`AKIA…`), Lively token (`lvk_`), private key (`BEGIN … PRIVATE KEY`). `redactDeep`/`redactString` mask more broadly, adding
JWT·`Bearer <literal>` (`TOKEN_SHAPE_RES`·`PROSE_RISKY_RES`).

### Choke-point coverage (content write paths)

| Write path | Input | assertNoHardSecrets | Location |
|---|---|---|---|
| ~~`ctx_save`~~ (retired — merged into `knowledge_*`) | `note` | — | Old `src/capabilities/ctx.ts` (deleted). Its successor `knowledge_save` is in the v6 row below |
| `org_update_section` (MCP·REST) | `body_md` | ✓ (P8) | `src/capabilities/delivery/org-content.ts` |
| `org_member_upsert` (MCP·REST/admin) | `body_md` (personal layer) | ✓ (P8) | `src/capabilities/delivery/members.ts` |
| Self writes (`me_profile_update`·`me_onboarding_set`·`me_liv_profile_set`·`me_welcome_*`) | Personal-layer `body_md`·notes·profile·onboarding answers | ✓ | `src/capabilities/delivery/me-self.ts`·`liv.ts`·`welcome.ts` |
| ~~`propose_domain`·`dm_domain_edit`~~ (retired 2026-06-24 — replaced by `category_*`) | `description`·`evidence` | — | Successors `category_*` are in the v6 row below |
| v6 content writes — `knowledge_save`·`knowledge_set_title`·`category_create`/`category_update`/`category_group_upsert`·`project_create_v6`/`project_update_v6`/`project_rename_v6`·`task_create_v6`/`task_update_v6`·`task_checklist_v6`·`task_comment_v6`·`project_list_create_v6`/`project_list_update_v6`·`task_field_value_set_v6` (MCP·REST) | **Every string** in the input (nested included). Fields holding old text (`edits[].old`·`description_base`) are skipped so an edit that removes a secret isn't blocked | ✓ (#4501, 2026-09-30) | `assertNoContentSecrets` in `src/capabilities/content-secrets.ts`, first line of each handler |
| First prompt → auto-created draft project | name·body | Masked (`redactTokenShapes`) — blocking would leave the session without a workspace | `src/project/first-prompt-project.ts` |
| `org_hook_upsert` (MCP·REST/runtime) | `source_code` | ✓ | `src/capabilities/delivery/hooks.ts` |
| `org_harness_asset_upsert`·`me_harness_asset_draft` | description·body·frontmatter | ✓ | `src/capabilities/delivery/harness-assets.ts`·`me-self.ts` |
| ~~`migrate-content.mjs`~~ (script — since removed from the repo) | `body_md` | ✓ (direct call) | Old `scripts/migrate-content.mjs` |
| Audit before/after | Org admin entities (`src/org/store/*`) | redactDeep | `src/org/store/audit.ts` — v6 knowledge/category/project audits (`src/v6/content-audit.ts auditOrgContent`) are not masked |
| Connector mirror ingest | title/body/fields/raw | redactString·redactDeep | `src/v6/mirror/*` |
| http_proxy response body | dynamic-tools res.body | redactDeep | `src/mcp/dynamic-tools.ts` |

**Design decision — the guard lives in the capability (adapter) layer, not the data layer (`upsertKnowledge`).** Putting
an indiscriminate `assertNoHardSecrets` in the data layer could break seeds/migrations/legitimate content, and the migration (`source=
'migration'`) calls `upsertKnowledge` directly and so bypasses the adapter guard — which is why the migration asserted explicitly
on its own path (same pattern, same single source — that script has since been removed). The guard was added only to free-text paths with low false-positive risk (where legitimate
content rarely contains token-shaped strings).

### Unguarded (advisory only) paths

- **debt_finding.detail** — there is no user write capability. It is machine output filled by code analysis in the domainmap refresh/ingest pipeline
  (`reconcile.ts`→`upsertDebt`), and `dm_debt_status` only changes status.
  Code analysis can quote token-shaped strings from a repo (false positives), so the pipeline is not blocked indiscriminately.
  → Advice: don't keep plaintext secrets in the refresh input (the analyzed repo) (source secret hygiene is a separate responsibility).
- **Direct calls to the data layer `upsertKnowledge`/`upsertMember`** — seed/migration/test paths. The adapter guard is
  enough, and direct callers are responsible for asserting on their own path (the migration set the precedent).
- **v6 audit records (v6 before/after in `org_content_audit`)** — not masked. After the entry-point block (#4501) new writes don't
  bring in hard secrets, but bodies stored before it and masking-only patterns (JWT·Bearer and others outside the hard-block list) can remain
  in audit copies. Detect with the (f) scan; remove with step 3 of the (e) rotation.

---

## (b) Connection/provider secrets = env name references (values not stored in the DB)

External system auth stores **the environment variable 'name', not the secret value**, and resolves it from `process.env`
at runtime. On this path the value never settles in the DB, code, or content (for the ciphertext storage path, see the credential vault below).

| Target | Stored field | Stored content | Runtime resolution | Allowlist |
|---|---|---|---|---|
| DB source (`org_db_source`) | `auth_ref` | env **name** (e.g. `PROD_DB_PW`) | `resolveConnectionString` → `process.env[auth_ref]` | `allowed_db_secret_refs` (deny-all by default) |
| MCP server (`org_mcp_server`, client mode) | `auth_env` | env **name** | register-clients/session hooks, from the env on the member's machine | Name format check (`^[A-Za-z_][A-Za-z0-9_]*$`) |
| http_proxy tool (`org_tool`) | `auth_env` | env **name** | dynamic-tools at call time `process.env[auth_env]` → Bearer | `allowed_auth_envs` (deny-all by default) |
| Embedding provider | `embedding_config.auth_env_ref` (runtime setting — seed env `EMBEDDINGS_AUTH_ENV`) | env **name** | `src/v6/embedding-provider.ts` sends that env's value as Bearer | Name format check |

Enforcing guards (all present at the code locations in the table above):
- **Name format check** — only `^[A-Za-z_][A-Za-z0-9_]*$` passes (format-level block against putting a secret value in the name field).
- **Allowlist** — `auth_ref`/`auth_env` can only be referenced after being registered in the runtime setting's allowlist
  (`isSecretRefAllowed`, `allowed_auth_envs`). Blocks arbitrary references to infrastructure secrets (`ITEMS_DATABASE_URL`, etc.).
- **Inline password block in URLs** — `org_db_source.url` only accepts connection strings without a password. `assertNoHardSecrets(url)` +
  a pg parser check (`inspectConnString`: including bypasses via the `?password=`/`?hostaddr=` query parameters) — `src/db/source-guard.ts`.
- **Response masking** — DB source list responses expose only the host instead of the raw url (`maskDbSource`), and auth_ref only as a name.

Where values actually live: the gateway `.env` (gitignored), or injected into `.env`/the process env from an external manager (1Password/Doppler/SOPS).
**Never commit or print `.env`** (gitignore + `*.sw?`/`*~` ignored).

### Credential vault — ciphertext storage path (#541·#746)

For deployments where editing `.env` is impractical (SSM-only boxes, etc.), credentials entered through the admin tab or MCP are stored in the DB **only as ciphertext**:
connector tokens (`org_connector`), gateway-wide and per-member credentials (`org_credential_set`·`me_credential_set` → `member_secret`),
and git credentials. Encryption is `src/org/credentials/secret-box.ts` (AES-256-GCM, master key env `CONNECTOR_SECRET_KEY` —
if unset, vault storage is disabled and only the env fallback works).
- Values never go out in responses (only the `has_secret` flag·meta). `member_secret`·`git_credential` are db_query denied tables ((c)).
- `org_tool`·`org_mcp_server` can reference auth via `auth_kind` (a vault kind — the requester's personal credential first, with a conditional fallback to the gateway-wide credential) instead of `auth_env`.
  The two are mutually exclusive (one auth source only).
- ⚠ If the master key is lost or changed, existing ciphertext cannot be decrypted (re-entry required) — keep the key together with the `.env` volume.

---

## (c) Product DB access = per-member DB roles (db_query RLS)

The gateway does not proxy production DB access through an all-powerful account — access is separated into **per-member DB roles** and rows are
restricted with RLS.

- `db_query`/`db_schema` connect directly to pg through the registered source from the gateway (the same outbound surface as http_proxy).
- Auth is `auth_mode` (only `password` for now; placeholders for iam/mtls/vault) + `auth_ref` (env name) — the (b) plane above.
- **RLS GUC injection** — the gateway injects GUCs such as `app.current_user` into the session, and the firewall blocks
  `set_config`/`current_setting` calls that would overwrite them inside a SELECT (regex + AST, including CTEs·subqueries) —
  `src/db/firewall.ts`. The member token's identity becomes the input to RLS policies, enforcing per-member visibility.
- **SSRF/rebinding block** — the host is pinned to a public IP (`pinHost`), and private/metadata ranges are rejected.
- **Meta-table block** — `DENIED_TABLES` (auth_token·org_content_audit·org_hook·org_tool·org_mcp_server·
  org_db_source·member_secret·git_credential, etc.) SELECTs are blocked — so secret-reference, audit, and auth tables cannot be read via db_query.

---

## (d) Procedure for safely adding a new connection/provider secret

The standard order for adding one without putting the value in content/DB/code:

1. **Keep the value outside.** Add `MY_API_TOKEN=…` to the gateway `.env` (or inject it from an external manager).
   `.env` is gitignored — leave the value nowhere in commits, logs, or PRs.
   (If you use the credential vault: store the credential with `org_credential_set`/`me_credential_set` and reference it with `auth_kind` in step 3 — step 2 is not needed.)
2. **Register the name in the allowlist.** In the web runtime settings (`org_runtime_update`):
   - http_proxy/MCP auth → add `MY_API_TOKEN` to `allowed_auth_envs`.
   - DB source password → add it to `allowed_db_secret_refs`.
   (If not registered, the next step is rejected with a 400 "not in the allowlist" — deny-all by default.)
3. **Reference the connection by name.** In the relevant CRUD (`org_mcp_upsert`/`org_tool_upsert`/`org_db_source_upsert`), put the
   **name** (`MY_API_TOKEN`) in the `auth_env`/`auth_ref` field. If you put the value there, the format check/`assertNoHardSecrets`
   blocks it.
4. **Verify.** `node --env-file=.env scripts/scan-content-secrets.mjs` — confirm 0 hits in the content store ((f) below).
   If the value leaked into content somewhere, it is caught here.

Anything that runs on a member's machine (client-mode MCP servers) needs that env to exist **on the member's machine** — the install bundle/
the member's own `.env`. The gateway only distributes the name. Anything that runs on the gateway resolves there — http_proxy tools from the
gateway env (or the vault via `auth_kind`), proxy-mode MCP servers via the vault (`auth_kind`)·OAuth·SigV4.

---

## (e) Rotation procedure after a leak

If there are signs (or a scan hit) that a plaintext secret got into content/logs/storage:

1. **Invalidate immediately (rotate at source).** Revoke and reissue the key at the issuer (OpenAI/GitHub/Slack/AWS/DB).
   For a Lively token (`lvk_`), use `org_token_revoke` — pass as the handle the `tokenHash` from the `org_token_mint` response or the
   `token_hash` from `org_tokens` as is (a prefix of 12+ characters also works if it is unique). No gateway restart needed.
   ⚠ **Read the response** (#2646): only `revoked:true` means this call killed it. `revoked:false` (= it was already revoked) or
   404 (= no such token) **means you need to look at a different token** — previously all three returned `{ok:true}`, so believing it was revoked
   and walking away left a live token behind (observed 2026-09-04). In leak response, the surest check is to hit the API once with that plaintext token
   after revoking and **see the 401 with your own eyes**.
2. **Inject the new value outside.** Put the new value in `.env`/the manager as in (d)1. **The name can stay the same** (since the reference is an env name,
   changing only the value makes the runtime resolve the new value — DB sources pick it up without a restart via pool recycling).
3. **Remove it from content/logs.** If the plaintext got into a content body: edit the affected knowledge/section/member/category
   (for section/member, `assertNoHardSecrets` blocks re-saving, so clean it before saving). The audit log (`org_content_audit`) is
   append-only — audits of org admin entities are already masked by redactDeep (if a pattern slipped through, strengthen the patterns in redact.ts),
   but v6 knowledge/category/project audits (`auditOrgContent`) are not masked, so plaintext copies may remain.
4. **Confirm with a scan.** Re-confirm 0 hits with `scripts/scan-content-secrets.mjs`.
5. **Prevent recurrence.** Trace which write path it leaked through (audit actor/source) → if that path lacks a choke-point, add one
   (update the (a) table); if the secret pattern was not in the hard-block list, strengthen `HARD_LABELS`/`TOKEN_SHAPE_RES`·`PROSE_RISKY_RES`.

---

## (f) Continuous verification — content store secret scan

```
node --env-file=.env scripts/scan-content-secrets.mjs      # from the gateway app directory (needs the dist build)
```

- Targets: the items DB (single DB — the domain map tables live there too): `knowledge` name/title/body_md/summary,
  `category` name/description/should, `org_member` display_name/email/body_md/identities, `debt_finding` title/detail,
  `project` (projects·tasks) name/description, `task_comment` body, `task_checklist_item` name.
  The list is `SCAN_TARGETS` in the script; `scripts/scan-content-secrets.test.mjs` checks it against the schema definitions.
- Applies `assertNoHardSecrets` + `redactDeep` (single source in redact.ts) to everything. **Values are never printed** — only the location (table/PK/
  column) and the pattern label (hard/masked) are reported.
- hit ≥ 1 → `exit 1` (CI candidate). If `ITEMS_DATABASE_URL` is unset, or a target table doesn't exist, that part is skipped (reported only, not a failure).
- No runtime impact (standalone) — the MCP surface is unchanged.
