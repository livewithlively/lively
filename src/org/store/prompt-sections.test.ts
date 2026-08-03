// 프롬프트 조각 오버라이드 저장 위생(#1419-B) — DB 에 오해를 남기지 않는다.
//
// 왜: 조립부(buildDistillerPrompt)는 불변 조각(targeting·guards)과 오타 키를 무시한다. 그래도 저장 단계에서
// 걸러야 한다 — DB 에 `guards: "..."` 가 남으면 관리탭이 그걸 편집 가능한 조각으로 오인해 보여주고,
// 사람은 "안전 문구를 바꿨다"고 믿는데 실제로는 아무 효과가 없다(조용한 거짓 설정).
import { strict as assert } from "node:assert";
import { sanitizePromptSections } from "./ingest.js";

let pass = 0;
const t = (n: string, f: () => void): void => { f(); pass++; console.log(`ok  ${n}`); };

t("S1 편집 가능한 조각은 통과한다", () => {
  assert.deepEqual(sanitizePromptSections({ intro: "a", procedure: "b" }), { intro: "a", procedure: "b" });
});

t("S2 불변 조각은 버린다 — 저장돼 있으면 '바꿨다'는 거짓 인상을 남긴다", () => {
  assert.equal(sanitizePromptSections({ targeting: "x", guards: "y" }), null);
  assert.deepEqual(sanitizePromptSections({ intro: "a", guards: "y" }), { intro: "a" });
});

t("S3 알 수 없는 키·비문자열은 버린다(오타가 설정으로 굳지 않게)", () => {
  assert.deepEqual(sanitizePromptSections({ procedur: "오타", intro: "a", format: 3, thread: null }), { intro: "a" });
});

t("S4 빈 문자열은 **유효한 값**이다 — 그 조각을 뺀다는 뜻이라 버리면 안 된다", () => {
  assert.deepEqual(sanitizePromptSections({ thread: "" }), { thread: "" },
    "빈 문자열을 걸러내면 조각을 뺄 방법이 사라진다");
});

t("S5 객체가 아니거나 남는 게 없으면 null(컬럼을 비운다)", () => {
  for (const v of [null, undefined, "str", 3, [], {}, { guards: "y" }]) assert.equal(sanitizePromptSections(v), null);
});

console.log(`prompt-sections.test: ok (${pass})`);
