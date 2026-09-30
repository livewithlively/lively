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

- Hook scripts = `kit/hooks/*.mjs`
- **Hook wiring table** (`hooks/hooks.json`) = `userLevelHooksBlock()` + `runnerHooksBlock()` from `kit/setup/user-install.mjs`, moved onto `${CLAUDE_PLUGIN_ROOT}` paths. When the canonical source changes, change this too (the build script doesn't touch the wiring table; it only checks reference integrity). `kit/hooks/settings-hooks.json` is the PROJECT-DIR template (for the published artifact's parallel "run from the bundle folder" path and `--install-hooks`), so it isn't canonical
- Organization skills = the gateway's `org_harness_assets` (edit centrally — local copies get overwritten by the next build)

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
