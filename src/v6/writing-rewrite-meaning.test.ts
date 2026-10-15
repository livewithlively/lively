// 서술 형식 자동 정리 — 의미 판정 답을 통과·탈락으로 환원하는 규칙을 잠근다.
//  예시 항목은 top-16 dry-run 리포트에서 판정기가 실제로 낸 답의 모양이다.
// 실행: npx tsx src/v6/writing-rewrite-meaning.test.ts
import assert from "node:assert/strict";
import { normalizeJudgement, meaningVerdict, meaningFeedback, type MeaningItem } from "./writing-rewrite-gate.js";

let pass = 0;
const t = (name: string, fn: () => void) => { fn(); pass++; console.log(`ok  ${name}`); };

const emojiDropped = { kind: "missing", a: "🧭 엔지니어링 독트린", b: "엔지니어링 독트린", category: "expression", fact_changed: false, reason: "장식 이모지 제거" };
const rangeChanged = { kind: "changed", a: "2 라운드로 제한하고", b: "2 라운드 안팎으로 제한하고", category: "scope", fact_changed: true, reason: "상한이 전후로 바뀜" };
const metaAdded = { kind: "added", a: "", b: "(기존 제목 앞에는 🧭 장식이 있었다)", category: "meta", fact_changed: true, reason: "편집 경위 문장" };

const norm = (raw: unknown, swapped = false): MeaningItem[] => {
  const r = normalizeJudgement(raw, swapped);
  assert.ok(r, "판정 답이 항목 목록으로 펴져야 한다");
  return r;
};

t("판정기가 표현 차이로 표시한 항목만 있으면 두 번 판정 뒤 통과한다", () => {
  const v = meaningVerdict([norm({ items: [emojiDropped] }), norm({ items: [] }, true)], 2);
  assert.equal(v.pass, true);
  assert.equal(v.factual.length, 0);
  assert.equal(v.ignored.length, 1);
});

t("판정 횟수를 다 채우지 못하면 차이가 없어도 통과가 아니다", () => {
  assert.equal(meaningVerdict([norm({ items: [] })], 2).pass, false);
});

t("사실 변화 항목이 하나라도 있으면 표현 차이 항목과 섞여 있어도 탈락한다", () => {
  const v = meaningVerdict([norm({ items: [emojiDropped, rangeChanged] })], 2);
  assert.equal(v.pass, false);
  assert.deepEqual(v.factual.map((x) => x.b), ["2 라운드 안팎으로 제한하고"]);
  assert.deepEqual(v.ignored.map((x) => x.category), ["expression"]);
});

t("편집 경위를 적은 메타 문장은 사실 추가로 탈락한다", () => {
  const v = meaningVerdict([norm({ items: [metaAdded] }), norm({ items: [] })], 2);
  assert.equal(v.pass, false);
  assert.equal(v.factual[0].category, "meta");
});

t("fact_changed=false 라도 범주가 사실 범주면 사실 변화로 본다(판정기 자기모순은 탈락 쪽)", () => {
  const [x] = norm({ items: [{ ...emojiDropped, category: "risk", a: "🔴 되돌릴 수 없음", b: "되돌릴 수 없음" }] });
  assert.equal(x.fact_changed, true);
});

t("fact_changed 가 없거나 불리언 false 가 아니면 사실 변화로 본다", () => {
  const { fact_changed: _omit, ...noFlag } = emojiDropped;
  assert.equal(norm({ items: [noFlag] })[0].fact_changed, true);
  assert.equal(norm({ items: [{ ...emojiDropped, fact_changed: "false" }] })[0].fact_changed, true);
  assert.equal(norm({ items: [{ ...emojiDropped, fact_changed: 0 }] })[0].fact_changed, true);
});

t("모르는 범주는 unknown 으로 두고 사실 변화로 본다", () => {
  const [x] = norm({ items: [{ ...emojiDropped, category: "style" }] });
  assert.equal(x.category, "unknown");
  assert.equal(x.fact_changed, true);
});

t("모르는 kind 는 changed 로 받는다", () => {
  assert.equal(norm({ items: [{ ...rangeChanged, kind: "diff" }] })[0].kind, "changed");
});

t("자리를 바꿔 물은 판정은 missing↔added 와 원문·재작성본 대목을 되돌린다", () => {
  const [x, y] = norm({ items: [{ kind: "added", a: "재작성본 쪽", b: "원문 쪽", category: "claim", fact_changed: true, reason: "" }, rangeChanged] }, true);
  assert.equal(x.kind, "missing");
  assert.equal(x.a, "원문 쪽");
  assert.equal(x.b, "재작성본 쪽");
  assert.equal(y.kind, "changed");
  assert.equal(y.a, rangeChanged.b);
});

t("옛 모양 {missing, added, changed} 답은 표시가 없어 전부 사실 변화로 받는다", () => {
  const items = norm({ missing: ["A 제목의 🧭 이모지는 표현 요소이므로 사실 변화 아님"], added: [], changed: [{ A: "x", B: "y" }] });
  assert.equal(items.length, 2);
  assert.ok(items.every((x) => x.fact_changed));
  assert.equal(meaningVerdict([items], 1).pass, false);
});

t("답의 모양이 아니면 null 이다", () => {
  assert.equal(normalizeJudgement(null, false), null);
  assert.equal(normalizeJudgement("items", false), null);
  assert.equal(normalizeJudgement({ items: "none" }, false), null);
  assert.equal(normalizeJudgement({ missing: [], added: [] }, false), null);
});

t("재시도 피드백에는 사실 변화 항목만 범주·양쪽 대목과 함께 싣는다", () => {
  const fb = meaningFeedback(norm({ items: [emojiDropped, rangeChanged] }));
  assert.equal(fb.length, 1);
  assert.match(fb[0], /\[scope\]/);
  assert.match(fb[0], /원문: 2 라운드로 제한하고/);
  assert.match(fb[0], /재작성본: 2 라운드 안팎으로 제한하고/);
  assert.match(fb[0], /되돌려라/);
  assert.ok(!fb.some((l) => l.includes("🧭")), "표현 차이를 주면 모델이 장식을 되살리려 메타 문장을 쓴다");
});

t("추가 항목의 피드백은 지우라고 말한다", () => {
  const [line] = meaningFeedback(norm({ items: [metaAdded] }));
  assert.match(line, /지워라/);
  assert.match(line, /\[meta\]/);
});

console.log(`writing-rewrite-meaning: ${pass} passed`);
