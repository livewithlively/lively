# Claude 하네스 배선

*[English](README.md)*

Claude Code 하네스용 설정을 emit 한다. **user-level 설치**가 주력(D2/D3): 한 번 설치하면 멤버가 어느 폴더에서 `claude` 를 켜든 조직 컨텍스트+리플렉스가 따라온다.

> **정본은 `setup/user-install.mjs` 다.** 이 폴더에 있던 `install.mjs` 는 아무도 호출하지 않는 죽은 코드라
> 삭제했다(#1475 — 그 존재가 "개선을 실배포 아닌 곳에 넣는" 사고를 코덱스 쪽에서 실제로 만들었다).
> 제거기(`uninstall.mjs`)와 managed 예시는 여기 그대로다. 코덱스 쪽 대응 문서는 `../codex/README.ko.md`.

## 심는 것 (전부 idempotent)

| 산출물 | 내용 | 비고 |
|---|---|---|
| `~/.lively/context.md` | org-context — 설치 시 게이트웨이(`/api/ui/org/preview`)에서 1회 시드, 이후 `session-preload` 가 매 세션 받아 갱신 | **토큰/시크릿 없음.** 게이트웨이에 못 닿는 세션에서 `session-preload` 가 이 캐시를 SessionStart 에 주입 |
| `~/.lively/hooks/*` | 훅 런타임 복사(chmod 755) — 목록 정본은 `setup/kit-manifest.mjs` 의 `HOOK_SCRIPTS` | 배선 훅 session-preload · sync-harness-assets · work-flag · stop-writeback-gate · run-custom + 배선 안 되는 파일(self-update · usage-report · 하네스 어댑터 · 공유 모듈) |
| `~/.claude/settings.json` | **user-level** 훅 블록(기본 훅 + 이벤트별 run-custom 러너) 비파괴 머지 + auto-approve(`permissions.allow`) reconcile | 백업 먼저(`~/.lively/backups/settings.json.bak`); hooks·`permissions.allow` 외 키 무수정(멤버가 넣은 allow 항목은 보존). `CLAUDE_CONFIG_DIR` 가 있으면 그 안의 settings.json(프로필별 계정 격리 #346) |
| `~/.lively/work-roots` | 자가 게이팅 work-root 시드 | 없는 항목만 추가, 기존 보존 |

MCP 등록은 **여기서 하지 않는다** — 멤버 PC 는 `lively install` 의 마지막 단계(`claude mcp add --scope user`), 박스 프로비저닝은 `setup/register-clients.sh`(→ `mcp-register.mjs`, `~/.claude.json` 직접 기록)가 맡는다(중복 등록 방지).

## user-level vs project-dir 의 결정적 차이 (가장 큰 함정)

- **project-dir 템플릿**(`hooks/settings-hooks.json`): command = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<script>.mjs"`.
  발행물(`<번들>/.claude/`)에 들어가 '번들 폴더에서 실행' 병행 경로에서만 동작. `$CLAUDE_PROJECT_DIR` 는 그 번들 루트로 해석됨.
- **user-level**(`setup/user-install.mjs` 가 emit): command = `"<node>" "$HOME/.lively/hooks/<script>.mjs"` — **절대경로**.
  `<node>` 는 번들 런타임(`~/.lively/runtime/current/bin/node`)이 있으면 그 절대경로, 없으면 `node`(#355). Windows 는 `node "<절대경로>"`.
  `$CLAUDE_PROJECT_DIR` 는 user-level 에서 미정의/실행 레포로 잘못 해석되므로 절대경로 필수.
  command 표기는 설치 세대마다 달라질 수 있어 idempotency 키는 command 전문이 아니라 **스크립트 파일명(+인자)+matcher** 다 — 같은 키의 구표기 lively 항목은 재설치 때 최신형으로 교체돼 한 벌만 남는다(`session-preload` 도 매 세션 같은 규칙으로 dedup).

`~/.claude/settings.json` 의 다른 Stop 훅(예: tmux)·env·permissions·enabledPlugins·theme 는 보존된다.

## managed 강제층 (선택, D6)

`managed-settings.example.json` — 홈/managed 경로로 강제 규칙을 박고 싶을 때(규제 T3~T4). incognito(`LIVELY_OFF`)로도 안 꺼지는 계층이므로 "끄고 싶은 것"과 분리 설계.

## 정적 컨텍스트 갱신

`context.md` 는 설치 시 1회 시드되고, 이후 `session-preload` 가 매 세션 게이트웨이에서 조직 맥락을 받아 주입하면서 이 파일을 갱신한다(오프라인 폴백 캐시) — 관리 웹 UI 편집이 재설치 없이 다음 세션에 반영된다. 라이브 현황도 세션마다 자동 갱신.
