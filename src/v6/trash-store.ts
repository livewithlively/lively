// v6 휴지통(삭제됨) 데이터 접근 — 감사로그(org_content_audit)를 단일 소스로 본다.
//  별도 휴지통 테이블/TTL 없음: append-only 감사가 before 스냅샷을 보존하므로 그게 곧 휴지통이다.
//  "현재 삭제 상태" = (entity, entity_key) 별 마지막 op 이 'delete' 인 것(이후 insert/restore 가 없는 것).
//  복원은 capability(content_restore)가 getDeleteSnapshot → 엔티티별 restore* 로 재적재한다.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { labelOf } from "./trash-shape.js";
export { previewOf, PREVIEW_BODY_MAX, type DeletePreview } from "./trash-shape.js";

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
export async function listDeleted(limit = 200, offset = 0, entity?: TrashEntity | null): Promise<DeletedRow[]> {
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
      ORDER BY at DESC
      LIMIT $2 OFFSET $3`,   // #709 offset — 최신 삭제 N건 너머 옛 삭제 항목 복원 도달
    [entities, Math.min(Math.max(Number(limit) || 200, 1), 500),
     Math.min(Math.max(Number(offset) || 0, 0), 1_000_000)]);
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
export async function purgeDeleted(entity: string, key: string): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_content_audit SET before = NULL, after = NULL
      WHERE entity = $1 AND entity_key = $2 AND (before IS NOT NULL OR after IS NOT NULL)`,
    [entity, key]);
  return r.rowCount || 0;
}

// 지금 삭제 상태인가 — (entity,key) 의 최신 감사 op 가 'delete' 인지. listDeleted 와 같은 판정(한 건용).
export async function isDeletedNow(entity: string, key: string): Promise<boolean> {
  const row = await one(itemsPool,
    `SELECT op FROM org_content_audit WHERE entity=$1 AND entity_key=$2 ORDER BY at DESC, id DESC LIMIT 1`, [entity, key]);
  return !!row && (row as { op?: string }).op === "delete";
}
