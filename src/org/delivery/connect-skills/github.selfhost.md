# liv-connect-github — 깃허브 연결 (회사 직접 설치)

깃허브 이슈·PR 대화와 릴리스 노트를 라이블리 자료함으로 모은다. 이 워크스페이스는 회사가 직접 설치한 라이블리라, **이 회사의 GitHub App**을 한 번 만들어 등록하면 구성원이 저장소를 골라 연결할 수 있다. 앱이 없어도 각자 개인 토큰으로 연결할 수는 있다(«개인 토큰으로 연결»).

## 상태 확인

`org_connect_status` 의 `github` 줄과 `prereq` 를 본다. 자세한 상태는 `org_github_collect`(내 연결 `me_connected` · 켜짐 `enabled` · 누구 연결로 도는지 `member` · 범위 `scope` · 마지막 실행 `last_run`)와 `org_github_connect_status`(앱 준비 `app_ready`)다.

- `app_ready=false` 이고 `can_register=true` → «앱 등록»을 권한다(저장소를 골라 읽게 할 수 있어 개인 토큰보다 범위가 분명하다). 사람이 원하지 않으면 «개인 토큰으로 연결».
- `app_ready=false` 이고 `can_register=false` → «개인 토큰으로 연결»을 쓰거나, 관리자에게 앱 등록을 부탁하게 한다(보낼 한 줄: «라이블리에서 ‹깃허브 연결해줘›라고 말하면 GitHub App 등록을 안내받을 수 있어요.»).
- `app_ready=true` 이고 `next=connect` → «연결»부터 · `set_scope` → «모을 저장소»부터 · `collecting` → «확인»만.
- 앱으로 연결하려면 `prereq.callback_url` 이 있어야 한다 — null 이면 입구 스킬(`liv-connect`)의 «공개 주소 넣기»부터.

## 앱 등록 (한 번만)

OAuth App 이 아니라 **GitHub App** 이다.
1. 사람에게: «깃허브 조직 화면에서 Settings ▸ Developer settings ▸ GitHub Apps ▸ [New GitHub App] 으로 가 주세요.» 깃허브 조직 Owner 여야 한다.
2. 칸마다 이렇게 넣게 한다(한 번에 하나씩 안내):
   - GitHub App name: 회사가 알아볼 이름(예: «Lively (회사명)») — 이미 있는 이름이면 뒤에 단어를 붙인다.
   - Homepage URL: 라이블리 주소(`gateway_url`).
   - Callback URL: `prereq.callback_url` 값 그대로.
   - **Request user authorization (OAuth) during installation** 를 체크한다 — 빠지면 연결이 끝난 뒤 오류가 난다.
   - Webhook: **Active 체크 해제**.
   - Repository permissions: Contents · Metadata · Issues · Pull requests 를 **Read-only** 로.
   - Where can this GitHub App be installed: **Only on this account**.
3. [Create GitHub App] 뒤 앱 화면에서 다섯 가지를 챙기게 한다: **App ID**, **Client ID**, **Client secret**([Generate a new client secret]), **Private key**([Generate a private key] → .pem 파일), 앱 주소 `github.com/apps/<슬러그>` 의 **슬러그**.
4. 라이블리에 등록한다 — 이 값들은 아직 화면에 입력칸이 없다. 그래서 대화로 받아 등록한다. 공통 규칙 6의 경고를 **반드시 먼저** 하고, 사람이 동의하면: `org_github_app_register { client_id, client_secret, app_id, app_slug, private_key }` (private_key 는 .pem 파일 내용 전체). 받은 값은 다시 출력하지 않는다.
5. `org_connect_status` 로 `github.app_ready=true` 를 확인하고 «연결»로 간다.
