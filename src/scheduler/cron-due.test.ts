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
import { cronDue } from "./cron-due.js";

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

  //  A3 한 번도 안 돌았다 → due. run_once 가 이미 같은 규율이다(engine.ts).
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

  //  B1 1회성 분기 — 종전 그대로.
  assert.match(ENGINE, /if \(job\.run_once\) return !job\.last_run_at/, "B1 run_once 분기가 바뀌었다");
  //  B2·B3 주기형 분기 — 종전 그대로(last + interval, 최소 60초 하한).
  assert.match(ENGINE, /return now - last >= Math\.max\(60, Number\(job\.interval_sec\) \|\| 600\) \* 1000/,
    "B2 주기형 판정이 바뀌었다 — 이번 범위가 아니다");
});
