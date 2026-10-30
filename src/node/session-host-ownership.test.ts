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
import { SESSION_HOST_DEAD_MS, gatewayDefersToSessionHost, sessionHostVerdict } from "./self-node.js";

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
// ⚠ #3797 T7 — 아래 둘은 **선언한 호스트가 하나뿐**인 표라 축이 바뀌어도 답이 같다.
//  «선언한 호스트가 여럿» 인 표는 V9·V9b·V9c 에 있다(거기서 규칙이 some → every 로 뒤집혔다).
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

// ── 사유(`why`) — 같은 답에 «왜» 를 붙인다 (#2600 T2 d6) ─────────────────────
//  왜 생겼나: 계수 실측(2026-09-08)에서 **같은 술어가 두 자리에서 다르게 답했다** — 카나리아 테넌트에서
//   알림 스윕은 참(그 자리 tmux 호출 0)인데 목록 라우트는 거짓이라 `list-sessions` 를 5~8/분 쳤다.
//   불리언 하나로는 그 어긋남의 이유를 물을 수가 없다(선언? 오프라인? 낡음? 스코프에 노드가 없음?).
//  엣지 표는 스크래치패드 `spec-verdict.md` 의 10행.
const why = (hosts: Host[]) => sessionHostVerdict(hosts, STALE).why;

test("V1 선언 + 온라인 + 신선 → ok", () => {
  assert.deepEqual(sessionHostVerdict([host()], STALE), { owns: true, why: "ok" });
});

test("V2 ★ 스코프에 노드가 하나도 없으면 `no-hosts` — «없다» 와 «자격이 없다» 는 다른 사유다", () => {
  assert.deepEqual(sessionHostVerdict([], STALE), { owns: false, why: "no-hosts" });
});

test("V3 노드는 있는데 전부 선언 없음 → undeclared", () => {
  assert.equal(why([host({ declared: false }), host({ declared: false })]), "undeclared");
});

test("V4 선언은 있는데 전부 오프라인 → offline", () => {
  assert.equal(why([host({ online: false })]), "offline");
});

test("V5 선언·온라인인데 스냅샷이 없음(null) → stale", () => {
  assert.equal(why([host({ stateAgeMs: null })]), "stale");
});

test("V6 선언·온라인인데 스냅샷이 낡음 → stale", () => {
  assert.equal(why([host({ stateAgeMs: STALE + 1 })]), "stale");
});

test("V7 경계 — 정확히 staleMs 면 아직 신선하다(ok)", () => {
  assert.deepEqual(sessionHostVerdict([host({ stateAgeMs: STALE })], STALE), { owns: true, why: "ok" });
});

test("V8 ★ 섞이면 **선언한 쪽이 사유를 정한다** — 미선언 온라인 + 선언 오프라인 → offline", () => {
  //  미선언 노드가 온라인이라고 «offline 아님» 으로 읽으면, 정작 주인이 끊긴 사실이 사유에서 사라진다.
  assert.equal(why([host({ declared: false, online: true }), host({ declared: true, online: false })]), "offline");
});

test("★★ V9 (#3797 T7 로 뒤집혔다) 선언된 호스트가 **하나라도** 낡았으면 놓지 않는다 — 부분 관측", () => {
  //  ── 왜 뒤집혔나 ────────────────────────────────────────────────────────────
  //  d4~d6 에서 세션 호스트 하나는 **클러스터 전역** 목록을 주장했다(브로커 `/lvly/sessions` 가 다른 산
  //   노드로 팬아웃한다). 그래서 «자격 있는 하나» 면 그 하나가 전부를 답했고 `some` 이 맞았다.
  //  T7 이 각 호스트를 **자기 노드로** 좁힌다. 그 순간 스냅샷은 **부분 관측**이 되고, 하나가 낡으면
  //   그 노드의 세션이 목록에서 통째로 빠진다 — 그런데 게이트웨이는 «누가 답했으니 됐다» 로 손을 뗀 뒤다.
  //  ⇒ 모든 선언 호스트가 자격일 때만 놓는다. 아니면 종전대로 게이트웨이가 답한다(fail-closed).
  assert.equal(why([host({ stateAgeMs: STALE + 5_000 }), host()]), "stale",
    "🔴 낡은 호스트가 있는데 소유를 놓았다 — 그 노드 세션이 목록에서 사라진다");
});

test("★★ V9b 선언된 호스트가 **하나라도** 오프라인이면 놓지 않는다", () => {
  assert.equal(why([host({ online: false }), host()]), "offline");
});

test("★ V9c 선언된 호스트가 **전부** 자격이면 놓는다 — (노드, 테넌트) 축의 정상 상태", () => {
  //  노드 둘이 그 테넌트를 서빙하면 호스트도 둘이다. 둘 다 신선하면 두 스냅샷의 **합집합**이 곧 전체다
  //   (`registry.nodeSessionsFor` 가 노드마다 이어붙인다 · `session-merge` 가 중복 id 를 접는다).
  assert.deepEqual(sessionHostVerdict([host(), host({ stateAgeMs: 200 })], STALE), { owns: true, why: "ok" });
});

test("★ V9d 미선언 노드는 자격을 묻지 않는다 — 멤버 PC 가 오프라인이어도 소유는 넘어간다", () => {
  //  `every` 가 «스코프의 모든 노드» 로 새면 멤버 PC 노드 하나가 꺼진 순간 소유가 영영 안 넘어간다.
  assert.equal(why([host({ declared: false, online: false, stateAgeMs: null }), host()]), "ok");
});

// ── ★★ 죽은 호스트 지평선(#3797 T7) ────────────────────────────────────────
test("★★ V11 회수된 노드의 행(하루 넘게 소식 없음)은 판정에서 **빠진다** — 소유를 영영 붙들지 않게", () => {
  //  T7 의 `every` 만 두면 ASG 가 갈아치운 노드의 `sesshost-*` 행 하나가 그 테넌트의 소유를 영구히 막는다.
  //  노드 행은 시간이 갈수록 쌓이므로(실측: nodes 3행 중 2행이 48시간 안에 생겼다) 그건 악화하는 부류다.
  const dead = host({ online: false, stateAgeMs: SESSION_HOST_DEAD_MS + 1 });
  assert.deepEqual(sessionHostVerdict([dead, host()], STALE), { owns: true, why: "ok" });
});

test("★ V12 경계는 **포함**이다 — 정확히 deadMs 면 아직 «죽지 않았다»(그래서 막는다)", () => {
  const edge = host({ online: false, stateAgeMs: SESSION_HOST_DEAD_MS });
  assert.equal(sessionHostVerdict([edge, host()], STALE).why, "offline");
});

test("★★ V13 **전부** 죽었으면 소유를 놓지 않는다(undeclared) — 살아 있는 주인이 0인데 손을 떼면 목록이 빈다", () => {
  const dead = host({ online: false, stateAgeMs: SESSION_HOST_DEAD_MS + 1 });
  assert.deepEqual(sessionHostVerdict([dead, dead], STALE), { owns: false, why: "undeclared" });
});

test("V10 ★ 답은 언제나 종전 술어와 같다 — 사유를 붙이면서 판정이 바뀌면 안 된다", () => {
  const rows: Host[][] = [
    [], [host()], [host({ declared: false })], [host({ online: false })],
    [host({ stateAgeMs: null })], [host({ stateAgeMs: STALE + 1 })], [host({ stateAgeMs: STALE })],
    [host({ declared: false, online: true }), host({ declared: true, online: false })],
    [host({ stateAgeMs: STALE + 5_000 }), host()],
    [host(), host({ stateAgeMs: 200 })],
    [host({ online: false }), host()],
    [host({ declared: false, online: false, stateAgeMs: null }), host()],
  ];
  for (const r of rows) {
    assert.equal(sessionHostVerdict(r, STALE).owns, gatewayDefersToSessionHost(r, STALE), JSON.stringify(r));
  }
});
