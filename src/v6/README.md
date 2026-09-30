# src/v6/ — canonical store layer (codified in #1313 R49)

*[한국어](README.ko.md)*

This directory's conventions are written down here, in one place. Read this before creating a new file.

## 1. What 'v6' means

It is **the current canonical data-access layer**. It is not version history —
**`src/v5/` never existed, and neither did v4 or earlier.** The schema generation name (v6 = the current `knowledge`/`project`/`task` schema)
simply became the directory name. There is no plan to "switch to v7 someday" either — this is the only store layer.

For the same reason, **don't add the `-v6` suffix to new files.** `src/capabilities/*-v6.ts` (projects-v6 · lists-v6 ·
task-detail-v6 …) and the `_v6` in MCP op names (`project_get_v6`, etc.) are **surfaces already exposed externally**, so they stay as they are,
but don't add the suffix to new capability or store file names. The suffix distinguishes nothing (everything is v6).

## 2. File layout

- **One file per entity.** `<entity>-store.ts` owns all DB access for that entity
  (`knowledge-store.ts` · `project-store.ts` · `task-field-store.ts` · `team-store.ts` …).
- **Tests are co-located.** The test for `x.ts` is `x.test.ts` in the same directory. The runner discovers them automatically from source globs,
  so **just create the file** (no registration — see the test tiers in `scripts/README.md`).
- **Ontology-agnostic stores use domain-prefixed file names.** This directory also holds stores unrelated to the knowledge ontology
  (dashboard preferences · sidebar preferences · favorites …). The name alone should reveal what it owns:
  `dash-pref-store.ts` · `side-pref-store.ts` · `knowledge-view-config-store.ts`.
  A generic name (`view-config-store.ts`) collides with neighboring files — it actually got confused with `view-store.ts` (saved project views)
  and was renamed in R49. **Where possible, use the same vocabulary as the REST path/table name in the file name.**

## 3. Layer rules (machine-checked — `scripts/check-imports.mjs`)

v6 is **the lowest layer**. Imports that go upward are forbidden:

| Forbidden | Why |
|---|---|
| `src/v6/** → src/capabilities/**` | A store must not know the MCP/REST surface (R9). `capabilities/rest-util.ts` (a re-export shim) is included here — the real `src/http/rest-util.ts` is covered by the next row |
| `src/v6/** → src/http/**` | No express layer (R9). If you need an HTTP error, use the leaf `src/http-error.ts` |
| `src/v6/schema/** → src/org/store**` | Schema init doesn't read org settings — it SELECTs directly (R19c) |
| `src/db/** (except self/) → src/v6/**` | The reverse direction is forbidden too. The generic db_query stack must not know the ontology (R48) |

Allowed downward dependencies: `src/db/client.ts` (pool · `q` · `one`) · inside `src/v6/` · `src/http-error.ts` · pure utilities.

## 4. Write audit

Content writes are recorded in `org_content_audit` via `auditOrgContent(...)` in `content-audit.ts`
(the caller specifies only the entity — don't copy-paste it into each store). Audit of data **access** (db_query) is not this layer's job;
it belongs to `src/db/access-log.ts`.
