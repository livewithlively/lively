# scripts/ — operations and build scripts, and the test tiers

*[한국어](README.ko.md)*

## Six test tiers (#1313 R6 — what runs where)

| Tier | What | How to run | Prerequisites |
|---|---|---|---|
| ① Unit chain | `src/**/*.test.ts`(→dist) + `kit\|scripts\|deploy\|desktop/**/*.test.mjs` — [run-tests.mjs](./run-tests.mjs) **discovers them from source globs** (no registration needed) | `npm test` (includes the build · **parallel, keeps going after failures** → [execution policy](#runner-execution-policy-1431--run-to-completion--parallel)) · partial run `node scripts/run-tests.mjs <substring>` | None (no DB needed) |
| ② itest | `scripts/*.itest.mjs` — integration tests that need a real DB (schema init, session-log CAS, etc.) | `npm run test:itest` · single file `node --env-file-if-exists=.env scripts/<x>.itest.mjs` | `ITEMS_DATABASE_URL` (.env) |
| ③ integration/ | [scripts/integration/](./integration/) — manual e2e against a real PG and a real gateway (each file's header comment says how to run it) | Manual, per file | Varies by file (PG, a running gateway, secret keys) |
| ④ vis-e2e/ | [scripts/vis-e2e/](./vis-e2e/) — e2e for the visibility axes and UI wiring (has its own README) | See `vis-e2e/README.md` | A running gateway |
| ⑤ pg-test | `src/**/*.pg-test.mjs` — real-Postgres integration (excluded from the unit runner). Because the runner doesn't collect them, **each file only runs once it is registered as its own step in test.yml** (a missing registration is caught by `scripts/pg-test-registered.test.mjs`) | CI (test.yml) runs each registered file against a pgvector service · locally `ITEMS_DATABASE_URL=… node <file>` | A real PG (pgvector) |
| ⑥ Hook bash | [kit/hooks/test-hooks.sh](../kit/hooks/test-hooks.sh) — runner for the hooks' shell paths | `kit/hooks/test-hooks.sh` | None |

- ① is the default safety net — adding a test means **just creating the file** (do not register it in package.json; the runner discovers it).
- `*.itest.mjs` and `*.pg-test.mjs` are excluded from the runner's default collection (see the runner's header comment).

### Runner execution policy (#1431 — run to completion · parallel)
The old runner was **serial and stopped at the first failure**, so one failure hid the 100-odd files after it, and it used one core out of ten. Now:

- **Running to completion is the default** — after a failure it keeps running the remaining files and reports all failures together at the end. As before, the exit code propagates **the first failure's exit code**.
- **Parallel is the default** — default `-j min(cores, 8)`. Why this tier is safe to run in parallel: one file = one process · no real DB · every temp dir comes from `mkdtemp` · ports use `listen(0)` · HOME is sandboxed (guards: `src/ops/state-dir.test.ts`, `kit/cli/bootstrap-node-gate.test.mjs`).
- **The runner also runs the build** — `npm test` = `node scripts/run-tests.mjs --build`. The old `npm run build && …` used `&&`, so a single web tsc type error hid all 160 Node tests. Now the runner remembers the build failure, runs whatever tests can still run, and reports both (the build failure is reflected in the exit code).
- Missing build outputs follow the same principle — only the missing ones are recorded as failures and the rest still run (nothing is skipped silently).

| Option | Meaning |
|---|---|
| `<substring>…` | Only paths containing the substring (several = OR). **Zero matches is a failure** (exit 1) — so a typo can't become a false green |
| `-j N` / `--jobs=N` | Concurrency. `-j 1` streams child output as-is (for debugging a single file) |
| `--fail-fast` | Stop at the first failure (the old default) |
| `--verbose` | Also show the full output of passing files (parallel mode defaults to a one-line summary) |
| `--slowest[=N]` | Show the N slowest files at the end (default 10) — the lower bound on parallel wall time is **the single longest file**, so use this to find the culprit |
| `--list` / `--itest` / `--build` | Only list what was discovered / tier ② (real DB — always serial) / have the runner run the build too |
| `--scope=kit,desktop` | Collect only `*.test.mjs` in the given areas (skips the src→dist mapping). **The Windows CI job uses this to run the common runner** — that job does no `npm ci` or build, so collecting dist would make everything "missing output" |
| `--budget=N` | Per-file limit for unit tests (seconds). Exceeding it **fails even if the file passed**. Off by default — the CI Linux job turns it on with `--budget=45` |

### Per-file time budget (#2457 — 2026-08-31)

A unit file that exceeds the limit fails even if it passed. **Exceeding it means the file either isn't a unit test (→ move it to `*.itest.mjs`) or is waiting on something**, and the latter was a real incident:

> Without a DB address (`ITEMS_DATABASE_URL`), pg connects to **the libpq default, localhost:5432**. The CI unit job has no such env var, but `services.postgres` is alive on 5432, so six unit tests that don't use a DB waited **60 seconds per file** (60% of the 604 s of unit CPU). A Mac has no DB there, so the connection fails immediately with ECONNREFUSED → the same six took 1.8 s. **Run time was a function of that machine's port state.**
> Nobody noticed for four months for a simple reason — **nobody was measuring.** Now `src/db/client.ts` does not attempt a connection without an address (pinned by `src/db/no-db-socket.test.ts`), and this budget catches a recurrence the same day.

**Measured (2026-08-03, 10 cores · 160 files):** serial 121 s → `-j 8` 42 s. What held the wall time then was a single file, `kit/cli/project-status.test.mjs` (36.5 s = 30% of the total), because the harness probe in `lively status` called **the real `claude mcp list`** (hidden behind a stub bin, it takes 1.6 s). A unit test's run time must not depend on a person's local MCP setup — tests that launch the CLI should put **a stub bin at the front of PATH**, like `newHome` in `kit/cli/lively.test.mjs`.

## Main scripts
- `run-tests.mjs` — the unit chain runner (① and ② above). Parallel, run-to-completion, plus `--build` — options are in the [execution policy](#runner-execution-policy-1431--run-to-completion--parallel) above
- `build-node-agent.mjs` — esbuild bundle of the worker node agent
- `restart-gateway.sh` — build and restart the gateway on the live box (restarts only if the build succeeds)
- `restage.sh` — rebuild the `stage` branch (lay main down as the new base and re-merge the branches that were on it). **Don't do it by hand with `reset --hard`** — branches without a PR and commits made directly on stage silently disappear. This script checks for those and blocks, and leaves a backup tag
- `check-css-drops.mjs` — guard against dropped CSS selectors (#317)
- `register-*.mjs|sh` — one-off tools for registering clients/hooks
- `seed-notion-fixture.mjs` — seeds a connector fixture
- `archive/` — where finished one-off backfills and migrations (prefixed with the issue number) are moved (not present in the public repository yet). **Move new one-off scripts here once they're done.**
