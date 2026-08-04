# Lively 플러그인

조직의 **맥락 스토어**(지식·프로젝트·도메인맵)를 AI 세션에 잇는다. 라이블리 게이트웨이가 있어야 동작한다.

## 설치

```
/plugin marketplace add livewithlively/lively
/plugin install lively@lively
```

활성화하면 **게이트웨이 주소** 하나를 묻는다(`https://lively.회사도메인` 또는 매니지드 워크스페이스 주소. `/mcp` 는 붙이지 않는다). 바꾸려면 `/plugin` → `lively` → 설정.

그다음 로그인한다 — 토큰을 복붙할 필요 없이 브라우저 승인으로 끝난다.

```bash
node "$CLAUDE_PLUGIN_ROOT/bin/login.mjs"
```

토큰은 `~/.lively/token`(0600)에 저장되고, MCP 헤더와 훅이 **같은 파일**을 읽는다.

> **왜 토큰을 `userConfig` 로 안 받나** — `sensitive: true` 값은 **훅 프로세스 env 로 전달되지 않는다**(2026-08-04 실기기 실측. 공식 문서의 "All values are exported to hook processes" 와 다르다). 토큰을 설정으로 받으면 MCP 는 붙지만 조직 맥락 주입·스킬 배포·거버넌스 훅·상태 보고가 전부 인증에 실패한다. 그래서 토큰의 단일 출처를 파일로 두고 MCP 는 `headersHelper` 로 그 파일을 읽는다.

## 무엇이 들어 있나

| 구성 | 하는 일 |
|---|---|
| **MCP 서버** | 게이트웨이의 지식·프로젝트·도메인맵·DB 툴을 세션에 노출 |
| **SessionStart 훅** | 세션 시작 시 조직 맥락(카테고리·WIKI 인덱스·페르소나·내 신원)을 주입하고, 게이트웨이에 등록된 조직 스킬·서브에이전트를 내려받는다 |
| **실행 단계 보고 훅** | 게이트웨이가 화면 스크래핑 없이 '작업 중 / 확인 필요 / 대기 중'을 알 수 있게 세션 상태를 얇게 보고 |
| **기록 게이트 훅** | 세션이 끝날 때 남길 맥락이 있으면 기록하도록 게이트 |
| **스킬 번들** | 온보딩·분류체계 정립·파이프라인 점검·프로젝트 마무리 등 라이블리 운영 스킬 |

게이트웨이에 **조직 고유 스킬**이 등록돼 있으면 첫 세션 이후 자동으로 추가된다 — 이 번들과 별개다.

## ⚠ 키트와 함께 쓰지 않는다

설치 경로가 둘이고 **둘 중 하나만** 쓴다.

- **플러그인**(이 저장소) — 마켓플레이스 설치. 훅·MCP 배선이 플러그인 안에 있다.
- **키트** — `curl -fsSL <게이트웨이>/cli | sh`. 훅을 `~/.lively/hooks/` 에 깔고 `~/.claude/settings.json` 을 비파괴 머지한다.

둘 다 깔면 같은 훅이 두 번 돈다. 키트를 이미 설치했다면 이 플러그인은 필요 없다.

## 유지보수 (이 저장소 기여자용)

플러그인이 담는 것들은 **진실원천이 딴 데 있다.**

- 훅 스크립트 = `kit/hooks/*.mjs`
- **훅 배선표**(`hooks/hooks.json`) = `kit/setup/user-install.mjs` 의 `userLevelHooksBlock()` + `runnerHooksBlock()` 을 `${CLAUDE_PLUGIN_ROOT}` 경로로 옮긴 것. 정본이 바뀌면 여기도 같이 고친다(빌드 스크립트는 배선표를 손대지 않고 참조 무결성만 검사한다). `kit/hooks/settings-hooks.json` 은 구 어댑터용 축약본이라 정본이 아니다
- 조직 스킬 = 게이트웨이 `org_harness_assets` (편집은 중앙에서 — 로컬 사본을 고치면 다음 빌드에 덮인다)

`run-custom` 은 이벤트당 고정 엔트리 하나이고 커스텀 훅 자체는 런너가 런타임에 게이트웨이에서 받아온다 — 조직이 훅을 추가·삭제해도 배선표를 다시 쓸 필요가 없고, 비활성화하면 다음 세션에 즉시 무효가 된다(kill-switch).

> ⚠ `.mcp.json`·`hooks/hooks.json` 에 `_comment` 같은 주석 키를 넣지 말 것. Claude Code 는 무시하지만(그래서 `claude plugin validate --strict` 도 통과한다) **claude.ai 마켓플레이스 싱크가 거부할 수 있다** — 그래서 이 문서가 주석을 대신 담는다.

복제는 빌드 스크립트가 한다.

```
node scripts/build-plugin.mjs            # 훅만
node scripts/build-plugin.mjs --skills   # 스킬까지(게이트웨이 토큰 필요)
```

동봉 스킬 목록은 `bundled-skills.json` 이 정한다 — 제외 사유도 그 파일에 적혀 있다.
