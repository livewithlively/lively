// #1419 T3 — 수집기 산출 정책이 라우팅을 어디까지 덮는지 회귀 잠금. 순수 함수(DB·네트워크 무의존).
//  실행: npm run build && node dist/org/ingest/ingest-route-policy.test.js
//
//  이 테스트가 지키는 것 하나: **구조 엔티티는 정책이 덮지 못한다.** PM 계층(폴더·리스트·뷰·댓글·타임)과
//  clickup task 는 '수집된 읽을거리'가 아니라 그 소스의 뼈대다. 정책 하나로 폴더가 지식이 되면 위계가
//  깨지고 프로젝트 미러가 통째로 무너진다 — 그런데 그 붕괴는 다음 싱크에나 드러난다(조용한 파괴).
//
//  시나리오는 사양 엣지 표(R1~R22)를 행마다 옮긴 것이다. 이름 끝 [Rn] 이 그 대응.
import assert from "node:assert/strict";
import { routeIngestV6, alsoMirrorKnowledge } from "./ingest-classify.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ══ P1 기본값 = 종전 동작(무중단) ══
t("preset — 슬랙 메시지는 자료 [R1]", () => {
  assert.equal(routeIngestV6("message", "slack", "preset"), "source");
});
t("preset — 노션 문서는 지식 [R2]", () => {
  assert.equal(routeIngestV6("doc", "notion", "preset"), "knowledge");
});
t("preset — 클릭업 태스크는 프로젝트 [R3]", () => {
  assert.equal(routeIngestV6("task", "clickup", "preset"), "project");
});
t("정책 인자를 생략하면 preset 과 같다 [R22·경계]", () => {
  // 레거시 호출부(수집기 바인딩 없는 경로)가 그대로 도는지 — 무중단의 실체.
  assert.equal(routeIngestV6("message", "slack"), routeIngestV6("message", "slack", "preset"));
  assert.equal(routeIngestV6("doc", "notion"), routeIngestV6("doc", "notion", "preset"));
  assert.equal(routeIngestV6("task", "clickup"), routeIngestV6("task", "clickup", "preset"));
});

// ══ P2 읽을거리는 정책이 목적지를 바꾼다 ══
t("knowledge — 슬랙 메시지를 지식 직행으로 [R4]", () => {
  assert.equal(routeIngestV6("message", "slack", "knowledge"), "knowledge");
});
t("source — 노션 문서를 자료로 되돌려 증류를 태운다 [R5]", () => {
  assert.equal(routeIngestV6("doc", "notion", "source"), "source");
});
t("both — 라우팅은 자료로 답한다(지식은 미러가 한 번 더) [R6]", () => {
  assert.equal(routeIngestV6("message", "slack", "both"), "source");
});
t("gdrive 문서 특례도 정책으로 바꿀 수 있다 [R14·R15]", () => {
  assert.equal(routeIngestV6("doc", "gdrive", "preset"), "source");      // 특례 기본
  assert.equal(routeIngestV6("doc", "gdrive", "knowledge"), "knowledge"); // 정책이 이긴다
});

// ══ P3 구조 엔티티 불가침 — 이 파일의 존재 이유 ══
t("clickup task 는 정책과 무관하게 project [R7]", () => {
  for (const mode of ["knowledge", "source", "both"] as const) {
    assert.equal(routeIngestV6("task", "clickup", mode), "project", `${mode} 에서 뒤집혔다`);
  }
});
t("PM 계층은 정책과 무관하게 자기 자리로 [R8·R9·R10·R11·R12]", () => {
  const structural: Array<[string, string]> = [
    ["space", "pm_folder"], ["folder", "pm_folder"], ["list", "pm_list"],
    ["view", "pm_view"], ["comment", "pm_comment"], ["time", "pm_time"],
  ];
  for (const [type, expected] of structural) {
    for (const mode of ["knowledge", "source", "both"] as const) {
      assert.equal(routeIngestV6(type, "clickup", mode), expected, `${type}/${mode} 에서 뒤집혔다`);
    }
  }
});

// ══ P4 미정의는 정책이 있어도 미정의 ══
t("라우팅 정의 밖은 정책으로도 되살아나지 않는다 [R13]", () => {
  // 정책은 '어디로 보낼까'이지 '없던 것을 만들어라'가 아니다 — 보수적 skip 의 의미를 지킨다.
  for (const mode of ["preset", "knowledge", "source", "both"] as const) {
    assert.equal(routeIngestV6("unknown-type", "some-system", mode), null, `${mode} 에서 되살아났다`);
  }
});

// ══ P5·P6 'both' 의 지식 동반 적재 ══
t("both 일 때만 지식도 함께 적재한다 [R16·R17·R18]", () => {
  assert.equal(alsoMirrorKnowledge("message", "slack", "both"), true);
  assert.equal(alsoMirrorKnowledge("message", "slack", "preset"), false);
  assert.equal(alsoMirrorKnowledge("message", "slack", "source"), false);
  assert.equal(alsoMirrorKnowledge("message", "slack", "knowledge"), false);
  assert.equal(alsoMirrorKnowledge("message", "slack"), false); // 인자 생략 = preset
});
t("both 여도 구조 엔티티는 지식으로 복제하지 않는다 [R19·R20]", () => {
  assert.equal(alsoMirrorKnowledge("task", "clickup", "both"), false);
  for (const type of ["space", "folder", "list", "view", "comment", "time"]) {
    assert.equal(alsoMirrorKnowledge(type, "clickup", "both"), false, `${type} 이 복제됐다`);
  }
});
t("미정의 타입은 both 여도 지식을 만들지 않는다 [R21]", () => {
  assert.equal(alsoMirrorKnowledge("unknown-type", "some-system", "both"), false);
});

console.log(`\n${pass} passed`);
