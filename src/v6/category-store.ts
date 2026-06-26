// v6 category 데이터 접근 — 구 domain 일반화(space 3값: 사업/제품/시스템, repo 분리).
//  도메인 = space='product' 부분집합(is/debt/엣지 보유). itemsPool 직접 + q/one 헬퍼(domainmap/db) 재사용.
//  감사는 org_content_audit(entity='category') — knowledge/domain 과 동일 append-only 패턴.
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";
import { auditOrgContent, restoreSnapshot, type WriteCtx } from "../db/write.js";

const CATEGORY_COLS =
  `id, space, key, name, description, should, cross_cutting, origin, status, state, created_at, updated_at`;

export interface CategoryRow {
  id: number; space: string; key: string; name: string | null;
  description: string | null; should: string | null; cross_cutting: boolean;
  origin: string | null; status: string; state: string;
  created_at: string; updated_at: string;
  // 오너 팀(team_category relation='owner') — listCategories 만 채운다(LEFT JOIN). 쓰기/감사 경로는 base 컬럼만.
  owner_team_id?: number | null; owner_team_key?: string | null; owner_team_name?: string | null;
}

// 읽기 전용 SELECT(목록) — base 컬럼 + 오너 팀 조인. 쓰기 RETURNING/restoreSnapshot 은 CATEGORY_COLS(base)만 사용.
const CATEGORY_SEL =
  `${CATEGORY_COLS.split(",").map((c) => "c." + c.trim()).join(", ")},
   tco.team_id AS owner_team_id, tot.key AS owner_team_key, tot.name AS owner_team_name`;
const CATEGORY_OWNER_JOIN =
  `LEFT JOIN team_category tco ON tco.category_id=c.id AND tco.relation='owner'
   LEFT JOIN team tot ON tot.id=tco.team_id`;

export interface CategoryEdgeRow {
  id: number; from_category_id: number; to_category_id: number;
  axis: string; relation: string; origin: string | null; weight: number | null;
  from_key?: string; to_key?: string; from_name?: string | null; to_name?: string | null;
}

// append-only 감사(org_content_audit, entity='category') — 공유 헬퍼 위임.
const auditCategory = (entityKey: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("category", entityKey, op, before, after, ctx);

export async function listCategories(space?: string): Promise<CategoryRow[]> {
  if (space) {
    return q(itemsPool,
      `SELECT ${CATEGORY_SEL} FROM category c ${CATEGORY_OWNER_JOIN}
       WHERE c.space=$1 AND c.state<>'merged' ORDER BY c.name NULLS LAST, c.key`, [space]);
  }
  return q(itemsPool,
    `SELECT ${CATEGORY_SEL} FROM category c ${CATEGORY_OWNER_JOIN}
     WHERE c.state<>'merged' ORDER BY c.space, c.name NULLS LAST, c.key`);
}

export async function getCategory(id: number): Promise<CategoryRow | undefined> {
  return one(itemsPool, `SELECT ${CATEGORY_COLS} FROM category WHERE id=$1`, [id]);
}

export async function getCategoryByKey(space: string, key: string): Promise<CategoryRow | undefined> {
  return one(itemsPool,
    `SELECT ${CATEGORY_COLS} FROM category WHERE space=$1 AND key=$2 AND state<>'merged'`, [space, key]);
}

export async function createCategory(
  input: { space: string; key: string; name?: string; description?: string; should?: string; cross_cutting?: boolean },
  ctx?: WriteCtx,
): Promise<CategoryRow> {
  const origin = ctx?.source === "mcp" ? "agent" : "human";
  const row: CategoryRow = await one(itemsPool,
    `INSERT INTO category(space, key, name, description, should, cross_cutting, origin, status, state, created_at, updated_at)
     VALUES($1,$2,$3,$4,$5,COALESCE($6,false),$7,'confirmed','active',now(),now())
     RETURNING ${CATEGORY_COLS}`,
    [input.space, input.key, input.name ?? null, input.description ?? null,
     input.should ?? null, input.cross_cutting ?? null, origin]);
  await auditCategory(`${input.space}/${input.key}`, "insert", null, row, ctx);
  return row;
}

export async function updateCategory(
  id: number,
  patch: { name?: string; description?: string; should?: string; cross_cutting?: boolean },
  ctx?: WriteCtx,
): Promise<CategoryRow> {
  const before = await getCategory(id);
  if (!before) throw new Error(`카테고리 #${id} 없음`);
  // COALESCE($n, col): undefined→null→기존값 보존(부분 수정).
  const row: CategoryRow = await one(itemsPool,
    `UPDATE category SET
       name=COALESCE($2,name), description=COALESCE($3,description),
       should=COALESCE($4,should), cross_cutting=COALESCE($5,cross_cutting), updated_at=now()
     WHERE id=$1 RETURNING ${CATEGORY_COLS}`,
    [id, patch.name ?? null, patch.description ?? null, patch.should ?? null, patch.cross_cutting ?? null]);
  await auditCategory(`${before.space}/${before.key}`, "update", before, row, ctx);
  return row;
}

export async function deleteCategory(id: number, ctx?: WriteCtx): Promise<{ deleted: boolean; id: number }> {
  const before = await getCategory(id);
  if (!before) throw new Error(`카테고리 #${id} 없음`);
  await itemsPool.query(`DELETE FROM category WHERE id=$1`, [id]); // FK CASCADE: 매핑·엣지·정션 동반 삭제
  await auditCategory(`${before.space}/${before.key}`, "delete", before, null, ctx);
  return { deleted: true, id };
}

// 복원 — 마지막 delete 의 before 스냅샷을 원래 id 로 재적재한다. 매핑·엣지·정션은 삭제 시 cascade 됐으므로
//  복원되지 않는다(카테고리 본체만). 이미 존재하면 거부. (space/key 유니크 충돌 시 DB 가 throw.)
//  사람전용 게이트는 capability 계층(content_restore)에서 선행.
export async function restoreCategory(before: Record<string, unknown>, ctx?: WriteCtx): Promise<CategoryRow> {
  const after = await restoreSnapshot<CategoryRow>("category", CATEGORY_COLS, "id", before);
  await auditCategory(`${after.space}/${after.key}`, "restore", null, after, ctx);
  return after;
}

// ── category_edge (도메인 의존) — axis='should'(수동 저작) | 'is'(스캔 전용, 여기서 안 만듦). ──
export async function listCategoryEdges(filter?: { categoryId?: number; axis?: string }): Promise<CategoryEdgeRow[]> {
  const wh: string[] = [];
  const params: unknown[] = [];
  if (filter?.categoryId != null) {
    params.push(filter.categoryId);
    wh.push(`(e.from_category_id=$${params.length} OR e.to_category_id=$${params.length})`);
  }
  if (filter?.axis) {
    params.push(filter.axis);
    wh.push(`e.axis=$${params.length}`);
  }
  const where = wh.length ? `WHERE ${wh.join(" AND ")}` : "";
  return q(itemsPool,
    `SELECT e.id, e.from_category_id, e.to_category_id, e.axis, e.relation, e.origin, e.weight,
            cf.key AS from_key, ct.key AS to_key, cf.name AS from_name, ct.name AS to_name
     FROM category_edge e
     JOIN category cf ON cf.id=e.from_category_id
     JOIN category ct ON ct.id=e.to_category_id
     ${where} ORDER BY e.axis, cf.key, ct.key`, params);
}

export async function setCategoryEdge(
  input: { from_category_id: number; to_category_id: number; relation?: string },
  ctx?: WriteCtx,
): Promise<CategoryEdgeRow> {
  if (input.from_category_id === input.to_category_id) throw new Error("자기 참조 엣지는 불가합니다");
  const origin = ctx?.source === "mcp" ? "agent" : "human";
  // 수동 저작 = axis 'should'(의도된 관계). is 는 스캔 upsert 전용.
  return one(itemsPool,
    `INSERT INTO category_edge(from_category_id, to_category_id, axis, relation, origin, created_at, updated_at)
     VALUES($1,$2,'should',COALESCE($3,'depends_on'),$4,now(),now())
     ON CONFLICT (from_category_id, to_category_id, axis)
     DO UPDATE SET relation=EXCLUDED.relation, updated_at=now()
     RETURNING id, from_category_id, to_category_id, axis, relation, origin, weight`,
    [input.from_category_id, input.to_category_id, input.relation ?? null, origin]);
}

export async function removeCategoryEdge(id: number): Promise<{ deleted: boolean; id: number }> {
  const r = await itemsPool.query(`DELETE FROM category_edge WHERE id=$1 AND axis='should'`, [id]);
  if (!r.rowCount) throw new Error(`should 엣지 #${id} 없음(is 엣지는 스캔 소유라 수동 삭제 불가)`);
  return { deleted: true, id };
}
