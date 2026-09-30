# lively kit

*[English](README.md)*

팀원 PC에 깔리는 **컨텍스트/리플렉스 하네스 키트**(org-agnostic) — 각자 쓰는 AI 도구(하네스)에 조직 맥락을 주입하고, 조직이 공유한 세팅(스킬·서브에이전트·커맨드·커스텀 훅)을 깔고, 작업 기록을 저장소로 돌려보낸다. 옛 이름은 `workflow-std` 이고, 생성물 헤더·설정 센티넬 문자열 등 코드 곳곳에 호환을 위해 그 이름이 남아 있다.
생성기는 조직콘텐츠를 *입력*으로 받아 그 조직의 설치 아티팩트를 빌드한다. 키트 자체에는 특정 조직의 내용이 없다 — 각 조직은 포크하지 않고 자기 조직콘텐츠로 같은 키트를 돌린다(설계문서 D1).

> **전달(2026-06-24~):** 라이블리 인스턴스는 조직콘텐츠를 **게이트웨이 DB(위키)** 에 두고, 멤버 설치를 게이트웨이 **`/install` 동적 번들** 한 경로로 단일화했다(구 `lively-org`·`context-setup` git 레포 폐기). 멤버는 설치 한 줄(`curl -fsSL <게이트웨이>/cli | sh`)로 `lively` CLI 를 받고, `lively install` 이 `/install` 번들을 내려받아 설치한다. 게이트웨이는 아래 generator 의 `buildKitBundle` 을 **in-process** 로 호출해 **조직콘텐츠 없는** 부트스트랩 번들(tar.gz)을 만든다 — 조직 맥락은 설치 시 1회 + 매 세션 게이트웨이에서 라이브로 받는다. 아래 `--publish <dir>` git 발행 CLI 는 그 **제네릭/이식 경로**(파일 기반 배포가 필요한 다른 조직용)다.

> 전체 구조·생애주기·제품 전략은 위키(knowledge) 참조 — `knowledge_grep "architecture"` / `knowledge_grep "service-overview"`. 조직콘텐츠 작성법은 **[ORG-CONTENT-GUIDE.ko.md](ORG-CONTENT-GUIDE.ko.md)**(이 레포 코드와 함께 버전드).

## 세 폴더 (설계문서 D1)

| 폴더 | 무엇 | 소유 |
|---|---|---|
| **제품**(이 `kit/` 디렉터리, 옛 `workflow-std`) | `lively` CLI + generator + 공유 훅 + 하네스 어댑터 + setup + `template-org/`(새 조직 init 소스) | 라이블리(버전드, 전 고객 공유) |
| **조직콘텐츠** `<org>-org` (= 입력) | `org/`·`members/`·`memory/`·`gateway-url`. **라이블리는 게이트웨이 DB(위키)** — 파일 기반 배포 시 git 레포 | 고객사 |
| **발행물**(설치 묶음) | 위 둘을 빌드한 설치 아티팩트. **라이블리는 `/install` 이 동적 생성**(git 레포 아님, 조직콘텐츠 없이 부트스트랩만); 파일 기반은 `--publish <dir>` | 고객사 인스턴스 |

## 구조

```
kit/
├─ cli/                           # lively CLI(lively.mjs) + 부트스트랩(bootstrap.sh·bootstrap.ps1 — 게이트웨이 /cli·/cli.ps1 이 서빙) + MCP stdio 프록시
├─ generator/build-context.mjs   # 코어: org-content 입력 → 발행 아티팩트 조립 + --init/--check
├─ hooks/                         # 공유 훅(하네스 무관) — 배선 훅 5종: session-preload · sync-harness-assets · work-flag · stop-writeback-gate
│                                 #   · run-custom(커스텀 훅 런너: org_hook 을 매 세션 게이트웨이 fetch·실행, 디스크 미저장, kill-switch)
│                                 #   + self-update(백그라운드 자가 업데이터) · usage-report(statusLine) · 하네스 어댑터(opencode-plugin.js · antigravity-adapter · grok-adapter)
│                                 #   + 공유 모듈(harness-registry · host-effects-port) — 설치 목록 정본은 setup/kit-manifest.mjs
│                                 #   + settings-hooks.json(PROJECT-DIR 템플릿) · test-hooks.sh · examples/(조직 커스텀 훅 예시)
├─ adapters/
│  ├─ claude/                     # 하네스별 제거기(uninstall.mjs) + managed 예시 · 배선 문서
│  ├─ codex/                      # 〃 (설치 정본은 setup/user-install.mjs 하나 — 어댑터 설치기는 #1475 에서 삭제)
│  └─ opencode/ · antigravity/ · grok/   # 하네스별 제거기(uninstall.mjs)
├─ template-org/                  # 새 조직콘텐츠 1회성 INIT 소스(generic 골격, 라이블리 특정 내용 없음)
├─ setup/                         # 설치 엔진(user-install.mjs)·제거기 + 가이드 + vendored register-clients.sh
├─ aws/                           # AWS credential_process 헬퍼(게이트웨이에서 단기 AWS 자격 발급)
├─ testlib/                       # 테스트 샌드박스 격리 헬퍼
└─ ORG-CONTENT-GUIDE.ko.md        # 조직콘텐츠 각 파일 작성법 + 새 조직 부트스트랩 체크리스트
```

## CLI

```bash
# 발행 (파일 기반 — git 레포 등 <publish-dir> 로. ※라이블리 멤버 설치는 게이트웨이 /install 이라 이 단계 불필요)
node generator/build-context.mjs --org ../<org>-org --publish ../<publish-dir> --harness claude

# 소스 레포 루트에도 CLAUDE.md/AGENTS.md 생성(소스 안에서 실행 편의)
node generator/build-context.mjs --org ../<org>-org --publish ../<publish-dir> --emit-root

# 새 조직콘텐츠 골격 생성(template-org → 새 독립 레포로 복사)
node generator/build-context.mjs --init ../acme-org

# 조직콘텐츠 점검(doctor) — template-org 대비 차이·린트, 읽기전용
node generator/build-context.mjs --check ../<org>-org

# 훅만 설치(독푸드)
node generator/build-context.mjs --org ../<org>-org --install-hooks <dir> [<dir>…]
```

| 플래그 | 의미 |
|---|---|
| `--org <dir>` | 조직콘텐츠 디렉토리(발행/훅설치 시 필수). `org/` 존재 확인. |
| `--publish <dir>` | 발행 아티팩트 타깃. idempotent(.git·members/local.md 보존 후 재조립). |
| `--harness claude\|codex\|opencode\|antigravity\|grok` | 발행물에 emit 할 하네스 설정(기본 claude). `claude,codex` 다중 가능. claude 외 하네스는 발행물 전용 파일이 없고 동봉 user-install.mjs 가 배선하므로 claude 와 함께 발행한다. |
| `--org-name <name>` | 헤더 표시명 오버라이드(미지정 시 `org/org-defaults.md` 의 `org-name:` frontmatter → 첫 H1 → 디렉토리명). |
| `--emit-root` | `--org` 루트에도 CLAUDE.md/AGENTS.md 생성(선택, 소스 레포 내부 dogfood). |
| `--install-hooks <dir>…` | 각 디렉토리에 PROJECT-DIR 훅만 비파괴 머지. |
| `--init <dir> [--force]` | `template-org` → 새 독립 조직콘텐츠 레포로 복사(빈 디렉토리 요구, `.template-version` 스탬프). |
| `--check <dir>` | doctor — template-org 대비 누락-필수/신규-옵션 + 린트(members email, managed-policy 길이, AGENTS 32KiB). 읽기전용. |

`GATEWAY_DIR` env 로 register-clients.sh 캐노니컬 위치 오버라이드(기본: 제품 옆 `../lively`(구 설치는 `../context-ontology` 폴백); 없으면 `setup/register-clients.sh` vendored 사본 폴백).

## 조직콘텐츠 진화 (template-org 모델)

`template-org` 는 새 조직의 **1회성 INIT 소스**일 뿐 — 조직콘텐츠가 extend/track 하는 베이스가 아니다. `--init` 이 복사하면 그 레포는 조직 소유로 독립(별개 레포 → git-pull 충돌 0). 미래 제품이 새 필드를 기대하면: 생성기는 누락 필드/파일에 관대(누락→기본/스킵), `--check` 가 차이를 보고, `template-org/VERSION`+`CHANGELOG.md` 로 조직이 원하는 것만 opt-in. 자세히는 위키 참조(`knowledge_grep "architecture"`).

## 전달 = user-level 훅 (설계문서 D2/D3)

설치기(`setup/user-install.mjs` — 보통 `lively install` 이 부른다)가 **user-level**(`~/.lively/` + 하네스별 설정: `~/.claude/settings.json` · `~/.codex/config.toml` · OpenCode·Antigravity·Grok 설정)에 설치 → 멤버는 어느 폴더에서 켜든 컨텍스트+리플렉스를 받는다. 실행 디렉토리는 무의미.

- **컨텍스트**: `session-preload`(SessionStart)가 게이트웨이에서 조직 맥락(`/api/ui/org/preview`)과 라이브 현황을 받아 주입. 받은 맥락은 `~/.lively/context.md` 에 캐시해 게이트웨이에 못 닿는 세션의 폴백으로 쓴다(설치 시 1회 시드).
- **조직 자산**: `sync-harness-assets`(SessionStart)가 게이트웨이에 등록된 스킬·서브에이전트·커맨드를 하네스별 자리에 내려받는다(멤버 본인 자산은 불가침).
- **리플렉스**: work-flag(작업·기록 신호 + 세션 실행 단계 보고 — PostToolUse·UserPromptSubmit·Notification·Stop 등) + stop-writeback-gate(Stop, 라이트백 1회 게이트) + **run-custom**(런너 — 웹 관리에서 정의한 커스텀 훅 `org_hook` 을 매 세션 게이트웨이 fetch·실행, enabled=false/제거 시 다음 세션 즉시 무효=kill-switch).
- **incognito**: `LIVELY_OFF=1` (구 `LIVELY_HOOKS_OFF` alias) → 훅 전부(런너·자산 동기화·자가 업데이트 포함) no-op(클린룸).
- **자가 게이팅**: writeback 게이트는 'lively work' 세션에서만 — cwd 가 `~/.lively/work-roots` prefix 아래 OR 그 세션에서 lively MCP 툴 사용 시.

## 멀티하네스 (설계문서 D5)

훅 스크립트 한 벌 공유, 하네스별로 설정 파일만 다르게 emit. Claude·Codex·OpenCode·Antigravity·Grok Build 지원(#1475·#1519·#1689·#1701) — 하네스별 차이는 `hooks/harness-registry.mjs` 표 한 곳에 모은다. openclaw/pi 는 TODO.
