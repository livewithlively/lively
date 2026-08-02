// 최소 cron 표현식 평가 — 제로-dep(croner 등 미사용: 공유레포 npm install 처닝 회피). 5필드(분 시 일 월 요일).
//  지원: * , - / — 예) '*/10 * * * *'(매 10분), '0 9 * * *'(매일 09:00), '0 9 * * 1-5'(평일 09:00),
//        '0,30 * * * *'(매시 0·30분), '0 */2 * * *'(짝수시 정각).
//  미지원: 이름(JAN/MON)·매크로(@daily)·초 필드. 그 이상이 필요하면 croner 로 교체.
//  요일: 0·7 = 일요일. DOM·DOW 둘 다 제한되면 표준 cron OR 시맨틱(둘 중 하나라도 매치).
//
//  ⚠ 시간대(#778) — 매치는 **조직 시간대(tz)의 벽시계**로 판정한다(org_profile.timezone, 기본 Asia/Seoul).
//   예전엔 서버 프로세스 로컬 TZ 였다: 리눅스 박스 기본 TZ 는 대개 UTC 라 '0 9 * * *'(아침 9시 의도)가 실제로는
//   **18:00 KST** 에 돌았다. 게다가 dev(맥, KST)에선 우연히 맞고 고객 박스(UTC)에서만 틀려 조용히 새는 클래스였다.
//   tz 를 안 주면 서버 로컬로 폴백(종전 동작) — 호출부는 scheduler 가 orgTimezone() 을 넘긴다.
//
//   DST: 절대 instant 를 분 단위로 전진시키며 tz 벽시계로 판정한다 → 봄 전환의 '존재하지 않는 벽시계'는 그날
//   건너뛰고, 가을 전환의 '중복되는 벽시계'는 두 번 매치한다(Asia/Seoul 은 DST 가 없어 무해). 엄밀한 DST
//   시맨틱이 필요해지면 croner 로 교체.

export interface ParsedCron {
  min: Set<number>; hr: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>;
  domR: boolean; dowR: boolean; // dom/dow 가 '*' 가 아닌지(제한 여부) — OR 시맨틱 판정용.
}

function parseField(f: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of f.split(",")) {
    const [rangeStr, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron step 오류: ${part}`);
    let a: number, b: number;
    if (rangeStr === "*") { a = lo; b = hi; }
    else if (rangeStr.includes("-")) { const m = rangeStr.split("-"); a = Number(m[0]); b = Number(m[1]); }
    else { a = Number(rangeStr); b = step > 1 ? hi : a; } // 'n/step' → n..hi step
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) {
      throw new Error(`cron 필드 범위 오류: '${part}' (허용 ${lo}-${hi})`);
    }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): ParsedCron {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error("cron 은 5필드여야 합니다: 분 시 일 월 요일");
  return {
    min: parseField(f[0], 0, 59), hr: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31),
    mon: parseField(f[3], 1, 12), dow: parseField(f[4], 0, 7),
    domR: f[2] !== "*", dowR: f[4] !== "*",
  };
}

// tz 벽시계 분해기 — zero-dep(Intl). 포맷터는 TZ 당 1개만 만들어 캐시(30s 틱·next_run 스캔이 매번 재생성하지 않게).
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    // hourCycle:'h23' 명시 — hour12:false 는 구현에 따라 자정을 '24' 로 준다(h24). h23 이 0..23 을 보장한다.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

interface Wall { mon: number; day: number; hr: number; min: number; dow: number }

// 절대 instant d 를 tz 의 벽시계로 분해. tz 없으면 서버 로컬(종전 동작).
function wallClock(d: Date, tz?: string): Wall {
  if (!tz) return { mon: d.getMonth() + 1, day: d.getDate(), hr: d.getHours(), min: d.getMinutes(), dow: d.getDay() };
  const p: Record<string, string> = {};
  for (const part of formatterFor(tz).formatToParts(d)) p[part.type] = part.value;
  const y = Number(p.year), mon = Number(p.month), day = Number(p.day);
  // 요일은 로케일 문자열('Mon') 파싱 대신 y/m/d 에서 직접 뽑는다 — 로케일 무관·결정적.
  const dow = new Date(Date.UTC(y, mon - 1, day)).getUTCDay();
  return { mon, day, hr: Number(p.hour), min: Number(p.minute), dow };
}

// 절대 instant d 가 tz 벽시계 기준으로 cron 에 매치하는가.
export function cronMatches(c: ParsedCron, d: Date, tz?: string): boolean {
  const w = wallClock(d, tz);
  if (!c.min.has(w.min) || !c.hr.has(w.hr) || !c.mon.has(w.mon)) return false;
  const domOk = c.dom.has(w.day);
  const dowOk = c.dow.has(w.dow) || (w.dow === 0 && c.dow.has(7));
  if (c.domR && c.dowR) return domOk || dowOk; // 표준 cron OR
  if (c.domR) return domOk;
  if (c.dowR) return dowOk;
  return true; // 둘 다 '*' → 일/요일 무관
}

// from 이후(배타) 첫 매치 분. **절대 instant** 를 분 단위로 최대 366일 전진 스캔하며 tz 벽시계로 판정(DST 안전).
//  매치가 없으면 null(예: '0 0 30 2 *' = 2월 30일 — 이때만 최대 527k 회 도는데, 잡 저장/실행 시 1회라 무해).
//  (표시용 next_run_at.)
export function nextCronTime(c: ParsedCron, from: Date, tz?: string): Date | null {
  let t = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000; // 다음 분 경계(초=0) — from 배타
  for (let i = 0; i < 366 * 24 * 60; i++, t += 60_000) {
    const d = new Date(t);
    if (cronMatches(c, d, tz)) return d;
  }
  return null;
}

export function isValidCron(expr: string): boolean {
  try { parseCron(expr); return true; } catch { return false; }
}
