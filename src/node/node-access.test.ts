// 노드 접근 정책(#1540) — nodeOpenTo / remoteDelegateAllowed 사양 진리표. 행 번호(A1…C1)는 사양 엣지 표와 1:1.
//
// 왜 표로 못박나: 이 두 술어가 "남이 내 노트북에서 임의 프롬프트(=임의 코드)를 돌릴 수 있나"를 혼자 정한다.
// 종전 위탁 규칙은 `hasLease || owner === requester` 였다 — **셋업토큰 리스 하나로 조직의 모든 멤버 노드가 열렸다.**
// 그 한 칸(B4: 소유 불일치 · 비공유 · 리스 있음 → 반드시 제외)이 이 파일의 존재 이유고, 나머지 칸은 무회귀 증거다.
//
// 축: 소유일치 × shared(true/false/undefined/null) × 리스. shared 는 **이번에 새로 도입한 플래그**라
//  구 스키마 행에서 undefined/null 로 올 수 있다 — truthy 로 오독하면 전 노드가 개방되므로 그 두 칸을 따로 본다.
import assert from "node:assert/strict";
import { nodeOpenTo, remoteDelegateAllowed, type NodeAccessFacts } from "./node-access.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

const ME = "bob";
const OTHER = "alice";
const node = (owner: NodeAccessFacts["owner_member"], shared?: boolean | null): NodeAccessFacts =>
  ({ owner_member: owner, shared });

// ── A. 접근 판정(provision·노드 세션생성·노드 지정·목록 노출) = 소유 또는 공유 ──
{
  const rows: Array<[string, NodeAccessFacts, string, boolean]> = [
    ["A1 본인 노드 · 비공유",                          node(ME, false),        ME, true],
    ["A2 본인 노드 · 공유",                            node(ME, true),         ME, true],
    ["A3 남의 노드 · 비공유 → 거부",                   node(OTHER, false),     ME, false],
    ["A4 남의 노드 · 관리자가 공유 → 허용",            node(OTHER, true),      ME, true],
    ["A5 남의 노드 · shared undefined(구 스키마 행) → 거부", node(OTHER, undefined), ME, false],
    ["A6 남의 노드 · shared null → 거부",              node(OTHER, null),      ME, false],
    ["A7 등록자 미상 · 비공유 → 거부",                 node(null, false),      ME, false],
    ["A8 등록자 미상 · 공유 → 허용(공유는 소유와 독립)", node(null, true),      ME, true],
    ["A10 요청자 신원 없음 · 공유 → 거부",             node(OTHER, true),      "", false],
  ];
  for (const [label, n, requester, want] of rows) assert.equal(nodeOpenTo(n, requester), want, label);
  ok(`A. 접근 판정 진리표 ${rows.length}칸`);

  // A9 — 요청자 신원이 빈 문자열이면, 노드 등록자도 빈 값이라 **우연히 같아지는** 자리가 생긴다. 거기서 열리면 안 된다.
  for (const owner of ["", null, undefined] as const) {
    assert.equal(nodeOpenTo(node(owner, false), ""), false,
      `A9 신원 없음 + 등록자 ${String(owner) || "빈 문자열"} → 우연한 일치로 열려선 안 된다`);
  }
  ok("A9 요청자 신원 없음 → fail-closed(빈 값끼리의 우연한 일치 포함)");
}

// ── B. 위탁 배치 후보 = 개방 + 의뢰자 자격이 그 머신에 실재하는가 ──
{
  const rows: Array<[string, NodeAccessFacts, boolean, boolean]> = [
    ["B1 본인 노드 · 리스 없음 → 후보(본인 로그인이 그 머신에 있다)", node(ME, false),        false, true],
    ["B2 본인 노드 · 리스 있음 → 후보",                              node(ME, false),        true,  true],
    ["B3 본인 공유 노드 · 리스 없음 → 후보",                         node(ME, true),         false, true],
    // 🔴 B4 = #1540 급소. 종전엔 리스만 있으면 여기가 후보였다(남의 노트북에 위탁 배정).
    ["B4 남의 비공유 노드 · 리스 있음 → 제외",                       node(OTHER, false),     true,  false],
    ["B5 남의 비공유 노드 · 리스 없음 → 제외",                       node(OTHER, false),     false, false],
    ["B6 남의 공유 노드 · 리스 있음 → 후보",                         node(OTHER, true),      true,  true],
    ["B7 남의 공유 노드 · 리스 없음 → 제외(그 박스엔 의뢰자 자격이 없다)", node(OTHER, true),  false, false],
    ["B8 남의 노드 · shared undefined · 리스 있음 → 제외",           node(OTHER, undefined), true,  false],
    ["B9 등록자 미상 · 공유 · 리스 있음 → 후보",                     node(null, true),       true,  true],
    ["B10 등록자 미상 · 비공유 · 리스 있음 → 제외",                  node(null, false),      true,  false],
  ];
  for (const [label, n, lease, want] of rows) assert.equal(remoteDelegateAllowed(n, ME, lease), want, label);
  ok(`B. 위탁 후보 진리표 ${rows.length}칸`);

  // B11 — 신원 없음. 공유+리스라는 '가장 열린' 조합에서도 제외돼야 한다.
  for (const lease of [true, false]) {
    assert.equal(remoteDelegateAllowed(node(ME, true), "", lease), false, `B11 신원 없음(리스=${lease}) → 후보 제외`);
    assert.equal(remoteDelegateAllowed(node("", true), "", lease), false, `B11 신원 없음 + 등록자도 빈 값(리스=${lease}) → 후보 제외`);
  }
  ok("B11 요청자 신원 없음 → 위탁 후보 제외(리스·소유 우연일치 무관)");
}

// ── C1. 불변식: 위탁 후보인 노드는 반드시 접근도 허용이다(위탁 ⊆ 접근) ──
//  두 판정이 따로 표류하면 "위탁은 되는데 세션은 못 여는" 비대칭이 생긴다. 전 조합으로 포함관계를 못박는다.
{
  let checked = 0, allowed = 0;
  for (const owner of [ME, OTHER, null, undefined, ""] as const) {
    for (const shared of [true, false, undefined, null] as const) {
      for (const lease of [true, false]) {
        const n = node(owner, shared);
        if (remoteDelegateAllowed(n, ME, lease)) {
          allowed++;
          assert.equal(nodeOpenTo(n, ME), true,
            `C1 위탁은 허용인데 접근은 거부 — owner=${String(owner)} shared=${String(shared)} lease=${lease}`);
        }
        checked++;
      }
    }
  }
  assert.equal(checked, 40, "조합 수 배선 확인(축이 늘면 이 수도 같이 늘려라)");
  // 배선 단언 — 허용이 0건이면 위 포함관계는 공허하게 통과한다(vacuous). 실제로 통과한 칸이 있어야 검증이다.
  assert.ok(allowed >= 6, `C1 관측 장치 확인 — 위탁 허용 칸이 실제로 있어야 한다(observed=${allowed})`);
  ok(`C1 불변식 위탁 ⊆ 접근 (${checked}조합 · 허용 ${allowed}칸)`);
}

console.log(`\n${pass} passed`);
