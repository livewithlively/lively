# Codex 하네스 배선

> **정본은 `setup/user-install.mjs --harness codex` 다.** 예전엔 이 폴더에 `install.mjs` 형제 설치기가 있었지만
> **아무도 호출하지 않는 죽은 코드**였고, 개선이 거기 들어가 실배포엔 안 나가는 사고를 만들었다(#1475 실측:
> #1221 세션 실행단계 보고가 어댑터에만 들어가 사용자에겐 내내 안 갔다). 그래서 삭제했다 — 배선을 고칠 땐
> `setup/user-install.mjs` 의 `codexManagedBlock()` **하나만** 고친다. 제거기(`uninstall.mjs`)는 여기 그대로 있다.
> 사양은 `setup/codex-wiring.test.mjs` 가 못박는다(claude 배선과의 패리티를 코드로 강제).

## 심는 것 (전부 idempotent · 센티넬 surgical merge)

공유 자산 `~/.lively/{context.md, org-name, hooks/*.mjs, work-roots, bin/lively, lib/*}` 는 claude 와 **같은 것**을 쓴다.
Codex 전용 표면은 둘뿐이다.

### `~/.codex/AGENTS.md`
정적 org-context. Codex 가 글로벌 인스트럭션으로 **네이티브 로드**(`$CODEX_HOME/AGENTS.md`)하므로 훅 trust 와 무관하게 항상 적용된다.
센티넬 블록으로 머지 — 멤버 기존 지침은 보존(백업 `~/.lively/backups/codex-AGENTS.md.{orig,bak}`).

### `~/.codex/config.toml`
`# >>> lively-managed … >>>` ~ `# <<< lively-managed <<<` 안만 교체한다. 바깥(model·`[projects.*]` trust·tui·다른 mcp_servers/hooks)은 한 바이트도 안 건드린다.

**MCP — 기본은 로컬 stdio 프록시:**
```toml
[mcp_servers.lively]
command = "/…/.lively/bin/lively"
args = ["mcp"]

[mcp_servers.lively.env]
LIVELY_HARNESS = "codex"
```
- codex 의 `http_headers` 는 **정적 문자열**이라 세션 env 를 확장하지 못한다 → http 직결로는 `x-lively-session`(#852)·`x-lively-mode`(#1007 읽기전용/incognito)를 **영영 못 보낸다.** 프록시가 그 env 를 읽어 상류에 붙이므로 두 기능이 codex 에서도 산다.
- 부팅 시 게이트웨이에 못 닿아도 stdio 는 로컬 프로세스라 세션 내내 failed 로 굳지 않는다(#1079).
- 토큰이 설정 파일에 안 들어간다 — 프록시가 매 호출 `~/.lively/token` 을 읽는다(rc 의 `LIVELY_TOKEN` 이 스테일이어도 옛 신원으로 조용히 안 붙는다 — #916 의 codex 판).
- **`env.LIVELY_HARNESS` 는 필수다.** 프록시를 거치면 UA 가 우리 것이 되므로 이 stamp 가 하네스 신호의 전부다(빠지면 게이트웨이가 코덱스 세션을 claude 로 집계 — #182).
- 프록시 파일이 없거나(구버전 번들) 롤백 스위치(`~/.lively/mcp-transport` = `http`)면 종전 http 직결(`url` + `bearer_token_env_var` + 정적 `x-lively-harness` 헤더)로 떨어진다. 그 경우 세션·모드 기능은 빠진다.

**추가 MCP 서버**(관리탭 org_mcp_server → 번들 `.lively/mcp-servers.json`): stdio 는 `command`(문자열) + `args`(배열)다.
⚠ `command` 에 배열을 넣으면 codex 가 `invalid type: sequence, expected a string` 로 **config.toml 전체**를 못 읽어 `[mcp_servers.lively]`·`[hooks.*]` 까지 동반 사망한다(#1475 에서 고친 실버그 — 조직에 stdio 서버가 하나도 없어 미발현이었다).

**auto-approve**: `[mcp_servers.lively.tools.<툴>] approval_mode = "approve"` — claude 의 `permissions.allow` 대응물. 센티넬 안이라 재설치마다 reconcile 된다.

**훅** — claude 와 같은 자리에 같은 수준으로 붙인다:

| 이벤트 | 붙는 것 |
|---|---|
| SessionStart | session-preload · sync-harness-assets · work-flag · 러너 |
| UserPromptSubmit | work-flag · 러너 |
| PreToolUse | 러너 (**조직 거버넌스 deny 게이트**) |
| PostToolUse | work-flag ×2(lively MCP · 편집툴) · 러너 |
| PermissionRequest | work-flag (claude 의 Notification = '확인 필요' 자리) |
| Stop | stop-writeback-gate · work-flag · 러너 |
| SubagentStop / PreCompact / PostCompact | 러너 |

## 하네스 차이 (codex 0.142.0 실측)

- **이벤트 집합이 다르다.** codex 엔 `SessionEnd`·`Notification` 이 **없고**(바이너리 문자열 부재로 확인), 대신 `PermissionRequest`·`SubagentStart` 가 있다. 그래서 세션 정상종료 보고(#1059)는 codex 에서 성립하지 않고, '확인 필요'는 PermissionRequest 가 대신한다.
- **PreToolUse 결정 계약은 claude 와 동일**(`permissionDecision`/`permissionDecisionReason`, exit 2) — `run-custom` 의 병합 로직이 그대로 쓰인다.
- **SessionStart 출력은 JSON 봉투 필수** — raw stdout 은 무시된다. `session-preload` 가 `LIVELY_HARNESS=codex` 로 분기.
- **파일 편집 툴명은 `apply_patch`** — `work-flag` 의 EDIT_TOOLS 에 가산돼 있다(양쪽 안전).
- **서버 이벤트 허용목록**(`src/capabilities/delivery/hooks.ts` HOOK_EVENTS)은 claude 기준이라 `PermissionRequest`·`SubagentStart` 에는 **조직 훅을 등록할 수 없다** — 그래서 러너도 그 둘엔 배선하지 않는다(등록 불가능한 이벤트에 러너를 붙이면 빈 왕복만 는다).

## 조직 자산 (sync-harness-assets)

| 종류 | claude | codex |
|---|---|---|
| 스킬 | `~/.claude/skills/<id>/SKILL.md` | `~/.codex/skills/<id>/SKILL.md` — Agent Skills 오픈표준이라 **같은 파일** |
| 서브에이전트 | `~/.claude/agents/<id>.md` | `~/.codex/agents/<id>.toml` — **포맷 변환**(name·description·developer_instructions) |
| 슬래시커맨드 | `~/.claude/commands/<id>.md` | `~/.codex/prompts/<id>.md` — 커스텀 프롬프트 `/prompts:<id>`(최상위 .md 만 스캔) |

변환 시 하네스 고유 필드(claude frontmatter 의 `model`·`tools`)는 **옮기지 않는다** — 모델 슬러그도 툴 이름도 하네스마다 달라 그대로 넣으면 에이전트가 안 뜨거나 조용히 무시된다.

⚠ **자산의 `harness` 타깃이 `claude` 로 묶여 있으면 코드가 아무리 준비돼도 codex 엔 안 간다** — 배선(코드)과 타깃(데이터)은 별개 축이다. 관리탭 ▸ 하네스에서 `all` 로 넓혀야 배포된다.

## 훅 trust (Codex 고유)

비관리 command 훅은 최초 1회 **trust** 가 필요하다(해시 기반, `~/.codex` 에 persist). `trusted_hash` 는 설치기가 굽지 않는다(계산 불가·취약).
- 대화형(TUI): `/hooks` 로 신뢰
- 헤드리스(`codex exec`): `--dangerously-bypass-hook-trust`

## 실측 (codex-cli 0.142.0, 2026-08-04)

- **`codex exec`(비대화형)에서도 라이프사이클 훅이 발화한다** — SessionStart·UserPromptSubmit·**PreToolUse**·PostToolUse·Stop 전부 확인.
  0.138 시절의 "exec 는 훅 미발화" 한계는 **해소됐다**(그 문구가 남아 있으면 지운다 — 헤드리스 자동화에도 거버넌스가 걸린다는 뜻이다).
  헤드리스는 훅 trust 를 못 물으므로 `--dangerously-bypass-hook-trust` 가 필요하다.
- **stdio 프록시가 상류에 붙이는 헤더 4종 확인**: `x-lively-harness=codex` · `x-lively-session` · `x-lively-mode` · `Authorization`.
  → 코덱스 세션도 작업기록에 세션이 붙고(#852) 읽기전용/incognito 가 걸린다(#1007).
- `LIVELY_OFF=1`: 훅 라이브 주입 침묵(AGENTS.md 정적분은 유지).

## 남은 갭

- **auto-approve 는 설치 시점에만 반영된다.** claude 는 `session-preload` 가 매 세션 `permissions.allow` 를 reconcile 하지만,
  codex 는 관리 블록 안이라 재설치(=self-update)까지 관리자 변경이 안 붙는다. 기능 손실은 아니고 승인 프롬프트가 늦게 사라질 뿐.
