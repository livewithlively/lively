# Hook package runbook — 4 session hooks + custom hook runner (Phase C ④) + domain authoring (⑤) operating notes
*[한국어](hooks.ko.md)*

Principle: **triggers are deterministic, judgment happens in context.** Hooks never call an LLM or model API —
they only inject text or touch flags, and the judgment is made by the session that still holds the working context.

Source (single source of truth): `kit/hooks/` (product repo — 4 session hooks: session-preload·sync-harness-assets·work-flag·stop-writeback-gate + **run-custom** (custom hook runner) + the `settings-hooks.json` template + `test-hooks.sh`).
The single source for the list of files installed into a member's home is `HOOK_SCRIPTS` in `kit/setup/kit-manifest.mjs` (includes self-update·usage-report·harness adapters·shared modules).
Deployment (member install): `kit/setup/user-install.mjs` from the gateway `/install` bundle copies them to `~/.lively/hooks/` and
non-destructively merges the hooks block into the user's `~/.claude/settings.json` (inside `CLAUDE_CONFIG_DIR` if set) (`userLevelHooksBlock`·`runnerHooksBlock`·`safeMergeUserSettings`).
File-based path: `kit/generator/build-context.mjs` emits `<target>/.claude/hooks/*.mjs` + `<target>/.claude/settings.json`
(non-destructive merge of the hooks block) via the `--publish <out-dir>` and `--install-hooks <dir>…` (dogfood) paths.

## 1. Hook contract (verified against the official docs — ground truth)

| Hook | Event/matcher | stdin | stdout/exit |
|---|---|---|---|
| `session-preload.mjs` | SessionStart, matcher `startup\|resume\|clear` (compact intentionally excluded as re-injection noise) | Not read (prevents hangs) | On success, a Korean status block + exit 0 → injected into the session context. Every failure is silent exit 0 |
| `sync-harness-assets.mjs` | SessionStart, matcher `startup\|resume\|clear` | Not read | Fetches org harness assets (skills·subagents·commands) from the gateway and materializes them non-destructively on the harness's disk. If anything changed (claude), `{"hookSpecificOutput":{"hookEventName":"SessionStart","reloadSkills":true}}`; otherwise no output. Always exit 0 (on fetch failure the disk is left as is) |
| `work-flag.mjs` | PostToolUse ×3 (`mcp__lively__.*`, `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash`, `Agent\|Task` — #4217) + **SessionStart** (`startup\|resume\|clear`) + **SessionEnd** — #1059 · **UserPromptSubmit + Notification (no matcher) + Stop** — #1221 · **SubagentStop** — #4217 | hook-input JSON (session_id, tool_name, hook_event_name, reason, notification_type/message …) | No output, always exit 0. PostToolUse = touch flags (launching a record fork sets a `.writeback-pending` marker). SubagentStop = clears that marker. SessionStart = reports the claude UUID mapping (precise restore). SessionEnd (reason=prompt_input_exit\|logout) = reports a normal exit (shown as 'exited' in the restore list). **UserPromptSubmit/PostToolUse/Notification/Stop = session run-phase reporting** (§1.6 below) |
| `stop-writeback-gate.mjs` | Stop (no matcher) | hook-input JSON (includes `stop_hook_active`) | Only when blocking: `{"decision":"block","reason":…}` + exit 0 (resumes the same live session). Otherwise silent exit 0 |

> **memory_write is intentionally excluded from work-flag** — do **not** add it to `WRITE_TOOLS_DEFAULT` in work-flag.mjs or to the settings-hooks matchers.
> It is a no-op stub, so flagging it would create a false 'already recorded' (.writeback) signal (add it to both places at once when it is actually implemented). The `memory_*` MCP tools
> were retired on 2026-06-24 and are not in the current surface (merged into `knowledge_*`) — `memory_save`, which had stayed in the default list, was removed on 2026-09-30 (#4501). The list of tools that count as a record is
> changed without redeploying via the admin runtime setting `write_tools` (mirrored to `~/.lively/hooks-config.json`).

The MCP server name in the matchers is **the client registration label `lively`** (MCP_LABEL in `register-clients.sh`) —
not the server's self-name 'context-ontology'.

### Gate decision table (stop-writeback-gate — deterministic, exactly once per session)
1. `LIVELY_OFF=1` · read-only session (`LIVELY_MODE=readonly`) · disabled in the admin tab (`hooks.stop_writeback_gate=false`) → pass
2. `stop_hook_active === true` → pass (mandatory loop guard; a second guard independent of the hard 8-block cap)
3. Not a lively work session (cwd is outside the registered work-roots and there is no `<sid>.lively`) → pass (self-gating — never nudge in personal/other repos)
4. `<sid>.writeback` exists (already recorded) → pass
5. `<sid>.worked` absent (no meaningful work) → pass
6. `<sid>.blocked` exists (already nudged once) → pass
7. A record fork is in flight (#4217 — a `기록:` subagent in Stop's `background_tasks`; if that field is absent, a
   `<sid>.writeback-pending.*` set within the last 20 minutes) → pass (no `.blocked` written — if the fork ends without recording, the next Stop nudges)
8. Otherwise (only worked is present) → atomically create `.blocked` (O_EXCL) + decision:block — the reason is `writeback_notice` (admin-tab custom text
   or the server default, mirrored to `hooks-config.json`). Without it, a stub asks to record with activity_log·knowledge_save (source_save for external originals)
   or simply exit again

## 1.5 Custom hook runner (run-custom.mjs — 2026-06-16)
- An **immutable runner** that executes custom hooks (`org_hook`) defined in web admin (**runtime** scope). The body (source_code) is never stored on the member's disk — each session it fetches the enabled hooks from the gateway's `GET /api/ui/org/runner/hooks?harness=&event=` (member token auth, `org_runner_hooks` in `src/capabilities/delivery/hooks.ts`), runs each from a temp file, and deletes it.
- It is pinned in settings as one fixed entry per event (SessionStart·**SessionEnd**·UserPromptSubmit·PreToolUse·PostToolUse·Stop·SubagentStop·Notification·PreCompact·PostCompact — `user-install.mjs runnerHooksBlock`). Adding or removing custom hooks does not require rewriting settings — all the dynamism is server-side.
  - **⚠ Only SessionEnd has an explicit `timeout: 10` (#1043)**: on the shutdown path, Claude Code gives a SessionEnd hook without a declared `timeout` only a **1500 ms floor** (`getSessionEndHookTimeoutMs`: without env `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, `max(1500, configured hook timeout*1000)`, ceiling 60 s). When run-custom did its gateway fetch (org hook lookup) on SessionEnd against a remote gateway, it exceeded 1500 ms, was cut off by an `AbortSignal`, and printed a `SessionEnd hook … failed: Hook cancelled` warning. The explicit timeout raises that ceiling (run-custom has its own limits and usually finishes in <200 ms in practice — shutdown does not get slower). ⚠ For this value to reach existing settings, `safeMergeUserSettings` must **reclaim by comparing the full entry** (comparing only the command string never applies a timeout change to existing installs — user-install.test ⑨).
- **Cache fallback + grace knob when the gateway is unreachable (#1008)**: it runs from the last successful cache. The validity period is `runtime_config.hook_grace_ms` (admin tab ▸ custom hooks ▸ "offline cache validity" · session-preload mirrors it to `~/.lively/hooks-config.json` every session · read by run-custom `graceMs()`) — **default `null` = unlimited** (runs indefinitely based on the last connection: local, self-contained hooks that work without a gateway — the skill router, the spec-blind quality gate — keep working offline). If set to a positive value (ms), it fails CLOSED after that time has passed (a revocation window); `0` = stop immediately. Only hooks with a required and matching `content_hash` run (the same applies to the cache), and the cache is replaced wholesale on reconnect, so enabled=false/removal takes effect from the next session after reconnecting (an effective kill-switch) — even with no limit there is no tampering or unrevoked-hook risk. SIGKILL per `timeout_sec` (no-block invariant). `LIVELY_OFF=1` exits at the very top. (It used to be hardcoded to 10 minutes, so after 10 minutes offline even the self-contained local hooks above died — promoted to an admin-tab knob in #1008.)
- **stdout propagation (per event)**: `SessionStart`·`UserPromptSubmit` inject context as raw text, `PostToolUse` as `additionalContext` JSON. **`PreToolUse` propagates a 'decision' (#892)** — it is a `permissionDecision`, not text, so it cannot be concatenated; the runner parses the hooks' JSON and merges them into the **most restrictive decision** (`deny`>`defer`>`ask`>`allow`, all `additionalContext` preserved). Because the runner looks like a single hook to the harness, the runner has to do this merge itself. Other events (Stop·SessionEnd, etc.) are side effects only.
  - **Envelopes on context events**: a hook may emit context as raw text or in a `hookSpecificOutput.additionalContext` envelope — the runner unwraps envelopes before combining. Without unwrapping, two or more hooks produce stdout like `{...}\n\n{...}`, and the harness **discards the entire output** as "looks like JSON but fails to parse" (a silent failure where every hook succeeded but the context vanishes). However, if the envelope also carries meaning beyond context, such as `decision`·`systemMessage`, it is not unwrapped and is emitted as is. ⚠ That only survives to the harness on the **raw path (claude's SessionStart·UserPromptSubmit)** — `PostToolUse`·codex re-wrap into an envelope anyway, so they cannot carry a decision, and with several hooks even the raw path merges it with other context and loses the meaning. **Do not mix context and decisions in one envelope.**
  - **Propagation policy**: admin tab `runtime_config.hook_relay_decisions` (default `deny`·`ask`·`defer`). **`allow` is excluded by default** — it skips members' permission prompts, so it is an explicit opt-in. The runner receives it as `relay_decisions` in the `/api/ui/org/runner/hooks` response (no extra round trip).
  - **Module type**: if the hook source is CJS (`require`) it runs as `.cjs`, if ESM as `.mjs`. **Writing CJS source to `.mjs` dies on the first line with `require is not defined`** — that is why, in #892, the spec-blind guard/tracker had been dead ever since it was registered.
- **Hook health (#892)**: when a hook crashes or times out, the runner writes `[lively] hook '<id>' <reason>: <error headline>` to stderr (debug log) and reports it to the gateway via `POST /api/ui/org/runner/hook-report` → `org_hook.health` (last failure per member) → a `⚠ 실패 N대` ("failed on N machines") badge in the admin hook list. It **reports only on failure**, so a healthy org generates zero traffic. Previously crashes were swallowed whole (`catch → ""`), so 'dead' and 'no decision' were indistinguishable, and nobody noticed dead hooks.
- Design/verification: `research/2026-06-16-hook-tool-crud-구현.md` (internal design note — not in this repo).

## 1.6 Session run-phase reporting (work-flag — #1221, replaces screen scraping)

The **working · needs attention · idle** states on session cards used to be a heuristic where the gateway peeked at the tmux screen (Braille
spinner `U+2801~28FF` in the pane title · the approval pattern at the bottom of `capture-pane`). So ① it broke silently whenever the Claude Code UI changed
(#853 false-positive history), ② 5-minute polling missed changes between ticks, and ③ codex, which draws no spinner, **never became 'working'.**
The **phase itself** is now sent over the same path (`POST …/active`) that #1059 used to move 'activity time' into hooks.

| Event | Reported | Notes |
|---|---|---|
| `UserPromptSubmit` | `busy` | Turn start |
| `PostToolUse` | `busy` | Turn in progress (also keeps long turns fresh — where the old activity report lived) |
| `Notification` (`permission_prompt`·`elicitation_dialog`·`agent_needs_input`) | `waiting` | **No matcher** — avoids the entry silently never firing on old builds that don't know type matchers. The hook classifies from the payload (both the new `notification_type` and the old `message` wording) |
| `Notification` (`idle_prompt`) | `idle` | |
| `Stop` | `idle` | Turn end |
| `PermissionRequest` | `waiting` | **Codex parity** — codex has no Notification |
| `SessionStart`·other notifications (`auth_success`, etc.) | Not reported | A session starting is not work (inflating the activity time breaks both reclaim and the 'work done' judgment) |

- **Transitions are always sent. Only repeats of the same state are throttled to 60 s** — flag `<boxId>.state` (contents = last reported state). If a transition
  were throttled, a finished session would stay 'working' and also stay protected from reclaim forever.
- The gateway writes it to `@box_state` (a tmux session option, `"<phase> <epoch seconds>"`) — it survives restarts and rides along on the one `LIST_FMT`
  line the list query already reads, so querying costs nothing. **Phase and time are bundled in one string for atomicity** (written separately, a query could
  land between the two writes and see 'old state + new time').
- #4588 — **idle reports (Stop · the `idle_prompt` notification) carry `bg`**: the number of background jobs this conversation launched
  that have not finished yet (Bash in background · Bash moved to the background on timeout · background agents · Monitor, minus
  completion notifications and TaskStop), read incrementally from the transcript (`kit/hooks/bg-jobs.mjs`). The gateway writes
  `"idle <epoch seconds> bg=<n>"` (old parsers read only the first two tokens) and does **not** carry a previous bg over a report that has
  none (a hook that could not count must not inherit an old 0). The session list drops the screen's «… · 1 shell still running» (#4502 background) from the sidebar dot when the
  last report is idle with `bg=0` — the screen counter can disagree with what the AI is actually waiting for. No count → no `bg` → the screen is trusted as before.
- **Decision priority** (`src/terminal/phase.ts resolveAgentPhase` — re-exported by `terminal-sessions.ts`; the table is pinned by `terminal-sessions.test.ts`):
  fresh `waiting` report → fresh `busy` report → spinner (legacy) → capture-pane waiting (legacy) → `idle`.
  The spinner ranks above a reported `idle` to rescue **the case where the Stop gate blocked and the turn continued**.
- **TTL 10 minutes** (`PHASE_TTL_SEC`). Hooks are not daemons; **they only run when an event fires** — while a single tool runs for 10 minutes there is
  no update. So the TTL is generous, and expiry loses nothing (the legacy fallback answers exactly as before).
  Reports stamped in the future are treated as expired — node hooks use the member PC's clock, and with skew a report would harden into 'forever fresh'.
- **Scraping has not been removed yet** (fallback), because sessions without reports remain: old sessions · `LIVELY_OFF=1` (incognito) ·
  harnesses without hook wiring. Once the reporting path is proven, it will be retired by deleting rules 3 and 4 of `resolveAgentPhase`.
  Even before that, **sessions with a fresh report skip `capture-pane` entirely** (by priority it cannot change the result).
- **Node sessions (#869)**: a node has no DB, so there is no central desired-state record → `/active` returned 404. The gateway
  verifies the owner and relays via the node RPC `markActive` (old nodes don't declare the cap → nothing is sent = scraping as before).
- **Reclaim protection**: `SessionInfo.working` ('running', regardless of attachment) got a **sibling `awaiting`** ('waiting for approval', regardless of attachment).
  Without a tab, `agentState` overwrote waiting with offline, so **a session with its tab closed and an approval dialog open was a
  reclaim target** (losing the decision a person was about to make). Both values are the **union** of reports and scraping — reclaim cannot be undone,
  so over-protection is the right direction to fail.

## 2. Flag lifecycle
- Directory: `os.tmpdir()/lively-hooks/` (same on every platform; on macOS the per-user 0700 `$TMPDIR`=/var/folders/…/T),
  mkdir mode 0700. **Shared /tmp is not used** — removes the surface for pre-planted symlinks / flag spoofing in a shared directory (from an adversarial review).
- Files: `<session_id>.worked` · `<session_id>.writeback` · `<session_id>.blocked` · `<session_id>.lively` (a lively MCP tool
  was used — self-gating signal) · `<session_id>.writeback-pending.<child id>` (record fork in flight, #4217) (empty files).
  **Box-level flags** (keyed by `LIVELY_SESSION_ID`, not the session id): `<boxId>.<sid>.mapped` (+ `.try` cooldown, precise restore #1059) ·
  `<boxId>.state` (last reported phase — transition detection · 60 s throttle, #1221). Box-level is intentional — even when `/clear` changes the claude sid,
  the state of **the same tmux session** must carry over.
- session_id is allowlisted by `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` — no-op on mismatch (blocks path manipulation).
- The OS temp dir is wiped on reboot — no separate GC needed. `/clear` gives a new session_id → flags reset naturally.

## 3. Token/address conventions (secrets — never print or commit values)
- Token and address precedence depends on **who launched that window** (#959 — the canonical comment is in `kit/hooks/session-preload.mjs`):
  - A shell a person opened (no `LIVELY_SESSION_ID`): plugin setting (`CLAUDE_PLUGIN_OPTION_TOKEN`) → `~/.lively/token` (0600) → env
    `LIVELY_TOKEN`. The env is a snapshot of the file that the installer planted in the rc, so after re-login it holds the old value (#916·#2617).
  - A window Lively launched (`LIVELY_SESSION_ID` present): env `LIVELY_TOKEN` → plugin setting → `~/.lively/token`. There the env is the value the
    launcher loaded for that session (session hook token on shared-home boxes #1719 · gateway address for delegated runs #4012 T5).
  - If a session token file exists (#4135 — credentials the gateway later delivered to an already-running session), it takes top priority for the token
    (`sessionTokenFromFile` in `harness-registry.mjs`).
  - `self-update` is the exception and always reads the file first (it manages this machine's kit install). If none exist, preload silently does nothing.
  **Flags and the gate work without a token** — stop-gate never contacts the gateway, and work-flag reports with a token (UUID mapping · normal exit · run phase §1.6)
  only in Lively-launched box sessions (`LIVELY_SESSION_ID=box-*`); without a token it just skips those reports.
- Gateway address: same rules, `~/.lively/gateway-url` ↔ env `LIVELY_GATEWAY_URL` (↔ plugin
  `CLAUDE_PLUGIN_OPTION_GATEWAY_URL`) → if none, `http://localhost:8080`.
- Token issuance: the member install (`curl <gw>/cli | sh` → `lively` CLI device-code login) writes `~/.lively/token` (0600) directly.
  Admins can issue one with `org_token_mint` (a revocable DB token). The static `AUTH_TOKENS_JSON` in `.env` cannot be revoked,
  so it is not recommended for people. **Do not print the value to stdout**.

## 4. Prerequisites
- Register the `lively` MCP with `lively install` (CLI — run by `curl <gw>/cli | sh`) or the box's `register-clients.sh` (hard prerequisite for dogfooding). **If it is not registered, the `mcp__lively__*` matcher
  never matches and the `.writeback` flag is never set** → every session that did file work gets one stop nudge on exit
  (safe by design, but noisy). SessionStart preload (REST) and the Edit/Write flags work without registration.
- `GET /api/ui/org/preview`·`GET /api/ui/org/runtime-config`, which preload calls, require authentication only, with no scope — the token needs no particular scope.

## 5. Disabling / troubleshooting
- Global off: `LIVELY_OFF=1` (old `LIVELY_HOOKS_OFF` alias) — every hook script (including the runner) exits 0 immediately.
- Per-hook off: admin runtime setting `hooks.<name>=false` (mirrored to `~/.lively/hooks-config.json` — e.g. `session_preload`·
  `work_flag`·`stop_writeback_gate`·`sync_harness_assets`·`self_update`).
- Permanent removal: delete the entry from the hooks block of the user's `~/.claude/settings.json` (kit install default — the project `.claude/settings.json` for the `--install-hooks` path)
  (other keys are preserved). To remove the whole kit, use `kit/setup/user-uninstall.mjs`.
- Every script fails open: error/timeout → exit 0 with no output. Structurally, a hook never blocks real work.
- Unit tests: `bash kit/hooks/test-hooks.sh` (live cases with `LIVE=1`).
- **Flags globally inert**: if the `os.tmpdir()/lively-hooks` path is occupied by a regular file or the like, mkdir
  fails (fail-open, so nothing is blocked) and flags/stop nudges silently turn off for every session — since it is a per-user tmp,
  nobody else can create it, so it is limited to self-collision (accepted by design). If nudges don't appear, check that the path is a directory.

## 6. Billing gray zone (§10.4 flag)
Resuming after a Stop-block runs as **a continuation of the same interactive session** (subscription usage), but the official docs do not specify
how it is billed. On anomalies (usage spikes, etc.) it can be shut off immediately with `LIVELY_OFF=1`.
With once per session + the stop_hook_active guard + the hard 8-block cap, loop cost is structurally capped.

## 7. Snapshot/trust caveats
- Settings are **snapshotted at session start** — hook deployments apply from the next session. Verifying with an existing session right after
  deploying gives a false negative. A trust prompt may appear the first time a new hook is seen (normal).

## 8. Windows hooks — **supported** (the old "unsupported" caveat was misinformation, corrected 2026-06-17)
Claude Code **runs hooks normally on Windows** (official docs: no Windows-unsupported caveat; SessionStart stdout
injection is the same as on Mac). Our installer (`user-install.mjs`) generates **absolute forward-slash** commands for Windows
(`node "C:/Users/<user>/.lively/hooks/…"`) — no dependency on POSIX shell variables, so they work whether run from Git Bash, PowerShell, or cmd
(the old `$CLAUDE_PROJECT_DIR` quoting assumption is no longer used). **The only caveat: the `~/.lively` path must match** —
`kit/cli/bootstrap.ps1` (`irm <gw>/cli.ps1 | iex`) must write under `$env:USERPROFILE` (= Node `os.homedir()`) for hooks to read token/context.md
(PowerShell `$HOME` diverges on domain/roaming/OneDrive accounts — ps1 fixed 06-17). To turn off, `LIVELY_OFF=1`.

## 9. Domain authoring (⑤) operating notes
> **⚠ Retired (2026-06-24)** — `propose_domain`·`domain_deprecate` (and domain authoring such as `dm_domain_edit`) were removed;
> `category_create`·`category_update`·`category_edge_set` are the single surface (retirement comment in `src/capabilities/domainmap-curation.ts`).
> What follows is kept for the record.

- MCP surface of 24 tools — added `propose_domain` (evidence required, creates status='proposed', 403 for the protected repo lively) and
  `domain_deprecate` (state active↔deprecated, 400 for merged). Writes via MCP are passed as `x-actor-type: agent`
  and persisted in the domainmap change_log as actor_type='agent'.
- **domain_deprecate also has the agent-only protected-repo guard** — when actor.type==='agent', `setDomainState`
  rejects lifecycle changes to SYNC_BLOCKED_REPOS (default lively) domains with 403 (single-guard-in-the-store convention —
  same principle as proposeDomain). The human (web) path is unrestricted (existing behavior).
- **origin follows the actual actor type** — on propose, origin=actor.type (via MCP=agent, via web/REST by a
  human=human). Either way it is created with status='proposed' and waits for a human confirm (intended behavior).
- **Agents cannot edit confirmed domains (403)** — agent PATCH only on proposed rows, status unchanged.
  The human (web) path keeps the existing auto-confirm behavior. ※ The pattern of editing confirmed rows with CLI `domain-set --actor-type=agent`
  is now 403 — an intended behavior change.
- propose's evidence is **persisted only as a change_log note** (`propose (evidence): …`) — exposed in the UI via history.
- Deprecated domains are shown in every list by default (only state<>'merged' is filtered; bestDomainByTarget does not exclude them either —
  existing mappings stay valid). Badges/filtering are follow-ups (DESIGN-GUIDE §0.5 restraint principle).

## 10. known gaps
- **e2e-sandbox repo lingers permanently** — domainmap has no repo-delete. It shows up naturally in the /ui repo selector
  (graceful). Cleaning it up needs DB surgery — deferred. → **Resolved**: it can now be cleaned up with `repo_delete` (MCP·REST
  `POST /api/ui/domainmap/repo/delete`).
- `~/.lively/token` is a new convention — the setup script (setup-mac.sh) does not write it yet. On member machines only
  preload silently does nothing (normal). Follow-up: consider adding a write step to setup-mac.sh. → **Resolved**: the kit install's `lively` CLI
  login (device code) writes `~/.lively/token` (0600) (`setup-mac.sh` no longer exists).
