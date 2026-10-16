// 옛 경로 → 새 경로 기록(#4688) — file_move 표의 저장·조회. 순수 규칙은 files/file-move-core.ts, 배선은 files/file-move.ts.
//
//  moved_at = 그 줄이 옮겨 놓은 것이 **to_path 에 도착한 때**다. 따라가기는 이 시각 이후의 기록만 다음 걸음으로 본다
//   (findFileMove since) — 그 전 기록은 그 경로를 앞서 쓰던 다른 것의 일이다(같은 이름 폴더를 다시 쓰는 경우).
//
//  기록 한 번에 세 일을 한 트랜잭션으로 한다:
//   ① 연쇄 접기 — 옮긴 것(자신·하위)을 가리키던 기록이 이제 새 자리를 가리킨다(A→B 뒤 B→C 면 A→C, 도착 시각은 지금).
//      ★ 단 그 줄이 옮겨 놓은 자리 **아래에**, 그것이 도착한 뒤 생긴 기록이 있으면 접지 않는다 — 그 기록이 그 줄이 옮겨 놓은 것의
//       다음 걸음이라, 접으면 그 걸음을 건너뛴다(폴더 이름 바꾸기 → 그 안 파일 이름 바꾸기 → 다시 폴더 이름 바꾸기). 접지 않은 줄은
//       따라가기가 한두 걸음 더 간다 — 대개 한두 번에 닿는다.
//   ② 되돌리기 — 접은 결과가 제자리(A→B 뒤 B→A 면 A→A)인 줄은 지운다. 그 자리엔 지금 실제 파일이 있다.
//   ③ 이번 이동 — 같은 옛 경로는 한 줄, 나중 이동이 이긴다(그 경로에 마지막으로 있던 것이 간 곳).
//  오프셋은 PG 에서 센다 — JS 의 length 는 UTF-16 코드 단위라 이모지가 든 이름에서 어긋난다(renameSharedFolderAclPrefix 와 같은 이유).
import { itemsPool, withTx } from "../db/client.js";
import { movePrefixes, normalizeMovePath, type MoveRecord } from "../files/file-move-core.js";

/** 공유 루트 자리 키 — 프로젝트 폴더도 이 자리의 `project/<id>/…` 다(링크 root=shared 와 같다). */
export const SHARED_MOVE_SCOPE = "shared";
/** 개인 폴더 자리 키 — 주인별(root=personal 링크는 여는 사람 자신의 폴더로 풀린다). */
export const personalMoveScope = (member: string): string => `personal:${member}`;

/** 이동 한 건을 남긴다. 경로가 이상하거나 제자리면 아무것도 안 하고 false. */
export async function recordFileMove(scope: string, fromRel: string, toRel: string, by: string | null): Promise<boolean> {
  const from = normalizeMovePath(fromRel);
  const to = normalizeMovePath(toRel);
  if (!scope || !from || !to || from === to) return false;
  await withTx(async (c) => {
    const foldable = `scope = $1 AND (to_path = $2 OR starts_with(to_path, $2 || '/'))
      AND NOT EXISTS (SELECT 1 FROM file_move d WHERE d.scope = file_move.scope
                        AND starts_with(d.from_path, file_move.to_path || '/') AND d.moved_at >= file_move.moved_at)`;
    const folded = `$3 || substring(to_path from length($2) + 1)`;
    await c.query(`DELETE FROM file_move WHERE ${foldable} AND from_path = ${folded}`, [scope, from, to]);              // ② 먼저 — 제자리 줄은 CHECK 에 걸린다
    await c.query(`UPDATE file_move SET to_path = ${folded}, moved_at = now() WHERE ${foldable}`, [scope, from, to]);   // ①
    await c.query(
      `INSERT INTO file_move(scope, from_path, to_path, moved_by) VALUES($1, $2, $3, $4)
       ON CONFLICT (tenant_id, scope, from_path) DO UPDATE SET to_path = EXCLUDED.to_path, moved_by = EXCLUDED.moved_by, moved_at = now()`,
      [scope, from, to, by]);                                                                                            // ③
  });
  return true;
}

/**
 * 이 경로를 담는 가장 긴 접두 기록(자기 포함). 없으면 null.
 *  since(앞 기록의 도착 시각)가 있으면 그 뒤(같은 때 포함)에 생긴 기록만 — 시각은 DB 글자 그대로 주고받는다(JS Date 는 마이크로초를 버린다).
 */
export async function findFileMove(scope: string, rel: string, since: string | null = null): Promise<MoveRecord | null> {
  const p = normalizeMovePath(rel);
  if (!scope || !p) return null;
  const r = await itemsPool.query(
    `SELECT from_path, to_path, moved_at::text AS at FROM file_move
      WHERE scope = $1 AND from_path = ANY($2::text[]) AND ($3::timestamptz IS NULL OR moved_at >= $3::timestamptz)
      ORDER BY length(from_path) DESC LIMIT 1`, [scope, movePrefixes(p), since]);
  const row = r.rows[0] as { from_path: string; to_path: string; at: string } | undefined;
  return row ? { from: String(row.from_path), to: String(row.to_path), at: String(row.at) } : null;
}
