// «멤버 토큰 수집기 토글» 순수 규칙 잠금(#2247). DB·네트워크 불요.
//   실행: npm run build && node dist/capabilities/member-collect.test.js
//  겨누는 고장: ① 자격 없이 켜져 «켜짐인데 0건» ② 범위 없이 켜져 크론이 매 주기 실패 ③ 끄기가 자격 유무에 막힘.
import assert from "node:assert/strict";
import { memberCollectPlan, scopeSatisfied, normalizeScopeInput } from "./member-collect.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("끄기는 자격·범위와 무관하게 늘 된다(전임자가 나간 수집기도 끌 수 있어야 한다)", () => {
  assert.equal(memberCollectPlan({ enabled: false, meConnected: false, scopeOk: false }), "disable");
});
t("자격이 없으면 needs_connect — 범위가 있어도 켜지 않는다", () => {
  assert.equal(memberCollectPlan({ enabled: true, meConnected: false, scopeOk: true }), "needs_connect");
});
t("자격은 있는데 범위가 비면 needs_scope — 켜지 않는다(크론 실패 로그 방지)", () => {
  assert.equal(memberCollectPlan({ enabled: true, meConnected: true, scopeOk: false }), "needs_scope");
});
t("둘 다 있으면 enable", () => {
  assert.equal(memberCollectPlan({ enabled: true, meConnected: true, scopeOk: true }), "enable");
});
t("scopeSatisfied — 범위 요구가 없으면 늘 참, 있으면 키 중 하나라도 차야 참(공백은 빈 것)", () => {
  assert.equal(scopeSatisfied({}, {}), true);
  assert.equal(scopeSatisfied({ requireScope: true, scopeKeys: ["file_keys", "team_ids"] }, {}), false);
  assert.equal(scopeSatisfied({ requireScope: true, scopeKeys: ["file_keys", "team_ids"] }, { file_keys: "   " }), false);
  assert.equal(scopeSatisfied({ requireScope: true, scopeKeys: ["file_keys", "team_ids"] }, { team_ids: "123" }), true);
});
t("normalizeScopeInput — 표에 있는 키만, 배열은 공백으로 합친다(피그마 링크 규약), 모르는 키는 버린다", () => {
  const r = normalizeScopeInput({ scopeKeys: ["file_keys", "team_ids"] }, { file_keys: ["https://figma.com/file/a", " https://figma.com/file/b "], team_ids: " 9 ", token_source: "member:evil" });
  assert.deepEqual(r, { file_keys: "https://figma.com/file/a https://figma.com/file/b", team_ids: "9" });
  assert.deepEqual(normalizeScopeInput({ scopeKeys: ["x"] }, "nope"), {});
});
console.log(`\n${pass} passed`);
