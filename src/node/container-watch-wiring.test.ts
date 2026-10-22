// #4939 — 컨테이너 관측의 **배선**(자리별). 단위시험에서는 노드 연결을 만들 수 없어(`authNodeTokenDetailed` 가 DB 없으면 거절 — rpc-sent.test 머리말)
//  판정은 순수 함수(container-watch · session-unreachable-rule)로 재고, 여기서는 그 함수가 **제자리에서 불리는지**를 소스로 잰다.
//  명제: ① 관측은 상태 push 에서만 잇는다(attach 전 RPC 재확인의 applyState 는 그 칸이 없어, 거기서 이으면 «옛 판» 으로 읽혀 시계가 지워진다)
//        ② 박동은 관측도 «지난번 그대로» 로 잇는다 ③ 노드를 잊으면 관측도 잊는다
//        ④ 노드는 목록을 만들기 **전** 시각으로 관측을 꺼내 싣고, 관측이 바뀐 판은 박동으로 삼키지 않는다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";

const code = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8")
  .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const body = (src: string, head: string): string => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `자리를 못 찾았다: ${head}`);
  return src.slice(i, src.indexOf("\n}\n", i));
};

test("[WIRE-1] ★ 관측은 상태 push 에서만 잇는다 — 노드가 보낸 칸을 모양 검사(parseContainerObservations)를 거쳐 observeContainers 로", () => {
  const src = code("node/registry.ts");
  const handler = body(src, "function onNodeControlMsg(");
  const stateBranch = handler.slice(handler.indexOf('if (m.t === "state")'), handler.indexOf('if (m.t === "beat")'));
  assert.match(stateBranch, /observeContainers\(watches\.get\(wk\), parseContainerObservations\(m\.containers\), Date\.now\(\), STATE_STALE_MS\)/);
  assert.doesNotMatch(body(src, "function applyState("), /watches|observeContainers/, "🔴 applyState 가 관측을 만진다 — RPC 재확인 경로가 시계를 지운다");
  assert.equal((src.match(/observeContainers\(/g) ?? []).length, 1, "관측을 잇는 자리는 하나다");
});

test("[WIRE-2] 박동은 관측도 잇는다 · 노드를 잊으면 관측도 잊는다 · 판정 재료는 순수 hostViewsOf 로", () => {
  const src = code("node/registry.ts");
  assert.match(body(src, "function applyBeat("), /observeBeat\(watches\.get\(k\), now, STATE_STALE_MS\)/);
  assert.match(body(src, "export function forgetNode("), /watches\.delete\(k\)/);
  assert.match(body(src, "export function sessionHostContainerViews("), /hostViewsOf\(/);
});

test("[WIRE-3] ★ 노드 — 목록을 만들기 전 시각으로 관측을 꺼내 상태에 싣고, 관측이 바뀐 판은 박동으로 삼키지 않는다", () => {
  const push = body(code("node/agent.ts"), "const pushState = async");
  const at = push.indexOf("const obsAt = Date.now();");
  const list = push.indexOf("listSessionsRaw({ strict: true })");
  const take = push.indexOf("takeContainerObservation(obsAt)");
  assert.ok(at >= 0 && list > at && take > list, "obsAt → 목록 → 관측 꺼내기 순서가 아니다(앞 판의 관측을 이번 판 것으로 싣는다)");
  assert.match(push, /const sesKey = JSON\.stringify\(\[sessions, containers\]\);/, "🔴 관측이 비교 키에 없다 — 관측만 바뀐 판이 박동으로 삼켜진다");
  assert.match(push, /\{ t: "state", sessions, res, \.\.\.\(containers \? \{ containers \} : \{\}\) \}/, "관측이 없으면 칸을 안 싣는다(빈 배열 ≠ 모름)");
});
