// #2108 — 게이트웨이 자신이 노드로도 등록됐나(sharesGatewayTmux)의 계약. 사양 표 B 6행을 그대로 옮긴다.
//  🔴 틀리는 두 방향의 값이 다르다:
//   · 거짓양성(남의 PC 를 자기 자신이라 함) → 그 멤버의 노드가 세션 생성 목록에서 **조용히 사라진다**.
//   · 거짓음성(자기 자신을 못 알아봄) → 같은 tmux 세션이 두 경로(박스 즉시확답 / 노드 3초 스냅샷)로 잡혀
//     새 세션이 복원으로 샌다 — #2108 의 원증상 그대로다.
//  그래서 '겹치면 자기 자신'만 참으로 두고, '안 겹치면 아니다'는 **결론으로 쓰지 않는다**(없음 ≠ 아니다).
import { strict as assert } from "node:assert";
import test from "node:test";
import { sharesGatewayTmux } from "./self-node.js";

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
