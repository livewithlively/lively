// projects/detail-hub-timeline.ts — 허브 «작업 타임라인» 위젯(#4135, 전면 재구성 2026-09-27).
//
//  이 위젯으로 알게 되는 것 한 문장: **누가 어떤 작업을 하는가.**
//  종전 판은 사람 × 날 레인에 건수만큼 점 크기를 달리 그렸다 — 원준: «누가 더 일 많이 했는지 비교하는 용도밖에 안 된다.
//  누가 어떤 작업을 하는 건지 보는 역할이어야지». 그래서 양(건수·빈도)을 그리는 것은 어느 크기에도 없다.
//  화면의 단위는 «사람 + 그 사람이 한 작업의 내용» 이고, 시간은 그것을 늘어놓는 순서일 뿐이다.
//
//   1×1  최근 작업 넷 — 얼굴 · 내용 · 때
//   1×N  날로 묶은 흐름 — 얼굴 · 내용(두 줄) / 이름 · 중분류 · 태스크
//   2×1 · 3×1  사람별 최근 — 사람마다 한 열(가장 최근에 일한 사람부터), 그 사람의 최근 작업 셋
//   2×2  날 × 사람 판 — 왼쪽 축은 날(기록 있는 날만), 열은 사람, 칸에는 그날 그 사람이 한 작업
//   3×2  판 + 오른쪽 «고른 작업»(제목 · 설명 · 누가 · 어느 태스크 · 세션 · 커밋 · 이어진 지식)
//   모달 사람 · 종류 거르기 · 찾기 · 보기(사람별 | 시간순) + 판 또는 흐름 + 고른 작업의 속
//  좁은 화면(한 열)은 흐름으로 선다 — 열이 글을 읽을 폭을 못 가지면 판을 세우지 않는다.
//
//  작업 한 줄의 글: 큰 글 = 요약의 «내용»(«중분류 - 내용» 에서 뒤쪽), 작은 글 = 중분류 · 그 작업이 속한 태스크.
//  종류(기능·수정·문서…)는 점의 색으로만. 사람 순서는 **가장 최근에 일한 사람부터**(많이 한 순이 아니다).
import { el, personFace, relTime } from '../core.js';
import { pjvPopover } from './popover.js';
import { type CtxRow, type Fill, SEP, btn, copyRow, emptyNote, footText, hubCtx, hubIcon, openRouteRow } from './detail-hub-kit.js';
import { type BoardCol, actWhen, boardCols, boardDays, boardMaxCols, dayKey, dayParts, feedDayHead, peopleByRecency, recentByCol, splitSummary, taskIndex, whenShort } from './detail-hub-model.js';

const TYPE_LABEL: Record<string, string> = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타' };
const REL_LABEL: Record<string, string> = { produced: '산출', references: '참조', decided: '결정' };
// 거르기 · 보기 · 고른 작업 — 페이지 안에서만 산다(프로젝트별).
type Tools = { person: string; type: string; q: string; view: 'board' | 'feed'; sel: string };
const TOOLS: Map<number, Tools> = new Map();
const toolsOf = (pid: number): Tools => { let t = TOOLS.get(pid); if (!t) { t = { person: '', type: '', q: '', view: 'board', sel: '' }; TOOLS.set(pid, t); } return t; };

export const fillTimeline: Fill = (ctx, f, body, foot, sub) => {
  const { o, P, pid } = ctx;
  const w = f.w, h = f.h;
  const modal = !!f.modal;
  const phone = modal && ctx.narrow;
  const now = Date.now();
  const tools = toolsOf(pid);
  const open = () => ctx.openTool('timeline');
  const memberName = ctx.memberName;
  const tasks = taskIndex(P.tasks || []);
  /** 그 작업이 속한 태스크 — 기록의 project_id 가 이 프로젝트면 없다(프로젝트의 일). */
  const taskOf = (a: any): any | null => { const id = Number(a.project_id); return id && id !== pid ? tasks.get(id) || null : null; };
  const openTask = (t: any): void => { if (o.openTask) o.openTask(Number(t.id)); else location.hash = '#/projects2/t/' + t.id; };
  const hmOf = (t: number): string => (t ? String(new Date(t).getHours()).padStart(2, '0') + ':' + String(new Date(t).getMinutes()).padStart(2, '0') : '');

  body.append(el('div', { class: 'pjh-stat', text: '기록을 불러오는 중' }));
  ctx.D.acts().then((acts: any[]) => {
    body.replaceChildren();
    const sorted = acts.filter((a) => actWhen(a)).sort((a, b) => actWhen(b) - actWhen(a));
    const last = sorted[0] || null;
    const lastTxt = last ? '마지막 ' + relTime(new Date(actWhen(last)).toISOString()) : '';
    sub.textContent = lastTxt;
    if (!sorted.length) {
      body.append(emptyNote('아직 이 프로젝트의 작업 기록이 없습니다 — 세션이 일을 마치면 누가 무엇을 했는지 여기에 쌓입니다.'));
      foot.append(footText('이 프로젝트와 태스크의 작업'));
      if (!modal) foot.append(btn('전체 보기', 'btn-ghost', open));
      return;
    }

    // ── 우클릭 — 작업 한 줄 ──
    const pickInModal = (a: any): void => { tools.sel = String(a.id); if (modal) ctx.refreshGrid(); else open(); };
    const actRows = (a: any): Array<CtxRow | null> => {
      const t = taskOf(a);
      return [
        { label: '자세히 보기', icon: 'open', run: () => pickInModal(a) },
        t ? { label: '태스크 열기', icon: 'doc', hint: String(t.name || '').slice(0, 18), run: () => openTask(t) } : null,
        a.session_id ? openRouteRow('이 작업을 한 세션 열기', '#/s/' + encodeURIComponent(String(a.session_id)), 'term') : null,
        a.external_url ? { label: '바깥 링크 열기', icon: 'open', run: () => { window.open(String(a.external_url), '_blank', 'noopener'); } } : null,
        SEP,
        copyRow('요약 복사', String(a.summary || a.title || '')),
        a.title && a.title !== a.summary ? copyRow('제목 복사', String(a.title)) : null,
        a.body ? copyRow('설명 복사', String(a.body)) : null,
        a.commit_sha ? copyRow('커밋 복사', String(a.commit_sha)) : null,
        a.session_id ? copyRow('세션 id 복사', String(a.session_id)) : null,
      ];
    };

    // ── 작업 한 줄 ──
    //  face: 얼굴을 앞에 세운다(사람이 섞인 자리 — 흐름 · «그 밖» 열). 아니면 종류 점(그 열이 이미 한 사람이다).
    //  lines: 1 = 내용 한 줄 + 때 / 2 = 내용 두 줄까지 + 작은 글(이름 · 중분류 · 태스크).
    type WorkOpts = { face: boolean; lines: 1 | 2; when: 'hm' | 'short'; who?: boolean; pick: (a: any, node: HTMLElement) => void };
    const markSel = modal || (w >= 3 && h >= 2);   // «고른 줄» 표시는 옆 칸이 있는 자리에서만
    const work = (a: any, wo: WorkOpts): HTMLElement => {
      const sp = splitSummary(a.summary || a.title);
      const t = actWhen(a);
      const ty = TYPE_LABEL[a.type] || '';
      const task = taskOf(a);
      const who = memberName(a.author_person) || 'AI';
      const lead = wo.face ? personFace(a.author_person, 'pjv-ava', who) : el('i', { class: 'pjh-ev-dot ' + String(a.type || ''), title: ty, 'aria-hidden': 'true' });
      const meta: any[] = [];
      const sepDot = () => el('span', { class: 'pjh-wk-sep', text: '·', 'aria-hidden': 'true' });
      const put = (n: any) => { if (!n) return; if (meta.length) meta.push(sepDot()); meta.push(n); };
      if (wo.lines === 2) {
        if (wo.who) put(el('span', { class: 'pjh-wk-who', text: who }));
        //  얼굴이 앞에 서면 종류 점이 설 자리가 없다 — 작은 글 앞에 점을 세운다.
        put(el('span', { class: 'pjh-wk-k' }, wo.face ? el('i', { class: 'pjh-ev-dot sm ' + String(a.type || ''), 'aria-hidden': 'true' }) : null, sp.kind || ty || '작업'));
        if (task) {
          const chip = el('button', { class: 'pjh-tb', type: 'button', title: '태스크: ' + task.name + ' — 누르면 태스크 열기' }, hubIcon('tasks', 11), el('span', { text: task.name }));
          chip.onclick = (e) => { e.stopPropagation(); openTask(task); };
          put(chip);
        }
      }
      const node = el('div', {
        class: 'pjh-wk' + (wo.lines === 1 ? ' one' : '') + (markSel && tools.sel && String(a.id) === tools.sel ? ' on' : ''), 'data-aid': String(a.id), tabindex: '0', role: 'button',
        title: who + ' · ' + (a.summary || a.title || ''),
      }, lead,
      el('div', { class: 'pjh-wk-b' },
        el('div', { class: 'pjh-wk-t' }, el('span', { class: 'pjh-wk-x', text: sp.text || '(내용 없음)' }),
          el('span', { class: 'pjh-wk-w', text: wo.when === 'short' ? whenShort(t, now) : hmOf(t) })),
        meta.length ? el('div', { class: 'pjh-wk-m' }, ...meta) : null)) as HTMLElement;
      node.onclick = () => wo.pick(a, node);
      node.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); wo.pick(a, node); } });
      return hubCtx(node, sp.text || String(a.title || '작업'), who + ' · ' + (sp.kind || ty || '작업'), () => actRows(a));
    };

    // ── 사람 머리 — 얼굴 · 이름 · 마지막으로 일한 때 ──
    const personHead = (c: BoardCol, items: any[]): HTMLElement => {
      const mine = items.filter((a) => c.ids.includes(String(a.author_person || '')));
      const lastAt = mine.length ? actWhen(mine[0]) : 0;
      const when = lastAt ? relTime(new Date(lastAt).toISOString()) : '';
      if (c.key === 'others') {
        return el('div', { class: 'pjh-bd-p', title: c.ids.map((id) => memberName(id)).join(' · ') },
          el('span', { class: 'pjh-bd-faces' }, ...c.ids.slice(0, 3).map((id) => personFace(id, 'pjv-ava', memberName(id)))),
          el('span', { class: 'pjh-bd-pn', text: '그 밖 ' + c.ids.length + '명' }), when ? el('small', { text: when }) : null) as HTMLElement;
      }
      return el('div', { class: 'pjh-bd-p', title: memberName(c.key) + (when ? ' — 마지막 작업 ' + when : '') },
        personFace(c.key, 'pjv-ava', memberName(c.key)), el('span', { class: 'pjh-bd-pn', text: memberName(c.key) }), when ? el('small', { text: when }) : null) as HTMLElement;
    };

    /** 날로 묶은 흐름 — 사람이 섞여 서므로 줄마다 얼굴. 전부 세우고 그 안에서 스크롤. */
    const feed = (items: any[], pick: WorkOpts['pick']): HTMLElement => {
      const box = el('div', { class: 'pjh-feed pjh-wfeed', 'data-mscroll': 'feed' });
      let lastDay = '';
      for (const a of items) {
        const d = dayKey(actWhen(a));
        if (d !== lastDay) { box.append(el('div', { class: 'pjh-grp' }, el('b', { text: feedDayHead(actWhen(a), now) }))); lastDay = d; }
        box.append(work(a, { face: true, lines: 2, when: 'hm', who: true, pick }));
      }
      return box as HTMLElement;
    };
    /** 날 × 사람 판 — 왼쪽 축은 날(기록 있는 날만 · 최근부터), 열은 사람. 칸에는 그날 그 사람이 한 작업이 최근 순으로. */
    const board = (items: any[], maxCols: number, pick: WorkOpts['pick']): HTMLElement => {
      const cols = boardCols(peopleByRecency(items), maxCols);
      const days = boardDays(items, cols);
      const tpl = 'grid-template-columns:64px repeat(' + cols.length + ',minmax(0,1fr))';
      const box = el('div', { class: 'pjh-bd', 'data-mscroll': 'board' });
      box.append(el('div', { class: 'pjh-bd-h', style: tpl }, el('span', {}), ...cols.map((c) => personHead(c, items))));
      for (const d of days) {
        const dp = dayParts(d.at, now);
        box.append(el('div', { class: 'pjh-bd-r' + (dp.main === '오늘' ? ' today' : ''), style: tpl },
          el('div', { class: 'pjh-bd-d' }, el('b', { text: dp.main }), el('span', { text: dp.sub })),
          ...d.cells.map((cell, ci) => el('div', { class: 'pjh-bd-c' + (cell.length ? '' : ' empty') },
            ...cell.map((a) => work(a, { face: cols[ci].key === 'others', lines: 2, when: 'hm', who: cols[ci].key === 'others', pick }))))));
      }
      return box as HTMLElement;
    };
    /** 사람별 최근 — 한 줄 높이 위젯. 사람마다 한 열, 그 사람의 최근 작업 rows 개(때는 «14:05 · 어제 14:05 · 9/25»). */
    const lanes = (items: any[], maxCols: number, rows: number, pick: WorkOpts['pick']): HTMLElement => {
      const cols = boardCols(peopleByRecency(items), maxCols);
      const rec = recentByCol(items, cols, rows);
      return el('div', { class: 'pjh-pl', style: 'grid-template-columns:repeat(' + cols.length + ',minmax(0,1fr))' },
        ...cols.map((c, i) => el('div', { class: 'pjh-pl-c' }, personHead(c, items),
          ...rec[i].map((a) => work(a, { face: c.key === 'others', lines: 1, when: 'short', pick }))))) as HTMLElement;
    };

    // ── 고른 작업의 속(3×2 · 모달 옆 칸) ──
    const paintSide = (side: HTMLElement, a: any | null): void => {
      if (!a) { side.replaceChildren(el('div', { class: 'pjh-side-l', text: '고른 작업' }), el('div', { class: 'pjh-stat', text: '왼쪽에서 작업을 누르면 속이 여기 섭니다.' })); return; }
      const t = actWhen(a); const d = t ? new Date(t) : null;
      const full = d ? d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '. ' + hmOf(t) + ' · ' + relTime(d.toISOString()) : '';
      const refs: any[] = Array.isArray(a.refs) ? a.refs : [];
      const sp = splitSummary(a.summary || a.title);
      const task = taskOf(a);
      const who = memberName(a.author_person) || '—';
      const sbtn = (label: string, icon: string, fn: () => void, ghost = true): HTMLElement =>
        el('button', { class: 'pjh-sbtn' + (ghost ? ' ghost' : ''), type: 'button', onclick: fn }, hubIcon(icon, 12), label) as HTMLElement;
      //  ⚠ replaceChildren 은 null 을 «null» 글자로 앉힌다 — 없는 조각은 걸러서 넘긴다.
      const kids: any[] = [
        el('div', { class: 'pjh-side-l', text: '고른 작업' }),
        el('div', { class: 'pjh-wd-who' }, a.author_person ? personFace(a.author_person, 'pjv-ava', who) : null,
          el('b', { text: who }), el('span', { text: full })),
        el('div', { class: 'pjh-tl-h' }, el('i', { class: 'pjh-ev-dot ' + String(a.type || '') }), el('b', { class: 'pjh-ev-ty', text: TYPE_LABEL[a.type] || a.type || '기타' }),
          sp.kind ? el('span', { class: 'pjh-wd-kind', text: sp.kind }) : null),
        el('div', { class: 'pjh-tl-t', text: sp.text || a.title || '(내용 없음)' }),
        a.title && a.title !== a.summary ? el('div', { class: 'pjh-tl-s', text: String(a.title) }) : null,
        a.body ? el('div', { class: 'pjh-stail pjh-wd-body', text: String(a.body) }) : null,
        el('div', { class: 'pjh-kv' },
          ...(task ? [el('b', { text: '태스크' }), (() => { const c = el('button', { class: 'pjh-tb', type: 'button', title: '누르면 태스크 열기' }, hubIcon('tasks', 11), el('span', { text: task.name })); c.onclick = () => openTask(task); return c; })()] : [el('b', { text: '태스크' }), el('span', { text: '프로젝트의 일(태스크 없음)' })]),
          ...(a.author_agent ? [el('b', { text: 'AI' }), el('span', { text: String(a.author_agent) })] : []),
          ...(a.repo || a.commit_sha ? [el('b', { text: '저장소 · 커밋' }), el('span', { class: 'pjh-mono', text: [a.repo, a.commit_sha ? String(a.commit_sha).slice(0, 8) : ''].filter(Boolean).join(' @ ') })] : []),
          ...(a.session_id ? [el('b', { text: '세션' }), el('span', { class: 'pjh-mono', text: String(a.session_id) })] : []),
          ...(a.external_url ? [el('b', { text: '바깥 링크' }), el('a', { class: 'pjh-kr-t', href: String(a.external_url), target: '_blank', rel: 'noopener', text: String(a.external_url) })] : [])),
        el('div', { class: 'pjh-side-l', text: '이어진 지식 ' + refs.length }),
        ...(refs.length ? refs.map((r) => el('div', { class: 'pjh-kr' }, hubIcon('doc', 13),
          el('a', { class: 'pjh-kr-t', href: '#/k/' + encodeURIComponent(String(r.name || '')), target: '_blank', rel: 'noopener', title: '새 탭에서 지식 열기', text: r.title || r.name }),
          el('span', { class: 'pjh-kn-rel', text: REL_LABEL[r.relation] || r.relation || '' })))
          : [el('div', { class: 'pjh-rail-fine', text: '이 작업에 이어진 지식이 없습니다.' })]),
        (a.session_id || task) ? el('div', { class: 'pjh-side-acts pjh-fside-acts' },
          a.session_id ? sbtn('세션 열기', 'term', () => { location.hash = '#/s/' + encodeURIComponent(String(a.session_id)); }, false) : null,
          task ? sbtn('태스크 열기', 'tasks', () => openTask(task)) : null) : null,
      ];
      side.replaceChildren(...kids.filter(Boolean));
      hubCtx(side, sp.text || String(a.title || '작업'), who + ' · ' + (sp.kind || TYPE_LABEL[a.type] || '작업'), () => actRows(a));
    };
    /** 옆 칸이 있는 자리의 «고르기» — 다시 그리지 않고 그 줄만 켜고 옆 칸만 바꾼다. */
    const pickInPlace = (host: HTMLElement, side: HTMLElement) => (a: any, node: HTMLElement): void => {
      tools.sel = String(a.id);
      host.querySelectorAll('.pjh-wk.on').forEach((x) => x.classList.remove('on'));
      node.classList.add('on');
      paintSide(side, a);
      side.scrollTop = 0;
    };

    // ══ 위젯 ══
    if (!modal) {
      //  «마지막 …» 은 머리에 이미 있다 — 바닥은 무엇의 기록인지만 말한다.
      const footAll = () => foot.append(footText(w <= 1 ? '기록 ' + sorted.length + '건' : '기록 ' + sorted.length + '건 · 이 프로젝트와 그 태스크의 작업'), btn('전체 보기', 'btn-ghost', open));
      if (w <= 1 && h <= 1) {
        const list = el('div', { class: 'pjh-wlist' });
        for (const a of sorted.slice(0, 4)) list.append(work(a, { face: true, lines: 1, when: 'short', pick: pickInModal }));
        body.append(list);
        footAll();
        return;
      }
      if (w <= 1) { body.append(feed(sorted, pickInModal)); footAll(); return; }
      if (h <= 1) { body.append(lanes(sorted, w >= 3 ? 3 : 2, 3, pickInModal)); footAll(); return; }
      if (w >= 3) {
        const side = el('div', { class: 'pjh-side pjh-wside', 'data-mscroll': 'tl-side' }) as HTMLElement;
        if (!tools.sel || !sorted.some((a) => String(a.id) === tools.sel)) tools.sel = String(sorted[0].id);
        const wrap = el('div', { class: 'pjh-mtwo', style: 'grid-template-columns:minmax(0,1fr) 300px' });
        const bd = board(sorted, boardMaxCols(954 - 300 - 16), pickInPlace(wrap as HTMLElement, side));
        wrap.append(el('div', { class: 'pjh-mmain' }, bd), side);
        body.append(wrap);
        paintSide(side, sorted.find((a) => String(a.id) === tools.sel) || null);
        footAll();
        return;
      }
      body.append(board(sorted, boardMaxCols(617), pickInModal));
      footAll();
      return;
    }

    // ══ 모달 — 거르기 · 찾기 · 보기 + 판(사람별) 또는 흐름(시간순) + 고른 작업의 속 ══
    const people = peopleByRecency(sorted);
    const types = [...new Set(sorted.map((a) => String(a.type || 'other')))];
    const q = tools.q.trim().toLowerCase();
    const items = sorted.filter((a) => (!tools.person || String(a.author_person || '') === tools.person)
      && (!tools.type || String(a.type || 'other') === tools.type)
      && (!q || [a.summary, a.title, a.body, (taskOf(a) || {}).name].some((x) => String(x || '').toLowerCase().includes(q))));
    const chip = (k: string, v: string, onclick: (b: HTMLElement) => void, on = false) => {
      const c = el('button', { class: 'pjh-chip' + (on ? ' on' : ''), type: 'button' }, k + ' ', el('b', { text: v }), hubIcon('chev', 11));
      c.onclick = (e) => { e.stopPropagation(); onclick(c); };
      return c;
    };
    const menuOf = (anchor: HTMLElement, its: Array<[string, string]>, cur: string, pickV: (v: string) => void) => {
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(anchor, menu);
      for (const [v, label] of its) menu.append(el('button', { class: 'pjv-menu-item' + (v === cur ? ' sel' : ''), type: 'button', text: label, onclick: (e: Event) => { e.stopPropagation(); close(); pickV(v); } }));
    };
    const find = el('input', { type: 'search', class: 'pjh-search-in', placeholder: '작업 내용으로 찾기…', value: tools.q }) as HTMLInputElement;
    let composing = false, timer = 0;
    const onFind = (): void => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (find.value !== tools.q) { tools.q = find.value; ctx.refreshGrid(); } }, 260); };
    find.addEventListener('compositionstart', () => { composing = true; });
    find.addEventListener('compositionend', () => { composing = false; onFind(); });
    find.addEventListener('input', () => { if (!composing) onFind(); });
    if (tools.q) setTimeout(() => { const n = document.querySelector('.pjh-modal .pjh-tools-find input') as HTMLInputElement | null; if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 0);
    const view: Tools['view'] = phone ? 'feed' : tools.view;
    const filtered = !!(tools.person || tools.type || q);
    const toolsRow = el('div', { class: 'pjh-tools' },
      chip('사람', tools.person ? memberName(tools.person) : '전체', (b) => menuOf(b, [['', '전체'], ...people.map((p) => [p, memberName(p)] as [string, string])], tools.person, (v) => { tools.person = v; ctx.refreshGrid(); }), !!tools.person),
      chip('종류', tools.type ? (TYPE_LABEL[tools.type] || tools.type) : '전체', (b) => menuOf(b, [['', '전체'], ...types.map((t) => [t, TYPE_LABEL[t] || t] as [string, string])], tools.type, (v) => { tools.type = v; ctx.refreshGrid(); }), !!tools.type),
      el('span', { class: 'pjh-search pjh-tools-find' }, hubIcon('search', 13), find),
      filtered ? el('button', { class: 'pjh-chip', type: 'button', onclick: () => { tools.person = ''; tools.type = ''; tools.q = ''; ctx.refreshGrid(); } }, '거르기 지우기 ', hubIcon('x', 11)) : null,
      phone ? null : el('span', { class: 'pjh-seg pjh-tools-r' }, ...([['board', '사람별'], ['feed', '시간순']] as Array<[Tools['view'], string]>).map(([k, l]) =>
        el('button', { type: 'button', class: view === k ? 'on' : '', text: l, onclick: () => { tools.view = k; ctx.refreshGrid(); } }))));
    const side = el('div', { class: 'pjh-side pjh-wside', 'data-mscroll': 'tl-side' }) as HTMLElement;
    const sel = items.find((a) => String(a.id) === tools.sel) || items[0] || null;
    tools.sel = sel ? String(sel.id) : '';
    const wrap = el('div', { class: 'pjh-mtwo pjh-wtwo' }) as HTMLElement;
    //  판의 폭 — 모달 안쪽 폭에서 옆 칸과 사이를 뺀 것(옆 칸 폭은 CSS 와 같은 셈: clamp(320, 36%, 440)).
    const inner = Math.min(1320, Math.round(window.innerWidth * 0.96)) - 48;
    const sideW = Math.max(320, Math.min(440, Math.round(inner * 0.36)));
    const main = !items.length ? el('div', { class: 'pjh-stat', text: '이 조건에 맞는 작업이 없습니다 — 거르기를 풀어 보세요.' })
      : view === 'feed' ? feed(items, pickInPlace(wrap, side))
        : board(items, boardMaxCols(inner - sideW - 22), pickInPlace(wrap, side));
    wrap.append(el('div', { class: 'pjh-mmain' }, main), side);
    body.append(toolsRow, wrap);
    paintSide(side, sel);
    foot.append(footText(phone ? (filtered ? '거른 작업 ' + items.length + '건 / 전체 ' + sorted.length + '건' : '작업 ' + sorted.length + '건')
      : (filtered ? '거른 작업 ' + items.length + '건 / 전체 ' + sorted.length + '건' : '작업 ' + sorted.length + '건') + ' · 이 프로젝트와 그 태스크의 작업 — 줄을 누르면 오른쪽에 속이 섭니다'));
  });
};
