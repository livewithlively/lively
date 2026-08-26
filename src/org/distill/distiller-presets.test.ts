// 증류기 프리셋 규약 검사 (#1881 F8) — DB·네트워크 불요.
// 실행: npm run build && node dist/org/distill/distiller-presets.test.js
//
//  ── 이 파일이 지키는 것 ────────────────────────────────────────────────────────────────
//  증류기 기준(criteria_md)은 **프롬프트로 나가는 데이터**라 오타·누락이 조용히 프로덕션까지 간다.
//  아래 규약은 distiller-authoring 스킬이 실측으로 적어 둔 함정이고, 특히 둘은 **증상이 성공처럼 보인다**:
//   ① `lifecycle: pending` 지시 — 조직 정책이 auto 여도 전 산출물이 검토 큐에 갇힌다(실측: 세 증류기 전부
//      그 상태였고 아무도 안 봤다). 기준은 lifecycle 을 **지정하지 않는 것**이 정답이다(정책에 맡김).
//   ② 결정성 **키워드에만** 의존하는 판정 — 키워드를 한 번도 안 쓰고 끝나는 실제 업무 대화를 통째로 놓친다.
//      '문제 → 조치 → 확인' 같은 **구조**를 신호로 넣어야 한다.
//  프리셋을 늘릴 땐 PRESETS 에 한 줄 추가하면 전 규약을 그대로 지나간다.
//  사양·엣지 표: 이 커밋의 PR 본문(17행) 참조.
import assert from "node:assert/strict";
import { localFilesDistillerDraft } from "./local-preset.js";
import { figmaCommentsDistillerDraft } from "./figma-preset.js";
import type { DistillerUpsertInput } from "../store/ingest.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const PRESETS: Array<[string, DistillerUpsertInput]> = [
  ["local-files", localFilesDistillerDraft()],
  ["figma-comments", figmaCommentsDistillerDraft()],
];

// ── 배선(엣지 표 17행) — 이게 없으면 아래 순회가 전부 vacuous 다 ──────────────────────────
//  PRESETS 는 이 파일에서 새로 만든 목록이다. 비면 for 문이 0회 돌고 **모든 단언이 통과한다**.
//  '새로 도입한 것이 비었을 때' 행을 표에 반드시 넣으라는 규율이 정확히 이 자리를 겨냥한다.
t("배선: 프리셋이 2개 이상이고, 각 프리셋의 기준·형식이 비어 있지 않다", () => {
  assert.ok(PRESETS.length >= 2, `프리셋이 ${PRESETS.length}개 — 순회가 vacuous 해진다`);
  for (const [key, p] of PRESETS) {
    assert.ok(String(p.criteria_md ?? "").trim().length > 200, `${key} 의 criteria_md 가 비었거나 너무 짧다`);
    assert.ok(String(p.format_md ?? "").trim().length > 100, `${key} 의 format_md 가 비었거나 너무 짧다`);
    assert.ok(String(p.key ?? "").length > 0, `${key} 에 key 가 없다`);
  }
});

// ── 전 프리셋 공통 규약 ────────────────────────────────────────────────────────────────
t("P1 꺼진 채로 출하한다 — 기준이 설익은 채 첫 배치가 나가면 산출물을 지우기 어렵다", () => {
  for (const [key, p] of PRESETS) assert.equal(p.enabled, false, `${key} 가 켜진 채로 만들어진다`);
});

t("★ P2 lifecycle 값을 지시하지 않는다 — 지시하면 조직 인입 정책을 뚫고 검토 큐에 갇힌다", () => {
  for (const [key, p] of PRESETS) {
    const c = String(p.criteria_md ?? "");
    // 금지되는 건 **값 지시**다. "lifecycle 을 직접 지정하지 마라" 같은 안내 문구는 오히려 있어야 한다.
    assert.ok(!/lifecycle\s*[:=]\s*['"`]?(pending|active)/i.test(c),
      `${key} 기준이 lifecycle 값을 지시한다 — 정책(org_ingest_policy)이 정할 몫이다`);
    assert.match(c, /lifecycle 을 직접 지정하지 마라/, `${key} 기준에 lifecycle 지정 금지 안내가 없다`);
  }
});

t("P3 판정이 절대 기준이다 — 백분위·상위 N% 는 증분 배치에서 분포가 없어 성립하지 않는다", () => {
  for (const [key, p] of PRESETS) {
    const c = String(p.criteria_md ?? "");
    assert.match(c, /백분위/, `${key} 기준에 백분위 금지 문구가 없다`);
    assert.match(c, /하나라도/, `${key} 기준에 '신호가 하나라도 있으면' 형태의 절대 임계가 없다`);
  }
});

t("★ P4 키워드 없이 닫히는 **구조**도 신호로 잡는다 — 여기서 가장 크게 샌다", () => {
  for (const [key, p] of PRESETS) {
    const c = String(p.criteria_md ?? "");
    assert.match(c, /키워드가 없어도/,
      `${key} 기준이 결정성 키워드에만 기대고 있다 — 키워드를 안 쓰는 대화를 통째로 놓친다`);
    assert.match(c, /→/, `${key} 기준에 '문제 → 조치 → 결과' 같은 구조 신호가 없다`);
  }
});

t("P5 중복 방지 4요소 — 새 name 재저장·배치 분할이 같은 지식을 두 번 만든다", () => {
  for (const [key, p] of PRESETS) {
    const c = String(p.criteria_md ?? "");
    assert.match(c, /knowledge_similar/, `${key}: 저장 전 유사 확인 규약이 없다`);
    assert.match(c, /같은 name/, `${key}: '같은 name 으로 갱신' 규약이 없다`);
    assert.match(c, /source_link_knowledge/, `${key}: 자료 링크 규약이 없다`);
    assert.match(c, /서브에이전트로 쪼개지 마라/, `${key}: 배치 분할 금지가 없다`);
  }
});

t("P6 형식이 자료 id 본문 나열을 금지한다 — 링크가 정본이고 숫자 나열은 갱신도 클릭도 안 된다", () => {
  for (const [key, p] of PRESETS) {
    assert.match(String(p.format_md ?? ""), /자료 id 를 본문에 나열하지 마라/, `${key} 형식에 그 금지가 없다`);
  }
});

t("P7 catch-all 레인이다 — priority<0(0 은 불가) + 채널 무제한으로 사각지대를 만들지 않는다", () => {
  for (const [key, p] of PRESETS) {
    assert.ok(typeof p.priority === "number" && p.priority < 0,
      `${key} 의 priority(${p.priority})가 catch-all(음수)이 아니다 — 0 도 안 된다`);
    assert.equal(p.include_channels, null, `${key} 가 채널을 좁히고 있다 — 그 밖 자료가 사각지대가 된다`);
  }
});

// ── 피그마 전용 — 디자인 코멘트가 슬랙 메시지와 다른 지점들 ──────────────────────────────
const figma = figmaCommentsDistillerDraft();

t("F1 스코프가 kind 전용이다(figma_comment) — 다른 커넥터 자료를 집어가지 않는다", () => {
  assert.deepEqual(figma.match_kinds, ["figma_comment"]);
  assert.equal(figma.match_system, "figma");
});

t("F2 판단 단위가 스레드다 — 코멘트 낱개는 '확인'·이모지라 뜻이 없다", () => {
  assert.equal(figma.thread_aware, true);
  assert.match(String(figma.criteria_md), /스레드/);
});

t("★ F3 사전필터가 꺼져 있다 — 길이·참여자·키워드 축이 전부 디자인 코멘트에 불리하다", () => {
  assert.equal(figma.prefilter_level, 0, "코멘트는 짧고 둘이서 오가며 결정 단어를 안 쓴다 — 켜면 유실만 난다");
  assert.equal(figma.prefilter_rules, null);
  assert.equal(figma.min_chars, 0, "길이 컷은 '간격 8' 같은 사양 확정을 통째로 버린다");
});

t("★ F4 resolved 를 신호로 쓰고 미해결을 결정으로 굳히지 않는다 — 슬랙엔 없는 표식이다", () => {
  const c = String(figma.criteria_md);
  assert.match(c, /resolved/);
  assert.match(c, /논의 중/, "미해결 스레드를 결정으로 굳히지 말라는 구분이 없다");
  assert.match(String(figma.format_md), /열린 사항/, "형식에 미해결 스레드를 적는 자리가 없다");
});

t("F5 파일명(채널)을 맥락으로 남긴다 — 코멘트는 '여기·이거'로 말해 본문만으론 화면을 모른다", () => {
  assert.match(String(figma.criteria_md), /container_name/);
});

console.log(`\ndistiller presets tests: ${pass} passed`);
