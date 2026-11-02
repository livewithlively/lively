// 증류 잡 보장(#2415) — 사양 엣지 표(scratchpad/spec-distill-job.md) 행마다 한 검사.
//  단언은 문구가 아니라 **판정 결과와 대상 잡**으로 한다(reason 문구는 다듬어도 테스트가 안 깨지게).
import test from "node:test";
import assert from "node:assert/strict";
import { planDistillJob, laneJobPlan, ALL_LANES_JOB_ID, type DistillJobRow } from "./ensure-job.js";

const SEEDED = "distill-local-files";
const job = (id: string, enabled: boolean, distiller?: string | null): DistillJobRow =>
  ({ id, enabled, params: distiller === undefined ? {} : { distiller } });

test("① 잡이 하나도 없으면 전체 접수 잡을 만든다", () => {
  const p = planDistillJob([], "lane-a");
  assert.equal(p.action, "create");
  assert.equal((p as { jobId: string }).jobId, ALL_LANES_JOB_ID);
});

test("② 심은 잡이 이미 전체 접수(묶임 없음)면 아무것도 안 한다", () => {
  assert.equal(planDistillJob([job(SEEDED, true)], "lane-a").action, "none");
});

test("③ 심은 잡이 다른 증류기 하나에 묶여 있으면 그 잡을 넓힌다", () => {
  const p = planDistillJob([job(SEEDED, true, "local-files")], "lane-a");
  assert.equal(p.action, "widen");
  assert.equal((p as { jobId: string }).jobId, SEEDED);
});

test("④ 켜는 증류기가 바로 그 묶임 대상이면 아무것도 안 한다", () => {
  assert.equal(planDistillJob([job(SEEDED, true, "local-files")], "local-files").action, "none");
});

test("⑤ 심은 잡이 꺼져 있으면 되살리지 않는다(마스터킬 보존)", () => {
  const p = planDistillJob([job(SEEDED, false, "local-files")], "lane-a");
  assert.equal(p.action, "none");
});

test("⑥ 운영자 잡만 있고 그것이 다른 증류기에 묶였으면 남의 잡을 안 건드리고 새로 만든다", () => {
  const p = planDistillJob([job("my-job", true, "x")], "lane-a");
  assert.equal(p.action, "create");
  assert.equal((p as { jobId: string }).jobId, ALL_LANES_JOB_ID);
});

test("⑦ 운영자 잡이 전체 접수면 아무것도 안 한다", () => {
  assert.equal(planDistillJob([job("my-job", true)], "lane-a").action, "none");
});

test("⑧ 심은 잡이 묶여 있어도 다른 잡이 전체 접수면 넓히지 않는다", () => {
  const p = planDistillJob([job(SEEDED, true, "local-files"), job("my-job", true)], "lane-a");
  assert.equal(p.action, "none");
});

test("⑨ distiller 가 공백뿐이면 '비어 있음'으로 본다 — 전체 접수", () => {
  assert.equal(planDistillJob([job(SEEDED, true, "   ")], "lane-a").action, "none");
});

test("⑩ 증류기 key 가 비면 판정하지 않는다", () => {
  assert.equal(planDistillJob([], "").action, "none");
});

// ── 배선 단언 — 표가 실제로 서로 다른 결과를 내는지(관측 장치가 죽어 있지 않은지) ──
test("⑪ 표의 세 갈래가 모두 실제로 나온다(vacuous 방지)", () => {
  const got = new Set([
    planDistillJob([], "lane-a").action,
    planDistillJob([job(SEEDED, true, "local-files")], "lane-a").action,
    planDistillJob([job(SEEDED, true)], "lane-a").action,
  ]);
  assert.deepEqual([...got].sort(), ["create", "none", "widen"]);
});

test("⑫ params 가 null 이어도 터지지 않고 '전체 접수'로 본다", () => {
  const row: DistillJobRow = { id: SEEDED, enabled: true, params: null };
  assert.equal(planDistillJob([row], "lane-a").action, "none");
});

// ── 사람이 정한 잡을 레인 저장이 건드리지 않는다 · 돌릴 잡이 없으면 말한다 (#5235) — 사양 표 J ──────
//  잡 행이 실제로 어떻게 되는지는 lane-jobs.pg-test.mjs 가 잰다(create 는 곧 쓰기라 여기서 «create 가 아니다» 를 보면 된다).
const PIN = "my-pin";
const noneUncovered = (jobs: DistillJobRow[], jobId?: string) => {
  const p = planDistillJob(jobs, "lane-a");
  assert.equal(p.action, "none", "만들거나 넓혔다");
  assert.equal(p.action === "none" && p.uncovered, true, "돌릴 잡이 없다고 말하지 않는다");
  assert.equal(p.action === "none" ? p.jobId : undefined, jobId);
};

test("J2 맡는 잡이 있으면 그 잡을 말하고 uncovered 가 아니다", () => {
  const p = planDistillJob([job("my-all", true)], "lane-a");
  assert.equal(p.action === "none" && p.jobId, "my-all");
  assert.notEqual(p.action === "none" && p.uncovered, true);
});
test("J3 ★ 전체 잡이 꺼져 있으면 다른 전용 잡이 켜져 있어도 되살리지 않는다 — 전부 꺼짐 분기를 못 타는 자리", () => {
  noneUncovered([job(ALL_LANES_JOB_ID, false), job(PIN, true, "lane-x")], ALL_LANES_JOB_ID);
});
test("J5 증류 잡이 전부 꺼져 있으면 돌릴 잡이 없다고 말한다", () => {
  noneUncovered([job(PIN, false, "lane-x")]);
  noneUncovered([job(ALL_LANES_JOB_ID, false)], ALL_LANES_JOB_ID);
});
test("J6 ★ 다른 레인에 묶인 전체 잡을 덮지 않는다 — 켜져 있어도 이 레인을 안 맡는다", () => {
  noneUncovered([job(ALL_LANES_JOB_ID, true, "lane-x"), job(PIN, true, "lane-y")], ALL_LANES_JOB_ID);
});
test("J6b 전체 잡이 이 레인에 묶여 있으면 그 잡이 맡는다", () => {
  const p = planDistillJob([job(ALL_LANES_JOB_ID, true, "lane-a")], "lane-a");
  assert.equal(p.action, "none");
  assert.notEqual(p.action === "none" && p.uncovered, true);
});
test("J7 심은 잡을 넓히는 쪽이 먼저다 — 전체 잡이 꺼져 있어도 심은 잡이 있으면 레인이 돈다", () => {
  assert.equal(planDistillJob([job(SEEDED, true, "local-files"), job(ALL_LANES_JOB_ID, false)], "lane-a").action, "widen");
});
test("J9 전체 잡이 없고 전용 잡만 켜져 있으면 만든다(종전 · #2415)", () => {
  assert.equal(planDistillJob([job(PIN, true, "lane-x")], "lane-a").action, "create");
});
test("J12 저장 응답의 모양 — 만들면 주기를 싣고, 그 밖엔 안 싣는다", () => {
  assert.deepEqual(laneJobPlan({ action: "create", jobId: ALL_LANES_JOB_ID, reason: "r" }),
    { action: "create", job_id: ALL_LANES_JOB_ID, uncovered: false, reason: "r", interval_sec: 600 });
  assert.deepEqual(laneJobPlan({ action: "none", jobId: "x", uncovered: true, reason: "r" }),
    { action: "none", job_id: "x", uncovered: true, reason: "r" });
  assert.deepEqual(laneJobPlan({ action: "none", reason: "r" }),
    { action: "none", job_id: null, uncovered: false, reason: "r" });
  assert.deepEqual(laneJobPlan({ action: "widen", jobId: SEEDED, reason: "r" }),
    { action: "widen", job_id: SEEDED, uncovered: false, reason: "r" });
});
