<!--
  비인간 주체(에이전트/시스템) 신원 바인딩 — context-ontology load-bindings 전용 레코드.
  ──────────────────────────────────────────────────────────────────────
   · 멤버 프로필이 없는 주체(봇·동기화 시스템 등)만 여기 둡니다. 사람은 각자 members/<id>.md frontmatter 로.
   · 언더스코어 접두(_bindings.md) = 멤버 아님 컨벤션 → --publish 가 복사하지 않습니다(소스 전용).
   · email 은 소스 간 조인 키 — 커넥터가 숫자 user-id 를 관측하기 전까지 email 을 external_id 로 겸용 가능.
   · 선택 파일: 비인간 주체가 없으면 이 파일을 비워 두거나 지워도 됩니다.

  예시(지우고 실제 주체로 채우거나, 없으면 bindings: [] 로 비우세요):
-->
---
bindings: []
#  - id: <봇-슬러그>
#    kind: agent
#    display_name: <봇 표시 이름>
#    identities:
#      - system: <예: discord>
#        external_id: "<봇 사용자 ID>"
#      - system: <예: PM툴>
#        external_id: <bot@example.com>
#        email: <bot@example.com>
---
