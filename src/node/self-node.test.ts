// #2108 — 게이트웨이 자신이 노드로도 등록됐나(sharesGatewayTmux)의 계약. 사양 표 B 6행을 그대로 옮긴다.
//  🔴 틀리는 두 방향의 값이 다르다:
//   · 거짓양성(남의 PC 를 자기 자신이라 함) → 그 멤버의 노드가 세션 생성 목록에서 **조용히 사라진다**.
//   · 거짓음성(자기 자신을 못 알아봄) → 같은 tmux 세션이 두 경로(박스 즉시확답 / 노드 3초 스냅샷)로 잡혀
//     새 세션이 복원으로 샌다 — #2108 의 원증상 그대로다.
//  그래서 '겹치면 자기 자신'만 참으로 두고, '안 겹치면 아니다'는 **결론으로 쓰지 않는다**(없음 ≠ 아니다).
import { strict as assert } from "node:assert";
import test from "node:test";
import { sharesGatewayTmux, hasSelfProbeCandidate, relayNodeId, selfNodeMessage } from "./self-node.js";

const box = (...ids: string[]): ReadonlySet<string> => new Set(ids);
const A = "box-yoon-1a2b3c4d", B = "box-won-9f8e7d6c", C = "box-yoon-deadbeef";

// 1) 겹침 = 같은 tmux 서버 = 같은 박스.
test("겹치는 세션 id 가 있으면 자기 자신", () => {
  assert.equal(sharesGatewayTmux(box(A, B), [A]), true);
});

// 2) 원격 노드 — 그 PC 의 tmux 는 이 박스 tmux 와 세션을 공유할 수 없다.
test("세션 id 가 하나도 안 겹치면 자기 자신이 아니다", () => {
  assert.equal(sharesGatewayTmux(box(A), ["box-x-11111111", "box-x-22222222"]), false);
});

// 3·4) 한쪽이 비면 **볼 것이 없을 뿐**이다. 호출부는 false 를 "아직 모른다"로 읽고 다음 스냅샷에서 다시 본다
//  (registry.probeSelfNodes 가 한 번 선 판정을 뒤집지 않는 이유가 이 두 칸이다).
test("이 박스에 세션이 없으면 판정하지 않는다(빈 목록 ≠ 아니다)", () => {
  assert.equal(sharesGatewayTmux(box(), [A]), false);
});
test("노드가 세션을 하나도 안 들고 있으면 판정하지 않는다", () => {
  assert.equal(sharesGatewayTmux(box(A), []), false);
});

// 5) 매니지드 공유 게이트웨이 — 판정은 **박스 단위**다. 한 박스에서 도는 노드는 어느 테넌트·멤버가 등록했든
//  같은 tmux 를 쓰므로 자기 자신이 맞다(겹친 id 자체는 응답에 싣지 않는다 — 노드마다 불리언 하나만 나간다).
test("공유 게이트웨이 — 다른 멤버의 세션과 겹쳐도 같은 박스로 본다", () => {
  assert.equal(sharesGatewayTmux(box(B), [A, B]), true);
});

// 6) 경계 — 겹치는 것이 **마지막 원소 하나뿐**이어도 참이어야 한다. 첫 원소만 보는 구현을 여기서 잡는다.
test("겹치는 것이 마지막 하나뿐이어도 자기 자신", () => {
  assert.equal(sharesGatewayTmux(box(A, B, C), [C]), true);
});

// ── #2172 후속 — 판정을 **언제 시도하나**. 사양·엣지 표는 스크래치패드 spec.md(행 번호 = 아래 이름의 번호).
//
//  잰 것: 게이트웨이를 재시작하면 자기노드가 목록에 **약 30초** 남고, 그 사이 '내 것 + 가장 최근 연결'이라
//  새 세션의 기본 실행 노드(#2172)로까지 뽑혔다. 원인은 판정 로직이 아니라 **판정을 시도한 시점**이다 —
//  부팅 순서상 노드 접속 수신(LISTEN_STEPS)이 스냅샷 복구(DB_BOOT_STEPS)보다 먼저 열려, 노드의 첫 보고가
//  **아직 빈 목록**으로 판정을 시도하고, 그 헛시도가 30초 최소간격을 먹었다.
//
//  → 그래서 "지금 판정할 값이 있나"를 **tmux 를 묻기 전에·최소간격을 쓰기 전에** 가른다.
//  키는 실제로는 scopeKey(테넌트+노드id)라 구분자가 섞이지만, 이 판정은 문자열 동등성만 보므로 여기선 평문으로 쓴다.
const cand = (key: string, sessionCount: number): { key: string; sessionCount: number } => ({ key, sessionCount });
const judged = (...ks: string[]): ReadonlySet<string> => new Set(ks);

// 1) 부팅 직후 — 목록이 비어 있다. 여기서 참을 주면 그 헛시도가 최소간격을 먹는다(이 버그의 자리).
test("판정할 후보가 하나도 없으면 시도하지 않는다(부팅 직후 빈 목록)", () => {
  assert.equal(hasSelfProbeCandidate([], judged()), false);
});

// 2) 세션 0 인 노드는 대상이 아니다 — 볼 것이 없으면 판정이 아니라 보류다(sharesGatewayTmux 와 같은 근거).
test("세션을 하나도 안 든 노드만 있으면 시도하지 않는다", () => {
  assert.equal(hasSelfProbeCandidate([cand("t/n1", 0), cand("t/n2", 0)], judged()), false);
});

// 3) 판정할 값이 실제로 있으면 시도한다 — 가드가 과하면(전부 막으면) 자기노드를 영영 못 찾는다.
test("세션을 든 미판정 노드가 있으면 시도한다", () => {
  assert.equal(hasSelfProbeCandidate([cand("t/n1", 0), cand("t/n2", 3)], judged()), true);
});

// 4) 이미 자기노드로 판정된 것은 다시 볼 값이 없다 — 한 번 선 판정은 유지한다(뒤집지 않는다).
test("남은 후보가 이미 판정된 것뿐이면 시도하지 않는다", () => {
  assert.equal(hasSelfProbeCandidate([cand("t/self", 5)], judged("t/self")), false);
});

// 5) 판정된 것과 안 된 것이 섞이면 — 안 된 쪽 때문에 시도한다(새 노드가 나중에 붙는 경우가 이것이다).
test("판정된 노드가 있어도 미판정 후보가 남아 있으면 시도한다", () => {
  assert.equal(hasSelfProbeCandidate([cand("t/self", 5), cand("t/new", 2)], judged("t/self")), true);
});

// 6) 판정 여부는 **스코프 키**로 가른다 — 같은 노드 id 라도 다른 테넌트면 별개다(판정이 테넌트를 넘지 않게).
test("판정 여부는 스코프 키로 가른다(같은 노드 id, 다른 테넌트)", () => {
  assert.equal(hasSelfProbeCandidate([cand("t1/n", 3)], judged("t2/n")), true);
});

// 7) 경계 — 세션이 **정확히 하나**여도 판정할 값이다. `> 0` 을 `> 1` 로 쓴 오프바이원을 여기서 잡는다.
test("세션이 정확히 하나뿐이어도 시도한다", () => {
  assert.equal(hasSelfProbeCandidate([cand("t/n", 1)], judged()), true);
});

// ── #2592 relayNodeId — «좌표 접기». 사양 엣지 표 A 7행을 그대로 옮긴다. ─────────────────────────
//
//  🔴 틀리는 두 방향의 값이 여기서도 갈린다:
//   · 과하게 접는다(진짜 원격 노드 좌표를 버린다) → 그 멤버 PC 의 세션이 **중앙 tmux 에서** 찾아지고,
//     없으니 «세션이 종료됨»으로 답한다. 살아 있는 남의 세션을 죽었다고 말하는 것이라 가장 나쁘다.
//   · 덜 접는다(셀프 좌표를 남긴다) → 이 프로젝트가 닫으려는 구멍 그대로다(같은 tmux 를 노드 WS 로 한 바퀴).
//  그래서 판정기(isSelf)에 **정확히 무엇을 묻는지**까지 잰다(A7) — 안 물으면 통과하면서 아무것도 안 보는 테스트가 된다.

const NEVER = (): boolean => { throw new Error("좌표가 없는데 판정기를 불렀다 — 셀프 판정은 tmux 를 묻는 비용이 있다"); };
const SELF = (): boolean => true, REMOTE = (): boolean => false;

// A1) 진짜 원격 노드 — 좌표는 릴레이 지시다. 여기서 접으면 멤버 PC 세션이 통째로 안 열린다.
test("원격 노드 좌표는 그대로 둔다", () => {
  assert.equal(relayNodeId("macmini", REMOTE), "macmini");
});
// A2) 이 프로젝트의 본체 — 셀프 노드 좌표는 «같은 tmux 로 한 바퀴 돌아오라» 라 좌표가 아니다.
test("셀프 노드 좌표는 버린다(중앙 경로로 접는다)", () => {
  assert.equal(relayNodeId("macmini", SELF), "");
});
// A3·A4) 좌표 없음 — 종전 동작 그대로. DB `node_id` 는 NULL 일 수 있고(A4), 그때 판정기를 부르면 안 된다.
test("빈 좌표는 그대로 빈 값(판정기를 부르지 않는다)", () => {
  assert.equal(relayNodeId("", NEVER), "");
});
test("좌표가 아예 없으면(null·undefined) 빈 값 — DB node_id 는 NULL 일 수 있다", () => {
  assert.equal(relayNodeId(null, NEVER), "");
  assert.equal(relayNodeId(undefined, NEVER), "");
});
// A5) 종전 호출부들이 하던 `.trim()` 을 이 함수가 이어받는다(호출부에서 사라진 동작이 여기 있어야 한다).
test("앞뒤 공백은 다듬는다(종전 호출부의 trim 을 이어받는다)", () => {
  assert.equal(relayNodeId("  macmini  ", REMOTE), "macmini");
});
// A6) 경계 — **트림한 값으로 판정**해야 한다. 원문으로 물으면 공백 하나에 판정이 빗나가 구멍이 그대로 열린다.
test("공백이 붙어 있어도 셀프 노드로 판정된다(트림 후 판정)", () => {
  assert.equal(relayNodeId("  macmini  ", (id) => id === "macmini"), "");
});
// A7) 배선 — 판정기를 **정확히 한 번, 트림된 값으로** 묻는다. 안 물으면 위 단언들이 전부 vacuous 가 된다.
test("판정기에 트림된 id 를 정확히 한 번 묻는다", () => {
  const asked: string[] = [];
  relayNodeId(" macmini ", (id) => { asked.push(id); return false; });
  assert.deepEqual(asked, ["macmini"]);
});

// 문구는 여러 표면(등록 409·close 사유·관리 배지·CLI)이 나눠 쓰는 단일 출처다 — 비어 있으면 그 표면들이 침묵한다.
test("사람에게 할 말이 있고, 노드 id 를 주면 그 노드를 지목한다", () => {
  assert.ok(selfNodeMessage().length > 20);
  assert.ok(selfNodeMessage("macmini").includes("macmini"));
});
