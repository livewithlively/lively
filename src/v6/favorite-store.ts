// 멤버 즐겨찾기(#670) — 사용자별 사이드바 핀. 리스트(project_list)·카테고리(category)를 즐겨찾기하면
//  프로젝트 탭/WIKI 사이드바 맨 위 '⭐ 즐겨찾기' 구역에 고정. 개인 UI 상태 — 감사(org_content_audit) 대상 아님.
import { itemsPool } from "../db/client.js";
import { q } from "../db/client.js";

export type FavoriteKind = "project_list" | "category";
const KINDS: FavoriteKind[] = ["project_list", "category"];

export interface FavoriteSet {
  project_lists: number[]; // 즐겨찾기한 리스트 id
  categories: number[];    // 즐겨찾기한 카테고리 id
}

// 이 멤버의 즐겨찾기 전체 — 종류별 숫자 id 배열. (target_id 는 TEXT 저장이라 숫자로 복원.)
export async function listFavorites(memberId: string): Promise<FavoriteSet> {
  const out: FavoriteSet = { project_lists: [], categories: [] };
  if (!memberId) return out;
  const rows = await q(itemsPool,
    `SELECT target_kind, target_id FROM member_favorite WHERE member_id = $1`, [memberId]);
  for (const r of rows) {
    const id = Number(r.target_id);
    if (!Number.isFinite(id)) continue;
    if (r.target_kind === "project_list") out.project_lists.push(id);
    else if (r.target_kind === "category") out.categories.push(id);
  }
  return out;
}

// 즐겨찾기 토글/설정 — on 이면 추가(멱등), 아니면 제거. 이후 갱신된 전체 집합을 반환(프론트 즉시 반영용).
export async function setFavorite(memberId: string, kind: FavoriteKind, targetId: string | number, on: boolean): Promise<FavoriteSet> {
  if (!memberId) throw new Error("no member");
  if (!KINDS.includes(kind)) throw new Error("invalid kind");
  const id = String(targetId);
  if (!id || !Number.isFinite(Number(id))) throw new Error("invalid target id");
  if (on) {
    await q(itemsPool,
      `INSERT INTO member_favorite(member_id, target_kind, target_id) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, member_id, target_kind, target_id) DO NOTHING`, [memberId, kind, id]);
  } else {
    await q(itemsPool,
      `DELETE FROM member_favorite WHERE member_id=$1 AND target_kind=$2 AND target_id=$3`, [memberId, kind, id]);
  }
  return listFavorites(memberId);
}
