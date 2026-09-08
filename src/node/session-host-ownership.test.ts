// «게이트웨이가 세션 목록의 소유를 언제 놓나» — 선언된 세션 호스트가 주인으로 설 때 (#2600 T2 d4).
//
//  ── 무엇을 지키나 ──
//  매니지드 세션의 주인이 노드의 세션 호스트로 옮겨가면 게이트웨이는 그 테넌트의 목록을 **자기 tmux 로
//   만들면 안 된다**. 안 그러면 `mergeSessionViews` 에서 local 이 이겨 카드 메타를 계속 게이트웨이가 만들고
//   attach 만 호스트로 가는 **반쪽** 상태가 된다(그게 지금 상태다).
//
//  ★ 이 술어의 규율은 **fail-closed** 다. 셋(선언·온라인·신선한 스냅샷)이 다 참일 때만 놓는다.
//   잘못 놓으면 증상이 «그 테넌트 목록이 통째로 빔» 이고, 잘못 쥐고 있으면 «메타를 옛 경로가 만듦» 이다.
//   앞이 훨씬 비싸므로 모르면 쥔다.
//
//  엣지 표는 스크래치패드 `spec.md` 의 10행 — 행마다 시나리오 하나.
import assert from "node:assert/strict";
import test from "node:test";
import { gatewayDefersToSessionHost } from "./self-node.js";

/** registry 의 `STATE_STALE_MS`(상태 push 3초 기준 신선 임계)와 같은 값을 시험에서도 **명시**한다. */
const STALE = 12_000;

type Host = { declared: boolean; online: boolean; stateAgeMs: number | null };
/** 기본은 «자격 있는 세션 호스트» — 각 행은 **한 칸만** 뒤집어 그 칸이 판정에 무는지 본다. */
const host = (o: Partial<Host> = {}): Host => ({ declared: true, online: true, stateAgeMs: 1_000, ...o });

// ── 셋이 다 참일 때만 놓는다 ─────────────────────────────────────────────────
test("G1 선언 + 온라인 + 신선한 스냅샷 → 게이트웨이가 소유를 놓는다", () => {
  assert.equal(gatewayDefersToSessionHost([host()], STALE), true);
});

test("G2 ★ 선언 없는 노드로는 놓지 않는다 — 멤버 PC 노드 무회귀", () => {
  //  멤버 PC 노드는 온라인이고 스냅샷도 신선하다. 다른 건 다 같고 **선언만** 없다.
  //  이 칸이 안 물면 오늘 잘 도는 모든 배포에서 중앙 세션 목록이 사라진다.
  assert.equal(gatewayDefersToSessionHost([host({ declared: false })], STALE), false);
});

test("G3 ★ 주인이 오프라인이면 놓지 않는다", () => {
  assert.equal(gatewayDefersToSessionHost([host({ online: false })], STALE), false);
});

test("G4 ★ 스냅샷이 아직 없으면(null) 놓지 않는다 — 붙었지만 아무것도 못 본 순간", () => {
  //  부팅·재연결 직후가 그 순간이다. ⚠ JS 에서 `null <= 12000` 은 **참**이라, 이 행이 없으면
  //   «스냅샷 부재» 가 «가장 신선함» 으로 읽히는 것을 아무도 못 잡는다.
  assert.equal(gatewayDefersToSessionHost([host({ stateAgeMs: null })], STALE), false);
});

test("G5 ★ 스냅샷이 낡았으면 놓지 않는다", () => {
  assert.equal(gatewayDefersToSessionHost([host({ stateAgeMs: STALE + 1 })], STALE), false);
});

test("G6 ★ 노드가 하나도 없으면 종전 그대로", () => {
  assert.equal(gatewayDefersToSessionHost([], STALE), false);
});

// ── 여럿이 붙어 있을 때 ──────────────────────────────────────────────────────
test("G7 ★ 멤버 PC 노드들 사이에 자격 있는 세션 호스트가 하나 있으면 성립한다", () => {
  assert.equal(gatewayDefersToSessionHost(
    [host({ declared: false }), host({ declared: false, stateAgeMs: 500 }), host()], STALE), true);
});

test("G8 ★ 부적격 세션 호스트가 여럿이어도 합쳐서 자격이 되지는 않는다", () => {
  assert.equal(gatewayDefersToSessionHost(
    [host({ online: false }), host({ stateAgeMs: null }), host({ stateAgeMs: STALE + 1 })], STALE), false);
});

// ── 경계 ────────────────────────────────────────────────────────────────────
test("G9 ★ 신선도 경계는 **포함**이다 — 정확히 staleMs 면 아직 신선", () => {
  //  상태 push 가 3초 주기다. 경계를 배타로 두면 판정이 주기마다 깜빡여 목록의 주인이 왔다 갔다 한다.
  assert.equal(gatewayDefersToSessionHost([host({ stateAgeMs: STALE })], STALE), true);
});

test("G10 방금 받은 스냅샷(나이 0)도 신선하다", () => {
  assert.equal(gatewayDefersToSessionHost([host({ stateAgeMs: 0 })], STALE), true);
});
