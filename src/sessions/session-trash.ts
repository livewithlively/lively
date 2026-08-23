// 세션 휴지통(#1851) — org_session_trash CRUD.
//
// 모델: 세션 하나 = 행 0~2개. 박스 id(box-…, desired-state/tmux)와 대화 uuid(중앙 기록)가 **같은 세션의 두 이름**이라
//  휴지통에 넣을 때 둘 다 넣는다 — 한쪽만 넣으면 목록 병합(web/v2/views.ts mergeSessions)이 다른 이름으로 그 세션을 되살린다
//  (실측: desired-state 를 지운 뒤 중앙 기록 행이 '기록' 세션으로 다시 떠올랐다).
//  · trashed_at  — 휴지통에 있음. 목록 응답엔 그대로 실리되 trashedAt 표식이 붙고, 새 셸은 사이드바에서 빼고 휴지통 화면에 그린다.
//  · purged_at   — 완전 삭제. 목록 응답에서 **빠진다**(desired-state 는 실제로 지우고, 중앙 기록은 조직 보존정책대로 남되 이 사람
//                  목록엔 안 보인다). 행은 남겨 둔다 — 지워야 할 '이름'을 잊으면 기록 행이 또 돌아온다.
//  owner 게이트는 여기서 — 모든 쓰기는 owner 가 자기 것일 때만(WHERE owner=$1). 남의 세션은 건드릴 수 없다.
import { itemsPool } from "../db/client.js";

export interface TrashMark { trashed_at: string; purged: boolean }

const clean = (ids: string[]): string[] => [...new Set((ids || []).map((x) => String(x || "").trim()).filter(Boolean))];

/** 이 사람의 휴지통 표식 전부 — session_id → {trashed_at, purged}. 목록 응답에 주석을 얹을 때 한 번 읽는다. */
export async function trashMapFor(owner: string): Promise<Map<string, TrashMark>> {
  const out = new Map<string, TrashMark>();
  if (!owner) return out;
  const r = await itemsPool.query(`SELECT session_id, trashed_at, purged_at FROM org_session_trash WHERE owner=$1`, [owner]);
  for (const row of r.rows) {
    out.set(String(row.session_id), { trashed_at: new Date(row.trashed_at).toISOString(), purged: !!row.purged_at });
  }
  return out;
}

// ⚠ upsert 에 `ON CONFLICT (session_id)` 처럼 **제약 컬럼을 적지 않는다** — 멀티테넌시 배포는 부팅 마이그레이션이 모든 표에
//  tenant_id 를 붙이고 PK 를 (tenant_id, …) 로 다시 짜므로, 스키마 파일의 PK 로는 매칭 제약을 못 찾아 500 이 난다
//  (#1850 이 실측으로 밟은 함정 — 이 표도 dev 에서 같은 500 을 냈다). 갱신은 UPDATE, 추가는 NOT EXISTS + ON CONFLICT DO NOTHING.

/** 휴지통으로 — 이미 있던 행은 시각만 갱신(되돌렸다가 다시 넣는 경우). purged 행은 되살리지 않는다(완전 삭제는 최종). */
export async function trashSessions(owner: string, ids: string[]): Promise<number> {
  const list = clean(ids);
  if (!owner || !list.length) return 0;
  const u = await itemsPool.query(
    `UPDATE org_session_trash SET trashed_at = now()
      WHERE owner = $1 AND purged_at IS NULL AND session_id = ANY($2::text[])`, [owner, list]);
  const i = await itemsPool.query(
    `INSERT INTO org_session_trash(session_id, owner, trashed_at)
       SELECT x, $1, now() FROM unnest($2::text[]) AS x
        WHERE NOT EXISTS (SELECT 1 FROM org_session_trash t WHERE t.session_id = x)
     ON CONFLICT DO NOTHING`, [owner, list]);
  return (u.rowCount || 0) + (i.rowCount || 0);
}

/** 되돌리기 — 휴지통 행을 지운다(purged 는 못 되돌린다). */
export async function untrashSessions(owner: string, ids: string[]): Promise<number> {
  const list = clean(ids);
  if (!owner || !list.length) return 0;
  const r = await itemsPool.query(
    `DELETE FROM org_session_trash WHERE owner=$1 AND purged_at IS NULL AND session_id = ANY($2::text[])`, [owner, list]);
  return r.rowCount || 0;
}

/** 완전 삭제 표식 — 행이 없으면 만들어서라도 purged 로 둔다(휴지통을 거치지 않은 호출도 같은 결과). */
export async function purgeSessions(owner: string, ids: string[]): Promise<number> {
  const list = clean(ids);
  if (!owner || !list.length) return 0;
  const u = await itemsPool.query(
    `UPDATE org_session_trash SET purged_at = COALESCE(purged_at, now())
      WHERE owner = $1 AND session_id = ANY($2::text[])`, [owner, list]);
  const i = await itemsPool.query(
    `INSERT INTO org_session_trash(session_id, owner, trashed_at, purged_at)
       SELECT x, $1, now(), now() FROM unnest($2::text[]) AS x
        WHERE NOT EXISTS (SELECT 1 FROM org_session_trash t WHERE t.session_id = x)
     ON CONFLICT DO NOTHING`, [owner, list]);
  return (u.rowCount || 0) + (i.rowCount || 0);
}

/** 휴지통에 있는(아직 purged 아닌) 이 사람의 세션 id — 비우기가 한 번에 지울 목록. */
export async function listTrashedIds(owner: string): Promise<string[]> {
  if (!owner) return [];
  const r = await itemsPool.query(`SELECT session_id FROM org_session_trash WHERE owner=$1 AND purged_at IS NULL`, [owner]);
  return r.rows.map((x) => String(x.session_id));
}
