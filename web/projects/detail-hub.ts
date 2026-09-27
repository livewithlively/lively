// projects/detail-hub.ts — 프로젝트 상세 = **도구 위젯 허브** (#3916, 2026-09-14 원준 결정: "원안(안 5 허브)이 제일 낫다 ·
//  카드 크기·배치를 설정에서 · 크기에 맞춰 뷰가 완전히 다르게, 휴대폰 위젯처럼").
//
//  화면 = 속성 띠(detail-meta.ts pjvProjFactsStrip, detail.ts 가 세운다) 아래 **3열 격자**에 도구 위젯 여섯(태스크·세션·본문·
//  공유 폴더·연결된 지식·작업 타임라인). 크기(가로 w × 세로 h, #4164)가 곧 뷰다.
//  #4135 5판(2026-09-25 원준): 여섯 위젯 모두 **모든 크기를 위젯 자신이 그린다**(detail-hub-{tasks,sessions,body,knowledge,folder,timeline}
//   — 크기는 «무엇을 몇 줄 어떤 열로» 만 바꾼다). 기존 섹션 카드는 «열기»(전폭)에서만 선다. hubView 는 편집 모드 크기 라벨에만 남는다.
//  배치(순서·크기·숨김)는 detail-hub-layout.ts 가 저장한다(내 계정 전역 한 벌 · «이 프로젝트에서만» 토글). 편집 모드는 iOS 홈
//  편집 문법 — 손잡이(⋮⋮)를 끌어 순서, 오른쪽 아래 모서리를 끌거나 [w×h] 격자에서 골라 크기, × 로 숨김, 「＋ 위젯」 슬롯으로 되살림.
//
//  ⚠ 의존 방향: 이 모듈은 섹션 렌더러(detail-tasks·detail-terminal·detail-folder·detail-body·detail-sections)를 **직접 물지 않는다** —
//   그것들은 배럴(projects.ts)을 되짚어 새 순환을 만든다(scripts/check-imports.mjs). detail.ts 가 **공장(sections · tasksList · newSession …)** 으로 넣어 준다.
//   여기서 import 하는 것은 리프뿐(core · files-icons · files-format · popover · status · detail-hub-layout · detail-hub-kit · 위젯 채움 모듈).
//  ⚠ 열기(→ 도구 전폭)는 페이지에선 주소(#/projects2/p/:id/<도구>)로, 모달(.pjv-pm) 안에선 제자리 전환으로 — 모달은 자기 주소를
//   소유하므로(#808) 해시를 바꾸면 라우터가 모달을 닫는다.
import { api, el, loadPeopleAvatars, personDisplayName } from '../core.js';
import { pjvPopover } from './popover.js';
import {
  HUB_COLS, HUB_MAX_H, HUB_PRESETS, HUB_TOOL_LABEL, HUB_TOOLS, HUB_VIEW_LABEL, applyHubPreset, hideHubItem, hubView,
  loadHubLayout, matchHubPreset, moveHubItem, resetHubLayout, resizeHubItem, saveHubLayout, setHubScope, showHubItem,
  type HubLayout, type HubTool,
} from './detail-hub-layout.js';
import { SEP, TOOL_TONE, type Fill, type HubCtx, type HubData, type HubOpts, btn, hubCtxSurface, hubIcon } from './detail-hub-kit.js';
import { fillTasks } from './detail-hub-tasks.js';
import { fillSessions } from './detail-hub-sessions.js';
import { fillBody } from './detail-hub-body.js';
import { fillKnowledge } from './detail-hub-knowledge.js';
import { fillFolder } from './detail-hub-folder.js';
import { fillTimeline } from './detail-hub-timeline.js';

export type { HubOpts, HubSectionFactory, HubTasksListOpts } from './detail-hub-kit.js';

// ── 도구 모달(#4135, 2026-09-27 원준: «열기는 모달로 통일 — 프로젝트 창에서 나가지지 않게») ─────────────────────
//  한 번에 하나. 상세가 다시 그려져도(o.reload → 허브 재마운트) 열어 둔 도구를 되살린다 — 그래서 상태가 모듈에 산다.
const OPEN_MODAL: Map<number, HubTool> = new Map();
let modalEl: HTMLElement | null = null;
let modalOff: (() => void) | null = null;
function dropModal(): void {
  if (modalOff) { modalOff(); modalOff = null; }
  if (modalEl) { modalEl.remove(); modalEl = null; }
}

// ══ 허브 ══════════════════════════════════════════════════════════════════════
export function mountProjectHub(host: HTMLElement, o: HubOpts): void {
  const pid = o.id;
  const P = o.p || {};

  // 데이터 — 위젯마다 따로 부르지 않고 허브가 한 번 받아 나눠 준다(같은 화면에서 같은 것을 두 번 묻지 않는다). invalidate 로 한 키만 다시.
  const lazyOf = <T,>(fn: () => Promise<T>): { get: () => Promise<T>; drop: () => void } => { let p: Promise<T> | null = null; return { get: () => (p ||= fn()), drop: () => { p = null; } }; };
  const L = {
    sessions: lazyOf(() => api(o.base + pid + '/sessions').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[])),
    files: lazyOf(() => api(o.base + pid + '/files?path=').then((d: any) => (d && d.items) || []).catch(() => [] as any[])),
    acts: lazyOf(() => api(o.base + pid + '/activity').then((d: any) => (d && d.activities) || []).catch(() => [] as any[])),
    comments: lazyOf(() => api('/api/ui/v6/projects/' + pid + '/comments').then((d: any) => ((d && d.feed) || []).filter((f: any) => f && f.kind === 'comment')).catch(() => [] as any[])),
    recs: lazyOf(() => api('/api/ui/v6/projects/' + pid + '/recommend-knowledge?limit=5').then((d: any) => (d && d.entries) || []).catch(() => [] as any[])),
  };
  const D: HubData = {
    sessions: () => L.sessions.get(), files: () => L.files.get(), acts: () => L.acts.get(), comments: () => L.comments.get(), recs: () => L.recs.get(),
    invalidate: (key) => L[key].drop(),
  };
  // 사람 이름 — 프로젝트 구성원 → 조직 명부(avatar.ts 의 같은 맵) → id. 명부가 아직 안 왔으면 오는 대로 한 번 다시 그린다(id 로 선 첫 그림을 이름으로).
  const memberName = (mid: string): string => { const m = (o.members || []).find((x) => x.member_id === mid); return (m && m.display_name) || personDisplayName(mid) || mid || ''; };
  let namesPending = !personDisplayName(String(o.meId || ''));

  // 배치 상태
  let { layout, scope } = loadHubLayout(pid);
  let editing = false;
  let focus: HubTool | null = o.focus;
  const mq = window.matchMedia('(max-width: 900px)');
  let narrow = mq.matches;

  const commit = (next: HubLayout): void => { layout = next; saveHubLayout(pid, layout, scope); renderGrid(); };
  // 열기 = 모달(화면을 옮기지 않는다). 주소로 들어온 전폭 보기(o.focus — 옛 링크)에서 허브로 돌아가는 길만 leaveFocus 가 맡는다.
  const openTool = (tool: HubTool | null): void => { if (tool) openToolModal(tool); else closeToolModal(); };
  const leaveFocus = (): void => {
    if (o.inModal) { focus = null; render(); return; }
    location.hash = '#/projects2/p/' + pid;
  };
  const ctx: HubCtx = {
    pid, P, o, D, meId: String(o.meId || ''), narrow, openTool, memberName,
    refreshGrid: () => renderGrid(),
  };

  // 5판 위젯 — 여섯 도구 모두 모든 크기를 스스로 그린다.
  const FILL5: Record<HubTool, Fill> = { tasks: fillTasks, sessions: fillSessions, body: fillBody, knowledge: fillKnowledge, folder: fillFolder, timeline: fillTimeline };

  // ── 도구 모달 — 같은 채움 함수가 Fit.modal 로 «전체 뷰» 를 그린다. 다시 그릴 때 스크롤 자리([data-mscroll])를 되살린다. ──
  function closeToolModal(): void {
    const had = OPEN_MODAL.has(pid) || !!modalEl;
    OPEN_MODAL.delete(pid);
    dropModal();
    if (had && grid.isConnected && !focus) renderGrid();   // 모달에서 바꾼 것(필터·고른 것·본문)을 뒤 격자에도
  }
  function renderModal(tool: HubTool): void {
    const keep: Record<string, number> = {};
    if (modalEl) modalEl.querySelectorAll('[data-mscroll]').forEach((n) => { keep[(n as HTMLElement).dataset.mscroll || ''] = (n as HTMLElement).scrollTop; });
    dropModal();
    const sub = el('span', { class: 'pjh-wh-sub' });
    const acts = el('span', { class: 'pjh-wh-acts' });
    const x = el('button', { class: 'pjh-mx', type: 'button', title: '닫기 (Esc)', 'aria-label': '닫기', onclick: () => closeToolModal() }, hubIcon('x', 16));
    const head = el('div', { class: 'pjh-wh pjh-mh' },
      el('span', { class: 'pjh-wh-ic ' + TOOL_TONE[tool] }, hubIcon(tool, 16)),
      el('span', { class: 'pjh-wh-name', text: HUB_TOOL_LABEL[tool] }), sub, acts, x);
    const body = el('div', { class: 'pjh-wb pjh-mb' });
    const foot = el('div', { class: 'pjh-wf pjh-mf' });
    const box = el('div', { class: 'pjh-w pjh-modal pjh-w3 pjh-m-' + tool, 'data-tool': tool, role: 'dialog', 'aria-modal': 'true', 'aria-label': HUB_TOOL_LABEL[tool] }, head, body, foot);
    const back = el('div', { class: 'pjh-mback' }, box);
    back.addEventListener('mousedown', (e: MouseEvent) => { if (e.target === back) closeToolModal(); });
    //  Esc — 위에 뜬 것(태스크 모달 · 팝오버)이 있으면 그쪽 몫이다.
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !document.querySelector('.pjv-tm-back, .pjv-menu')) closeToolModal(); };
    const onHash = (): void => closeToolModal();
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    modalOff = () => { document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); };
    modalEl = back;
    document.body.append(back);
    hubCtxSurface(box, () => [{ label: '닫기', icon: 'x', hint: 'Esc', run: () => closeToolModal() }], HUB_TOOL_LABEL[tool]);
    const mctx: HubCtx = { ...ctx, narrow: mq.matches, refreshGrid: () => renderModal(tool), openTool: (t) => { if (!t) closeToolModal(); else if (t !== tool) openToolModal(t); } };
    FILL5[tool](mctx, { view: 'full', w: 3, h: 3, modal: true }, body, foot, sub, acts);
    const restore = (): void => {
      if (modalEl !== back) return;
      back.querySelectorAll('[data-mscroll]').forEach((n) => { const k = (n as HTMLElement).dataset.mscroll || ''; if (keep[k]) (n as HTMLElement).scrollTop = keep[k]; });
    };
    requestAnimationFrame(() => requestAnimationFrame(restore));
    setTimeout(restore, 160);   // 채움이 약속(세션·파일·기록) 뒤에 서는 도구
  }
  function openToolModal(tool: HubTool): void { OPEN_MODAL.set(pid, tool); renderModal(tool); }

  // ── 위젯 한 장 ── 격자 칸 수는 CSS 변수(--w·--h)로 — 좁은 폭(한 열)에선 CSS 가 그 변수를 버린다(37-projects-hub.css).
  function widget(tool: HubTool, w: number, h: number): HTMLElement {
    const view = hubView(w, h, narrow);
    const card = el('div', { class: 'pjh-w v-' + view + (w === 1 ? ' col' : '') + ' pjh-w' + (narrow ? 1 : w) + ' pjh-h' + h, 'data-tool': tool, style: '--w:' + w + ';--h:' + h });
    const sub = el('span', { class: 'pjh-wh-sub' });
    const acts = el('span', { class: 'pjh-wh-acts' });
    const openBtn = el('button', { class: 'pjh-open', type: 'button', title: HUB_TOOL_LABEL[tool] + ' 크게 열기(이 화면 위에 창으로)', 'aria-haspopup': 'dialog', onclick: () => openTool(tool) }, '열기 ', hubIcon('right', 13));
    acts.append(openBtn);
    const head = el('div', { class: 'pjh-wh' },
      el('span', { class: 'pjh-wh-ic ' + TOOL_TONE[tool] }, hubIcon(tool, 16)),
      el('span', { class: 'pjh-wh-name', text: HUB_TOOL_LABEL[tool] }), sub, acts);
    const body = el('div', { class: 'pjh-wb' });
    const foot = el('div', { class: 'pjh-wf' });
    card.append(head, body, foot);
    const fit = { view, w: narrow ? 1 : w, h };
    ctx.narrow = narrow;
    //  빈 자리 우클릭 — 어느 위젯이든 «크게 열기 · 배치 편집 · 숨기기». 도구가 제 빈 자리 메뉴를 가지면(폴더·본문) 그쪽이 덮어 건다.
    hubCtxSurface(card, () => [
      { label: '크게 열기', icon: 'window', run: () => openTool(tool) },
      SEP,
      narrow ? null : { label: editing ? '배치 편집 끝내기' : '배치 편집', icon: 'apps', run: () => { editing = !editing; render(); } },
      narrow ? null : { label: '이 위젯 숨기기', icon: 'x', run: () => commit(hideHubItem(layout, tool)) },
    ], HUB_TOOL_LABEL[tool]);
    FILL5[tool](ctx, fit, body, foot, sub, acts);
    if (editing) decorateEdit(card, tool, w, h);
    return card;
  }

  // ── 편집 모드 크롬 ──
  const sizeText = (w: number, h: number): string => w + '×' + h + ' · ' + HUB_VIEW_LABEL[hubView(w, h)];
  // 크기 고르기 — 표 삽입 격자처럼 가로 HUB_COLS × 세로 HUB_MAX_H 칸에 올려 미리 보고 눌러 정한다(모서리 끌기의 정밀판).
  function openSizePicker(anchor: HTMLElement, tool: HubTool, w0: number, h0: number): void {
    const cells = el('div', { class: 'pjh-szg', style: 'grid-template-columns:repeat(' + HUB_COLS + ',1fr)' });
    const label = el('div', { class: 'pjh-szg-l', text: sizeText(w0, h0) });
    const paint = (w: number, h: number): void => {
      for (const c of Array.from(cells.children) as HTMLElement[]) c.classList.toggle('on', Number(c.dataset.w) <= w && Number(c.dataset.h) <= h);
      label.textContent = sizeText(w, h);
    };
    const menu = el('div', { class: 'pjv-menu pjh-szg-pop' }, cells, label);
    const close = pjvPopover(anchor, menu);
    for (let h = 1; h <= HUB_MAX_H; h++) for (let w = 1; w <= HUB_COLS; w++) {
      cells.append(el('button', { type: 'button', 'data-w': String(w), 'data-h': String(h), 'aria-label': w + '×' + h,
        onmouseenter: () => paint(w, h), onfocus: () => paint(w, h),
        onclick: (e: Event) => { e.stopPropagation(); close(); if (w !== w0 || h !== h0) commit(resizeHubItem(layout, tool, w, h)); } }));
    }
    cells.addEventListener('mouseleave', () => paint(w0, h0));
    paint(w0, h0);
  }
  // 오른쪽 아래 모서리 끌기 — 칸 단위로 끊어 그 자리에서 크기를 바꿔 보여 준다(격자가 dense 라 옆 위젯이 따라 흐른다).
  //  기준은 **누른 자리에서의 이동량**이다: 카드가 넓어지며 다음 줄로 흘러도 그 새 위치로 다시 재지 않는다(재면 크기가 튄다).
  function resizeGrip(card: HTMLElement, tool: HubTool, w0: number, h0: number): HTMLElement {
    const grip = el('span', { class: 'pjh-rsz', title: '끌어서 크기 바꾸기', 'aria-hidden': 'true' });
    grip.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      card.draggable = false;   // 순서 끌기(HTML5 DnD)가 같은 몸짓을 가로채지 않게 — 놓으면 다시 켠다
      const cs = getComputedStyle(grid);
      const gapX = parseFloat(cs.columnGap) || 16, gapY = parseFloat(cs.rowGap) || 16;
      const colW = (grid.getBoundingClientRect().width - gapX * (HUB_COLS - 1)) / HUB_COLS;
      const rowH = parseFloat(cs.gridAutoRows) || 260;
      const x0 = e.clientX, y0 = e.clientY;
      let w = w0, h = h0;
      const tip = el('span', { class: 'pjh-rsz-tip', text: sizeText(w, h) });
      card.append(tip); card.classList.add('resizing');
      try { grip.setPointerCapture(e.pointerId); } catch (_) { /* 옛 브라우저 — move 는 grip 위에서만 */ }
      const move = (ev: PointerEvent): void => {
        const nw = Math.max(1, Math.min(HUB_COLS, w0 + Math.round((ev.clientX - x0) / (colW + gapX))));
        const nh = Math.max(1, Math.min(HUB_MAX_H, h0 + Math.round((ev.clientY - y0) / (rowH + gapY))));
        if (nw === w && nh === h) return;
        w = nw; h = nh;
        card.style.setProperty('--w', String(w)); card.style.setProperty('--h', String(h));
        tip.textContent = sizeText(w, h);
      };
      const up = (): void => {
        grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
        card.draggable = true; card.classList.remove('resizing'); tip.remove();
        if (w !== w0 || h !== h0) commit(resizeHubItem(layout, tool, w, h));   // 커밋이 그 크기의 뷰로 다시 그린다
      };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    return grip;
  }
  function decorateEdit(card: HTMLElement, tool: HubTool, w: number, h: number): void {
    const sizeBtn = el('button', { class: 'pjh-szbtn', type: 'button', title: '크기 고르기 — 가로 × 세로 칸', 'aria-haspopup': 'dialog', text: w + '×' + h,
      onclick: (e: Event) => { e.stopPropagation(); openSizePicker(sizeBtn, tool, w, h); } });
    const hide = el('button', { class: 'pjh-hide', type: 'button', title: '숨기기', 'aria-label': HUB_TOOL_LABEL[tool] + ' 숨기기', onclick: (e: Event) => { e.stopPropagation(); commit(hideHubItem(layout, tool)); } }, hubIcon('x', 13));
    card.prepend(el('div', { class: 'pjh-edtools' }, el('span', { class: 'pjh-grip', title: '끌어서 순서 바꾸기' }), el('span', { class: 'pjh-edtools-sp' }), hide, sizeBtn));
    card.append(resizeGrip(card, tool, w, h));
    card.draggable = true;
    card.addEventListener('dragstart', (e: DragEvent) => { e.dataTransfer?.setData('text/plain', tool); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); grid.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
    card.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; card.classList.add('over'); });
    card.addEventListener('dragleave', () => card.classList.remove('over'));
    card.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault(); card.classList.remove('over');
      const src = e.dataTransfer?.getData('text/plain') as HubTool;
      if (src && src !== tool && (HUB_TOOLS as string[]).includes(src)) commit(moveHubItem(layout, src, tool));
    });
  }
  function editBar(): HTMLElement {
    const presetBtn = el('button', { class: 'pjh-preset', type: 'button' }, hubIcon('grid', 13), '프리셋' + (matchHubPreset(layout) ? ' · ' + (HUB_PRESETS.find((p) => p.id === matchHubPreset(layout)) || HUB_PRESETS[0]).label : ''), hubIcon('chev', 12));
    presetBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu pjh-preset-pop' });
      const close = pjvPopover(presetBtn, menu);
      const cur = matchHubPreset(layout);
      for (const p of HUB_PRESETS) {
        const mini = el('span', { class: 'pjh-pm' });
        for (const it of p.items) mini.append(el('i', { class: it.tool === 'tasks' ? 'a' : '', style: 'grid-column:span ' + it.w + ';grid-row:span ' + it.h }));
        menu.append(el('button', { class: 'pjh-preset-row' + (cur === p.id ? ' on' : ''), type: 'button', onclick: () => { close(); commit(applyHubPreset(p.id)); } }, mini, el('span', { text: p.label })));
      }
    };
    const sw = el('button', { class: 'pjh-sw', type: 'button', role: 'switch', 'aria-checked': String(scope === 'project'),
      onclick: () => { const r = setHubScope(pid, scope === 'project' ? 'global' : 'project', layout); layout = r.layout; scope = r.scope; render(); } },
      el('i'), '이 프로젝트에서만');
    return el('div', { class: 'pjh-edbar' }, hubIcon('grid', 15),
      el('span', {}, el('b', { text: '배치 편집' }), ' — 손잡이(⋮⋮)를 끌어 순서를 바꾸고, 오른쪽 아래 모서리를 끌거나 [가로×세로] 를 눌러 크기를 고르면 그 자리에서 뷰가 바뀝니다. 격자는 빈틈 없이 다시 채워집니다.'),
      el('span', { class: 'pjh-edbar-r' }, presetBtn, sw,
        btn('기본으로', 'btn-ghost', () => { layout = resetHubLayout(pid, scope); renderGrid(); }),
        btn('완료', 'btn-primary', () => { editing = false; render(); })));
  }
  function slot(): HTMLElement {
    const s = el('div', { class: 'pjh-slot' });
    if (!layout.hidden.length) s.append(el('span', { text: '숨긴 도구 없음 — 카드의 × 로 숨기면 여기서 되살립니다' }));
    else {
      s.append(hubIcon('plus', 15), el('span', { text: '위젯 추가' }));
      for (const t of layout.hidden) s.append(btn(HUB_TOOL_LABEL[t], 'btn-ghost', () => commit(showHubItem(layout, t))));
    }
    // 슬롯에 놓으면 맨 뒤로
    s.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); s.classList.add('over'); });
    s.addEventListener('dragleave', () => s.classList.remove('over'));
    s.addEventListener('drop', (e: DragEvent) => { e.preventDefault(); s.classList.remove('over'); const src = e.dataTransfer?.getData('text/plain') as HubTool; if (src && (HUB_TOOLS as string[]).includes(src)) commit(moveHubItem(layout, src, null)); });
    return s;
  }

  // ── 조립 ──
  const grid = el('div', { class: 'pjh-grid' });
  const top = el('div', {});
  const editBtn = btn('배치 편집', 'btn-ghost', () => { editing = !editing; render(); }, { class: 'btn btn-sm btn-ghost pjh-edit-btn' });
  editBtn.prepend(hubIcon('grid', 13));
  function renderGrid(): void {
    grid.classList.toggle('edit', editing);
    grid.replaceChildren(...layout.items.map((it) => widget(it.tool, it.w, it.h)));
    if (namesPending) { namesPending = false; loadPeopleAvatars().then(() => { if (grid.isConnected && !focus) renderGrid(); }); }
  }
  function render(): void {
    host.replaceChildren();
    if (focus) {
      const tool = focus;
      host.append(el('div', { class: 'pjh-focus-bar' }, btn('허브', 'btn-ghost', () => leaveFocus()), el('b', { text: HUB_TOOL_LABEL[tool] }),
        el('span', { class: 'muted', style: 'font-size:12.5px;color:var(--muted-2)', text: '전폭 보기 — 가장 큰 위젯의 확장' })));
      host.append(el('div', { class: 'pjh-focus' }, o.sections[tool]()));
      if (o.actionsHost) o.actionsHost.replaceChildren();
      return;
    }
    if (o.actionsHost) { o.actionsHost.replaceChildren(editBtn); editBtn.classList.toggle('active', editing); }
    top.replaceChildren();
    if (editing) top.append(editBar());
    host.append(top, grid);
    renderGrid();
    if (editing) host.append(slot());
  }
  const onMq = (): void => { const n = mq.matches; if (n !== narrow) { narrow = n; renderGrid(); } };
  try { mq.addEventListener('change', onMq); } catch (_) { /* 옛 사파리 */ }
  render();
  // 열어 둔 도구 모달 — 상세가 다시 그려져(o.reload) 여기로 돌아왔으면 새 자료로 다시 세운다. 다른 프로젝트의 것은 걷는다.
  const reopen = OPEN_MODAL.get(pid);
  if (reopen && !focus) renderModal(reopen); else if (modalEl) dropModal();
}
