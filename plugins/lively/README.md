# Lively plugin

*[한국어](README.ko.md)*

Connects your organization's **context store** (knowledge, projects, domain map) to AI sessions. Requires a Lively gateway.

## Install

```
/plugin marketplace add livewithlively/lively
/plugin install lively@lively
```

When you enable it, it asks for one thing: the **gateway address** (`https://lively.<company-domain>` or your managed workspace address; don't append `/mcp`). To change it, go to `/plugin` → `lively` → settings.

Then log in — no token copy-pasting; browser approval is all it takes.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/login.mjs"
```

The token is saved to `~/.lively/token` (0600), and the MCP headers and the hooks read **the same file**.

To get a newer version: `/plugin marketplace update lively`, then `/reload-plugins` (or start a new session). Background auto-update is off for third-party marketplaces unless you turn it on.

> **Why the token isn't taken via `userConfig`** — values marked `sensitive: true` **are not passed to the hook process env** (observed on a real device on 2026-08-04; this differs from the official docs' "All values are exported to hook processes"). If the token were taken as a setting, MCP would connect, but organization context injection, skill distribution, governance hooks, and status reporting would all fail to authenticate. So the token has a single source, the file, and MCP reads that file through `headersHelper`.

## What's inside

| Component | What it does |
|---|---|
| **MCP server** | Exposes the gateway's knowledge, project, domain map, and DB tools to the session |
| **SessionStart hooks** | At session start, injects organization context (categories, WIKI index, persona, your identity) and downloads the organization skills and subagents registered on the gateway |
| **Phase reporting hook** | Lightly reports session state so the gateway knows "working / needs confirmation / idle" without screen scraping |
| **Record gate hook** | When a session ends, gates it so that context worth keeping gets recorded |
| **Skill bundle** | Lively operations skills such as onboarding, taxonomy setup, pipeline audit, and project closeout |

If **organization-specific skills** are registered on the gateway, they're added automatically after the first session — separately from this bundle.

## ⚠ Don't use it together with the kit

There are two install paths, and you use **only one**.

- **Plugin** (this repo) — installed from the marketplace. Hook and MCP wiring live inside the plugin.
- **Kit** — `curl -fsSL <gateway>/cli | sh`. Installs hooks into `~/.lively/hooks/` and non-destructively merges `~/.claude/settings.json`.

If you install both, the same hooks run twice. If you've already installed the kit, you don't need this plugin.

## Maintenance (for contributors to this repo)

The things the plugin contains **have their source of truth elsewhere.**

- Hook scripts = `kit/hooks/*.mjs`, plus the modules those hooks import (`harness-registry.mjs`, `host-effects-port.mjs`) and the shared module outside `hooks/` (`kit/setup/host-effects.mjs` → `lib/host-effects.mjs`, the same place as in the installed tree)
- **Hook wiring table** (`hooks/hooks.json`) = **generated** from `userLevelHooksBlock()` + `runnerHooksBlock()` in `kit/setup/user-install.mjs`, with the paths moved onto `${CLAUDE_PLUGIN_ROOT}`. Don't edit it by hand. `kit/hooks/settings-hooks.json` is the PROJECT-DIR template (for the published artifact's parallel "run from the bundle folder" path and `--install-hooks`), so it isn't canonical
- Organization skills = the gateway's `org_harness_assets` (edit centrally — local copies get overwritten by the next build)

After changing anything under `kit/hooks/` or the wiring in `user-install.mjs`, run `node scripts/build-plugin.mjs` and commit the result. `scripts/build-plugin.test.mjs` fails CI if the copies differ from `kit/`, if `hooks.json` differs from the generated one, or if a hook imports a file that isn't in the plugin tree (that last one would make every hook die with `ERR_MODULE_NOT_FOUND` on install).

**Don't set `version`** in `.claude-plugin/plugin.json` or in the marketplace entry. A pinned version keeps every installed user on the cached copy until someone changes the string ("a manifest that pins `version` … keeps every user on the cached copy until its author changes the string" — [Claude Code docs](https://code.claude.com/docs/en/plugins/loading)). Without it, the version is the commit SHA of the plugin directory, so every commit that touches `plugins/lively` reaches users on update. `claude plugin validate --strict` warns about the missing version — that warning is expected. Don't record a version or content hash in a repo file either: two PRs that change hooks would both edit the same lines and always conflict. It was pinned at `0.1.0` from 2026-08-04 to 2026-09-30, so installs from that period never received a later change.

`run-custom` is one fixed entry per event, and the runner fetches the custom hooks themselves from the gateway at runtime — when the organization adds or removes hooks, the wiring table doesn't need rewriting, and disabling a hook takes effect immediately from the next session (kill-switch).

> ⚠ **Don't create a `bin/` directory at the plugin root** (observed 2026-08-04). The claude.ai marketplace sync rejects plugins that have `bin/` — regardless of contents or file modes; even a single plain .txt inside gets rejected. `scripts/` and `hooks/` are fine, so scripts go in `scripts/`. Local `claude plugin validate --strict`, the public JSON schema, and CLI remote install all pass, so this trap only shows up on the web. Details: WIKI `claude-marketplace-sync-rejects-bin-dir`
>
> Comment keys (`_comment`, etc.) have been confirmed harmless (the official hook files also put a `description` next to `hooks`), but it reads better for this document to carry the comments instead.

The build script does the copying.

```
node scripts/build-plugin.mjs            # hooks only
node scripts/build-plugin.mjs --skills   # skills too (requires a gateway token)
```

The list of bundled skills is set by `bundled-skills.json` — the reasons for exclusions are written in that file too.
