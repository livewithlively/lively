// cron 표현식 평가 테스트 — 특히 **시간대**(#778). 회귀 대상: cron 이 서버 프로세스 로컬 TZ 로 평가되던 버그.
//  박스가 UTC(리눅스 서버 기본)면 '0 9 * * *'(아침 9시 의도)가 18:00 KST 에 돌았고, dev(맥=KST)에선 우연히 맞아
//  **고객 박스에서만 조용히 틀리는** 클래스였다. 아래 t1/t2 가 그 정확한 경계를 못 박는다.
//  ※ 이 테스트는 프로세스 TZ 에 의존하지 않는다(모든 단언이 절대 instant + 명시 tz).
import assert from "node:assert/strict";
import { parseCron, cronMatches, nextCronTime, isValidCron } from "./cron-expr.js";

const at = (iso: string) => new Date(iso);
const KST = "Asia/Seoul";

// ── #778 핵심 회귀: '매일 09:00' 은 조직 시간대의 09:00 이다 ──
{
  const c = parseCron("0 9 * * *");
  // 09:00 KST = 00:00Z → 매치해야 한다.
  assert.equal(cronMatches(c, at("2026-07-13T00:00:00Z"), KST), true, "09:00 KST 에 매치해야 함");
  // 09:00 UTC = 18:00 KST → 매치하면 안 된다(이게 예전 버그의 발화 시각).
  assert.equal(cronMatches(c, at("2026-07-13T09:00:00Z"), KST), false, "18:00 KST 에 발화하면 안 됨(#778 회귀)");
  // 같은 표현식을 UTC 조직으로 보면 정반대 — tz 가 실제로 판정을 바꾼다는 증거.
  assert.equal(cronMatches(c, at("2026-07-13T09:00:00Z"), "UTC"), true);
  assert.equal(cronMatches(c, at("2026-07-13T00:00:00Z"), "UTC"), false);
}

// ── 자정(h23 함정): hour12:false 는 구현에 따라 자정을 '24' 로 준다 → 0 시가 안 잡히는 버그. h23 강제 확인. ──
{
  const c = parseCron("0 0 * * *");
  assert.equal(cronMatches(c, at("2026-07-12T15:00:00Z"), KST), true, "00:00 KST 매치(자정=0시, 24 아님)");
  assert.equal(cronMatches(c, at("2026-07-13T00:00:00Z"), KST), false);
}

// ── 요일이 시간대 경계를 넘을 때 — 같은 instant 가 KST 로는 월요일, UTC 로는 일요일. ──
{
  const t = at("2026-07-12T15:00:00Z"); // KST: 월 00:00 / UTC: 일 15:00
  assert.equal(cronMatches(parseCron("0 0 * * 1"), t, KST), true, "KST 기준 월요일");
  assert.equal(cronMatches(parseCron("0 0 * * 0"), t, KST), false, "KST 기준 일요일 아님");
  assert.equal(cronMatches(parseCron("0 15 * * 0"), t, "UTC"), true, "UTC 기준 일요일");
  assert.equal(cronMatches(parseCron("0 15 * * 7"), t, "UTC"), true, "7 도 일요일(0·7 동치)");
}

// ── nextCronTime: tz 벽시계의 다음 매치를 **절대 instant** 로 돌려준다. ──
{
  const n = nextCronTime(parseCron("0 9 * * *"), at("2026-07-12T23:00:00Z"), KST);
  assert.equal(n?.toISOString(), "2026-07-13T00:00:00.000Z", "다음 09:00 KST = 2026-07-13T00:00Z");
  // 평일(1-5) 제한: 금요일 09:00 KST 다음은 (토·일 건너뛰고) 월요일 09:00 KST.
  const fri = nextCronTime(parseCron("0 9 * * 1-5"), at("2026-07-10T00:00:00Z"), KST); // 금 09:00 KST 직후
  assert.equal(fri?.toISOString(), "2026-07-13T00:00:00.000Z", "금→월 점프(주말 스킵)");
}

// ── DST: 절대 instant 를 전진시키며 tz 벽시계로 판정하므로 '존재하지 않는 벽시계'는 자동으로 건너뛴다. ──
//  2026-03-08 America/New_York 은 01:00 → 03:00 으로 점프해 **02:00 이 존재하지 않는다**.
{
  const c = parseCron("0 2 * * *");
  const NY = "America/New_York";
  assert.equal(cronMatches(c, at("2026-03-08T07:00:00Z"), NY), false, "점프된 03:00 을 02:00 으로 오인하면 안 됨");
  // 3/7 02:00 EST(=07:00Z) 직후의 다음 매치는 3/8(없음)을 건너뛰고 3/9 02:00 EDT(=06:00Z).
  const n = nextCronTime(c, at("2026-03-07T07:00:00Z"), NY);
  assert.equal(n?.toISOString(), "2026-03-09T06:00:00.000Z", "존재하지 않는 02:00 인 날은 스킵");
}

// ── 기존 문법 보존(회귀 방지) — 필드 파싱·OR 시맨틱·검증. ──
{
  assert.equal(cronMatches(parseCron("*/10 * * * *"), at("2026-07-13T00:20:00Z"), "UTC"), true);
  assert.equal(cronMatches(parseCron("*/10 * * * *"), at("2026-07-13T00:25:00Z"), "UTC"), false);
  assert.equal(cronMatches(parseCron("0,30 * * * *"), at("2026-07-13T00:30:00Z"), "UTC"), true);
  assert.equal(cronMatches(parseCron("0 */2 * * *"), at("2026-07-13T02:00:00Z"), "UTC"), true);
  assert.equal(cronMatches(parseCron("0 */2 * * *"), at("2026-07-13T03:00:00Z"), "UTC"), false);
  // DOM·DOW 둘 다 제한 → 표준 cron OR(둘 중 하나만 맞아도 매치). 2026-07-13 = 월요일, 13일.
  const or = parseCron("0 0 13 * 5"); // 13일 **또는** 금요일
  assert.equal(cronMatches(or, at("2026-07-13T00:00:00Z"), "UTC"), true, "13일이라 매치(요일 불일치여도)");
  assert.equal(cronMatches(parseCron("0 0 14 * 5"), at("2026-07-13T00:00:00Z"), "UTC"), false);
  // tz 미지정 → 서버 로컬 폴백(종전 동작). 로컬 벽시계로 만든 Date 는 항상 매치해야 한다.
  const local = new Date(2026, 6, 13, 9, 0, 0);
  assert.equal(cronMatches(parseCron("0 9 13 7 *"), local), true, "tz 생략 = 서버 로컬 폴백");

  assert.equal(isValidCron("0 9 * * 1-5"), true);
  assert.equal(isValidCron("0 9 * *"), false, "5필드 아니면 거부");
  assert.equal(isValidCron("60 * * * *"), false, "분 범위 초과 거부");
}

// ── 매치 불가 표현식(2월 30일) → null. 366일 스캔 상한이 무한루프를 막는다는 보증. ──
{
  const t0 = Date.now();
  assert.equal(nextCronTime(parseCron("0 0 30 2 *"), at("2026-07-13T00:00:00Z"), KST), null);
  assert.ok(Date.now() - t0 < 10_000, "최악 스캔(366일)도 실용 범위 안");
}

console.log("cron-expr.test.ts ok");
