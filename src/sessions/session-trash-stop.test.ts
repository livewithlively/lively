// #3870 — «멈추고 휴지통으로» 는 멈출 수 있을 때만 받는다(session-trash-ops liveTrashRefusal).
//
//  격리 리뷰 지적(2026-10-05): 사이드바 휴지통 단추가 도는 세션에 «하던 작업이 멈춘다» 고 묻고 stop_live 로 보내는데, 그 세션이 도는
//   컴퓨터가 꺼져 있으면 stopForPurge 가 아무것도 못 멈추고 true 를 줘서 표식만 붙었다 — 목록에서 사라진 채 그 PC 에서 계속 돈다.
//
//  엣지 표(행마다 단언):
//   L1 휴지통 · 꼭 멈춰야 함 · 노드 세션 · 노드 꺼짐 → 거절(이유 한 줄)
//   L2 같은 조건인데 노드가 켜져 있다 → 받는다(null)
//   L3 중앙 세션(노드 없음 — null · 빈 값) → 받는다(게이트웨이가 직접 멈춘다)
//   L4 꼭 멈춰야 함이 아니다(프로젝트를 통째로 버리는 길) → 노드가 꺼져 있어도 종전대로 받는다
//   L5 완전 삭제 · 되돌리기 · 비우기 → 이 판정과 무관(종전 그대로)
//   W1 배선 — 라우트는 stop_live 가 정확히 true 인 trash 에만 stopLive · mustStop 을 함께 넘기고, 조작 루프는 멈추기 **전에** 이 판정을 묻는다
//  fail-first(2026-10-05): 판정이 늘 null(L1) · 노드 켜짐을 안 봄(L2) · 중앙 세션도 거절(L3) · mustStop 을 안 봄(L4) · op 를 안 봄(L5) 변이가 모두 빨강.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { liveTrashRefusal } from "./session-trash-ops.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const base = { op: "trash" as const, mustStop: true, nodeId: "pc-1", nodeOnline: false };

t("L1 휴지통 · 꼭 멈춰야 함 · 노드 꺼짐 → 거절하고 이유를 말한다", () => {
  const why = liveTrashRefusal(base);
  assert.equal(typeof why, "string");
  assert.ok((why as string).length > 0);
});
t("L2 노드가 켜져 있으면 받는다", () => assert.equal(liveTrashRefusal({ ...base, nodeOnline: true }), null));
t("L3 중앙 세션(노드 없음)은 받는다", () => {
  assert.equal(liveTrashRefusal({ ...base, nodeId: null }), null);
  assert.equal(liveTrashRefusal({ ...base, nodeId: "" }), null);
});
t("L4 꼭 멈춰야 함이 아니면(프로젝트 통째로) 노드가 꺼져 있어도 종전대로 받는다", () => assert.equal(liveTrashRefusal({ ...base, mustStop: false }), null));
t("L5 완전 삭제 · 되돌리기 · 비우기는 이 판정과 무관하다", () => {
  for (const op of ["purge", "untrash", "empty"] as const) assert.equal(liveTrashRefusal({ ...base, op }), null, op);
});
t("W1 배선 — 라우트가 mustStop 을 함께 넘기고, 루프는 멈추기 전에 묻는다", () => {
  const here = new URL(".", import.meta.url).pathname.replace(/\/dist\//, "/src/");
  const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const route = code(readFileSync(`${here}session-trash-routes.ts`, "utf8"));
  assert.match(route, /const stopLive = op === "trash" && b\.stop_live === true;/);
  assert.match(route, /ids, stopLive \? \{ stopLive: true, mustStop: true \} : \{\}\)/);
  const ops = code(readFileSync(`${here}session-trash-ops.ts`, "utf8"));
  const ask = ops.indexOf("const refused = liveTrashRefusal({ op, mustStop: !!opts.mustStop, nodeId, nodeOnline: !!nodeId && nodeOnline(nodeId) });");
  const skip = ops.indexOf("if (refused) { skipped.push({ id, why: refused }); continue; }");
  const stop = ops.indexOf("const stopped = await stopForPurge(u, me, boxId, nodeId);");
  assert.ok(ask > 0 && skip > ask && stop > skip, "판정 → 건너뛰기 → 멈추기 순서");
});

console.log(`\n${pass} passed`);
