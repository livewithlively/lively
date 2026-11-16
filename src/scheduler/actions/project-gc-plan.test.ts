// 자동 생성 프로젝트 정리(project_gc) 판정 — 순수 함수 표 검증. DB 무의존.
//  실행: npm run build && node dist/scheduler/actions/project-gc-plan.test.js
import { strict as assert } from "node:assert";
import { GC_DEFAULTS, childBudgetAllows, gcCloseReason, localDateOf, parseGcOptions, planProjectGc, type GcOptions, type GcRow } from "./project-gc-plan.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const NOW = new Date("2026-11-11T00:00:00Z");
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);
let seq = 0;
const row = (o: Partial<GcRow> & { days: number }): GcRow => ({
  id: o.id ?? ++seq, nameSource: o.nameSource === undefined ? "rule" : o.nameSource, hasRecord: o.hasRecord ?? false,
  lastTouch: daysAgo(o.days), protected: o.protected ?? false, openChildren: o.openChildren ?? 0,
});
const on: GcOptions = { ...GC_DEFAULTS, mode: "on" };
const ids = (xs: Array<{ id: number }>) => xs.map((x) => x.id);

t("모드 — on 만 쓰기를 켠다. 빈 값·모르는 값·대소문자 다른 값은 report", () => {
  assert.equal(parseGcOptions({}).mode, "report");
  assert.equal(parseGcOptions({ mode: "yes" }).mode, "report");
  assert.equal(parseGcOptions({ mode: "ON" }).mode, "report");
  assert.equal(parseGcOptions({ mode: " on" }).mode, "on");
});

t("파라미터 — 비거나 숫자가 아니면 기본값, 범위 밖은 잘린다", () => {
  const o = parseGcOptions({ empty_days: "", idle_days: "abc", batch_close: "-3", cap: "7.9" });
  assert.equal(o.emptyDays, 14);
  assert.equal(o.idleDays, 30);
  assert.equal(o.batchClose, 0);
  assert.equal(o.cap, 7);
  assert.equal(parseGcOptions({ empty_days: 0 }).emptyDays, 1, "0일 기준은 방금 만든 것까지 치운다 — 최소 1일");
});

t("report — 고른 것은 요약에 남지만 쓰기 목록은 비어 있다", () => {
  const rows = [row({ days: 20 }), row({ days: 40, hasRecord: true })];
  const p = planProjectGc(rows, { ...GC_DEFAULTS }, NOW);
  assert.deepEqual(p.writes, { trash: [], close: [] });
  assert.equal(p.empty.trash, 1);
  assert.equal(p.idle.close, 1);
});

t("기록 없음 — 기계 이름(rule·NULL)은 닫고 휴지통, 다듬은 이름(session·agent)은 닫기만", () => {
  const rule = row({ days: 20, nameSource: "rule" });
  const nul = row({ days: 20, nameSource: null });
  const ses = row({ days: 20, nameSource: "session" });
  const agt = row({ days: 20, nameSource: "agent" });
  const p = planProjectGc([rule, nul, ses, agt], on, NOW);
  assert.deepEqual(ids(p.writes.trash).sort(), [rule.id, nul.id].sort());
  assert.deepEqual(ids(p.writes.close).sort(), [ses.id, agt.id].sort());
});

t("기록 유무 — 기록 있으면 휴지통에 넣지 않고 idle_days 를 넘어야 닫는다. 기준일 정확히는 «넘음» 이 아니다", () => {
  const recYoung = row({ days: 20, hasRecord: true });
  const recOld = row({ days: 31, hasRecord: true });
  const recEdge = row({ days: 30, hasRecord: true });
  const emptyEdge = row({ days: 14 });
  const p = planProjectGc([recYoung, recOld, recEdge, emptyEdge], on, NOW);
  assert.deepEqual(ids(p.writes.trash), []);
  assert.deepEqual(ids(p.writes.close), [recOld.id]);
  assert.equal(p.empty.candidates, 0);
  assert.equal(p.idle.candidates, 1);
});

t("제외 — 사람 이름(human)·보호(기한 남은·담당자 있는 열린 하위)는 어떤 단계에도 들지 않는다", () => {
  const human = row({ days: 400, nameSource: "human" });
  const prot = row({ days: 400, protected: true });
  const protRec = row({ days: 400, protected: true, hasRecord: true });
  const p = planProjectGc([human, prot, protRec], on, NOW);
  assert.equal(p.empty.candidates + p.idle.candidates, 0);
  assert.equal(p.protectedExcluded, 2);
  assert.deepEqual(p.writes, { trash: [], close: [] });
});

t("상한 — 오래된 손길부터 batch 만큼, 나머지는 deferred", () => {
  const rows = [row({ days: 15 }), row({ days: 50 }), row({ days: 30 })];
  const p = planProjectGc(rows, { ...on, batchTrash: 2 }, NOW);
  assert.deepEqual(ids(p.writes.trash), [rows[1].id, rows[2].id]);
  assert.equal(p.empty.deferred, 1);
  assert.deepEqual(p.empty.sampleIds, [rows[1].id, rows[2].id, rows[0].id]);
});

t("상한 — 닫기 상한은 두 단계가 함께 쓴다(empty 가 먼저)", () => {
  const a = row({ days: 20, nameSource: "agent" });
  const b1 = row({ days: 60, hasRecord: true });
  const b2 = row({ days: 50, hasRecord: true });
  const p = planProjectGc([a, b1, b2], { ...on, batchClose: 2 }, NOW);
  assert.deepEqual(ids(p.writes.close), [a.id, b1.id]);
  assert.equal(p.idle.deferred, 1);
});

t("하위 상한 — 예산을 쓴 뒤 하위를 다 닫을 수 없는 프로젝트는 미루고, 하위 없는 것은 계속 받는다", () => {
  const small = row({ days: 60, openChildren: 2 });
  const big = row({ days: 30, openChildren: 5 });
  const none = row({ days: 20, openChildren: 0 });
  const p = planProjectGc([small, big, none], { ...on, batchChildren: 3 }, NOW);
  assert.deepEqual(ids(p.writes.trash), [small.id, none.id]);
  assert.equal(p.empty.deferred, 1);
});

t("하위 상한 — 회차 예산을 아직 안 썼으면 상한보다 하위가 많은 프로젝트도 하나는 받는다(영원히 미뤄지지 않게)", () => {
  const big = row({ days: 60, openChildren: 5 });
  const small = row({ days: 30, openChildren: 1 });
  const p = planProjectGc([big, small], { ...on, batchChildren: 3 }, NOW);
  assert.deepEqual(ids(p.writes.trash), [big.id]);
  assert.equal(p.empty.deferred, 1);
  assert.equal(childBudgetAllows(0, 500, 3), true);
  assert.equal(childBudgetAllows(1, 3, 3), false);
  assert.equal(childBudgetAllows(3, 0, 3), true);
});

t("cap — 단계 후보가 cap 을 넘으면 그 단계만 멈춘다(halted), 다른 단계는 진행", () => {
  const empties = [row({ days: 20 }), row({ days: 21 }), row({ days: 22 })];
  const idle = row({ days: 40, hasRecord: true });
  const p = planProjectGc([...empties, idle], { ...on, cap: 2 }, NOW);
  assert.equal(p.empty.halted, true);
  assert.equal(p.empty.candidates, 3);
  assert.deepEqual(ids(p.writes.trash), []);
  assert.equal(p.idle.halted, false);
  assert.deepEqual(ids(p.writes.close), [idle.id]);
  const exact = planProjectGc(empties, { ...on, cap: 3 }, NOW);
  assert.equal(exact.empty.halted, false, "cap 과 같으면 넘은 것이 아니다");
});

t("사유 — 손길 없는 일수(내림)를 담는다", () => {
  const p = planProjectGc([row({ days: 20.7 })], on, NOW);
  assert.equal(p.writes.trash[0].idleDays, 20);
  assert.ok(gcCloseReason(20).startsWith("20일"));
});

t("조직 시간대의 오늘 — 같은 순간도 시간대에 따라 날짜가 다르다, 모르는 시간대는 UTC", () => {
  const at = new Date("2026-11-10T16:30:00Z");   // 서울 11-11 01:30
  assert.equal(localDateOf(at, "Asia/Seoul"), "2026-11-11");
  assert.equal(localDateOf(at, "UTC"), "2026-11-10");
  assert.equal(localDateOf(at, "Not/AZone"), "2026-11-10");
});

console.log(`\n${pass} passed`);
