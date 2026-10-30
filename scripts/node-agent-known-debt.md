# Node agent bundle — 5 remaining debts (#2165)

*[한국어](node-agent-known-debt.ko.md)*

`node-agent-known-debt.json` is a machine-read list, so it can't carry reasons. They are written here.
**It must only ever shrink** — `DEBT_CEILING` in `scripts/node-agent-bundle-boundary.test.mjs` is the ratchet.
`node scripts/node-agent-bundle-map.mjs` shows where to fix things, as boundary edges.

⚠ `await import()` does not get a module out — with a single outfile, esbuild inlines dynamic imports into the same bundle (measured).
 **You have to split the module (heavy side / light side) or invert the dependency** (`sessions/gateway-capabilities.ts`).

| Module | How it gets in | Why it isn't out yet |
|---|---|---|
| `sessions/session-outbox.js` | **Dynamic** import from `terminal/sessions.js` (1 place) | It stays even though the import is already dynamic — exactly the ⚠ above. It uses `itemsPool` directly (14 places), so splitting it means separating the queue store from the delivery logic. It never runs on a node (the gateway reads the queue and delivers). |
| `terminal/member-kit-seed.js` | `terminal/sessions.js` | The heavy dependencies (`org/store`, `org/delivery/publish`) have already been moved out into gateway capabilities. The module itself stays because the session-creation path calls it directly — on a node, `memberExecConfigured()` is false, so it returns immediately. |
| `gateway-url.js` | `terminal/sessions.js` | Pulls in only `org/store/profile` (the barrel is already cut). A node also needs to know the gateway address, so a full split is awkward — the next move is to have the cached value injected. |
| `org/tenant-context.js` | `v6/embedding-provider.js` · `org/store/members.js` (dynamic) | Pure (AsyncLocalStorage), so it doesn't touch the DB. On a node the context is always empty and it runs on defaults. It's a size/surface issue, not a contract violation. |
| `db/tenant-column.js` | `org/store/audit.js` · `org/store/members.js` | Pulls in `itemsPool`. First check whether the audit path is reachable on a node (if it isn't, cutting that edge is the end of it). But `org/store/members.js` also imports it directly (the boundary edge the map shows), so that edge has to be cut too. |

## Two approved ones that are easy to confuse

`sessions/session-desired.js` and `v6/execution-session-store.js` are in the `org/`·`v6/` namespaces, but
**they have an `onNode()` guard inside the module, so they are explicitly a no-op on a node** (#1791 design). That is design, not debt —
the namespace rule is a proxy for "does it touch the DB", not a goal in itself.
