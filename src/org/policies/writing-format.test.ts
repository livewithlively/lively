// 조직 서술 형식 블록(buildWritingGuideBlock)이 적용 표면(apply_to)을 보는가 — 2026-10-14 리뷰 G.
//  실행: npm run build && node dist/org/policies/writing-format.test.js
//
//  회귀 대상: 표면을 전부 끈 조직(apply_to: [])이나 지식을 뺀 조직에도 세션 주입·증류 프롬프트에 «저장 거부» 예고가 실리는 것.
//   그 조직에서 그 저장은 판정조차 하지 않으므로 예고는 거짓 안내다 — 에이전트는 걸리지도 않는 규칙에 맞추느라 글을 고친다.
//
//  엣지 표(입력 조합 × 기대):
//   G1 | 꺼짐(enabled=false) · 표면 무관                       | "" (켜지 않은 조직의 주입은 바이트 그대로)
//   G2 | 켜짐 · apply_to=[] · 표면 안 줌(세션 주입)             | ""
//   G3 | 켜짐 · apply_to=[] · knowledge                         | ""
//   G4 | 켜짐 · apply_to=[activity, project] · knowledge        | "" (증류기는 지식을 저장한다)
//   G5 | 켜짐 · apply_to=[activity] · 표면 안 줌                | 블록(세션은 작업기록도 쓴다)
//   G6 | 켜짐 · apply_to=[knowledge] · knowledge                | 블록 — 가이드 · 거부 규칙 · 금지어
//   G7 | 켜짐 · apply_to 기본(전부) · 표면 안 줌 / knowledge    | 같은 블록(표면 인자는 거르기만 하고 글을 바꾸지 않는다)
import assert from "node:assert/strict";
import { buildWritingGuideBlock, resolveWritingFormat } from "./writing-format.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const RULES = { local_path: "reject" as const };
const TERMS = ["review-gate"];
const on = (apply_to?: string[]) => resolveWritingFormat({ enabled: true, rules: RULES, forbid_terms: TERMS, ...(apply_to ? { apply_to } : {}) });

t("G1 꺼진 조직은 표면과 상관없이 빈 글", () => {
  const off = resolveWritingFormat({ enabled: false, rules: RULES, forbid_terms: TERMS });
  assert.equal(buildWritingGuideBlock(off), "");
  assert.equal(buildWritingGuideBlock(off, "knowledge"), "");
});

t("G2 표면을 전부 끈 조직(apply_to: [])은 세션 주입에도 블록이 없다", () => {
  assert.equal(on([]).apply_to.length, 0, "전제: 빈 표면이 그대로 해석된다");
  assert.equal(buildWritingGuideBlock(on([])), "");
});

t("G3 표면을 전부 끈 조직은 증류 프롬프트(knowledge)에도 블록이 없다", () => {
  assert.equal(buildWritingGuideBlock(on([]), "knowledge"), "");
});

t("G4 지식을 뺀 조직은 knowledge 표면 블록이 없다", () => {
  assert.equal(buildWritingGuideBlock(on(["activity", "project"]), "knowledge"), "");
});

t("G5 작업기록만 켠 조직도 세션 주입(표면 안 줌)에는 블록이 실린다", () => {
  const b = buildWritingGuideBlock(on(["activity"]));
  assert.ok(b.startsWith(on(["activity"]).guide_md.trim()), b);
});

t("G6 지식을 켠 조직의 knowledge 블록 — 가이드 · 거부 규칙 · 금지어", () => {
  const fmt = on(["knowledge"]);
  const b = buildWritingGuideBlock(fmt, "knowledge");
  assert.ok(b.startsWith(fmt.guide_md.trim()));
  assert.match(b, /저장 거부.*local_path/);
  assert.match(b, /review-gate/);
});

t("G7 표면 인자는 거르기만 한다 — 전부 켠 조직은 세션 블록과 knowledge 블록이 같다", () => {
  const fmt = on();
  assert.deepEqual(fmt.apply_to, ["knowledge", "activity", "project"], "전제: 기본 표면은 전부");
  const session = buildWritingGuideBlock(fmt);
  assert.notEqual(session, "");
  assert.equal(buildWritingGuideBlock(fmt, "knowledge"), session);
  assert.equal(buildWritingGuideBlock(fmt, "project"), session);
});

console.log(`writing-format: ${pass} passed`);
