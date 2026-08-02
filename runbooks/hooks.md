# 훅 패키지 런북 — 세션 훅 3종 + 커스텀 훅 런너 (Phase C ④) + 도메인 authoring (⑤) 운영 노트

원칙: **트리거는 결정적으로, 판단은 인-컨텍스트로.** 훅은 LLM/모델 API 를 절대 호출하지 않는다 —
텍스트를 주입하거나 플래그를 만질 뿐이고, 판단은 작업 맥락이 살아있는 세션이 한다.

소스(단일 출처): `workflow-std/hooks/` (제품 레포 — 4 스크립트: session-preload·work-flag·stop-writeback-gate·**run-custom**(커스텀 훅 런너) + `settings-hooks.json` 템플릿 + `test-hooks.sh`).
배포: `workflow-std/generator/build-context.mjs` 가 `--publish`(context-setup) 와 `--install-hooks <dir>…`(독푸드)
경로에서 `<target>/.claude/hooks/*.mjs` + `<target>/.claude/settings.json`(hooks 블록 비파괴 머지)을 에밋한다.

## 1. 훅 계약 (공식 문서 검증 완료 — ground truth)

| 훅 | 이벤트/매처 | stdin | stdout/exit |
|---|---|---|---|
| `session-preload.mjs` | SessionStart, matcher `startup\|resume\|clear` (compact 는 재주입 노이즈로 의도적 제외) | 읽지 않음(hang 차단) | 성공 시 한국어 현황 블록 + exit 0 → 세션 컨텍스트로 주입. 실패는 전부 무출력 exit 0 |
| `work-flag.mjs` | PostToolUse ×2 (`mcp__lively__.*`, `Edit\|Write\|MultiEdit\|NotebookEdit`) + **SessionStart**(`startup\|resume\|clear`) + **SessionEnd** — #1059 · **UserPromptSubmit + Notification(matcher 없음) + Stop** — #1221 | hook-input JSON (session_id, tool_name, hook_event_name, reason, notification_type/message …) | 출력 없음, 항상 exit 0. PostToolUse=플래그 touch. SessionStart=claude UUID 매핑 보고(정밀복원). SessionEnd(reason=prompt_input_exit\|logout)=정상종료 보고(복원목록 '종료됨'). **UserPromptSubmit/PostToolUse/Notification/Stop=세션 실행 단계 보고**(아래 §1.6) |
| `stop-writeback-gate.mjs` | Stop (matcher 없음) | hook-input JSON (`stop_hook_active` 포함) | 차단 시에만 `{"decision":"block","reason":…}` + exit 0 (동일 라이브 세션 재가동). 그 외 무출력 exit 0 |

> **memory_save 는 work-flag 에서 의도적 제외** — 06-16 부터 MCP 표면(24툴)에 라이브(org_memory 영속, memory scope).
> 그러나 work-flag.mjs `WRITE_TOOLS`·settings-hooks 매처에는 **넣지 않는다** — memory_save 는 *조직 공유 메모리 저작*이지
> 프로젝트 라이트백이 아니라, 플래그하면 '이미 기록함'(.writeback) 오판을 만든다(프로젝트 작업 감지와 분리 유지).

매처의 MCP 서버명은 **클라이언트 등록 라벨 `lively`** (`register-clients.sh` 의 MCP_LABEL) —
서버 self-name 'context-ontology' 가 아니다.

### 게이트 결정표 (stop-writeback-gate — 결정적, 세션당 정확히 1회)
1. `stop_hook_active === true` → 통과 (필수 루프가드; 하드 8블록 캡과 별개의 이중 가드)
2. `<sid>.writeback` 존재 (이미 기록함) → 통과
3. `<sid>.worked` 부재 (의미있는 작업 없음) → 통과
4. `<sid>.blocked` 존재 (이미 1회 너지) → 통과
5. 그 외(worked 만 있음) → `.blocked` touch + decision:block — 기록(curate_item_mapping /
   pm_task_update_status·comment / propose_domain) 또는 그대로 재종료 안내

## 1.5 커스텀 훅 런너 (run-custom.mjs — 2026-06-16)
- 웹 관리(**runtime** scope)에서 정의하는 커스텀 훅(`org_hook`)을 실행하는 **불변 런너**. 본문(source_code)은 멤버 디스크에 저장하지 않는다 — 매 세션 게이트웨이 `GET /api/ui/org/runner/hooks?harness=&event=`(멤버 토큰 인증, `delivery.ts org_runner_hooks`)에서 enabled 훅을 받아 임시파일로 실행 후 삭제.
- 이벤트당 고정 엔트리 1개로 settings 에 박힌다(SessionStart·**SessionEnd**·UserPromptSubmit·PreToolUse·PostToolUse·Stop·SubagentStop·Notification·PreCompact·PostCompact — `user-install.mjs runnerHooksBlock`). 커스텀 훅 추가/삭제는 settings 재작성 불요 — 동적성은 전부 서버측.
  - **⚠ SessionEnd 만 명시 `timeout: 10`(#1043)**: Claude Code 는 종료 경로 SessionEnd 훅에 `timeout` 미선언 시 **floor 1500ms** 만 준다(`getSessionEndHookTimeoutMs`: env `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` 없으면 `max(1500, 설정훅 timeout*1000)`, ceiling 60s). run-custom 이 SessionEnd 에서 게이트웨이 fetch(org 훅 조회)를 하다 원격 게이트웨이면 1500ms 를 넘겨 `AbortSignal` 로 잘리고 `SessionEnd hook … failed: Hook cancelled` 워닝이 떴다. 명시 timeout 이 그 상한을 올린다(run-custom 은 자체 상한으로 실제로는 대개 <200ms 종료 — 종료가 느려지지 않는다). ⚠ 이 값을 settings 에 반영하려면 `safeMergeUserSettings` 가 **전문(entry) 비교로 회수**해야 한다(command 문자열만 보면 timeout 변경이 기존 설치에 안 박힌다 — user-install.test ⑨).
- **게이트웨이 미도달 시 캐시 폴백 + grace 노브(#1008)**: 최근 성공 캐시로 실행한다. 유효기간은 `runtime_config.hook_grace_ms`(관리탭 ▸ 커스텀 훅 ▸ "오프라인 캐시 유효기간" · session-preload 가 매 세션 `~/.lively/hooks-config.json` 로 미러 · run-custom `graceMs()` 가 읽음) — **기본 `null`=무제한**(마지막 접속 기준 영구 실행: 게이트웨이 없이도 동작하는 로컬-자족 훅 — 스킬 라우터·spec-blind 품질게이트 — 이 오프라인에서 유지된다). 양수(ms) 설정 시 그 경과 후 fail-CLOSED(회수창), `0`=즉시 중단. `content_hash` 필수+일치만 실행하고(캐시에도 동일 적용) 재접속 시 캐시가 통째 교체되므로, enabled=false/제거는 재접속한 다음 세션부터 무효(실효 kill-switch) — 무제한이어도 변조·미회수 위험은 없다. `timeout_sec` 마다 SIGKILL(no-block 불변식). `LIVELY_OFF=1` 최상단 종료. (종전엔 10분 하드코딩이라 오프라인 10분 후 위 로컬-자족 훅까지 죽었다 — #1008 에서 관리탭 노브로 승격.)
- **stdout 전파(이벤트별)**: `SessionStart`·`UserPromptSubmit` 는 raw 텍스트, `PostToolUse` 는 `additionalContext` JSON 으로 컨텍스트 주입. **`PreToolUse` 는 '결정'을 전파한다(#892)** — 텍스트가 아니라 `permissionDecision` 이라 이어붙일 수 없어, 러너가 훅들의 JSON 을 파싱해 **가장 제한적인 결정**으로 병합한다(`deny`>`defer`>`ask`>`allow`, `additionalContext` 는 전부 보존). 러너는 하네스에 훅 1개로 보이므로 이 병합을 러너가 직접 해야 한다. 그 외 이벤트(Stop·SessionEnd 등)는 부수효과만.
  - **전파 정책**: 관리탭 `runtime_config.hook_relay_decisions`(기본 `deny`·`ask`·`defer`). **`allow` 는 기본 제외** — 구성원의 권한 프롬프트를 건너뛰므로 명시 opt-in. 러너는 `/api/ui/org/runner/hooks` 응답의 `relay_decisions` 로 받는다(왕복 추가 없음).
  - **모듈 타입**: 훅 소스가 CJS(`require`)면 `.cjs`, ESM 이면 `.mjs` 로 실행한다. **CJS 소스를 `.mjs` 로 쓰면 `require is not defined` 로 첫 줄에서 즉사**하는데, 그게 #892 에서 spec-blind guard/tracker 가 등록 이래 내내 죽어 있던 원인이다.
- **훅 건강(#892)**: 훅이 죽거나 타임아웃되면 러너가 stderr 에 `[lively] hook '<id>' <사유>: <에러 헤드라인>` 을 남기고(디버그 로그), `POST /api/ui/org/runner/hook-report` 로 게이트웨이에 보고한다 → `org_hook.health`(멤버별 마지막 실패) → 관리탭 훅 목록에 `⚠ 실패 N대` 배지. **실패했을 때만** 보고하므로 정상 조직은 트래픽 0. 종전엔 크래시를 통째로 삼켜(`catch → ""`) '죽음'과 '결정 없음'이 구분되지 않았고, 그래서 죽은 훅을 아무도 몰랐다.
- 설계/검증: `research/2026-06-16-hook-tool-crud-구현.md`.

## 1.6 세션 실행 단계 보고 (work-flag — #1221, 화면 스크래핑 대체)

세션 카드의 **작업 중 · 확인 필요 · 대기 중**은 게이트웨이가 tmux 화면을 훔쳐보던 휴리스틱이었다(pane 제목의
브라유 스피너 `U+2801~28FF` · `capture-pane` 하단 승인 패턴). 그래서 ① Claude Code UI 가 바뀌면 조용히 깨지고
(#853 오탐 이력) ② 5분 폴링이라 tick 사이 변화를 놓치고 ③ 스피너를 안 그리는 코덱스는 **영영 '작업 중'이 안 됐다.**
#1059 가 '활동 시각'을 훅으로 옮긴 그 경로(`POST …/active`)에 **단계 자체**를 실어 보낸다.

| 이벤트 | 보고 | 비고 |
|---|---|---|
| `UserPromptSubmit` | `busy` | 턴 시작 |
| `PostToolUse` | `busy` | 턴 진행(긴 턴의 신선도 유지 겸함 — 종전 활동 보고 자리) |
| `Notification` (`permission_prompt`·`elicitation_dialog`·`agent_needs_input`) | `waiting` | **matcher 를 안 건다** — 타입 matcher 를 모르는 구 빌드에서 엔트리가 통째로 안 걸려 조용히 죽는 걸 피한다. 분류는 훅이 페이로드로(신형 `notification_type` / 구형 `message` 문구 둘 다) |
| `Notification` (`idle_prompt`) | `idle` | |
| `Stop` | `idle` | 턴 종료 |
| `PermissionRequest` | `waiting` | **코덱스 패리티** — 코덱스엔 Notification 이 없다 |
| `SessionStart`·그 외 알림(`auth_success` 등) | 보고 안 함 | 세션이 뜬 것은 작업이 아니다(활동 시각을 부풀리면 회수·'작업 완료' 판정이 함께 망가진다) |

- **전이는 항상 보낸다. 같은 상태의 반복만 60초 스로틀** — 플래그 `<boxId>.state`(내용=마지막 보고 상태). 전이가
  스로틀에 막히면 끝난 세션이 계속 '작업 중'으로 남고 회수도 영구 보호된다.
- 게이트웨이는 `@box_state`(tmux 세션 옵션, `"<phase> <epoch초>"`)에 새긴다 — 재기동 생존 + 목록 조회가 어차피
  읽는 `LIST_FMT` 한 줄에 딸려 와 조회 비용 0. **phase 와 시각을 한 문자열에 묶은 건 원자성** 때문이다(따로 쓰면
  두 write 사이에 조회가 끼어 '옛 상태 + 새 시각'이 나온다).
- **판정 우선순위**(`terminal-sessions.ts resolveAgentPhase`, 표는 `terminal-sessions.test.ts` 가 고정):
  신선한 `waiting` 보고 → 신선한 `busy` 보고 → 스피너(레거시) → capture-pane 대기(레거시) → `idle`.
  스피너가 보고된 `idle` 보다 위인 건 **Stop 게이트가 block 해 턴이 이어진 경우**를 구제하기 위해서다.
- **TTL 10분**(`PHASE_TTL_SEC`). 훅은 데몬이 아니라 **이벤트가 나야 실행된다** — 도구 하나가 10분 도는 동안엔
  갱신이 없다. 그래서 TTL 은 넉넉하고, 만료돼도 손실이 없다(레거시 폴백이 종전과 똑같이 답한다).
  미래로 찍힌 보고는 만료로 본다 — 노드 훅은 멤버 PC 시계라 스큐가 있으면 '영원히 신선한' 보고가 굳는다.
- **스크래핑은 아직 안 지웠다**(폴백). 보고가 없는 세션이 남기 때문이다: 구 세션 · `LIVELY_OFF=1`(incognito) ·
  훅 미배선 하네스. 보고 경로가 실증되면 `resolveAgentPhase` 의 3·4번 규칙을 지우는 것으로 은퇴시킨다.
  그 전에도 **신선한 보고가 있는 세션은 `capture-pane` 을 아예 건너뛴다**(우선순위상 결과를 못 바꾸므로).
- **노드 세션(#869)**: 노드엔 DB 가 없어 중앙 desired-state 레코드가 없다 → `/active` 가 404 였다. 게이트웨이가
  소유자 확인 후 노드 RPC `markActive` 로 릴레이한다(구 노드는 caps 미선언 → 안 보냄 = 종전 스크래핑 그대로).
- **회수 보호**: `SessionInfo.working`(접속 무관 '돌고 있다')에 **형제로 `awaiting`**(접속 무관 '승인 대기')을 더했다.
  탭이 없으면 `agentState` 가 waiting 을 offline 으로 덮어, **탭 닫아 둔 채 승인 다이얼로그가 떠 있는 세션이
  회수 대상**이었다(사람이 내리려던 결정을 잃는다). 두 값 모두 보고·스크래핑의 **합집합** — 회수는 되돌릴 수 없어
  과보호가 옳은 실패 방향이다.

## 2. 플래그 생명주기
- 디렉토리: `os.tmpdir()/lively-hooks/` (전 플랫폼 동일; macOS 는 유저별 0700 `$TMPDIR`=/var/folders/…/T),
  mkdir mode 0700. **공유 /tmp 미사용** — 공유 디렉토리 심링크 사전심기/플래그 스푸핑 표면 제거(적대 리뷰 반영).
- 파일: `<session_id>.worked` · `<session_id>.writeback` · `<session_id>.blocked` (빈 파일).
  **box 단위 플래그**(세션 id 가 아니라 `LIVELY_SESSION_ID`): `<boxId>.<sid>.mapped`(+`.try` 쿨다운, 정밀복원 #1059) ·
  `<boxId>.state`(마지막 보고 단계 — 전이 판정·60초 스로틀, #1221). box 단위인 건 의도다 — `/clear` 로 claude sid 가
  바뀌어도 **같은 tmux 세션**의 상태는 이어져야 한다.
- session_id 는 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` 화이트리스트 — 불일치 시 no-op(경로조작 차단).
- OS 템프는 재부팅 시 소멸 — 별도 GC 불요. `/clear` 는 새 session_id → 플래그 자연 리셋.

## 3. 토큰/주소 컨벤션 (시크릿 — 값 출력/커밋 절대 금지)
- 토큰: env `LIVELY_TOKEN` → 없으면 `~/.lively/token`(0600) 폴백 → 없으면 preload 는 조용히 무동작.
  **work-flag/stop-gate 는 무토큰 동작**(게이트웨이 비접촉) — 멤버 머신에서 토큰이 없어도 게이트는 정상.
- 게이트웨이 주소: env `LIVELY_GATEWAY_URL` → `~/.lively/gateway-url` → `http://localhost:8080`.
- 레포 스코프: env `LIVELY_HOOKS_REPO` (기본 `productivity`).
- 토큰 발급: 게이트웨이 `.env` 의 `AUTH_TOKENS_JSON` 에서 본인 항목 — **값을 stdout 에 출력하지 말 것**
  (`install -m 600` / python os.open 패턴으로 파일에 직접 기록).

## 4. 선행조건
- `register-clients.sh` 로 `lively` MCP 등록(독푸드 하드 선행조건). **미등록이면 `mcp__lively__*` 매처가
  영영 안 맞아 `.writeback` 플래그가 서지 않는다** → 파일 작업을 한 모든 세션이 종료 시 1회 stop 너지를
  받는다(설계상 안전하나 노이즈). SessionStart preload(REST)와 Edit/Write 플래그는 등록 없이도 동작.
- preload 토큰은 items+context 양 스코프 필요(inbox/stats=items, domainmap proxy=context).

## 5. 비활성화 / 트러블슈팅
- 전역 끄기: `LIVELY_OFF=1`(구 `LIVELY_HOOKS_OFF` alias) — 4 스크립트 모두(런너 포함) 공통으로 즉시 exit 0.
- 영구 제거: 프로젝트 `.claude/settings.json` 의 hooks 블록에서 해당 entry 삭제(다른 키는 보존).
- 모든 스크립트는 페일오픈: 에러/타임아웃 → exit 0 무출력. 훅이 실제 작업을 막는 일은 구조적으로 없다.
- 유닛테스트: `bash workflow-std/hooks/test-hooks.sh` (라이브 케이스는 `LIVE=1`).
- **플래그 전역 무동작 케이스**: `os.tmpdir()/lively-hooks` 경로가 일반 파일 등으로 선점되면 mkdir 가
  실패하고(페일오픈이라 차단은 없음) 모든 세션의 플래그/stop 너지가 조용히 꺼진다 — per-user tmp 라
  본인 외엔 만들 수 없으므로 자기충돌 한정(설계상 수용). 너지가 안 보이면 해당 경로가 디렉토리인지 확인.

## 6. 과금 그레이존 (§10.4 플래그)
Stop-block 의 재가동은 **동일 인터랙티브 세션의 연속**(구독 사용량)으로 동작하지만, 공식 문서가 과금
처리를 명시하지 않는다. 이상 징후(사용량 급증 등) 시 `LIVELY_HOOKS_OFF=1` 로 즉시 차단 가능.
게이트는 세션당 1회 + stop_hook_active 가드 + 하드 8블록 캡으로 루프 비용이 구조적으로 캡된다.

## 7. 스냅샷/trust 주의
- settings 는 **세션 시작 시 스냅샷** — 훅 배포는 다음 세션부터 적용된다. 배포 직후 기존 세션으로
  검증하면 거짓 음성. 신규 훅 첫 인지 시 trust 확인 프롬프트가 뜰 수 있다(정상).

## 8. Windows 훅 — **지원됨** (구 "미지원" 캐비앗은 오정보, 2026-06-17 정정)
Claude Code 는 **Windows 에서 훅을 정상 실행**한다(공식 docs: Windows 비지원 캐비앗 없음; SessionStart stdout
주입도 Mac 동일). 우리 설치기(`user-install.mjs`)는 Windows 용으로 **절대경로 forward-slash** 커맨드
(`node "C:/Users/<user>/.lively/hooks/…"`)를 생성 — POSIX 셸 변수 의존이 없어 Git Bash/PowerShell/cmd 어디서
실행돼도 동작한다(구 `$CLAUDE_PROJECT_DIR` 인용 가정은 더는 안 씀). **유일 주의: `~/.lively` 경로 일치** —
`setup-windows.ps1` 이 `$env:USERPROFILE`(=Node `os.homedir()`)에 써야 훅이 token/context.md 를 읽는다
(PowerShell `$HOME` 은 도메인/로밍/OneDrive 계정서 갈림 — 06-17 ps1 수정). 끄려면 `LIVELY_OFF=1`.

## 9. 도메인 authoring (⑤) 운영 노트
- MCP 표면 24툴 — `propose_domain`(evidence 필수, status='proposed' 생성, 보호 리포 lively 403)과
  `domain_deprecate`(state active↔deprecated, merged 는 400) 추가. MCP 경유 쓰기는 `x-actor-type: agent`
  로 전달되어 domainmap change_log 에 actor_type='agent' 로 영속된다.
- **domain_deprecate 도 agent 한정 보호 리포 가드** — `setDomainState` 가 actor.type==='agent' 이면
  SYNC_BLOCKED_REPOS(기본 lively) 도메인의 lifecycle 변경을 403 으로 거부한다(스토어 단일 가드 관례 —
  proposeDomain 과 동일 원칙). human(웹) 경로는 무제한(기존 거동).
- **origin 은 실제 행위자 타입을 따른다** — propose 시 origin=actor.type(MCP 경유=agent, 웹/REST 인간
  경유=human). 어느 경로든 status='proposed' 로 생성되어 사람 confirm 을 기다리는 것은 동일(의도된 거동).
- **agent 는 confirmed 도메인을 편집할 수 없다(403)** — agent PATCH 는 proposed 행만, status 유지.
  human(웹) 경로는 기존 auto-confirm 거동 그대로. ※ CLI `domain-set --actor-type=agent` 로 confirmed
  행을 편집하던 패턴은 이제 403 — 의도된 행위 변경.
- propose 의 evidence 는 **change_log note 로만 영속**(`propose (evidence): …`) — UI 노출은 history 경유.
- deprecated 도메인은 모든 목록에 기본 노출(state<>'merged' 만 필터; bestDomainByTarget 도 미제외 —
  기존 매핑 유효 유지). 뱃지/필터링은 후속(DESIGN-GUIDE §0.5 절제 원칙).

## 10. known gaps
- **e2e-sandbox 리포 영구 잔존** — domainmap 에 repo-delete 가 없다. /ui 리포 셀렉터에는 자연스럽게
  표시된다(graceful). 정리하려면 DB 수술이 필요 — 보류.
- `~/.lively/token` 은 신규 컨벤션 — setup 스크립트(setup-mac.sh)가 아직 기록하지 않는다. 멤버 머신에선
  preload 만 조용히 무동작(정상). 후속: setup-mac.sh 에 기록 단계 추가 검토.
