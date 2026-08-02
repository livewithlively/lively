// projects/filters.ts — #1313 R32: web/projects.ts 분해 ③ (필터 모델 · 툴바 팝오버 · 뷰 탭).
//  조건행 모델(PJV_FILTER_FIELDS/OPS · pjvFilterState) · 담당자 빠른필터 · Me mode · 뷰 내 검색을
//  한 술어(pjvApplyToolbarFilters)로 합치고, 그 위에 툴바 팝오버 5종과 뷰 탭 줄을 얹는다.
//  ⚠ pjvFilterUniverse(필터 값 후보)는 모듈 전역 mutable — 밖에서 재할당하지 말고 **pjvSetFilterUniverse 세터**로만 바꾼다
//   (ESM import 바인딩은 재할당 불가. 호출부는 보드 렌더 2곳 — 스코프 보드 · 전체 보드).
//  ⚠ 보기 상태(pjvBoardView·pjvSidebarSel·pjvClosedView 등)의 소유는 projects/state.js(#1313 R31) — 여기선 그 객체를
//   직접 import 해 읽고 프로퍼티만 바꾼다(재할당 아님). 배럴(projects.ts)을 거치지 않으므로 역방향 엣지가 생기지 않는다.
// ⚠ 저장뷰 메뉴·설정 스위치 행 — 소유는 #1313 R36 이후 projects/board.ts 이고 여기선 **배럴 경유**로 받는다
//  (직결로 바꾸면 filters↔board 로 경로가 곱해져 순환이 늘어난다 — check-imports.mjs 주석의 실측 참조).
//  filters→projects 역방향 엣지의 유일한 잔여 사유다.
import { el, toast } from '../core.js';
import { pjvPopover } from './popover.js';
import { pjvTabIcon, pjvTbIcon } from './icons.js';
import { pjvCustomColsSection, pjvDefaultColsSection } from './columns.js';
import { pjvBoardMineOnly, pjvBoardView, pjvClosedView, pjvExitAreaMode, pjvKeepScopeOnCollapse, pjvPersistSideOpen, pjvProjClosedView, pjvSavedView, pjvScopeIsFolder, pjvSidebarSel } from './state.js';
import { pjvTlClearTasks } from './timeline.js';   // #1313 R33 — 타임라인 캐시는 timeline.ts 소유(적출 완료). 배럴 우회 = 역방향 엣지 아님
import { pjvSavedViewMenu, pjvSwitchRow } from '../projects.js';
import { pjvMeMode } from './filters-state.js';

// ── 'Me mode' 팝오버(#1067) — 내 아바타를 누르면 뜬다. ClickUp 은 Comments/Subtasks/Checklists 지만
//  우리 보드의 단위는 프로젝트와 태스크라 그 둘로 옮겼다(없는 개념을 흉내내면 눌러도 아무 일이 안 생긴다).
function pjvMeModePopover(anchor, onChange) {
  const pop = el('div', { class: 'pjv-menu pjv-closed-pop' });
  pjvPopover(anchor, pop, { align: 'right' });
  pop.append(el('div', { class: 'pjv-closed-pop-head', text: '내가 맡은 것만 보기' }));
  pop.append(pjvSwitchRow('프로젝트', () => pjvBoardMineOnly.on, (v) => { pjvBoardMineOnly.on = v; }, onChange));
  pop.append(pjvSwitchRow('태스크', () => pjvMeMode.tasks, (v) => { pjvMeMode.tasks = v; }, onChange));
  pop.append(el('div', { class: 'pjv-menu-hint', text: '프로젝트 = 내가 만들었거나 팀원인 것 · 태스크 = 내가 담당인 것' }));
}

// ── '완료 표시' 팝오버 — 프로젝트/태스크 각각의 닫힌 항목 노출 스위치(ClickUp Tasks·Subtasks 파리티). ──
function pjvClosedPopover(anchor, onChange) {
  const pop = el('div', { class: 'pjv-menu pjv-closed-pop' });
  pjvPopover(anchor, pop, { align: 'right' });
  pop.append(el('div', { class: 'pjv-closed-pop-head', text: '완료된 항목 표시' }));
  pop.append(pjvSwitchRow('프로젝트', () => pjvProjClosedView.done, (v) => { pjvProjClosedView.done = v; }, onChange));
  pop.append(pjvSwitchRow('태스크', () => pjvClosedView.tasks, (v) => { pjvClosedView.tasks = v; pjvClosedView.subtasks = v; }, onChange));
}

// ── '컬럼' 팝오버 — 기본 컬럼/커스텀 필드 표시·숨김(기존 Fields 패널 섹션 재사용). ──
function pjvColumnsPopover(anchor, card, reload) {
  const pop = el('div', { class: 'pjv-menu pjv-cols-pop' });
  pjvPopover(anchor, pop, { align: 'right' });
  pop.append(el('div', { class: 'pjv-closed-pop-head', text: '컬럼' }));
  pop.append(pjvDefaultColsSection('proj', card));
  const custom = pjvCustomColsSection(card, reload);
  if (custom) pop.append(custom);
}

// ── '설정'(톱니) 팝오버 — 보기 방식 · 열 정렬 · 저장된 뷰 · 사이드바. 툴바에서 뺀 옵션들의 집(누락 없음). ──
function pjvBoardSettingsPopover(anchor, ctx) {
  const pop = el('div', { class: 'pjv-menu pjv-set-pop' });
  const close = pjvPopover(anchor, pop, { align: 'right' });
  pop.append(el('div', { class: 'pjv-closed-pop-head', text: '보기 설정' }));
  // 보기 방식(상태/리스트/칸반) — 라디오. 예전 '필터' 버튼이 품고 있던 것.
  pop.append(el('div', { class: 'pjv-set-sec', text: '보기 방식' }));
  //  뷰 탭(테이블·타임라인)에 있을 땐 여기 라디오 넷 중 어느 것도 켜지 않는다 — 켜면 실제 화면과 다른 걸 가리킨다.
  const curMode = () => pjvBoardView.table ? 'table' : pjvBoardView.timeline ? 'timeline'
    : pjvBoardView.overview ? 'overview' : pjvBoardView.kanban ? 'kanban' : pjvBoardView.byFolder ? 'list' : 'status';
  const syncs: any[] = [];
  const mkMode = (key, label, hint) => {
    const radio = el('span', { class: 'pjv-view-radio', 'aria-hidden': 'true' });
    const item = el('button', { class: 'pjv-menu-item pjv-view-item', type: 'button', role: 'menuitemradio' },
      el('span', { class: 'pjv-view-item-main' }, el('span', { class: 'pjv-view-item-label', text: label }), el('span', { class: 'pjv-view-item-hint', text: hint })), radio);
    const sync = () => { const on = curMode() === key; item.classList.toggle('on', on); item.setAttribute('aria-checked', String(on)); };
    item.onclick = (e) => {
      e.stopPropagation();
      if (curMode() === key) return;
      pjvBoardView.kanban = key === 'kanban';
      pjvBoardView.table = false; pjvBoardView.timeline = false; // 보기 방식은 뷰 탭과 상호배타(#1067)
      pjvBoardView.byFolder = key === 'list';
      pjvBoardView.byStatus = key === 'status' || key === 'list';
      pjvBoardView.overview = key === 'overview';
      if (key === 'list' && !pjvBoardView.byArea) { pjvSidebarSel.key = '__all__'; pjvSidebarSel.explicit = false; pjvExitAreaMode(); pjvPersistSideOpen(); }
      syncs.forEach((s) => s());
      ctx.onView();
    };
    syncs.push(sync);
    pop.append(item);
  };
  mkMode('status', '그룹으로 나누기', '툴바의 그룹 기준(기본: 상태)으로');
  mkMode('list', '리스트로 나누기', '리스트마다 박스 하나로');
  mkMode('kanban', '칸반 보드', '상태별 컬럼에 카드로 (드래그로 상태 변경)');
  // 개요 — 폴더/스페이스에서 하위 폴더·리스트를 요약 카드로. 예전 폴더 기본 뷰(#1067 에서 기본 자리는 리스트 박스에 내줌).
  if (pjvScopeIsFolder(pjvSidebarSel.key)) mkMode('overview', '개요', '하위 폴더·리스트를 요약 카드로');
  syncs.forEach((s) => s());
  // 열 정렬 — 값·헤더 가로 정렬(순수 CSS, 재렌더 없음).
  pop.append(el('div', { class: 'pjv-set-sec', text: '표' }));
  pop.append(pjvSwitchRow('값을 왼쪽 정렬', () => ctx.isAlignLeft(), (v) => ctx.setAlignLeft(v), () => { /* 즉시 CSS 반영 */ }));
  pop.append(pjvSwitchRow('사이드바 표시', () => pjvBoardView.byArea, (v) => {
    pjvBoardView.byArea = v;
    if (v) pjvBoardView.byFolder = false; else pjvKeepScopeOnCollapse();
    pjvPersistSideOpen();
  }, () => ctx.onView()));
  // 저장된 뷰(ClickUp 이관) — 별도 팝오버로 진입.
  const sv2 = el('button', { class: 'pjv-menu-item', type: 'button' },
    el('span', { text: '저장된 뷰' + (pjvSavedView.id != null && pjvSavedView.name ? ' · ' + pjvSavedView.name : '') }),
    el('span', { class: 'pjv-menu-caret', text: '›' }));
  sv2.onclick = (e) => { e.stopPropagation(); close(); pjvSavedViewMenu(anchor, ctx.onView); };
  pop.append(el('div', { class: 'pjv-set-sec', text: '뷰' }), sv2);
}

// ── 뷰 탭 줄(#1067) — 보드·타임라인·테이블·리스트 + ＋뷰. ──
//  보드/리스트는 이미 있는 렌더에 연결(칸반 #541 / 상태그룹). 테이블·타임라인은 아직 없어 준비 중 토스트.
//  ⚠ 설정(톱니) 팝오버의 '보기 방식' 라디오와 **같은 상태**(pjvBoardView)를 본다 — 두 곳이 항상 일치해야 한다.
const PJV_VIEW_TABS = [
  { key: 'list', label: '리스트' },
  { key: 'board', label: '보드' },
  { key: 'table', label: '테이블' },
  { key: 'timeline', label: '타임라인' },
];

// 현재 보기 → 탭 키. 칸반=보드 / 표=테이블 / 타임라인 / 나머지(상태그룹·리스트박스·개요)는 리스트 계열.
function pjvCurrentViewTab() {
  if (pjvBoardView.kanban) return 'board';
  if (pjvBoardView.table) return 'table';
  if (pjvBoardView.timeline) return 'timeline';
  return 'list';
}

// 탭 하나만 켜고 나머지 보기 플래그는 끈다(상호배타).
function pjvSetViewTab(key) {
  // 타임라인에 **들어올 때마다** 하위 작업 캐시를 비운다(#1305) — 다른 뷰에서 태스크를 고치고 돌아와도 신선하게.
  if (key === 'timeline' && !pjvBoardView.timeline) pjvTlClearTasks();
  pjvBoardView.kanban = key === 'board';
  pjvBoardView.table = key === 'table';
  pjvBoardView.timeline = key === 'timeline';
  if (key !== 'list') { pjvBoardView.overview = false; return; }
  pjvBoardView.overview = false;
  if (!pjvBoardView.byFolder) pjvBoardView.byStatus = true;
}

// ctx.onView() = 뷰 전환 후 재렌더(스코프별 뷰 영속 포함). 없으면 탭은 표시 전용.
function pjvViewTabsRow(ctx?) {
  const row = el('div', { class: 'pjv-vtabs', role: 'tablist', 'aria-label': '뷰' });
  const syncs: any[] = [];
  for (const t of PJV_VIEW_TABS) {
    const b = el('button', { class: 'pjv-vtab', type: 'button', role: 'tab' },
      pjvTabIcon(t.key), el('span', { class: 'pjv-vtab-label', text: t.label }));
    const sync = () => {
      const on = pjvCurrentViewTab() === t.key;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    };
    syncs.push(sync);
    b.onclick = (e) => {
      e.stopPropagation();
      if (pjvCurrentViewTab() === t.key) return;
      pjvSetViewTab(t.key);
      syncs.forEach((s) => s());
      if (ctx && ctx.onView) ctx.onView();
    };
    row.append(b);
  }
  const add = el('button', { class: 'pjv-vtab pjv-vtab-add', type: 'button', title: '뷰 추가' }, pjvTbIcon('plus', 'sm'), el('span', { class: 'pjv-vtab-label', text: '뷰' }));
  add.onclick = (e) => { e.stopPropagation(); toast('뷰 추가는 준비 중이에요'); };
  row.append(el('span', { class: 'pjv-vtab-sep' }), add);
  syncs.forEach((s) => s());
  // render() 가 뷰를 바꿔도 탭이 따라오게 — 헤더는 한 번만 만들어지므로 sync 를 걸어둔다.
  (row as any)._sync = () => syncs.forEach((s) => s());
  return row;
}


export {
  pjvBoardSettingsPopover,
  pjvClosedPopover,
  pjvColumnsPopover,
  pjvMeModePopover,
  pjvViewTabsRow,
};
export { pjvApplyToolbarFilters, pjvAsgFilter, pjvBoardSearch, pjvFilterCount, pjvMeMode, pjvMeModeOn, pjvSetFilterUniverse, pjvTaskIsMine } from './filters-state.js';
export { pjvAssigneePopover, pjvFilterPopover } from './filters-popover.js';
