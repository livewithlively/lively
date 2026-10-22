# liv-connect-slack — 슬랙 연결 (라이블리 클라우드)

슬랙 대화를 라이블리 자료함으로 모은다. 이 워크스페이스는 라이블리 클라우드라 **슬랙 앱은 라이블리가 이미 준비해 두었다** — 사람은 슬랙 화면에서 [허용]만 누르면 된다. 슬랙 앱을 직접 만들라고 안내하지 않는다.

## 상태 확인

`org_connect_status` 의 `slack` 줄을 본다. 자세한 상태는 `org_slack_collect` 다(내 연결 `me_connected` · 봇 설치 `bot.available` · 지금 모으는 채널 `channels` · 누구 연결로 도는지 `search.member` · 마지막 실행 `last_run`).

- `next=preparing` — «슬랙 연결은 라이블리가 준비하고 있어요. 준비가 끝나면 바로 연결할 수 있어요»라고만 말하고 끝낸다. 사람이 할 일은 없다.
- `next=connect` → «연결»부터 · `set_scope` → «모을 채널»부터 · `collecting` → «확인»만 하고 채널을 바꾸고 싶은지 묻는다.
