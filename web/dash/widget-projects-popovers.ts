// dash/widget-projects-popovers.ts — '내 프로젝트' 위젯의 팝오버 3종(#1313 R42 · dashboard-home.ts 에서 verbatim 분리).
//  ① 리스트별 목록 거르기(그룹 헤더 ⌄) ② 개요 끝 '+ 리스트'(찾아 불러오기 / 새로 만들기) ③ 위젯 ⚙ 설정(스페이스›폴더 트리).
//  셋 다 fillProjects 의 클로저 지역 상태를 읽고 쓴다 — 그 상태는 이제 ProjCtx 한 덩어리로 넘어온다(widget-projects.ts).
//
// ⚠ 이 파일이 지켜야 하는 계약
//  · **팝오버는 자기 패널만 다시 그린다**. 항목을 하나 고를 때마다 위젯을 통째로 draw() 하면, 팝오버가 붙어 있던
//    앵커 버튼이 새 노드로 갈려 dashPopover 의 바깥클릭 감지가 오작동하고 선택이 끊긴다(#1236·#1098 동형).
//    ①은 그래서 onChange(그룹 body 만 다시 그리기) 콜백을 받고, ③은 renderTree() 로 자기 트리만 다시 그린다.
//  · ①의 검색 입력(qIn)·③의 검색 입력(search) **노드는 재생성하지 않는다** — 포커스·커서 위치가 유지돼야 한다.
//  · ctx.listById 는 참조를 유지해야 하는 Map 이다(widget-projects.ts 헤더 참조) — 여기서 새로 만들지 않는다.
import { el } from '../core.js';
import { PJV_PRIORITY, PJV_PRIORITY_ORDER, avatarColor, openListForm, pjvFolderIsArchive, pjvFolderIsSpace } from '../projects.js';
import { dashListFilter, dashListFilterOn, dashListFilterPreds, dashSaveListFilter, dashProjFilterStatusKey, dashOvHidden, dashOvPinned, dashSaveOvHidden, dashSaveOvPinned, dashProjFilterDefault, dashSaveProjFilterDefault, dashTaskCountMode, dashSaveTaskCountMode } from './prefs.js';
import { dashListStatusDefs } from './status.js';
import { dashFolderThumb } from './icons.js';
import { dashPopover } from './chrome.js';
import type { ProjCtx } from './widget-projects.js';

// 리스트별 필터 팝오버(#1236 고도화) — 이름 + 상태(리스트 커스텀 상태 어휘)·담당·우선순위·태그·마감.
//  세션 위젯 필터(#1098)와 같은 다중선택 문법: '전체' 행(=이 축 안 거름) + 체크 행 + 다른 축만 적용한 개수.
//  항목을 골라도 닫히지 않고 자기 패널만 다시 그린다 — 검색 입력 노드는 안 건드려 포커스·커서가 유지된다.
//  onChange = 그룹 body 만 다시 그리는 콜백(위젯 전체 재렌더 금지 — 팝오버가 붙은 버튼이 살아 있어야 한다).
function projOpenListFilter(ctx: ProjCtx, anchor, listId, l, rawAll, onChange) {
  const panel = el('div', { class: 'dash-pop-panel dash-pop-panel--filter' });
  const head = el('div', { class: 'dash-pop-head' });
  const qIn: any = el('input', { class: 'dash-pop-search', type: 'text', placeholder: '프로젝트 이름…', 'aria-label': '프로젝트 이름으로 거르기', value: dashListFilter(listId).q });
  const secs = el('div');
  panel.append(head, qIn, secs);
  const save = (patch) => dashSaveListFilter(listId, { ...dashListFilter(listId), ...patch });
  const AXES = ['who', 'q', 'st', 'pri', 'tags', 'due'];
  const render = () => {
    const lf: any = dashListFilter(listId);
    const P = dashListFilterPreds(lf, l, ctx.mineIds);
    // 축별 카운트 풀 — 자기 축만 빼고 나머지 축 전부 적용(#1098 동형). mode(위젯 칩)는 안 건다 — 상태 축이 칩을 대체하는 축이라.
    const pool = (skip) => rawAll.filter((p) => AXES.every((k) => k === skip || P[k](p)));
    head.replaceChildren(el('strong', { text: '목록 거르기' }),
      dashListFilterOn(lf)
        ? (() => { const c = el('button', { class: 'dash-pop-clear', type: 'button', text: '초기화' }); c.onclick = () => { dashSaveListFilter(listId, null); qIn.value = ''; apply(); }; return c; })()
        : el('span', { class: 'dash-pop-sub', text: '이 기기에 저장돼요' }));
    const nodes: any[] = [];
    // 다중선택 섹션 한 벌 — opts: {key, label, deco?(색점/깃발), match(p)}.
    const multiSec = (title, axis, opts) => {
      nodes.push(el('div', { class: 'dash-pop-sec', text: title }));
      const cur = new Set(lf[axis]);
      const pl = pool(axis);
      const allRow = el('button', { class: 'dash-pop-opt dash-pop-opt--all' + (cur.size === 0 ? ' sel' : ''), type: 'button', 'aria-pressed': String(cur.size === 0) },
        el('span', { class: 'dash-pop-box', text: cur.size === 0 ? '✓' : '' }),
        el('span', { class: 'dash-pop-name', text: '전체' }),
        el('span', { class: 'dash-pop-cnt', text: String(pl.length) }));
      allRow.onclick = () => { save({ [axis]: [] }); apply(); };
      nodes.push(allRow);
      for (const o of opts) {
        const on = cur.has(o.key);
        const n = pl.filter(o.match).length;
        // 0건 항목도 숨기지 않는다(#1098 동형) — '이 리스트엔 긴급이 없구나'가 그 자리에서 읽히게.
        const row = el('button', { class: 'dash-pop-opt' + (on ? ' sel' : '') + (n === 0 && !on ? ' zero' : ''), type: 'button', 'aria-pressed': String(on) },
          el('span', { class: 'dash-pop-box', text: on ? '✓' : '' }), o.deco || null,
          el('span', { class: 'dash-pop-name', text: o.label }),
          el('span', { class: 'dash-pop-cnt', text: String(n) }));
        row.onclick = () => { const next = new Set(cur); if (on) next.delete(o.key); else next.add(o.key); save({ [axis]: [...next] }); apply(); };
        nodes.push(row);
      }
    };
    // 단일선택 세그 한 줄 — 담당·마감처럼 상호배타 축.
    const segSec = (title, axis, opts) => {
      nodes.push(el('div', { class: 'dash-pop-sec', text: title }));
      const row = el('div', { class: 'dash-pop-seg' });
      for (const [k, label] of opts) {
        const b = el('button', { class: 'dash-pop-segbtn' + (k === lf[axis] ? ' on' : ''), type: 'button', text: label });
        b.onclick = () => { save({ [axis]: k }); apply(); };
        row.append(b);
      }
      nodes.push(row);
    };
    // 상태 — 커스텀 상태 리스트면 그 어휘(색점)로, 아니면 표준 3버킷. dashProjFilterStatusKey 와 같은 defs 키라 판정이 어긋나지 않는다.
    multiSec('상태', 'st', dashListStatusDefs(l).map((d: any) => ({
      key: String(d.key), label: d.label,
      deco: el('span', { class: 'pjv-list-dot sm', style: 'background:' + (d.color || 'var(--muted-3)') }),
      match: (p) => dashProjFilterStatusKey(p, l) === String(d.key),
    })));
    segSec('담당', 'who', [['all', '전체'], ['mine', '내 프로젝트만']]);
    // 우선순위 — 프로젝트 탭과 같은 어휘·깃발색(PJV_PRIORITY). 행에 우선순위가 안 보여도 '긴급만'은 자주 쓰는 축이다.
    multiSec('우선순위', 'pri', [
      ...PJV_PRIORITY_ORDER.map((k) => ({
        key: k, label: (PJV_PRIORITY as any)[k].label,
        deco: el('span', { class: 'pjv-flag ' + (PJV_PRIORITY as any)[k].cls, text: '⚑' }),
        match: (p) => String(p.priority || '') === k,
      })),
      { key: 'none', label: '미지정', match: (p) => !p.priority },
    ]);
    // 태그 — 이 리스트 프로젝트에 실제로 붙은 태그만 후보로(하나도 없으면 섹션 생략 — 고를 게 없다).
    const tagMap = new Map<string, any>();
    for (const p of rawAll) for (const t of (p.tags || [])) if (!tagMap.has(String(t.id))) tagMap.set(String(t.id), t);
    if (tagMap.size) multiSec('태그', 'tags', [...tagMap.values()].map((t: any) => ({
      key: String(t.id), label: t.name || '(이름 없음)',
      deco: el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (t.color || 'var(--muted-3)') }),
      match: (p) => (p.tags || []).some((x) => String(x.id) === String(t.id)),
    })));
    segSec('마감', 'due', [['', '전체'], ['over', '지남'], ['week', '7일 이내'], ['unset', '없음']]);
    secs.replaceChildren(...nodes);
  };
  const apply = () => { onChange(); render(); };
  // 입력마다 목록·카운트만 갱신 — 입력 노드는 다시 만들지 않는다(포커스·커서 유지).
  qIn.addEventListener('input', () => { save({ q: qIn.value }); apply(); });
  render();
  dashPopover(anchor, panel);
  qIn.focus();
}

// #req R20 — 개요 그리드 맨 끝 '+ 리스트' 카드. 클릭하면 한 칸짜리 입력이 뜨고, 타이핑에 따라 **두 갈래**로 갈린다:
//   ① 이미 있는 리스트를 찾아 요약 카드로 **불러오기**(아래 제안 목록에서 선택) — 조직의 모든 리스트가 대상.
//   ② Enter = **새로 만들기** → 리스트 설정 팝업(openListForm)을 연다. 여기서 스페이스·폴더를 반드시 고르게 된다(#1067).
//  예전엔 Enter 가 POST /project-lists 를 곧장 때려 **스페이스 밖에 뜬 리스트**가 만들어졌다 — 그 경로를 없앴다.
function projListAddCard(ctx: ProjCtx) {
  const card = el('div', { class: 'pjv-ov-card dash-ov-addcard', role: 'button', tabindex: '0', title: '리스트 추가·불러오기' });
  const showBtn = () => card.replaceChildren(el('span', { class: 'dash-ov-add-plus', text: '+' }), el('span', { class: 'dash-ov-add-lbl', text: '리스트' }));
  const showInput = () => {
    const input: any = el('input', { class: 'dash-ov-add-input', type: 'text', placeholder: '리스트 찾기 · Enter로 새로 만들기', 'aria-label': '리스트 이름 검색 또는 새 리스트 이름' });
    let panel: any = null; let closePop: any = null;
    let opts: any[] = [];   // 제안 항목 [{ id, run() }] — 마지막 항목은 항상 '새로 만들기'
    let active = -1;        // 활성 제안(-1 = 없음 → Enter 는 새로 만들기)
    const done = () => { if (closePop) closePop(); closePop = null; panel = null; showBtn(); };
    // 새로 만들기 — 이름을 넘겨 리스트 설정 팝업을 연다(스페이스·폴더 지정은 그 폼이 강제한다).
    const create = () => {
      const name = (input.value || '').trim();
      done();
      openListForm(ctx.reloadAll, undefined, { name, onCreated: (created) => {
        const id = Number(created && created.id);
        if (id) { ctx.justCreated.add(id); ctx.selectedListId = id; } // 방금 만든 리스트를 개요에 띄우고 선택(비어도)
      } });
    };
    // 기존 리스트 불러오기 — 요약 카드에 올리고(직접 고름=pinned) 그 리스트를 선택 상태로.
    const pick = (l) => { const id = Number(l.id); ctx.setListShown(id, true); ctx.selectedListId = id; done(); ctx.draw(); };
    const renderSug = () => {
      const q = (input.value || '').trim().toLowerCase();
      if (!panel) { panel = el('div', { class: 'dash-pop-panel dash-addpop' }); closePop = dashPopover(card, panel); }
      const hidden = dashOvHidden(); const pinned = dashOvPinned();
      const isOn = (id) => !hidden.has(Number(id)) && (ctx.autoIds.has(Number(id)) || pinned.has(Number(id)) || ctx.justCreated.has(Number(id)));
      const found = q ? ctx.lists.filter((l) => String(l.name || '').toLowerCase().includes(q)).slice(0, 8) : [];
      opts = []; active = -1;
      const rows: any[] = [];
      if (q && found.length) {
        rows.push(el('div', { class: 'dash-pop-gh', text: '이미 있는 리스트' }));
        for (const l of found) {
          const on = isOn(l.id);
          const row = el('div', { class: 'dash-pop-row dash-addpop-row', role: 'button', tabindex: '-1' },
            el('span', { class: 'dash-pop-txt' }, el('span', { class: 'dash-pop-name' },
              ctx.favLists.has(Number(l.id)) ? el('span', { class: 'dash-pop-fav', title: '즐겨찾기', text: '⭐ ' }) : null, l.name || '(이름 없음)')),
            on ? el('span', { class: 'dash-addpop-badge', text: '표시 중' }) : el('span', { class: 'dash-addpop-badge is-add', text: '＋ 불러오기' }));
          const run = () => (on ? (() => { ctx.selectedListId = Number(l.id); done(); ctx.draw(); })() : pick(l));
          row.addEventListener('mousedown', (e: any) => e.preventDefault()); // blur 로 입력이 접히기 전에 클릭이 먹게
          row.addEventListener('click', run);
          opts.push({ el: row, run });
          rows.push(row);
        }
      } else if (q) {
        rows.push(el('div', { class: 'dash-pop-row', style: 'cursor:default' }, el('span', { class: 'dash-pop-desc', text: '같은 이름의 리스트가 없어요.' })));
      } else {
        rows.push(el('div', { class: 'dash-pop-row', style: 'cursor:default' }, el('span', { class: 'dash-pop-desc', text: '이름을 입력하면 이미 있는 리스트를 찾아드려요.' })));
      }
      // 맨 아래 = 새로 만들기(Enter 기본 동작). 이름이 없으면 팝업이 빈 이름으로 열린다(거기서 입력해도 된다).
      const mk = el('div', { class: 'dash-pop-row dash-addpop-row dash-addpop-create', role: 'button', tabindex: '-1' },
        el('span', { class: 'dash-pop-txt' },
          el('span', { class: 'dash-pop-name', text: q ? '＋ ‘' + (input.value || '').trim() + '’ 새로 만들기' : '＋ 새 리스트 만들기' }),
          el('span', { class: 'dash-pop-desc', text: '스페이스·폴더를 고르는 설정 창이 열려요' })));
      mk.addEventListener('mousedown', (e: any) => e.preventDefault());
      mk.addEventListener('click', create);
      opts.push({ el: mk, run: create });
      rows.push(el('div', { class: 'dash-addpop-sep' }), mk);
      panel.replaceChildren(...rows);
    };
    const setActive = (i) => {
      active = i;
      opts.forEach((o, k) => o.el.classList.toggle('active', k === i));
      if (i >= 0) opts[i].el.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', renderSug);
    input.addEventListener('keydown', (e: any) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1 >= opts.length ? 0 : active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1 < 0 ? opts.length - 1 : active - 1); }
      // Enter — 활성 제안이 있으면 그것, 없으면 새로 만들기(요청대로 '엔터 = 어디로 보낼지 고르는 팝업').
      else if (e.key === 'Enter' && !e.isComposing && (e as any).keyCode !== 229) {
        e.preventDefault();
        if (active >= 0 && opts[active]) opts[active].run(); else create();
      } else if (e.key === 'Escape') { e.preventDefault(); done(); }
    });
    // 팝오버 안을 누를 땐 mousedown 을 막아 두었으므로 여기로 오지 않는다(진짜 바깥 클릭일 때만 접힘).
    input.addEventListener('blur', () => { setTimeout(() => { if (!card.contains(document.activeElement)) done(); }, 0); });
    card.replaceChildren(input); input.focus();
    renderSug();
  };
  card.addEventListener('click', (e: any) => { if (e.target.closest('input')) return; showInput(); });
  card.addEventListener('keydown', (e: any) => { if ((e.key === 'Enter' || e.key === ' ') && !card.querySelector('input')) { e.preventDefault(); showInput(); } });
  showBtn();
  return card;
}

// 지금 요약 카드에 떠 있는 리스트가 들어 있는 폴더는 처음부터 펼쳐 둔다 — 내 리스트가 접힌 폴더에 숨지 않게.
//  팝오버를 처음 그릴 때 1회만(그 시점엔 draw() 가 끝나 autoIds 가 채워져 있다). 이후 펼침은 사람이 정한 대로 둔다.
function projSeedOvOpen(ctx: ProjCtx) {
  const parentOf = new Map<number, any>(ctx.folders.map((f) => [Number(f.id), f.parent_id]));
  const shownIds = new Set<number>([...ctx.autoIds, ...dashOvPinned()]);
  for (const l of ctx.lists) {
    if (l.folder_id == null || !shownIds.has(Number(l.id))) continue;
    let fid: any = Number(l.folder_id);
    for (let i = 0; fid != null && i < 20; i++) { ctx.ovOpen.add(Number(fid)); fid = parentOf.get(Number(fid)); }
  }
}

// 헤더 ⚙ — 내 프로젝트 위젯 개인화 팝오버(#req): 태스크 수 표시 · 기본 필터 · 빈 리스트 숨김 · 개요 카드 표시/숨김.
function projOpenOvPrefs(ctx: ProjCtx, anchor) {
  const panel = el('div', { class: 'dash-pop-panel' });
  panel.append(el('div', { class: 'dash-pop-head' },
    el('strong', { text: '내 프로젝트 설정' }),
    el('span', { class: 'dash-pop-sub', text: '이 기기에 저장돼요' })));
  // 세그먼트(라디오) 한 줄 — 선택 시 저장·재렌더·팝오버 갱신.
  const seg = (title, options, cur, onPick) => {
    panel.append(el('div', { class: 'dash-pop-gh', text: title }));
    const rowEl = el('div', { class: 'dash-pop-seg' });
    for (const [k, label] of options) {
      const b = el('button', { class: 'dash-pop-segbtn' + (k === cur ? ' on' : ''), type: 'button', text: label });
      b.onclick = () => { onPick(k); ctx.draw(); projOpenOvPrefs(ctx, anchor); };
      rowEl.append(b);
    }
    panel.append(rowEl);
  };
  seg('태스크 수 표시', [['active', '진행 중만'], ['all', '전체'], ['progress', '완료·전체']], dashTaskCountMode(), (k) => dashSaveTaskCountMode(k));
  seg('기본 상태 필터', [['active', '진행 중'], ['all', '전체']], dashProjFilterDefault(), (k) => { dashSaveProjFilterDefault(k); ctx.mode = k; });
  // #req 요약 카드에 올릴 리스트는 **조직의 모든 리스트**에서 고른다 — 다만 평면 목록이면 너무 많으므로,
  //  우리가 실제로 리스트를 정리하는 방식 그대로 **스페이스 › 폴더 › 리스트** 트리로 훑고, 검색으로 바로 찾는다.
  panel.append(el('div', { class: 'dash-pop-gh', text: '위에 요약 카드로 표시할 리스트' }));
  const search = el('input', { class: 'dash-pop-search', type: 'text', placeholder: '리스트·폴더 검색…', 'aria-label': '리스트·폴더 검색' });
  const rowsWrap = el('div', { class: 'dash-pop-listrows dash-pop-tree' });
  panel.append(search, rowsWrap);
  const footEl = el('div', { class: 'dash-pop-foot' });
  panel.append(footEl);

  const renderTree = () => {
    if (ctx.foldersLoaded && !ctx.ovSeeded) { ctx.ovSeeded = true; projSeedOvOpen(ctx); }
    const q = (search.value || '').trim().toLowerCase();
    const hidden = dashOvHidden(); const pinned = dashOvPinned();
    // 지금 요약 카드에 떠 있는지 = (자동 후보 | 직접 고름 | 방금 만듦) 이면서 숨기지 않음.
    const isOn = (id) => !hidden.has(Number(id)) && (ctx.autoIds.has(Number(id)) || pinned.has(Number(id)) || ctx.justCreated.has(Number(id)));
    const hit = (s) => !q || String(s || '').toLowerCase().includes(q);
    // 폴더 트리 인덱스 — 부모별 하위 폴더 · 폴더별 리스트 · 폴더 밖 리스트.
    const byParent = new Map<any, any[]>(); const byFolder = new Map<number, any[]>(); const looseLists: any[] = [];
    for (const f of ctx.folders) { const k = f.parent_id ?? null; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k)!.push(f); }
    for (const l of ctx.lists) {
      if (l.folder_id == null) { looseLists.push(l); continue; }
      const k = Number(l.folder_id); if (!byFolder.has(k)) byFolder.set(k, []); byFolder.get(k)!.push(l);
    }
    // 즐겨찾기(⭐) 먼저 — 같은 폴더 안에서만 끌어올린다(폴더 구조는 그대로 유지).
    const byFav = (a, b) => (ctx.favLists.has(Number(b.id)) ? 1 : 0) - (ctx.favLists.has(Number(a.id)) ? 1 : 0);
    const listRow = (l, depth) => {
      const id = Number(l.id);
      const cb: any = el('input', { type: 'checkbox' }); cb.checked = isOn(id);
      cb.onchange = () => { ctx.setListShown(id, cb.checked); ctx.draw(); renderTree(); };
      const nm = el('span', { class: 'dash-pop-name' },
        ctx.favLists.has(id) ? el('span', { class: 'dash-pop-fav', title: '즐겨찾기', text: '⭐ ' }) : null, l.name || '(이름 없음)');
      return el('label', { class: 'dash-pop-row dash-pop-lrow', style: 'padding-left:' + (8 + depth * 15) + 'px' },
        cb, el('span', { class: 'dash-pop-txt' }, nm));
    };
    // 폴더 서브트리 렌더 — 보일 리스트가 하나도 없으면 통째로 생략(빈 폴더로 트리를 채우지 않는다).
    //  forced = 상위 폴더 이름이 검색어에 걸림 → 그 아래는 전부 보여준다.
    const folderNode = (f, depth, forced) => {
      const all = forced || hit(f.name);
      const subs = (byParent.get(f.id) || []).slice().sort((a, b) => (pjvFolderIsArchive(a) ? 1 : 0) - (pjvFolderIsArchive(b) ? 1 : 0));
      const kidNodes = subs.map((c) => folderNode(c, depth + 1, all)).filter(Boolean) as any[];
      const own = (byFolder.get(Number(f.id)) || []).filter((l) => all || hit(l.name)).sort(byFav);
      if (!kidNodes.length && !own.length) return null;
      const total = own.length + kidNodes.reduce((n, k) => n + k.total, 0);
      const on = own.filter((l) => isOn(l.id)).length + kidNodes.reduce((n, k) => n + k.on, 0);
      // 검색 중에는 강제로 펼친다(찾은 결과가 접힌 폴더에 숨지 않게).
      const opened = !!q || ctx.ovOpen.has(Number(f.id));
      const isSpace = pjvFolderIsSpace(f);
      const car = el('span', { class: 'dash-pop-caret', text: opened ? '▾' : '▸', 'aria-hidden': 'true' });
      const icon = isSpace
        ? el('span', { class: 'pjv-side-space-avatar dash-pop-spaceav', text: (String(f.name || 'S').trim()[0] || 'S').toUpperCase(), style: 'background:' + (f.color || avatarColor('space' + f.id)) })
        : el('span', { class: 'dash-pop-foldico' }, dashFolderThumb());
      const head = el('div', { class: 'dash-pop-row dash-pop-frow' + (isSpace ? ' is-space' : ''), role: 'button', tabindex: '0',
        style: 'padding-left:' + (8 + depth * 15) + 'px' },
        car, icon, el('span', { class: 'dash-pop-txt' }, el('span', { class: 'dash-pop-name', text: f.name || '(이름 없음)' })),
        el('span', { class: 'dash-pop-fcount', text: on + '/' + total }));
      const toggle = () => { if (q) return; if (ctx.ovOpen.has(Number(f.id))) ctx.ovOpen.delete(Number(f.id)); else ctx.ovOpen.add(Number(f.id)); renderTree(); };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      const nodes: any[] = [head];
      if (opened) { for (const l of own) nodes.push(listRow(l, depth + 1)); for (const k of kidNodes) nodes.push(...k.nodes); }
      return { nodes, total, on };
    };

    rowsWrap.replaceChildren();
    if (!ctx.foldersLoaded) { rowsWrap.append(el('div', { class: 'dash-pop-row', style: 'cursor:default' }, el('span', { class: 'dash-pop-desc', text: '불러오는 중…' }))); return; }
    const out: any[] = [];
    // 최상위 = 스페이스(+ 스페이스가 아닌 최상위 폴더도 그대로). 아카이브는 맨 뒤.
    const roots = (byParent.get(null) || []).slice().sort((a, b) => (pjvFolderIsArchive(a) ? 1 : 0) - (pjvFolderIsArchive(b) ? 1 : 0));
    for (const r of roots) { const n = folderNode(r, 0, false); if (n) out.push(...n.nodes); }
    // 폴더에 안 들어간 리스트 + 미분류(리스트 없는 내 프로젝트) — 트리 맨 아래 평평하게.
    const loose = looseLists.filter((l) => hit(l.name)).sort(byFav);
    if (loose.length) {
      out.push(el('div', { class: 'dash-pop-gh dash-pop-treegh', text: '폴더에 없는 리스트' }));
      for (const l of loose) out.push(listRow(l, 0));
    }
    if (ctx.currentOrder.some((id) => Number(id) === 0) && hit('미분류')) {
      const cb: any = el('input', { type: 'checkbox' }); cb.checked = isOn(0);
      cb.onchange = () => { ctx.setListShown(0, cb.checked); ctx.draw(); renderTree(); };
      out.push(el('label', { class: 'dash-pop-row dash-pop-lrow', style: 'padding-left:8px' },
        cb, el('span', { class: 'dash-pop-txt' }, el('span', { class: 'dash-pop-name', text: '미분류' }))));
    }
    if (!out.length) { rowsWrap.append(el('div', { class: 'dash-pop-row', style: 'cursor:default' }, el('span', { class: 'dash-pop-desc', text: q ? '검색 결과가 없어요.' : '리스트가 없어요.' }))); }
    else rowsWrap.append(...out);

    // 푸터 — 숨긴 카드 되돌리기 / 직접 고른 리스트 일괄 해제.
    footEl.replaceChildren();
    if (hidden.size) {
      const b = el('button', { class: 'dash-pop-reset', type: 'button', text: '숨긴 카드 모두 표시' });
      b.onclick = () => { dashSaveOvHidden(new Set()); ctx.draw(); renderTree(); };
      footEl.append(b);
    }
    if (pinned.size) {
      const b = el('button', { class: 'dash-pop-reset', type: 'button', text: '직접 고른 ' + pinned.size + '개 빼기' });
      b.onclick = () => { dashSaveOvPinned(new Set()); ctx.draw(); renderTree(); };
      footEl.append(b);
    }
  };
  search.addEventListener('input', renderTree);
  renderTree();
  // 폴더가 아직 안 왔으면 도착 후 다시 그린다(팝오버는 열린 채로).
  if (!ctx.foldersLoaded) ctx.foldersP.then(() => { ctx.foldersLoaded = true; if (rowsWrap.isConnected) renderTree(); });
  dashPopover(anchor, panel);
}

export { projOpenListFilter, projListAddCard, projSeedOvOpen, projOpenOvPrefs };
