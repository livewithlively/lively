# liv-connect-gitlab — 깃랩 연결

깃랩 이슈·MR 대화와 릴리스 노트를 라이블리 자료함으로 모은다. 깃랩은 앱 등록 없이 **각자의 개인 액세스 토큰**으로 연결한다.

## 길 고르기

`org_connect_status` 의 `gitlab` 줄을 본다. 깃랩의 길은 개인 토큰(`token`) 하나다 — 그 길의 `state` 마다:
- `connect` → «연결»부터 · `set_scope` → «모을 프로젝트»부터 · `collecting` → «확인»만 하고 범위를 바꿀지 묻는다.
- `ask_admin` → 토큰은 넣었지만 이 사람은 수집을 켤 수 없다 — 관리자에게 «깃랩 수집 켜기»를 부탁하게 한다.
- 상태를 더 자세히 볼 때는 `org_gitlab_collect` 다(내 연결 `me_connected` · 켜짐 `enabled` · 누구 연결로 도는지 `member` · 범위 `scope` · 마지막 실행 `last_run`).

## 연결 — 개인 액세스 토큰

1. 사람에게: «깃랩에서 프로필 ▸ Edit profile ▸ Access tokens 로 가서 새 토큰을 만들어 주세요. 권한은 **read_api** 를 꼭 체크해 주세요.» 코드까지 읽게 하려면 `read_repository` 도 체크한다. 만료일은 넉넉하게 잡는다.
   - 깃랩 계정 로그인으로 받는 연결(`me_oauth_connect { server:"gitlab" }`)은 AI 가 깃랩을 직접 쓰는 용도라 **수집에는 쓸 수 없다**. 수집에는 이 토큰이 필요하다.
2. 회사 깃랩이면 주소의 호스트(예: `gitlab.회사.com`)를 확인한다. gitlab.com 이면 그대로.
3. 토큰 넣기 — 공통 규칙 6의 경고를 먼저 하고: `me_credential_set { kind:"gitlab_pat", scope_key:"<호스트, 예: gitlab.com>", secret:"glpat-…", meta:{ auth_header:"PRIVATE-TOKEN", token_prefix:"" } }`. 호스트를 빼면 gitlab.com 으로 간주돼 회사 깃랩에서는 실패한다.
4. `org_gitlab_collect` 로 `me_connected=true` 를 확인한다(`me_credential_verify` 는 깃랩 토큰을 확인하지 못한다 — 건너뛴다).

## 모을 프로젝트

- 프로젝트 목록: `org_collect_scope_options { system:"gitlab" }`.
- ⚠ **범위를 비우면 이 계정이 구성원인 프로젝트 전부(비공개 포함)를 모은다.** 모은 자료는 워크스페이스 구성원 모두에게 보인다(공개범위 규칙을 따로 정하지 않았다면). 비우기 전에 말하고 확인받는다.
- 켜기: `org_gitlab_collect_set { enabled:true, scope:{ projects:"group/project group/project2", include_mrs:"on", include_releases:"on", backfill_since:"YYYY-MM-DD" } }` — 범위는 꼭 `scope` 안에. 깃랩 주소(호스트)는 토큰을 넣을 때 정한 값을 따른다.
  - ⚠ `_set {enabled:true}` 는 수집을 **부른 사람의 연결**로 바꾼다. `member` 가 이 사람이 아니면 먼저 말하고 동의를 받는다.

## 확인

- 켜면 첫 수집이 바로 시작된다. 1~2분 뒤 `org_gitlab_collect` 의 `last_run` 을 본다. 들어온 자료: `source_list { system:"gitlab", limit:5 }`.
- 켤 때 «이슈 대화 정리 규칙»(증류기 `issue-threads`)이 **꺼진 채로** 함께 만들어진다. 정리하려면 사람에게 확인받고 `org_distiller_upsert { key:"issue-threads", enabled:true }`.

## 함정

- 회사 내부망에만 있는 깃랩에는 라이블리 클라우드가 닿지 못한다. 그런 깃랩은 회사 안에 직접 설치한 라이블리에서만 모을 수 있다.
