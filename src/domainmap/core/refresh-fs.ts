// 파일시스템-스캔 기반 구조 리프레시 — git diff 가 닿지 못하는 드리프트의 결정론적 복구 경로.
//
// 왜 별도 경로인가(정직히): 표준 refresh()/webhook 은 git diff(name-status)를 입력으로 받아
// rename 을 row-identity 로 보존한다. 그러나 (a) 서브레포가 상위 레포에서 git-ignore 되어 git 이
// 그 내용을 전혀 못 보거나 (b) 과거 스캔이 git-track 안 된 물리 디렉터리를 파일시스템 워크로 심은
// 경우, git rename 히스토리가 존재하지 않아 git diff 로는 복구가 불가능하다. 이 모듈은 현 파일시스템을
// 한 번 워크해서 '저장된 code_unit path' ↔ '실재 path' 의 결정론적 diff 를 만들고, 그 diff 를 기존
// refresh() 엔진(동일 트랜잭션·감사·불변식)에 그대로 먹인다. 엔진/불변식은 손대지 않는다.
//
// HARD 불변식(refresh() 가 강제하는 것을 그대로 물려받음):
//   - rename(R)= 같은 code_unit 행 UPDATE → 그 행의 mapping/project_touch 전부 보존(mapping 무쓰기).
//   - delete(D)= soft remove(state='removed') + 확정매핑 걸려있으면 orphan flag. 행/매핑 보존.
//   - add(A)=  unmapped 인박스(기본 OFF — 아래 emitAdds 참조).
//   - 비파괴: human/source 소유 매핑은 refresh() 가 절대 안 건드린다(애초에 mapping 테이블 무쓰기).
//
// 이 모듈의 '판단' 책임은 오직 결정론적 path-diff 계산뿐이다. 어느 도메인인가/이 rename 이 진짜인가
// 같은 의미 판단은 전부 잔여로 남긴다(저신뢰 rename flag, orphan flag, unmapped 인박스).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dmPool, one, q } from "../db.js";
import { httpErr, type Actor } from "./types.js";
import { logChange } from "./changelog.js";
import { refresh } from "./refresh.js";
import { evaluateDomainStructureDebt, type DomainDebtFinding } from "./domain-debt.js";

// 1:1 rename 후보 규칙: prefix 치환 맵(구→신 토폴로지). 결정론적이고 명시적이다 —
// 휴리스틱 similarity 가 아니라 '운영자가 선언한 토폴로지 이전'을 코드 path 에 사상한다.
// 빈 from prefix('') 는 루트 상대 path 그대로(치환 없음)를 의미.
export interface RenamePrefix { from: string; to: string }

export interface FsDiffInput {
  storedPaths: string[];                 // 저장된 active code_unit path (repo-루트 상대)
  exists: (path: string) => boolean;     // 실재 여부 프로브(repo 루트 기준) — 테스트 주입 가능
  renamePrefixes?: RenamePrefix[];        // 구→신 prefix 이전 규칙(우선순위順)
}

export interface FsDiffResult {
  changes: any[];                        // refresh() 가 먹는 R/D change[]
  unchanged: string[];                   // 실재 그대로(no-op)
  renamed: { from: string; to: string }[];
  removed: string[];                     // 실재 없음 + 정직한 1:1 rename 없음 → soft-remove
  ambiguous: { from: string; to: string }[]; // rename 후보가 충돌(다른 stored path 와) → 보수적으로 제외
}

// 저장된 path 하나의 '예상 신규 위치'를 prefix 규칙으로 계산. 매칭되는 prefix 가 여러 개면
// 가장 긴(longest-prefix) 것을 적용(결정론적). 매칭 없으면 path 그대로.
function applyPrefixes(path: string, prefixes: RenamePrefix[]): string {
  let best: RenamePrefix | null = null;
  for (const p of prefixes) {
    if (p.from === "" || path === p.from || path.startsWith(p.from)) {
      if (best == null || p.from.length > best.from.length) best = p;
    }
  }
  if (!best || best.from === "") return path;
  if (path === best.from) return best.to;
  return best.to + path.slice(best.from.length);
}

// 결정론적 path-diff(PURE — DB·git 무접촉). 분류:
//  - 저장 path 가 실재하면 → unchanged(no-op).
//  - 실재 안 하지만 prefix 규칙으로 계산한 신규 위치가 실재하고, 그 신규 위치를 '다른 저장 path 도
//    노리지 않고'(충돌 없음) '아직 active 로 점유되지 않았으면' → rename R(매핑 보존).
//  - 신규 위치가 이미 다른 active 저장 path 거나 두 저장 path 가 같은 신규 위치로 갈리면 → ambiguous
//    (보수적으로 rename 안 하고 그대로 둠 — refresh()의 active 충돌 가드와 같은 정신; 침묵 금지).
//  - 그 외(실재 없음 + 정직한 1:1 rename 없음) → removed D(soft + orphan flag).
export function computeFsDiff(input: FsDiffInput): FsDiffResult {
  const prefixes = input.renamePrefixes ?? [];
  const storedSet = new Set(input.storedPaths);
  const unchanged: string[] = [];
  const candidates: { from: string; to: string }[] = [];
  const removedRaw: string[] = [];

  for (const p of input.storedPaths) {
    if (input.exists(p)) { unchanged.push(p); continue; }
    const to = applyPrefixes(p, prefixes);
    if (to !== p && !storedSet.has(to) && input.exists(to)) {
      candidates.push({ from: p, to });
    } else {
      removedRaw.push(p);
    }
  }

  // 충돌 해소: 여러 from 이 같은 to 를 노리면 전부 ambiguous(어느 하나를 임의로 못 고름).
  const toCount = new Map<string, number>();
  for (const c of candidates) toCount.set(c.to, (toCount.get(c.to) ?? 0) + 1);
  const renamed: { from: string; to: string }[] = [];
  const ambiguous: { from: string; to: string }[] = [];
  for (const c of candidates) {
    if ((toCount.get(c.to) ?? 0) > 1) ambiguous.push(c);
    else renamed.push(c);
  }

  // 충돌(ambiguous)이라 rename 못 한 from 은 '여전히 실재 안 함' → removed 로 강등(침묵 금지:
  // soft-remove + orphan flag 로 표면화되고, 신규 위치는 별도 ADD/사람 판단으로 흡수).
  const removed = [...removedRaw, ...ambiguous.map((a) => a.from)];

  const changes: any[] = [];
  // score=100: 결정론적·운영자 선언 이전이라 휴리스틱 similarity 가 아님(저신뢰 flag 회피).
  for (const r of renamed) changes.push({ status: "R", from: r.from, to: r.to, score: 100 });
  for (const p of removed) changes.push({ status: "D", path: p });

  return { changes, unchanged, renamed, removed, ambiguous };
}

// 키 순서 무관 깊은 동등(멱등 비교용) — JSONB 라운드트립이 키를 재정렬해도 의미가 같으면 같다고 본다.
// 순수·결정론적: 객체는 키 정렬 후 재귀 비교, 배열은 순서 유지(배열 순서는 의미 있음), 그 외는 ===.
function deepEqualUnordered(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqualUnordered(x, b[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort(), bk = Object.keys(bo).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqualUnordered(ao[k], bo[k]));
  }
  return false;
}
// 테스트 전용 export(_접두 = 내부 헬퍼지만 단위 검증 노출). 표면 계약 아님.
export { deepEqualUnordered as _deepEqualUnordered };

// detected_stack 보정(감사). refresh() 는 detected_stack 을 손대지 않으므로(ingest 전용) 별도로
// repo 메타를 갱신하고 change_log(entity='repo', op='update')에 스냅샷한다 — 복구 가능(RESTORE_COLUMNS.repo).
export async function correctDetectedStack(repoName: string, newStack: unknown, actor: Actor): Promise<{ before: unknown; after: unknown; change_id: number } | null> {
  const pool = dmPool();
  const r = await one(pool, "SELECT * FROM repo WHERE name=$1", [repoName]);
  if (!r) throw httpErr(404, "no such repo: " + repoName);
  const before = r.detected_stack ?? {};
  if (deepEqualUnordered(before, newStack ?? {})) return null; // 멱등: 의미상 동일하면 무쓰기(키순서 무관)
  await pool.query("UPDATE repo SET detected_stack=$1 WHERE id=$2", [JSON.stringify(newStack ?? {}), r.id]);
  const change_id = await logChange(pool, {
    repoId: r.id, entityType: "repo", entityId: r.id, op: "update", actor,
    before: { detected_stack: before }, after: { detected_stack: newStack ?? {} },
    note: "detected_stack 보정(파일시스템 토폴로지 동기화)",
  });
  return { before, after: newStack ?? {}, change_id };
}

// 호스트 파일시스템 워크 기반 refresh: 저장된 active code_unit path 를 rootPath 기준으로 실재 프로브 →
// computeFsDiff → 기존 refresh() 엔진에 R/D change 를 먹인다. headSha 가 주어지면 refresh() 가
// last_refreshed_sha 체크포인트도 찍어 다음 증분 base 를 만든다(freshness never_refreshed 해소).
// detectedStack 이 주어지면 refresh 후 detected_stack 도 보정한다(같은 actor).
export async function refreshFromFilesystem(
  repoName: string, rootPath: string, actor: Actor,
  opts: { renamePrefixes?: RenamePrefix[]; headSha?: string | null; detectedStack?: unknown; evalDomainDebt?: boolean } = {},
): Promise<{ diff: FsDiffResult; tally: Record<string, unknown>; run_id: number; stack_corrected: { before: unknown; after: unknown; change_id: number } | null; domain_debt: { findings: DomainDebtFinding[]; tally: Record<string, number> } | null }> {
  const pool = dmPool();
  const r = await one(pool, "SELECT id FROM repo WHERE name=$1", [repoName]);
  if (!r) throw httpErr(404, "no such repo: " + repoName);
  const rows = await q(pool, "SELECT path FROM code_unit WHERE repo_id=$1 AND COALESCE(state,'active')='active'", [r.id]);
  const storedPaths = rows.map((x) => x.path);

  const diff = computeFsDiff({
    storedPaths,
    exists: (rel) => existsSync(join(rootPath, rel)),
    renamePrefixes: opts.renamePrefixes,
  });

  // 기존 refresh() 엔진에 위임(granularity 'unit' — 우리가 이미 unit-level R/D 를 만들었다).
  const payload: any = { changes: diff.changes };
  if (opts.headSha != null) payload.head = String(opts.headSha);
  const res = await refresh(repoName, payload, actor);

  const stack_corrected = opts.detectedStack !== undefined
    ? await correctDetectedStack(repoName, opts.detectedStack, actor)
    : null;

  // refresh 가 code_unit 을 soft-remove 한 직후 도메인-레벨 구조 부채를 재평가(structure→intent 발산).
  // refresh() 트랜잭션 밖에서 도는 별도 멱등 upsert — 부분실패 시에도 구조 변경 자체는 이미 커밋됐다.
  const domain_debt = opts.evalDomainDebt ? await evaluateDomainStructureDebt(repoName, actor) : null;

  return { diff, tally: res.tally, run_id: res.run_id, stack_corrected, domain_debt };
}
