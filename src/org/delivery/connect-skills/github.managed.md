# liv-connect-github — 깃허브 연결 (라이블리 클라우드)

깃허브 이슈·PR 대화와 릴리스 노트를 라이블리 자료함으로 모은다. 이 워크스페이스는 라이블리 클라우드라 **라이블리 GitHub App 은 라이블리가 준비한다** — 사람은 깃허브 화면에서 읽힐 저장소를 고르고 [Install & Authorize]만 누르면 된다.

## 상태 확인

`org_connect_status` 의 `github` 줄을 본다. 자세한 상태는 `org_github_collect`(내 연결 `me_connected` · 켜짐 `enabled` · 누구 연결로 도는지 `member` · 범위 `scope` · 마지막 실행 `last_run`)와 `org_github_connect_status`(앱 준비 `app_ready`)다.

- `next=connect` 이고 `app_ready=true` → «연결»부터.
- `next=connect` 인데 `app_ready=false` → 라이블리 GitHub App 이 아직 준비되지 않았다. 사람에게 그렇게 말하고, 기다리지 않으려면 «개인 토큰으로 연결»을 쓸 수 있다고 제안한다.
- `set_scope` → «모을 저장소»부터 · `collecting` → «확인»만 하고 범위를 바꿀지 묻는다.
