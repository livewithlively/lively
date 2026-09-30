---
name: clickup-sync
description: ClickUp ↔ v6 store sync (lossless read mirror + external_outbox outbound push). Space/Folder=project_folder, List=project_list, top-level Task=project, Subtask=task/subtask.
tools:
  - bash
env:
  - ITEMS_DATABASE_URL
  - CLICKUP_API_TOKEN
  - CLICKUP_TOKEN_SOURCE
  - CLICKUP_INCLUDE_LIST_IDS
  - CLICKUP_EXCLUDE_LIST_IDS
  - CLICKUP_CONTAINER_LIST_ID
trigger: on-demand + scheduler cron actions connector_sync·connector_push (§4 below)
---

# clickup-sync — ClickUp lossless mirror + outbound push
*[한국어](clickup-sync.ko.md)*

> **Model (v6).** The ClickUp hierarchy is migrated losslessly into the v6 PM tables: Space·Folder → `project_folder`, List → `project_list`
> (+`settings.statuses`), View → `project_view`, top-level Task → `project` (level='project'), Subtask → level='task',
> nested Subtask → level='subtask', comments → `task_comment`, time entries → `task_time_entry`
> (header comment of `src/v6/connector-mirror.ts`, `clickUpLevel` in `src/connectors/clickup/transform.ts`).
> **It is bidirectional.** Inbound, run-sync mirrors with a per-field 3-way merge; local edits (web/MCP) go through `external_outbox`
> and run-push applies them to ClickUp (§3). If both sides changed the same field, **our DB value wins** (`merge3` — our DB is the master).
> (The old phase B model — one list = a domainmap project `clickup-<listId>`, task = an item row, `item_project` declared mapping,
> ClickUp as the single master, the `pm_*` MCP tools — was retired in the 2026-06-24 v6 cutover.)

## 1. Running a sync (run-sync)

Configuration: the ClickUp collector in the admin tab, or `.env` (CONNECTOR_SPECS in `src/connectors/config.ts`). The token is `CLICKUP_API_TOKEN`
(personal token `pk_…`, `Authorization: <token>` — no Bearer prefix) or `CLICKUP_TOKEN_SOURCE`
(`org` = the org-wide `clickup_token` in the credential vault · `member:<member id>` = the token that member saved).

```bash
npm run build
# Incremental (cursor-based date_updated_gt — default). With no cursor, it automatically does a full backfill.
node --env-file-if-exists=.env dist/connectors/run-sync.js clickup
# Full re-backfill (every list + archived pass) — idempotent, so always safe.
node --env-file-if-exists=.env dist/connectors/run-sync.js clickup --full
```

Order within one run (`src/connectors/clickup/sync.ts`·`stream.ts`): hierarchy (Space→Folder→List→View — re-collected every run regardless of since) →
shallow task listing (incremental: team-level `date_updated_gt` + a per-list archived pass / full: per list, active+archived) →
per-task hydration (`getTaskFull` — markdown body·attachments·custom fields·subtasks, parents first) → per-task comments →
team time entries (incremental uses a 7-day margin) → idempotent `ingestItems` upsert (batches of 200) → `healPmMirror` (converges parents/lists/status keys) →
**the cursor advances only after everything succeeds** (`tasks_max_updated_ms` in `connector_state('clickup', <teamId>[:<collector instance>])`,
1-second epsilon re-poll — the upsert dedups).

- **A no-change re-sync is silent:** the mirror records an `org_content_audit` revision only when the body/title actually changed
  (a no-op re-sync just updates the row). Items are upserted by (system, instance, external_id), so there are no duplicates.
- **Automatic promotion for the first lossless migration:** if the cursor has no `lossless_full_done`, the run is promoted to full once even when incremental was requested
  (on a clean finish it records the flag so it never promotes again).
- **Rate budget:** per task, 1 hydration call + 1 comments call (+ hierarchy·list details·views·field definitions). The 100 req/min/token limit is
  absorbed by `clickupFetch` waiting pre-emptively on `X-RateLimit-Remaining=0` + retrying 429s per `retry-after` — a full backfill can take a long time
  in proportion to the number of tasks (a progress log every 120 s — keeps run-tracker's 15-minutes-without-output kill from firing).
- exit code: 1 if there was any stream exception·collection (fetch) failure·per-item mirror failure, otherwise 0.
  **A failed run never advances the cursor (enforced in code)** — the next run re-polls the same window and converges,
  and since the upsert is idempotent the re-poll costs nothing (no manual `--full`/cursor reset needed). Tasks whose hydration fails are skipped rather than
  falling back to the shallow response (prevents deleted attachments·downgraded bodies).
- **Tasks moved between lists converge automatically:** it follows subtasks revealed by hydration (including ones moved to other lists) and ingests them,
  and the upsert and `healPmMirror` update the parent/list coordinates.

## 2. Listing/exclusion rules

Space → lists in folders (active+archived passes) + folderless lists (active+archived passes) → filters applied:
`CLICKUP_INCLUDE_LIST_IDS` (when set, **only these lists** — allowlist) and `CLICKUP_EXCLUDE_LIST_IDS` (denylist). Both are set via the admin-tab
collector (`include_list_ids`·`exclude_list_ids` — pick from a list) or `.env` (comma-separated). The filters also apply to parents/moved subtasks
revealed by hydration, and with an allowlist scope only spaces/folders that contain an allowed list are migrated (prevents empty containers
from flowing in). Example: ClickUp's sample lists (Get Started with ClickUp / Project 1 / Project 2). **A new sample/noise list is synced until
it is added to the exclusion list** — the alternative is to archive the sample list in the ClickUp UI (the archived pass converges it to archived).

## 3. Outbound push (replaces the old pm_* write-through)

The old `pm_task_*` MCP tools (create·update_status·assign·comment·link·archive) were retired — task edits are handled by the
`task_*_v6`·`project_*_v6` surface ([docs/architecture.md](../docs/architecture.md)). The path to ClickUp:

- Local creates·updates·deletes (web/MCP) are queued in `external_outbox` (`src/v6/external-outbox.ts` — pending rows coalesce to one per entity,
  and inbound connector writes are not queued = loop prevention). Deletes are queued only for mirrored rows (ones with an external_id).
- Drain: `node --env-file-if-exists=.env dist/connectors/run-push.js clickup` (`src/connectors/clickup-push.ts`).

| op | Semantics |
|---|---|
| Create | project = top-level Task in the container List, task = Subtask (parent = the project Task), subtask = nested Subtask. `CLICKUP_CONTAINER_LIST_ID` (admin tab 'container list') is required — without it the row stays in error. If the parent is not pushed yet, the child is deferred to the next tick. Links back external_id/url after creation |
| Update | PUTs name·`markdown_description`·status·priority·start/due. status maps the canonical category → the space's status set; on a mismatch it retries once without status |
| Delete | **Hard-deletes** the ClickUp task (`DELETE /task/<id>` — already gone (404) counts as success) |

- Idempotent: the drain re-reads the current project row and upserts — running it twice converges to the same ClickUp state. Pushed values
  advance `external_base` (the common ancestor for the 3-way merge), so the next inbound picks out only external edits.
- Failed rows keep `attempts`·`last_error` and are retried on the next tick. exit 1 = there are failed rows.
- **Native** projects (born in Lively) in lists with restricted visibility are not exported (#1291). Rows that originated from the mirror are pushed as usual.

## 4. Schedule

Runs as scheduler cron actions (a verified CLI is run as a subprocess — no arbitrary shell):

- `connector_sync` (external→us) — params `system` (empty = every enabled collector)·`collector_id`·`full`. Runs are recorded as `connector_run`
  and can be observed on the web.
- `connector_push` (us→external) — `run-push.js clickup`.

For a one-off manual run, use the CLI above or `org_collector_sync_run`·`org_connector_sync_run`. If you need a loop inside a session:

```
/loop 10m node --env-file-if-exists=.env dist/connectors/run-sync.js clickup
```

Don't set the interval tighter than 2–3 minutes — the 100/min limit is shared per token.

## 5. Troubleshooting

- **`CLICKUP_API_TOKEN 미설정` (not set):** save an API Token in the admin-tab collector or set a token source (`org`/`member:<id>`), or use `.env`.
- **`ClickUp 워크스페이스 없음` (no workspace):** check the token's permissions.
- **`CLICKUP_CONTAINER_LIST_ID 미설정 — 아웃바운드 create 불가` (not set — outbound create impossible):** set the admin tab 'container list' (usually the same as the included list).
- **Local edits don't reach ClickUp:** check that the `connector_push` cron is enabled, and check the errors on pending rows:
  `SELECT id, entity_id, op, attempts, last_error FROM external_outbox WHERE system='clickup' AND done_at IS NULL;`
- **Out-of-band archiving (archived in the UI):** for both lists and tasks, the archived pass converges on the next run.
  Objects **hard-deleted** in ClickUp are not detected inbound (the mirror rows stay stale).
- **Tasks moved between lists:** converge automatically (§1).
- **Cursor reset:** `DELETE FROM connector_state WHERE system='clickup'`, then run-sync (= full backfill). Idempotent, so safe.
  To run a full pass just once, `--full` is simpler.

## 6. Verification procedure

1. `run-sync clickup --full` ×2 — on the second run the row count is unchanged (idempotent upsert), and with no body/title changes no
   `org_content_audit` revisions are added.
2. Edit a mirrored task on the web or via MCP (`task_update_v6`) → 1 pending row in `external_outbox` → `run-push clickup` →
   reflected in ClickUp, and `done_at` is recorded on that row.
3. `run-sync clickup` (incremental) → still one row for the same external_id, and the local edit's value is kept.

(The old procedure — replaying `pm_task_create`/`comment`/`update_status`/`archive`, leftovers from the 2026-06-11 verification task 86exxdbmd / item 612 —
can no longer be reproduced now that `pm_*` is retired.)
