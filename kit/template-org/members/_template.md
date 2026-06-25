<!--
  멤버 프로필 템플릿 — 사람 한 명당 파일 하나(members/<id>.md).
  ──────────────────────────────────────────────────────────────────────
   · 이 파일(_template.md)은 언더스코어 접두 = '멤버 아님' 컨벤션 → 발행 시 그대로 복사되어 새 사람이 베껴 쓰는 견본.
   · 새 사람: 이 파일을 members/<id>.md 로 복사하고 frontmatter + 본문을 채우세요(id 는 소문자 슬러그).
   · 개인 선호만 쓰고 싶으면 members/local.md 로 복사하세요(gitignore — 커밋 안 됨, 발행물 미포함).
   · @import 줄은 쓰지 마세요 — 생성기가 org/memory 합성을 알아서 합니다. 여긴 '개인 것'만.

  frontmatter(신원 바인딩 — context-ontology load-bindings 가 읽는 ground truth):
   · id          : 안정적 소문자 슬러그(예: jdoe). 한 번 정하면 바꾸지 마세요(조인 키).
   · kind        : human | agent | system
   · display_name: 표시 이름
   · identities  : 이 사람의 외부 시스템 신원 목록.
       - **email 은 소스 간 조인 키입니다** — discord/slack/PM툴/notion 등에서 같은 사람을 자동 매칭하는 핵심.
         커넥터가 숫자 user-id 를 관측하기 전까지 email 을 external_id 로 겸용할 수 있습니다.
       - human 멤버에 email 이 없으면 --check 가 경고합니다(자동 매칭이 깨짐).
-->
---
id: <소문자-슬러그>
kind: human
display_name: <표시 이름>
identities:
  - system: <예: discord>
    external_id: "<해당 시스템의 사용자 ID>"
    email: <work@example.com>
  # - system: <예: slack 또는 PM툴>
  #   external_id: <ID 또는 email>
  #   email: <work@example.com>
---

# <표시 이름> — 개인 레이어

## 프로필
- **역할:** <예: 프로덕트 매니저 / 디자이너 / 공동대표>
- **개발 경험:** <비개발자 / 주니어 / 시니어 — 응답 깊이 조절 기준>

## 개인 선호
- **호칭/말투:** <예: 편하게 반말 / 존댓말>
- **응답 길이:** <예: 결론 먼저 짧게 / 자세히>
- **자주 쓰는 도구·레포:** <예: 결제 서비스, PM 보드>

## 담당 영역
- <예: 결제 도메인, 온보딩 플로우 …>
