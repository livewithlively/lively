# liv-connect-slack — 슬랙 연결 (회사 직접 설치)

슬랙 대화를 라이블리 자료함으로 모은다. 이 워크스페이스는 회사가 직접 설치한 라이블리라, **이 회사의 슬랙 앱**을 한 번 만들어 라이블리에 등록해야 구성원이 연결할 수 있다. 슬랙 앱은 슬랙 워크스페이스 관리자가 만들고, 라이블리 등록은 라이블리 관리자가 한다.

## 상태 확인

`org_connect_status` 의 `slack` 줄과 `prereq` 를 본다. 자세한 상태는 `org_slack_collect` 다(내 연결 `me_connected` · 봇 설치 `bot.available` · 지금 모으는 채널 `channels` · 누구 연결로 도는지 `search.member` · 마지막 실행 `last_run`).

- `prereq.callback_url` 이 null 이면 입구 스킬(`liv-connect`)의 «공개 주소 넣기»부터 한다 — 슬랙 앱이 돌아올 주소가 없으면 앱을 만들 수 없다.
- `next=register_app` → «앱 등록»부터.
- `next=ask_admin` → «라이블리 관리자가 먼저 슬랙 앱을 등록해야 해요»라고 말하고, 관리자에게 보낼 한 줄을 적어 준다: «라이블리에서 ‹슬랙 연결해줘›라고 말하면 슬랙 앱 등록을 안내받을 수 있어요.» 여기서 끝낸다.
- `next=connect` → «연결»부터 · `set_scope` → «모을 채널»부터 · `collecting` → «확인»만 하고 채널을 바꾸고 싶은지 묻는다.

## 앱 등록 (한 번만)

1. `org_slack_app_manifest` 를 부른다 → `create_url`(앱 만들기 링크)·`redirect_url`(돌아올 주소). 사람에게 말한다: «이 링크를 열고 회사 슬랙 워크스페이스를 고른 뒤 [Next] → [Create]를 눌러 주세요. 앱 이름·권한·돌아올 주소가 미리 채워져 있어요.» 슬랙 워크스페이스 관리자 계정이어야 만들 수 있다.
   - 앱이 요청하는 권한을 물으면: 봇은 초대받은 채널의 메시지·파일과 구성원 이름·이메일(사람 매칭용)만 읽는다. 사용자 권한은 각자 연결한 사람의 AI 가 그 사람 계정으로 슬랙을 검색·발송할 때 쓰고, 그 사람이 수집을 켜면 공개 채널 검색 수집에도 쓰인다.
2. 만들어진 앱의 **Basic Information** 화면에서 **Client ID** 와 **Client Secret** 을 확인하게 한다.
3. 라이블리에 등록한다 — **화면에서 하게 안내한다**(비밀 값이 대화를 지나지 않게): `<gateway_url>/ui/#/system/tools` ▸ «외부 도구 서버 (MCP)» ▸ [추가] ▸ 프리셋 «Slack» ▸ Client ID·Client Secret 입력 ▸ [저장]. 이 화면은 라이블리 관리자만 열 수 있다. 저장 한 번으로 슬랙 연결 창구와 앱 키가 함께 등록된다.
   - 사람이 대화로 하겠다고 하면(공통 규칙 6의 경고를 먼저 하고) 두 번에 나눠 등록한다:
     1. `org_mcp_upsert { name:"slack", transport:"http", url:"https://mcp.slack.com/mcp", mode:"proxy", auth_mode:"oauth", auth_kind:"slack_oauth", scope:"items", level:"L0", pii_scrub:true, log_args:false }` — 슬랙 연결 창구(이게 없으면 연결이 «proxy MCP 서버 없음»으로 실패한다).
     2. `org_credential_set { kind:"slack_oauth", scope_key:"oauth:client", secret:"{\"client_id\":\"…\",\"client_secret\":\"…\"}" }` — 라이블리 관리자만.
4. `org_connect_status` 를 다시 불러 `slack.app_ready=true` 인지 확인한다. 그다음 «연결»로 간다 — 앱을 등록한 사람이 먼저 연결하면 그 동의로 라이블리 봇이 슬랙에 설치된다.
