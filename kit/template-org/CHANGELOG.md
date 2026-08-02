# template-org CHANGELOG

조직콘텐츠 골격(template-org)의 버전 이력. 새 조직은 `--init` 으로 *현재 버전* 을 한 번 복사할 뿐이며,
이후 자기 레포를 자유롭게 편집합니다(template-org 를 다시 당기지 않음 → git-pull 충돌 0).

제품이 새 조직콘텐츠 필드를 기대하게 되면 여기에 항목을 추가하고 VERSION 을 올립니다.
기존 조직은 `--check <org-dir>` 가 "init 버전 → 현재 버전" 차이를 보고하면, **원하는 항목만 opt-in** 합니다(강제 아님).
생성기는 누락 필드/파일에 관대(누락 → 기본/스킵)하므로, 옛 버전에서 init 한 조직콘텐츠도 계속 빌드됩니다.

## VERSION 1 (초기)
- `org/org-defaults.md` (필수) — 회사·페르소나·업무방식.
- `org/managed-policy.md` (선택) — 강제 규칙 템플릿.
- `memory/MEMORY.md` (선택) — 빈 캐노니컬 인덱스.
- `members/_template.md`, `members/_bindings.md` — 멤버/바인딩 견본(email = 소스 조인 키).
- `gateway-url` — 사내 MCP 게이트웨이 주소 placeholder.
