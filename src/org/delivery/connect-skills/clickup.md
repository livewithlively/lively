# liv-connect-clickup — 클릭업 연결

클릭업의 작업·댓글·시간 기록을 라이블리로 가져온다. 클릭업은 자료함이 아니라 **프로젝트 탭**으로 들어온다(작업 = 프로젝트, 리스트·댓글은 그 아래). 앱 등록 없이 **각자의 API 토큰**으로 연결한다(라이블리 클라우드·직접 설치 모두 같다).

## 상태 확인

`org_connect_status` 의 `clickup` 줄을 본다. 자세한 상태는 `org_clickup_collect` 다(내 연결 `me_connected` · 켜짐 `enabled` · 누구 연결로 도는지 `member` · 범위 `scope` · 마지막 실행 `last_run`).
- `next=connect` → «연결»부터 · `set_scope` → «가져올 리스트»부터 · `collecting` → «확인»만 하고 범위를 바꿀지 묻는다.

## 연결 — API 토큰

1. 사람에게: «클릭업에 로그인한 뒤 왼쪽 아래 프로필 ▸ Settings ▸ Apps 로 가서 API Token 의 [Generate](이미 있으면 [Copy])를 눌러 주세요.» 토큰은 `pk_` 로 시작한다. [Regenerate]를 누르면 예전 토큰은 바로 못 쓰게 된다는 것도 말한다.
2. 토큰 넣기 — 공통 규칙 6의 경고를 먼저 하고: `me_credential_set { kind:"clickup_token", scope_key:"", secret:"pk_…", meta:{ token_prefix:"" } }`. `scope_key` 는 반드시 비워 둔다 — 다른 값이면 수집이 토큰을 못 찾는다.
3. `me_credential_verify { kind:"clickup_token" }` 로 실제로 통하는지 확인한다. 실패하면 돌아온 사유를 그대로 전한다.

## 가져올 리스트

- 리스트 목록: `org_collect_scope_options { system:"clickup" }`.
- 비우면 **첫 번째 클릭업 워크스페이스의 모든 리스트**를 가져온다. 토큰이 여러 워크스페이스에 속해 있어도 첫 번째만 본다 — 다른 워크스페이스가 필요하면 사람에게 그 사실을 말한다.
- 켜기: `org_clickup_collect_set { enabled:true, scope:{ include_list_ids:"901,902" } }` — 범위는 꼭 `scope` 안에. 빼고 싶은 리스트만 정하려면 `exclude_list_ids`.
  - ⚠ `_set {enabled:true}` 는 가져오기를 **부른 사람의 연결**로 바꾼다. `member` 가 이 사람이 아니면 먼저 말하고 동의를 받는다.

## 확인

- 켜면 첫 가져오기가 바로 시작된다. 1~2분 뒤 `org_clickup_collect` 의 `last_run` 을 보고, 프로젝트 탭에 클릭업 작업이 보이는지 `project_list_v6` 로 확인한다.
- 클릭업은 지식 정리 규칙(증류기)이 필요 없다 — 작업 자체가 프로젝트로 들어온다. 공통 규칙 «연결 뒤» 3은 건너뛴다.
