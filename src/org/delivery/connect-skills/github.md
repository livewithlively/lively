## 연결 — 읽힐 저장소를 고르는 것이 곧 범위

1. `org_github_connect {}` 를 부른다 → `authorization_url`. 그 링크를 주고 말한다: «이 링크를 열고 설치할 계정(조직)을 고른 뒤, 라이블리가 읽을 저장소만 골라 [Install & Authorize]를 눌러 주세요.» 이미 설치돼 있으면 [Authorize]만 나온다. 링크는 10분 동안만 쓸 수 있다.
   - 409 가 오면 GitHub App 이 아직 없다 — «상태 확인»으로 돌아간다.
2. 사람이 «했어요»라고 하면 `org_github_collect` 로 `me_connected=true` 를 확인한다.
- 깃허브 화면에서 앱을 직접 설치하면(이 링크를 거치지 않으면) 라이블리가 설치를 알아보지 못한다. 꼭 이 링크로 하게 한다.

## 개인 토큰으로 연결

GitHub App 이 없거나 사람이 원할 때. 저장소를 고르는 화면이 없어서, 토큰이 볼 수 있는 저장소 전부가 대상이 된다는 점을 먼저 말한다.
1. 사람에게: «깃허브 ▸ Settings ▸ Developer settings ▸ Personal access tokens 에서 토큰을 만들어 주세요.» classic 토큰이면 `repo` 권한이 필요하다.
2. 토큰 넣기 — 공통 규칙 6의 경고를 먼저 하고: `me_credential_set { kind:"github_pat", scope_key:"", secret:"<토큰>", meta:{ auth_header:"Authorization", token_prefix:"Bearer " } }`. `scope_key` 는 비워 둔다(호스트 이름을 넣으면 수집은 되지만 AI 도구가 토큰을 못 찾는다). 앱 연결과 개인 토큰은 같은 자리를 쓴다 — 나중에 앱으로 연결하면 토큰이 그 연결로 바뀐다.
3. `org_github_collect` 로 `me_connected=true` 를 확인한다.

## 모을 저장소

- 저장소 목록: `org_collect_scope_options { system:"github" }`.
- ⚠ **범위를 비우면 이 연결이 볼 수 있는 저장소 전부(비공개 포함)를 모은다.** 모은 자료는 워크스페이스 구성원 모두에게 보인다(공개범위 규칙을 따로 정하지 않았다면). 비우기 전에 이 사실을 말하고 확인받는다.
- 저장소마다 모을지 제안하고, PR 리뷰 대화·릴리스 노트도 함께 모을지(기본 둘 다 켬), 언제부터 읽을지(비우면 전부)도 정한다.
- 켜기: `org_github_collect_set { enabled:true, scope:{ repos:"owner/repo owner/repo2", include_prs:"on", include_releases:"on", backfill_since:"YYYY-MM-DD" } }` — 범위는 꼭 `scope` 안에. 정하지 않은 항목은 빼고 보낸다.
  - ⚠ `_set {enabled:true}` 는 수집을 **부른 사람의 연결**로 바꾼다. `member` 가 이 사람이 아니면 먼저 말하고 동의를 받는다.
- 앱을 설치할 때 고르지 않은 저장소는 범위에 적어도 읽히지 않는다(조용히 건너뛴다). 더 읽게 하려면 깃허브 ▸ Settings ▸ Applications 에서 그 앱의 저장소 선택을 넓힌다.

## 확인

- 켜면 첫 수집이 바로 시작된다. 1~2분 뒤 `org_github_collect` 의 `last_run` 을 본다. 들어온 자료: `source_list { system:"github", limit:5 }`.
- 켤 때 «이슈 대화 정리 규칙»(증류기 `issue-threads`)이 **꺼진 채로** 함께 만들어진다. 이슈·PR 대화를 지식으로 정리하려면 사람에게 확인받고 `org_distiller_upsert { key:"issue-threads", enabled:true }` 로 켠다(리니어·깃랩과 같이 쓰는 규칙이다).

## 함정

- github.com 만 지원한다. 회사 자체 깃허브 서버(GitHub Enterprise Server)는 연결되지 않는다.
- 설치가 하나도 없으면 «볼 수 있는 저장소가 하나도 없습니다»로 실패한다 — «연결»을 다시 한다.
