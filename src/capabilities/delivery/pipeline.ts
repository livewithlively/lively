// delivery ▸ pipeline — 맥락 파이프라인 현황을 REST/MCP 로 노출하는 **얇은 표면**.
//
//  요구: "가시적으로 데이터 수집 - 증류 - 분류 - 관리의 파이프라인을 보고 그걸 관리할수있게."
//  화면이 4단계 현황을 그리려면 지금은 6~7군데를 따로 물어야 한다. 그러면 로딩이 계단식으로 들어오고
//  (숫자가 하나씩 튀어 오르고), 무엇보다 **단계 간 비교**가 불가능하다 — 파이프라인의 요점은
//  "어디가 막혔나"인데 그건 단계들을 **같은 시점에** 나란히 놓아야 보인다. 그래서 한 번에 준다.
//
//  계산 자체는 org/store/pipeline.ts 에 있다(온보딩도 같은 계산을 읽어야 하는데 스토어는 이 표면을
//  상향 import 할 수 없다 — 그 파일 헤더 참조). 여기는 노출만 한다.
//
//  scope: restWork(memory) — 읽기 현황이고 증류기·관리기 설정과 같은 워킹레벨이다.
import type { Capability } from "../types.js";
import { computePipelineOverview } from "../../org/store/pipeline.js";
import { restWork } from "./shared.js";

export const pipelineCapabilities: Capability[] = [
  restWork("org_pipeline_overview", "맥락 파이프라인 현황",
    "수집 → 증류 → 관리 세 단계의 처리량·잔량·막힘과 카테고리 기준표를 한 번에 반환한다. 맥락 관리 탭이 읽는다. " +
    "각 단계는 { 설정된 것 수 · 켜진 것 수 · 산출물 수 · 잔량(아직 다음 단계로 못 간 것) · 자동 실행 잡 }. " +
    "증류는 지식을 완성시킨다 — stages.distill 은 자료 → 지식(자료 레인), stages.distill.knowledge 는 카테고리 붙이기 " +
    "(카테고리가 없는 미분류 지식에 카테고리를 붙이는 레인 — 옛 이름 «분류기»). taxonomy = 카테고리 칸 수·정의 빈 칸 수(기준표 — 단계 아님). " +
    "stages.classify 는 옛 모양 별칭이라 다음 릴리스에서 사라진다 — 새 호출은 distill.knowledge·taxonomy 를 읽는다.",
    [{ method: "GET", paths: ["/api/ui/org/pipeline"], parse: () => ({}) }],
    async () => computePipelineOverview()),
];
