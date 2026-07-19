// #976 위키 아웃바운드 라우팅 store — 피드 목적지 레지스트리(feed_target) + 카테고리↔피드 N:M(category_feed).
//  발행 게이트 = 옵트인 매핑: 카테고리를 feed_target 에 매핑해야 그 도메인 지식이 그 피드로 나간다(설정 전엔 아무것도 안 나감).
//  writer(notion-push)는 타깃별 호출이라 N:M 이 그대로 성립 — 여기선 '무엇을 어디로'만 해소한다.
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";

export interface FeedTargetRow {
  id: number; system: string; instance: string | null; target_id: string;
  data_source_id: string | null; parent_page_id: string | null; title: string | null;
  exclude_registered: boolean; all_categories: boolean; state: string;
}

const FT_COLS = "id, system, instance, target_id, data_source_id, parent_page_id, title, exclude_registered, all_categories, state";

// 피드 목적지 등록(멱등 upsert — (system,instance,target_id) 좌표). 기존이면 메타 갱신.
export async function createFeedTarget(t: {
  system: string; instance?: string | null; targetId: string;
  dataSourceId?: string | null; parentPageId?: string | null; title?: string | null;
}): Promise<FeedTargetRow> {
  const r = await one(itemsPool,
    `INSERT INTO feed_target(system, instance, target_id, data_source_id, parent_page_id, title, created_at, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,now(),now())
     ON CONFLICT (system, target_id) DO UPDATE SET
       data_source_id=COALESCE(EXCLUDED.data_source_id, feed_target.data_source_id),
       parent_page_id=COALESCE(EXCLUDED.parent_page_id, feed_target.parent_page_id),
       title=COALESCE(EXCLUDED.title, feed_target.title), updated_at=now()
     RETURNING ${FT_COLS}`,
    [t.system, t.instance ?? null, t.targetId, t.dataSourceId ?? null, t.parentPageId ?? null, t.title ?? null]);
  return r as FeedTargetRow;
}

export async function listFeedTargets(opts?: { system?: string; activeOnly?: boolean }): Promise<FeedTargetRow[]> {
  const where: string[] = [], params: unknown[] = [];
  if (opts?.system) { params.push(opts.system); where.push(`system=$${params.length}`); }
  if (opts?.activeOnly) where.push(`state='active'`);
  const sql = `SELECT ${FT_COLS} FROM feed_target${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
  return (await q(itemsPool, sql, params)) as FeedTargetRow[];
}

export async function getFeedTarget(id: number): Promise<FeedTargetRow | null> {
  const r = (await one(itemsPool, `SELECT ${FT_COLS} FROM feed_target WHERE id=$1`, [id])) as FeedTargetRow | undefined;
  return r ?? null;
}

// 해소 캐시·상태 갱신(드레인이 data_source 를 lazy 해소하면 저장, exclude_pages 등록 후 플래그).
export async function updateFeedTarget(
  id: number, patch: { dataSourceId?: string | null; excludeRegistered?: boolean; allCategories?: boolean; title?: string | null; state?: string },
): Promise<void> {
  const sets: string[] = [], params: unknown[] = [];
  if (patch.dataSourceId !== undefined) { params.push(patch.dataSourceId); sets.push(`data_source_id=$${params.length}`); }
  if (patch.excludeRegistered !== undefined) { params.push(patch.excludeRegistered); sets.push(`exclude_registered=$${params.length}`); }
  if (patch.allCategories !== undefined) { params.push(patch.allCategories); sets.push(`all_categories=$${params.length}`); }
  if (patch.title !== undefined) { params.push(patch.title); sets.push(`title=$${params.length}`); }
  if (patch.state !== undefined) { params.push(patch.state); sets.push(`state=$${params.length}`); }
  if (!sets.length) return;
  params.push(id);
  await itemsPool.query(`UPDATE feed_target SET ${sets.join(", ")}, updated_at=now() WHERE id=$${params.length}`, params);
}

export async function deleteFeedTarget(id: number): Promise<void> {
  await itemsPool.query(`DELETE FROM feed_target WHERE id=$1`, [id]);  // category_feed 는 FK CASCADE 로 함께 삭제.
}

// ── 카테고리 ↔ feed_target N:M 매핑(발행 게이트) ──────────────────────────
// 한 feed_target 의 카테고리 집합을 통째로 교체(관리탭 저장 idiom — 멱등).
export async function setCategoryFeeds(feedTargetId: number, categoryIds: number[]): Promise<void> {
  await itemsPool.query(`DELETE FROM category_feed WHERE feed_target_id=$1`, [feedTargetId]);
  if (!categoryIds.length) return;
  const values = categoryIds.map((_, i) => `($1, $${i + 2})`).join(", ");
  await itemsPool.query(
    `INSERT INTO category_feed(feed_target_id, category_id) VALUES ${values}
     ON CONFLICT (category_id, feed_target_id) DO NOTHING`,
    [feedTargetId, ...categoryIds]);
}

// 이 카테고리가 매핑된 active feed_target 들(지식 저장 훅·per-knowledge 라우팅용).
export async function feedTargetsForCategory(categoryId: number): Promise<FeedTargetRow[]> {
  return (await q(itemsPool,
    `SELECT ${FT_COLS.split(", ").map((c) => "ft." + c).join(", ")}
     FROM category_feed cf JOIN feed_target ft ON ft.id=cf.feed_target_id
     WHERE cf.category_id=$1 AND ft.state='active' ORDER BY ft.id`, [categoryId])) as FeedTargetRow[];
}

// 관리탭 표시용 — 이 feed_target 에 매핑된 카테고리들.
export async function categoriesForFeedTarget(feedTargetId: number): Promise<Array<{ id: number; key: string; name: string | null; space: string }>> {
  return (await q(itemsPool,
    `SELECT c.id, c.key, c.name, c.space FROM category_feed cf JOIN category c ON c.id=cf.category_id
     WHERE cf.feed_target_id=$1 ORDER BY c.space, c.key`, [feedTargetId])) as Array<{ id: number; key: string; name: string | null; space: string }>;
}

// 드레인 대상 해소 — 이 feed_target 으로 발행할 지식 이름들.
//  provenance='authored' 필수: observed(외부에서 들여온 미러)는 되쏘지 않는다.
//  all_categories=true 면 매핑 무시하고 모든 authored 정본(도메인은 발행 시 best-effort 해소) — 새 카테고리 자동 포함.
//  아니면 category_feed 매핑 카테고리의 confirmed 지식만.
export async function listPublishableForFeedTarget(feedTargetId: number, limit = 500): Promise<string[]> {
  const lim = Math.min(Math.max(limit, 1), 5000);
  const ft = await getFeedTarget(feedTargetId);
  if (!ft) return [];
  const rows = ft.all_categories
    ? await q(itemsPool,
        `SELECT k.name FROM knowledge k
         WHERE k.provenance='authored' AND k.lifecycle='active'
         ORDER BY k.name LIMIT $1`, [lim])
    : await q(itemsPool,
        `SELECT DISTINCT k.name
         FROM category_feed cf
         JOIN knowledge_category kc ON kc.category_id=cf.category_id AND kc.state='confirmed'
         JOIN knowledge k ON k.name=kc.name AND k.lifecycle='active' AND k.provenance='authored'
         WHERE cf.feed_target_id=$1
         ORDER BY k.name LIMIT $2`, [feedTargetId, lim]);
  return rows.map((r) => r.name as string);
}
