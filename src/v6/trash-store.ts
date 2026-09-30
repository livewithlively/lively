// v6 휴지통(삭제됨) 데이터 접근 — 감사로그(org_content_audit)를 단일 소스로 본다.
//  별도 휴지통 테이블/TTL 없음: append-only 감사가 before 스냅샷을 보존하므로 그게 곧 휴지통이다.
//  "현재 삭제 상태" = (entity, entity_key) 별 마지막 op 이 'delete' 인 것(이후 insert/restore 가 없는 것).
//  복원은 capability(content_restore)가 getDeleteSnapshot → 엔티티별 restore* 로 재적재한다.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { labelOf, purgeAxesOf, TRASHABLE_SOURCE_SYSTEMS } from "./trash-shape.js";
export { previewOf, PREVIEW_BODY_MAX, isMirroredSourceSnapshot, purgeAxesOf, type DeletePreview } from "./trash-shape.js";

// 휴지통 대상 엔티티 — knowledge/project/category + source(#3778: 자료도 지우면 되살릴 문이 있어야 한다.
//  deleteSource 는 처음부터 before 전문을 남겼는데 여기 목록에 없어서 «스냅샷은 있고 꺼낼 문은 없는» 상태였다).
//  도메인맵 repo/domain 은 레거시 hard-delete 경로 별도.
export const TRASH_ENTITIES = ["knowledge", "project", "category", "source"] as const;
export type TrashEntity = typeof TRASH_ENTITIES[number];

export interface DeletedRow {
  entity: string;
  key: string;
  label: string;
  at: string;
  actor: string | null;
  actor_kind: string | null;
  // #1291 — 공개범위 판정 근거. 삭제된 행은 본체 테이블에 없으므로 술어가 물어볼 곳이 여기뿐이다.
  //  before 스냅샷 전체를 밖으로 흘리면 그게 곧 본문 유출이라(지식 before 엔 body_md 가 들어 있다)
  //  **판정에 필요한 두 필드만** 꺼내 온다.
  visibility: string | null;   // knowledge · source
  list_id: number | null;      // project
  // #3778 — 휴지통 네 탭이 줄을 가르는 재료. 본문은 여기 싣지 않는다(위 #1291 과 같은 이유) — 본문은 getDeletePreview 가 게이트 뒤에서 준다.
  level: string | null;        // project — project|task|subtask (태스크 삭제도 entity='project' 로 쌓인다, #1850 F4)
  kind: string | null;         // source — slack·transcript·local_file …
  doc_type: string | null;     // knowledge — decision·how-to …
}

// 현재 삭제 상태인 항목 — 각 (entity, entity_key) 의 최신 감사행이 op='delete' 인 것만, 최신 삭제순.
export async function listDeleted(limit = 200, offset = 0, entity?: TrashEntity | null, includeMirrors = false): Promise<DeletedRow[]> {
  //  entity 를 주면 그 종류만(#3778 네 탭 — 탭마다 제 목록을 제 상한으로 받는다. 한 목록 200건을 넷이 나눠 쓰면
  //   프로젝트·태스크 243건이 지식 43건을 화면 밖으로 밀어낸다: 실측 2026-09-20).
  const entities = entity && (TRASH_ENTITIES as readonly string[]).includes(entity) ? [entity] : (TRASH_ENTITIES as unknown as string[]);
  const rows = await q(itemsPool,
    `SELECT entity, entity_key, at, actor, actor_kind, before
       FROM (
         SELECT DISTINCT ON (entity, entity_key)
                entity, entity_key, op, at, actor, actor_kind, before
           FROM org_content_audit
          WHERE entity = ANY($1)
          ORDER BY entity, entity_key, at DESC, id DESC
       ) latest
      WHERE latest.op = 'delete'
        -- #1850 P4: 완전 삭제(purge)된 항목은 스냅샷이 비어(before IS NULL) 복원할 것이 없다 — "(제목 없음)" 유령 행으로
        --  휴지통에 세우지 않는다. 일반 삭제는 before 에 전문이 있어 그대로 복원된다.
        AND latest.before IS NOT NULL
        -- #3778 2차: 수집해 온 자료(원본이 밖에 있는 것)의 스냅샷은 세우지 않는다 — trash-shape.isMirroredSourceSnapshot 과 같은 판정.
        --  SQL 에서 거르는 이유: 상한(LIMIT)이 거른 **뒤에** 걸려야 한다. 밖에서 거르면 일괄 정리 2천 건이 상한을 다 먹는다.
        AND ($4::boolean OR latest.entity <> 'source' OR COALESCE(latest.before->>'external_system', '') = ANY($5))
      ORDER BY at DESC
      LIMIT $2 OFFSET $3`,   // #709 offset — 최신 삭제 N건 너머 옛 삭제 항목 복원 도달
    [entities, Math.min(Math.max(Number(limit) || 200, 1), 500),
     Math.min(Math.max(Number(offset) || 0, 0), 1_000_000), !!includeMirrors, TRASHABLE_SOURCE_SYSTEMS as unknown as string[]]);
  return rows.map((r: any) => ({
    entity: r.entity,
    key: r.entity_key,
    label: labelOf(r.entity, r.before),
    at: r.at,
    actor: r.actor ?? null,
    actor_kind: r.actor_kind ?? null,
    visibility: (r.before?.visibility as string) ?? null,
    list_id: r.before?.list_id == null ? null : Number(r.before.list_id),
    level: r.entity === "project" ? ((r.before?.level as string) ?? null) : null,
    kind: r.entity === "source" ? ((r.before?.kind as string) ?? null) : null,
    doc_type: r.entity === "knowledge" ? ((r.before?.type as string) ?? null) : null,
  }));
}

/**
 * 휴지통 개수(#3778 — 사이드바 「휴지통 N」). listDeleted + 공개범위 게이트(capabilities/trash.ts filterVisibleDeleted)와
 *  **같은 모집단**을 본문 없이 센다 — 목록 조회는 스냅샷 전문(before)을 통째로 끌어와 배지 하나에 쓰기엔 무겁다(지식 500건 = 본문 500개).
 *  ⚠ 아래 조건은 listDeleted 의 WHERE 와 filterVisibleDeleted 의 판정을 그대로 옮긴 것이다 — 한쪽을 고치면 여기도 고친다.
 *    (DB 없는 단위 시험으론 못 재는 축이라, 배포 뒤 끝단 검사가 «개수 = 목록 길이» 를 실데이터로 잰다.)
 *  gate=false 는 특권(내부·긴급 열람) — 목록과 같이 전부 센다. visibleListIds=null 은 «리스트 제한 없음».
 *  화면 상한과 맞추려고 종류마다 TRASH_COUNT_CAP 에서 자른다(탭은 500건까지만 받는다).
 */
export const TRASH_COUNT_CAP = 500;
export async function countDeleted(opts: { gate: boolean; visibleListIds: number[] | null }): Promise<{ knowledge: number; project: number; source: number }> {
  const rows = await q(itemsPool,
    `SELECT latest.entity, LEAST(count(*), $5)::int AS n
       FROM (
         SELECT DISTINCT ON (entity, entity_key) entity, entity_key, op, before
           FROM org_content_audit
          WHERE entity = ANY($1)
          ORDER BY entity, entity_key, at DESC, id DESC
       ) latest
      WHERE latest.op = 'delete'
        AND latest.before IS NOT NULL
        AND (latest.entity <> 'source' OR COALESCE(latest.before->>'external_system', '') = ANY($2))
        AND (NOT $3::boolean
             OR (latest.entity IN ('knowledge', 'source') AND COALESCE(latest.before->>'visibility', '') <> 'members')
             OR (latest.entity = 'project' AND ($4::int[] IS NULL OR latest.before->>'list_id' IS NULL
                   OR CASE WHEN latest.before->>'list_id' ~ '^[0-9]+$' THEN (latest.before->>'list_id')::int = ANY($4) ELSE false END)))
      GROUP BY latest.entity`,
    [["knowledge", "project", "source"], TRASHABLE_SOURCE_SYSTEMS as unknown as string[], !!opts.gate, opts.visibleListIds, TRASH_COUNT_CAP]);
  const out = { knowledge: 0, project: 0, source: 0 };
  for (const r of rows as Array<{ entity: string; n: number }>) if (r.entity in out) (out as Record<string, number>)[r.entity] = Number(r.n) || 0;
  return out;
}

// 복원용 스냅샷 — 해당 (entity, key) 의 가장 최근 delete 의 before(전문 행). 없으면 undefined.
export async function getDeleteSnapshot(entity: string, key: string): Promise<Record<string, unknown> | undefined> {
  const row = await one(itemsPool,
    `SELECT before FROM org_content_audit
      WHERE entity=$1 AND entity_key=$2 AND op='delete'
      ORDER BY at DESC, id DESC LIMIT 1`, [entity, key]);
  return row ? (row.before as Record<string, unknown>) : undefined;
}

// ── 파기(#3778 — 설계는 #1850 trash-flow-redesign 계약 1, 8/24 에 한 번 만들었다가 되돌린 것을 되살린다) ─────────
//  **본문만 지우고 행은 남긴다.** 그 키의 **모든** 감사 행(delete 만이 아니라 insert·update·link 의 before/after 전부 —
//  지식 변경이력이 같은 표를 읽는다)을 비운다. 호출자가 op='purge' 행을 하나 남긴다 — «누가 언제 파기했다»는 남고 내용은 어디에도 없다.
//  ⚠ org_content_audit 를 UPDATE 하는 곳은 이 함수와 session-footprint-store.blankAuditSnapshots 둘뿐이다 — 늘리지 마라.
//  전제: 지금 삭제 상태(최신 op='delete')여야 한다 — 살아 있는 것을 파기하면 «지웠는데 살아 있는» 모순이 된다. 호출자가 isDeletedNow 로 확인한다.
//  지식은 **두 축**을 함께 비운다 — 항상-주입 섹션은 같은 문서가 entity='org_section' 으로도 감사된다(섹션 편집·삭제, org/store/sections.ts).
//   한 축만 비우면 «완전히 지웠다» 는 문서의 본문이 다른 축의 before/after 에 그대로 남는다(지식 변경이력도 두 축을 함께 읽는다 — HISTORY_ENTITIES).
//   어느 축들인지는 trash-shape.purgeAxesOf(순수 — 값으로 시험한다).
export async function purgeDeleted(entity: string, key: string): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_content_audit SET before = NULL, after = NULL
      WHERE entity = ANY($1) AND entity_key = $2 AND (before IS NOT NULL OR after IS NOT NULL)`,
    [purgeAxesOf(entity), key]);
  return r.rowCount || 0;
}

// 지금 삭제 상태인가 — (entity,key) 의 최신 감사 op 가 'delete' 인지. listDeleted 와 같은 판정(한 건용).
export async function isDeletedNow(entity: string, key: string): Promise<boolean> {
  const row = await one(itemsPool,
    `SELECT op FROM org_content_audit WHERE entity=$1 AND entity_key=$2 ORDER BY at DESC, id DESC LIMIT 1`, [entity, key]);
  return !!row && (row as { op?: string }).op === "delete";
}
