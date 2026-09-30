---
name: clickup-sync
description: ClickUp ↔ v6 스토어 동기화(무손실 읽기 미러 + external_outbox 아웃바운드 push). Space/Folder=project_folder, List=project_list, 최상위 Task=project, Subtask=task/subtask.
tools:
  - bash
env:
  - ITEMS_DATABASE_URL
  - CLICKUP_API_TOKEN
  - CLICKUP_TOKEN_SOURCE
  - CLICKUP_INCLUDE_LIST_IDS
  - CLICKUP_EXCLUDE_LIST_IDS
  - CLICKUP_CONTAINER_LIST_ID
trigger: on-demand + 스케줄러 크론 액션 connector_sync·connector_push(아래 §4)
---

# clickup-sync — ClickUp 무손실 미러 + 아웃바운드 push
*[English](clickup-sync.md)*

> **모델(v6).** ClickUp 계층은 v6 PM 테이블로 무손실 이관된다: Space·Folder → `project_folder`, List → `project_list`
> (+`settings.statuses`), View → `project_view`, 최상위 Task → `project`(level='project'), Subtask → level='task',
> 중첩 Subtask → level='subtask', 댓글 → `task_comment`, 타임엔트리 → `task_time_entry`
> (`src/v6/connector-mirror.ts` 머리주석, `src/connectors/clickup/transform.ts` `clickUpLevel`).
> **양방향이다.** 인바운드는 run-sync 가 필드별 3-way 머지로 미러하고, 로컬 편집(web/MCP)은 `external_outbox` 를 거쳐
> run-push 가 ClickUp 에 반영한다(§3). 양쪽이 같은 필드를 바꿨으면 **우리 DB 값이 이긴다**(`merge3` — 우리 DB=master).
> (구 phase B 모델 — 리스트 1개=domainmap 프로젝트 `clickup-<listId>`, 태스크=item 행, `item_project` declared 매핑,
> ClickUp 단일 마스터, `pm_*` MCP 툴 — 은 2026-06-24 v6 컷오버로 폐기됐다.)

## 1. 싱크 실행 (run-sync)

설정: 관리탭 수집기(ClickUp) 또는 `.env`(`src/connectors/config.ts` CONNECTOR_SPECS). 토큰은 `CLICKUP_API_TOKEN`
(personal token `pk_…`, `Authorization: <token>` — Bearer 접두사 없음) 또는 `CLICKUP_TOKEN_SOURCE`
(`org` = 자격 금고의 조직 공용 `clickup_token` · `member:<구성원 id>` = 그 사람이 저장한 토큰).

```bash
npm run build
# 증분(커서 기반 date_updated_gt — 기본). 커서가 없으면 자동 전체 백필.
node --env-file-if-exists=.env dist/connectors/run-sync.js clickup
# 전체 재백필(리스트별 전수 + archived 패스) — 멱등이라 언제든 안전.
node --env-file-if-exists=.env dist/connectors/run-sync.js clickup --full
```

한 run 의 순서(`src/connectors/clickup/sync.ts`·`stream.ts`): 계층(Space→Folder→List→View — since 무관 매 run 재수집) →
태스크 얕은 나열(증분: 팀 단위 `date_updated_gt` + 리스트별 archived 패스 / 전체: 리스트별 active+archived) →
태스크별 hydration(`getTaskFull` — 본문 markdown·첨부·커스텀필드·서브태스크, 부모 먼저) → 태스크별 댓글 →
팀 타임엔트리(증분은 7일 마진) → `ingestItems` 멱등 upsert(200건 배치) → `healPmMirror`(부모/리스트/상태키 수렴) →
**전부 성공 후에만 커서 전진**(`connector_state('clickup', <teamId>[:<수집기 instance>])` 의 `tasks_max_updated_ms`,
1초 epsilon 재폴링 — upsert 가 dedup).

- **무변경 재싱크 = 무소음:** 미러는 본문/제목이 실제로 바뀐 경우에만 `org_content_audit` 리비전을 남긴다
  (no-op 재싱크는 행만 갱신). 아이템은 (system, instance, external_id) upsert 라 중복이 없다.
- **최초 무손실 이관 자동 승격:** 커서에 `lossless_full_done` 이 없으면 증분 요청이어도 이번 run 을 full 로 1회 승격한다
  (무결 완주 시 플래그를 기록해 재승격하지 않는다).
- **rate budget:** 태스크마다 hydration 1콜 + 댓글 1콜(+ 계층·리스트 상세·뷰·필드 정의). 한도 100 req/min/token 은
  `clickupFetch` 가 `X-RateLimit-Remaining=0` 선제 대기 + 429 `retry-after` 재시도로 흡수한다 — 전체 백필은 태스크 수에
  비례해 오래 걸릴 수 있다(120초마다 진행 로그 — run-tracker 의 15분 무출력 킬 방지).
- exit code: 스트림 예외·수집(fetch) 실패·항목 단위 미러 실패가 하나라도 있으면 1, 아니면 0.
  **실패 run 은 커서를 전진시키지 않는다(코드로 강제)** — 다음 run 이 같은 윈도를 재폴링해 수렴하며,
  멱등 upsert 라 재폴링은 무비용(수동 `--full`/커서 리셋 불필요). hydration 이 실패한 태스크는 얕은 응답으로 폴백하지 않고
  skip 한다(첨부 삭제·본문 다운그레이드 방지).
- **리스트 간 태스크 이동 자동 수렴:** hydration 이 드러낸 서브태스크(타 리스트 이동 포함)를 따라가 적재하고,
  upsert 와 `healPmMirror` 가 부모/리스트 좌표를 갱신한다.

## 2. 나열/제외 규칙

스페이스 → 폴더(active+archived 패스)의 리스트 + folderless 리스트(active+archived 패스) → 필터 적용:
`CLICKUP_INCLUDE_LIST_IDS`(설정 시 **이 리스트만** — allowlist) 와 `CLICKUP_EXCLUDE_LIST_IDS`(denylist). 둘 다 관리탭
수집기(`include_list_ids`·`exclude_list_ids` — 목록에서 선택) 또는 `.env`(쉼표구분)로 준다. 필터는 hydration 이
드러내는 부모/이동 서브태스크에도 적용되고, allowlist 스코프면 허용 리스트가 있는 스페이스/폴더만 이관한다(빈 컨테이너
유입 방지). 예: ClickUp 샘플 리스트(Get Started with ClickUp / Project 1 / Project 2). **새 샘플/노이즈 리스트가 생기면
제외 목록에 추가하기 전까지 싱크된다** — 대안은 ClickUp UI 에서 샘플 리스트를 보관(archive)하는 것(archived 패스로 보관 상태가 수렴).

## 3. 아웃바운드 push (구 pm_* write-through 대체)

구 `pm_task_*` MCP 툴(create·update_status·assign·comment·link·archive)은 폐기됐다 — 태스크 편집은
`task_*_v6`·`project_*_v6` 표면이 맡는다([docs/architecture.ko.md](../docs/architecture.ko.md)). ClickUp 반영 경로:

- 로컬 생성·수정·삭제(web/MCP)가 `external_outbox` 에 적재된다(`src/v6/external-outbox.ts` — pending 은 엔티티당 1행으로
  coalesce, 커넥터 인바운드 쓰기는 적재하지 않는다=루프 차단). 삭제는 미러된(external_id 가 있는) 행만 적재된다.
- 드레인: `node --env-file-if-exists=.env dist/connectors/run-push.js clickup`(`src/connectors/clickup-push.ts`).

| op | 의미론 |
|---|---|
| 생성 | project=컨테이너 List 안 최상위 Task, task=Subtask(parent=project-Task), subtask=중첩 Subtask. `CLICKUP_CONTAINER_LIST_ID`(관리탭 '컨테이너 리스트') 필수 — 없으면 그 행은 에러로 남는다. 부모가 아직 미푸시면 자식은 다음 틱으로 defer. 생성 후 external_id/url 링크백 |
| 수정 | name·`markdown_description`·status·priority·start/due 를 PUT. status 는 정규 카테고리 → 스페이스 상태셋으로 매핑하고, 불일치면 status 를 빼고 1회 재시도 |
| 삭제 | ClickUp 태스크 **하드 삭제**(`DELETE /task/<id>` — 이미 없으면(404) 성공 취급) |

- 멱등: 드레인이 현재 project 행을 다시 읽어 upsert — 두 번 돌려도 같은 ClickUp 상태로 수렴한다. 푸시한 값은
  `external_base`(3-way 머지의 공통조상)로 전진해, 다음 인바운드가 외부 편집만 골라낸다.
- 실패 행은 `attempts`·`last_error` 가 남고 다음 틱에 재시도한다. exit 1 = 실패 행 존재.
- 공개범위가 잠긴 리스트의 **네이티브**(우리에서 태어난) 프로젝트는 반출하지 않는다(#1291). 미러 기원 행은 그대로 푸시한다.

## 4. 스케줄

스케줄러 크론 액션으로 돈다(검증된 CLI 를 서브프로세스로 실행 — 임의 셸 금지):

- `connector_sync`(외부→우리) — params `system`(비우면 켜진 수집기 전부)·`collector_id`·`full`. 실행은 `connector_run`
  으로 기록되고 웹에서 관찰된다.
- `connector_push`(우리→외부) — `run-push.js clickup`.

수동 1회는 위 CLI 또는 `org_collector_sync_run`·`org_connector_sync_run`. 세션 안에서 도는 루프가 필요하면:

```
/loop 10m node --env-file-if-exists=.env dist/connectors/run-sync.js clickup
```

주기는 2~3분보다 타이트하게 잡지 말 것 — 한도 100/min 을 토큰 단위로 공유한다.

## 5. 트러블슈팅

- **`CLICKUP_API_TOKEN 미설정`:** 관리탭 수집기에 API Token 을 저장하거나 토큰 출처(`org`/`member:<id>`)를 지정, 또는 `.env`.
- **`ClickUp 워크스페이스 없음`:** 토큰 권한 확인.
- **`CLICKUP_CONTAINER_LIST_ID 미설정 — 아웃바운드 create 불가`:** 관리탭 '컨테이너 리스트' 지정(보통 포함 리스트와 동일).
- **로컬 편집이 ClickUp 에 안 나간다:** `connector_push` 크론이 켜져 있는지, 그리고 pending 행의 에러를 확인:
  `SELECT id, entity_id, op, attempts, last_error FROM external_outbox WHERE system='clickup' AND done_at IS NULL;`
- **아웃오브밴드 보관(UI 에서 archive):** 리스트/태스크 모두 archived 패스가 다음 run 에 수렴.
  ClickUp 에서 **하드 삭제**된 객체는 인바운드가 탐지 못 한다(미러 행이 stale 로 남음).
- **리스트 간 태스크 이동:** 자동 수렴(§1).
- **커서 리셋:** `DELETE FROM connector_state WHERE system='clickup'` 후 run-sync(=전체 백필). 멱등이라 안전.
  한 번만 전체로 돌리려면 `--full` 이 더 간단하다.

## 6. 검증 절차

1. `run-sync clickup --full` ×2 — 2회차는 행 수 불변(멱등 upsert), 본문/제목 변경이 없으면 `org_content_audit`
   리비전 추가 없음.
2. 미러된 태스크를 웹 또는 MCP(`task_update_v6`)로 수정 → `external_outbox` 에 pending 1행 → `run-push clickup` →
   ClickUp 반영, 그 행에 `done_at` 기록.
3. `run-sync clickup`(증분) → 같은 external_id 1행 유지, 로컬 편집 값 유지.

(구 절차 — `pm_task_create`/`comment`/`update_status`/`archive` 리플레이, 2026-06-11 검증 잔재 task 86exxdbmd / item 612 —
는 `pm_*` 폐기로 더는 재현할 수 없다.)
