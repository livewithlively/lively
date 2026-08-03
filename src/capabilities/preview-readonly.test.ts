// 미리보기는 POST 여도 **읽기 전용**이다(#1419-B UX 회귀 가드).
//
// 왜: draft 미리보기는 본문이 커서(criteria_md 가 수천 자) GET 쿼리로 못 보낸다 → POST 라우트를 뒀다.
// 그런데 capMutates 는 "REST 에 POST 가 있으면 쓰기"로 파생하므로, 명시하지 않으면 이 op 이 쓰기로 분류돼
// **읽기전용 세션이 미리보기조차 못 한다** — 설정을 바꿀 권한이 없는 사람이 확인도 못 하게 되는 건
// 이 화면의 취지(무엇이 집히는지 켜기 전에 본다)를 정면으로 깬다.
// 반대로 저장(upsert)은 계속 차단돼야 한다 — 읽기전용의 본령이다.
import { strict as assert } from "node:assert";
import { registry, capMutates, isReadOnlyBlocked } from "./index.js";

const get = (n: string) => {
  const c = [...registry.values()].find((x) => x.name === n);
  assert.ok(c, `capability '${n}' 이 registry 에 없다 — 이 테스트가 아무것도 안 보고 있다(배선 확인)`);
  return c!;
};

// R1 — 미리보기는 읽기로 분류된다.
const prev = get("org_distiller_preview");
assert.equal(capMutates(prev), false, "미리보기가 쓰기로 분류되면 읽기전용 세션이 확인조차 못 한다");
assert.equal(isReadOnlyBlocked(prev), false, "읽기전용에서 차단되면 안 된다");

// R2 — 그런데 POST 라우트는 실제로 있다(GET 만 남기면 draft 를 못 보낸다).
const methods = (Array.isArray(prev.expose.rest) ? prev.expose.rest : []).map((r) => String(r.method));
assert.ok(methods.includes("POST"), "draft 를 보낼 POST 경로가 있어야 한다(본문이 커서 GET 불가)");
assert.ok(methods.includes("GET"), "기존 GET 경로도 유지해야 한다(무회귀)");

// R3 — 쓰기 op 은 여전히 쓰기다. 위 예외가 넓게 새면 안 된다.
for (const n of ["org_distiller_upsert", "org_distiller_remove"]) {
  assert.equal(capMutates(get(n)), true, `${n} 은 쓰기로 남아야 한다 — 읽기전용의 본령이다`);
  assert.equal(isReadOnlyBlocked(get(n)), true);
}

// R4 — 현 상태 기록: org_distiller_tune 은 SELECT 만 하는데도 POST 라우트 때문에 **쓰기로 분류**된다.
//  즉 읽기전용 세션은 튜닝 재료 조회를 못 한다. 이번 변경 범위가 아니라 손대지 않고 사실만 못박는다 —
//  나중에 읽기로 바꾸려면 이 단언이 실패하며 "의도한 변경인가"를 묻게 된다.
assert.equal(capMutates(get("org_distiller_tune")), true,
  "지금은 쓰기로 분류된다(POST 파생). 읽기로 바꾸려면 restWork 의 mutates:false 를 달고 이 단언을 뒤집어라");

console.log("preview-readonly.test: ok");
