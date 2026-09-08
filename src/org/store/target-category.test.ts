// #1631 — 레인 목적지(target_category) 판정. 순수 함수라 단위로 잠근다.
//
//  왜 이 가드가 있나(실측 2026-09-02, 서리재): target_category 는 TEXT 라 무엇이든 들어갔고,
//  증류 프롬프트가 그 값을 그대로 «분류(category)는 'comms' 로 고정해 저장한다» 로 싣는다.
//  그런데 `comms` 라는 축이 없었다 — 그 레인이 자료 54건을 판정했고(전체 1위), 나온 지식 17건은
//  LLM 이 알아서 다른 5축으로 흩었다. **결과는 괜찮았지만 화면은 여전히 «목적지: comms» 라고 말한다.**
//
//  사양·엣지 표: scratchpad/spec-cat4.md 의 ⑧행.
import assert from "node:assert/strict";
import { judgeTargetCategory } from "./ingest.js";

const live = new Map<string, string>([
  ["brewing", "active"],
  ["partners", "active"],
  ["old-admin", "deprecated"],
]);

// 배선 단언 — 관측 장치가 살아 있나. 이게 없으면 아래가 통째로 vacuous 일 수 있다.
assert.equal(judgeTargetCategory("brewing", live).ok, true, "관측 장치 확인 — 실존하는 활성 축은 통과해야 한다");
assert.equal(judgeTargetCategory("comms", live).ok, false, "관측 장치 확인 — 없는 축은 반드시 거절된다");

// ⑧-1 실존하는 활성 축 → 통과
assert.deepEqual(judgeTargetCategory("partners", live), { ok: true });

// ⑧-2 없는 축 → 거절(unknown). 실측에서 실제로 저장돼 있던 두 값.
assert.deepEqual(judgeTargetCategory("comms", live), { ok: false, reason: "unknown" });
assert.deepEqual(judgeTargetCategory("talks", live), { ok: false, reason: "unknown" });

// ⑧-3 빈 값 계열 → 통과. catch-all 레인의 정상 상태다(목적지를 안 정하고 분류기에 맡긴다).
for (const empty of [null, undefined, "", "   ", "\t\n"]) {
  assert.deepEqual(judgeTargetCategory(empty, live), { ok: true }, `빈 값(${JSON.stringify(empty)})은 catch-all 이라 통과`);
}

// ⑧-4 비활성 축 → 거절(deprecated). 새 지식을 비활성 축으로 보내는 건 «비활성» 의 뜻과 정반대다.
assert.deepEqual(judgeTargetCategory("old-admin", live), { ok: false, reason: "deprecated" });

// 경계 — 앞뒤 공백은 다듬어 판정한다(사람이 붙여넣으면 공백이 딸려 온다).
assert.deepEqual(judgeTargetCategory("  brewing  ", live), { ok: true }, "공백은 다듬고 본다");
//  다만 «가운데» 는 안 다듬는다 — 그건 다른 key 다.
assert.equal(judgeTargetCategory("brew ing", live).ok, false, "가운데 공백은 다른 key 다");

// 축이 하나도 없는 새 워크스페이스 — 무엇을 넣어도 unknown, 빈 값만 통과.
const none = new Map<string, string>();
assert.deepEqual(judgeTargetCategory("brewing", none), { ok: false, reason: "unknown" });
assert.deepEqual(judgeTargetCategory("", none), { ok: true });

console.log("ok  레인 목적지 — 실존 활성 축만 통과, 없는 축·비활성 축은 거절, 빈 값은 catch-all");
