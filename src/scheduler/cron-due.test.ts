// 시각형 크론 due 판정 — 조건 조합 고정 (#3994 T4)
//
//  실측 계기: `wikilink-sweep`(`30 4 * * *`)의 마지막 실행이 2026-09-06 이었다(10일 미실행).
//   같은 표의 주기형 잡들은 멀쩡히 돌고 있었다 — 그쪽은 «경과 시간»만 보기 때문이다.
//   원인은 표현식도 시간대도 아니라 **틱 격자**였다: 매니지드에서 크론을 굴리는 것은 인프로세스
//   30초 타이머가 아니라 CP 가 HTTP 로 부르는 틱이고(web.ts:115), 실측 격자가 5분이었다
//   (07:13:20 · 07:18:20 · 07:23:20 · 07:28:20). 4시 30분은 그 격자에 영영 안 걸린다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cronDue, runOnceDue } from "./cron-due.js";
import { cronStaggerOffsetMs } from "./cron-stagger.js";
import { parseCron, nextCronTime } from "./cron-expr.js";

const r = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const ENGINE = r("./engine.ts");

const ms = (iso: string): number => Date.parse(iso);
const KST = "Asia/Seoul";

test("표 A — «마지막 실행 이후 첫 매치가 지났는가»로 판정한다", () => {
  const daily430 = "30 4 * * *"; // KST 매일 04:30 = 전날 19:30Z

  //  A1 last 이후 첫 매치가 지났다 — 실측 그대로(wikilink-sweep).
  assert.equal(
    cronDue({ expr: daily430, lastRunAt: "2026-09-06T19:30:06.271Z", now: ms("2026-09-16T08:00:00Z"), tz: KST }),
    true, "A1 10일 밀린 잡을 due 로 안 본다");

  //  A2 아직 안 지났다 — 오늘 04:30(KST)에 이미 돌았고 지금은 같은 날 09:00(KST).
  assert.equal(
    cronDue({ expr: daily430, lastRunAt: "2026-09-15T19:30:00Z", now: ms("2026-09-16T00:00:00Z"), tz: KST }),
    false, "A2 이미 돈 잡을 또 due 로 본다");

  //  A3 한 번도 안 돌았다 → due. 반복 잡의 규칙이다 — 1회성은 아래 runOnceDue(O 표).
  assert.equal(cronDue({ expr: daily430, lastRunAt: null, now: ms("2026-09-16T08:00:00Z"), tz: KST }), true,
    "A3 한 번도 안 돈 잡이 첫 실행을 틱 격자에 기댄다");
  assert.equal(cronDue({ expr: daily430, lastRunAt: "", now: ms("2026-09-16T08:00:00Z"), tz: KST }), true,
    "A3 빈 문자열을 last 있음으로 봤다");

  //  A4 매치가 영영 없는 표현식(2월 30일).
  assert.equal(
    cronDue({ expr: "0 0 30 2 *", lastRunAt: "2026-09-01T00:00:00Z", now: ms("2027-09-01T00:00:00Z"), tz: KST }),
    false, "A4 존재하지 않는 날짜를 due 로 봤다");

  //  A5 잘못된 표현식 — 검증은 cron_set 이 한다. 여기선 조용히 아님.
  for (const bad of ["엉망", "* * *", "*/0 * * * *", ""]) {
    assert.equal(cronDue({ expr: bad, lastRunAt: "2026-09-01T00:00:00Z", now: ms("2026-09-16T00:00:00Z"), tz: KST }),
      false, `A5 잘못된 표현식(${bad || "빈 문자열"})을 due 로 봤다`);
  }

  //  A6 ★경계 — 첫 매치 시각이 정확히 지금(초 0). 그 분을 놓치면 하루가 밀린다.
  //   last = 09-15 04:30 KST → 첫 매치 = 09-16 04:30 KST = 09-15T19:30:00Z
  assert.equal(
    cronDue({ expr: daily430, lastRunAt: "2026-09-14T19:30:00Z", now: ms("2026-09-15T19:30:00Z"), tz: KST }),
    true, "A6 매치 시각 정각을 아직 아님으로 봤다");
  //   1ms 전이면 아직 아니다.
  assert.equal(
    cronDue({ expr: daily430, lastRunAt: "2026-09-14T19:30:00Z", now: ms("2026-09-15T19:30:00Z") - 1, tz: KST }),
    false, "A6 매치 1ms 전을 due 로 봤다");

  //  A7 ★★이번 수정의 핵심 — 틱이 매치 분을 지나쳤다(5분 격자: …:28:20 다음이 :33:20).
  //   04:30 매치인데 틱은 04:33:20 에 깨어난다. 종전 판정(«지금이 매치 분인가»)은 여기서 false 였다.
  assert.equal(
    cronDue({ expr: daily430, lastRunAt: "2026-09-14T19:30:00Z", now: ms("2026-09-15T19:33:20Z"), tz: KST }),
    true, "A7 매치 분을 지나친 틱에서 due 가 아니다 — 이 잡은 영영 안 돈다");

  //  A8 last 가 미래(시계 되돌림·잘못된 값) — 보수적으로 아님.
  assert.equal(
    cronDue({ expr: daily430, lastRunAt: "2027-01-01T00:00:00Z", now: ms("2026-09-16T08:00:00Z"), tz: KST }),
    false, "A8 미래 기준을 due 로 봤다");

  //  A9 ★last 가 파싱 불가 — «모름» 을 due 로 접으면 매 틱 폭주가 된다(engine.ts 가 그 사고를 기록해 뒀다).
  for (const junk of ["not-a-date", "2026-13-45T99:99:99Z", "null"]) {
    assert.equal(cronDue({ expr: daily430, lastRunAt: junk, now: ms("2026-09-16T08:00:00Z"), tz: KST }),
      false, `A9 파싱 불가 last(${junk})를 due 로 봤다 — 매 틱 실행 폭주`);
  }

  //  A10 시간대(#778) — 조직 벽시계로 판정한다. 같은 입력이 tz 에 따라 갈려야 한다.
  //   '0 9 * * *' · last = 09-15 09:00 KST(=09-15T00:00Z) · now = 09-15T12:00Z(KST 21:00 / UTC 12:00)
  assert.equal(
    cronDue({ expr: "0 9 * * *", lastRunAt: "2026-09-15T00:00:00Z", now: ms("2026-09-15T12:00:00Z"), tz: KST }),
    false, "A10 KST 로 보면 다음 09:00 은 아직인데 due 로 봤다");
  assert.equal(
    cronDue({ expr: "0 9 * * *", lastRunAt: "2026-09-15T00:00:00Z", now: ms("2026-09-15T12:00:00Z"), tz: "UTC" }),
    true, "A10 UTC 로 보면 09:00 이 지났는데 아님으로 봤다 — tz 가 판정에 안 먹힌다");
});

test("표 B·C — 건드리지 않은 축이 그대로고, 새 판정이 실제로 배선됐다", () => {
  //  C1 시각형 분기가 순수 판정을 쓴다.
  assert.match(ENGINE, /if \(job\.cron_expr\) return cronDue\(\{/,
    "C1 시각형 분기가 새 판정을 안 쓴다 — 매치 분을 지나친 틱에서 잡이 영영 안 돈다");
  //  C2 옛 판정이 남아 있으면 안 된다(두 판정이 공존하면 어느 쪽이 도는지 알 수 없다).
  assert.ok(!/cronMatches\(parseCron\(job\.cron_expr\)/.test(ENGINE), "C2 옛 판정이 남아 있다");
  assert.ok(!/nowMin !== lastMin/.test(ENGINE), "C2 옛 분 비교가 남아 있다");

  //  B1 1회성 분기 — 저장 시각을 기준으로 시각을 지킨다(#5235, 아래 O 표).
  assert.match(ENGINE, /if \(job\.run_once\) return runOnceDue\(\{ expr: job\.cron_expr, lastRunAt: job\.last_run_at, savedAt: job\.updated_at, now, tz \}\)/,
    "B1 1회성 분기가 시각을 안 본다 — 저장한 시각과 상관없이 다음 틱에 돈다");
  assert.ok(ENGINE.indexOf("runOnceDue({") < ENGINE.indexOf("if (job.cron_expr) return cronDue({"),
    "B1 1회성 판정이 시각형 판정보다 뒤에 있다 — 안 돈 1회성이 바로 due 가 된다");
  //  C3 시각형 분기가 잡 id 로 정한 고정 지연을 싣는다(cron-stagger.ts) — 빠지면 정각 잡들이 다시 한 틱에 몰린다.
  assert.match(ENGINE, /if \(job\.cron_expr\) return cronDue\(\{[^\n]*offsetMs: cronStaggerOffsetMs\(job\.id, job\.cron_expr, cronStaggerSec\(\)\)/,
    "C3 시각형 판정에 고정 지연이 안 실렸다");
  //  C4 표시(next_run_at)가 판정과 같은 지연을 더한다 — 다르면 화면이 실제와 다른 시각을 말한다.
  const nextRun = ENGINE.slice(ENGINE.indexOf("function computeNextRun"), ENGINE.indexOf("async function executeAndRecord"));
  assert.match(nextRun, /cronStaggerOffsetMs\(job\.id, job\.cron_expr, cronStaggerSec\(\)\)/, "C4 next_run_at 에 지연이 빠졌다");
  //  B2·B3 주기형 분기 — 종전 그대로(last + interval, 최소 60초 하한).
  assert.match(ENGINE, /return now - last >= Math\.max\(60, Number\(job\.interval_sec\) \|\| 600\) \* 1000/,
    "B2 주기형 판정이 바뀌었다 — 이번 범위가 아니다");
});

// ── 1회성 잡의 시각 (#5235) — 사양 표 O ─────────────────────────────────────────
//  실측 2026-11-02: cron_expr 를 4분 간격으로 준 run_once 잡 30개를 저장했더니 다음 틱에 30개가 전부 queued 였다.
const SAVED = "2026-11-02T08:00:00Z";
const EVENING = "0 18 * * *";

test("O1 시각이 없으면 다음 틱에 돈다(종전)", () => {
  assert.equal(runOnceDue({ now: ms(SAVED) }), true);
  assert.equal(runOnceDue({ expr: null, lastRunAt: null, savedAt: SAVED, now: ms(SAVED) }), true);
  assert.equal(runOnceDue({ expr: "", now: ms(SAVED) }), true, "빈 값도 시각 없음이다");
});
test("O2 ★ 시각이 있으면 저장 뒤 첫 매치 전엔 안 돈다", () => {
  assert.equal(runOnceDue({ expr: EVENING, savedAt: SAVED, now: ms("2026-11-02T08:00:30Z"), tz: "UTC" }), false, "저장 직후 틱");
  assert.equal(runOnceDue({ expr: EVENING, savedAt: SAVED, now: ms("2026-11-02T17:59:59Z"), tz: "UTC" }), false);
});
test("O3 첫 매치가 지나면 돈다 — 틱 격자에 기대지 않는다", () => {
  assert.equal(runOnceDue({ expr: EVENING, savedAt: SAVED, now: ms("2026-11-02T18:03:20Z"), tz: "UTC" }), true);
  assert.equal(runOnceDue({ expr: EVENING, savedAt: SAVED, now: ms("2026-11-05T00:00:00Z"), tz: "UTC" }), true, "오래 밀려도 돈다");
});
test("O4 정각이면 돈다(경계)", () => {
  assert.equal(runOnceDue({ expr: EVENING, savedAt: SAVED, now: ms("2026-11-02T18:00:00Z"), tz: "UTC" }), true);
});
test("O5 이미 돌았으면 시각 유무와 상관없이 안 돈다", () => {
  const lastRunAt = "2026-11-02T07:00:00Z";
  assert.equal(runOnceDue({ lastRunAt, now: ms("2026-12-01T00:00:00Z") }), false);
  assert.equal(runOnceDue({ expr: EVENING, lastRunAt, savedAt: SAVED, now: ms("2026-12-01T00:00:00Z"), tz: "UTC" }), false);
});
test("O6 저장이 오늘 매치 뒤면 다음 매치까지 안 돈다 — 지난 시각을 바로 돌리지 않는다", () => {
  const savedAt = "2026-11-02T19:00:00Z";
  assert.equal(runOnceDue({ expr: EVENING, savedAt, now: ms("2026-11-02T19:00:30Z"), tz: "UTC" }), false);
  assert.equal(runOnceDue({ expr: EVENING, savedAt, now: ms("2026-11-03T18:00:00Z"), tz: "UTC" }), true, "다음 매치에는 돈다");
});
test("O7 잘못된 표현식은 안 돈다", () => {
  assert.equal(runOnceDue({ expr: "이상한 값", savedAt: SAVED, now: ms("2027-01-01T00:00:00Z"), tz: "UTC" }), false);
});
test("O8 ★ 저장 시각을 모르면 시각형은 안 돈다 — «모름» 을 due 로 접지 않는다", () => {
  for (const savedAt of [undefined, null, "", "   ", "시각 아님"]) {
    assert.equal(runOnceDue({ expr: EVENING, savedAt, now: ms("2027-01-01T00:00:00Z"), tz: "UTC" }), false, String(savedAt));
  }
});
test("O9 조직 시간대 벽시계로 읽는다 — 18시 KST 는 09시 UTC", () => {
  const o = { expr: EVENING, savedAt: SAVED, tz: "Asia/Seoul" };
  assert.equal(runOnceDue({ ...o, now: ms("2026-11-02T08:59:59Z") }), false);
  assert.equal(runOnceDue({ ...o, now: ms("2026-11-02T09:00:00Z") }), true);
});
test("O9b 드라이버가 준 Date 도 같다 — pg 는 TIMESTAMPTZ 를 Date 로 준다", () => {
  const savedAt = new Date(SAVED) as unknown as string;
  assert.equal(runOnceDue({ expr: EVENING, savedAt, now: ms("2026-11-02T08:30:00Z"), tz: "UTC" }), false);
  assert.equal(runOnceDue({ expr: EVENING, savedAt, now: ms("2026-11-02T18:00:00Z"), tz: "UTC" }), true);
});
test("O2b ★ 프로젝트 재현 — 4분 간격 30개를 저장해도 지난 시각의 잡만 돈다", () => {
  const start = ms("2026-11-02T18:02:00Z");
  const jobs = Array.from({ length: 30 }, (_, i) => {
    const at = new Date(start + (i + 1) * 4 * 60_000);
    return { expr: `${at.getUTCMinutes()} ${at.getUTCHours()} 2 11 *`, savedAt: new Date(start).toISOString(), tz: "UTC" };
  });
  const dueAt = (now: number) => jobs.filter((j) => runOnceDue({ ...j, now })).length;
  assert.equal(dueAt(start + 30_000), 0, "저장 직후 틱에 전부 돌았다(실측 사고)");
  assert.equal(dueAt(start + 4 * 60_000), 1);
  assert.equal(dueAt(start + 40 * 60_000), 10);
  assert.equal(dueAt(start + 120 * 60_000), 30);
});

// ── 고정 지연(cron-stagger.ts) — 사양 표 D·G ─────────────────────────────────────
//  정각에 몰린 시각형 잡을 잡 id 로 정한 지연만큼 늦춘다. 지켜야 할 것은 셋이다: 지연 전엔 안 돌고 지나면 돈다 ·
//  지연을 켜고 끄는 순간에도 직전 회차를 다시 돌지 않는다 · 어떤 틱 간격에서도 회차를 건너뛰거나 두 번 돌지 않는다.
const H = "0 * * * *";

test("D1 지연 전엔 due 아님, 지나면 due", () => {
  const o = { expr: H, lastRunAt: "2026-11-07T09:00:40Z", tz: "UTC", offsetMs: 40_000 };
  assert.equal(cronDue({ ...o, now: ms("2026-11-07T10:00:00Z") }), false, "매치 정각에 지연을 무시하고 돌았다");
  assert.equal(cronDue({ ...o, now: ms("2026-11-07T10:00:40Z") - 1 }), false, "지연 1ms 전에 돌았다");
  assert.equal(cronDue({ ...o, now: ms("2026-11-07T10:00:40Z") }), true, "지연이 지났는데 안 돌았다");
});

test("D2 지연 0·미지정은 종전 판정과 같다", () => {
  const grid = [ms("2026-11-07T09:59:59Z"), ms("2026-11-07T10:00:00Z"), ms("2026-11-07T10:03:20Z")];
  for (const now of grid) {
    const base = cronDue({ expr: H, lastRunAt: "2026-11-07T09:00:05Z", now, tz: "UTC" });
    assert.equal(cronDue({ expr: H, lastRunAt: "2026-11-07T09:00:05Z", now, tz: "UTC", offsetMs: 0 }), base);
  }
});

test("D3 한 번도 안 돈 잡은 지연 없이 바로 due(첫 실행 규칙 그대로)", () => {
  assert.equal(cronDue({ expr: H, lastRunAt: null, now: ms("2026-11-07T10:00:00Z"), tz: "UTC", offsetMs: 80_000 }), true);
});

test("D4 ★ 지연을 켜는 순간 — 지연 없이 돈 직전 회차를 다시 돌지 않는다", () => {
  //  10:00:05 에 지연 없이 돌았다(배포 전). 배포 뒤 지연 60초가 붙어도 10시 회차는 이미 돈 것이다.
  const o = { expr: H, lastRunAt: "2026-11-07T10:00:05Z", tz: "UTC", offsetMs: 60_000 };
  assert.equal(cronDue({ ...o, now: ms("2026-11-07T10:01:30Z") }), false, "10시 회차를 한 번 더 돌았다");
  assert.equal(cronDue({ ...o, now: ms("2026-11-07T10:59:59Z") }), false);
  assert.equal(cronDue({ ...o, now: ms("2026-11-07T11:01:00Z") }), true, "11시 회차(+지연)를 안 돌았다");
  //  매일 잡도 같다 — 배포가 한낮이어도 새벽 회차를 다시 돌지 않는다.
  assert.equal(cronDue({ expr: "30 4 * * *", lastRunAt: "2026-11-07T04:30:10Z", now: ms("2026-11-07T10:00:00Z"), tz: "UTC", offsetMs: 60_000 }), false);
});

test("D5 지연을 끄는 순간 — 지연을 두고 돈 회차를 다시 돌지 않고 다음 정각에 돈다", () => {
  const o = { expr: H, lastRunAt: "2026-11-07T10:01:20Z", tz: "UTC", offsetMs: 0 };
  assert.equal(cronDue({ ...o, now: ms("2026-11-07T10:30:00Z") }), false);
  assert.equal(cronDue({ ...o, now: ms("2026-11-07T11:00:00Z") }), true);
});

//  틱을 흉내 낸다 — engine 처럼 due 면 그 틱 시각을 last_run_at(실행 시작)으로 적는다.
//  delay(i) = i 번째 틱이 제 시각보다 늦게 온 몫(ms) — CP 가 부르는 틱은 제때 안 올 수 있다.
type Delay = (i: number) => number;
const ON_TIME: Delay = () => 0;
function simulate(expr: string, offsetMs: number, tickMs: number, phaseMs: number, startIso: string, hours: number, delay: Delay): number[] {
  const start = ms(startIso);
  let last: string = new Date(start + offsetMs).toISOString(); // 정상 상태: 직전 회차를 지연대로 돌았다
  const runs: number[] = [];
  for (let i = 0, t0 = start + offsetMs + phaseMs; t0 < start + hours * 3_600_000; i++, t0 += tickMs) {
    const t = t0 + delay(i);
    if (cronDue({ expr, lastRunAt: last, now: t, tz: "UTC", offsetMs })) { runs.push(t); last = new Date(t).toISOString(); }
  }
  return runs;
}
//  매치마다 [매치 + 지연, + 틱 + 최대 늦음) 안에 정확히 한 번 · 그 밖의 실행은 없다.
function missesAndExtras(expr: string, offsetMs: number, tickMs: number, phaseMs: number, startIso: string, hours: number,
  delay: Delay = ON_TIME, maxDelayMs = 0) {
  const runs = simulate(expr, offsetMs, tickMs, phaseMs, startIso, hours, delay);
  const end = ms(startIso) + hours * 3_600_000;
  const win = tickMs + maxDelayMs;
  let misses = 0, used = 0, until = 0;
  const parsed = parseCron(expr);
  for (let m = nextCronTime(parsed, new Date(ms(startIso)), "UTC")!.getTime(); m + offsetMs + win <= end;
    m = nextCronTime(parsed, new Date(m), "UTC")!.getTime()) {
    const hit = runs.filter((r) => r >= m + offsetMs && r < m + offsetMs + win).length;
    if (hit !== 1) misses++;
    used += hit;
    until = m + offsetMs + win;
  }
  //  마지막 창 뒤(시뮬레이션 끝에 걸친 회차)의 실행은 세지 않는다.
  return { misses, extras: runs.filter((r) => r < until).length - used };
}
//  [식, 최소 매치 간격(분)] — 7분 간격 식은 시간 경계에서 11분이 된다(*/7 은 56→다음 시 0 이 4분이라 쓰지 않는다).
const EXPRS: Array<[string, number]> = [
  [H, 60], ["*/30 * * * *", 30], ["*/10 * * * *", 10], ["0,7,14,21,28,35,42,49 * * * *", 7],
  ["*/6 * * * *", 6], ["*/5 * * * *", 5], ["*/2 * * * *", 2],
];

test("G1 ★ 제때 오는 틱 — 어떤 틱 간격·위상에서도 회차를 건너뛰거나 두 번 돌지 않는다(실제 지연 함수로)", () => {
  const ticks = [30_000, 300_000]; // 인프로세스 타이머(engine.ts TICK_MS) · 매니지드 HTTP 틱 격자(이 파일 머리말)
  for (const [expr, gapMin] of EXPRS) {
    for (const id of ["distill-inbox", "job-1", "job-2", "job-3", "wikilink-sweep"]) {
      const off = cronStaggerOffsetMs(id, expr, 90);
      for (const tick of ticks) {
        if (tick > gapMin * 60_000) continue; // 틱이 간격보다 성기면 지연과 무관하게 건너뛴다(종전)
        for (const phase of [0, 1_000, tick / 3, tick - 1_000]) {
          const r = missesAndExtras(expr, off, tick, phase, "2026-11-07T00:00:00Z", 6);
          assert.deepEqual(r, { misses: 0, extras: 0 }, `${expr} id=${id} off=${off} tick=${tick} phase=${phase}`);
        }
      }
    }
  }
});

test("G1b ★ 늦게 오는 5분 틱(0~60초) — 그래도 회차를 건너뛰거나 두 번 돌지 않는다", () => {
  const tick = 300_000, maxDelay = 60_000;
  const delays: Array<[string, Delay]> = [
    ["7틱마다 60초", (i) => (i % 7 === 6 ? maxDelay : 0)],
    ["0~60초 고루", (i) => ((i * 37) % 61) * 1_000],
  ];
  const ids = Array.from({ length: 40 }, (_, i) => `job-${i}`);
  for (const [expr, gapMin] of EXPRS) {
    if (tick + maxDelay > gapMin * 60_000) continue; // 지연 없이도 늦음만으로 건너뛰는 간격(종전)
    for (const id of ids) {
      const off = cronStaggerOffsetMs(id, expr, 90);
      for (const [name, delay] of delays) {
        for (const phase of [0, tick / 2, tick - 1_000]) {
          const r = missesAndExtras(expr, off, tick, phase, "2026-11-07T00:00:00Z", 6, delay, maxDelay);
          assert.deepEqual(r, { misses: 0, extras: 0 }, `${expr} id=${id} off=${off} ${name} phase=${phase}`);
        }
      }
    }
  }
});

test("G2 음성대조 — 상한을 넘긴 지연은 정말로 회차를 건너뛴다(상한이 필요한 이유)", () => {
  //  5분 틱에서 5분마다 도는 잡에 80초를 주면 10분에 한 번만 돈다. cronStaggerOffsetMs 는 이 잡을 흩지 않는다.
  //  틱이 «매치 + 지연» 직전에 깨는 위상 — 실행이 거의 한 틱 늦게 시작해 다음 매치 분으로 넘어간다.
  const r = missesAndExtras("*/5 * * * *", 80_000, 300_000, 299_000, "2026-11-07T00:00:00Z", 2);
  assert.ok(r.misses > 0, "시뮬레이터가 누락을 못 본다 — G1 이 헛통과한다");
  assert.equal(cronStaggerOffsetMs("job-1", "*/5 * * * *", 90), 0);
});
