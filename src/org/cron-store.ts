// org_cron 데이터 접근(#1313 R45) — 서버사이드 스케줄 잡 정의(웹 관리탭 CRUD)의 단일 SQL 지점.
//  capabilities/cron.ts 가 직접 itemsPool.query 하던 4개 쿼리를 원문 그대로 내렸다 — 스키마가 바뀌면
//  여기 한 파일만 고치면 되게(표면 계층은 '무엇을' 만 알고 '어떻게 저장되나'는 모른다).
//  ⚠ 실행 엔진(scheduler/engine.ts)의 상태 갱신(last_run_at·next_run_at)과 커넥터 자동싱크 잡 등록
//   (org/store/connectors.ts)은 여전히 각자 SQL 을 갖는다 — 관리 CRUD 와 다른 생명주기라 이 파일 범위 밖.
//  감사 없음: org_cron 은 org-content(org_content_audit 대상)가 아니라 게이트웨이 운영 설정이다.
import { itemsPool } from "../db/client.js";

// 잡 행은 스키마가 계속 붙는 운영 테이블(cron_expr·run_once·last_* 가 순차 추가됐다) — 표면이 그대로
//  통과시키는 값이라 열 목록을 타입으로 고정하지 않는다(SELECT * 원문 유지).
export type CronJobRow = Record<string, unknown>;

export interface CronJobInsert {
  id: string;
  label: string | null;
  action: string;
  params: string;          // JSON 문자열(호출부가 JSON.stringify 해서 넘긴다)
  interval_sec: number;
  cron_expr: string | null;
  enabled: boolean | null; // null=기본값(true)
  note: string | null;
  run_once: boolean | null; // null=기본값(false)
  actor: string | null;     // created_by/updated_by 동시 세팅($10 재사용)
}

export interface CronJobUpdate {
  id: string;
  label: string | null;
  action: string | null;
  params: string | null;    // null=보존(COALESCE)
  interval_sec: number | null;
  cron_provided: boolean;   // cron_expr 를 명시적으로 준 요청인가 — false 면 기존 값 보존
  cron_expr: string | null;
  enabled: boolean | null;
  note: string | null;
  run_once: boolean | null;
  actor: string | null;
}

// 전체 목록 — 관리탭 표시 순서(sort, id). 정의 전체를 그대로 싣는다(액션·주기·마지막 실행 상태).
export async function listCronJobs(): Promise<CronJobRow[]> {
  return (await itemsPool.query(`SELECT * FROM org_cron ORDER BY sort, id`)).rows;
}

// 존재 확인 — upsert 분기(신규 INSERT vs 기존 UPDATE) 판정용. 없으면 undefined.
export async function getCronJob(id: string): Promise<{ id: string } | undefined> {
  return (await itemsPool.query(`SELECT id FROM org_cron WHERE id=$1`, [id])).rows[0];
}

export async function insertCronJob(v: CronJobInsert): Promise<CronJobRow> {
  const r = await itemsPool.query(
    `INSERT INTO org_cron(id,label,action,params,interval_sec,cron_expr,enabled,note,run_once,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,true),$8,COALESCE($9,false),$10,$10) RETURNING *`,
    [v.id, v.label, v.action, v.params,
     v.interval_sec, v.cron_expr, v.enabled, v.note, v.run_once, v.actor]);
  return r.rows[0];
}

// 정의 upsert — **실행 이력(last_run_at·next_run_at)을 보존**하며 정의만 갈아 끼운다(#1780 v2 §7-1, 설계 R2-O5).
//  앱 재설치/업그레이드의 크론 재전개가 종전엔 delete+insert 라 last_run_at 이 사라져 interval 잡이 **즉시 due**
//  가 됐다(예정 외 실행). enabled 는 INSERT 와 같은 규칙(null=true) 이고, 켜는 방향이면 사람이 켤 때(updateCronJob)
//  와 같이 브레이커를 초기화한다 — 재전개는 사람의 "다시 켬" 과 같은 의도.
//  ⚠ 충돌 키는 (tenant_id, id) — CREATE TABLE 은 `id PRIMARY KEY` 지만 부팅 체인이 테넌트 복합 PK 로 다시 쓴다
//   (connectors.ts 의 org_cron upsert 와 동일; `ON CONFLICT (id)` 는 실-DB 에서 "no unique constraint" 로 죽는다 — itest 실측).
export async function upsertCronJob(v: CronJobInsert): Promise<CronJobRow> {
  const r = await itemsPool.query(
    `INSERT INTO org_cron(id,label,action,params,interval_sec,cron_expr,enabled,note,run_once,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,true),$8,COALESCE($9,false),$10,$10)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       label=EXCLUDED.label, action=EXCLUDED.action, params=EXCLUDED.params,
       interval_sec=EXCLUDED.interval_sec, cron_expr=EXCLUDED.cron_expr, enabled=EXCLUDED.enabled,
       note=EXCLUDED.note, run_once=EXCLUDED.run_once,
       fail_streak = CASE WHEN EXCLUDED.enabled THEN 0 ELSE org_cron.fail_streak END,
       auto_disabled_at = CASE WHEN EXCLUDED.enabled THEN NULL ELSE org_cron.auto_disabled_at END,
       auto_disabled_reason = CASE WHEN EXCLUDED.enabled THEN NULL ELSE org_cron.auto_disabled_reason END,
       version=org_cron.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING *`,
    [v.id, v.label, v.action, v.params,
     v.interval_sec, v.cron_expr, v.enabled, v.note, v.run_once, v.actor]);
  return r.rows[0];
}

// 부분 수정 — COALESCE($n, col) 로 미제공 키는 보존. cron_expr 만 3상태(미제공=보존 / ""=해제 / 값=설정)라
//  $6(제공 여부) 플래그로 CASE 분기한다(COALESCE 로는 '명시적 NULL' 을 표현할 수 없다).
export async function updateCronJob(v: CronJobUpdate): Promise<CronJobRow> {
  const r = await itemsPool.query(
    `UPDATE org_cron SET
       label=COALESCE($2,label), action=COALESCE($3,action),
       params=COALESCE($4,params), interval_sec=COALESCE($5,interval_sec),
       cron_expr = CASE WHEN $6::boolean THEN $7::text ELSE cron_expr END,
       enabled=COALESCE($8,enabled), note=COALESCE($9,note), run_once=COALESCE($11,run_once),
       version=version+1, updated_at=now(), updated_by=$10
     WHERE id=$1 RETURNING *`,
    [v.id, v.label, v.action,
     v.params,
     v.interval_sec, v.cron_provided, v.cron_expr,
     v.enabled, v.note, v.actor, v.run_once]);
  return r.rows[0];
}

// 삭제 — 지운 행이 있었으면 true(없는 id 도 에러가 아니다: 관리탭은 멱등 삭제).
export async function deleteCronJob(id: string): Promise<boolean> {
  const r = await itemsPool.query(`DELETE FROM org_cron WHERE id=$1`, [id]);
  return (r.rowCount ?? 0) > 0;
}
