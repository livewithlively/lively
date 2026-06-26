// 최소 cron 표현식 평가 — 제로-dep(croner 등 미사용: 공유레포 npm install 처닝 회피). 5필드(분 시 일 월 요일).
//  지원: * , - / — 예) '*/10 * * * *'(매 10분), '0 9 * * *'(매일 09:00), '0 9 * * 1-5'(평일 09:00),
//        '0,30 * * * *'(매시 0·30분), '0 */2 * * *'(짝수시 정각).
//  미지원: 이름(JAN/MON)·매크로(@daily)·초 필드·DST 보정. 그 이상이 필요하면 croner 로 교체.
//  요일: 0·7 = 일요일. DOM·DOW 둘 다 제한되면 표준 cron OR 시맨틱(둘 중 하나라도 매치). 평가는 서버 로컬 TZ 기준.

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

// d(로컬 시각)가 cron 에 매치하는가.
export function cronMatches(c: ParsedCron, d: Date): boolean {
  if (!c.min.has(d.getMinutes()) || !c.hr.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dow = d.getDay(); // 0=일요일
  const dowOk = c.dow.has(dow) || (dow === 0 && c.dow.has(7));
  if (c.domR && c.dowR) return domOk || dowOk; // 표준 cron OR
  if (c.domR) return domOk;
  if (c.dowR) return dowOk;
  return true; // 둘 다 '*' → 일/요일 무관
}

// from 이후(배타) 첫 매치 분(초=0). 분 단위로 최대 366일 전진 스캔, 없으면 null. (표시용 next_run_at.)
export function nextCronTime(c: ParsedCron, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(c, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export function isValidCron(expr: string): boolean {
  try { parseCron(expr); return true; } catch { return false; }
}
