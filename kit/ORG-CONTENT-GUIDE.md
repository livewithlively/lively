# ORG-CONTENT-GUIDE — 조직콘텐츠 작성 가이드

조직콘텐츠(`<org>-org`)는 제품(`workflow-std`)의 **입력**입니다(파일 기반 배포 경로).
이 문서는 각 파일이 무엇이고 무엇을 쓰는지, 새 조직을 어떻게 부트스트랩하는지 설명합니다.
> ※라이블리 인스턴스는 조직콘텐츠를 **게이트웨이 DB(위키)** 에 두고 `/install` 로 배포한다(파일 레포 `lively-org` 폐기, 2026-06-24). 이 가이드는 `--init`/`--publish` 파일 기반 경로(다른 조직·이식)용.
전체 구조·생애주기는 위키 참조 — `knowledge_grep "architecture"`.

> **핵심 모델:** 조직콘텐츠는 제품 안 `template-org` 를 **1회 init** 해서 만든 독립 레포입니다.
> 이후 template-org 를 다시 당기지 않습니다(별개 레포 → git-pull 충돌 0). 진화는 `--check` + CHANGELOG opt-in.

---

## 1. 파일 구성

| 파일 | 무엇 | 필수? | 합성 위치 |
|---|---|---|---|
| `org/org-defaults.md` | 회사 맥락·에이전트 페르소나·업무 방식 | **필수** | CLAUDE.md(@import)·AGENTS.md(inline) 본문 |
| `org/managed-policy.md` | 강제(오버라이드 불가로 의도)·짧은 규칙 | 선택 | 합성본 **최상단**(최우선) |
| `memory/MEMORY.md` | 캐노니컬 메모리 인덱스(+`memory/*.md` 본문) | 선택 | 합성 끝(링크된 md 는 1-depth 함께 발행) |
| `members/<id>.md` | 사람 한 명당 프로필 + 신원 frontmatter | 권장 | 발행물에 `_template.md` 견본만 복사(개인파일 비유출) |
| `members/_template.md` | 새 사람이 베껴 쓰는 견본(언더스코어=멤버 아님) | 권장 | 발행물에 그대로 복사 |
| `members/_bindings.md` | 비인간 주체(봇·시스템) 신원 바인딩 | 선택 | 발행 안 함(소스 전용, 게이트웨이 load-bindings 가 읽음) |
| `members/local.md` | 개인 레이어(각자 `_template.md` 복사) | 선택 | gitignore — 커밋·발행 안 함 |
| `gateway-url` | 사내 MCP 게이트웨이 주소 | 선택 | 파일 자체는 미발행(setup 가 멤버 머신에 주입) |

### 작성 규칙
- **`org/org-defaults.md`** 가 유일한 하드 필수입니다(합성 코어). 나머지는 없으면 생성기가 **스킵**(에러 아님).
- **`org/managed-policy.md`** 는 합성 최상단에 항상 로드되므로 **짧고 절대적인 규칙만**(5~7개 이내 권장). 권장 사항은 org-defaults 로.
  - 실제 '오버라이드 불가' 강제력은 텍스트가 아니라 Claude managed-settings / Codex `requirements.toml` 배포로 얻습니다(`adapters/claude/managed-settings.example.json` 참고). 그냥 두면 권장 규칙으로 합성됩니다.
- **합성 AGENTS.md 는 32KiB 이하**여야 합니다(Codex 글로벌 인스트럭션 한도). `--check` 가 검사·차단.
- **`members/` frontmatter 의 `email` = 소스 간 조인 키**입니다(discord/slack/PM툴/notion 에서 같은 사람을 자동 매칭). human 멤버에 email 이 없으면 `--check` 가 경고합니다.
- `@import` 줄을 member/org 파일에 쓰지 마세요 — 생성기가 합성을 알아서 합니다.

---

## 2. 새 조직 부트스트랩 체크리스트

```
init → fill → set gateway-url → check → publish → distribute
```

1. **init** — 빈 디렉토리에 골격 복사:
   ```bash
   node workflow-std/generator/build-context.mjs --init ../acme-org
   ```
   (비어있지 않으면 거부 — `--force` 로 덮어쓰기 가능, `.git` 은 보존. `.template-version` 이 스탬프됩니다.)
2. **fill** — `org/org-defaults.md`·`org/managed-policy.md`·`members/<id>.md` 의 `<placeholder>` 를 실제 내용으로 채웁니다.
3. **set gateway-url** — `gateway-url` 파일에 사내 MCP 게이트웨이 주소를 한 줄로(없으면 비워둠 → 컨텍스트만, 라이브 데이터 제외).
   - 또는 setup 의 `ORG_DEFAULT_URL`(mac) / `McpUrl`(windows) 로 멤버 배포 시 주입. 멤버 머신에선 `~/.lively/gateway-url` 로 기록됩니다.
4. **check (doctor)** — 누락·placeholder·린트 점검(읽기전용):
   ```bash
   node workflow-std/generator/build-context.mjs --check ../acme-org
   ```
5. **publish** — 멤버 배포물(설치 아티팩트) 조립:
   ```bash
   node workflow-std/generator/build-context.mjs --org ../acme-org --publish ../acme-context-setup --harness claude
   # 다중 하네스:  --harness claude,codex
   ```
6. **distribute** — 발행물 레포를 멤버가 clone → `bash setup/setup-mac.sh`(또는 windows ps1) 1회 → 어느 폴더에서 켜든 컨텍스트+리플렉스 수령. 토큰은 관리자가 안전 채널로 개별 전달.

> git init/remote/commit 은 생성기가 하지 않습니다 — 오퍼레이터가 조직콘텐츠·발행물을 각각 독립 레포로 만듭니다.

---

## 3. 진화 (제품이 새 필드를 기대하게 될 때)

조직콘텐츠는 template-org 를 추적하지 않으므로 **git merge 충돌이 없습니다**. 대신:

1. 생성기는 누락 파일/필드에 **관대**합니다(누락 → 기본/스킵, 크래시 아님). 옛 버전에서 init 한 조직콘텐츠도 계속 빌드됩니다.
2. `--check <org-dir>` 가 `.template-version`(init 시 스탬프) 과 현재 `template-org/VERSION` 을 비교해
   **"init 이후 새로 생긴 옵션 필드"** 를 보고합니다.
3. `template-org/CHANGELOG.md` 에서 무엇이 추가됐는지 읽고, **원하는 것만 opt-in**(강제 아님)합니다.

`--check` 가 보고하는 것:
- 누락-필수(`org/org-defaults.md`) · 누락-권장(managed-policy·MEMORY·_template)
- `.template-version` 부재/불일치(신규 옵션 안내)
- 린트: members human email 누락 · managed-policy 과다 길이 · 합성 AGENTS 32KiB 초과(차단 에러)
- placeholder 미작성 · gateway-url 부재

---

## 4. 메모리 큐레이션

```
세션 중 auto-memory(로컬·개인) → 검토(PR) → 승인/중복제거/스코프
                                          → canonical 승격 → memory/ 커밋 → 재발행 → 전원 setup 재실행
```
캐노니컬(정설)만 `memory/MEMORY.md` 인덱스에 한 줄/항목으로. 본문은 `memory/<name>.md`.
