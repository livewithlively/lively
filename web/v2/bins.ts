// v2/bins.ts — 아카이브(#/archive) · 휴지통(#/trash) 화면(#1851 → #1850 안 A, 원준 2026-08-27 "A안으로 가자").
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
import { confirmSessionPurge, confirmSessionPurgeLocal, confirmSessionPurgeMany, fetchFootprint, purgeSessionRecord, purgedToast, sessionNames, sessionTrashOp, setTrashConfirmSkipped, trashConfirmSkipped, eulReul, type Footprint } from '../session-actions.js';
import { sessText } from './side.js';
import { dotCls, isArchivedProj, isLiveSess, isLooseTrashedSess, isTrashedProj, isTrashedSess, projName, type Proj, type Sess, type V2Data } from './views.js';

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
const archUi = { kind: 'all' as 'all' | 'live', q: '', newestFirst: true, shown: PAGE, sel: new Set<number>(), focus: null as number | null };
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
      // 안에 든 결과물(발자국) — 묶음 세션 것을 모아 이름까지. 못 읽으면 조용히 생략(추측 금지).
      const fpBox = el('div', { class: 'fp' });
      detail.append(fpBox);
      const sids = it.bundle.map((s) => ({ sid: logSid(s), node: logNode(s) })).filter((x) => x.sid).slice(0, 5);
      if (sids.length) void Promise.all(sids.map((x) => fpOf(x.sid, x.node))).then((fps) => {
        if (ui.focus !== it.key || !aside.contains(fpBox)) return;
        paintFp(fpBox, fps.filter((x): x is Footprint => !!x));
      });
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
      if (sid) void fpOf(sid, logNode(s)).then((fp) => {
        if (ui.focus !== it.key || !aside.contains(fpBox)) return;
        if (fp) paintFp(fpBox, [fp]);
        else fpBox.append(el('p', { class: 'meta', text: '이 세션이 남긴 것은 찾지 못했어요.' }));
      });
      else fpBox.append(el('p', { class: 'meta', text: '중앙 대화 기록이 없는 세션이에요 — 지워도 기록·지식 변화가 없어요.' }));
    }
    box.append(detail);
    aside.replaceChildren(box);
  };
  // 발자국 → 곁칸 목록. "지우면 무엇이 함께 정리되나"를 창을 열기 전에 보여 준다(실제 선택은 확인창에서).
  const paintFp = (boxEl: HTMLElement, fps: Footprint[]) => {
    const kc = new Map<string, string>(); const ke = new Map<string, string>(); let src = 0, acts = 0, tk = 0;
    for (const fp of fps) {
      for (const k of fp.knowledge_created) kc.set(k.name, k.title || k.name);
      for (const k of fp.knowledge_edited) ke.set(k.name, k.title || k.name);
      src += fp.sources.length; acts += fp.activities; tk += (fp.tasks || []).length;
    }
    if (!kc.size && !ke.size && !src && !acts && !tk) { boxEl.append(el('p', { class: 'meta', text: '만든 지식·자료·작업 기록은 없어요.' })); return; }
    boxEl.append(el('h5', { text: '완전히 지우면 함께 정리되는 것' }));
    for (const [, t] of [...kc].slice(0, 5)) boxEl.append(sideLi(null, t, '만든 지식'));
    if (kc.size > 5) boxEl.append(el('p', { class: 'meta', text: `만든 지식 외 ${kc.size - 5}건` }));
    for (const [, t] of [...ke].slice(0, 3)) boxEl.append(sideLi(null, t, '이전으로 되돌림'));
    if (ke.size > 3) boxEl.append(el('p', { class: 'meta', text: `고친 지식 외 ${ke.size - 3}건` }));
    if (src) boxEl.append(sideLi(null, '원본 자료', `${src}건`));
    if (tk) boxEl.append(sideLi(null, '만든 태스크', `${tk}건`));
    if (acts) boxEl.append(sideLi(null, '작업 기록', `${acts}건`));
    boxEl.append(el('p', { class: 'meta', text: '남길 것은 [완전 삭제…]를 누른 창에서 고를 수 있어요.' }));
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

// ══════════════════════════════════ 아카이브 ═════════════════════════════════
//  같은 표 문법 — 동사만 다르다(보관 해제 · 휴지통으로). 세션은 그대로 열 수 있으니 여기엔 파괴 동사가 없다.
export function renderArchive(host: HTMLElement, data: V2Data, hooks: BinHooks = {}, aside?: HTMLElement | null): void {
  const projs = data.projects.filter((p) => isArchivedProj(p) && !isTrashedProj(p));   // 버린 것은 휴지통이 맡는다
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

  const visible = (): Proj[] => {
    const needle = ui.q.trim().toLowerCase();
    return projs
      .filter((p) => ui.kind === 'all' || liveOf(p) > 0)
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || ('#' + p.id).includes(needle))
      .sort((a, b) => ui.newestFirst
        ? String(b.archived_at || '').localeCompare(String(a.archived_at || ''))
        : String(a.archived_at || '').localeCompare(String(b.archived_at || '')));
  };

  const tblWrap = el('div', { class: 'v2-bin-tblwrap' });
  const chipsEl = el('div', { class: 'v2-bin-chips' });
  const barEl = el('div', { class: 'v2-bin-selbar' });
  const countEl = el('span', { class: 'v2-bin-count' });
  const search = el('input', { type: 'search', class: 'v2-bin-search', placeholder: '이름으로 찾기', 'aria-label': '아카이브에서 이름으로 찾기' }) as HTMLInputElement;
  search.value = ui.q;
  search.addEventListener('input', () => { ui.q = search.value; ui.shown = PAGE; paint(); });
  const sortBtn = el('button', { class: 'btn-text v2-bin-sort', type: 'button', text: ui.newestFirst ? '최근 순' : '오래된 순', title: '정렬을 바꿉니다', onclick: () => { ui.newestFirst = !ui.newestFirst; sortBtn.textContent = ui.newestFirst ? '최근 순' : '오래된 순'; paint(); } });

  const paintChips = () => {
    const liveN = projs.filter((p) => liveOf(p) > 0).length;
    const chip = (k: typeof ui.kind, label: string, n: number) => el('button', { class: 'v2-bin-chip' + (ui.kind === k ? ' on' : ''), type: 'button', text: `${label} ${n}`, 'aria-pressed': String(ui.kind === k), onclick: () => { ui.kind = k; ui.shown = PAGE; paint(); } });
    chipsEl.replaceChildren(chip('all', '전체', projs.length), chip('live', '도는 세션 있음', liveN));
  };
  const paintBar = () => {
    const vis = visible();
    const picked = vis.filter((p) => ui.sel.has(p.id));
    barEl.replaceChildren(...(picked.length ? [
      el('span', { class: 'n', text: `${picked.length}개 선택` }),
      el('button', { class: 'btn-text', type: 'button', text: '보관 해제', onclick: () => void unarchive(picked) }),
      el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void toTrash(picked) }),
      el('button', { class: 'btn-text', type: 'button', text: '선택 해제', onclick: () => { ui.sel.clear(); paint(); } }),
    ] : []), countEl);
    countEl.textContent = vis.length === projs.length ? '' : `${vis.length}개 표시`;
  };

  const rowOf = (p: Proj): HTMLElement => {
    const ss = sessOf(p); const live = liveOf(p);
    const tr = el('tr', { class: (ui.focus === p.id ? 'focus' : '') },
      el('td', { class: 'c-cb' }, cb(ui.sel.has(p.id), p.name + ' 선택', (on) => { if (on) ui.sel.add(p.id); else ui.sel.delete(p.id); paintBar(); paintAside(); })),
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
      paint();
    });
    return tr;
  };

  const paintTable = () => {
    const vis = visible();
    const head = vis.slice(0, ui.shown);
    const allOn = vis.length > 0 && vis.every((p) => ui.sel.has(p.id));
    const someOn = vis.some((p) => ui.sel.has(p.id));
    const master = cb(allOn, '보이는 항목 전체 선택', (on) => { for (const p of vis) { if (on) ui.sel.add(p.id); else ui.sel.delete(p.id); } paint(); }, someOn && !allOn);
    const body = el('tbody', {});
    let cur = '';
    for (const p of head) {
      const b = bucketOf(String(p.archived_at || ''));
      if (b !== cur) {
        cur = b;
        const grp = vis.filter((x) => bucketOf(String(x.archived_at || '')) === b);
        const gAll = grp.every((x) => ui.sel.has(x.id));
        const gSome = grp.some((x) => ui.sel.has(x.id));
        body.append(el('tr', { class: 'g' },
          el('td', { class: 'c-cb' }, cb(gAll, `${b} 전체 선택`, (on) => { for (const x of grp) { if (on) ui.sel.add(x.id); else ui.sel.delete(x.id); } paint(); }, gSome && !gAll)),
          el('td', { colspan: '3' }, el('b', { text: b }), el('span', { class: 'n', text: ` · ${grp.length}` })),
          el('td', { class: 'c-acts' }, el('button', { class: 'btn-text', type: 'button', text: '이 묶음 보관 해제', onclick: () => void unarchive(grp) }))));
      }
      body.append(rowOf(p));
    }
    tblWrap.replaceChildren(
      el('table', { class: 'v2-bin-tbl arch' },
        el('thead', {}, el('tr', {},
          el('th', { class: 'c-cb' }, master), el('th', { text: '이름' }), el('th', { text: '세션' }),
          el('th', { text: '보관한 때' }), el('th', {}))),
        body),
      ...(vis.length > head.length ? [el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${vis.length - head.length}개 더 보기`, onclick: () => { ui.shown += PAGE; paint(); } })] : []),
      ...(!vis.length ? [el('p', { class: 'v2-bin-empty', text: ui.q.trim() ? '찾는 이름이 없어요.' : '이 조건엔 보관한 프로젝트가 없어요.' })] : []));
  };

  const paintAside = () => {
    if (!aside) return;
    const box = el('div', { class: 'v2-bin-side' });
    const vis = visible();
    const picked = vis.filter((p) => ui.sel.has(p.id));
    if (picked.length > 1) {
      box.append(el('div', { class: 'v2-bin-side-sum' },
        el('h4', { text: `고른 ${picked.length}개` }),
        el('p', { class: 'd', text: `프로젝트 ${picked.length} · 안의 세션 ${picked.reduce((a, p) => a + sessOf(p).length, 0)}` }),
        el('div', { class: 'act' },
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '보관 해제', onclick: () => void unarchive(picked) }),
          el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void toTrash(picked) }))));
    }
    const p = projs.find((x) => x.id === ui.focus) || (picked.length === 1 ? picked[0] : null);
    if (!p) {
      if (!picked.length) box.append(el('p', { class: 'v2-bin-side-hint', text: '행을 누르면 그 프로젝트의 세션이 여기 열립니다.' }));
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
  };

  const paint = () => { paintChips(); paintTable(); paintBar(); paintAside(); };

  const empty = !projs.length;
  const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('v2-bin-search');
  host.replaceChildren(el('div', { class: 'v2-center v2-binpage wide' },
    el('div', { class: 'v2-bin-top' },
      el('div', {},
        el('h1', { class: 'v2-title', text: '아카이브' }),
        el('p', { class: 'v2-desc', text: '끝났거나 한동안 안 볼 프로젝트예요. 안의 세션은 그대로 열 수 있고, [보관 해제]를 누르면 원래 자리로 돌아갑니다.' }))),
    empty
      ? el('div', { class: 'v2-inbox-empty' }, el('p', { class: 'h', text: '보관한 프로젝트가 없어요.' }),
          el('p', { class: 'sub', text: '사이드바 프로젝트 행을 오른쪽 클릭 ▸ [아카이브로 보내기]로 치워 두면 사이드바가 가벼워져요.' }))
      : el('section', { class: 'v2-bin-sec' },
          el('div', { class: 'v2-bin-tools' }, chipsEl, el('span', { class: 'sp' }), search, sortBtn),
          barEl, tblWrap)));
  if (!empty) paint();
  else if (aside) aside.replaceChildren();
  if (hadFocus && !empty) { search.focus(); const n = search.value.length; try { search.setSelectionRange(n, n); } catch { /* noop */ } }
}
