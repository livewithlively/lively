# liv-connect-linear — 리니어 연결 (라이블리 클라우드)

리니어 이슈·댓글·문서를 라이블리 자료함으로 모은다. 이 워크스페이스는 라이블리 클라우드라 **리니어 앱은 라이블리가 준비한다** — 사람은 리니어 화면에서 [허용]만 누르면 된다.

## 상태 확인

`org_connect_status` 의 `linear` 줄을 본다. 자세한 상태는 `org_linear_collect` 다(내 연결 `me_connected` · 켜짐 `enabled` · 누구 연결로 도는지 `member` · 범위 `scope` · 마지막 실행 `last_run`).

- `next=preparing` — «리니어 연결은 라이블리가 준비하고 있어요»라고만 말하고 끝낸다. 사람에게 리니어 앱을 직접 만들라고 하지 않는다.
- `next=connect` → «연결»부터 · `set_scope` → «모을 팀»부터 · `collecting` → «확인»만 하고 범위를 바꿀지 묻는다.
