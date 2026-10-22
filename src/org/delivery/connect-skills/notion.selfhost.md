# liv-connect-notion — 노션 연결 (회사 직접 설치)

노션 문서를 라이블리 지식으로 모은다. 이 워크스페이스는 회사가 직접 설치한 라이블리라, **이 회사의 노션 공개 통합(Public integration)**을 한 번 만들어 라이블리에 등록해야 연결할 수 있다.

## 상태 확인

`org_connect_status` 의 `notion` 줄과 `prereq` 를 본다. 자세한 상태는 `org_notion_collect` 다(준비 `ready` · 연결된 노션 워크스페이스 `workspaces[]` — 각 줄의 `enabled`·`pages`·`first_sync_done`).

- `prereq.callback_url` 이 null 이면 입구 스킬(`liv-connect`)의 «공개 주소 넣기»부터 한다.
- `next=register_app` → «앱 등록»부터.
- `next=ask_admin` → «라이블리 관리자가 먼저 노션 통합을 등록해야 해요»라고 말하고, 관리자에게 보낼 한 줄을 적어 준다: «라이블리에서 ‹노션 연결해줘›라고 말하면 노션 통합 등록을 안내받을 수 있어요.» 여기서 끝낸다.
- `next=connect` → «연결»부터 · `collecting` → «확인»만 하고, 페이지를 더 고를지 묻는다.
- `next=set_scope` — 연결은 돼 있는데 수집이 꺼져 있다. 사람에게 말한 뒤 `org_notion_collect_set { enabled:true }` 로 켜고 «확인»으로 간다.

## 앱 등록 (한 번만)

1. 사람에게: «https://www.notion.so/profile/integrations 를 열고 [새 통합 만들기]를 눌러 주세요. 유형은 **공개(Public)**로 골라 주세요.» 노션 워크스페이스 관리자 계정이어야 한다.
2. 필수 칸(회사 이름·웹사이트 등)을 채우고, **리디렉션 URI** 에 `prereq.callback_url` 값을 그대로 넣게 한다.
3. 기능(Capabilities)은 **콘텐츠 읽기**와 **댓글 읽기**를 켜게 한다. 쓰기 기능은 켜지 않는다 — 라이블리는 읽기만 한다.
4. 저장 뒤 **OAuth 클라이언트 ID** 와 **OAuth 클라이언트 시크릿**을 확인하게 한다.
5. 라이블리에 등록한다 — **화면에서 하게 안내한다**: `connect_url`(노션 화면) ▸ «자료 가져오기» ▸ «통합 값 저장» 칸에 두 값 입력 ▸ [저장]. 라이블리 관리자만 저장할 수 있다(아니면 저장할 때 권한 오류가 난다).
   - 사람이 대화로 하겠다고 하면(공통 규칙 6의 경고를 먼저 하고): `org_credential_set { kind:"notion_public", scope_key:"oauth:client", secret:"{\"client_id\":\"…\",\"client_secret\":\"…\"}" }` — 라이블리 관리자만.
6. `org_connect_status` 를 다시 불러 `notion.app_ready=true` 인지 확인하고 «연결»로 간다.
