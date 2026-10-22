# liv-connect-notion — 노션 연결 (라이블리 클라우드)

노션 문서를 라이블리 지식으로 모은다. 이 워크스페이스는 라이블리 클라우드라 **노션 연결 앱은 라이블리가 이미 준비해 두었다** — 사람은 노션 화면에서 모을 페이지를 고르고 [액세스 허용]만 누르면 된다.

## 상태 확인

`org_connect_status` 의 `notion` 줄을 본다. 자세한 상태는 `org_notion_collect` 다(연결된 노션 워크스페이스 `workspaces[]` — 각 줄의 `enabled`·모은 페이지 수 `pages`·첫 수집이 끝났는지 `first_sync_done`).

- `next=preparing` — «노션 연결은 라이블리가 준비하고 있어요»라고만 말하고 끝낸다.
- `next=connect` → «연결»부터 · `collecting` → «확인»만 하고, 페이지를 더 고를지 묻는다.
- `next=set_scope` — 연결은 돼 있는데 수집이 꺼져 있다. 사람에게 말한 뒤 `org_notion_collect_set { enabled:true }` 로 켜고 «확인»으로 간다.
