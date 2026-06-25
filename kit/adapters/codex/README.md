# Codex 어댑터 (R2 — 구현 완료)

`install.mjs` 가 **user-level** 로 Codex(0.138.0+)에 조직 컨텍스트+리플렉스를 설치한다. Claude 어댑터의 형제 — 같은 `~/.lively` 자산을 공유하고 Codex 전용 표면만 발행한다.

## 하는 일 (전부 idempotent)

- `~/.lively/context.md` · `org-name` · `hooks/*.mjs` · `work-roots` — **Claude 어댑터와 공유**.
- `~/.codex/AGENTS.md` — 정적 org-context. Codex 가 **글로벌 인스트럭션으로 네이티브 로드**(`$CODEX_HOME/AGENTS.md`, 프로젝트 AGENTS.md 보다 먼저 concat). 훅 trust 와 무관하게 항상 적용.
- `~/.codex/config.toml` — **센티넬 surgical safe-merge**(백업 먼저 → `~/.lively/backups/config.toml.codex.{orig,bak}`):
  - `[mcp_servers.lively]` — Streamable HTTP `url`(게이트웨이 `…/mcp`) + `bearer_token_env_var = "LIVELY_TOKEN"`. **토큰 리터럴 절대 미기입**(env 로만).
- **셸 rc `LIVELY_TOKEN` export** — `~/.zshrc`(+ 있으면 `.bashrc`/`.bash_profile`/`.profile`)에 센티넬 가드 블록 추가: `if [ -z "$LIVELY_TOKEN" ] && [ -r ~/.lively/token ]; then export LIVELY_TOKEN="$(cat ~/.lively/token)"; fi`. **토큰 리터럴이 아니라 런타임에 `~/.lively/token` 을 읽는 export** 다(가드레일 준수). Codex 는 config.toml 토큰 리터럴을 거부하므로(`bearer_token_env_var` 만 허용) 이 env 가 없으면 새 셸의 lively MCP 가 **401**(`codex doctor` 가 'Set the missing MCP env vars' 경고). 새 셸/`source ~/.zshrc` 후부터 적용.
  - `[[hooks.SessionStart]]`(matcher `startup|resume|clear`) · `[[hooks.PostToolUse]]`×2(matcher `mcp__lively__.*` / `Edit|Write|MultiEdit|NotebookEdit|apply_patch`) · `[[hooks.Stop]]`. 핸들러는 공유 훅 절대경로 + `env LIVELY_HARNESS=codex node "…"`.
  - 사용자 기존 키(model / `[projects.*]` trust / tui / 다른 mcp_servers/hooks)는 **한 바이트도 안 건드린다**. `# >>> lively-managed … >>>` ~ `# <<< lively-managed <<<` 센티넬 영역만 교체.

## 공유 훅이 drop-in 인 이유 + 하네스 분기 (검증된 계약, Codex 0.138.0 임베드 스키마)

훅 입력 필드(`session_id` / `tool_name` / `cwd` / `stop_hook_active`)와 Stop 출력(`{"decision":"block","reason":…}`)은 **Claude 와 동일**. MCP 툴 이름도 `mcp__<server>__<tool>` 로 동일. 단 두 가지만 분기:

1. **SessionStart 출력 봉투** — Codex 는 raw stdout 을 무시하고 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` 만 주입한다. `session-preload.mjs` 가 `LIVELY_HARNESS=codex` 일 때 이 봉투로 감싼다(미설정=raw=Claude).
2. **파일 편집 툴 이름** — Codex 는 편집을 `apply_patch` 로 보고한다. `work-flag.mjs` 의 `EDIT_TOOLS` 에 `apply_patch` 가산(Claude 의 `Edit/Write/…` 와 공존, 양쪽 안전).

스크립트는 **단일 세트**(포크 없음). 어댑터가 config.toml hook command 에 `LIVELY_HARNESS=codex` 를 박아 분기를 결정한다.

## 훅 trust (Codex 고유)

비관리 command 훅은 최초 1회 **trust** 필요(해시 기반, `~/.codex` 에 persist). `trusted_hash` 는 어댑터가 굽지 않는다(계산 불가/취약).
- **대화형(TUI):** `codex` 에서 `/hooks` 로 신뢰.
- **헤드리스(`codex exec`):** `--dangerously-bypass-hook-trust`.

## 실측 E2E 결과 (codex-cli 0.138.0, 실설치 검증)

- **대화형 세션: SessionStart 훅 발화 + 라이브 현황 주입 + lively MCP 연결 — 동작 확인.** 실 세션 rollout 에 `additionalContext`(미매핑/검토대기/최근 아이템) 주입 확인. `codex mcp list` 에 lively(streamable_http, bearer) enabled.
- **`codex exec`(비대화형): 라이프사이클 훅(SessionStart/PreToolUse/PostToolUse/Stop) 미발화** — Codex 0.138.0 한계(센티넬 테스트로 확인, 우리 버그 아님). 단 **`~/.codex/AGENTS.md` 정적 org-context 는 exec 에서도 주입됨**(네이티브 로드). 헤드리스 자동화에서 라이브 현황/라이트백 게이트가 필요하면 대화형 경로 사용.
- **`LIVELY_OFF=1`:** 훅 라이브 현황 침묵(SessionStart·Stop 모두). AGENTS.md 정적 컨텍스트는 유지(비밀 없음).
- 참고: 일부 버전에서 repo-local `.codex/config.toml` 훅 미발화 이슈(openai/codex#17532) — 우리는 **글로벌 `~/.codex/config.toml`** 에 설치하므로 해당 안 함.

## 생성기 라우팅 / 발행물

`generator/build-context.mjs` 의 `--harness codex`(또는 `claude,codex`)는 `HARNESS_EMIT` 로 dispatch.
user-level 발행물 경로는 동봉 `setup/user-install.mjs --harness codex`(자체완결 — generator 미의존)가 담당하고, 번들-안에서-실행(병행 경로)은 발행물 루트 `AGENTS.md` 를 Codex 가 네이티브 로드한다. `setup/setup-mac.sh` 는 `command -v claude/codex` 로 설치된 하네스를 자동 감지해 각각 설치한다.
