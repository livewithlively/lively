// v2/bins.ts — 지난 세션(#/archive) · 휴지통(#/trash) 화면(#1851 → #1850 안 A, 원준 2026-08-27 "A안으로 가자").
//  ⚠ 「아카이브」였던 자리는 #3778(원준 2026-09-19)에서 **「지난 세션」**이 됐다 — 주인공이 보관한 프로젝트에서
//   세션으로 바뀌었고, 보관한 프로젝트는 같은 화면의 칩 하나로 남았다(renderPast 머리말).
//
//  ── 안 A「원장 표」 ──
//  두 화면이 **같은 표 문법**을 쓴다(프로젝트 앱의 리스트 뷰와 같은 결): 열 머리 + 날짜 묶음 행 + 항목 행.
//   · 묶음 행(오늘·어제·이번 주·이전)에 체크박스 — "오늘 것 전체 선택"이 한 번(원준 요청). 묶음 되돌리기 링크도 그 줄에.
//   · 행을 누르면 **곁칸**(새 셸의 우패널)에 그 항목의 안(함께 들어간 세션·만든 지식·자료·작업 기록)이 열린다 —
//     지우기 전에 안을 본다. 여러 개를 고르면 곁칸 위에 고른 것의 합계와 동사가 선다.
//   · 파괴 동사는 행 안 코랄 글자(진입점) → 확인창의 코랄 채움(확정) 하나뿐. 채운 파랑은 화면에 0개(P1 컬러 예산).
//   · 아카이브는 같은 표에서 동사만 다르다(보관 해제 · 휴지통으로). 종전 카드 깔림(#1851)을 걷어냈다.
//  완전 삭제의 실제 삭제 범위는 #1850 P2~P4(session-actions·session-footprint-store) — 여기는 그 창을 부를 뿐이다.
//  행 문법은 홈·확인할 것과 같은 토큰(v2-dot·bg-sel·line-row)만 쓴다 — 새 시각 언어를 만들지 않는다.
import { api, el, relTime, sv, toast } from '../core.js';
import { confirmSessionPurge, confirmSessionPurgeLocal, confirmSessionPurgeMany, fetchFootprint, purgeSessionRecord, purgedToast, sessionNames, sessionTrashOp, setTrashConfirmSkipped, splitFootprint, trashConfirmSkipped, eulReul, type Footprint } from '../session-actions.js';
import { sessText } from './side.js';
import { dotCls, isArchivedProj, isLiveSess, isLooseTrashedSess, isTrashedProj, isTrashedSess, projName, type Proj, type Sess, type V2Data } from './views.js';
import { listDismissedSessions, restoreDismissedSessions, type DismissedSession } from './app-instance.js';   // #3857 「치운 세션」
import { groupPastByProject, isDismissedSess, pastNames, PAST_PERIODS, selectPast, standsInPast, type PastPeriod, type PastScope, type PastSessLike } from '../lib/past-sess.js';   // #3778 — 「지난 세션」의 잣대(순수)

export interface BinHooks { onChanged?: () => void }

const when = (iso: string | null | undefined): string => (iso ? relTime(iso) : '');
const whenMs = (ms: number): string => (ms ? relTime(new Date(ms).toISOString()) : '');
const dot = (k: string) => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });
const PAGE = 50;
const folderIcon = () => sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold sm', 'aria-hidden': 'true' }, sv('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }));
const sessIcon = () => sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold sm', 'aria-hidden': 'true' }, sv('path', { d: 'M4 5h16v11H8l-4 4z' }));

// 날짜 묶음 — 오늘 · 어제 · 이번 주(7일) · 이전. 긴 목록의 눈금(OS 휴지통과 같은 문법).
const bucketOf = (iso: string): string => {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '이전';
  const d = new Date(t); const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  return diff <= 0 ? '오늘' : diff === 1 ? '어제' : diff < 7 ? '이번 주' : '이전';
};

// 정밀 시각은 hover(title)로 — 열은 상대 표기(디자인 시스템 §9).
const whenCell = (iso: string | null | undefined): HTMLElement =>
  el('span', { class: 'm', text: when(iso), title: iso ? new Date(iso).toLocaleString() : '' });

// 발자국 캐시 — 곁칸이 항목을 열 때마다 다시 부르지 않게. 화면이 다시 그려져도 산다(모듈 수준).
const fpCache = new Map<string, Footprint | null>();
async function fpOf(sid: string, node: string): Promise<Footprint | null> {
  if (!fpCache.has(sid)) fpCache.set(sid, await fetchFootprint(sid, node));
  return fpCache.get(sid) ?? null;
}

// 체크박스 한 알 — 표 안 어디서나 같은 부품. ⚠ 행 클릭(곁칸 열기)과 겹치지 않게 클릭 전파를 끊는다.
function cb(checked: boolean, label: string, onchange: (on: boolean) => void, indeterminate = false): HTMLInputElement {
  const box = el('input', { type: 'checkbox', class: 'sel', 'aria-label': label }) as HTMLInputElement;
  box.checked = checked; box.indeterminate = indeterminate;
  box.addEventListener('change', () => onchange(box.checked));
  box.addEventListener('click', (ev) => ev.stopPropagation());
  return box;
}

// 곁칸의 항목 줄 하나 — 왼쪽 표식 + 이름 + 오른쪽 값.
function sideLi(lead: HTMLElement | null, label: string, value: string, href?: string): HTMLElement {
  const name = href
    ? el('a', { class: 'n', href, text: label, title: label })
    : el('span', { class: 'n', text: label, title: label });
  return el('div', { class: 'li' }, lead, name, el('span', { class: 'sp' }), el('span', { class: 'v', text: value }));
}

// ── 화면 상태(모듈 수준) ──
//  main.ts 가 20초 결로(그리고 되돌리기·완전 삭제 뒤) render* 를 통째로 다시 부르므로, 클로저에 두면 고른 것·검색어·
//  초점·[더 보기]가 20초마다 증발한다(프리뷰 실측 2026-08-27). 진행 중 잠금(busy)도 같은 이유로 여기.
const trashUi = { kind: 'all' as 'all' | 'project' | 'session', q: '', newestFirst: true, shown: PAGE, sel: new Set<string>(), focus: null as string | null };
//  「보관한 프로젝트」 모드의 고른 것·초점 — 세션 모드(pastUi)와 따로 산다(칩을 오가도 각자 자리를 지킨다).
const archUi = { sel: new Set<number>(), focus: null as number | null };
let binBusy = false;
const guard = async (fn: () => Promise<void>): Promise<void> => { if (binBusy) return; binBusy = true; try { await fn(); } finally { binBusy = false; } };

// ══════════════════════════════════ 휴지통 ══════════════════════════════════
export function renderTrash(host: HTMLElement, data: V2Data, hooks: BinHooks = {}, aside?: HTMLElement | null): void {
  // 재료 — 따로 버린 세션(묶음 표식 없음) + 통째로 버린 프로젝트(안의 세션은 bundleOf). 한 목록으로 섞는다.
  const ss = data.sessions.filter(isLooseTrashedSess);
  const tps = data.projects.filter((p) => isTrashedProj(p));
  const bundleOf = (p: Proj): Sess[] => data.sessions.filter((s) => isTrashedSess(s) && Number(s.trashedWith) === p.id).sort((a, b) => b.lastSeen - a.lastSeen);
  type Item = { kind: 'project'; key: string; at: string; p: Proj; bundle: Sess[] } | { kind: 'session'; key: string; at: string; s: Sess };
  const items: Item[] = [
    ...tps.map((p): Item => ({ kind: 'project', key: 'p:' + p.id, at: String(p.trashed_at || ''), p, bundle: bundleOf(p) })),
    ...ss.map((s): Item => ({ kind: 'session', key: 's:' + s.id, at: String(s.trashedAt || ''), s })),
  ];
  const nameOf = (it: Item): string => it.kind === 'project' ? it.p.name : (sessText(it.s, projName(data, it.s.projectId)).main || it.s.label || it.s.id);

  // 세션 하나는 이름이 둘(박스 id·대화 uuid)이라 서버 응답을 이름이 아니라 **세션 단위**로 읽는다 — 한 이름만 처리돼도 그 세션은 된 것.
  const bySession = (r: { done: string[]; skipped: Array<{ id: string; why: string }> }, list: Sess[]): { ok: Sess[]; failed: Sess[]; why: string } => {
    const done = new Set(r.done);
    const ok = list.filter((s) => sessionNames(s).some((n) => done.has(n)));
    const failed = list.filter((s) => !ok.includes(s));
    const why = failed.length ? (r.skipped.find((k) => sessionNames(failed[0]).includes(k.id))?.why || r.skipped[0]?.why || '처리된 세션이 없어요') : '';
    return { ok, failed, why };
  };
  const logSid = (s: Sess): string => s.logId || (s.stateKey === 'log' ? s.id : '');
  const logNode = (s: Sess): string => String((s.logNode ?? s.node) || '');
  const defaultChoice = { log: true, knowledge: [] as string[], revert: [] as string[], projects: [] as number[], sources: [] as number[], tasks: [] as number[], categories: [] as number[], activities: false };

  // ── 되돌리기 ──
  const restoreSession = (s: Sess): Promise<void> => guard(async () => {
    try {
      const o = bySession(await sessionTrashOp('untrash', sessionNames(s)), [s]);
      if (!o.ok.length) { toast('되돌리지 못했어요 — ' + o.why, true); return; }
      toast('지난 세션으로 되돌렸어요.');
      hooks.onChanged?.();
    } catch (e: any) { toast('되돌리지 못했어요 — ' + (e?.message || e), true); }
  });
  const restoreProject = (p: Proj): Promise<void> => guard(async () => {
    try {
      const res: any = await api('/api/ui/v6/projects/' + p.id + '/trash', { method: 'POST', body: JSON.stringify({ trashed: false }) });
      const sk = Array.isArray(res?.sessions?.skipped) ? res.sessions.skipped : [];
      toast(`「${p.name}」${eulReul(p.name)} 복원했어요 — 세션도 함께 돌아왔어요.` + (sk.length ? ` (세션 ${sk.length}개는 건너뜀 — ${sk[0].why})` : ''));
      hooks.onChanged?.();
    } catch (e: any) { toast('복원하지 못했어요 — ' + (e?.message || e), true); }
  });
  const restoreItems = (list: Item[]): Promise<void> => guard(async () => {
    if (!list.length) return;
    const sess = list.filter((i): i is Extract<Item, { kind: 'session' }> => i.kind === 'session').map((i) => i.s);
    const pjs = list.filter((i): i is Extract<Item, { kind: 'project' }> => i.kind === 'project').map((i) => i.p);
    let sessDone = 0, pjDone = 0, failed = 0; let why = '';
    if (sess.length) {
      try { const o = bySession(await sessionTrashOp('untrash', sess.flatMap((s) => sessionNames(s))), sess); sessDone = o.ok.length; if (o.failed.length) { failed += o.failed.length; why = o.why; } }
      catch (e: any) { failed += sess.length; why = e?.message || String(e); }
    }
    for (const p of pjs) {
      try { await api('/api/ui/v6/projects/' + p.id + '/trash', { method: 'POST', body: JSON.stringify({ trashed: false }) }); pjDone++; }
      catch (e: any) { failed++; why = e?.message || String(e); }
    }
    const parts: string[] = [];
    if (pjDone) parts.push(`프로젝트 ${pjDone}개`); if (sessDone) parts.push(`세션 ${sessDone}개`);
    if (!parts.length) { toast('되돌리지 못했어요 — ' + (why || '처리된 항목이 없어요'), true); return; }
    toast(parts.join(' · ') + '를 원래 자리로 되돌렸어요.' + (failed ? ` (${failed}개는 못 돌렸어요 — ${why})` : ''), failed > 0);
    trashUi.sel.clear(); hooks.onChanged?.();
  });

  // ── 완전 삭제 — 세션·프로젝트 섞어서 **한 창**. 행·곁칸·선택·묶음·비우기가 전부 이 길을 탄다. ──
  const purgeItems = (list: Item[], title: string): Promise<void> => guard(async () => {
    if (!list.length) return;
    const loose = list.filter((i): i is Extract<Item, { kind: 'session' }> => i.kind === 'session').map((i) => i.s);
    const pjs = list.filter((i): i is Extract<Item, { kind: 'project' }> => i.kind === 'project');
    const bundled = pjs.flatMap((i) => i.bundle);
    const all = [...loose, ...bundled];
    const choices = await confirmSessionPurgeMany({
      title,
      sessions: all.map((s) => ({ sid: logSid(s) || null, node: logNode(s), label: sessText(s, projName(data, s.projectId)).main || s.id })),
      projects: pjs.map((i) => ({ id: i.p.id, name: i.p.name, sessN: i.bundle.length })),
    });
    if (!choices) return;
    let logs = 0, failed = 0; const sum = { kn: 0, rv: 0, pj: 0, src: 0, tk: 0, ct: 0 };
    // ⚠ 같은 창에서 프로젝트도 지울 때, 세션 발자국의 projects 에 그 프로젝트가 있으면 세션 쪽이 먼저 지워
    //  아래 프로젝트 삭제가 404 로 헛돈다(순서 경합). 지금 지우려는 프로젝트 id 는 세션 선택에서 뺀다 —
    //  그 행은 아래 /projects/:id/purge 가 지운다(서버가 묶음 세션 결과물까지 마저 되돌린다 — #1850 P4).
    const purgingPj = new Set(pjs.map((i) => i.p.id));
    for (const s of all) {
      const sid = logSid(s); if (!sid) continue;
      try {
        const c = choices.get(sid) || defaultChoice;
        const r = await purgeSessionRecord(sid, logNode(s), { ...c, projects: c.projects.filter((id) => !purgingPj.has(id)) });
        logs++; sum.kn += r.knowledge_deleted; sum.rv += r.knowledge_reverted; sum.pj += r.projects_deleted; sum.src += r.sources_deleted; sum.tk += r.tasks_deleted; sum.ct += r.categories_deleted;
        fpCache.delete(sid);
      } catch { failed++; }
    }
    let sessDone = 0, pjDone = 0; let why = '';
    if (loose.length) {
      try { const o = bySession(await sessionTrashOp('purge', loose.flatMap((s) => sessionNames(s))), loose); sessDone = o.ok.length; if (o.failed.length) { failed += o.failed.length; why = o.why; } }
      catch (e: any) { failed += loose.length; why = e?.message || String(e); }
    }
    for (const i of pjs) {
      try { const res: any = await api('/api/ui/v6/projects/' + i.p.id + '/purge', { method: 'POST' }); pjDone++; sessDone += i.bundle.length - (Array.isArray(res?.sessions?.skipped) ? res.sessions.skipped.length : 0); }
      catch (e: any) { failed++; why = e?.message || String(e); }
    }
    const parts: string[] = [];
    if (pjDone) parts.push(`프로젝트 ${pjDone}개`); if (sessDone) parts.push(`세션 ${sessDone}개`);
    if (!parts.length) { toast('지우지 못했어요 — ' + (why || '처리된 항목이 없어요'), true); hooks.onChanged?.(); return; }
    const tail: string[] = [];
    if (logs) tail.push(`대화 기록 ${logs}건 파기`);
    if (sum.kn) tail.push(`지식 ${sum.kn}건 삭제`); if (sum.rv) tail.push(`지식 ${sum.rv}건 되돌림`);
    if (sum.pj) tail.push(`프로젝트 ${sum.pj}건 삭제`); if (sum.src) tail.push(`자료 ${sum.src}건 삭제`);
    if (sum.tk) tail.push(`태스크 ${sum.tk}건 삭제`); if (sum.ct) tail.push(`분류 ${sum.ct}건 삭제`);
    if (failed) tail.push(`⚠ ${failed}건은 지우지 못했어요${why ? ' — ' + why : ''}`);
    toast(parts.join(' · ') + '를 완전히 지웠어요.' + (tail.length ? ' ' + tail.join(' · ') : ''), failed > 0);
    trashUi.sel.clear(); hooks.onChanged?.();
  });
  // 세션 하나는 종전의 단일 창(이름·원격 노드 안내가 있다). 프로젝트·여러 개·비우기는 위 공통 창.
  const purgeSession = (s: Sess): Promise<void> => guard(async () => {
    const name = sessText(s, projName(data, s.projectId)).main || s.id;
    const sid = logSid(s);
    try {
      if (sid) {
        const choice = await confirmSessionPurge({ sid, node: logNode(s), title: `「${name}」${eulReul(name)} 완전히 지울까요?`, remoteNode: logNode(s) || null });
        if (!choice) return;
        const r = await purgeSessionRecord(sid, logNode(s), choice);
        fpCache.delete(sid);
        const m = bySession(await sessionTrashOp('purge', sessionNames(s)), [s]);
        if (!m.ok.length) { toast('대화 기록은 지웠지만 휴지통에서 빼지 못했어요 — ' + m.why, true); hooks.onChanged?.(); return; }
        toast(purgedToast(r));
      } else {
        if (!await confirmSessionPurgeLocal({ title: `「${name}」${eulReul(name)} 완전히 지울까요?` })) return;
        const m = bySession(await sessionTrashOp('purge', sessionNames(s)), [s]);
        if (!m.ok.length) { toast('지우지 못했어요 — ' + m.why, true); return; }
        toast('완전히 지웠어요.');
      }
      hooks.onChanged?.();
    } catch (e: any) { toast('지우지 못했어요 — ' + (e?.message || e), true); }
  });

  // ── 화면 상태 손질 — 그새 사라진(되돌린·지운) 항목은 선택·초점에서 뺀다 ──
  const ui = trashUi;
  const keys = new Set(items.map((i) => i.key));
  for (const k of Array.from(ui.sel)) if (!keys.has(k)) ui.sel.delete(k);
  if (ui.focus && !keys.has(ui.focus)) ui.focus = null;

  const visible = (): Item[] => {
    const needle = ui.q.trim().toLowerCase();
    return items
      .filter((i) => ui.kind === 'all' || i.kind === ui.kind)
      .filter((i) => !needle || nameOf(i).toLowerCase().includes(needle) || (i.kind === 'project' && ('#' + i.p.id).includes(needle)))
      .sort((a, b) => ui.newestFirst ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at));
  };

  // ── 조립 부품 ──
  const tblWrap = el('div', { class: 'v2-bin-tblwrap' });
  const countEl = el('span', { class: 'v2-bin-count' });
  const chipsEl = el('div', { class: 'v2-bin-chips' });
  const barEl = el('div', { class: 'v2-bin-selbar' });
  const search = el('input', { type: 'search', class: 'v2-bin-search', placeholder: '이름으로 찾기', 'aria-label': '휴지통에서 이름으로 찾기' }) as HTMLInputElement;
  search.value = ui.q;
  search.addEventListener('input', () => { ui.q = search.value; ui.shown = PAGE; paint(); });
  const sortBtn = el('button', { class: 'btn-text v2-bin-sort', type: 'button', text: ui.newestFirst ? '최근 순' : '오래된 순', title: '정렬을 바꿉니다', onclick: () => { ui.newestFirst = !ui.newestFirst; sortBtn.textContent = ui.newestFirst ? '최근 순' : '오래된 순'; paint(); } });

  const contentsOf = (it: Item): string => it.kind === 'project'
    ? (it.bundle.length ? `세션 ${it.bundle.length}` : '비어 있음')
    : (logSid(it.s) ? '대화 기록 있음' : '기록 없음');

  const paintChips = () => {
    const chip = (k: typeof ui.kind, label: string, n: number) => el('button', { class: 'v2-bin-chip' + (ui.kind === k ? ' on' : ''), type: 'button', text: `${label} ${n}`, 'aria-pressed': String(ui.kind === k), onclick: () => { ui.kind = k; ui.shown = PAGE; paint(); } });
    chipsEl.replaceChildren(chip('all', '전체', items.length), chip('project', '프로젝트', tps.length), chip('session', '세션', ss.length));
  };

  const paintBar = () => {
    const vis = visible();
    const picked = vis.filter((i) => ui.sel.has(i.key));
    barEl.replaceChildren(...(picked.length ? [
      el('span', { class: 'n', text: `${picked.length}개 선택` }),
      el('button', { class: 'btn-text', type: 'button', text: '되돌리기', onclick: () => void restoreItems(picked) }),
      el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제', onclick: () => void purgeItems(picked, `고른 ${picked.length}개를 완전히 지울까요?`) }),
      el('button', { class: 'btn-text', type: 'button', text: '선택 해제', onclick: () => { ui.sel.clear(); paint(); } }),
    ] : []), countEl);
    countEl.textContent = vis.length === items.length ? '' : `${vis.length}개 표시`;
  };

  const rowOf = (it: Item): HTMLElement => {
    const isP = it.kind === 'project';
    const name = nameOf(it);
    const tr = el('tr', { class: (ui.focus === it.key ? 'focus' : '') },
      el('td', { class: 'c-cb' }, cb(ui.sel.has(it.key), name + ' 선택', (on) => { if (on) ui.sel.add(it.key); else ui.sel.delete(it.key); paintBar(); paintAside(); })),
      el('td', { class: 'c-name' },
        isP ? folderIcon() : sessIcon(),
        isP
          ? el('span', { class: 't', text: name, title: name })
          : el('a', { class: 't', href: '#/s/' + encodeURIComponent(it.s.id), text: name, title: (it.s.label || '') + '\n세션 대화를 엽니다', onclick: (ev: Event) => ev.stopPropagation() }),
        isP ? el('span', { class: 'mono', text: `#${it.p.id}` }) : null),
      el('td', { class: 'c-kind', text: isP ? '프로젝트' : '세션' }),
      el('td', { class: 'c-in', text: contentsOf(it) }),
      el('td', { class: 'c-when' }, whenCell(it.at)),
      el('td', { class: 'c-acts' }, el('span', { class: 'acts' },
        isP
          ? el('button', { class: 'btn-text', type: 'button', text: '복원', title: '프로젝트와 함께 들어간 세션이 원래 자리로 돌아갑니다', onclick: () => void restoreProject(it.p) })
          : el('button', { class: 'btn-text', type: 'button', text: '되돌리기', title: '지난 세션으로 되돌립니다', onclick: () => void restoreSession(it.s) }),
        el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제', title: '되살릴 수 없게 지웁니다', onclick: () => isP ? void purgeItems([it], `「${name}」${eulReul(name)} 완전히 지울까요?`) : void purgeSession(it.s) }))));
    tr.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('button, input, a')) return;
      ui.focus = ui.focus === it.key ? null : it.key;
      paint();
    });
    return tr;
  };

  const paintTable = () => {
    const vis = visible();
    const head = vis.slice(0, ui.shown);
    const allOn = vis.length > 0 && vis.every((i) => ui.sel.has(i.key));
    const someOn = vis.some((i) => ui.sel.has(i.key));
    const master = cb(allOn, '보이는 항목 전체 선택', (on) => { for (const i of vis) { if (on) ui.sel.add(i.key); else ui.sel.delete(i.key); } paint(); }, someOn && !allOn);
    const body = el('tbody', {});
    let cur = '';
    for (const it of head) {
      const b = bucketOf(it.at);
      if (b !== cur) {
        cur = b;
        const grp = vis.filter((x) => bucketOf(x.at) === b);
        const gAll = grp.every((x) => ui.sel.has(x.key));
        const gSome = grp.some((x) => ui.sel.has(x.key));
        body.append(el('tr', { class: 'g' },
          el('td', { class: 'c-cb' }, cb(gAll, `${b} 전체 선택`, (on) => { for (const x of grp) { if (on) ui.sel.add(x.key); else ui.sel.delete(x.key); } paint(); }, gSome && !gAll)),
          el('td', { colspan: '4' }, el('b', { text: b }), el('span', { class: 'n', text: ` · ${grp.length}` }),
            gSome ? el('span', { class: 'n', text: ` — ${grp.filter((x) => ui.sel.has(x.key)).length}개 고름` }) : null),
          el('td', { class: 'c-acts' }, el('button', { class: 'btn-text', type: 'button', text: '이 묶음 되돌리기', title: `${b}에 버린 ${grp.length}개를 원래 자리로 되돌립니다`, onclick: () => void restoreItems(grp) }))));
      }
      body.append(rowOf(it));
    }
    tblWrap.replaceChildren(
      el('table', { class: 'v2-bin-tbl' },
        el('thead', {}, el('tr', {},
          el('th', { class: 'c-cb' }, master), el('th', { text: '이름' }), el('th', { text: '종류' }),
          el('th', { text: '안에 든 것' }), el('th', { text: '버린 때' }), el('th', {}))),
        body),
      ...(vis.length > head.length ? [el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${vis.length - head.length}개 더 보기`, onclick: () => { ui.shown += PAGE; paint(); } })] : []),
      ...(!vis.length ? [el('p', { class: 'v2-bin-empty', text: ui.q.trim() ? '찾는 이름이 없어요.' : '이 종류엔 버린 것이 없어요.' })] : []));
  };

  // ── 곁칸 — 고른 것의 합계 + 초점 항목의 안(발자국) ──
  const paintAside = () => {
    if (!aside) return;
    const box = el('div', { class: 'v2-bin-side' });
    const vis = visible();
    const picked = vis.filter((i) => ui.sel.has(i.key));
    if (picked.length > 1) {
      const pn = picked.filter((i) => i.kind === 'project').length;
      const sn = picked.length - pn;
      const bn = picked.reduce((a, i) => a + (i.kind === 'project' ? i.bundle.length : 0), 0);
      box.append(el('div', { class: 'v2-bin-side-sum' },
        el('h4', { text: `고른 ${picked.length}개` }),
        el('p', { class: 'd', text: [pn ? `프로젝트 ${pn}` : '', sn ? `세션 ${sn}` : '', bn ? `안의 세션 ${bn}` : ''].filter(Boolean).join(' · ') }),
        el('div', { class: 'act' },
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '되돌리기', onclick: () => void restoreItems(picked) }),
          el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제…', onclick: () => void purgeItems(picked, `고른 ${picked.length}개를 완전히 지울까요?`) }))));
    }
    const it = items.find((x) => x.key === ui.focus) || (picked.length === 1 ? picked[0] : null);
    if (!it) {
      if (!picked.length) box.append(el('p', { class: 'v2-bin-side-hint', text: '행을 누르면 그 안에 든 것이 여기 열립니다. 지우기 전에 확인하세요.' }));
      aside.replaceChildren(box);
      return;
    }
    const name = nameOf(it);
    const detail = el('div', { class: 'v2-bin-side-detail' });
    if (it.kind === 'project') {
      detail.append(
        el('div', { class: 'h' }, folderIcon(), el('b', { text: name }), el('span', { class: 'tag', text: `#${it.p.id}` })),
        el('p', { class: 'meta', text: `버림 ${when(it.p.trashed_at)} · 함께 들어간 세션 ${it.bundle.length}개` }));
      if (it.bundle.length) {
        detail.append(el('h5', { text: '함께 들어간 세션' }));
        for (const s of it.bundle.slice(0, 8)) detail.append(sideLi(dot(s.stateKey), sessText(s, it.p.name).main || s.id, s.stateLabel, '#/s/' + encodeURIComponent(s.id)));
        if (it.bundle.length > 8) detail.append(el('p', { class: 'meta', text: `외 ${it.bundle.length - 8}개 — 복원하면 전부 돌아와요.` }));
      }
      detail.append(el('div', { class: 'act' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '복원', onclick: () => void restoreProject(it.p) }),
        el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제…', onclick: () => void purgeItems([it], `「${name}」${eulReul(name)} 완전히 지울까요?`) })));
      // 안에 든 결과물(발자국) — 묶음 세션 것을 모아 이름까지. 읽는 동안·실패도 말한다(빈 채로 두면 고장으로 읽힌다).
      const fpBox = el('div', { class: 'fp' });
      detail.append(fpBox);
      const sids = it.bundle.map((s) => ({ sid: logSid(s), node: logNode(s) })).filter((x) => x.sid).slice(0, 10);
      if (sids.length) {
        fpBox.append(el('p', { class: 'meta', text: '안에 든 지식·자료를 확인하는 중…' }));
        void Promise.all(sids.map((x) => fpOf(x.sid, x.node))).then((fps) => {
          if (ui.focus !== it.key || !aside.contains(fpBox)) return;
          fpBox.replaceChildren();
          paintFp(fpBox, fps.filter((x): x is Footprint => !!x), { logs: sids.length, failed: fps.filter((x) => !x).length });
        });
      } else fpBox.append(el('p', { class: 'meta', text: '함께 들어간 세션에 중앙 대화 기록이 없어요 — 지워도 지식·자료 변화가 없어요.' }));
    } else {
      const s = it.s;
      detail.append(
        el('div', { class: 'h' }, sessIcon(), el('b', { text: name })),
        el('p', { class: 'meta', text: `버림 ${when(s.trashedAt)} · ${s.stateLabel} · ${whenMs(s.lastSeen)}` }),
        el('div', { class: 'act' },
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '되돌리기', onclick: () => void restoreSession(s) }),
          el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제…', onclick: () => void purgeSession(s) }),
          el('a', { class: 'btn-text', href: '#/s/' + encodeURIComponent(s.id), text: '대화 열기 →' })));
      const sid = logSid(s);
      const fpBox = el('div', { class: 'fp' });
      detail.append(fpBox);
      if (sid) {
        fpBox.append(el('p', { class: 'meta', text: '이 세션이 남긴 것을 확인하는 중…' }));
        void fpOf(sid, logNode(s)).then((fp) => {
          if (ui.focus !== it.key || !aside.contains(fpBox)) return;
          fpBox.replaceChildren();
          paintFp(fpBox, fp ? [fp] : [], { logs: 1, failed: fp ? 0 : 1 });
        });
      } else fpBox.append(el('p', { class: 'meta', text: '중앙 대화 기록이 없는 세션이에요 — 지워도 기록·지식 변화가 없어요.' }));
    }
    box.append(detail);
    aside.replaceChildren(box);
  };
  // 발자국 → 곁칸. **확인창과 똑같은 판정(splitFootprint)** 으로 세 단락을 그린다 — 지워지는 것 / 이전으로 돌아가는 것 /
  //  남는 것(이유까지). 원준 2026-08-27: "삭제하면 어떤 지식·자료가 삭제되고 바뀌는지 제대로 안 보인다" — 개수 요약이
  //  아니라 **이름과 결과**를 창을 열기 전에 보여 준다. 판정 함수를 공유하므로 곁칸과 확인창이 어긋날 수 없다.
  const paintFp = (boxEl: HTMLElement, fps: Footprint[], meta?: { logs: number; failed: number }) => {
    // 못 읽은 세션이 있으면 정직하게 — 빈 목록을 '없다'로 단언하지 않는다.
    if (meta && meta.failed > 0 && !fps.length) {
      boxEl.append(el('p', { class: 'meta', text: '안에 든 것을 확인하지 못했어요 — [완전 삭제…]를 누르면 창에서 다시 확인해요.' }));
      return;
    }
    const { groups, keep } = splitFootprint(fps);
    const li = (label: string, value: string) => boxEl.append(sideLi(null, label, value));
    const items = (kind: string, cap: number, value: string): number => {
      const g = groups.find((x) => x.kind === kind);
      if (!g) return 0;
      if (g.items.length) {
        for (const x of g.items.slice(0, cap)) li(x.label, value);
        if (g.items.length > cap) boxEl.append(el('p', { class: 'meta', text: `외 ${g.items.length - cap}건 ${value}` }));
      } else li(g.title.replace(/ 지우기$/, ''), value);
      return g.count;
    };
    // ① 지워지는 것 — 대화 기록부터(이 흐름의 출발점), 그다음 만든 것들 이름으로.
    boxEl.append(el('h5', { text: '완전히 지우면 사라지는 것' }));
    if (meta?.logs) li(meta.logs > 1 ? `대화 기록 ${meta.logs}개 세션` : '이 세션의 대화 기록', '파기');
    const delN = items('kc', 5, '지식 삭제') + items('src', 3, '자료 삭제') + items('tk', 3, '태스크 삭제') + items('ct', 2, '분류 삭제') + items('ac', 0, '작업 기록 삭제');
    // ② 이전으로 돌아가는 것 — 고친 지식은 지우는 게 아니라 이 세션이 고치기 전 내용으로.
    const ke = groups.find((x) => x.kind === 'ke');
    if (ke) {
      boxEl.append(el('h5', { text: '이 세션이 고치기 전으로 돌아가는 것' }));
      for (const x of ke.items.slice(0, 4)) li(x.label, '되돌림');
      if (ke.items.length > 4) boxEl.append(el('p', { class: 'meta', text: `외 ${ke.items.length - 4}건 되돌림` }));
    }
    // ③ 남는 것 — 남이 손댄 것(이유), 그리고 폴더의 파일·커밋.
    if (keep.length) {
      boxEl.append(el('h5', { text: '남는 것' }));
      for (const k of keep.slice(0, 4)) boxEl.append(el('div', { class: 'li' }, el('span', { class: 'n', text: k.label, title: k.label }), el('span', { class: 'sp' }), el('span', { class: 'v keep', text: k.why })));
      if (keep.length > 4) boxEl.append(el('p', { class: 'meta', text: `외 ${keep.length - 4}건 남아요` }));
    }
    if (!delN && !ke && !keep.length) {
      boxEl.append(el('p', { class: 'meta', text: '이 세션이 만든 지식·자료·작업 기록은 찾지 못했어요 — 대화 기록만 지워져요.' }));
      return;
    }
    boxEl.append(el('p', { class: 'meta', text: (meta && meta.failed > 0 ? `세션 ${meta.failed}개는 확인하지 못했어요. ` : '') + '남길 것은 [완전 삭제…] 창에서 체크로 고를 수 있어요.' }));
  };

  const paint = () => { paintChips(); paintTable(); paintBar(); paintAside(); };

  const empty = !items.length;
  const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('v2-bin-search');
  const scrollTop = host.scrollTop;
  host.replaceChildren(el('div', { class: 'v2-center v2-binpage wide' },
    el('div', { class: 'v2-bin-top' },
      el('div', {},
        el('h1', { class: 'v2-title', text: '휴지통' }),
        el('p', { class: 'v2-desc', text: '버린 프로젝트와 세션이 버린 순서대로 있어요. [복원]·[되돌리기]면 원래 자리로 돌아가고, 완전히 지우는 건 여기서만 할 수 있어요.' }),
        // '다음부터 묻지 않기'(confirmSessionTrash)를 켜 둔 사람에게 되돌리는 문 — 확인창이 더는 안 뜨니 여기가 유일한 자리다.
        trashConfirmSkipped() ? el('p', { class: 'v2-desc v2-bin-skipnote' },
          el('span', { text: '휴지통으로 보낼 때 묻지 않고 바로 보내도록 해 두셨어요. ' }),
          el('button', { class: 'btn-text', type: 'button', text: '다시 묻기', onclick: (ev: Event) => { setTrashConfirmSkipped(false); (ev.currentTarget as HTMLElement).closest('p')?.remove(); toast('다음부터 휴지통으로 보낼 때 다시 확인해요.'); } })) : null),
      empty ? null : el('button', { class: 'btn btn-ghost btn-sm v2-bin-emptyb', type: 'button', text: '휴지통 비우기', title: '휴지통의 프로젝트·세션을 전부 완전히 지웁니다', onclick: () => void purgeItems(items, '휴지통을 비울까요?') })),
    empty
      ? el('div', { class: 'v2-inbox-empty' }, el('p', { class: 'h', text: '휴지통이 비어 있어요.' }),
          el('p', { class: 'sub', text: '프로젝트는 사이드바 행 오른쪽 클릭 ▸ [휴지통으로 보내기], 세션은 [지난 세션] 행의 휴지통 단추로 보낼 수 있어요.' }))
      : el('section', { class: 'v2-bin-sec' },
          el('div', { class: 'v2-bin-tools' }, chipsEl, el('span', { class: 'sp' }), search, sortBtn),
          barEl, tblWrap),
    el('p', { class: 'v2-bin-fine', text: '지식·카테고리를 삭제한 것은 WIKI 앱의 휴지통에 있어요.' },
      el('a', { class: 'btn-text', href: location.pathname + '?ui=classic#/trash', target: '_blank', rel: 'noopener', text: '열기 ↗' }))));
  if (!empty) paint();
  else if (aside) aside.replaceChildren();
  if (hadFocus && !empty) { search.focus(); const n = search.value.length; try { search.setSelectionRange(n, n); } catch { /* 일부 브라우저는 search 타입에 거부 */ } }
  if (scrollTop) host.scrollTop = scrollTop;
}

// ══════════════════════════════ 지난 세션 (#/archive) ══════════════════════════════
//  원준 2026-09-19: "x 를 누르면 아카이브로 보내지 말고 지난 세션으로 보내. 아카이브라는 곳을 없애고 그냥 지난 세션을
//   볼 수 있는 창으로 하는 게 좋겠음. 그 안에서도 프로젝트 단위로 묶어서 보거나 각종 필터 걸려서 쉽게 볼 수 있게."
//
//  ★ 종전엔 이 자리가 「아카이브」였고, 담는 것이 **보관한 프로젝트**였다. 그래서 세션의 두 축이 갈 곳을 잃었다:
//   · 박스가 없는 세션(실행 축)은 홈에서 흐리게 보일 뿐 모아 보는 자리가 없었다(실측 2026-09-19: 원준 계정 213건).
//   · × 로 치운 세션(보임 축)은 이 화면 발치의 「치운 세션」 표에만 있었고, × 툴팁이 그걸 «아카이브»라고 불렀다 —
//     사람에겐 «보관함에 넣었다» 로 읽혔다.
//  ⇒ 이 화면의 주인공을 **세션**으로 바꾼다. 두 축을 한 표에 싣고(가름은 칩), 보관한 프로젝트는 같은 화면의 딴 모드로 남긴다.
//   잣대는 lib/past-sess.ts 한 자리에 있다(순수 함수 — scripts/past-sess.test.mjs 가 값으로 지킨다).
//  ⚠ 주소(#/archive)는 그대로다 — 열어 둔 탭·고정한 자리가 그 문자열을 들고 있다. 바꾸면 그 창들이 빈 화면이 된다.
//  ⚠ 「내 세션」만 싣는다 — 여기서 하는 일(이어서 열기·목록으로 되돌리기·휴지통으로)이 전부 주인의 몫이다.
//   남의 세션은 프로젝트 화면 ▸ [지난 세션] 칸에서 본다.
let dismissedCache: DismissedSession[] = [];
let dismissedAt = 0;
let dismissedLoading = false;
/** 치운 세션 재료(#3857) — 전용 창구 하나. 이 화면이 20초마다 다시 그려져도 15초 안엔 다시 부르지 않는다. */
function ensureDismissed(repaint: () => void): void {
  if (dismissedLoading || Date.now() - dismissedAt <= 15_000) return;
  dismissedLoading = true;
  void listDismissedSessions()
    .then((rows) => { dismissedCache = rows; dismissedAt = Date.now(); })
    .catch(() => { /* 못 받았으면 직전 판을 그대로 둔다 */ })
    .finally(() => { dismissedLoading = false; repaint(); });
}

/** 한 줄이 들고 있는 것 — 세션 행(내 세션)과, 세션 목록엔 없고 치움 기록만 남은 행을 같은 모양으로 만든다. */
interface PastItem extends PastSessLike {
  key: string; name: string; stateKey: string; stateLabel: string; s: Sess | null; dismissed: boolean;
}

/** 화면 상태 — 모듈 수준인 이유는 trashUi 와 같다(20초 결로가 render 를 통째로 다시 부른다). */
const pastUi = {
  mode: 'sess' as 'sess' | 'proj',      // 세션 보기 / 보관한 프로젝트 보기
  scope: 'all' as PastScope,
  period: 'all' as PastPeriod,
  group: true,                          // 프로젝트로 묶기(끄면 날짜 묶음)
  q: '', newestFirst: true, shown: PAGE,
  sel: new Set<string>(), focus: null as string | null,
  closed: new Set<number>(),            // 접어 둔 프로젝트 묶음
};

export function renderPast(host: HTMLElement, data: V2Data, hooks: BinHooks = {}, aside?: HTMLElement | null): void {
  const ui = pastUi;
  const now = Date.now();
  const dism = new Set(dismissedCache.map((d) => String(d.session_id || '')).filter(Boolean));
  const archProjs = data.projects.filter((p) => isArchivedProj(p) && !isTrashedProj(p));   // 버린 것은 휴지통이 맡는다

  // ── 재료 ──
  const items: PastItem[] = [];
  const known = new Set<string>();
  for (const s of data.sessions) {
    if (!s.owned || isTrashedSess(s)) continue;
    if (!standsInPast(s, dism)) continue;
    const it: PastItem = {
      id: s.id, logId: s.logId || null, altIds: s.altIds, projectId: s.projectId,
      live: s.live, alive: s.alive, trashedAt: s.trashedAt || null, lastSeen: s.lastSeen,
      key: s.id, name: sessText(s, projName(data, s.projectId)).main || s.label || s.id,
      stateKey: s.stateKey, stateLabel: s.stateLabel, s, dismissed: isDismissedSess(s, dism),
    };
    items.push(it);
    for (const n of pastNames(it)) known.add(n);
  }
  //  세션 목록엔 없고 치움 기록만 남은 줄 — 그래도 세운다(치운 것이 «어디에도 없는» 상태가 #3857 이 고친 그 증상이다).
  //  ⚠ 서버가 gone 이라 한 것은 뺀다 — 되살릴 수도 열 수도 없어 되돌려도 설 자리가 없다.
  for (const d of dismissedCache) {
    const sid = String(d.session_id || '');
    if (!sid || known.has(sid) || d.subject_state === 'gone') continue;
    known.add(sid);
    items.push({
      id: sid, projectId: d.subject_project_id ?? null, live: false, alive: false, trashedAt: null,
      lastSeen: Date.parse(String(d.closed_at || '')) || 0,
      key: sid, name: String(d.subject_label || d.title || sid), stateKey: 'log', stateLabel: '기록', s: null, dismissed: true,
    });
  }

  const needle = ui.q.trim().toLowerCase();
  const hay = (it: PastItem): string => `${it.name} ${projName(data, it.projectId ?? null)} ${it.id}`.toLowerCase();
  const visible = (): PastItem[] => selectPast(items, {
    dismissed: dism, scope: ui.scope, period: ui.period, now, newestFirst: ui.newestFirst,
    match: needle ? (it: PastItem) => hay(it).includes(needle) : undefined,
  });
  const dismN = items.filter((it) => it.dismissed).length;

  // 고른 것 청소 — 다시 그릴 때 사라진 줄은 선택에서도 뺀다.
  const keys = new Set(items.map((it) => it.key));
  for (const k of Array.from(ui.sel)) if (!keys.has(k)) ui.sel.delete(k);
  if (ui.focus && !keys.has(ui.focus)) ui.focus = null;

  // ── 동작 ──
  const restoreRows = (list: PastItem[]): Promise<void> => guard(async () => {
    const ids = [...new Set(list.flatMap((it) => pastNames(it)))];
    if (!ids.length) return;
    try { await restoreDismissedSessions(ids); }
    catch (e: any) { toast('되돌리지 못했어요 — ' + (e?.message || e), true); return; }
    toast(list.length === 1 ? `「${list[0].name}」${eulReul(list[0].name)} 홈 목록으로 되돌렸어요.` : `세션 ${list.length}개를 홈 목록으로 되돌렸어요.`);
    ui.sel.clear(); dismissedAt = 0; hooks.onChanged?.();
  });
  const trashRows = (list: PastItem[]): Promise<void> => guard(async () => {
    const names = [...new Set(list.flatMap((it) => (it.s ? sessionNames(it.s) : [it.id])))];
    if (!names.length) return;
    try {
      const out = await sessionTrashOp('trash', names);
      if (!out.done.length) { toast('휴지통으로 보내지 못했어요 — ' + (out.skipped[0]?.why || '처리된 세션이 없어요'), true); return; }
    } catch (e: any) { toast('휴지통으로 보내지 못했어요 — ' + (e?.message || e), true); return; }
    toast((list.length === 1 ? `「${list[0].name}」${eulReul(list[0].name)}` : `세션 ${list.length}개를`) + ' 휴지통으로 보냈어요 — 휴지통에서 되돌릴 수 있어요.');
    ui.sel.clear(); dismissedAt = 0; hooks.onChanged?.();
  });

  // ── 조각 ──
  const tblWrap = el('div', { class: 'v2-bin-tblwrap' });
  const chipsEl = el('div', { class: 'v2-bin-chips' });
  const toolsEl = el('div', { class: 'v2-bin-tools' });
  const barEl = el('div', { class: 'v2-bin-selbar' });
  const countEl = el('span', { class: 'v2-bin-count' });
  const search = el('input', { type: 'search', class: 'v2-bin-search', placeholder: '세션·프로젝트 이름으로 찾기', 'aria-label': '지난 세션에서 찾기' }) as HTMLInputElement;
  search.value = ui.q;
  search.addEventListener('input', () => { ui.q = search.value; ui.shown = PAGE; paint(); });

  const chip = (on: boolean, label: string, n: number, onclick: () => void) =>
    el('button', { class: 'v2-bin-chip' + (on ? ' on' : ''), type: 'button', text: `${label} ${n}`, 'aria-pressed': String(on), onclick });
  const paintChips = () => {
    chipsEl.replaceChildren(
      chip(ui.mode === 'sess' && ui.scope === 'all', '전체', items.length, () => { ui.mode = 'sess'; ui.scope = 'all'; ui.shown = PAGE; paint(); }),
      chip(ui.mode === 'sess' && ui.scope === 'dismissed', '치운 것', dismN, () => { ui.mode = 'sess'; ui.scope = 'dismissed'; ui.shown = PAGE; paint(); }),
      //  ★ 보관한 프로젝트는 **없어지지 않는다** — 자리만 이 화면 안의 딴 모드로 옮겼다(사이드바 ▸ 프로젝트 우클릭 ▸ [보관하기]의 도착지).
      chip(ui.mode === 'proj', '보관한 프로젝트', archProjs.length, () => { ui.mode = 'proj'; ui.shown = PAGE; paint(); }));
  };
  const paintTools = () => {
    if (ui.mode === 'proj') { toolsEl.replaceChildren(chipsEl); return; }
    const period = el('select', { class: 'v2-bin-pick', 'aria-label': '기간', onchange: (e: Event) => { ui.period = (e.target as HTMLSelectElement).value as PastPeriod; ui.shown = PAGE; paint(); } },
      ...PAST_PERIODS.map((p) => el('option', { value: p.key, text: p.label, ...(p.key === ui.period ? { selected: 'selected' } : {}) }))) as HTMLSelectElement;
    period.value = ui.period;
    const grpBtn = el('button', { class: 'v2-bin-chip' + (ui.group ? ' on' : ''), type: 'button', text: '프로젝트로 묶기',
      'aria-pressed': String(ui.group), title: ui.group ? '끄면 시간 순서로 늘어놓습니다' : '프로젝트마다 묶어서 보여 줍니다',
      onclick: () => { ui.group = !ui.group; ui.shown = PAGE; paint(); } });
    const sortBtn = el('button', { class: 'btn-text v2-bin-sort', type: 'button', text: ui.newestFirst ? '최근 순' : '오래된 순', title: '정렬을 바꿉니다',
      onclick: () => { ui.newestFirst = !ui.newestFirst; paint(); } });
    toolsEl.replaceChildren(chipsEl, period, grpBtn, el('span', { class: 'sp' }), search, sortBtn);
  };
  const paintBar = () => {
    const vis = visible();
    const picked = vis.filter((it) => ui.sel.has(it.key));
    const anyDism = picked.some((it) => it.dismissed);
    barEl.replaceChildren(...(picked.length ? [
      el('span', { class: 'n', text: `${picked.length}개 선택` }),
      anyDism ? el('button', { class: 'btn-text', type: 'button', text: '홈 목록으로', title: '홈 목록에 다시 세웁니다', onclick: () => void restoreRows(picked.filter((it) => it.dismissed)) }) : null,
      el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void trashRows(picked) }),
      el('button', { class: 'btn-text', type: 'button', text: '선택 해제', onclick: () => { ui.sel.clear(); paint(); } }),
    ] : []), countEl);
    countEl.textContent = vis.length === items.length ? `${items.length}개` : `${vis.length}개 표시 · 전체 ${items.length}`;
  };

  const rowOf = (it: PastItem): HTMLElement => {
    const tr = el('tr', { class: (ui.focus === it.key ? 'focus' : '') + (it.dismissed ? ' dism' : '') },
      el('td', { class: 'c-cb' }, cb(ui.sel.has(it.key), it.name + ' 선택', (on) => { if (on) ui.sel.add(it.key); else ui.sel.delete(it.key); paintBar(); paintAside(); })),
      el('td', { class: 'c-name' }, sessIcon(),
        el('a', { class: 't', href: '#/s/' + encodeURIComponent(it.key), text: it.name, title: '세션을 엽니다 — 그때 대화를 그대로 이어서 계속할 수 있어요', onclick: (ev: Event) => { ev.stopPropagation(); dismissedAt = 0; } }),
        it.dismissed ? el('span', { class: 'v2-bin-tag', text: '치움', title: '내가 홈 목록에서 치운 세션이에요 — [홈 목록으로]를 누르면 다시 섭니다' }) : null),
      ...(ui.group ? [] : [el('td', { class: 'c-in' }, el('span', { text: it.projectId ? projName(data, it.projectId) : '프로젝트 없음' }))]),
      el('td', { class: 'c-kind' }, dot(it.stateKey), el('span', { text: it.stateLabel || '지난 세션' })),
      el('td', { class: 'c-when' }, el('span', { class: 'm', text: whenMs(Number(it.lastSeen) || 0), title: it.lastSeen ? new Date(Number(it.lastSeen)).toLocaleString() : '' })),
      el('td', { class: 'c-acts' }, el('span', { class: 'acts' },
        it.dismissed ? el('button', { class: 'btn-text', type: 'button', text: '홈 목록으로', title: '홈 목록에 다시 세웁니다', onclick: () => void restoreRows([it]) }) : null,
        el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', title: '휴지통으로 보냅니다 — 되돌릴 수 있어요', onclick: () => void trashRows([it]) }))));
    tr.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('button, input, a')) return;
      ui.focus = ui.focus === it.key ? null : it.key;
      paint();
    });
    return tr;
  };

  //  묶음 머리줄 — 프로젝트로 묶었으면 프로젝트(접을 수 있다), 아니면 날짜.
  const projHead = (g: { id: number; rows: PastItem[] }): HTMLElement => {
    const p = g.id ? data.projects.find((x) => x.id === g.id) : null;
    const closed = ui.closed.has(g.id);
    const name = g.id ? (p ? p.name : `#${g.id}`) : '프로젝트 없음';
    const sel = g.rows.every((it) => ui.sel.has(it.key));
    return el('tr', { class: 'g' + (closed ? ' closed' : '') },
      el('td', { class: 'c-cb' }, cb(sel, `${name} 전체 선택`, (on) => { for (const it of g.rows) { if (on) ui.sel.add(it.key); else ui.sel.delete(it.key); } paint(); }, !sel && g.rows.some((it) => ui.sel.has(it.key)))),
      el('td', { colspan: '3' },
        el('button', { class: 'v2-bin-gt', type: 'button', 'aria-expanded': String(!closed), title: closed ? '펴기' : '접기',
          onclick: () => { if (closed) ui.closed.delete(g.id); else ui.closed.add(g.id); paint(); } },
          el('span', { class: 'v2-car', 'aria-hidden': 'true', text: '›' }), folderIcon(), el('b', { text: name })),
        p && isArchivedProj(p) ? el('span', { class: 'v2-bin-tag', text: '보관됨', title: '보관한 프로젝트예요 — [보관한 프로젝트] 칩에서 해제할 수 있어요' }) : null,
        el('span', { class: 'n', text: ` · ${g.rows.length}` })),
      el('td', { class: 'c-acts' }, g.id
        ? el('a', { class: 'btn-text', href: '#/p/' + g.id, text: '프로젝트 열기 →', title: '그 프로젝트 화면을 엽니다' })
        : null));
  };

  const paintTable = () => {
    const vis = visible();
    const body = el('tbody', {});
    let drawn = 0;
    if (ui.group) {
      const groups = groupPastByProject(vis);
      for (const g of groups) {
        if (drawn >= ui.shown) break;
        body.append(projHead(g));
        if (ui.closed.has(g.id)) continue;
        for (const it of g.rows) {
          if (drawn >= ui.shown) break;
          body.append(rowOf(it)); drawn++;
        }
      }
    } else {
      let cur = '';
      for (const it of vis.slice(0, ui.shown)) {
        const b = bucketOf(new Date(Number(it.lastSeen) || 0).toISOString());
        if (b !== cur) {
          cur = b;
          const grp = vis.filter((x) => bucketOf(new Date(Number(x.lastSeen) || 0).toISOString()) === b);
          const gAll = grp.every((x) => ui.sel.has(x.key));
          body.append(el('tr', { class: 'g' },
            el('td', { class: 'c-cb' }, cb(gAll, `${b} 전체 선택`, (on) => { for (const x of grp) { if (on) ui.sel.add(x.key); else ui.sel.delete(x.key); } paint(); }, !gAll && grp.some((x) => ui.sel.has(x.key)))),
            el('td', { colspan: '4' }, el('b', { text: b }), el('span', { class: 'n', text: ` · ${grp.length}` }))));
        }
        body.append(rowOf(it)); drawn++;
      }
    }
    const allOn = vis.length > 0 && vis.every((it) => ui.sel.has(it.key));
    const master = cb(allOn, '보이는 세션 전체 선택', (on) => { for (const it of vis) { if (on) ui.sel.add(it.key); else ui.sel.delete(it.key); } paint(); }, !allOn && vis.some((it) => ui.sel.has(it.key)));
    const left = vis.length - drawn;
    tblWrap.replaceChildren(
      el('table', { class: 'v2-bin-tbl arch past' },
        el('thead', {}, el('tr', {},
          el('th', { class: 'c-cb' }, master), el('th', { text: '세션' }),
          ...(ui.group ? [] : [el('th', { text: '프로젝트' })]),
          el('th', { text: '상태' }), el('th', { text: '마지막' }), el('th', {}))),
        body),
      ...(left > 0 ? [el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${left}개 더 보기`, onclick: () => { ui.shown += PAGE; paint(); } })] : []),
      ...(!vis.length ? [el('p', { class: 'v2-bin-empty', text: dismissedLoading && !dismissedAt ? '불러오는 중…' : needle || ui.period !== 'all' || ui.scope !== 'all' ? '이 조건엔 없어요 — 칩이나 기간을 바꿔 보세요.' : '지난 세션이 없어요. 세션이 멈추거나 × 로 치우면 여기 모입니다.' })] : []));
  };

  const paintAside = () => {
    if (!aside) return;
    const box = el('div', { class: 'v2-bin-side' });
    const vis = visible();
    const picked = vis.filter((it) => ui.sel.has(it.key));
    if (picked.length > 1) {
      box.append(el('div', { class: 'v2-bin-side-sum' },
        el('h4', { text: `고른 ${picked.length}개` }),
        el('p', { class: 'd', text: `치운 것 ${picked.filter((it) => it.dismissed).length} · 멈춘 것 ${picked.filter((it) => !it.dismissed).length}` }),
        el('div', { class: 'act' },
          picked.some((it) => it.dismissed) ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '홈 목록으로', onclick: () => void restoreRows(picked.filter((it) => it.dismissed)) }) : null,
          el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void trashRows(picked) }))));
    }
    const it = items.find((x) => x.key === ui.focus) || (picked.length === 1 ? picked[0] : null);
    if (!it) {
      if (!picked.length) box.append(el('p', { class: 'v2-bin-side-hint', text: '행을 누르면 그 세션의 안이 여기 열립니다. 이름을 누르면 그 대화를 이어서 계속할 수 있어요.' }));
      aside.replaceChildren(box);
      return;
    }
    const detail = el('div', { class: 'v2-bin-side-detail' },
      el('div', { class: 'h' }, sessIcon(), el('b', { text: it.name }), it.dismissed ? el('span', { class: 'tag', text: '치움' }) : null),
      el('p', { class: 'meta', text: `${it.projectId ? projName(data, it.projectId) : '프로젝트 없음'} · ${it.stateLabel || '지난 세션'} · 마지막 ${whenMs(Number(it.lastSeen) || 0)}` }));
    detail.append(el('div', { class: 'act' },
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/s/' + encodeURIComponent(it.key), text: '이어서 열기', onclick: () => { dismissedAt = 0; } }),
      it.dismissed ? el('button', { class: 'btn-text', type: 'button', text: '홈 목록으로', onclick: () => void restoreRows([it]) }) : null,
      el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void trashRows([it]) }),
      it.projectId ? el('a', { class: 'btn-text', href: '#/p/' + it.projectId, text: '프로젝트 열기 →' }) : null));
    box.append(detail);
    aside.replaceChildren(box);
  };

  const paint = () => {
    if (ui.mode === 'proj') { paintChips(); paintTools(); archivedProjects(tblWrap, barEl, countEl, data, hooks, aside, paint); return; }
    paintChips(); paintTools(); paintTable(); paintBar(); paintAside();
  };

  const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('v2-bin-search');
  const scrollTop = host.scrollTop;
  host.replaceChildren(el('div', { class: 'v2-center v2-binpage wide' },
    el('div', { class: 'v2-bin-top' },
      el('div', {},
        el('h1', { class: 'v2-title', text: '지난 세션' }),
        el('p', { class: 'v2-desc', text: '박스가 멈춰 지금은 안 도는 세션과, 홈 목록에서 × 로 치운 세션이에요. 이름을 누르면 그때 대화를 그대로 이어서 계속할 수 있어요.' }))),
    el('section', { class: 'v2-bin-sec' }, toolsEl, barEl, tblWrap)));
  paint();
  ensureDismissed(() => { if (host.isConnected) renderPast(host, data, hooks, aside); });
  if (hadFocus) { search.focus(); const n = search.value.length; try { search.setSelectionRange(n, n); } catch { /* 일부 브라우저는 search 타입에 거부 */ } }
  if (scrollTop) host.scrollTop = scrollTop;
}

// ── 같은 화면의 딴 모드: 보관한 프로젝트 ────────────────────────────────────────
//  통째로 치워 둔 프로젝트와 그 아래 세션. 동사는 둘(보관 해제 · 휴지통으로) — 여기엔 파괴 동사가 없다.
//  ⚠ 「아카이브」라는 **자리**는 없앴지만 프로젝트 보관 자체는 그대로다(사이드바 우클릭 ▸ [보관하기]).
//   그 도착지가 이 모드다 — 없애면 보관한 프로젝트를 되돌릴 길이 사라진다.
function archivedProjects(tblWrap: HTMLElement, barEl: HTMLElement, countEl: HTMLElement, data: V2Data, hooks: BinHooks, aside: HTMLElement | null | undefined, repaint: () => void): void {
  const projs = data.projects.filter((p) => isArchivedProj(p) && !isTrashedProj(p));
  const sessOf = (p: Proj): Sess[] => data.sessions.filter((s) => Number(s.projectId) === p.id && !isTrashedSess(s))
    .sort((a, b) => Number(isLiveSess(b)) - Number(isLiveSess(a)) || b.lastSeen - a.lastSeen);
  const liveOf = (p: Proj): number => sessOf(p).filter(isLiveSess).length;

  const ui = archUi;
  const ids = new Set(projs.map((p) => p.id));
  for (const k of Array.from(ui.sel)) if (!ids.has(k)) ui.sel.delete(k);
  if (ui.focus != null && !ids.has(ui.focus)) ui.focus = null;

  const unarchive = (list: Proj[]): Promise<void> => guard(async () => {
    let done = 0, failed = 0; let why = '';
    for (const p of list) {
      try { await api('/api/ui/v6/projects/' + p.id + '/archive', { method: 'POST', body: JSON.stringify({ archived: false }) }); done++; }
      catch (e: any) { failed++; why = e?.message || String(e); }
    }
    if (!done) { toast('보관을 해제하지 못했어요 — ' + (why || '처리된 프로젝트가 없어요'), true); return; }
    toast((list.length === 1 ? `「${list[0].name}」 보관을 해제했어요 — 사이드바로 돌아왔어요.` : `프로젝트 ${done}개의 보관을 해제했어요.`) + (failed ? ` (${failed}개 실패 — ${why})` : ''), failed > 0);
    ui.sel.clear(); hooks.onChanged?.();
  });
  // 휴지통으로 — 잃는 것이 없다(표식이 붙어 휴지통으로 갈 뿐, 복원 가능) → 확인창 없이 바로(#1582).
  //  단 남의 도는 세션이 있으면 서버가 409 로 막는다 — 그 이유를 그대로 보여 준다.
  const toTrash = (list: Proj[]): Promise<void> => guard(async () => {
    let done = 0, failed = 0; let why = '';
    for (const p of list) {
      try { await api('/api/ui/v6/projects/' + p.id + '/trash', { method: 'POST', body: JSON.stringify({ trashed: true }) }); done++; }
      catch (e: any) { failed++; why = e?.message || String(e); }
    }
    if (!done) { toast('휴지통으로 보내지 못했어요 — ' + (why || '처리된 프로젝트가 없어요'), true); return; }
    toast((list.length === 1 ? `「${list[0].name}」${eulReul(list[0].name)}` : `프로젝트 ${done}개를`) + ' 휴지통으로 보냈어요 — 휴지통에서 되돌릴 수 있어요.' + (failed ? ` (${failed}개 실패 — ${why})` : ''), failed > 0);
    ui.sel.clear(); hooks.onChanged?.();
  });

  const visible = (): Proj[] => projs.slice().sort((a, b) => String(b.archived_at || '').localeCompare(String(a.archived_at || '')));

  const rowOf = (p: Proj): HTMLElement => {
    const ss = sessOf(p); const live = liveOf(p);
    const tr = el('tr', { class: (ui.focus === p.id ? 'focus' : '') },
      el('td', { class: 'c-cb' }, cb(ui.sel.has(p.id), p.name + ' 선택', (on) => { if (on) ui.sel.add(p.id); else ui.sel.delete(p.id); repaint(); })),
      el('td', { class: 'c-name' }, folderIcon(),
        el('a', { class: 't', href: '#/p/' + p.id, text: p.name, title: '프로젝트 화면을 엽니다', onclick: (ev: Event) => ev.stopPropagation() }),
        el('span', { class: 'mono', text: `#${p.id}` })),
      el('td', { class: 'c-in' }, live ? dot('busy') : null, el('span', { text: ss.length ? `${ss.length}${live ? ` · 도는 중 ${live}` : ''}` : '없음' })),
      el('td', { class: 'c-when' }, whenCell(p.archived_at)),
      el('td', { class: 'c-acts' }, el('span', { class: 'acts' },
        el('button', { class: 'btn-text', type: 'button', text: '보관 해제', title: '원래 자리(사이드바·보드)로 되돌립니다', onclick: () => void unarchive([p]) }),
        el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', title: '휴지통으로 보냅니다 — 되돌릴 수 있어요', onclick: () => void toTrash([p]) }))));
    tr.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('button, input, a')) return;
      ui.focus = ui.focus === p.id ? null : p.id;
      repaint();
    });
    return tr;
  };

  const vis = visible();
  const body = el('tbody', {});
  for (const p of vis) body.append(rowOf(p));
  const allOn = vis.length > 0 && vis.every((p) => ui.sel.has(p.id));
  const master = cb(allOn, '보이는 항목 전체 선택', (on) => { for (const p of vis) { if (on) ui.sel.add(p.id); else ui.sel.delete(p.id); } repaint(); }, !allOn && vis.some((p) => ui.sel.has(p.id)));
  tblWrap.replaceChildren(
    el('table', { class: 'v2-bin-tbl arch' },
      el('thead', {}, el('tr', {},
        el('th', { class: 'c-cb' }, master), el('th', { text: '이름' }), el('th', { text: '세션' }),
        el('th', { text: '보관한 때' }), el('th', {}))),
      body),
    ...(!vis.length ? [el('p', { class: 'v2-bin-empty', text: '보관한 프로젝트가 없어요. 사이드바 프로젝트 행을 오른쪽 클릭 ▸ [보관하기]로 치워 두면 사이드바가 가벼워져요.' })] : []));

  const picked = vis.filter((p) => ui.sel.has(p.id));
  barEl.replaceChildren(...(picked.length ? [
    el('span', { class: 'n', text: `${picked.length}개 선택` }),
    el('button', { class: 'btn-text', type: 'button', text: '보관 해제', onclick: () => void unarchive(picked) }),
    el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void toTrash(picked) }),
    el('button', { class: 'btn-text', type: 'button', text: '선택 해제', onclick: () => { ui.sel.clear(); repaint(); } }),
  ] : []), countEl);
  countEl.textContent = `${vis.length}개`;

  if (!aside) return;
  const box = el('div', { class: 'v2-bin-side' });
  const p = projs.find((x) => x.id === ui.focus) || (picked.length === 1 ? picked[0] : null);
  if (!p) {
    box.append(el('p', { class: 'v2-bin-side-hint', text: '행을 누르면 그 프로젝트의 세션이 여기 열립니다.' }));
    aside.replaceChildren(box);
    return;
  }
  const ss = sessOf(p);
  const detail = el('div', { class: 'v2-bin-side-detail' },
    el('div', { class: 'h' }, folderIcon(), el('b', { text: p.name }), el('span', { class: 'tag', text: `#${p.id}` })),
    el('p', { class: 'meta', text: `보관 ${when(p.archived_at)} · 세션 ${ss.length}개` }));
  if (ss.length) {
    detail.append(el('h5', { text: '세션' }));
    for (const s of ss.slice(0, 8)) detail.append(sideLi(dot(s.stateKey), sessText(s, p.name).main || s.id, s.stateLabel, '#/s/' + encodeURIComponent(s.id)));
    if (ss.length > 8) detail.append(el('p', { class: 'meta', text: `외 ${ss.length - 8}개` }));
  } else detail.append(el('p', { class: 'meta', text: '이 프로젝트엔 세션이 없어요.' }));
  detail.append(el('div', { class: 'act' },
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '보관 해제', onclick: () => void unarchive([p]) }),
    el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void toTrash([p]) }),
    el('a', { class: 'btn-text', href: '#/p/' + p.id, text: '프로젝트 열기 →' })));
  box.append(detail);
  aside.replaceChildren(box);
}
