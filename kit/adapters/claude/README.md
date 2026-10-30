# Claude harness wiring

*[한국어](README.ko.md)*

Emits the settings for the Claude Code harness. The main path is a **user-level install** (D2/D3): install once, and the organization's context + reflexes follow the member whichever folder they start `claude` in.

> **The canonical installer is `setup/user-install.mjs`.** The `install.mjs` that used to live in this folder was dead code nobody called, so it
> was deleted (#1475 — its existence actually caused an incident on the Codex side where "improvements went somewhere that isn't the real deployment").
> The uninstaller (`uninstall.mjs`) and the managed example remain here. The matching Codex doc is `../codex/README.md`.

## What gets installed (all idempotent)

| Output | Contents | Notes |
|---|---|---|
| `~/.lively/context.md` | Org context — seeded once at install from the gateway (`/api/ui/org/preview`), then refreshed every session by `session-preload` | **No tokens/secrets.** In sessions that can't reach the gateway, `session-preload` injects this cache at SessionStart |
| `~/.lively/hooks/*` | Copies of the hook runtime (chmod 755) — the canonical list is `HOOK_SCRIPTS` in `setup/kit-manifest.mjs` | Wired hooks session-preload · sync-harness-assets · work-flag · stop-writeback-gate · run-custom + files that aren't wired (self-update · usage-report · harness adapters · shared modules) |
| `~/.claude/settings.json` | Non-destructive merge of the **user-level** hook block (base hooks + a run-custom runner per event) + auto-approve (`permissions.allow`) reconcile | Backs up first (`~/.lively/backups/settings.json.bak`); keys other than hooks and `permissions.allow` are untouched (allow entries the member added are preserved). If `CLAUDE_CONFIG_DIR` is set, the settings.json inside it (per-profile account isolation, #346) |
| `~/.lively/work-roots` | Seed of self-gating work roots | Adds only missing entries, preserves existing ones |

MCP registration is **not done here** — on member machines the last step of `lively install` (`claude mcp add --scope user`) handles it, and in box provisioning `setup/register-clients.sh` (→ `mcp-register.mjs`, which writes `~/.claude.json` directly) does (to avoid duplicate registration).

## The decisive difference between user-level and project-dir (the biggest pitfall)

- **Project-dir template** (`hooks/settings-hooks.json`): command = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<script>.mjs"`.
  It goes into the published artifact (`<bundle>/.claude/`) and only works on the parallel "run from the bundle folder" path. `$CLAUDE_PROJECT_DIR` resolves to that bundle root.
- **User-level** (emitted by `setup/user-install.mjs`): command = `"<node>" "$HOME/.lively/hooks/<script>.mjs"` — an **absolute path**.
  `<node>` is the absolute path of the bundled runtime (`~/.lively/runtime/current/bin/node`) if present, otherwise `node` (#355). On Windows it is `node "<absolute path>"`.
  At user level `$CLAUDE_PROJECT_DIR` is undefined or resolves to the wrong repo (the one being worked in), so an absolute path is required.
  Because the command spelling can differ between install generations, the idempotency key is not the full command but the **script file name (+ args) + matcher** — older-spelling lively entries with the same key are replaced with the latest form on reinstall, leaving exactly one (`session-preload` also dedups by the same rule every session).

Other Stop hooks (e.g. tmux), env, permissions, enabledPlugins, and theme in `~/.claude/settings.json` are preserved.

## Managed enforcement layer (optional, D6)

`managed-settings.example.json` — for when you want to pin enforced rules through the home/managed path (regulated T3–T4). This layer can't be turned off even with incognito (`LIVELY_OFF`), so it's designed separately from "things you may want to turn off".

## Refreshing the static context

`context.md` is seeded once at install; after that, `session-preload` fetches organization context from the gateway every session, injects it, and refreshes this file (offline fallback cache) — edits in the admin web UI apply from the next session without reinstalling. Live status is also refreshed automatically every session.
