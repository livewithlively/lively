---
name: clickup-sync
description: ClickUp ↔ 컨텍스트 스토어 동기화(읽기 미러 + pm_* write-through). 프로젝트=리스트, 태스크=item, 매핑=declared.
tools:
  - bash
  - lively:pm_task_create
  - lively:pm_task_update_status
  - lively:pm_task_assign
  - lively:pm_task_comment
  - lively:pm_task_link
  - lively:pm_task_archive
env:
  - ITEMS_DATABASE_URL
  - DOMAINMAP_DATABASE_URL
  - CLICKUP_API_TOKEN
  - CLICKUP_EXCLUDE_LIST_IDS
trigger: on-demand + suggested in-session loop — 스케줄러 미설치(아래 §6)
---

# clickup-sync — ClickUp 읽기 미러 + PM write-through (phase B)

> **단일 마스터 = ClickUp(툴 구조가 진실).** 리스트 1개 = domainmap 프로젝트 1개(`clickup-<listId>`,
> status='confirmed' origin='source'), 태스크 1건 = item 1행(type 'task'), 태스크→리스트 소속 =
> `mapped_by='declared'` item_project(confirmed). 이견이 있으면 우리 스토어가 아니라 ClickUp 을 고친다.

## 1. 싱크 실행 (run-sync)

```bash
npm run build
# 증분(커서 기반 date_updated_gt — 기본). 커서가 없으면 자동 전체 백필.
node --env-file-if-exists=.env dist/connectors/run-sync.js clickup
# 전체 재백필(리스트별 전수 + archived 패스) — 멱등이라 언제든 안전.
node --env-file-if-exists=.env dist/connectors/run-sync.js clickup --full
```

한 run 의 순서: 컨테이너 나열 → **프로젝트 싱크(리스트별 1 POST)** → 후보 vocab 1회 로드 →
태스크 수집(증분: 팀 단위 `date_updated_gt` + 리스트별 archived 패스 / 전체: 리스트별 2패스) →
`ingestItems` 멱등 upsert → `resolveParents`(서브태스크) → `declareItemProject`(리스트=프로젝트) →
**전부 성공 후에만 커서 전진**(`connector_state`, 1초 epsilon 재폴링 — upsert 가 dedup).

- **무변경 재싱크 = 무소음:** 프로젝트는 action `'unchanged'`(change_log 안 찍힘), 아이템은 upsert no-op.
  fields 에 휘발 값(task_count 등)을 추가하면 영구 churn 이 되므로 **금지**.
- **빈 리스트 설명은 생략(omit)** — domainmap 의 큐레이션된 설명(예: 프로젝트 46)을 보존한다.
  ClickUp 쪽에 설명을 쓰면 그게 마스터가 되어 덮는다(의도된 단일 마스터).
- **rate budget:** 전체 ≈ 13 호출, 증분 ≈ 10 호출 (한도 100/min — 여유 큼).
- exit code: 리스트 단위 실패(프로젝트 싱크/태스크 수집/declare)가 하나라도 있으면 1, 아니면 0.
  **실패 run 은 커서를 전진시키지 않는다(코드로 강제)** — 다음 run 이 같은 윈도를 재폴링해 수렴하며,
  멱등 upsert/declare 라 재폴링은 무비용(수동 `--full`/커서 리셋 불필요).
- **리스트 간 태스크 이동 자동 수렴:** declare 후 같은 아이템의 **다른 리스트 declared 행을
  `rejected` 로 강등**(감사 action `declared-superseded`)하고, upsert 가 `container_ref` 도 갱신 —
  한 아이템 = declared 1행 불변식. manual/rule/llm 매핑은 건드리지 않는다.

## 2. 나열/제외 규칙

스페이스 → (숨김 아닌 폴더의 리스트, 전방호환) + folderless 리스트(active+archived 패스) →
`CLICKUP_EXCLUDE_LIST_IDS`(.env, 쉼표구분) denylist 적용. 현재 제외 = ClickUp 샘플 리스트 3개
(Get Started with ClickUp / Project 1 / Project 2). **새 샘플/노이즈 리스트가 생기면 여기 추가하기 전까지
프로젝트로 싱크된다** — 대안은 ClickUp UI 에서 샘플 리스트를 보관(archive)하는 것(그러면 state='archived' 로 수렴).

## 3. pm_* write-through (MCP 전용, scope 'items')

| op | 의미론 |
|---|---|
| `pm_task_create` | `{listKeyOrId('clickup-<id>' 또는 숫자), title, description?, assigneeEmails?, priority?(1~4), dueDate?(ISO)}` — 리스트가 후보 vocab 에 없으면 **ClickUp 호출 전 거부(무쓰기)** → run-sync 먼저 |
| `pm_task_update_status` | status 문자열은 스페이스의 상태 그대로(`to do`/`in progress`/`complete`) — 오타는 ClickUp 에러 그대로 표면화 |
| `pm_task_assign` | **교체(replace) 의미론** — 준 이메일 목록이 최종 담당자 집합(목록 밖 기존 담당자는 해제) |
| `pm_task_comment` | notify_all=false. 코멘트는 별도 item 미러 없음 — 부모 태스크 에코가 신호 |
| `pm_task_link` | ClickUp 태스크 딥링크면 task-task 링크, 그 외 URL 은 `링크: <url>` 코멘트 폴백(mode 반환) |
| `pm_task_archive` | archived=true. **하드 삭제 op 는 없다(아카이브 온리 철학)** |

- 모든 쓰기 = 검증 → ClickUp API(실패는 ClickUp 메시지 그대로) → **에코 업서트**(같은 toRawItem→ingest
  경로 + declare) — 미러 즉시 반영(read-your-writes), 이후 폴이 같은 external_id 로 멱등 수렴.
- **excluded/미동기화 리스트의 태스크에 대한 op(create 외 5개):** ClickUp 쓰기는 성공하고 op 도
  성공으로 반환하되 — excluded 리스트면 **미러 자체를 스킵**(`mirrored:false` + 경고; 영구 스테일 행
  방지), 미동기화 리스트면 item 만 에코하고 declare 는 스킵(`warning` — 다음 run-sync 가 매핑 수렴).
- **감사(내구 = DB):** ClickUp 에는 토큰 계정(lively@lvly.io → item actor 'daon')으로 보이지만,
  실제 지시자는 **items DB `pm_write_audit` 테이블**(op 단위 append-only: action/by_user/outcome/
  detail/clickup_ok/error) + `item_mapping_audit`(actor=userId, source='pm-write')에 영속 기록.
  logger `pm_write` 라인은 보조(게이트웨이 stdout — 휘발 가능 위치면 믿지 말 것). 에코 fields
  `{via:'harness', initiator}` 는 **transient** — 다음 폴이 fields 를 정규화하며 지운다(의도된 설계).
  조회: `SELECT at, action, by_user, outcome, detail FROM pm_write_audit ORDER BY at DESC LIMIT 20;`
- ClickUp 쓰기 성공 후 에코만 실패하면 `미러 반영 실패 … 다음 run-sync 가 수렴` 에러 — **create 를
  맹목 재시도하지 말 것**(ClickUp 태스크가 중복된다; 미러는 다음 run-sync 가 채운다).
- 스코프는 'items' 재사용(2인 조직 — curate 쓰기와 동급 표면). 추후 분리하려면 **`src/capabilities/scopes.ts`
  의 SCOPES 배열(단일 진실원천)** 1곳만 — types union·web.ts `mw()`·토큰 검증이 전부 거기서 파생된다(2026-06-16
  scope 단일상수화 완료; 신규 scope 추가 시 mw 가 자동 fail-closed). + AUTH_TOKENS_JSON/구성원 scope 부여.

## 4. 도그푸드 스케줄 (제안 — **설치하지 않음**)

세션 안에서:

```
/loop 10m node --env-file-if-exists=.env dist/connectors/run-sync.js clickup
```

또는 crontab 주석 예시(직접 설치는 운영자 판단 — 2~3분보다 타이트하게 잡지 말 것, 한도 100/min 공유):

```cron
# */10 * * * * cd /Users/lively/.openclaw/workspace/productivity/context-ontology && node --env-file-if-exists=.env dist/connectors/run-sync.js clickup >> /tmp/clickup-sync.log 2>&1
```

## 5. 트러블슈팅

- **`리스트/프로젝트 후보 없음` / declare `검증 실패`:** 리스트가 아직 domainmap 에 싱크 전 — run-sync 실행.
- **409 (provenance conflict):** 같은 ClickUp 객체가 **다른 repo** 에 이미 싱크됨(provenance 는 repo 횡단
  유니크). 소유 repo 가 에러 메시지에 나온다 — repo 정리 없이 재시도 금지.
- **403 sync-protected:** repo 'lively' 는 서버측 `SYNC_BLOCKED_REPOS` 가 차단(코드도 productivity 하드코딩 — 이중 가드).
- **아웃오브밴드 보관(UI 에서 archive):** 리스트/태스크 모두 archived 패스가 다음 run 에 수렴.
  ClickUp 에서 **하드 삭제**된 객체는 탐지 못 함(phase B 갭 — 미러 행/프로젝트가 stale 로 남음; 조직
  철학이 아카이브 온리라 수용).
- **리스트 간 태스크 이동:** 자동 수렴 — upsert 가 container_ref 를 갱신하고, declare 후
  reconcile 이 옛 리스트 declared 행을 `rejected` 로 강등(감사 `declared-superseded`, warn 로그
  `item_project_declare_supersede`). 태스크가 옛 리스트로 되돌아오면 declare 가 rejected 를 도로
  덮는다(`declared-overrode-rejected` — 정상).
- **`declared-overrode-rejected/manual` warn 로그:** 누가 clickup 아이템을 손 큐레이션했거나
  태스크가 이동 후 원래 리스트로 돌아온 경우 — declared 는 단일 마스터라 도로 덮는다.
  이견은 ClickUp 구조를 바꿔서 반영할 것.
- **커서 리셋:** `DELETE FROM connector_state WHERE system='clickup'` 후 run-sync(=전체 백필). 멱등이라 안전.

## 6. e2e 리플레이 (phase B 검증 절차)

1. `run-sync clickup --full` ×2 — 2회차는 프로젝트 전부 `'unchanged'`, 아이템/매핑 수 불변.
2. MCP `pm_task_create` (리스트 901818713960, 제목 "pm write-through e2e 검증 (자동생성)") →
   items DB 에 에코 행(via='harness', initiator=<userId>, actor 'daon') + declared confirmed 매핑.
3. `pm_task_comment` → `pm_task_update_status` 'complete' → `pm_task_archive`.
4. `run-sync clickup` (증분) → 같은 external_id 1행 유지, fields.archived=true 수렴, change_log 무소음.
5. 아카이브된 태스크는 **삭제하지 않고 보존**(감사 추적). 2026-06-11 검증 잔재: task 86exxdbmd / item 612.
