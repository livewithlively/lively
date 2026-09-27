// v2/panes-tasks.ts — 곁칸의 **프로젝트** 앱(#4135, 옛 «태스크» 부품 #4084). 보는 세션이 속한 프로젝트를, 고를 것 없이 보여 준다.
//
//  왜 고쳤나(원준 2026-09-27, 9/22 회의의 상민님 워크플로우): 세션을 열 때(?new=1)와 연 뒤 지시할 때 곁에 있어야 하는 것은
//   ① 프로젝트 본문(읽히는 글로) ② «이 세션이 무엇을 어떤 순서로 하나» ③ 나머지 태스크가 어느 세션에서 도는가다.
//   종전 부품은 본문이 접힌 원문 편집칸이었고, 상태는 누를 때마다 한 칸씩 넘어갔고, 이 세션의 태스크는 카드 하나뿐이었다.
//
//  짜임(위→아래) — 머리(프로젝트 · n/m 끝냄) → 본문(늘 펼쳐 **읽기**, 누르면 고치기) → 두 갈래:
//   · 세션을 보고 있다: «이 세션의 태스크» 1. 2. 3.(순서 = 이 세션이 할 차례 · 끌기/메뉴로 바꾸기 · 빈 칸에서 찾아 넣기)
//                       + «외부 태스크»(이 세션에 없는 것 전부 · 세션 배지와 수행 상태 · [세션으로] / [이 세션에 넣기])
//   · 새 세션 자리(?new=1): «이 프로젝트의 태스크» 전체 + [담기] — 담은 것은 가운데 글칸에 번호 배지로 선다(compose-tasks.ts).
//   → 빠른 추가.
//  규칙(원준 2026-09-27): **세션이 있으면(멈춤 포함) [세션으로], 없을 때만 [이 세션에 넣기]** · 같은 세션은 어느 줄에서나 같은 색 배지.
//
//  ⚠ 입력 중에는 다시 그리지 않는다 — 이 칸은 8초마다 서버를 다시 읽는다. 글칸에 손이 가 있는 동안은 그리기를 미루고(listDirty),
//   손을 떼는 순간 따라잡는다.
//  ⚠ 프로젝트 본문은 **일하는 세션도 덧붙인다**(append_description). 사람의 자동저장은 통째 교체라 고치기 시작한 본문
//   (description_base)을 함께 보내고, 서버가 그 뒤에 붙은 꼬리를 살려 합친다. 꼬리가 아닌 곳이 바뀌었으면 409 — 덮지 않고 묻는다.
import { api, el, renderMarkdown, replaceKids, toast } from '../core.js';
import { lsGet, lsSet, pnIcon, seedSessName } from './panes-kit.js';
import { bindCtx, requestOpenRoute } from './ctx-registry.js';
import { copyText, showCtxMenu, type CtxRow } from './ctx-menu.js';
import { spawnSession } from './quick-session.js';
import { dotCls, type Sess } from './views.js';
import type { Part, PartCtx } from './panes-parts.js';
import { pjvPopover } from '../projects/popover.js';
import { PJV_STATUS_ORDER, PJV_TASK_STATUS, pjvStatusIconStd } from '../projects/status.js';
import {
  doneOpenByDefault, externalTasks, groupTasks, isDoing, isDone, moveInOrder, sessionColor, sessionNumbers,
  sessionTaskOrder, stripLeadNotice, type TaskSessRef,
} from '../lib/task-pane.js';
import { clearUnsaved, keepUnsaved, readUnsaved } from './unsaved-store.js';
import { autoSaveCore, type FailVerdict } from '../lib/autosave.js';
import { putIntoSession } from './sess-input.js';
import { onTaskPicks, setTaskPicks, taskPicks, toggleTaskPick } from './task-picks.js';
import { TASK_DRAG_TYPE } from './compose-tasks.js';

const refsOf = (t: any): TaskSessRef[] => (Array.isArray(t && t.sessions) ? t.sessions : []);
const DONE_OPEN_KEY = 'pn_tasks_done_open';   // 취향(완료 묶음을 펴 둘까) — 내용이 아니라 워크스페이스로 가르지 않는다
const SAVE_MS = 1200;                          // 프로젝트 설정의 본문 자동저장과 같은 박자
const BODY_READ_MAX = 60_000;                  // 읽기 모드가 그리는 본문 상한 — 넘으면 [크게 보기]·[프로젝트 창]에서 전문
const KICKOFF_BODY_MAX = 3000;                 // 서버 taskKickoffPrompt 와 같은 상한(넣는 글 모양을 맞춘다)

const isTextField = (a: Element | null): boolean => !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT');
const typingIn = (host: HTMLElement): boolean => isTextField(document.activeElement) && host.contains(document.activeElement);

/** 세션 입력칸에 넣는 글 — 태스크에서 연 세션의 첫 지시(서버 taskKickoffPrompt)와 같은 모양. 사람이 읽고 고쳐서 보낸다. */
export function taskPromptText(t: { id: number; name?: string | null; description?: string | null }): string {
  const body = String(t.description ?? '').trim();
  return [
    `태스크 #${t.id} «${String(t.name || '')}» 을(를) 진행해 주세요.`,
    ...(body ? ['', '## 태스크 본문', '', body.length > KICKOFF_BODY_MAX ? body.slice(0, KICKOFF_BODY_MAX) + '\n\n…(이하 생략 — task_detail_v6 로 전문 조회)' : body] : []),
  ].join('\n');
}

// ── 자동저장 글칸 — 본문·태스크 본문이 같은 것을 쓴다 ─────────────────────────────────────────
//  상태기계는 lib/autosave(값으로 시험한다)에 있고, 여기는 그것을 글칸·칩·토스트에 묶는 껍데기다.
//  ⚠ flush 는 **도는 저장이 실제로 끝날 때까지** 기다린다 — 부른 쪽은 그 뒤에 dirty() 를 보고 «정말 남겼나»를 안다.
interface AutoSave { flush(): Promise<void>; dirty(): boolean; setSaved(v: string): void; destroy(): void }
function autoSave(ta: HTMLTextAreaElement, chip: HTMLElement, save: (text: string) => Promise<string>,
  opts?: { savedText?: string; onSaved?: (v: string) => void; onFail?: (e: any, live: string) => FailVerdict }): AutoSave {
  const setChip = (t: string, warn?: boolean): void => { chip.textContent = t; chip.classList.toggle('warn', !!warn); };
  const okText = opts?.savedText || '저장했어요.';
  let lastErr: any = null;
  const core = autoSaveCore({
    read: () => ta.value,
    save,
    adopt: (kept, sent) => {
      if (ta.value !== sent) return;
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = kept;
      try { ta.setSelectionRange(s, e); } catch (_) { /* 포커스 없는 글칸 */ }
    },
    status: (st) => {
      if (st === 'typing') setChip('쓰는 중…');
      else if (st === 'saving') setChip('저장 중…');
      else if (st === 'idle') setChip('');
      else if (st === 'saved') { setChip(okText); window.setTimeout(() => { if (chip.textContent === okText) setChip(''); }, 2400); }
      else { setChip('저장하지 못했어요.', true); toast('저장하지 못했어요 — ' + (lastErr?.message || lastErr), true); }
    },
    onSaved: opts?.onSaved,
    onFail: (e, live) => { lastErr = e; return opts?.onFail?.(e, live); },
    delayMs: SAVE_MS,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
  }, ta.value);
  const onInput = (): void => core.input();
  const onBlur = (): void => { void core.flush(); };
  ta.addEventListener('input', onInput);
  ta.addEventListener('blur', onBlur);
  return {
    flush: core.flush, dirty: core.dirty, setSaved: core.setSaved,
    destroy: () => { core.destroy(); ta.removeEventListener('input', onInput); ta.removeEventListener('blur', onBlur); },
  };
}

/** 본문만 크게 읽는 창 — 뜨는 동안 **뒤 화면은 스크롤되지 않는다**(원준 2026-09-27). Esc · × · 바깥을 누르면 닫힌다. */
function openBodyModal(title: string, md: string, acts: Array<{ label: string; icon: string; run: () => void; primary?: boolean }>): void {
  const html = document.documentElement;
  const prevOverflow = html.style.overflow;
  html.style.overflow = 'hidden';
  document.body.classList.add('pj-lock');
  const close = (): void => {
    back.remove();
    html.style.overflow = prevOverflow;
    document.body.classList.remove('pj-lock');
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const body = el('div', { class: 'pj-modal-b md-rendered' }, renderMarkdown(stripLeadNotice(md) || '_(본문이 비어 있어요)_'));
  const box = el('div', { class: 'pj-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { class: 'pj-modal-h' }, pnIcon('projtask', 'pn-i sm'), el('b', { class: 'ell', text: title }), el('span', { class: 'grow' }),
      ...acts.map((a) => el('button', { class: 'btn-text pj-dact' + (a.primary ? ' pri' : ''), type: 'button', onclick: () => { close(); a.run(); } },
        pnIcon(a.icon, 'pn-i sm'), el('span', { text: a.label }))),
      el('button', { class: 'pj-ib pj-x', type: 'button', title: '닫기 (Esc)', 'aria-label': '닫기', onclick: close }, pnIcon('x', 'pn-i sm'))),
    body);
  const back = el('div', { class: 'pj-modal-back', onmousedown: (e: Event) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  window.setTimeout(() => body.focus(), 0);
}

export function tasksPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-tk pj' });
  if (!(ctx.id > 0)) {
    root.append(el('div', { class: 'pn-empty' }, pnIcon('projtask', 'pn-i big'),
      el('b', { text: '프로젝트에 붙은 세션에서 보여요.' }),
      el('p', { class: 'pn-fine', text: '세션을 프로젝트에 붙이면 그 프로젝트의 본문과 태스크가 여기 섭니다.' })));
    return { root };
  }

  // ── 상태 ──
  let fresh: any = null;                  // 이 부품이 직접 읽은 최신 상세(셸의 detail 은 마운트 때 한 번 읽고 만다)
  let loading = false, loadedAt = 0;
  let openTask = 0;                       // 본문을 펼쳐 둔 태스크(한 번에 하나)
  let editTask = 0;                       // 그 본문을 고치는 중인가
  let opening = 0;                        // 지금 새 세션을 여는 중인 태스크(두 번 눌러 세션이 둘 생기지 않게)
  let localOrder: number[] | null = null; // 순서를 방금 바꿨다 — 서버가 다시 읽힐 때까지 이 순서로 그린다
  let slotOpen = false, slotQ = '', slotSel = 0;
  let dragFrom = -1;                      // «이 세션의 태스크» 안에서 끄는 줄의 자리
  let headSig = '', listSig = '', listDirty = false;
  const drafts = new Map<number, string>();   // 저장 전 태스크 본문 — 다시 그려도 쓰던 글이 옛 글로 돌아가지 않게
  let rowSaver: AutoSave | null = null;
  let bodySaver: AutoSave | null = null;

  const cur = (): any => fresh || ctx.detail() || {};
  const proj = (): any => cur().project || {};
  const tasks = (): any[] => (Array.isArray(proj().tasks) ? proj().tasks : []);
  const byId = (id: number): any => tasks().find((t) => Number(t.id) === id) || null;
  const allSess = (): Sess[] => ctx.data()?.sessions || [];
  const sessOf = (sid: string): Sess | null =>
    allSess().find((s) => s.id === sid || s.logId === sid || (s.altIds || []).includes(sid)) || null;
  const nums = (): Map<string, number> => sessionNumbers(allSess().filter((s) => Number(s.projectId) === ctx.id && !s.trashedAt));
  const mySid = (): string | null => ctx.curSession();
  const myIds = (): string[] => {
    const sid = mySid();
    if (!sid) return [];
    const s = sessOf(sid);
    return [sid, s?.id, s?.logId, ...(s?.altIds || [])].filter((x): x is string => !!x);
  };
  /** 서버 execution_session 의 열쇠 — 박스 id(목록 행의 id). 기록만 남은 세션이면 주소의 id 그대로. */
  const myKey = (): string => { const sid = mySid() || ''; return sessOf(sid)?.id || sid; };
  const isNew = (): boolean => !mySid();
  const picksRoot = (): HTMLElement => ctx.paneRoot();

  /** 이 태스크를 맡은 세션 가운데 **목록에 있는 것**(지금 보는 세션 제외) — [세션으로]가 갈 곳. 도는 것을 먼저. */
  const otherSessOf = (t: any): { ref: TaskSessRef; s: Sess } | null => {
    const mine = new Set(myIds());
    const hits = refsOf(t).filter((r) => !mine.has(String(r.id))).map((r) => ({ ref: r, s: sessOf(String(r.id)) }))
      .filter((x): x is { ref: TaskSessRef; s: Sess } => !!x.s);
    hits.sort((a, b) => Number(b.s.alive) - Number(a.s.alive) || Number(!!b.ref.current) - Number(!!a.ref.current));
    return hits[0] || null;
  };
  const busyOf = (t: any): boolean => { const o = otherSessOf(t); return !!o && o.s.stateKey === 'busy'; };

  async function load(force?: boolean): Promise<void> {
    if (loading || ctx.dead()) return;
    if (!force && Date.now() - loadedAt < 3000) return;
    loading = true;
    try {
      const d = await api('/api/ui/v6/projects/' + ctx.id);
      if (d && !ctx.dead()) { fresh = d; loadedAt = Date.now(); localOrder = null; paint(); }
    } catch (_) { /* 다음 틱에 다시 읽는다 */ }
    loading = false;
  }
  const changed = (): void => { void load(true); ctx.onChanged?.(); };

  // ── 머리 ──
  const nameBtn = el('button', { class: 'pn-tk-name', type: 'button', title: '프로젝트 상세를 엽니다 — 보고 있는 세션의 프로젝트입니다. 세션을 바꾸면 따라 바뀝니다.', onclick: () => ctx.openSettings?.() }) as HTMLButtonElement;
  const countEl = el('span', { class: 'pn-fine pn-tk-count' });
  const barFill = el('div', { class: 'pn-tk-bar-fill' });
  const head = el('div', { class: 'pn-tk-head' },
    el('div', { class: 'pn-tk-head-row' }, pnIcon('projtask', 'pn-i sm'), nameBtn, countEl),
    el('div', { class: 'pn-tk-bar', role: 'progressbar', 'aria-label': '끝낸 태스크' }, barFill));
  function paintHead(): void {
    const g = groupTasks(tasks(), null);
    const name = String(proj().name || '프로젝트');
    const sig = name + '|' + g.doneCount + '/' + g.total;
    if (sig === headSig) return;
    headSig = sig;
    nameBtn.textContent = name;
    countEl.textContent = g.total ? `${g.doneCount}/${g.total} 끝냄` : '';
    const pct = g.total ? Math.round((100 * g.doneCount) / g.total) : 0;
    barFill.style.width = pct + '%';
    head.querySelector('.pn-tk-bar')?.setAttribute('aria-valuenow', String(pct));
  }

  // ── 본문 — 늘 펼쳐 읽고, 누르면 고친다 ─────────────────────────────────────────────────
  const bodyBox = el('div', { class: 'pj-bodywrap' });
  let bodyEdit = false, bodyMore = false, bodySig = '';
  let bodyBase = '';
  let stashedByMe = false;
  let bodyGen = 0;
  const openProjectWindow = (): void => requestOpenRoute('#/projects2/p/' + ctx.id);
  const copyBody = (): void => { void copyText(String(proj().description || '')).then((ok) => { if (ok) toast('본문 전체를 복사했어요.'); }); };
  const bigBody = (): void => openBodyModal(String(proj().name || '프로젝트 본문'), String(proj().description || ''), [
    { label: '전체 복사', icon: 'copy', run: copyBody },
    { label: '고치기', icon: 'pencil', run: () => void startBodyEdit() },
    { label: '프로젝트 창', icon: 'ext', run: openProjectWindow, primary: true },
  ]);
  const iconBtn = (icon: string, title: string, run: () => void): HTMLElement =>
    el('button', { class: 'pj-ib', type: 'button', title, 'aria-label': title, onclick: (e: Event) => { e.stopPropagation(); run(); } }, pnIcon(icon, 'pn-i sm'));

  function paintBody(force?: boolean): void {
    if (bodyEdit) return;
    const md = String(proj().description || '');
    const sig = md.length + '|' + md.slice(0, 200) + md.slice(-200) + '|' + (bodyMore ? 1 : 0);
    if (!force && sig === bodySig) return;
    bodySig = sig;
    const shown = stripLeadNotice(md);
    //  접힌 글은 앞부분만(흐려지며 끝남), 편 글은 **제 안에서 스크롤**한다 — 곁칸 전체를 밀어 내리지 않고, 접기 단추가 늘 머리에 남게(원준 2026-09-27).
    const rd = el('div', { class: 'pj-rd md-rendered' + (bodyMore ? ' pj-rdopen' : ' pj-prd') },
      shown.trim() ? renderMarkdown(shown.length > BODY_READ_MAX ? shown.slice(0, BODY_READ_MAX) + '\n\n…(길어서 여기까지 — [크게 보기]나 프로젝트 창에서 전문)' : shown)
        : el('p', { class: 'pj-empty', text: '아직 적지 않았어요 — 눌러서 이 프로젝트가 무엇인지 적어 두면 세션도 그걸 읽고 일합니다.' }));
    const box = el('div', {
      class: 'pj-body', role: 'button', tabindex: '0', title: '누르면 고칩니다',
      onclick: (e: Event) => {
        if ((e.target as HTMLElement).closest('a,button')) return;
        if (window.getSelection()?.toString()) return;             // 글을 긁는 중 — 고치기로 넘어가지 않는다
        void startBodyEdit();
      },
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); void startBodyEdit(); } },
    },
      el('div', { class: 'pj-bh' }, el('span', { class: 'pj-bl', text: '본문' }),
        el('span', { class: 'pn-fine', text: md.length ? `${md.length.toLocaleString('ko-KR')}자` : '비어 있음' }),
        el('span', { class: 'grow' }),
        iconBtn('copy', '본문 전체 복사', copyBody),
        //  «창에 띄워 읽기» 는 글자까지 단다 — 화살표 아이콘만 두면 전체 화면으로 읽혀 창이 뜬다는 느낌이 안 든다(원준 2026-09-27).
        el('button', { class: 'pj-popb', type: 'button', title: '본문만 창에 띄워 읽습니다', onclick: (e: Event) => { e.stopPropagation(); bigBody(); } },
          pnIcon('window', 'pn-i xs'), el('span', { text: '띄워 읽기' })),
        shown.trim() ? el('button', { class: 'pj-ib pj-foldb', type: 'button', title: bodyMore ? '접기' : '펼치기', 'aria-label': bodyMore ? '본문 접기' : '본문 펼치기', 'aria-expanded': String(bodyMore),
          onclick: (e: Event) => { e.stopPropagation(); bodyMore = !bodyMore; paintBody(true); } }, pnIcon(bodyMore ? 'up' : 'chevD', 'pn-i sm')) : null),
      rd);
    replaceKids(bodyBox, box);
  }

  /** 본문 고치기 — 종전 [본문] 접이와 같은 편집칸(가드 저장·충돌 안내·못 남긴 글 보관). 칸을 떠나면 읽기로 돌아간다. */
  async function startBodyEdit(): Promise<void> {
    if (bodyEdit) return;
    bodyEdit = true;
    const gen = ++bodyGen;
    const ta = el('textarea', { class: 'pn-tk-ta big', 'aria-label': '프로젝트 본문', disabled: '',
      placeholder: '이 프로젝트가 무엇인지 적어 두면 세션도 그걸 읽고 일합니다.' }) as HTMLTextAreaElement;
    const chip = el('span', { class: 'pn-set-chip' });
    const size = el('span', { class: 'pn-fine' });
    const acts = el('span', { class: 'pn-tk-editor-acts' });
    const foot = el('div', { class: 'pn-tk-editor-foot' }, chip, el('span', { class: 'grow' }), size, acts);
    replaceKids(bodyBox, el('div', { class: 'pj-body edit' }, el('div', { class: 'pn-tk-editor' }, ta, foot)));
    const count = (): void => { size.textContent = ta.value.length ? ta.value.length.toLocaleString('ko-KR') + '자' : ''; };
    ta.addEventListener('input', count);
    const linkBtn = (text: string, run: () => void, title?: string): HTMLElement => el('button', { class: 'btn-text pn-tk-link', type: 'button', text, title, onclick: run });
    const baseActs = (): HTMLElement[] => [linkBtn('다 고쳤어요', () => void stopBodyEdit(), '저장하고 읽기로 돌아갑니다')];
    const lostOffscreen = (live: string): boolean => {
      if (ta.isConnected) return false;
      const kept = keepUnsaved(ctx.id, 'body', live);
      if (kept) stashedByMe = true;
      toast(kept ? '본문을 저장하지 못했어요 — 프로젝트 칸에서 본문을 다시 누르면 쓰던 글을 꺼낼 수 있어요.'
        : '저장하지 못했어요 — 쓰던 글이 너무 길어 보관하지도 못했어요.', true);
      return true;
    };
    // 펴는 순간의 **최신** 본문에서 시작한다 — 셸이 쥔 상세는 마운트 때 것이라, 그 위에서 고치면 그 사이 덧붙임을 지운다.
    try { const d = await api('/api/ui/v6/projects/' + ctx.id); if (d) { fresh = d; loadedAt = Date.now(); } } catch (_) { /* 쥔 것으로 시작 */ }
    if (gen !== bodyGen || ctx.dead()) return;
    bodyBase = String(proj().description || '');
    ta.value = bodyBase;
    bodySaver = autoSave(ta, chip, async (text) => {
      const r = await api('/api/ui/v6/projects/' + ctx.id, { method: 'POST', body: JSON.stringify({ description: text || null, description_base: bodyBase }) });
      const kept = String(r?.project?.description || '');
      bodyBase = kept;
      if (fresh?.project) fresh.project.description = kept;
      return kept;
    }, {
      onSaved: () => { if (stashedByMe) { clearUnsaved(ctx.id, 'body'); stashedByMe = false; } count(); ctx.onChanged?.(); },
      onFail: (e, live) => {
        if (lostOffscreen(live)) return e?.status === 409 ? 'pause' : 'handled';
        if (e?.status !== 409) return;
        chip.textContent = '다른 곳에서 본문이 바뀌었어요.'; chip.classList.add('warn');
        size.textContent = '';
        replaceKids(acts,
          linkBtn('내 글 복사', () => void copyText(ta.value).then((ok) => { if (ok) toast('쓰던 글을 복사했어요.'); })),
          linkBtn('최신 본문 불러오기', () => { void reopenBody(); }, '쓰던 글을 버리고 지금 본문에서 다시 시작합니다'));
        return 'pause';
      },
    });
    ta.disabled = false; count();
    replaceKids(acts, ...baseActs());
    // 지난번에 못 남긴 글이 있다 — 본문은 통째로 되살리지 않고 복사만(보관본은 그 뒤 세션이 덧붙인 기록을 모르는 글이다).
    const lost = readUnsaved(ctx.id, 'body');
    if (lost !== null && lost !== ta.value) {
      chip.textContent = '지난번에 저장하지 못한 글이 있어요.'; chip.classList.add('warn');
      size.textContent = '';
      const settle = (): void => { chip.textContent = ''; chip.classList.remove('warn'); count(); replaceKids(acts, ...baseActs()); };
      replaceKids(acts,
        linkBtn('내 글 복사', () => void copyText(lost).then((ok) => { if (ok) toast('그때 쓰던 글을 복사했어요 — 필요한 곳에 붙여 넣으세요.'); }), '그때 쓰던 본문 전체를 복사합니다(지금 본문은 그대로 둡니다)'),
        linkBtn('버리기', () => { clearUnsaved(ctx.id, 'body'); settle(); }));
    } else if (lost !== null) clearUnsaved(ctx.id, 'body');
    ta.focus();
    try { ta.setSelectionRange(0, 0); } catch (_) { /* noop */ }
    ta.scrollTop = 0;
  }
  /** 고치기를 마친다 — **못 남긴 글이 있으면 닫지 않는다**(false). */
  async function stopBodyEdit(): Promise<boolean> {
    if (!bodyEdit) return true;
    if (bodySaver) {
      await bodySaver.flush();
      if (bodySaver.dirty()) { toast('아직 저장하지 못한 글이 있어 읽기로 돌아가지 않았어요.', true); return false; }
    }
    dropBodyEdit();
    return true;
  }
  function dropBodyEdit(): void {
    bodyGen++;
    bodySaver?.destroy(); bodySaver = null;
    bodyEdit = false;
    paintBody(true);
  }
  async function reopenBody(): Promise<void> { dropBodyEdit(); await startBodyEdit(); }
  bodyBox.addEventListener('focusout', () => {
    // 칸 밖으로 손이 나갔다 — 저장이 끝나면 읽기로(글칸 안의 단추로 옮겨 가는 중이면 그대로).
    //  ⚠ 편집칸이 **준비된 뒤에만**(bodySaver 가 섰다) — 여는 동안 눌렀던 읽기 칸이 걷히며 나는 focusout 에 막 연 편집을 닫지 않게.
    window.setTimeout(() => { if (bodyEdit && bodySaver && !bodyBox.contains(document.activeElement)) void stopBodyEdit(); }, 0);
  });

  // ── 목록 ──
  const top = el('div', { class: 'pj-top' });
  const list = el('div', { class: 'pn-tk-list pj-scroll' });
  for (const host of [top, list]) host.addEventListener('focusout', () => {
    window.setTimeout(() => { if (listDirty && !typingIn(list) && !typingIn(top)) paintList(); }, 0);
  });

  const goSession = (sid: string): void => requestOpenRoute('#/s/' + encodeURIComponent(sid));

  /** 이 태스크를 맡은 **새** 세션을 연다(첫 지시는 서버가 태스크 번호·본문으로). */
  async function openTaskSession(t: any): Promise<void> {
    const tid = Number(t && t.id);
    if (!(tid > 0) || opening) return;
    opening = tid; paintList(true);
    try {
      const made = await spawnSession('', { projectId: ctx.id, taskId: tid });
      if (!made) return;
      seedSessName(made.id, String(t.name || ''));
      ctx.onSessionCreated?.(made.session);
      changed();
      toast('이 태스크를 맡은 세션을 열었어요.');
      goSession(made.id);
    } finally { opening = 0; paintList(true); }
  }

  function setStatus(t: any, status: 'todo' | 'in_progress' | 'done'): void {
    void api('/api/ui/v6/tasks/' + t.id, { method: 'POST', body: JSON.stringify({ status }) })
      .then(() => { changed(); toast(status === 'done' ? '완료로 바꿨어요.' : status === 'in_progress' ? '진행 중으로 바꿨어요.' : '할 일로 바꿨어요.'); })
      .catch((e: any) => toast('바꾸지 못했어요 — ' + (e?.message || e), true));
  }
  const statusKey = (t: any): 'todo' | 'doing' | 'done' => (isDone(t) ? 'done' : isDoing(t) ? 'doing' : 'todo');
  const statusText = (t: any): string => (isDone(t) ? '완료' : isDoing(t) ? '진행 중' : '할 일');
  const nativeOf = (t: any): string => (isDone(t) ? 'done' : isDoing(t) ? 'in_progress' : 'todo');

  /** 상태 원 — 누르면 **프로젝트 탭과 같은 팝오버**에서 고른다(한 칸씩 밀지 않는다). */
  function glyph(t: any): HTMLElement {
    const btn = el('button', {
      class: 'pn-tk-st ' + statusKey(t), type: 'button', 'aria-haspopup': 'menu',
      'aria-label': '상태: ' + statusText(t) + ' — 눌러서 고르기', title: '상태: ' + statusText(t) + ' — 눌러서 고릅니다',
    }) as HTMLButtonElement;
    btn.onclick = (e: Event) => {
      e.stopPropagation();
      const now = nativeOf(t);
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(btn, menu);
      for (const key of PJV_STATUS_ORDER) {
        const on = key === now;
        const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
          pjvStatusIconStd(key, 'sm'), el('span', { text: (PJV_TASK_STATUS as any)[key].label }));
        item.onclick = () => { close(); if (!on) setStatus(t, key as any); };
        menu.append(item);
      }
    };
    return btn;
  }

  /** 세션 배지 — 같은 세션은 어느 줄에서나 같은 색. 누르면 그 세션으로. */
  function sessBadge(ref: TaskSessRef, s: Sess | null): HTMLElement | null {
    const n = nums().get(String(ref.id)) || (s ? nums().get(s.id) : 0) || 0;
    if (!n) return null;
    const name = String(ref.label || s?.label || '').trim() || '세션';
    const nth = ref.count && ref.count > 1 && ref.order ? ` · ${ref.order}번째` : '';
    return el('button', {
      class: 'pj-sb', type: 'button', style: '--sc:' + sessionColor(n),
      title: `세션 ${n} «${name}»으로 갑니다` + (s ? ` — ${s.stateLabel}` : '') + (nth ? `\n그 세션이 할 태스크 ${ref.count}개 가운데 ${ref.order}번째` : ''),
      onclick: (e: Event) => { e.stopPropagation(); goSession(s?.id || String(ref.id)); },
    }, el('span', { class: 'pj-sbn', text: '세션 ' + n }), nth ? el('span', { class: 'pj-ord', text: nth }) : null);
  }
  function liveOf(s: Sess | null): HTMLElement | null {
    if (!s) return null;
    return el('span', { class: 'pj-live', title: s.stateLabel }, el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { text: s.stateLabel }));
  }

  // ── 순서(«이 세션의 태스크») ──
  const myOrder = (): number[] => (localOrder ? localOrder.slice() : sessionTaskOrder(tasks(), myIds()).map((t) => Number(t.id)));
  async function putOrder(ids: number[], msg?: string): Promise<boolean> {
    const sid = myKey();
    if (!sid) return false;
    const prev = localOrder;
    localOrder = ids.slice(); paintList(true);
    try {
      await api(`/api/ui/v6/projects/${ctx.id}/sessions/${encodeURIComponent(sid)}/tasks`, { method: 'PUT', body: JSON.stringify({ taskIds: ids }) });
      if (msg) toast(msg);
      changed();
      return true;
    } catch (e: any) {
      localOrder = prev; paintList(true);
      toast('순서를 바꾸지 못했어요 — ' + (e?.message || e), true);
      return false;
    }
  }
  /** 이 세션의 입력칸에 태스크 이름·본문을 넣는다(보내지 않는다). 세션 화면이 안 떠 있으면 복사로 물러난다. */
  function putPrompt(t: any): void {
    const text = taskPromptText(t);
    if (putIntoSession(myIds(), text)) { toast('입력칸에 넣었어요 — 읽어 보고 보내세요.'); return; }
    void copyText(text).then((ok) => toast(ok ? '세션 입력칸을 찾지 못해 복사했어요 — 붙여 넣으세요.' : '넣지 못했어요.', !ok));
  }
  /** [이 세션에 넣기] — 이 세션의 다음 번호로 붙이고, 이름·본문을 입력칸에 넣는다. */
  async function takeIntoThis(t: any): Promise<void> {
    const tid = Number(t.id);
    const ids = myOrder();
    if (!ids.includes(tid) && !(await putOrder([...ids, tid]))) return;
    putPrompt(t);
  }

  function actChip(kind: 'go' | 'take' | 'put' | 'pick' | 'picked', t: any, extra?: { s?: Sess | null; n?: number }): HTMLElement {
    const tid = Number(t.id);
    if (opening === tid) return el('button', { class: 'pn-tk-chip pj-act', type: 'button', disabled: '' }, el('span', { text: '여는 중…' }));
    if (kind === 'go') {
      const s = extra?.s || null;
      return el('button', { class: 'pn-tk-chip on pj-act go' + (s && !s.alive ? ' past' : ''), type: 'button',
        title: s ? `이 태스크를 맡은 세션 «${s.label}»으로 갑니다 — ${s.stateLabel}` : '이 태스크를 맡은 세션으로 갑니다',
        onclick: (e: Event) => { e.stopPropagation(); if (s) goSession(s.id); } },
      pnIcon('goto', 'pn-i sm'), el('span', { text: '세션으로' }));
    }
    if (kind === 'take') return el('button', { class: 'pn-tk-chip pj-act take', type: 'button',
      title: '이 세션의 다음 번호로 넣고, 태스크 이름과 본문을 입력칸에 넣습니다(보내지는 않습니다)',
      onclick: (e: Event) => { e.stopPropagation(); void takeIntoThis(t); } }, pnIcon('insert', 'pn-i sm'), el('span', { text: '이 세션에 넣기' }));
    if (kind === 'put') return el('button', { class: 'pn-tk-chip pj-act put', type: 'button',
      title: '태스크 이름과 본문을 지금 세션의 입력칸에 넣습니다(보내지는 않습니다)',
      onclick: (e: Event) => { e.stopPropagation(); putPrompt(t); } }, pnIcon('insert', 'pn-i sm'), el('span', { text: '본문 넣기' }));
    if (kind === 'picked') return el('button', { class: 'pn-tk-chip pj-act picked', type: 'button',
      title: '담았어요 — 누르면 뺍니다. 순서는 가운데 글칸의 번호로 바꿔요',
      onclick: (e: Event) => { e.stopPropagation(); toggleTaskPick(picksRoot(), tid); } }, pnIcon('check', 'pn-i sm'), el('span', { text: `담김 ${extra?.n || ''}`.trim() }));
    return el('button', { class: 'pn-tk-chip pj-act take', type: 'button',
      title: '새 세션이 맡을 태스크로 담습니다 — 가운데 글칸에 번호 배지로 들어가요. 여러 개 담으면 그 순서대로 진행해요',
      onclick: (e: Event) => { e.stopPropagation(); toggleTaskPick(picksRoot(), tid); } }, pnIcon('plus', 'pn-i sm'), el('span', { text: '담기' }));
  }

  const moreBtn = (rows: () => CtxRow[], title: string): HTMLElement => el('button', {
    class: 'pj-ib', type: 'button', title: '더 보기', 'aria-label': '더 보기',
    onclick: (e: Event) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); showCtxMenu(r.left, r.bottom + 4, rows(), { title }); },
  }, pnIcon('more', 'pn-i sm'));
  const copyName = (t: any): CtxRow => ({ label: '이름 복사', icon: 'copy', run: () => void copyText(String(t.name || '')).then((ok) => { if (ok) toast('복사했어요'); }) });
  const copyTaskBody = (t: any): void => { void copyText(taskPromptText(t)).then((ok) => { if (ok) toast('태스크 이름과 본문을 복사했어요.'); }); };
  const boardRow: CtxRow = { label: '보드에서 보기', icon: 'proj', run: () => requestOpenRoute('#/projects2/p/' + ctx.id) };

  /** 줄의 속 — 본문(읽기 · 누르면 고치기) · 할 일. */
  function detailOf(t: any, primary: HTMLElement | null): HTMLElement {
    const tid = Number(t.id);
    const md = drafts.has(tid) ? String(drafts.get(tid)) : String(t.description || '');
    let inner: HTMLElement;
    if (editTask === tid) {
      const ta = el('textarea', { class: 'pn-tk-ta', rows: '5', 'aria-label': '태스크 본문', placeholder: '무엇을 하는 태스크인지, 어디까지 하면 끝인지 적어 두세요. 이 태스크를 맡은 세션이 읽습니다.' }) as HTMLTextAreaElement;
      ta.value = md;
      const chip = el('span', { class: 'pn-set-chip' });
      ta.addEventListener('input', () => drafts.set(tid, ta.value));
      rowSaver?.destroy();
      rowSaver = autoSave(ta, chip, async (text) => {
        await api('/api/ui/v6/tasks/' + tid, { method: 'POST', body: JSON.stringify({ description: text || null }) });
        t.description = text;
        if (drafts.get(tid) === text) drafts.delete(tid);
        return text;
      });
      if (drafts.has(tid) && drafts.get(tid) !== String(t.description || '')) rowSaver.setSaved(String(t.description || ''));
      inner = el('div', { class: 'pj-dedit' }, ta, el('div', { class: 'pn-tk-ta-foot' }, chip,
        el('button', { class: 'btn-text pn-tk-link', type: 'button', text: '다 고쳤어요', onclick: () => void (rowSaver ? rowSaver.flush() : Promise.resolve()).then(() => { if (rowSaver?.dirty()) return; editTask = 0; paintList(true); }) })));
      window.setTimeout(() => { if (ta.isConnected) ta.focus(); }, 0);
    } else {
      const shown = stripLeadNotice(md);
      inner = el('div', {
        class: 'pj-rd pj-drd md-rendered', role: 'button', tabindex: '0', title: '누르면 고칩니다',
        onclick: (e: Event) => { if ((e.target as HTMLElement).closest('a,button') || window.getSelection()?.toString()) return; editTask = tid; paintList(true); },
      }, shown.trim() ? renderMarkdown(shown.slice(0, 20_000)) : el('p', { class: 'pj-empty', text: '본문이 없어요 — 눌러서 적어 두면 이 태스크를 맡은 세션이 읽습니다.' }));
    }
    const subs: any[] = Array.isArray(t.subtasks) ? t.subtasks : [];
    const subBox = subs.length ? el('div', { class: 'pn-tk-sec' },
      el('div', { class: 'pn-tk-sec-h' }, el('span', { text: '하위 할 일' }), el('span', { class: 'n', text: `${subs.filter(isDone).length}/${subs.length}` })),
      ...subs.map((s) => el('div', { class: 'pn-tk-row sub' + (isDone(s) ? ' done' : '') }, glyph(s), el('span', { class: 'pn-tk-sub-n ell', title: s.name, text: s.name || '이름 없는 할 일' })))) : null;
    const acts = el('div', { class: 'pj-dacts' },
      primary,
      el('button', { class: 'btn-text pj-dact', type: 'button', onclick: () => copyTaskBody(t) }, pnIcon('copy', 'pn-i sm'), el('span', { text: '본문 복사' })),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn-text pj-dact', type: 'button', title: '체크리스트·댓글·연결은 보드에서 봅니다', onclick: () => requestOpenRoute('#/projects2/p/' + ctx.id) }, pnIcon('proj', 'pn-i sm'), el('span', { text: '보드' })));
    return el('div', { class: 'pn-tk-detail pj-detail' }, inner, subBox, acts);
  }

  function toggleOpen(t: any): void {
    const tid = Number(t.id);
    const next = openTask === tid ? 0 : tid;
    void (rowSaver ? rowSaver.flush() : Promise.resolve()).then(() => { if (rowSaver?.dirty()) return; openTask = next; editTask = 0; paintList(true); });
  }

  const nameBtnOf = (t: any, open: boolean): HTMLElement => el('button', {
    class: 'pn-tk-rname', type: 'button', 'aria-expanded': String(open), title: String(t.name || '') + '\n누르면 본문을 펼칩니다', onclick: () => toggleOpen(t),
  }, el('span', { class: 'ell', text: t.name || '이름 없는 태스크' }));

  /** 다른 세션 배지·상태 한 줄 — 세션이 없으면 «세션 없음». */
  function sessMeta(t: any): HTMLElement[] {
    const mine = new Set(myIds());
    const out: HTMLElement[] = [];
    const refs = refsOf(t).filter((r) => !mine.has(String(r.id)));
    const o = otherSessOf(t);
    for (const r of refs.slice(0, 2)) { const b = sessBadge(r, sessOf(String(r.id))); if (b) out.push(b); }
    if (o) { const lv = liveOf(o.s); if (lv) out.push(lv); }
    if (!out.length) out.push(el('span', { class: 'pj-fine', text: '세션 없음' }));
    return out;
  }

  // ── «이 세션의 태스크» 줄 ──
  function tsRow(t: any, i: number, n: number): HTMLElement[] {
    const tid = Number(t.id);
    const open = openTask === tid;
    const ids = myOrder();
    const firstOpen = ids.map(byId).find((x) => x && !isDone(x));
    const now = firstOpen && Number(firstOpen.id) === tid;
    const row = el('div', { class: 'pn-tk-row pj-row pj-ts' + (isDone(t) ? ' done' : '') + (open ? ' open' : ''), draggable: 'true', 'data-i': String(i) },
      el('span', { class: 'pj-grip', title: '끌어서 순서 바꾸기', 'aria-hidden': 'true' }, pnIcon('grip', 'pn-i xs')),
      el('span', { class: 'pj-num', text: (i + 1) + '.' }),
      glyph(t),
      el('div', { class: 'pj-main' }, nameBtnOf(t, open),
        el('div', { class: 'pj-meta' }, el('span', { class: 'pj-id', text: '#' + tid }),
          now ? el('span', { class: 'pj-now', text: '지금 하는 일' })
            : el('span', { class: 'pj-fine', text: isDone(t) ? '끝냄' : '앞의 것이 끝나면 이어서' }))),
      el('div', { class: 'pj-acts' }, actChip('put', t),
        moreBtn(() => [
          { label: '위로', icon: 'up', off: i === 0, run: () => void putOrder(moveInOrder(ids, i, i - 1)) },
          { label: '아래로', icon: 'chevD', off: i >= n - 1, run: () => void putOrder(moveInOrder(ids, i, i + 1)) },
          { label: '1번으로', icon: 'up', off: i === 0, run: () => void putOrder(moveInOrder(ids, i, 0)) },
          { sep: true, label: '' },
          { label: '본문 넣기', icon: 'insert', hint: '입력칸에만', run: () => putPrompt(t) },
          { label: '본문 복사', icon: 'copy', run: () => copyTaskBody(t) },
          boardRow,
          copyName(t),
          { sep: true, label: '' },
          { label: '이 세션에서 빼기', icon: 'x', danger: true, run: () => void putOrder(ids.filter((x) => x !== tid), '이 세션에서 뺐어요 — 태스크는 그대로 있어요.') },
        ], String(t.name || '태스크'))));
    row.addEventListener('dragstart', (e: DragEvent) => {
      dragFrom = i; row.classList.add('pj-lift');
      e.dataTransfer?.setData(TASK_DRAG_TYPE, String(tid));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { dragFrom = -1; row.classList.remove('pj-lift'); insline.remove(); });
    bindCtx(row, () => ({ title: String(t.name || '태스크'), sub: `이 세션 ${i + 1}번 · ${statusText(t)}`,
      rows: [{ label: '본문 넣기', icon: 'insert', run: () => putPrompt(t) }, { label: '본문 복사', icon: 'copy', run: () => copyTaskBody(t) }, boardRow, copyName(t)] }));
    return open ? [row, detailOf(t, actChip('put', t))] : [row];
  }

  // ── 끌어 놓기 — «이 세션의 태스크» 안에서 순서 · 아래 외부 줄을 끌어 와 넣기 ──
  const insline = el('div', { class: 'pj-insline', 'aria-hidden': 'true' });
  function tsDropIndex(sec: HTMLElement, e: DragEvent): number {
    const rows = ([...(sec as HTMLElement).querySelectorAll('.pj-ts')] as HTMLElement[]);
    for (let k = 0; k < rows.length; k++) { const r = rows[k].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) return k; }
    return rows.length;
  }
  const dragAccepts = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes(TASK_DRAG_TYPE);
  function wireTsDrop(sec: HTMLElement): void {
    sec.addEventListener('dragover', (e: DragEvent) => {
      if (!dragAccepts(e)) return;
      e.preventDefault();
      const at = tsDropIndex(sec, e);
      const rows = ([...(sec as HTMLElement).querySelectorAll('.pj-ts')] as HTMLElement[]);
      if (at < rows.length) rows[at].before(insline);
      else (sec.querySelector('.pj-slot') || sec.lastElementChild)?.before(insline);
    });
    sec.addEventListener('dragleave', (e: DragEvent) => { if (!sec.contains(e.relatedTarget as Node)) insline.remove(); });
    sec.addEventListener('drop', (e: DragEvent) => {
      if (!dragAccepts(e)) return;
      e.preventDefault();
      const tid = Number(e.dataTransfer?.getData(TASK_DRAG_TYPE) || 0);
      const at = tsDropIndex(sec, e);
      insline.remove();
      const ids = myOrder();
      const from = dragFrom >= 0 ? dragFrom : ids.indexOf(tid);
      if (from >= 0) { const to = from < at ? at - 1 : at; if (to !== from) void putOrder(moveInOrder(ids, from, to)); return; }
      if (tid > 0) { const next = ids.slice(); next.splice(at, 0, tid); void putOrder(next, '이 세션에 넣었어요.'); }
    });
  }

  /** 늘 하나 남는 빈 칸 — 누르면 찾기, 아래 줄을 끌어 와 놓아도 된다. */
  function slotOf(n: number): HTMLElement[] {
    const ids = new Set(myOrder());
    if (!slotOpen) {
      return [el('button', { class: 'pj-slot', type: 'button', title: '이 세션이 이어서 할 태스크를 찾아 넣습니다 — 아래 목록에서 끌어 와도 돼요',
        onclick: () => { slotOpen = true; slotQ = ''; slotSel = 0; paintList(true); } },
      el('span', { class: 'pj-num', text: (n + 1) + '.' }), pnIcon('search', 'pn-i sm'),
      el('span', { class: 'pj-slot-in pj-ph', text: n ? '다음 태스크 찾기 · 아래에서 끌어 오기' : '이 세션이 할 태스크 찾기 · 아래에서 끌어 오기' }))];
    }
    const inp = el('input', { class: 'pj-slot-q', type: 'text', placeholder: '태스크 이름이나 #번호', value: slotQ, 'aria-label': '넣을 태스크 찾기' }) as HTMLInputElement;
    const q = slotQ.trim().toLowerCase().replace(/^#/, '');
    const cands = tasks().filter((t) => !ids.has(Number(t.id)) && (!q || String(t.name || '').toLowerCase().includes(q) || String(t.id).startsWith(q)))
      .sort((a, b) => Number(isDone(a)) - Number(isDone(b))).slice(0, 7);
    slotSel = Math.min(slotSel, Math.max(0, cands.length - 1));
    const pick = (t: any): void => { slotOpen = false; void putOrder([...myOrder(), Number(t.id)], '이 세션에 넣었어요.'); };
    inp.addEventListener('input', () => { slotQ = inp.value; slotSel = 0; paintList(true); const n2 = ((top as HTMLElement).querySelector('.pj-slot-q') as HTMLInputElement | null); n2?.focus(); n2?.setSelectionRange(n2.value.length, n2.value.length); });
    inp.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown') { slotSel = Math.min(slotSel + 1, cands.length - 1); e.preventDefault(); paintList(true); ((top as HTMLElement).querySelector('.pj-slot-q') as HTMLInputElement | null)?.focus(); }
      else if (e.key === 'ArrowUp') { slotSel = Math.max(slotSel - 1, 0); e.preventDefault(); paintList(true); ((top as HTMLElement).querySelector('.pj-slot-q') as HTMLInputElement | null)?.focus(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (cands[slotSel]) pick(cands[slotSel]); }
      else if (e.key === 'Escape') { e.preventDefault(); slotOpen = false; paintList(true); }
    });
    inp.addEventListener('blur', () => window.setTimeout(() => { if (slotOpen && !top.contains(document.activeElement)) { slotOpen = false; paintList(true); } }, 150));
    window.setTimeout(() => { if (inp.isConnected && document.activeElement !== inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }, 0);
    const dd = el('div', { class: 'pj-dd', role: 'listbox' },
      cands.length ? null : el('div', { class: 'pj-dd-h', text: '맞는 태스크가 없어요' }),
      ...cands.map((t, k) => el('div', { class: 'pj-dd-i' + (k === slotSel ? ' sel' : ''), role: 'option',
        onmousedown: (e: Event) => { e.preventDefault(); pick(t); } },
      el('span', { class: 'pn-tk-st static ' + statusKey(t), 'aria-hidden': 'true' }),
      el('span', { class: 'pj-dd-n' }, el('span', { class: 'ell', text: t.name || '이름 없는 태스크' }), el('span', { class: 'pj-dd-m', text: '#' + t.id + (refsOf(t).length ? ' · 다른 세션에도 있어요' : '') })))),
      el('div', { class: 'pj-dd-f', text: '↑↓ 고르기 · Enter 넣기 · Esc 닫기' }));
    return [el('div', { class: 'pj-slot on' }, el('span', { class: 'pj-num', text: (n + 1) + '.' }), pnIcon('search', 'pn-i sm'), inp), dd];
  }

  // ── 외부 줄 · 새 세션 자리 줄 ──
  function extRow(t: any, mode: 'ext' | 'new', pickN: number): HTMLElement[] {
    const tid = Number(t.id);
    const open = openTask === tid;
    const o = otherSessOf(t);
    let act: HTMLElement;
    if (mode === 'new') act = pickN ? actChip('picked', t, { n: pickN }) : o ? actChip('go', t, { s: o.s }) : actChip('pick', t);
    else act = o ? actChip('go', t, { s: o.s }) : actChip('take', t);
    const rows = (): CtxRow[] => [
      ...(o ? [{ label: '맡은 세션으로 가기', icon: 'chat', run: () => goSession(o.s.id) }] : []),
      ...(mode === 'new'
        ? [{ label: pickN ? '담은 것에서 빼기' : '새 세션에 담기', icon: pickN ? 'x' : 'plus', run: () => toggleTaskPick(picksRoot(), tid) }]
        : [{ label: '이 세션에 넣기', icon: 'insert', hint: '다음 번호로', run: () => void takeIntoThis(t) }]),
      { label: refsOf(t).length ? '새 세션으로 이어 하기' : '새 세션 열기', icon: 'plus', run: () => void openTaskSession(t) },
      { sep: true, label: '' },
      { label: '본문 복사', icon: 'copy', run: () => copyTaskBody(t) },
      boardRow,
      copyName(t),
    ];
    const row = el('div', { class: 'pn-tk-row pj-row' + (mode === 'new' ? ' pj-new' : ' pj-ext') + (isDone(t) ? ' done' : '') + (open ? ' open' : '') + (pickN ? ' pj-picked' : ''), draggable: 'true' },
      glyph(t),
      el('div', { class: 'pj-main' }, nameBtnOf(t, open),
        el('div', { class: 'pj-meta' }, ...sessMeta(t), el('span', { class: 'pj-id', text: '#' + tid }))),
      el('div', { class: 'pj-acts' }, act, moreBtn(rows, String(t.name || '태스크'))));
    row.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer?.setData(TASK_DRAG_TYPE, String(tid));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
      row.classList.add('pj-lift');
    });
    row.addEventListener('dragend', () => { row.classList.remove('pj-lift'); insline.remove(); });
    bindCtx(row, () => ({ title: String(t.name || '태스크'), sub: statusText(t), rows: rows() }));
    const primary = mode === 'new' ? null : (o ? actChip('go', t, { s: o.s }) : actChip('take', t));
    return open ? [row, detailOf(t, primary)] : [row];
  }

  function groupHead(label: string, n: number, extra?: HTMLElement | null, fold?: { open: boolean; toggle: () => void }): HTMLElement {
    const inner = [el('span', { text: label }), el('span', { class: 'n', text: String(n) }), extra || null];
    return fold
      ? el('button', { class: 'pn-tk-gh fold' + (fold.open ? ' open' : ''), type: 'button', 'aria-expanded': String(fold.open), onclick: fold.toggle }, pnIcon('chev', 'pn-i xs pn-tk-chev'), ...inner)
      : el('div', { class: 'pn-tk-gh' }, ...inner);
  }

  function paintList(force?: boolean): void {
    const all = tasks();
    const newMode = isNew();
    const picks = newMode ? taskPicks(picksRoot()) : [];
    const order = newMode ? [] : myOrder();
    const doneOpen = doneOpenByDefault(all.filter(isDone).length, lsGet(DONE_OPEN_KEY, ''));
    const sessSig = (t: any): string => refsOf(t).map((x) => x.id + (x.label || '') + (x.order || '') + (sessOf(String(x.id))?.stateKey || '')).join(',');
    const sig = [mySid() || '', order.join('.'), picks.join('.'), openTask, editTask, opening, doneOpen ? 1 : 0, slotOpen ? 'q' + slotQ + slotSel : '',
      all.map((t) => t.id + (t.status_category || '') + (t.name || '') + String(t.description || '').length + sessSig(t)
        + (Array.isArray(t.subtasks) ? t.subtasks.map((s: any) => s.id + (s.status_category || '')).join('.') : '')).join('|')].join('§');
    if (!force && sig === listSig) return;
    if ((typingIn(list) || typingIn(top)) && !top.querySelector('.pj-slot-q:focus')) { listDirty = true; return; }
    listSig = sig; listDirty = false;
    if (openTask && !all.some((t) => Number(t.id) === openTask)) { openTask = 0; editTask = 0; }

    //  위(머리·본문·이 세션의 태스크·목록 머리)는 서 있고, **스크롤은 아래 목록 안에서만**(원준 2026-09-27).
    const tops: HTMLElement[] = [bodyBox];
    const kids: HTMLElement[] = [];
    if (!all.length) {
      tops.push(el('div', { class: 'pn-empty' }, pnIcon('projtask', 'pn-i big'),
        el('b', { text: '태스크가 아직 없어요.' }),
        el('p', { class: 'pn-fine', text: '이 프로젝트에서 세션을 열면 그 세션의 태스크가 저절로 생깁니다. 아래에서 직접 더해도 돼요.' })));
    } else if (newMode) {
      const ext = externalTasks(all, new Set(), busyOf);
      const tag = picks.length ? el('span', { class: 'pj-picked-n', text: `${picks.length}개 담음 · 순서는 글칸에서` }) : null;
      tops.push(groupHead('이 프로젝트의 태스크', ext.open.length + ext.done.length, tag));
      if (!picks.length) tops.push(el('p', { class: 'pj-hint', text: '[담기]로 새 세션이 맡을 태스크를 고르세요 — 가운데 글칸에 번호 배지로 들어가고, 그 순서대로 진행해요.' }));
      kids.push(...ext.open.flatMap((t) => extRow(t, 'new', picks.indexOf(Number(t.id)) + 1)));
      if (ext.done.length) {
        kids.push(groupHead('완료', ext.done.length, null, { open: doneOpen, toggle: () => { lsSet(DONE_OPEN_KEY, doneOpen ? '0' : '1'); paintList(true); } }));
        if (doneOpen) kids.push(...ext.done.flatMap((t) => extRow(t, 'new', picks.indexOf(Number(t.id)) + 1)));
      }
    } else {
      const mine = order.map(byId).filter(Boolean);
      const sec = el('div', { class: 'pj-sec pj-tssec' });
      const n0 = nums().get(myKey()) || nums().get(mySid() || '') || 0;
      const meTag = n0 ? el('span', { class: 'pj-sb me', style: '--sc:' + sessionColor(n0), title: '지금 보는 세션' }, el('span', { class: 'pj-sbn', text: '세션 ' + n0 }), el('span', { class: 'pj-ord', text: ' · 이 세션' })) : null;
      sec.append(groupHead('이 세션의 태스크', mine.length, meTag), ...mine.flatMap((t, i) => tsRow(t, i, mine.length)), ...slotOf(mine.length));
      wireTsDrop(sec);
      tops.push(sec);
      const ext = externalTasks(all, new Set(order), busyOf);
      tops.push(groupHead('외부 태스크', ext.open.length, el('span', { class: 'pj-fine', text: '이 세션에 없는 것' })));
      kids.push(...ext.open.flatMap((t) => extRow(t, 'ext', 0)));
      if (ext.done.length) {
        kids.push(groupHead('완료', ext.done.length, null, { open: doneOpen, toggle: () => { lsSet(DONE_OPEN_KEY, doneOpen ? '0' : '1'); paintList(true); } }));
        if (doneOpen) kids.push(...ext.done.flatMap((t) => extRow(t, 'ext', 0)));
      }
    }
    const st = list.scrollTop, st2 = top.scrollTop;
    replaceKids(top, ...tops);
    replaceKids(list, ...kids);
    list.scrollTop = st; top.scrollTop = st2;
  }

  // ── 빠른 추가 ──
  const addIn = el('input', { class: 'pn-tk-add-in', type: 'text', 'aria-label': '태스크 추가', placeholder: '태스크 추가 — 이름을 적고 Enter', maxlength: '200' }) as HTMLInputElement;
  let adding = false;
  addIn.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.isComposing || adding) return;
    const name = addIn.value.trim();
    if (!name) return;
    adding = true;
    void api('/api/ui/v6/projects/' + ctx.id + '/tasks', { method: 'POST', body: JSON.stringify({ name }) })
      .then(() => { addIn.value = ''; changed(); toast('태스크를 더했어요.'); })
      .catch((err: any) => toast('더하지 못했어요 — ' + (err?.message || err), true))
      .finally(() => { adding = false; });
  });
  const addBox = el('label', { class: 'pn-tk-add' }, pnIcon('plus', 'pn-i sm'), addIn);

  function paint(): void {
    paintHead();
    paintBody();
    paintList();
  }

  root.append(head, top, list, addBox);
  // 보는 세션이 바뀌었다 — «이 세션의 태스크»가 그 세션의 것으로 선다. 펴 둔 줄은 저장 먼저.
  const offSess = ctx.onSession(() => {
    void (rowSaver ? rowSaver.flush() : Promise.resolve()).then(() => { openTask = 0; editTask = 0; slotOpen = false; localOrder = null; paintList(true); });
  });
  // 새 세션 자리에서 담은 것이 바뀌었다(여기서든 글칸에서든) — [담기]/[담김 n] 을 다시 그린다.
  const offPicks = onTaskPicks(picksRoot(), () => { if (isNew()) paintList(true); });
  paint();
  void load(true);

  return {
    root,
    tick: () => { paint(); if (document.visibilityState !== 'hidden') void load(); },
    destroy: () => {
      offSess(); offPicks();
      // 칸이 걷힌다 — 못 남긴 본문은 **지금** 글칸 밖에 둔다(성공하면 onSaved 가 지우고, 실패하면 다음에 다시 꺼낼 수 있다).
      if (bodyEdit && bodySaver?.dirty()) {
        const ta = bodyBox.querySelector('textarea') as HTMLTextAreaElement | null;
        if (ta && keepUnsaved(ctx.id, 'body', ta.value)) stashedByMe = true;
      }
      const savers = [bodySaver, rowSaver].filter(Boolean) as AutoSave[];
      for (const sv of savers) void sv.flush().finally(() => sv.destroy());
    },
  };
}

/** 새 세션 자리에서 담은 것을 비운다(세션을 열었거나 프로젝트를 옮겼다) — 부르는 쪽이 곁칸 뿌리를 안다. */
export const clearTaskPicks = (root: HTMLElement): void => setTaskPicks(root, []);
