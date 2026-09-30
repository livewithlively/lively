// #4194 — 증류기 레인 두 종류의 입력 판정(org/distill/lanes.ts). 순수 함수 — DB 무의존.
//  실행: npm run build && node dist/org/distill/lanes.test.js
//  사양의 엣지 표 한 행 = 테스트 하나(행 번호를 이름 앞에 둔다). 사양: 프로젝트 #4194 검토 지식 · 이 파일 머리의 표.
import assert from "node:assert/strict";
import { assertLaneFields, isActiveLane, laneMarker, KNOWLEDGE_ONLY_FIELDS, SOURCE_ONLY_FIELDS } from "./lanes.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ══ 레인이 실제로 일하나(isActiveLane) — 크론 대상·커버리지·파이프라인 «켜진 수» 가 이 한 판정을 쓴다 ══
//  (행 1~4 의 laneInputOf 는 적대검증 뒤 폐기 — 쓰기 op 를 이름으로 갈라 input 파라미터가 없어졌다.)
t("[A1] 켜진 unmapped 레인은 일한다", () => assert.equal(isActiveLane({ enabled: true, target: "unmapped" }), true));
t("[A2] 켜진 both 레인도 일한다 — both 는 이제 미분류만 본다", () => assert.equal(isActiveLane({ enabled: true, target: "both" }), true));
t("[A3] 켜진 low_confidence 레인은 안 일한다 — 인박스가 빈 폐지 모드가 폴백 자리를 차지하면 안 된다", () => {
  assert.equal(isActiveLane({ enabled: true, target: "low_confidence" }), false);
});
t("[A4] 꺼진 레인은 target 과 무관하게 안 일한다", () => {
  for (const target of ["unmapped", "both", "low_confidence"]) assert.equal(isActiveLane({ enabled: false, target }), false, target);
});
t("[A5] target 이 비어 있어도(옛 행) 켜져 있으면 일한다", () => {
  assert.equal(isActiveLane({ enabled: true, target: null }), true);
  assert.equal(isActiveLane({ enabled: true }), true);
});

// ══ 레인별 실행 표식(laneMarker) ══
t("[M1] 표식 = cron:<잡>#<레인 key>", () => assert.equal(laneMarker("classify-knowledge-headless", "default"), "cron:classify-knowledge-headless#default"));
t("[M2] 같은 잡의 두 레인은 표식이 다르다 — 같으면 뒤 레인이 «진행 중» 으로 건너뛴다", () => {
  assert.notEqual(laneMarker("j", "notion"), laneMarker("j", "wiki"));
});

// ══ 종류에 안 맞는 필드는 거부 ══
t("[5] 자료 레인에 카테고리 붙이기 전용 필드 → 거부, 그 이름을 댄다", () => {
  assert.throws(() => assertLaneFields({ key: "a", candidate_categories: ["gtm"] }, "source"), /candidate_categories/);
});
t("[6] 카테고리 붙이기 레인에 자료 전용 필드 → 거부, 그 이름을 댄다", () => {
  assert.throws(() => assertLaneFields({ key: "a", include_channels: ["dev"] }, "knowledge"), /include_channels/);
});
t("[7] false 도 값이다 — exclude_bots:false 를 카테고리 붙이기 레인에 보내면 거부", () => {
  assert.throws(() => assertLaneFields({ key: "a", exclude_bots: false }, "knowledge"), /exclude_bots/);
});
t("[8] 0 도 값이다(경계) — prefilter_level:0 을 카테고리 붙이기 레인에 보내면 거부", () => {
  assert.throws(() => assertLaneFields({ key: "a", prefilter_level: 0 }, "knowledge"), /prefilter_level/);
});
t("[9] 안 보냄·비움(undefined·null·''·[]·{})은 통과 — 부분 저장과 «지우기» 는 막지 않는다", () => {
  assert.doesNotThrow(() => assertLaneFields({ key: "a", include_channels: undefined, target_category: null, format_md: "", match_kinds: [], prefilter_rules: {} }, "knowledge"));
  assert.doesNotThrow(() => assertLaneFields({ key: "a", candidate_categories: [], match_types: null, confirm_threshold: undefined, exclude_names: {} , match_provenance: "" }, "source"));
});
t("[10] 공용 필드(기준·주기·실행)는 어느 쪽이든 통과", () => {
  const shared = { key: "a", label: "x", enabled: true, priority: 3, criteria_md: "기준", batch_size: 10, min_chars: 5,
    lookback_days: 30, mode: "headless", harness: "claude", model: "opus", effort: "low", requester: "m1", note: "n" };
  assert.doesNotThrow(() => assertLaneFields(shared, "source"));
  assert.doesNotThrow(() => assertLaneFields(shared, "knowledge"));
});
t("[11] 빈 입력은 통과", () => {
  assert.doesNotThrow(() => assertLaneFields({}, "source"));
  assert.doesNotThrow(() => assertLaneFields({}, "knowledge"));
});

// ══ 재분류 모드 폐지 ══
t("[12] 카테고리 붙이기 레인의 target='unmapped' 는 통과", () => {
  assert.doesNotThrow(() => assertLaneFields({ key: "a", target: "unmapped" }, "knowledge"));
});
t("[13] target='low_confidence'·'both' 는 폐지 이유와 함께 거부", () => {
  for (const target of ["low_confidence", "both"]) {
    assert.throws(() => assertLaneFields({ key: "a", target }, "knowledge"), /폐지/, `${target} 가 통과했다`);
    assert.throws(() => assertLaneFields({ key: "a", target }, "knowledge"), /점검/, `${target} 의 거부 이유에 대안이 없다`);
  }
});
t("[14] 자료 레인엔 target 자체가 없다 — 'unmapped' 여도 거부", () => {
  assert.throws(() => assertLaneFields({ key: "a", target: "unmapped" }, "source"), /target/);
});
t("[15] 전용 필드가 둘이면 둘 다 댄다", () => {
  assert.throws(() => assertLaneFields({ key: "a", include_channels: ["dev"], format_md: "형식" }, "knowledge"),
    (e: Error) => /include_channels/.test(e.message) && /format_md/.test(e.message));
});

t("[17] confidence_below(재분류 문턱)도 폐지된 설정 — 카테고리 붙이기 레인에 값이 오면 거부", () => {
  assert.throws(() => assertLaneFields({ key: "a", confidence_below: 0.5 }, "knowledge"), /폐지/);
  assert.doesNotThrow(() => assertLaneFields({ key: "a", confidence_below: null }, "knowledge"), "비움까지 막으면 옛 값을 지울 수 없다");
});

// ══ 두 목록은 서로 겹치지 않는다 — 겹치면 그 필드는 어느 쪽에서도 저장 못 한다 ══
t("[16] 자료 전용·카테고리 붙이기 전용 필드 목록은 서로소", () => {
  assert.deepEqual(SOURCE_ONLY_FIELDS.filter((f) => KNOWLEDGE_ONLY_FIELDS.includes(f)), []);
});

console.log(`\n${pass} passed`);
