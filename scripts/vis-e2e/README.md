# Context visibility (#1291) real e2e — dual REST · MCP surface

*[한국어](README.ko.md)*

Visibility has one requirement: **it applies to a person and that person's AI at the same time.** The web UI uses REST and the AI uses MCP, so
the requirement is only verified by **hitting both surfaces side by side with the same identity and checking that they give the same answer**.
The unit test (`src/v6/visibility.test.ts`) and the SQL integration test (`src/v6/visibility.pg-test.mjs`) only look at the predicates —
the leak where a locked task was actually being shipped in responses was caught **only by this e2e**.

## Where it runs
The `pilot-box` EC2 (our test box). Connect through the dev Mac mini:

```sh
# On the dev Mac mini, the AWS [default] profile is SSO and can't be used non-interactively → override it by exporting static keys as env vars.
ssh lively@localhost
. ~/.lively-awsenv.sh                      # reads AWS_ACCESS_KEY_ID/SECRET from ~/.aws/credentials and exports them
aws ec2 describe-instances --filters Name=tag:Name,Values=pilot-box \
  --query 'Reservations[].Instances[].PublicIpAddress' --output text
ssh -i ~/.ssh/pilot-box ubuntu@<that IP>
```

## Procedure
1. `boot.sh` — creates two isolated DBs (`vis_e2e`, `vis_e2e_dm`) and starts this branch's gateway, inheriting the production `.env` but **overriding only the DB, port (8099), tokens and scheduler** (`cycle.sh` overrides the shared paths). It does not touch the live gateway (:8080) or the live DB.
2. `cycle.sh` — restart + seed + run. For repeated verification, this is all you need.
3. Baseline: `run.mjs` 34 · `run-v2.mjs` 30 · `run-ui-wire.mjs` 8 · `src/v6/visibility.pg-test.mjs` 30, all 0 failed.

## What each script checks
- `run.mjs` — v1: **non-targets can't see it** (lists, detail, search, tasks, files, sessions, timeline, on both REST and MCP).
- `run-v2.mjs` — v2: **even admin can't see the content**; instead the metadata is visible, and break-glass access with a stated reason opens it for a limited time. At the end comes the **trash** (deleting doesn't open it · restoring doesn't lift the lock) — it changes the seed state, so it always runs last.
- `run-ui-wire.mjs` — whether the paths the UI calls **are actually served**. Registering a route in code and that process answering on that path are two different things, so this is the most substantive UI check you can do without a browser. (The two modes of the shared-folder visibility modal, badge and modal; `settable=false` on project folders; team assignment; break-glass history.)
- `run-v3.mjs` — v3: whether the self source is restricted **per row** (v2 closed self entirely if anything at all was locked). Self stays open even when something is locked, locked rows don't appear in results, a non-target and a target get different answers to the same SQL, and nothing leaks through owner privileges.
- `run-v4.mjs` — v4: per-connector source visibility policy and inheritance by distilled knowledge. A lock with no target is rejected · a channel rule beats a connector rule · the backfill actually corrects past material · distilled knowledge inherits the source's targets (cites do not) · non-admins can't touch the policy.
- `run-axes.mjs` — axis toggles: checks with real responses, in a round trip, that turning a type on/off **actually lifts enforcement** (off = visible to everyone as before, on = locked again). It changes org-wide state, so it always restores the original state at the end.

## Pitfalls (things we actually ran into here)
- **Don't kill the gateway with `pkill -f`.** If the pattern doesn't match the actual command line, it fails silently, the old process keeps holding the port, and the new process dies with EADDRINUSE → **you test old code and believe it passed.** `cycle.sh` finds and kills the port's owner, and checks that the pid answering is the pid it just started.
- **Put wiring assertions first.** If a token gets 401, every "blocked" assertion passes (a vacuous test). `run.mjs` first checks via `/api/ui/me` that all three tokens are alive, and that a non-target actually receives the public projects.
- **You can't make an admin with a static token (`AUTH_TOKENS_JSON`)** — admin/runtime are deliberately stripped on load (because static tokens can't be revoked). So `seed.mjs` issues DB tokens directly into `auth_token` (effective permission = token ∩ member, so it sets the member scopes too).
- The release bundle doesn't include `mysql2`. This check doesn't use a mysql source, so it is replaced with a stub that "fails immediately if used" (better than passing silently).
- The shared workspace is owned by the production user, so `ubuntu` can't write to it → run against an e2e-only path (not a code problem).

## Cleanup
```sh
kill $(sudo ss -ltnp | awk '/:8099 /{match($0,/pid=([0-9]+)/,m); print m[1]}')
sudo docker exec context-ontology-items-db-1 psql -U lively -d postgres \
  -c 'DROP DATABASE IF EXISTS vis_e2e' -c 'DROP DATABASE IF EXISTS vis_e2e_dm'
rm -rf ~/vis-e2e
```

## If you added a new gate, watch it go red once
The trash gate **decided based on a field the store doesn't even return**, so it was a complete no-op — yet it passed the unit tests, one round of isolated review, and all three e2e scripts. Nobody had ever hit that path. A passing test proves nothing on its own — temporarily disable the compiled gate, **see the red with your own eyes**, then restore it:

```sh
node -e 'const fs=require("fs"),p="dist/capabilities/trash.js";let s=fs.readFileSync(p,"utf8");
  s=s.replace("async function filterVisibleDeleted(entries, viewer) {", "$&\n    return entries;");
  fs.writeFileSync(p,s)'
# restart → run-v2.mjs → confirm the relevant assertion FAILs → restore dist and restart
```
