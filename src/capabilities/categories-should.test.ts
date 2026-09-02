// #1631 — 분류축의 «정의(should)» 는 만들 때 필수다.
//
//  왜 이 가드가 있나(실측 2026-09-01): 같은 코드가 같은 일을 두 갈래로 했다. 한 워크스페이스는 축 3개가
//  전부 정의 0자, 다른 워크스페이스는 5개가 81~114자였다. 정의가 비면 분류·소환이 **축 이름의 어감으로만**
//  판정한다(recall-router 가 `SELECT id, key, name, should FROM category` 로 정의를 읽는다).
//  optional 이던 동안 결과가 갈린 건 우연이 아니라 **규정이 빈 자리**였다.
//
//  사양·엣지 표: scratchpad/spec.md (8행). 아래 시나리오는 그 행과 1:1 이다.
//  ⚠ 고칠 때(category_update)는 종전대로 선택 — 이름만 바꾸는 부분 수정을 막으면 안 된다.
import assert from "node:assert/strict";
import { z } from "zod";
import { registry } from "./index.js";

const shapeOf = (name: string): z.ZodRawShape => {
  const cap = registry.get(name);
  assert.ok(cap, `${name} op 이 있어야 한다`);
  return cap.input as z.ZodRawShape;
};

const create = z.object(shapeOf("category_create"));
const update = z.object(shapeOf("category_update"));
//  ⚠ space 는 아직 필수 입력이라 함께 준다 — 이 축을 걷어내는 작업이 끝나면 이 줄에서 빼면 된다.
//   (fail-first 에서 이걸 빠뜨려 «모든 파싱이 실패»해 거절 단언이 거저 통과한 적이 있다. 그게 vacuous test 다.)
const base = { space: "business", key: "brewing", name: "양조·생산" };
const mk = (should: unknown) => create.safeParse({ ...base, should });

// 배선 단언 — 관측 장치가 살아 있나. 이게 없으면 아래가 통째로 vacuous 일 수 있다.
assert.ok(Object.keys(shapeOf("category_create")).includes("should"), "create 입력에 should 필드가 있어야 한다");
assert.equal(mk("가").success, false, "관측 장치 확인 — 짧은 정의는 반드시 거절된다");

// 1) 정의 없음
assert.equal(create.safeParse({ ...base }).success, false, "① 정의 없이 만들 수 없다");
// 2) 빈 문자열
assert.equal(mk("").success, false, "② 빈 정의는 거절");
// 3) 공백만 — trim 도입으로 새로 생긴 엣지
assert.equal(mk("                                                  ").success, false, "③ 공백만 있는 정의는 거절(trim 후 판정)");
// 4) 경계 −1
assert.equal(mk("가".repeat(39)).success, false, "④ 39자는 거절(경계 −1)");
// 5) 경계 정확히
assert.equal(mk("가".repeat(40)).success, true, "⑤ 40자는 통과(경계)");
// 6) 상한 +1
assert.equal(mk("가".repeat(8001)).success, false, "⑥ 8001자는 거절(상한 +1)");
// 7) 제대로 된 정의
assert.equal(
  mk("술을 빚는 일의 기록을 담는다. 담금·발효·여과·병입의 조건과 결과가 여기로 오고, 거래처와 주고받은 금액·기한은 「거래처」로 보낸다.").success,
  true, "⑦ 제대로 된 정의는 통과");

// 거절 사유가 사람 말이어야 한다 — 무엇을 적어야 하는지가 문구에 있어야 그 자리에서 고친다.
const bad = mk("짧음");
assert.equal(bad.success, false);
if (!bad.success) {
  const msg = bad.error.issues.map((i) => i.message).join(" ");
  assert.match(msg, /정의/, "오류 문구에 '정의' 가 있어야 한다");
  assert.match(msg, /담지 않는/, "무엇을 담고 무엇을 담지 않는지를 안내해야 한다");
}

// 8) 고칠 때는 선택 유지
assert.equal(update.safeParse({ id: 1, name: "새 이름" }).success, true, "⑧ 정의 없이도 수정은 된다");

console.log("ok  category_create 는 정의를 요구하고(8행), category_update 는 종전대로 선택이다");
