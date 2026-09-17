// 증류 잡이 둘 켜진 워크스페이스에서 같은 자료가 두 번 나가지 않게 (#4052 끝단 확인 후속) — 사양 엣지 표 S1·S2.
//
//  실측 2026-09-17(CP 운영 조회): 배포 뒤 새 테넌트 3곳 모두 distill-lanes(10분)·distill-sources-headless(30분)가 함께
//  켜졌다(CP 가 기본 증류기를 크론보다 먼저 저장 → #2415 가 전체 접수 잡을 따로 만든다). 처음 설정이 심는 local-files 전용
//  잡도 전체 잡과 같은 레인을 집는다. 잡마다 중첩 방지 표식이 달라(cron:<job>#<key>) 같은 틱이면 둘 다 인박스를 읽는다.
//  단언은 문구가 아니라 판정 결과(집합·action)와 배선으로 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dedicatedDistillerKeys, planDistillJob, type DistillJobRow } from "./ensure-job.js";

const job = (id: string, enabled: boolean, params: Record<string, unknown> | null): DistillJobRow => ({ id, enabled, params });
const keys = (jobs: DistillJobRow[]): string[] => [...dedicatedDistillerKeys(jobs)].sort();
const read = (rel: string): string => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const code = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// ── S2 전용 잡이 맡은 증류기 ──────────────────────────────────────────────────
test("D1 잡이 없으면 빈 집합", () => {
  assert.deepEqual(keys([]), []);
});
test("D2 ★ 켜진 전용 잡 → 그 증류기(처음 설정이 심는 local-files 전용 잡)", () => {
  assert.deepEqual(keys([job("distill-local-files", true, { distiller: "local-files" })]), ["local-files"]);
});
test("D3 ★ 꺼진 전용 잡은 아무것도 맡지 않는다 — 그 레인은 전체 잡이 집는다(증류가 멈추지 않는다)", () => {
  assert.deepEqual(keys([job("distill-local-files", false, { distiller: "local-files" })]), []);
});
test("D4 무지정(전체) 잡은 전용이 아니다", () => {
  assert.deepEqual(keys([job("distill-sources-headless", true, {}), job("distill-lanes", true, {})]), []);
});
test("D5 params 가 null 이어도 무지정", () => {
  assert.deepEqual(keys([job("x", true, null)]), []);
});
test("D6 공백뿐인 묶음은 지정 없음", () => {
  assert.deepEqual(keys([job("x", true, { distiller: "   " })]), []);
});
test("D7 문자열이 아닌 묶음은 지정 없음", () => {
  assert.deepEqual(keys([job("x", true, { distiller: 42 }), job("y", true, { distiller: ["a"] })]), []);
});
test("D8 묶음은 trim 해서 쓴다", () => {
  assert.deepEqual(keys([job("x", true, { distiller: " a " })]), ["a"]);
});
test("D9 전용 둘(key·id) + 무지정 하나 → 두 대상", () => {
  assert.deepEqual(keys([
    job("p1", true, { distiller: "local-files" }), job("p2", true, { distiller: "7" }), job("all", true, {}),
  ]), ["7", "local-files"]);
});

// ── S1 CP 가 증류 크론을 기본 증류기보다 먼저 심는 이유 — 코어 판정이 그 순서를 전제한다 ─────
test("C1 ★ 켜진 무지정 distill-sources-headless 가 있으면 default 를 켜도 잡을 더 만들지 않는다(잡 1개)", () => {
  assert.equal(planDistillJob([job("distill-sources-headless", true, {})], "default").action, "none");
});
test("C2 distill-sources-headless 가 꺼진 채(옛 재시도)면 default 를 켜도 새로 만들지 않는다 — 사람이 끈 것을 되살리지 않는다", () => {
  assert.equal(planDistillJob([job("distill-sources-headless", false, {})], "default").action, "none");
});
test("C3 대조 — 잡이 하나도 없을 때 default 를 켜면 전체 접수 잡이 새로 생긴다(순서가 뒤바뀌면 둘이 되는 이유)", () => {
  assert.equal(planDistillJob([], "default").action, "create");
});

// ── S2 배선 — 전체 잡 경로가 전용 레인을 빼되, 폴백·방치 판정은 켜진 증류기 전부로 ─────────────
const pick = (() => {
  const s = code(read("src/scheduler/actions/distill.ts"));
  const i = s.indexOf("async function pickDistillerBatch(");
  return s.slice(i, s.indexOf("\n}\n", i));
})();

test("W1 ★ 전체 잡 경로는 전용 잡이 켜진 증류기를 배치에서 뺀다(key·id 둘 다로 대조)", () => {
  assert.match(pick, /const dedicated = await dedicatedDistillersSafe\(\);/);
  assert.match(pick, /const serve = enabled\.filter\(\(d\) => !dedicated\.has\(String\(d\.key\)\) && !dedicated\.has\(String\(d\.id\)\)\);/);
  assert.match(pick, /for \(const d of serve\) \{/, "배치는 serve 로 만든다");
  assert.ok(!/for \(const d of enabled\) \{/.test(pick), "켜진 증류기 전부로 배치를 만들던 옛 루프가 남지 않는다");
});
test("W2 ★ 폴백 판정은 켜진 증류기 전부로 — 켜진 레인이 모두 전용이어도 전역 폴백으로 떨어지지 않는다", () => {
  const fallback = pick.indexOf("if (!enabled.length) {");
  assert.ok(fallback > 0, "폴백 판정이 enabled(전부) 기준");
  assert.ok(fallback < pick.indexOf("const serve ="), "폴백 판정이 제외보다 먼저");
});
test("W3 ★ 방치 계산은 켜진 증류기 전부로 — 전용 레인 자료를 «방치» 로 세지 않는다", () => {
  assert.match(pick, /listStrandedSources\(enabled, 50, null\)/);
});
test("W4 지정 경로(params.distiller — 전용 잡 자신)는 제외 판정 전에 끝난다", () => {
  assert.ok(pick.indexOf("if (ref) {") < pick.indexOf("dedicatedDistillersSafe()"));
});
test("W5 잡 목록을 못 읽으면 아무것도 빼지 않는다(종전 동작)", () => {
  const s = code(read("src/scheduler/actions/distill.ts"));
  const i = s.indexOf("async function dedicatedDistillersSafe(");
  const body = s.slice(i, s.indexOf("\n}\n", i));
  assert.ok(i > 0, "도우미가 있다");
  assert.match(body, /return dedicatedDistillerKeys\(await readDistillJobs\(\)\);/);
  assert.match(body, /catch \{ return new Set\(\); \}/);
});
test("W6 전용 잡 판정과 잡 정비가 같은 목록 조회를 쓴다(같은 action 범위)", () => {
  const e = code(read("src/org/distill/ensure-job.ts"));
  assert.match(e, /SELECT id, enabled, params FROM org_cron WHERE action='distill_sources_headless'/);
  assert.match(e, /jobs = await readDistillJobs\(\);/, "ensureDistillJob 도 같은 조회");
});
