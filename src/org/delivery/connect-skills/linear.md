# liv-connect-linear — 리니어 연결

리니어 이슈·댓글·문서를 라이블리 자료함으로 모은다.

## 길 고르기

`org_connect_status` 의 `linear` 줄을 본다. `routes` 는 리니어을(를) 연결할 수 있는 길이 우선순위 순서로 들어 있고(`app` 라이블리 앱 하나), `recommended` 가 권하는 길이다. 그 길부터 한다. 배포 방식은 묻지 않는다 — 길의 상태가 이미 그것을 반영한다.
- `blocked_before` 에 길이 있으면 그 사정을 한 줄로 먼저 말한다:
  - 라이블리 앱이 `preparing` → «라이블리가 리니어 연결 앱을 준비하고 있어요.»
  - 라이블리 앱이 `ask_admin` → «라이블리 관리자가 먼저 리니어 앱을(를) 등록해야 해요.» 관리자에게 보낼 한 줄을 적어 준다: «라이블리 [외부 앱 연결] ▸ 리니어에서 ‹앱 등록›을 하면 돼요(약 5분).»
- 길은 아래 «라이블리 앱» 하나다.
- 상태를 더 자세히 볼 때는 `org_linear_collect` 다(앱 준비 `app_ready` · 내 연결 `me_connected` · 켜짐 `enabled` · 누구 연결로 도는지 `member` · 범위 `scope` · 마지막 실행 `last_run`).

## 라이블리 앱

라이블리 앱 길의 `state` 마다:
- `collecting` → «확인»만 하고 범위를 바꿀지 묻는다.
- `set_scope` → «모을 팀»부터.
- `connect` → «연결»부터.
- `register` → «앱 등록»부터(이 사람이 등록할 수 있다). 끝나면 «연결»로 이어 간다.
- `ask_admin` → 앱이 아직 없으면 «길 고르기»의 관리자 한 줄로 끝낸다(리니어는 다른 길이 없다). 앱이 있는데 `ask_admin` 이면 이 사람은 수집을 켤 수 없다 — 관리자에게 «리니어 수집 켜기»를 부탁하게 한다.
- `preparing` → «라이블리가 리니어 연결을 준비하고 있어요»라고만 말하고 끝낸다.

{{registration}}

### 연결 — 사람 몫은 [허용] 한 번

1. `org_linear_collect_connect {}` 를 부른다 → `authorization_url`. 그 링크를 주고 말한다: «이 링크를 열고 리니어 화면에서 [허용]을 눌러 주세요.» 리니어는 연결할 때마다 이 화면을 보여 준다. 링크는 10분 동안만 쓸 수 있다.
2. 사람이 «했어요»라고 하면 `org_linear_collect` 로 `me_connected=true` 를 확인한다.
- 연결만으로는 수집이 켜지지 않는다 — 아래 «모을 팀»에서 켠다.
- 개인 AI 가 리니어를 직접 쓰는 연결(`me_oauth_connect { server:"linear" }`)은 이것과 별개다 — 그 연결로는 자료를 모으지 않는다.

### 모을 팀

- 팀 목록: `org_collect_scope_options { system:"linear" }` — 팀 **키**(예: ENG)가 온다. 비우면 리니어 워크스페이스 전체다.
- 팀마다 모을지 제안하고 확인받는다. 리니어 문서(Docs)도 함께 모을지(기본 켬)와, 언제부터 읽을지(비우면 볼 수 있는 과거 전체)도 함께 정한다.
- 켜기: `org_linear_collect_set { enabled:true, scope:{ teams:"ENG OPS", include_documents:"on", backfill_since:"YYYY-MM-DD" } }` — 범위는 꼭 `scope` 안에 넣는다(바깥에 두면 무시된다). 정하지 않은 항목은 빼고 보낸다.
  - ⚠ `_set {enabled:true}` 는 수집을 **부른 사람의 연결**로 바꾼다. `org_linear_collect` 의 `member` 가 이 사람이 아니면 먼저 말하고 동의를 받는다: «지금은 ○○님 연결로 모으고 있어요. 범위를 바꾸면 이제부터 당신 연결로 모아요.»
- 모은 자료는 이 워크스페이스 구성원 모두에게 보인다(공개범위 규칙을 따로 정하지 않았다면).

### 확인

- 켜면 첫 수집이 바로 시작된다. 1~2분 뒤 `org_linear_collect` 의 `last_run` 을 본다. 들어온 자료: `source_list { system:"linear", limit:5 }`.
- 켤 때 «이슈 대화 정리 규칙»(증류기 `issue-threads`)이 **꺼진 채로** 함께 만들어진다. 이슈 대화를 지식으로 정리하려면 사람에게 확인받고 `org_distiller_upsert { key:"issue-threads", enabled:true }` 로 켠다(깃허브·깃랩과 같이 쓰는 규칙이다).

### 함정

- 리니어 연결은 만료되면 자동으로 갱신되지 않는다. 수집이 «권한»·«토큰» 오류로 멈추면 «연결»의 1을 다시 하고 «모을 팀»의 켜기를 한 번 더 부른다.
- 한 번에 읽을 이슈가 아주 많으면(만 건 이상) 그 회차 수집이 실패하고 멈춘다. 그때는 팀을 나눠서 모은다.
