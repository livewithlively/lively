// 시각형 잡 고정 지연 — 사양 표 S(오프셋 함수)·W(최소 간격)·E(설정값).
//  틀렸을 때: 오프셋이 재기동마다 바뀌면 잡 시각이 매번 흔들리고, 상한이 없으면 짧은 주기 잡이 회차를 건너뛴다.
//  판정과 엮인 «건너뛰지도 두 번 돌지도 않는다» 는 cron-due.test.ts 표 G 가 지킨다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  cronStaggerOffsetMs, cronMinGapSec, cronStaggerSec, CRON_STAGGER_DEFAULT_SEC, CRON_STAGGER_SUGGESTED_SEC, COARSEST_TICK_SEC, TICK_JITTER_SEC,
} from "./cron-stagger.js";

const HOURLY = "0 * * * *";
const ids = Array.from({ length: 400 }, (_, i) => `job-${i}`);

test("S1 결정적이다 — 같은 id 는 몇 번을 물어도, 식이 바뀌어도 같은 지연", () => {
  for (const id of ["distill-inbox", "sync-notion-full", "a", ""]) {
    const first = cronStaggerOffsetMs(id, HOURLY, 90);
    for (let i = 0; i < 3; i++) assert.equal(cronStaggerOffsetMs(id, HOURLY, 90), first, id);
    //  상한에 안 걸리는 식끼리는 지연이 같다 — 지연은 id 로만 정한다(시각을 고쳐도 위상이 옮겨 가지 않는다).
    assert.equal(cronStaggerOffsetMs(id, "30 4 * * *", 90), first, id);
  }
});

test("S2 범위 — [0, spread) 초, 초 단위", () => {
  for (const spread of [1, 7, 60, 90]) {
    for (const id of ids) {
      const off = cronStaggerOffsetMs(id, HOURLY, spread);
      assert.ok(off >= 0 && off < spread * 1000, `${id} spread=${spread} off=${off}`);
      assert.equal(off % 1000, 0, "초 단위가 아니다");
    }
  }
});

test("S3 spread 가 0 이하면 지연 없음(끄기)", () => {
  for (const spread of [0, -1, Number.NaN]) {
    for (const id of ids.slice(0, 20)) assert.equal(cronStaggerOffsetMs(id, HOURLY, spread), 0, `spread=${spread}`);
  }
});

test("S4 서로 다른 id 가 흩어진다 — 정각 무리가 한 틱 창에 남지 않는다", () => {
  const offs = ids.map((id) => cronStaggerOffsetMs(id, HOURLY, 90) / 1000);
  assert.ok(new Set(offs).size >= 80, `400개가 90칸 중 ${new Set(offs).size}칸에만 몰렸다`);
  //  30초 틱 창 셋에 고르게 — 한 창이 절반을 넘으면 흩은 의미가 없다.
  for (let w = 0; w < 3; w++) {
    const n = offs.filter((o) => o >= w * 30 && o < (w + 1) * 30).length;
    assert.ok(n > 400 * 0.2 && n < 400 * 0.5, `창 ${w}: ${n}/400`);
  }
});

test("S4b ★ 끝자리만 다른 id 도 흩어진다 — 번호를 붙인 이름 16개가 한 틱 창에 몰리지 않는다", () => {
  //  틀렸을 때: 정각에 몰린 잡이 `sync-0` … `sync-15` 꼴이면 흩어도 전부 같은 30초 창에 남는다(해시에 마무리 섞기가 없을 때 실측 0/0/16).
  //  S4 는 400개를 한꺼번에 보므로 이 국소 뭉침을 못 잡는다 — 접두마다 16개씩 따로 본다.
  for (const prefix of ["job-", "sync-", "distill-", "connector-sync-notion-", "cron_"]) {
    const offs = Array.from({ length: 16 }, (_, i) => cronStaggerOffsetMs(`${prefix}${i}`, HOURLY, 90) / 1000);
    const wins = [0, 1, 2].map((w) => offs.filter((o) => o >= w * 30 && o < (w + 1) * 30).length);
    assert.ok(Math.max(...wins) <= 10 && Math.min(...wins) >= 1, `${prefix}0..15 가 창 ${wins.join("/")} 로 몰렸다`);
    //  이웃한 번호가 이웃한 지연을 받지 않는다 — 1초 차로 줄지어 서면 틱 경계에서 함께 넘어간다.
    const adjacent = offs.filter((o, i) => i > 0 && Math.abs(o - offs[i - 1]) <= 1).length;
    assert.ok(adjacent <= 3, `${prefix}0..15 중 ${adjacent}쌍이 1초 안에 붙어 있다`);
  }
});

test("S5 ★ 상한 — 지연은 «최소 간격 − 가장 성긴 틱 간격 − 틱 늦음» 미만, 그 이하 간격이면 흩지 않는다", () => {
  const cases: Array<[string, number]> = [
    ["* * * * *", 0],          // 60초 간격
    ["*/2 * * * *", 0],
    ["*/5 * * * *", 0],        // 간격 = 5분 틱 — 지연을 주면 그 틱에서 회차를 건너뛴다
    ["0,1 * * * *", 0],        // 분 값이 둘이면 그 사이가 간격이다
    ["*/6 * * * *", 0],        // 6분 = 틱 + 틱 늦음 — 틱이 조금만 늦어도 건너뛴다
    ["0,7,14,21,28,35,42,49 * * * *", 420 - COARSEST_TICK_SEC - TICK_JITTER_SEC], // 7분 간격(경계는 11분)
    ["*/10 * * * *", 90],
    ["*/30 * * * *", 90],
    [HOURLY, 90],
    ["0 9 * * 1", 90],
  ];
  for (const [expr, span] of cases) {
    const max = Math.max(...ids.map((id) => cronStaggerOffsetMs(id, expr, 90)));
    if (span === 0) assert.equal(max, 0, `${expr} 를 흩었다`);
    else assert.ok(max < span * 1000 && max >= (span - 5) * 1000, `${expr}: 최대 ${max}ms, 기대 상한 ${span}s`);
  }
});

test("S6 잘못된 식은 지연 0 — 판정은 cronDue 가 따로 «아님» 으로 접는다", () => {
  for (const bad of ["엉망", "* * *", ""]) assert.equal(cronStaggerOffsetMs("x", bad, 90), 0, bad);
});

test("W 최소 간격 하한 — 분 필드만 본다", () => {
  assert.equal(cronMinGapSec([0]), 3600, "분 값 하나 = 한 시간에 한 번");
  assert.equal(cronMinGapSec([0, 30]), 1800);
  assert.equal(cronMinGapSec([10, 50]), 1200, "시간 경계를 넘는 간격(50 → 다음 시 10 = 20분)");
  assert.equal(cronMinGapSec([5, 55]), 600, "경계를 넘는 쪽이 더 짧다");
  assert.equal(cronMinGapSec(Array.from({ length: 60 }, (_, i) => i)), 60);
  assert.equal(cronMinGapSec([30, 0, 15]), 900, "정렬 안 된 입력");
});

test("E 설정값 — 비면 기본(꺼짐), 0 은 끔, 잡값은 기본으로 접는다", () => {
  //  기본은 꺼짐이다 — 설정을 안 건드린 배포의 잡 실행 시각이 업그레이드로 바뀌지 않는다(5분 격자 틱 배포에서는 흩어지지 않고 밀리기만 한다).
  assert.equal(CRON_STAGGER_DEFAULT_SEC, 0);
  assert.equal(CRON_STAGGER_SUGGESTED_SEC, 90);
  assert.equal(cronStaggerSec({}), CRON_STAGGER_DEFAULT_SEC);
  assert.equal(cronStaggerSec({ CRON_STAGGER_SEC: "" }), CRON_STAGGER_DEFAULT_SEC);
  assert.equal(cronStaggerSec({ CRON_STAGGER_SEC: "  " }), CRON_STAGGER_DEFAULT_SEC);
  assert.equal(cronStaggerSec({ CRON_STAGGER_SEC: "0" }), 0, "0 으로 끌 수 없다");
  assert.equal(cronStaggerSec({ CRON_STAGGER_SEC: "45" }), 45);
  assert.equal(cronStaggerSec({ CRON_STAGGER_SEC: "45.9" }), 45);
  //  잘못 쓴 값은 기본값(꺼짐)이다 — 조용히 꺼진 채 두지 않게 startScheduler 가 부팅 때 경고로 드러낸다.
  for (const junk of ["abc", "-5", "NaN", "Infinity"]) {
    assert.equal(cronStaggerSec({ CRON_STAGGER_SEC: junk }), CRON_STAGGER_DEFAULT_SEC, junk);
  }
});
