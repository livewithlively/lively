// v2/bins.ts — 아카이브(#/archive) · 휴지통(#/trash) 화면(#1851, 원준 2026-08-23).
//
//  사이드바 발치의 두 행이 여는 **가운데 화면**이다. 둘 다 '치워 둔 것'의 목록이고, 되돌리는 길이 화면 안에 있다.
//   · 아카이브 — 통째로 보관한 프로젝트들. 각 프로젝트 아래 그 세션(지난 세션)이 줄줄이 보인다(원준: "프로젝트들과 그의 하부
//     AI 세션들이 리스트로 쭉 보이는 창"). 세션을 누르면 그 대화가 열리고, 프로젝트는 [보관 해제]로 원래 자리로 돌아간다.
//   · 휴지통 — **한 목록, 버린 순서**(원준 2026-08-27 안 3 확정 — 종전의 '프로젝트 구역 → 세션 구역'은 프로젝트 카드 52장(6,971px)
//     밑에 세션이 깔려 8장을 내려야 보였다). 맥·윈도우 휴지통 문법: 지운 폴더(프로젝트)는 한 줄, 그 안에서 따로 지운 파일(세션)도
//     한 줄, 섞어서 시간순. 종류는 아이콘과 칩 필터로 가르고, 날짜 묶음(오늘·어제·이번 주·이전)과 50건 [더 보기]가 긴 목록을 다스린다.
//     프로젝트 행은 ▸ 로 함께 들어간 세션을 펼친다. 프로젝트도 체크박스 — 고른 것을 섞어서 [되돌리기]/[완전 삭제], [휴지통 비우기]는
//     전부 고른 것과 같다(같은 창). 완전 삭제 창은 세션·프로젝트 합쳐 **한 번**(종전엔 프로젝트가 두 번 물었다).
//     지식·카테고리의 삭제(감사 스냅샷)는 종전대로 WIKI 앱의 휴지통 — 한때 여기 묶음으로 넣었다가 되돌렸다(archive-trash-v2-shell-1851).
//  행의 문법은 홈·확인할 것(v2-now-row)과 같다 — 새 시각 언어를 만들지 않는다.
import { api, el, relTime, sv, toast } from '../core.js';
// 완전 삭제는 두 갈래(#1851 ⟶ #1850): 중앙 기록이 있는 세션은 #1850 의 범위 선택 확인창 + 기록 파기(purgeSessionRecord)를 그대로
//  쓰고, 그 위에 되살리기 좌표(desired-state)까지 지우는 휴지통 op('purge')를 얹는다. 기록이 없는 세션은 좌표만 지운다.
import { confirmSessionPurge, confirmSessionPurgeLocal, confirmSessionPurgeMany, purgeSessionRecord, purgedToast, sessionNames, sessionTrashOp, setTrashConfirmSkipped, trashConfirmSkipped, eulReul } from '../session-actions.js';
import { sessText } from './side.js';
import { dotCls, isArchivedProj, isLiveSess, isLooseTrashedSess, isTrashedProj, isTrashedSess, projName, type Proj, type Sess, type V2Data } from './views.js';

export interface BinHooks { onChanged?: () => void }

const when = (iso: string | null | undefined): string => (iso ? relTime(iso) : '');
const whenMs = (ms: number): string => (ms ? relTime(new Date(ms).toISOString()) : '');
const dot = (k: string) => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });
const MAX_ROWS = 8;   // 프로젝트 하나 아래 펼쳐 보이는 세션 상한 — 넘치면 '외 n개'가 그 자리에서 편다

// 세션 한 줄 — 이름(프로젝트명 되풀이 걷어낸 것) · 상태 · 시각. 오른쪽 끝은 호출자가 준 조작 단추.
function sessRow(s: Sess, pn: string, actions: HTMLElement[] = [], tail?: string, lead?: HTMLElement | null): HTMLElement {
  const t = sessText(s, pn);
  return el('div', { class: 'v2-bin-row' + (isLiveSess(s) ? '' : ' past') },
    lead || null,
    dot(s.stateKey),
    el('a', { class: 'tw', href: '#/s/' + encodeURIComponent(s.id), title: (s.label || '') + '\n세션 대화를 엽니다' },
      el('span', { class: 't', text: t.main }),
      // 부제('하던 일')가 이름의 되풀이면 생략 — 이름이 첫 지시에서 잘려 나온 세션은 둘이 같은 문장으로 시작한다(실측).
      t.sub && !t.sub.startsWith(t.main.replace(/…$/, '')) && !t.main.startsWith(t.sub) ? el('span', { class: 'p', text: t.sub }) : null),
    el('span', { class: 'st', text: tail || `${s.stateLabel} · ${whenMs(s.lastSeen)}` }),
    ...actions);
}

// ── 아카이브 ──────────────────────────────────────────────────────────────────
export function renderArchive(host: HTMLElement, data: V2Data, hooks: BinHooks = {}): void {
  const projs = data.projects.filter((p) => isArchivedProj(p) && !isTrashedProj(p))   // 버린 것은 휴지통이 맡는다
    .sort((a, b) => String(b.archived_at || '').localeCompare(String(a.archived_at || '')));
  const sessOf = (p: Proj): Sess[] => data.sessions.filter((s) => Number(s.projectId) === p.id && !isTrashedSess(s))
    .sort((a, b) => Number(isLiveSess(b)) - Number(isLiveSess(a)) || b.lastSeen - a.lastSeen);
  const card = (p: Proj): HTMLElement => {
    const ss = sessOf(p);
    const live = ss.filter(isLiveSess).length;
    const listEl = el('div', { class: 'v2-bin-list' });
    const paintList = (all: boolean): void => {
      const head = all ? ss : ss.slice(0, MAX_ROWS);
      // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다(el() 과 다르다) — 조건부 자식은 배열 스프레드로.
      listEl.replaceChildren(
        ...head.map((s) => sessRow(s, p.name)),
        ...(ss.length > head.length ? [el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${ss.length - head.length}개 더 보기`, onclick: () => paintList(true) })] : []),
        ...(!ss.length ? [el('p', { class: 'v2-bin-empty', text: '이 프로젝트엔 세션이 없어요.' })] : []));
    };
    paintList(false);
    const unarch = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '보관 해제',
      title: '원래 자리(사이드바·보드)로 되돌립니다' }) as HTMLButtonElement;
    unarch.onclick = () => {
      unarch.disabled = true;
      void api('/api/ui/v6/projects/' + p.id + '/archive', { method: 'POST', body: JSON.stringify({ archived: false }) })
        .then(() => { toast(`「${p.name}」 보관을 해제했어요 — 사이드바로 돌아왔어요.`); hooks.onChanged?.(); })
        .catch((e: any) => { unarch.disabled = false; toast('보관을 해제하지 못했어요 — ' + (e?.message || e), true); });
    };
    return el('section', { class: 'v2-bin-card' },
      el('div', { class: 'v2-bin-head' },
        sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold', 'aria-hidden': 'true' }, sv('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })),
        el('div', { class: 'tw' },
          el('a', { class: 't', href: '#/p/' + p.id, text: p.name, title: '프로젝트 화면을 엽니다' }),
          el('span', { class: 'p', text: [`#${p.id}`, '보관 ' + when(p.archived_at), `세션 ${ss.length}`, live ? `도는 중 ${live}` : ''].filter(Boolean).join(' · ') })),
        unarch),
      listEl);
  };
  host.replaceChildren(el('div', { class: 'v2-center v2-binpage' },
    el('h1', { class: 'v2-title', text: '아카이브' }),
    el('p', { class: 'v2-desc', text: '통째로 보관한 프로젝트예요. 아래 세션은 그대로 열어 볼 수 있고, [보관 해제]를 누르면 원래 자리로 돌아갑니다.\n보내는 길: 사이드바 프로젝트 행을 오른쪽 클릭 ▸ [아카이브로 보내기], 또는 프로젝트 상세 창의 [보관].' }),
    projs.length
      ? el('div', { class: 'v2-bin-cards' }, ...projs.map(card))
      : el('div', { class: 'v2-inbox-empty' }, el('p', { class: 'h', text: '보관한 프로젝트가 없어요.' }),
          el('p', { class: 'sub', text: '끝났거나 한동안 안 볼 프로젝트를 여기 치워 두면 사이드바가 가벼워져요.' }))));
}

// ── 휴지통 ────────────────────────────────────────────────────────────────────
// 휴지통 화면 상태는 렌더 밖에 둔다 — main.ts 가 20초 결로(그리고 되돌리기·완전 삭제 뒤) renderTrash 를 통째로 다시 부르므로
//  클로저에 두면 고른 것·검색어·칩·펼침·[더 보기]가 20초마다 증발한다(프리뷰 실측 2026-08-27). 되돌리기/완전 삭제 진행 중 잠금(busy)도
//  같은 이유로 여기 — 다시 그린 새 단추가 진행 중인 작업을 모른 채 두 번 쏘지 않도록.
const trashUi = { kind: 'all' as 'all' | 'project' | 'session', q: '', newestFirst: true, shown: 50, open: new Set<number>(), sel: new Set<string>() };
let trashBusy = false;

export function renderTrash(host: HTMLElement, data: V2Data, hooks: BinHooks = {}): void {
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

  const guard = async (fn: () => Promise<void>): Promise<void> => { if (trashBusy) return; trashBusy = true; try { await fn(); } finally { trashBusy = false; } };
  // 세션 하나는 이름이 둘(박스 id·대화 uuid)이라 서버 응답을 이름이 아니라 **세션 단위**로 읽는다 — 한 이름만 처리돼도 그 세션은 된 것.
  //  (둘 다 보내면 한쪽은 '휴지통에 없는 세션'으로 건너뛰는 게 정상이라, 그걸 '일부 실패'로 읽어 주면 사람이 놀란다 — 프리뷰 실측.)
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
    sel.clear(); hooks.onChanged?.();
  });

  // ── 완전 삭제 — 세션·프로젝트 섞어서 **한 창**. 행별(프로젝트)·선택·비우기가 전부 이 길을 탄다. ──
  //  프로젝트에 함께 들어간 세션의 기록도 여기서 같이 판다(결과물 범위는 창에서 고른다). 순서: 기록 파기 → 세션 표식 purge →
  //  프로젝트 purge(묶음 세션 좌표는 서버가 함께 지운다).
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
    //  그 행은 아래 /projects/:id/purge 가 지운다(서버가 묶음 세션 결과물까지 마저 되돌린다).
    const purgingPj = new Set(pjs.map((i) => i.p.id));
    for (const s of all) {
      const sid = logSid(s); if (!sid) continue;
      try {
        const c = choices.get(sid) || defaultChoice;
        const r = await purgeSessionRecord(sid, logNode(s), { ...c, projects: c.projects.filter((id) => !purgingPj.has(id)) });
        logs++; sum.kn += r.knowledge_deleted; sum.rv += r.knowledge_reverted; sum.pj += r.projects_deleted; sum.src += r.sources_deleted; sum.tk += r.tasks_deleted; sum.ct += r.categories_deleted;
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
    sel.clear(); hooks.onChanged?.();
  });
  // 세션 하나는 종전의 단일 창(제목에 이름·원격 노드 안내가 있다). 프로젝트 하나·여러 개·비우기는 위 공통 창.
  const purgeSession = (s: Sess): Promise<void> => guard(async () => {
    const name = sessText(s, projName(data, s.projectId)).main || s.id;
    const sid = logSid(s);
    try {
      if (sid) {
        const choice = await confirmSessionPurge({ sid, node: logNode(s), title: `「${name}」${eulReul(name)} 완전히 지울까요?`, remoteNode: logNode(s) || null });
        if (!choice) return;
        const r = await purgeSessionRecord(sid, logNode(s), choice);
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

  // ── 화면 상태: 종류 칩 · 검색 · 정렬 · 펼침 · 선택 · 페이지 ──
  const PAGE = 50;
  const ui = trashUi;
  const keys = new Set(items.map((i) => i.key));
  for (const k of Array.from(ui.sel)) if (!keys.has(k)) ui.sel.delete(k);          // 그새 사라진(되돌린·지운) 항목은 선택에서 뺀다
  for (const id of Array.from(ui.open)) if (!tps.some((p) => p.id === id)) ui.open.delete(id);
  const sel = ui.sel; const open = ui.open;

  const visible = (): Item[] => {
    const needle = ui.q.trim().toLowerCase();
    return items
      .filter((i) => ui.kind === 'all' || i.kind === ui.kind)
      .filter((i) => !needle || nameOf(i).toLowerCase().includes(needle) || (i.kind === 'project' && ('#' + i.p.id).includes(needle)))
      .sort((a, b) => ui.newestFirst ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at));
  };
  // 날짜 묶음 — 오늘 · 어제 · 이번 주(7일) · 이전. 긴 목록에 눈금을 준다(OS 휴지통도 같은 눈금을 쓴다).
  const bucketOf = (iso: string): string => {
    const t = Date.parse(iso); if (!Number.isFinite(t)) return '이전';
    const d = new Date(t); const now = new Date();
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    return diff <= 0 ? '오늘' : diff === 1 ? '어제' : diff < 7 ? '이번 주' : '이전';
  };

  const folderIcon = () => sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold sm', 'aria-hidden': 'true' }, sv('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }));
  const selbox = (key: string, label: string): HTMLInputElement => {
    const box = el('input', { type: 'checkbox', class: 'sel', 'aria-label': label + ' 선택' }) as HTMLInputElement;
    box.checked = sel.has(key);
    box.addEventListener('change', () => { if (box.checked) sel.add(key); else sel.delete(key); paintBar(); });
    return box;
  };
  const rowOf = (it: Item): HTMLElement[] => {
    if (it.kind === 'session') {
      const pn = projName(data, it.s.projectId);
      return [sessRow(it.s, pn, [
        el('button', { class: 'btn-text', type: 'button', text: '되돌리기', title: '지난 세션으로 되돌립니다', onclick: () => void restoreSession(it.s) }),
        el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제', title: '되살릴 수 없게 지웁니다', onclick: () => void purgeSession(it.s) }),
      ], (it.s.projectId ? pn + ' · ' : '') + '버림 ' + when(it.s.trashedAt), selbox(it.key, it.s.label || it.s.id))];
    }
    const p = it.p; const isOpen = open.has(p.id);
    const caret = el('button', { class: 'v2-bin-caret', type: 'button', text: isOpen ? '▾' : '▸', 'aria-label': (isOpen ? '접기 ' : '펼치기 ') + p.name, title: isOpen ? '함께 들어간 세션 접기' : `함께 들어간 세션 ${it.bundle.length}개 펼치기`,
      onclick: () => { if (isOpen) open.delete(p.id); else open.add(p.id); paintList(); } });
    const row = el('div', { class: 'v2-bin-row proj' },
      selbox(it.key, p.name), folderIcon(),
      el('div', { class: 'tw' }, el('span', { class: 't', text: p.name }), el('span', { class: 'p', text: `#${p.id} · 세션 ${it.bundle.length}` })),
      el('span', { class: 'st', text: '버림 ' + when(p.trashed_at) }),
      it.bundle.length ? caret : el('span', { class: 'v2-bin-caret none', 'aria-hidden': 'true', text: '·' }),
      el('button', { class: 'btn-text', type: 'button', text: '복원', title: '프로젝트와 함께 들어간 세션이 원래 자리로 돌아갑니다', onclick: () => void restoreProject(p) }),
      el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제', title: '프로젝트를 지우고 함께 들어간 세션은 되살릴 수 없게 합니다', onclick: () => void purgeItems([it], `「${p.name}」${eulReul(p.name)} 완전히 지울까요?`) }));
    if (!isOpen || !it.bundle.length) return [row];
    const kids = el('div', { class: 'v2-bin-kids' },
      ...it.bundle.slice(0, MAX_ROWS).map((s) => sessRow(s, p.name, [], `${s.stateLabel} · ${whenMs(s.lastSeen)}`)),
      ...(it.bundle.length > MAX_ROWS ? [el('p', { class: 'v2-bin-empty', text: `외 ${it.bundle.length - MAX_ROWS}개 — 복원하면 전부 돌아와요.` })] : []));
    return [row, kids];
  };

  // ── 조립 ──
  const listEl = el('div', { class: 'v2-bin-list' });
  const barEl = el('div', { class: 'v2-bin-selbar' });
  const chipsEl = el('div', { class: 'v2-bin-chips' });
  const countEl = el('span', { class: 'v2-bin-count' });
  const search = el('input', { type: 'search', class: 'v2-bin-search', placeholder: '이름으로 찾기', 'aria-label': '휴지통에서 이름으로 찾기' }) as HTMLInputElement;
  search.value = ui.q;
  search.addEventListener('input', () => { ui.q = search.value; ui.shown = PAGE; paintList(); });
  const sortBtn = el('button', { class: 'btn-text v2-bin-sort', type: 'button', text: ui.newestFirst ? '최근 순' : '오래된 순', title: '정렬을 바꿉니다', onclick: () => { ui.newestFirst = !ui.newestFirst; sortBtn.textContent = ui.newestFirst ? '최근 순' : '오래된 순'; paintList(); } });

  const paintChips = () => {
    const chip = (k: typeof ui.kind, label: string, n: number) => el('button', { class: 'v2-bin-chip' + (ui.kind === k ? ' on' : ''), type: 'button', text: `${label} ${n}`, 'aria-pressed': String(ui.kind === k), onclick: () => { ui.kind = k; ui.shown = PAGE; paintChips(); paintList(); } });
    chipsEl.replaceChildren(chip('all', '전체', items.length), chip('project', '프로젝트', tps.length), chip('session', '세션', ss.length));
  };
  const paintBar = () => {
    const vis = visible();
    const picked = vis.filter((i) => sel.has(i.key));
    const allOn = vis.length > 0 && picked.length === vis.length;
    const master = el('input', { type: 'checkbox', class: 'sel', 'aria-label': '보이는 항목 전체 선택' }) as HTMLInputElement;
    master.checked = allOn; master.indeterminate = picked.length > 0 && !allOn;
    master.addEventListener('change', () => { if (master.checked) vis.forEach((i) => sel.add(i.key)); else vis.forEach((i) => sel.delete(i.key)); paintList(); });
    barEl.replaceChildren(
      el('label', { class: 'v2-bin-master' }, master, el('span', { text: picked.length ? `${picked.length}개 선택` : '전체 선택' })),
      ...(picked.length ? [
        el('button', { class: 'btn-text', type: 'button', text: '되돌리기', onclick: () => void restoreItems(picked) }),
        el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제', onclick: () => void purgeItems(picked, `고른 ${picked.length}개를 완전히 지울까요?`) }),
        el('button', { class: 'btn-text', type: 'button', text: '선택 해제', onclick: () => { sel.clear(); paintList(); } }),
      ] : []),
      countEl);
  };
  const paintList = () => {
    const vis = visible();
    countEl.textContent = vis.length === items.length ? '' : `${vis.length}개 표시`;
    const head = vis.slice(0, ui.shown);
    const out: HTMLElement[] = [];
    let cur = '';
    for (const it of head) {
      const b = bucketOf(it.at);
      if (b !== cur) { cur = b; out.push(el('div', { class: 'v2-bin-grp', text: `${b} · ${vis.filter((x) => bucketOf(x.at) === b).length}` })); }
      out.push(...rowOf(it));
    }
    if (vis.length > head.length) out.push(el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${vis.length - head.length}개 더 보기`, onclick: () => { ui.shown += PAGE; paintList(); } }));
    if (!vis.length) out.push(el('p', { class: 'v2-bin-empty', text: ui.q.trim() ? '찾는 이름이 없어요.' : '이 종류엔 버린 것이 없어요.' }));
    listEl.replaceChildren(...out);
    paintBar();
  };

  const empty = !items.length;
  const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('v2-bin-search');
  const scrollTop = host.scrollTop;
  host.replaceChildren(el('div', { class: 'v2-center v2-binpage' },
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
          barEl, listEl),
    el('p', { class: 'v2-bin-fine', text: '지식·카테고리를 삭제한 것은 WIKI 앱의 휴지통에 있어요.' },
      el('a', { class: 'btn-text', href: location.pathname + '?ui=classic#/trash', target: '_blank', rel: 'noopener', text: '열기 ↗' }))));
  if (!empty) { paintChips(); paintList(); }
  // 20초 결 다시 그리기가 타이핑 중인 검색창·스크롤 자리를 빼앗지 않도록
  if (hadFocus && !empty) { search.focus(); const n = search.value.length; try { search.setSelectionRange(n, n); } catch { /* 일부 브라우저는 search 타입에 거부 */ } }
  if (scrollTop) host.scrollTop = scrollTop;
}
