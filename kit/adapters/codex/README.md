# Codex harness wiring

*[한국어](README.ko.md)*

> **The canonical installer is `setup/user-install.mjs --harness codex`.** This folder used to have a sibling installer, `install.mjs`, but
> it was **dead code nobody called**, and improvements that went into it never reached the real deployment (#1475, observed:
> #1221 session phase reporting went only into the adapter and never reached users). So it was deleted — when you change the wiring,
> change **only** `codexManagedBlock()` in `setup/user-install.mjs`. The uninstaller (`uninstall.mjs`) remains here.
> The spec is pinned by `setup/codex-wiring.test.mjs` (which enforces parity with the claude wiring in code).

## What gets installed (all idempotent · sentinel surgical merge)

The shared assets `~/.lively/{context.md, org-name, hooks/*.mjs, work-roots, bin/lively, lib/*}` are **the same ones** claude uses.
There are two Codex-specific settings surfaces (in addition, a `LIVELY_TOKEN` export sentinel block is planted in the shell rc — for `bearer_token_env_var` on the direct-http fallback, with no token literal).

### `~/.codex/AGENTS.md`
Static org context. Codex **loads it natively** as global instructions (`$CODEX_HOME/AGENTS.md`), so it always applies regardless of hook trust.
Merged as a sentinel block — the member's existing instructions are preserved (backups at `~/.lively/backups/codex-AGENTS.md.{orig,bak}`).

### `~/.codex/config.toml`
Only the part between `# >>> lively-managed … >>>` and `# <<< lively-managed <<<` is replaced. Everything outside it (model, `[projects.*]` trust, tui, other mcp_servers/hooks) is left byte-for-byte untouched.

**MCP — the default is a local stdio proxy:**
```toml
[mcp_servers.lively]
command = "/…/.lively/bin/lively"
args = ["mcp"]

[mcp_servers.lively.env]
LIVELY_HARNESS = "codex"
```
- Codex's `http_headers` are **static strings** and can't expand session env → over a direct http connection, `x-lively-session` (#852) and `x-lively-mode` (#1007 read-only/incognito) can **never be sent.** The proxy reads that env and attaches it upstream, so both features work in codex too.
- Even if the gateway is unreachable at boot, stdio is a local process, so it doesn't get stuck as failed for the whole session (#1079).
- The token never goes into the config file — the proxy reads `~/.lively/token` on every call (so even if `LIVELY_TOKEN` in the rc is stale, it won't silently connect as an old identity — the codex version of #916).
- **`env.LIVELY_HARNESS` is required.** Through the proxy the UA is ours, so this stamp is the entire harness signal (without it the gateway counts codex sessions as claude — #182).
- If the proxy file is missing (older bundle) or the rollback switch is set (`~/.lively/mcp-transport` = `http`), it falls back to the old direct http connection (`url` + `bearer_token_env_var` + a static `x-lively-harness` header). In that case the session and mode features are lost.
- On the stdio path, the local-operations MCP `[mcp_servers.lively-local]` (`args = ["mcp-local"]` — repo and worktree tools) is included as well (#1884, parity with claude's `lively-local`).

**Additional MCP servers** (admin tab org_mcp_server → bundle `.lively/mcp-servers.json`): stdio servers use `command` (a string) + `args` (an array).
⚠ If you put an array in `command`, codex fails to read **the whole config.toml** with `invalid type: sequence, expected a string`, taking `[mcp_servers.lively]` and `[hooks.*]` down with it (a real bug fixed in #1475 — it never surfaced because the organization had no stdio servers).

**auto-approve**: `[mcp_servers.lively.tools.<tool>] approval_mode = "approve"` — the counterpart of claude's `permissions.allow`. Written inside the sentinel at install, then reconciled by `session-preload` every session (#1475 — the same cadence as claude).

**Hooks** — attached at the same points and at the same level as claude:

| Event | What's attached |
|---|---|
| SessionStart | session-preload · sync-harness-assets · work-flag · runner (+ matcher `compact` work-flag — #4219 record reminder right after compaction) |
| UserPromptSubmit | work-flag · runner |
| PreToolUse | runner (**organization governance deny gate**) |
| PostToolUse | work-flag ×3 (lively MCP · edit tools + shell · subagent launch `spawn_agent`) · runner — the #4219 inline-record correction nudge is Claude-only; codex writes records inline (#4220) |
| PermissionRequest | work-flag (where claude's Notification = "needs confirmation" sits) |
| Stop | stop-writeback-gate · work-flag · runner |
| SessionEnd | work-flag · runner (fires on codex 0.149.1+) |
| SubagentStop | work-flag · runner |
| PreCompact / PostCompact | runner (codex PreCompact can only stop the turn, so the #4219 record nudge is not wired here) |

## Harness differences (observed on codex 0.142.0)

- **The event set differs.** codex 0.142 has **no** `SessionEnd` or `Notification` (confirmed by their absence from the binary's strings), but has `PermissionRequest` and `SubagentStart` instead. PermissionRequest stands in for "needs confirmation".
  `SessionEnd` **fires from 0.149.1 on** (observed in #1884; the timeout is clamped to 3s) — the installer wires SessionEnd (0.142 silently ignores it), and normal session-end reporting (#1059) works on 0.149.1+.
- **The PreToolUse decision contract is the same as claude's** (`permissionDecision`/`permissionDecisionReason`, exit 2) — `run-custom`'s merge logic is used as is.
- **SessionStart output requires a JSON envelope** — raw stdout is ignored. `session-preload` branches on `LIVELY_HARNESS=codex`.
- **The file edit tool is named `apply_patch`** — it has been added to `work-flag`'s EDIT_TOOLS (safe for both). The 0.149.1+gpt-5.6 line issues edits as shell commands, so `work-flag` also detects shell edits (#1884).
- **The server's event allowlist** (`src/capabilities/delivery/hooks.ts` HOOK_EVENTS) is based on claude, so **organization hooks can't be registered** on `PermissionRequest` or `SubagentStart` — which is why the runner isn't wired to those two either (attaching the runner to events nobody can register for only adds empty round trips).

## Organization assets (sync-harness-assets)

| Kind | claude | codex |
|---|---|---|
| Skill | `~/.claude/skills/<id>/SKILL.md` | `~/.codex/skills/<id>/SKILL.md` — the Agent Skills open standard, so **the same file** |
| Subagent | `~/.claude/agents/<id>.md` | `~/.codex/agents/<id>.toml` — **format conversion** (name, description, developer_instructions) |
| Slash command | `~/.claude/commands/<id>.md` | `~/.codex/prompts/<id>.md` — custom prompt `/prompts:<id>` (only top-level .md files are scanned) |

Harness-specific fields (`model` and `tools` in claude frontmatter) are **not carried over** in conversion — model slugs and tool names differ per harness, so copying them as is makes the agent fail to load or be silently ignored.

⚠ **If an asset's `harness` target is pinned to `claude`, it won't reach codex no matter how ready the code is** — wiring (code) and targeting (data) are separate axes. Widen it to `all` in the admin tab ▸ Harness for it to be distributed.

## Hook trust (Codex-specific)

Unmanaged command hooks need a one-time **trust** (hash-based, persisted in `~/.codex`). The installer does not bake in `trusted_hash` (it can't be computed and would be fragile).
- Interactive (TUI): trust with `/hooks`
- Headless (`codex exec`): `--dangerously-bypass-hook-trust`

## Observations (codex-cli 0.142.0, 2026-08-04)

- **Lifecycle hooks fire even in `codex exec` (non-interactive)** — SessionStart, UserPromptSubmit, **PreToolUse**, PostToolUse, and Stop all confirmed.
  The 0.138-era limitation "hooks don't fire in exec" **is gone** (if that wording remains anywhere, delete it — it means governance applies to headless automation too).
  Headless mode can't ask for hook trust, so `--dangerously-bypass-hook-trust` is required.
- **Confirmed the 4 headers the stdio proxy attaches upstream**: `x-lively-harness=codex` · `x-lively-session` · `x-lively-mode` · `Authorization`.
  → Codex sessions also get the session attached to work records (#852), and read-only/incognito applies (#1007).
- `LIVELY_OFF=1`: live hook injection goes silent (the static part in AGENTS.md remains).

## Remaining gaps

- **auto-approve reflection cadence — resolved** (#1475). It used to be applied only at install, but now `session-preload` reconciles
  `[mcp_servers.lively(-local).tools.*]` in the config.toml managed block every session (`reconcileCodexAutoApprove`) — the same cadence as claude's `permissions.allow`.
