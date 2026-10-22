# liv-connect-google — 구글 연결 (라이블리 클라우드)

구글 드라이브 문서와 지메일을 라이블리 자료함으로 모은다(캘린더는 모으지 않고 AI 도구로만 쓴다). 이 워크스페이스는 라이블리 클라우드라 **구글 연결 앱은 라이블리가 준비한다** — 사람은 구글 화면에서 [허용]만 누르면 된다.

## 상태 확인

`org_connect_status` 의 `google` 줄을 본다. 자세한 상태는 `org_google_collect` 다(준비 `ready` · 내 연결 `connected` · 서비스별 수집기 `collectors[]` — `service`·`enabled`·동의 범위 `scope_ok` · 미검증 앱 인원 한도를 쓰는지 `consumes_user_cap`).

- `next=preparing` — «구글 연결은 라이블리가 준비하고 있어요»라고만 말하고 끝낸다. 사람에게 구글 클라우드에서 앱을 만들라고 하지 않는다.
- `next=connect` → «연결»부터 · `set_scope` → «모을 범위»부터 · `collecting` → «확인»만 하고 범위를 바꿀지 묻는다.
