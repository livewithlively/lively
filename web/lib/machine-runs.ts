// lib/machine-runs.ts — 기계(수집기 · 증류기)별 최근 실행. 순수 함수(#4135, 9/22 회의 ①②).
//
//  수집기 행과 증류기 카드는 «그 기계가 최근에 무엇을 했나»를 그 자리에서 보여 준다 — 종전엔 「마지막 실행 n일 전」뿐이라
//   기록을 보려면 [설정] → [수집 기록] → 로그 원문까지 들어가야 했다. 자료는 자동 실행 기록(/api/ui/org/auto-runs)의 줄이고,
//   여기서는 그 줄을 기계별로 나누고 · 오늘과 어제로 합치고 · 시각과 실패 사유를 사람 말로 적는다.
//  화면(web/context-machine-runs.ts)은 이 값을 그리기만 한다. 시험: scripts/machine-runs.test.mjs.

/** 실행 한 줄 — 화면이 쓰는 모양(context-runs.ts 의 AutoRun)에서 계산에 필요한 것만. */
export interface RunLike {
  kind: 'c' | 'd';
  machineId: string;
  /** 시작 시각(ms). */
  t: number;
  ok: boolean;
  err?: string | null;
  /** 새로 생긴 것(수집: 새 자료 · 증류: 새 지식). */
  n: number;
  /** 바뀐 것(수집: 바뀐 자료 · 증류: 고친 지식 · 카테고리 붙인 수). */
  mo: number;
  /** 읽은 것(증류만). 수집은 값이 없다. */
  read?: number | null;
  /** 아직 도는 중 — 결과가 아직 없다. */
  running?: boolean;
}

export interface RunSum { runs: number; failed: number; n: number; mo: number; read: number; changed: number }
export interface MachineSum<R extends RunLike> { today: RunSum; yesterday: RunSum; last: R | null }

/** 수집기와 증류기는 번호가 같아도 다른 기계다. */
export const machineKey = (kind: 'c' | 'd', machineId: string | number): string => kind + ':' + String(machineId);

/** 줄을 기계별로 나눈다. 기계 안에서는 최근 것이 위다(들어온 순서와 무관). */
export function groupRuns<R extends RunLike>(runs: readonly R[] | null | undefined): Map<string, R[]> {
  const m = new Map<string, R[]>();
  for (const r of runs || []) {
    if (!r || !Number.isFinite(r.t)) continue;
    const k = machineKey(r.kind, r.machineId);
    const a = m.get(k);
    if (a) a.push(r); else m.set(k, [r]);
  }
  for (const a of m.values()) a.sort((x, y) => y.t - x.t);
  return m;
}

/** 그 기계의 줄 — 기록이 없는 기계(또는 묶음 자체가 없을 때)는 빈 목록이다. */
export function runsOf<R extends RunLike>(map: Map<string, R[]> | null | undefined, kind: 'c' | 'd', machineId: string | number): R[] {
  return (map && map.get(machineKey(kind, machineId))) || [];
}

/**
 * 마지막 실행을 어떻게 말할까 — 도는 중이면 결과를 말하지 않는다(끝나지 않은 실행의 숫자는 결과가 아니다).
 *  none 기록 없음 · running 도는 중 · failed 실패 · done 끝남.
 */
export function lastOutcome<R extends RunLike>(runs: readonly R[] | null | undefined): { kind: 'none' | 'running' | 'failed' | 'done'; run: R | null } {
  let last: R | null = null;
  for (const r of runs || []) if (r && Number.isFinite(r.t) && (!last || r.t > last.t)) last = r;
  if (!last) return { kind: 'none', run: null };
  if (last.running) return { kind: 'running', run: last };
  return { kind: last.ok ? 'done' : 'failed', run: last };
}

/** 변화 있는 실행 — 실패했거나, 새로 생긴 것과 바뀐 것이 하나라도 있다. */
export const isChanged = (r: RunLike): boolean => !r.ok || (Number(r.n) || 0) + (Number(r.mo) || 0) > 0;

/** 그 시각이 든 날의 0시(보는 사람의 시계). */
export function dayStart(t: number): number { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function prevDayStart(d0: number): number { const d = new Date(d0); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d.getTime(); }

const zero = (): RunSum => ({ runs: 0, failed: 0, n: 0, mo: 0, read: 0, changed: 0 });
function add(s: RunSum, r: RunLike): void {
  s.runs++;
  if (isChanged(r)) s.changed++;
  if (!r.ok) { s.failed++; return; }   // 실패한 실행은 실행 수와 실패 수에만 든다
  s.n += Number(r.n) || 0;
  s.mo += Number(r.mo) || 0;
  s.read += Number(r.read) || 0;
}

/** 오늘 · 어제 합계와 마지막 실행. 하루는 0시부터이고 0시 정각의 실행은 그날 것이다. */
export function summarize<R extends RunLike>(runs: readonly R[] | null | undefined, now: number): MachineSum<R> {
  const t0 = dayStart(now), y0 = prevDayStart(t0);
  const out: MachineSum<R> = { today: zero(), yesterday: zero(), last: null };
  for (const r of runs || []) {
    if (!r || !Number.isFinite(r.t)) continue;
    if (!out.last || r.t > out.last.t) out.last = r;
    if (r.running) continue;   // 도는 중인 실행은 아직 합계에 넣지 않는다(끝나면 든다)
    if (r.t >= t0) add(out.today, r);
    else if (r.t >= y0) add(out.yesterday, r);
  }
  return out;
}

const p2 = (v: number): string => String(v).padStart(2, '0');
/** 마지막 실행 시각 — 오늘 «15:30» · 어제 «어제 15:30» · 그 전 «9/17 11:42». */
export function whenLabel(t: number, now: number): string {
  const d = new Date(t), hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
  const t0 = dayStart(now);
  if (t >= t0) return hm;
  if (t >= prevDayStart(t0)) return '어제 ' + hm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}

export const CAUSE_MAX = 40;
/** 실패 사유 — 기록된 사유의 첫 토막만, 길면 자른다. 없으면 없다고 말한다. */
export function failCause(err: string | null | undefined): string {
  const s = String(err ?? '').split(' — ')[0].replace(/\s+/g, ' ').trim();
  if (!s) return '원인 기록 없음';
  return s.length > CAUSE_MAX ? s.slice(0, CAUSE_MAX) + '…' : s;
}
