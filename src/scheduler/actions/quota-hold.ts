// 헤드리스 실행 계정의 «사용 한도 소진» 을 읽어, 풀릴 때까지 새 배치를 내지 않게 한다 (#5160). 순수 — DB 를 모른다.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────────────────────────
//  구독 계정이 주간·세션 한도에 닿으면 `claude -p` 는 2~3초 만에 «You've hit your weekly limit · resets 9pm (UTC)» 를 내고
//  exit 1 로 죽는다. 종전엔 이걸 아무도 안 읽어서, 증류 잡이 풀릴 때까지 매 주기(수집 이어달리기로 실제론 5분마다) 배치를 다시 냈다
//  — 2026-10-29~30 실측: 하루 413건 실패, 자동 실행 화면이 빨간 줄로 덮였다(#5155 원인규명). 두 장치 모두 이걸 못 잡는다:
//   · 크론 브레이커(cron-breaker.ts)는 접수 반환값만 센다 — 헤드리스는 접수가 늘 ok(cron-task-feedback.ts 머리말).
//   · 자격 실패 대응(node/auth-failure-response.ts)은 401 만 본다 — 한도는 exit 1 + 본문 문구다.
//  그래서 접수 직전에 «그 계정의 마지막 배치가 한도로 죽었나» 를 보고, 풀림 시각 전이면 건너뛴다. 상태를 따로 두지 않는다 —
//  풀린 뒤 첫 배치가 성공하면 마지막 배치가 성공이 되어 저절로 풀리고, 또 한도면 새 풀림 시각으로 다시 건다.
//
// ── 문구(실측) ─────────────────────────────────────────────────────────────────────────────────
//   «You've hit your weekly limit · resets Oct 30, 9pm (UTC)»       (org_task 7458, 2026-10-29)
//   «You've hit your weekly limit · resets 9pm (UTC)»               (org_task 8074, 2026-10-30 — 풀림이 같은 날이면 날짜가 빠진다)
//   «You've hit your weekly limit · resets Oct 24, 6am (Asia/Seoul)» (agent_job #17, 2026-10-22)
//  ⚠ 문구는 Claude Code 가 바꿀 수 있다. «hit your … limit» 만 맞고 풀림 시각을 못 읽으면 FALLBACK_HOLD_MS 만 쉰다
//   (한 시간에 한 번 시험 배치가 간다 — 종전 5분마다보다 낫고, 영영 멈추지는 않는다).

/** 한도 문구는 알아봤는데 풀림 시각을 못 읽었을 때 쉬는 시간. */
export const FALLBACK_HOLD_MS = 60 * 60_000;
/** 풀림 시각이 이보다 멀면 잘못 읽은 것으로 본다(주간 한도 7일 + 여유). 그때도 FALLBACK 으로 내려간다 — 잘못 읽어 잡이 몇 주 멈추는 것이 더 나쁘다. */
export const MAX_HOLD_MS = 8 * 24 * 60 * 60_000;
/** 날짜 없는 풀림 시각이 실패 시각보다 이만큼 안쪽으로 앞서면 «다음 날» 로 넘기지 않는다(표시 시각이 분 단위로 내려 찍혔을 수 있다). */
const NEAR_PAST_MS = 10 * 60_000;

const LIMIT = /\bhit your\b[^·\n]*\blimit\b/i;
//  resets [Mon D, ]H[:MM]am|pm (TZ)
const RESET = /\bresets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 그 시간대에서 utcMs 시각의 벽시계가 UTC 보다 몇 ms 앞서나. 모르는 시간대면 던진다(Intl RangeError). */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/** 그 시간대의 벽시계 y-m-d h:mi → UTC ms. 오프셋을 두 번 재서 서머타임 경계 근처도 맞춘다. */
function wallToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

/** 그 시각의 그 시간대 날짜(y, m0, d). */
function wallDate(utcMs: number, tz: string): { y: number; m: number; d: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day };
}

/**
 * (순수) 배치 실패 문장에서 «한도 소진이면 언제까지 쉴지» 를 읽는다. 한도 문구가 아니면 null.
 * @param text 실패 문장(org_task.result.summary · error 를 이어 붙인 것)
 * @param failedAtMs 그 배치가 끝난 시각 — 날짜 없는 풀림 시각(«resets 9pm») 은 이 시각 **뒤의** 첫 9pm 이다.
 */
export function quotaHoldUntil(text: string | null | undefined, failedAtMs: number): number | null {
  if (typeof text !== "string" || !LIMIT.test(text)) return null;
  const fallback = failedAtMs + FALLBACK_HOLD_MS;
  const m = RESET.exec(text);
  if (!m) return fallback;
  const [, mon, day, hh, mm, ampm, tzRaw] = m;
  const tz = tzRaw.trim();
  const mi = mm ? Number(mm) : 0;
  //  12시간제 — 1~12 밖이면 깨진 문구다(«13pm» 을 1pm 으로 읽지 않는다).
  if (Number(hh) < 1 || Number(hh) > 12 || mi > 59) return fallback;
  const h = (Number(hh) % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  let until: number;
  try {
    if (mon) {
      const mo = MONTHS.indexOf(mon.toLowerCase());
      if (mo < 0) return fallback;
      const { y } = wallDate(failedAtMs, tz);
      until = wallToUtc(y, mo, Number(day), h, mi, tz);
      //  연말에 걸친 풀림(12/30 에 «resets Jan 2») — 이미 지난 날짜면 다음 해다.
      if (until <= failedAtMs - 24 * 60 * 60_000) until = wallToUtc(y + 1, mo, Number(day), h, mi, tz);
    } else {
      const { y, m: mo, d } = wallDate(failedAtMs, tz);
      until = wallToUtc(y, mo, d, h, mi, tz);
      //  표시 시각이 실패 시각 바로 앞이면(분 단위 내림 등) «내일 그 시각» 이 아니라 막 풀리는 중이다 — 하루를 쉬지 않고 바닥만 쉰다.
      if (until <= failedAtMs && failedAtMs - until < NEAR_PAST_MS) return fallback;
      if (until <= failedAtMs) until = wallToUtc(y, mo, d + 1, h, mi, tz);
    }
  } catch { return fallback; /* 모르는 시간대 이름 */ }
  if (!Number.isFinite(until) || until <= failedAtMs || until - failedAtMs > MAX_HOLD_MS) return fallback;
  return until;
}

/** 그 계정의 가장 최근 종결 배치(org_task) — 접수 직전에 읽는다. */
export interface LastTask { status: string; text: string | null; finishedAt: Date | string | null }

/**
 * (순수) 지금 쉬어야 하면 풀림 시각(ms), 아니면 null.
 *  마지막 배치가 **실패**이고 그 문장이 한도이며 풀림 시각이 아직 안 왔을 때만 쉰다 — 성공한 배치는 요약에 무엇이 적혔든 쉬는 근거가 아니다
 *  (AI 가 요약에 한도 얘기를 쓸 수 있다). 풀림 시각 «부터» 낸다(경계 포함).
 */
export function activeQuotaHold(last: LastTask | null | undefined, nowMs: number): number | null {
  if (!last || last.status !== "failed" || last.finishedAt == null) return null;
  const failedAtMs = new Date(last.finishedAt).getTime();
  if (!Number.isFinite(failedAtMs)) return null;
  const until = quotaHoldUntil(last.text, failedAtMs);
  return until != null && nowMs < until ? until : null;
}
