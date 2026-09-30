# Claude 하네스 배선

Claude Code 하네스용 설정을 emit 한다. **user-level 설치**가 주력(D2/D3): 한 번 설치하면 멤버가 어느 폴더에서 `claude` 를 켜든 조직 컨텍스트+리플렉스가 따라온다.

> **정본은 `setup/user-install.mjs` 다.** 이 폴더에 있던 `install.mjs` 는 아무도 호출하지 않는 죽은 코드라
> 삭제했다(#1475 — 그 존재가 "개선을 실배포 아닌 곳에 넣는" 사고를 코덱스 쪽에서 실제로 만들었다).
> 제거기(`uninstall.mjs`)와 managed 예시는 여기 그대로다. 코덱스 쪽 대응 문서는 `../codex/README.md`.

## 심는 것 (전부 idempotent)

| 산출물 | 내용 | 비고 |
|---|---|---|
| `~/.lively/context.md` | 정적 org-context (`buildStaticContext`) | **토큰/시크릿 없음.** `session-preload` 가 읽어 SessionStart 에 주입 |
| `~/.lively/hooks/*.mjs` | 공유 훅 3종 복사(chmod 755) | session-preload · work-flag · stop-writeback-gate |
| `~/.claude/settings.json` | **user-level** 훅 블록 비파괴 머지 | 백업 먼저(`~/.lively/backups/settings.json.bak`); hooks 외 키 무수정 |
| `~/.lively/work-roots` | 자가 게이팅 work-root 시드 | 없을 때만 생성, 기존 보존 |

MCP 등록은 **하지 않는다** — `setup/register-clients.sh`(`claude mcp add --scope user`)에 위임(중복 등록 방지).

## user-level vs project-dir 의 결정적 차이 (가장 큰 함정)

- **project-dir 템플릿**(`hooks/settings-hooks.json`): command = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<script>.mjs"`.
  발행물(`<번들>/.claude/`)에 들어가 '번들 폴더에서 실행' 병행 경로에서만 동작. `$CLAUDE_PROJECT_DIR` 는 그 번들 루트로 해석됨.
- **user-level**(이 어댑터가 emit): command = `node "$HOME/.lively/hooks/<script>.mjs"` — **절대경로**.
  `$CLAUDE_PROJECT_DIR` 는 user-level 에서 미정의/실행 레포로 잘못 해석되므로 절대경로 필수.
  command 문자열은 **단일 정규형($HOME 형)**으로 고정 — idempotency 키(command+matcher)가 안정되어 재설치 시 중복 entry 가 안 생긴다.

`~/.claude/settings.json` 의 다른 Stop 훅(예: tmux)·env·permissions·enabledPlugins·theme 는 보존된다.

## managed 강제층 (선택, D6)

`managed-settings.example.json` — 홈/managed 경로로 강제 규칙을 박고 싶을 때(규제 T3~T4). incognito(`LIVELY_OFF`)로도 안 꺼지는 계층이므로 "끄고 싶은 것"과 분리 설계.

## 정적 컨텍스트 갱신

`context.md` 는 설치 시 1회 발행 — 조직콘텐츠가 바뀌면 `setup` 재실행(또는 re-publish)으로 갱신. 라이브 현황은 세션마다 자동 갱신.
