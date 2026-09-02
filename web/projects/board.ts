// projects/board.ts — #1313 R36: web/projects.ts 분해 ⑦(캠페인 최종) — 프로젝트 보드 조립부.
//  #/projects2 라우터 진입(renderProjectsV2)부터 스코프/전체 보드(renderProjectV2Board) · 칸반(pjvKanbanBoard) ·
//  리스트 보드 대형 클로저(pjvProjectListBoard — 사이드바 트리 조립 buildTree +
//  본문 영역 렌더 renderArea + 3층 헤더)까지 '화면 한 장을 조립하는' 층 전부. 12,607줄 projects.ts 의 마지막 덩어리다.
//  ⚠ 레지스트리·상태 세터를 호출하는 **유일한 자리**다 — pjvSidePrefsEnsure · setBoardFieldsCur · setFavListCache ·
//   pjvSetStatusRegistry · pjvSetListRegistry · pjvSetFilterUniverse · setSortCtx · setGroupCtx · consumeKeepScroll.
//   ESM import 바인딩은 재할당할 수 없으므로 각 상태의 소유 모듈이 낸 세터로만 바꾼다(#1313 R31 규약).
//   호출의 **위치와 횟수**가 곧 동작이다(보드 렌더 진입마다 1회) — 옮기거나 합치지 말 것.
//  ⚠ 표시모드 메뉴 3종·팀원 저장·커스텀 상태 저장은 이 모듈이 **단독 소유**한다.
//   projects/{rows,selection,detail-*}.ts 는 이들을 배럴(../projects.js) 경유로 받는다 —
//   소비자 import 무변경이 이 캠페인의 계약이고, 직결 전환은 실측상 순환을 되레 늘린다(834건, check-imports 주석 참조).
//   반대로 **읽는 쪽이 하나뿐이던** pjvBoardFieldsCur·pjvHeadSortable 은 그 소비자(projects/columns.ts)로 내려보냈다
//   — 배럴을 되짚을 이유 자체를 없앤 것이라 순환이 117→60 으로 줄었다.
//   #1404 는 같은 판정을 이어 저장뷰 메뉴를 filters 로, 스위치 행을 popover 리프로, 드래그 싱글턴 둘을 state
//   리프로 내려보냈다(60→48). 읽는 쪽이 여럿이어도 **값이 리프의 것이면** 내려보낼 수 있다는 게 이때 추가된 판정이다.
//  ※ 이 파일은 web/projects.ts 를 import 하지 않는다(단방향). 배럴은 이제 재수출만 하는 통로다.
// ════════════════════════════════════════════════════════════════════════════
// 프로젝트 보드 상단 헤더(#1067) — ClickUp 파리티 3층 구조.
//   ① 브레드크럼   스페이스 › 폴더 › 리스트  + ⌄(설정 메뉴) + ☆(즐겨찾기)
//   ② 뷰 탭        보드 · 타임라인 · 테이블 · 리스트 · ＋뷰   (지금은 버튼·아이콘만 — 기능은 별도 작업)
//   ③ 툴바         좌: 그룹 · 하위태스크 · 컬럼   /   우: 필터 · 완료 · 담당자 · 나 · 검색 | 설정 · ＋프로젝트
//  예전엔 이 셋이 한 줄에 뒤섞여(제목 + 사이드바 + 스코프칩 + 필터 + 뷰 + 그룹 + 하위 + 정렬 + 내할당 + Closed)
//  '무엇이 위치이고 무엇이 보기 옵션인지' 구분이 안 됐다. 층을 나눠 위치(①)/보기(②)/데이터 좁히기(③)로 분리.
//  아이콘은 우리 톤(단색 라인 · currentColor · 컬러 이모지 금지)으로 직접 제작 — 형태만 ClickUp 과 맞춘다.
//  ②뷰 탭·③툴바의 실체(필터 엔진 · 팝오버 5종 · 뷰 탭 줄)는 web/projects/filters.ts 로 나갔다(#1313 R32).
//  이 파일에는 ①브레드크럼과 세 층을 조립하는 보드 렌더(pjvProjectListBoard)가 남는다.
// ════════════════════════════════════════════════════════════════════════════
import { api, el, errorNote, keepSideScroll, personFace, state, sv, toast } from '../core.js';
import { skeleton } from '../learn.js';
import { pjvPopover, pjvSwitchRow } from './popover.js';
import { pjvBundleIcon, pjvSideSearchIcon, pjvTbIcon, pjvViewIcon } from './icons.js';
import { avatarColor } from './files.js';
// ⚠ 보기 상태 싱글턴은 projects/state.ts 소유(#1313 R31) — 여기선 읽고 프로퍼티만 바꾸며, 통째 교체는 세터 경유.
import { consumeKeepScroll, pjvApplyView, pjvBoardMineOnly, pjvBoardView, pjvClosedView, pjvDefaultView, pjvExitAreaMode, pjvFolderDrag, pjvGroupCtx, pjvIsFolderOpen, pjvKeepScopeOnCollapse, pjvKnownFolderIds, pjvListOpen, pjvLoadScopeView, pjvPersistSideOpen, pjvProjClosedView, pjvProjTaskMode, pjvReloadKeepScroll, pjvRestoreScroll, pjvSaveScopeView, pjvSavedView, pjvScopeIsFolder, pjvScopeKept, pjvSetFolderOpen, pjvSideDrag, pjvSidePrefsEnsure, pjvSidebarSel, pjvSnapshotView, pjvSubtaskMode, pjvSyncUrl, setGroupCtx, setSortCtx } from './state.js';
import { PJV_DEFAULT_STATUS_DEFS, PJV_PRIORITY, pjvFmtDate, pjvIsOverdue, pjvListIsCustomStatus, pjvListStatusDefs, pjvLoadStatusTemplates, pjvNativeStatusOf, pjvResolveProjStatus, pjvSetStatusRegistry, pjvStatusIcon, pjvStatusIconStd } from './status.js';
import { pjvAssignees } from './task-controls.js';
import { PJV_STD_COLS, PJV_STD_COL_VAR, PJV_STD_COL_W, pjvApplyColOrder, pjvApplyColWidths, pjvApplyHiddenCols, pjvFieldsForList, pjvGetColSort, pjvGetShownCols, pjvInitNameResize, pjvNameResizeHandle, pjvProjGridTemplate, pjvSetListRegistry, pjvStdColHead, pjvWireColReorder, setBoardFieldsCur } from './columns.js';
import { pjvAddColumnButton, pjvColumnHead } from './fields.js';
import { pjvApplyToolbarFilters, pjvAsgFilter, pjvAssigneePopover, pjvBoardSearch, pjvBoardSettingsPopover, pjvClosedPopover, pjvColumnsPopover, pjvFilterCount, pjvFilterPopover, pjvMeModeOn, pjvMeModePopover, pjvSavedViewMenu, pjvSetFilterUniverse, pjvViewTabsRow } from './filters.js';
import { pjvSelReset } from './selection.js';
import { PJV_GROUPBY_FIELDS, pjvColSortCmp, pjvContainerCmp, pjvGetAlsoList, pjvGetGroupBy, pjvManualCmp, pjvProjAddRow, pjvProjRow, pjvRenderStatusGroups, pjvSetAlsoList, pjvSetGroupBy } from './rows.js';
import { pjvTableDefaultCmp, pjvTimelineView } from './timeline.js';
import { openFolderForm, openListForm, pjvFolderIsArchive, pjvFolderIsSpace } from './list-forms.js';
import { PJV_ARCHIVE_FOLDER_NAME, pjvArchiveDropTarget, pjvArchiveFolderIds, pjvBuildListGroups, pjvFavSecOpen, pjvFindArchiveFolder, pjvFolderDropTarget, pjvFolderTreeMenu, pjvListGlyph, pjvListGroup, pjvListSettingsMenu, pjvMoveFolderToParent, pjvMoveListToFolder, pjvMoveNear, pjvReorderFolders, pjvReorderLists, pjvSetFavSecOpen, pjvSetFavorite, pjvSideIndent, pjvSideNavDrop, pjvTrashDropTarget, pjvVisLock, setFavListCache } from './sidebar.js';
import { openProjectV2Form } from './project-form.js';

// ════════════════════════════════════════════
// 프로젝트(v2) #/projects2 — 맥락 = 카테고리 + 지식 + 프로젝트 중 '프로젝트'(= 맥락의 *변화*).
//  지식 탭과 대칭인 하위 탭: [대시보드 · 작업 현황 · 사업 · 제품 · 시스템].
//   · 대시보드 = 프로젝트 보드(level='project' 카드, 진행중/완료)
//   · 작업 현황 = 기존 #/dash(사람×AI 작업현황)를 하위 탭으로 흡수(dashboard.ts 의 activityTimelineRow 재사용)
//  데이터: GET /api/ui/v6/projects(보드 목록)·/:id(상세) + POST .../status,/tasks,/members,/category,/knowledge,
//   POST /api/ui/v6/tasks/:id/status, GET /api/ui/categories(사이드바). (백엔드 projects-v6 — 이미 구현됨.)
// ════════════════════════════════════════════

// 프로젝트 하위 탭 바(대시보드·탐색) 폐지 — 별도 페이지로 존재할 이유가 없어 제거. 프로젝트 탭 = 보드 하나만
//  (클릭 = 프로젝트 보드로 바로). '탐색'(지식·프로젝트·자료 둘러보기)은 제거, '작업 로그'는 이미 터미널로 이관(#609).

// 프로젝트 탭 공통 페이지 헤더 — 상단 헤더 줄 폐지(#670): 제목·부제는 이미 없었고, 남아있던 🗑 휴지통도
//  사이드바 맨 아래 폴더형 항목으로 내렸다(상단에 통째로 비던 한 줄·여백 제거). → 헤드 없음(null).
function projectPageHead() {
  return null;
}

// 프로젝트(v2) 진입 — 하위 탭(탐색) 폐지: 상세(p) 외 모든 진입은 프로젝트 보드로. 옛 worklog→터미널(#609) 유지, 옛 browse URL 도 보드로 흡수.
async function renderProjectsV2(view, sub, _params, scopeKey?) {
  if (sub === 'worklog') { location.replace('#/terminal'); return; } // 작업 로그 이관(#609) — 옛 링크/북마크는 터미널로
  return renderProjectV2Board(view, scopeKey);
}

// 대시보드 — 프로젝트 보드(level='project'). 진행 중/완료 두 섹션 + [+ 새 프로젝트] + [선택→일괄삭제].
//  선택 모드: 내가 만든(created_by==나) 프로젝트만 체크 가능 — 진행 중·완료에 걸쳐 여러 개를 골라 한 번에 삭제.
// 대시보드 — 프로젝트 보드(level='project'), **리스트로 1차 그룹핑**(클릭업 List▸Task). 내가 참여한 리스트는 펼침,
//  그 외 리스트는 접힘(기본), 미분류는 '기타'로. 상태(할 일/진행 중/완료)는 각 행의 동그라미 + 헤더 Closed 토글로 표현.
//  '내 할당만' 토글 = 내가 만든/팀원인 프로젝트만(서버 mine=1 집합). 회사 전체 타임라인은 아래 그대로.
function pjvSavedSortCmp() {
  const s = pjvSavedView.sort;
  if (!s) return null;
  const dir = s.dir === -1 ? -1 : 1;
  const prioRank = { urgent: 0, high: 1, normal: 2, low: 3 };
  const val = (p) => {
    switch (s.field) {
      case 'due_date': return p.due_date || '9999-99-99';
      case 'start_date': return p.start_date || '9999-99-99';
      case 'priority': return p.priority in prioRank ? prioRank[p.priority] : 9;
      case 'name': return String(p.name || '').toLowerCase();
      case 'created_at': return p.created_at || '';
      case 'updated_at': return p.updated_at || '';
      default: return 0;
    }
  };
  return (a, b) => { const x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; };
}
// (저장뷰 메뉴 pjvSavedViewMenu 와 그 전용 헬퍼 pjvMapClickUpSortField 는 #1404 에서 projects/filters.ts 로
//  내려갔다 — 읽는 쪽이 그 모듈의 설정 팝오버 하나뿐이었다. 여기선 아래 './filters.js' 로 직결해 받는다.)

// ── ClickUp 리스트 컬럼 캐시(#541) — 리스트별 이관 커스텀필드(정의·값·행별 내부 id). undefined=미조회, null=조회중. ──
const pjvCuFieldsCache = new Map<number, any>();

// ── 칸반 보드(#541) — 상태별 컬럼에 카드(ClickUp 보드 뷰 동형). 단일 리스트 선택 + 커스텀 상태면 그 상태 컬럼,
//  아니면 표준 3버킷. 카드 드래그로 상태 변경(커스텀=status_raw 키, 표준=네이티브 status). ──
function pjvKanbanBoard(projects, selList, ctx) {
  const { reload } = ctx;
  const custom = selList && pjvListIsCustomStatus(selList);
  // 기본 3버킷 색은 PJV_DEFAULT_STATUS_DEFS 와 단일 출처(#667) — 상태 편집 창(주황 진행·초록 완료)과 동일 가족.
  let defs = custom ? pjvListStatusDefs(selList) : PJV_DEFAULT_STATUS_DEFS.map((d, i) => ({
    ...d, key: d.key === 'active' ? 'in_progress' : d.key, frac: d.category === 'active' ? (i === 0 ? 0 : 0.5) : undefined,
  }));
  if (ctx.groupDir === -1) defs = defs.slice().reverse(); // 그룹 방향(#541) — 상태 그룹바이 내림차순이면 컬럼 역순
  const colOf = (p) => {
    if (custom) {
      const d = pjvResolveProjStatus(p);
      if (d) return d.key;
      return p.status === 'done' ? (defs.find((x) => x.category === 'done' || x.category === 'closed') || defs[0]).key : defs[0].key;
    }
    return p.status === 'done' ? 'done' : (p.status === 'todo' ? 'todo' : 'in_progress');
  };
  const byCol = new Map<string, any[]>(defs.map((d) => [d.key, [] as any[]]));
  for (const p of projects) { const k = colOf(p); (byCol.get(k) || byCol.get(defs[0].key)!).push(p); }

  const wrap = el('div', { class: 'pjv-kanban' });
  for (const d of defs) {
    const cards = byCol.get(d.key) || [];
    const col = el('div', { class: 'pjv-kb-col' });
    col.append(el('div', { class: 'pjv-kb-head' },
      pjvStatusIcon(d.category, d.color, d.frac, 'sm'),
      // #762 후속 — 칸반 헤더 라벨도 상태 알약(흰 글자+상태색)으로 통일(개요 칩·리스트 상태보드 pill 과 동일 톤). 기존 검은 라벨 해소.
      el('span', { class: 'pjv-kb-label pjv-status-pill', style: '--sc:' + d.color, text: d.label }),
      el('span', { class: 'pjv-kb-count', text: String(cards.length) })));
    const body = el('div', { class: 'pjv-kb-body' });
    for (const p of cards) {
      const card = el('div', { class: 'pjv-kb-card' + (p.status === 'done' ? ' done' : ''), draggable: 'true', role: 'link', tabindex: '0' });
      card.append(el('div', { class: 'pjv-kb-name', text: p.name }));
      const tags = Array.isArray(p.tags) ? p.tags.slice(0, 3) : [];
      if (tags.length) {
        const tr = el('div', { class: 'pjv-kb-tags' });
        for (const t of tags) tr.append(el('span', { class: 'pjv-kb-tag', text: t.name, style: t.color ? 'background:' + t.color + '22;border-color:' + t.color + '55' : '' }));
        tr.append(...(p.tags.length > 3 ? [el('span', { class: 'pjv-kb-tag more', text: '+' + (p.tags.length - 3) })] : []));
        card.append(tr);
      }
      const meta = el('div', { class: 'pjv-kb-meta' });
      if (p.due_date) meta.append(el('span', { class: 'pjv-kb-due' + (pjvIsOverdue(p.due_date) && p.status !== 'done' ? ' overdue' : ''), text: pjvFmtDate(p.due_date) }));
      const pr = p.priority && PJV_PRIORITY[p.priority];
      if (pr) meta.append(el('span', { class: 'pjv-kb-prio ' + pr.cls, text: '⚑ ' + pr.label }));
      const faces = el('span', { class: 'pjv-kb-faces' });
      for (const mid of pjvAssignees(p).slice(0, 3)) faces.append(personFace(mid, 'pjv-kb-face', mid));
      meta.append(faces);
      card.append(meta);
      card.onclick = () => { location.hash = '#/projects2/p/' + p.id; };
      card.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') location.hash = '#/projects2/p/' + p.id; });
      card.addEventListener('dragstart', (ev: any) => {
        pjvFolderDrag.id = null; // 폴더 드롭과 분리
        card.classList.add('dragging');
        try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', 'KB' + p.id); } catch (_) { /* */ }
        (pjvKanbanBoard as any)._drag = { id: p.id, from: d.key };
      });
      card.addEventListener('dragend', () => { card.classList.remove('dragging'); document.querySelectorAll('.pjv-kb-col.drop-over').forEach((n) => n.classList.remove('drop-over')); });
      body.append(card);
    }
    if (!cards.length) body.append(el('div', { class: 'pjv-kb-empty', text: '비어 있음' }));
    col.append(body);
    // 드롭 = 이 컬럼 상태로 변경. 커스텀=status_raw 키 저장(pjvSetProjStatusCustom 동형), 표준=네이티브 status.
    col.addEventListener('dragover', (ev: any) => { const dr = (pjvKanbanBoard as any)._drag; if (!dr || dr.from === d.key) return; ev.preventDefault(); col.classList.add('drop-over'); try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* */ } });
    col.addEventListener('dragleave', () => col.classList.remove('drop-over'));
    col.addEventListener('drop', async (ev: any) => {
      ev.preventDefault(); col.classList.remove('drop-over');
      const dr = (pjvKanbanBoard as any)._drag; (pjvKanbanBoard as any)._drag = null;
      if (!dr || dr.from === d.key) return;
      try {
        const bodyJson = custom
          ? { status: pjvNativeStatusOf(d.category), status_raw: d.key }
          : { status: d.key };
        await api('/api/ui/v6/projects/' + dr.id + '/status', { method: 'POST', body: JSON.stringify(bodyJson) });
        pjvReloadKeepScroll(reload);
      } catch (e) { toast('상태 변경 실패 — ' + e.message, true); }
    });
    wrap.append(col);
  }
  return wrap;
}

async function renderProjectV2Board(view, scopeKey?) {
  // URL 딥링크로 진입(#/projects2/l|f/<id>) — 스코프 선택. reload(scopeKey 없음)은 현재 선택 유지.
  //  사이드바 열림은 스코프 유무와 무관하게 열림 선호(localStorage) 반영 — 기본 ON, 사용자가 닫았으면 닫힌 채(#662:
  //  사이드바를 닫아도 스코프는 유지되므로, 스코프 딥링크가 사이드바를 강제로 다시 열지 않는다).
  if (scopeKey) { pjvSidebarSel.key = scopeKey; pjvSidebarSel.explicit = true; }
  try { const s = localStorage.getItem('pjv:sideOpen'); if (s === '0') pjvBoardView.byArea = false; else if (s === '1' || scopeKey) pjvBoardView.byArea = true; } catch (_) { if (scopeKey) pjvBoardView.byArea = true; }
  // #2043 — 새 셸 액자(?embed=1) 안에서는 이 패널을 세우지 않는다. 폴더·리스트로 오가는 일은 셸의 [프로젝트] 사이드바
  //  (폴더 · 리스트 렌즈, web/v2/side.ts renderProjTree)가 맡고, 이 화면은 그 사이드바가 보낸 스코프(#/projects2/l|f/<id> · /none)를
  //  보드로 그린다. 같은 목록이 두 열에 서던 것(레일 #2016 §6 '남은 것')을 여기서 끊는다. 스코프는 패널이 접혀도 유지된다(#1067 §2).
  if (document.body.classList.contains('embed')) pjvBoardView.byArea = false;
  pjvSelReset(); // 화면 진입/재렌더 시 다중선택·하단 바 초기화(이전 화면 선택 잔존 방지)
  const { y: keepY, host: keepHost } = consumeKeepScroll(); // 인라인 편집 재렌더면 스켈레톤 스킵 + 스크롤 복원(#358)
  if (keepY == null) view.replaceChildren(skeleton('프로젝트를 불러오는 중'));
  const head = projectPageHead();

  let allProjects: any, mineProjects: any, lists: any, folders: any, favData: any;
  try {
    // 전체 프로젝트(리스트별 그룹 — 접힌 리스트도 보이게) + 내 프로젝트(세션수·'내 할당' 판정) + 리스트 + 폴더(#475) + 즐겨찾기(#670) 를 병렬로.
    [allProjects, mineProjects, lists, folders, favData] = await Promise.all([
      api('/api/ui/v6/projects').then((d) => (d && d.projects) || []),
      api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []).catch(() => []),
      api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || []).catch(() => []),
      api('/api/ui/v6/project-folders').then((d) => (d && d.folders) || []).catch(() => []),
      api('/api/ui/v6/favorites').then((d) => d || {}).catch(() => ({})),
      pjvLoadStatusTemplates(), // #729 스페이스 기본 상태 스킴 로드 — pjvSetStatusRegistry/pjvListStatusDefs 가 참조(inherit 상속).
      pjvSidePrefsEnsure(), // #1227 폴더 접힘(계정별) — 첫 트리 렌더 전에 반영해 '펼쳐졌다 접히는' 깜빡임 방지. 세션당 1회.
    ]);
  } catch (e) {
    view.replaceChildren(head, errorNote(e, '프로젝트를 불러오지 못했습니다'));
    return;
  }
  // 내 세션 수는 mine=1 응답에만 부여됨 → id 로 머지(전체 목록 행에 '내 세션' 신호 복원).
  const sessById = new Map<number, number>(mineProjects.map((p: any) => [p.id, p.my_session_count || 0]));
  for (const p of allProjects) p.my_session_count = sessById.get(p.id) || 0;
  // '내가 할당된' = 서버 mine=1(생성자 OR 팀원) 집합 — '내 할당만' 토글의 기준.
  const mineIds = new Set<number>(mineProjects.map((p: any) => p.id));

  // 보드 커스텀 컬럼(클릭업식 (+)) — 정의 + 프로젝트별 값. 실패해도 컬럼 없이 진행.
  let board: any = { anchorId: null, fields: [], valuesByProject: {} };
  try { board = await api('/api/ui/v6/board-fields'); } catch (_) { /* graceful */ }
  for (const p of allProjects) p.field_values = (board.valuesByProject && board.valuesByProject[p.id]) || {};

  const reload = () => renderProjectV2Board(view);
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  // 삭제 전원 개방(#280) — 인증만 되면 누구나(서버도 인증만 요구). 삭제는 #/trash 에서 복원 가능.
  const canDelete = (_p?) => !!meId;

  // 페이지 크롬(제목만) — 사이드바(byArea) 켜지면 셸의 우측 컬럼(main) 상단으로, 꺼지면 카드 위 전폭으로.
  //  이 배치를 pjvProjectListBoard 가 byArea 에 따라 옮긴다(#607 — WIKI 형 풀블리드 사이드바).
  //  옛 '프로젝트 보드 / 폴더·리스트로 정리한 프로젝트.' 중분류 헤드(eyebrow+설명)는 WIKI 탭과 통일감 위해 제거(#617)
  //  — 이제 head(제목+설명) 바로 아래 보드. 중분류 탭 폐지(#629)와 같은 방향(보드 하나).
  const pageChrome = head ? el('div', { class: 'pjv-board-chrome' }, head) : null; // 헤드 없으면 크롬 줄 자체를 안 그림(#670)
  view.replaceChildren(
    pjvProjectListBoard(allProjects, lists, mineIds, reload, canDelete, board.fields || [], board.anchorId, meId, folders, pageChrome, favData),
    // '회사 전체'(회사 활동 피드)는 터미널 탭의 '작업 로그' 섹션으로 이관(#609 — companyTimelineSection).
  );
  pjvRestoreScroll(keepY, keepHost); // 인라인 편집 재렌더면 원래 스크롤 위치 복원(#358)
}

// 리스트 1차 그룹 보드 — 한 카드(태스크 리스트와 동일 톤). 헤더 버튼: 하위태스크 표시 · 내 할당만 · Closed · ＋새 리스트.
//  컬럼 헤더는 카드 상단에 한 번. 그 아래 리스트 그룹(접이식) 들이 쌓인다. 펼침 상태는 pjvListOpen 으로 세션 유지.
function pjvProjectListBoard(projects, lists, mineIds, reload, canDelete, fields, anchorId, meId, folders?, pageChrome?, favData?: any) {
  // 래퍼 — 사이드바 켜짐(byArea)이면 [셸 카드], 꺼짐이면 [페이지크롬 전폭 + 카드]. render() 가 배치를 바꾼다(#607).
  const wrapper = el('div', { class: 'pjv-board-wrap' });
  const card = el('div', { class: 'card pjv-tasks-card pjv-proj-card pjv-listboard', style: 'margin-bottom:18px' });
  pjvInitNameResize(card, 'pjv:nameMin:projlist'); // 이름칸 폭 드래그 저장/복원(#483)
  pjvApplyHiddenCols(card, 'proj'); // 숨긴 기본 컬럼 복원(#req)
  pjvApplyColWidths(card, 'proj'); // 저장된 컬럼 폭 복원(#666)
  folders = folders || [];
  // 📦 아카이브(#1067) — 아카이브 폴더 하위(중첩 폴더 포함)의 리스트·프로젝트는 '치워둔 것'이라 보드에서 뺀다.
  //  사이드바 트리에서도 빼고(아래 buildTree 의 고정 아카이브 항목이 대신 담당), 아카이브 스코프를 직접 고르면 그때만 보인다.
  const archiveFolder = pjvFindArchiveFolder(folders);
  const archiveFolderIds = pjvArchiveFolderIds(folders, archiveFolder);
  const archivedListIds = new Set<number>((lists || [])
    .filter((l) => l.folder_id != null && archiveFolderIds.has(Number(l.folder_id))).map((l) => Number(l.id)));
  const isArchivedList = (id) => archivedListIds.has(Number(id));
  const isArchivedProj = (p) => p.list_id != null && isArchivedList(p.list_id);
  // 아카이브를 뺀 보드용 프로젝트·리스트(전체 스코프의 상태·평면·칸반·리스트별 보기가 소비).
  const boardProjects = () => archivedListIds.size ? projects.filter((p) => !isArchivedProj(p)) : projects;
  const boardLists = () => archivedListIds.size ? lists.filter((l) => !isArchivedList(l.id)) : lists;
  pjvSetStatusRegistry(lists); // 리스트별 커스텀 상태 레지스트리 — 모든 뷰의 프로젝트 행 상태 동그라미가 참조(#475).
  pjvSetListRegistry(lists);   // #710 리스트별 컬럼 표시/숨김 — 숨김 토글이 리스트 settings 를 id 로 찾아 읽고 쓰게(팀 공유).
  setBoardFieldsCur(fields || []); // #710 확장 — 커스텀 컬럼 숨김 재조정·되살리기 패널이 참조할 현재 보드 필드.

  // 프로젝트별 태스크 캐시(행 펼침용) — 같은 렌더 동안 재사용(프로미스 캐싱으로 동시요청 합침).
  const taskCache = new Map();
  const fetchProjTasks = (projId) => {
    if (taskCache.has(projId)) return taskCache.get(projId);
    const pr = api('/api/ui/v6/projects/' + projId).then((d) => {
      const pj = (d && d.project) || d || {};
      return { tasks: pj.tasks || [], members: pj.members || [], fields: pj.fields || [] };
    });
    taskCache.set(projId, pr);
    return pr;
  };
  const taskCtx: any = { mode: pjvProjTaskMode.mode, meId, fetchProjTasks, invalidate: (id) => taskCache.delete(id) };

  // ── 툴바 버튼(#1067 ClickUp 파리티) — 좌: 그룹·하위태스크·컬럼 / 우: 필터·완료·담당자·나·검색 | 설정·＋프로젝트 ──
  //  아이콘 전용 버튼은 title + aria-label 로 이름을 준다(라벨 없이도 무엇인지 알 수 있게).
  const iconBtn = (cls, label, icon) => el('button', { class: 'pjv-tb-btn ' + cls, type: 'button', title: label, 'aria-label': label }, icon);
  // '하위 태스크' — 접힘/펼침/분리(ClickUp Subtasks).
  const subtaskBtn = iconBtn('pjv-subtask-btn', '하위 태스크 표시 방식', pjvTbIcon('subtask'));
  // '나' — 내가 만든·참여한 프로젝트만(ClickUp Me mode). 내 아바타가 곧 버튼.
  // 'Me mode'(#1067) — 내 아바타가 버튼. 누르면 프로젝트/태스크 스위치 팝오버, 켜지면 알약으로 늘어나 라벨이 붙는다(ClickUp 동형).
  const mineBtn = el('button', { class: 'pjv-tb-btn pjv-mine-btn', type: 'button', title: '내가 맡은 것만 보기', 'aria-label': '내가 맡은 것만 보기' },
    personFace(meId, 'pjv-ava', '나'), el('span', { class: 'pjv-mine-btn-label', text: '내 항목' }));
  // '완료 표시' — 닫힌(완료) 프로젝트/태스크 노출 스위치 팝오버.
  const closedBtn = iconBtn('pjv-closed-btn', '완료된 항목 표시', pjvTbIcon('check'));
  // '필터' — 필드 조건(상태·담당자·우선순위·태그·마감일·이름)으로 좁히기. 걸린 조건 수를 배지로.
  const filterBtn = iconBtn('pjv-filter-btn', '필터 — 조건으로 좁혀 보기', pjvTbIcon('filter'));
  const filterBadge = el('span', { class: 'pjv-tb-badge', 'aria-hidden': 'true' });
  filterBtn.append(filterBadge);
  // '담당자' — 사람별 빠른 필터(미지정 포함).
  const asgBtn = iconBtn('pjv-asg-btn', '담당자로 좁혀 보기', pjvTbIcon('people'));
  // '컬럼' — 기본 컬럼·커스텀 필드 표시/숨김.
  const colsBtn = iconBtn('pjv-cols-btn', '컬럼 — 표시할 열 고르기', pjvTbIcon('columns'));
  // '검색' — 이 화면 안에서 프로젝트 이름으로 좁히기. 누르면 입력창이 펼쳐진다.
  const searchBtn = iconBtn('pjv-search-btn', '검색 — 이름으로 좁혀 보기', pjvTbIcon('search'));
  const searchInput = el('input', { type: 'text', class: 'pjv-tb-search-input', placeholder: '이름으로 검색…', 'aria-label': '프로젝트 이름 검색' });
  const searchBox = el('div', { class: 'pjv-tb-search' }, searchBtn, searchInput);
  // '설정' — 보기 방식·표 정렬·사이드바·저장된 뷰(툴바에서 뺀 옵션들의 집).
  const gearBtn = iconBtn('pjv-gear-btn', '보기 설정', pjvTbIcon('gear'));
  // '＋ 프로젝트' — 기본 액션(검은 버튼). ⌄ 로 새 리스트·폴더까지.
  const addProjBtn = el('button', { class: 'pjv-tb-primary', type: 'button', title: '새 프로젝트' }, pjvTbIcon('plus', 'sm'), el('span', { text: '프로젝트' }));
  const addMoreBtn = el('button', { class: 'pjv-tb-primary-more', type: 'button', title: '더 만들기', 'aria-label': '새로 만들기 더보기' }, pjvTbIcon('caret', 'sm'));
  const addGroup = el('div', { class: 'pjv-tb-primary-group' }, addProjBtn, addMoreBtn);
  // '사이드바' — 스페이스·폴더·리스트 탐색 열기/닫기. 브레드크럼 줄 맨 앞(위치를 다루는 층).
  const sideBtn = iconBtn('pjv-side-btn', '사이드바 열기/닫기', pjvTbIcon('sidebar'));
  // '뷰' — 저장된 뷰(ClickUp 이관 포함) 피커(#541). 설정 팝오버에서 진입(툴바 직접 노출은 폐지).
  const savedViewBtn = el('button', { class: 'pjv-view-btn pjv-savedview-btn', type: 'button', title: '뷰 — 저장된 보기(ClickUp 이관 포함)', style: 'display:none' },
    pjvViewIcon(), el('span', { class: 'pjv-view-btn-label', text: '뷰' }));
  // '그룹' — 그룹바이 필드+방향(#541 ClickUp group by 파리티). 기본값=ClickUp 뷰 grouping, 리스트별 로컬 오버라이드.
  const groupBtn = el('button', { class: 'pjv-tb-btn pjv-tb-pill pjv-groupby-btn', type: 'button', title: '그룹 — 필드와 방향으로 묶어 보기' },
    pjvTbIcon('group'), el('span', { class: 'pjv-view-btn-label', text: '상태' }));
  groupBtn.onclick = (e) => { e.stopPropagation(); pjvGroupByMenu(groupBtn); };
  // 열 정렬 — 값·헤더 가로 정렬(#607). 순수 CSS(카드 클래스)라 재렌더 없이 즉시 반영, per-user localStorage. 이제 설정 팝오버에서.
  const pjvIsAlignLeft = () => { try { return localStorage.getItem('pjv:colAlign') === 'left'; } catch (_) { return false; } };
  const applyAlign = () => { card.classList.toggle('pjv-align-left', pjvIsAlignLeft()); };
  const setAlignLeft = (v) => { try { localStorage.setItem('pjv:colAlign', v ? 'left' : 'center'); } catch (_) { /* noop */ } applyAlign(); };
  applyAlign(); // 저장된 정렬 초기 반영

  // 셸 호스트(#1067) — 카드의 유일한 자식. 사이드바 켜짐이면 [nav|main] 그리드를, 꺼짐이면 main 하나를 담는다.
  //  덕분에 사이드바를 접어도 제목·툴바·보드가 시작하는 y 가 그대로다(예전엔 접으면 카드형 배치로 갈아타 높이가 튀었다).
  const shellHost = el('div', { class: 'pjv-shell-host' });
  // 스코프 없는 전체 보기(상태·평면·칸반·리스트별)의 표 컨테이너 겸 가로 스크롤 박스.
  const body = el('div', { class: 'pjv-tasks-body pjv-board-scroll' });
  // 가로 스크롤 컨테이너 — 고정 제목 열 그림자 토글(#req).
  body.addEventListener('scroll', () => { body.classList.toggle('is-xscroll', body.scrollLeft > 0); }, { passive: true });
  // 사이드바 폴더·리스트 검색어(#req) — render() 재호출 사이에도 유지, 보드 재마운트 시 초기화. 트리만 다시 그려 입력 포커스 유지.
  let sideSearchQ = '';
  //  (#1154) 사이드바 검색창은 늘 열려 있다 — 헤더 🔍 토글은 폐지(WIKI 사이드바와 동형).
  let searchOpen = false;     // 툴바 🔍(뷰 내 검색) 펼침 상태 — 검색어가 있으면 계속 펼친 것으로 본다

  const syncToggles = () => {
    subtaskBtn.classList.toggle('active', pjvProjTaskMode.mode !== 'collapsed');
    subtaskBtn.title = '하위 태스크 표시 — ' + PJV_SUBTASK_BTNLABEL[pjvProjTaskMode.mode];
    closedBtn.classList.toggle('active', pjvProjClosedView.done || pjvClosedView.tasks);
    const meOn = pjvMeModeOn();
    mineBtn.classList.toggle('active', meOn);
    mineBtn.setAttribute('aria-pressed', String(meOn));
    // '필터' — 조건이 하나라도 걸리면 강조 + 개수 배지.
    const fc = pjvFilterCount();
    filterBtn.classList.toggle('active', fc > 0);
    filterBadge.textContent = fc > 1 ? String(fc) : '';
    filterBadge.style.display = fc > 1 ? '' : 'none';
    // '담당자' — 사람/미지정이 하나라도 골라져 있으면 강조.
    const ac = pjvAsgFilter.ids.size + (pjvAsgFilter.none ? 1 : 0);
    asgBtn.classList.toggle('active', ac > 0);
    // '검색' — 검색어가 있거나 펼쳐져 있으면 입력창 노출.
    const sOpen = searchOpen || !!pjvBoardSearch.q.trim();
    searchBox.classList.toggle('open', sOpen);
    searchBtn.classList.toggle('active', !!pjvBoardSearch.q.trim());
    if (searchInput.value !== pjvBoardSearch.q) searchInput.value = pjvBoardSearch.q;
    // '사이드바' 토글 — 열려 있으면(byArea) 강조.
    sideBtn.classList.toggle('active', pjvBoardView.byArea);
    sideBtn.setAttribute('aria-pressed', String(pjvBoardView.byArea));
    // '뷰' — 저장 뷰가 적용돼 있으면 강조 + 이름 표기(#541). (툴바에선 숨김 — 설정 팝오버 경유)
    savedViewBtn.classList.toggle('active', pjvSavedView.id != null);
    const svLbl = savedViewBtn.querySelector('.pjv-view-btn-label'); if (svLbl) svLbl.textContent = pjvSavedView.id != null && pjvSavedView.name ? '뷰: ' + pjvSavedView.name : '뷰';
  };

  // 상태 그룹(원래 보드) — 할 일/진행 중/완료. 컬럼 헤더 한 번 + pjvProjGroup 재사용(Closed 반영). shown=이미 '내 할당만' 필터된 목록.
  //  그룹 내 순서는 수동/기본 비교자(#541 리뷰) — 드래그 재정렬 결과가 이 뷰에서도 유지돼 보이게(사이드바 뷰와 동형).
  const renderStatus = (shown) => {
    // 툴바의 그룹 기준을 따른다(#1067) — 상태(기본)면 3버킷, 담당자·우선순위·마감일·태그면 그 값으로 묶는다.
    //  컬럼 라벨은 별도 헤더 행이 아니라 첫(맨 위) 그룹 헤더에 합쳐진다(#470 — pjvRenderStatusGroups 의 withCols).
    body.replaceChildren();
    pjvRenderStatusGroups(body, shown, null, {
      reload, canDelete, fields, anchorId, meId, taskCtx,
      mineOnly: pjvBoardMineOnly.on, listIdForAdd: null,
      groupBy: (pjvGroupCtx && pjvGroupCtx.groupBy) || { field: 'status', dir: 1 },
    });
  };

  // 테이블(#1067) — 평면과 같은 행·컬럼을 쓰되 스프레드시트 껍데기(세로 격자선·행번호·고정 행높이)를 CSS 로 입힌다.
  //  ClickUp Table 뷰의 성격이 '그룹 없는 고정 높이 표'라 평면과 데이터 경로가 같다 — 행 컴포넌트를 새로 만들지 않는다.
  const renderTable = (shown) => renderFlat(shown);

  // 평면 — 영역·상태 그룹 없이 한 목록. 컬럼 헤더 + 행들(진행 중→할 일→완료, 같은 상태면 최신순) + 인라인 추가행(미분류로 생성).
  //  저장 뷰 정렬(#541)이 적용돼 있으면 그 정렬이 우선(상태 rank 무시 — ClickUp 뷰 시맨틱).
  const renderFlat = (shown) => {
    body.replaceChildren(pjvListColHead(fields, anchorId, reload));
    const rank = (p) => p.status === 'done' ? 2 : (p.status === 'todo' ? 1 : 0);
    const savedCmp = pjvSavedSortCmp();
    const rows = shown
      .filter((p) => p.status !== 'done' || pjvProjClosedView.done)
      .slice()
      .sort(savedCmp || ((a, b) => rank(a) - rank(b) || (Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))));
    const bodyEl = el('div', { class: 'pjv-tgroup-body pjv-flat-body' });
    for (const p of rows) bodyEl.append(pjvProjRow(p, reload, null, canDelete, fields, anchorId, taskCtx));
    if (!rows.length) bodyEl.append(el('div', { class: 'pjv-proj-empty', text: pjvBoardMineOnly.on ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.' }));
    if (!pjvBoardMineOnly.on) bodyEl.append(pjvProjAddRow('in_progress', reload, bodyEl, null, fields, null, canDelete, anchorId, meId, taskCtx, null));
    body.append(bodyEl);
  };

  // 영역 목록(좌측) — 펼침: 전체/영역들/미분류 + ＋새 영역. 접힘: 얇은 레일(▶ 펼치기 + 영역 색점). 본문은 선택 영역의 프로젝트.
  //  byStatus 면 각 영역을 상태로 다시 나눔. 접어도 영역 그룹은 유지(레일의 ▶ 로 언제든 다시 펼침) — 영역 자체를 끄려면 보기→영역으로.
  //  noNav(#662) — 사이드바를 닫아도 고른 스코프(리스트/폴더)만 계속 보여줘야 하므로, 같은 본문을 nav 없이 렌더한다.
  //   이때 페이지크롬·툴바 배치는 사이드바-꺼짐 레이아웃(전폭 크롬 + card-head 툴바)을 따르므로 main 에 넣지 않는다.
  const renderArea = (byStatus, noNav?) => {
    const groups = pjvBuildListGroups(projects, lists, mineIds, meId);
    // 좌측 사이드바 카운트/표시는 '보이는 것'과 일치 — 완료(done)는 Closed 토글일 때만(본문 필터·그룹 헤더 visibleCount 동형).
    const visCount = (arr) => pjvProjClosedView.done ? arr.length : arr.filter((p) => p.status !== 'done').length;
    const groupByList = new Map<number, any>();
    let unGroup: any = null;
    for (const g of groups) { if (g.list) groupByList.set(g.list.id, g); else unGroup = g; }
    // 트리 검색용 원본 프로젝트(#1154) — 사이드바 검색은 '어디로 갈지'를 찾는 내비게이션이라 툴바 좁히기
    //  (검색어·필터·담당자·'내 할당만')의 영향을 받으면 안 된다. groupByList 는 그 관문(pjvBuildListGroups → filterProj)을
    //  이미 지난 뒤라 검색 소스로 쓰면 두 검색이 조용히 AND 로 겹쳤다 — 툴바에 '결제'가 남아 있으면 트리에서 '온보딩'을
    //  못 찾고, '내 할당만'이 켜져 있으면 남의 프로젝트를 영영 못 찾는다. 리스트 카운트·본문은 그대로 필터된 값을
    //  쓰고, **트리 검색 매칭과 아카이브 총량(#1176)만** 이 원본 맵을 본다.
    const searchProjsByList = new Map<number, any[]>();
    const searchProjsUn: any[] = [];
    for (const p of projects) {
      if (p.list_id == null) { searchProjsUn.push(p); continue; }
      if (!searchProjsByList.has(p.list_id)) searchProjsByList.set(p.list_id, []);
      searchProjsByList.get(p.list_id)!.push(p);
    }
    const searchProjsOf = (lid) => searchProjsByList.get(Number(lid)) || [];
    // ⭐ 즐겨찾기(#670) — favData(바깥 로드)에서 파생. listNavItem/buildTree 와 같은 스코프.
    const favListIds = new Set<number>(((favData && favData.project_lists) || []).map((x: any) => Number(x)));
    setFavListCache(favListIds); // 모듈 캐시 동기(#1115) — 사이드바 밖 ⋯ 메뉴가 같은 Set 을 본다(낙관 토글도 즉시 반영).
    // 리스트 즐겨찾기 토글 — 낙관적 갱신(즉시 트리 재렌더) 후 서버 저장, 실패 시 롤백. 바깥 favData 도 갱신해 renderArea 재호출 간 유지.
    const toggleListFav = async (id: number, next: boolean) => {
      if (next) favListIds.add(id); else favListIds.delete(id);
      favData.project_lists = [...favListIds];
      buildTree();
      try { await pjvSetFavorite('project_list', id, next); }
      catch (e: any) { if (next) favListIds.delete(id); else favListIds.add(id); favData.project_lists = [...favListIds]; buildTree(); toast('즐겨찾기 저장 실패 — ' + (e && e.message || e), true); }
    };

    // 폴더 트리 — 폴더(정렬) › 그 폴더의 리스트 / 최상위(폴더 없는) 리스트 / 미분류('기타')(#475).
    //  #541: 폴더 중첩(parent_id — ClickUp Space›Folder 이관) — 루트 폴더 아래 하위 폴더를 재귀 렌더.
    // 사이드바 순서(#541 파리티) — pjvContainerCmp: sort 오름차순(구 데이터 호환), 동률은 ClickUp orderindex → 이름.
    //  미재정렬(전부 sort=0) 상태에선 ClickUp 사이드바 순서 그대로, 드래그 재정렬 시 로컬 순서 우선(커넥터가 sort 를 안 써 안 덮임).
    const bySortName = pjvContainerCmp;
    const folderAll = [...(folders || [])].sort(bySortName);
    const folderIds = new Set(folderAll.map((f) => f.id));
    // #1227 저장 필터용 — 지금 트리에 존재하는 폴더 id. 지운 폴더의 접힘 상태가 계정에 영원히 남지 않게 한다.
    pjvKnownFolderIds.clear();
    for (const f of folderAll) { const n = Number(f.id); if (Number.isFinite(n)) pjvKnownFolderIds.add(n); }
    // 부모가 실재할 때만 하위로(고아 parent_id 는 루트 취급 — 방어).
    const foldersByParent = new Map<any, any[]>();
    for (const f of folderAll) {
      const pk = (f.parent_id != null && folderIds.has(f.parent_id)) ? f.parent_id : null;
      if (!foldersByParent.has(pk)) foldersByParent.set(pk, []);
      foldersByParent.get(pk)!.push(f);
    }
    // 최상위 폴더 — 아카이브 폴더는 여기서 빼고(#1067) 트리 맨 아래 고정 항목으로 따로 렌더한다.
    //  하위 폴더·리스트 맵(foldersByParent·listsByFolder)은 그대로 둔다 — 고정 항목이 펼쳐질 때 같은 맵으로 자식을 그린다.
    const rootFolders = (foldersByParent.get(null) || []).filter((f) => !pjvFolderIsArchive(f));
    // DFS 평탄 순서(트리 순서 후보 목록·재정렬용) — 렌더와 동일 순서.
    const folderList: any[] = [];
    const walkFolders = (pid) => { for (const f of (foldersByParent.get(pid) || [])) { folderList.push(f); walkFolders(f.id); } };
    walkFolders(null);
    const listsByFolder = new Map<number, any[]>();
    const topLists: any[] = [];
    for (const l of [...lists].sort(bySortName)) {
      if (l.folder_id != null) { if (!listsByFolder.has(l.folder_id)) listsByFolder.set(l.folder_id, []); listsByFolder.get(l.folder_id)!.push(l); }
      else topLists.push(l);
    }
    // 폴더의 리스트를 하위 폴더까지 재귀 수집(선택 본문·가시성 판정 공용).
    const folderListsDeep = (fid): any[] => {
      const own = listsByFolder.get(fid) || [];
      const kids = (foldersByParent.get(fid) || []).flatMap((c) => folderListsDeep(c.id));
      return [...own, ...kids];
    };
    const showUn = !!unGroup && visCount(unGroup.projects) > 0; // 미분류는 보일 게 있을 때만

    // 선택 해소(#473 후속: '전체' 제거) — 기본/사라진 대상이면 '트리 순서상 맨 위의 내용(보이는 프로젝트) 있는 폴더/리스트'.
    //  내용 있는 게 없으면 맨 위 후보(빈 폴더라도)로. sel: F<id> | L<id> | __none__.
    const listHasVis = (lid) => visCount((groupByList.get(lid)?.projects) || []) > 0;
    const folderHasVis = (f) => folderListsDeep(f.id).some((l) => listHasVis(l.id)); // 하위 폴더 포함(#541 중첩)
    //  아카이브 안(#1067)은 자동 선택 후보에서 뺀다 — 기본 진입이 '치워둔 곳'이 되면 안 된다(직접 눌러야 들어간다).
    const selCandidates = [
      ...folderList.filter((f) => !archiveFolderIds.has(Number(f.id))).map((f) => ({ key: 'F' + f.id, has: folderHasVis(f) })),
      ...topLists.map((l) => ({ key: 'L' + l.id, has: listHasVis(l.id) })),
      ...(showUn ? [{ key: '__none__', has: visCount(unGroup.projects) > 0 }] : []),
    ];
    // ⭐ 즐겨찾기 우선(#1114) — 즐겨찾기한 리스트가 있으면 트리 순서 대신 그게 기본 진입(사이드바 맨 위 '즐겨찾기' 구역과 같은 순서).
    //  내용(보이는 프로젝트) 있는 즐겨찾기 우선, 전부 비었으면 첫 즐겨찾기 — 사용자가 직접 꽂은 핀이라 빈 리스트여도 트리 휴리스틱보다 앞선다.
    const favCandidates = lists.filter((l) => favListIds.has(l.id)).map((l) => ({ key: 'L' + l.id, has: listHasVis(l.id) }));
    const defaultSel = () => (favCandidates.find((c) => c.has) || favCandidates[0] || selCandidates.find((c) => c.has) || selCandidates[0] || { key: '__none__' }).key;
    let sel = pjvSidebarSel.key;
    const listExists = (id) => lists.some((l) => String(l.id) === String(id));
    const folderExists = (id) => folderList.some((f) => String(f.id) === String(id));
    if (sel === '__all__') sel = defaultSel();
    else if (sel === '__none__' && !showUn) sel = defaultSel();
    else if (typeof sel === 'string' && sel[0] === 'L' && !listExists(sel.slice(1))) sel = defaultSel();
    else if (typeof sel === 'string' && sel[0] === 'F' && !folderExists(sel.slice(1))) sel = defaultSel();
    if (sel !== pjvSidebarSel.key) pjvSidebarSel.explicit = false; // 자동 해소된 스코프 — 사용자가 고른 게 아님(#662)
    pjvSidebarSel.key = sel;
    // 스코프별 뷰 로드(#541) — 이 스코프의 저장 뷰(없으면 기본: 폴더/스페이스=개요, 리스트=상태)를 globals 로.
    //  byStatus 파라미터도 여기서 재동기(render() 가 넘긴 값은 로드 전 스냅샷이므로).
    pjvApplyView(pjvLoadScopeView(sel) || pjvDefaultView(sel));
    byStatus = pjvBoardView.byStatus;
    pjvSyncUrl(sel, true); // 자동 해소된 스코프를 URL 에 replace(히스토리 오염 없이 새로고침 복원용)
    syncCrumbs(); // 브레드크럼 재동기(#1067) — render() 시점엔 sel 이 '__all__' 일 수 있어, 자동 해소된 실제 스코프로 다시 그린다
    (viewTabs as any)._sync(); // 뷰 탭도 재동기 — 위 pjvApplyView 가 스코프 저장뷰(칸반 등)로 갈아탔을 수 있다
    // 필터·담당자 값 후보를 **이 스코프**로 재수집(#1067) — 전체 기준이면 "윤상민 216" 처럼 화면(59개)과 안 맞는
    //  숫자가 나와 오해를 부른다. 툴바 필터가 걸리기 전(raw) 스코프 집합이 기준이라 후보가 자기 자신에 의해 줄지 않는다.
    {
      const inScope = sel[0] === 'F' ? new Set(folderListsDeep(Number(sel.slice(1))).map((l) => Number(l.id)))
        : sel[0] === 'L' ? new Set([Number(sel.slice(1))]) : null;
      const scoped = inScope ? projects.filter((p) => p.list_id != null && inScope.has(Number(p.list_id)))
        : sel === '__none__' ? projects.filter((p) => p.list_id == null) : projects;
      pjvSetFilterUniverse(scoped, lists);
    }
    const selectArea = (key) => {
      // 스코프 전환 — URL push(뒤로가기 가능) + 인메모리 render(리페치 없음). 뷰 로드는 renderArea 재진입이 처리.
      pjvSidebarSel.key = key;
      pjvSidebarSel.explicit = true; // 사용자가 직접 고름(#662) — 사이드바를 닫아도 이 스코프 유지
      pjvSyncUrl(key, false);
      render();
    };
    const isFolderOpen = (fid) => pjvIsFolderOpen(fid);
    const toggleFolder = (fid) => { pjvSetFolderOpen(fid, !isFolderOpen(fid)); render(); }; // #1227 설정과 동시에 계정에 저장

    // 본문 — 선택 범위의 프로젝트. 폴더 선택=그 폴더의 모든 리스트, 리스트 선택=그 리스트, 미분류=미분류.
    let shownProjects: any[] = [];
    let selList: any = null;
    if (sel === '__all__') shownProjects = groups.flatMap((g) => g.projects);
    else if (sel[0] === 'F') { const fid = sel.slice(1); shownProjects = folderListsDeep(Number(fid)).flatMap((l) => (groupByList.get(l.id)?.projects) || []); }
    else if (sel[0] === 'L') { selList = lists.find((l) => String(l.id) === sel.slice(1)); shownProjects = (groupByList.get(Number(sel.slice(1)))?.projects) || []; }
    else if (sel === '__none__') shownProjects = unGroup ? unGroup.projects : [];
    const listIdForAdd = selList ? selList.id : null; // 특정 리스트 선택 시 새 프로젝트는 그 리스트로
    const mineOnly = pjvBoardMineOnly.on;

    // ClickUp 리스트 컬럼(#541) — 선택 리스트에 이관 커스텀필드가 있으면 컬럼으로 병합(lazy fetch + 캐시).
    //  컬럼 id='cu:<external_id>'(공유 정의), 편집은 행별 내부 field id(cuIds)로 해소. 행 값은 field_values 에 프리필.
    // #607/D 리스트별 필드 — 선택 리스트의 전용 필드 + 전역 필드만. 폴더·전체 스코프(selList 없음)면 전역만.
    let effFields = pjvFieldsForList(fields, selList ? selList.id : null);
    // #710 리스트별 컬럼 표시/숨김 재조정 — 선택 스코프(리스트)마다 그 리스트 settings 로 **완전 재조정**(팀 공유).
    //  리스트 밖(전체·폴더) 스코프면 listId=null → 보드 전역(per-user localStorage). card.dataset.colList 도 여기서 새겨져
    //  헤더 ⋯/되살리기 토글이 현재 스코프를 안다. 이 호출이 예전의 '뷰 유래 기본숨김 잔존 폭 리셋'까지 포함한다(완전 재조정).
    pjvApplyHiddenCols(card, 'proj', selList ? selList.id : null);
    pjvApplyColWidths(card, 'proj', selList ? selList.id : null);
    if (selList && selList.external_id) {
      const cu = pjvCuFieldsCache.get(selList.id);
      if (cu === undefined) {
        pjvCuFieldsCache.set(selList.id, null); // 조회중 마커(중복 fetch 방지)
        api('/api/ui/v6/project-lists/' + selList.id + '/clickup-fields')
          .then((d) => { pjvCuFieldsCache.set(selList.id, d || { fields: [] }); if (((d || {}).fields || []).length || ((d || {}).view_columns || []).length || (d || {}).view_grouping || ((d || {}).view_sorting || []).length) render(); })
          .catch(() => pjvCuFieldsCache.set(selList.id, { fields: [] }));
      } else if (cu && ((cu.fields || []).length || (cu.view_columns || []).length)) {
        let cuCols = (cu.fields || []).map((f) => ({
          id: 'cu:' + f.key, name: f.name, field_type: f.field_type, config: f.config || {},
          readonlyDef: true,
          cuIds: Object.fromEntries(Object.entries(cu.fieldIds || {}).map(([pid, m]: [string, any]) => [pid, m[f.key]])),
        }));
        // ClickUp 리스트 뷰 컬럼 구성 적용(#541 빌트인 패리티) — hidden=false 항목만, idx 순.
        const vcols = Array.isArray(cu.view_columns) ? cu.view_columns.filter((c) => c && c.field && !c.hidden) : [];
        if (vcols.length) {
          // ① 빌트인 → 우리 기본 컬럼 자동 켬(가산 — 사용자가 (+)패널에서 켠/끈 명시 설정은 그대로).
          const BUILTIN = { assignee: 'team', dueDate: 'due', startDate: 'start', dateCreated: 'created', dateUpdated: 'updated', priority: 'priority' };
          for (const c of vcols) {
            const std = BUILTIN[String(c.field)];
            if (std) {
              const def = PJV_STD_COLS.proj.find((x) => x.key === std);
              // 기본숨김 컬럼만 뷰가 켠다(기본표시 컬럼은 이미 보임). 카드 변수로 이 렌더에 즉시 반영(저장 안 함 — 뷰 유래).
              if (def && def.defaultHidden && !pjvGetShownCols('proj', selList.id).has(std)) card.style.setProperty(PJV_STD_COL_VAR[std], PJV_STD_COL_W[std] || '92px'); // #710 이 리스트 shown-set 기준
            }
          }
          // ② 커스텀필드 → 뷰의 순서/노출로 정렬·필터(뷰에 없는 필드는 뒤에 유지 — 데이터 발견성 우선).
          const order = new Map(vcols.map((c, i) => [String(c.field), i]));
          const inView = cuCols.filter((f) => order.has(f.id.slice(3)));
          const rest = cuCols.filter((f) => !order.has(f.id.slice(3)));
          inView.sort((a, b) => Number(order.get(a.id.slice(3)) ?? 0) - Number(order.get(b.id.slice(3)) ?? 0));
          cuCols = [...inView, ...rest];
        }
        for (const p of shownProjects) {
          const vals = (cu.values || {})[String(p.id)];
          if (!vals) continue;
          p.field_values = p.field_values || {};
          for (const f of cu.fields || []) if (vals[f.key] !== undefined && p.field_values['cu:' + f.key] === undefined) p.field_values['cu:' + f.key] = vals[f.key];
        }
        effFields = [...effFields, ...cuCols]; // 리스트별 필터된 필드(#607/D) + ClickUp 이관 컬럼
      }
    }

    // 그룹바이/컬럼 정렬 컨텍스트(#541) — ClickUp 뷰 기본값(view_grouping/view_sorting) + 리스트별 로컬 오버라이드.
    const cuData = (selList && pjvCuFieldsCache.get(selList.id)) || null;
    const groupBy = pjvGetGroupBy(selList, cuData, sel);
    const colSort = pjvGetColSort(selList, cuData);
    setSortCtx(selList ? { selList, colSort, rerender: render } : null);
    // 그룹은 어느 스코프에서든 바꿀 수 있다(#1067) — 폴더/스페이스면 각 리스트 박스 안에서 그 기준으로 묶인다.
    setGroupCtx({ selList, groupBy, rerender: render, enabled: true, scopeKey: sel });
    if (groupBtn) pjvSyncGroupBtn(groupBtn, groupBy, true, sel);

    const main = el('div', { class: 'pjv-side-main' + (noNav ? ' pjv-side-main-nonav' : '') + (pjvBoardView.table ? ' pjv-table-mode' : '') });
    // 셸의 우측 컬럼 상단에 페이지 크롬(제목·하위탭·보드헤드) + 툴바를 얹는다 — 사이드바는 좌측에서 y=64 부터 풀하이트(#607).
    //  noNav(#662)여도 같은 자리에 얹는다(#1067) — 사이드바를 접어도 '사이드바만 사라지고' 나머지는 그대로여야 한다.
    if (pageChrome) main.append(pageChrome);
    main.append(headerStack);
    // 표 뷰(폴더·상태·평면)는 열이 많으면 가로로 넘칠 수 있으니 이 박스가 보드만 가로 스크롤한다(#607) — 개요·칸반은 제외.
    const boardBox = el('div', { class: 'pjv-board-scroll' });
    // 가로 스크롤 상태 표시(#req) — 고정 제목 열 우측 그림자 토글(엑셀식 고정 경계).
    boardBox.addEventListener('scroll', () => { boardBox.classList.toggle('is-xscroll', boardBox.scrollLeft > 0); }, { passive: true });
    const selFolder = sel[0] === 'F' ? folderList.find((x) => String(x.id) === sel.slice(1)) : null;
    if (pjvBoardView.overview && selFolder) {
      // 개요(Overview) 뷰(#541) — 폴더/스페이스 진입 기본. 하위 폴더·리스트를 카드로 요약(개수·상태 미니바). 클릭→진입.
      const isSpace = pjvFolderIsSpace(selFolder);
      // 개요 통계도 Closed 토글을 따른다(#541 리뷰) — 사이드바 navcount·본문과 '보이는 것' 일치. 완료(done)는 Closed 켤 때만 집계.
      const vis = (arr) => pjvProjClosedView.done ? arr : arr.filter((p) => p.status !== 'done');
      const brk = (arr0) => { const arr = vis(arr0); return { total: arr.length, done: arr.filter((p) => p.status === 'done').length,
        prog: arr.filter((p) => p.status !== 'done' && p.status !== 'todo').length, todo: arr.filter((p) => p.status === 'todo').length }; };
      const childFolders = (foldersByParent.get(selFolder.id) || []);
      const childLists = (listsByFolder.get(selFolder.id) || []);
      const top = brk(folderListsDeep(selFolder.id).flatMap((l) => (groupByList.get(l.id)?.projects) || []));
      const statRow = el('div', { class: 'pjv-ov-stats' },
        el('span', { class: 'pjv-ov-stat', text: '전체 ' + top.total }),
        el('span', { class: 'pjv-ov-stat', text: '진행 ' + top.prog }));
      if (pjvProjClosedView.done) statRow.append(el('span', { class: 'pjv-ov-stat', text: '완료 ' + top.done }));
      const ov = el('div', { class: 'pjv-overview' });
      ov.append(el('div', { class: 'pjv-ov-head' },
        el('div', { class: 'pjv-ov-title' }, el('span', { class: 'pjv-ov-kind', text: isSpace ? '스페이스' : '폴더' }), el('h3', { class: 'pjv-ov-name', text: selFolder.name })),
        statRow));
      const grid = el('div', { class: 'pjv-ov-grid' });
      const ovCard = (key, glyph, name, arr, sub) => {
        const b = brk(arr);
        const c = el('div', { class: 'pjv-ov-card', role: 'button', tabindex: '0' });
        c.append(el('div', { class: 'pjv-ov-card-head' }, glyph, el('span', { class: 'pjv-ov-card-name', text: name }),
          sub ? el('span', { class: 'pjv-ov-card-sub', text: sub }) : el('span', { class: 'pjv-ov-card-sub' })));
        c.append(el('div', { class: 'pjv-ov-card-count', text: b.total + '개 프로젝트' }));
        const bar = el('div', { class: 'pjv-ov-bar' });
        const seg = (n, cls) => { if (n > 0) { const s = el('span', { class: 'pjv-ov-bar-seg ' + cls }); s.style.flex = String(n); bar.append(s); } };
        if (b.total) { seg(b.todo, 'todo'); seg(b.prog, 'prog'); seg(b.done, 'done'); } else bar.append(el('span', { class: 'pjv-ov-bar-seg empty' }));
        c.append(bar);
        const go = () => selectArea(key);
        c.addEventListener('click', go);
        c.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        return c;
      };
      for (const f of childFolders) {
        const isSp = pjvFolderIsSpace(f);
        const g = isSp
          ? el('span', { class: 'pjv-side-space-avatar', text: (String(f.name).trim()[0] || 'S').toUpperCase(), style: 'background:' + (f.color || avatarColor('space' + f.id)) })
          : pjvBundleIcon(f.color || 'var(--muted-2)');
        grid.append(ovCard('F' + f.id, g, f.name, folderListsDeep(f.id).flatMap((l) => (groupByList.get(l.id)?.projects) || []), isSp ? '스페이스' : '폴더'));
      }
      for (const l of childLists) grid.append(ovCard('L' + l.id, pjvListGlyph(l), l.name, (groupByList.get(l.id)?.projects) || [], null));
      if (!childFolders.length && !childLists.length) grid.append(el('div', { class: 'pjv-proj-empty', text: '이 ' + (isSpace ? '스페이스' : '폴더') + '에 리스트가 없습니다.' }));
      ov.append(grid);
      main.append(ov);
    } else if (pjvBoardView.kanban) {
      // 칸반 보드(#541) — 선택 리스트의 커스텀 상태 컬럼(없으면 표준 3버킷)에 카드. 그룹 방향(dir=-1)이면 컬럼 역순.
      main.append(pjvKanbanBoard(shownProjects, selList, { reload, canDelete, groupDir: groupBy.field === 'status' ? groupBy.dir : 1 }));
    } else if (pjvBoardView.timeline) {
      // 타임라인(#1067) — 스코프 안 프로젝트를 시간축에. 그룹 없이 한 행 = 한 프로젝트.
      main.append(pjvTimelineView(shownProjects, { reload, rerender: () => renderArea(byStatus, noNav), lists }));
    } else if (pjvBoardView.table) {
      // 테이블(#1067) — 그룹 없는 평면 표(껍데기는 .pjv-table-mode CSS). 컬럼 헤더 + 행.
      const tbody = el('div', { class: 'pjv-tgroup-body pjv-flat-body' });
      const trows = shownProjects.filter((p) => p.status !== 'done' || pjvProjClosedView.done).slice().sort(pjvSavedSortCmp() || pjvTableDefaultCmp);
      for (const p of trows) tbody.append(pjvProjRow(p, reload, null, canDelete, fields, anchorId, taskCtx));
      if (!trows.length) tbody.append(el('div', { class: 'pjv-proj-empty', text: '표시할 프로젝트가 없습니다.' }));
      main.append(pjvListColHead(fields, anchorId, reload, selList ? selList.id : undefined), tbody);
    } else if (selFolder && !pjvGetAlsoList(sel)) {
      // #req '리스트로도 묶기'를 끈 폴더/스페이스 — 리스트 경계를 지우고 이 폴더 아래 전체를 한 덩어리로.
      //  그룹 기준(상태·담당자 등)만 남는다. 리스트 스코프에서 쓰는 것과 같은 렌더 경로라 행·컬럼 모습은 그대로.
      //  selList=null 이므로 표준 3버킷(커스텀 상태는 리스트마다 달라 폴더 단위로는 합칠 수 없다).
      pjvRenderStatusGroups(boardBox, shownProjects, null, { reload, canDelete, fields: effFields, anchorId, meId, taskCtx, mineOnly, listIdForAdd: null, noAdd: true, groupBy, colSort });
    } else if (selFolder) {
      // 폴더/스페이스 뷰(#1067) — ClickUp 폴더 List 뷰 파리티: **리스트마다 테두리 박스** 하나.
      //  박스 헤더 위에 경로(스페이스 / 폴더)를 얹고, 박스 안에서 툴바의 그룹 기준으로 다시 묶는다.
      //  공용 컬럼 헤더 행은 두지 않는다 — 각 박스의 첫 그룹 헤더가 컬럼 라벨을 겸하므로(#470) 중복이 된다.
      const scoped = folderListsDeep(selFolder.id);
      // 이 리스트가 어디 있는지 — 조상 폴더 이름을 ' / ' 로 이어 준다(선택한 폴더 자신까지 포함).
      const crumbOf = (l) => {
        const names: string[] = [];
        let f = l.folder_id != null ? folderAll.find((x) => String(x.id) === String(l.folder_id)) : null;
        while (f) { names.unshift(f.name); f = f.parent_id != null ? folderAll.find((x) => String(x.id) === String(f.parent_id)) : null; }
        return names.join(' / ');
      };
      let any = false;
      for (const l of scoped) {
        const g = groupByList.get(l.id);
        if (!g) continue;
        if (mineOnly && !visCount(g.projects)) continue;
        any = true;
        // 폴더를 명시 선택한 문맥 — 접힘 저장값이 없으면 기본 펼침(보드 기본값은 '내 리스트만 펼침'이라 여기선 부적합).
        const og = pjvListOpen.has(g.key) ? g : { ...g, open: true };
        boardBox.append(pjvListGroup(og, reload, canDelete, effFields, anchorId, meId, taskCtx, true, false, { boxed: true, crumb: crumbOf(l), groupBy }));
      }
      if (!any) boardBox.append(el('div', { class: 'pjv-proj-empty', text: scoped.length ? (mineOnly ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.') : '이 폴더에 리스트가 없습니다.' }));
    } else if (pjvBoardView.byFolder) {
      // 리스트로 나누기(#756) — 사이드바를 닫지 않고(상태로·칸반과 동일하게 유지) 우측 컬럼에 '리스트별 접이식 그룹'으로.
      //  폴더 뷰(위 selFolder 분기)와 동형: 전체 스코프면 모든 리스트(+미분류), 단일 리스트 스코프면 그 리스트만.
      //  byStatus 는 false 라 리스트 안 상태 중첩 없음(순수 리스트 그룹).
      const lgs = selList ? groups.filter((g) => g.list && g.list.id === selList.id) : groups.filter((g) => g.list);
      let anyL = false;
      for (const g of lgs) {
        if (mineOnly && !visCount(g.projects)) continue;
        anyL = true;
        boardBox.append(pjvListGroup(pjvListOpen.has(g.key) ? g : { ...g, open: true }, reload, canDelete, effFields, anchorId, meId, taskCtx, true, false, { boxed: true, groupBy }));
      }
      if (!selList && unGroup && visCount(unGroup.projects) > 0) {
        anyL = true;
        boardBox.append(pjvListGroup(pjvListOpen.has(unGroup.key) ? unGroup : { ...unGroup, open: true }, reload, canDelete, effFields, anchorId, meId, taskCtx, true, false, { boxed: true, groupBy }));
      }
      if (!anyL) boardBox.append(el('div', { class: 'pjv-proj-empty', text: mineOnly ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.' }));
    } else if (byStatus) {
      // 컬럼 라벨은 별도 헤더 행이 아니라 첫 상태 그룹 헤더에 합친다(#470). 단일 리스트면 커스텀 상태로 그룹핑(#475).
      pjvRenderStatusGroups(boardBox, shownProjects, selList, { reload, canDelete, fields: effFields, anchorId, meId, taskCtx, mineOnly, listIdForAdd, groupBy, colSort });
    } else {
      boardBox.append(pjvListColHead(effFields, anchorId, reload, selList ? selList.id : null)); // #607/D 리스트별 필드 추가
      const rank = (p) => p.status === 'done' ? 2 : (p.status === 'todo' ? 1 : 0);
      const savedCmp = pjvSavedSortCmp(); // 저장 뷰 정렬(#541) 우선
      // 정렬 우선순위: 컬럼 헤더 클릭(로컬) > 저장 뷰 정렬 > 뷰 기본(view_sorting) > 상태 rank + 수동/기본 순서.
      const localSort = colSort && !colSort.fromView ? colSort : null;
      const rows = shownProjects.filter((p) => p.status !== 'done' || pjvProjClosedView.done).slice()
        .sort(localSort ? pjvColSortCmp(localSort)
          : (savedCmp || (colSort ? pjvColSortCmp(colSort) : ((a, b) => rank(a) - rank(b) || pjvManualCmp(a, b)))));
      const flatBody = el('div', { class: 'pjv-tgroup-body pjv-flat-body' });
      for (const p of rows) flatBody.append(pjvProjRow(p, reload, null, canDelete, effFields, anchorId, taskCtx));
      if (!rows.length) flatBody.append(el('div', { class: 'pjv-proj-empty', text: mineOnly ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.' }));
      if (!mineOnly) flatBody.append(pjvProjAddRow('in_progress', reload, flatBody, null, effFields, null, canDelete, anchorId, meId, taskCtx, listIdForAdd));
      boardBox.append(flatBody);
    }
    if (boardBox.childNodes.length) main.append(boardBox); // 표 뷰만 가로 스크롤 박스로(개요·칸반은 main 에 직접)

    // ── 리스트 항목(트리 잎) — 체크 글리프(색/이모지) + 이름 + 개수 + ⋯(리스트 설정) + 프로젝트 드롭 타깃. sub=폴더 안이면 들여쓰기.
    const listNavItem = (list, sub, depth = 0, opts?: any) => {
      const key = 'L' + list.id;
      const grp = groupByList.get(list.id);
      const active = sel === key;
      const noDrag = !!(opts && opts.noDrag); // 즐겨찾기 구역 사본 등 — 드래그 소스/재정렬 비활성(드롭 타깃은 유지)
      // 카테고리(도메인) 배지(#541 후속) — 이 리스트가 어느 카테고리에 배정됐는지, 안 됐으면 '미분류' 를 명시.
      const cat = list.category;
      const catBadge = el('span', { class: 'pjv-side-cat' + (cat ? '' : ' none'),
        title: cat ? ('카테고리: ' + (cat.name || cat.key)) : '카테고리 미분류 — 리스트 설정에서 지정',
        text: cat ? (cat.name || cat.key) : '미분류' });
      const it = el('div', { class: 'pjv-side-navitem pjv-side-navlist' + (sub ? ' sub' : '') + (active ? ' active' : '') + (favListIds.has(list.id) ? ' is-fav' : ''), role: 'button', tabindex: '0', 'aria-pressed': String(active), ...(noDrag ? {} : { draggable: 'true' }) },
        pjvListGlyph(list), el('span', { class: 'pjv-side-navlabel', text: list.name }), pjvVisLock(list), catBadge,
        el('span', { class: 'pjv-side-navcount', text: String(grp ? visCount(grp.projects) : 0) }));
      pjvSideIndent(it, sub ? Math.max(depth, 1) : 0); // 들여쓰기 격자 + 위계 세로선(#1067) — 폴더·리스트 한 격자
      const go = (e) => { e.stopPropagation(); selectArea(key); };
      it.addEventListener('click', go);
      it.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
      // ⭐ 즐겨찾기 토글은 ⋯ 메뉴 안으로(#1115) — 행 우측 호버 별(#670)은 개수·⋯와 한 자리를 다퉈 위치가 애매했고,
      //  즐겨찾기된 행은 별 상시표시 탓에 개수가 아예 안 보였다. 즐겨찾기 여부는 맨 위 '즐겨찾기' 구역 자체가 보여주므로
      //  행에는 표시를 남기지 않는다(클릭업 동일 — 행 별 없음, 메뉴 'Add to Favorites'). 사이드바 폭·행 레이아웃 불변.
      const more = el('button', { class: 'pjv-side-navmore', type: 'button', title: '리스트 설정', 'aria-label': '리스트 설정', text: '⋯' });
      more.addEventListener('click', (e) => { e.stopPropagation(); const menu = el('div', { class: 'pjv-menu pjv-listset-menu' }); const close = pjvPopover(more, menu); pjvListSettingsMenu(menu, close, list, reload, { isFav: favListIds.has(list.id), onToggle: (next) => toggleListFav(list.id, next) }); });
      it.append(more);
      pjvFolderDropTarget(it, list.id, reload); // 프로젝트를 이 리스트로 드롭(별개 드래그: pjvFolderDrag) — 즐겨찾기 사본에서도 유지
      if (!noDrag) {
        // 드래그: 이 리스트(=파일)를 잡아 폴더로 넣기/빼기(kind='list'). 놓는 곳이 폴더면 그 폴더로, 빈 곳이면 최상위로.
        it.addEventListener('dragstart', (ev) => { pjvSideDrag.kind = 'list'; pjvSideDrag.id = list.id; pjvSideDrag.folderId = list.folder_id ?? null; document.body.classList.add('pjv-side-dragging', 'pjv-side-dragging-list'); if (list.folder_id != null) document.body.classList.add('pjv-side-dragging-infolder'); try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', 'L' + list.id); } catch (_) { /* */ } });
        it.addEventListener('dragend', () => { pjvSideDrag.kind = null; pjvSideDrag.id = null; pjvSideDrag.folderId = null; document.body.classList.remove('pjv-side-dragging', 'pjv-side-dragging-list', 'pjv-side-dragging-infolder'); document.querySelectorAll('.pjv-side-drop-over, .pjv-side-drop-before, .pjv-side-drop-after, .pjv-side-drop-outdent').forEach((n) => n.classList.remove('pjv-side-drop-over', 'pjv-side-drop-before', 'pjv-side-drop-after', 'pjv-side-drop-outdent')); });
      }
      // 리스트→리스트 드롭(#541): 같은 폴더 형제면 커서 위/아래로 앞/뒤 재정렬(가로 삽입선), 다른 폴더 리스트면 그 폴더로 이동(기존 동작). 즐겨찾기 사본은 재정렬 타깃 제외.
      if (!noDrag) pjvSideNavDrop(it, {
        reorderList: (lid) => { if (String(lid) === String(list.id)) return false; const d = lists.find((x) => String(x.id) === String(lid)); return !!(d && String(d.folder_id ?? '') === String(list.folder_id ?? '')); },
        onList: (lid, after) => {
          if (String(lid) === String(list.id)) return;
          const dragged = lists.find((x) => String(x.id) === String(lid));
          const sameFolder = dragged && String(dragged.folder_id ?? '') === String(list.folder_id ?? '');
          if (sameFolder) {
            const sibs = (list.folder_id != null ? (listsByFolder.get(list.folder_id) || []) : topLists).map((x) => x.id);
            pjvReorderLists(pjvMoveNear(sibs, lid, list.id, after), reload);
          } else pjvMoveListToFolder(lid, list.folder_id ?? null, reload);
        },
        // 아웃덴트(리스트를 최상위로) 폐지(#1067) — 리스트는 항상 스페이스 안에 있어야 한다. 옮기려면 ⋯ '폴더로 이동'.
        onOutdent: () => { toast('리스트는 스페이스 밖으로 뺄 수 없어요 — ⋯ ▸ 폴더로 이동 을 써 주세요'); },
      });
      return it;
    };

    // 전체 네비. nav = 본문 높이만큼 늘어나는 레일(구분선), navInner = sticky 항목.
    //  세모(◀)는 사이드바(byArea) 자체를 닫는다 — 예전 '작은 레일'로 접던 동작 폐기(#510). 다시 열려면 상단 '폴더' 버튼.
    const nav = el('div', { class: 'pjv-side-nav' });
    // 사이드바 폭 조절(#541) — 오른쪽 경계 드래그 핸들. 끌면 wrap 의 --pjv-side-w 를 바꾸고 localStorage 저장. 더블클릭=기본값.
    const sideResize = el('div', { class: 'pjv-side-resize', title: '드래그하여 사이드바 너비 조절 (더블클릭: 기본값)', 'aria-hidden': 'true' });
    sideResize.addEventListener('mousedown', (e: any) => {
      e.preventDefault(); e.stopPropagation();
      const wrap = sideResize.closest('.pjv-side-wrap') as HTMLElement | null;
      const startX = e.clientX;
      const startW = nav.getBoundingClientRect().width || 208;
      document.body.classList.add('pjv-side-resizing'); // 사이드바 전용(#541 리뷰) — 이름칸 리사이즈(pjv-col-resizing)와 하이라이트 분리
      const onUp = () => {
        document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); window.removeEventListener('blur', onUp);
        document.body.classList.remove('pjv-side-resizing');
        const cur = wrap && wrap.style.getPropertyValue('--pjv-side-w');
        if (cur) { try { localStorage.setItem('pjv:sideW', cur.trim()); } catch (_) { /* noop */ } }
      };
      const onMove = (ev: any) => {
        if (ev.buttons === 0) { onUp(); return; } // 창 밖에서 손 뗀 경우 등 mouseup 유실 방지(#541 리뷰)
        let w = startW + (ev.clientX - startX); w = Math.max(150, Math.min(440, w)); if (wrap) wrap.style.setProperty('--pjv-side-w', Math.round(w) + 'px');
      };
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); window.addEventListener('blur', onUp);
    });
    sideResize.addEventListener('dblclick', (e: any) => {
      e.preventDefault(); e.stopPropagation();
      const wrap = sideResize.closest('.pjv-side-wrap') as HTMLElement | null;
      if (wrap) wrap.style.removeProperty('--pjv-side-w');
      try { localStorage.removeItem('pjv:sideW'); } catch (_) { /* noop */ }
    });
    nav.append(sideResize);
    const navInner = el('div', { class: 'pjv-side-nav-inner' });
    // 사이드바 항목을 고르면 보드 전체를 다시 그려 이 스크롤러가 새 노드가 된다 → 위치가 0 으로 돌아갔다
    //  (실측 #1635: 400→0). 리스트·폴더가 많으면 늘 스크롤돼 있어 '방금 누른 자리'를 매번 잃었다.
    keepSideScroll(navInner, 'projects');
    // 접기 글리프는 «(이중 꺾쇠) — 클릭업과 같은 기호. 채워진 ▲▼◀ 삼각형은 트리 캐럿(펼침/접힘) 몫이라 섞이면 헷갈린다.
    const collapseBtn = el('button', { class: 'pjv-side-collapse', type: 'button', title: '사이드바 닫기', 'aria-label': '사이드바 닫기', text: '«' });
    // 세모(◀) 닫기 — 직접 고른 스코프(리스트/폴더)는 유지한 채 nav 만 닫는다(#662). 자동 선택 스코프면 예전처럼
    //  전체 보드로(뷰 리셋 pjvExitAreaMode — 안 하면 URL·잔존뷰가 스코프에 남는다).
    collapseBtn.onclick = (e) => { e.stopPropagation(); pjvBoardView.byArea = false; pjvKeepScopeOnCollapse(); pjvPersistSideOpen(); syncToggles(); render(); };
    // ── 헤더 줄(#1067, 클릭업 파리티) — 라벨 + [◀ 접기] + [＋ ⌄ 새로 만들기]. 두 부류가 다르다:
    //  · ◀ = **호버로 드러나는** 무지 아이콘(평소엔 라벨만 보이게 조용히).
    //  · ＋ = **항상 보이는 흰 알약**(테두리+얕은 그림자) — 클릭업도 이것만 상시 노출한다. 생성은 늘 손에 닿아야 하니까.
    //  (#1154) 검색은 예전엔 헤더 🔍 를 눌러야 펼쳐졌다(트리 세로 공간을 아끼려고) — 눌러야 나오니 있는 줄도 모르고,
    //   사이드바를 접으면 아예 손이 닿지 않았다. 이제 검색창은 트리 위에 상시 노출한다(WIKI 사이드바와 동형).
    //  ＋ 메뉴는 예전 트리 맨 아래 버튼 3개를 대체한다(맨 아래는 아카이브·휴지통 자리).
    const addGlyph = (d, w) => { const n = sv('svg', { viewBox: '0 0 24 24', width: w, height: w, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }); n.append(sv('path', { d })); return n; };
    const addBtn = el('button', { class: 'pjv-side-head-add', type: 'button', title: '새로 만들기 — 스페이스 · 폴더 · 리스트', 'aria-label': '새로 만들기' },
      addGlyph('M12 5.5v13M5.5 12h13', 15), addGlyph('M6.5 10l5.5 5 5.5-5', 12));
    addBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(addBtn, menu);
      const mk = (label, hint, fn) => {
        const b = el('button', { class: 'pjv-menu-item', type: 'button' },
          el('span', { class: 'pjv-view-item-main' }, el('span', { class: 'pjv-view-item-label', text: label }), el('span', { class: 'pjv-view-item-hint', text: hint })));
        b.onclick = (ev) => { ev.stopPropagation(); close(); fn(); };
        return b;
      };
      menu.append(el('div', { class: 'pjv-menu-head', text: '새로 만들기' }));
      menu.append(mk('새 스페이스', '최상위 구획 — 폴더·리스트를 담습니다', () => openFolderForm(reload, undefined, { kind: 'space' })));
      menu.append(mk('새 폴더', '리스트를 묶는 정리용 폴더', () => openFolderForm(reload)));
      menu.append(mk('새 리스트', '프로젝트가 실제로 담기는 곳', () => openListForm(reload)));
    };
    navInner.append(el('div', { class: 'pjv-side-nav-head' },
      el('span', { class: 'pjv-side-nav-head-label', text: '폴더 · 리스트' }),
      el('span', { class: 'pjv-side-head-btns' }, collapseBtn, addBtn)));
    // ── 폴더·리스트·프로젝트 검색(#req, #665) — 트리 위 검색창. 이름으로 폴더/리스트/프로젝트 필터, 매칭 폴더는 자동 펼침.
    //  매칭 프로젝트는 소속 리스트 아래 결과 행으로(클릭=상세). 트리만 다시 그려 포커스 유지. ──
    const searchInput = el('input', { class: 'pjv-side-search-input', type: 'text', placeholder: '폴더·리스트·프로젝트 검색', 'aria-label': '폴더·리스트·프로젝트 검색' }) as HTMLInputElement;
    searchInput.value = sideSearchQ;
    const searchClear = el('button', { class: 'pjv-side-search-clear', type: 'button', title: '지우기', 'aria-label': '검색어 지우기', text: '×' });
    const searchBox = el('div', { class: 'pjv-side-search' }, pjvSideSearchIcon(), searchInput, searchClear);
    navInner.append(searchBox);
    const treeWrap = el('div', { class: 'pjv-side-tree' });
    navInner.append(treeWrap);
    // 빈 공간 드롭 = '최상위로 빼기' 였으나 폐지(#1067) — 리스트는 항상 스페이스 안에 있어야 한다.
    //  드롭을 조용히 무시하면 '왜 안 옮겨지지?' 가 되므로, 어디로 옮기면 되는지 알려준다.
    treeWrap.addEventListener('dragover', (ev) => { if (pjvSideDrag.kind === 'list') { ev.preventDefault(); try { ev.dataTransfer.dropEffect = 'none'; } catch (_) { /* */ } } });
    treeWrap.addEventListener('drop', (ev) => { if (pjvSideDrag.kind !== 'list') return; ev.preventDefault(); pjvSideDrag.kind = null; pjvSideDrag.id = null; toast('리스트는 스페이스·폴더 안에만 둘 수 있어요 — 스페이스나 폴더 위에 놓아 주세요'); });
    // 폴더들(캐럿+폴더아이콘) › (하위 폴더 재귀 #541) › 리스트(파일). '전체' 제거(#473 후속) — 기본은 맨 위 폴더 진입.
    //  폴더는 드래그로 재정렬·리스트 드롭 타깃. depth 는 들여쓰기(중첩 폴더 — ClickUp Space›Folder 이관 시 2층).
    const renderFolderNode = (f, depth) => {
      // 검색 중이면 매칭 안 되는 폴더 서브트리는 건너뛴다(자기 이름 또는 하위 폴더/리스트 매칭).
      if (sideSearchActive() && !folderMatchesDeep(f)) return;
      const open = sideSearchActive() ? true : isFolderOpen(f.id); // 검색 중엔 강제 펼침
      const fkey = 'F' + f.id;
      // Space(#541 — ClickUp 이관 최상위) 는 폴더와 구분되는 스페이스 스타일: 색 사각 아바타(첫 글자) + 볼드 라벨.
      const isSpace = pjvFolderIsSpace(f);
      // 접힘/펼침 세모는 오른쪽 끝으로(#508) — 왼쪽에 두면 폴더 아이콘이 밀려 최상위 리스트와 어긋나 위계가 안 느껴진다.
      const caret = el('button', { class: 'pjv-side-folder-caret', type: 'button', 'aria-expanded': String(open), title: open ? '접기' : '펼치기', 'aria-label': open ? '접기' : '펼치기', text: open ? '▾' : '▸' });
      caret.addEventListener('click', (e) => { e.stopPropagation(); toggleFolder(f.id); });
      const glyph = isSpace
        ? el('span', { class: 'pjv-side-space-avatar', text: (String(f.name).trim()[0] || 'S').toUpperCase(), style: 'background:' + (f.color || avatarColor('space' + f.id)) })
        : pjvBundleIcon(f.color || 'var(--muted-2)');
      const fit = el('div', { class: 'pjv-side-navitem pjv-side-navfolder' + (isSpace ? ' pjv-side-navspace' : '') + (sel === fkey ? ' active' : ''), role: 'button', tabindex: '0', draggable: 'true' },
        glyph, el('span', { class: 'pjv-side-navlabel', text: f.name }), pjvVisLock(f), caret);
      pjvSideIndent(fit, depth); // 들여쓰기 격자 + 위계 세로선(#1067)
      fit.addEventListener('click', (e) => { e.stopPropagation(); if (!isFolderOpen(f.id)) pjvSetFolderOpen(f.id, true); selectArea(fkey); });
      const fmore = el('button', { class: 'pjv-side-navmore', type: 'button', title: '폴더 설정', 'aria-label': '폴더 설정', text: '⋯' });
      fmore.addEventListener('click', (e) => { e.stopPropagation(); const menu = el('div', { class: 'pjv-menu' }); const close = pjvPopover(fmore, menu); pjvFolderTreeMenu(menu, close, f, reload); });
      fit.append(fmore);
      // 드래그: 폴더를 잡아 순서 재정렬(kind='folder'). 리스트를 이 폴더로 드롭 = 그 폴더로 이동.
      fit.addEventListener('dragstart', (ev) => { pjvSideDrag.kind = 'folder'; pjvSideDrag.id = f.id; document.body.classList.add('pjv-side-dragging'); try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', 'F' + f.id); } catch (_) { /* */ } });
      fit.addEventListener('dragend', () => { pjvSideDrag.kind = null; pjvSideDrag.id = null; document.body.classList.remove('pjv-side-dragging'); document.querySelectorAll('.pjv-side-drop-over, .pjv-side-drop-before, .pjv-side-drop-after').forEach((n) => n.classList.remove('pjv-side-drop-over', 'pjv-side-drop-before', 'pjv-side-drop-after')); });
      pjvSideNavDrop(fit, {
        onList: (lid) => pjvMoveListToFolder(lid, f.id, reload),
        // 폴더→폴더 드롭(#541): 같은 부모(형제) 안에서만 순서 재정렬(커서 위/아래로 앞/뒤, 가로 삽입선) — 스페이스↔하위폴더 간 이동 오조작 방지.
        //  #766: 스페이스로 드롭하면 재정렬이 아니라 그 스페이스 하위로 '넣기'(중첩) — 삽입선 대신 하이라이트로 유도.
        reorderFolder: (fid) => {
          if (String(fid) === String(f.id)) return false;
          if (isSpace) return false; // 스페이스로는 '넣기'만(재정렬 삽입선 X)
          const d = folderList.find((x) => String(x.id) === String(fid));
          if (d && pjvFolderIsSpace(d)) return false; // 스페이스는 폴더 사이에 끼우지 않음
          return !!(d && String(d.parent_id ?? '') === String(f.parent_id ?? ''));
        },
        onFolder: (fid, after) => {
          if (String(fid) === String(f.id)) return;
          const dragged = folderList.find((x) => String(x.id) === String(fid));
          if (!dragged) return;
          if (isSpace) {
            // #766 스페이스로 드롭 = 그 스페이스 하위로 중첩. 스페이스 자신은 못 넣고, 이미 그 자식이면 무시.
            if (pjvFolderIsSpace(dragged)) { toast('스페이스는 다른 스페이스 안에 넣을 수 없어요', true); return; }
            if (String(dragged.parent_id ?? '') === String(f.id)) return;
            pjvMoveFolderToParent(dragged.id, f.id, reload);
            return;
          }
          const sameParent = String(dragged.parent_id ?? '') === String(f.parent_id ?? '');
          if (!sameParent) { toast('같은 위치의 폴더끼리만 순서를 바꿀 수 있어요', true); return; }
          const sibs = (foldersByParent.get(f.parent_id != null && folderIds.has(f.parent_id) ? f.parent_id : null) || []).map((x) => x.id);
          pjvReorderFolders(pjvMoveNear(sibs, fid, f.id, after), reload);
        },
      });
      treeWrap.append(fit);
      if (open) {
        const childFolders = foldersByParent.get(f.id) || [];
        for (const c of childFolders) renderFolderNode(c, depth + 1); // 하위 폴더 먼저(트리 위계)
        // 검색 중: 폴더 이름 자체가 매칭이면 하위 리스트 전부, 아니면 매칭 리스트(이름 또는 프로젝트 매칭 #665)만.
        const fLists = (listsByFolder.get(f.id) || []).filter((l) => !sideSearchActive() || folderSelfMatch(f) || listMatchesDeep(l));
        if (fLists.length) for (const l of fLists) { treeWrap.append(listNavItem(l, true, depth + 1)); appendProjMatches(searchProjsOf(l.id), depth + 2, 'L' + l.id); }
        else if (!childFolders.length && !sideSearchActive()) treeWrap.append(el('button', { class: 'pjv-side-folder-empty', type: 'button', onclick: (e) => { e.stopPropagation(); openListForm(reload, undefined, { folderId: f.id }); } }, el('span', { class: 'pjv-newlist-plus', text: '＋' }), el('span', { text: '리스트 추가' })));
      }
    };
    // 검색 매칭 헬퍼(#req) — 리스트는 이름, 폴더는 이름 또는 하위(재귀)에 매칭이 있으면.
    //  프로젝트도 검색(#665) — 이름/#번호가 매칭되는 프로젝트가 있으면 그 리스트를 노출하고,
    //  매칭 프로젝트를 리스트 아래 들여쓴 결과 행으로 보여준다(클릭 = 프로젝트 상세로).
    function sideSearchActive() { return !!(sideSearchQ && sideSearchQ.trim()); }
    function sideSearchNorm(s) { return String(s || '').toLowerCase(); }
    function sideQ() { return sideSearchQ.trim().toLowerCase(); }
    function listMatchesQ(l) { return !sideSearchActive() || sideSearchNorm(l.name).includes(sideQ()); }
    function projMatchesQ(p) { return sideSearchActive() && (sideSearchNorm(p.name).includes(sideQ()) || ('#' + p.id).includes(sideQ())); }
    function listMatchesDeep(l) { return listMatchesQ(l) || searchProjsOf(l.id).some(projMatchesQ); }
    function folderSelfMatch(f) { return sideSearchNorm(f.name).includes(sideQ()); }
    function folderMatchesDeep(f) {
      if (!sideSearchActive()) return true;
      if (folderSelfMatch(f)) return true;
      if (folderListsDeep(f.id).some(listMatchesDeep)) return true;
      return (foldersByParent.get(f.id) || []).some(folderMatchesDeep);
    }
    // 검색 결과 프로젝트 행(#665) — 상태 아이콘(커스텀 상태면 그 색) + 이름. 완료는 흐리게.
    function sideProjRow(p, depth) {
      const d = pjvResolveProjStatus(p);
      const ic = d ? pjvStatusIcon(d.category, d.color, d.frac, 'sm') : pjvStatusIconStd(p.status, 'sm');
      const it = el('div', { class: 'pjv-side-navitem pjv-side-navproj' + (p.status === 'done' ? ' done' : ''), role: 'link', tabindex: '0', title: p.name },
        ic, el('span', { class: 'pjv-side-navlabel', text: p.name }));
      pjvSideIndent(it, Math.max(depth, 1), 6); // 격자 + 세로선(#1067). 검색 결과 행은 6px 더 안쪽(리스트의 자식)
      const go = (e) => { e.stopPropagation(); location.hash = '#/projects2/p/' + p.id; };
      it.addEventListener('click', go);
      it.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') { e.preventDefault(); go(e); } });
      return it;
    }
    // 리스트 항목 아래 매칭 프로젝트 행 부착(#665) — 과다 노출 방지 상한 + 넘치면 'N개 더'.
    //  (#1154) 'N개 더'는 이제 **누를 수 있다** — 예전엔 "리스트를 눌러 보기"라고 안내만 했고, 실제로 리스트를 눌러
    //   들어가도 검색어가 따라가지 않아 나머지를 다시 찾아야 했다(완료 프로젝트는 Closed 가 꺼져 있으면 여전히 안 보였다).
    //   누르면 ① 그 리스트로 이동 ② 툴바 검색에 같은 키워드를 넣어 본문을 같은 조건으로 좁히고 ③ 완료도 보이게 켠다
    //   — 사이드바에서 세던 N 과 본문에서 보이는 수가 어긋나지 않는다.
    function appendProjMatches(projArr, depth, scopeKey?) {
      if (!sideSearchActive()) return;
      const ms = (projArr || []).filter(projMatchesQ);
      const MAX = 8;
      for (const p of ms.slice(0, MAX)) treeWrap.append(sideProjRow(p, depth));
      if (ms.length <= MAX) return;
      const rest = ms.length - MAX;
      const label = scopeKey ? `＋${rest}개 더 — 여기서 모두 보기` : `＋${rest}개 더`;
      const more = el('div', { class: 'pjv-side-navproj-more' + (scopeKey ? ' clickable' : ''), text: label, style: `padding-left:${8 + Math.max(depth, 1) * 14 + 6}px` });
      if (scopeKey) {
        more.setAttribute('role', 'link');
        more.setAttribute('tabindex', '0');
        more.title = `이 검색어로 좁힌 채 이동합니다 — 완료한 프로젝트도 함께 보입니다`;
        const go = (e) => {
          e.stopPropagation();
          pjvBoardSearch.q = sideSearchQ.trim();   // 툴바(뷰 내) 검색에 같은 키워드 — 본문이 같은 조건으로 좁혀진다
          searchOpen = true;                        // 검색어가 보이게 툴바 입력창을 펼친 채로
          pjvProjClosedView.done = true;            // 완료도 보이게(아니면 '＋N개'와 본문 수가 어긋난다)
          syncToggles();
          selectArea(scopeKey);                     // 그 리스트/미분류로 이동(URL push + render)
        };
        more.addEventListener('click', go);
        more.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
      }
      treeWrap.append(more);
    }
    // 📦 아카이브(#1067) — 트리 맨 아래(휴지통 바로 위) 고정 항목. 기본은 접힘(치워둔 것이라 평소 눈에 안 띄게),
    //  펼치면 일반 폴더와 똑같이 안의 폴더·리스트를 그린다(같은 renderFolderNode·listNavItem — 끌어내면 그대로 복귀).
    //  아카이브 폴더가 아직 없어도 항목은 늘 보인다: 첫 드롭 때 폴더를 만든다(pjvEnsureArchiveFolder).
    //  (#1176) 안의 개수는 **필터 이전 원본**으로 센다 — 아카이브는 '치워둔 보관함'이라 총량이 지금 보드를 어떻게
    //   좁혀 놨는지에 흔들리면 안 된다. 예전엔 groupByList(툴바 관문을 지난 집합)를 봐서, 툴바에 검색어·필터가
    //   걸려 있으면 개수가 0 이 되고 0 은 숫자를 아예 안 그리므로(아래 n ? ... : '') **안에 있는데도 '비었다'로 보였다**.
    const archiveProjects = () => (archiveFolder ? folderListsDeep(archiveFolder.id).flatMap((l) => searchProjsOf(l.id)) : []);
    const archiveHasMatch = () => !!archiveFolder
      && ((foldersByParent.get(archiveFolder.id) || []).some(folderMatchesDeep) || folderListsDeep(archiveFolder.id).some(listMatchesDeep));
    const renderArchiveNode = () => {
      const key = archiveFolder ? 'F' + archiveFolder.id : null;
      // 접힘/펼침은 폴더와 같은 저장소(pjvFolderOpen)를 쓰되 기본값만 반대(폴더=펼침, 아카이브=접힘).
      const open = !!archiveFolder && (sideSearchActive() || pjvIsFolderOpen(archiveFolder.id, false));
      const caret = el('button', { class: 'pjv-side-folder-caret', type: 'button', 'aria-expanded': String(open), title: open ? '접기' : '펼치기', 'aria-label': open ? '접기' : '펼치기', text: open ? '▾' : '▸' });
      //  ⚠ toggleFolder 를 쓰면 안 된다 — 그건 '기본 펼침'(isFolderOpen 기본 true) 전제라 첫 클릭이 false 를 써서 그대로 접힌 채다.
      caret.addEventListener('click', (e) => { e.stopPropagation(); if (!archiveFolder) return; pjvSetFolderOpen(archiveFolder.id, !open); render(); });
      // 개수는 Closed 토글·툴바 좁히기와 무관한 '전부'(#1176) — 아카이브엔 완료가 대부분이라 visCount 면 늘 0으로 보인다.
      const n = archiveProjects().length;
      const it = el('div', { class: 'pjv-side-navitem pjv-side-navfolder pjv-side-archive' + (key && sel === key ? ' active' : ''), role: 'button', tabindex: '0',
        title: '아카이브 — 다 지난 리스트·폴더·프로젝트를 여기로 끌어 치워둡니다(삭제 아님). 보드 목록에서 빠지고, 다시 끌어내면 원래대로 돌아옵니다.' },
        el('span', { class: 'pjv-side-archive-ico', 'aria-hidden': 'true', text: '📦' }),
        el('span', { class: 'pjv-side-navlabel', text: PJV_ARCHIVE_FOLDER_NAME }),
        el('span', { class: 'pjv-side-navcount', text: n ? String(n) : '' }),
        archiveFolder ? caret : null);
      const go = (e) => {
        e.stopPropagation();
        if (!archiveFolder) { toast('아카이브가 비어 있어요 — 리스트·폴더·프로젝트를 여기로 끌어다 놓으세요'); return; }
        pjvSetFolderOpen(archiveFolder.id, true);
        // 아카이브엔 완료 프로젝트가 대부분 — 들어갈 때 Closed 를 켜서 '있는데 안 보이는' 상황을 막는다(툴바에서 다시 끌 수 있음).
        pjvProjClosedView.done = true; syncToggles();
        selectArea(key);
      };
      it.addEventListener('click', go);
      it.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
      pjvArchiveDropTarget(it, { archive: () => archiveFolder, reload });
      treeWrap.append(it);
      if (archiveFolder && open) {
        for (const c of (foldersByParent.get(archiveFolder.id) || [])) renderFolderNode(c, 1);
        for (const l of (listsByFolder.get(archiveFolder.id) || [])) {
          if (sideSearchActive() && !listMatchesDeep(l)) continue;
          treeWrap.append(listNavItem(l, true, 1));
          appendProjMatches(searchProjsOf(l.id), 2, 'L' + l.id);
        }
      }
    };

    // 트리(폴더·리스트)만 다시 그린다 — 검색 입력 중 전체 보드 재렌더 없이 트리만 갱신해 입력 포커스 유지.
    const buildTree = () => {
      treeWrap.replaceChildren();
      // 검색 결과 건수(#1154) — 검색창이 상시 노출이라 검색어를 남긴 채 다른 리스트를 다녀오기 쉽다.
      //  '트리가 왜 이것뿐인지'를 한 줄로 알린다. 프로젝트 행은 리스트당 8개까지만 보이므로(appendProjMatches MAX),
      //  여기 숫자는 화면에 그려진 수가 아니라 **실제 매칭 수**다. 아카이브 폴더는 트리에 자기 이름으로는 안 뜨므로 뺀다.
      if (sideSearchActive()) {
        const nProj = lists.reduce((a, l) => a + searchProjsOf(l.id).filter(projMatchesQ).length, 0) + searchProjsUn.filter(projMatchesQ).length;
        const nList = lists.filter(listMatchesQ).length;
        const nFolder = folderList.filter((f) => !pjvFolderIsArchive(f) && folderSelfMatch(f)).length;
        if (nProj + nList + nFolder > 0) {
          treeWrap.append(el('div', { class: 'pjv-side-searchcount', 'aria-live': 'polite', text: `폴더 ${nFolder} · 리스트 ${nList} · 프로젝트 ${nProj}` }));
        }
      }
      // ⭐ 즐겨찾기(#670) — 즐겨찾기한 리스트를 맨 위 고정 구역에(폴더 안이든 밖이든 한자리로). 검색 중엔 생략(검색이 우선).
      //  본래 위치에도 그대로 남고, 여기 사본은 드래그 비활성(noDrag) — 빠른 접근용 핀.
      //  #1113 후속: 구역이 '트리 위 작은 라벨'이라 위계가 안 읽혔다 → 스페이스급 섹션 헤더(별 SVG + 라벨 + 개수 + 캐럿)로
      //  올리고, 즐겨찾기 리스트는 sub/depth 1 로 들여써 그 아래 소속임을 격자·세로선으로 드러낸다(폴더›리스트와 같은 언어).
      //  헤더 클릭 = 접기/펼치기(localStorage 영속) — 즐겨찾기는 스코프가 아니라 구역이라 선택 대상이 아니다.
      if (!sideSearchActive()) {
        const favLists = lists.filter((l) => favListIds.has(l.id));
        if (favLists.length) {
          const open = pjvFavSecOpen();
          const caret = el('button', { class: 'pjv-side-folder-caret', type: 'button', 'aria-expanded': String(open),
            title: open ? '접기' : '펼치기', 'aria-label': open ? '접기' : '펼치기', text: open ? '▾' : '▸' });
          const head = el('div', { class: 'pjv-side-navitem pjv-side-favsec', role: 'button', tabindex: '0', 'aria-expanded': String(open),
            title: '즐겨찾기 — 리스트 ⋯ 메뉴에서 추가하면 여기 맨 위에 고정됩니다' },
            pjvTbIcon('star-on', 'pjv-side-favsec-ic'),
            el('span', { class: 'pjv-side-navlabel', text: '즐겨찾기' }),
            el('span', { class: 'pjv-side-navcount', text: String(favLists.length) }),
            caret);
          const toggleFav = (e) => { e.stopPropagation(); pjvSetFavSecOpen(!open); buildTree(); };
          head.addEventListener('click', toggleFav);
          caret.addEventListener('click', toggleFav);
          head.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFav(e); } });
          treeWrap.append(head);
          if (open) for (const l of favLists) treeWrap.append(listNavItem(l, true, 1, { noDrag: true }));
          treeWrap.append(el('div', { class: 'pjv-side-favsep', 'aria-hidden': 'true' }));
        }
      }
      for (const f of rootFolders) renderFolderNode(f, 0);
      // 최상위(폴더 없는) 리스트 — 이름 매칭 또는 안의 프로젝트 매칭(#665)이면 노출 + 매칭 프로젝트 행.
      for (const l of topLists) if (listMatchesDeep(l)) { treeWrap.append(listNavItem(l, false)); appendProjMatches(searchProjsOf(l.id), 1, 'L' + l.id); }
      // 미분류('기타') — 검색 중엔 '기타/미분류' 문자열 매칭 또는 미분류 프로젝트 매칭(#665)일 때.
      //  (#1154) 검색 중 노출 판정은 showUn(툴바 필터를 지난 값)이 아니라 원본 미분류 프로젝트로 한다 —
      //   필터에 걸려 보드에서 빠진 미분류 프로젝트도 트리 검색으로는 찾아갈 수 있어야 한다. 카운트는 그대로 '보이는 수'.
      const unSearchHit = sideSearchActive() && (sideSearchNorm('기타 미분류').includes(sideQ()) || searchProjsUn.some(projMatchesQ));
      if (sideSearchActive() ? unSearchHit : showUn) {
        const unKey = '__none__';
        const uit = el('div', { class: 'pjv-side-navitem pjv-side-navlist' + (sel === unKey ? ' active' : ''), role: 'button', tabindex: '0' },
          pjvBundleIcon(null, 'none'), el('span', { class: 'pjv-side-navlabel', text: '기타 (미분류)' }), el('span', { class: 'pjv-side-navcount', text: String(unGroup ? visCount(unGroup.projects) : 0) }));
        uit.addEventListener('click', (e) => { e.stopPropagation(); selectArea(unKey); });
        pjvFolderDropTarget(uit, null, reload);
        treeWrap.append(uit);
        appendProjMatches(searchProjsUn, 1, '__none__');
      }
      // 📦 아카이브(#1067) — 평소엔 늘 고정 노출(휴지통 바로 위), 검색 중엔 안에 매칭이 있을 때만(펼친 채로).
      if (!sideSearchActive() || archiveHasMatch()) renderArchiveNode();
      if (sideSearchActive()) {
        if (!treeWrap.querySelector('.pjv-side-navitem')) treeWrap.append(el('div', { class: 'pjv-side-empty', text: '검색 결과가 없습니다' }));
        return; // 검색 중엔 드롭존·새 폴더/리스트 버튼 숨김
      }
      // (#670) '여기로 끌어 폴더 밖으로 빼기' 드롭존 박스 제거 — 폴더 안 리스트를 왼쪽으로 끌면 인라인 아웃덴트(pjvSideNavDrop onOutdent)로 폴더 밖.
      //  빈 곳 드롭 → 최상위 는 treeWrap 의 dragover/drop 이 폴백으로 계속 처리.
      // 휴지통 — 상단 헤더 줄에서 내려 사이드바 폴더형 항목으로(#670). 새 폴더/새 리스트 버튼 '위'에 배치.
      const trashItem = el('a', { class: 'pjv-side-navitem pjv-side-navfolder pjv-side-trash', href: '#/trash', title: '삭제한 프로젝트·지식·카테고리 복원 (휴지통) — 리스트·폴더·프로젝트를 여기로 끌어 삭제할 수 있어요' },
        el('span', { class: 'pjv-side-navtrash-ico', 'aria-hidden': 'true', text: '🗑' }), el('span', { class: 'pjv-side-navlabel', text: '휴지통' }));
      pjvTrashDropTarget(trashItem, lists, folderList, reload); // #1020 리스트·폴더·프로젝트를 끌어와 놓으면 삭제
      treeWrap.append(trashItem);
      // (#1067) 예전의 '＋ 새 스페이스/폴더/리스트' 3버튼 줄은 헤더의 ＋ 메뉴로 올라갔다(클릭업 파리티).
    };
    buildTree();
    // 검색 입력 → 트리만 재빌드(포커스 유지). × 로 지움.
    searchInput.addEventListener('input', () => { sideSearchQ = searchInput.value; searchBox.classList.toggle('has-q', !!searchInput.value); buildTree(); });
    //  Esc — 검색어만 지운다(#1154 — 검색창은 상시 노출이라 '접기'가 없다. 트리는 곧바로 전체로 돌아온다).
    searchInput.addEventListener('keydown', (e: any) => { if (e.key === 'Escape') { searchInput.value = ''; sideSearchQ = ''; searchBox.classList.remove('has-q'); buildTree(); } });
    searchClear.addEventListener('click', (e) => { e.stopPropagation(); searchInput.value = ''; sideSearchQ = ''; searchBox.classList.remove('has-q'); buildTree(); searchInput.focus(); });
    searchBox.classList.toggle('has-q', !!sideSearchQ);
    nav.append(navInner);
    if (noNav) { shellHost.replaceChildren(main); return; } // #662 — 스코프 유지 + 사이드바 없음: 같은 main 셸만(nav 제외)
    const sideWrap = el('div', { class: 'pjv-side-wrap' }, nav, main);
    try { const sw = localStorage.getItem('pjv:sideW'); if (sw) sideWrap.style.setProperty('--pjv-side-w', sw.indexOf('px') >= 0 ? sw : sw + 'px'); } catch (_) { /* noop */ }
    shellHost.replaceChildren(sideWrap);
  };

  // 본문에 폴더별 접이식 구역을 인라인으로 쌓기(#455) — '상태로 나누기'의 폴더판. 사이드바(byArea)와 달리 모든 폴더를 한 화면에.
  //  byStatus 면 각 폴더를 상태로 다시 나눔(폴더 › 상태 중첩). 빈 폴더도 노출(추가·드롭 타깃). 각 폴더 헤더의 ⋯ 로 설정/삭제(#453).
  const renderByFolder = (byStatus) => {
    const groups = pjvBuildListGroups(boardProjects(), boardLists(), mineIds, meId); // 아카이브 안 리스트는 제외(#1067)
    const visCount = (arr) => pjvProjClosedView.done ? arr.length : arr.filter((p) => p.status !== 'done').length;
    // 실제 폴더는 비어도 노출(추가·드롭 타깃), '기타(미분류)'는 보일 게 있을 때만.
    const shown = groups.filter((g) => g.list || visCount(g.projects) > 0);
    body.replaceChildren();
    if (!shown.length) { body.append(el('div', { class: 'pjv-proj-empty', text: pjvBoardMineOnly.on ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.' })); return; }
    // 리스트마다 박스(#1067) — 폴더 스코프와 같은 표기. 그룹 기준도 그대로 따른다.
    const gb = (pjvGroupCtx && pjvGroupCtx.groupBy) || { field: 'status', dir: 1 };
    for (const g of shown) body.append(pjvListGroup(g, reload, canDelete, fields, anchorId, meId, taskCtx, true, false, { boxed: true, groupBy: gb }));
  };

  const render = () => {
    taskCtx.mode = pjvProjTaskMode.mode;
    // 정렬/그룹 컨텍스트 리셋(#541 리뷰) — 리스트 스코프(renderArea 의 selList)에서만 유효. 여기서 안 비우면
    //  다른 분기(상태/평면/폴더/칸반)와 상세 페이지의 헤더가 stale ctx 로 다른 리스트의 저장 정렬을 오염시킨다.
    setSortCtx(null);
    // 전체 보기(스코프 없음)에서도 그룹은 쓸 수 있다(#1067) — renderArea 로 가면 그쪽이 스코프 기준으로 덮어쓴다.
    const allGb = pjvGetGroupBy(null, null, '__all__');
    setGroupCtx({ selList: null, groupBy: allGb, rerender: render, enabled: true, scopeKey: '__all__' });
    pjvSyncGroupBtn(groupBtn, allGb, true, '__all__'); // 전체 보기 — 폴더 스코프가 아니라 '리스트로도 묶기'는 해당 없음
    const byArea = pjvBoardView.byArea, byStatus = pjvBoardView.byStatus, byFolder = pjvBoardView.byFolder;
    syncScopeChip();
    syncCrumbs();   // 브레드크럼(#1067) — 현재 스코프를 위치로 표시
    (viewTabs as any)._sync();  // 뷰 탭 활성 표시(#1067) — 설정 팝오버로 바꿔도 탭이 따라온다
    // 테이블 껍데기는 CSS 모드 하나로 — 어느 렌더 경로로 가든 여기서 한 번만 정한다(다른 뷰로 나갈 때 확실히 벗겨진다).
    body.classList.toggle('pjv-table-mode', !!pjvBoardView.table);
    pjvSetFilterUniverse(projects, lists); // 필터·담당자 팝오버의 값 후보(상태·사람·태그)를 현재 데이터로 갱신
    // WIKI 형 풀블리드 셸(#607)은 사이드바 여닫이와 무관하게 항상(#1067) — 접으면 '사이드바만' 사라지고
    //  제목·툴바·보드가 시작하는 y 는 그대로다. (예전엔 접을 때 카드형 배치로 갈아타 높이가 튀고 여백이 달라졌다.)
    card.classList.add('pjv-has-side');
    wrapper.replaceChildren(card);
    if (byArea) { renderArea(byStatus); return; } // 페이지크롬·툴바는 renderArea 가 우측 컬럼 상단에 넣는다
    // 스코프 유지(#662) — 사이드바에서 고른 리스트/폴더는 사이드바를 닫아도 그대로 보여준다(#1067: 접을 때 항상 유지).
    //  같은 renderArea 본문(개요·리스트묶음·커스텀 상태 그룹·리스트 컬럼·저장 뷰 포함)을 nav 없이 렌더 — 화면이 안 바뀐다.
    if (pjvScopeKept()) { renderArea(byStatus, true); return; }
    // 스코프 없음(전체 보기) — 같은 main 셸 안에 페이지크롬·툴바·표를 넣는다(사이드바만 없는 상태).
    const mainNo = el('div', { class: 'pjv-side-main pjv-side-main-nonav' });
    if (pageChrome) mainNo.append(pageChrome);
    mainNo.append(headerStack);
    mainNo.append(body);
    shellHost.replaceChildren(mainNo);
    if (byFolder) { renderByFolder(byStatus); return; }
    const base = boardProjects(); // 아카이브 안(#1067)은 전체 보기에서 제외 — 아카이브 스코프로 들어가야 보인다
    // 툴바 좁히기(#1067 필터·담당자·검색)는 '내 할당만' 과 같은 자리에서 한 번에 — 모든 하위 뷰가 같은 목록을 본다.
    const shown = pjvApplyToolbarFilters(pjvBoardMineOnly.on ? base.filter((p) => mineIds.has(p.id)) : base);
    if (pjvBoardView.kanban) { body.replaceChildren(pjvKanbanBoard(shown, null, { reload, canDelete })); return; } // 칸반(#541) — 전체 스코프는 표준 3버킷
    if (pjvBoardView.timeline) { body.replaceChildren(pjvTimelineView(shown, { reload, rerender: render, lists })); return; } // 타임라인(#1067)
    if (pjvBoardView.table) { renderTable(shown); return; }                                          // 테이블(#1067)
    if (byStatus) { renderStatus(shown); return; }
    renderFlat(shown);
  };

  // ── 스코프 칩(#662) — 사이드바를 닫고도 스코프(리스트/폴더/기타)만 보는 중임을 툴바에 표시 + × 로 전체 보기 복귀. ──
  const scopeChip = el('span', { class: 'pjv-scope-chip', title: '사이드바에서 고른 범위만 보는 중 — × 로 전체 보기' });
  const scopeName = (key) => {
    if (key === '__none__') return '기타 (미분류)';
    if (typeof key === 'string' && key[0] === 'L') { const l = lists.find((x) => String(x.id) === key.slice(1)); return l ? l.name : null; }
    if (typeof key === 'string' && key[0] === 'F') { const f = (folders || []).find((x) => String(x.id) === key.slice(1)); return f ? f.name : null; }
    return null;
  };
  const syncScopeChip = () => {
    const nm = (!pjvBoardView.byArea && !pjvBoardView.byFolder && pjvScopeKept()) ? scopeName(pjvSidebarSel.key) : null;
    scopeChip.replaceChildren();
    scopeChip.style.display = nm ? '' : 'none';
    if (!nm) return;
    scopeChip.append(el('span', { class: 'pjv-scope-chip-name', text: nm }));
    const x = el('button', { class: 'pjv-scope-chip-x', type: 'button', title: '전체 보기로', 'aria-label': '스코프 해제 — 전체 보기', text: '×' });
    x.onclick = (e) => { e.stopPropagation(); pjvSidebarSel.key = '__all__'; pjvSidebarSel.explicit = false; pjvExitAreaMode(); syncToggles(); render(); };
    scopeChip.append(x);
  };

  // 뷰/저장뷰 변경은 현재 스코프에 영속(#541) — 스코프가 살아있으면(사이드바 켜짐 or #662 스코프 유지 모드) 스코프별 저장.
  const rerenderScoped = () => { syncToggles(); if (pjvBoardView.byArea || (pjvSidebarSel.key && pjvSidebarSel.key !== '__all__')) pjvSaveScopeView(pjvSidebarSel.key, pjvSnapshotView()); render(); };
  savedViewBtn.onclick = (e) => { e.stopPropagation(); pjvSavedViewMenu(savedViewBtn, rerenderScoped); };
  // 사이드바 토글 — byArea 를 뒤집고, 열 땐 펼친 상태로 연다. 사이드바를 켜면 '폴더로 나누기'(인라인)는 끈다(상호배타).
  //  닫을 때 직접 고른 스코프(리스트/폴더)는 유지(#662) — 아니면 뷰 리셋(pjvExitAreaMode, #541 잔존뷰 누수 방지).
  sideBtn.onclick = (e) => { e.stopPropagation(); pjvBoardView.byArea = !pjvBoardView.byArea; if (pjvBoardView.byArea) { pjvBoardView.byFolder = false; } else { pjvKeepScopeOnCollapse(); } pjvPersistSideOpen(); syncToggles(); render(); };
  subtaskBtn.onclick = (e) => { e.stopPropagation(); pjvProjTaskMenu(subtaskBtn, () => { syncToggles(); render(); }); };
  mineBtn.onclick = (e) => { e.stopPropagation(); pjvMeModePopover(mineBtn, () => { syncToggles(); render(); }); };
  // 완료 표시 — 팝오버(프로젝트/태스크 각각). 예전의 '한 번 누르면 켜짐' 직접 토글은 ClickUp 파리티로 팝오버화.
  closedBtn.onclick = (e) => { e.stopPropagation(); pjvClosedPopover(closedBtn, () => { syncToggles(); render(); }); };
  filterBtn.onclick = (e) => { e.stopPropagation(); pjvFilterPopover(filterBtn, () => { syncToggles(); render(); }); };
  asgBtn.onclick = (e) => { e.stopPropagation(); pjvAssigneePopover(asgBtn, () => { syncToggles(); render(); }); };
  colsBtn.onclick = (e) => { e.stopPropagation(); pjvColumnsPopover(colsBtn, card, reload); };
  gearBtn.onclick = (e) => { e.stopPropagation(); pjvBoardSettingsPopover(gearBtn, { onView: rerenderScoped, isAlignLeft: pjvIsAlignLeft, setAlignLeft }); };
  // 검색 — 아이콘을 누르면 입력창이 펼쳐지고 포커스. 비어 있는 채로 닫으면 접힌다(Esc 도 동일).
  searchBtn.onclick = (e) => {
    e.stopPropagation();
    if (searchOpen && !pjvBoardSearch.q.trim()) { searchOpen = false; syncToggles(); return; }
    searchOpen = true; syncToggles(); searchInput.focus(); searchInput.select();
  };
  // (#1154) 이 입력창의 근본 제약 — render() 는 헤더 스택째로 DOM 을 옮겨 붙인다(shellHost.replaceChildren).
  //  입력마다 이 input 이 문서에서 떨어졌다 붙으므로 ① **포커스가 body 로 날아가고**(한 글자만 쳐지던 원인)
  //  ② **IME 조합 세션이 끊긴다**('터미널' → 'ㅌㅓㅁㅣㄴㅓㄹ' 로 자모가 분리되던 원인).
  //  ①은 렌더 뒤 포커스·커서를 되돌려 해결한다. ②는 '조합이 끝나면 그때 렌더'로는 부족했다 —
  //  한글 IME 는 글자 경계마다 compositionend 를 내고 **곧바로 다음 글자 조합을 시작**하는데, 그 틈에 렌더가 끼면
  //  막 시작된 조합이 깨져 앞 글자를 먹는다('터미'+'널' → '터널'). 그래서 **타이핑이 멈출 때까지 렌더를 미룬다**(디바운스).
  //  타이핑 중에는 값만 최신으로 들고 있다가 손이 멈추면 한 번 렌더 — 조합 경계와 절대 겹치지 않고 렌더 횟수도 준다.
  //  Enter 로 즉시 반영할 수 있다. (사이드바 검색은 buildTree 로 트리만 갈아 끼우므로 둘 다 겪지 않는다.)
  const SEARCH_DEBOUNCE_MS = 220;
  let searchComposing = false;
  let searchRenderedQ = '';
  let searchTimer: any = null;
  const cancelBoardSearchTimer = () => { if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; } };
  const applyBoardSearch = () => {
    cancelBoardSearchTimer();
    if (searchComposing) { scheduleBoardSearch(); return; }   // 아직 조합 중 — 렌더는 조합이 끝난 뒤로
    if (searchInput.value === searchRenderedQ) return;         // 이미 이 값으로 그려져 있다
    searchRenderedQ = searchInput.value;
    pjvBoardSearch.q = searchInput.value;
    const selS = searchInput.selectionStart, selE = searchInput.selectionEnd;
    syncToggles(); render();
    searchInput.focus();
    try { searchInput.setSelectionRange(selS, selE); } catch (_) { /* 브라우저가 막으면 포커스만 */ }
  };
  function scheduleBoardSearch() {
    cancelBoardSearchTimer();
    searchTimer = setTimeout(() => { searchTimer = null; applyBoardSearch(); }, SEARCH_DEBOUNCE_MS);
  }
  searchInput.addEventListener('compositionstart', () => { searchComposing = true; });
  searchInput.addEventListener('compositionend', () => { searchComposing = false; scheduleBoardSearch(); });
  searchInput.addEventListener('input', () => { pjvBoardSearch.q = searchInput.value; scheduleBoardSearch(); });
  searchInput.addEventListener('keydown', (e: any) => {
    // Enter — 디바운스를 기다리지 않고 즉시 반영(조합 확정용 Enter 는 흘려보낸다).
    if (e.key === 'Enter') { if (e.isComposing) return; e.stopPropagation(); applyBoardSearch(); return; }
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    cancelBoardSearchTimer();
    pjvBoardSearch.q = ''; searchInput.value = ''; searchRenderedQ = ''; searchOpen = false; syncToggles(); render();
  });
  // ＋ 프로젝트 — 현재 스코프(리스트)의 인라인 추가행으로 데려가 바로 이름을 치게 한다(모달 없이 한 동작).
  //  추가행이 없는 화면(칸반·개요 등)이면 새 프로젝트 폼으로 폴백.
  const scopeListId = () => (typeof pjvSidebarSel.key === 'string' && pjvSidebarSel.key[0] === 'L') ? Number(pjvSidebarSel.key.slice(1)) : undefined;
  addProjBtn.onclick = (e) => {
    e.stopPropagation();
    const trig = card.querySelector('.pjv-addrow-trigger') as HTMLElement | null;
    if (trig) { trig.scrollIntoView({ block: 'center', behavior: 'smooth' }); trig.click(); return; }
    openProjectV2Form(reload, { listId: scopeListId() });
  };
  addMoreBtn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(addMoreBtn, menu, { align: 'right' });
    const mk = (label, fn) => { const b = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { text: label })); b.onclick = (ev) => { ev.stopPropagation(); close(); fn(); }; return b; };
    menu.append(mk('새 프로젝트 (자세히)', () => openProjectV2Form(reload, { listId: scopeListId() })));
    menu.append(mk('새 리스트', () => openListForm(reload)));
    menu.append(mk('새 폴더', () => openFolderForm(reload)));
  };
  syncToggles();

  // ── 브레드크럼 줄(#1067) — 스페이스 › 폴더 › 리스트 + ⌄(설정) + ☆(즐겨찾기). 위치를 다루는 층. ──
  const crumbBar = el('div', { class: 'pjv-crumbbar' }, sideBtn);
  const crumbPath = el('nav', { class: 'pjv-crumbs', 'aria-label': '현재 위치' });
  crumbBar.append(crumbPath);
  const syncCrumbs = () => {
    const sel = pjvSidebarSel.key;
    const items: any[] = [];
    const root = el('button', { class: 'pjv-crumb pjv-crumb-root', type: 'button', title: '전체 프로젝트' }, el('span', { text: '프로젝트' }));
    root.onclick = (e) => { e.stopPropagation(); pjvSidebarSel.key = '__all__'; pjvSidebarSel.explicit = false; pjvExitAreaMode(); syncToggles(); render(); };
    items.push(root);
    // 현재 선택의 조상 사슬(폴더는 parent_id 로 위로) — 스페이스/폴더/리스트를 순서대로.
    const folderById = (id) => (folders || []).find((f) => String(f.id) === String(id));
    const chain: any[] = [];
    let leafList: any = null, leafFolder: any = null;
    if (typeof sel === 'string' && sel[0] === 'L') {
      leafList = lists.find((l) => String(l.id) === sel.slice(1)) || null;
      let f = leafList && leafList.folder_id != null ? folderById(leafList.folder_id) : null;
      while (f) { chain.unshift(f); f = f.parent_id != null ? folderById(f.parent_id) : null; }
    } else if (typeof sel === 'string' && sel[0] === 'F') {
      leafFolder = folderById(sel.slice(1)) || null;
      let f = leafFolder && leafFolder.parent_id != null ? folderById(leafFolder.parent_id) : null;
      while (f) { chain.unshift(f); f = f.parent_id != null ? folderById(f.parent_id) : null; }
    }
    const mkCrumb = (glyph, label, key, cls?) => {
      const b = el('button', { class: 'pjv-crumb' + (cls ? ' ' + cls : ''), type: 'button', title: label }, glyph, el('span', { class: 'pjv-crumb-label', text: label }));
      b.onclick = (e) => { e.stopPropagation(); pjvSidebarSel.key = key; pjvSidebarSel.explicit = true; pjvSyncUrl(key, false); render(); };
      return b;
    };
    for (const f of chain) {
      const glyph = pjvFolderIsSpace(f)
        ? el('span', { class: 'pjv-side-space-avatar', text: (String(f.name).trim()[0] || 'S').toUpperCase(), style: 'background:' + (f.color || avatarColor('space' + f.id)) })
        : pjvBundleIcon(f.color || 'var(--muted-2)');
      items.push(mkCrumb(glyph, f.name, 'F' + f.id));
    }
    if (leafFolder) {
      const glyph = pjvFolderIsSpace(leafFolder)
        ? el('span', { class: 'pjv-side-space-avatar', text: (String(leafFolder.name).trim()[0] || 'S').toUpperCase(), style: 'background:' + (leafFolder.color || avatarColor('space' + leafFolder.id)) })
        : pjvBundleIcon(leafFolder.color || 'var(--muted-2)');
      items.push(mkCrumb(glyph, leafFolder.name, 'F' + leafFolder.id, 'is-leaf'));
    }
    if (leafList) items.push(mkCrumb(pjvListGlyph(leafList), leafList.name, 'L' + leafList.id, 'is-leaf'));
    if (sel === '__none__') items.push(mkCrumb(pjvBundleIcon(null, 'none'), '기타 (미분류)', '__none__', 'is-leaf'));
    // 구분자(/)를 끼워 넣고, 잎 옆에 ⌄(설정 메뉴)·☆(즐겨찾기)를 붙인다.
    const nodes: any[] = [];
    items.forEach((it, i) => { if (i) nodes.push(el('span', { class: 'pjv-crumb-sep', 'aria-hidden': 'true', text: '/' })); nodes.push(it); });
    const leaf = leafList || leafFolder;
    if (leaf) {
      const menuBtn = el('button', { class: 'pjv-crumb-menu', type: 'button', title: (leafList ? '리스트' : pjvFolderIsSpace(leaf) ? '스페이스' : '폴더') + ' 설정', 'aria-label': '설정 메뉴' }, pjvTbIcon('caret', 'sm'));
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjv-listset-menu' });
        const close = pjvPopover(menuBtn, menu);
        if (leafList) pjvListSettingsMenu(menu, close, leafList, reload);
        else pjvFolderTreeMenu(menu, close, leafFolder, reload);
      };
      nodes.push(menuBtn);
      if (leafList) {
        const favIds = new Set<number>(((favData && favData.project_lists) || []).map((x: any) => Number(x)));
        const isFav = favIds.has(Number(leafList.id));
        const star = el('button', { class: 'pjv-crumb-fav' + (isFav ? ' on' : ''), type: 'button', title: isFav ? '즐겨찾기 해제' : '즐겨찾기에 추가', 'aria-label': isFav ? '즐겨찾기 해제' : '즐겨찾기에 추가', 'aria-pressed': String(isFav) }, pjvTbIcon(isFav ? 'star-on' : 'star'));
        star.onclick = async (e) => {
          e.stopPropagation();
          const next = !isFav;
          if (next) favIds.add(Number(leafList.id)); else favIds.delete(Number(leafList.id));
          if (favData) favData.project_lists = [...favIds];
          render();
          try { await pjvSetFavorite('project_list', leafList.id, next); }
          catch (err: any) { toast('즐겨찾기 저장 실패 — ' + (err && err.message || err), true); reload(); }
        };
        nodes.push(star);
      }
    }
    crumbPath.replaceChildren(...nodes);
  };

  // 툴바 — 사이드바 여닫이와 무관하게 늘 셸 본문 컬럼 상단(#607/#1067). render() 가 그때그때 main 에 얹는다.
  //  좌(데이터 구조: 그룹·계층·열) / 우(데이터 좁히기 + 생성) 로 역할을 가른다.
  const toolbar = el('div', { class: 'card-head pjv-board-toolbar' },
    el('div', { class: 'pjv-tasks-head-left' }, groupBtn, subtaskBtn, colsBtn, scopeChip),
    el('div', { class: 'card-head-actions' }, filterBtn, closedBtn, asgBtn, mineBtn, searchBox,
      el('span', { class: 'pjv-tb-sep', 'aria-hidden': 'true' }), gearBtn, savedViewBtn, addGroup));
  // 상단 헤더 스택 — ① 브레드크럼 ② 뷰 탭 ③ 툴바.
  //  뷰 탭은 rerenderScoped 로 전환한다(설정 팝오버의 '보기 방식'과 같은 경로 — 스코프별 뷰 영속 포함).
  const viewTabs = pjvViewTabsRow({ onView: () => rerenderScoped() });
  const headerStack = el('div', { class: 'pjv-board-header' }, crumbBar, viewTabs, toolbar);
  card.append(shellHost);
  render();
  return wrapper;
}

// 컬럼 헤더 한 줄(카드 상단) — pjvProjRow 와 같은 그리드. 첫 칸은 '프로젝트' 라벨, 나머지는 팀원/마감/우선/세션 + 커스텀 + (＋컬럼).
function pjvListColHead(fields, anchorId, reload, listId?) {
  const headEl = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols pjv-list-colhead' },
    el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-list-colhead-name', text: '프로젝트' }), pjvNameResizeHandle()),
    pjvStdColHead('proj', 'team', '팀원'),
    pjvStdColHead('proj', 'due', '마감일'),
    pjvStdColHead('proj', 'start', '시작일'),
    pjvStdColHead('proj', 'created', '생성일'),
    pjvStdColHead('proj', 'updated', '갱신일'),
    pjvStdColHead('proj', 'priority', '우선순위'),
    pjvStdColHead('proj', 'sess', '내 세션'),
    ...(fields || []).map((f) => pjvColumnHead(f, anchorId, reload)),
    el('div', { class: 'pjv-tcell pjv-tcell-add' }, anchorId ? pjvAddColumnButton(anchorId, reload, listId) : el('span', {})));
  headEl.style.gridTemplateColumns = pjvProjGridTemplate(fields);
  pjvApplyColOrder(headEl, 'proj', fields);                 // 열 순서 적용(#611)
  pjvWireColReorder(headEl, 'proj', fields || [], reload);  // 열 순서 드래그 재정렬(기본+커스텀, #611)
  return headEl;
}

// ════════════════════════════════════════════
// 프로젝트 목록(클릭업식 리스트) — 카드 대신 태스크 리스트와 동일한 그룹/행 UI.
//  진행 중/완료 두 그룹(상태 동그라미·개수·캐럿) + 컬럼 헤더(팀원·갱신) + 프로젝트 한 줄.
//  이름 클릭=상세 이동, 상태 동그라미=진행↔완료 토글. 선택(일괄삭제) 모드면 앞에 체크박스.
//  ※ 상태 체계 자체(메타·커스텀 상태 defs·레지스트리·아이콘 SVG)는 projects/status.ts (#1313 R31).
// ════════════════════════════════════════════

// 프로젝트를 커스텀 상태로 변경 — 네이티브 status 투영 + status_raw(커스텀 키) 저장.
async function pjvSetProjStatusCustom(id, def, reload) {
  try {
    await api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: pjvNativeStatusOf(def.category), status_raw: def.key }) });
    toast('‘' + def.label + '’(으)로 옮겼습니다');
    pjvReloadKeepScroll(reload);
  } catch (e) { toast('실패 — ' + e.message, true); }
}

// '그룹' 버튼 라벨/강조 동기 — 그룹: <필드> (↑/↓). 리스트 미선택 스코프에선 비활성 표시.
function pjvSyncGroupBtn(btn, gb, enabled, scopeKey?) {
  const lbl = btn.querySelector('.pjv-view-btn-label');
  const f = PJV_GROUPBY_FIELDS.find((x) => x.key === gb.field);
  // #req 폴더·스페이스에서 '리스트로도 묶기'를 끄면 라벨에 그 사실을 붙인다 — 팝오버를 열지 않아도
  //  리스트 박스가 사라진 이유가 보이게(안 그러면 '왜 리스트가 안 나뉘지?'가 된다).
  const noList = pjvScopeIsFolder(scopeKey) && !pjvGetAlsoList(scopeKey);
  // ClickUp 파리티 — 알약 버튼에 그룹 기준 필드명만(방향은 화살표로). '그룹:' 접두어는 아이콘이 대신한다.
  if (lbl) lbl.textContent = (f ? f.label : '상태') + (gb.dir === -1 ? ' ↓' : '') + (noList ? ' · 리스트 안 나눔' : '');
  btn.classList.toggle('active', !!(enabled && (gb.field !== 'status' || gb.dir === -1 || noList)));
  // 쓸 수 없는 스코프(폴더·전체)에선 disabled 대신 '흐리게 + aria-disabled'(#1067) — 진짜 disabled 면 클릭이
  //  이벤트조차 안 나서 '눌러도 아무 일이 없다'로만 보인다. 눌리면 왜 못 쓰는지 토스트로 알려준다.
  btn.disabled = false;
  btn.classList.toggle('is-off', !enabled);
  btn.setAttribute('aria-disabled', String(!enabled));
  btn.title = '그룹 — 필드와 방향으로 묶어 보기 (ClickUp group by)';
}
// '그룹' 팝오버(#1067 ClickUp Group by 파리티) — [기준 필드 ⌄] [오름/내림 ⌄] [🗑 기본값으로].
//  한 줄 안에 필드·방향·해제를 나란히 둬서 '무엇으로 어떻게 묶는지'가 한눈에 보인다(예전엔 세로 메뉴 나열).
function pjvGroupByMenu(anchor) {
  const ctx = pjvGroupCtx;
  if (!ctx) return;
  const pop = el('div', { class: 'pjv-menu pjv-groupby-pop' });
  pjvPopover(anchor, pop);
  const line = el('div', { class: 'pjv-groupby-line' });
  pop.append(el('div', { class: 'pjv-closed-pop-head', text: '그룹 기준' }), line,
    el('div', { class: 'pjv-menu-hint', text: '기본값 = 이 리스트의 뷰 설정(ClickUp 이관 포함)' }));
  // #req 폴더·스페이스에서만 '리스트로도 묶기'(ClickUp Also group by List). 끄면 리스트 박스가 사라지고
  //  이 폴더 아래 프로젝트가 한 덩어리로 위 그룹 기준으로만 묶인다.
  if (pjvScopeIsFolder(ctx.scopeKey)) { // 폴더·스페이스(F…)일 때만 — 리스트 스코프는 이미 그 리스트 하나뿐이라 무의미
    pop.append(el('div', { class: 'pjv-groupby-sep' }));
    pop.append(pjvSwitchRow('리스트로도 묶기',
      () => pjvGetAlsoList(ctx.scopeKey),
      (v) => pjvSetAlsoList(ctx.scopeKey, v),
      () => ctx.rerender()));
  }
  const mkSel = (label, cls, onOpen) => {
    const b = el('button', { class: 'pjv-filter-sel ' + cls, type: 'button' }, el('span', { class: 'pjv-filter-sel-label', text: label }), pjvTbIcon('caret', 'sm'));
    b.onclick = (e) => { e.stopPropagation(); onOpen(b); };
    return b;
  };
  const cur = () => (pjvGroupCtx && pjvGroupCtx.groupBy) || ctx.groupBy;
  // 고르면 보드만 다시 그리는 게 아니라 **이 팝오버도 다시 그린다** — 안 그러면 기준을 바꿔도
  //  팝오버 라벨이 옛 값 그대로라 '눌러도 안 바뀐다'로 보인다. 팝오버는 열어 둔 채 연속 조작(ClickUp 동형).
  const apply = (v) => { pjvSetGroupBy(ctx.selList, v, ctx.scopeKey); ctx.rerender(); paint(); };
  function paint() {
    line.replaceChildren();
    const f = PJV_GROUPBY_FIELDS.find((x) => x.key === cur().field);
    line.append(mkSel(f ? f.label : '상태', 'pjv-groupby-field', (b) => {
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(b, menu);
      for (const o of PJV_GROUPBY_FIELDS) {
        const on = cur().field === o.key;
        const it = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
          el('span', { text: o.label }), el('span', { class: 'pjv-menu-check', text: on ? '✓' : '' }));
        it.onclick = (e) => { e.stopPropagation(); close(); apply({ field: o.key, dir: cur().dir }); };
        menu.append(it);
      }
    }));
    line.append(mkSel(cur().dir === -1 ? '내림차순' : '오름차순', 'pjv-groupby-dir', (b) => {
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(b, menu);
      for (const o of [{ d: 1, l: '오름차순' }, { d: -1, l: '내림차순' }]) {
        const on = cur().dir === o.d;
        const it = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
          el('span', { text: o.l }), el('span', { class: 'pjv-menu-check', text: on ? '✓' : '' }));
        it.onclick = (e) => { e.stopPropagation(); close(); apply({ field: cur().field, dir: o.d }); };
        menu.append(it);
      }
    }));
    const reset = el('button', { class: 'pjv-filter-del', type: 'button', title: '뷰 기본값으로 되돌리기', 'aria-label': '그룹 기준 초기화' }, pjvTbIcon('trash', 'sm'));
    reset.onclick = (e) => { e.stopPropagation(); apply(null); };
    line.append(reset);
  }
  paint();
}


// (옛 pjvProjTeamView — 보기 전용 팀원 팝오버 — 폐기(#req): 상세 프로퍼티도 pjvProjTeamControl 로 바로 편집.)


// 프로젝트 팀원 저장 — 전체 멤버 id 목록을 통째로 보낸다(setProjectMembers = 전체 교체). 조용히(토스트만).
//  #1313 R33 — 옆의 행 인라인 컨트롤(pjvProjTeamControl·projPatch…)은 projects/rows.ts 로 갔지만 이 한 줄은
//  남겼다: 세 면(벌크바=selection.ts · 행=rows.ts · 상세 메타패널=이 파일)이 공유하는 쓰기 경로라, rows.ts 에
//  두면 selection→rows 역참조가 생겨 순환이 2건 더 늘어난다(위 배럴 중계로 두 모듈 모두 여기서 받는다).
// (팀원 저장 pjvSaveProjMembers 는 #1404 에서 projects/task-controls.ts 로 내려갔다 — 이 모듈은 정의·재수출만
//  했을 뿐 호출하지 않았고, 읽는 쪽 셋(rows·selection·detail-meta)이 배럴을 되짚는 사유로만 남아 있었다.)

// ════════════════════════════════════════════
// 태스크(클릭업형 리스트뷰) — 상태 그룹(할 일/진행 중/완료) + 컬럼(담당자·마감일·우선순위) + 인라인 편집.
//  상위 태스크만 상태로 그룹핑하고, 하위는 부모 아래 중첩(자기 상태는 점으로 표시하되 재그룹 안 함 — 클릭업 동형).
//  모든 필드 편집은 POST /api/ui/v6/tasks/:id(task_update_v6) 패치 — 변경 후 reload()로 재페인트(기존 토글과 동일).
//  ※ 표준 상수·날짜 헬퍼는 projects/status.ts, 인라인 컨트롤(상태·담당자·마감일·우선순위)은
//   projects/task-controls.ts 로 이관 — 이 파일엔 행·그룹·추가행 등 '리스트 조립'만 남는다(#1313 R31).
// ════════════════════════════════════════════
// (태스크 모달 상태 pill pjvTaskModalStatusField 는 #1404 에서 taskmodal/fields.ts 로 내려갔다 — 읽는 쪽이
//  거기 하나뿐이었고 이 모듈은 정의·재수출만 했지 호출하지 않았다. 그걸로 taskmodal/fields 가 배럴을 되짚을
//  마지막 사유가 사라졌다.)

// (현재 보드의 커스텀 필드 pjvBoardFieldsCur 는 #1313 R36 에서 **읽는 쪽인** projects/columns.ts 로 내렸다 —
//  여기선 세터 setBoardFieldsCur 로 값만 세운다. 드래그 싱글턴 둘(pjvFolderDrag·pjvSideDrag)은 #1404 에서
//  projects/state.ts 로 내려갔다 — 읽는 쪽이 넷(여기·sidebar·rows·selection)이라 소비자 하강이 성립하지 않고,
//  값 자체가 보기 상태 싱글턴이라 그 리프가 원래 집이다. 그걸로 sidebar→projects 되짚기가 사라졌다.)

// 하위 태스크 표시 모드 메뉴 — 모드 싱글턴(pjvSubtaskMode·pjvProjTaskMode) 자체는 projects/state.ts (#1313 R31).
const PJV_SUBTASK_OPTS = [
  { key: 'collapsed', label: '접힘', hint: '기본 (하위는 캐럿으로 펼침)' },
  { key: 'expanded', label: '펼침', hint: '모든 하위를 펼쳐서 표시' },
  { key: 'separate', label: '분리', hint: '하위를 별도 행으로 표시' },
];
const PJV_SUBTASK_BTNLABEL = { collapsed: '하위 태스크', expanded: '펼침', separate: '분리' };
// Subtasks 버튼 메뉴 — 접힘/펼침/분리. 선택 시 모드 변경 후 onChange(재렌더).
function pjvSubtaskMenu(anchor, onChange) {
  const pop = el('div', { class: 'pjv-menu pjv-subtask-pop' });
  const close = pjvPopover(anchor, pop);
  pop.append(el('div', { class: 'pjv-subtask-pop-head', text: '하위 태스크 표시' }));
  for (const o of PJV_SUBTASK_OPTS) {
    const sel = pjvSubtaskMode.mode === o.key;
    const item = el('button', { class: 'pjv-menu-item pjv-subtask-item' + (sel ? ' sel' : ''), type: 'button' },
      el('span', { class: 'pjv-subtask-item-main' },
        el('span', { class: 'pjv-subtask-item-label', text: o.label }),
        el('span', { class: 'pjv-subtask-item-hint', text: o.hint })),
      sel ? el('span', { class: 'pjv-subtask-check', text: '✓' }) : null);
    item.onclick = () => { close(); if (pjvSubtaskMode.mode !== o.key) { pjvSubtaskMode.mode = o.key; onChange(); } };
    pop.append(item);
  }
}
// 프로젝트 보드의 '하위 태스크' 버튼 메뉴 — 태스크 박스와 동일 UI. 선택 시 pjvProjTaskMode 변경 후 onChange(재렌더).
function pjvProjTaskMenu(anchor, onChange) {
  const pop = el('div', { class: 'pjv-menu pjv-subtask-pop' });
  const close = pjvPopover(anchor, pop);
  pop.append(el('div', { class: 'pjv-subtask-pop-head', text: '하위 태스크 표시' }));
  for (const o of PJV_SUBTASK_OPTS) {
    const sel = pjvProjTaskMode.mode === o.key;
    const item = el('button', { class: 'pjv-menu-item pjv-subtask-item' + (sel ? ' sel' : ''), type: 'button' },
      el('span', { class: 'pjv-subtask-item-main' },
        el('span', { class: 'pjv-subtask-item-label', text: o.label }),
        el('span', { class: 'pjv-subtask-item-hint', text: o.hint })),
      sel ? el('span', { class: 'pjv-subtask-check', text: '✓' }) : null);
    item.onclick = () => { close(); if (pjvProjTaskMode.mode !== o.key) { pjvProjTaskMode.mode = o.key; onChange(); } };
    pop.append(item);
  }
}

// (토글 스위치 행 pjvSwitchRow 는 #1404 에서 projects/popover.ts 리프로 내려갔다 — 도메인을 모르는 표시
//  프리미티브라 그쪽이 집이고, 그 덕에 filters 가 이 모듈을 배럴로 되짚을 이유가 사라졌다.)

// ════════════════════════════════════════════════════════════════════════════
// 프로젝트 보드 상단 헤더(#1067) — ClickUp 파리티 3층 구조.
//   ① 브레드크럼   스페이스 › 폴더 › 리스트  + ⌄(설정 메뉴) + ☆(즐겨찾기)
//   ② 뷰 탭        보드 · 타임라인 · 테이블 · 리스트 · ＋뷰   (지금은 버튼·아이콘만 — 기능은 별도 작업)
//   ③ 툴바         좌: 그룹 · 하위태스크 · 컬럼   /   우: 필터 · 완료 · 담당자 · 나 · 검색 | 설정 · ＋프로젝트
//  예전엔 이 셋이 한 줄에 뒤섞여(제목 + 사이드바 + 스코프칩 + 필터 + 뷰 + 그룹 + 하위 + 정렬 + 내할당 + Closed)
//  '무엇이 위치이고 무엇이 보기 옵션인지' 구분이 안 됐다. 층을 나눠 위치(①)/보기(②)/데이터 좁히기(③)로 분리.
//  아이콘은 우리 톤(단색 라인 · currentColor · 컬러 이모지 금지)으로 직접 제작 — 형태만 ClickUp 과 맞춘다.
//  ②뷰 탭·③툴바의 실체(필터 엔진 · 팝오버 5종 · 뷰 탭 줄)는 web/projects/filters.ts 로 나갔다(#1313 R32).
//  이 파일에는 ①브레드크럼과 세 층을 조립하는 보드 렌더(pjvProjectListBoard)가 남는다.
// ════════════════════════════════════════════════════════════════════════════

// ── 공개 심볼 ──
//  · 라우터 진입: renderProjectsV2 (web/main.ts 가 배럴 web/projects.js 로 받는다)
//  · 배럴이 되짚어 중계하는 소유분: 표시모드 메뉴(PJV_SUBTASK_BTNLABEL·pjvSubtaskMenu) · 팀원 저장 ·
//    커스텀 상태 저장 · 태스크 모달 상태 pill.
//  ※ #1404 에서 넷이 여기를 떠났다 — 저장뷰 메뉴(→filters) · 스위치 행(→popover) · 드래그 싱글턴 둘(→state).
//   읽는 쪽이 하나뿐이거나(저장뷰) 도메인을 모르는 값·프리미티브(나머지)라 그 집이 따로 있었고, 옮기고 나니
//   filters·sidebar 가 배럴을 되짚을 이유가 사라졌다(순환 60 → 실측 갱신은 check-imports.mjs 주석 참조).
//  ※ 나머지(projectPageHead·pjvKanbanBoard·pjvProjectListBoard·pjvListColHead·pjvGroupByMenu·pjvSyncGroupBtn·
//   pjvSavedSortCmp·pjvCuFieldsCache·setBoardFieldsCur·PJV_SUBTASK_OPTS·pjvProjTaskMenu)는
//   이 모듈 내부용이다 — 밖에서 부르는 곳이 없다(noUnusedLocals 가 잔재 0 을 지킨다).
export {
  PJV_SUBTASK_BTNLABEL,
  pjvSetProjStatusCustom,
  pjvSubtaskMenu,
  renderProjectsV2,
};
