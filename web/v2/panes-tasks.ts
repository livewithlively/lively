// v2/panes-tasks.ts — 곁칸의 **태스크** 부품(#4084). 보는 세션이 속한 프로젝트의 태스크를, 고를 것 없이 보여 준다.
//
//  왜 따로 섰나(원준 2026-09-20): "매 세션마다 프로젝트가 있잖아. 그 프로젝트의 태스크(세션 이름일 가능성이 높지)를
//   보여 주는 용도 — 연동되어서 자동으로 보이게." 종전 «할 일» 부품은 같은 목록을 그렸지만 ① 마운트 때 읽은 상세만 봐서
//   세션이 완료로 바꿔도 새로고침 전엔 그대로였고 ② 지금 보는 세션의 태스크가 어느 줄인지 몰랐고 ③ 기본 배치에 없었다.
//
//  짜임(위→아래) — 머리(프로젝트 · n/m 끝냄) → 접이 [본문] [규칙] → «이 세션의 태스크» 카드 → 진행 중·할 일·완료 → 빠른 추가.
//  **문법은 하나다: 줄을 누르면 그 줄의 속이 그 자리에서 펴지고, 쓰면 저절로 저장된다.** 본문·규칙 접이도, 태스크 줄도 같다.
//   저장 단추를 두지 않는 것은 프로젝트 설정(proj-settings.ts)과 같은 규약이다(#1719) — 한 화면에서 어떤 칸만 단추를
//   요구하면 사람은 단추를 못 보고 닫는다.
//
//  ⚠ 입력 중에는 다시 그리지 않는다 — 이 칸은 8초마다 서버를 다시 읽는다. 그때마다 목록을 갈아 끼우면 쓰던 글자와
//   커서가 날아간다. 글칸에 손이 가 있는 동안은 그리기를 미루고(listDirty), 손을 떼는 순간 따라잡는다.
//  ⚠ 프로젝트 본문은 **일하는 세션도 덧붙인다**(append_description). 사람의 자동저장은 통째 교체라, 그 사이에 든
//   덧붙임을 지울 수 있다 — 그래서 고치기 시작한 본문(description_base)을 함께 보내고, 서버가 그 뒤에 붙은 꼬리를
//   살려 합친다. 꼬리가 아닌 곳이 바뀌었으면 409 — 그땐 덮지 않고 사람에게 묻는다.
import { api, el, relTime, replaceKids, toast } from '../core.js';
import { lsGet, lsSet, pnIcon, seedSessName } from './panes-kit.js';
import { bindCtx, requestOpenRoute } from './ctx-registry.js';
import { copyText } from './ctx-menu.js';
import { spawnSession } from './quick-session.js';
import { dotCls, type Sess } from './views.js';
import type { Part, PartCtx } from './panes-parts.js';
import { bodyExcerpt, doneOpenByDefault, groupTasks, isDoing, isDone, taskOfSession } from '../lib/task-pane.js';
import { clearUnsaved, keepUnsaved, readUnsaved } from './unsaved-store.js';
import { autoSaveCore, type FailVerdict } from '../lib/autosave.js';

type TaskSess = { id: string; label: string | null };
const taskSessions = (t: any): TaskSess[] => (Array.isArray(t && t.sessions) ? t.sessions : []);
const DONE_OPEN_KEY = 'pn_tasks_done_open';   // 취향(완료 묶음을 펴 둘까) — 내용이 아니라 워크스페이스로 가르지 않는다
const SAVE_MS = 1200;                          // 프로젝트 설정의 본문 자동저장과 같은 박자

const isTextField = (a: Element | null): boolean => !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT');
const typingIn = (host: HTMLElement): boolean => isTextField(document.activeElement) && host.contains(document.activeElement);

// ── 자동저장 글칸 — 본문·규칙·태스크 본문이 같은 것을 쓴다 ─────────────────────────────────────────
//  상태기계는 lib/autosave(값으로 시험한다)에 있고, 여기는 그것을 글칸·칩·토스트에 묶는 껍데기다.
//  ⚠ flush 는 **도는 저장이 실제로 끝날 때까지** 기다린다 — 부른 쪽은 그 뒤에 dirty() 를 보고 «정말 남겼나»를 안다.
interface AutoSave { flush(): Promise<void>; dirty(): boolean; setSaved(v: string): void; destroy(): void }
/** save 는 **서버에 실제로 남은 글**을 돌려준다(합쳐졌으면 보낸 것과 다르다). 던지면 실패 — 문구는 부른 쪽이 정한다. */
function autoSave(ta: HTMLTextAreaElement, chip: HTMLElement, save: (text: string) => Promise<string>,
  opts?: { savedText?: string; onSaved?: (v: string) => void; onFail?: (e: any, text: string) => FailVerdict }): AutoSave {
  const setChip = (t: string, warn?: boolean): void => { chip.textContent = t; chip.classList.toggle('warn', !!warn); };
  const okText = opts?.savedText || '저장했어요.';
  let lastErr: any = null;
  const core = autoSaveCore({
    read: () => ta.value,
    save,
    // 서버가 합친 글이 보낸 것과 다르다(세션이 그 사이 덧붙였다) — 글칸이 보낸 그대로일 때만 맞추고 커서는 그 자리에 둔다.
    adopt: (kept, sent) => {
      if (ta.value !== sent) return;                       // 저장하는 동안 더 친 글이 있다 — 다음 저장이 새 기준 위에 얹는다
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
    onFail: (e, text) => { lastErr = e; return opts?.onFail?.(e, text); },
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

export function tasksPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-tk' });
  if (!(ctx.id > 0)) {
    root.append(el('div', { class: 'pn-empty' }, pnIcon('task', 'pn-i big'),
      el('b', { text: '프로젝트에 붙은 세션에서 보여요.' }),
      el('p', { class: 'pn-fine', text: '세션을 프로젝트에 붙이면 그 프로젝트의 태스크가 여기 섭니다.' })));
    return { root };
  }

  // ── 상태 ──
  let fresh: any = null;                  // 이 부품이 직접 읽은 최신 상세(셸의 detail 은 마운트 때 한 번 읽고 만다)
  let loading = false, loadedAt = 0;
  let openTask = 0;                       // 속을 펴 둔 태스크(한 번에 하나)
  let openFold: '' | 'body' | 'rules' = '';
  let opening = 0;                        // 지금 세션을 여는 중인 태스크(두 번 눌러 세션이 둘 생기지 않게)
  let headSig = '', listSig = '', listDirty = false;
  const drafts = new Map<number, string>();   // 저장 전 태스크 본문 — 다시 그려도 쓰던 글이 옛 글로 돌아가지 않게
  let rowSaver: AutoSave | null = null;
  let foldSaver: AutoSave | null = null;

  const cur = (): any => fresh || ctx.detail() || {};
  const proj = (): any => cur().project || {};
  const tasks = (): any[] => (Array.isArray(proj().tasks) ? proj().tasks : []);
  const sessOf = (sid: string): Sess | null => {
    const all: Sess[] = ctx.data()?.sessions || [];
    return all.find((s) => s.id === sid || s.logId === sid || (s.altIds || []).includes(sid)) || null;
  };
  const myTask = (): any | null => {
    const sid = ctx.curSession();
    if (!sid) return null;
    const s = sessOf(sid);
    return taskOfSession(tasks(), [sid, s?.id, s?.logId, ...(s?.altIds || [])]);
  };

  async function load(force?: boolean): Promise<void> {
    if (loading || ctx.dead()) return;
    if (!force && Date.now() - loadedAt < 3000) return;   // 내 조작 직후 셸이 다시 틱을 돌린다 — 같은 것을 두 번 읽지 않는다
    loading = true;
    try {
      const d = await api('/api/ui/v6/projects/' + ctx.id);
      if (d && !ctx.dead()) { fresh = d; loadedAt = Date.now(); paint(); }
    } catch (_) { /* 다음 틱에 다시 읽는다 */ }
    loading = false;
  }
  /** 내가 바꿨다 — 곧바로 다시 읽고, 셸(문패·사이드바)에도 알린다. */
  const changed = (): void => { void load(true); ctx.onChanged?.(); };

  // ── 머리 ──
  const nameBtn = el('button', { class: 'pn-tk-name', type: 'button', title: '프로젝트 상세를 엽니다 — 보고 있는 세션의 프로젝트입니다. 세션을 바꾸면 따라 바뀝니다.', onclick: () => ctx.openSettings?.() }) as HTMLButtonElement;
  const countEl = el('span', { class: 'pn-fine pn-tk-count' });
  const barFill = el('div', { class: 'pn-tk-bar-fill' });
  const head = el('div', { class: 'pn-tk-head' },
    el('div', { class: 'pn-tk-head-row' }, pnIcon('proj', 'pn-i sm'), nameBtn, countEl),
    el('div', { class: 'pn-tk-bar', role: 'progressbar', 'aria-label': '끝낸 태스크' }, barFill));

  function paintHead(): void {
    const g = groupTasks(tasks(), null);
    const name = String(proj().name || '프로젝트');
    const sig = name + '|' + g.doneCount + '/' + g.total;
    if (sig === headSig) return;
    headSig = sig;
    nameBtn.textContent = name;
    countEl.textContent = g.total ? `${g.doneCount}/${g.total} 끝냄` : '';
    barFill.style.width = (g.total ? Math.round((100 * g.doneCount) / g.total) : 0) + '%';
    head.querySelector('.pn-tk-bar')?.setAttribute('aria-valuenow', String(g.total ? Math.round((100 * g.doneCount) / g.total) : 0));
  }

  // ── 접이 [본문] [규칙] ──
  const folds = el('div', { class: 'pn-tk-folds' });
  let rulesText: string | null = null;    // null = 아직 안 읽었다
  let bodyBase = '';                      // 본문을 고치기 시작한 글(서버가 그 뒤에 붙은 꼬리를 살려 합친다)
  const foldHost = (k: 'body' | 'rules'): HTMLElement => folds.querySelector(`[data-fold="${k}"]`) as HTMLElement;

  function foldRow(k: 'body' | 'rules', label: string): HTMLElement {
    const ex = el('span', { class: 'pn-tk-fold-ex ell' });
    const btn = el('button', {
      class: 'pn-tk-fold', type: 'button', 'aria-expanded': 'false',
      onclick: () => void toggleFold(k),
    }, pnIcon('chev', 'pn-i xs pn-tk-chev'), el('span', { class: 'pn-tk-fold-l', text: label }), ex);
    return el('div', { class: 'pn-tk-foldwrap', 'data-fold': k }, btn);
  }
  folds.append(foldRow('body', '본문'), foldRow('rules', '규칙'));

  function paintFoldRows(): void {
    const set = (k: 'body' | 'rules', text: string): void => {
      const ex = foldHost(k).querySelector('.pn-tk-fold-ex') as HTMLElement;
      const shown = openFold === k ? '' : text;
      if (ex.textContent !== shown) ex.textContent = shown;
    };
    set('body', bodyExcerpt(proj().description) || '아직 적지 않았습니다');
    set('rules', rulesText === null ? '' : (bodyExcerpt(rulesText) || '아직 적지 않았습니다'));
  }

  let foldGen = 0;                        // 접이를 여닫을 때마다 오른다 — 늦게 돌아온 읽기가 새 접이를 건드리지 않게

  /** 접이를 닫는다. **못 저장한 글이 있으면 닫지 않는다**(false) — 닫으면 그 글은 글칸과 함께 사라진다.
   *  flush 가 도는 저장의 끝(충돌 포함)을 기다리므로, 여기서 dirty 면 «정말로 못 남긴 글이 있다» 는 뜻이다. */
  async function closeFold(): Promise<boolean> {
    if (!openFold) return true;
    const k = openFold;
    if (foldSaver) {
      await foldSaver.flush();
      if (openFold !== k) return true;                     // 기다리는 사이 다른 길로 이미 닫혔다
      if (foldSaver.dirty()) { toast('아직 저장하지 못한 글이 있어 접지 않았어요.', true); return false; }
    }
    dropFold(k);
    return true;
  }
  /** 글칸을 걷는다(저장 여부를 묻지 않는다 — 물을 자리는 closeFold 다). */
  function dropFold(k: 'body' | 'rules'): void {
    foldGen++;
    foldSaver?.destroy(); foldSaver = null;
    openFold = '';
    const w = foldHost(k);
    w.querySelector('.pn-tk-editor')?.remove();
    w.querySelector('.pn-tk-fold')?.setAttribute('aria-expanded', 'false');
    w.classList.remove('open');
    paintFoldRows();
  }

  async function toggleFold(k: 'body' | 'rules'): Promise<void> {
    if (openFold === k) { await closeFold(); return; }
    if (!(await closeFold())) return;                      // 다른 접이에 못 저장한 글이 있다 — 그쪽을 그대로 둔다
    openFold = k;
    const gen = ++foldGen;
    const w = foldHost(k);
    w.classList.add('open');
    w.querySelector('.pn-tk-fold')?.setAttribute('aria-expanded', 'true');
    const ta = el('textarea', {
      class: 'pn-tk-ta big', 'aria-label': k === 'body' ? '프로젝트 본문' : '프로젝트 규칙', disabled: '',
      placeholder: k === 'body' ? '이 프로젝트가 무엇인지 적어 두면 세션도 그걸 읽고 일합니다.'
        : '이 프로젝트에서 AI가 지켰으면 하는 걸 편하게 적으세요. 예)\n· 큰 변경이나 삭제는 진행하기 전에 꼭 먼저 물어본다.\n· 자료를 만들 땐 근거와 출처를 같이 적는다.',
    }) as HTMLTextAreaElement;
    const chip = el('span', { class: 'pn-set-chip' });
    const size = el('span', { class: 'pn-fine' });
    const acts = el('span', { class: 'pn-tk-editor-acts' });
    const foot = el('div', { class: 'pn-tk-editor-foot' }, chip, el('span', { class: 'grow' }), size, acts);
    const box = el('div', { class: 'pn-tk-editor' }, ta, foot);
    w.append(box);
    paintFoldRows();
    const count = (): void => { size.textContent = ta.value.length ? ta.value.length.toLocaleString('ko-KR') + '자' : ''; };
    ta.addEventListener('input', count);
    const linkBtn = (text: string, run: () => void, title?: string): HTMLElement => el('button', { class: 'btn-text pn-tk-link', type: 'button', text, title, onclick: run });
    const baseActs = (): HTMLElement[] => (k === 'body'
      ? [linkBtn('크게 열기', () => { void closeFold().then((ok) => { if (ok) ctx.openSettings?.(); }); }, '프로젝트 상세에서 넓게 고칩니다')] : []);
    /** 저장이 실패했는데 **글칸이 이미 걷혔다**(탭을 닫았다·화면을 떠났다) — 글을 글칸 밖에 남기고 알린다. */
    const lostOffscreen = (text: string): boolean => {
      if (ta.isConnected) return false;
      const kept = keepUnsaved(ctx.id, k, text);
      toast(kept ? `${k === 'body' ? '본문' : '규칙'}을 저장하지 못했어요 — 태스크 칸에서 [${k === 'body' ? '본문' : '규칙'}]을 다시 열면 쓰던 글을 되살릴 수 있어요.`
        : '저장하지 못했어요 — 쓰던 글이 너무 길어 보관하지도 못했어요.', true);
      return true;
    };

    if (k === 'body') {
      // 펴는 순간의 **최신** 본문에서 시작한다 — 셸이 쥔 상세는 마운트 때 것이라, 그 위에서 고치면 그 사이 덧붙임을 지운다.
      try { const d = await api('/api/ui/v6/projects/' + ctx.id); if (d) { fresh = d; loadedAt = Date.now(); } } catch (_) { /* 쥔 것으로 시작 */ }
      if (gen !== foldGen || ctx.dead()) return;
      bodyBase = String(proj().description || '');
      ta.value = bodyBase;
      foldSaver = autoSave(ta, chip, async (text) => {
        const r = await api('/api/ui/v6/projects/' + ctx.id, { method: 'POST', body: JSON.stringify({ description: text || null, description_base: bodyBase }) });
        const kept = String(r?.project?.description || '');
        bodyBase = kept;
        if (fresh?.project) fresh.project.description = kept;
        return kept;
      }, {
        onSaved: () => { clearUnsaved(ctx.id, 'body'); count(); ctx.onChanged?.(); },   // 서버가 꼬리를 합쳐 글이 늘었을 수 있다 — 글자 수도 따라간다
        onFail: (e, text) => {
          if (lostOffscreen(text)) return e?.status === 409 ? 'pause' : 'handled';
          if (e?.status !== 409) return;
          // 꼬리가 아닌 곳이 다른 데서 바뀌었다 — 덮지 않는다. 최신을 불러오게 하고, 쓰던 글은 챙길 수 있게 한다.
          chip.textContent = '다른 곳에서 본문이 바뀌었어요.'; chip.classList.add('warn');
          size.textContent = '';                           // 좁은 발치 — 안내와 두 단추에 자리를 준다
          replaceKids(acts,
            linkBtn('내 글 복사', () => void copyText(ta.value).then((ok) => { if (ok) toast('쓰던 글을 복사했어요.'); })),
            linkBtn('최신 본문 불러오기', () => { void reopenFold('body'); }, '쓰던 글을 버리고 지금 본문에서 다시 시작합니다'));
          return 'pause';
        },
      });
    } else {
      try { const d = await api('/api/ui/v6/projects/' + ctx.id + '/rules'); rulesText = String((d && d.rules) || ''); } catch (_) { rulesText = rulesText ?? ''; }
      if (gen !== foldGen || ctx.dead()) return;
      ta.value = rulesText || '';
      foldSaver = autoSave(ta, chip, async (text) => {
        await api('/api/ui/v6/projects/' + ctx.id + '/rules', { method: 'POST', body: JSON.stringify({ rules: text }) });
        rulesText = text;
        return text;
      }, {
        savedText: '저장했어요 · 다음 세션부터 적용돼요.',
        onSaved: () => clearUnsaved(ctx.id, 'rules'),
        onFail: (_e, text) => (lostOffscreen(text) ? 'handled' : undefined),
      });
    }
    ta.disabled = false; count();
    replaceKids(acts, baseActs());
    // 지난번에 못 남긴 글이 있다(저장이 가는 도중에 칸을 떠났고 그 저장이 실패했다) — 덮어쓰지 않고 되살릴지 묻는다.
    const lost = readUnsaved(ctx.id, k);
    if (lost !== null && lost !== ta.value) {
      chip.textContent = '지난번에 저장하지 못한 글이 있어요.'; chip.classList.add('warn');
      size.textContent = '';
      replaceKids(acts,
        linkBtn('되살리기', () => { ta.value = lost; chip.classList.remove('warn'); replaceKids(acts, baseActs()); ta.dispatchEvent(new Event('input')); ta.focus(); }, '그 글을 이 칸에 다시 넣습니다 — 넣으면 저절로 저장돼요'),
        linkBtn('버리기', () => { clearUnsaved(ctx.id, k); chip.textContent = ''; chip.classList.remove('warn'); count(); replaceKids(acts, baseActs()); }));
    } else if (lost !== null) clearUnsaved(ctx.id, k);      // 이미 같은 글이 저장돼 있다
    // 긴 본문은 맨 위에서 시작한다 — focus 는 커서를 끝에 두어 글칸이 맨 아래(가장 옛 기록 아래)로 내려가 버린다.
    ta.focus();
    try { ta.setSelectionRange(0, 0); } catch (_) { /* noop */ }
    ta.scrollTop = 0;
  }
  /** 접이를 최신 글로 다시 연다(충돌 뒤) — 쓰던 글은 버린다. 그래서 누르기 전에 [내 글 복사]를 같이 둔다. */
  async function reopenFold(k: 'body' | 'rules'): Promise<void> {
    dropFold(k);
    await toggleFold(k);
  }

  /** 펴 둔 본문을 손대지 않았고 글칸에 손도 안 가 있으면, 세션이 그 사이 덧붙인 것을 따라잡는다. */
  function syncOpenBody(): void {
    if (openFold !== 'body' || !foldSaver || foldSaver.dirty()) return;
    const ta = foldHost('body').querySelector('textarea') as HTMLTextAreaElement | null;
    if (!ta || ta.disabled || document.activeElement === ta) return;
    const latest = String(proj().description || '');
    if (latest === ta.value) return;
    ta.value = latest; bodyBase = latest; foldSaver.setSaved(latest);
  }

  // ── 목록(카드 + 묶음) ──
  const list = el('div', { class: 'pn-tk-list' });
  list.addEventListener('focusout', () => {
    // 손을 뗐다 — 미뤄 둔 그리기를 따라잡는다(포커스가 목록 안 다른 글칸으로 옮겨 가는 중이면 그대로 둔다).
    window.setTimeout(() => { if (listDirty && !typingIn(list)) paintList(); }, 0);
  });

  const goTaskSession = (sid: string): void => requestOpenRoute('#/s/' + encodeURIComponent(sid));

  /** 이 태스크를 맡은 **새** 세션을 연다. 첫 지시는 서버가 태스크 번호·본문으로 채운다(핸드오버 «#<id> 진행해» 와 같은 모양). */
  async function openTaskSession(t: any): Promise<void> {
    const tid = Number(t && t.id);
    if (!(tid > 0) || opening) return;
    opening = tid; paintList(true);
    try {
      const made = await spawnSession('', { projectId: ctx.id, taskId: tid });
      if (!made) return;                              // 이유는 spawnSession 이 toast 로 이미 말했다
      seedSessName(made.id, String(t.name || ''));
      ctx.onSessionCreated?.(made.session);           // 목록에 지금 끼워 넣는다(20초 폴링을 기다리지 않게)
      changed();
      toast('이 태스크를 맡은 세션을 열었어요.');
      goTaskSession(made.id);
    } finally { opening = 0; paintList(true); }
  }

  function setStatus(t: any, status: 'todo' | 'in_progress' | 'done'): void {
    void api('/api/ui/v6/tasks/' + t.id, { method: 'POST', body: JSON.stringify({ status }) })
      .then(() => { changed(); toast(status === 'done' ? '끝냈다고 표시했어요.' : status === 'in_progress' ? '진행 중으로 바꿨어요.' : '할 일로 되돌렸어요.'); })
      .catch((e: any) => toast('바꾸지 못했어요 — ' + (e?.message || e), true));
  }

  const statusKey = (t: any): 'todo' | 'doing' | 'done' => (isDone(t) ? 'done' : isDoing(t) ? 'doing' : 'todo');
  const statusText = (t: any): string => (isDone(t) ? '완료' : isDoing(t) ? '진행 중' : '할 일');

  function glyph(t: any): HTMLElement {
    const done = isDone(t);
    return el('button', {
      class: 'pn-tk-st ' + statusKey(t), type: 'button', 'aria-pressed': String(done),
      'aria-label': done ? '아직 안 끝난 것으로 되돌리기' : '끝냈다고 표시',
      title: done ? '아직 안 끝난 것으로 되돌립니다' : '끝냈다고 표시합니다',
      onclick: (e: Event) => { e.stopPropagation(); setStatus(t, done ? 'todo' : 'done'); },
    });
  }

  function sessChip(t: any): HTMLElement {
    const sess = taskSessions(t);
    const tid = Number(t.id);
    if (opening === tid) return el('button', { class: 'pn-tk-chip', type: 'button', disabled: '' }, el('span', { text: '여는 중…' }));
    if (sess.length) {
      const s0 = sess[0];
      const live = sessOf(s0.id);
      const name = String(s0.label || live?.label || '').trim() || '세션';
      return el('button', {
        class: 'pn-tk-chip on' + (live?.live ? '' : ' past'), type: 'button',
        title: `이 태스크를 맡은 세션 «${name}»으로 갑니다` + (live ? ` — ${live.stateLabel}` : '') + (sess.length > 1 ? ` · 붙은 세션은 모두 ${sess.length}개예요` : ''),
        onclick: (e: Event) => { e.stopPropagation(); goTaskSession(s0.id); },
      }, el('span', { class: 'v2-dot ' + dotCls(live?.stateKey || ''), 'aria-hidden': 'true' }),
      el('span', { class: 'ell', text: name + (sess.length > 1 ? ` 외 ${sess.length - 1}` : '') }));
    }
    return el('button', {
      class: 'pn-tk-chip', type: 'button',
      title: '이 태스크를 맡은 새 세션을 엽니다 — 세션이 진행하고, 끝나면 완료로 표시합니다',
      onclick: (e: Event) => { e.stopPropagation(); void openTaskSession(t); },
    }, pnIcon('plus', 'pn-i xs'), el('span', { text: '세션 열기' }));
  }

  /** 줄의 속 — 본문(쓰면 저장) · 상태 · 맡은 세션 · 하위 할 일 · 보드로 가는 길. 위 접이와 같은 문법이다. */
  function detailOf(t: any): HTMLElement {
    const tid = Number(t.id);
    const ta = el('textarea', { class: 'pn-tk-ta', rows: '3', 'aria-label': '태스크 본문', placeholder: '무엇을 하는 태스크인지, 어디까지 하면 끝인지 적어 두세요. 이 태스크를 맡은 세션이 읽습니다.' }) as HTMLTextAreaElement;
    ta.value = drafts.has(tid) ? String(drafts.get(tid)) : String(t.description || '');
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

    const seg = el('div', { class: 'pn-tk-seg', role: 'group', 'aria-label': '상태' },
      ...([['todo', '할 일'], ['in_progress', '진행 중'], ['done', '완료']] as const).map(([k, label]) => {
        const on = (k === 'done' && isDone(t)) || (k === 'in_progress' && isDoing(t)) || (k === 'todo' && !isDone(t) && !isDoing(t));
        return el('button', { class: 'pn-tk-seg-b' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), text: label, onclick: () => { if (!on) setStatus(t, k); } });
      }));

    const sess = taskSessions(t);
    const sessBox = el('div', { class: 'pn-tk-sec' },
      el('div', { class: 'pn-tk-sec-h' }, el('span', { text: '맡은 세션' }), sess.length ? el('span', { class: 'n', text: String(sess.length) }) : null),
      ...sess.map((s) => {
        const live = sessOf(s.id);
        const name = String(s.label || live?.label || '').trim() || '세션';
        return el('div', { class: 'pn-tk-srow' },
          el('span', { class: 'v2-dot ' + dotCls(live?.stateKey || ''), 'aria-hidden': 'true' }),
          el('span', { class: 'nm ell', text: name }),
          el('span', { class: 'pn-fine', text: live ? live.stateLabel : '지난 세션' }),
          el('button', { class: 'btn-text pn-tk-link', type: 'button', text: '가기', onclick: () => goTaskSession(s.id) }));
      }),
      el('button', { class: 'btn-text pn-tk-link add', type: 'button', disabled: opening ? '' : undefined, onclick: () => void openTaskSession(t) },
        pnIcon('plus', 'pn-i xs'), el('span', { text: sess.length ? '새 세션으로 이어 하기' : '세션 열기' })));

    const subs: any[] = Array.isArray(t.subtasks) ? t.subtasks : [];
    const subBox = subs.length ? el('div', { class: 'pn-tk-sec' },
      el('div', { class: 'pn-tk-sec-h' }, el('span', { text: '하위 할 일' }), el('span', { class: 'n', text: `${subs.filter(isDone).length}/${subs.length}` })),
      ...subs.map((s) => el('div', { class: 'pn-tk-row sub' + (isDone(s) ? ' done' : '') }, glyph(s), el('span', { class: 'pn-tk-sub-n ell', title: s.name, text: s.name || '이름 없는 할 일' })))) : null;

    const meta: string[] = [];
    if (t.due_date) meta.push('기한 ' + String(t.due_date).slice(5).replace('-', '/'));
    if (t.priority) meta.push(({ urgent: '긴급', high: '높음', normal: '보통', low: '낮음' } as Record<string, string>)[String(t.priority)] || String(t.priority));
    const foot = el('div', { class: 'pn-tk-detail-foot' },
      el('span', { class: 'pn-fine', text: ['#' + tid, ...meta].join(' · ') }), el('span', { class: 'grow' }),
      el('button', { class: 'btn-text pn-tk-link', type: 'button', text: '보드에서 열기', title: '체크리스트·댓글·연결은 보드에서 봅니다', onclick: () => requestOpenRoute('#/projects2/p/' + ctx.id) }));

    return el('div', { class: 'pn-tk-detail' }, ta, el('div', { class: 'pn-tk-ta-foot' }, chip), seg, sessBox, subBox, foot);
  }

  function toggleOpen(t: any): void {
    const tid = Number(t.id);
    const next = openTask === tid ? 0 : tid;
    void (rowSaver ? rowSaver.flush() : Promise.resolve()).then(() => { openTask = next; paintList(true); });
  }

  function rowOf(t: any): HTMLElement[] {
    const tid = Number(t.id);
    const open = openTask === tid;
    const row = el('div', { class: 'pn-tk-row' + (isDone(t) ? ' done' : '') + (open ? ' open' : '') },
      glyph(t),
      el('button', { class: 'pn-tk-rname', type: 'button', 'aria-expanded': String(open), title: t.name, onclick: () => toggleOpen(t) },
        el('span', { class: 'ell', text: t.name || '이름 없는 태스크' })),
      sessChip(t));
    const sess = taskSessions(t);
    // #3784 우클릭 — 끝냄 토글 · (#4084) 세션 열기 · 보드에서 보기 · 이름 복사
    bindCtx(row, () => ({
      title: String(t.name || '태스크'), sub: statusText(t),
      rows: [
        { label: isDone(t) ? '아직 안 끝난 것으로' : '끝냈다고 표시', icon: 'check', checked: isDone(t) || undefined, run: () => setStatus(t, isDone(t) ? 'todo' : 'done') },
        ...(sess.length ? [{ label: '맡은 세션으로 가기', icon: 'chat', run: () => goTaskSession(sess[0].id) }] : []),
        { label: sess.length ? '새 세션으로 이어 하기' : '세션 열기', icon: 'plus', run: () => void openTaskSession(t) },
        { label: '보드에서 보기', icon: 'proj', run: () => requestOpenRoute('#/projects2/p/' + ctx.id) },
        { sep: true, label: '' },
        { label: '이름 복사', icon: 'copy', run: () => void copyText(String(t.name || '')).then((ok) => { if (ok) toast('복사했어요'); }) },
      ],
    }));
    return open ? [row, detailOf(t)] : [row];
  }

  function cardOf(t: any): HTMLElement {
    const sid = ctx.curSession();
    const live = sid ? sessOf(sid) : null;
    const open = openTask === Number(t.id);
    const done = isDone(t);
    return el('div', { class: 'pn-tk-card' + (open ? ' open' : '') },
      el('div', { class: 'pn-tk-card-h' }, pnIcon('chat', 'pn-i sm'), el('span', { text: '이 세션의 태스크' }), el('span', { class: 'grow' }),
        live ? el('span', { class: 'pn-tk-card-st' }, el('span', { class: 'v2-dot ' + dotCls(live.stateKey), 'aria-hidden': 'true' }), el('span', { text: live.stateLabel })) : null),
      el('button', { class: 'pn-tk-card-n', type: 'button', 'aria-expanded': String(open), title: '눌러서 이 태스크의 본문·상태·세션을 봅니다', onclick: () => toggleOpen(t) },
        el('span', { text: t.name || '이름 없는 태스크' }), pnIcon('chev', 'pn-i xs pn-tk-chev')),
      el('div', { class: 'pn-tk-card-m' }, el('span', { class: 'pn-tk-st static ' + statusKey(t), 'aria-hidden': 'true' }),
        el('span', { text: statusText(t) }), t.created_at ? el('span', { class: 'sep', text: '·' }) : null,
        t.created_at ? el('span', { text: relTime(t.created_at) + ' 시작' }) : null),
      open ? detailOf(t) : el('div', { class: 'pn-tk-card-a' },
        done ? el('button', { class: 'btn-text pn-tk-link', type: 'button', text: '다시 진행 중으로', onclick: () => setStatus(t, 'in_progress') })
          : el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '끝냈다고 표시', onclick: () => setStatus(t, 'done') }),
        el('span', { class: 'pn-fine', text: done ? '끝낸 태스크예요.' : '세션이 일을 끝내면 스스로 완료로 바꿉니다.' })));
  }

  function groupHead(label: string, n: number, fold?: { open: boolean; toggle: () => void }): HTMLElement {
    const inner = [el('span', { text: label }), el('span', { class: 'n', text: String(n) })];
    return fold
      ? el('button', { class: 'pn-tk-gh fold' + (fold.open ? ' open' : ''), type: 'button', 'aria-expanded': String(fold.open), onclick: fold.toggle }, pnIcon('chev', 'pn-i xs pn-tk-chev'), ...inner)
      : el('div', { class: 'pn-tk-gh' }, ...inner);
  }

  function paintList(force?: boolean): void {
    const all = tasks();
    const mine = myTask();
    const g = groupTasks(all, mine);
    const doneOpen = doneOpenByDefault(g.done.length, lsGet(DONE_OPEN_KEY, ''));
    const sessSig = (t: any): string => taskSessions(t).map((x) => x.id + (x.label || '') + (sessOf(x.id)?.stateKey || '')).join(',');
    const sig = [ctx.curSession() || '', mine ? mine.id : 0, openTask, opening, doneOpen ? 1 : 0,
      all.map((t) => t.id + (t.status_category || '') + (t.name || '') + sessSig(t)
        + (Array.isArray(t.subtasks) ? t.subtasks.map((s: any) => s.id + (s.status_category || '')).join('.') : '')).join('|')].join('§');
    if (!force && sig === listSig) return;
    if (typingIn(list)) { listDirty = true; return; }     // 쓰는 중 — 손을 떼면 따라잡는다(focusout)
    listSig = sig; listDirty = false;
    if (openTask && !all.some((t) => Number(t.id) === openTask)) openTask = 0;   // 펴 둔 태스크가 사라졌다

    if (!all.length) {
      replaceKids(list, el('div', { class: 'pn-empty' }, pnIcon('task', 'pn-i big'),
        el('b', { text: '태스크가 아직 없어요.' }),
        el('p', { class: 'pn-fine', text: '이 프로젝트에서 세션을 열면 그 세션의 태스크가 저절로 생깁니다. 아래에서 직접 더해도 돼요.' })));
      return;
    }
    const kids: HTMLElement[] = [];
    if (mine) kids.push(cardOf(mine));
    if (g.doing.length) kids.push(groupHead('진행 중', g.doing.length), ...g.doing.flatMap(rowOf));
    if (g.todo.length) kids.push(groupHead('할 일', g.todo.length), ...g.todo.flatMap(rowOf));
    if (g.done.length) {
      kids.push(groupHead('완료', g.done.length, { open: doneOpen, toggle: () => { lsSet(DONE_OPEN_KEY, doneOpen ? '0' : '1'); paintList(true); } }));
      if (doneOpen) kids.push(...g.done.flatMap(rowOf));
    }
    const top = list.scrollTop;
    replaceKids(list, kids);
    list.scrollTop = top;
  }

  // ── 빠른 추가 ──
  const addIn = el('input', { class: 'pn-tk-add-in', type: 'text', 'aria-label': '태스크 추가', placeholder: '태스크 추가 — 이름을 적고 Enter', maxlength: '200' }) as HTMLInputElement;
  let adding = false;
  addIn.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.isComposing || adding) return;     // 한글 조합 중의 Enter 는 글자를 확정하는 것이다
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
    paintFoldRows();
    syncOpenBody();
    paintList();
  }

  root.append(head, folds, list, addBox);
  // 보는 세션이 바뀌었다 — 카드가 그 세션의 태스크로 선다. 펴 둔 줄은 toggleOpen 과 같은 순서로 닫는다(저장 먼저).
  const offSess = ctx.onSession(() => { void (rowSaver ? rowSaver.flush() : Promise.resolve()).then(() => { openTask = 0; paintList(true); }); });
  paint();
  void load(true);
  // 규칙 줄에 비칠 한 줄 — 펴기 전에도 «적어 둔 것이 있나»는 보여야 한다.
  void api('/api/ui/v6/projects/' + ctx.id + '/rules').then((d: any) => { rulesText = String((d && d.rules) || ''); paintFoldRows(); }).catch(() => { rulesText = ''; paintFoldRows(); });

  return {
    root,
    tick: () => { paint(); if (document.visibilityState !== 'hidden') void load(); },
    destroy: () => {
      offSess();
      // 칸이 걷힌다 — 저장은 뒤에서 끝까지 가지만 결과를 보여 줄 화면이 없다. 못 남긴 본문·규칙은 **지금** 글칸 밖에 둔다
      //  (성공하면 onSaved 가 지우고, 실패하면 다음에 접이를 열 때 되살릴 수 있다).
      if (openFold && foldSaver?.dirty()) {
        const ta = foldHost(openFold).querySelector('textarea') as HTMLTextAreaElement | null;
        if (ta) keepUnsaved(ctx.id, openFold, ta.value);
      }
      const savers = [foldSaver, rowSaver].filter(Boolean) as AutoSave[];
      for (const sv of savers) void sv.flush().finally(() => sv.destroy());
    },
  };
}
