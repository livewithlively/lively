# liv-connect-figma — 피그마 연결

피그마 파일의 **코멘트**를 라이블리 자료함으로 모은다. 앱 등록 없이 **각자의 개인 액세스 토큰**으로 연결한다. 개인 AI 가 피그마 화면을 직접 읽는 연결은 이것과 별개다.

## 길 고르기

`org_connect_status` 의 `figma` 줄을 본다. 피그마의 길은 개인 토큰(`token`) 하나다 — 그 길의 `state` 마다:
- `connect` → «연결»부터 · `set_scope` → «모을 파일»부터 · `collecting` → «확인»만 하고 범위를 바꿀지 묻는다.
- `ask_admin` → 토큰은 넣었지만 이 사람은 수집을 켤 수 없다 — 관리자에게 «피그마 수집 켜기»를 부탁하게 한다.
- 상태를 더 자세히 볼 때는 `org_figma_collect` 다(내 연결 `me_connected` · 켜짐 `enabled` · 범위 `scope` · 범위가 비었는지 `needs_scope` · 마지막 실행 `last_run`).

## 연결 — 개인 액세스 토큰

1. 사람에게: «피그마에서 Settings ▸ Security ▸ Personal access tokens 로 가서 새 토큰을 만들어 주세요. 만료는 길게 잡아 주세요.»
2. 허용 범위는 이것들을 켜게 한다(나중에 바꿀 수 없어 빠지면 토큰을 새로 만들어야 한다): `file_comments:read` · `file_content:read` · `file_metadata:read` · `current_user:read` · 팀 전체를 훑으려면 `folders:read`.
3. 토큰 넣기 — 공통 규칙 6의 경고를 먼저 하고: `me_credential_set { kind:"figma_token", scope_key:"", secret:"figd_…", meta:{ auth_header:"X-Figma-Token", token_prefix:"" } }`.
4. `me_credential_verify { kind:"figma_token" }` 로 확인한다. 빠진 허용 범위가 있으면 그 이름이 돌아온다 — 그대로 전하고 1부터 새 토큰을 만들게 한다.

## 모을 파일

- 피그마는 범위가 **꼭 있어야** 켜진다(비우면 `needs_scope` 로 켜지지 않는다). 둘 중 하나로 정한다:
  - 파일 링크: 사람에게 모을 파일의 링크를 받는다.
  - 팀 전체: 팀 id 는 피그마가 목록으로 주지 않는다. 팀 페이지 주소 `figma.com/files/team/<숫자>/…` 의 숫자를 받는다. 팀 id 가 있으면 `org_collect_scope_options { system:"figma", team_id:"<숫자>" }` 로 그 팀 파일 목록을 보고 고를 수 있다.
- 켜기: `org_figma_collect_set { enabled:true, scope:{ file_keys:"<링크 또는 키, 공백 구분>" } }` 또는 `scope:{ team_ids:"<숫자>" }`.
  - ⚠ `_set {enabled:true}` 는 수집을 **부른 사람의 연결**로 바꾼다. `member` 가 이 사람이 아니면 먼저 말하고 동의를 받는다.
- 팀이 여럿이면 첫 팀만 한 수집기로 묶인다 — 팀마다 따로 모으려면 사람에게 그 사실을 말한다.

## 확인

- 켜면 첫 수집이 바로 시작된다. 1~2분 뒤 `org_figma_collect` 의 `last_run` 을 본다. 들어온 자료: `source_list { system:"figma", limit:5 }`. 팀 전체가 403 으로 실패하면 토큰에 `folders:read` 가 빠진 것이다.
- 켤 때 «피그마 코멘트 정리 규칙»(증류기 `figma-comments`)이 **꺼진 채로** 함께 만들어진다. 정리하려면 사람에게 확인받고 `org_distiller_figma_ensure { enable:true }`.
