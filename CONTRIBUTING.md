# Contributing to Lively

Thanks for taking the time. This document covers what you need to know before opening a pull
request.

## Contributor License Agreement

Every contributor signs a short CLA — see [CLA.md](CLA.md). A bot will prompt you on your first
pull request; signing is a single comment and takes a few seconds. We cannot merge unsigned
contributions.

The short version of *why*: the core is AGPL-3.0 and we also offer commercial terms to
organisations that cannot use AGPL. Doing that requires holding sufficient rights to the whole
codebase. See [LICENSING.md](LICENSING.md) for our commitments in return.

## Which license your change falls under

Determined entirely by directory:

- `kit/` → Apache-2.0
- `desktop/` → Apache-2.0 (same rule as `kit/` — it runs on members' own machines)
- `src/ee/` → Lively Enterprise License (commercial)
- everything else → AGPL-3.0-only

**Please do not move basic safety or core product value into `src/ee/`.** We have publicly
committed to keeping the free edition a complete, working product (see [LICENSING.md](LICENSING.md)).
The MCP surface snapshot test (`src/capabilities/surface-snapshot.test.ts`) fails if a core tool
disappears, so any change to that boundary needs a deliberate decision rather than a drive-by move.

New Enterprise features belong in `src/ee/`. If you are unsure which side a change belongs on,
open an issue first and we will help decide.

## Development

Requirements: Node.js 22.9+ (CI and the install script use Node 22; `npm start` and the test
runner rely on `--env-file-if-exists`), PostgreSQL with pgvector (for integration tests).
`engines.node` in `package.json` stays at `>=20` on purpose: it is the floor for the member CLI and hooks, and
`kit/cli/bootstrap-node-gate.test.mjs` (R6) keeps it equal to the CLI's `NODE_MIN_MAJOR`.

```bash
npm ci
npm run typecheck     # tsc across server, web, standalone
npm run build
npm test              # build + unit tier (other test tiers: scripts/README.md)
```

Before pushing, `npm run build` and `npm test` must both pass. This is not negotiable — the test
suite is the only thing standing between a refactor and a silent data-exposure regression.

### Verifying the core builds without Enterprise code

The AGPL core must remain independently buildable. If you touch the boundary
(`src/enterprise/`, or any shim that delegates to it), verify:

```bash
mv src/ee /tmp/ee-holdout
npm run typecheck     # must pass
mv /tmp/ee-holdout src/ee
```

The core must never statically import from `src/ee/`. The only permitted link is the dynamic
load in `src/enterprise/load.ts`.

## Code conventions

- TypeScript, ESM, `strict` mode. No `any` without a comment explaining why.
- Comments explain **why**, not what. Match the density and voice of surrounding code.
- Tests live next to the code as `*.test.ts` (or `*.test.mjs` under `kit/`, `scripts/`, `deploy/`,
  `desktop/`) and run without a test framework (`node:assert`). The runner discovers them
  automatically — see the test tiers in [scripts/README.md](scripts/README.md).
- Security-relevant defaults are fail-closed. If you add a policy, make the "policy configured but
  enforcement missing" case an error, not a silent pass.

## Pull requests

- One logical change per PR. Refactor and behaviour change in separate commits.
- Describe what breaks if your change is wrong — that is the most useful line in any PR.
- Link the issue if there is one.

## Reporting security issues

Please do **not** open a public issue for a security vulnerability. Use the private reporting
channel described in [SECURITY.md](SECURITY.md) so we can prepare a fix before disclosure.
