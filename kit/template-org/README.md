# template-org — 새 조직콘텐츠 골격 (제품 내장, 1회성 INIT 소스)

이 디렉토리는 제품(`workflow-std`)에 내장된 **조직콘텐츠 골격**입니다. 새 조직을 시작할 때
`generator --init <dir>` 가 이 골격을 **새 독립 레포로 복사**합니다. 복사 이후 그 레포는 조직 소유이며,
template-org 를 다시 당기지 않습니다(별개 레포 → git-pull 충돌이 구조적으로 0).

> **베이스가 아닙니다.** 조직콘텐츠는 template-org 를 extend/track 하지 않습니다 — 1회 복사 후 독립.
> 진화(미래 제품이 새 필드 기대)는 git merge 가 아니라 `--check`(doctor) + CHANGELOG opt-in 으로 다룹니다.

## 무엇이 들어있나 (전부 placeholder — 특정 조직 내용 없음)

| 파일 | 무엇 | 필수? |
|---|---|---|
| `org/org-defaults.md` | 회사 맥락·페르소나·업무방식 | **필수**(생성기 합성 코어) |
| `org/managed-policy.md` | 강제 규칙 템플릿(짧게) | 선택 |
| `memory/MEMORY.md` | 빈 캐노니컬 메모리 인덱스 | 선택 |
| `members/_template.md` | 멤버 프로필 견본(email=조인 키) | 권장 |
| `members/_bindings.md` | 비인간 주체 바인딩 견본 | 선택 |
| `gateway-url` | 사내 MCP 게이트웨이 주소 placeholder | 선택 |
| `VERSION` / `CHANGELOG.md` | 골격 버전 + 이력(init 시 `.template-version` 으로 스탬프) | (제품 메타 — 복사 안 됨) |

## 새 조직 부트스트랩

```bash
# 1) 골격 복사(빈 디렉토리에)
node workflow-std/generator/build-context.mjs --init ../acme-org
# 2) <placeholder> 를 실제 회사 내용으로 채우기 (org/ · members/ · gateway-url)
# 3) 점검(doctor)
node workflow-std/generator/build-context.mjs --check ../acme-org
# 4) 발행 → 멤버 배포물
node workflow-std/generator/build-context.mjs --org ../acme-org --publish ../acme-context-setup --harness claude
```

자세한 작성 가이드: 제품 루트의 `ORG-CONTENT-GUIDE.md`.
