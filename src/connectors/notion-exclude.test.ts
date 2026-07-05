// 제외 서브트리(관리탭 '제외 페이지') 판정 회귀 — 순수 조상 워크(원장 parentExt 사용, 네트워크 불요).
//   실행: npm run build && node dist/connectors/notion-exclude.test.js
//   목적: excludeIds 로 지정한 페이지/DB 와 그 하위 전체가 싱크에서 빠지는지(직접 id·원장 조상·깊은 체인·
//        seed 부모 지름길·memo)를 잠근다. live fetch 폴백 경로는 원장 parentExt 를 미리 채워 회피(결정성).
import assert from "node:assert/strict";
import { __scopeTestables } from "./notion.js";

const { underExcluded } = __scopeTestables;

// 유효한 36자 대시드 uuid(parseNotionRootId 캐노니컬과 동형).
const ROOT_EXC = "11111111-1111-4111-8111-111111111111"; // 제외 루트
const CHILD = "22222222-2222-4222-8222-222222222222"; // ROOT_EXC 의 자식
const GRAND = "33333333-3333-4333-8333-333333333333"; // CHILD 의 자식
const TOP_OK = "44444444-4444-4444-8444-444444444444"; // 제외와 무관한 최상위
const NODE_OK = "55555555-5555-4555-8555-555555555555"; // TOP_OK 아래
const ROWID = "66666666-6666-4666-8666-666666666666"; // 원장에 없는 DB 행(seed 부모로만 판정)

// underExcluded 가 실제로 읽는 필드만 갖춘 최소 Traversal.
function mkT(excludeIds: string[], ledger?: Array<[string, string | null]>, preMemo?: Array<[string, boolean]>) {
  const byId = new Map<string, { parentExt: string | null }>();
  for (const [id, parentExt] of ledger ?? []) byId.set(id, { parentExt });
  const excluded = new Map<string, boolean>();
  for (const [id, v] of preMemo ?? []) excluded.set(id, v);
  return { cfg: { excludeIds }, ledger: ledger ? { byId } : null, excluded } as any;
}

async function main() {
  // 1) excludeIds 비면 즉시 false(기존 설치 무영향·무비용 fast path).
  assert.equal(await underExcluded(mkT([]), CHILD), false, "빈 excludeIds → 항상 false");

  // 2) 직접 지정된 id → true(원장 없이도).
  assert.equal(await underExcluded(mkT([ROOT_EXC]), ROOT_EXC), true, "직접 id 제외");

  // 3) 원장 부모가 제외 루트 → true(0-fetch).
  assert.equal(await underExcluded(mkT([ROOT_EXC], [[CHILD, ROOT_EXC]]), CHILD), true, "원장 조상 1홉 제외");

  // 4) 깊은 체인(손자 → 자식 → 제외 루트) → true, 중간 노드도 memo(true).
  {
    const t = mkT([ROOT_EXC], [[GRAND, CHILD], [CHILD, ROOT_EXC]]);
    assert.equal(await underExcluded(t, GRAND), true, "깊은 체인 제외");
    assert.equal(t.excluded.get(GRAND), true, "손자 memo=true");
    assert.equal(t.excluded.get(CHILD), true, "중간 노드 memo=true");
  }

  // 5) 제외와 무관 — 원장 부모가 이미 '제외 아님'으로 memo 된 최상위에 닿으면 false(네트워크 없이 종결).
  {
    const t = mkT([ROOT_EXC], [[NODE_OK, TOP_OK]], [[TOP_OK, false]]);
    assert.equal(await underExcluded(t, NODE_OK), false, "무관 서브트리 → false");
    assert.equal(t.excluded.get(NODE_OK), false, "무관 노드 memo=false");
  }

  // 6) seed 부모 지름길 — 원장에 없는 DB 행이라도 직계 부모(소유 DB)가 제외 루트면 true(첫 홉 seed 사용, 무fetch).
  assert.equal(await underExcluded(mkT([ROOT_EXC]), ROWID, ROOT_EXC), true, "seedParentExt 지름길 제외");

  // 7) seed 부모가 무관하고 그 위가 없으면(원장 부재) live fetch 로 가야 하므로 여기선 검증 안 함 —
  //    대신 seed 부모가 제외 아님 + 원장으로 최상위까지 이어지는 케이스로 false 를 확인.
  {
    const t = mkT([ROOT_EXC], [[TOP_OK, null]], [[TOP_OK, false]]);
    // ROWID 의 seed 부모 = TOP_OK(원장 memo=false) → false.
    assert.equal(await underExcluded(t, ROWID, TOP_OK), false, "seed 부모가 무관(memo=false) → false");
  }

  console.log("notion-exclude.test ok — 7 checks (직접·원장조상·깊은체인·무관·seed지름길·memo·fast-path)");
}

main().catch((e) => { console.error(e); process.exit(1); });
