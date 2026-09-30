// #4194 — stuckStages(온보딩 «셋업 중인가» 판정)가 카테고리 붙이기를 **증류의 레인**으로 본다.
//  종전 넷째 단계 «분류»(stages.classify)가 stages.distill.knowledge 로 옮겨졌다. 판정: 미분류 지식이 **실제로 있는데**
//  그 레인의 자동 실행이 안 돈다 = 그 지식은 소환되지 않는다. (#4194 적대검증 — 종전엔 «지식이 하나라도 있으면» 이었다.
//  채울 게 없는 조직까지 «멈춤» 으로 세어 화면 판정(할 일이 있을 때만 말한다)과 온보딩이 서로 다른 말을 했다.)
//  실행: npm run build && node dist/org/store/pipeline-stuck.test.js
import assert from "node:assert/strict";
import { stuckStages, type PipelineOverview, type PipelineJob } from "./pipeline.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const job = (on: boolean): PipelineJob => ({ id: "j", enabled: on, interval_sec: 1800, last_run_at: null, last_status: null, any_enabled: on });
/** 전 단계가 멀쩡히 도는 조직 — 테스트마다 한 칸만 바꾼다. */
const mk = (over: { knowledgeJob?: PipelineJob | null; output?: number; unmapped?: number } = {}): PipelineOverview => ({
  stages: {
    collect: { configured: 1, enabled: 1, output: 10, recent_24h: 1, job: job(true) },
    distill: {
      configured: 1, draft: 0, total: 1, enabled: 1, output: over.output ?? 5, backlog: 0, job: job(true),
      knowledge: { configured: 0, enabled: 0, backlog: over.unmapped ?? 2, uncovered: 0, pending_review: 0,
        job: over.knowledgeJob === undefined ? job(true) : over.knowledgeJob },
    },
    manage: { configured: 1, enabled: 1, open: {}, by_kind: [], job: job(true) },
  },
  taxonomy: { categories: 3, no_definition: 0 },
  gates: { knowledge_pending: 0, classification_proposed: 0 },
});

t("다 돌면 멈춘 단계가 없다", () => assert.deepEqual(stuckStages(mk()), []));
t("지식이 있는데 카테고리 붙이기 자동 실행이 꺼져 있으면 멈춤", () => {
  assert.deepEqual(stuckStages(mk({ knowledgeJob: job(false) })), ["카테고리 붙이기"]);
});
t("자동 실행 잡이 아예 없어도 멈춤", () => {
  assert.deepEqual(stuckStages(mk({ knowledgeJob: null })), ["카테고리 붙이기"]);
});
t("지식이 0 이면(미분류도 0) 묻지 않는다(필요하다는 증거가 없다)", () => {
  assert.ok(!stuckStages(mk({ knowledgeJob: job(false), output: 0, unmapped: 0 })).includes("카테고리 붙이기"));
});
t("미분류 지식이 0 이면 자동 실행이 꺼져 있어도 묻지 않는다 — 채울 게 없다", () => {
  assert.deepEqual(stuckStages(mk({ knowledgeJob: job(false), unmapped: 0 })), []);
  assert.deepEqual(stuckStages(mk({ knowledgeJob: null, unmapped: 0 })), []);
});
t("미분류 지식이 1 이면 묻는다(경계)", () => {
  assert.deepEqual(stuckStages(mk({ knowledgeJob: job(false), unmapped: 1 })), ["카테고리 붙이기"]);
});
t("옛 이름 «분류» 는 더 이상 나오지 않는다", () => {
  assert.ok(!stuckStages(mk({ knowledgeJob: job(false) })).includes("분류"));
});

console.log(`\n${pass} passed`);
