// v6 휴지통(삭제됨) 데이터 접근 — 감사로그(org_content_audit)를 단일 소스로 본다.
//  별도 휴지통 테이블/TTL 없음: append-only 감사가 before 스냅샷을 보존하므로 그게 곧 휴지통이다.
//  "현재 삭제 상태" = (entity, entity_key) 별 마지막 op 이 'delete' 인 것(이후 insert/restore 가 없는 것).
//  복원은 capability(content_restore)가 getDeleteSnapshot → 엔티티별 restore* 로 재적재한다.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";

// 휴지통 대상 엔티티 — knowledge/project/category 만(도메인맵 repo/domain 은 레거시 hard-delete 경로 별도).
export const TRASH_ENTITIES = ["knowledge", "project", "category"] as const;

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
  visibility: string | null;   // knowledge
  list_id: number | null;      // project
}

// before 스냅샷에서 사람이 읽을 라벨 — 엔티티별 표시 필드.
function labelOf(entity: string, before: Record<string, unknown> | null): string {
  const b = before ?? {};
  if (entity === "knowledge") return (b.title as string) || (b.name as string) || "(제목 없음)";
  if (entity === "project") return (b.name as string) || `#${b.id ?? ""}`;
  if (entity === "category") return (b.name as string) || (b.key as string) || `#${b.id ?? ""}`;
  return (b.name as string) || (b.key as string) || "";
}

// 현재 삭제 상태인 항목 — 각 (entity, entity_key) 의 최신 감사행이 op='delete' 인 것만, 최신 삭제순.
export async function listDeleted(limit = 200, offset = 0): Promise<DeletedRow[]> {
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
    [TRASH_ENTITIES as unknown as string[], Math.min(Math.max(Number(limit) || 200, 1), 500),
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
