# liv-connect-outlook — 아웃룩 연결 (회사 직접 설치)

아웃룩 메일(Microsoft 365 회사 계정·outlook.com 개인 계정)을 라이블리 자료함으로 모은다. 일정은 모으지 않고 AI 도구로만 쓴다. 이 워크스페이스는 회사가 직접 설치한 라이블리라, **이 회사의 Microsoft Entra 앱**을 한 번 등록해야 연결할 수 있다.

## 상태 확인

`org_connect_status` 의 `outlook` 줄과 `prereq` 를 본다. 자세한 상태는 `org_outlook_collect` 다(앱 준비 `app_ready` · 내 연결 `me_connected` · 켜짐 `enabled` · 누구 연결로 도는지 `member` · 관리자에게 보낼 링크 `admin_consent_url` · 마지막 실행 `last_run`).

- `prereq.callback_url` 이 null 이면 입구 스킬(`liv-connect`)의 «공개 주소 넣기»부터 한다.
- `next=register_app` → «앱 등록»부터.
- `next=ask_admin` → «라이블리 관리자가 먼저 Microsoft 앱을 등록해야 해요»라고 말하고, 관리자에게 보낼 한 줄을 적어 준다: «라이블리에서 ‹아웃룩 연결해줘›라고 말하면 Entra 앱 등록을 안내받을 수 있어요.» 여기서 끝낸다.
- `next=connect` → «연결»부터 · `set_scope` → «켜기»부터 · `collecting` → «확인»만.

## 앱 등록 (한 번만)

Microsoft Entra 관리 센터에서 한다. 회사 Microsoft 365 의 앱 등록 권한이 필요하다. 한 번에 하나씩 안내한다.
1. https://entra.microsoft.com ▸ 앱 등록 ▸ [새 등록].
2. **지원되는 계정 유형**: «모든 조직 디렉터리의 계정 및 개인 Microsoft 계정»을 고른다 — 다른 것을 고르면 연결이 실패한다.
3. **리디렉션 URI**: 플랫폼 «웹», 값은 `prereq.callback_url` 그대로.
4. 등록 뒤 개요의 **애플리케이션(클라이언트) ID** 를 확인하고, «인증서 및 비밀 ▸ 새 클라이언트 암호»를 만든 뒤 **값**(ID 가 아니다)을 확인하게 한다.
5. 라이블리에 등록한다 — **화면에서 하게 안내한다**: `connect_url`(아웃룩 화면) ▸ «자료 가져오기» ▸ «앱 등록» 칸에 Client ID·Client Secret 입력 ▸ [앱 등록]. 라이블리 관리자만 저장할 수 있다.
   - 사람이 대화로 하겠다고 하면(공통 규칙 6의 경고를 먼저 하고): `org_credential_set { kind:"microsoft_oauth", scope_key:"oauth:client", secret:"{\"client_id\":\"…\",\"client_secret\":\"…\"}" }` — 라이블리 관리자만.
6. `org_connect_status` 로 `outlook.app_ready=true` 를 확인하고 «연결»로 간다.
