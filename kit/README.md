# lively kit

*[한국어](README.ko.md)*

The **context/reflex harness kit** (org-agnostic) installed on teammates' machines. It injects your organization's context into the AI tool (harness) each person uses, installs the setup your organization shares (skills, subagents, commands, custom hooks), and sends work records back to the store. Its old name is `workflow-std`, and that name still appears in places across the code for compatibility, such as generated-file headers and config sentinel strings.
The generator takes organization content as *input* and builds that organization's install artifact. The kit itself contains nothing specific to any organization: each organization runs the same kit with its own organization content, without forking (design doc D1).

> **Delivery (2026-06-24 onward):** A Lively instance keeps organization content in the **gateway DB (wiki)** and has a single member install path: the gateway's **`/install` dynamic bundle** (the former `lively-org` and `context-setup` git repos are retired). Members get the `lively` CLI with the one-line installer (`curl -fsSL <gateway>/cli | sh`), and `lively install` downloads and installs the `/install` bundle. The gateway calls the generator's `buildKitBundle` **in-process** to build a bootstrap bundle (tar.gz) **with no organization content**; organization context is fetched live from the gateway once at install and again every session. The `--publish <dir>` git publishing CLI below is the **generic/portable path** (for other organizations that need file-based distribution).

> For the overall structure, lifecycle, and product strategy, see the wiki (knowledge): `knowledge_grep "architecture"` / `knowledge_grep "service-overview"`. How to write organization content is in **[ORG-CONTENT-GUIDE.md](ORG-CONTENT-GUIDE.md)** (versioned together with the code in this repo).

## Three folders (design doc D1)

| Folder | What | Owner |
|---|---|---|
| **Product** (this `kit/` directory, formerly `workflow-std`) | `lively` CLI + generator + shared hooks + harness adapters + setup + `template-org/` (init source for new organizations) | Lively (versioned, shared by all customers) |
| **Organization content** `<org>-org` (= input) | `org/`, `members/`, `memory/`, `gateway-url`. **For Lively, the gateway DB (wiki)**; a git repo for file-based distribution | Customer |
| **Published artifact** (install bundle) | The install artifact built from the two above. **For Lively, generated dynamically by `/install`** (not a git repo, bootstrap only with no organization content); for file-based distribution, `--publish <dir>` | Customer instance |

## Layout

```
kit/
├─ cli/                           # lively CLI (lively.mjs) + bootstrap (bootstrap.sh, bootstrap.ps1 — served by the gateway at /cli, /cli.ps1) + MCP stdio proxies
├─ generator/build-context.mjs   # Core: org-content input → assemble the published artifact + --init/--check
├─ hooks/                         # Shared hooks (harness-agnostic) — 5 wired hooks: session-preload · sync-harness-assets · work-flag · stop-writeback-gate
│                                 #   · run-custom (custom hook runner: fetches and runs org_hook from the gateway every session, never stored on disk, kill-switch)
│                                 #   + self-update (background self-updater) · usage-report (statusLine) · harness adapters (opencode-plugin.js · antigravity-adapter · grok-adapter)
│                                 #   + shared modules (harness-registry · host-effects-port) — the canonical install list is setup/kit-manifest.mjs
│                                 #   + settings-hooks.json (PROJECT-DIR template) · test-hooks.sh · examples/ (example org custom hooks)
├─ adapters/
│  ├─ claude/                     # Per-harness uninstaller (uninstall.mjs) + managed example · wiring doc
│  ├─ codex/                      # Same (the only canonical installer is setup/user-install.mjs — adapter installers were deleted in #1475)
│  └─ opencode/ · antigravity/ · grok/   # Per-harness uninstallers (uninstall.mjs)
├─ template-org/                  # One-time INIT source for new organization content (generic skeleton, nothing Lively-specific)
├─ setup/                         # Install engine (user-install.mjs), uninstallers + guides + vendored register-clients.sh
├─ aws/                           # AWS credential_process helper (issues short-lived AWS credentials from the gateway)
├─ testlib/                       # Test sandbox isolation helpers
└─ ORG-CONTENT-GUIDE.md           # How to write each organization content file + bootstrap checklist for a new organization
```

## CLI

```bash
# Publish (file-based — to a <publish-dir> such as a git repo. ※ Lively member installs go through the gateway's /install, so this step isn't needed)
node generator/build-context.mjs --org ../<org>-org --publish ../<publish-dir> --harness claude

# Also generate CLAUDE.md/AGENTS.md at the source repo root (convenience for running inside the source)
node generator/build-context.mjs --org ../<org>-org --publish ../<publish-dir> --emit-root

# Create a new organization content skeleton (copy template-org → a new independent repo)
node generator/build-context.mjs --init ../acme-org

# Check organization content (doctor) — differences from template-org and lint, read-only
node generator/build-context.mjs --check ../<org>-org

# Install hooks only (dogfooding)
node generator/build-context.mjs --org ../<org>-org --install-hooks <dir> [<dir>…]
```

| Flag | Meaning |
|---|---|
| `--org <dir>` | Organization content directory (required for publishing/installing hooks). Checks that `org/` exists. |
| `--publish <dir>` | Target for the published artifact. Idempotent (preserves .git and members/local.md, then reassembles). |
| `--harness claude\|codex\|opencode\|antigravity\|grok` | Harness settings to emit into the artifact (default claude). Multiple allowed, e.g. `claude,codex`. Harnesses other than claude have no artifact-specific files and are wired by the bundled user-install.mjs, so publish them together with claude. |
| `--org-name <name>` | Override the header display name (if omitted: the `org-name:` frontmatter in `org/org-defaults.md` → the first H1 → the directory name). |
| `--emit-root` | Also generate CLAUDE.md/AGENTS.md at the `--org` root (optional, dogfooding inside the source repo). |
| `--install-hooks <dir>…` | Non-destructively merge only the PROJECT-DIR hooks into each directory. |
| `--init <dir> [--force]` | Copy `template-org` → a new independent organization content repo (requires an empty directory, stamps `.template-version`). |
| `--check <dir>` | Doctor — missing-required/new-optional items versus template-org + lint (members email, managed-policy length, AGENTS 32KiB). Read-only. |

Override the canonical location of register-clients.sh with the `GATEWAY_DIR` env var (default: `../lively` next to the product (older installs fall back to `../context-ontology`); if neither exists, fall back to the vendored copy at `setup/register-clients.sh`).

## Evolving organization content (the template-org model)

`template-org` is only a **one-time INIT source** for a new organization, not a base that organization content extends or tracks. Once `--init` copies it, that repo belongs to the organization and stands alone (separate repo → zero git-pull conflicts). When a future product expects new fields: the generator is tolerant of missing fields/files (missing → default/skip), `--check` reports the differences, and `template-org/VERSION` + `CHANGELOG.md` let the organization opt in to only what it wants. For details, see the wiki (`knowledge_grep "architecture"`).

## Delivery = user-level hooks (design doc D2/D3)

The installer (`setup/user-install.mjs`, usually called by `lively install`) installs at the **user level** (`~/.lively/` + per-harness settings: `~/.claude/settings.json` · `~/.codex/config.toml` · OpenCode, Antigravity, and Grok settings) → members get context + reflexes whichever folder they start in. The working directory doesn't matter.

- **Context**: `session-preload` (SessionStart) fetches organization context (`/api/ui/org/preview`) and live status from the gateway and injects them. The fetched context is cached in `~/.lively/context.md` and used as a fallback in sessions that can't reach the gateway (seeded once at install).
- **Organization assets**: `sync-harness-assets` (SessionStart) downloads the skills, subagents, and commands registered on the gateway into each harness's location (members' own assets are never touched).
- **Reflexes**: work-flag (work/record signals + session phase reporting — PostToolUse, UserPromptSubmit, Notification, Stop, etc.) + stop-writeback-gate (Stop, a one-time write-back gate) + **run-custom** (runner — fetches and runs the custom hooks `org_hook` defined in the web admin from the gateway every session; enabled=false or removal takes effect from the next session = kill-switch).
- **Incognito**: `LIVELY_OFF=1` (alias of the old `LIVELY_HOOKS_OFF`) → every hook (including the runner, asset sync, and self-update) is a no-op (clean room).
- **Self-gating**: the write-back gate works only in 'lively work' sessions — when cwd is under a `~/.lively/work-roots` prefix OR the session has used a lively MCP tool.

## Multi-harness (design doc D5)

One shared set of hook scripts; only the settings files are emitted differently per harness. Supports Claude, Codex, OpenCode, Antigravity, and Grok Build (#1475, #1519, #1689, #1701) — per-harness differences are collected in one table, `hooks/harness-registry.mjs`. openclaw/pi are TODO.
