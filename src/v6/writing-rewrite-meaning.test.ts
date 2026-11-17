// 서술 형식 자동 정리 — 의미 판정 답을 통과·탈락으로 환원하는 규칙을 잠근다.
//  예시 항목은 top-16 dry-run 리포트에서 판정기가 실제로 낸 답의 모양이다.
// 실행: npx tsx src/v6/writing-rewrite-meaning.test.ts
import assert from "node:assert/strict";
import { normalizeJudgement, meaningVerdict, meaningFeedback, riskGradePreserved, type MeaningItem } from "./writing-rewrite-gate.js";

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

// 위험도 기호 → 같은 등급 글 — 예시는 2026-10-03 E 재처리 리포트에서 판정기가 risk 로 분류해 떨어뜨린 실제 항목이다.
const riskKept = { kind: "changed", a: "🔴 **같은 논거로 `nhc` 도 탈락했다**(2026-09-04).", b: "위험도: 높음. 같은 논거로 `nhc` 도 탈락했다(2026-09-04).", category: "risk", fact_changed: false, reason: "🔴를 동일 등급 문구로 옮겨 등급 유지" };

t("위험도 기호를 같은 등급의 글로 옮겼고 판정기도 사실 변화가 아니라고 하면 비사실로 본다", () => {
  const [x] = norm({ items: [riskKept] });
  assert.equal(x.fact_changed, false);
  assert.equal(meaningVerdict([norm({ items: [riskKept] }), norm({ items: [] }, true)], 2).pass, true);
});

t("자리를 바꿔 물은 판정에서도 원문→재작성본 방향으로 등급을 대조한다", () => {
  const swappedAnswer = { ...riskKept, a: riskKept.b, b: riskKept.a };
  const [x] = norm({ items: [swappedAnswer] }, true);
  assert.equal(x.a, riskKept.a);
  assert.equal(x.fact_changed, false);
});

t("판정기가 사실 변화라고 하면 등급이 보존돼 보여도 사실 변화다(두 신호가 모두 맞아야 한다)", () => {
  assert.equal(norm({ items: [{ ...riskKept, fact_changed: true }] })[0].fact_changed, true);
});

t("등급을 낮췄거나 기호만 지웠으면 판정기가 false 라 해도 사실 변화다", () => {
  assert.equal(norm({ items: [{ ...riskKept, b: "주의: 같은 논거로 `nhc` 도 탈락했다(2026-09-04)." }] })[0].fact_changed, true);
  assert.equal(norm({ items: [{ ...riskKept, b: "같은 논거로 `nhc` 도 탈락했다(2026-09-04)." }] })[0].fact_changed, true);
});

t("riskGradePreserved — 등급 열이 같고 기호가 실제로 글이 됐을 때만 참", () => {
  assert.equal(riskGradePreserved("**⚠️ same-day 전제**: 랑데부", "주의: same-day 전제 — 랑데부"), true);
  assert.equal(riskGradePreserved("**스캔 품질 하한** 🔴 성공률 최대 레버", "스캔 품질 하한 — 위험도: 높음, 성공률 최대 레버"), true);
  assert.equal(riskGradePreserved("🔴 A 🟡 B", "위험도: 높음 — A. 위험도: 중간 — B"), true);
  assert.equal(riskGradePreserved("🔴 A 🟡 B", "위험도: 높음 — A. B"), false);
  assert.equal(riskGradePreserved("🟡 A", "위험도: 높음 — A"), false);
  assert.equal(riskGradePreserved("위험도: 높음 — A", "위험도: 높음 — A"), false);
  assert.equal(riskGradePreserved("주의가 필요하다 ⚠️", "주의가 필요하다"), false);
  assert.equal(riskGradePreserved("⚠ 같은 날 전제", "주의: 같은 날 전제"), true);
});

t("riskGradePreserved — 등급 개수가 같아도 자리끼리 바뀌었거나 글 대응 없는 표지를 지웠으면 거짓", () => {
  assert.equal(riskGradePreserved("🔴 A. 🟡 B", "위험도: 중간 — A. 위험도: 높음 — B"), false);
  assert.equal(riskGradePreserved("🔴 A ⚠️ B", "주의: A. 위험도: 높음 B"), false);
  assert.equal(riskGradePreserved("🔴 🚨 X", "위험도: 높음 X"), false);
  assert.equal(riskGradePreserved("🔴 🚨 X", "위험도: 높음 🚨 X"), true);
});

// 옮겨졌을 뿐인 항목 — 판정기가 fact_changed=false 로 적고도 category 를 meta·date·claim 으로 달아 탈락하던 r2 사례의 모양이다.
const movedDate = { kind: "changed", a: "Docker Hub openjdk 17 태그 소멸 (2026-08-27 발견)", b: "2026-08-27 에 발견한 Docker Hub openjdk 17 태그 소멸", category: "meta", fact_changed: false, reason: "제목의 날짜가 본문 첫머리로 옮겨졌을 뿐 값은 그대로다" };
const rewrittenDoc = { title: "Docker Hub 태그 소멸", body_md: "결론 한 줄.\n\n## 경위\n\nDocker Hub openjdk 17 태그   소멸\n(2026-08-27 발견) 뒤 base 를 바꿨다." };

t("fact_changed=false 이고 원문 대목이 재작성본 전문에 그대로 있으면 이동으로 보고 통과한다", () => {
  const v = meaningVerdict([norm({ items: [movedDate] }), norm({ items: [] }, true)], 2, rewrittenDoc);
  assert.equal(v.pass, true);
  assert.equal(v.ignored[0].moved, true);
  assert.equal(v.ignored[0].fact_changed, false);
});

t("이동 대조는 자리를 바꿔 물은 판정에서도 원문 쪽 대목으로 한다", () => {
  const swappedAnswer = { ...movedDate, kind: "changed", a: movedDate.b, b: movedDate.a };
  assert.equal(meaningVerdict([norm({ items: [swappedAnswer] }, true)], 1, rewrittenDoc).pass, true);
  // 재작성본 쪽 대목(b)만 전문에 있는 건 이동이 아니다.
  const onlyRewritten = { title: "Docker Hub 태그 소멸", body_md: "2026-08-27 에 발견한 Docker Hub openjdk 17 태그 소멸" };
  assert.equal(meaningVerdict([norm({ items: [swappedAnswer] }, true)], 1, onlyRewritten).pass, false);
});

t("판정기가 fact_changed=true 라 하면 대목이 전문에 있어도 사실 변화다", () => {
  assert.equal(meaningVerdict([norm({ items: [{ ...movedDate, fact_changed: true }] })], 1, rewrittenDoc).pass, false);
});

t("원문 대목이 전문에 없으면 판정기가 false 라 해도 사실 변화다", () => {
  const v = meaningVerdict([norm({ items: [{ ...movedDate, a: "Docker Hub openjdk 17 태그 소멸 (2026-08-28 발견)" }] })], 1, rewrittenDoc);
  assert.equal(v.pass, false);
  assert.equal(v.factual[0].moved, undefined);
});

t("이동 대조는 공백만 맞춘다 — 볼드·헤딩 기호가 빠진 대목은 그대로 있는 것이 아니다", () => {
  const bold = { ...movedDate, a: "**Docker Hub openjdk 17 태그 소멸** (2026-08-27 발견)" };
  assert.equal(meaningVerdict([norm({ items: [bold] })], 1, rewrittenDoc).pass, false);
});

t("짧은 원문 대목은 문서 다른 자리와 우연히 겹칠 수 있어 이동으로 받지 않는다", () => {
  // 재작성본에 "2026" 이 있어도 값 치환일 수 있다 — 하한 미만은 판정기 말과 무관하게 사실 변화로 남긴다.
  const short = { ...movedDate, a: "2026", b: "2025" };
  const v = meaningVerdict([norm({ items: [short] })], 1, rewrittenDoc);
  assert.equal(v.pass, false);
  assert.equal(v.factual[0].moved, undefined);
});

t("서술 주장(claim)은 원문 대목이 남아 있어도 이동으로 받지 않는다 — 상반 주장을 덧붙인 것일 수 있다", () => {
  const doc = { title: "배포 절차", body_md: "실제로는 자동 배포다.\n\n배포는 수동 승인 뒤에만 진행한다." };
  const claim = { kind: "changed", a: "배포는 수동 승인 뒤에만 진행한다", b: "실제로는 자동 배포다", category: "claim", fact_changed: false, reason: "문장이 옮겨졌을 뿐이다" };
  const v = meaningVerdict([norm({ items: [claim] })], 1, doc);
  assert.equal(v.pass, false);
  assert.equal(v.factual[0].moved, undefined);
});

t("원문 쪽 대목이 빈 추가 항목은 이동이 될 수 없다", () => {
  assert.equal(meaningVerdict([norm({ items: [{ ...metaAdded, fact_changed: false }] })], 1, rewrittenDoc).pass, false);
});

t("재작성본을 주지 않으면 이동 대조 없이 종전대로 가른다", () => {
  assert.equal(meaningVerdict([norm({ items: [movedDate] })], 1).pass, false);
});

t("이동으로 받은 항목은 재시도 피드백에 싣지 않는다", () => {
  const v = meaningVerdict([norm({ items: [movedDate, rangeChanged] })], 1, rewrittenDoc);
  assert.equal(v.factual.length, 1);
  assert.deepEqual(meaningFeedback([...v.factual, ...v.ignored]).length, 1);
});

console.log(`writing-rewrite-meaning: ${pass} passed`);
