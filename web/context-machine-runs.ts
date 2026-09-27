// context-machine-runs.ts — 수집기 행 · 증류기 카드 안의 «최근 실행»(#4135, 9/22 회의 ①②).
//
//  회의: «수집이 1시 50분, 2시, 2시 10분… 눌렀을 때 새로 몇 건, 기존 몇 건 수정됐다 정도. 설정 안에 들어 있는 걸 빼야 돼» ·
//   «자동으로 도는 거는 그 기록을 볼 수 있었으면». 종전엔 행에 「마지막 실행 n일 전」뿐이었고, 기록은 [설정] → [수집 기록] →
//   로그 원문이었다.
//  자료는 현황의 「자동 실행」 패널과 같은 것(/api/ui/org/auto-runs)이다 — 새 API 를 만들지 않았다. 어제 0시부터 지금까지를
//   한 번 받아 기계별로 나눈다(계산은 lib/machine-runs.ts). 그보다 오래된 것은 「자동 실행 기록」 화면이 맡는다.
//  ⚠ 펼친 기록은 접지 않는다(원준 2026-09-27 «펼치기 이거 말고 안에서 스크롤») — 변화 없는 실행도 흐린 줄로 같이 서고,
//   목록이 일정 높이 안에서 굴러간다.
import { api, el } from './core.js';
import { type AutoRun, addDays, hhmm, mdw, relDay, dayOf, toRun, today0, ymd } from './context-runs.js';
import { type MachineSum, failCause, groupRuns, isChanged, runsOf, summarize, whenLabel } from './lib/machine-runs.js';

export type RunsByMachine = Map<string, AutoRun[]>;

/** 어제 0시 ~ 지금. 실패해도 화면을 막지 않는다 — 기록 없이 그린다. */
export async function fetchRecentRuns(): Promise<RunsByMachine> {
  try {
    const r: any = await api('/api/ui/org/auto-runs?' + new URLSearchParams({ since: new Date(addDays(today0(), -1)).toISOString(), until: new Date().toISOString() }));
    return groupRuns<AutoRun>(((r && r.runs) || []).map(toRun));
  } catch { return new Map(); }
}
export const machineRuns = (map: RunsByMachine | null | undefined, kind: 'c' | 'd', machineId: string | number): AutoRun[] => runsOf(map, kind, machineId);
export const machineSum = (runs: AutoRun[]): MachineSum<AutoRun> => summarize(runs, Date.now());

/** 「자동 실행 기록」 화면을 그 기계로 걸러 여는 주소(최근 7일). */
export function machineRunsHref(kind: 'c' | 'd', machineId: string | number): string {
  const q = new URLSearchParams({ from: ymd(addDays(today0(), -6)), to: ymd(today0()), kind, machine: String(machineId) });
  return '#/context/runs?' + q.toString();
}

const b = (v: number, cls = ''): HTMLElement => el('b', { class: 'num' + (cls ? ' ' + cls : ''), text: String(v) });

/** 수집기 행 둘째 줄의 마지막 자리 — «마지막 15:30 · 새 자료 3 · 바뀐 자료 1». 기록이 없으면 null(부르는 쪽이 옛 문구를 쓴다). */
export function collectorLast(runs: AutoRun[]): HTMLElement | null {
  const last = runs[0];
  if (!last || !last.ok) return null;
  return el('span', { class: 'cxc-last' }, '마지막 ' + whenLabel(last.t, Date.now()) + ' · 새 자료 ', b(last.n), ' · 바뀐 자료 ', b(last.mo, 'is-u'));
}

/** 증류기 카드 둘째 줄의 마지막 자리 — «오늘 6회 · 새 지식 2 · 고침 3 · 실패 1». 오늘 돈 적이 없으면 null. */
export function distillerToday(sum: MachineSum<AutoRun>, category = false): HTMLElement | null {
  const t = sum.today;
  if (!t.runs) return null;
  const out = el('span', { class: 'cxc-last' }, '오늘 ' + t.runs + '회 · ');
  if (category) out.append('카테고리 붙임 ', b(t.mo, 'is-u'));
  else out.append('새 지식 ', b(t.n), ' · 고침 ', b(t.mo, 'is-u'));
  if (t.failed) out.append(' · ', el('span', { class: 'is-fail', text: '실패 ' + t.failed }));
  return out;
}

/** 실패 알림 — 셋째 줄로 빼지 않고 둘째 줄 안에 선다(원준 2026-09-27). act 는 그 옆의 글자 단추. */
export function issueInline(when: number | null, cause: string | null | undefined, act: HTMLElement | null): HTMLElement {
  const box = el('span', { class: 'cxc-iss-in' }, warnIcon(),
    el('span', { text: (when ? whenFull(when) + ' ' : '') + '수집 실패 · ' + failCause(cause) }));
  if (act) box.append(act);
  return box;
}
/** 실패 시각은 날짜까지 적는다(«9/17 11:42») — 오늘 실패도 어느 날 것인지 헷갈리지 않게. */
function whenFull(t: number): string { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm(t); }

function runRow(r: AutoRun, kind: 'c' | 'd', onPick: (r: AutoRun) => void): HTMLElement {
  const dur = r.dur == null ? '' : r.dur >= 60 ? Math.round(r.dur / 60) + '분' : Math.max(1, Math.round(r.dur)) + '초';
  const res = !r.ok ? el('span', { class: 'r bad', text: '실패' }) : isChanged(r) ? el('span', { class: 'r ok', text: '성공' }) : el('span', { class: 'r z', text: '변화 없음' });
  let what: HTMLElement;
  if (!r.ok) what = el('span', { class: 'w', text: failCause(r.err) });
  else if (!isChanged(r)) what = el('span', { class: 'w' });
  else if (kind === 'c') what = el('span', { class: 'w' }, '새 자료 ', b(r.n), ' · 바뀐 자료 ', b(r.mo, 'is-u'));
  else if (r.lane === 'category') what = el('span', { class: 'w' }, '읽은 지식 ' + (r.read ?? 0) + ' → 카테고리 붙임 ', b(r.mo, 'is-u'));
  else what = el('span', { class: 'w' }, '읽은 자료 ' + (r.read ?? 0) + ' → 새 지식 ', b(r.n), ' · 고친 지식 ', b(r.mo, 'is-u'));
  const row = el('button', { class: 'cmr-row' + (r.ok && !isChanged(r) ? ' is-z' : ''), type: 'button', title: '자동 실행 기록에서 이 실행 보기' },
    el('span', { class: 't num', text: hhmm(r.t) }), res, what, el('span', { class: 'd num', text: dur }));
  row.addEventListener('click', () => onPick(r));
  return row;
}

/**
 * 행 아래 펼친 실행 기록 — 머리(오늘 합계 · 전체 보기) + 안에서 굴러가는 목록 + 발치(거르기).
 *  날짜가 바뀌는 자리에 날짜 줄이 선다. 줄을 누르면 「자동 실행 기록」 화면이 그 실행을 연 채로 열린다.
 */
export function historyBox(kind: 'c' | 'd', machineId: string | number, runs: AutoRun[]): HTMLElement {
  const sum = machineSum(runs), t = sum.today;
  const href = machineRunsHref(kind, machineId);
  const box = el('div', { class: 'cmr' });
  box.append(el('div', { class: 'cmr-h' },
    el('span', { text: '최근 실행 · 오늘 ' + t.runs + '회 · 변화 ' + t.changed + '회' + (t.failed ? ' · 실패 ' + t.failed + '회' : '') }),
    el('span', { class: 'sp' }),
    el('a', { href, text: '자동 실행 기록에서 전체 보기 →' })));
  const list = el('div', { class: 'cmr-list', tabindex: '0', role: 'group', 'aria-label': '최근 실행 목록' });
  const only = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const go = (r: AutoRun): void => { location.hash = href.slice(1) + '&run=' + encodeURIComponent(r.key); };
  const paint = (): void => {
    const shown = only.checked ? runs.filter(isChanged) : runs;
    list.replaceChildren();
    if (!shown.length) { list.append(el('p', { class: 'cmr-empty', text: only.checked ? '어제부터 변화 있는 실행이 없습니다.' : '어제부터 실행한 기록이 없습니다.' })); return; }
    let day = -1;
    for (const r of shown) {
      const d0 = dayOf(r.t);
      if (d0 !== day) { day = d0; if (d0 !== today0() || shown[0] !== r) list.append(el('div', { class: 'cmr-day', text: mdw(d0) + (relDay(d0) ? ' · ' + relDay(d0) : '') })); }
      list.append(runRow(r, kind, go));
    }
  };
  only.addEventListener('change', paint);
  paint();
  box.append(list, el('div', { class: 'cmr-foot' },
    el('span', { text: '아래로 굴리면 이전 실행 · 어제부터 ' + runs.length + '회' }),
    el('span', { class: 'sp' }),
    el('label', { class: 'cmr-only' }, only, ' 변화 있는 실행만')));
  return box;
}

/** 증류기 카드 발치의 «최근 실행» 한 줄 — 최근 넷 + 어제 합계 + 기록 전체. 어제부터 돈 적이 없으면 null. */
export function recentLine(machineId: string, runs: AutoRun[], category = false): HTMLElement | null {
  if (!runs.length) return null;
  const sum = machineSum(runs), y = sum.yesterday;
  const line = el('div', { class: 'dsl-runs' }, el('span', { class: 'k', text: '최근 실행' }));
  for (const r of runs.slice(0, 4)) {
    const when = whenLabel(r.t, Date.now());
    if (!r.ok) line.append(el('span', { class: 'run bad' }, el('span', { class: 't num', text: when }), '실패 · ' + failCause(r.err)));
    else if (category) line.append(el('span', { class: 'run' }, el('span', { class: 't num', text: when }), '읽음 ' + (r.read ?? 0) + ' → 붙임 ', b(r.mo, 'is-u')));
    else line.append(el('span', { class: 'run' }, el('span', { class: 't num', text: when }), '읽음 ' + (r.read ?? 0) + ' → 새 ', b(r.n), ' · 고침 ', b(r.mo, 'is-u')));
  }
  if (y.runs) line.append(el('span', { class: 'z', text: '어제 ' + y.runs + '회 · ' + (category ? '붙임 ' + y.mo : '새 지식 ' + y.n + ' · 고침 ' + y.mo) }));
  line.append(el('a', { href: machineRunsHref('d', machineId), text: '기록 전체 →' }));
  return line;
}

function warnIcon(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const n = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ class: 'cxc-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) n.setAttribute(k, v);
  for (const d of ['M12 3 2.5 19.5h19z', 'M12 10v4M12 17.5h.01']) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); n.append(p); }
  return n;
}
