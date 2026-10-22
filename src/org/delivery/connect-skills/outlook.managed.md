# liv-connect-outlook — 아웃룩 연결 (라이블리 클라우드)

아웃룩 메일(Microsoft 365 회사 계정·outlook.com 개인 계정)을 라이블리 자료함으로 모은다. 일정은 모으지 않고 AI 도구로만 쓴다. 이 워크스페이스는 라이블리 클라우드라 **Microsoft 연결 앱은 라이블리가 준비한다** — 사람은 Microsoft 화면에서 [허용]만 누르면 된다(회사 계정은 회사 관리자의 허용이 먼저 필요할 수 있다).

## 상태 확인

`org_connect_status` 의 `outlook` 줄을 본다. 자세한 상태는 `org_outlook_collect` 다(앱 준비 `app_ready` · 내 연결 `me_connected` · 켜짐 `enabled` · 누구 연결로 도는지 `member` · 관리자에게 보낼 링크 `admin_consent_url` · 마지막 실행 `last_run`).

- `next=preparing` — «아웃룩 연결은 라이블리가 준비하고 있어요»라고만 말하고 끝낸다. 사람에게 Microsoft 앱을 직접 등록하라고 하지 않는다.
- `next=connect` → «연결»부터 · `set_scope` → «켜기»부터 · `collecting` → «확인»만.
