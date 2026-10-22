# liv-connect-google — 구글 연결 (회사 직접 설치)

구글 드라이브 문서와 지메일을 라이블리 자료함으로 모은다(캘린더는 모으지 않고 AI 도구로만 쓴다). 이 워크스페이스는 회사가 직접 설치한 라이블리라, **이 회사의 구글 OAuth 클라이언트**를 한 번 만들어 라이블리에 등록해야 연결할 수 있다.

## 상태 확인

`org_connect_status` 의 `google` 줄과 `prereq` 를 본다. 자세한 상태는 `org_google_collect` 다(준비 `ready` · 내 연결 `connected` · 서비스별 수집기 `collectors[]` — `service`·`enabled`·동의 범위 `scope_ok`).

- `prereq.callback_url` 이 null 이면 입구 스킬(`liv-connect`)의 «공개 주소 넣기»부터 한다.
- `next=register_app` → «앱 등록»부터.
- `next=ask_admin` → «라이블리 관리자가 먼저 구글 OAuth 클라이언트를 등록해야 해요»라고 말하고, 관리자에게 보낼 한 줄을 적어 준다: «라이블리에서 ‹구글 연결해줘›라고 말하면 등록을 안내받을 수 있어요.» 여기서 끝낸다.
- `next=connect` → «연결»부터 · `set_scope` → «모을 범위»부터 · `collecting` → «확인»만.

## 앱 등록 (한 번만)

구글 클라우드 콘솔에서 한다. 회사 구글 클라우드 프로젝트의 관리 권한이 필요하다. 한 번에 하나씩 안내한다.
1. https://console.cloud.google.com 에서 프로젝트를 고르거나 새로 만든다.
2. «API 및 서비스 ▸ 라이브러리»에서 쓸 API 를 사용 설정한다: **Google Drive API**, **Gmail API**, **Google Calendar API**(캘린더 도구를 쓸 때).
3. «OAuth 동의 화면»을 만들고 **게시(프로덕션)** 상태로 둔다. 테스트 상태로 두면 7일마다 연결이 끊긴다. 구글 검증 전이면 연결할 때 «확인되지 않은 앱» 경고가 뜨고, 이 프로젝트로 연결할 수 있는 계정이 누적 100개로 제한된다 — 사람에게 미리 말한다.
4. «사용자 인증 정보 ▸ 사용자 인증 정보 만들기 ▸ OAuth 클라이언트 ID»에서 유형 **웹 애플리케이션**, **승인된 리디렉션 URI** 에 `prereq.callback_url` 값을 그대로 넣는다.
5. 만들어진 **클라이언트 ID** 와 **클라이언트 보안 비밀번호**를 확인하게 한다.
6. 라이블리에 등록한다 — **화면에서 하게 안내한다**: `connect_url`(구글 화면) ▸ «자료 가져오기» ▸ 클라이언트 ID·보안 비밀 입력 ▸ [클라이언트 값 저장]. 라이블리 관리자만 저장할 수 있다.
   - 사람이 대화로 하겠다고 하면(공통 규칙 6의 경고를 먼저 하고): `org_credential_set { kind:"google_oauth", scope_key:"oauth:client", secret:"{\"client_id\":\"…\",\"client_secret\":\"…\"}" }` — 라이블리 관리자만.
   - 클라이언트를 나중에 바꾸면 이미 연결한 사람들은 모두 다시 연결해야 한다(구글은 발급한 클라이언트로만 연결을 이어 준다).
7. (선택) AI 가 구글 드라이브·지메일·캘린더를 직접 쓰게 하려면 도구를 심는다: `org_http_tool_preset_apply { key:"google-drive" }`(·`"google-gmail"`·`"google-calendar"`). 수집에는 필요 없다.
8. `org_connect_status` 로 `google.app_ready=true` 를 확인하고 «연결»로 간다.
