# Lively 플러그인

*[English](README.md)*

조직의 **맥락 스토어**(지식·프로젝트·도메인맵)를 AI 세션에 잇는다. 라이블리 게이트웨이가 있어야 동작한다.

## 설치

```
/plugin marketplace add livewithlively/lively
/plugin install lively@lively
```

활성화하면 **게이트웨이 주소** 하나를 묻는다(`https://lively.회사도메인` 또는 매니지드 워크스페이스 주소. `/mcp` 는 붙이지 않는다). 바꾸려면 `/plugin` → `lively` → 설정.

그다음 로그인한다 — 토큰을 복붙할 필요 없이 브라우저 승인으로 끝난다.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/login.mjs"
```

토큰은 `~/.lively/token`(0600)에 저장되고, MCP 헤더와 훅이 **같은 파일**을 읽는다.

새 버전을 받으려면 `/plugin marketplace update lively` 뒤 `/reload-plugins`(또는 새 세션). 서드파티 마켓플레이스의 백그라운드 자동 갱신은 직접 켜지 않으면 꺼져 있다.

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

- 훅 스크립트 = `kit/hooks/*.mjs` + 그 훅이 import 하는 모듈(`harness-registry.mjs`·`host-effects-port.mjs`) + `hooks/` 밖 공유 모듈(`kit/setup/host-effects.mjs` → `lib/host-effects.mjs`, 설치 트리와 같은 자리)
- **훅 배선표**(`hooks/hooks.json`) = `kit/setup/user-install.mjs` 의 `userLevelHooksBlock()` + `runnerHooksBlock()` 에서 **생성**하고 경로만 `${CLAUDE_PLUGIN_ROOT}` 로 옮긴다. 손으로 고치지 않는다. `kit/hooks/settings-hooks.json` 은 PROJECT-DIR 템플릿(발행물의 '번들 폴더에서 실행' 병행 경로·`--install-hooks` 용)이라 정본이 아니다
- 조직 스킬 = 게이트웨이 `org_harness_assets` (편집은 중앙에서 — 로컬 사본을 고치면 다음 빌드에 덮인다)

`kit/hooks/` 나 `user-install.mjs` 의 배선을 바꿨으면 `node scripts/build-plugin.mjs` 를 돌려 결과를 함께 커밋한다. `scripts/build-plugin.test.mjs` 가 사본이 `kit/` 와 다르거나, `hooks.json` 이 생성본과 다르거나, 훅이 플러그인 트리에 없는 파일을 import 하면 CI 를 떨어뜨린다(마지막 경우는 설치본의 훅이 전부 `ERR_MODULE_NOT_FOUND` 로 죽는다).

**`.claude-plugin/plugin.json` 의 `version` 은 빌드 스크립트가 올린다 — 손으로 고치지 않는다.** Claude Code 는 설치된 플러그인을 갱신할지 이 문자열로 정한다. 버전을 고정해 두면 설치한 사람은 그 문자열이 바뀔 때까지 캐시된 사본에 머문다(«a manifest that pins `version` … keeps every user on the cached copy until its author changes the string» — [Claude Code 문서](https://code.claude.com/docs/en/plugins/loading)). 빼면 커밋 SHA 가 버전이 되지만 `claude plugin validate --strict` 가 실패한다. 그래서 `build-plugin.mjs` 가 플러그인 내용의 해시를 내어 해시가 바뀔 때마다 패치 버전을 올리고, 그 짝을 `scripts/build-plugin.version.json` 에 적는다. 내용이 바뀌었는데 버전이 그대로면 테스트가 실패한다. 마켓플레이스 항목에는 `version` 을 두지 않는다(둘 다 있으면 `plugin.json` 이 경고 없이 이긴다). 2026-08-04 부터 2026-09-30 까지 `0.1.0` 에 머물러, 그 사이 설치본은 이후 변경을 하나도 받지 못했다.

`run-custom` 은 이벤트당 고정 엔트리 하나이고 커스텀 훅 자체는 런너가 런타임에 게이트웨이에서 받아온다 — 조직이 훅을 추가·삭제해도 배선표를 다시 쓸 필요가 없고, 비활성화하면 다음 세션에 즉시 무효가 된다(kill-switch).

> ⚠ **플러그인 루트에 `bin/` 디렉터리를 만들지 말 것**(2026-08-04 실측). claude.ai 마켓플레이스 싱크가 `bin/` 이 있는 플러그인을 거부한다 — 내용·파일모드 무관이고, 안에 평문 .txt 하나만 있어도 거부된다. `scripts/`·`hooks/` 는 정상이라 스크립트는 `scripts/` 에 둔다. 로컬 `claude plugin validate --strict`·공개 JSON 스키마·CLI 원격설치는 전부 통과하므로 이 함정은 웹에서만 드러난다. 상세: WIKI `claude-marketplace-sync-rejects-bin-dir`
>
> 주석 키(`_comment` 등)는 무해함이 확인됐지만(공식 훅 파일도 `hooks` 옆에 `description` 을 둔다) 이 문서가 주석을 대신 담는 편이 읽기 좋다.

복제는 빌드 스크립트가 한다.

```
node scripts/build-plugin.mjs            # 훅만
node scripts/build-plugin.mjs --skills   # 스킬까지(게이트웨이 토큰 필요)
```

동봉 스킬 목록은 `bundled-skills.json` 이 정한다 — 제외 사유도 그 파일에 적혀 있다.
