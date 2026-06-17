// 도메인 soft-alias 해소 — domain_rename(H3) 의 읽기측 짝. 물리 domain.key 는 절대 안 바뀌므로
// (cross-DB 원자성 불가 — schema.ts domain_alias 주석 참조), 옛 슬러그(knowledge_unit.domain_key 에
// 약결합으로 박혀 있는 값)가 가리키던 도메인을 계속 찾으려면 alias 매핑을 따라 canonical key 로 해소해야
// 한다. 검증(ctx_save)·목록(domain_list)·중복검사(create/rename)가 전부 이 한 함수를 거친다.
import { dmPool, one, type Db } from "../db.js";

// (repo_id, key) → canonical key. alias 체인(old_key→new_key→…)을 따라가며, 더 이상 alias 가
// 없는 종점(= 물리 domain.key 후보)을 돌려준다. 사이클/긴 체인 가드(MAX_HOPS) — 사람이 의도치 않게
// 별칭 사이클을 만들어도 무한루프 대신 마지막 방문 키에서 멈춘다(fail-safe, 데이터 손상 없음).
// alias 가 전혀 없으면 입력 key 를 그대로 반환(통상 경로 — 비용 1쿼리).
const MAX_HOPS = 16;
export async function resolveDomainKey(repoId: number, key: string, db: Db = dmPool()): Promise<string> {
  let cur = key;
  const seen = new Set<string>([cur]);
  for (let i = 0; i < MAX_HOPS; i++) {
    const row = await one(db, "SELECT new_key FROM domain_alias WHERE repo_id=$1 AND old_key=$2", [repoId, cur]);
    if (!row) return cur; // 종점 — 더 이상 별칭 없음
    const next = row.new_key as string;
    if (seen.has(next)) return next; // 사이클 가드 — 마지막 키 반환(무한루프 방지)
    seen.add(next);
    cur = next;
  }
  return cur; // 체인 과길이 가드
}

// 한 repo 의 alias 전부(old_key → new_key) — 목록 표면에서 옛키 입력을 canonical 로 접는 데 사용.
export async function listAliases(repoId: number, db: Db = dmPool()): Promise<Array<{ old_key: string; new_key: string }>> {
  const rows = await (db.query("SELECT old_key, new_key FROM domain_alias WHERE repo_id=$1 ORDER BY old_key", [repoId]));
  return rows.rows.map((r: any) => ({ old_key: r.old_key, new_key: r.new_key }));
}
