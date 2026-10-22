# liv-connect-linear — 리니어 연결 (회사 직접 설치)

리니어 이슈·댓글·문서를 라이블리 자료함으로 모은다. 이 워크스페이스는 회사가 직접 설치한 라이블리라, **이 회사의 리니어 OAuth 앱**을 한 번 만들어 라이블리에 등록해야 연결할 수 있다.

## 상태 확인

`org_connect_status` 의 `linear` 줄과 `prereq` 를 본다. 자세한 상태는 `org_linear_collect` 다(앱 준비 `app_ready` · 내 연결 `me_connected` · 켜짐 `enabled` · 누구 연결로 도는지 `member` · 범위 `scope` · 마지막 실행 `last_run`).

- `prereq.callback_url` 이 null 이면 입구 스킬(`liv-connect`)의 «공개 주소 넣기»부터 한다.
- `next=register_app` → «앱 등록»부터.
- `next=ask_admin` → «라이블리 관리자가 먼저 리니어 앱을 등록해야 해요»라고 말하고, 관리자에게 보낼 한 줄을 적어 준다: «라이블리에서 ‹리니어 연결해줘›라고 말하면 리니어 앱 등록을 안내받을 수 있어요.» 여기서 끝낸다.
- `next=connect` → «연결»부터 · `set_scope` → «모을 팀»부터 · `collecting` → «확인»만 하고 범위를 바꿀지 묻는다.

## 앱 등록 (한 번만)

1. 사람에게: «리니어에서 Settings ▸ API ▸ OAuth Applications 로 가서 새 앱을 만들어 주세요.» 리니어 워크스페이스 관리자 계정이어야 한다.
2. 이름은 회사가 알아볼 이름(예: «Lively»)으로, **Callback URL** 에는 `prereq.callback_url` 값을 그대로 넣게 한다.
3. 만들어진 앱의 **Client ID** 와 **Client Secret** 을 확인하게 한다.
4. 라이블리에 등록한다 — **화면에서 하게 안내한다**: `connect_url`(리니어 화면) ▸ «자료 가져오기» ▸ «앱 등록» 칸에 두 값 입력 ▸ [앱 등록]. 라이블리 관리자만 저장할 수 있다.
   - 사람이 대화로 하겠다고 하면(공통 규칙 6의 경고를 먼저 하고): `org_credential_set { kind:"linear_app", scope_key:"oauth:client", secret:"{\"client_id\":\"…\",\"client_secret\":\"…\"}" }` — 라이블리 관리자만.
5. `org_connect_status` 를 다시 불러 `linear.app_ready=true` 인지 확인하고 «연결»로 간다.
