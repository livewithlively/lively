// projects.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { TOKEN_KEY, api, applyReveal, el, errorNote, lifecycleDot, pageHead, personFace, relTime, renderMarkdown, safeHref, selectFilter, state, sv, toast } from './core.js';
import { SPACE_LABEL, knInjectChip, knProvChip } from './wiki-data.js';   // #764 — knowledge.ts 해체(미사용 심볼 정리: knRow 등은 로컬 정의가 섀도잉하고 있었음)
import { activityTimelineRow } from './dashboard.js';
import { openProjectSessionsModal } from './sessions.js';   // #905 C1 — 프로젝트 세션 기록: 버튼→모달(터미널 섹션)
import { overlayBox, skeleton, skeletonRows } from './learn.js';
import { loadAdmin } from './admin.js';
import { field, overlay } from './admin.js';
import { PJV_TAG_NONE, pjvOpenTaskModal, pjvtmComposerToolbar } from './taskmodal.js';
import { saveTermCreatePrefs, termAutoApprovePref, termCreatePrefs } from './terminal.js';   // '실행 설정' 기억 공유(#673/#req — 세션 폼 프리필). 자동 승인 기억은 #782.
import { createBlockEditor } from './block-editor.js';   // #730 본문(프로젝트/태스크) 노션형 블록 에디터 — 슬래시 명령·이미지 붙여넣기


// ════════════════════════════════════════════
// 프로젝트(v2) #/projects2 — 맥락 = 카테고리 + 지식 + 프로젝트 중 '프로젝트'(= 맥락의 *변화*).
//  지식 탭과 대칭인 하위 탭: [대시보드 · 작업 현황 · 사업 · 제품 · 시스템].
//   · 대시보드 = 프로젝트 보드(level='project' 카드, 진행중/완료)
//   · 작업 현황 = 기존 #/dash(사람×AI 작업현황)를 하위 탭으로 흡수(renderDashboard 재사용)
//   · 사업·제품·시스템 = 카테고리(space)로 프로젝트를 훑는 2분할(지식 탭의 renderKnowledgeSpace 패턴 재사용)
//  데이터: GET /api/ui/v6/projects(보드·space목록)·/:id(상세) + POST .../status,/tasks,/members,/category,/knowledge,
//   POST /api/ui/v6/tasks/:id/status, GET /api/ui/categories(사이드바). (백엔드 projects-v6 — 이미 구현됨.)
// ════════════════════════════════════════════
const PJV_STATUS_LABEL = { active: '진행 중', done: '완료' };

// ── 인라인 편집(상태 아이콘·우선순위·담당자 등) 후 재렌더 시 스크롤 위치 보존 (#358) ──
//  상태 아이콘 클릭 등 인라인 편집은 전체 재페인트(reload)를 부른다. 기본 경로는 먼저 스켈레톤으로
//  교체하는데, 이때 문서 높이가 줄며 브라우저가 스크롤을 맨 위로 클램프 → '새로고침돼서 위로 강제이동'
//  되는 느낌을 준다. 아래 신호를 세팅해 두면 renderProjectV2Board/Detail 이 스켈레톤을 건너뛰고
//  (구 DOM 을 유지한 채 조용히 재페치) 재페인트 후 원래 스크롤 위치를 복원한다.
//  신호는 대상 렌더가 최상단에서 동기적으로 소비하며, 비대상 재로드(예: 태스크 모달 자체 재렌더)는
//  소비하지 않으므로 래퍼가 즉시 null 로 되돌려 다음 페이지 렌더로 새는 것(누수)을 막는다.
let _pjvKeepScrollY: any = null;
function pjvReloadKeepScroll(reload) {
  if (!reload) return;
  _pjvKeepScrollY = window.scrollY || window.pageYOffset || 0;
  const ret = reload();      // 대상 렌더가 최상단에서 신호를 동기 소비(스켈레톤 스킵)
  _pjvKeepScrollY = null;    // 미소비(비대상 재로드)면 여기서 즉시 해제 — 누수 방지
  return ret;
}
// 재페인트 후 스크롤 복원 — 하위 비동기 섹션(폴더·터미널·타임라인)은 재페인트 직후 스켈레톤이라
//  문서가 잠깐 짧아진다. 이때 한 번만 복원하면 목표 위치가 최대 스크롤로 클램프됐다가(위로 튐) 섹션이
//  로드되며 문서가 다시 커져도 스크롤은 그대로 남는다. 따라서 즉시 + 로드 창(≈1.2s) 동안 재적용하되,
//  목표에 도달하면(문서가 충분히 커지면) 즉시 멈춘다.
function pjvRestoreScroll(y) {
  if (y == null) return;
  let done = false;
  const apply = () => {
    if (done) return;
    window.scrollTo(0, y);
    if (Math.abs((window.scrollY || window.pageYOffset || 0) - y) <= 2) done = true; // 도달 → 종료
  };
  requestAnimationFrame(apply);
  for (const ms of [40, 120, 260, 500, 800, 1200]) setTimeout(apply, ms);
}

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
// ── 저장 뷰(#541) — project_view(ClickUp 이관 포함)를 보드에 적용. 세션 한정 상태(다른 보기 상태들과 동형). ──
//  적용 범위(보수적 — UI 불변식 우선): type board→상태로 나누기 / list→평면, 정렬(지원 필드만). 필터·컬럼은
//  데이터로 보존(project_view.config)하되 아직 미적용 — 툴팁·토스트로 존재를 알린다.
const pjvSavedView: { id: number | null; name: string; sort: { field: string; dir: number } | null } = { id: null, name: '', sort: null };

// ── 스코프별 뷰 상태(#541) — 리스트/폴더/스페이스마다 마지막 뷰(보기 모드 + 저장 뷰)를 각자 기억. localStorage 영속. ──
//  전역 globals(pjvBoardView/pjvSavedView)은 '현재 스코프의 live 뷰'를 담고, renderArea 진입 시 스코프 store 에서 로드한다.
function pjvScopeViewKey(k) { return 'pjv:scopeView:' + k; }
function pjvLoadScopeView(k) { try { return JSON.parse(localStorage.getItem(pjvScopeViewKey(k)) || 'null'); } catch (_) { return null; } }
function pjvSaveScopeView(k, v) { try { if (v == null) localStorage.removeItem(pjvScopeViewKey(k)); else localStorage.setItem(pjvScopeViewKey(k), JSON.stringify(v)); } catch (_) { /* noop */ } }
function pjvScopeIsFolder(k) { return typeof k === 'string' && k[0] === 'F'; }
// 스코프 기본 뷰 — 폴더/스페이스=개요(Overview), 그 외(리스트/미분류/전체)=상태로 나누기.
// 스코프 기본 뷰(#1067) — 폴더/스페이스도 '리스트 박스'로 연다(ClickUp 폴더 List 뷰).
//  예전 기본이던 개요(요약 카드)는 프로젝트가 한 줄도 안 보여서, 폴더에서 필터·그룹을 걸어도 아무 반응이 없는 것처럼 보였다.
//  개요는 없어지지 않고 톱니(보기 설정) → 보기 방식 → '개요' 로 언제든 돌아갈 수 있다.
function pjvDefaultView(_scopeKey) {
  return { overview: false, byStatus: true, kanban: false, savedViewId: null, savedViewName: '', savedViewSort: null };
}
function pjvSnapshotView() {
  return { kanban: !!pjvBoardView.kanban, byStatus: pjvBoardView.byStatus !== false, overview: !!pjvBoardView.overview,
    savedViewId: pjvSavedView.id, savedViewName: pjvSavedView.name, savedViewSort: pjvSavedView.sort };
}
function pjvApplyView(v) {
  pjvBoardView.kanban = !!(v && v.kanban);
  pjvBoardView.byStatus = !v || v.byStatus !== false;
  pjvBoardView.overview = !!(v && v.overview);
  pjvSavedView.id = (v && v.savedViewId) != null ? v.savedViewId : null;
  pjvSavedView.name = (v && v.savedViewName) || '';
  pjvSavedView.sort = (v && v.savedViewSort) || null;
}
// URL 딥링크(#541) — 현재 스코프를 해시로 반영해 새로고침·뒤로가기·직접이동 가능. pushState 는 hashchange 를
//  안 쏘므로 사이드바 클릭은 인메모리 render 유지(리페치 없음), 뒤로가기(hashchange)만 route 재실행.
function pjvScopeHash(key) {
  if (!key || key === '__all__') return '#/projects2';
  if (key === '__none__') return '#/projects2/none';
  if (key[0] === 'L') return '#/projects2/l/' + key.slice(1);
  if (key[0] === 'F') return '#/projects2/f/' + key.slice(1);
  return '#/projects2';
}
function pjvSyncUrl(key, replace) {
  const target = pjvScopeHash(key);
  if (location.hash === target) return;
  try { if (replace) history.replaceState(null, '', target); else history.pushState(null, '', target); } catch (_) { /* noop */ }
}
// 사이드바(스코프) 모드를 떠날 때(#541 리뷰) — 스코프 live 뷰 globals 를 전역 보드 기본으로 리셋 + URL 정리.
//  안 하면 마지막 스코프의 overview/kanban/저장뷰가 전역 '전체' 보드로 새어 flat/kanban·엉뚱한 정렬로 렌더된다.
function pjvExitAreaMode() {
  pjvApplyView(pjvDefaultView('__all__')); // byStatus=true, kanban/overview=false, savedView clear
  pjvSyncUrl('__all__', true);
}
// 사이드바 열림 선호 저장(#541 리뷰) — 기본 ON 이지만 사용자가 닫으면 새로고침 후에도 닫힌 채 유지(URL 은 못 담음).
function pjvPersistSideOpen() { try { localStorage.setItem('pjv:sideOpen', pjvBoardView.byArea ? '1' : '0'); } catch (_) { /* noop */ } }
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
// ClickUp view.sorting.fields[].field → 우리 정렬 필드(지원분만 — 나머지는 null=미적용).
function pjvMapClickUpSortField(f) {
  const m = { dueDate: 'due_date', due_date: 'due_date', startDate: 'start_date', start_date: 'start_date',
    priority: 'priority', name: 'name', dateCreated: 'created_at', date_created: 'created_at',
    dateUpdated: 'updated_at', date_updated: 'updated_at' };
  return m[f] || null;
}
// '뷰' 팝오버 — 현재 사이드바 스코프(리스트/폴더)의 저장 뷰 나열 + 적용/해제. lazy fetch(보드 로드 비용 0).
async function pjvSavedViewMenu(anchor, rerender) {
  const menu = el('div', { class: 'pjv-menu pjv-view-pop pjv-savedview-pop' });
  const close = pjvPopover(anchor, menu);
  menu.append(el('div', { class: 'pjv-menu-head', text: '저장된 뷰' }));
  const loading = el('div', { class: 'pjv-menu-item', text: '불러오는 중…' });
  menu.append(loading);
  const selKey = String(pjvSidebarSel.key || '');
  let qs = '';
  if (selKey[0] === 'L') qs = '?list_id=' + selKey.slice(1);
  else if (selKey[0] === 'F') qs = '?folder_id=' + selKey.slice(1);
  let views: any[] = [];
  try { const d = await api('/api/ui/v6/project-views' + qs); views = (d && d.views) || []; }
  catch (_) { loading.textContent = '뷰를 불러오지 못했습니다'; return; }
  loading.remove();
  const mkPlain = (label, on, sel) => { const it = el('div', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), role: 'button', tabindex: '0', text: label }); it.onclick = on; return it; };
  const isFolder = selKey[0] === 'F';
  if (isFolder) {
    // 폴더/스페이스(#541) — 개요/리스트묶음 전환. 개요=폴더 진입 기본(하위 요약 카드).
    menu.append(mkPlain('개요 (Overview)', () => { pjvApplyView({ overview: true, byStatus: false, kanban: false }); close(); rerender(); }, pjvBoardView.overview));
    menu.append(mkPlain('리스트 묶음', () => { pjvApplyView({ overview: false, byStatus: false, kanban: false }); close(); rerender(); }, !pjvBoardView.overview && !pjvBoardView.kanban && pjvSavedView.id == null));
  } else {
    menu.append(mkPlain('기본 보기', () => { pjvApplyView(pjvDefaultView(selKey)); close(); rerender(); }, pjvSavedView.id == null && !pjvBoardView.kanban && !pjvBoardView.overview));
  }
  if (!views.length) { if (!isFolder) menu.append(el('div', { class: 'pjv-menu-item pjv-savedview-empty', text: qs ? '이 스코프에 저장된 뷰가 없습니다' : '저장된 뷰가 없습니다' })); return; }
  for (const v of views) {
    const row = el('div', { class: 'pjv-menu-item pjv-savedview-item' + (pjvSavedView.id === v.id ? ' sel' : ''), role: 'button', tabindex: '0' });
    row.append(el('span', { class: 'pjv-savedview-name', text: v.name }));
    row.append(el('span', { class: 'pjv-savedview-type', text: String(v.type || 'list') }));
    if (v.external_system) row.append(el('span', { class: 'pjv-savedview-src', text: 'ClickUp' }));
    const cfg = v.config || {};
    const sf = cfg.sorting && Array.isArray(cfg.sorting.fields) ? cfg.sorting.fields[0] : null;
    const bits: string[] = [];
    if (cfg.grouping && cfg.grouping.field) bits.push('그룹: ' + cfg.grouping.field);
    if (sf) bits.push('정렬: ' + sf.field + (Number(sf.dir) === -1 ? ' ↓' : ' ↑'));
    const fc = cfg.filters && Array.isArray(cfg.filters.fields) ? cfg.filters.fields.length : 0;
    if (fc) bits.push('필터 ' + fc + '개');
    if (bits.length) row.title = bits.join(' · ');
    row.onclick = () => {
      pjvSavedView.id = v.id; pjvSavedView.name = String(v.name || '');
      // board 타입 → 칸반, location_overview → 개요(#541), 그 외(list 등)=평면/리스트묶음.
      const vt = String(v.type);
      pjvBoardView.kanban = vt === 'board';
      // 개요(location_overview)는 폴더/스페이스 스코프에서만 유효(렌더 브랜치가 selFolder 필요) — 리스트/미분류에선 평면 폴백(#541 리뷰).
      pjvBoardView.overview = vt === 'location_overview' && selKey[0] === 'F';
      pjvBoardView.byStatus = false;
      const mapped = sf ? pjvMapClickUpSortField(String(sf.field)) : null;
      pjvSavedView.sort = mapped ? { field: mapped, dir: Number(sf && sf.dir) === -1 ? -1 : 1 } : null;
      close(); rerender();
      toast('뷰 적용: ' + v.name + (fc ? ' — 필터 조건은 보존만 되고 아직 적용되지 않아요' : ''));
    };
    menu.append(row);
  }
}

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
  pjvSelReset(); // 화면 진입/재렌더 시 다중선택·하단 바 초기화(이전 화면 선택 잔존 방지)
  const keepY = _pjvKeepScrollY; _pjvKeepScrollY = null; // 인라인 편집 재렌더면 스켈레톤 스킵 + 스크롤 복원(#358)
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
  pjvRestoreScroll(keepY); // 인라인 편집 재렌더면 원래 스크롤 위치 복원(#358)
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
  pjvBoardFieldsCur = fields || []; // #710 확장 — 커스텀 컬럼 숨김 재조정·되살리기 패널이 참조할 현재 보드 필드.

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
  const taskCtx: any = { mode: pjvProjTaskMode.mode, fetchProjTasks, invalidate: (id) => taskCache.delete(id) };

  // ── 툴바 버튼(#1067 ClickUp 파리티) — 좌: 그룹·하위태스크·컬럼 / 우: 필터·완료·담당자·나·검색 | 설정·＋프로젝트 ──
  //  아이콘 전용 버튼은 title + aria-label 로 이름을 준다(라벨 없이도 무엇인지 알 수 있게).
  const iconBtn = (cls, label, icon) => el('button', { class: 'pjv-tb-btn ' + cls, type: 'button', title: label, 'aria-label': label }, icon);
  // '하위 태스크' — 접힘/펼침/분리(ClickUp Subtasks).
  const subtaskBtn = iconBtn('pjv-subtask-btn', '하위 태스크 표시 방식', pjvTbIcon('subtask'));
  // '나' — 내가 만든·참여한 프로젝트만(ClickUp Me mode). 내 아바타가 곧 버튼.
  const mineBtn = el('button', { class: 'pjv-tb-btn pjv-mine-btn', type: 'button', title: '나 — 내가 만든·참여한 프로젝트만 보기', 'aria-label': '내 프로젝트만 보기' },
    personFace(meId, 'pjv-ava', '나'));
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
  let sideSearchOpen = false; // 헤더 🔍 로 펼친 상태(#1067) — 검색어가 있으면 자동으로 펼친 것으로 본다
  let searchOpen = false;     // 툴바 🔍(뷰 내 검색) 펼침 상태 — 검색어가 있으면 계속 펼친 것으로 본다

  const syncToggles = () => {
    subtaskBtn.classList.toggle('active', pjvProjTaskMode.mode !== 'collapsed');
    subtaskBtn.title = '하위 태스크 표시 — ' + PJV_SUBTASK_BTNLABEL[pjvProjTaskMode.mode];
    closedBtn.classList.toggle('active', pjvProjClosedView.done || pjvClosedView.tasks);
    mineBtn.classList.toggle('active', pjvBoardMineOnly.on);
    mineBtn.setAttribute('aria-pressed', String(pjvBoardMineOnly.on));
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
    // ⭐ 즐겨찾기(#670) — favData(바깥 로드)에서 파생. listNavItem/buildTree 와 같은 스코프.
    const favListIds = new Set<number>(((favData && favData.project_lists) || []).map((x: any) => Number(x)));
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
    const defaultSel = () => (selCandidates.find((c) => c.has) || selCandidates[0] || { key: '__none__' }).key;
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
    const isFolderOpen = (fid) => pjvFolderOpen.has(fid) ? pjvFolderOpen.get(fid) : true;
    const toggleFolder = (fid) => { pjvFolderOpen.set(fid, !isFolderOpen(fid)); render(); };

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
    pjvSortCtx = selList ? { selList, colSort, rerender: render } : null;
    // 그룹은 어느 스코프에서든 바꿀 수 있다(#1067) — 폴더/스페이스면 각 리스트 박스 안에서 그 기준으로 묶인다.
    pjvGroupCtx = { selList, groupBy, rerender: render, enabled: true, scopeKey: sel };
    if (groupBtn) pjvSyncGroupBtn(groupBtn, groupBy, true);

    const main = el('div', { class: 'pjv-side-main' + (noNav ? ' pjv-side-main-nonav' : '') });
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
      const catBadge = el('span', { class: 'pjv-side-cat' + (cat ? ' pjv-side-cat-' + cat.space : ' none'),
        title: cat ? ('카테고리(도메인): ' + (cat.name || cat.key)) : '카테고리 미분류 — 리스트 설정에서 지정',
        text: cat ? (cat.name || cat.key) : '미분류' });
      const it = el('div', { class: 'pjv-side-navitem pjv-side-navlist' + (sub ? ' sub' : '') + (active ? ' active' : '') + (favListIds.has(list.id) ? ' is-fav' : ''), role: 'button', tabindex: '0', 'aria-pressed': String(active), ...(noDrag ? {} : { draggable: 'true' }) },
        pjvListGlyph(list), el('span', { class: 'pjv-side-navlabel', text: list.name }), catBadge,
        el('span', { class: 'pjv-side-navcount', text: String(grp ? visCount(grp.projects) : 0) }));
      pjvSideIndent(it, sub ? Math.max(depth, 1) : 0); // 들여쓰기 격자 + 위계 세로선(#1067) — 폴더·리스트 한 격자
      const go = (e) => { e.stopPropagation(); selectArea(key); };
      it.addEventListener('click', go);
      it.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
      // ⭐ 즐겨찾기 별(#670) — 리스트를 사이드바 맨 위 '즐겨찾기' 구역에 고정. 호버 노출, 즐겨찾기면 금색 항상 표시.
      it.append(pjvFavStar(favListIds.has(list.id), (next) => toggleListFav(list.id, next)));
      const more = el('button', { class: 'pjv-side-navmore', type: 'button', title: '리스트 설정', 'aria-label': '리스트 설정', text: '⋯' });
      more.addEventListener('click', (e) => { e.stopPropagation(); const menu = el('div', { class: 'pjv-menu pjv-listset-menu' }); const close = pjvPopover(more, menu); pjvListSettingsMenu(menu, close, list, reload); });
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
        // 인라인 아웃덴트(#670) — 폴더 안 리스트를 왼쪽으로 끌면 최상위(folder_id null)로. 이미 최상위면 no-op(가드).
        onOutdent: (lid) => { const d = lists.find((x) => String(x.id) === String(lid)); if (d && d.folder_id != null) pjvMoveListToFolder(lid, null, reload); },
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
    // 접기 글리프는 «(이중 꺾쇠) — 클릭업과 같은 기호. 채워진 ▲▼◀ 삼각형은 트리 캐럿(펼침/접힘) 몫이라 섞이면 헷갈린다.
    const collapseBtn = el('button', { class: 'pjv-side-collapse', type: 'button', title: '사이드바 닫기', 'aria-label': '사이드바 닫기', text: '«' });
    // 세모(◀) 닫기 — 직접 고른 스코프(리스트/폴더)는 유지한 채 nav 만 닫는다(#662). 자동 선택 스코프면 예전처럼
    //  전체 보드로(뷰 리셋 pjvExitAreaMode — 안 하면 URL·잔존뷰가 스코프에 남는다).
    collapseBtn.onclick = (e) => { e.stopPropagation(); pjvBoardView.byArea = false; pjvKeepScopeOnCollapse(); pjvPersistSideOpen(); syncToggles(); render(); };
    // ── 헤더 줄(#1067, 클릭업 파리티) — 라벨 + [🔍 검색] [◀ 접기] + [＋ ⌄ 새로 만들기]. 두 부류가 다르다:
    //  · 🔍·◀ = **호버로 드러나는** 무지 아이콘(평소엔 라벨만 보이게 조용히).
    //  · ＋ = **항상 보이는 흰 알약**(테두리+얕은 그림자) — 클릭업도 이것만 상시 노출한다. 생성은 늘 손에 닿아야 하니까.
    //  검색창은 평소 접혀 있고 🔍 를 눌러야 펼쳐진다(트리에 세로 공간을 더 준다). 검색어가 있으면 계속 펼친 채.
    //  ＋ 메뉴는 예전 트리 맨 아래 버튼 3개를 대체한다(맨 아래는 아카이브·휴지통 자리).
    const searchToggle = el('button', { class: 'pjv-side-head-btn', type: 'button', title: '폴더·리스트·프로젝트 검색', 'aria-label': '검색' }, pjvSideSearchIcon());
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
      el('span', { class: 'pjv-side-head-btns' }, searchToggle, collapseBtn, addBtn)));
    // ── 폴더·리스트·프로젝트 검색(#req, #665) — 트리 위 검색창. 이름으로 폴더/리스트/프로젝트 필터, 매칭 폴더는 자동 펼침.
    //  매칭 프로젝트는 소속 리스트 아래 결과 행으로(클릭=상세). 트리만 다시 그려 포커스 유지. ──
    const searchInput = el('input', { class: 'pjv-side-search-input', type: 'text', placeholder: '폴더·리스트·프로젝트 검색', 'aria-label': '폴더·리스트·프로젝트 검색' }) as HTMLInputElement;
    searchInput.value = sideSearchQ;
    const searchClear = el('button', { class: 'pjv-side-search-clear', type: 'button', title: '지우기', 'aria-label': '검색어 지우기', text: '×' });
    const searchBox = el('div', { class: 'pjv-side-search' }, pjvSideSearchIcon(), searchInput, searchClear);
    const syncSearchOpen = (focus?) => {
      const on = sideSearchOpen || !!sideSearchQ;
      searchBox.style.display = on ? '' : 'none';
      searchToggle.classList.toggle('active', on);
      if (on && focus) setTimeout(() => searchInput.focus(), 0);
    };
    searchToggle.onclick = (e) => {
      e.stopPropagation();
      sideSearchOpen = !(sideSearchOpen || !!sideSearchQ);
      if (!sideSearchOpen && sideSearchQ) { sideSearchQ = ''; searchInput.value = ''; searchBox.classList.remove('has-q'); buildTree(); }
      syncSearchOpen(true);
    };
    navInner.append(searchBox);
    syncSearchOpen();
    const treeWrap = el('div', { class: 'pjv-side-tree' });
    navInner.append(treeWrap);
    // 리스트를 빈 공간에 놓으면 최상위(폴더 밖)로 — 폴더/리스트 항목의 drop 은 stopPropagation 이라 '빈 곳' 드롭만 여기로.
    treeWrap.addEventListener('dragover', (ev) => { if (pjvSideDrag.kind === 'list') { ev.preventDefault(); try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* */ } } });
    treeWrap.addEventListener('drop', (ev) => { if (pjvSideDrag.kind !== 'list') return; ev.preventDefault(); const lid = pjvSideDrag.id; pjvSideDrag.kind = null; pjvSideDrag.id = null; pjvMoveListToFolder(lid, null, reload); });
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
        glyph, el('span', { class: 'pjv-side-navlabel', text: f.name }), caret);
      pjvSideIndent(fit, depth); // 들여쓰기 격자 + 위계 세로선(#1067)
      fit.addEventListener('click', (e) => { e.stopPropagation(); if (!isFolderOpen(f.id)) pjvFolderOpen.set(f.id, true); selectArea(fkey); });
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
        if (fLists.length) for (const l of fLists) { treeWrap.append(listNavItem(l, true, depth + 1)); appendProjMatches((groupByList.get(l.id)?.projects) || [], depth + 2); }
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
    function listMatchesDeep(l) { return listMatchesQ(l) || ((groupByList.get(l.id)?.projects) || []).some(projMatchesQ); }
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
    // 리스트 항목 아래 매칭 프로젝트 행 부착(#665) — 과다 노출 방지 상한 + 'N개 더'는 리스트 클릭 유도.
    function appendProjMatches(projArr, depth) {
      if (!sideSearchActive()) return;
      const ms = (projArr || []).filter(projMatchesQ);
      const MAX = 8;
      for (const p of ms.slice(0, MAX)) treeWrap.append(sideProjRow(p, depth));
      if (ms.length > MAX) treeWrap.append(el('div', { class: 'pjv-side-navproj-more', text: '＋' + (ms.length - MAX) + '개 더 — 리스트를 눌러 보기', style: `padding-left:${8 + Math.max(depth, 1) * 14 + 6}px` }));
    }
    // 📦 아카이브(#1067) — 트리 맨 아래(휴지통 바로 위) 고정 항목. 기본은 접힘(치워둔 것이라 평소 눈에 안 띄게),
    //  펼치면 일반 폴더와 똑같이 안의 폴더·리스트를 그린다(같은 renderFolderNode·listNavItem — 끌어내면 그대로 복귀).
    //  아카이브 폴더가 아직 없어도 항목은 늘 보인다: 첫 드롭 때 폴더를 만든다(pjvEnsureArchiveFolder).
    const archiveProjects = () => (archiveFolder ? folderListsDeep(archiveFolder.id).flatMap((l) => (groupByList.get(l.id)?.projects) || []) : []);
    const archiveHasMatch = () => !!archiveFolder
      && ((foldersByParent.get(archiveFolder.id) || []).some(folderMatchesDeep) || folderListsDeep(archiveFolder.id).some(listMatchesDeep));
    const renderArchiveNode = () => {
      const key = archiveFolder ? 'F' + archiveFolder.id : null;
      // 접힘/펼침은 폴더와 같은 저장소(pjvFolderOpen)를 쓰되 기본값만 반대(폴더=펼침, 아카이브=접힘).
      const open = !!archiveFolder && (sideSearchActive() || pjvFolderOpen.get(archiveFolder.id) === true);
      const caret = el('button', { class: 'pjv-side-folder-caret', type: 'button', 'aria-expanded': String(open), title: open ? '접기' : '펼치기', 'aria-label': open ? '접기' : '펼치기', text: open ? '▾' : '▸' });
      //  ⚠ toggleFolder 를 쓰면 안 된다 — 그건 '기본 펼침'(isFolderOpen 기본 true) 전제라 첫 클릭이 false 를 써서 그대로 접힌 채다.
      caret.addEventListener('click', (e) => { e.stopPropagation(); if (!archiveFolder) return; pjvFolderOpen.set(archiveFolder.id, !open); render(); });
      // 개수는 Closed 토글과 무관한 '전부' — 아카이브엔 완료가 대부분이라 visCount 면 늘 0으로 보인다.
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
        pjvFolderOpen.set(archiveFolder.id, true);
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
          appendProjMatches((groupByList.get(l.id)?.projects) || [], 2);
        }
      }
    };

    // 트리(폴더·리스트)만 다시 그린다 — 검색 입력 중 전체 보드 재렌더 없이 트리만 갱신해 입력 포커스 유지.
    const buildTree = () => {
      treeWrap.replaceChildren();
      // ⭐ 즐겨찾기(#670) — 즐겨찾기한 리스트를 맨 위 고정 구역에(폴더 안이든 밖이든 한자리로). 검색 중엔 생략(검색이 우선).
      //  본래 위치에도 그대로 남고(별 표시), 여기 사본은 드래그 비활성(noDrag) — 빠른 접근용 핀.
      if (!sideSearchActive()) {
        const favLists = lists.filter((l) => favListIds.has(l.id));
        if (favLists.length) {
          treeWrap.append(el('div', { class: 'pjv-side-favhead', 'aria-hidden': 'true' }, el('span', { class: 'pjv-side-favhead-ic', text: '⭐' }), el('span', { text: '즐겨찾기' })));
          for (const l of favLists) treeWrap.append(listNavItem(l, false, 0, { noDrag: true }));
          treeWrap.append(el('div', { class: 'pjv-side-favsep', 'aria-hidden': 'true' }));
        }
      }
      for (const f of rootFolders) renderFolderNode(f, 0);
      // 최상위(폴더 없는) 리스트 — 이름 매칭 또는 안의 프로젝트 매칭(#665)이면 노출 + 매칭 프로젝트 행.
      for (const l of topLists) if (listMatchesDeep(l)) { treeWrap.append(listNavItem(l, false)); appendProjMatches((groupByList.get(l.id)?.projects) || [], 1); }
      // 미분류('기타') — 검색 중엔 '기타/미분류' 문자열 매칭 또는 미분류 프로젝트 매칭(#665)일 때.
      if (showUn && (!sideSearchActive() || sideSearchNorm('기타 미분류').includes(sideQ()) || (unGroup && unGroup.projects.some(projMatchesQ)))) {
        const unKey = '__none__';
        const uit = el('div', { class: 'pjv-side-navitem pjv-side-navlist' + (sel === unKey ? ' active' : ''), role: 'button', tabindex: '0' },
          pjvBundleIcon(null, 'none'), el('span', { class: 'pjv-side-navlabel', text: '기타 (미분류)' }), el('span', { class: 'pjv-side-navcount', text: String(visCount(unGroup.projects)) }));
        uit.addEventListener('click', (e) => { e.stopPropagation(); selectArea(unKey); });
        pjvFolderDropTarget(uit, null, reload);
        treeWrap.append(uit);
        appendProjMatches(unGroup ? unGroup.projects : [], 1);
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
    //  Esc — 검색어를 지우고 검색창까지 접는다(헤더 🔍 로 다시 연다, #1067).
    searchInput.addEventListener('keydown', (e: any) => { if (e.key === 'Escape') { searchInput.value = ''; sideSearchQ = ''; searchBox.classList.remove('has-q'); sideSearchOpen = false; syncSearchOpen(); buildTree(); } });
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
    pjvSortCtx = null;
    // 전체 보기(스코프 없음)에서도 그룹은 쓸 수 있다(#1067) — renderArea 로 가면 그쪽이 스코프 기준으로 덮어쓴다.
    const allGb = pjvGetGroupBy(null, null, '__all__');
    pjvGroupCtx = { selList: null, groupBy: allGb, rerender: render, enabled: true, scopeKey: '__all__' };
    pjvSyncGroupBtn(groupBtn, allGb, true);
    const byArea = pjvBoardView.byArea, byStatus = pjvBoardView.byStatus, byFolder = pjvBoardView.byFolder;
    syncScopeChip();
    syncCrumbs();   // 브레드크럼(#1067) — 현재 스코프를 위치로 표시
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
  mineBtn.onclick = (e) => { e.stopPropagation(); pjvBoardMineOnly.on = !pjvBoardMineOnly.on; syncToggles(); render(); };
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
  searchInput.addEventListener('input', () => { pjvBoardSearch.q = searchInput.value; syncToggles(); render(); });
  searchInput.addEventListener('keydown', (e: any) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    pjvBoardSearch.q = ''; searchInput.value = ''; searchOpen = false; syncToggles(); render();
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
  const headerStack = el('div', { class: 'pjv-board-header' }, crumbBar, pjvViewTabsRow(), toolbar);
  card.append(shellHost);
  render();
  return wrapper;
}

// 그룹 빌드 — 내 리스트(펼침) → 그 외 리스트(접힘) → 미분류('기타'). '내 할당만' 이면 내 프로젝트만 남기고 빈 그룹은 숨김.
function pjvBuildListGroups(projects, lists, mineIds, meId) {
  const byList = new Map<number, any[]>();
  const unassigned: any[] = [];
  for (const p of projects) {
    if (p.list_id == null) { unassigned.push(p); continue; }
    if (!byList.has(p.list_id)) byList.set(p.list_id, []);
    byList.get(p.list_id)!.push(p);
  }
  const isMyList = (l) => (l.members || []).some((m) => String(m.member_id) === String(meId));
  const sortLists = pjvContainerCmp; // #541 — 사이드바와 동일 비교자(sort → ClickUp orderindex → 이름)
  const my: any[] = [], other: any[] = [];
  for (const l of [...lists].sort(sortLists)) (isMyList(l) ? my : other).push(l);

  const mineOnly = pjvBoardMineOnly.on;
  // '내 할당만' + 툴바 좁히기(#1067 필터·담당자·검색) — 사이드바 카운트·본문·개요가 모두 이 한 관문을 지난다.
  const filterProj = (arr) => pjvApplyToolbarFilters(mineOnly ? arr.filter((p) => mineIds.has(p.id)) : arr);
  const groups: any[] = [];
  const pushList = (l, defaultOpenWhenNotMine) => {
    const projs = filterProj(byList.get(l.id) || []);
    if (mineOnly && !projs.length) return; // 내 할당만: 빈 리스트 숨김
    const mine = isMyList(l);
    const key = 'L' + l.id;
    const open = pjvListOpen.has(key) ? pjvListOpen.get(key) : (mineOnly ? true : (mine || defaultOpenWhenNotMine));
    groups.push({ key, list: l, isMine: mine, projects: projs, open });
  };
  for (const l of my) pushList(l, true);
  for (const l of other) pushList(l, false);

  // 미분류('기타') — 프로젝트가 있으면 표시. 리스트가 하나도 없으면(=전부 미분류) 빈 상태라도 표시해 시작 add-row 노출.
  const unProjs = filterProj(unassigned);
  if (unProjs.length > 0 || (!mineOnly && lists.length === 0)) {
    const key = '__none__';
    const hasMine = unProjs.some((p) => mineIds.has(p.id));
    const open = pjvListOpen.has(key) ? pjvListOpen.get(key) : (mineOnly ? true : (lists.length === 0 || hasMine));
    groups.push({ key, list: null, isMine: false, projects: unProjs, open });
  }
  return groups;
}

// 리스트 한 그룹(접이식) — 헤더(캐럿·색점·이름·개수·내리스트칩 | 멤버 페이스파일·⋯) + 프로젝트 행들 + 인라인 추가행.
function pjvListGroup(g, reload, canDelete, fields, anchorId, meId, taskCtx, nested?, bare?, opts?: any) {
  const list = g.list;            // null = 미분류('기타')
  const isUn = !list;
  const name = isUn ? '기타 (미분류)' : list.name;
  const color = isUn ? 'var(--line, #2a2a33)' : (list.color || avatarColor('list' + list.id));
  const members = isUn ? [] : (list.members || []);
  const listIdForAdd = isUn ? null : list.id;
  const emptyText = pjvBoardMineOnly.on ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.';
  // 헤더 개수 — 완료는 Closed 일 때만 집계(보이는 것과 일치).
  const visibleCount = pjvProjClosedView.done ? g.projects.length : g.projects.filter((p) => p.status !== 'done').length;

  const bodyEl = el('div', { class: 'pjv-tgroup-body' });
  if (nested) {
    // 리스트 › 상태 — 상태 하위그룹. 리스트가 커스텀 상태면 그 상태들로, 아니면 표준 3버킷(#475). 각 그룹에 추가행.
    const mineOnly = pjvBoardMineOnly.on;
    const before = bodyEl.childElementCount;
    // 그룹 기준(#1067) — 폴더/스페이스 스코프에서도 툴바에서 고른 기준(상태·담당자·우선순위·마감일·태그)으로 묶는다.
    pjvRenderStatusGroups(bodyEl, g.projects, list, { reload, canDelete, fields, anchorId, meId, taskCtx, mineOnly, listIdForAdd, groupBy: opts && opts.groupBy });
    if (mineOnly && bodyEl.childElementCount === before) bodyEl.append(el('div', { class: 'pjv-proj-empty', text: emptyText }));
  } else {
    // 평면 — 완료는 Closed 토글일 때만. 정렬: 진행 중→할 일→완료, 같은 상태면 최신순.
    const rank = (p) => p.status === 'done' ? 2 : (p.status === 'todo' ? 1 : 0);
    const shown = g.projects
      .filter((p) => p.status !== 'done' || pjvProjClosedView.done)
      .slice()
      .sort((a, b) => rank(a) - rank(b) || (Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)));
    for (const p of shown) bodyEl.append(pjvProjRow(p, reload, null, canDelete, fields, anchorId, taskCtx));
    if (!shown.length) bodyEl.append(el('div', { class: 'pjv-proj-empty', text: emptyText }));
    if (!pjvBoardMineOnly.on) bodyEl.append(pjvProjAddRow('in_progress', reload, bodyEl, null, fields, null, canDelete, anchorId, meId, taskCtx, listIdForAdd));
  }

  // bare — 영역 헤더 생략(단일 영역 선택 시 좌측 네비가 이미 그 영역을 강조 → 본문 헤더는 중복). 본문만 펼친 채 노출.
  if (bare) {
    bodyEl.hidden = false;
    return el('div', { class: 'pjv-tgroup pjv-list-group pjv-list-group-bare', 'data-list-id': isUn ? '' : String(list.id), style: '--list-color:' + color }, bodyEl);
  }

  let open = !!g.open;
  const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: open ? '▾' : '▸', 'aria-expanded': String(open) });
  bodyEl.hidden = !open;
  const setOpen = (o) => { open = o; pjvListOpen.set(g.key, o); gcaret.textContent = o ? '▾' : '▸'; gcaret.setAttribute('aria-expanded', String(o)); bodyEl.hidden = !o; };
  gcaret.onclick = (e) => { e.stopPropagation(); setOpen(!open); };

  const dot = isUn
    ? el('span', { class: 'pjv-list-dot', style: 'background:' + color, 'aria-hidden': 'true' })
    : el('span', { class: 'pjv-list-headglyph', 'aria-hidden': 'true' }, pjvListGlyph(list));
  const labelEl = el('span', { class: 'pjv-tgroup-label', text: name });
  const countEl = el('span', { class: 'pjv-tgroup-count', text: String(visibleCount) });
  const mineChip = g.isMine ? el('span', { class: 'pjv-list-mine-chip', title: '내가 참여한 리스트', text: '내 리스트' }) : null;
  const main = el('div', { class: 'pjv-list-head-main' }, gcaret, dot, labelEl, countEl, mineChip);

  // 실제 리스트만 멤버 페이스파일(클릭→멤버 관리, 조용히 저장) + ⋯(리스트 설정). 미분류는 액션 없음.
  const actions = el('div', { class: 'pjv-list-head-actions' });
  if (!isUn) {
    const memberCell = pjvProjTeamControl(members, (ids) => pjvSaveListMembers(list.id, ids));
    memberCell.classList.add('pjv-list-members');
    memberCell.title = '리스트 참여 멤버 (참여하면 이 리스트가 기본으로 펼쳐집니다)';
    actions.append(memberCell, pjvListMore(list, reload));
  }

  const headEl = el('div', { class: 'pjv-tgroup-head pjv-list-head' + (isUn ? ' pjv-list-head-un' : '') }, main, actions);
  headEl.addEventListener('click', (e) => {
    if ((e.target as Element).closest('button, .pjv-cell-btn, .pjv-menu, input')) return;
    setOpen(!open);
  });
  // 박스(#1067) — 폴더/스페이스를 열었을 때 리스트마다 테두리 카드로 감싼다(ClickUp 폴더 뷰). 헤더 위엔 그 리스트가
  //  어디 있는지 알려주는 작은 경로(스페이스 / 폴더)를 얹는다 — 여러 리스트가 한 화면에 쌓이면 이름만으론 구분이 안 된다.
  const boxed = !!(opts && opts.boxed);
  const crumb = opts && opts.crumb ? el('div', { class: 'pjv-list-box-crumb', text: opts.crumb }) : null;
  const groupEl = el('div', { class: 'pjv-tgroup pjv-list-group' + (boxed ? ' pjv-list-box' : ''), 'data-list-id': isUn ? '' : String(list.id), style: '--list-color:' + color },
    ...(crumb ? [crumb] : []), headEl, bodyEl);
  // 이 폴더 구역 어디에 프로젝트를 놓아도 그 폴더로(미분류 그룹이면 null=미분류)(#454).
  pjvFolderDropTarget(groupEl, isUn ? null : list.id, reload);
  return groupEl;
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

// 리스트 설정 팝아웃(클릭업 List settings 의 필요 부분집합, #475) — 사이드바 리스트 ⋯ · 인라인 리스트 헤더 ⋯ 공용.
//  리스트 설정(이름·색·아이콘·멤버·공개범위) / 상태 체계 관리 / 폴더로 이동 / 프로젝트 관리 / 삭제. 라벨 간결화(#500).
function pjvListSettingsMenu(menu, close, list, reload) {
  const mk = (label, fn, danger?, sub?) => {
    const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label }), sub ? el('span', { class: 'pjv-menu-caret', text: '›' }) : null);
    b.onclick = (e) => { e.stopPropagation(); if (sub) { fn(); } else { close(); fn(); } };
    return b;
  };
  menu.append(el('div', { class: 'pjv-menu-head', text: list.name }));
  menu.append(mk('리스트 설정', () => openListForm(reload, list)));
  menu.append(mk('상태 체계 관리', () => pjvListStatusEditor(list, reload)));
  menu.append(mk('폴더로 이동', () => pjvListFolderSubmenu(menu, close, list, reload), false, true));
  menu.append(mk('프로젝트 관리', () => pjvManageFolderProjects(list, reload)));
  menu.append(el('div', { class: 'pjv-bulk-sep-h' }));
  menu.append(mk('리스트 삭제', () => pjvDeleteList(list, reload), true));
}

// '폴더로 이동' 하위 — 같은 팝오버 안에서 폴더 목록으로 교체(뒤로가기 포함). 폴더를 그 자리에서 fetch.
function pjvListFolderSubmenu(menu, close, list, reload) {
  const back = el('button', { class: 'pjv-menu-item pjv-menu-back', type: 'button' }, el('span', { class: 'pjv-menu-caret', text: '‹' }), el('span', { text: '뒤로' }));
  back.onclick = (e) => { e.stopPropagation(); menu.replaceChildren(); pjvListSettingsMenu(menu, close, list, reload); };
  menu.replaceChildren(back, el('div', { class: 'pjv-menu-head', text: '폴더로 이동' }), el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  api('/api/ui/v6/project-folders').then((d) => {
    const folders = (d && d.folders) || [];
    menu.replaceChildren(back, el('div', { class: 'pjv-menu-head', text: '폴더로 이동' }));
    const mkItem = (label, folderId, color) => {
      const cur = (list.folder_id == null ? folderId == null : String(list.folder_id) === String(folderId));
      const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' },
        color !== undefined ? pjvBundleIcon(color, folderId == null ? 'none' : undefined) : null,
        el('span', { class: 'pjv-asg-mname', text: label }), el('span', { class: 'pjv-asg-check', text: cur ? '✓' : '' }));
      item.onclick = async (e) => {
        e.stopPropagation(); close();
        if (cur) return;
        try { await api('/api/ui/v6/project-lists/' + list.id + '/folder', { method: 'POST', body: JSON.stringify({ folder_id: folderId }) }); toast(folderId == null ? '폴더에서 뺐습니다' : '폴더로 옮겼습니다'); if (reload) reload(); }
        catch (err) { toast('이동 실패 — ' + err.message, true); }
      };
      return item;
    };
    menu.append(mkItem('폴더 없음 (최상위)', null, null));
    for (const f of folders) menu.append(mkItem(f.name, f.id, f.color || 'var(--muted-2)'));
    const addNew = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' }, el('span', { class: 'pjv-sess-add-ico', text: '＋' }), el('span', { text: '새 폴더…' }));
    addNew.onclick = (e) => { e.stopPropagation(); close(); openFolderForm(reload); };
    menu.append(el('div', { class: 'pjv-bulk-sep-h' }), addNew);
  }).catch((err) => menu.replaceChildren(back, el('div', { class: 'pjv-menu-empty', text: '폴더를 불러오지 못했어요 — ' + err.message })));
}

// 인라인 리스트 그룹 헤더의 ⋯ — 리스트 설정 팝아웃.
function pjvListMore(list, reload) {
  const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '리스트 설정', 'aria-label': '리스트 설정', text: '⋯' });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu pjv-listset-menu' });
    const close = pjvPopover(btn, menu);
    pjvListSettingsMenu(menu, close, list, reload);
  };
  return btn;
}

// 리스트 글리프(사이드바) — settings.icon 이모지가 있으면 그것, 없으면 리스트 색의 체크리스트 글리프(클릭업 List 아이콘).
function pjvListGlyph(list) {
  const emoji = list && list.settings && list.settings.icon;
  if (emoji) return el('span', { class: 'pjv-side-listemoji', text: String(emoji) });
  const color = (list && list.color) || avatarColor('list' + (list ? list.id : ''));
  const n = sv('svg', { class: 'pjv-side-listglyph', viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(
    sv('path', { d: 'M4 7l1.6 1.6L8.4 5.6' }), sv('path', { d: 'M11 7h9' }),
    sv('path', { d: 'M4 15l1.6 1.6L8.4 13.6' }), sv('path', { d: 'M11 15h9' }));
  return n;
}

// 폴더에 프로젝트 넣고 빼기 모달(#454) — 이 폴더의 프로젝트(빼기) + 다른 프로젝트 검색해 추가. 이동은 즉시 반영 + 보드 리로드.
//  검색 입력은 고정하고 목록 컨테이너만 다시 그린다(타이핑 중 포커스 유지).
function pjvManageFolderProjects(list, reload) {
  let all: any[] = [];
  const inHead = el('div', { class: 'pjv-foldman-sec-h' });
  const inList = el('div', { class: 'pjv-foldman-list' });
  const otherList = el('div', { class: 'pjv-foldman-list' });
  const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '프로젝트 이름으로 검색해 추가…' });
  const move = async (p, listId) => {
    try {
      await api('/api/ui/v6/projects/' + p.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) });
      p.list_id = listId; toast(listId == null ? '리스트에서 뺐습니다' : '이 리스트에 넣었습니다'); paint(); if (reload) reload();
    } catch (e) { toast('이동 실패 — ' + e.message, true); }
  };
  const paint = () => {
    const inFolder = all.filter((p) => String(p.list_id) === String(list.id));
    inHead.textContent = '이 리스트의 프로젝트 (' + inFolder.length + ')';
    inList.replaceChildren(...(inFolder.length
      ? inFolder.map((p) => el('div', { class: 'pjv-foldman-row' },
          el('span', { class: 'pjv-foldman-name' + (p.status === 'done' ? ' done' : ''), text: p.name }),
          el('button', { class: 'pjv-foldman-btn', type: 'button', text: '빼기', onclick: () => move(p, null) })))
      : [el('div', { class: 'pjv-menu-empty', text: '이 리스트에 든 프로젝트가 없어요. 아래에서 추가하세요.' })]));
    const q = searchIn.value.trim().toLowerCase();
    const others = all.filter((p) => String(p.list_id) !== String(list.id) && (!q || (p.name || '').toLowerCase().includes(q)));
    otherList.replaceChildren(...(others.length
      ? others.slice(0, 50).map((p) => el('div', { class: 'pjv-foldman-row' },
          el('span', { class: 'pjv-foldman-name' + (p.status === 'done' ? ' done' : ''), text: p.name }),
          p.list_id != null ? el('span', { class: 'pjv-foldman-cur', text: '다른 리스트' }) : null,
          el('button', { class: 'pjv-foldman-btn add', type: 'button', text: '＋ 추가', onclick: () => move(p, list.id) })))
      : [el('div', { class: 'pjv-menu-empty', text: q ? '일치하는 프로젝트가 없어요.' : '추가할 프로젝트가 없어요.' })]));
  };
  searchIn.addEventListener('input', paint);
  const box = el('div', { class: 'pjv-foldman' },
    inHead, inList,
    el('div', { class: 'pjv-foldman-sec-h', style: 'margin-top:16px', text: '리스트에 추가' }), searchIn, otherList);
  const back = overlayBox('‘' + list.name + '’ 리스트 — 프로젝트 넣고 빼기', box,
    el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => back.remove() })));
  inList.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  api('/api/ui/v6/projects').then((d) => { all = (d && d.projects) || []; paint(); setTimeout(() => searchIn.focus(), 0); })
    .catch((e) => inList.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '프로젝트를 불러오지 못했어요 — ' + e.message })));
  return back;
}

// 폴더 드롭 타깃 배선(#454) — elm 에 프로젝트 행 드래그를 받아 targetListId(폴더 id | null=미분류)로 이동한다.
//  진행 중인 폴더-드래그(pjvFolderDrag.id)가 있을 때만 반응 — 첨부파일 등 다른 드롭과 안 섞이게.
function pjvFolderDropTarget(elm, targetListId, reload) {
  const over = (ev) => { if (pjvFolderDrag.id == null) return; ev.preventDefault(); try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* */ } elm.classList.add('pjv-folder-drop-over'); };
  elm.addEventListener('dragover', over);
  elm.addEventListener('dragenter', over);
  elm.addEventListener('dragleave', (ev) => { if (!elm.contains(ev.relatedTarget)) elm.classList.remove('pjv-folder-drop-over'); });
  elm.addEventListener('drop', (ev) => {
    elm.classList.remove('pjv-folder-drop-over');
    if (pjvFolderDrag.id == null) return;
    ev.preventDefault(); ev.stopPropagation();
    const pid = pjvFolderDrag.id; pjvFolderDrag.id = null;
    api('/api/ui/v6/projects/' + pid + '/list', { method: 'POST', body: JSON.stringify({ list_id: targetListId }) })
      .then(() => { toast(targetListId == null ? '미분류로 옮겼습니다' : '리스트로 옮겼습니다'); if (reload) reload(); })
      .catch((e) => toast('이동 실패 — ' + e.message, true));
  });
}

// 휴지통 드롭 타깃(#1020) — 사이드바에서 끌던 리스트·폴더·프로젝트를 이 항목 위에 놓으면 삭제(휴지통 이동)한다.
//  드래그 종류가 둘로 갈린다: 리스트/폴더는 pjvSideDrag(kind), 프로젝트는 pjvFolderDrag(id). 어느 쪽이든 반응.
//  삭제는 각자의 기존 확인 절차를 그대로 거친다 — 리스트=cascade 모달(pjvDeleteList), 폴더=confirm(pjvDeleteFolder),
//  프로젝트=confirm(pjvProjDelete). 실수 드롭도 확인에서 막힌다. 놓을 수 있을 때만 빨강(파괴적) 하이라이트.
//  드롭 처리는 setTimeout 로 미뤄 dragend 가 먼저 드래그 스타일을 정리하게 한다(모달·confirm 뒤 잔상 방지).
function pjvTrashDropTarget(elm, lists, folderList, reload) {
  const canDrop = () => pjvFolderDrag.id != null || pjvSideDrag.kind === 'list' || pjvSideDrag.kind === 'folder';
  const over = (ev) => {
    if (!canDrop()) return;
    ev.preventDefault(); ev.stopPropagation();
    try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* */ }
    elm.classList.add('pjv-side-trash-over');
  };
  elm.addEventListener('dragover', over);
  elm.addEventListener('dragenter', over);
  elm.addEventListener('dragleave', (ev) => { if (!elm.contains(ev.relatedTarget)) elm.classList.remove('pjv-side-trash-over'); });
  elm.addEventListener('drop', (ev) => {
    elm.classList.remove('pjv-side-trash-over');
    if (!canDrop()) return;
    ev.preventDefault(); ev.stopPropagation(); // 링크(#/trash) 이동·treeWrap 최상위 이동 폴백을 막는다
    // 프로젝트 드롭 — pjvFolderDrag 에서 id·name 을 꺼내 확인 후 삭제.
    if (pjvFolderDrag.id != null) {
      const proj = { id: pjvFolderDrag.id, name: pjvFolderDrag.name };
      pjvFolderDrag.id = null; pjvFolderDrag.name = null;
      setTimeout(() => pjvProjDelete(proj, reload), 0);
      return;
    }
    // 리스트/폴더 드롭 — pjvSideDrag 에서 대상 id 를 꺼내 원본 객체를 찾아(카운트·이름 필요) 확인 후 삭제.
    const kind = pjvSideDrag.kind; const id = pjvSideDrag.id;
    pjvSideDrag.kind = null; pjvSideDrag.id = null; pjvSideDrag.folderId = null;
    if (kind === 'list') { const l = (lists || []).find((x) => String(x.id) === String(id)); if (l) setTimeout(() => pjvDeleteList(l, reload), 0); }
    else if (kind === 'folder') { const f = (folderList || []).find((x) => String(x.id) === String(id)); if (f) setTimeout(() => pjvDeleteFolder(f, reload), 0); }
  });
}

// ── 사이드바 파일탐색기 DnD(#473 후속) — 리스트(=파일)를 폴더로 넣기/빼기, 폴더 순서 재정렬. ──
//  리스트 이동: POST project-lists/:id/folder {folder_id} · 폴더 재정렬: POST project-folders/:id {sort} 일괄.
function pjvMoveListToFolder(listId, folderId, reload) {
  api('/api/ui/v6/project-lists/' + listId + '/folder', { method: 'POST', body: JSON.stringify({ folder_id: folderId }) })
    .then(() => { toast(folderId == null ? '폴더에서 뺐어요' : '폴더로 옮겼어요'); if (reload) reload(); })
    .catch((e) => toast('이동 실패 — ' + e.message, true));
}
// 주어진 순서(id 배열)대로 폴더 sort 를 일괄 저장(#541 — 배치 엔드포인트, 서버가 1..n 재부여) 후 재렌더.
function pjvReorderFolders(orderedIds, reload) {
  api('/api/ui/v6/project-folders-reorder', { method: 'POST', body: JSON.stringify({ ids: orderedIds }) })
    .then(() => { if (reload) reload(); })
    .catch((e) => toast('폴더 순서 저장 실패 — ' + e.message, true));
}
// 사이드바 들여쓰기 격자(#1067) — 스페이스·폴더·리스트·검색결과가 **한 격자**를 쓴다(예전엔 폴더 14px 계단 +
//  리스트 .sub 30px 특례로 단이 어긋나 위계 세로선이 격자처럼 어색했다). 깊이 d → 왼쪽 여백 PJV_SIDE_PAD + d*PJV_SIDE_STEP.
//  같은 값으로 세로선 개수(--pjv-guide-n = 조상 수)도 실어 CSS 가 선을 긋는다(선 x = 부모 아이콘 중심).
const PJV_SIDE_PAD = 10;   // 깊이 0 항목의 왼쪽 여백(= .pjv-side-navitem 기본 padding)
const PJV_SIDE_STEP = 18;  // 한 단 들여쓰기 — 선(부모 아이콘 중심 19px)과 자식 아이콘 사이에 9px 숨통
function pjvSideIndent(elm, depth, extra = 0) {
  if (depth > 0 || extra) elm.style.paddingLeft = `${PJV_SIDE_PAD + depth * PJV_SIDE_STEP + extra}px`;
  elm.style.setProperty('--pjv-guide-n', String(depth));
}
// 스페이스 판정(#766) — 커넥터 미러(external_id 'space:…', #541) 또는 네이티브(settings.kind==='space'). 백엔드 folderIsSpace 와 동형.
function pjvFolderIsSpace(f): boolean {
  return !!(f && ((typeof f.external_id === 'string' && f.external_id.startsWith('space:')) || (f.settings && f.settings.kind === 'space')));
}
// ── 📦 아카이브(#1067) — 사이드바 맨 아래 고정 폴더. '다 지난' 리스트·폴더·프로젝트를 끌어다 치워두는 곳. ──
//  휴지통과 나란히 있지만 성격이 반대다: 삭제가 아니라 **이동**이다. 실체는 그냥 폴더(project_folder, settings.kind='archive')라
//  끌어내면 원상복귀되고, 백엔드는 이 폴더에 한해 스페이스도 하위로 받는다(folder-store.folderIsArchive).
//  대신 아카이브 안의 것들은 사이드바 트리와 보드(상태·평면·칸반·리스트별)에서 통째로 빠져 평소 화면이 깨끗해진다 —
//  아카이브 항목을 직접 열었을 때만 보인다.
const PJV_ARCHIVE_FOLDER_NAME = '아카이브';
const PJV_ARCHIVE_LIST_NAME = '지난 프로젝트';
// 아카이브 판정 — 백엔드 folderIsArchive 와 동형(settings.kind==='archive').
function pjvFolderIsArchive(f): boolean {
  return !!(f && f.settings && f.settings.kind === 'archive');
}
// 아카이브 폴더 한 개 — 어쩌다 여럿이 생겨도(동시 생성) 가장 오래된 것(최소 id) 하나만 고정 폴더로 채택한다.
function pjvFindArchiveFolder(folders) {
  const cands = (folders || []).filter(pjvFolderIsArchive);
  return cands.length ? cands.reduce((a, b) => (Number(a.id) <= Number(b.id) ? a : b)) : null;
}
// 아카이브 폴더 + 그 하위 폴더 전부의 id — 트리·보드에서 '아카이브 안'을 통째로 판정하는 데 쓴다.
function pjvArchiveFolderIds(folders, archive): Set<number> {
  const ids = new Set<number>();
  if (!archive) return ids;
  ids.add(Number(archive.id));
  let grew = true;
  while (grew) { // 깊이 제한 없이 — 폴더 수가 적어 반복 훑기로 충분(부모 순서 무관).
    grew = false;
    for (const f of (folders || [])) {
      if (f.parent_id != null && ids.has(Number(f.parent_id)) && !ids.has(Number(f.id))) { ids.add(Number(f.id)); grew = true; }
    }
  }
  return ids;
}
// 아카이브 폴더 확보 — 없으면 그 자리에서 만든다(첫 드롭 때 생성). 동시 드롭이 두 개를 만들지 않게 진행 중 프로미스를 공유.
let pjvArchiveEnsurePr: any = null;
function pjvEnsureArchiveFolder(known?) {
  if (known && known.id) return Promise.resolve(known);
  if (!pjvArchiveEnsurePr) {
    pjvArchiveEnsurePr = api('/api/ui/v6/project-folders')
      .then((d) => pjvFindArchiveFolder((d && d.folders) || [])
        || api('/api/ui/v6/project-folders', { method: 'POST', body: JSON.stringify({ name: PJV_ARCHIVE_FOLDER_NAME, kind: 'archive' }) }).then((r) => (r && r.folder) || r))
      .finally(() => { pjvArchiveEnsurePr = null; });
  }
  return pjvArchiveEnsurePr;
}
// 아카이브 안 '지난 프로젝트' 리스트 확보 — 프로젝트는 폴더에 직접 못 들어가고(프로젝트 ▸ 리스트 소속) 리스트가 있어야 한다.
//  화면의 stale 목록 대신 매번 서버 목록으로 찾는다(중복 생성 방지). 동시 드롭은 프로미스 공유로 한 번만 만든다.
let pjvArchiveListPr: any = null;
function pjvEnsureArchiveList(archive) {
  if (!pjvArchiveListPr) {
    pjvArchiveListPr = api('/api/ui/v6/project-lists')
      .then((d) => {
        const hit = ((d && d.lists) || []).find((l) => String(l.folder_id) === String(archive.id) && l.name === PJV_ARCHIVE_LIST_NAME);
        if (hit) return hit;
        return api('/api/ui/v6/project-lists', { method: 'POST', body: JSON.stringify({ name: PJV_ARCHIVE_LIST_NAME }) })
          .then((r) => { const l = (r && r.list) || r;
            return api('/api/ui/v6/project-lists/' + l.id + '/folder', { method: 'POST', body: JSON.stringify({ folder_id: archive.id }) }).then(() => l); });
      })
      .finally(() => { pjvArchiveListPr = null; });
  }
  return pjvArchiveListPr;
}
// 아카이브 드롭 타깃(#1067) — 사이드바에서 끌던 리스트·폴더·프로젝트를 놓으면 아카이브로 옮긴다.
//  휴지통(pjvTrashDropTarget)과 같은 두 드래그 상태를 받고(리스트·폴더=pjvSideDrag / 프로젝트=pjvFolderDrag),
//  같은 배선 주의점을 따른다: dragover·drop 에서 preventDefault+stopPropagation 로 treeWrap 의 '최상위로' 폴백을 막는다.
//  파괴적이지 않으므로 확인 없이 바로 옮기고(되돌리기는 다시 끌어내기), 하이라이트도 danger 빨강이 아닌 이동(파랑) 계열.
function pjvArchiveDropTarget(elm, ctx) {
  const canDrop = () => pjvFolderDrag.id != null || pjvSideDrag.kind === 'list' || pjvSideDrag.kind === 'folder';
  const over = (ev) => {
    if (!canDrop()) return;
    ev.preventDefault(); ev.stopPropagation();
    try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* */ }
    elm.classList.add('pjv-side-archive-over');
  };
  elm.addEventListener('dragover', over);
  elm.addEventListener('dragenter', over);
  elm.addEventListener('dragleave', (ev) => { if (!elm.contains(ev.relatedTarget)) elm.classList.remove('pjv-side-archive-over'); });
  elm.addEventListener('drop', (ev) => {
    elm.classList.remove('pjv-side-archive-over');
    if (!canDrop()) return;
    ev.preventDefault(); ev.stopPropagation();
    const done = (msg) => { toast(msg); if (ctx.reload) ctx.reload(); };
    const fail = (e) => toast('아카이브로 옮기지 못했어요 — ' + (e && e.message || e), true);
    // 프로젝트 — 아카이브 안 '지난 프로젝트' 리스트로. 리스트가 없으면 폴더·리스트를 그 자리에서 만든다.
    if (pjvFolderDrag.id != null) {
      const pid = pjvFolderDrag.id; pjvFolderDrag.id = null; pjvFolderDrag.name = null;
      pjvEnsureArchiveFolder(ctx.archive())
        .then((a) => pjvEnsureArchiveList(a))
        .then((l) => api('/api/ui/v6/projects/' + pid + '/list', { method: 'POST', body: JSON.stringify({ list_id: l.id }) }))
        .then(() => done('아카이브로 옮겼어요'))
        .catch(fail);
      return;
    }
    const kind = pjvSideDrag.kind; const id = pjvSideDrag.id;
    pjvSideDrag.kind = null; pjvSideDrag.id = null; pjvSideDrag.folderId = null;
    if (kind === 'list') {
      pjvEnsureArchiveFolder(ctx.archive())
        .then((a) => api('/api/ui/v6/project-lists/' + id + '/folder', { method: 'POST', body: JSON.stringify({ folder_id: a.id }) }))
        .then(() => done('아카이브로 옮겼어요')).catch(fail);
    } else if (kind === 'folder') {
      const cur = ctx.archive();
      if (cur && String(cur.id) === String(id)) { toast('아카이브 폴더 자신은 옮길 수 없어요', true); return; }
      pjvEnsureArchiveFolder(cur)
        .then((a) => api('/api/ui/v6/project-folders/' + id, { method: 'POST', body: JSON.stringify({ parent_id: a.id }) }))
        .then(() => done('아카이브로 옮겼어요')).catch(fail);
    }
  });
}

// 폴더를 스페이스/폴더 하위로 이동(parentId=null 이면 최상위로) — parent_id 패치. #766
function pjvMoveFolderToParent(folderId, parentId, reload) {
  api('/api/ui/v6/project-folders/' + folderId, { method: 'POST', body: JSON.stringify({ parent_id: parentId }) })
    .then(() => { toast(parentId == null ? '최상위로 옮겼어요' : '스페이스로 옮겼어요'); if (reload) reload(); })
    .catch((e) => toast('이동 실패 — ' + e.message, true));
}
// 리스트 사이드바 순서 저장(#541) — 같은 폴더 형제의 새 순서(id 배열)를 배치 저장(sort=1..n).
function pjvReorderLists(orderedIds, reload) {
  api('/api/ui/v6/project-lists-reorder', { method: 'POST', body: JSON.stringify({ ids: orderedIds }) })
    .then(() => { if (reload) reload(); })
    .catch((e) => toast('리스트 순서 저장 실패 — ' + e.message, true));
}
// movingId 를 targetId 바로 앞에 옮긴 새 순서 배열(둘 다 같은 배열 안에 있어야 함).
function pjvMoveBefore(ids, movingId, targetId) {
  const rest = ids.filter((x) => String(x) !== String(movingId));
  const idx = rest.findIndex((x) => String(x) === String(targetId));
  if (idx < 0) return ids;
  rest.splice(idx, 0, movingId);
  return rest;
}
// movingId 를 targetId '앞(after=false)/뒤(after=true)'에 옮긴 새 순서 배열.
function pjvMoveNear(ids, movingId, targetId, after) {
  const rest = ids.filter((x) => String(x) !== String(movingId));
  const idx = rest.findIndex((x) => String(x) === String(targetId));
  if (idx < 0) return ids;
  rest.splice(idx + (after ? 1 : 0), 0, movingId);
  return rest;
}
// 즐겨찾기 토글 저장(#670) — 서버 POST(/api/ui/v6/favorites). WIKI 사이드바도 동일 엔드포인트 공유.
function pjvSetFavorite(kind: string, id: number, on: boolean) {
  return api('/api/ui/v6/favorites', { method: 'POST', body: JSON.stringify({ kind, id, on }) });
}
// ⭐ 즐겨찾기 별 토글 버튼(#670) — 항목 우측(호버 노출, 즐겨찾기면 금색 채움·항상 표시). onToggle(next) 호출.
//  프로젝트 탭·WIKI 사이드바 공용 마크업(.pjv-side-navfav) — 통일성.
function pjvFavStar(isFav: boolean, onToggle: (next: boolean) => void) {
  const btn = el('button', { class: 'pjv-side-navfav' + (isFav ? ' on' : ''), type: 'button',
    title: isFav ? '즐겨찾기 해제' : '즐겨찾기에 추가', 'aria-label': isFav ? '즐겨찾기 해제' : '즐겨찾기에 추가',
    'aria-pressed': String(isFav), text: isFav ? '★' : '☆' });
  btn.addEventListener('click', (e: any) => { e.preventDefault(); e.stopPropagation(); onToggle(!isFav); });
  return btn;
}
// 사이드바 항목 드롭 타깃 — 진행 중인 사이드바 드래그(pjvSideDrag)에만 반응.
//  같은 형제 재정렬(handlers.reorderList/reorderFolder 가 true)이면 커서 위/아래 절반으로 '앞/뒤' 가로 삽입선(#670,
//  어디 들어갈지 직관적), 아니면(폴더로 넣기 등) 종전 폴더 하이라이트. onList/onFolder(id, after) 로 위치 전달.
function pjvSideNavDrop(elm, handlers) {
  const clearMarks = () => elm.classList.remove('pjv-side-drop-over', 'pjv-side-drop-before', 'pjv-side-drop-after', 'pjv-side-drop-outdent');
  const over = (ev) => {
    if (!pjvSideDrag.kind) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* */ }
    const id = pjvSideDrag.id;
    const canReorder = pjvSideDrag.kind === 'list' ? !!(handlers.reorderList && handlers.reorderList(id))
      : pjvSideDrag.kind === 'folder' ? !!(handlers.reorderFolder && handlers.reorderFolder(id)) : false;
    clearMarks();
    const r = elm.getBoundingClientRect();
    const half = (ev.clientY - r.top) > r.height / 2 ? 'pjv-side-drop-after' : 'pjv-side-drop-before';
    // 인라인 아웃덴트(#670, VS Code식) — 폴더 '안' 리스트를 드래그하는 중(pjvSideDrag.folderId != null)에 커서 X 를 항목 왼쪽
    //  들여쓰기 영역(< PJV_OUTDENT_PX)으로 끌면 '폴더 밖 최상위'로 빼기. 삽입선을 최상위 들여쓰기로 당기고 세로 가이드 표시.
    //  (예전의 '여기로 끌어 폴더 밖으로 빼기' 드롭존 박스를 대체 — 별도 박스 없이 자연스러운 가로 인라인 레벨.)
    if (pjvSideDrag.kind === 'list' && handlers.onOutdent && pjvSideDrag.folderId != null && (ev.clientX - r.left) < PJV_OUTDENT_PX) {
      elm.classList.add('pjv-side-drop-outdent', half);
      return;
    }
    if (canReorder) elm.classList.add(half);
    else elm.classList.add('pjv-side-drop-over');
  };
  elm.addEventListener('dragover', over);
  elm.addEventListener('dragenter', over);
  elm.addEventListener('dragleave', (ev) => { if (!elm.contains(ev.relatedTarget)) clearMarks(); });
  elm.addEventListener('drop', (ev) => {
    const isOutdent = elm.classList.contains('pjv-side-drop-outdent');
    const after = elm.classList.contains('pjv-side-drop-after');
    clearMarks();
    if (!pjvSideDrag.kind) return;
    ev.preventDefault(); ev.stopPropagation();
    const kind = pjvSideDrag.kind; const id = pjvSideDrag.id; pjvSideDrag.kind = null; pjvSideDrag.id = null; pjvSideDrag.folderId = null;
    if (kind === 'list' && isOutdent && handlers.onOutdent) { handlers.onOutdent(id); return; }
    if (kind === 'list' && handlers.onList) handlers.onList(id, after);
    else if (kind === 'folder' && handlers.onFolder) handlers.onFolder(id, after);
  });
}
const PJV_OUTDENT_PX = 30; // 아웃덴트 트리거 — 항목 왼쪽 이만큼(px) 안으로 커서가 들어오면 '폴더 밖'으로 해석(#670).

// 리스트 삭제 확인 — 우리 디자인 모달(#732). 브라우저 confirm() 대신 overlayBox + 스위치 카드.
//  '리스트 안의 프로젝트도 함께 삭제'를 토글로 물어 선택대로 수행: OFF(기본)=리스트만 삭제하고 프로젝트는
//  ‘기타(미분류)’로 이동해 보존 / ON=cascade_projects 로 프로젝트(하위 태스크 포함)까지 삭제(휴지통에서 복원 가능).
function pjvDeleteList(list, reload) {
  const count = Number.isFinite(Number(list && list.project_count)) ? Number(list.project_count) : 0;
  let cascade = false;

  const hint = el('div', { class: 'pjv-dellist-note' });
  const paintHint = () => {
    hint.textContent = count === 0
      ? '이 리스트에는 프로젝트가 없어요. 리스트만 삭제합니다.'
      : (cascade
          ? '리스트와 그 안의 프로젝트 ' + count + '개를 모두 삭제해요. 휴지통(#/trash)에서 되살릴 수 있어요.'
          : '리스트만 삭제하고, 프로젝트 ' + count + '개는 ‘기타(미분류)’로 옮겨 보존해요.');
  };

  // '함께 삭제' 스위치 카드 — openListForm 공개범위 토글과 동일한 pjv-visrow/pjv-switch 결(우리 디자인).
  const sw = el('span', { class: 'pjv-switch', 'aria-hidden': 'true' }, el('span', { class: 'pjv-switch-knob' }));
  const toggleRow = el('div', { class: 'pjv-visrow', role: 'switch', tabindex: '0', 'aria-checked': 'false' },
    el('span', { class: 'pjv-visrow-txt' },
      el('span', { class: 'pjv-visrow-title', text: '리스트 안의 프로젝트도 함께 삭제' }),
      el('span', { class: 'pjv-visrow-hint', text: '끄면 프로젝트는 ‘기타(미분류)’로 옮겨져 보존돼요.' })),
    sw);
  const delBtn = el('button', { class: 'btn btn-danger' });
  const updateBtn = () => { delBtn.textContent = (cascade && count > 0) ? '리스트·프로젝트 삭제' : '리스트 삭제'; };
  const toggle = () => {
    cascade = !cascade;
    toggleRow.classList.toggle('on', cascade); sw.classList.toggle('on', cascade);
    toggleRow.setAttribute('aria-checked', cascade ? 'true' : 'false');
    paintHint(); updateBtn();
  };
  toggleRow.onclick = (e) => { e.stopPropagation(); toggle(); };
  toggleRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const body = el('div', { class: 'pjv-dellist' },
    el('p', { class: 'pjv-dellist-lead' }, el('span', { class: 'pjv-dellist-name', text: '‘' + list.name + '’' }), ' 리스트를 삭제할까요?'),
    count > 0 ? toggleRow : null,
    hint);

  let busy = false;
  const go = async () => {
    if (busy) return;
    busy = true; delBtn.disabled = true; cancelBtn.disabled = true;
    try {
      await api('/api/ui/v6/project-lists/' + list.id + '/delete', { method: 'POST', body: JSON.stringify({ cascade_projects: cascade }) });
      back.remove();
      toast((cascade && count > 0) ? '리스트와 프로젝트 ' + count + '개를 삭제했습니다' : '리스트를 삭제했습니다');
      if (reload) reload();
    } catch (e) { toast('삭제 실패 — ' + e.message, true); busy = false; delBtn.disabled = false; cancelBtn.disabled = false; }
  };
  delBtn.onclick = go;

  const back = overlayBox('리스트 삭제', body, el('div', { class: 'ov-actions' }, delBtn, cancelBtn));
  const boxEl = back.querySelector('.ov-box'); if (boxEl) boxEl.classList.add('pjv-modal-narrow');
  paintHint(); updateBtn();
  setTimeout(() => cancelBtn.focus(), 0);
  return back;
}

// 리스트 멤버 저장(조용히 — 팝오버 안에서 연속 토글, reload 없음). 멤버십 변화는 다음 렌더에 펼침/접힘으로 반영.
function pjvSaveListMembers(id, ids) {
  return api('/api/ui/v6/project-lists/' + id + '/members', { method: 'POST', body: JSON.stringify({ members: ids }) })
    .catch((e) => toast('리스트 멤버 저장 실패 — ' + e.message, true));
}

// ── 폴더(project_folder) CRUD·메뉴(#475) — 폴더는 정리용(멤버·권한 없음). 리스트를 담아 사이드바에서 폴더›리스트로. ──
function pjvFolderTreeMenu(menu, close, folder, reload) {
  const mk = (label, fn, danger?) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = (e) => { e.stopPropagation(); close(); fn(); }; return b; };
  const isSpace = pjvFolderIsSpace(folder);      // #766 스페이스면 메뉴 문구·항목이 달라진다
  const kindLabel = isSpace ? '스페이스' : '폴더';
  menu.append(el('div', { class: 'pjv-menu-head', text: folder.name }));
  menu.append(mk(kindLabel + ' 설정 (이름·색)', () => openFolderForm(reload, folder)));
  if (isSpace) menu.append(mk('이 스페이스에 새 폴더', () => openFolderForm(reload, undefined, { parentId: folder.id })));  // #766 스페이스 하위 폴더 생성
  menu.append(mk('이 ' + kindLabel + '에 새 리스트', () => openListForm(reload, undefined, { folderId: folder.id })));
  // #766 중첩 해제. 스페이스도 포함(#1067) — 아카이브에 치워둔 스페이스를 꺼내는 유일한 경로다(스페이스는 폴더 하위로
  //  못 가지만 '최상위로'는 언제나 가능). 드래그로 못 꺼내는 상황(아카이브 안)에서 갇히지 않게.
  if (folder.parent_id != null) menu.append(mk('최상위로 빼기', () => pjvMoveFolderToParent(folder.id, null, reload)));
  menu.append(el('div', { class: 'pjv-bulk-sep-h' }));
  menu.append(mk(kindLabel + ' 삭제', () => pjvDeleteFolder(folder, reload), true));
}

function pjvDeleteFolder(folder, reload) {
  if (!confirm('폴더 ‘' + folder.name + '’을(를) 삭제할까요?\n\n폴더만 사라지고, 속한 리스트는 ‘최상위(폴더 없음)’로 이동합니다(리스트·프로젝트는 보존).')) return;
  (async () => {
    try { await api('/api/ui/v6/project-folders/' + folder.id + '/delete', { method: 'POST' }); toast('폴더를 삭제했습니다'); reload(); }
    catch (e) { toast('삭제 실패 — ' + e.message, true); }
  })();
}

// 새 폴더/스페이스 · 폴더 수정 폼 — 이름·색(정리용, 멤버 없음).
//  #766 opts.kind='space' → 스페이스 생성(최상위 구획). 일반 폴더는 '상위 스페이스' 선택으로 스페이스
//  하위에 생성/이동(opts.parentId = 초기 상위). 수정 시 folder 가 스페이스면 상위 선택 숨김(최상위 전용).
function openFolderForm(reload, folder?, opts?) {
  opts = opts || {};
  const editing = !!folder;
  const isSpace = editing ? pjvFolderIsSpace(folder) : (opts.kind === 'space');
  const kindLabel = isSpace ? '스페이스' : '폴더';
  const nameIn = el('input', { type: 'text', value: editing ? folder.name : '', placeholder: kindLabel + ' 이름 (예: ' + (isSpace ? 'Lively 제품' : '개인신용대출') + ')', maxlength: '120' });
  let color = editing ? (folder.color || '') : '';
  const swatches = el('div', { class: 'pjv-color-swatches' });
  const paintSw = () => {
    const none = el('button', { class: 'pjv-sw pjv-sw-none' + (color ? '' : ' on'), type: 'button', title: '자동(이름 해시색)', text: 'A' });
    none.onclick = () => { color = ''; paintSw(); };
    swatches.replaceChildren(none, ...PJV_LIST_COLORS.map((c) => {
      const s = el('button', { class: 'pjv-sw' + (color === c ? ' on' : ''), type: 'button', style: 'background:' + c, title: c });
      s.onclick = () => { color = c; paintSw(); };
      return s;
    }));
  };
  paintSw();
  // 상위 스페이스 선택(#766) — 일반 폴더만(스페이스는 최상위 전용이라 숨김). 스페이스 목록을 비동기 로드.
  const initialParent: number | null = editing ? (folder.parent_id ?? null) : (opts.parentId != null ? Number(opts.parentId) : null);
  const parentSel: any = el('select', { class: 'pjv-cat-select' });
  const parentField = el('div', { class: 'field', style: 'margin-top:12px' },
    el('label', { class: 'field-label', text: '상위 스페이스' }), parentSel,
    el('div', { class: 'field-hint', text: '스페이스를 고르면 그 안에 들어가요. ‘없음’이면 최상위.' }));
  if (!isSpace) {
    parentSel.append(el('option', { value: '', text: '불러오는 중…' }));
    parentSel.disabled = true;
    (async () => {
      let folders: any[] = [];
      try { folders = await api('/api/ui/v6/project-folders').then((d) => (d && d.folders) || []); }
      catch (_) { parentSel.replaceChildren(el('option', { value: '', text: '없음 (최상위)' })); parentSel.disabled = false; return; }
      // 스페이스만 상위 후보(자기 자신 제외 — 편집 중 폴더는 스페이스가 아니므로 자동 제외됨).
      const spaces = folders.filter(pjvFolderIsSpace);
      parentSel.replaceChildren(el('option', { value: '', text: '없음 (최상위)' }),
        ...spaces.map((s) => { const o: any = el('option', { value: String(s.id), text: s.name }); if (initialParent != null && Number(initialParent) === Number(s.id)) o.selected = true; return o; }));
      parentSel.disabled = false;
    })();
  }
  const saveBtn = el('button', { class: 'btn btn-primary', text: editing ? '저장' : '만들기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox(editing ? (kindLabel + ' 수정') : ('새 ' + kindLabel),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '색' }), swatches),
    isSpace ? null : parentField,
    el('div', { class: 'pjv-side-nav-hint', style: 'margin-top:10px', text: isSpace ? '스페이스는 최상위 구획이에요 — 안에 폴더·리스트를 담아요.' : '폴더는 정리용이에요 — 멤버·공개범위·상태는 리스트에서 설정해요.' }),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
  let busy = false; // 재진입 가드 — Enter 키반복/Enter+클릭 이중 제출로 2개 생성되던 버그 방지.
  const go = async () => {
    if (busy) return;
    const nm = nameIn.value.trim();
    if (!nm) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    const pid = isSpace ? null : (parentSel.value ? Number(parentSel.value) : null); // 폴더의 상위 스페이스(빈=최상위)
    busy = true; saveBtn.disabled = true;
    try {
      if (editing) {
        const body: any = { name: nm, color: color || null };
        if (!isSpace) body.parent_id = pid;  // 폴더면 상위 반영(이동 포함). 스페이스는 최상위 전용이라 건드리지 않음.
        await api('/api/ui/v6/project-folders/' + folder.id, { method: 'POST', body: JSON.stringify(body) });
      } else {
        const body: any = { name: nm, color: color || null };
        if (isSpace) body.kind = 'space';
        else if (pid != null) body.parent_id = pid;
        // 새 폴더/스페이스는 맨 위로(#473 후속) — 배치 재정렬 엔드포인트(#541 — 서버가 1..n 재부여).
        const r = await api('/api/ui/v6/project-folders', { method: 'POST', body: JSON.stringify(body) });
        const newId = r && (r.folder ? r.folder.id : r.id);
        if (newId != null) {
          try {
            const d = await api('/api/ui/v6/project-folders');
            const others = ((d && d.folders) || []).map((x) => x.id).filter((x) => x !== newId);
            if (others.length) await api('/api/ui/v6/project-folders-reorder', { method: 'POST', body: JSON.stringify({ ids: [newId, ...others] }) });
          } catch (_) { /* 재정렬 실패해도 생성은 됨 */ }
        }
      }
      back.remove(); toast(editing ? (kindLabel + '를 수정했습니다') : (kindLabel + '를 만들었습니다')); if (reload) reload();
    } catch (e) { toast('실패 — ' + e.message, true); busy = false; saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  return back;
}

// 리스트 색 팔레트(생성/수정 폼). 빈값='자동'(id 해시색).
const PJV_LIST_COLORS = ['#6c8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#64748b'];

// 새 리스트 / 리스트 수정 폼 — 이름·색 (+ 생성 시 참여 멤버). 저장 후 reload.
//  opts.onCreated(list) — 생성(수정 아님) 성공 시 새로 만든 영역(서버 응답 { list })을 넘긴다.
//  새 프로젝트 모달의 분류(영역) 피커가 인라인으로 영역을 만들고 곧장 선택하는 데 쓴다(#337).
// 리스트 설정 아이콘 후보(이모지) — 색 체크글리프 대신 리스트마다 이모지 지정(#475 Color & Icon).
const PJV_LIST_ICONS = ['📁', '📗', '📘', '📙', '💎', '⚙️', '🚀', '🧭', '🧱', '🗂️', '📊', '🔒', '💡', '🎯', '🧪'];
// 리스트 카테고리(도메인) 단일 선택 필드(#541 후속) — 카테고리는 리스트 소유, 소속 프로젝트가 상속. space 별 그룹 드롭다운.
function pjvListCategoryField(currentId) {
  const cur = currentId != null && Number(currentId) > 0 ? Number(currentId) : null;
  const selectEl: any = el('select', { class: 'pjv-cat-select', disabled: 'disabled' }); // 옵션 로드 전 잠금(오클리어 방지)
  selectEl.append(el('option', { value: '', text: '불러오는 중…' }));
  let loaded = false;
  (async () => {
    let cats: any[] = [];
    try { cats = await api('/api/ui/categories').then((d) => (d && d.categories) || []); } catch (_) { /* 실패 시 loaded=false 유지 → 저장이 현재값 보존 */ return; }
    selectEl.replaceChildren(el('option', { value: '', text: '미분류 (카테고리 없음)' }));
    const bySpace: any = {};
    for (const c of cats) (bySpace[c.space] = bySpace[c.space] || []).push(c);
    for (const sp of ['business', 'product', 'system']) {
      const list = bySpace[sp]; if (!list || !list.length) continue;
      const og: any = el('optgroup', { label: SPACE_LABEL[sp] || sp });
      for (const c of list) {
        const o: any = el('option', { value: String(c.id), text: c.name || c.key });
        if (cur === Number(c.id)) o.selected = true;
        og.append(o);
      }
      selectEl.append(og);
    }
    selectEl.disabled = false;
    loaded = true;
  })();
  const row = el('div', { class: 'field', style: 'margin-top:12px' },
    el('label', { class: 'field-label', text: '카테고리 (도메인)' }),
    selectEl,
    el('div', { class: 'field-hint', text: '이 리스트의 프로젝트가 이 카테고리(도메인)를 물려받아요. 카테고리는 관리탭 ▸ 분류 체계에서 만들어요.' }));
  // getSelected: 옵션 로드 전/실패면 undefined → 저장 body 에서 category_id 를 아예 빼 현재값 보존(오클리어 방지 F5).
  //  로드 후엔 선택값(빈 문자열=미분류=null). 호출부는 undefined 를 '무변경'으로 다뤄야 한다.
  return { row, getSelected: () => { if (!loaded) return undefined; const v = selectEl.value; return v ? Number(v) : null; } };
}

function openListForm(reload, list?, opts?) {
  opts = opts || {};
  const editing = !!list;
  const nameIn = el('input', { type: 'text', value: editing ? list.name : '', placeholder: '리스트 이름 (예: 컨텍스트 저장소)', maxlength: '120' });
  let color = editing ? (list.color || '') : '';
  const swatches = el('div', { class: 'pjv-color-swatches' });
  const paintSw = () => {
    const none = el('button', { class: 'pjv-sw pjv-sw-none' + (color ? '' : ' on'), type: 'button', title: '자동(이름 해시색)', text: 'A' });
    none.onclick = () => { color = ''; paintSw(); };
    swatches.replaceChildren(none, ...PJV_LIST_COLORS.map((c) => {
      const s = el('button', { class: 'pjv-sw' + (color === c ? ' on' : ''), type: 'button', style: 'background:' + c, title: c });
      s.onclick = () => { color = c; paintSw(); };
      return s;
    }));
  };
  paintSw();
  // 아이콘(이모지) — settings.icon. 빈값=색 체크글리프(기본).
  let icon = editing ? ((list.settings && list.settings.icon) || '') : '';
  const iconRow = el('div', { class: 'pjv-icon-swatches' });
  const paintIcon = () => {
    const none = el('button', { class: 'pjv-sw pjv-sw-none' + (icon ? '' : ' on'), type: 'button', title: '기본(색 체크)', text: '∅' });
    none.onclick = () => { icon = ''; paintIcon(); };
    iconRow.replaceChildren(none, ...PJV_LIST_ICONS.map((em) => {
      const s = el('button', { class: 'pjv-sw pjv-sw-emoji' + (icon === em ? ' on' : ''), type: 'button', text: em, title: em });
      s.onclick = () => { icon = em; paintIcon(); };
      return s;
    }));
  };
  paintIcon();
  // 공개범위 — open(전원) / members(리스트 멤버만). 기본 open. 폼 톤에 맞춘 카드형 토글(#500).
  //  카드 전체가 스위치(role=switch) — 안의 스위치는 시각 표시만(중첩 button 회피).
  let visibility = editing ? (list.visibility || 'open') : 'open';
  const visSw = el('span', { class: 'pjv-switch' + (visibility === 'members' ? ' on' : '') }, el('span', { class: 'pjv-switch-knob' }));
  const visRow = el('div', { class: 'pjv-visrow' + (visibility === 'members' ? ' on' : ''), role: 'switch', tabindex: '0',
    'aria-checked': visibility === 'members' ? 'true' : 'false' },
    el('span', { class: 'pjv-visrow-txt' },
      el('span', { class: 'pjv-visrow-title', text: '공개범위를 멤버로 제한' }),
      el('span', { class: 'pjv-visrow-hint', text: '켜면 멤버가 아닌 사람에겐 이 리스트와 프로젝트가 보이지 않아요.' })),
    visSw);
  const toggleVis = () => {
    visibility = visibility === 'members' ? 'open' : 'members';
    const on = visibility === 'members';
    visRow.classList.toggle('on', on);
    visSw.classList.toggle('on', on);
    visRow.setAttribute('aria-checked', on ? 'true' : 'false');
  };
  visRow.onclick = (e) => { e.stopPropagation(); toggleVis(); };
  visRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVis(); } });
  // 카테고리(도메인) 소유(#541 후속) — 리스트가 카테고리를 이고 소속 프로젝트가 상속(프로젝트 단위 지정 폐지).
  const catField = pjvListCategoryField(editing ? (list.category_id ?? null) : (opts.categoryId ?? null));
  // 멤버 — 생성뿐 아니라 수정 때도 편집(만든 뒤에도 속성 수정). 수정이면 현재 멤버를 프리필.
  const picker = memberPicker(editing ? (list.members || []).map((m) => m.member_id) : [], { includeMe: !editing });
  // #729 새 리스트 상태 체계 — 스페이스 기본 상속(기본, 재생성 불필요) 또는 저장된 템플릿에서 시작.
  let statusTmplSelect: any = null;
  let statusTmplField: any = null;
  if (!editing) {
    statusTmplSelect = el('select', { class: 'pjv-newlist-tmpl' });
    const paintTmplOpts = () => {
      statusTmplSelect.replaceChildren(el('option', { value: '', text: '스페이스 기본 상속 (권장)' }));
      for (const t of pjvStatusTemplatesCache) statusTmplSelect.append(el('option', { value: String(t.id), text: t.name + (t.is_default ? '  ★ 기본' : '') }));
    };
    paintTmplOpts();
    if (!pjvStatusTemplatesCache.length) pjvLoadStatusTemplates().then(paintTmplOpts).catch(() => {});
    statusTmplField = el('div', { class: 'field', style: 'margin-top:12px' },
      el('label', { class: 'field-label', text: '상태 체계' }), statusTmplSelect,
      el('div', { class: 'field-hint', text: '기본은 스페이스 기본 상태를 물려받아요(리스트마다 다시 만들 필요 없음). 저장된 템플릿으로 시작할 수도 있어요.' }));
  }
  const saveBtn = el('button', { class: 'btn btn-primary', text: editing ? '저장' : '만들기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const rows: any[] = [
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '색' }), swatches),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '아이콘' }), iconRow),
    catField.row,
    el('div', { class: 'field', style: 'margin-top:12px' },
      el('label', { class: 'field-label', text: '참여 멤버' }), picker.box),
    statusTmplField,
    el('div', { class: 'field', style: 'margin-top:12px' }, visRow),
  ];
  const back = overlayBox(editing ? '리스트 설정' : '새 리스트', ...rows, el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
  let busy = false; // 재진입 가드 — Enter 키반복/Enter+클릭 이중 제출로 2개 생성되던 버그 방지(버튼 disabled 는 keydown 경로를 못 막음).
  const go = async () => {
    if (busy) return;
    const nm = nameIn.value.trim();
    if (!nm) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    busy = true; saveBtn.disabled = true;
    try {
      if (editing) {
        await api('/api/ui/v6/project-lists/' + list.id, { method: 'POST', body: JSON.stringify({ name: nm, color: color || null, visibility, category_id: catField.getSelected() }) });
        await api('/api/ui/v6/project-lists/' + list.id + '/settings', { method: 'POST', body: JSON.stringify({ settings: { icon: icon || null } }) }).catch(() => {});
        await pjvSaveListMembers(list.id, picker.getSelected());
      } else {
        const res = await api('/api/ui/v6/project-lists', { method: 'POST', body: JSON.stringify({ name: nm, color: color || null, members: picker.getSelected(), category_id: catField.getSelected() }) });
        const created = (res && res.list) || null;
        if (created && created.id) {
          if (visibility !== 'open') await api('/api/ui/v6/project-lists/' + created.id, { method: 'POST', body: JSON.stringify({ visibility }) }).catch(() => {});
          if (icon) await api('/api/ui/v6/project-lists/' + created.id + '/settings', { method: 'POST', body: JSON.stringify({ settings: { icon } }) }).catch(() => {});
          // #729 상태 체계 — 템플릿 선택 시 그 스킴을 커스텀으로 적용(미선택=스페이스 기본 상속, settings 미변경).
          if (statusTmplSelect && statusTmplSelect.value) {
            const t = pjvStatusTemplatesCache.find((x) => String(x.id) === statusTmplSelect.value);
            const statuses = t ? pjvNormStatusDefs(t.statuses) : [];
            if (statuses.length) await api('/api/ui/v6/project-lists/' + created.id + '/settings', { method: 'POST', body: JSON.stringify({ settings: { statusMode: 'custom', statuses } }) }).catch(() => {});
          }
          if (opts.folderId != null) await api('/api/ui/v6/project-lists/' + created.id + '/folder', { method: 'POST', body: JSON.stringify({ folder_id: opts.folderId }) }).catch(() => {});
        }
        if (opts.onCreated) opts.onCreated(created);
      }
      back.remove(); toast(editing ? '리스트를 수정했습니다' : '리스트를 만들었습니다'); if (reload) reload();
    } catch (e) { toast('실패 — ' + e.message, true); busy = false; saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  return back;
}

// ══════════════════════════════════════════════════════════════════════════
// 리스트별 상태 편집기(#475 Task statuses) — 클릭업 'Edit statuses' 화면 대응.
//  할 일/진행 중/완료 3버킷 안에 커스텀 단계(기획중·개발중·QA중·보류 등)를 추가/이름·색/정렬/삭제.
//  저장: settings.statusMode('inherit'|'custom') + settings.statuses[{key,label,color,category}] (/project-lists/:id/settings).
// ══════════════════════════════════════════════════════════════════════════
function pjvListStatusEditor(list, reload) {
  let mode = pjvListIsCustomStatus(list) ? 'custom' : 'inherit';
  // 작업용 복사본 — 커스텀이면 현재 정의, 아니면 기본 3단계 복사(커스텀 전환 시 출발점).
  let defs = pjvListStatusDefs(list).map((d) => ({ key: d.key, label: d.label, color: d.color, category: d.category }));
  let keySeq = 1;
  const genKey = (label) => {
    const base = String(label || 'status').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'status';
    let k = base; while (defs.some((d) => d.key === k)) k = base + '-' + (keySeq++);
    return k;
  };
  const groupsBox = el('div', { class: 'pjv-statused-groups' });

  const moveDef = (d, dir) => {
    const sameCat = defs.filter((x) => x.category === d.category);
    const i = sameCat.indexOf(d); const j = i + dir;
    if (j < 0 || j >= sameCat.length) return;
    // 전체 defs 배열에서 두 항목 위치 교환.
    const gi = defs.indexOf(sameCat[i]); const gj = defs.indexOf(sameCat[j]);
    [defs[gi], defs[gj]] = [defs[gj], defs[gi]]; paint();
  };
  const delDef = (d) => {
    const sameCat = defs.filter((x) => x.category === d.category);
    // Closed 는 비워도 됨(선택), Active·Done 은 최소 1개.
    if (d.category !== 'closed' && sameCat.length <= 1) { toast('Active·Done 버킷엔 최소 1개 상태가 필요해요', true); return; }
    defs = defs.filter((x) => x !== d); paint();
  };
  const addDef = (category) => {
    const label = '새 상태';
    defs.push({ key: genKey(label), label, color: PJV_LIST_COLORS[defs.length % PJV_LIST_COLORS.length], category });
    paint();
  };
  const pickColor = (anchor, d) => {
    const menu = el('div', { class: 'pjv-menu pjv-color-pop' });
    const close = pjvPopover(anchor, menu);
    const wrap = el('div', { class: 'pjv-color-swatches' });
    for (const c of PJV_LIST_COLORS) {
      const s = el('button', { class: 'pjv-sw' + (d.color === c ? ' on' : ''), type: 'button', style: 'background:' + c, title: c });
      s.onclick = () => { d.color = c; close(); paint(); };
      wrap.append(s);
    }
    menu.append(wrap);
  };

  const paint = () => {
    groupsBox.classList.toggle('inherit', mode !== 'custom');
    groupsBox.replaceChildren();
    pjvAssignFracs(defs);  // Active 진행 파이 갱신 — 순서·개수(1/n) 반영(#499)
    for (const cat of PJV_STATUS_CATS) {
      const rows = el('div', { class: 'pjv-statused-rows' });
      for (const d of defs.filter((x) => x.category === cat.key)) {
        const dot = el('button', { class: 'pjv-status-btn', type: 'button', title: mode === 'custom' ? '색 변경' : undefined,
          disabled: mode !== 'custom' ? 'disabled' : undefined }, pjvStatusIcon(d.category, d.color, d.frac));
        dot.onclick = (e) => { e.stopPropagation(); if (mode === 'custom') pickColor(dot, d); };
        const nameIn = el('input', { class: 'pjv-statused-name', type: 'text', value: d.label, maxlength: '40', disabled: mode !== 'custom' ? 'disabled' : undefined });
        nameIn.addEventListener('input', () => { d.label = nameIn.value; });
        const more = el('button', { class: 'pjv-trow-more', type: 'button', title: '상태 작업', text: '⋯' });
        more.onclick = (e) => {
          e.stopPropagation();
          const m = el('div', { class: 'pjv-menu' }); const close = pjvPopover(more, m);
          const mk = (label, fn, danger?) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
          m.append(mk('위로', () => moveDef(d, -1)), mk('아래로', () => moveDef(d, 1)), el('div', { class: 'pjv-bulk-sep-h' }), mk('삭제', () => delDef(d), true));
        };
        rows.append(el('div', { class: 'pjv-statused-row' },
          el('span', { class: 'pjv-statused-grip', 'aria-hidden': 'true', text: '⠿' }), dot, nameIn,
          mode === 'custom' ? more : null));
      }
      const addBtn = el('button', { class: 'pjv-statused-add', type: 'button', onclick: () => addDef(cat.key) },
        el('span', { class: 'pjv-newlist-plus', text: '＋' }), el('span', { text: '상태 추가' }));
      // 버킷 헤더 — 라벨 + 우측 ＋(클릭업처럼 헤더에서 바로 추가).
      const catAdd = mode === 'custom'
        ? el('button', { class: 'pjv-statused-cat-add', type: 'button', title: cat.label + ' 상태 추가', 'aria-label': cat.label + ' 상태 추가', text: '＋', onclick: () => addDef(cat.key) })
        : null;
      groupsBox.append(el('div', { class: 'pjv-statused-cat' },
        el('div', { class: 'pjv-statused-cat-h' }, el('span', { text: cat.label }), catAdd), rows, mode === 'custom' ? addBtn : null));
    }
  };

  // 좌측 — 상태 타입 라디오.
  const radio = (val, label, hint) => {
    const on = mode === val;
    const r = el('button', { class: 'pjv-statused-radio' + (on ? ' on' : ''), type: 'button' },
      el('span', { class: 'pjv-statused-radio-mark' }),
      el('span', {}, el('div', { class: 'pjv-statused-radio-label', text: label }), el('div', { class: 'pjv-statused-radio-hint', text: hint })));
    r.onclick = () => { mode = val; paintRadios(); paint(); };
    return r;
  };
  const radios = el('div', { class: 'pjv-statused-radios' });
  const paintRadios = () => radios.replaceChildren(
    radio('inherit', '기본(스페이스) 상태 사용',
      (pjvSpaceDefaultDefs && pjvSpaceDefaultDefs.length)
        ? ('스페이스 기본 상태 체계를 따름 — ' + pjvSpaceDefaultDefs.map((d) => d.label).join(' · '))
        : '할 일 · 진행 중 · 완료 (표준 3단계)'),
    radio('custom', '커스텀 상태 사용', '이 리스트만의 상태 — 버킷 안에 중간 단계를 자유롭게'));
  paintRadios(); paint();

  // #729 템플릿 바 — 저장된 템플릿 불러오기(적용) + 현재 구성을 템플릿으로 저장(스페이스 기본 지정 가능).
  //  클릭업 'Edit statuses' 의 'Inherit from Space' + 'Save template' 대응. 리스트마다 재생성하던 문제 해소.
  const tmplSelect: any = el('select', { class: 'pjv-statused-tmpl' });
  const paintTmpl = () => {
    tmplSelect.replaceChildren(el('option', { value: '', text: '템플릿 불러오기…' }));
    for (const t of pjvStatusTemplatesCache) tmplSelect.append(el('option', { value: String(t.id), text: t.name + (t.is_default ? '  ★ 기본' : '') }));
  };
  paintTmpl();
  tmplSelect.onchange = () => {
    const id = Number(tmplSelect.value); tmplSelect.value = '';
    if (!id) return;
    const t = pjvStatusTemplatesCache.find((x) => Number(x.id) === id);
    const loaded = t ? pjvNormStatusDefs(t.statuses) : [];
    if (!loaded.length) { toast('빈 템플릿이에요', true); return; }
    mode = 'custom';
    defs = loaded.map((d) => ({ key: d.key, label: d.label, color: d.color, category: d.category }));
    paintRadios(); paint();
    toast('‘' + t.name + '’ 불러옴 — 저장하면 이 리스트에 적용돼요');
  };
  const saveTmplBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 템플릿으로 저장',
    onclick: () => pjvSaveStatusTemplate(defs, reload, paintTmpl) });
  const tmplBar = el('div', { class: 'pjv-statused-tmplbar' },
    el('div', { class: 'field-label', text: '템플릿' }),
    el('div', { class: 'pjv-statused-tmplrow' }, tmplSelect, saveTmplBtn),
    el('div', { class: 'field-hint', text: '스페이스 단위로 상태 체계를 재사용해요. 저장 시 ‘스페이스 기본’으로 지정하면 새 리스트가 자동으로 상속합니다.' }));

  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const layout = el('div', { class: 'pjv-statused' },
    el('div', { class: 'pjv-statused-left' }, el('div', { class: 'field-label', text: '상태 유형' }), radios, tmplBar),
    el('div', { class: 'pjv-statused-right' }, groupsBox));
  const back = overlayBox('‘' + list.name + '’ 상태 편집', layout, el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  saveBtn.onclick = async () => {
    // 검증 — 커스텀이면 각 상태 라벨 채우고, 각 버킷 최소 1개.
    let statuses: any[] = [];
    if (mode === 'custom') {
      for (const d of defs) { if (!String(d.label).trim()) { toast('상태 이름을 모두 입력하세요', true); return; } }
      // Active·Done 은 최소 1개, Closed 는 선택(비워도 됨).
      for (const cat of PJV_STATUS_CATS) if (cat.key !== 'closed' && !defs.some((d) => d.category === cat.key)) { toast('‘' + cat.label + '’에 상태가 최소 1개 필요해요', true); return; }
      statuses = defs.map((d) => ({ key: d.key, label: String(d.label).trim(), color: d.color, category: d.category }));
    }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/v6/project-lists/' + list.id + '/settings', { method: 'POST', body: JSON.stringify({ settings: { statusMode: mode, statuses } }) });
      back.remove(); toast('상태를 저장했습니다'); if (reload) reload();
    } catch (e) { toast('저장 실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  return back;
}

// #729 현재 상태 구성을 재사용 템플릿으로 저장 — 이름 + '스페이스 기본으로 지정' 옵션. 저장 후 캐시 리로드·드롭다운 갱신.
//  스페이스 기본으로 지정하면 inherit(기본 상태 사용) 리스트·새 리스트가 이 스킴을 물려받는다(reload 로 반영).
function pjvSaveStatusTemplate(defs, reload, refreshSelect) {
  for (const d of defs) if (!String(d.label).trim()) { toast('상태 이름을 모두 입력하세요', true); return; }
  for (const cat of PJV_STATUS_CATS) if (cat.key !== 'closed' && !defs.some((d) => d.category === cat.key)) { toast('‘' + cat.label + '’에 상태가 최소 1개 필요해요', true); return; }
  const statuses = defs.map((d) => ({ key: d.key, label: String(d.label).trim(), color: d.color, category: d.category }));
  const nameIn = el('input', { type: 'text', placeholder: '템플릿 이름 (예: 개발 표준)', maxlength: '120' });
  const defChk: any = el('input', { type: 'checkbox' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const back = overlayBox('상태 템플릿으로 저장',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('label', { class: 'pjv-tmpl-defrow' }, defChk, el('span', { text: '스페이스 기본으로 지정 — 새 리스트·기본 상속 리스트가 이 체계를 따름' })),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const nm = nameIn.value.trim();
    if (!nm) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/v6/status-templates', { method: 'POST', body: JSON.stringify({ name: nm, statuses, is_default: defChk.checked }) });
      await pjvLoadStatusTemplates();
      if (refreshSelect) refreshSelect();
      back.remove();
      toast(defChk.checked ? '템플릿 저장 + 스페이스 기본으로 지정했어요' : '템플릿을 저장했어요');
      if (defChk.checked && reload) reload(); // 스페이스 기본 변경 → inherit 리스트 재렌더
    } catch (e) { toast('저장 실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
}

// 프로젝트를 다른 리스트로 이동(또는 미분류로) — 행 ⋯ 메뉴에서 호출. 리스트 목록을 그 자리에서 fetch.
function pjvMoveProjectList(anchor, p, reload) {
  const menu = el('div', { class: 'pjv-menu pjv-listmove-pop' });
  const close = pjvPopover(anchor, menu);
  const head = el('div', { class: 'pjv-menu-head', text: '리스트로 이동' });
  menu.append(head, el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  api('/api/ui/v6/project-lists').then((d) => {
    const lists = (d && d.lists) || [];
    menu.replaceChildren(head);
    const mkItem = (label, listId, color) => {
      const cur = (p.list_id == null ? listId == null : String(p.list_id) === String(listId));
      const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-list-dot sm', style: 'background:' + (color || 'var(--line, #2a2a33)') }),
        el('span', { class: 'pjv-asg-mname', text: label }),
        el('span', { class: 'pjv-asg-check', text: cur ? '✓' : '' }));
      item.onclick = async (e) => {
        e.stopPropagation(); close();
        if (cur) return;
        try { await api('/api/ui/v6/projects/' + p.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) }); toast(listId == null ? '미분류로 옮겼습니다' : '리스트로 옮겼습니다'); if (reload) reload(); }
        catch (err) { toast('이동 실패 — ' + err.message, true); }
      };
      return item;
    };
    menu.append(mkItem('기타 (미분류)', null, null));
    for (const l of lists) menu.append(mkItem(l.name, l.id, l.color || avatarColor('list' + l.id)));
    const addNew = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' },
      el('span', { class: 'pjv-sess-add-ico', text: '＋' }), el('span', { text: '새 리스트…' }));
    addNew.onclick = (e) => { e.stopPropagation(); close(); openListForm(reload); };
    menu.append(el('div', { class: 'pjv-bulk-sep-h' }), addNew);
  }).catch((err) => menu.replaceChildren(head, el('div', { class: 'pjv-menu-empty', text: '리스트를 불러오지 못했어요 — ' + err.message })));
}

// 보드 한 섹션(진행 중 / 완료) — 카드 + 개수 배지 + 타일 그리드. renderProjects 의 projectSection 짜임 재사용.
function pjvBoardTile(p) {
  const isDone = p.status === 'done';
  const tile = el('div', { class: 'project-tile' + (isDone ? ' done' : ''),
    role: 'link', tabindex: '0', onclick: () => { location.hash = '#/projects2/p/' + p.id; } });
  tile.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') location.hash = '#/projects2/p/' + p.id; });
  tile.append(el('div', { class: 'project-tile-name', text: p.name }));
  if (p.description) tile.append(el('div', { class: 'project-tile-desc', text: p.description }));
  const mc = Number(p.member_count != null ? p.member_count : (p.members ? p.members.length : 0)) || 0;
  const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
  tile.append(el('div', { class: 'project-tile-foot' },
    el('span', { class: 'project-tile-meta', text: (isDone ? '완료 ' : '갱신 ') + (when ? relTime(when) : '') }),
    el('span', { class: 'pjv-tile-badge' },
      el('span', { class: 'pill-state' + (isDone ? '' : ' confirmed'), text: PJV_STATUS_LABEL[p.status] || p.status }),
      mc ? el('span', { class: 'pjv-tile-members', text: '👤 ' + mc }) : null)));
  return tile;
}

// ════════════════════════════════════════════
// 프로젝트 목록(클릭업식 리스트) — 카드 대신 태스크 리스트와 동일한 그룹/행 UI.
//  진행 중/완료 두 그룹(상태 동그라미·개수·캐럿) + 컬럼 헤더(팀원·갱신) + 프로젝트 한 줄.
//  이름 클릭=상세 이동, 상태 동그라미=진행↔완료 토글. 선택(일괄삭제) 모드면 앞에 체크박스.
// ════════════════════════════════════════════
const PJV_PROJ_GRID = 'minmax(0, 1fr) 140px 120px';

function pjvProjStatusMeta(status) {
  // 태스크 리스트와 동일한 3단계 — 할 일(점선 링)·진행 중(◐)·완료(✓ 민트).
  //  레거시·기본값 'active' 는 '진행 중'으로 흡수(표시만 — 기존 active 프로젝트가 진행 중에 그대로 보이게).
  if (status === 'done') return { key: 'done', label: '완료', cls: 'done', glyph: '✓' };
  if (status === 'todo') return { key: 'todo', label: '할 일', cls: 'todo', glyph: '' };
  return { key: 'in_progress', label: '진행 중', cls: 'inprog', glyph: '◐' };
}

// ══════════════════════════════════════════════════════════════════════════
// 리스트별 커스텀 상태(#475 Task statuses) — 고정 3버킷(할 일/진행 중/완료) 안에 사용자 정의 단계.
//  저장: project_list.settings.statusMode('inherit'|'custom') + settings.statuses[{key,label,color,category}].
//  프로젝트엔 status(CHECK 유효 네이티브 투영: todo|in_progress|done) + status_raw(커스텀 상태 키, 개방 어휘)로 저장.
// ══════════════════════════════════════════════════════════════════════════
// 기본(inherit) 상태 — 클릭업 3버킷(Active/Done/Closed) 표현: 할 일(점선)·진행 중 은 Active,
//  완료 는 Done, Closed 는 기본 비어있음. 커스텀 전환 시 이 세트가 출발점.
const PJV_DEFAULT_STATUS_DEFS = [
  { key: 'todo', label: '할 일', color: '#94a3b8', category: 'active' },
  { key: 'active', label: '진행 중', color: '#f59e0b', category: 'active' },
  { key: 'done', label: '완료', color: '#22c55e', category: 'done' },
];
// 카테고리(버킷) — 클릭업 상태 유형과 동일: Active(진행 파이) → Done(체크) → Closed(채운 체크). #499
const PJV_STATUS_CATS = [
  { key: 'active', label: 'Active' },
  { key: 'done', label: 'Done' },
  { key: 'closed', label: 'Closed' },
];
// 커스텀 상태 category → 저장할 네이티브 status(CHECK 유효 todo|in_progress|done).
//  Done·Closed 는 둘 다 네이티브 done(완료됨), 그 외(Active)는 in_progress. (todo 버킷은 Active 로 흡수 — #499)
function pjvNativeStatusOf(category) { return (category === 'done' || category === 'closed') ? 'done' : 'in_progress'; }
function pjvListIsCustomStatus(list) {
  const s = list && list.settings;
  return !!(s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length);
}
// ── #729 스페이스(워크스페이스) 기본 상태 스킴 + 재사용 템플릿 ──────────────────────────────
//  리스트를 새로 만들 때마다 상태 체계를 재생성하던 문제 해소: is_default 템플릿이 '스페이스 기본'으로,
//  inherit(기본 상태 사용) 리스트가 이 스킴을 물려받는다(하드코딩 3단계 대신). project_status_template 를 로드해 캐시.
let pjvSpaceDefaultDefs: any[] | null = null;      // 스페이스 기본 defs(없으면 null=표준 3단계 폴백)
let pjvStatusTemplatesCache: any[] = [];           // 템플릿 목록(에디터·새 리스트 폼 드롭다운)
let pjvSpaceDefaultId: number | null = null;       // 스페이스 기본 템플릿 id
// 원시 statuses[] → 정규화 defs(리스트 커스텀 상태 정규화와 동형).
function pjvNormStatusDefs(statuses) {
  if (!Array.isArray(statuses)) return [];
  return statuses.filter((x) => x && x.key).map((x) => ({
    key: String(x.key), label: String(x.label || x.key), color: x.color || '#94a3b8',
    category: (x.category === 'done' || x.category === 'closed') ? x.category : 'active',
  }));
}
// 상태 템플릿(스페이스 기본 포함) 로드 — 실패해도 조용히(기본=null → 표준 3단계). 레지스트리 세팅/렌더 전에 await.
async function pjvLoadStatusTemplates() {
  try {
    const d = await api('/api/ui/v6/status-templates');
    pjvStatusTemplatesCache = (d && d.templates) || [];
    pjvSpaceDefaultId = (d && d.default_id) != null ? Number(d.default_id) : null;
    const def = (d && d.default) || pjvStatusTemplatesCache.find((t) => t.is_default) || null;
    const defs = def ? pjvNormStatusDefs(def.statuses) : [];
    pjvSpaceDefaultDefs = defs.length ? defs : null;
  } catch (_) { /* 미설정/실패 → 표준 3단계 폴백 */ }
}
// 리스트의 상태 정의(커스텀이면 그것, 아니면 기본 3단계). 항상 {key,label,color,category,frac} 정규화.
//  frac = Active 버킷 안 진행도(0=첫 상태=점선 할일 → (n-1)/n=거의 가득). Done/Closed 는 체크라 무관. #499
function pjvListStatusDefs(list) {
  let defs;
  if (pjvListIsCustomStatus(list)) {
    defs = list.settings.statuses.filter((x) => x && x.key).map((x) => ({
      key: String(x.key), label: String(x.label || x.key), color: x.color || '#94a3b8',
      // 레거시 'todo' 카테고리는 Active 로 흡수, 'closed' 신규 허용, 그 외는 Active.
      category: (x.category === 'done' || x.category === 'closed') ? x.category : 'active',
    }));
  } else {
    // #729 inherit(기본 상태 사용) — 하드코딩 3단계 대신 스페이스 기본 스킴을 상속(있으면).
    const base = (pjvSpaceDefaultDefs && pjvSpaceDefaultDefs.length) ? pjvSpaceDefaultDefs : PJV_DEFAULT_STATUS_DEFS;
    defs = base.map((d) => ({ ...d }));
  }
  return pjvAssignFracs(defs);
}
// Active 버킷 정의들에 진행도 frac(순서 i / 개수 n) 부여 — 파이차트 채움용. 첫 상태=0(점선). #499
function pjvAssignFracs(defs) {
  const act = defs.filter((d) => d.category === 'active');
  const n = act.length;
  act.forEach((d, i) => { d.frac = n > 0 ? i / n : 0; });
  return defs;
}
// 보드 렌더 동안 리스트별 커스텀 상태 레지스트리 — 프로젝트 행의 상태 동그라미/메뉴가 소속 리스트 상태를 참조(어느 뷰든).
let pjvStatusReg = new Map<number, any[]>();
function pjvSetStatusRegistry(lists) {
  pjvStatusReg = new Map();
  const hasSpaceDefault = !!(pjvSpaceDefaultDefs && pjvSpaceDefaultDefs.length);
  for (const l of lists || []) {
    // 커스텀이면 그 스킴을, 아니면(inherit) 스페이스 기본이 있을 때만 등록 — 그래야 inherit 리스트의 프로젝트/태스크
    //  행도 스페이스 기본 상태(색·이름)로 보인다. 스페이스 기본이 없으면 등록 안 함(네이티브 3단계 폴백 경로 유지).
    if (pjvListIsCustomStatus(l) || hasSpaceDefault) pjvStatusReg.set(Number(l.id), pjvListStatusDefs(l));
  }
}
// #731 프로젝트 id → 소속 리스트 id 맵. 태스크/하위태스크는 list_id 가 없어(부모 체인으로 해소), 행 상태칩이
//  '루트 프로젝트의 리스트' 커스텀 상태를 쓰게 하는 다리. 프로젝트 행/상세가 렌더될 때 채워진다(그 뒤 태스크 행이 그림).
let pjvProjListReg = new Map<number, number | null>();
function pjvRegisterProjList(projectId, listId) {
  if (projectId != null) pjvProjListReg.set(Number(projectId), listId != null ? Number(listId) : null);
}
// 태스크(하위 포함)의 상태 정의 — 루트 프로젝트 id 로 소속 리스트를 찾아 커스텀 상태 defs 반환(없으면 null=네이티브 3단계).
function pjvTaskStatusDefs(projectId) {
  if (projectId == null) return null;
  const listId = pjvProjListReg.get(Number(projectId));
  if (listId == null) return null;
  const defs = pjvStatusReg.get(Number(listId));
  return (defs && defs.length) ? defs : null;
}
// 커스텀 상태 defs 에서 (status_raw 우선, 없으면 네이티브 status 흡수) 현재 상태 def 해소 — 프로젝트/태스크 공용.
function pjvResolveStatusDef(statusRaw, status, defs) {
  if (!defs || !defs.length) return null;
  const rawKey = statusRaw || status;
  let d = defs.find((x) => x.key === rawKey);
  if (!d) {
    if (status === 'done') d = defs.find((x) => x.category === 'done') || defs.find((x) => x.category === 'closed') || null;
    else d = defs.find((x) => x.category === 'active') || null;
  }
  return d;
}
// 프로젝트의 실제 상태 정의(커스텀 리스트면 커스텀 def, 아니면 null=기본 meta). status_raw 우선, 없으면 카테고리로 흡수.
function pjvResolveProjStatus(p) {
  if (p == null || p.list_id == null) return null;
  const defs = pjvStatusReg.get(Number(p.list_id));
  if (!defs || !defs.length) return null;
  const rawKey = p.status_raw || p.status;
  let d = defs.find((x) => x.key === rawKey);
  if (!d) {
    // 미스매치는 네이티브 status 로 흡수 — done 은 Done(없으면 Closed), 그 외는 Active 첫 상태.
    if (p.status === 'done') d = defs.find((x) => x.category === 'done') || defs.find((x) => x.category === 'closed') || null;
    else d = defs.find((x) => x.category === 'active') || null;
  }
  return d;
}
// 카테고리 → 기본 클래스(버킷별 CSS 훅). 아이콘 자체는 pjvStatusIcon 이 그린다(#499).
function pjvCatMeta(category) {
  if (category === 'closed') return { cls: 'closed', glyph: '✓' };
  if (category === 'done') return { cls: 'done', glyph: '✓' };
  return { cls: 'inprog', glyph: '' };
}
// 상태 아이콘(SVG) — 클릭업 스타일(#499). 사이트 전역 진행도 아이콘의 단일 출처:
//  · Active: 진행도 파이(frac=0 → 점선 빈 링='할일', 커질수록 시계방향으로 채워짐).
//  · Done:  색 링 + 체크.   · Closed: 색으로 꽉 채운 원 + 흰 체크.
//  색은 inline style 로 넣어 CSS 변수(var(--blue) 등)도 해석되게 한다(setAttribute fill 은 var 미해석).
function pjvStatusIcon(category, color, frac, size?) {
  const px = size === 'sm' ? 15 : 18;
  const c = color || 'var(--muted-3)';
  const R = 9, cx = 12, cy = 12;
  const svg = sv('svg', { class: 'pjv-status-ic' + (size ? ' ' + size : ''), viewBox: '0 0 24 24', width: px, height: px, 'aria-hidden': 'true' });
  if (category === 'done' || category === 'closed') {
    const filled = category === 'closed';
    svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, style: 'fill:' + (filled ? c : 'none') + ';stroke:' + c }));
    svg.append(sv('path', { d: 'M7.7 12.3l2.7 2.7 5.9-6.2', 'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: 'fill:none;stroke:' + (filled ? '#fff' : c) }));
    return svg;
  }
  // Active — 진행도 파이.
  const f = Math.max(0, Math.min(0.995, frac || 0));
  if (f < 0.001) {
    svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, 'stroke-dasharray': '2.2 2.4', style: 'fill:none;stroke:' + c }));
  } else {
    svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, opacity: 0.3, style: 'fill:none;stroke:' + c }));
    const th = f * 2 * Math.PI;
    const ex = (cx + R * Math.sin(th)).toFixed(2), ey = (cy - R * Math.cos(th)).toFixed(2);
    const large = f > 0.5 ? 1 : 0;
    svg.append(sv('path', { d: 'M' + cx + ' ' + cy + 'L' + cx + ' ' + (cy - R) + 'A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + ex + ' ' + ey + 'Z', style: 'fill:' + c }));
  }
  return svg;
}
// 표준 3상태(todo|in_progress|done) → 통일 상태 아이콘. 사이트 전역(프로젝트·태스크·하위태스크) 공통 진행도 아이콘.
//  todo=점선 빈 링, in_progress=반쯤 채운 파이, done=색 링+체크.
//  색은 PJV_DEFAULT_STATUS_DEFS(상태 편집 창의 기본 3단계)와 단일 출처(#667) — 예전 파랑/민트 테마변수는
//  상태 편집 창(주황 진행·초록 완료)과 어긋나 '기본 상태'가 outdated 파란 아이콘으로 보였다.
function pjvStatusIconStd(status, size?) {
  const color = (k, fb) => { const d = PJV_DEFAULT_STATUS_DEFS.find((x) => x.key === k); return (d && d.color) || fb; };
  if (status === 'done') return pjvStatusIcon('done', color('done', '#22c55e'), undefined, size);
  if (status === 'todo') return pjvStatusIcon('active', color('todo', '#94a3b8'), 0, size);
  return pjvStatusIcon('active', color('active', '#f59e0b'), 0.5, size); // in_progress — 반 파이
}
// 네이티브 상태(todo|in_progress|done) → 기본 상태색(PJV_DEFAULT_STATUS_DEFS 단일 출처). 상태 그룹 헤더 pill 배경용(#670 통일감).
//  in_progress 는 기본 def 키 'active' 로 대응. 커스텀 리스트의 pill 과 같은 표현으로 inherit/기본 리스트도 통일.
function pjvNativeStatusColor(status) {
  const k = status === 'in_progress' ? 'active' : status;
  const d = PJV_DEFAULT_STATUS_DEFS.find((x) => x.key === k);
  return (d && d.color) || '#94a3b8';
}
// 클릭 가능한 상태 아이콘 버튼 래퍼 — SVG 아이콘 + 투명 버튼(경계·배경 없음).
function pjvStatusIconBtn(icon, attrs?) {
  return el('button', { class: 'pjv-status-btn', type: 'button', ...(attrs || {}) }, icon);
}
// 커스텀 상태 아이콘 — 파이/체크(pjvStatusIcon). size='sm' 작게.
function pjvCustomStatusDot(def, size?) {
  return pjvStatusIcon(def.category, def.color, def.frac, size);
}
// 프로젝트를 커스텀 상태로 변경 — 네이티브 status 투영 + status_raw(커스텀 키) 저장.
async function pjvSetProjStatusCustom(id, def, reload) {
  try {
    await api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: pjvNativeStatusOf(def.category), status_raw: def.key }) });
    toast('‘' + def.label + '’(으)로 옮겼습니다');
    pjvReloadKeepScroll(reload);
  } catch (e) { toast('실패 — ' + e.message, true); }
}

// 상태 그룹 렌더(사이드바 본문) — 단일 리스트 선택이고 커스텀 상태면 각 상태를 그룹으로(스크린샷),
//  아니면(전체/폴더/미분류/기본 리스트) 표준 3버킷. #475.
// ── 그룹바이 파리티(#541) — ClickUp 뷰의 group by(field+dir)를 기본값으로, 리스트별 로컬 오버라이드 저장. ──
//  필드: status(상태)|assignee(담당자)|priority(우선순위)|due(마감일)|tag(태그). dir 1=오름/-1=내림(ClickUp grouping.dir 동형).
const PJV_GROUPBY_FIELDS = [
  { key: 'status', label: '상태' }, { key: 'assignee', label: '담당자' },
  { key: 'priority', label: '우선순위' }, { key: 'due', label: '마감일' }, { key: 'tag', label: '태그' },
];
const PJV_CU_GROUP_MAP = { status: 'status', assignee: 'assignee', assignees: 'assignee', priority: 'priority', dueDate: 'due', due_date: 'due', duedate: 'due', tag: 'tag', tags: 'tag' };
function pjvGroupByStoreKey(scope) { return 'pjv:groupBy:' + (scope == null || scope === '' ? 'all' : scope); }
// 그룹 기준의 저장 스코프(#1067) — 리스트면 그 리스트 id(기존 키 그대로 유지), 아니면 스코프 키(F<id>/__all__/__none__).
//  예전엔 리스트 스코프에서만 그룹을 바꿀 수 있어 폴더·스페이스에선 버튼이 죽어 있었다(ClickUp 은 폴더에서도 Group: Status).
function pjvGroupScope(selList, scopeKey) { return selList ? String(selList.id) : (scopeKey || 'all'); }
function pjvGetGroupBy(selList, cu, scopeKey?) {
  try {
    const v = JSON.parse(localStorage.getItem(pjvGroupByStoreKey(pjvGroupScope(selList, scopeKey))) || 'null');
    if (v && v.field) return { field: v.field, dir: v.dir === -1 ? -1 : 1 };
  } catch (_) { /* noop */ }
  const g = cu && cu.view_grouping;
  const f = g && PJV_CU_GROUP_MAP[String(g.field)];
  if (f) return { field: f, dir: g.dir === -1 ? -1 : 1, fromView: true };
  return { field: 'status', dir: 1 };
}
function pjvSetGroupBy(selList, v, scopeKey?) {
  try {
    const k = pjvGroupByStoreKey(pjvGroupScope(selList, scopeKey));
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch (_) { /* noop */ }
}
// 상태(그룹) 접힘 상태 저장(#req) — 리스트+그룹 단위로 localStorage 에 저장해 새로고침에도 유지된다.
//  기본은 펼침(키 없음); 접으면 '0' 을 저장하고, 다시 펼치면 키를 지워 기본(펼침)으로 되돌린다(저장소 정리).
//  gid = 커스텀 상태 key | 기본 3버킷 statusKey('in_progress'|'todo'|'done') | (필드 그룹) 라벨.
//  이유: 태스크 수십 개인 조직에서 매 새로고침마다 다 펼쳐지면 원하는 그룹까지 매번 접어야 해 불편(#req).
function pjvGrpOpenKey(listId, gid) { return 'pjv:grpOpen:' + (listId == null ? 'all' : listId) + ':' + gid; }
function pjvGrpOpenGet(listId, gid) { try { return localStorage.getItem(pjvGrpOpenKey(listId, gid)) !== '0'; } catch (_) { return true; } }
function pjvGrpOpenSet(listId, gid, open) {
  try { const k = pjvGrpOpenKey(listId, gid); if (open) localStorage.removeItem(k); else localStorage.setItem(k, '0'); } catch (_) { /* noop */ }
}

// ── 그룹 내 컬럼 정렬(#541) — 헤더 클릭 3-state(오름→내림→해제). 기본값 = ClickUp 뷰 sorting.fields[0]. ──
//  key: 'name'|'team'|'due'|'start'|'created'|'updated'|'priority'|'cu:<externalId>'. 저장값 {key,dir} | {off:true}(뷰 기본도 끔).
const PJV_CU_SORT_MAP = { name: 'name', assignee: 'team', assignees: 'team', dueDate: 'due', due_date: 'due', duedate: 'due', startDate: 'start', start_date: 'start', dateCreated: 'created', date_created: 'created', dateUpdated: 'updated', date_updated: 'updated', priority: 'priority' };
function pjvColSortStoreKey(listId) { return 'pjv:colSort:' + (listId == null ? 'all' : listId); }
function pjvGetColSort(selList, cu) {
  try {
    const v = JSON.parse(localStorage.getItem(pjvColSortStoreKey(selList && selList.id)) || 'null');
    if (v && v.off) return null;
    if (v && v.key) return { key: v.key, dir: v.dir === -1 ? -1 : 1 };
  } catch (_) { /* noop */ }
  const s = cu && Array.isArray(cu.view_sorting) ? cu.view_sorting[0] : null;
  if (s && s.field) {
    const k = PJV_CU_SORT_MAP[String(s.field)] || ('cu:' + s.field);
    return { key: k, dir: (s.dir === -1 || s.dir === 'desc') ? -1 : 1, fromView: true };
  }
  return null;
}
function pjvSetColSort(selList, v) {
  try {
    if (v == null) localStorage.removeItem(pjvColSortStoreKey(selList && selList.id));
    else localStorage.setItem(pjvColSortStoreKey(selList && selList.id), JSON.stringify(v));
  } catch (_) { /* noop */ }
}
// 현재 렌더 스코프의 정렬 컨텍스트 — 컬럼 헤더(pjvStdColHead/pjvColumnHead)가 클릭 정렬에 사용.
//  renderArea 가 렌더마다 갱신(리스트 스코프 밖 화면에선 null → 헤더 정렬 비활성).
let pjvSortCtx: any = null;
// 현재 렌더 스코프의 그룹바이 컨텍스트 — 툴바 '그룹' 버튼이 사용(renderArea 가 갱신).
let pjvGroupCtx: any = null;

// '그룹' 버튼 라벨/강조 동기 — 그룹: <필드> (↑/↓). 리스트 미선택 스코프에선 비활성 표시.
function pjvSyncGroupBtn(btn, gb, enabled) {
  const lbl = btn.querySelector('.pjv-view-btn-label');
  const f = PJV_GROUPBY_FIELDS.find((x) => x.key === gb.field);
  // ClickUp 파리티 — 알약 버튼에 그룹 기준 필드명만(방향은 화살표로). '그룹:' 접두어는 아이콘이 대신한다.
  if (lbl) lbl.textContent = (f ? f.label : '상태') + (gb.dir === -1 ? ' ↓' : '');
  btn.classList.toggle('active', !!(enabled && (gb.field !== 'status' || gb.dir === -1)));
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
  pop.append(el('div', { class: 'pjv-closed-pop-head', text: '그룹 기준' }));
  const line = el('div', { class: 'pjv-groupby-line' });
  const mkSel = (label, cls, onOpen) => {
    const b = el('button', { class: 'pjv-filter-sel ' + cls, type: 'button' }, el('span', { class: 'pjv-filter-sel-label', text: label }), pjvTbIcon('caret', 'sm'));
    b.onclick = (e) => { e.stopPropagation(); onOpen(b); };
    return b;
  };
  const cur = () => (pjvGroupCtx && pjvGroupCtx.groupBy) || ctx.groupBy;
  const fLabel = () => { const f = PJV_GROUPBY_FIELDS.find((x) => x.key === cur().field); return f ? f.label : '상태'; };
  line.append(mkSel(fLabel(), 'pjv-groupby-field', (b) => {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(b, menu);
    for (const f of PJV_GROUPBY_FIELDS) {
      const it = el('button', { class: 'pjv-menu-item' + (cur().field === f.key ? ' sel' : ''), type: 'button' },
        el('span', { text: f.label }), cur().field === f.key ? el('span', { class: 'pjv-menu-check', text: '✓' }) : el('span', {}));
      it.onclick = (e) => { e.stopPropagation(); close(); pjvSetGroupBy(ctx.selList, { field: f.key, dir: cur().dir }, ctx.scopeKey); ctx.rerender(); };
      menu.append(it);
    }
  }));
  line.append(mkSel(cur().dir === -1 ? '내림차순' : '오름차순', 'pjv-groupby-dir', (b) => {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(b, menu);
    for (const o of [{ d: 1, l: '오름차순' }, { d: -1, l: '내림차순' }]) {
      const it = el('button', { class: 'pjv-menu-item' + (cur().dir === o.d ? ' sel' : ''), type: 'button' }, el('span', { text: o.l }));
      it.onclick = (e) => { e.stopPropagation(); close(); pjvSetGroupBy(ctx.selList, { field: cur().field, dir: o.d }, ctx.scopeKey); ctx.rerender(); };
      menu.append(it);
    }
  }));
  const reset = el('button', { class: 'pjv-filter-del', type: 'button', title: '뷰 기본값으로 되돌리기', 'aria-label': '그룹 기준 초기화' }, pjvTbIcon('trash', 'sm'));
  reset.onclick = (e) => { e.stopPropagation(); pjvSetGroupBy(ctx.selList, null, ctx.scopeKey); ctx.rerender(); };
  line.append(reset);
  pop.append(line);
  pop.append(el('div', { class: 'pjv-menu-hint', text: '기본값 = 이 리스트의 뷰 설정(ClickUp 이관 포함)' }));
}

// 리스트/폴더 표시 순서 비교자(#541 사이드바 파리티) — sort 오름차순(0 포함 — 구 0-based 재정렬 데이터의 0-top 보존,
//  서버 ORDER BY 와 동형), 동률(미재정렬 전부 0 등)은 ClickUp orderindex(settings.clickup — 미러 사이드바 순서), 이름.
function pjvContainerCmp(a, b) {
  const sa = Number(a.sort) || 0, sb = Number(b.sort) || 0;
  if (sa !== sb) return sa - sb;
  const oi = (x) => { const n = Number(x && x.settings && x.settings.clickup && x.settings.clickup.orderindex); return Number.isFinite(n) ? n : null; };
  const oa = oi(a), ob = oi(b);
  if (oa != null || ob != null) { if (oa == null) return 1; if (ob == null) return -1; if (oa !== ob) return oa - ob; }
  return String(a.name).localeCompare(String(b.name));
}

// 드래그 재정렬 직후 세션 오버라이드(#541) — 보드 메모리의 projects 배열은 refetch 전까지 옛 sort 를 들고 있어,
//  드롭 후 같은 세션 안 재렌더에서 원복돼 보인다. 저장 성공 시 여기 기록해 비교자가 우선 참조(다음 fetch 가 진실로 대체).
const pjvLocalSortOverride = new Map<number, number>();
// 수동/기본 순서 비교자 — 로컬 드래그(sort 1..n; 0=미지정→맨 위(새 항목)) → ClickUp 수동 순서(ext_orderindex) → 최신순.
function pjvManualCmp(a, b) {
  const sa = pjvLocalSortOverride.get(Number(a.id)) ?? (Number(a.sort) || 0);
  const sb = pjvLocalSortOverride.get(Number(b.id)) ?? (Number(b.sort) || 0);
  if (sa !== sb) { if (!sa) return -1; if (!sb) return 1; return sa - sb; }
  const na = a.ext_orderindex == null ? null : Number(a.ext_orderindex);
  const nb = b.ext_orderindex == null ? null : Number(b.ext_orderindex);
  if (na != null || nb != null) {
    if (na == null) return -1; if (nb == null) return 1;
    if (na !== nb) return na - nb;
  }
  return (Date.parse(b.updated_at || 0) || 0) - (Date.parse(a.updated_at || 0) || 0);
}
// 컬럼 정렬 비교자 — 빈 값은 방향 무관 항상 뒤(ClickUp 동형). 동률은 수동/기본 순서.
const PJV_PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
function pjvColSortCmp(sortSpec) {
  if (!sortSpec || !sortSpec.key) return pjvManualCmp;
  const { key, dir } = sortSpec;
  const val = (p) => {
    if (key === 'name') return String(p.name || '');
    if (key === 'team') { const m = (p.members || [])[0]; return m ? String(m.display_name || m.member_id || '') : null; }
    if (key === 'due') return p.due_date || null;
    if (key === 'start') return p.start_date || null;
    if (key === 'created') return p.created_at || null;
    if (key === 'updated') return p.updated_at || null;
    if (key === 'priority') { const r = PJV_PRIORITY_RANK[p.priority]; return r === undefined ? null : r; }
    // 그 외(cu:<externalId> — ClickUp 이관, 또는 네이티브 커스텀필드 id) — 행 field_values 값.
    const v = (p.field_values || {})[key];
    return v == null || v === '' ? null : v;
  };
  return (a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return pjvManualCmp(a, b);
    if (va == null) return 1;
    if (vb == null) return -1;
    let c;
    const na = Number(va), nb = Number(vb);
    if (Number.isFinite(na) && Number.isFinite(nb) && String(va).trim() !== '' && String(vb).trim() !== '') c = na - nb;
    else c = String(va).localeCompare(String(vb));
    return (dir === -1 ? -c : c) || pjvManualCmp(a, b);
  };
}
// 그룹 안 프로젝트 정렬 — 컬럼 정렬 지정 시 그것, 아니면 수동/기본 순서. (기존 rank/최신순을 대체 — ClickUp 파리티)
function pjvSortProjects(arr, colSort) { return arr.slice().sort(pjvColSortCmp(colSort)); }

// 컬럼 헤더 클릭 정렬(#541) — 라벨 클릭 시 오름→내림→해제 순환. pjvSortCtx(현재 리스트 스코프)가 있을 때만.
function pjvHeadSortable(labelEl, colKey) {
  if (!pjvSortCtx) return;
  const ctx = pjvSortCtx;
  const cur = ctx.colSort;
  if (cur && cur.key === colKey) labelEl.append(el('span', { class: 'pjv-sort-ind', text: cur.dir === -1 ? '↓' : '↑', 'aria-hidden': 'true' }));
  labelEl.classList.add('pjv-sortable'); // 커서/호버 어포던스는 실제 리스너가 붙은 헤더만(#541 리뷰 — 거짓 어포던스 방지)
  labelEl.title = '클릭해서 정렬 (오름 → 내림 → 해제)';
  labelEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const now = ctx.colSort;
    let next;
    if (!now || now.key !== colKey) next = { key: colKey, dir: 1 };
    else if (now.dir === 1) next = { key: colKey, dir: -1 };
    else next = { off: true }; // 해제 — 뷰 기본 정렬(view_sorting)까지 끄는 명시 off(다음 클릭이 덮어씀).
    pjvSetColSort(ctx.selList, next);
    ctx.rerender();
  });
}

function pjvRenderStatusGroups(main, shownProjects, selList, opts) {
  const { reload, canDelete, fields, anchorId, meId, taskCtx, mineOnly, listIdForAdd } = opts;
  const gb = opts.groupBy || { field: 'status', dir: 1 };
  const sortArr = (arr) => pjvSortProjects(arr, opts.colSort);
  // 첫(맨 위) 그룹 헤더에 컬럼 라벨을 합친다(별도 컬럼헤더 행 없음, #470). 실제로 그려지는 첫 그룹에만 withCols.
  let firstShown = true;
  const takeCols = () => { const w = firstShown; firstShown = false; return w; };
  // 상태 외 그룹바이(#541 파리티) — 담당자/우선순위/마감일/태그.
  if (gb.field && gb.field !== 'status') {
    pjvRenderFieldGroups(main, shownProjects, selList, opts, gb, sortArr, takeCols);
    return;
  }
  if (selList && pjvListIsCustomStatus(selList)) {
    const defs = pjvListStatusDefs(selList);
    // 프로젝트를 상태 def 로 분배 — status_raw/status 매칭, 미스매치는 카테고리 첫 def 로 흡수.
    const byKey = new Map<string, any[]>();
    for (const d of defs) byKey.set(d.key, []);
    const firstOfCat = (cat) => defs.find((d) => d.category === cat);
    for (const p of shownProjects) {
      let d = defs.find((x) => x.key === (p.status_raw || p.status));
      // 미스매치는 네이티브 status 로 흡수 — done 은 Done(없으면 Closed), 그 외는 Active 첫 상태.
      if (!d) d = (p.status === 'done' ? (firstOfCat('done') || firstOfCat('closed')) : firstOfCat('active')) || defs[0];
      const arr = d ? byKey.get(d.key) : null; if (arr) arr.push(p);
    }
    // 카테고리 순서로, 각 카테고리 안에서는 정의 순서. dir=-1(내림)이면 전체 역순(ClickUp group by status descending 동형).
    //  완료(done)/종결(closed) 상태는 Closed 토글일 때만.
    const ordered: any[] = [];
    for (const cat of PJV_STATUS_CATS) {
      for (const d of defs.filter((x) => x.category === cat.key)) {
        if ((cat.key === 'done' || cat.key === 'closed') && !pjvProjClosedView.done) continue;
        const arr = byKey.get(d.key) || [];
        if (mineOnly && !arr.length) continue;
        ordered.push({ d, arr });
      }
    }
    if (gb.dir === -1) ordered.reverse();
    for (const { d, arr } of ordered) {
      main.append(pjvProjGroup(d.label, pjvNativeStatusOf(d.category), sortArr(arr), reload, null, canDelete, takeCols(), fields, anchorId, meId, taskCtx, undefined, mineOnly, listIdForAdd, d));
    }
    return;
  }
  // 표준 3버킷(기존 동작 그대로 — 회귀 없음). dir=-1 이면 역순.
  const inprog = shownProjects.filter((p) => p.status !== 'done' && p.status !== 'todo');
  const todo = shownProjects.filter((p) => p.status === 'todo');
  const done = shownProjects.filter((p) => p.status === 'done');
  const subs: Array<[string, string, any[]]> = [];
  if (!mineOnly || inprog.length) subs.push(['진행 중', 'in_progress', inprog]);
  if (!mineOnly || todo.length) subs.push(['할 일', 'todo', todo]);
  if (pjvProjClosedView.done && (!mineOnly || done.length)) subs.push(['완료', 'done', done]);
  if (gb.dir === -1) subs.reverse();
  for (const [label, key, arr] of subs) main.append(pjvProjGroup(label, key, sortArr(arr), reload, null, canDelete, takeCols(), fields, anchorId, meId, taskCtx, undefined, mineOnly, listIdForAdd));
}

// 상태 외 필드 그룹 렌더(#541 그룹바이) — 담당자(다중이면 각 그룹에 중복 표시, ClickUp 동형)/우선순위/마감일/태그.
//  값 없는 그룹('없음')은 방향 무관 항상 마지막. 추가행은 그룹 값 프리필이 애매해 생략(noAdd).
function pjvRenderFieldGroups(main, shownProjects, selList, opts, gb, sortArr, takeCols) {
  const { reload, canDelete, fields, anchorId, meId, taskCtx, mineOnly } = opts;
  // done 필터는 그룹 분배 **전에**(#541 리뷰) — 그룹별 사후 필터는 '전부 done'일 때 빈 안내조차 없는 완전 공백을 만든다.
  shownProjects = shownProjects.filter((p) => p.status !== 'done' || pjvProjClosedView.done);
  const groups = new Map<string, { label: string; sortVal: any; arr: any[] }>();
  const put = (key, label, sortVal, p) => {
    if (!groups.has(key)) groups.set(key, { label, sortVal, arr: [] });
    groups.get(key)!.arr.push(p);
  };
  const NONE = '\u0000none';   // 그룹키 센티넬(실제 키와 절대 충돌 안 함). 리터럴 NUL 이 아니라 이스케이프 — 소스에 NUL 이 있으면 grep 이 파일을 바이너리로 보고 건너뛴다.
  for (const p of shownProjects) {
    if (gb.field === 'assignee') {
      const ms = (p.members || []);
      if (!ms.length) put(NONE, '담당자 없음', null, p);
      else for (const m of ms) put('m:' + m.member_id, String(m.display_name || m.member_id), String(m.display_name || m.member_id), p);
    } else if (gb.field === 'priority') {
      const r = PJV_PRIORITY_RANK[p.priority];
      if (r === undefined) put(NONE, '우선순위 없음', null, p);
      else put('p:' + p.priority, ({ urgent: '긴급', high: '높음', normal: '보통', low: '낮음' })[p.priority] || p.priority, r, p);
    } else if (gb.field === 'due') {
      if (!p.due_date) put(NONE, '마감일 없음', null, p);
      else put('d:' + p.due_date, pjvFmtDate(p.due_date), p.due_date, p);
    } else if (gb.field === 'tag') {
      const tags = (p.tags || []);
      if (!tags.length) put(NONE, '태그 없음', null, p);
      else for (const t of tags) put('t:' + String(t.name).toLowerCase(), String(t.name), String(t.name).toLowerCase(), p);
    }
  }
  const entries = [...groups.entries()];
  entries.sort((a, b) => {
    if (a[0] === NONE) return 1; if (b[0] === NONE) return -1;
    const va = a[1].sortVal, vb = b[1].sortVal;
    const c = (typeof va === 'number' && typeof vb === 'number') ? va - vb : String(va).localeCompare(String(vb));
    return gb.dir === -1 ? -c : c;
  });
  if (!entries.length) { main.append(el('div', { class: 'pjv-proj-empty', text: mineOnly ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.' })); return; }
  for (const [, g] of entries) {
    main.append(pjvProjGroup(g.label, null, sortArr(g.arr), reload, null, canDelete, takeCols(), fields, anchorId, meId, taskCtx, undefined, true, null));
  }
}

async function pjvSetProjStatus(id, status, reload) {
  try {
    await api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status }) });
    toast(status === 'done' ? '완료된 프로젝트로 옮겼습니다'
      : status === 'todo' ? '할 일로 옮겼습니다'
      : '진행 중으로 옮겼습니다');
    pjvReloadKeepScroll(reload);  // 상태 아이콘 변경 후 위로 튀지 않게 스크롤 보존(#358)
  } catch (e) { toast('실패 — ' + e.message, true); }
}

// 상태 동그라미(클릭→상태 메뉴) — 태스크 pjvStatusControl 과 같은 결. 소속 리스트가 커스텀 상태면 그 상태들을 제시(#475).
function pjvProjStatusDot(p, reload) {
  const defs = (p.list_id != null && pjvStatusReg.get(Number(p.list_id))) || null;
  if (defs && defs.length) {
    const cur = pjvResolveProjStatus(p) || defs[0];
    const btn = el('button', { class: 'pjv-status-btn', type: 'button',
      title: '상태: ' + cur.label, 'aria-label': '상태 ' + cur.label },
      pjvStatusIcon(cur.category, cur.color, cur.frac));
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(btn, menu);
      for (const cat of PJV_STATUS_CATS) {
        for (const d of defs.filter((x) => x.category === cat.key)) {
          const isCur = d.key === cur.key;
          const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' },
            pjvCustomStatusDot(d, 'sm'), el('span', { text: d.label }));
          item.onclick = () => { close(); if (!isCur) pjvSetProjStatusCustom(p.id, d, reload); };
          menu.append(item);
        }
      }
    };
    return btn;
  }
  const meta = pjvProjStatusMeta(p.status);
  const btn = pjvStatusIconBtn(pjvStatusIconStd(p.status), { title: '상태: ' + meta.label, 'aria-label': '상태 ' + meta.label });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const st of ['todo', 'in_progress', 'done']) {
      const m = pjvProjStatusMeta(st);
      const cur = pjvProjStatusMeta(p.status).key === st;
      const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' },
        pjvStatusIconStd(st, 'sm'),
        el('span', { text: m.label }));
      item.onclick = () => { close(); if (!cur) pjvSetProjStatus(p.id, st, reload); };
      menu.append(item);
    }
  };
  return btn;
}

// 팀원 페이스파일(최대 4 + N) — 없으면 '—'.
function pjvProjFacepile(members) {
  const arr = members || [];
  if (!arr.length) return el('span', { class: 'pjv-proj-noface', text: '—' });
  const faces = el('div', { class: 'project-tile-faces pjv-proj-faces' });
  for (const m of arr.slice(0, 4)) faces.append(personFace(m.member_id, 'project-face', m.display_name || m.member_id));
  if (arr.length > 4) faces.append(el('span', { class: 'project-face more', text: '+' + (arr.length - 4) }));
  return faces;
}

// (옛 pjvProjTeamView — 보기 전용 팀원 팝오버 — 폐기(#req): 상세 프로퍼티도 pjvProjTeamControl 로 바로 편집.)

function projSaveQuiet(id, patch) {
  return api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify(patch) }).catch((e) => toast('수정 실패 — ' + e.message, true));
}

// 전체 사람 구성원 디렉터리(팀원 검색 후보) — /api/ui/dash/members 1회 캐시. 팀원 팝오버가 공유한다(memberPicker 와 동일 소스).
let _pjvMemDir: any = null;
function pjvMemberDirectory() {
  if (!_pjvMemDir) _pjvMemDir = api('/api/ui/dash/members').then((d) => (d && d.members) || []).catch((e) => { _pjvMemDir = null; throw e; });
  return _pjvMemDir;
}
// 프로젝트 팀원 저장 — 전체 멤버 id 목록을 통째로 보낸다(setProjectMembers = 전체 교체). 조용히(토스트만).
function pjvSaveProjMembers(id, ids) {
  return api('/api/ui/v6/projects/' + id + '/members', { method: 'POST', body: JSON.stringify({ members: ids }) })
    .catch((e) => toast('팀원 저장 실패 — ' + e.message, true));
}
// 팀원 셀 — 멤버 페이스파일(클릭→전체 구성원 검색·다중토글 팝오버). 프로젝트의 '담당자'를 대체한다.
//  currentMembers=[{member_id,display_name}](보드 listProjects 가 채움). applyIds(ids)= 저장(프로젝트 행) 또는 드래프트 갱신(추가행).
//  태스크의 pjvAssigneeControl 과 같은 결(팝오버·아바타·체크) + 검색 인풋으로 전체 구성원에서 고른다.
function pjvProjTeamControl(currentMembers, applyIds) {
  let members = (currentMembers || []).map((m) => ({ id: m.member_id, name: m.display_name || m.member_id }));
  const btn = el('button', { class: 'pjv-cell-btn', type: 'button', title: '팀원' });
  function render() {
    btn.className = 'pjv-cell-btn' + (members.length ? '' : ' empty');
    if (members.length) {
      const faces = el('span', { class: 'pjv-asg-faces' });
      for (const m of members.slice(0, 3)) faces.append(personFace(m.id, 'pjv-ava', m.name));
      if (members.length > 3) faces.append(el('span', { class: 'pjv-ava pjv-ava-more', text: '+' + (members.length - 3) }));
      btn.replaceChildren(faces);
    } else {
      btn.replaceChildren(pjvIcon('assignee'));
    }
  }
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu pjv-asg-menu pjv-team-menu' });
    pjvPopover(btn, menu);
    const search = el('input', { type: 'text', class: 'pjv-team-search', placeholder: '이름으로 검색해 추가/해제…', spellcheck: 'false', autocomplete: 'off' });
    const listBox = el('div', { class: 'pjv-team-list' });
    menu.append(el('div', { class: 'pjv-team-searchwrap' }, search), listBox);
    let all: any = null;
    const setIds = (ids) => {
      members = ids.map((id) => { const m = all && all.find((x) => x.id === id); return { id, name: m ? (m.display_name || id) : id }; });
      render(); applyIds(ids); rebuild();
    };
    function rebuild() {
      if (!all) { listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' })); return; }
      const selIds = new Set(members.map((m) => m.id));
      const q = search.value.trim().toLowerCase();
      const cand = all.filter((m) => !q || (m.display_name || m.id).toLowerCase().includes(q));
      if (!cand.length) { listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: q ? '일치하는 사람이 없어요.' : '구성원이 없습니다.' })); return; }
      listBox.replaceChildren(...cand.map((m) => {
        const on = selIds.has(m.id);
        const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
          personFace(m.id, 'pjv-ava', m.display_name || m.id),
          el('span', { class: 'pjv-asg-mname', text: m.display_name || m.id }),
          el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
        item.onclick = (ev) => { ev.stopPropagation(); const cur = members.map((x) => x.id); setIds(on ? cur.filter((x) => x !== m.id) : [...cur, m.id]); };
        return item;
      }));
    }
    pjvMemberDirectory().then((dir) => { all = dir; rebuild(); }).catch(() => listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '구성원을 불러오지 못했어요.' })));
    search.addEventListener('input', rebuild);
    setTimeout(() => search.focus(), 0);
  };
  render();
  return btn;
}
async function projPatch(id, patch, reload) {
  try { await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify(patch) }); pjvReloadKeepScroll(reload); }
  catch (e) { toast('수정 실패 — ' + e.message, true); }
}
// 행 끝 ⋯ 메뉴 — 이름 변경 · 상태 토글 · 삭제(작성자만, 서버 403 재검증).
function pjvProjMore(p, reload, canDelete) {
  const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '더보기', 'aria-label': '프로젝트 작업', text: '⋯' });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    const mk = (label, fn, danger) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
    menu.append(mk('이름 변경', () => pjvProjRename(btn, p, reload), false));
    menu.append(mk(p.status === 'done' ? '진행 중으로' : '완료된 프로젝트로', () => pjvSetProjStatus(p.id, p.status === 'done' ? 'in_progress' : 'done', reload), false));
    menu.append(mk('리스트 이동', () => pjvMoveProjectList(btn, p, reload), false));
    if (canDelete(p)) menu.append(mk('삭제', () => pjvProjDelete(p, reload), true));
  };
  return btn;
}
function pjvProjRename(anchor, p, reload) {
  const input = el('input', { type: 'text', class: 'pjv-rename-input', value: p.name, maxlength: '200' });
  const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
  input.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); const v = input.value.trim(); close();
    if (v && v !== p.name) {
      try { await api('/api/ui/v6/projects/' + p.id, { method: 'POST', body: JSON.stringify({ name: v }) }); reload(); }
      catch (err) { toast('수정 실패 — ' + err.message, true); }
    }
  };
  setTimeout(() => { input.focus(); input.select(); }, 0);
}
function pjvProjDelete(p, reload) {
  if (!confirm('프로젝트 ‘' + p.name + '’을(를) 삭제할까요?\n\n프로젝트와 그 안의 작업(태스크·하위)이 함께 사라집니다(되돌릴 수 없음).')) return;
  (async () => {
    try { await api('/api/ui/v6/projects/' + p.id + '/delete', { method: 'POST' }); toast('프로젝트를 삭제했습니다'); reload(); }
    catch (e) { toast('삭제 실패 — ' + e.message, true); }
  })();
}
// 프로젝트 한 줄(태스크 행과 동형) — [캐럿자리][상태점/체크] 이름 | 담당자 | 마감일 | 우선순위 | 커스텀… | ⋯.
// '내 세션' 셀(프로젝트 목록 전용) — 터미널 아이콘 클릭 → 이 프로젝트의 '내 세션' 목록 팝업 → 고르면 새 탭으로 입장.
function pjvProjSessionCell(p, reload) {
  // 내 세션이 있으면 활성(컬러 터미널 아이콘 + 작은 라이브 점), 없으면 옅게(비활성). my_session_count 는 보드 API 가 부여.
  const nSess = Number(p.my_session_count || 0);
  const active = nSess > 0;
  const btn = el('button', { class: 'pjv-cell-btn' + (active ? ' pjv-sess-active' : ' empty'), type: 'button',
    title: active ? ('내 세션 ' + nSess + '개 — 클릭해 입장/추가') : '내 세션 없음 — 클릭해 만들기' },
    el('span', { class: 'pjv-sess-ico-wrap' }, pjvIcon('session'), active ? el('span', { class: 'pjv-sess-dot', 'aria-hidden': 'true' }) : null));
  // 그 자리에서 바로 '새 터미널 세션' 폼을 띄운다 — 프로젝트 안으로 들어가지 않음. 이름은 프로젝트명으로 프리필.
  const openCreate = () => openProjectSessionForm(p.id, reload, '/api/ui/v6/projects/', p.name, p.repos);
  btn.onclick = (e) => {
    e.stopPropagation();
    // 활성·비활성 공통으로 같은 드롭다운을 띄운다 — 비활성도 곧장 폼이 뜨지 않고 '＋ 새 세션 만들기'를 거치게(이미지 참고).
    const menu = el('div', { class: 'pjv-menu pjv-sess-menu' });
    const close = pjvPopover(btn, menu);
    // '＋ 새 세션 만들기' — 프로젝트로 안 들어가고 그 자리에서 새 세션 생성 폼. (활성·비활성 공통 항목)
    const addItem = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' },
      el('span', { class: 'pjv-sess-ico pjv-sess-add-ico', text: '＋' }),
      el('span', { text: '새 세션 만들기' }));
    addItem.onclick = (ev) => { ev.stopPropagation(); close(); openCreate(); };
    if (!active) {
      // 내 세션 없음 → 빈 목록 fetch 없이 곧장 안내 + 새 세션 만들기(활성 드롭다운과 같은 모양·위치).
      menu.append(el('div', { class: 'pjv-menu-empty', text: '내 세션이 없습니다' }), addItem);
      return;
    }
    // 내 세션 있음 → 내 세션들(입장) + '＋ 새 세션 만들기'.
    menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    api('/api/ui/v6/projects/' + p.id + '/sessions')
      .then((d) => {
        const mine = ((d && d.sessions) || []).filter((s) => s.owned); // owned = 서버가 판정한 '내 세션'
        menu.replaceChildren();
        for (const s of mine) {
          const item = el('button', { class: 'pjv-menu-item', type: 'button', title: s.id },
            el('span', { class: 'pjv-sess-ico' }, pjvIcon('session')),
            el('span', { class: 'pjv-sess-name', text: s.label || s.id }));
          item.onclick = (ev) => {
            ev.stopPropagation(); close();
            // 노드 세션(#905 C4)은 &node= 로 열어야 attach 가 그 노드로 릴레이된다.
            window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || '') + (s.node ? '&node=' + encodeURIComponent(s.node.id) : ''), '_blank');
          };
          menu.append(item);
        }
        menu.append(addItem);
      })
      .catch((err) => { menu.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '불러오기 실패 — ' + err.message })); });
  };
  return btn;
}

// ════════════════════════════════════════════════════════════════════════════
// 클릭업식 다중선택 — 행 호버 시 좌측 체크박스 + 제목 우측 아이콘 3개(추가·태그·이름변경),
//  체크박스로 1개 이상 선택하면 화면 하단 일괄작업 바(상태·담당자·마감·우선순위·태그·복제·삭제).
//  선택은 종류(project|task)별로 분리(혼합 금지). 한 화면 안에서만 유효 — 재렌더/이동 시 비운다.
// ════════════════════════════════════════════════════════════════════════════
const pjvSel: any = { kind: null, ids: new Set(), items: new Map(), ctx: null };
let pjvSelLastEl: any = null;   // 마지막으로 클릭한 체크박스 — Shift+클릭 범위선택의 앵커(#366)
let pjvSelSilent = false;       // 드래그/범위 페인트 중엔 하단 바 재렌더를 억제하고 끝에서 1회만(#366)

function pjvSelDomClear() {
  document.querySelectorAll('.pjv-row-check.on').forEach((c) => c.classList.remove('on'));
  document.querySelectorAll('.pjv-trow-wrap.pjv-row-selected').forEach((w) => w.classList.remove('pjv-row-selected'));
}
function pjvSelReset() {
  pjvSelDomClear();
  pjvSel.kind = null; pjvSel.ids.clear(); pjvSel.items.clear(); pjvSel.ctx = null;
  pjvSelLastEl = null;
  pjvSelRenderBar();
}
function pjvSelToggle(kind, item, ctx) {
  if (pjvSel.kind && pjvSel.kind !== kind) { pjvSelDomClear(); pjvSel.ids.clear(); pjvSel.items.clear(); } // 종류 전환 — 기존 비움
  pjvSel.kind = kind; pjvSel.ctx = ctx;
  if (pjvSel.ids.has(item.id)) { pjvSel.ids.delete(item.id); pjvSel.items.delete(item.id); }
  else { pjvSel.ids.add(item.id); pjvSel.items.set(item.id, item); }
  if (!pjvSel.ids.size) pjvSel.kind = null;
  if (!pjvSelSilent) pjvSelRenderBar();
}
function pjvSelReloadAfter() { const r = pjvSel.ctx && pjvSel.ctx.reload; pjvSelReset(); if (r) r(); }
const pjvSelIds = () => [...pjvSel.ids];
const pjvSelPatchUrl = (id) => (pjvSel.kind === 'task' ? '/api/ui/v6/tasks/' + id : '/api/ui/v6/projects/' + id);
async function pjvBulkApply(perId, okMsg) {
  const ids = pjvSelIds();
  const res = await Promise.allSettled(ids.map(perId));
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  const fail = res.length - ok;
  toast(fail ? (ok + '개 적용 · ' + fail + '개 실패') : (okMsg || (ok + '개 적용됨')), fail > 0);
  pjvSelReloadAfter();
}

// 하단 일괄작업 바 — 선택 1개 이상일 때만. document.body 에 고정.
let pjvBulkBarEl: any = null;
function pjvSelRenderBar() {
  if (!pjvBulkBarEl) {
    pjvBulkBarEl = el('div', { class: 'pjv-bulkbar' });
    document.body.append(pjvBulkBarEl);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pjvSel.ids.size) pjvSelReset(); });
  }
  const n = pjvSel.ids.size;
  if (!n) { pjvBulkBarEl.classList.remove('show'); pjvBulkBarEl.replaceChildren(); return; }
  pjvBulkBarEl.classList.add('show');
  const isTask = pjvSel.kind === 'task';
  const mk = (label, icon, fn, danger?) => {
    const b = el('button', { class: 'pjv-bulk-btn' + (danger ? ' danger' : ''), type: 'button' }, pjvBulkIcon(icon), el('span', { text: label }));
    b.onclick = (e) => { e.stopPropagation(); fn(b); };
    return b;
  };
  // native replaceChildren 는 null 을 'null' 텍스트로 넣으므로 falsy 를 걸러서 넘긴다(태스크 전용 버튼들).
  pjvBulkBarEl.replaceChildren(...[
    el('div', { class: 'pjv-bulk-count' },
      el('span', { class: 'pjv-bulk-n', text: String(n) }),
      el('span', { class: 'pjv-bulk-lbl', text: (isTask ? '태스크' : '프로젝트') + ' 선택됨' }),
      el('button', { class: 'pjv-bulk-x', type: 'button', title: '선택 해제 (Esc)', text: '✕', onclick: () => pjvSelReset() })),
    el('div', { class: 'pjv-bulk-actions' },
      mk('상태', 'status', pjvBulkStatus),
      mk('담당자', 'assignee', pjvBulkAssignee),
      mk('마감일', 'due', pjvBulkDue),
      mk('우선순위', 'priority', pjvBulkPriority),
      isTask ? mk('태그', 'tag', pjvBulkTags) : null,
      !isTask ? mk('리스트', 'list', pjvBulkList) : null,
      mk('복제', 'dup', () => pjvBulkDuplicate()),
      mk('삭제', 'trash', () => pjvBulkDelete(), true)),
    isTask ? el('button', { class: 'pjv-bulk-run', type: 'button', title: '선택한 태스크로 내 새 클로드 세션을 만들고 바로 실행을 맡깁니다',
      onclick: (e) => { e.stopPropagation(); pjvBulkRunClaude(e.currentTarget); } },
      pjvBulkIcon('run'), el('span', { text: '클로드로 실행' })) : null,
    // '클로드로 실행' 오른쪽의 보조 버튼 — 원클릭 실행이 쓰는 기본값(레포·워크트리·실행기·모델·실행 위치)을 보고 수정. 실행 버튼보다 덜 강조.
    isTask ? el('button', { class: 'pjv-bulk-cfg', type: 'button', title: '클로드로 실행 기본값 — 레포·워크트리·실행기·모델·실행 위치를 설정',
      onclick: (e) => { e.stopPropagation(); pjvBulkRunDefaultsModal(pjvSel.ctx); } },
      pjvBulkIcon('settings'), el('span', { text: '기본값' })) : null,
  ].filter(Boolean));
}
function pjvBulkIcon(kind) {
  if (kind === 'assignee') return pjvIcon('assignee');
  if (kind === 'due') return pjvIcon('due');
  if (kind === 'priority') return pjvIcon('priority');
  const svg = (...k) => sv('svg', { class: 'pjv-bulk-ic', viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...k);
  if (kind === 'status') return svg(sv('circle', { cx: '12', cy: '12', r: '8.2' }), sv('path', { d: 'M8.5 12.2l2.4 2.4 4.6-5' }));
  if (kind === 'tag') return svg(sv('path', { d: 'M4 4h7l9 9-7 7-9-9z' }), sv('circle', { cx: '8.2', cy: '8.2', r: '1.3' }));
  if (kind === 'dup') return svg(sv('rect', { x: '8', y: '8', width: '12', height: '12', rx: '2' }), sv('path', { d: 'M4 16V5a1 1 0 0 1 1-1h11' }));
  if (kind === 'trash') return svg(sv('path', { d: 'M5 7h14M10 7V5.5h4V7M6.5 7l1 12.5h9l1-12.5' }));
  if (kind === 'list') return svg(sv('path', { d: 'M8 6h12M8 12h12M8 18h12' }), sv('circle', { cx: '4', cy: '6', r: '1.2' }), sv('circle', { cx: '4', cy: '12', r: '1.2' }), sv('circle', { cx: '4', cy: '18', r: '1.2' }));
  if (kind === 'run') return svg(sv('path', { d: 'M8 5.4v13.2l11-6.6z', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }));
  if (kind === 'settings') return svg(sv('path', { d: 'M4 8h9M17 8h3M4 16h3M11 16h9' }), sv('circle', { cx: '15', cy: '8', r: '2.2' }), sv('circle', { cx: '9', cy: '16', r: '2.2' }));
  return svg();
}

// 선택한 태스크 → 내 새 클로드 세션을 만들고(내 이름·태스크 기반 라벨) 새 탭으로 열어, 그 태스크들을 클로드에게 실행 요청까지 원클릭.
//  세션은 autoApprove(=claude --dangerously-skip-permissions)로 만들어 멈춤 없이 실행. 프롬프트 주입은 terminal.js 가 부팅 후 1회(localStorage 핸드오프).
async function pjvBulkRunClaude(btn?) {
  if (pjvSel.kind !== 'task' || !pjvSel.ids.size) return;
  const ctx = pjvSel.ctx || {};
  const pid = ctx.projectId;
  if (!pid) { toast('프로젝트를 찾을 수 없어요', true); return; }
  const ids = [...pjvSel.ids];
  const B = '/api/ui/v6/projects/' + pid;
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  const meName = (((ctx.members || []).find((m) => m.member_id === meId) || {}).display_name) || meId || '나';
  const labelSpan = btn ? btn.querySelector('span') : null;
  const origLabel = labelSpan ? labelSpan.textContent : '';
  if (btn) btn.disabled = true;
  if (labelSpan) labelSpan.textContent = '내용 준비 중…';

  // 팝업 전체 내용을 모은다: 상세(본문·체크리스트·댓글/주석) + 첨부 파일 경로(이미지는 클로드가 직접 열어 확인) + 하위태스크(재귀로 동일하게).
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i;
  const detailOf = (tid) => api('/api/ui/v6/tasks/' + tid + '/detail').catch(() => null);
  const attsOf = (tid) => api(B + '/files?path=' + encodeURIComponent('_attachments/task-' + tid))
    .then((r) => ((r && r.items) || []).filter((it) => it.type === 'file').map((it) => it.name)).catch(() => []);
  const blockOf = async (t, depth) => {
    const ind = '  '.repeat(depth);
    const out = [ind + (depth ? '◦ ' : '■ ') + (t.name || ('태스크 ' + t.id))
      + (t.status ? ' [' + t.status + ']' : '') + (t.priority ? ' (우선순위:' + t.priority + ')' : '') + (t.due_date ? ' (마감:' + t.due_date + ')' : '')];
    const desc = (t.description || '').trim();
    out.push(ind + '  본문: ' + (desc ? desc.replace(/\n/g, '\n' + ind + '  ') : '(없음)'));
    const atts = await attsOf(t.id);
    if (atts.length) {
      const hasImg = atts.some((n) => IMG_RE.test(n));
      out.push(ind + '  첨부: ' + atts.map((n) => '_attachments/task-' + t.id + '/' + n).join(', ') + (hasImg ? '  ← 이미지는 직접 열어 확인할 것' : ''));
    }
    return out.join('\n');
  };
  const extrasOf = (d, ind) => {
    const out: string[] = [];
    for (const cl of ((d && d.checklists) || [])) {
      const its = (cl.items || []);
      if (its.length) out.push(ind + '체크리스트' + (cl.name ? '(' + cl.name + ')' : '') + ': ' + its.map((i) => (i.done ? '[x]' : '[ ]') + (i.text || i.name || '')).join(' / '));
    }
    const cm = ((d && d.feed) || []).filter((f) => f.kind === 'comment' && f.body).map((f) => String(f.body).trim().replace(/\n/g, ' '));
    if (cm.length) out.push(ind + '댓글/주석: ' + cm.map((c) => '“' + c + '”').join('  '));
    return out;
  };

  let prompt = '', projName = '';
  try {
    const blocks: string[] = [];
    for (const id of ids) {
      const d = await detailOf(id);
      if (d && d.project && !projName) projName = d.project.name || '';
      const t = (d && d.task) || pjvSel.items.get(id) || { id, name: '태스크 ' + id };
      const parts = [await blockOf(t, 0), ...extrasOf(d, '  ')];
      const subs = (t.subtasks || []);
      if (subs.length) {
        parts.push('  하위태스크 (' + subs.length + '):');
        for (const s0 of subs) {
          const sd = await detailOf(s0.id);
          const s = (sd && sd.task) || s0;
          parts.push(await blockOf(s, 1), ...extrasOf(sd, '    '));
        }
      }
      blocks.push(parts.join('\n'));
    }
    prompt = (projName ? ('프로젝트: ' + projName + '. ') : '')
      + '아래 태스크들을 진행해줘. 각 태스크의 본문·체크리스트·댓글(주석)·첨부·하위태스크를 모두 반영하고, 첨부 이미지는 경로를 직접 열어 확인해. 각 태스크를 끝내면 무엇을 했는지 보고하고, 막히면 질문해줘.\n\n' + blocks.join('\n\n');
  } catch (e) {
    if (btn) btn.disabled = false; if (labelSpan) labelSpan.textContent = origLabel || '클로드로 실행';
    toast('태스크 내용을 불러오지 못했어요 — ' + e.message, true); return;
  }

  // 이 프로젝트의 '클로드로 실행' 기본값(실행 위치·실행기·모델·자동승인·워크트리·레포). 설정 팝업(pjvBulkRunDefaultsModal)에서 바꾼다.
  const proj0 = await api(B).then((dd) => dd && (dd.project || dd)).catch(() => null);
  const projRepos = ((proj0 && proj0.repos) || []).filter(Boolean);
  const rd = pjvRunDefaults(pid, projRepos);
  // 실행 위치 = 내 PC(로컬): 박스 세션을 만들지 않고, 태스크 내용을 클립보드에 복사한 뒤 '내 PC에서 작업' 안내 모달을 기본값으로 선주입해 연다.
  //  로컬은 work.mjs 한 줄이 코드 준비(clone/worktree)까지 겸하는 셋업이라 레포·워크트리 기본값을 그대로 넘긴다 — 아래 박스 세션과 다르다(#918).
  if (rd.where === 'local') {
    const chosenRepos = (rd.repos === null) ? projRepos : projRepos.filter((n) => rd.repos.includes(n));
    try { copyText(prompt); } catch (_) { /* */ }
    if (btn) btn.disabled = false; if (labelSpan) labelSpan.textContent = origLabel || '클로드로 실행';
    openLocalWorkModal(pid, { id: pid, name: projName || (proj0 && proj0.name) || '', repos: chosenRepos },
      { harness: rd.harness, model: rd.model, autoApprove: rd.autoApprove, worktree: rd.worktree, branch: rd.branch, repos: chosenRepos });
    toast('태스크 내용을 클립보드에 복사했어요 — 안내대로 내 PC에서 세션을 열고 붙여넣어 실행하세요');
    pjvSelReset();
    return;
  }

  const first = pjvSel.items.get(ids[0]);
  const firstName = (first && (first.name || first.title)) || ('태스크 ' + ids[0]);
  const label = meName + ' · ' + firstName + (ids.length > 1 ? (' 외 ' + (ids.length - 1) + '건') : '');
  // 세션은 프로젝트 폴더에서 연다 — 코드를 미리 provision 하지 않는다(#918).
  //  이전엔 세션 전에 레포를 워크트리로 provision 하고 '단일 레포일 때만' cwd 를 거기로 뒀다. 그건 보장이 아니었다:
  //  멀티레포·provision 실패·다른 진입 경로면 어차피 맨 프로젝트 폴더에서 떴고(실측: 코드 프로젝트의 40%), 실패는
  //  .catch 로 삼켜 무음이었고, 회수된 워크트리 경로가 마커에 남아 오히려 에이전트를 속였다.
  //  지금은 세션이 코드가 필요해진 시점에 스스로 뜬다 — 발견은 AGENTS.md '코드 작업' 섹션(프로젝트 폴더에 항상)과
  //  lively_local_repo_worktree 의 _meta.alwaysLoad(스키마 상시 노출)가 보장한다. 미리 받아두고 싶으면 세션 생성
  //  모달의 '레포 준비'(POST /provision)를 쓴다 — 거긴 실패가 4xx/5xx 로 표면화된다.
  if (labelSpan) labelSpan.textContent = '세션 여는 중…';
  try {
    const sbody: any = { label, harness: rd.harness || 'claude', autoApprove: rd.autoApprove === true };   // #782 기본 꺼짐 — 켠 사람만 켜짐
    if (rd.model) sbody.flags = { '--model': rd.model };
    const r = await api(B + '/sessions', { method: 'POST', body: JSON.stringify(sbody) });
    const sid = r && r.session && r.session.id;
    if (!sid) throw new Error('세션 생성 실패');
    try { localStorage.setItem('lively:autosend:' + sid, prompt); } catch (_) { /* */ }
    window.open('/ui/terminal.html?session=' + encodeURIComponent(sid) + '&label=' + encodeURIComponent((r.session && r.session.label) || label) + '&autosend=1', '_blank');
    toast(ids.length + '개 태스크(본문·하위·첨부 포함)를 클로드에게 맡겼어요 — 새 탭에서 실행됩니다');
    pjvSelReset();
  } catch (e) {
    if (btn) btn.disabled = false; if (labelSpan) labelSpan.textContent = origLabel || '클로드로 실행';
    toast('실패 — ' + e.message, true);
  }
}
// ── '클로드로 실행' 기본값(실행 위치·실행기·모델·자동승인·워크트리·레포) — 프로젝트별 localStorage. 플로팅바 원클릭(pjvBulkRunClaude)이 읽는다. ──
//  #782 키를 사용자별로도 나눈다(v2) — 한 브라우저를 여러 계정이 써도 남의 자동 승인이 내 기본값이 되지 않게.
//  자동 승인의 기본은 '꺼짐'(termAutoApprovePref = 내가 세션 폼에서 마지막에 고른 값)이고, 옛 키(v1)의 autoApprove 는
//  기본값이 켜져 있던 시절(#480)에 저장된 잔재라 이어받지 않는다 — 나머지(실행 위치·실행기·모델·워크트리·레포)만 이어받는다.
const pjvRunDefaultsKey = (pid) => 'lively:runclaude:defaults:v2:' + ((state.me && (state.me.userId || state.me.email)) || 'anon') + ':' + pid;
const pjvRunDefaultsLegacyKey = (pid) => 'lively:runclaude:defaults:' + pid;
function pjvRunDefaults(pid, projectRepos) {
  const base: any = { where: 'web', harness: 'claude', model: '', autoApprove: termAutoApprovePref(), worktree: true, branch: 'project/' + pid, repos: null };
  let saved: any = {};
  try {
    const raw = localStorage.getItem(pjvRunDefaultsKey(pid));
    if (raw != null) saved = JSON.parse(raw) || {};
    else { saved = JSON.parse(localStorage.getItem(pjvRunDefaultsLegacyKey(pid)) || '{}') || {}; delete saved.autoApprove; }
  } catch (_) { saved = {}; }
  const d = { ...base, ...saved };
  d.branch = 'project/' + pid;   // 워크트리 브랜치는 프로젝트 id 로 자동 고정 — 팝업에서 편집하지 않는다(#514 후속 피드백: 자동 파생값을 '기본값'으로 노출하면 오해)
  // repos: null=관련 레포 전부(미래에 추가되는 레포도 자동 포함). 배열이면 현재 프로젝트 레포와 교집합(빠진 레포 정리).
  if (Array.isArray(d.repos)) d.repos = d.repos.filter((n) => (projectRepos || []).includes(n));
  return d;
}
function pjvSaveRunDefaults(pid, d) {
  try { localStorage.setItem(pjvRunDefaultsKey(pid), JSON.stringify(d)); } catch (_) { /* localStorage 불가 시 무시 */ }
}

// 기본값 설정 팝업 — '지금 어떻게 설정돼 있는지'를 보여주고 수정. 저장은 프로젝트별 localStorage(다음 '클로드로 실행'부터 적용).
async function pjvBulkRunDefaultsModal(ctx) {
  ctx = ctx || pjvSel.ctx || {};
  const pid = ctx.projectId;
  if (!pid) { toast('프로젝트를 찾을 수 없어요', true); return; }
  // 프로젝트 관련 레포 + 하네스 카탈로그(모델 목록·자동승인 여부). 실패해도 아래 기본 카탈로그로 진행.
  let projectRepos: string[] = [];
  try { const pr = await api('/api/ui/v6/projects/' + pid).then((dd) => dd && (dd.project || dd)); projectRepos = ((pr && pr.repos) || []).filter(Boolean); } catch (_) { /* 레포 조회 실패 — 레포 선택 없이 */ }
  const harnessCat: any = {
    claude: { label: 'Claude Code', models: ['', 'opus', 'sonnet', 'haiku'], hasAuto: true },
    codex: { label: 'Codex', models: ['', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'], hasAuto: true },
  };
  try {
    const cfg = await api('/api/ui/terminal/config');
    ((cfg && cfg.harnesses) || []).forEach((h) => {
      const mf = (h.flags || []).find((f) => f.name === '--model');
      harnessCat[h.key] = { label: h.label || h.key, models: (mf && mf.choices) || [''], hasAuto: !!h.hasAutoApprove };
    });
  } catch (_) { /* 카탈로그 실패 → 위 기본 카탈로그 유지 */ }

  const d = pjvRunDefaults(pid, projectRepos);

  // 실행 위치(웹 중앙 컴퓨터 / 내 PC 로컬)
  const whereWeb = el('input', { type: 'radio', name: 'rcd-where', value: 'web' });
  const whereLocal = el('input', { type: 'radio', name: 'rcd-where', value: 'local' });
  (d.where === 'local' ? whereLocal : whereWeb).checked = true;
  const whereRow = el('div', { class: 'field', style: 'margin-top:2px' },
    el('label', { class: 'field-label', text: '실행 위치' }),
    el('label', { class: 'proj-sess-auto', style: 'margin-top:2px' }, whereWeb, el('span', { text: ' 웹(중앙 컴퓨터) — 누르면 곧장 세션을 만들어 실행 (설치 불필요·권장)' })),
    el('label', { class: 'proj-sess-auto', style: 'margin-top:2px' }, whereLocal, el('span', { text: ' 내 PC(로컬) — 누르면 태스크 내용을 복사하고 내 PC 실행 안내를 띄움' })));

  // 실행기 + 모델 + 자동승인
  const HKEYS = ['claude', 'codex'].filter((k) => harnessCat[k]);
  const harnessSel = el('select', {}, ...HKEYS.map((k) => el('option', { value: k, text: harnessCat[k].label || k })));
  const modelSel = el('select', {});
  const autoCb = el('input', { type: 'checkbox' });
  const autoRow = el('label', { class: 'proj-sess-auto', style: 'margin-top:10px' }, autoCb, el('span', { text: ' 자동 승인 — 권한 확인 없이 바로 실행 (신뢰하는 작업에만)' }));
  const renderModels = () => {
    const cat = harnessCat[harnessSel.value] || { models: [''] };
    const cur = modelSel.value;
    modelSel.replaceChildren(...(cat.models || ['']).map((m) => el('option', { value: m, text: m || '기본 모델' })));
    if ((cat.models || []).includes(cur)) modelSel.value = cur;
    autoRow.style.display = (cat.hasAuto === false) ? 'none' : '';
  };
  if (HKEYS.includes(d.harness)) harnessSel.value = d.harness;
  harnessSel.addEventListener('change', renderModels);
  renderModels();
  if (((harnessCat[harnessSel.value] || { models: [] }).models || []).includes(d.model)) modelSel.value = d.model;
  autoCb.checked = d.autoApprove === true;   // #782 기본 해제(저장된 값이 있을 때만 켬)

  // 워크트리 — 이 프로젝트 전용 작업 공간을 자동 준비(있으면 재사용). 브랜치명(project/<id>)은 프로젝트에서 자동 파생되므로 사용자에게 안 물어본다(#514 후속 피드백).
  const wtChk = el('input', { type: 'checkbox' }); wtChk.checked = d.worktree !== false;
  const wtRow = el('label', { class: 'proj-sess-auto', style: 'margin-top:2px' }, wtChk,
    el('span', { text: ' 이 프로젝트 전용 작업 공간에서 격리 실행 — 매번 자동으로 준비되고(있으면 재사용) 다른 작업과 안 섞여요 (권장)' }));
  const wtHint = el('div', { class: 'caption', style: 'margin-top:2px' },
    '작업 공간은 프로젝트에 맞춰 자동으로 준비돼요 — 이름을 따로 정할 필요 없어요. (개발자용: git worktree · 브랜치 project/' + pid + ')');

  // 레포 선택 — 실행 전에 자동으로 가져올(provision) 레포. 기본은 관련 레포 전부.
  const repoChecks = projectRepos.map((n) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = (d.repos === null) ? true : d.repos.includes(n);
    return { n, cb, row: el('label', { class: 'proj-sess-auto', style: 'margin-top:2px' }, cb, el('span', { text: ' ' + n })) };
  });
  const repoBox = projectRepos.length
    ? el('div', {}, ...repoChecks.map((r) => r.row))
    : el('div', { class: 'caption', text: '이 프로젝트에 연결된 레포가 없어요 — 레포 없이 실행됩니다.' });

  // 코드 저장소 준비는 '내 PC' 실행 전용이다(#918) — work.mjs 한 줄(--worktree/--branch/레포)에만 실린다.
  //  웹(박스) 세션은 코드를 미리 받지 않고, 세션이 코드가 필요해진 시점에 lively_local_repo_worktree 로 스스로 뜬다.
  //  그래서 웹을 고른 상태에선 숨긴다 — 남겨두면 '준비해준다'는 거짓 약속이 된다(웹에선 아무 효과도 없다).
  const repoField = el('div', { class: 'field', style: 'margin-top:14px' },
    el('label', { class: 'field-label', text: '코드 저장소 준비 (내 PC 실행 시)' }),
    el('div', { class: 'caption', text: '내 PC에서 실행할 때 아래 레포를 준비합니다(있으면 재사용). 코드 작업이 아니면 모두 꺼도 돼요.' }),
    wtRow, wtHint,
    el('div', { style: 'margin-top:8px' }, repoBox));
  const syncRepoField = () => { repoField.style.display = whereLocal.checked ? '' : 'none'; };
  whereWeb.onchange = syncRepoField; whereLocal.onchange = syncRepoField; syncRepoField();

  const saveBtn = el('button', { class: 'btn btn-primary', text: '기본값 저장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('클로드로 실행 — 기본값',
    el('p', { class: 'admin-hint', text: '‘클로드로 실행’(플로팅 바)을 누를 때 쓰는 기본값이에요. 여기서 바꾸면 다음 실행부터 이 값으로 준비됩니다. (이 프로젝트에만 적용)' }),
    whereRow,
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '실행기' }), harnessSel),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '모델' }), modelSel),
    autoRow,
    repoField,
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  saveBtn.onclick = () => {
    const chosen = repoChecks.filter((r) => r.cb.checked).map((r) => r.n);
    const allChosen = projectRepos.length > 0 && chosen.length === projectRepos.length;
    pjvSaveRunDefaults(pid, {
      where: whereLocal.checked ? 'local' : 'web',
      harness: harnessSel.value,
      model: modelSel.value || '',
      autoApprove: autoCb.checked,
      worktree: wtChk.checked,
      repos: (projectRepos.length && !allChosen) ? chosen : null,   // null=전부(미래 레포 자동 포함). 브랜치는 저장 안 함 — pjvRunDefaults 가 project/<id> 로 자동 고정.
    });
    back.remove();
    toast('클로드로 실행 기본값을 저장했어요');
  };
}
// ── 일괄 액션들 ──
function pjvBulkStatus(anchor) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  for (const [key, label] of [['todo', '할 일'], ['in_progress', '진행 중'], ['done', '완료']]) {
    const item = el('button', { class: 'pjv-menu-item', type: 'button' },
      pjvStatusIconStd(key, 'sm'),
      el('span', { text: label }));
    item.onclick = () => {
      close();
      if (pjvSel.kind === 'task') pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id, { method: 'POST', body: JSON.stringify({ status: key }) }), '상태 변경됨');
      else pjvBulkApply((id) => api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: key }) }), '상태 변경됨');
    };
    menu.append(item);
  }
}
function pjvBulkDue(anchor) {
  const input = el('input', { type: 'date', class: 'pjv-date-input' });
  const clearBtn = el('button', { class: 'pjv-menu-item danger', type: 'button', text: '마감일 지우기' });
  const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input, clearBtn);
  const close = pjvPopover(anchor, wrap);
  setTimeout(() => { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) { /* noop */ } } }, 0);
  input.onchange = () => { const v = input.value || null; close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ due_date: v }) }), '마감일 적용됨'); };
  clearBtn.onclick = () => { close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ due_date: null }) }), '마감일 지움'); };
}
function pjvBulkPriority(anchor) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  for (const key of PJV_PRIORITY_ORDER) {
    const pm = PJV_PRIORITY[key];
    const item = el('button', { class: 'pjv-menu-item', type: 'button' },
      el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })), el('span', { text: pm.label }));
    item.onclick = () => { close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ priority: key }) }), '우선순위 적용됨'); };
    menu.append(item);
  }
  const none = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
  none.onclick = () => { close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ priority: null }) }), '우선순위 지움'); };
  menu.append(none);
}
async function pjvBulkAssignee(anchor) {
  const menu = el('div', { class: 'pjv-menu pjv-asg-menu' });
  const close = pjvPopover(anchor, menu);
  menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  let members: any[] = [];
  try {
    if (pjvSel.kind === 'task' && pjvSel.ctx && (pjvSel.ctx.members || []).length) {
      members = pjvSel.ctx.members.map((m) => ({ id: m.member_id, name: m.display_name || m.member_id }));
    } else {
      members = ((await api('/api/ui/dash/members')) || []).map((m) => ({ id: m.id || m.member_id, name: m.display_name || m.name || m.id || m.member_id }));
    }
  } catch (_) { /* graceful */ }
  const picked = new Set();
  const render = () => {
    menu.replaceChildren(el('div', { class: 'pjv-menu-head', text: pjvSel.kind === 'task' ? '담당자 지정' : '팀원 지정' }));
    for (const m of members) {
      const on = picked.has(m.id);
      const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
        personFace(m.id, 'pjv-ava', m.name),
        el('span', { class: 'pjv-asg-mname', text: m.name }), el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
      item.onclick = (e) => { e.stopPropagation(); if (on) picked.delete(m.id); else picked.add(m.id); render(); };
      menu.append(item);
    }
    if (!members.length) menu.append(el('div', { class: 'pjv-menu-empty', text: '팀원이 없습니다' }));
    const apply = el('button', { class: 'pjv-menu-item pjv-bulk-apply', type: 'button' }, el('span', { text: '선택 ' + (pjvSel.kind === 'task' ? '담당자' : '팀원') + '로 지정 (' + picked.size + ')' }));
    apply.onclick = () => {
      close(); const ids = [...picked];
      if (pjvSel.kind === 'task') pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id, { method: 'POST', body: JSON.stringify({ assignee: pjvAssigneeWrite(ids) }) }), '담당자 적용됨');
      else pjvBulkApply((id) => pjvSaveProjMembers(id, ids), '팀원 적용됨');
    };
    const clear = el('button', { class: 'pjv-menu-item danger', type: 'button' }, el('span', { text: (pjvSel.kind === 'task' ? '담당자' : '팀원') + ' 비우기' }));
    clear.onclick = () => {
      close();
      if (pjvSel.kind === 'task') pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id, { method: 'POST', body: JSON.stringify({ assignee: null }) }), '담당자 비움');
      else pjvBulkApply((id) => pjvSaveProjMembers(id, []), '팀원 비움');
    };
    menu.append(el('div', { class: 'pjv-bulk-sep-h' }), apply, clear);
  };
  render();
}
async function pjvBulkTags(anchor) {
  if (pjvSel.kind !== 'task') return;
  const menu = el('div', { class: 'pjv-menu pjv-rowtag-pop' });
  const close = pjvPopover(anchor, menu);
  menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  let all: any[] = [];
  try { all = ((await api('/api/ui/v6/tags')) || {}).tags || []; } catch (_) { /* graceful */ }
  menu.replaceChildren(el('div', { class: 'pjv-menu-head', text: '선택 태스크에 태그 추가' }));
  for (const tg of all) {
    const item = el('button', { class: 'pjv-menu-item', type: 'button' },
      el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (tg.color || PJV_TAG_NONE) }), el('span', { text: tg.name }));
    item.onclick = () => { close(); pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id }) }), '태그 추가됨'); };
    menu.append(item);
  }
  if (!all.length) menu.append(el('div', { class: 'pjv-menu-empty', text: '태그가 없습니다 — 행에서 ＋ 로 먼저 만드세요' }));
}
function pjvBulkDuplicate() {
  if (pjvSel.kind === 'task') {
    const pid = pjvSel.ctx && pjvSel.ctx.projectId;
    if (!pid) { toast('복제 대상 프로젝트를 알 수 없습니다', true); return; }
    pjvBulkApply(async (id) => {
      const t = pjvSel.items.get(id); const name = (t.name || t.title || '태스크') + ' (사본)';
      const created = await api('/api/ui/v6/projects/' + pid + '/tasks', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => d && d.task);
      if (created) {
        if (t.status && t.status !== 'todo') await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify({ status: t.status }) }).catch(() => {});
        const patch: any = {}; if (t.assignee) patch.assignee = t.assignee; if (t.due_date) patch.due_date = t.due_date; if (t.priority) patch.priority = t.priority;
        if (Object.keys(patch).length) await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
      }
    }, '복제됨');
  } else {
    pjvBulkApply(async (id) => {
      const p = pjvSel.items.get(id); await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({ name: (p.name || '프로젝트') + ' (사본)' }) });
    }, '복제됨');
  }
}
function pjvBulkDelete() {
  const n = pjvSel.ids.size; const what = pjvSel.kind === 'task' ? '태스크' : '프로젝트';
  if (!confirm(n + '개 ' + what + '를 삭제할까요?\n\n#/trash 에서 복원할 수 있습니다.')) return;
  if (pjvSel.kind === 'task') pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id + '/delete', { method: 'POST', body: JSON.stringify({}) }), '삭제됨');
  else pjvBulkApply((id) => api('/api/ui/v6/projects/' + id + '/delete', { method: 'POST', body: JSON.stringify({}) }), '삭제됨');
}
// 일괄 '리스트로 이동'(프로젝트 전용) — 선택한 프로젝트들을 한 리스트(또는 미분류)로. 기존 49개 정리·대량 분류용.
async function pjvBulkList(anchor) {
  if (pjvSel.kind === 'task') return; // 태스크는 리스트 개념 없음(프로젝트 전용)
  const menu = el('div', { class: 'pjv-menu pjv-listmove-pop' });
  const close = pjvPopover(anchor, menu);
  const headEl = el('div', { class: 'pjv-menu-head', text: '선택 프로젝트를 리스트로 이동' });
  menu.append(headEl, el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  let lists: any[] = [];
  try { lists = ((await api('/api/ui/v6/project-lists')) || {}).lists || []; } catch (_) { /* graceful */ }
  menu.replaceChildren(headEl);
  const mkItem = (label, listId, color) => {
    const item = el('button', { class: 'pjv-menu-item', type: 'button' },
      el('span', { class: 'pjv-list-dot sm', style: 'background:' + (color || 'var(--line, #2a2a33)') }),
      el('span', { class: 'pjv-asg-mname', text: label }));
    item.onclick = () => { close(); pjvBulkApply((id) => api('/api/ui/v6/projects/' + id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) }), '리스트로 이동됨'); };
    return item;
  };
  menu.append(mkItem('기타 (미분류)', null, null));
  for (const l of lists) menu.append(mkItem(l.name, l.id, l.color || avatarColor('list' + l.id)));
  if (!lists.length) menu.append(el('div', { class: 'pjv-menu-empty', text: '폴더가 없습니다 — 상단 ‘폴더’ 버튼을 켜면 왼쪽에서 ‘＋ 새 폴더’로 만들 수 있어요' }));
}

// ── 다중선택 드래그/범위 (#366) — 좌측 체크박스를 눌러 아래로 쭉 끌면 지나온 행이 한 번에 선택된다.
//  · 드래그: 앵커(누른 체크박스)~현재 포인터 아래 행까지를 '칠한다'. 되돌아오면 범위가 줄어(칠하기 전 상태로 복원).
//  · Shift+클릭: 직전 클릭 앵커~현재까지를 선택.
//  체크박스는 같은 kind(프로젝트 XOR 태스크)끼리만 이어진다 — pjvSelToggle 이 kind 혼합을 막기 때문.
const pjvDrag: any = { active: false, kind: null, ctx: null, mode: false, anchorEl: null, moved: false, base: null, lastOver: null, suppressClick: false, _init: false };

// 현재 화면의 같은 kind 체크박스들을 DOM(=시각) 순서로. (자식 서브태스크 체크박스도 문서 순서에 자연히 포함)
function pjvDragChecks(kind) {
  return [...document.querySelectorAll('.pjv-row-check')].filter((c: any) => (c as any)._pjvKind === kind);
}
// 체크박스 하나를 특정 상태로 세팅(멱등) — pjvSel 상태 + .on + 행 하이라이트를 함께 맞춘다.
function pjvSetChecked(cb: any, on) {
  const kind = cb._pjvKind, item = cb._pjvItem, ctx = cb._pjvCtx;
  const cur = pjvSel.kind === kind && pjvSel.ids.has(item.id);
  if (cur !== on) pjvSelToggle(kind, item, ctx);
  cb.classList.toggle('on', on);
  const w = cb.closest('.pjv-trow-wrap'); if (w) w.classList.toggle('pjv-row-selected', on);
}
// 앵커~overCb 범위를 mode 로 칠하고, 범위 밖은 드래그 시작 시점 상태(base)로 복원. 바 재렌더는 1회만.
function pjvDragPaint(overCb) {
  const list = pjvDragChecks(pjvDrag.kind);
  const ai = list.indexOf(pjvDrag.anchorEl);
  const ci = list.indexOf(overCb);
  if (ai < 0 || ci < 0) return;
  const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
  pjvSelSilent = true;
  list.forEach((c, i) => {
    const inRange = i >= lo && i <= hi;
    pjvSetChecked(c, inRange ? pjvDrag.mode : !!(pjvDrag.base && pjvDrag.base.get(c)));
  });
  pjvSelSilent = false;
  pjvSelRenderBar();
}
function pjvDragInit() {
  if (pjvDrag._init) return; pjvDrag._init = true;
  document.addEventListener('pointerover', (e: any) => {
    if (!pjvDrag.active) return;
    if (e.buttons === 0) { pjvDragEnd(null); return; } // 창 밖에서 손을 뗀 경우 등 — 끊김 방지
    const wrap = e.target && e.target.closest && e.target.closest('.pjv-trow-wrap');
    if (!wrap) return;
    const cb = wrap.querySelector('.pjv-row-check'); // wrap 자신의 행 체크박스(문서상 첫 .pjv-row-check)
    if (!cb || (cb as any)._pjvKind !== pjvDrag.kind || cb === pjvDrag.lastOver) return;
    pjvDrag.lastOver = cb;
    if (cb !== pjvDrag.anchorEl) pjvDrag.moved = true;
    pjvDragPaint(cb);
  });
  document.addEventListener('pointerup', (e: any) => { if (pjvDrag.active) pjvDragEnd(e); });
}
function pjvDragEnd(e) {
  // 앵커 위에서 손을 뗐고 실제로 끌었다면, 뒤이어 오는 click 이 앵커를 되돌리지 않게 삼킨다.
  const endOnAnchor = !!(e && e.target && e.target.closest && e.target.closest('.pjv-row-check') === pjvDrag.anchorEl);
  pjvDrag.suppressClick = pjvDrag.moved && endOnAnchor;
  pjvDrag.active = false; pjvDrag.base = null; pjvDrag.lastOver = null;
  document.body.classList.remove('pjv-dragging');
}

// ── 행 호버 컨트롤 — 좌측 체크박스 + 우측 아이콘 그룹(추가·태그·이름변경) ──
function pjvRowCheck(kind, item, ctx) {
  pjvDragInit();
  const cb: any = el('button', { class: 'pjv-row-check', type: 'button', 'aria-label': '선택' });
  cb._pjvKind = kind; cb._pjvItem = item; cb._pjvCtx = ctx;
  if (pjvSel.kind === kind && pjvSel.ids.has(item.id)) cb.classList.add('on');
  cb.addEventListener('pointerdown', (e: any) => {
    if (e.button !== 0) return; // 좌클릭만
    pjvDrag.active = true; pjvDrag.kind = kind; pjvDrag.ctx = ctx;
    pjvDrag.anchorEl = cb; pjvDrag.moved = false; pjvDrag.lastOver = null; pjvDrag.suppressClick = false;
    const anchorOn = pjvSel.kind === kind && pjvSel.ids.has(item.id);
    pjvDrag.mode = !anchorOn; // 앵커가 꺼져있었으면 드래그는 '선택', 켜져있었으면 '해제'
    pjvDrag.base = new Map();
    for (const c of pjvDragChecks(kind)) pjvDrag.base.set(c, c.classList.contains('on'));
    document.body.classList.add('pjv-dragging'); // 드래그 중 텍스트 선택 방지
    e.preventDefault(); // 포커스/드래그 선택 억제(click 은 그대로 발생 → 단순 클릭 유지)
  });
  cb.onclick = (e: any) => {
    e.stopPropagation();
    if (pjvDrag.suppressClick) { pjvDrag.suppressClick = false; return; } // 드래그 뒤 따라온 click 무시
    // Shift+클릭 — 직전 앵커~현재까지 같은 kind 를 이어 선택.
    if (e.shiftKey && pjvSel.kind === kind && pjvSelLastEl && (pjvSelLastEl as any)._pjvKind === kind) {
      const list = pjvDragChecks(kind);
      const ai = list.indexOf(pjvSelLastEl), ci = list.indexOf(cb);
      if (ai >= 0 && ci >= 0) {
        const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
        pjvSelSilent = true;
        for (let i = lo; i <= hi; i++) pjvSetChecked(list[i], true);
        pjvSelSilent = false; pjvSelRenderBar();
        pjvSelLastEl = cb;
        return;
      }
    }
    const on = !(pjvSel.kind === kind && pjvSel.ids.has(item.id));
    pjvSetChecked(cb, on);
    pjvSelLastEl = cb;
  };
  return cb;
}

// ── 그룹 헤더 전체선택 체크박스(#664) — 상태(할 일/진행 중/…) 그룹 헤더 좌측. 클릭하면 그 그룹 본문의
//  모든 행(펼쳐진 하위 포함)을 한 번에 선택/해제한다. 행 체크박스(pjvRowCheck)와 같은 스타일·hover 노출.
//  _pjvKind 를 안 달아 드래그 범위선택(pjvDragChecks)에는 안 섞인다. 선택 리셋 시 .on 은 pjvSelDomClear 가 함께 지운다.
function pjvGroupCheck(kind, bodyEl) {
  const cb: any = el('button', { class: 'pjv-row-check pjv-group-check', type: 'button', title: '이 그룹 전체 선택/해제', 'aria-label': '그룹 전체 선택/해제' });
  const rowChecks = () => [...bodyEl.querySelectorAll('.pjv-row-check')].filter((c: any) => c._pjvKind === kind);
  const allOn = (checks) => checks.length > 0 && checks.every((c: any) => pjvSel.kind === kind && pjvSel.ids.has(c._pjvItem.id));
  const sync = () => { cb.classList.toggle('on', allOn(rowChecks())); };
  cb.addEventListener('pointerenter', sync); // 개별 행 토글로 어긋난 표시를 호버 시점에 재동기
  cb.onclick = (e: any) => {
    e.stopPropagation();
    const checks = rowChecks();
    if (!checks.length) return;
    const on = !allOn(checks);
    pjvSelSilent = true;
    for (const c of checks) pjvSetChecked(c, on);
    pjvSelSilent = false;
    pjvSelRenderBar();
    cb.classList.toggle('on', on);
    pjvSelLastEl = null; // Shift+클릭 앵커는 개별 행 기준 — 그룹 토글 후엔 리셋
  };
  return cb;
}

// ── 그룹 내 프로젝트 행 수동 재정렬(#541) — 기존 행 HTML5 드래그(pjvFolderDrag)를 재사용: 같은 그룹 본문 위면
//  삽입선을 띄우고, 드롭 시 DOM 재배치 + 그 그룹의 새 순서(형제 전체 id)를 projects-reorder 로 저장(sort=1..n).
//  표시 순서는 pjvManualCmp(sort → ClickUp ext_orderindex → 최신순)가 소비. 컬럼 정렬이 켜져 있으면 비활성(ClickUp 동형).
function pjvGroupReorderTarget(body, _reload) {
  let marker: any = null;
  const rows = () => [...body.children].filter((c: any) => c.classList && c.classList.contains('pjv-proj-wrap'));
  const clear = () => { if (marker) { marker.remove(); marker = null; } };
  body.addEventListener('dragover', (ev: any) => {
    if (pjvSortCtx && pjvSortCtx.colSort) return; // 정렬 중엔 수동 순서 의미 없음
    const dragId = pjvFolderDrag.id;
    if (dragId == null) return;
    const dragged = rows().find((w: any) => String(w.getAttribute('data-proj-id')) === String(dragId));
    if (!dragged) return; // 이 그룹의 행이 아님 — 리스트/폴더 이동 등 기존 드롭 타깃에 맡긴다
    ev.preventDefault(); ev.stopPropagation();
    try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* noop */ }
    if (!marker) marker = el('div', { class: 'pjv-proj-insert-marker', 'aria-hidden': 'true' });
    let before: any = null;
    for (const w of rows()) {
      if (w === dragged) continue;
      const r = w.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { before = w; break; }
    }
    if (before) body.insertBefore(marker, before);
    else { const rs = rows(); const last = rs[rs.length - 1]; if (last) body.insertBefore(marker, last.nextSibling); }
  });
  body.addEventListener('dragleave', (ev: any) => { if (!body.contains(ev.relatedTarget)) clear(); });
  body.addEventListener('drop', (ev: any) => {
    const dragId = pjvFolderDrag.id;
    if (dragId == null || !marker) { clear(); return; }
    const dragged = rows().find((w: any) => String(w.getAttribute('data-proj-id')) === String(dragId));
    if (!dragged) { clear(); return; }
    ev.preventDefault(); ev.stopPropagation();
    pjvFolderDrag.id = null;
    body.insertBefore(dragged, marker);
    clear();
    const ids = rows().map((w: any) => Number(w.getAttribute('data-proj-id'))).filter(Boolean);
    if (ids.length > 1) {
      ids.forEach((id, i) => pjvLocalSortOverride.set(id, i + 1)); // 세션 오버라이드 — 재렌더 원복 방지(서버 재부여와 동일 1..n)
      api('/api/ui/v6/projects-reorder', { method: 'POST', body: JSON.stringify({ ids }) })
        .then(() => toast('순서를 저장했습니다'))
        .catch((e) => toast('순서 저장 실패 — ' + e.message, true));
    }
  });
}

// ── 드래그 재정렬(#366) — 호버 시 체크박스 왼쪽 핸들(⠿)을 잡고 위/아래로 끌어 태스크 순서를 바꾼다.
//  · 여러 개 선택(pjvSel, kind='task')한 상태에서 핸들을 잡으면 선택분 전체가 'N개' 한 덩어리로 이동(클릭업 동형).
//  · 드래그 중: 커서를 따라다니는 고스트 + 놓일 자리에 가로 삽입선(marker). 같은 컨테이너의 형제 태스크 행끼리만.
//  · 끝나면 DOM 을 재배치하고 새 순서(sort)를 서버에 저장. 저장 API 미배포 환경에선 화면 순서만 바뀐다(새로고침 시 원복).
const pjvReorder: any = { active: false, wraps: [], container: null, ghost: null, marker: null, reload: null, _init: false };

// 컨테이너의 직계 태스크 행(형제)만 — 서브태스크(.pjv-trow-subs 안)는 각자의 컨테이너에서 다룬다.
function pjvReorderSibs(container) {
  return [...container.children].filter((c: any) => c.classList && c.classList.contains('pjv-trow-wrap') && c.hasAttribute('data-task-id'));
}
function pjvReorderStart(e, wrap, reload) {
  const container = wrap.parentElement;
  if (!container) return;
  const sibs = pjvReorderSibs(container);
  // 이 행이 다중선택(task)에 포함돼 있으면 선택분 전체(같은 컨테이너 것만), 아니면 이 행만 이동.
  const selIds = pjvSel.kind === 'task' ? pjvSel.ids : new Set();
  let moving = sibs.filter((w: any) => selIds.has(Number(w.getAttribute('data-task-id'))));
  if (!moving.length || moving.indexOf(wrap) < 0) moving = [wrap];
  pjvReorder.active = true; pjvReorder.container = container; pjvReorder.wraps = moving; pjvReorder.reload = reload;
  const label = moving.length > 1 ? (moving.length + '개 태스크') : (wrap.getAttribute('data-task-name') || '태스크');
  pjvReorder.ghost = el('div', { class: 'pjv-reorder-ghost', text: label });
  pjvReorder.marker = el('div', { class: 'pjv-reorder-marker', 'aria-hidden': 'true' });
  document.body.append(pjvReorder.ghost);
  moving.forEach((w: any) => w.classList.add('pjv-reorder-src'));
  document.body.classList.add('pjv-dragging');
  pjvReorderMove(e);
  e.preventDefault();
}
function pjvReorderMove(e) {
  if (!pjvReorder.active) return;
  if (e.buttons === 0) { pjvReorderEnd(); return; } // 창 밖에서 손을 뗀 경우 등 — 끊김 방지
  const g = pjvReorder.ghost;
  if (g) { g.style.left = (e.clientX + 14) + 'px'; g.style.top = (e.clientY + 12) + 'px'; }
  const rest = pjvReorderSibs(pjvReorder.container).filter((w: any) => pjvReorder.wraps.indexOf(w) < 0);
  let before: any = null;
  for (const w of rest) {
    const r = w.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { before = w; break; }
  }
  const m = pjvReorder.marker;
  if (before) pjvReorder.container.insertBefore(m, before);
  else pjvReorder.container.append(m);
}
function pjvReorderEnd() {
  if (!pjvReorder.active) return;
  pjvReorder.active = false;
  const { container, wraps, marker, ghost } = pjvReorder;
  document.body.classList.remove('pjv-dragging');
  if (ghost) ghost.remove();
  wraps.forEach((w: any) => w.classList.remove('pjv-reorder-src'));
  if (marker && marker.parentElement === container) { for (const w of wraps) container.insertBefore(w, marker); }
  if (marker) marker.remove();
  const ids = pjvReorderSibs(container).map((w: any) => Number(w.getAttribute('data-task-id')));
  const reload = pjvReorder.reload;
  pjvReorder.wraps = []; pjvReorder.container = null; pjvReorder.ghost = null; pjvReorder.marker = null; pjvReorder.reload = null;
  if (pjvSel.kind === 'task') pjvSelReset(); // 이동 후 선택 해제(자리 이동이 끝났으니)
  if (ids.length > 1) {
    api('/api/ui/v6/tasks-reorder', { method: 'POST', body: JSON.stringify({ ids }) })
      .then(() => toast('순서를 저장했습니다'))
      .catch(() => toast('순서를 화면에만 반영했어요 (저장 미지원 — 새로고침 시 원복)', true));
  }
}
function pjvReorderInit() {
  if (pjvReorder._init) return; pjvReorder._init = true;
  document.addEventListener('pointermove', pjvReorderMove);
  document.addEventListener('pointerup', pjvReorderEnd);
}
// 좌측 드래그 핸들(⠿) — 태스크 행 전용. ctx.reload 로 실패 시 원복 렌더.
function pjvRowGrip(_kind, _item, ctx) {
  pjvReorderInit();
  const g: any = el('button', { class: 'pjv-row-grip', type: 'button', tabindex: '-1', 'aria-label': '드래그해서 순서 바꾸기', title: '드래그해서 순서 바꾸기' }, '⠿');
  g.addEventListener('pointerdown', (e: any) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const wrap = g.closest('.pjv-trow-wrap');
    if (wrap) pjvReorderStart(e, wrap, ctx && ctx.reload);
  });
  g.onclick = (e: any) => { e.stopPropagation(); e.preventDefault(); }; // 핸들 클릭이 행 이동/네비로 새지 않게
  return g;
}
function pjvActIcon(kind) {
  const svg = (...k) => sv('svg', { class: 'pjv-act-ic', viewBox: '0 0 24 24', width: '15', height: '15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...k);
  if (kind === 'add') return svg(sv('path', { d: 'M12 5v14M5 12h14' }));
  if (kind === 'tag') return svg(sv('path', { d: 'M4 4h7l9 9-7 7-9-9z' }), sv('circle', { cx: '8.4', cy: '8.4', r: '1.3' }));
  if (kind === 'rename') return svg(sv('path', { d: 'M4 20h4L18 10l-4-4L4 16z' }), sv('path', { d: 'M13.5 6.5l4 4' }));
  return svg();
}
function pjvRowActions(specs) {
  const group = el('span', { class: 'pjv-row-actions' });
  for (const s of specs) {
    if (!s) continue;
    const b = el('button', { class: 'pjv-row-act', type: 'button', title: s.title }, pjvActIcon(s.icon));
    b.onclick = (e) => { e.stopPropagation(); s.fn(b); };
    group.append(b);
  }
  return group;
}
// 행 인라인 태그 편집 팝오버(태스크) — 토글 추가/제거 + 새 태그 만들기. 닫힐 때 행 칩 갱신(reload).
async function pjvTagPopover(anchor, t, reload) {
  const menu = el('div', { class: 'pjv-menu pjv-rowtag-pop' });
  const close = pjvPopover(anchor, menu);
  let changed = false;
  const obs = new MutationObserver(() => { if (!menu.isConnected) { obs.disconnect(); if (changed && reload) reload(); } });
  obs.observe(document.body, { childList: true, subtree: true });
  const draw = (all) => {
    const cur = new Set((t.tags || []).map((x) => x.id));
    menu.replaceChildren(el('div', { class: 'pjv-menu-head', text: '태그' }));
    for (const tg of all) {
      const on = cur.has(tg.id);
      const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (tg.color || PJV_TAG_NONE) }), el('span', { text: tg.name }), el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
      item.onclick = async (e) => {
        e.stopPropagation();
        try {
          if (on) { t.tags = (t.tags || []).filter((x) => x.id !== tg.id); await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id, remove: true }) }); }
          else { t.tags = [...(t.tags || []), tg]; await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id }) }); }
          changed = true; draw(all);
        } catch (err) { toast('태그 적용 실패 — ' + err.message, true); }
      };
      menu.append(item);
    }
    const inp = el('input', { type: 'text', class: 'pjv-rowtag-input', placeholder: '새 태그 이름 후 Enter', maxlength: '40' });
    inp.onkeydown = async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); const name = (inp as any).value.trim(); if (!name) return;
        try {
          const tags = await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => (r && r.tags) || []);
          t.tags = tags; changed = true;
          const all2 = ((await api('/api/ui/v6/tags')) || {}).tags || []; draw(all2);
        } catch (err) { toast('태그 생성 실패 — ' + err.message, true); }
      }
    };
    menu.append(el('div', { class: 'pjv-bulk-sep-h' }), inp);
  };
  menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  let all: any[] = [];
  try { all = ((await api('/api/ui/v6/tags')) || {}).tags || []; } catch (_) { /* graceful */ }
  draw(all);
}

// 행(프로젝트/태스크/서브태스크) 태그 칩 — 보이는 칩(최대 2)에 호버 ×(제거). 클릭업식. row.id 로 /tasks/:id/tags 공유(프로젝트·태스크 동일).
//  비면 null 반환. 제거는 낙관적(즉시 칩 제거) + 백그라운드 POST(실패 시 reload 로 복구).
function pjvRowTagsEl(row, reload) {
  if (!(row.tags || []).length) return null;
  const wrap = el('span', { class: 'pjv-trow-tags' });
  const removeTag = async (tg) => {
    row.tags = (row.tags || []).filter((x) => x.id !== tg.id);
    repaint();
    try { await api('/api/ui/v6/tasks/' + row.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id, remove: true }) }); }
    catch (e) { toast('태그 제거 실패 — ' + e.message, true); if (reload) reload(); }
  };
  function repaint() {
    wrap.replaceChildren();
    const cur = row.tags || [];
    for (const tg of cur.slice(0, 2)) {
      const x = el('button', { class: 'pjv-trow-tag-x', type: 'button', title: '태그 제거', text: '✕' });
      x.onclick = (e) => { e.stopPropagation(); removeTag(tg); };
      wrap.append(el('span', { class: 'pjv-trow-tag', style: '--tag:' + (tg.color || PJV_TAG_NONE), title: tg.name },
        el('span', { class: 'pjv-trow-tag-name', text: tg.name }), x));
    }
    if (cur.length > 2) wrap.append(el('span', { class: 'pjv-trow-tag-more', text: '+' + (cur.length - 2) }));
  }
  repaint();
  return wrap;
}

function pjvProjRow(p, reload, select, canDelete, fields, anchorId, taskCtx) {
  fields = fields || [];
  pjvRegisterProjList(p.id, p.list_id);   // #731 이 프로젝트의 태스크 행이 소속 리스트 커스텀 상태를 쓰게 등록.
  const isDone = p.status === 'done';
  const selectable = !!select && canDelete(p);
  const wrap = el('div', { class: 'pjv-trow-wrap pjv-proj-wrap', 'data-proj-id': p.id, 'data-proj-name': p.name || '' });

  // 폴더로 드래그(#454) — 선택(일괄) 모드가 아닐 때만. 체크박스·캐럿·버튼·제목링크 등 상호작용 요소에서 시작한
  //  드래그는 취소(칠하기-선택·클릭 유지). 폴더(사이드바 항목·인라인 그룹 헤더)가 드롭 타깃(pjvFolderDrag).
  if (!select) {
    wrap.draggable = true;
    wrap.addEventListener('dragstart', (ev: any) => {
      const t = ev.target as Element;
      // 상호작용 요소 + 펼친 하위(태스크) 영역에서 시작한 드래그는 취소 — 칠하기-선택·클릭·하위 재정렬을 살린다.
      if (t && t.closest && t.closest('.pjv-row-check, .pjv-trow-caret, .pjv-row-actions, .pjv-subcount-ico, .pjv-cell-btn, .pjv-trow-subs, button, input, a')) { ev.preventDefault(); return; }
      pjvFolderDrag.id = p.id; pjvFolderDrag.name = p.name; // #1020 이름은 휴지통 드롭 삭제 확인 문구에 쓴다
      try { ev.dataTransfer.setData('text/plain', String(p.id)); ev.dataTransfer.effectAllowed = 'move'; } catch (_) { /* */ }
      document.body.classList.add('pjv-folder-dragging');
      wrap.classList.add('pjv-proj-drag-src');
    });
    wrap.addEventListener('dragend', () => { pjvFolderDrag.id = null; document.body.classList.remove('pjv-folder-dragging'); wrap.classList.remove('pjv-proj-drag-src'); document.querySelectorAll('.pjv-folder-drop-over').forEach((n) => n.classList.remove('pjv-folder-drop-over')); });
  }

  let lead;
  if (select) {
    if (selectable) {
      const cb = el('button', { class: 'pjv-proj-check', type: 'button', 'aria-label': '선택', 'aria-checked': 'false' });
      const apply = (on) => { cb.classList.toggle('on', on); cb.textContent = on ? '✓' : ''; cb.setAttribute('aria-checked', on ? 'true' : 'false'); };
      apply(select.ids.has(p.id));
      cb.onclick = (e) => {
        e.stopPropagation();
        const on = !select.ids.has(p.id);
        if (on) select.ids.add(p.id); else select.ids.delete(p.id);
        apply(on); select.onToggle();
      };
      lead = cb;
    } else {
      lead = el('span', { class: 'pjv-proj-check disabled', title: '내 프로젝트 아님', 'aria-hidden': 'true' });
    }
  } else {
    lead = pjvProjStatusDot(p, reload);
  }

  const title = el('span', { class: 'pjv-trow-title clickable' + (isDone ? ' done' : ''), title: p.name, text: p.name });
  title.onclick = (e) => {
    e.stopPropagation();
    if (select && selectable) { lead.click(); } else { location.hash = '#/projects2/p/' + p.id; } // #req 프로젝트 탭 목록은 페이지 이동(상세 팝업은 대시보드에서만). 선택모드는 그대로.
  };
  // 펼침 캐럿 — 태스크가 있는 프로젝트만(클릭 시 그 프로젝트의 태스크를 안에 펼침). 선택모드/모드없음/0개면 빈 캐럿.
  const nTasks = Number(p.task_count || 0);
  const canExpand = !select && !!taskCtx && nTasks > 0;
  const caret = canExpand
    ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸', title: nTasks + '개 태스크' })
    : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });
  // 프로젝트 태그 칩(클릭업식) — task_tag_link 를 project.id 로 사용. 칩 호버 시 × 로 제거(pjvRowTagsEl). 최대 2 + "+N".
  const ptagsEl = pjvRowTagsEl(p, reload);
  // 하위 태스크 아이콘(이름 옆 배지) — 클릭하면 캐럿과 동일하게 펼침/접힘(클릭업식). canExpand 일 때만 표시·클릭.
  const subcountEl = canExpand ? el('span', { class: 'pjv-trow-subcount pjv-subcount-ico clickable', role: 'button', tabindex: '0', title: nTasks + '개 태스크 — 클릭하여 펼치기' },
    pjvSubtaskIcon(), el('span', { text: String(nTasks) })) : null;
  const titleCell = el('div', { class: 'pjv-trow-title-cell' },
    select ? null : pjvRowCheck('project', p, { reload }),
    caret, lead, title,
    subcountEl,
    ptagsEl,
    select ? null : pjvRowActions([
      { title: '태스크 추가', icon: 'add', fn: () => pjvAddTask(p.id, null, reload) },
      { title: '태그 편집', icon: 'tag', fn: (b) => pjvTagPopover(b, p, reload) },
      { title: '이름 변경', icon: 'rename', fn: (b) => pjvProjRename(b, p, reload) },
    ]));
  // 제목 셀 전체(글자 + 여백)를 클릭 영역으로 — 태스크 목록처럼. 캐럿·체크박스·상태점·행 액션·제목(자체 핸들러)은 제외(각자 처리).
  titleCell.addEventListener('click', (e) => {
    if ((e.target as Element).closest('button, input, a, .pjv-trow-caret, .pjv-row-actions, .pjv-trow-title')) return;
    if (select && selectable) { lead.click(); } else { location.hash = '#/projects2/p/' + p.id; } // #req 프로젝트 탭 목록은 페이지 이동(상세 팝업은 대시보드에서만). 선택모드는 그대로.
  });

  const row = el('div', { class: 'pjv-trow pjv-proj-row' },
    titleCell,
    el('div', { class: 'pjv-tcell', 'data-col': 'team' }, pjvProjTeamControl(p.members || [], (ids) => pjvSaveProjMembers(p.id, ids))),
    el('div', { class: 'pjv-tcell', 'data-col': 'due' }, pjvDueControl(p, (patch) => projPatch(p.id, patch, reload))),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'start' }, el('span', { class: 'pjv-fval', text: p.start_date ? pjvFmtDate(p.start_date) : '' })),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'created' }, el('span', { class: 'pjv-fval', text: p.created_at ? pjvFmtDate(p.created_at) : '' })),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'updated' }, el('span', { class: 'pjv-fval', text: p.updated_at ? pjvFmtDate(p.updated_at) : '' })),
    el('div', { class: 'pjv-tcell', 'data-col': 'priority' }, pjvPriorityControl(p, (patch) => projPatch(p.id, patch, reload))),
    el('div', { class: 'pjv-tcell pjv-sess-cell', 'data-col': 'sess' }, pjvProjSessionCell(p, reload)),
    ...(fields).map((f) => el('div', { class: 'pjv-tcell pjv-fcell', 'data-col': 'f:' + f.id }, pjvFieldControl(p, f, reload))),
    el('div', { class: 'pjv-tcell pjv-tcell-add' }, pjvProjMore(p, reload, canDelete)));
  row.style.gridTemplateColumns = pjvProjGridTemplate(fields);
  pjvApplyColOrder(row, 'proj', fields); // 열 순서 적용(#611)
  wrap.append(row);

  // 하위(=이 프로젝트의 태스크) 펼침 영역 — 캐럿 클릭 시 lazy 로드, expanded 모드면 자동 펼침. 태스크 박스와 동일한 행/컨트롤.
  if (canExpand) {
    const subBox = el('div', { class: 'pjv-trow-subs pjv-proj-subs' });
    subBox.hidden = true;
    let loaded = false, open = false, loading = false;
    const localReload = () => { if (taskCtx.invalidate) taskCtx.invalidate(p.id); loaded = false; if (open) doLoad(); };
    const doLoad = async () => {
      if (loading) return; loading = true;
      subBox.replaceChildren(el('div', { class: 'pjv-proj-subnote', text: '태스크 불러오는 중…' }));
      try {
        const d = await taskCtx.fetchProjTasks(p.id);
        const tasks = (d && d.tasks) || [];
        subBox.replaceChildren();
        if (!tasks.length) subBox.append(el('div', { class: 'pjv-proj-subnote', text: '태스크가 없습니다.' }));
        else for (const t of tasks) subBox.append(pjvProjTaskRow(p.id, t, d.members, localReload, 1, fields));
        loaded = true;
      } catch (e) { subBox.replaceChildren(el('div', { class: 'pjv-proj-subnote', text: '태스크를 불러오지 못했습니다 — ' + e.message })); }
      loading = false;
    };
    const setOpen = (o) => {
      open = o; caret.textContent = o ? '▾' : '▸'; caret.setAttribute('aria-expanded', o ? 'true' : 'false'); subBox.hidden = !o;
      if (o && !loaded) doLoad();
    };
    caret.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
    if (subcountEl) {
      subcountEl.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
      subcountEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setOpen(!open); } };
    }
    if (taskCtx.mode === 'expanded') setOpen(true);
    wrap.append(subBox);
  }
  return wrap;
}

// 보드에서 프로젝트를 펼쳤을 때 그 안의 태스크 한 행 — 프로젝트 행과 '같은 그리드(pjvProjGridTemplate)'로 그려 컬럼 정렬 일치
//  (세션·커스텀필드 칼럼 자리는 빈 칸). 상태·담당자·마감·우선순위·이름변경·삭제·하위추가 모두 동작. 하위태스크는 캐럿으로 재귀 펼침.
function pjvProjTaskRow(projectId, t, members, reload, depth, boardFields) {
  depth = depth || 0;
  boardFields = boardFields || [];
  const subs = t.subtasks || [];
  const isDone = t.status === 'done';
  const wrap = el('div', { class: 'pjv-trow-wrap', 'data-task-id': t.id, 'data-task-name': t.name || t.title || '', 'data-task-level': t.level || 'task' });

  let open = false;
  const caret = subs.length
    ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸' })
    : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });

  const tagsEl = pjvRowTagsEl(t, reload);
  const subcountEl = subs.length ? el('span', { class: 'pjv-trow-subcount pjv-subcount-ico clickable', role: 'button', tabindex: '0', title: subs.length + '개 하위 — 클릭하여 펼치기' },
    pjvSubtaskIcon(), el('span', { text: String(subs.length) })) : null;
  const titleCell = el('div', { class: 'pjv-trow-title-cell' },
    pjvRowGrip('task', t, { reload }), // 좌측 드래그 핸들(#366) — 잡고 끌어 순서 변경
    pjvRowCheck('task', t, { reload, projectId, members }), // 프로젝트 행과 동일한 선택 체크박스(16px) — 정렬·다중선택 모두 동일하게
    caret, pjvStatusControl(t, reload, projectId),
    el('span', { class: 'pjv-trow-title' + (isDone ? ' done' : ''), text: t.name || t.title || '(제목 없음)' }),
    subcountEl,
    tagsEl);
  titleCell.style.paddingLeft = (depth * 22) + 'px';
  // 제목(셀) 클릭 = 태스크 상세 모달 (#811). 이 행은 보드 전용 렌더러라 pjvTaskRow 에 붙는 모달 배선(data-tm-wired)이
  //  없어서 **눌러도 아무 일도 안 일어났다** — 보드에서 태스크를 열 방법 자체가 없었다. 주소 동기화(#/projects2/t/<id>)는
  //  pjvOpenTaskModal 이 하므로 배선만 하면 따라온다(#810). 컨트롤(그립·체크·캐럿·상태·하위수·행액션)은 각자 동작하도록 통과.
  const titleEl: any = titleCell.querySelector('.pjv-trow-title');
  if (titleEl) { titleEl.classList.add('clickable'); titleEl.title = '상세 열기'; }
  titleCell.addEventListener('click', (e: any) => {
    if (e.target.closest('button, input, a, .pjv-trow-caret, .pjv-row-actions')) return;
    pjvOpenTaskModal(t.id, reload);
  });

  const subBox = el('div', { class: 'pjv-trow-subs' });
  subBox.hidden = true;
  if (subs.length && depth < 4) {
    for (const s of subs) subBox.append(pjvProjTaskRow(projectId, s, members, reload, depth + 1, boardFields));
    const toggle = () => { open = !open; caret.textContent = open ? '▾' : '▸'; caret.setAttribute('aria-expanded', open ? 'true' : 'false'); subBox.hidden = !open; };
    caret.onclick = toggle;
    if (subcountEl) {
      subcountEl.onclick = (e) => { e.stopPropagation(); toggle(); };
      subcountEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); } };
    }
  }

  // 하위 추가 가능 여부는 '레벨'로 판단(시각 indent용 depth 와 분리) — 프로젝트 직속 태스크(level=task)는 depth 1 로 그려도 하위 추가 가능.
  const isTopTask = t.level !== 'subtask';
  const onAddSub = isTopTask ? (() => pjvAddTask(projectId, t.id, reload)) : null;
  const moreBtn = pjvRowMore(projectId, t, isTopTask ? 0 : 1, reload, onAddSub);

  const rowEl = el('div', { class: 'pjv-trow pjv-proj-taskrow' },
    titleCell,
    el('div', { class: 'pjv-tcell', 'data-col': 'team' }, pjvAssigneeControl(t, members, (pa) => pjvSaveTask(t.id, pa))), // 태스크는 담당자지만 보드 그리드의 '팀원' 열 자리(#611 순서 정렬 일치)
    el('div', { class: 'pjv-tcell', 'data-col': 'due' }, pjvDueControl(t, (pa) => pjvPatchTask(t.id, pa, reload))),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'start' }, el('span', { class: 'pjv-fval', text: t.start_date ? pjvFmtDate(t.start_date) : '' })),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'created' }, el('span', { class: 'pjv-fval', text: t.created_at ? pjvFmtDate(t.created_at) : '' })),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'updated' }, el('span', { class: 'pjv-fval', text: t.updated_at ? pjvFmtDate(t.updated_at) : '' })),
    el('div', { class: 'pjv-tcell', 'data-col': 'priority' }, pjvPriorityControl(t, (pa) => pjvPatchTask(t.id, pa, reload))),
    el('div', { class: 'pjv-tcell pjv-sess-cell', 'data-col': 'sess' }),
    ...(boardFields).map((f) => el('div', { class: 'pjv-tcell', 'data-col': 'f:' + f.id })),
    el('div', { class: 'pjv-tcell pjv-tcell-add' }, moreBtn));
  rowEl.style.gridTemplateColumns = pjvProjGridTemplate(boardFields);
  pjvApplyColOrder(rowEl, 'proj', boardFields); // 열 순서 적용(#611)
  wrap.append(rowEl);
  wrap.append(subBox);
  return wrap;
}

// 상태 그룹(진행 중/완료) — 헤더(점·라벨·개수·캐럿[, withCols 면 컬럼 라벨]) + 행들. 빈 그룹은 안내.
function pjvProjGroup(label, statusKey, list, reload, select, canDelete, withCols, fields, anchorId, meId, taskCtx?: any, sepTasks?: any, noAdd?: boolean, listId?: any, statusDef?: any) {
  fields = fields || [];
  sepTasks = sepTasks || [];
  // statusKey=null(#541 그룹바이 — 담당자/우선순위 등 비상태 그룹): 상태 점 없이 라벨만, 추가행 없음(noAdd 전제).
  const meta = statusDef ? { key: pjvNativeStatusOf(statusDef.category), label: statusDef.label, ...pjvCatMeta(statusDef.category) }
    : statusKey ? pjvProjStatusMeta(statusKey)
    : { key: 'in_progress', label, cls: '' };
  const cat = statusDef ? statusDef.category : (statusKey === 'done' ? 'done' : (statusKey === 'todo' ? 'todo' : 'active')); // 완료 여부 판정용
  const body = el('div', { class: 'pjv-tgroup-body' });
  pjvGroupReorderTarget(body, reload); // 그룹 내 수동 재정렬(#541) — 같은 그룹 본문 안 드롭 시 순서 저장
  const countEl = el('span', { class: 'pjv-tgroup-count', text: String(list.length + sepTasks.length) });
  if (list.length) { for (const p of list) body.append(pjvProjRow(p, reload, select, canDelete, fields, anchorId, taskCtx)); }
  else if (cat === 'done' && !sepTasks.length) body.append(el('div', { class: 'pjv-proj-empty', text: '완료한 프로젝트가 아직 없습니다.' }));
  // 분리(separate) 모드 — 각 프로젝트의 태스크를 상태 버킷에 평면 행으로(프로젝트 행과 같은 그리드). 프로젝트 행 아래, 추가행 위.
  for (const s of sepTasks) body.append(pjvProjTaskRow(s.projId, s.task, s.members, reload, 1, fields));
  // 클릭업식 인라인 추가행 — 각 그룹(완료 제외) 맨 아래. 빈 그룹에선 이 행이 '시작하기' CTA. 선택(일괄삭제) 모드에선 숨김.
  if (!select && cat !== 'done' && cat !== 'closed' && !noAdd) body.append(pjvProjAddRow(meta.key, reload, body, countEl, fields, select, canDelete, anchorId, meId, taskCtx, listId, statusDef));

  // 그룹 접힘 상태 — 리스트+그룹 단위로 localStorage 에 저장해 새로고침에도 유지(#req). 기본 펼침.
  const gid = statusDef ? statusDef.key : (statusKey || label);
  let gopen = pjvGrpOpenGet(listId, gid);
  body.hidden = !gopen;   // 저장된 상태가 접힘이면 로드 시점부터 접혀 보이게
  const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: gopen ? '▾' : '▸', 'aria-expanded': String(gopen) });
  gcaret.onclick = () => {
    gopen = !gopen; gcaret.textContent = gopen ? '▾' : '▸';
    gcaret.setAttribute('aria-expanded', gopen ? 'true' : 'false'); body.hidden = !gopen;
    pjvGrpOpenSet(listId, gid, gopen);   // 접힘/펼침 저장 → 다음 새로고침에 반영
  };
  const dot = statusDef ? pjvCustomStatusDot(statusDef, 'sm')
    : statusKey ? pjvStatusIconStd(meta.key, 'sm')
    : el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }); // 비상태 그룹 — 점 없이 정렬만 유지
  // 상태 그룹 헤더 라벨 — 커스텀이든 기본(inherit)이든 같은 색 pill 로 통일(#670). 비상태 그룹(statusKey=null: 담당자·우선순위 등)만 밋밋 라벨.
  const labelEl = statusDef
    ? el('span', { class: 'pjv-tgroup-label pjv-status-pill', style: '--sc:' + statusDef.color, text: label })
    : statusKey
      ? el('span', { class: 'pjv-tgroup-label pjv-status-pill', style: '--sc:' + pjvNativeStatusColor(statusKey), text: label })
      : el('span', { class: 'pjv-tgroup-label', text: label });

  // 그룹 전체선택 체크박스(#664) — 헤더 좌측(행 체크박스와 같은 16px 자리). 레거시 선택(select) 모드에선 스페이서 유지.
  const headCheck = () => select
    ? el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' })
    : pjvGroupCheck('project', body);
  let head;
  if (withCols) {
    head = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols ' + meta.cls },
      el('div', { class: 'pjv-trow-title-cell' }, headCheck(), dot, labelEl, countEl, gcaret, pjvNameResizeHandle()),
      pjvStdColHead('proj', 'team', '팀원'),
      pjvStdColHead('proj', 'due', '마감일'),
      pjvStdColHead('proj', 'start', '시작일'),
      pjvStdColHead('proj', 'created', '생성일'),
      pjvStdColHead('proj', 'updated', '갱신일'),
      pjvStdColHead('proj', 'priority', '우선순위'),
      pjvStdColHead('proj', 'sess', '내 세션'),
      ...(fields || []).map((f) => pjvColumnHead(f, anchorId, reload)),
      el('div', { class: 'pjv-tcell pjv-tcell-add' }, anchorId ? pjvAddColumnButton(anchorId, reload, listId) : el('span', {}))); // #607/D 리스트별 필드 — 이 그룹의 리스트로 컬럼 추가
    head.style.gridTemplateColumns = pjvProjGridTemplate(fields);
    pjvApplyColOrder(head, 'proj', fields);                 // 열 순서 적용(#611)
    pjvWireColReorder(head, 'proj', fields || [], reload);  // 열 순서 드래그 재정렬(기본+커스텀, #611)
  } else {
    // 2번째+ 상태 그룹(non-cols) 헤더도 첫 그룹(withCols)·행과 동일하게 체크박스 자리(#664 전체선택)를 둬 상태점 가로 위치를 맞춘다
    //  (#613 후속 — 첫 그룹만 spacer 가 있어 그룹 간 상태 아이콘 들여쓰기가 어긋나 있었다).
    head = el('div', { class: 'pjv-tgroup-head ' + meta.cls }, headCheck(), dot, labelEl, countEl, gcaret);
  }
  return el('div', { class: 'pjv-tgroup' }, head, body);
}

// 프로젝트 인라인 추가행(클릭업식) — 태스크 add row 와 동형. 클릭→입력칸, Enter=생성(연속 추가 위해 입력 유지·낙관적 삽입), Esc/빈 blur=접기.
//  생성: POST /v6/projects {name} → 작성자=나(actor) 자동 → 내 보드 노출·삭제권한. '할 일' 그룹이면 생성 후 status=todo 패치(기본 생성은 active=진행 중).
//  담당자/마감/우선순위는 팀원이 아직 없어 행 생성 후 각 셀에서 지정(여기선 빈 칸으로 컬럼만 정렬). 모달 없이 그 자리에서.
function pjvProjAddRow(statusKey, reload, body, countEl, fields, select, canDelete, anchorId, meId, taskCtx, listId?, statusDef?) {
  fields = fields || [];
  const row = el('div', { class: 'pjv-addrow' });
  let indentParent: any = null; // Tab 들여쓰기(#663) — 바로 위 프로젝트의 '태스크'로 만들 때 그 부모 {id,name}. Shift+Tab 해제.
  // 접힌 트리거 '＋' 를 그룹 헤더 상태점 열에 맞춘다(#613 후속) — 옛 트리거는 체크박스 자리(check-spacer) 가 없어
  //  '＋ 프로젝트' 가 헤더 파이 아이콘·라벨보다 왼쪽으로 어긋났다. 헤더 title-cell 과 동일한 선두 spacer 로 정렬.
  const trigger = el('button', { class: 'pjv-addrow-trigger', type: 'button', 'data-tour': 'pd-new-project' },   // #853 '프로젝트 체험' 투어 앵커
    el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }),
    el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '프로젝트' }));
  const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '프로젝트 이름 입력 후 Enter (Esc 취소)', maxlength: '200', spellcheck: 'false', autocomplete: 'off' });
  // 생성 전 드래프트 — 팀원·마감·우선순위를 그 자리(인라인 셀)에서 지정해 생성 직후 한 번에 반영(태스크 추가행 pjvAddRow 와 동형).
  const draft: any = { memberIds: [], due_date: null, priority: null };
  const cTeam = el('div', { class: 'pjv-tcell' });
  const cDue = el('div', { class: 'pjv-tcell' });
  const cPriority = el('div', { class: 'pjv-tcell' });
  const setDraft = (p) => { Object.assign(draft, p); paintDateCells(); setTimeout(() => { if (row.classList.contains('editing')) input.focus(); }, 0); };
  // 마감·우선순위 셀만 draft 값을 반영해 다시 그린다. 팀원 셀은 자체 선택 상태를 들고 있으므로 여기서 재생성하지 않는다
  //  (마감일·우선순위를 고를 때 setDraft 가 팀원 셀까지 빈 상태로 다시 그려 선택이 사라지던 버그 방지 — expand 에서 한 번만 생성).
  function paintDateCells() {
    cDue.replaceChildren(pjvDueControl(draft, setDraft));
    cPriority.replaceChildren(pjvPriorityControl(draft, setDraft));
  }
  // 제목 칸 — 실제 프로젝트 행과 동일 구조(체크박스 자리 spacer + 캐럿 자리 + 그룹 상태 동그라미 + 입력)로 그려 픽셀 정렬 일치.
  //  프로젝트 행엔 호버 체크박스(16px)가 자리를 차지하므로, 추가행에도 동일 폭 spacer 를 둬 말머리(상태점) 가로 위치를 맞춘다.
  const buildTitleCell = () => {
    const dotEl = indentParent ? pjvStatusIconStd('todo') // 들여쓰기(#663) — 태스크로 생성되므로 할 일 점선 링
      : statusDef ? pjvCustomStatusDot(statusDef)
      : pjvStatusIconStd(pjvProjStatusMeta(statusKey).key);
    const tc = el('div', { class: 'pjv-trow-title-cell' },
      el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }),
      el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' }),
      dotEl, input);
    if (indentParent) tc.style.paddingLeft = '22px'; // 하위(태스크) 위치 — 태스크 추가행(pjvAddRow)과 동일 톤
    return tc;
  };
  // Tab 들여쓰기 시각화(#663) — 제목 칸을 한 단 들이고 안내문을 부모 프로젝트 이름으로 바꾼다(pjvAddRow 동형).
  const applyIndent = () => {
    const old = row.querySelector('.pjv-trow-title-cell');
    if (old) old.replaceWith(buildTitleCell());
    input.placeholder = indentParent
      ? ('“' + (indentParent.name || '위 프로젝트') + '” 의 태스크 — 이름 입력 후 Enter (Shift+Tab 해제)')
      : '프로젝트 이름 입력 후 Enter (Esc 취소)';
    input.focus();
  };
  const collapse = () => { row.classList.remove('editing'); draft.memberIds = []; draft.due_date = draft.priority = null; indentParent = null; row.replaceChildren(trigger); };
  const expand = () => {
    row.classList.add('editing');
    row.style.gridTemplateColumns = pjvProjGridTemplate(fields);
    // 팀원 셀은 자체 선택 상태를 들고 있어 expand 시 한 번만 생성(이후 마감/우선순위 변경에 재생성하지 않아 선택 유지).
    cTeam.replaceChildren(pjvProjTeamControl([], (ids) => { draft.memberIds = ids; }));
    if (!cTeam.getAttribute('data-col')) cTeam.setAttribute('data-col', 'team');
    if (!cDue.getAttribute('data-col')) cDue.setAttribute('data-col', 'due');
    if (!cPriority.getAttribute('data-col')) cPriority.setAttribute('data-col', 'priority');
    paintDateCells();
    row.replaceChildren(
      buildTitleCell(),
      cTeam, cDue,
      el('div', { class: 'pjv-tcell', 'data-col': 'start' }), el('div', { class: 'pjv-tcell', 'data-col': 'created' }), el('div', { class: 'pjv-tcell', 'data-col': 'updated' }),
      cPriority, el('div', { class: 'pjv-tcell pjv-sess-cell', 'data-col': 'sess' }),
      ...(fields).map((f) => el('div', { class: 'pjv-tcell', 'data-col': 'f:' + f.id })),
      el('div', { class: 'pjv-tcell pjv-tcell-add' }));
    pjvApplyColOrder(row, 'proj', fields); // 열 순서 적용(#611)
    input.focus();
  };
  trigger.onclick = expand;
  // Tab 들여쓰기 커밋(#663) — 위 프로젝트의 '태스크'로 직접 생성(설정 팝업 없이, 태스크 추가행과 동일 경로).
  //  드래프트(팀원 첫 명→담당자·마감·우선순위)도 태스크 패치로 반영. 생성 후 그 프로젝트 태스크 캐시 무효화 + 리로드.
  let busyTask = false;
  const commitAsTask = async () => {
    if (busyTask || !indentParent) return;
    const name = input.value.trim();
    if (!name) { collapse(); return; }
    busyTask = true; input.disabled = true;
    try {
      const created = await api('/api/ui/v6/projects/' + indentParent.id + '/tasks', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => d && d.task);
      const patch: any = {};
      if (draft.memberIds && draft.memberIds[0]) patch.assignee = draft.memberIds[0];
      if (draft.due_date) patch.due_date = draft.due_date;
      if (draft.priority) patch.priority = draft.priority;
      if (created && Object.keys(patch).length) await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
      if (taskCtx && taskCtx.invalidate) taskCtx.invalidate(indentParent.id);
      toast('“' + (indentParent.name || '위 프로젝트') + '” 에 태스크를 추가했습니다');
      pjvReloadKeepScroll(reload);
    } catch (err) { toast('태스크 추가 실패 — ' + err.message, true); input.disabled = false; busyTask = false; }
  };
  // Enter / 바깥클릭(blur) 모두 → 바로 생성하지 않고 '프로젝트 설정 팝업'을 띄운다(이름 + 그룹 상태 + 인라인 드래프트[팀원·마감·우선순위] 프리필).
  //  팝업 뜰 때 인라인 행은 접지 않고 입력을 유지(목록에서 이름이 사라지지 않게), 팝업이 닫히면(생성 후 이동 or 취소) 정리.
  //  단, Tab 들여쓰기 상태(#663)면 팝업 대신 위 프로젝트의 태스크로 즉시 생성.
  let modalOpen = false;
  const openSettingsPopup = () => {
    if (indentParent) { commitAsTask(); return; }
    if (modalOpen) return;
    const name = input.value.trim();
    if (!name) { collapse(); return; }
    modalOpen = true; // blur 가 떠도(팝업으로 포커스 이동) 인라인 행 유지
    const back = openProjectV2Form(reload, {
      name, status: statusKey, status_raw: statusDef ? statusDef.key : null, listId,
      memberIds: draft.memberIds, due_date: draft.due_date, priority: draft.priority,
    });
    if (back && typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver(() => { if (!back.isConnected) { obs.disconnect(); modalOpen = false; collapse(); } });
      obs.observe(document.body, { childList: true });
    } else { modalOpen = false; }
  };
  // 바깥클릭 — 셀 팝오버(.pjv-pop, 드래프트 지정 중)거나 행 내부 포커스면 보류. 이름 있으면 설정 팝업, 없으면 접기.
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (modalOpen || !row.classList.contains('editing')) return;
      if (document.querySelector('.pjv-pop')) return;
      if (row.contains(document.activeElement)) return;
      if (input.value.trim()) openSettingsPopup(); else collapse();
    }, 130);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; collapse(); return; }
    if (e.key === 'Tab') {
      // Tab 들여쓰기(#663) — 바로 위 프로젝트 행을 부모로, 이 입력을 그 프로젝트의 '태스크'로(클릭업식 강등).
      //  Shift+Tab = 해제(다시 프로젝트로). 위에 프로젝트 행이 없으면(분리 태스크 행 등) 무시.
      e.preventDefault();
      if (e.shiftKey) { if (indentParent) { indentParent = null; applyIndent(); } return; }
      if (indentParent) return; // 3단계 위계상 태스크 아래로 더 못 내림(하위태스크는 태스크 행에서)
      const prev = row.previousElementSibling as HTMLElement | null;
      const pid = prev && prev.classList && prev.classList.contains('pjv-proj-wrap') ? prev.getAttribute('data-proj-id') : null;
      if (pid) { indentParent = { id: Number(pid), name: prev!.getAttribute('data-proj-name') || '' }; applyIndent(); }
      return;
    }
    // 한글(IME) 조합 중 Enter 는 글자 확정용 — 그때 커밋하면 마지막 글자가 중복된 이름이 만들어진다(#293 동형).
    if (e.key === 'Enter' && !e.isComposing && (e as any).keyCode !== 229) { e.preventDefault(); openSettingsPopup(); }
  });
  collapse();
  return row;
}

// 프로젝트 목록 카드 — 진행 중/할 일/완료 세 그룹을 한 카드(태스크 리스트와 동일 톤). 컬럼 라벨은 첫(맨 위) 그룹에만.
//  진행 중·할 일은 항상 표시, 완료(Closed)는 헤더의 Closed 토글(pjvProjClosedView.done) 시에만 노출 — 태스크 리스트 동형.
function pjvProjectListCard(todo, inprog, done, reload, select, canDelete, fields, anchorId, meId) {
  const card = el('div', { class: 'card pjv-tasks-card pjv-proj-card', style: 'margin-bottom:18px' });
  pjvInitNameResize(card, 'pjv:nameMin:projlist'); // 이름칸 폭 드래그 저장/복원(#483)
  pjvApplyHiddenCols(card, 'proj'); // 숨긴 기본 컬럼 복원(#req)
  pjvApplyColWidths(card, 'proj'); // 저장된 컬럼 폭 복원(#666)

  // 프로젝트별 태스크 캐시(펼침용) — 같은 보드 렌더 동안 재사용(모드 전환·재펼침 시 재요청 없음). 프로미스 캐싱으로 동시 요청 합침.
  const taskCache = new Map();
  const fetchProjTasks = (projId) => {
    if (taskCache.has(projId)) return taskCache.get(projId);
    const pr = api('/api/ui/v6/projects/' + projId).then((d) => {
      const pj = (d && d.project) || d || {}; // 상세 응답은 { project: { …, tasks } } 로 래핑됨
      return { tasks: pj.tasks || [], members: pj.members || [], fields: pj.fields || [] };
    });
    taskCache.set(projId, pr);
    return pr;
  };
  const taskCtx: any = { mode: pjvProjTaskMode.mode, fetchProjTasks, invalidate: (id) => taskCache.delete(id) };

  // 헤더 — [프로젝트] [하위 태스크▾] ……… [Closed]. 태스크 박스 헤더와 동일 UI/동작(제목만 '프로젝트').
  const subtaskBtn = el('button', { class: 'pjv-subtask-btn', type: 'button', title: '태스크 표시 방식' },
    pjvSubtaskIcon(), el('span', { class: 'pjv-subtask-btn-label', text: PJV_SUBTASK_BTNLABEL[pjvProjTaskMode.mode] }));
  const syncSub = () => {
    subtaskBtn.classList.toggle('active', pjvProjTaskMode.mode !== 'collapsed');
    const lbl = subtaskBtn.querySelector('.pjv-subtask-btn-label');
    if (lbl) lbl.textContent = PJV_SUBTASK_BTNLABEL[pjvProjTaskMode.mode];
  };
  const closedBtn = el('button', { class: 'pjv-closed-btn', type: 'button', title: '닫힌(완료) 프로젝트 표시' },
    pjvCheckCircle(), el('span', { text: 'Closed' }));
  const syncClosed = () => closedBtn.classList.toggle('active', pjvProjClosedView.done);

  const body = el('div', { class: 'pjv-tasks-body' });
  const renderNested = () => {
    body.replaceChildren(
      pjvProjGroup('진행 중', 'in_progress', inprog, reload, select, canDelete, true, fields, anchorId, meId, taskCtx),
      pjvProjGroup('할 일', 'todo', todo, reload, select, canDelete, false, fields, anchorId, meId, taskCtx));
    if (pjvProjClosedView.done) body.append(pjvProjGroup('완료', 'done', done, reload, select, canDelete, false, fields, anchorId, meId, taskCtx));
  };
  // 분리(separate) — 모든 프로젝트의 태스크를 받아 상태 버킷으로 평면 표시(프로젝트 행과 함께). 캐시라 재진입 빠름.
  const renderSeparate = async () => {
    body.replaceChildren(el('div', { class: 'pjv-proj-subnote', text: '태스크 불러오는 중…' }));
    const all = [...inprog, ...todo, ...done].filter((p) => Number(p.task_count || 0) > 0);
    const details = await Promise.all(all.map((p) => fetchProjTasks(p.id).then((d) => ({ p, d })).catch(() => ({ p, d: { tasks: [], members: [] } }))));
    if (pjvProjTaskMode.mode !== 'separate') return; // 모드가 바뀌었으면 폐기(레이스 가드)
    const buckets: any = { in_progress: [], todo: [], done: [] };
    for (const { p, d } of details) for (const t of ((d as any).tasks || [])) {
      const bk = pjvStatusMeta(t.status).bucket;
      (buckets[bk] || buckets.in_progress).push({ projId: p.id, task: t, members: (d as any).members || [] });
    }
    body.replaceChildren(
      pjvProjGroup('진행 중', 'in_progress', inprog, reload, select, canDelete, true, fields, anchorId, meId, taskCtx, buckets.in_progress),
      pjvProjGroup('할 일', 'todo', todo, reload, select, canDelete, false, fields, anchorId, meId, taskCtx, buckets.todo));
    if (pjvProjClosedView.done) body.append(pjvProjGroup('완료', 'done', done, reload, select, canDelete, false, fields, anchorId, meId, taskCtx, buckets.done));
  };
  const render = () => {
    taskCtx.mode = pjvProjTaskMode.mode;
    if (pjvProjTaskMode.mode === 'separate') { renderSeparate(); return; }
    renderNested();
  };

  subtaskBtn.onclick = (e) => { e.stopPropagation(); pjvProjTaskMenu(subtaskBtn, () => { syncSub(); render(); }); };
  closedBtn.onclick = (e) => { e.stopPropagation(); pjvProjClosedView.done = !pjvProjClosedView.done; syncClosed(); render(); };
  syncSub(); syncClosed();

  card.append(el('div', { class: 'card-head' },
    el('div', { class: 'pjv-tasks-head-left' }, el('h2', { text: '프로젝트' }), subtaskBtn),
    el('div', { class: 'card-head-actions' }, closedBtn)));
  card.append(body);
  render();
  return card;
}

// ── 컴팩트 피커 — 멀티선택 피커({box,getSelected,getSelectedLabels})를 '요약 칩 + ▾' 트리거로 감싸 팝오버로 편집. ──
//  카테고리·레포·팀원을 같은 위계(한 줄 트리거)로 통일 + 세로를 크게 절약. makePicker(onChange) 로 피커 생성(onChange=요약 리페인트).
function compactPicker(label, makePicker, opts?) {
  opts = opts || {};
  const chipsWrap = el('div', { class: 'cf-chips' });
  const trigger = el('button', { class: 'cf-trigger', type: 'button', 'aria-haspopup': 'dialog' }, chipsWrap, el('span', { class: 'cf-caret', text: '▾' }));
  const repaint = () => {
    const items = (picker.getSelectedLabels && picker.getSelectedLabels()) || [];
    if (!items.length) { chipsWrap.replaceChildren(el('span', { class: 'cf-empty', text: opts.emptyText || '선택 안 함' })); return; }
    const shown = items.slice(0, opts.maxChips || 5);
    const chips = shown.map((it) => el('span', { class: 'cf-chip' },
      (opts.avatars && it.color) ? el('span', { class: 'cf-ava', style: 'background:' + it.color, text: it.initials }) : null,
      el('span', { class: 'cf-chip-t', text: it.label })));
    if (items.length > shown.length) chips.push(el('span', { class: 'cf-more', text: '+' + (items.length - shown.length) }));
    chipsWrap.replaceChildren(...chips);
  };
  const picker = makePicker(() => { repaint(); if (opts.onChange) opts.onChange(); });  // onChange = 요약 리페인트(+ 호출측 훅: 세부설정의 자동저장 등)
  trigger.onclick = () => {
    const panel = el('div', { class: 'cf-panel' }, picker.box);
    pjvPopover(trigger, panel);
    setTimeout(() => { const inp = panel.querySelector('input[type="text"]') as HTMLInputElement; if (inp) inp.focus(); }, 0);
  };
  repaint();
  const row = el('div', { class: 'cf-row' }, el('span', { class: 'cf-label', text: label }), trigger);
  return { row, getSelected: () => picker.getSelected(), getSelectedLabels: () => (picker.getSelectedLabels ? picker.getSelectedLabels() : []) };
}

// 할 일(선택) — 프로젝트 안의 하위태스크 리스트 UI를 가볍게 옮긴 인메모리 트리 에디터(생성 전이라 API 없이 메모리에만 담고, '만들기' 때 한 번에 생성).
//  클릭업식 결: 상태점(할 일 점선 링) + 이름, [＋하위]로 한 단계 중첩, ×로 삭제. ＋할 일 추가행은 Enter=추가·계속, Esc/빈칸=닫기.
//  가볍게 — 이름만(담당·마감·우선순위는 만든 뒤 프로젝트 안에서). getTasks() → [{ name, subs: [name…] }] (입력 순서 보존).
function npTaskEditor() {
  const model: any[] = [];                                   // [{ name, subs: [{name}], subBox }]
  const listEl = el('div', { class: 'np-tasklist' });
  const dot = () => pjvStatusIconStd('todo'); // 할 일 점선 링 — 프로젝트 행과 동일 톤

  // 자동 성장 입력 — 한 줄 넘으면 세로로 늘어난다(#req: 하위태스크가 여러 줄이면 할일 목록 세로 확장). 이름 전용이라 Enter=확정(줄바꿈 X).
  const growTa = (ta) => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight || 0) + 'px'; };
  const mkGrowInput = (ph) => {
    // 글자수 제한 없음(#607) — 태스크/하위태스크 이름을 길게 적어도 잘리지 않게(서버도 태스크명 길이 제한 없음). 자동성장 textarea 라 길면 세로로 늘어난다.
    const ta = el('textarea', { class: 'pjv-addrow-input np-grow-input', rows: '1', placeholder: ph || '', spellcheck: 'false' });
    ta.addEventListener('input', () => growTa(ta));
    return ta;
  };

  // 제목 인라인 편집(#507) — 제목을 클릭·더블클릭하면 자동성장 textarea 로 교체해 수정. Enter/blur=저장, Esc=취소.
  //  한글(IME) 조합 중 Enter 는 조합 확정용이라 무시(#293 패턴). Esc/Enter 는 오버레이(문서 Esc=팝업 닫기)로 새지 않게 stopPropagation. 인메모리라 값만 갱신.
  const editTitle = (titleEl, get, set) => {
    if (titleEl.dataset.npEditing) return;
    titleEl.dataset.npEditing = '1';
    const ta = mkGrowInput('');
    ta.value = get();
    titleEl.replaceWith(ta);
    growTa(ta); ta.focus(); if (ta.select) ta.select();
    let fin = false;
    const finish = (save) => {
      if (fin) return; fin = true;
      const nv = ta.value.trim().replace(/\s+/g, ' ');
      if (save && nv) { set(nv); titleEl.textContent = nv; }
      ta.replaceWith(titleEl);
      delete titleEl.dataset.npEditing;
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && (e as any).keyCode !== 229) { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    ta.addEventListener('blur', () => finish(true));
  };
  const bindEditable = (titleEl, get, set) => {
    titleEl.classList.add('np-title-editable');
    titleEl.title = '클릭·더블클릭해 수정';
    const go = (e) => { e.stopPropagation(); editTitle(titleEl, get, set); };
    titleEl.addEventListener('click', go);
    titleEl.addEventListener('dblclick', go);
  };

  const buildSubRow = (task, sub) => {
    const del = el('button', { class: 'np-trow-del', type: 'button', title: '삭제', 'aria-label': '삭제', text: '×' });
    const titleEl = el('span', { class: 'np-trow-title', text: sub.name });
    bindEditable(titleEl, () => sub.name, (v) => { sub.name = v; });
    const row = el('div', { class: 'np-trow np-trow-sub' }, dot(), titleEl, del);
    del.onclick = () => { const i = task.subs.indexOf(sub); if (i >= 0) task.subs.splice(i, 1); row.remove(); };
    return row;
  };

  // 하위 인라인 추가 입력 — Enter=추가(입력 유지→연속), Esc/빈 blur=제거. (pjvShowInlineSubtask 의 인메모리판)
  const showSubInput = (task) => {
    const existing = task.subBox.querySelector('.np-subadd');
    if (existing) { existing.querySelector('textarea, input').focus(); return; }
    const input = mkGrowInput('하위 태스크 이름 후 Enter (Esc 취소)');
    const addRow = el('div', { class: 'np-trow np-trow-sub np-subadd' }, dot(), input);
    task.subBox.append(addRow);
    setTimeout(() => { input.focus(); growTa(input); }, 0);
    input.addEventListener('blur', () => setTimeout(() => { if (!input.value.trim()) addRow.remove(); }, 130));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); input.value = ''; addRow.remove(); return; }  // 팝업까지 닫히지 않게(문서 Esc 차단)
      if (e.key !== 'Enter') return;
      if (e.isComposing || (e as any).keyCode === 229) return;  // 한글 IME 조합 확정용 Enter — 중복 생성 방지(#505)
      e.preventDefault(); e.stopPropagation();
      const name = input.value.trim(); if (!name) return;
      const sub = { name }; task.subs.push(sub);
      task.subBox.insertBefore(buildSubRow(task, sub), addRow);  // 입력행 위에 쌓아 입력 유지(연속 입력)
      input.value = ''; growTa(input); input.focus();
    });
  };

  const buildTaskRow = (task) => {
    const addSub = el('button', { class: 'np-trow-act', type: 'button', title: '하위 태스크 추가' }, pjvSubtaskIcon(), el('span', { text: '하위' }));
    const del = el('button', { class: 'np-trow-del', type: 'button', title: '삭제', 'aria-label': '삭제', text: '×' });
    const subBox = el('div', { class: 'np-trow-subs' });
    task.subBox = subBox;
    const titleEl = el('span', { class: 'np-trow-title', text: task.name });
    bindEditable(titleEl, () => task.name, (v) => { task.name = v; });
    const wrap = el('div', { class: 'np-trow-wrap' },
      el('div', { class: 'np-trow np-trow-top' },
        el('div', { class: 'np-trow-title-cell' }, dot(), titleEl),
        el('div', { class: 'np-trow-acts' }, addSub, del)),
      subBox);
    addSub.onclick = () => showSubInput(task);
    del.onclick = () => { const i = model.indexOf(task); if (i >= 0) model.splice(i, 1); wrap.remove(); };
    return wrap;
  };

  // 상위 ＋할 일 추가행 — 트리거(＋ 할 일 추가) ↔ 입력 토글. Enter=추가·계속, Esc/빈 blur=닫기. (pjvProjAddRow 의 인메모리·이름전용판)
  //  Tab(#663) = 바로 위(마지막) 태스크의 '하위'로 들여쓰기(클릭업식), Shift+Tab = 해제. 들여쓴 채 Enter 연타로 하위 연속 추가.
  const trigger = el('button', { class: 'np-add-trigger', type: 'button' }, el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '태스크 추가' }));
  const addInput = mkGrowInput('태스크 이름 후 Enter (여러 개면 계속, Tab 하위로, Esc 닫기)');
  const addRow = el('div', { class: 'np-addrow' }, trigger);
  let indentTask: any = null; // Tab 들여쓰기 대상(바로 위 태스크). null=상위 태스크로 추가.
  const applyIndent = () => {
    addRow.style.paddingLeft = indentTask ? '22px' : '';
    addInput.placeholder = indentTask
      ? ('“' + (indentTask.name || '위 태스크') + '” 의 하위 — 이름 입력 후 Enter (Shift+Tab 해제)')
      : '태스크 이름 후 Enter (여러 개면 계속, Tab 하위로, Esc 닫기)';
    addInput.focus();
  };
  const collapse = () => { addRow.classList.remove('editing'); indentTask = null; addRow.style.paddingLeft = ''; addRow.replaceChildren(trigger); };
  const expand = () => { addRow.classList.add('editing'); addRow.replaceChildren(dot(), addInput); setTimeout(() => { addInput.focus(); growTa(addInput); }, 0); };
  trigger.onclick = expand;
  addInput.addEventListener('blur', () => setTimeout(() => { if (!addInput.value.trim() && !addRow.contains(document.activeElement)) collapse(); }, 130));
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); addInput.value = ''; collapse(); return; }  // 팝업까지 닫히지 않게(문서 Esc 차단)
    if (e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) { if (indentTask) { indentTask = null; applyIndent(); } return; }
      if (!indentTask && model.length) { indentTask = model[model.length - 1]; applyIndent(); } // 위에 태스크가 없으면 무시
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.isComposing || (e as any).keyCode === 229) return;  // 한글 IME 조합 확정용 Enter — 중복 생성 방지(#505)
    e.preventDefault(); e.stopPropagation();
    const name = addInput.value.trim(); if (!name) return;
    if (indentTask && model.indexOf(indentTask) < 0) { indentTask = null; applyIndent(); } // 대상이 삭제됐으면 상위로 복귀
    if (indentTask) {
      // 들여쓴 상태 — 위 태스크의 하위로(인메모리). 하위 인라인 입력(np-subadd)이 열려 있으면 그 위에 쌓는다(showSubInput 동형).
      const sub = { name }; indentTask.subs.push(sub);
      const subAdd = indentTask.subBox && indentTask.subBox.querySelector('.np-subadd');
      if (subAdd) indentTask.subBox.insertBefore(buildSubRow(indentTask, sub), subAdd);
      else if (indentTask.subBox) indentTask.subBox.append(buildSubRow(indentTask, sub));
    } else {
      const task = { name, subs: [] }; model.push(task);
      listEl.append(buildTaskRow(task));
    }
    addInput.value = ''; growTa(addInput); addInput.focus();
  });

  const box = el('div', { class: 'np-tasks-tree' }, listEl, addRow);
  // 입력칸에 Enter 안 하고 남겨둔 텍스트도 커밋(#req 버그수정) — 안 그러면 마지막에 친 태스크가 저장 안 되고 사라짐(증발).
  const flushPending = () => {
    const name = (addInput.value || '').trim(); if (!name) return;
    if (indentTask && model.indexOf(indentTask) >= 0) indentTask.subs.push({ name });
    else model.push({ name, subs: [] });
    addInput.value = '';
  };
  return { box, getTasks: () => { flushPending(); return model.map((t) => ({ name: t.name, subs: t.subs.map((s) => s.name) })); } };
}

// 새 프로젝트(v2) 폼 — 이름·설명·할 일(히어로) + 컴팩트 메타(폴더·카테고리·레포·팀원). 생성 후 상세로 이동.
export function openProjectV2Form(reload, prefill?: any) {
  prefill = prefill || {};
  const nameIn = el('input', { type: 'text', class: 'np-name', value: prefill.name || '', placeholder: '프로젝트 이름 (예: 6월 데모데이 준비)', maxlength: '200' });
  const descIn = el('textarea', { class: 'np-desc', placeholder: '이 프로젝트로 무엇을, 왜 하려는지 적어주세요.\n여기 적은 설명은 나중에 AI 세션이 맥락으로 씁니다 — 길게 써도 좋아요.', maxlength: '5000' });
  if (prefill.description) descIn.value = prefill.description;
  const growDesc = () => { descIn.style.height = 'auto'; descIn.style.height = Math.min(Math.max(descIn.scrollHeight, 132), Math.round((window.innerHeight || 800) * 0.5)) + 'px'; };
  descIn.addEventListener('input', growDesc);
  const listPick = listPicker(prefill.listId);  // 분류(리스트) — 한 목록/상태 뷰에서 만들 때도 여기서 정해 미분류 방지(#337). 카테고리는 이 리스트에서 상속(#541 후속).
  const repoField = compactPicker('관련 레포', (onChange) => repoPicker(prefill.repos || [], { defaultOne: true, onChange }), { emptyText: '선택 안 함' });
  const memberField = compactPicker('팀원', (onChange) => memberPicker(prefill.memberIds || [], { includeMe: true, onChange }), { emptyText: '나만 참여', avatars: true, maxChips: 6 });
  // 선행 프로젝트에서 이어받는 '연결된 지식'(#519/C) — 후속 프로젝트를 인라인 생성할 때 선행의 연결 지식을 프리필로 보여주고
  //  만들 때 새 프로젝트에 required 로 연결한다. 칩 ×로 뺄 수 있음(원치 않으면 제외). 이름(name) 기준 중복 제거.
  const inheritKn: any[] = [];
  { const seen = new Set(); for (const k of (prefill.knowledge || [])) { const nm = k && (k.name || k.knowledge_name); if (nm && !seen.has(nm)) { seen.add(nm); inheritKn.push({ name: nm, title: k.title || nm }); } } }
  let knRow: any = null;
  if (inheritKn.length) {
    const chips = el('div', { class: 'np-inherit-chips' });
    const paintKn = () => {
      chips.replaceChildren(...inheritKn.map((k) => {
        const chip = el('span', { class: 'np-inherit-chip' }, el('span', { class: 'np-inherit-chip-name', text: k.title }));
        const x = el('button', { class: 'np-inherit-chip-x', type: 'button', title: '이어받지 않기', text: '✕' });
        x.onclick = () => { const i = inheritKn.indexOf(k); if (i >= 0) inheritKn.splice(i, 1); paintKn(); if (!inheritKn.length && knRow) knRow.remove(); };
        chip.append(x); return chip;
      }));
    };
    paintKn();
    knRow = el('div', { class: 'cf-row np-inherit-row' }, el('span', { class: 'cf-label', text: '이어받는 지식' }), chips);
  }
  // 태스크(선택) — 설명 바로 아래, 프로젝트 안 하위태스크 리스트를 옮긴 인메모리 트리 에디터. '만들기' 때 태스크(+하위)로 생성.
  const taskEd = npTaskEditor();
  const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기', 'data-tour': 'pd-create-btn' });   // #853 '프로젝트 체험' 투어 앵커
  // #758 만들고 바로 이 프로젝트에 내 AI 세션 열기 + 그 세션 실행 기본값 편집(기본값 = pjvBulkRunDefaultsModal 의 __new__ 전역 스코프).
  const runBtn = el('button', { class: 'btn btn-primary np-run', text: '만들고 AI세션 실행', title: '프로젝트를 만들고 바로 이 프로젝트에 내 AI 세션을 열어 새 탭으로 입장' });
  const defaultsBtn = el('button', { class: 'btn btn-ghost np-run-cfg', type: 'button', text: '기본값', title: 'AI세션 실행 기본값 — 실행기·모델·자동승인·워크트리 등' });
  defaultsBtn.onclick = () => pjvBulkRunDefaultsModal({ projectId: '__new__' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('새 프로젝트',
    el('div', { class: 'np-form' },
      el('div', { class: 'np-hero' },
        el('label', { class: 'np-hero-lbl', text: '이름' }), nameIn,
        el('label', { class: 'np-hero-lbl', style: 'margin-top:14px', text: '설명' }), descIn,
        // 태스크(선택) — 설명 바로 아래에 얹되 '선택'임을 라벨 배지 + 안내로 분명히. 각 태스크 아래로 하위 태스크까지 넣을 수 있음.
        el('label', { class: 'np-hero-lbl np-hero-lbl-opt', style: 'margin-top:16px' }, el('span', { text: '태스크' }), el('span', { class: 'np-opt', text: '선택' })),
        el('div', { class: 'np-tasks-hint', text: '지금 떠오르는 태스크가 있으면 여기에 적어두세요 — 각 태스크 아래로 하위 태스크까지 넣을 수 있어요. 비워둬도 되고, 나중에 프로젝트 안에서 얼마든지 추가·정리할 수 있어요.' }),
        taskEd.box),
      el('div', { class: 'np-meta' },
        el('div', { class: 'cf-row' }, el('span', { class: 'cf-label', text: '리스트' }), listPick.box),
        el('div', { class: 'np-meta-cap', text: '카테고리(도메인)는 소속 리스트에서 물려받아요. 레포·팀원은 비워둬도 되고 나중에 언제든 바꿀 수 있어요.' }),
        repoField.row, memberField.row, knRow)),
    el('div', { class: 'ov-actions' }, saveBtn, runBtn, defaultsBtn, cancelBtn));
  setTimeout(() => { nameIn.focus(); nameIn.select(); growDesc(); }, 0); // 프리필된 이름 전체 선택 + 설명 높이 초기화
  const go = async (withRun?) => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    // 분류(영역) — 영역이 있는데 미선택이면 막는다(미분류는 '기타(미분류)'를 명시적으로 골라야 함, #337).
    await listPick.ready;
    const listChoice = listPick.getSelected();
    if (!listChoice.ok) { toast('리스트를 선택하세요 — 미분류로 두려면 ‘기타(미분류)’를 고르세요', true); return; }
    saveBtn.disabled = true; runBtn.disabled = true;
    try {
      const r = await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({
        name, description: descIn.value.trim() || undefined, members: memberField.getSelected(),
      }) });
      const np = r && (r.project || r);
      // 인라인 그룹에서 연 경우 그 상태로 생성(기본 생성은 active=진행 중). 커스텀 상태면 status_raw 도 함께(#475).
      if (np && np.id && (prefill.status_raw || (prefill.status && prefill.status !== 'active'))) {
        await api('/api/ui/v6/projects/' + np.id + '/status', { method: 'POST', body: JSON.stringify({ status: prefill.status || 'in_progress', status_raw: prefill.status_raw ?? null }) }).catch(() => {});
      }
      // 인라인 추가행에서 지정해 둔 마감·우선순위 드래프트가 있으면 생성 직후 반영.
      if (np && np.id) {
        const patch: any = {};
        if (prefill.due_date) patch.due_date = prefill.due_date;
        if (prefill.priority) patch.priority = prefill.priority;
        if (Object.keys(patch).length) await api('/api/ui/v6/projects/' + np.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
      }
      // 관련 레포를 생성 직후 연결. (카테고리는 소속 리스트에서 상속 — 프로젝트 단위 지정 폐지 #541 후속.)
      const repoNames = repoField.getSelected();
      if (np && np.id && repoNames.length) await api('/api/ui/v6/projects/' + np.id + '/repos', { method: 'POST', body: JSON.stringify({ repos: repoNames }) }).catch(() => {});
      // 모달의 분류(영역) 선택대로 소속 지정 — '기타(미분류)'면 listId=null 이라 호출 생략(기본이 미분류).
      if (np && np.id && listChoice.listId != null) await api('/api/ui/v6/projects/' + np.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listChoice.listId }) }).catch(() => {});
      // 할 일(선택) — 드래프트 트리를 순서대로 태스크로 생성: 상위 먼저(순차·순서 보존) → 그 하위를 parent_task_id 로. 실패는 조용히 건너뜀(프로젝트는 이미 생성됨).
      const draftTasks = taskEd.getTasks();
      let taskFail = 0; // #req 조용히 삼키지 말고 실패 개수 집계 → 사용자에게 알림.
      if (np && np.id && draftTasks.length) {
        for (const dt of draftTasks) {
          let parentId = null;
          try { const tr = await api('/api/ui/v6/projects/' + np.id + '/tasks', { method: 'POST', body: JSON.stringify({ name: dt.name }) }); parentId = tr && tr.task && tr.task.id; }
          catch (_) { taskFail++; } // 상위 생성 실패 시 그 하위도 건너뜀
          if (parentId && dt.subs.length) {
            for (const sn of dt.subs) await api('/api/ui/v6/projects/' + np.id + '/tasks', { method: 'POST', body: JSON.stringify({ name: sn, parent_task_id: parentId }) }).catch(() => { taskFail++; });
          }
        }
        if (taskFail) toast(taskFail + '개 태스크 저장 실패 — 프로젝트 안에서 다시 추가해 주세요', true);
      }
      // 선행/후속 엣지(#519) — 후속 피커에서 인라인 생성한 경우 현재 프로젝트와 연결. edgeDir='in'=새 프로젝트가 edgeWith 의 후속(new→follow_up→edgeWith),
      //  'out'=새 프로젝트가 edgeWith 의 선행(edgeWith→follow_up→new). (from --follow_up--> to = from 이 to 의 후속, #340.)
      if (np && np.id && prefill.edgeWith) {
        const fromId = prefill.edgeDir === 'out' ? prefill.edgeWith : np.id;
        const toId = prefill.edgeDir === 'out' ? np.id : prefill.edgeWith;
        await api('/api/ui/v6/projects/' + fromId + '/link', { method: 'POST', body: JSON.stringify({ to: toId, relation: 'follow_up' }) }).catch(() => {});
      }
      // 선행에서 이어받는 연결 지식(#519/C) — 남긴 것만 required 로 연결.
      if (np && np.id && inheritKn.length) {
        for (const k of inheritKn) await api('/api/ui/v6/projects/' + np.id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: k.name, relation: 'required' }) }).catch(() => {});
      }
      try { localStorage.setItem('lively.newproj.recentRepos', JSON.stringify(repoNames)); } catch (_) { /* */ }
      // #758 '만들고 AI세션 실행' — 생성 직후 이 프로젝트에 내 세션을 열고 새 탭으로 입장. 실행 기본값은 pjvBulkRunDefaultsModal(__new__ 전역).
      if (withRun && np && np.id) {
        const rd = pjvRunDefaults('__new__', []);
        const sbody: any = { label: name, harness: rd.harness || 'claude', autoApprove: rd.autoApprove === true };   // #782 기본 꺼짐
        if (rd.model) sbody.flags = { '--model': rd.model };
        let sid = '';
        try { const sr = await api('/api/ui/v6/projects/' + np.id + '/sessions', { method: 'POST', body: JSON.stringify(sbody) }); sid = (sr && sr.session && sr.session.id) || ''; }
        catch (e) { toast('프로젝트는 만들었지만 세션 실행 실패 — ' + (e.message || e), true); }
        back.remove();
        if (reload) reload();
        toast(sid ? '프로젝트 생성 · AI세션을 새 탭에서 열었어요' : '프로젝트를 만들었어요');
        if (sid) window.open('/ui/terminal.html?session=' + encodeURIComponent(sid) + '&label=' + encodeURIComponent(name), '_blank');
        return;
      }
      back.remove();
      toast('프로젝트를 만들었습니다');
      // stay(#670) — 대시보드처럼 '목록 흐름 유지'가 필요한 호출측은 상세로 튀지 않고 그 자리 목록만 갱신(새 프로젝트가 목록 맨 아래에 자연스럽게).
      if (prefill.stay) { if (reload) reload(); }
      else if (np && np.id) location.hash = '#/projects2/p/' + np.id;
      else if (reload) reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; runBtn.disabled = false; }
  };
  saveBtn.onclick = () => go(false);
  runBtn.onclick = () => go(true);
  // 한글(IME) 조합 중 Enter 는 조합 확정용 — 조합 끝난 진짜 Enter 에서만 생성(#505 중복 방지).
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && (e as any).keyCode !== 229) go(false); });
  return back; // 호출측(인라인 추가행)이 팝업 닫힘을 감지해 인라인 행을 정리할 수 있게 오버레이 엘리먼트 반환
}

// 프로젝트 상세(v2) #/projects2/p/:id — 헤더(이름·상태 토글·팀원) + 태스크▸하위 트리 + 필요/산출 지식.
//  renderProjectDetail 의 헤더 결을 따르되, 본문은 태스크 계층 + 지식 두 섹션(GET /api/ui/v6/projects/:id).
// ── 프로젝트 클릭업식 메타데이터 패널 (상세 헤더, 이름 아래) — 태스크 모달의 pjv-tm-fields 동형 ──
//  상태·담당자·기간·우선순위는 /api/ui/v6/projects/:id(updateProject) 로, 태그·시간추적은 /tasks/:id/(tags|time) 를
//  프로젝트 id 로 호출(같은 task_tag_link/task_time_entry 테이블, 레벨 제약 없음). getProject 가 p.tags·p.time 부여.
function pjvProjStatusPill(p, reload) {
  const meta = pjvProjStatusMeta(p.status);
  const btn = el('button', { class: 'pjv-tm-statuspill ' + meta.cls, type: 'button' },
    pjvStatusIconStd(p.status, 'sm'),
    el('span', { text: meta.label }));
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const st of ['todo', 'in_progress', 'done']) {
      const m = pjvProjStatusMeta(st);
      const cur = pjvProjStatusMeta(p.status).key === st;
      const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' },
        pjvStatusIconStd(st, 'sm'),
        el('span', { text: m.label }));
      item.onclick = () => { close(); if (!cur) pjvSetProjStatus(p.id, st, reload); };
      menu.append(item);
    }
  };
  return btn;
}
function pjvProjDatesField(p, reload) {
  const wrap = el('div', { class: 'pjv-tm-dates' });
  const mk = (field, ph) => {
    const val = p[field];
    const overdue = field === 'due_date' && pjvIsOverdue(p);
    const b = el('button', { class: 'pjv-tm-datebtn' + (val ? '' : ' empty') + (overdue ? ' overdue' : ''), type: 'button' },
      el('span', { text: val ? pjvFmtDate(val) : ph }));
    b.onclick = (e) => {
      e.stopPropagation();
      const input = el('input', { type: 'date', class: 'pjv-date-input', value: val || '' });
      const wrapPop = el('div', { class: 'pjv-menu pjv-date-pop' }, input,
        val ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '지우기',
          onclick: () => { close(); projPatch(p.id, { [field]: null }, reload); } }) : null);
      const close = pjvPopover(b, wrapPop);
      setTimeout(() => { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) { /* noop */ } } }, 0);
      input.onchange = () => { const v = input.value || null; close(); projPatch(p.id, { [field]: v }, reload); };
    };
    return b;
  };
  wrap.append(mk('start_date', 'Start'), el('span', { class: 'pjv-tm-datearrow', text: '→' }), mk('due_date', 'Due'));
  return wrap;
}
// 태그 팝오버 헬퍼 — 태스크 모달과 동일한 아이콘/색 팔레트(프로젝트도 같은 /tags 엔드포인트·CSS 공유).
const PJV_TAG_PALETTE = ['#8b7fd6', '#6b8fff', '#4aa3e0', '#2bb3a3', '#56b877', '#e0b341', '#e8853a', '#e98aa8', '#d96bb0', '#b07fd6', '#a98e7d', '#cfd6e0', '#98a3b5'];
function pjvTagGearIcon() {
  const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 3 }));
  n.append(sv('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }));
  return n;
}
function pjvTagTrashIcon() {
  const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('polyline', { points: '4 7 20 7' }), sv('path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }), sv('path', { d: 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12' }));
  return n;
}
function pjvTagNoneIcon() {
  const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 8 }), sv('line', { x1: 6.4, y1: 6.4, x2: 17.6, y2: 17.6 }));
  return n;
}
function pjvTagBackIcon() {
  const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('polyline', { points: '14 6 8 12 14 18' }));
  return n;
}
// 프로젝트 태그 — 태스크 모달과 동일한 클릭업식 팝오버(선택칩 + 검색/생성 + 토글 + 행별 ⚙ + '모든 태그 관리').
//  프로젝트도 task_tag_link 를 p.id 로 공유 → 엔드포인트(/tasks/:id/tags · /tags/:id)·CSS 모두 태스크와 동일.
function pjvProjTagsField(p, reload) {
  const wrap = el('div', { class: 'pjv-tm-tags' });
  const save = async (body) => {
    try { const d = await api('/api/ui/v6/tasks/' + p.id + '/tags', { method: 'POST', body: JSON.stringify(body) }); p.tags = d.tags || []; return true; }
    catch (e) { toast('태그 저장 실패 — ' + e.message, true); return false; }
  };
  const tagChip = (tg, onRemove) => {
    const chip = el('span', { class: 'pjv-tm-tag', style: '--tag:' + (tg.color || PJV_TAG_NONE) }, el('span', { class: 'pjv-tm-tag-name', text: tg.name }));
    if (onRemove) { const x = el('button', { class: 'pjv-tm-tag-x', type: 'button', title: '제거', text: '✕' }); x.onclick = (e) => { e.stopPropagation(); onRemove(); }; chip.append(x); }
    return chip;
  };
  const render = () => {
    wrap.replaceChildren();
    for (const tg of (p.tags || [])) wrap.append(tagChip(tg, async () => { if (await save({ tag_id: tg.id, remove: true })) render(); }));
    const add = el('button', { class: 'pjv-tm-valbtn' + ((p.tags || []).length ? '' : ' empty'), type: 'button', text: (p.tags || []).length ? '＋' : 'Empty' });
    add.onclick = (e) => { e.stopPropagation(); openPop(add); };
    wrap.append(add);
  };
  async function openPop(anchor) {
    const pop = el('div', { class: 'pjv-menu pjv-tm-tagpop' });
    pjvPopover(anchor, pop);
    let all: any[] = [];
    const loadAll = async () => { try { all = await api('/api/ui/v6/tags').then((r) => (r && r.tags) || []); } catch (_) { all = []; } };
    const selIds = () => new Set((p.tags || []).map((x) => x.id));
    await loadAll();

    function showList(query) {
      const input = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '태그 검색…', maxlength: '40', value: query || '' });
      const chips = el('div', { class: 'pjv-tm-tagpop-chips' });
      const list = el('div', { class: 'pjv-tm-tagresults' });
      const manageBtn = el('button', { class: 'pjv-tm-tagmanage-btn', type: 'button' }, pjvTagGearIcon(), el('span', { text: '모든 태그 관리' }));
      manageBtn.onclick = () => showManageAll();
      pop.replaceChildren(
        el('div', { class: 'pjv-tm-tagpop-top' }, chips, input),
        el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: 'Select an option' })),
        list, manageBtn);
      setTimeout(() => { input.focus(); }, 0);
      const renderChips = () => chips.replaceChildren(...(p.tags || []).map((tag) => tagChip(tag, () => persistRemove(tag.id))));
      const persistAdd = async (x) => { if (await save({ tag_id: x.id })) { render(); renderChips(); renderList(); } };
      const persistRemove = async (tagId) => { if (await save({ tag_id: tagId, remove: true })) { render(); renderChips(); renderList(); } };
      const renderList = () => {
        const qq = input.value.trim();
        const have = selIds();
        const cand = all.filter((x) => (!qq || x.name.toLowerCase().includes(qq.toLowerCase())));
        list.replaceChildren();
        for (const x of cand.slice(0, 40)) {
          const on = have.has(x.id);
          const row = el('button', { class: 'pjv-tm-tagrow' + (on ? ' sel' : ''), type: 'button' },
            pjvCheckMini(on),
            el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }),
            el('span', { class: 'pjv-tm-tagrow-name', text: x.name }));
          row.onclick = () => (on ? persistRemove(x.id) : persistAdd(x));
          const gear = el('button', { class: 'pjv-tm-tagrow-gear', type: 'button', title: '태그 편집' }, pjvTagGearIcon());
          gear.onclick = (e) => { e.stopPropagation(); showColor(x, input.value); };
          row.append(gear);
          list.append(row);
        }
        // 새 태그 생성은 '모든 태그 관리'에서만 — 검색창은 검색·토글 전용(Create 행 없음).
        if (!list.children.length) list.append(el('div', { class: 'pjv-menu-empty', text: qq ? '검색 결과가 없습니다 — 새 태그는 아래 ‘모든 태그 관리’에서 만드세요.' : '태그가 없습니다 — ‘모든 태그 관리’에서 만드세요.' }));
      };
      input.addEventListener('input', renderList);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = input.value.trim(); if (!v) return;
        const exact = all.find((x) => x.name.toLowerCase() === v.toLowerCase());
        if (exact && !selIds().has(exact.id)) { persistAdd(exact); input.value = ''; renderList(); }
        // 일치하는 기존 태그만 추가 — 새 태그 생성은 '모든 태그 관리'에서만.
      });
      renderChips(); renderList();
    }

    function showColor(tag, backQuery, onBack?) {
      const goBack = onBack || (() => showList(backQuery));
      const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvTagBackIcon());
      back.onclick = goBack;
      const nameIn = el('input', { type: 'text', class: 'pjv-tm-tagcolor-name', value: tag.name, maxlength: '40' });
      const grid = el('div', { class: 'pjv-tm-tagcolor-grid' });
      const syncLocal = () => {
        all = all.map((a) => (a.id === tag.id ? { ...a, name: tag.name, color: tag.color } : a));
        p.tags = (p.tags || []).map((x) => (x.id === tag.id ? { ...x, name: tag.name, color: tag.color } : x));
      };
      const renderGrid = () => {
        grid.replaceChildren();
        for (const c of PJV_TAG_PALETTE) {
          const sw = el('button', { class: 'pjv-tm-swatch' + (tag.color === c ? ' sel' : ''), type: 'button', style: 'background:' + c + ';color:' + c, 'aria-label': '색상' });
          sw.onclick = () => applyColor(c);
          grid.append(sw);
        }
        const none = el('button', { class: 'pjv-tm-swatch none' + (!tag.color ? ' sel' : ''), type: 'button', title: '색 없음' }, pjvTagNoneIcon());
        none.onclick = () => applyColor(null);
        grid.append(none);
      };
      const applyColor = async (c) => {
        tag.color = c; renderGrid(); syncLocal(); render();
        try { await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ color: c }) }); }
        catch (e) { toast('실패 — ' + e.message, true); }
      };
      const rename = async () => {
        const v = nameIn.value.trim(); if (!v || v === tag.name) return;
        try { const r = await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ name: v }) }).then((x) => x.tag); tag.name = r.name; syncLocal(); render(); }
        catch (e) { toast('이름 변경 실패 — ' + e.message, true); nameIn.value = tag.name; }
      };
      const del = el('button', { class: 'pjv-tm-tagdelete', type: 'button' }, pjvTagTrashIcon(), el('span', { text: 'Delete' }));
      del.onclick = async () => {
        if (!confirm("'" + tag.name + "' 태그를 삭제할까요?\n모든 항목에서 제거됩니다.")) return;
        try { await api('/api/ui/v6/tags/' + tag.id + '/delete', { method: 'POST', body: JSON.stringify({}) }); p.tags = (p.tags || []).filter((x) => x.id !== tag.id); await loadAll(); render(); goBack(); }
        catch (e) { toast('삭제 실패 — ' + e.message, true); }
      };
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } });
      nameIn.addEventListener('blur', rename);
      pop.replaceChildren(
        el('div', { class: 'pjv-tm-tagcolor-top' }, back, nameIn),
        grid,
        el('div', { class: 'pjv-tm-tagcolor-sep' }),
        del);
      renderGrid();
      setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
    }

    function showManageAll() {
      const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvTagBackIcon());
      back.onclick = () => showList('');
      const list = el('div', { class: 'pjv-tm-tagresults' });
      // 새 태그 생성은 여기('모든 태그 관리')에서만. 정의만 만들고 이 프로젝트엔 적용하지 않는다(생성 직후 링크 해제).
      const createIn = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '＋ 새 태그 이름 입력 후 Enter', maxlength: '40' });
      const doCreate = async () => {
        const v = createIn.value.trim(); if (!v) return;
        if (all.some((x) => x.name.toLowerCase() === v.toLowerCase())) { toast('이미 있는 태그입니다', true); return; }
        createIn.disabled = true;
        const color = PJV_TAG_PALETTE[all.length % PJV_TAG_PALETTE.length];
        if (await save({ name: v, color })) {
          const created = (p.tags || []).find((x) => x.name.toLowerCase() === v.toLowerCase());
          if (created) await save({ tag_id: created.id, remove: true }); // 정의만 — 현재 프로젝트엔 미적용
          await loadAll(); render(); showManageAll();
        } else { createIn.disabled = false; }
      };
      createIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doCreate(); } });
      pop.replaceChildren(
        el('div', { class: 'pjv-tm-tagcolor-top' }, back, el('div', { class: 'pjv-tm-tagmanage-title', text: '모든 태그 관리' })),
        el('div', { class: 'pjv-tm-tagpop-top' }, createIn),
        el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: all.length + '개 · 클릭해 이름·색상·삭제 (모든 항목 반영)' })),
        list);
      setTimeout(() => createIn.focus(), 0);
      if (!all.length) { list.append(el('div', { class: 'pjv-menu-empty', text: '아직 태그가 없습니다 — 위 칸에서 만들어보세요.' })); return; }
      for (const x of all) {
        const row = el('button', { class: 'pjv-tm-tagrow', type: 'button' },
          el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }),
          el('span', { class: 'pjv-tm-tagrow-name', text: x.name }),
          el('span', { class: 'pjv-tm-tagrow-gear' }, pjvTagGearIcon()));
        row.onclick = () => showColor(x, '', showManageAll);
        list.append(row);
      }
    }

    showList('');
  }
  render();
  return wrap;
}
// 패널 — 좌(상태·기간) 우(담당자·우선순위·태그) 2열, 태스크 모달과 동일 결.
// 상세 '리스트' 필드 — 소속 리스트(색점+이름, 미분류면 안내) 표시 + 클릭해 변경(리스트 선택/미분류). getProject 가 p.list 부여.
function pjvProjListField(p, reload) {
  const cur = p.list || null; // { id, name, color } | null
  const btn = el('button', { class: 'pjv-cell-btn' + (cur ? '' : ' empty'), type: 'button', title: '소속 리스트' });
  const paint = () => {
    if (cur) btn.replaceChildren(
      el('span', { class: 'pjv-list-dot sm', style: 'background:' + (cur.color || avatarColor('list' + cur.id)) }),
      el('span', { class: 'pjv-asg-mname', text: cur.name }));
    else btn.replaceChildren(el('span', { class: 'pjv-cell-ph', text: '미분류 — 리스트 지정' }));
  };
  paint();
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu pjv-listmove-pop' });
    const close = pjvPopover(btn, menu);
    const headEl = el('div', { class: 'pjv-menu-head', text: '리스트' });
    menu.append(headEl, el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    api('/api/ui/v6/project-lists').then((d) => {
      const lists = (d && d.lists) || [];
      menu.replaceChildren(headEl);
      const mkItem = (label, listId, color) => {
        const isCur = (p.list_id == null ? listId == null : String(p.list_id) === String(listId));
        const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' },
          el('span', { class: 'pjv-list-dot sm', style: 'background:' + (color || 'var(--line, #2a2a33)') }),
          el('span', { class: 'pjv-asg-mname', text: label }),
          el('span', { class: 'pjv-asg-check', text: isCur ? '✓' : '' }));
        item.onclick = async (ev) => {
          ev.stopPropagation(); close();
          if (isCur) return;
          try { await api('/api/ui/v6/projects/' + p.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) }); toast(listId == null ? '미분류로 옮겼습니다' : '리스트로 옮겼습니다'); if (reload) reload(); }
          catch (err) { toast('이동 실패 — ' + err.message, true); }
        };
        return item;
      };
      menu.append(mkItem('기타 (미분류)', null, null));
      for (const l of lists) menu.append(mkItem(l.name, l.id, l.color || avatarColor('list' + l.id)));
      const addNew = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' },
        el('span', { class: 'pjv-sess-add-ico', text: '＋' }), el('span', { text: '새 리스트…' }));
      addNew.onclick = (ev) => { ev.stopPropagation(); close(); openListForm(reload); };
      menu.append(el('div', { class: 'pjv-bulk-sep-h' }), addNew);
    }).catch((err) => menu.replaceChildren(headEl, el('div', { class: 'pjv-menu-empty', text: '리스트를 불러오지 못했어요 — ' + err.message })));
  };
  return btn;
}

function pjvProjMetaPanel(p, members, reload) {
  const row = (glyph, label, control) => el('div', { class: 'pjv-tm-field' },
    el('span', { class: 'pjv-tm-field-ico', 'aria-hidden': 'true', text: glyph }),
    el('span', { class: 'pjv-tm-field-label', text: label }),
    el('div', { class: 'pjv-tm-field-val' }, control));
  // 선행/후속 프로젝트 — 프로퍼티 '첫 줄'(좌=선행, 우=후속). #340 의 별도 박스를 프로퍼티로 이관(#359) 후,
  //  사용자 요청으로 맨 위 첫 줄로 이동. 예전엔 풀폭 래퍼(pjv-proj-meta-edges, align-items:start)로 감쌌는데
  //  그 override 때문에 라벨 세로선이 다른 행과 어긋나 보였음 → 일반 row 로 통일(부모 2열 그리드에 그대로
  //  흘러 상태·폴더 등과 아이콘/라벨/값 세로선이 정확히 정렬됨).
  return el('div', { class: 'pjv-tm-fields pjv-proj-meta' },
    row('←', '선행 프로젝트', pjvProjEdgesField(p, reload, 'out')),
    row('→', '후속 프로젝트', pjvProjEdgesField(p, reload, 'in')),
    row('◎', '상태', pjvProjStatusPill(p, reload)),
    // 소속 리스트(클릭업 List) — 클릭해 변경. 미분류면 '리스트 지정' 안내.
    row('🗂', '리스트', pjvProjListField(p, reload)),
    // 팀원 = 담당자 — 프로퍼티 팝아웃에서 바로 검색·토글로 넣고 뺀다(#req — 옛 보기전용 pjvProjTeamView 폐기).
    //  보드 행/리스트 헤더의 팀원 셀과 동일 컴포넌트(pjvProjTeamControl) + 조용한 저장(토글마다 즉시 저장,
    //  리로드 없음 — 리로드하면 팝아웃이 닫혀 다중 토글이 안 됨. 아바타는 컨트롤이 자체 갱신).
    row('👤', '팀원', pjvProjTeamControl(members, (ids) => pjvSaveProjMembers(p.id, ids))),
    row('🗓', '기간', pjvProjDatesField(p, reload)),
    row('⚑', '우선순위', pjvPriorityControl(p, (patch) => projPatch(p.id, patch, reload))),
    // (⏱ 시간 추적 필드 제거 — #473 후속, 프로젝트엔 불필요한 속성.)
    row('🏷', '태그', pjvProjTagsField(p, reload)),
    // #541 무손실 이관 가산 — ①프로젝트 자신의 커스텀필드 값(ClickUp 최상위 태스크 값의 표시 표면 = 여기)
    //  ②원본(ClickUp 등) 링크. 둘 다 있을 때만 행 추가(네이티브 프로젝트 UI 는 불변).
    ...((p.fields || []).filter((f) => f && (p.field_values || {})[String(f.id)] !== undefined)
      .map((f) => row('▦', f.name, pjvFieldControl(p, f, () => pjvReloadKeepScroll(reload))))),
    ...(p.external_url ? [row('↗', '원본', el('a', {
      class: 'pjv-proj-extlink', target: '_blank', rel: 'noopener noreferrer',
      href: /^https?:\/\//i.test(String(p.external_url)) ? String(p.external_url) : '#',
      text: (p.external_system === 'clickup' ? 'ClickUp' : (p.external_system || '원본')) + '에서 열기',
    }))] : []));
}

// 선행/후속 프로젝트 필드(프로퍼티) — dir='out'=선행(이 프로젝트가 뒤따르는 앞 프로젝트, edges.outgoing),
//  dir='in'=후속(이 프로젝트를 뒤따르는 뒤 프로젝트, edges.incoming). 칩(상세 링크 + ✕ 해제) + ＋로 검색·추가.
//  방향 의미(#340): from --follow_up--> to = from 이 to 의 후속. 선행 추가=this→pick, 후속 추가=pick→this.
function pjvProjEdgesField(p, reload, dir) {
  const edges = p.edges || { outgoing: [], incoming: [] };
  const list = (dir === 'out' ? edges.outgoing : edges.incoming) || [];
  const wrap = el('div', { class: 'pjv-proj-edges' });
  for (const e of list) {
    const link = el('a', { class: 'pjv-edge-chip-link', href: '#/projects2/p/' + e.project_id,
      title: '#' + e.project_id + ' ' + (e.project_name || ''), text: e.project_name || ('#' + e.project_id) });
    // 모달 안에서 누르면 그 프로젝트 모달로 '교체'(드릴인) — 같은 탭 해시 이동은 모달 뒤에서 라우트만 바꿔
    //  '클릭해도 아무 일 없는' 죽은 클릭이 된다(#804). 태스크 모달의 하위 태스크 드릴인과 동일 결.
    //  전체 페이지에선 기본 동작(같은 탭 이동) 유지 — 거기선 모달이 없어 정상 작동한다.
    link.onclick = (ev) => {
      const pm = _pjvPmOpen;
      if (!pm || !link.closest('.pjv-pm')) return;
      ev.preventDefault();
      pm.close('swap');  // 교체일 뿐이니 뒤 화면(보드) 재렌더는 생략 — 새 모달이 곧 그 위를 덮는다. URL 항목은 새 모달이 이어받는다(#808)
      pjvOpenProjectModal(e.project_id, pm.pageReload);
    };
    const chip = el('span', { class: 'pjv-edge-chip' }, link);
    const x = el('button', { class: 'pjv-edge-chip-x', type: 'button', title: '관계 해제', text: '✕' });
    x.onclick = async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const fromId = dir === 'out' ? p.id : e.project_id;
      const toId = dir === 'out' ? e.project_id : p.id;
      try {
        await api('/api/ui/v6/projects/' + fromId + '/link', { method: 'POST', body: JSON.stringify({ to: toId, relation: e.relation || 'follow_up', unlink: true }) });
        toast('관계를 해제했습니다'); pjvReloadKeepScroll(reload);
      } catch (err) { toast('해제 실패 — ' + err.message, true); }
    };
    chip.append(x);
    wrap.append(chip);
  }
  const addBtn = el('button', { class: 'pjv-edge-add' + (list.length ? '' : ' empty'), type: 'button',
    title: dir === 'out' ? '선행 프로젝트 추가' : '후속 프로젝트 추가',
    text: list.length ? '＋' : ('＋ ' + (dir === 'out' ? '선행' : '후속')) });
  addBtn.onclick = (e) => { e.stopPropagation(); pjvProjEdgePicker(addBtn, p, dir, reload); };
  wrap.append(addBtn);
  return wrap;
}

// 선행/후속 추가 팝오버 — 프로젝트 검색(이름/번호) → 선택 시 엣지 연결. 이미 연결된 것·자기 자신 제외.
function pjvProjEdgePicker(anchor, p, dir, reload) {
  const edges = p.edges || { outgoing: [], incoming: [] };
  const existing = new Set([...(edges.outgoing || []).map((e) => e.project_id), ...(edges.incoming || []).map((e) => e.project_id), p.id]);
  const menu = el('div', { class: 'pjv-menu pjv-edge-pick' });
  const search = el('input', { type: 'search', class: 'pjv-edge-pick-search', placeholder: '프로젝트 검색(이름/번호)' });
  const results = el('div', { class: 'pjv-edge-pick-results' });
  menu.append(
    el('div', { class: 'pjv-edge-pick-hint', text: dir === 'out' ? '이 프로젝트가 뒤따르는 선행 프로젝트를 고르세요' : '이 프로젝트를 뒤따르는 후속 프로젝트를 고르세요' }),
    search, results);
  // 기존 프로젝트를 고르는 것 외에, '새 프로젝트 만들기'(#519) — 새 프로젝트 폼을 열되 현재 프로젝트를 선행/후속으로 프리필하고,
  //  현재 프로젝트의 본문(설명)·연결된 지식도 새 폼에 이어받게(#519/C). dir='in'=현재가 새 프로젝트의 선행이 됨.
  const createNew = el('button', { class: 'pjv-menu-item pjv-edge-pick-new', type: 'button' },
    el('span', { class: 'pjv-edge-pick-name', text: '＋ 새 프로젝트 만들기' }),
    el('span', { class: 'pjv-edge-pick-id', text: dir === 'out' ? '이 프로젝트의 선행으로' : '이 프로젝트의 후속으로' }));
  createNew.onclick = () => {
    close();
    const kdefs = [...(((p.knowledge || {}).required) || []), ...(((p.knowledge || {}).produced) || [])];
    openProjectV2Form(reload, { edgeWith: p.id, edgeDir: dir, listId: p.list_id, description: p.description || '', knowledge: kdefs });
  };
  menu.append(createNew);
  const close = pjvPopover(anchor, menu);
  let all: any[] = [];
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const items = all.filter((pr) => !existing.has(pr.id) && (!q || (pr.name || '').toLowerCase().includes(q) || String(pr.id).includes(q))).slice(0, 30);
    results.replaceChildren(...(items.length ? items.map((pr) => {
      const b = el('button', { class: 'pjv-menu-item pjv-edge-pick-item', type: 'button' },
        el('span', { class: 'pjv-edge-pick-name', text: pr.name || '제목 없음' }),
        el('span', { class: 'pjv-edge-pick-id', text: '#' + pr.id }));
      b.onclick = async () => {
        b.disabled = true;
        const fromId = dir === 'out' ? p.id : pr.id;
        const toId = dir === 'out' ? pr.id : p.id;
        try {
          await api('/api/ui/v6/projects/' + fromId + '/link', { method: 'POST', body: JSON.stringify({ to: toId, relation: 'follow_up' }) });
          toast('연결했습니다'); close(); pjvReloadKeepScroll(reload);
        } catch (e) { b.disabled = false; toast('연결 실패 — ' + e.message, true); }
      };
      return b;
    }) : [el('div', { class: 'pjv-menu-empty', text: q ? '결과 없음' : '연결할 다른 프로젝트가 없어요' })]));
  };
  search.addEventListener('input', paint);
  results.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  (async () => { try { all = await api('/api/ui/v6/projects').then((d) => (d && d.projects) || []); } catch (_) { all = []; } paint(); })();
  setTimeout(() => { try { search.focus(); } catch (_) { /* noop */ } }, 0);
}

// ── Lively 둘러보기(#761) 전용 예시 프로젝트 — 실제 데이터 대신 '선행/후행·연결된 지식·과업'을 직관적으로 보여주는
//  큐레이팅된 상세 페이지. 실제 UI 컴포넌트(메타패널·본문·지식·태스크)를 그대로 재사용해 진짜처럼 보이되 내용만 고정.
//  라우트: #/projects2/p/__demo__ (아래 renderProjectV2Detail 상단 가드). 저장/생성 액션은 안 쓴다(투어는 취소로 끝).
const DEMO_PROJECT: any = {
  id: '__demo__', name: '새 요금제 ‘팀 플랜’ 출시', status: 'in_progress', list_id: null,
  body: '기존 개인 요금제에 여러 명이 함께 쓰는 ‘팀 플랜’을 새로 추가한다. 목표는 3개월 내 유료 전환율 +15%.',
  description: '기존 개인 요금제에 여러 명이 함께 쓰는 ‘팀 플랜’을 새로 추가한다. 목표는 3개월 내 유료 전환율 +15%.',
  members: [{ member_id: 'demo-me', display_name: '나' }, { member_id: 'demo-minji', display_name: '민지' }],
  edges: {
    // 선행(outgoing)=이 프로젝트가 뒤따르는 앞 일 · 후행(incoming)=이 프로젝트를 뒤따르는 뒤 일. 조사 → (출시) → 분석 흐름.
    outgoing: [{ project_id: 'demo-pre', project_name: '경쟁사 요금제 조사', relation: 'follow_up' }],
    incoming: [{ project_id: 'demo-post', project_name: '출시 후 전환율 분석', relation: 'follow_up' }],
  },
  knowledge: {
    required: [
      { name: 'demo-kn-price', title: '경쟁사 가격 비교 (2월 조사)' },
      { name: 'demo-kn-policy', title: '요금 정책 결정 로그' },
    ],
    produced: [],
  },
  tasks: [
    { id: 'demo-t1', name: '팀 플랜 가격·인원 정책 확정', status: 'done', subtasks: [] },
    { id: 'demo-t2', name: '결제 페이지에 팀 플랜 추가', status: 'in_progress', subtasks: [] },
    { id: 'demo-t3', name: '기존 고객에게 출시 안내 메일 발송', status: 'todo', subtasks: [] },
  ],
  fields: [], repos: [],
};

// 데모 세션 이름 프리필 — 세션 이름은 '프로젝트명'이 아니라 '이 세션이 하는 일'로 짓는 게 자연스럽다(투어가 가르치려는 것).
//  그래서 데모 '＋새 세션'(웹)의 이름은 프로젝트명(DEMO_PROJECT.name) 대신 이 예시로 프리필한다 — 데모 태스크 'demo-t3
//  기존 고객에게 출시 안내 메일 발송'과 같은 세계. ⚠ guide-tour.ts 의 sess-name 코치마크 예시와 반드시 일치시킨다.
const DEMO_SESSION_NAME = '출시 안내 메일 초안';

function renderProjectDemo(view) {
  const P = DEMO_PROJECT, members = P.members, noop = () => {};
  const meId = (state.me && (state.me.userId || state.me.email)) || 'demo-me';
  const backLink = el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2', text: '← 프로젝트' });
  const head = el('div', { class: 'page-head' }, backLink);
  const titleEl = el('h1', { class: 'proj-detail-title', text: P.name });
  const settingsBtn = el('button', { class: 'btn btn-sm btn-ghost', text: '⚙ 프로젝트 세부 설정',
    onclick: () => toast('둘러보기 예시라 여기선 생략돼요 — 실제 프로젝트에서 열 수 있어요.') });
  head.append(el('div', { class: 'proj-detail-titlebar' },
    el('div', { class: 'proj-detail-titlebox' }, titleEl),
    el('div', { class: 'proj-detail-actions' }, settingsBtn)));
  head.append(pjvProjMetaPanel(P, members, noop));
  view.replaceChildren(head,
    projectBodySection('__demo__', P, noop),
    projectKnowledgeSection('__demo__', P, noop),
    pjvTasksSection('__demo__', P.tasks, members, noop, []),
    demoFolderCard(),
    demoTerminalCard(members, meId));
  (document.getElementById('view') as any)?.focus?.();
}

// 데모 공유 폴더 — 파일 fetch 없이 '공유 폴더' 카드(제목·앵커는 실제와 동일 → 투어가 짚는다).
function demoFolderCard() {
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '공유 폴더' }),
    el('div', { class: 'card-head-actions' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더' }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 업로드' }))));
  const file = (ic, nm) => el('div', { class: 'proj-file-card' },
    el('div', { class: 'proj-file-card-ic', text: ic }),
    el('div', { class: 'proj-file-card-nm', text: nm }));
  card.append(el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;padding:6px 2px' },
    file('📊', '요금제_비교표.xlsx'), file('📄', '출시_공지_초안.docx'), file('🖼', '결제화면_시안.png')));
  return card;
}

// 데모 터미널 세션 — 실제 '＋ 새 세션' 드롭다운·만들기 팝업(openProjectSessionForm)을 그대로 열어 투어가 시연.
//  세션 목록은 fetch 없이 팀원 진열만. 만들기 팝업은 제출 안 하고 취소로 끝나므로 데모 id 여도 안전.
function demoTerminalCard(members, meId) {
  const card = el('div', { class: 'card proj-term-card', style: 'margin-bottom:18px' });
  const newBtn = el('button', { class: 'btn btn-ghost btn-sm', 'data-tour': 'proj-new-session', text: '＋ 새 세션' });
  newBtn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu pjv-sess-menu' });
    const close = pjvPopover(newBtn, menu, { align: 'right' });
    const mkItem = (icon, label, desc, fn) => {
      const item = el('button', { class: 'pjv-menu-item', type: 'button' },
        el('span', { class: 'pjv-sess-ico', text: icon }),
        el('span', { style: 'display:flex;flex-direction:column;gap:1px;min-width:0' },
          el('span', { text: label }), el('span', { class: 'caption', text: desc })));
      item.onclick = (ev) => { ev.stopPropagation(); close(); fn(); };
      return item;
    };
    const localItem = mkItem('💻', '내 PC에서 열기', '개발자용 · 직접 설치해 실행',
      () => openLocalWorkModal('__demo__', { id: '__demo__', name: DEMO_PROJECT.name, repos: [] }));
    const webItem = mkItem('☁️', '웹에서 바로 열기', '설치 불필요 · 팀 공용',
      // 세션 이름은 프로젝트명이 아니라 '이 세션이 하는 일'로 프리필한다(투어 sess-name 코치마크 예시와 일치, #1009).
      () => openProjectSessionForm('__demo__', () => {}, '/api/ui/v6/projects/', DEMO_SESSION_NAME, []));
    webItem.dataset.tour = 'sess-web';
    menu.append(localItem, webItem);
  };
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '터미널 세션' }), el('div', { class: 'card-head-actions' }, newBtn)));
  const person = (m) => el('div', { class: 'proj-person' },
    personFace(m.member_id, 'proj-avatar', m.display_name || m.member_id),
    el('div', { class: 'proj-person-name', text: m.display_name || m.member_id }),
    el('div', { class: 'proj-person-status empty', text: m.member_id === meId ? '✎ 상태 남기기' : '' }));
  card.append(el('div', { class: 'proj-people-grid' }, ...members.map(person)));
  return card;
}

// 프로젝트 상세 팝업 — 대시보드 '내 프로젝트' 행 클릭 시 페이지로 튀지 않고 모달로 연다. 상세를 **그대로**(축약 없이)
//  렌더하고 모달 안에서 스크롤한다: 페이지와 똑같은 renderProjectV2Detail 을 모달 컨테이너에 호출하므로 내용·편집·재렌더가 전부 동일.
//  페이지용 '← 프로젝트' 백링크만 모달에선 CSS 로 숨긴다(모달은 ✕·Esc·배경클릭으로 닫음). 닫을 때 호출자(대시보드) 갱신.
//  태스크 팝업(pjvOpenTaskModal)과 동일한 결. 상세가 등록하는 전역 paste 핸들러는 DOM 이탈 시 스스로 해제되므로 누수 없음.
// 지금 열린 프로젝트 모달(항상 최대 1개) — 네 곳이 쓴다:
//  ① 모달 안 선행/후속 칩이 이 모달을 닫고 그 프로젝트로 '교체'(드릴인, #804)
//  ② 라우트가 바뀌면 라우터가 닫는다(pjvCloseProjectModalOnRoute, #804) — 단 '자기 주소'면 살려둔다(#810)
//  ③ 모달이 소유한 URL(히스토리 항목)을 닫을 때 되돌린다(#808 — 아래 _pjvPmUrl)
//  ④ 위에 겹친 태스크 모달(#810)이 '내가 닫히면 라우터가 뒤 화면을 그릴까'를 판단할 때(pjvProjectModalOpen)
// 닫는 경로마다 URL·재렌더 처리가 달라 mode 로 구분한다(#808 — 옛 skipReload 불리언을 대체):
//  'user'  ✕·Esc·배경클릭   → 우리가 넣은 히스토리 항목을 pop(뒤로) → 원래 URL 복귀 + 라우터가 뒤 화면을 다시 그림
//  'route' 라우터가 닫음     → URL 은 이미 다른 곳으로 갔다 → 히스토리·재렌더 둘 다 손대지 않는다
//  'page'  '전체 페이지로 ↗' → 같은 URL 에서 페이지가 렌더된다 → 항목은 그대로 두고 재렌더는 라우터에 맡긴다
//  'swap'  선행/후속 드릴인  → 다음 모달이 같은 항목을 replaceState 로 이어받는다(히스토리가 안 쌓인다)
type PjvPmClose = 'user' | 'route' | 'page' | 'swap';
let _pjvPmOpen: { close: (mode?: PjvPmClose) => void; pageReload?: any; url: string; refresh: () => void } | null = null;
// 모달이 소유한 히스토리 항목(#808) — 열 때 push 한 '#/projects2/p/<id>'. ret = 그 직전 해시(닫으면 돌아갈 곳).
//  null = URL 을 소유하지 않음(push 실패했거나 이미 그 해시) → 닫을 때 히스토리를 건드리지 않는다.
let _pjvPmUrl: { ret: string } | null = null;
// 라우터(main.ts route())가 호출 — 모달은 document.body 에 얹혀 라우터가 존재를 모른다. 안 닫으면 새 페이지가
//  모달 뒤에 렌더돼 '클릭해도 아무 일 없는' 죽은 클릭이 된다(뒤로가기도 동일). 편집 중 본문은 모달이 닫히며 저장된다.
// #810 — 모달은 '자기 주소'를 소유한다(#808). 새 주소가 그 주소면 **살려둔다**: 위에 겹쳤던 태스크 모달을 닫고
//  이 모달의 주소로 되돌아온 경우다. true 를 돌려주면 라우터는 뒤 화면(보드·대시보드)도 다시 그리지 않는다 —
//  모달 뒤는 열었을 때 그대로여야 하니까.
function pjvCloseProjectModalOnRoute(): boolean {
  if (!_pjvPmOpen) return false;
  if (_pjvPmOpen.url === location.hash) return true;
  _pjvPmOpen.close('route');
  return false;
}
// 프로젝트 모달이 떠 있나 — 태스크 모달(#810)이 '내가 pop 하면 라우터가 뒤 화면을 다시 그릴지'를 판단할 때 쓴다.
//  떠 있으면 라우터는 그 모달을 살려두느라 아무것도 안 그리므로, 태스크 모달이 직접 pageReload 해야 한다.
function pjvProjectModalOpen(): boolean { return !!_pjvPmOpen; }
// 전역 실행취소(undo.ts) 처럼 '지금 화면'을 다시 그려야 할 때 — 이 모달이 주소의 주인이면 라우터는 안 도니(위 규칙)
//  모달 안을 직접 다시 그린다. 그리지 않으면 되돌린 결과가 화면에 안 보이는 조용한 스테일이 된다.
function pjvProjectModalRefreshIfRoute(): boolean {
  if (!_pjvPmOpen || _pjvPmOpen.url !== location.hash) return false;
  _pjvPmOpen.refresh();
  return true;
}

function pjvOpenProjectModal(projectId, pageReload?) {
  // 주소는 지금 보고 있는 것을 가리킨다(#808) — 모달이 뜨면 URL 도 그 프로젝트가 된다(복사·공유·북마크가 통하고,
  //  새로고침하면 같은 내용이 전체 페이지로 뜬다. 뒤로가기 = 모달 닫고 목록). pushState 는 hashchange 를 쏘지 않으므로
  //  (#541 스코프 딥링크가 이미 기대는 사실) 라우터가 돌지 않는다 — 돌면 #804 의 '라우트가 바뀌면 모달을 닫는다'가
  //  방금 연 모달을 닫아버리는 자충수가 된다.
  const url = '#/projects2/p/' + projectId;
  if (_pjvPmUrl) {
    // 드릴인 교체(선행/후속 칩) — 앞 모달이 이미 항목을 소유 중이니 늘리지 말고 갈아끼운다(뒤로가기 한 번 = 목록).
    try { history.replaceState(null, '', url); } catch (_) { /* noop */ }
  } else if (location.hash !== url) {
    const ret = location.hash || '#/';
    try { history.pushState(null, '', url); _pjvPmUrl = { ret }; } catch (_) { /* noop */ }
  }

  const back = el('div', { class: 'pjv-pm-back' });
  const box = el('div', { class: 'pjv-pm' });
  const bodyEl = el('div', { class: 'pjv-pm-body' });
  const fullLink = el('a', { class: 'btn btn-ghost btn-sm', href: url,
    text: '전체 페이지로 ↗', title: '이 프로젝트를 전체 페이지로 열기' });
  const closeBtn = el('button', { class: 'pjv-pm-x', type: 'button', title: '닫기 (Esc)', 'aria-label': '닫기', text: '✕' });
  box.append(el('div', { class: 'pjv-pm-head' }, fullLink, closeBtn), bodyEl);
  back.append(box);

  let closed = false;
  function closeModal(mode: PjvPmClose = 'user') {
    if (closed) return;
    closed = true;
    if (_pjvPmOpen && _pjvPmOpen.close === closeModal) _pjvPmOpen = null;
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('pjv-pm-open');
    back.remove();
    // URL 되돌리기(#808) — 우리가 넣은 항목을 pop 하면 원래 해시(보드·대시보드)로 돌아가고, 그 hashchange 로 라우터가
    //  뒤 화면을 새로 그린다 → pageReload(모달 안 수정을 목록에 반영)는 그 재렌더가 대신하므로 생략한다(이중 렌더·중복
    //  fetch 방지 — #804 가 라우터 close 에서 편 논리와 같다). 'route'(이미 다른 데로 이동)·'page'(같은 URL 에서 페이지가
    //  렌더됨)에서 히스토리를 되돌리면 사용자를 엉뚱한 곳으로 돌려보내게 된다 → 항목만 놓아준다. 'swap' 은 다음 모달이 이어받는다.
    let popped = false;
    if (mode === 'user') {
      if (_pjvPmUrl) { _pjvPmUrl = null; try { history.back(); popped = true; } catch (_) { /* noop */ } }
    } else if (mode !== 'swap') {
      _pjvPmUrl = null;
    }
    if (pageReload && mode === 'user' && !popped) pageReload(); // 모달 안에서 고친 내용이 대시보드 목록에 반영되도록
  }
  // Esc — 중첩 팝업(태스크 모달·팝오버·오버레이·블록에디터 팝업)이 떠 있으면 그쪽이 먼저 처리하고 이 모달은 유지.
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.pjv-tm-back, .pjv-pop, .ov-back, .be-slash, .be-turnpop, .be-linkpop, .be-blockmenu, .be-mentionmenu')) return;
    closeModal();
  }
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); }); // 배경 클릭
  closeBtn.onclick = (e) => { e.stopPropagation(); closeModal(); };
  // '전체 페이지로 ↗' — 모달을 닫고 같은 주소에서 전체 페이지를 그린다. URL 은 이미 이 프로젝트라(#808) 앵커를 그대로
  //  두면 해시가 안 바뀌어 hashchange 가 안 뜨고 → 라우터가 안 돌아 '눌러도 아무 일 없는' 죽은 클릭이 된다(#804 부류).
  //  라우터를 직접 깨운다(undo.ts rerenderRoute 와 같은 방식). ⌘/Ctrl/Shift/중클릭 은 브라우저 기본(새 탭) — 모달은 유지.
  fullLink.onclick = (e: any) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    closeModal('page'); // 라우터가 곧 그 페이지를 그리므로 재렌더는 생략. 히스토리 항목은 그대로(이제 페이지가 그 URL 의 주인)
    if (location.hash === url) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = url; // URL 동기화가 안 된 예외(pushState 실패 등) — 평소대로 해시 이동
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  document.body.classList.add('pjv-pm-open');
  //  url = 이 모달이 소유한 주소(라우터가 '살려둘지' 판단 · #810), refresh = 모달 안만 다시 그리기(undo 등)
  _pjvPmOpen = { close: closeModal, pageReload, url, refresh: () => renderProjectV2Detail(bodyEl, String(projectId)) };

  renderProjectV2Detail(bodyEl, String(projectId)); // 페이지와 동일한 렌더러 → 내용 축약 없음
  return closeModal;
}

async function renderProjectV2Detail(view, idStr) {
  if (idStr === '__demo__') return renderProjectDemo(view); // Lively 둘러보기 전용 예시 프로젝트(#761)
  pjvSelReset(); // 화면 진입/재렌더 시 다중선택·하단 바 초기화
  pjvSortCtx = null; pjvGroupCtx = null; // 보드의 정렬/그룹 컨텍스트 잔존 차단(#541 리뷰 — 상세 헤더가 보드 리스트 설정을 오염)
  const id = Number(idStr);
  const V6_BASE = '/api/ui/v6/projects/'; // 파일/세션/타임라인/팀원 섹션이 v6 라우트로 연결되도록 base 주입
  const backLink = el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2', text: '← 프로젝트' });
  const keepY = _pjvKeepScrollY; _pjvKeepScrollY = null; // 인라인 편집 재렌더면 스켈레톤 스킵 + 스크롤 복원(#358)
  if (keepY == null) view.replaceChildren(skeleton('프로젝트를 불러오는 중'));
  let data: any;
  try { data = await api('/api/ui/v6/projects/' + id).then((d) => d && (d.project || d)); }
  catch (e) {
    view.replaceChildren(el('div', { class: 'page-head' }, backLink), errorNote(e, '프로젝트를 불러오지 못했습니다'));
    return;
  }
  if (!data) { view.replaceChildren(el('div', { class: 'page-head' }, backLink), el('div', { class: 'note', text: '프로젝트를 찾을 수 없습니다.' })); return; }
  const p = data;
  // #731 상세 뷰는 보드처럼 전체 리스트를 싣지 않아 상태 레지스트리가 비어있을 수 있다 → 이 프로젝트·태스크 상태칩이
  //  소속 리스트의 커스텀 상태(색·이름)를 쓰도록 리스트 레지스트리를 보강하고 프로젝트→리스트 매핑을 등록한다.
  pjvRegisterProjList(p.id, p.list_id);
  if (p.list_id != null && !pjvStatusReg.has(Number(p.list_id))) {
    try {
      const [ld] = await Promise.all([api('/api/ui/v6/project-lists'), pjvLoadStatusTemplates()]); // #729 스페이스 기본도 함께 로드
      pjvSetStatusRegistry((ld && ld.lists) || []);
    } catch (_) { /* 실패 시 네이티브 폴백 */ }
  }
  const members = p.members || [];
  const isDone = p.status === 'done';
  const reload = () => renderProjectV2Detail(view, idStr);

  // 헤더 — 제목(이름+상태칩) 좌 / 액션(완료토글·삭제) 우 한 줄, 설명, 팀원 칩(아래 별도 행). 박스 높이·세로정렬 통일.
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'proj-detail-back' }, backLink));
  // 상태 토글(완료/재개)은 '프로젝트 세부 설정' 팝업으로 이관 — 헤더엔 상태칩만 둔다.
  // 프로젝트 세부 설정 — 우측 액션 슬롯. 상태(완료된 프로젝트로/재개)·규칙(터미널 AI 주입)·연결된 지식 팝업.
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  // 삭제·팀원 수정은 '프로젝트 세부 설정' 팝업으로 이관 — 헤더 우측 액션은 설정 버튼만(권한 경계는 백엔드 403).
  const settingsBtn = el('button', { class: 'btn btn-sm btn-ghost', text: '⚙ 프로젝트 세부 설정',
    onclick: () => openProjectSettings(id, p, reload, meId, V6_BASE) });
  // '내 컴퓨터에서 작업'은 헤더에서 빼고 터미널 세션의 '＋ 새 세션' 드롭다운으로 이관(내 컴퓨터 / 중앙 컴퓨터 선택) — projectTerminalSection.
  // (코멘트는 헤더 버튼이 아니라 본문↔태스크 사이의 '코멘트' 섹션이 진입점 — projectCommentsSection. 클릭=드로어.)
  // 제목줄 — 이름(클릭해 수정)+상태칩(좌), 세부설정(우).
  const titleEl = el('h1', { class: 'proj-detail-title proj-detail-title-edit', title: '클릭해 이름 수정', text: p.name });
  const editTitle = () => {
    // 인라인 편집 = 제목(h1)과 같은 폰트·위치의 '테두리 없는' 자동확장 textarea(#493). 이름이 길면 잘리지 않고
    //  가로 전체를 쓰고 여러 줄로 늘어난다(입력창 UI 가 어색하던 문제 해소 — 태스크 모달 제목과 동일 결).
    const inp = el('textarea', { class: 'proj-detail-title-input', rows: '1', maxlength: '200', spellcheck: 'false' });
    inp.value = p.name;
    const autoGrow = () => { inp.style.height = 'auto'; inp.style.height = inp.scrollHeight + 'px'; };
    titleEl.replaceWith(inp);
    autoGrow(); inp.focus(); if (inp.select) inp.select();
    inp.addEventListener('input', autoGrow);
    let fin = false;
    const done = async (save) => {
      if (fin) return; fin = true;
      const nv = inp.value.trim().replace(/\s+/g, ' '); inp.replaceWith(titleEl);
      if (save && nv && nv !== p.name) {
        try { await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ name: nv }) }); p.name = nv; titleEl.textContent = nv; }
        catch (e) { toast('이름 수정 실패 — ' + e.message, true); }
      }
    };
    // 한글(IME) 조합 중 Enter 는 조합 확정용 — 조합이 끝난 진짜 Enter 에서만 저장(#293 패턴). Enter=저장(줄바꿈 X), Esc=취소.
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && (e as any).keyCode !== 229) { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    inp.addEventListener('blur', () => done(true));
  };
  titleEl.onclick = editTitle;
  head.append(el('div', { class: 'proj-detail-titlebar' },
    // 상태 배지(타이틀 오른쪽) 제거 — 아래 메타행의 상태 필드(클릭해 변경)와 중복이라 그쪽만 남긴다.
    el('div', { class: 'proj-detail-titlebox' }, titleEl),
    el('div', { class: 'proj-detail-actions' }, settingsBtn)));
  // (본문은 헤더에서 빼고 태스크 위 '본문' 섹션으로 분리 — projectBodySection. 다른 섹션과 동일 위계.)
  // 팀원 칩 행(proj-team-row) 제거 — 아래 메타 패널의 '팀원' 필드와 중복이라 한 곳(메타)만 남긴다.
  // 클릭업식 메타데이터 패널 — 이름 바로 아래(태스크 박스 위). 상태·팀원·기간·우선순위·태그.
  head.append(pjvProjMetaPanel(p, members, reload));

  // 상세 본문 — 태스크(작업 위계)를 헤더 바로 아래 맨 위에 둔다(프로젝트의 핵심). 이어 공유 폴더 ·
  //  터미널 세션 · 작업 타임라인(org #/projects 템플릿과 동형, v6 데이터·라우트). 모든 섹션 v6 API base 연결.
  //  '필요/산출 지식'은 본문 바로 아래 '지식 흐름' 섹션으로 분리(#245) — 세부 설정 팝업에서 이관.
  // 후속/선행 프로젝트는 별도 박스(projectEdgesSection)를 없애고 상단 프로퍼티(pjvProjMetaPanel)로 이관(#359).
  view.replaceChildren(head,
    projectBodySection(id, p, reload),
    projectKnowledgeSection(id, p, reload),
    projectCommentsSection(id, members),
    pjvTasksSection(id, p.tasks || [], members, reload, p.fields || []),
    projectFolderSection(id, V6_BASE),
    projectTerminalSection(id, members, meId, V6_BASE, p.name, p),
    projectTimelineSection(id, members, V6_BASE));
  // 인라인 편집 재렌더면 리빌 애니메이션 대신 스크롤 복원(전면 재애니메이션도 '새로고침'처럼 보임) (#358)
  if (keepY != null) pjvRestoreScroll(keepY); else applyReveal(Array.from(view.children).slice(1));
}

// ── 세션 기록(#905 C1): 별도 섹션이 공간을 많이 먹어 → 터미널 섹션 헤더의 [📜 세션 기록] 버튼→모달로 이관
//  (openProjectSessionsModal, sessions.ts). 끝난 세션까지 남는 '이력', 인가는 서버(프로젝트 멤버). ──

// ── 본문 섹션 — 태스크 위, 다른 섹션(공유 폴더·터미널 세션·작업 타임라인)과 동일 위계·디자인(.card + .card-head). ──
//  마크다운 렌더 + 본문 클릭/✎ 편집 버튼으로 그 자리 편집(Enter 저장·Shift+Enter 줄바꿈·Esc 취소). 길면 접힘+Expand.
// ── 본문 속 지식 링크 언펄(#317 범위 A — 감지+표시만; 필요지식 자동등록은 하지 않음) ──
//  본문에 붙여넣은 위키 링크(`#/k/<name>` 또는 게이트웨이 풀 URL `…/ui/#/k/<name>`)를 표시 렌더에서 '제목 + 링크'로 보여준다.
//  게이트웨이 주소는 하드코딩하지 않는다(고객사마다 다름) — 현재 origin + org 프로필 gateway_url(loadAdmin) 호스트만 '우리 것'으로 인정.
//  renderInline 은 생 URL 을 오토링크하지 않으므로, 렌더 전에 `[<name>](#/k/<name>)` 마크다운 링크로 치환하고 제목은 비동기로 채운다.
let _gwHostsP: any = null;
function gatewayHosts() {
  if (_gwHostsP) return _gwHostsP;
  _gwHostsP = (async () => {
    const hosts = new Set([location.host]);
    try {
      const d = await loadAdmin();
      const gw = d && d.profile && d.profile.gateway_url;
      if (gw) hosts.add(new URL(String(gw).replace(/\/mcp$/, '').replace(/\/$/, '')).host);
    } catch (_) { /* 프로필 못 받으면 현재 origin 만 */ }
    return hosts;
  })();
  return _gwHostsP;
}
const _knTitleCache = new Map();  // name → title|null (null=없음/실패, 재요청 안 함)
async function knTitle(name) {
  if (_knTitleCache.has(name)) return _knTitleCache.get(name);
  let title: any = null;
  try { const d = await api('/api/ui/knowledge/' + encodeURIComponent(name)); title = (d && d.knowledge && d.knowledge.title) || null; }
  catch (_) { title = null; }
  _knTitleCache.set(name, title);
  return title;
}
// md 안의 지식 링크를 `[<name>](#/k/<name>)` 로 치환. 풀 URL 은 host 가 우리 게이트웨이(hosts)일 때만. 이미 마크다운 링크 타깃인 건 건너뛴다.
function linkifyKnowledgeRefs(md, hosts) {
  const names = new Set();
  const out = String(md == null ? '' : md).replace(/(?:https?:\/\/[^\s)\]]+?)?#\/k\/([\w-]+)/g, (m, name, offset, str) => {
    const before = offset > 0 ? str.charAt(offset - 1) : '';
    if (before === '(' || before === ']') return m;  // 기존 [..](..) 링크 타깃 → 안 건드림
    if (m.charAt(0) === 'h') {  // 풀 URL → host 검증(우리 게이트웨이만)
      try { if (!hosts.has(new URL(m.split('#')[0]).host)) return m; } catch (_) { return m; }
    }
    names.add(name);
    return '[' + name + '](#/k/' + name + ')';
  });
  return { md: out, names };
}
// 렌더된 본문에서 지식 링크: 클릭(본문 편집 진입) 차단 + 제목으로 텍스트 교체. 게이트웨이 host 가 현재 origin 과 다르면 한 번 재치환.
async function unfurlKnowledgeLinks(body, desc, first, onBodyClick, measure) {
  let names = first.names;
  try {
    const hosts = await gatewayHosts();
    if (!(hosts.size === 1 && hosts.has(location.host))) {
      const re = linkifyKnowledgeRefs(desc, hosts);
      if (re.md !== first.md) { body.replaceChildren(renderMarkdown(re.md)); body.onclick = onBodyClick; names = re.names; }
    }
  } catch (_) { /* noop */ }
  body.querySelectorAll('a.md-link').forEach((a: any) => {
    if (!(a.getAttribute('href') || '').startsWith('#/k/')) return;
    a.classList.add('kn-unfurl');
    a.addEventListener('click', (e) => e.stopPropagation());  // 링크 클릭 시 본문 편집 진입 방지
  });
  for (const name of names) {
    const title = await knTitle(name);
    if (!title) continue;
    body.querySelectorAll('a.md-link').forEach((a: any) => {
      if (a.getAttribute('href') === '#/k/' + name) { a.textContent = title; a.title = name; }
    });
  }
  if (measure) requestAnimationFrame(measure);
}

// #730 본문 파일 업로드 — 프로젝트 폴더 하위(dir)에 저장하고 인라인 서빙 URL(/api/ui/…/file?path=)을 돌려준다.
//  core.ts 의 이미지 로더(#551)가 /api/ui/ 경로 이미지를 인증 fetch→blob 으로 렌더하므로 ![](url) 로 바로 표시·왕복.
async function uploadBodyFile(projId, dir, file) {
  try {
    const orig = (file && file.name) || 'file';
    const dot = orig.lastIndexOf('.');
    const ext = dot > 0 ? orig.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : (String(file.type || '').split('/')[1] || '').replace(/[^a-z0-9]/g, '');
    const stem = (dot > 0 ? orig.slice(0, dot) : orig).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'file';
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const stamp = '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    const fname = stem + '-' + stamp + (ext ? '.' + ext : '');
    const relPath = dir + '/' + fname;
    const url = '/api/ui/v6/projects/' + projId + '/file?path=' + encodeURIComponent(relPath);
    await authUpload(url, new File([file], fname, { type: file.type }));
    return url;
  } catch (e: any) { toast('업로드 실패 — ' + (e && e.message || e), true); return null; }
}

// #730 본문 블록 에디터 마운트 — 프로젝트/태스크/하위태스크 공용. 노션형 블록 에디터(항시 편집·자동저장).
//  config.save(md):Promise — 서버 저장. config.uploadFile(file):Promise<url|null> — 이미지/첨부 업로드.
//  반환 { el, flush, isDirty, destroy } — 호출부가 닫힐 때 flush()(미저장분 저장) + destroy() 권장.
function mountBodyEditor(config: { initial?: string; placeholder?: string; save: (md: string) => Promise<void>; uploadFile?: (f: File) => Promise<string | null> }) {
  let saveTimer: any = null, saving = false, lastSaved = config.initial || '';
  const chip = el('span', { class: 'pjv-bodyed-chip' });
  const setChip = (t, warn?) => { chip.textContent = t || ''; chip.classList.toggle('warn', !!warn); };
  const doSave = async () => {
    if (saving) return;
    const md = editor.getMarkdown();
    if (md === lastSaved) { editor.resetDirty(); setChip(''); return; }
    saving = true; setChip('저장 중…');
    try { await config.save(md); lastSaved = md; editor.resetDirty(); setChip('저장됨'); setTimeout(() => { if (chip.textContent === '저장됨') setChip(''); }, 1600); }
    catch (e: any) { setChip('저장 실패', true); toast('본문 저장 실패 — ' + (e && e.message || e), true); }
    saving = false;
    if (editor.isDirty()) queueSave();
  };
  const queueSave = () => { setChip('수정됨…', true); clearTimeout(saveTimer); saveTimer = setTimeout(doSave, 1200); };
  const flush = () => { clearTimeout(saveTimer); return editor.isDirty() ? doSave() : Promise.resolve(); };
  const editor = createBlockEditor({
    initial: config.initial || '',
    placeholder: config.placeholder,
    onChange: queueSave,
    onSaveShortcut: () => { clearTimeout(saveTimer); doSave(); },
    uploadFile: config.uploadFile,
  });
  const box = el('div', { class: 'pjv-bodyed' }, editor.el, el('div', { class: 'pjv-bodyed-bar' }, chip));
  // 본문 속 지식 링크(#/k/…)는 새 탭(#804). 프로젝트·태스크 본문은 모달로도 뜨는데(pjvOpenProjectModal·pjvOpenTaskModal),
  //  모달은 body 에 얹히고 라우터엔 모달 정리가 없어 같은 탭 이동은 모달 뒤에서 라우트만 바꾼다 → 죽은 클릭.
  //  편집 중인 본문(항시 편집·자동저장)을 두고 페이지가 떠나지도 않는다. 링크는 매 재렌더마다 새로 생기므로 위임(capture)으로 잡는다.
  //  ⚠ WIKI 문서 에디터는 createBlockEditor 를 직접 쓰므로 여기 안 걸린다 — 위키 내부 문서 이동은 같은 탭 유지.
  box.addEventListener('click', (e: any) => {
    const a = e.target && e.target.closest && e.target.closest('a.md-link[href^="#/k/"]');
    if (!a || !box.contains(a)) return;
    e.preventDefault(); e.stopPropagation();
    window.open(a.getAttribute('href'), '_blank', 'noopener');
  }, true);
  // 에디터 밖으로 포커스가 완전히 나가면 자동저장 flush(슬래시/툴바 팝업 클릭은 box 밖이지만 저장은 멱등이라 무해).
  box.addEventListener('focusout', () => setTimeout(() => { if (!box.contains(document.activeElement)) flush(); }, 200));
  return { el: box, flush, isDirty: () => editor.isDirty(), destroy: () => editor.destroy() };
}

function projectBodySection(id, p, reload) {
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const bodyWrap = el('div', { class: 'proj-body-sec' });
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '본문' })));
  card.append(bodyWrap);
  // #730 노션형 블록 에디터로 통일 — 슬래시(/) 명령·블록 드래그·선택 툴바·이미지 붙여넣기/드롭. 항시 편집(자동저장).
  const bodyEd = mountBodyEditor({
    initial: p.description || '',
    placeholder: '본문을 입력하세요.  ‘/’ 로 블록 삽입 · 이미지 붙여넣기/드롭 · 드래그로 정렬',
    uploadFile: (file) => uploadBodyFile(id, '_attachments/project-' + id, file),
    save: async (md) => { await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ description: md || null }) }); p.description = md; },
  });
  bodyWrap.append(bodyEd.el);
  projectBodyAttachments(bodyWrap, p);   // 이관 첨부 그리드(있으면)
  return card;
}

// #541 이관 첨부(task_attachment — ClickUp attachments[]/인라인 이미지) 그리드(읽기전용) — 본문 에디터 아래.
//  원본 URL 은 서명 URL 이라 만료 가능 → 이미지 로드 실패 시 파일 칩으로 폴백(레이아웃 보존).
function projectBodyAttachments(bodyWrap, p) {
    const atts = Array.isArray(p.attachments) ? p.attachments : [];
    if (atts.length) {
      const grid = el('div', { class: 'proj-att-grid' });
      for (const a of atts) {
        const url = a && a.url && /^https?:\/\//i.test(String(a.url)) ? String(a.url) : null;
        const isImg = /^image\//.test(String(a.mimetype || '')) || /(png|jpe?g|gif|webp|svg)$/i.test(String(a.extension || ''));
        const chip = el(url ? 'a' : 'span', { class: 'proj-att-chip', ...(url ? { href: url, target: '_blank', rel: 'noopener noreferrer' } : {}) });
        if (isImg && url) {
          const img = el('img', { class: 'proj-att-thumb', src: String(a.thumbnail || url), alt: a.title || '첨부 이미지', loading: 'lazy', referrerpolicy: 'no-referrer' });
          img.onerror = () => { img.replaceWith(el('span', { class: 'proj-att-fallback', text: '🖼' })); };
          chip.append(img);
        } else {
          chip.append(el('span', { class: 'proj-att-fallback', text: '📎' }));
        }
        chip.append(el('span', { class: 'proj-att-cap', text: a.title || String(a.url || '첨부').split('/').pop() }));
        grid.append(chip);
      }
      bodyWrap.append(el('div', { class: 'proj-att-sec' },
        el('div', { class: 'proj-att-head', text: '첨부 (' + atts.length + ')' }), grid));
    }
}

// ── '연결된 지식' 섹션 — 본문 바로 아래. 「필요 지식 → 이 프로젝트 → 산출 지식」 구조를 한 화면에(#245·#317). ──
//  '막막함' 제거(#317): ① 필요 빈칸은 죽은 끝 대신 추천을 인라인으로 먼저 보여줌(openKnowledgePicker = 추천-우선 단일 픽커)
//  ② '왜 다나' 배너(→ #/learn) ③ 액션은 섹션 헤더 우상단 단일 버튼 [＋ 지식 연결](관계는 픽커 라디오, 직접 작성도 픽커 안) ④ 산출 빈칸은 '아직 비어도 정상' 안내.
//  변경 후 v6 상세 GET 으로 재조회해 재페인트.
// (후속/선행 프로젝트 박스 projectEdgesSection 제거 — 상단 프로퍼티 pjvProjMetaPanel 의 선행/후속 필드로 이관, #359.)

function projectKnowledgeSection(id, p, reload) {
  const knName = (k) => k.name || k.knowledge_name;
  let cur = { required: (p.knowledge || {}).required || [], produced: (p.knowledge || {}).produced || [] };

  // 지식 링크는 새 탭(#804). 프로젝트 상세는 모달로도 뜨는데(pjvOpenProjectModal — 대시보드·보드 행 클릭),
  //  모달은 body 에 얹히고 라우터엔 모달 정리가 없어 같은 탭 해시 이동(#/k/…)이 **모달 뒤에서** 라우트만 바꾼다
  //  → 사용자 눈엔 '클릭해도 아무 일 없는' 죽은 클릭. 새 탭이면 프로젝트를 띄워 둔 채 지식을 읽는다(작업맥락 보존).
  //  지식 픽커(ps-kn-pick-main)가 이미 같은 규약이라 페이지에서도 동일하게 맞춘다.
  const KN_NEW_TAB = { target: '_blank', rel: 'noopener', title: '새 탭에서 지식 열기' };

  let remeasure: any = null;  // 길이 초과 시 접기 컨트롤 재측정(접힘 박스 생성 후 할당). 리스트 변경마다 호출.

  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  // 섹션 액션 — 칼럼별 버튼 대신 우상단 단일 버튼 하나(#317). 관계(필요/산출)는 픽커 라디오에서 고른다.
  const knAddBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 지식 연결', 'data-tour': 'pd-link-kn',   // #853 '프로젝트 체험' 투어 앵커
    title: '관련 지식을 추천받고 검색해 연결 — 필요/산출은 픽커에서 선택(없으면 직접 작성)',
    onclick: () => openKnowledgePicker(id, 'required', cur.required.map(knName), refresh) });
  card.append(el('div', { class: 'card-head' },
    el('div', { class: 'pjk-head-titles', style: 'display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; min-width:0;' },
      el('h3', { text: '연결된 지식' }),
      el('span', { class: 'pjk-head-hint' },
        '필요 지식을 연결하면 AI가 그 문서를 미리 읽은 상태로 시작해요 — ',
        // 가이드도 새 탭(#804) — 지식 링크와 같은 이유(모달 뒤 라우트 변경 = 죽은 클릭) + 읽던 프로젝트를 잃지 않는다.
        //  목적지는 문서 사이트의 WIKI 페이지(#780) — 필요지식 카드가 그리로 이사했다.
        el('a', { href: '#/learn/docs/wiki?focus=required', target: '_blank', rel: 'noopener', title: '새 탭에서 사용 가이드 열기',
          style: 'color:var(--blue); text-decoration:none; white-space:nowrap;', text: '자세히' }))),
    knAddBtn));

  const reqList = el('div', { class: 'pjk-list' });
  const prodList = el('div', { class: 'pjk-list' });
  const reqCount = el('span', { class: 'pjk-count' });
  const prodCount = el('span', { class: 'pjk-count' });

  // '왜 필요지식을 다나'는 닫는 배너 대신 섹션 제목 옆 부제로 이동(#317) — 위 card-head 의 pjk-head-hint + [자세히](→ learn 해당 섹션).

  // 필요지식 빈칸 — 죽은 끝('아직 없습니다') 대신 추천을 인라인으로 먼저(#317). 추천은 한 번만 불러 캐시(재페인트마다 호출 방지).
  let recsCache: any = null;
  async function fetchRecs() {
    if (recsCache) return recsCache;
    try { recsCache = await api('/api/ui/v6/projects/' + id + '/recommend-knowledge?limit=3').then((d) => (d && d.entries) || []); }
    catch (_) { recsCache = []; }
    return recsCache;
  }
  function recRow(m) {
    const name = knName(m);
    const pct = Math.round((Number(m.similarity) || 0) * 100);
    const addBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '연결' });
    addBtn.onclick = async () => { addBtn.disabled = true;
      try { await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation: 'required' }) });
        toast('연결했습니다'); refresh(); }
      catch (e) { addBtn.disabled = false; toast('연결 실패 — ' + e.message, true); } };
    return el('div', { class: 'pjk-rec-row' },
      el('a', { class: 'pjk-rec-title', href: '#/k/' + encodeURIComponent(name), ...KN_NEW_TAB, text: m.title || name }),
      m.shares_category ? el('span', { class: 'kn-chip', title: '프로젝트와 같은 분류', text: '📁' }) : null,
      pct > 0 ? el('span', { class: 'admin-hint pjk-rec-pct', title: '의미 유사도', text: pct + '%' }) : null,
      addBtn);
  }
  // 필요지식 칼럼 = 연결된 항목 + 아직 연결 안 된 추천을 **함께** 그린다(#138).
  //  하나 연결해도 나머지 추천은 그대로 남아 계속 추가 연결 가능(예전엔 첫 연결 순간 추천 목록이 통째로 사라짐).
  //  recsCache 는 최초 1회(연결 전) 목록이라, 이미 연결된 건 이름으로 걸러 낸다.
  let reqPaintSeq = 0;
  async function paintRequired(boxEl) {
    const seq = ++reqPaintSeq;
    const knRows = () => cur.required.map((k) => knRow(k, 'required'));
    if (!recsCache) {  // 추천 로딩 전 — 연결된 건 바로 보이고, 추천 자리엔 로딩 문구.
      boxEl.replaceChildren(...knRows(),
        el('div', { class: 'pjk-empty', text: cur.required.length ? '관련 지식 더 찾는 중…' : '관련 지식을 찾는 중…' }));
    }
    const recs = await fetchRecs();
    if (seq !== reqPaintSeq) return;  // 그 사이 다시 그려졌으면 폐기(레이스).
    const connected = new Set(cur.required.map(knName));
    const fresh = recs.filter((m) => !connected.has(knName(m)));  // 이미 연결된 추천은 제외.
    const children = knRows();
    if (fresh.length) {
      children.push(el('div', { class: 'pjk-rec' },
        el('div', { class: 'pjk-rec-head', text: cur.required.length ? '이런 지식도 연결해 보세요' : '이런 지식이 필요해 보여요' }),
        ...fresh.map(recRow)));
    } else if (!cur.required.length) {
      children.push(el('div', { class: 'pjk-empty' },
        '아직 연결된 필요지식이 없어요. ', el('b', { text: '[＋ 지식 연결]' }), ' 로 시작하세요 — 찾는 게 없으면 거기서 직접 작성도 됩니다.'));
    }
    boxEl.replaceChildren(...children);
    if (remeasure) requestAnimationFrame(remeasure);  // 내용이 바뀌었으니 접기 재측정.
  }

  // 지식 한 줄 — 제목(상세 링크) + 메타칩 + 연결 해제(✕). relation 별로 unlink 한다.
  function knRow(k, relation) {
    const name = knName(k);
    const r = el('div', { class: 'pjk-row' },
      el('a', { class: 'pjk-row-title', href: '#/k/' + encodeURIComponent(name), ...KN_NEW_TAB, text: k.title || name }),
      el('div', { class: 'pjk-row-meta' },
        // 배지는 '예외만' 표시 — 기본값(검색=recalled·저작=authored·유효=active)은 매 행 똑같이 반복돼
        // 차별성 0 인 노이즈라 숨긴다. 벗어난 것만(주입·미러·폐기 등) 배지로 떠 제목 폭을 최대로 확보(#59 가독성).
        // 간격은 CSS gap — 예전 리터럴 공백(' '·'  ') span 래핑은 간격이 들쭉날쭉해 제거.
        (k.injection && k.injection !== 'recalled') ? knInjectChip(k.injection) : null,
        (k.provenance && k.provenance !== 'authored') ? knProvChip(k.provenance) : null,
        (k.lifecycle && k.lifecycle !== 'active') ? lifecycleDot(k.lifecycle) : null));
    const x = el('button', { class: 'pjk-row-x', type: 'button', title: '연결 해제', text: '✕' });
    x.onclick = async (ev) => { ev.preventDefault();
      try { await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation, unlink: true }) }); toast('연결을 해제했습니다'); refresh(); }
      catch (e) { toast('해제 실패 — ' + e.message, true); } };
    r.append(x);
    return r;
  }
  function paint(boxEl, list, relation, emptyText) {
    if (!list.length) { boxEl.replaceChildren(el('div', { class: 'pjk-empty', text: emptyText })); return; }
    boxEl.replaceChildren(...list.map((k) => knRow(k, relation)));
  }
  function repaint() {
    reqCount.textContent = String(cur.required.length);
    prodCount.textContent = String(cur.produced.length);
    paintRequired(reqList);  // 연결된 항목 + 남은 추천을 함께(#138).
    paint(prodList, cur.produced, 'produced', '작업이 진행되면 여기에 쌓입니다 — 지금 비워둬도 괜찮아요.');
    if (remeasure) requestAnimationFrame(remeasure);  // 내용이 바뀌면 접기 필요 여부 재판정.
  }
  async function refresh() {
    try { const d = await api('/api/ui/v6/projects/' + id).then((r) => r && (r.project || r));
      cur = { required: (d.knowledge || {}).required || [], produced: (d.knowledge || {}).produced || [] }; } catch (_) { /* keep */ }
    repaint();
  }

  // (지식 연결 액션은 칼럼별이 아니라 섹션 헤더 우상단 단일 버튼 — 위 knAddBtn. #317)

  // 가운데 노드 — '이 프로젝트' 문구만(이름·상태 제거·박스 축소 #258). 좌우 화살표로 필요→프로젝트→산출 흐름을 표현.
  const node = el('div', { class: 'pjk-node' },
    el('div', { class: 'pjk-node-label', text: '이 프로젝트' }));

  const reqCol = el('div', { class: 'pjk-col pjk-col-req' },
    el('div', { class: 'pjk-col-head' }, el('span', { class: 'pjk-col-title', text: '필요 지식' }), reqCount),
    reqList);
  const prodCol = el('div', { class: 'pjk-col pjk-col-prod' },
    el('div', { class: 'pjk-col-head' }, el('span', { class: 'pjk-col-title', text: '산출 지식' }), prodCount),
    prodList);

  const flow = el('div', { class: 'pjk-flow' },
    reqCol,
    el('div', { class: 'pjk-arrow', 'aria-hidden': 'true', text: '→' }),
    node,
    el('div', { class: 'pjk-arrow', 'aria-hidden': 'true', text: '→' }),
    prodCol);

  // 길면(특정 높이 초과) 접기 — 본문 섹션과 동일한 펼침 알약(.proj-detail-body-expand). 짧으면 컨트롤 숨기고 펼쳐 둔다.
  const collapseBox = el('div', { class: 'pjk-collapse collapsed' }, flow);
  const exLbl = el('span', { class: 'lbl', text: '더 보기' });
  const exCaret = el('span', { class: 'caret', text: '⌄' });
  const exBtn = el('button', { class: 'proj-detail-body-expand', type: 'button' }, exLbl, exCaret);
  const exRow = el('div', { class: 'proj-detail-body-expand-row pjk-expand-row' }, exBtn);
  let userExpanded = false;  // 사용자가 펼쳤는지 기억 — 재측정 후에도 상태 보존.
  const applyExpanded = (expanded) => {
    collapseBox.classList.toggle('collapsed', !expanded);
    exCaret.textContent = expanded ? '⌃' : '⌄';
    exLbl.textContent = expanded ? '접기' : '더 보기';
  };
  exBtn.onclick = () => { userExpanded = collapseBox.classList.contains('collapsed'); applyExpanded(userExpanded); };
  // 캡 높이로 강제해 넘치는지 측정 → 짧으면 컨트롤 숨기고 펼침, 길면 컨트롤 노출(사용자 펼침 상태 유지).
  remeasure = () => {
    collapseBox.classList.add('collapsed');
    const tall = flow.scrollHeight > collapseBox.clientHeight + 2;
    if (!tall) { collapseBox.classList.remove('collapsed'); exRow.style.display = 'none'; return; }
    exRow.style.display = '';
    applyExpanded(userExpanded);
  };
  card.append(collapseBox, exRow);
  repaint();
  return card;
}

// (직접 작성은 모달이 아니라 새 작성 페이지(#/knowledge/new?project=&relation=)로 이관 — renderKnowledgeCreate 가 프로젝트 연결을 기본 채움.)

// ── 본문 에디터 서식 툴바 — 텍스트 선택 시 그 위로 떠서 선택 영역에 마크다운 서식 적용(클릭업식, 박스 없는 인라인 편집용). ──
//  렌더러가 지원하는 서식만 노출: 제목·굵게·기울임·코드·목록·인용·링크. 버튼은 mousedown preventDefault 로 textarea 포커스(=선택·편집모드)를 유지한다.
function buildFormatToolbar(ta) {
  const bar = el('div', { class: 'fmt-toolbar' });
  bar.hidden = true;
  let lastX = 0, lastY = 0;
  const fire = () => ta.dispatchEvent(new Event('input', { bubbles: true })); // 자동 높이 재계산
  const wrapSel = (mark) => {
    const s = ta.selectionStart, e = ta.selectionEnd; const sel = ta.value.slice(s, e);
    ta.setRangeText(mark + sel + mark, s, e, 'end');
    ta.selectionStart = s + mark.length; ta.selectionEnd = e + mark.length;
    ta.focus(); fire(); position();
  };
  const prefixLines = (prefix) => {
    const val = ta.value; const s = ta.selectionStart, e = ta.selectionEnd;
    const ls = val.lastIndexOf('\n', s - 1) + 1;
    let le = val.indexOf('\n', e); if (le === -1) le = val.length;
    const block = val.slice(ls, le).split('\n').map((l) => prefix + l).join('\n');
    ta.setRangeText(block, ls, le, 'end');
    ta.selectionStart = ls; ta.selectionEnd = ls + block.length;
    ta.focus(); fire(); position();
  };
  const insertLink = () => {
    const s = ta.selectionStart, e = ta.selectionEnd; const sel = ta.value.slice(s, e) || '링크';
    const url = window.prompt('링크 URL', 'https://'); if (url == null) return;
    ta.setRangeText('[' + sel + '](' + url + ')', s, e, 'end'); ta.focus(); fire(); position();
  };
  const ic = (...kids) => { const n = sv('svg', { class: 'fmt-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); for (const k of kids) n.append(k); return n; };
  const mkBtn = (inner, title, fn, cls?) => {
    const b = el('button', { class: 'fmt-btn' + (cls ? ' ' + cls : ''), type: 'button', title });
    if (typeof inner === 'string') b.textContent = inner; else b.append(inner);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // textarea 포커스 유지(선택·편집모드 유지)
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    return b;
  };
  bar.append(
    mkBtn('H', '제목', () => prefixLines('## '), 'fmt-h'),
    mkBtn('B', '굵게', () => wrapSel('**'), 'fmt-b'),
    mkBtn('I', '기울임', () => wrapSel('*'), 'fmt-i'),
    mkBtn(ic(sv('polyline', { points: '8 8 4 12 8 16' }), sv('polyline', { points: '16 8 20 12 16 16' })), '코드', () => wrapSel('`')),
    mkBtn(ic(sv('line', { x1: 9, y1: 6, x2: 20, y2: 6 }), sv('line', { x1: 9, y1: 12, x2: 20, y2: 12 }), sv('line', { x1: 9, y1: 18, x2: 20, y2: 18 }), sv('circle', { cx: 4.5, cy: 6, r: 1.1 }), sv('circle', { cx: 4.5, cy: 12, r: 1.1 }), sv('circle', { cx: 4.5, cy: 18, r: 1.1 })), '목록', () => prefixLines('- ')),
    mkBtn(ic(sv('path', { d: 'M6 7h8M6 12h12M6 17h8' }), sv('path', { d: 'M3 6.5v11' })), '인용', () => prefixLines('> ')),
    mkBtn(ic(sv('path', { d: 'M10 13a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.5 1.5' }), sv('path', { d: 'M14 11a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5' })), '링크', insertLink),
  );
  document.body.append(bar);
  function position() {
    if (ta.selectionStart === ta.selectionEnd) { bar.hidden = true; return; }
    bar.hidden = false;
    const bw = bar.offsetWidth || 250, bh = bar.offsetHeight || 38;
    const rect = ta.getBoundingClientRect();
    let x = (lastX || (rect.left + rect.width / 2)) - bw / 2;
    let y = (lastY || rect.top) - bh - 10;
    x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
    if (y < 8) y = (lastY || rect.top) + 18; // 위 공간 없으면 선택 아래로
    bar.style.left = x + 'px'; bar.style.top = y + 'px';
  }
  const onMouseUp = (e) => { lastX = e.clientX; lastY = e.clientY; setTimeout(position, 0); };
  const onKeyUp = (e) => { if (e.shiftKey || (e.key && e.key.indexOf('Arrow') === 0)) setTimeout(position, 0); };
  const onScroll = () => { if (!bar.hidden) position(); };
  ta.addEventListener('mouseup', onMouseUp);
  ta.addEventListener('keyup', onKeyUp);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  return { destroy: () => { bar.remove(); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); } };
}

// ── 위지위그 본문 직렬화 — contentEditable DOM → 마크다운(renderMarkdown 지원 서브셋의 역). 알 수 없는 요소는 자식만 재귀(텍스트 보존). ──
function mdFromDom(root) {
  // 인라인(텍스트 + 굵게/기울임/코드/링크/줄바꿈) → 마크다운 문자열.
  const inlineMd = (node) => {
    let out = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { out += n.textContent; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (tag === 'br') { out += '\n'; return; }
      if (tag === 'code') { out += '`' + n.textContent + '`'; return; }
      if (tag === 'a') { const href = n.getAttribute('href') || ''; const lbl = inlineMd(n) || n.textContent; out += href ? '[' + lbl + '](' + href + ')' : lbl; return; }
      if (tag === 'img') { const src = n.getAttribute('src') || ''; if (src) out += '![' + (n.getAttribute('alt') || '') + '](' + src + ')'; return; } // 이미지 왕복(#541)
      if (tag === 'del' || tag === 's' || tag === 'strike') { out += '~~' + inlineMd(n) + '~~'; return; } // 취소선 왕복(#541)
      const st = (n.getAttribute && n.getAttribute('style')) || '';
      const bold = tag === 'strong' || tag === 'b' || /font-weight\s*:\s*(bold|[6-9]00)/.test(st);
      const ital = tag === 'em' || tag === 'i' || /font-style\s*:\s*italic/.test(st);
      let inner = inlineMd(n);
      if (ital) inner = '*' + inner + '*';
      if (bold) inner = '**' + inner + '**';
      out += inner;
    });
    return out;
  };
  const blocks: string[] = [];
  const walk = (node, quote) => {
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, ' ').trim(); if (t) blocks.push((quote ? '> ' : '') + t); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      const q = quote ? '> ' : '';
      if (/^h[1-6]$/.test(tag)) { const t = inlineMd(n).trim(); if (t) blocks.push(q + '#'.repeat(Number(tag[1])) + ' ' + t); return; }
      if (tag === 'p' || tag === 'div') {
        const t = inlineMd(n).replace(/\n+$/, '').trim();
        if (t) blocks.push(quote ? t.split('\n').map((l) => '> ' + l).join('\n') : t);
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        // 중첩 리스트 직렬화(#541 — ClickUp 본문 다단 불릿 무손실 왕복): li 안의 하위 ul/ol 을 2칸 들여쓰기로 재귀.
        const items: string[] = [];
        const serializeList = (listEl: any, listTag: string, depth: number) => {
          let idx = 1;
          listEl.childNodes.forEach((li: any) => {
            if (li.nodeType !== 1 || li.tagName.toLowerCase() !== 'li') return;
            const mk = listTag === 'ol' ? (idx++ + '. ') : '- ';
            // li 의 인라인 내용(하위 리스트 제외) — 하위 ul/ol 은 별도 재귀.
            const clone = li.cloneNode(true);
            clone.querySelectorAll && clone.querySelectorAll('ul, ol').forEach((s: any) => s.remove());
            // 체크박스(input) → '[ ] '/'[x] ' 접두 복원(하위 리스트 제거 후 남은 첫 input = 이 항목 것).
            let prefix = '';
            const cb = clone.querySelector && clone.querySelector('input[type=checkbox]');
            if (cb) { prefix = cb.checked ? '[x] ' : '[ ] '; cb.remove(); }
            const t = inlineMd(clone).trim();
            items.push(q + '  '.repeat(depth) + mk + prefix + t);
            li.querySelectorAll && li.querySelectorAll(':scope > ul, :scope > ol').forEach((s: any) => serializeList(s, s.tagName.toLowerCase(), depth + 1));
          });
        };
        serializeList(n, tag, 0);
        if (items.length) blocks.push(items.join('\n'));
        return;
      }
      if (tag === 'blockquote') { walk(n, true); return; }
      if (tag === 'pre') { blocks.push('```\n' + n.textContent.replace(/\n$/, '') + '\n```'); return; }
      if (tag === 'hr') { blocks.push('---'); return; }
      walk(n, quote); // 알 수 없는 래퍼 → 자식 블록 재귀
    });
  };
  walk(root, false);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── 위지위그 서식 바 — contentEditable 용(execCommand). 선택 시 떠서 그 자리에서 굵게/기울임/제목/목록/인용/코드/링크 즉시 적용. ──
function buildWysiwygToolbar(ce) {
  const bar = el('div', { class: 'fmt-toolbar' });
  bar.hidden = true;
  try { document.execCommand('styleWithCSS', false, 'false'); } catch (_) { /* 시맨틱 태그(<b>/<i>) 우선 */ }
  const exec = (cmd, val?) => { ce.focus(); try { document.execCommand(cmd, false, val); } catch (_) { /* noop */ } setTimeout(position, 0); };
  const wrapCode = () => {
    const sel = window.getSelection(); if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0); const txt = range.toString(); if (!txt) return;
    const code = el('code', { class: 'md-code', text: txt });
    range.deleteContents(); range.insertNode(code);
    const r = document.createRange(); r.selectNodeContents(code); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
    ce.focus(); setTimeout(position, 0);
  };
  const insertLink = () => {
    const sel = window.getSelection(); const txt = sel ? sel.toString() : '';
    const url = window.prompt('링크 URL', 'https://'); if (url == null) return;
    ce.focus();
    if (txt) { try { document.execCommand('createLink', false, url); } catch (_) { /* noop */ } }
    else { try { document.execCommand('insertHTML', false, '<a href="' + url.replace(/"/g, '%22') + '">' + url + '</a>'); } catch (_) { /* noop */ } }
    setTimeout(position, 0);
  };
  const ic = (...kids) => { const n = sv('svg', { class: 'fmt-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); for (const k of kids) n.append(k); return n; };
  const mkBtn = (inner, title, fn, cls?) => {
    const b = el('button', { class: 'fmt-btn' + (cls ? ' ' + cls : ''), type: 'button', title });
    if (typeof inner === 'string') b.textContent = inner; else b.append(inner);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 에디터 포커스·선택 유지
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    return b;
  };
  bar.append(
    mkBtn('H', '제목', () => exec('formatBlock', 'h2'), 'fmt-h'),
    mkBtn('B', '굵게', () => exec('bold'), 'fmt-b'),
    mkBtn('I', '기울임', () => exec('italic'), 'fmt-i'),
    mkBtn(ic(sv('polyline', { points: '8 8 4 12 8 16' }), sv('polyline', { points: '16 8 20 12 16 16' })), '코드', wrapCode),
    mkBtn(ic(sv('line', { x1: 9, y1: 6, x2: 20, y2: 6 }), sv('line', { x1: 9, y1: 12, x2: 20, y2: 12 }), sv('line', { x1: 9, y1: 18, x2: 20, y2: 18 }), sv('circle', { cx: 4.5, cy: 6, r: 1.1 }), sv('circle', { cx: 4.5, cy: 12, r: 1.1 }), sv('circle', { cx: 4.5, cy: 18, r: 1.1 })), '목록', () => exec('insertUnorderedList')),
    mkBtn(ic(sv('path', { d: 'M6 7h8M6 12h12M6 17h8' }), sv('path', { d: 'M3 6.5v11' })), '인용', () => exec('formatBlock', 'blockquote')),
    mkBtn(ic(sv('path', { d: 'M10 13a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.5 1.5' }), sv('path', { d: 'M14 11a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5' })), '링크', insertLink),
  );
  document.body.append(bar);
  function position() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !ce.contains(sel.anchorNode)) { bar.hidden = true; return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) { bar.hidden = true; return; }
    bar.hidden = false;
    const bw = bar.offsetWidth || 250, bh = bar.offsetHeight || 38;
    let x = rect.left + rect.width / 2 - bw / 2;
    let y = rect.top - bh - 10;
    x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
    if (y < 8) y = rect.bottom + 10;
    bar.style.left = x + 'px'; bar.style.top = y + 'px';
  }
  const onSel = () => setTimeout(position, 0);
  document.addEventListener('selectionchange', onSel);
  ce.addEventListener('mouseup', onSel);
  ce.addEventListener('keyup', onSel);
  const onScroll = () => { if (!bar.hidden) position(); };
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  return { destroy: () => { bar.remove(); document.removeEventListener('selectionchange', onSel); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); } };
}

// ── 코멘트 섹션 — 본문↔태스크 사이, 같은 급(.card). 얇은 가로 스트립으로 최신 코멘트(아바타+이름+요약)를 카드로 쭉.
//  세로 공간 최소(헤더 + 한 줄 카드). 섹션 어디든 클릭 → 오른쪽 드로어(openProjectComments)로 전체 보기·작성. ──
function projectCommentsSection(id, members) {
  const nameOf = (uid) => { const m = (members || []).find((x) => x.member_id === uid); return (m && m.display_name) || uid || '?'; };
  const card = el('div', { class: 'card pjv-cmt-sec', style: 'margin-bottom:18px', role: 'button', tabindex: '0', title: '코멘트 열기' });
  const countEl = el('span', { class: 'pjv-cmt-sec-count' });
  const unreadBadge = el('span', { class: 'pjv-cmt-unread', hidden: true });
  const strip = el('div', { class: 'pjv-cmt-strip' }, el('div', { class: 'pjv-cmt-loading', text: '불러오는 중…' }));
  card.append(
    el('div', { class: 'card-head pjv-cmt-sec-head' },
      el('h3', {}, el('span', { text: '코멘트' }), countEl, unreadBadge),
      el('span', { class: 'pjv-cmt-sec-hint', text: '클릭해 작성 · 모두 보기 →' })),
    strip);
  // 안 읽은 코멘트 강조 — 기기별 마지막 읽음 id(localStorage)보다 새 코멘트(내가 쓴 것 제외)를 안읽음으로. 클릭(드로어 열기)=읽음 처리.
  const cmtMeId = (state.me && (state.me.userId || state.me.email)) || '';
  const cmtReadKey = 'pjv_cmt_read_' + id;
  const cmtLastRead = () => Number(localStorage.getItem(cmtReadKey)) || 0;
  const cmtMarkRead = (list) => { const mx = Math.max(0, ...list.map((c) => Number(c.id) || 0)); if (mx) localStorage.setItem(cmtReadKey, String(mx)); };
  let cmtLoaded: any[] = [];
  const open = () => {
    cmtMarkRead(cmtLoaded);
    unreadBadge.hidden = true; card.classList.remove('pjv-cmt-has-unread');
    strip.querySelectorAll('.pjv-cmt-mini-unread').forEach((n) => n.classList.remove('pjv-cmt-mini-unread'));
    openProjectComments(id, members);
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  (async () => {
    let comments: any[] = [];
    try { const d = await api('/api/ui/v6/projects/' + id + '/comments'); comments = ((d && d.feed) || []).filter((f) => f && f.kind === 'comment'); }
    catch (_) { strip.replaceChildren(el('div', { class: 'pjv-cmt-loading', text: '코멘트를 불러오지 못했어요' })); return; }
    cmtLoaded = comments;
    countEl.textContent = comments.length ? ' ' + comments.length : '';
    const lr = cmtLastRead();
    const isUnread = (c) => (Number(c.id) || 0) > lr && c.actor !== cmtMeId;
    const unreadN = comments.filter(isUnread).length;
    if (unreadN) { unreadBadge.hidden = false; unreadBadge.textContent = unreadN + '개 안 읽음'; card.classList.add('pjv-cmt-has-unread'); }
    strip.replaceChildren();
    if (!comments.length) {
      strip.append(el('div', { class: 'pjv-cmt-empty-card' }, el('span', { class: 'pjv-cmt-empty-ic', text: '＋' }), el('span', { text: '첫 코멘트를 남겨보세요' })));
      return;
    }
    const recent = comments.slice().reverse().slice(0, 12); // 피드는 시간 오름차순 → 최신 먼저
    for (const c of recent) {
      const who = c.display_name || nameOf(c.actor);
      const preview = (c.body || '').replace(/\s+/g, ' ').trim();
      strip.append(el('div', { class: 'pjv-cmt-mini' + (isUnread(c) ? ' pjv-cmt-mini-unread' : '') },
        el('div', { class: 'pjv-cmt-mini-top' },
          personFace(c.actor || who, 'pjv-cmt-mini-ava', who),
          el('span', { class: 'pjv-cmt-mini-name', text: who }),
          el('span', { class: 'pjv-cmt-mini-time', text: c.ts ? relTime(c.ts) : '' })),
        el('div', { class: 'pjv-cmt-mini-text', text: preview })));
    }
  })();
  return card;
}

// ── 코멘트 드로어 — 코멘트 섹션 클릭 → 우측에서 슬라이드되는 오버레이(상시 점유 X). 프로젝트 전체 코멘트, 모든 팀원 작성. ──
//  저장: task_comment(task_id=프로젝트 id) — v6 에서 태스크=프로젝트행이라 /tasks/:id/comments·/detail 을 프로젝트 id 로 그대로 재사용.
function openProjectComments(id, members) {
  const nameOf = (uid) => { const m = (members || []).find((x) => x.member_id === uid); return (m && m.display_name) || uid || '?'; };
  const panel = el('aside', { class: 'cmt-drawer', role: 'dialog', 'aria-label': '코멘트' });
  const back = el('div', { class: 'cmt-backdrop' }, panel);
  let closed = false;
  const close = () => { if (closed) return; closed = true; back.classList.remove('open'); document.removeEventListener('keydown', onEsc); setTimeout(() => back.remove(), 220); };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onEsc);

  let feedData: any[] = [];
  let newestFirst = false;  // 기본 오래된→최신(최신이 아래, 작성칸 옆) — 이미지와 동일
  let query = '';
  let threadParent: any = null;  // null=메인 피드, 숫자=해당 최상위 댓글의 스레드 보기
  const repliesOf = (pid) => feedData.filter((f) => f && f.kind === 'comment' && f.reply_to != null && Number(f.reply_to) === Number(pid));

  // 헤더 SVG 아이콘 헬퍼
  const hico = (...kids) => sv('svg', { viewBox: '0 0 24 24', width: '17', height: '17', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...kids);

  // 작성칸(하단) — 크고 편한 입력 + 파란 전송(이미지 참고).
  const ta = el('textarea', { class: 'cmt-input', placeholder: '댓글을 입력하세요…' });
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight, 56), 220) + 'px'; };
  ta.addEventListener('input', grow);
  const sendBtn = el('button', { class: 'cmt-send pjv-tm-send', type: 'button', title: '보내기 (⌘/Ctrl+Enter)' },
    hico(sv('path', { d: 'M22 2L11 13' }), sv('path', { d: 'M22 2l-7 20-4-9-9-4 20-7z' })));
  // 커서 위치 삽입(멘션·이모지·첨부·체크리스트). 태스크 모달 작성기 툴바와 동일 동작.
  const insertAtCursor = (text) => {
    const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const e = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    const pos = s + text.length; ta.focus(); try { ta.setSelectionRange(pos, pos); } catch (_) { /* noop */ } grow();
  };
  // 태스크 팝업 Activity 작성기 툴바 그대로 재사용 — ＋·Comment▾·📎·@·😊·✓·🎥·🎤·⋯ · ➤. 첨부는 이 프로젝트 공유 폴더.
  const composer = el('div', { class: 'cmt-composer' }, ta,
    pjvtmComposerToolbar({ insertAtCursor, members, sendBtn, d: { project: { id } } }));

  const feedBox = el('div', { class: 'cmt-feed' }, el('div', { class: 'cmt-empty', text: '불러오는 중…' }));
  const reactTo = async (c, emoji) => {
    try { const d = await api('/api/ui/v6/comments/' + c.id + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) }); c.reactions = (d && d.reactions) || []; renderFeed(); }
    catch (e) { toast('반응 실패 — ' + e.message, true); }
  };
  // 댓글 카드 1개 — 최상위/답글 공용. isReply=true 면 답글 스타일(들여쓰기).
  function commentCard(c, isReply) {
    const who = c.display_name || nameOf(c.actor);
    // 👍 좋아요(아웃라인 아이콘 + 개수) — 내가 눌렀으면 .on. 그 외 이모지 반응은 칩으로.
    const like = (c.reactions || []).filter((r) => r.emoji === '👍')[0];
    const likeBtn = el('button', { class: 'cmt-foot-btn cmt-like' + (like && like.mine ? ' on' : ''), type: 'button', title: '좋아요' },
      sv('svg', { viewBox: '0 0 24 24', width: '15', height: '15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
        sv('path', { d: 'M7 10v11' }), sv('path', { d: 'M7 10l4-7a2 2 0 0 1 2.6 2.5L12.5 9H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 21H7' })));
    if (like) likeBtn.append(el('span', { class: 'cmt-like-n', text: String(like.count) }));
    likeBtn.onclick = () => reactTo(c, '👍');
    const reactRow = el('span', { class: 'cmt-react' }, likeBtn,
      ...(c.reactions || []).filter((r) => r.emoji !== '👍').map((r) => {
        const ch = el('button', { class: 'cmt-react-chip' + (r.mine ? ' mine' : ''), type: 'button', text: r.emoji + ' ' + r.count });
        ch.onclick = () => reactTo(c, r.emoji); return ch;
      }));
    const replyBtn = el('button', { class: 'cmt-foot-btn cmt-reply', type: 'button', text: '답글' });
    replyBtn.onclick = () => {
      if (threadParent != null) { ta.value = (ta.value ? ta.value.replace(/\s*$/, ' ') : '') + '@' + who + ' '; ta.focus(); grow(); }
      else openThread(c.id);  // 메인 피드 → 스레드 열기
    };
    const bodyKids: any[] = [
      el('div', { class: 'cmt-meta' }, el('span', { class: 'cmt-name', text: who }), el('span', { class: 'cmt-time', text: c.ts ? '· ' + relTime(c.ts) : '' })),
      el('div', { class: 'cmt-text md-rendered' }, renderMarkdown(c.body || '')),
      el('div', { class: 'cmt-foot' }, reactRow, replyBtn),
    ];
    // 메인 피드의 최상위 카드에만 'N개의 답글' 칩 — 클릭 시 스레드 보기. (스레드 안에서는 표시 안 함)
    if (!isReply && threadParent == null) {
      const reps = repliesOf(c.id);
      if (reps.length) {
        const seen: any = {}; const avas: any[] = [];
        for (const r of reps) { const k = r.actor || r.display_name; if (seen[k] || avas.length >= 3) continue; seen[k] = 1;
          const rw = r.display_name || nameOf(r.actor);
          avas.push(personFace(r.actor || rw, 'cmt-thread-pill-ava', rw)); }
        const last = reps[reps.length - 1];
        const pill = el('button', { class: 'cmt-thread-pill', type: 'button' },
          el('span', { class: 'cmt-thread-pill-avas' }, ...avas),
          el('span', { class: 'cmt-thread-pill-n', text: reps.length + '개의 답글' }),
          el('span', { class: 'cmt-thread-pill-time', text: last && last.ts ? '· 마지막 ' + relTime(last.ts) : '' }));
        pill.onclick = () => openThread(c.id);
        bodyKids.splice(bodyKids.length - 1, 0, pill); // 푸터(👍/답글) '위'에 답글 칩을 둔다(맨 아래로 빠져 어색하던 것 수정).
      }
    }
    // 카드 우상단 호버 액션(클릭업식) — 반응(이모지)·링크 복사·답글. (수정/삭제는 백엔드 엔드포인트가 없어 제외.)
    const act = (title, icon, fn) => { const b = el('button', { class: 'cmt-act', type: 'button', title }, icon); b.onclick = (e) => { e.stopPropagation(); fn(b); }; return b; };
    const emojiIco = hico(sv('circle', { cx: 12, cy: 12, r: 8.5 }), sv('path', { d: 'M8.5 14a4 4 0 0 0 7 0' }), sv('circle', { cx: 9, cy: 10, r: .9, fill: 'currentColor', stroke: 'none' }), sv('circle', { cx: 15, cy: 10, r: .9, fill: 'currentColor', stroke: 'none' }));
    const linkIco = hico(sv('path', { d: 'M10 13a4.5 4.5 0 0 0 6.4 0l2-2a4.5 4.5 0 1 0-6.4-6.4l-1.1 1.1' }), sv('path', { d: 'M14 11a4.5 4.5 0 0 0-6.4 0l-2 2a4.5 4.5 0 1 0 6.4 6.4l1.1-1.1' }));
    const replyIco = hico(sv('path', { d: 'M9 17l-5-5 5-5' }), sv('path', { d: 'M4 12h11a5 5 0 0 1 5 5v1' }));
    const REACT_EMOJIS = ['👍', '❤️', '😄', '🎉', '👀', '🙏'];
    const actions = el('div', { class: 'cmt-actions' },
      act('반응', emojiIco, (b) => { const pop = el('div', { class: 'cmt-emoji-pop' }); const closePop = pjvPopover(b, pop); REACT_EMOJIS.forEach((em) => { const eb = el('button', { class: 'cmt-emoji-opt', type: 'button', text: em }); eb.onclick = () => { closePop(); reactTo(c, em); }; pop.append(eb); }); }),
      act('링크 복사', linkIco, () => { const url = location.origin + location.pathname + location.search + '#cmt-' + c.id; try { if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('링크를 복사했어요')).catch(() => toast('복사 실패', true)); else toast('복사 실패', true); } catch (_) { toast('복사 실패', true); } }),
      act('답글', replyIco, () => replyBtn.onclick()));
    return el('div', { class: 'cmt-card' + (isReply ? ' cmt-reply-card' : '') },
      personFace(c.actor || who, 'cmt-ava', who),
      el('div', { class: 'cmt-body' }, ...bodyKids),
      actions);
  }
  function openThread(pid) { threadParent = pid; query = ''; if (searchBar) { searchBar.hidden = true; searchBtn.classList.remove('on'); searchIn.value = ''; } renderFeed(); setTimeout(() => ta.focus(), 0); }
  // 헤더/작성칸을 현재 모드(메인 피드 vs 스레드)에 맞춰 갱신.
  function renderHead() {
    const inThread = threadParent != null;
    if (backBtn) backBtn.hidden = !inThread;
    if (headTitle) headTitle.textContent = inThread ? '스레드' : '활동';
    if (sortBtn) sortBtn.hidden = inThread;
    if (searchBtn) searchBtn.hidden = inThread;
    ta.placeholder = inThread ? '답글을 입력하세요…' : '댓글을 입력하세요…';
  }
  function renderFeed() {
    renderHead();
    feedBox.replaceChildren();
    if (threadParent != null) {  // ── 스레드 보기: 부모 + 답글들 ──
      const parent = feedData.find((f) => f && f.kind === 'comment' && Number(f.id) === Number(threadParent));
      if (!parent) { threadParent = null; renderFeed(); return; }
      feedBox.append(commentCard(parent, false));
      const reps = repliesOf(threadParent).slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      feedBox.append(reps.length
        ? el('div', { class: 'cmt-thread-replies' }, ...reps.map((r) => commentCard(r, true)))
        : el('div', { class: 'cmt-thread-empty', text: '첫 답글을 남겨보세요.' }));
      setTimeout(() => { feedBox.scrollTop = feedBox.scrollHeight; }, 0);
      return;
    }
    // ── 메인 피드: 최상위 댓글만(reply_to 없음) ──
    let comments = feedData.filter((f) => f && f.kind === 'comment' && f.reply_to == null);
    if (query) comments = comments.filter((c) => (c.body || '').toLowerCase().includes(query) || (c.display_name || nameOf(c.actor) || '').toLowerCase().includes(query));
    if (newestFirst) comments = comments.slice().reverse();
    if (!comments.length) { feedBox.append(el('div', { class: 'cmt-empty', text: query ? '검색 결과가 없어요.' : '아직 코멘트가 없어요. 아래에서 첫 코멘트를 남겨보세요.' })); return; }
    for (const c of comments) feedBox.append(commentCard(c, false));
    if (!newestFirst && !query) setTimeout(() => { feedBox.scrollTop = feedBox.scrollHeight; }, 0); // 오래된순 → 최신이 아래, 바닥으로
  }
  const send = async () => {
    const text = ta.value.trim(); if (!text) return;
    sendBtn.disabled = true; ta.disabled = true;
    const payload: any = { text };
    if (threadParent != null) payload.parent_id = threadParent;  // 스레드 답글
    try {
      const d = await api('/api/ui/v6/tasks/' + id + '/comments', { method: 'POST', body: JSON.stringify(payload) });
      ta.value = ''; grow(); feedData = (d && d.feed) || []; renderFeed();
      if (threadParent == null && newestFirst) feedBox.scrollTop = 0;
    }
    catch (e) { toast('전송 실패 — ' + e.message, true); }
    sendBtn.disabled = false; ta.disabled = false; ta.focus();
  };
  sendBtn.onclick = send;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });

  // 헤더 — '코멘트' + 정렬·검색 토글(보이는 버튼은 기능까지) + 닫기.
  const sortBtn = el('button', { class: 'cmt-hbtn', type: 'button', title: '정렬: 오래된순' },
    hico(sv('path', { d: 'M7 4v15M7 4L4 8M7 4l3 4' }), sv('path', { d: 'M17 20V5M17 20l-3-4M17 20l3-4' })));
  sortBtn.onclick = () => { newestFirst = !newestFirst; sortBtn.classList.toggle('on', newestFirst); sortBtn.title = newestFirst ? '정렬: 최신순' : '정렬: 오래된순'; renderFeed(); };
  const searchIn = el('input', { type: 'text', class: 'cmt-search-in', placeholder: '코멘트 검색…' });
  searchIn.addEventListener('input', () => { query = searchIn.value.trim().toLowerCase(); renderFeed(); });
  const searchBar = el('div', { class: 'cmt-search', hidden: true }, searchIn);
  const searchBtn = el('button', { class: 'cmt-hbtn', type: 'button', title: '검색' }, hico(sv('circle', { cx: 11, cy: 11, r: 7 }), sv('path', { d: 'M21 21l-4.3-4.3' })));
  searchBtn.onclick = () => { const willOpen = searchBar.hidden; searchBar.hidden = !willOpen; searchBtn.classList.toggle('on', willOpen); if (willOpen) searchIn.focus(); else { query = ''; searchIn.value = ''; renderFeed(); } };
  // 스레드 보기 → 메인 피드로 돌아가는 뒤로 버튼(메인에서는 숨김).
  const backBtn = el('button', { class: 'cmt-hbtn cmt-back', type: 'button', title: '뒤로', hidden: true }, hico(sv('path', { d: 'M15 18l-6-6 6-6' })));
  backBtn.onclick = () => { threadParent = null; renderFeed(); };
  const headTitle = el('h3', { text: '활동' });
  const head = el('div', { class: 'cmt-head' }, backBtn, headTitle,
    el('div', { class: 'cmt-head-actions' }, sortBtn, searchBtn,
      el('button', { class: 'cmt-close', type: 'button', title: '닫기 (Esc)', text: '✕', onclick: close })));

  panel.append(head, searchBar, feedBox, composer);
  document.body.append(back);
  requestAnimationFrame(() => { back.classList.add('open'); grow(); });
  (async () => {
    try {
      const d = await api('/api/ui/v6/projects/' + id + '/comments'); feedData = (d && d.feed) || []; renderFeed();
      // 드로어를 열어 읽었으니 마지막 읽음 id 갱신(가장 최신 코멘트 id) — 섹션 안읽음 배지 해제.
      const cs = feedData.filter((f) => f && f.kind === 'comment'); const mx = Math.max(0, ...cs.map((c) => Number(c.id) || 0)); if (mx) localStorage.setItem('pjv_cmt_read_' + id, String(mx));
    }
    catch (e) { feedBox.replaceChildren(el('div', { class: 'cmt-empty', text: '불러오지 못했습니다 — ' + e.message })); }
  })();
  setTimeout(() => ta.focus(), 180);
}

// ── 프로젝트 세부 설정 팝업 — 팀원 · 분류 · 레포 · 규칙 · 삭제. 헤더 '⚙ 프로젝트 세부 설정'에서 연다. ──
//  (필요/산출 지식은 본문 아래 '지식 흐름' 섹션으로 이관 — #245.)
//  (참고 파일 블록 제거 — 본문 '공유 폴더' 브라우저와 중복이라 거기로 일원화 — #246.)
//  (상태 블록 제거 — 상세 메타 패널의 상태 필드(pjvProjStatusPill, 클릭해 3단계 변경) + 대시보드·목록·일괄바와
//   중복이고 모달 토글은 2단계뿐이라 더 약했다 — #246.)
//  (삭제·팀원 수정을 헤더에서 여기로 이관 — 헤더는 제목/상태칩/설정 버튼만.)
// 세부 설정 = 새 프로젝트 폼과 같은 결로 통일(#473 후속) — 카테고리·레포·팀원을 컴팩트 피커(요약 칩 + ▾) 한 줄씩으로.
//  블록마다 저장 버튼을 두지 않고, 상세 메타 패널처럼 '바꾸면 그 자리서 자동 저장'(피커 onChange, 로드시 첫 fire 는 건너뜀 + 디바운스).
//  이름·설명은 프로젝트 화면에서 바로 편집(제목 클릭·본문 섹션)하므로 여기서 뺀다. 규칙·삭제는 유지.
function openProjectSettings(id, p, reload, meId, base) {
  const B = base || '/api/ui/v6/projects/';
  const back = overlayBox('프로젝트 세부 설정', el('div', { class: 'proj-settings' }));
  const box = back.querySelector('.ov-box'); if (box) box.classList.add('ov-box-wide');

  // 컴팩트 필드 + 자동저장 — 사용자가 값을 바꿀 때만(로드 완료의 첫 onChange 는 저장 아님) 짧게 디바운스해 현재 선택 전체를 POST.
  let dirty = false;  // 무언가 저장됐으면 팝업 닫힐 때 상세를 한 번 재렌더(헤더·메타 반영).
  const autoField = (label, makePicker, opts, postFn, savedMsg) => {
    let ready = false; let timer: any = null; let field: any;
    const doSave = async () => {
      try { await postFn(); dirty = true; toast(savedMsg); }
      catch (e) { toast(savedMsg.replace('저장됨', '저장 실패') + ' — ' + e.message, true); }
    };
    field = compactPicker(label, makePicker, Object.assign({}, opts, { onChange: () => {
      if (!ready) { ready = true; return; }          // 로드 완료 시 첫 onChange = 현재값 반영일 뿐, 저장 아님
      if (timer) clearTimeout(timer);
      timer = setTimeout(doSave, 500);
    } }));
    return field;
  };

  // 카테고리(도메인)는 소속 리스트에서 상속(#541 후속) — 여기선 읽기전용 표시, 변경은 리스트 설정에서.
  const inheritedCat = ((p.categories) || [])[0];
  const catRow = el('div', { class: 'cf-row' },
    el('span', { class: 'cf-label', text: '카테고리' }),
    el('div', { class: 'cf-summary ps-cat-inherit' },
      inheritedCat
        ? el('span', { class: 'ps-cat-chip', text: (inheritedCat.name || inheritedCat.key) })
        : el('span', { class: 'ps-cat-none', text: '미분류' }),
      el('span', { class: 'ps-cat-inherit-hint', text: '소속 리스트에서 상속 — 리스트 설정에서 변경' })));
  const repoField = autoField('관련 레포',
    (onChange) => repoPicker((p.repos) || [], { onChange }),
    { emptyText: '선택 안 함' },
    () => api(B + id + '/repos', { method: 'POST', body: JSON.stringify({ repos: repoField.getSelected() }) }),
    '관련 레포 저장됨');
  const memberField = autoField('팀원',
    (onChange) => memberPicker(((p.members) || []).map((m) => m.member_id), { onChange }),
    { emptyText: '나만 참여', avatars: true, maxChips: 6 },
    () => api(B + id + '/members', { method: 'POST', body: JSON.stringify({ members: memberField.getSelected() }) }),
    '팀원 저장됨');

  // 어떤 경로로 닫히든(닫기·배경·Esc) dirty 면 상세 재렌더 — overlayBox 는 콜백이 없어 back 분리를 감지.
  if (typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(() => { if (!back.isConnected) { obs.disconnect(); if (dirty) reload(); } });
    obs.observe(document.body, { childList: true });
  }

  back.querySelector('.proj-settings').append(
    el('section', { class: 'ps-block' },
      el('h3', { class: 'ps-block-title', text: '분류 · 연결' }),
      el('p', { class: 'ps-block-hint', text: '바꾸면 바로 저장돼요. (이름·설명은 프로젝트 화면에서 제목/본문을 눌러 바로 고칠 수 있어요.)' }),
      el('div', { class: 'ps-meta' }, catRow, repoField.row, memberField.row)),
    projectRulesBlock(id),
    // (필요/산출 지식 블록은 본문 아래 '지식 흐름' 섹션 projectKnowledgeSection 으로 이관 — #245.)
    // (참고 파일 블록은 본문 '공유 폴더' 섹션으로 일원화 — #246. 상태 블록은 메타 패널 상태 필드로 일원화 — #246.)
    projectDangerBlock(id, p, meId, back));
}

// ── '내 컴퓨터에서 작업' 모달 — 담당자가 본인 PC에서 이 프로젝트를 작업하도록 시작 명령을 만들어 준다. ──
//  웹은 원격 PC 터미널을 보지 않는다(스트리밍 X). 각자 자기 PC에서 터미널을 열어 쓰고, 웹은 '어떻게 시작하는지'만
//  쉽고 상세히 안내한다. 모달에서 레포·경로·워크트리·하네스를 고르면 `node ~/.lively/work.mjs <id> …` 한 줄을
//  로컬에서 만들어 준다(renderLocalWorkCommand) — work.mjs 가 공유폴더 pull·레포·.lively 마커·실행까지 자동.
function openLocalWorkModal(id, p, opts?) {
  const form = el('div', { class: 'proj-settings lw' });
  const back = overlayBox('💻 내 컴퓨터에서 작업 — ' + p.name, form);
  const box = back.querySelector('.ov-box'); if (box) box.classList.add('ov-box-wide');
  const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
  const block = (title, hint, ...controls) => el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: title }),
    hint ? el('p', { class: 'ps-block-hint', text: hint }) : null,
    ...controls);

  // 하네스
  const harnessSel = el('select', { style: inputStyle });
  harnessSel.append(el('option', { value: 'claude', text: 'Claude Code' }), el('option', { value: 'codex', text: 'Codex' }));
  if (opts && opts.harness && ['claude', 'codex'].includes(opts.harness)) harnessSel.value = opts.harness;   // '클로드로 실행' 기본값 선주입
  // 모델 · 자동승인 — 웹 터미널 카탈로그(/api/ui/terminal/config) 재사용(하네스별 모델·autoApprove 동일 규칙).
  const modelSel = el('select', { style: inputStyle });
  const modelBlock = block('모델', '비우면 하네스 기본 모델.', modelSel);
  const autoChk = el('input', { type: 'checkbox' });
  if (opts) autoChk.checked = !!opts.autoApprove;   // '클로드로 실행' 기본값 선주입
  const autoBlock = el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '자동 승인' }),
    el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer' },
      autoChk, el('span', { text: '권한 확인 건너뛰기 (claude --dangerously-skip-permissions / codex --yolo) — 내 PC에서 실행되니 주의' })));
  const harnessCat = {};  // {claude:{models:[...],hasAuto}, codex:{...}}
  const updateModels = () => {
    const cat = harnessCat[harnessSel.value] || { models: [], hasAuto: true };
    const cur = modelSel.value;
    modelSel.replaceChildren(el('option', { value: '', text: '기본' }));
    (cat.models || []).forEach((m) => { if (m) modelSel.append(el('option', { value: m, text: m })); });
    if ((cat.models || []).includes(cur)) modelSel.value = cur;
    autoBlock.style.display = cat.hasAuto === false ? 'none' : '';
    regen();
  };
  harnessSel.addEventListener('change', updateModels);
  const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
  const pathKey = (repo) => 'lively:workpath:' + repo;
  const savedPath = (repo) => { try { return repo ? (localStorage.getItem(pathKey(repo)) || '') : ''; } catch (_) { return ''; } };
  modelSel.addEventListener('change', () => regen());
  autoChk.addEventListener('change', () => regen());

  // ── 레포 N개(반복 행) — 각 행: 레포 선택 + 내 PC 경로 + 워크트리/브랜치. cloneUrlByRepo 로 git 주소 채움. ──
  const cloneUrlByRepo = {};
  const reposWrap = el('div', {});
  let rows: any[] = [];
  const repoNames = () => Object.keys(cloneUrlByRepo);
  const fillSel = (sel) => {
    const cur = sel.value;
    sel.replaceChildren(el('option', { value: '', text: '— 코드 저장소 선택 —' }));
    repoNames().forEach((n) => sel.append(el('option', { value: n, text: n })));
    if (repoNames().includes(cur)) sel.value = cur;
  };
  const addRow = (initRepo = '') => {
    const sel = el('select', { style: inputStyle });
    const pathInp = el('input', { type: 'text', style: inputStyle, placeholder: '예) ~/dev/<레포> · Windows: C:\\Users\\..\\<레포> (비우면 기본 경로에 clone)' });
    const wtChk = el('input', { type: 'checkbox' }); wtChk.checked = !(opts && opts.worktree === false);   // '클로드로 실행' 기본값 선주입
    const branchInp = el('input', { type: 'text', style: inputStyle, value: (opts && opts.branch) || ('project/' + id) });
    const rmBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '✕ 제거' });
    fillSel(sel); if (initRepo) sel.value = initRepo;
    pathInp.value = savedPath(sel.value);
    const branchWrap = el('div', { style: 'margin-top:6px' }, el('p', { class: 'ps-block-hint', style: 'margin:0 0 2px', text: '브랜치' }), branchInp);
    const branchVis = () => { branchWrap.style.display = wtChk.checked ? '' : 'none'; };
    const rowObj: any = { sel, pathInp, wtChk, branchInp };
    rows.push(rowObj);
    sel.addEventListener('change', () => { pathInp.value = savedPath(sel.value); regen(); });
    pathInp.addEventListener('input', () => regen());
    pathInp.addEventListener('change', () => { if (sel.value && pathInp.value.trim()) { try { localStorage.setItem(pathKey(sel.value), pathInp.value.trim()); } catch (_) { /* */ } } regen(); });
    wtChk.addEventListener('change', () => { branchVis(); regen(); });
    branchInp.addEventListener('input', () => regen());
    const rowEl = el('section', { class: 'ps-block', style: 'border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:10px;margin-top:8px' },
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, sel, rmBtn),
      el('div', { style: 'margin-top:6px' }, el('p', { class: 'ps-block-hint', style: 'margin:0 0 2px', text: '내 PC 경로' }), pathInp),
      el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer;margin-top:6px' }, wtChk, el('span', { text: '워크트리 생성 (전용 브랜치로 격리)' })),
      branchWrap);
    rowObj.el = rowEl;
    rmBtn.onclick = () => { rowEl.remove(); rows = rows.filter((r) => r !== rowObj); regen(); };
    branchVis(); reposWrap.append(rowEl); regen();
  };
  const addRepoBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 레포 추가', onclick: () => addRow() });

  // 카탈로그(모델·자동승인) 로드
  (async () => {
    try {
      const cfg = await api('/api/ui/terminal/config');
      ((cfg && cfg.harnesses) || []).forEach((h) => { const mf = (h.flags || []).find((f) => f.name === '--model'); harnessCat[h.key] = { models: (mf && mf.choices) || [], hasAuto: !!h.hasAutoApprove }; });
    } catch (_) { /* graceful */ }
    updateModels();
    if (opts && opts.model && (harnessCat[harnessSel.value] || { models: [] }).models.includes(opts.model)) { modelSel.value = opts.model; regen(); }   // '클로드로 실행' 기본값 선주입
  })();
  // 레포 목록(git 주소 포함) 로드 → 행 셀렉트 채움 + 기본 1행.
  (async () => {
    try {
      const r = await api('/api/ui/repos');
      ((r && r.domainmapRepos) || []).forEach((it) => { if (it && it.name) cloneUrlByRepo[it.name] = it.clone_url || ''; });
    } catch (_) { /* graceful: 레포 없음 */ }
    rows.forEach((ro) => fillSel(ro.sel));
    if (!rows.length) {
      // 이 프로젝트에 매핑된 레포(관련 레포)를 기본 행으로 — 없으면 레포가 하나뿐일 때만 자동 선택. (opts.repos = '클로드로 실행' 기본값 선주입)
      const pre = ((opts && opts.repos) || (p && p.repos) || []).filter((n) => repoNames().includes(n));
      if (pre.length) pre.forEach((n) => addRow(n));
      else addRow(repoNames().length === 1 ? repoNames()[0] : '');
    }
    regen();
  })();

  // ── 명령 — 입력이 바뀔 때마다 자동 재생성(live). 0레포=공유폴더만 / 1=가독 플래그 / N=--repos base64. ──
  const guideWrap = el('div', { class: 'lw-guide' });
  function regen() {
    const parts = [id, '--harness ' + harnessSel.value];
    if (modelSel.value) parts.push('--model ' + modelSel.value);
    if (autoChk.checked) parts.push('--auto-approve');
    const specs = rows.map((r) => ({ name: r.sel.value, path: r.pathInp.value.trim(), worktree: r.wtChk.checked, branch: r.branchInp.value.trim(), gitUrl: r.sel.value ? (cloneUrlByRepo[r.sel.value] || '') : '' })).filter((s) => s.name);
    let hasUrl = true;
    if (specs.length === 1) {
      const s = specs[0];
      if (s.path) parts.push('--repo-path ' + q(s.path));
      if (s.worktree) { parts.push('--worktree'); if (s.branch) parts.push('--branch ' + q(s.branch)); }
      if (s.gitUrl) parts.push('--git-url ' + q(s.gitUrl)); else hasUrl = false;
    } else if (specs.length > 1) {
      const json = JSON.stringify(specs);
      parts.push('--repos ' + q(btoa(unescape(encodeURIComponent(json))))); // base64(UTF-8 JSON) — N레포 안전 인코딩
      hasUrl = specs.every((s) => !!s.gitUrl);
    }
    renderLocalWorkCommand(guideWrap, parts.join(' '), { repo: specs.length ? specs[0].name : '', hasUrl, multi: specs.length > 1 });
  }

  form.append(
    el('p', { class: 'ps-block-hint', text: '값을 바꾸면 아래 명령이 자동으로 갱신됩니다. 내 PC 터미널에 붙여넣어 실행하세요 — 한 번 실행하면 공유 폴더·코드 준비·실행까지 자동, 재실행해도 안전(늘 이 명령으로 접속).' }),
    block('AI 코딩 에이전트', '내 PC에서 사용할 하네스를 고르세요.', harnessSel),
    modelBlock, autoBlock,
    block('사용할 레포 (여러 개 가능)', '코드 레포를 선택하고 내 PC 경로를 적으세요. 비개발자는 레포 행을 모두 제거하면 공유 폴더만 받습니다.', reposWrap, el('div', { style: 'margin-top:8px' }, addRepoBtn)),
    guideWrap);
  regen();
}

// 클립보드 복사 — http(비보안 컨텍스트)에선 navigator.clipboard 가 막히므로 execCommand 폴백 + 수동선택 안내.
function copyText(text) {
  const fallback = () => {
    try {
      const t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.top = '-1000px'; t.style.opacity = '0';
      document.body.appendChild(t); t.focus(); t.select();
      const ok = document.execCommand('copy'); document.body.removeChild(t);
      toast(ok ? '복사됨' : '복사 실패 — 명령을 직접 드래그해 복사하세요', !ok);
    } catch (_) { toast('복사 실패 — 명령을 직접 드래그해 복사하세요', true); }
  };
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(() => toast('복사됨'), fallback); return; } } catch (_) { /* */ }
  fallback();
}

// 만든 명령을 렌더 — #864 부터 **한 줄**이다(`lively run <프로젝트번호> …`).
//  종전엔 OS별로 두 벌을 보여줬다: `node ~/.lively/work.mjs …` 와 `node "$env:USERPROFILE\.lively\work.mjs" …`.
//  갈라진 이유는 오직 홈 경로 표기(윈도우 셸은 ~ 를 확장하지 않는다)였는데, CLI 가 PATH 에 있으니 그 문제가 사라졌다.
//  엔진은 그대로 work.mjs — `lively run` 이 인자를 그대로 넘긴다.
function renderLocalWorkCommand(wrap, argStr, info) {
  const cmd = 'lively run ' + argStr;
  const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '복사' });
  copyBtn.onclick = () => copyText(cmd);
  const notes = ['내 PC 터미널에 붙여넣어 실행하세요 (Mac · Windows 동일).'];
  if (info && info.repo && !info.hasUrl) notes.push('※ 이 레포는 git 주소 미설정 — --git-url 없음. 입력 경로에 레포가 이미 있어야 함(없으면 관리탭 ▸ 레포(git) 관리에서 git 주소 연결).');
  notes.push("※ 'lively: command not found' 가 나오면 아직 라이블리를 설치하지 않은 거예요 — [사용 가이드 ▸ 내 AI 세션 생성] 을 먼저 따라 하세요.");
  notes.push('복사가 안 되면(보안 컨텍스트 아님) 명령을 직접 드래그해 복사하세요.');
  wrap.replaceChildren(
    el('div', { style: 'margin-top:14px;border-top:1px solid rgba(127,127,127,.18);padding-top:12px' },
      el('h3', { class: 'ps-block-title', text: '내 PC에서 실행' }),
      el('div', { style: 'display:flex;gap:8px;align-items:flex-start;margin-top:8px' },
        el('pre', { style: 'flex:1;margin:0;padding:8px 10px;background:rgba(127,127,127,.1);border-radius:6px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;line-height:1.5;user-select:all' },
          el('code', { text: cmd })),
        copyBtn),
      ...notes.map((n) => el('p', { class: 'ps-block-hint', text: n }))));
}

// 팀원 블록 — 현재 팀원 칩 + '팀원 수정'(멀티선택 오버레이). 저장 시 설정 팝업 닫고 상세 재렌더.
// (팀원·카테고리·관련레포 블록 제거 — #473 후속. 세부 설정은 새 프로젝트 폼과 같은 컴팩트 피커 + 자동저장으로 openProjectSettings 에 인라인.)

// 삭제 블록 — 작성자 본인만 노출(서버도 403 재검증). 확인 후 삭제 → 팝업 닫고 목록으로.
function projectDangerBlock(id, p, meId, back) {
  // 삭제 전원 개방(#280) — 인증된 누구나(서버도 인증만 요구). 삭제는 #/trash 에서 복원 가능.
  const delBtn = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '프로젝트 삭제' });
  delBtn.onclick = async () => {
    if (!confirm('프로젝트 ‘' + p.name + '’을(를) 삭제할까요?\n\n프로젝트와 그 작업(태스크·하위)이 함께 사라집니다(되돌릴 수 없음). 연결된 지식은 보존됩니다.')) return;
    delBtn.disabled = true;
    try {
      await api('/api/ui/v6/projects/' + id + '/delete', { method: 'POST' });
      toast('프로젝트를 삭제했습니다');
      back.remove();
      location.hash = '#/projects2';
    } catch (e) { toast('실패 — ' + e.message, true); delBtn.disabled = false; }
  };
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '프로젝트 삭제' }),
    el('p', { class: 'ps-block-hint', text: '프로젝트와 그 안의 모든 태스크가 영구 삭제됩니다(되돌릴 수 없음). 연결된 지식은 보존돼요.' }),
    el('div', { class: 'ps-rules-actions' }, delBtn));
}

// (상태 블록 제거 — #246. 상태 변경은 상세 메타 패널의 상태 필드(pjvProjStatusPill, 클릭→할 일/진행 중/완료 3단계)
//  + 대시보드 보드·목록 뷰·행 ⋯ 메뉴·일괄작업 바 어디서든 가능. 모달 토글은 2단계뿐이라 더 약했고 중복이었다.)

// 규칙 블록 — 프로젝트 AGENTS.md 의 '규칙' 영역만 편집(나머지 digest 는 서버가 자동 생성). /rules 엔드포인트로 로드/저장.
//  AGENTS.md 는 Codex 가 네이티브 로드, CLAUDE.md 는 `@AGENTS.md` 한 줄로 Claude Code 가 끌어옴(서버가 함께 관리).
function projectRulesBlock(id) {
  const url = '/api/ui/v6/projects/' + id + '/rules';
  const ta = el('textarea', { class: 'ps-rules-ta', rows: '8', disabled: '',
    placeholder: '이 프로젝트에서 AI가 지켰으면 하는 걸 편하게 적으세요. 예)\n· 새로 만들기 전에 비슷한 게 이미 있는지 먼저 찾아본다.\n· 큰 변경이나 삭제는 진행하기 전에 꼭 먼저 물어본다.\n· 자료를 만들 땐 근거와 출처를 같이 적는다.\n· 안 되는 건 안 된다고 솔직히 말한다.' });
  const status = el('span', { class: 'ps-save-status admin-hint', text: '불러오는 중…' });
  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '규칙 저장', disabled: '' });
  (async () => {
    try { const d = await api(url); ta.value = (d && d.rules) || ''; }
    catch (_) { ta.value = ''; }
    ta.disabled = false; saveBtn.disabled = false; status.textContent = '';
  })();
  saveBtn.onclick = async () => {
    saveBtn.disabled = true; status.textContent = '저장 중…';
    try {
      await api(url, { method: 'POST', body: JSON.stringify({ rules: ta.value }) });
      status.textContent = '저장됨 · 다음 세션부터 적용'; toast('프로젝트 규칙을 저장했습니다');
    }
    catch (e) { status.textContent = ''; toast('저장 실패 — ' + e.message, true); }
    saveBtn.disabled = false;
  };
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '프로젝트 규칙' }),
    el('p', { class: 'ps-block-hint', text: '이 프로젝트에서 터미널 세션을 열면, 여기 적은 규칙이 그 AI에게 자동으로 주입됩니다. (프로젝트 폴더의 AGENTS.md 규칙 영역으로 저장)' }),
    ta,
    el('div', { class: 'ps-rules-actions' }, saveBtn, status));
}

// ── 카테고리 멀티선택 피커 — 사업/제품/시스템(space)별 그룹 + 체크박스. 비동기 로드. ──
//  생성 모달·세부설정 양쪽에서 재사용. selectedIds 는 미리 체크할 카테고리 id 배열.
//  opts.onChange: 선택 변할 때(로드 완료 포함) 호출 · opts.showRecents: 이전 생성에서 고른 카테고리를 '최근' 원탭 칩으로.
//  반환 { box, getSelected(), getSelectedLabels() } — getSelectedLabels 는 [{key:id, label:name}].
function categoryPicker(selectedIds, opts?) {
  opts = opts || {};
  const sel = new Set((selectedIds || []).map(Number));
  const fire = () => { try { opts.onChange && opts.onChange(); } catch (_) { /* */ } };
  const search = el('input', { type: 'text', class: 'cp-search', placeholder: '카테고리 검색…', spellcheck: 'false', autocomplete: 'off' });
  const listWrap = el('div', { class: 'cp-list' }, el('div', { class: 'admin-hint', text: '불러오는 중…' }));
  const box = el('div', { class: 'cp-box' }, listWrap);  // 로드 후 search·recents 를 앞에 붙인다
  const checks: any[] = [];  // [{id, name, input, row}]
  const groups: any[] = [];  // [{head, rows}] — 필터 시 매칭 없는 space 헤더는 숨김
  const recentChips: any[] = [];  // [{input, chip}] — 단일선택 동기화용
  // 프로젝트는 카테고리 단일-home(#290) — 라디오처럼 하나만 선택(다른 체크 해제 + 최근칩 on 동기화).
  const setSingle = (id: number) => {
    sel.clear();
    for (const c of checks) c.input.checked = (c.id === id);
    sel.add(id);
    for (const rc of recentChips) rc.chip.classList.toggle('on', rc.input.checked);
  };
  const applyFilter = () => {
    const q = search.value.trim().toLowerCase();
    for (const c of checks) c.row.style.display = (!q || c.name.toLowerCase().includes(q)) ? '' : 'none';
    for (const g of groups) g.head.style.display = g.rows.some((r) => r.style.display !== 'none') ? '' : 'none';
  };
  search.addEventListener('input', applyFilter);
  (async () => {
    let cats: any[] = [];
    try { cats = await api('/api/ui/categories').then((d) => (d && d.categories) || []); } catch (_) { /* */ }
    if (!cats.length) { box.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '등록된 카테고리가 없어요. 관리탭 ▸ 분류 체계 관리에서 먼저 만드세요.' })); fire(); return; }
    const bySpace: any = {};
    for (const c of cats) (bySpace[c.space] = bySpace[c.space] || []).push(c);
    const kids: any[] = [];
    for (const sp of ['business', 'product', 'system']) {
      const list = bySpace[sp]; if (!list || !list.length) continue;
      const head = el('div', { class: 'eyebrow', style: 'margin:6px 0 2px', text: SPACE_LABEL[sp] || sp });
      const rows: any[] = [];
      kids.push(head);
      for (const c of list) {
        const id = Number(c.id);
        const cb = el('input', { type: 'checkbox' }); if (sel.has(id)) cb.checked = true;
        const row = el('label', { class: 'cp-item' },
          cb, el('span', { text: c.name || c.key, title: (SPACE_LABEL[c.space] || c.space) + ' · ' + (c.key || '') }));
        cb.addEventListener('change', () => {
          if (cb.checked) setSingle(id);
          else { sel.delete(id); for (const rc of recentChips) rc.chip.classList.toggle('on', rc.input.checked); }
          fire();
        });
        checks.push({ id, name: String(c.name || c.key || ''), input: cb, row });
        rows.push(row);
        kids.push(row);
      }
      groups.push({ head, rows });
    }
    listWrap.replaceChildren(...kids);
    const head: any[] = [search];
    // 최근 사용(선택) — 이전 생성 때 고른 카테고리를 원탭 칩으로 노출. 자동선택은 안 함(무관한 프로젝트 오선택 방지).
    if (opts.showRecents) {
      let recents: any[] = [];
      try { recents = JSON.parse(localStorage.getItem('lively.newproj.recentCats') || '[]'); } catch (_) { /* */ }
      const valid = (recents || []).filter((r) => r && checks.some((c) => c.id === Number(r.id))).slice(0, 6);
      if (valid.length) {
        const row = el('div', { class: 'cp-recents' }, el('span', { class: 'cp-recents-lbl', text: '최근' }));
        for (const r of valid) {
          const c = checks.find((x) => x.id === Number(r.id))!;
          const chip = el('button', { class: 'cp-recent' + (c.input.checked ? ' on' : ''), type: 'button', text: c.name });
          recentChips.push({ input: c.input, chip });
          chip.onclick = () => { if (!c.input.checked) { setSingle(c.id); fire(); } };
          row.append(chip);
        }
        head.push(row);
      }
    }
    box.replaceChildren(...head, listWrap);
    applyFilter();
    fire();
  })();
  return {
    box,
    getSelected: () => checks.filter((c) => c.input.checked).map((c) => c.id),
    getSelectedLabels: () => checks.filter((c) => c.input.checked).map((c) => ({ key: c.id, label: c.name })),
  };
}

// ── 레포 멀티선택 피커 — 레포 레지스트리(관리탭 ▸ 레포 관리)의 비폐기 레포 체크박스. 비동기 로드. ──
//  생성 모달에서 사용(이름만 매핑 — 경로는 각 PC 의 .lively/project.json). selectedNames 는 미리 체크할 레포 이름.
//  opts.onChange: 선택 변할 때(로드 완료 포함) 호출 · opts.defaultOne: 미리 선택된 게 없으면 하나 자동 선택(최근 사용 → 없으면 첫 레포).
//  반환 { box, getSelected(), getSelectedLabels() }.
function repoPicker(selectedNames, opts?) {
  opts = opts || {};
  const sel = new Set(selectedNames || []);
  const fire = () => { try { opts.onChange && opts.onChange(); } catch (_) { /* */ } };
  const box = el('div', { class: 'cp-box' }, el('div', { class: 'cp-list' }, el('div', { class: 'admin-hint', text: '불러오는 중…' })));
  const checks: any[] = [];  // [{name, input}]
  (async () => {
    let names: any[] = [];
    try { const r = await api('/api/ui/repos'); names = ((r && r.domainmapRepos) || []).filter((it) => it && it.name && !it.deprecated).map((it) => it.name); } catch (_) { /* */ }
    for (const n of sel) if (!names.includes(n)) names.push(n);  // 저장됐지만 목록에 없는 것도 노출
    names.sort();
    if (!names.length) { box.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '등록된 레포가 없어요. 관리탭 ▸ 레포(git) 관리에서 먼저 추가하세요.' })); fire(); return; }
    // 디폴트 하나 선택 — 미리 선택된 게 없을 때만. 최근 사용 레포(있으면) → 없으면 첫 레포.
    if (opts.defaultOne && !sel.size) {
      let recents: any[] = [];
      try { recents = JSON.parse(localStorage.getItem('lively.newproj.recentRepos') || '[]'); } catch (_) { /* */ }
      const pick = (recents || []).find((n) => names.includes(n)) || names[0];
      if (pick) sel.add(pick);
    }
    box.replaceChildren(el('div', { class: 'cp-list' }, ...names.map((n) => {
      const cb = el('input', { type: 'checkbox' }); if (sel.has(n)) cb.checked = true;
      cb.addEventListener('change', () => { if (cb.checked) sel.add(n); else sel.delete(n); fire(); });
      checks.push({ name: n, input: cb });
      return el('label', { class: 'cp-item' }, cb, el('span', { text: n, title: n }));
    })));
    fire();
  })();
  return {
    box,
    getSelected: () => checks.filter((c) => c.input.checked).map((c) => c.name),
    getSelectedLabels: () => checks.filter((c) => c.input.checked).map((c) => ({ key: c.name, label: c.name })),
  };
}

// ── 분류(영역) 단일선택 피커 — 새 프로젝트 모달용. 영역(=project-list) 목록을 그 자리에서 fetch. ──
//  '한 목록'·'상태' 뷰처럼 영역 맥락이 없는 곳에서 만들 때도 모달에서 영역을 정하게 해 미분류 프로젝트가 무심코 생기지 않게 한다(#337).
//  반환 { box, ready, getSelected() }. getSelected → { ok, listId }:
//   ok=false → 영역이 있는데 아직 미선택(검증에서 막음) · listId=null → 명시적 '기타(미분류)' · 그 외 → 선택한 영역 id.
//  selectedListId 가 주어지면(특정 영역 추가행에서 연 경우) 그 영역을 미리 선택 — 기존 동작 유지.
function listPicker(selectedListId) {
  const sel = el('select', { class: 'pjv-listpick-sel', 'aria-label': '분류(리스트)' });
  sel.append(el('option', { value: '', text: '불러오는 중…' }));
  sel.disabled = true;
  const box = el('div', { class: 'pjv-listpick' }, sel);
  let loaded: any[] = [];      // 로드된 영역(없으면 미분류 강제 불가 — 첫 프로젝트 부트스트랩)
  let prevValue = '';          // '＋ 새 영역' 선택 시 되돌릴 직전 값
  const sortLists = pjvContainerCmp; // #541 — 사이드바와 동일 비교자(sort → ClickUp orderindex → 이름)
  const rebuild = (lists, preferId) => {
    loaded = [...lists].sort(sortLists);
    const has = preferId != null && loaded.some((l) => String(l.id) === String(preferId));
    const opts: any[] = [];
    // 미리 선택할 영역이 없으면 placeholder — 영역이 있으면 '선택하세요'(검증에서 막힘), 없으면 '미분류로 생성'(허용).
    if (!has) opts.push(el('option', { value: '', text: loaded.length ? '리스트를 선택하세요…' : '리스트 없음 — 미분류로 생성' }));
    for (const l of loaded) opts.push(el('option', { value: 'L' + l.id, text: l.name }));
    opts.push(el('option', { value: '__none__', text: '기타 (미분류)' }));
    opts.push(el('option', { value: '__new__', text: '＋ 새 리스트 만들기…' }));
    sel.replaceChildren(...opts);
    sel.value = has ? ('L' + preferId) : '';
    prevValue = sel.value;
    sel.disabled = false;
  };
  const ready = api('/api/ui/v6/project-lists')
    .then((d) => (d && d.lists) || [])
    .catch(() => [])
    .then((lists) => rebuild(lists, selectedListId));
  sel.addEventListener('change', () => {
    if (sel.value === '__new__') {
      sel.value = prevValue;  // 선택값 아님 — 즉시 되돌리고 영역 생성 폼을 띄운다.
      openListForm(null, undefined, { onCreated: (list) => { if (list && list.id != null) rebuild([...loaded, list], list.id); } });
      return;
    }
    prevValue = sel.value;
  });
  return {
    box,
    ready,
    getSelected: () => {
      const v = sel.value;
      if (v === '__none__') return { ok: true, listId: null };
      if (v.charAt(0) === 'L') return { ok: true, listId: Number(v.slice(1)) };
      // placeholder('') — 영역이 있으면 미선택(차단), 하나도 없으면 미분류 허용(부트스트랩).
      return loaded.length ? { ok: false, listId: undefined } : { ok: true, listId: null };
    },
  };
}

// (카테고리 블록 제거 — #473 후속. openProjectSettings 의 컴팩트 피커 + 자동저장으로 대체.)

// (참고 파일 블록 제거 — #246. 프로젝트 파일 업로드는 본문 '공유 폴더' 섹션(projectFolderSection)으로 일원화.
//  '공유 폴더'가 업로드·드래그앤드롭·붙여넣기·폴더 탐색을 모두 제공하므로 모달의 약식 업로더는 중복이었다.)

// 지식 연결(#317) — 위키검색·자동추천 두 모달을 하나로. 열면 추천(관련도순)이 먼저 뜨고, 검색하면 그 너머로 좁힌다.
//  연결 관계(필요/산출)는 칼럼에서 연 기본값을 따르되 라디오로 그 자리서 바꿀 수 있다(멘션 ≠ 항상 필요).
//  추천=project_recommend_knowledge_v6(벡터 #172), 검색=knowledge/search. 이미 연결된 건 클라이언트에서 제외.
function openKnowledgePicker(id, relation, linkedNames, onLinked) {
  const linked = new Set(linkedNames || []);
  let curRel = relation === 'produced' ? 'produced' : 'required';  // 라디오로 변경 가능.

  const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '제목·내용으로 검색해 더 찾기…' });
  const recHead = el('div', { class: 'ps-kn-sec', text: '추천 · 이 프로젝트와 관련도순' });
  const results = el('div', { class: 'ps-kn-pick-results' });

  // 연결 관계 토글 — 기본은 연 칼럼. 바꾸면 이후 [연결]이 그 관계로 들어간다.
  const relName = 'pjk-rel-' + id;
  const mkRadio = (val, label) => {
    const inp = el('input', { type: 'radio', name: relName, value: val });
    if (val === curRel) inp.checked = true;
    inp.onchange = () => { if (inp.checked) curRel = val; };
    return el('label', { class: 'pjk-rel-opt' }, inp, el('span', { text: label }));
  };
  // '직접 작성'은 칼럼 버튼에서 빼 픽커 안으로 옮김(#317 정리) — 찾는 지식이 없을 때 그 관계 그대로 새 작성 페이지로.
  const createLink = el('a', { href: '#', style: 'margin-left:auto; font-size:12.5px; color:var(--blue); text-decoration:none; white-space:nowrap;', text: '＋ 직접 작성' });
  createLink.onclick = (e) => { e.preventDefault(); location.hash = '#/knowledge/new?project=' + id + '&relation=' + curRel; };
  const relRow = el('div', { class: 'pjk-rel-row' },
    el('span', { class: 'admin-hint', text: '연결 관계' }), mkRadio('required', '필요'), mkRadio('produced', '산출'), createLink);

  overlayBox('지식 연결', el('div', { class: 'ps-kn-pick' }, searchIn, recHead, results, relRow));
  setTimeout(() => searchIn.focus(), 0);

  // 한 줄(추천·검색 공용). isRec 면 유사도/분류 뱃지를 제목 옆에.
  function pickRow(m, isRec) {
    const pct = Math.round((Number(m.similarity) || 0) * 100);
    const addBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 연결' });
    addBtn.onclick = async () => {
      addBtn.disabled = true;
      try { await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: m.name, relation: curRel }) });
        linked.add(m.name); addBtn.textContent = '연결됨'; toast('연결했습니다'); if (onLinked) onLinked(); }
      catch (e) { addBtn.disabled = false; toast('연결 실패 — ' + e.message, true); }
    };
    const tags = isRec ? el('span', { style: 'flex:none; display:inline-flex; gap:6px; align-items:baseline;' },
      m.shares_category ? el('span', { class: 'kn-chip', title: '프로젝트와 같은 분류', text: '📁 같은 분류' }) : null,
      pct > 0 ? el('span', { class: 'admin-hint', title: '의미 유사도(코사인)', text: pct + '%' }) : null) : null;
    const titleEl = isRec
      ? el('div', { class: 'row-title', style: 'display:flex; justify-content:space-between; gap:8px; align-items:baseline;' }, el('span', { text: m.title || m.name }), tags)
      : el('div', { class: 'row-title', text: m.title || m.name });
    return el('div', { class: 'ps-kn-pick-row' },
      el('a', { class: 'ps-kn-pick-main', href: '#/k/' + encodeURIComponent(m.name), target: '_blank', rel: 'noopener', title: '새 탭에서 지식 열기' }, titleEl,
        el('div', { class: 'admin-hint ps-kn-pick-snip', text: (m.snippet || '').slice(0, 90) })),
      addBtn);
  }

  async function loadRecs() {
    recHead.style.display = '';
    results.replaceChildren(el('span', { class: 'admin-hint', text: '추천을 불러오는 중…' }));
    let recs: any;
    try { recs = await api('/api/ui/v6/projects/' + id + '/recommend-knowledge?limit=10').then((d) => (d && d.entries) || []); }
    catch (e) { results.replaceChildren(errorNote(e, '추천을 불러오지 못했습니다')); return; }
    const cand = recs.filter((m) => !linked.has(m.name));
    if (!cand.length) {
      recHead.style.display = 'none';
      results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '아직 추천할 지식이 없어요 — 위에서 제목·내용으로 검색하거나, 직접 작성해 보세요.' }));
      return;
    }
    results.replaceChildren(...cand.map((m) => pickRow(m, true)));
  }

  const runSearch = debounce(async () => {
    const q = searchIn.value.trim();
    if (!q) { loadRecs(); return; }  // 검색어 지우면 추천으로 복귀.
    recHead.style.display = 'none';
    results.replaceChildren(el('span', { class: 'admin-hint', text: '검색 중…' }));
    let matches: any;
    try { matches = await api('/api/ui/knowledge/search?q=' + encodeURIComponent(q) + '&limit=20').then((d) => (d && d.entries) || []); }
    catch (e) { results.replaceChildren(errorNote(e, '검색하지 못했습니다')); return; }
    const cand = matches.filter((m) => !linked.has(m.name));
    if (!cand.length) { results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '결과가 없거나 모두 이미 연결됨.' })); return; }
    results.replaceChildren(...cand.map((m) => pickRow(m, false)));
  }, 300);

  searchIn.addEventListener('input', runSearch);
  loadRecs();  // 열면 추천 먼저.
}

// ════════════════════════════════════════════
// 태스크(클릭업형 리스트뷰) — 상태 그룹(할 일/진행 중/완료) + 컬럼(담당자·마감일·우선순위) + 인라인 편집.
//  상위 태스크만 상태로 그룹핑하고, 하위는 부모 아래 중첩(자기 상태는 점으로 표시하되 재그룹 안 함 — 클릭업 동형).
//  모든 필드 편집은 POST /api/ui/v6/tasks/:id(task_update_v6) 패치 — 변경 후 reload()로 재페인트(기존 토글과 동일).
// ════════════════════════════════════════════
const PJV_TASK_STATUS = {
  todo:        { label: '할 일',   bucket: 'todo',        glyph: '',  cls: 'todo' },
  in_progress: { label: '진행 중', bucket: 'in_progress', glyph: '◐', cls: 'inprog' },
  done:        { label: '완료',    bucket: 'done',        glyph: '✓', cls: 'done' },   // #731 프로젝트('완료')와 라벨 통일(구 'Closed')
};
const PJV_STATUS_ORDER = ['todo', 'in_progress', 'done'];
// 레거시 'active'(구 토글)·클릭업 미러 적재값을 'todo' 버킷으로 흡수. 그 외 미지정도 todo.
function pjvStatusMeta(s) {
  if (s === 'done') return PJV_TASK_STATUS.done;
  if (s === 'in_progress') return PJV_TASK_STATUS.in_progress;
  return PJV_TASK_STATUS.todo;
}
const PJV_PRIORITY = {
  urgent: { label: '긴급', cls: 'urgent' },
  high:   { label: '높음', cls: 'high' },
  normal: { label: '보통', cls: 'normal' },
  low:    { label: '낮음', cls: 'low' },
};
const PJV_PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];

function pjvFmtDate(d) {
  if (!d) return '';
  const p = String(d).split(/[T ]/)[0].split('-');
  return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : String(d);
}
function pjvTodayStr() {
  const n = new Date(); const z = (x) => String(x).padStart(2, '0');
  return n.getFullYear() + '-' + z(n.getMonth() + 1) + '-' + z(n.getDate());
}
function pjvIsOverdue(t) { return t.due_date && t.status !== 'done' && t.due_date < pjvTodayStr(); }

// 인라인 편집용 경량 팝오버 — 앵커 아래 위치, 바깥클릭/ESC 로 닫힘. body 에 1개만(기존 것 제거). 닫기함수 반환.
function pjvPopover(anchor, content, opts?) {
  document.querySelectorAll('.pjv-pop').forEach((n) => n.remove());
  const pop = el('div', { class: 'pjv-pop' }, content);
  document.body.append(pop);
  // 위치 — 기본 앵커 아래, 아래 공간 부족하고 위가 더 넓으면 위로 뒤집음(하단 일괄 바 등). 콘텐츠가 나중에
  //  (동기 append·비동기 fetch) 채워져 높이가 바뀌면 ResizeObserver 로 재배치 → 항상 화면 안.
  //  opts.align='right': 앵커의 '오른쪽 끝'에 팝오버 오른쪽을 맞춘다(우상단 버튼 등 오른쪽 정렬 트리거용 — 기본은 왼쪽정렬 #481).
  const alignRight = !!(opts && opts.align === 'right');
  const place = () => {
    const r = anchor.getBoundingClientRect();
    // 앵커가 DOM 에서 떨어졌거나(재렌더로 교체) 0크기면 재배치하지 않는다 — 그대로 두지 않으면 rect=0,0 으로 좌상단에 튄다.
    if (!anchor.isConnected || (r.width === 0 && r.height === 0)) return;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const ph = pop.offsetHeight;
    const flipUp = (r.bottom + 4 + ph > vh) && (r.top > vh - r.bottom);
    pop.style.top = ((flipUp ? r.top - ph - 4 : r.bottom + 4) + window.scrollY) + 'px';
    const wantLeft = alignRight ? (r.right - pop.offsetWidth) : r.left;   // 우측정렬이면 앵커 오른쪽 끝에 맞춤
    const left = Math.min(wantLeft + window.scrollX, window.scrollX + vw - pop.offsetWidth - 10);
    pop.style.left = Math.max(8, left) + 'px';
  };
  place();
  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(() => place()) : null;
  if (ro) ro.observe(pop);
  const close = () => {
    if (ro) ro.disconnect();
    pop.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return close;
}

// 필드 패치 — task_update_v6 호출 후 전체 재페인트. 실패 시 토스트.
async function pjvPatchTask(taskId, patch, reload) {
  try {
    await api('/api/ui/v6/tasks/' + taskId, { method: 'POST', body: JSON.stringify(patch) });
    pjvReloadKeepScroll(reload);  // 태스크/하위태스크 상태·필드 변경 후 스크롤 보존(#358)
  } catch (e) { toast('수정 실패 — ' + e.message, true); }
}

// 상태 점(클릭→메뉴) — #731 프로젝트 행(pjvProjStatusDot)과 동일한 디자인으로 통일. 소속(루트 프로젝트) 리스트가
//  커스텀 상태면 그 상태들(색·이름·아이콘·진행 파이)을 그대로 제시하고, 아니면 네이티브 3단계(할 일/진행 중/완료).
//  projectId = 루트 프로젝트 id(태스크는 list_id 가 없어 이걸로 소속 리스트 커스텀 상태를 해소, pjvTaskStatusDefs).
function pjvStatusControl(t, reload, projectId?) {
  const defs = pjvTaskStatusDefs(projectId);
  if (defs) {
    const cur = pjvResolveStatusDef(t.status_raw, t.status, defs) || defs[0];
    const btn = el('button', { class: 'pjv-status-btn', type: 'button',
      title: '상태: ' + cur.label, 'aria-label': '상태 ' + cur.label }, pjvStatusIcon(cur.category, cur.color, cur.frac));
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(btn, menu);
      for (const cat of PJV_STATUS_CATS) {
        for (const d of defs.filter((x) => x.category === cat.key)) {
          const isCur = d.key === cur.key;
          const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' },
            pjvCustomStatusDot(d, 'sm'), el('span', { text: d.label }));
          item.onclick = () => { close(); if (!isCur) pjvPatchTask(t.id, { status: pjvNativeStatusOf(d.category), status_raw: d.key }, reload); };
          menu.append(item);
        }
      }
    };
    return btn;
  }
  const meta = pjvStatusMeta(t.status);
  const btn = pjvStatusIconBtn(pjvStatusIconStd(meta.bucket), { title: '상태: ' + meta.label, 'aria-label': '상태 ' + meta.label });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const key of PJV_STATUS_ORDER) {
      const m = PJV_TASK_STATUS[key];
      const sel = meta.bucket === key;
      const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' },
        pjvStatusIconStd(key, 'sm'),
        el('span', { text: m.label }));
      item.onclick = () => { close(); if (!sel) pjvPatchTask(t.id, { status: key, status_raw: null }, reload); };
      menu.append(item);
    }
  };
  return btn;
}

// #731 태스크 모달 상태 pill(라벨) — 리스트 커스텀 상태가 있으면 그 상태들(색·이름·아이콘), 아니면 네이티브 3단계.
//  listStatus = task_detail 의 d.list ({id, statusMode, statuses[]}) | null. onPick(patch) 로 저장(패치={status, status_raw}).
function pjvTaskModalStatusField(t, listStatus, onPick) {
  let defs: any = null;
  if (listStatus && listStatus.statusMode === 'custom' && Array.isArray(listStatus.statuses) && listStatus.statuses.length) {
    defs = pjvListStatusDefs({ settings: { statusMode: 'custom', statuses: listStatus.statuses } });
  }
  if (defs) {
    const cur = pjvResolveStatusDef(t.status_raw, t.status, defs) || defs[0];
    const btn = el('button', { class: 'pjv-tm-statuspill ' + pjvCatMeta(cur.category).cls, type: 'button' },
      pjvStatusIcon(cur.category, cur.color, cur.frac), el('span', { text: cur.label }));
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(btn, menu);
      for (const cat of PJV_STATUS_CATS) {
        for (const d of defs.filter((x) => x.category === cat.key)) {
          const isCur = d.key === cur.key;
          const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' },
            pjvCustomStatusDot(d, 'sm'), el('span', { text: d.label }));
          item.onclick = () => { close(); if (!isCur) onPick({ status: pjvNativeStatusOf(d.category), status_raw: d.key }); };
          menu.append(item);
        }
      }
    };
    return btn;
  }
  const meta = pjvStatusMeta(t.status);
  const btn = el('button', { class: 'pjv-tm-statuspill ' + meta.cls, type: 'button' },
    pjvStatusIconStd(meta.bucket, 'sm'), el('span', { text: meta.label.toUpperCase() }));
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const key of PJV_STATUS_ORDER) {
      const m = PJV_TASK_STATUS[key];
      const sel = meta.bucket === key;
      const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' },
        pjvStatusIconStd(key, 'sm'), el('span', { text: m.label }));
      item.onclick = () => { close(); if (!sel) onPick({ status: key, status_raw: null }); };
      menu.append(item);
    }
  };
  return btn;
}

// 담당자(아바타/이니셜, 클릭→프로젝트 팀원 선택 + '담당 없음').
// 빈 상태 회색 라인 아이콘(클릭업식) — 담당자=사람＋ · 마감일=달력＋ · 우선순위=깃발. 색은 CSS(.pjv-cell-ico).
function pjvIcon(kind) {
  const svg = (...kids) => sv('svg', { class: 'pjv-cell-ico', viewBox: '0 0 24 24', width: '17', height: '17',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...kids);
  if (kind === 'assignee') { // 사람 + (담당자 지정)
    return svg(
      sv('circle', { cx: '9.5', cy: '8', r: '3.4' }),
      sv('path', { d: 'M3.7 19a5.8 5.8 0 0 1 11.6 0' }),
      sv('path', { d: 'M18.8 13.6v4.6M16.5 15.9h4.6' }));
  }
  if (kind === 'due') { // 달력 + (마감일 지정)
    return svg(
      sv('rect', { x: '3.3', y: '5', width: '17.4', height: '15.2', rx: '2.4' }),
      sv('path', { d: 'M3.3 9.3h17.4' }),
      sv('path', { d: 'M8 2.8v3.6M16 2.8v3.6' }),
      sv('path', { d: 'M12 12.2v4.6M9.7 14.5h4.6' }));
  }
  if (kind === 'session') { // 터미널 바로가기(내 세션) — 창 + 프롬프트(>_)
    return svg(
      sv('rect', { x: '3', y: '4.5', width: '18', height: '15', rx: '2.4' }),
      sv('path', { d: 'M7 9.5l3 2.5-3 2.5' }),
      sv('path', { d: 'M13 14.5h4' }));
  }
  return svg( // 깃발 (우선순위)
    sv('path', { d: 'M6 20.5V4' }),
    sv('path', { d: 'M6 4.7h10.3l-2.4 3.3 2.4 3.3H6z' }));
}

// 담당자 다중 지정 — assignee 컬럼에 JSON 배열(["yoon","jang"]) 저장. 단일 문자열("yoon")은 레거시로 하위호환.
//  서버는 assignee 를 검증없이 문자열 그대로 저장하고 SQL 필터도 없어, 배열 직렬화만으로 다중이 된다(조인테이블 불요).
function pjvAssignees(t) {
  const a = t && t.assignee;
  if (a == null) return [];
  if (Array.isArray(a)) return a.filter(Boolean);
  const s = String(a).trim();
  if (!s) return [];
  if (s[0] === '[') { try { const arr = JSON.parse(s); return Array.isArray(arr) ? arr.filter(Boolean) : [s]; } catch (_) { return [s]; } }
  return [s];
}
function pjvAssigneeWrite(ids) {
  const a = [...new Set((ids || []).filter(Boolean))];
  return a.length ? JSON.stringify(a) : null;
}
// 저장만(전체 reload 없이) — 다중 토글 중 메뉴를 닫지 않으려고 낙관적 갱신 + 백그라운드 저장.
function pjvSaveTask(taskId, patch) {
  return api('/api/ui/v6/tasks/' + taskId, { method: 'POST', body: JSON.stringify(patch) }).catch((e) => toast('수정 실패 — ' + e.message, true));
}

// 담당자 셀(다중) — 페이스파일 아바타(최대 3 + N) / 빈 아이콘. 메뉴=팀원 토글(체크 유지, 닫지 않음) + 담당 없음.
function pjvAssigneeControl(t, members, apply) {
  const nameOf = (id) => { const m = members.find((x) => x.member_id === id); return m ? (m.display_name || m.member_id) : id; };
  const btn = el('button', { class: 'pjv-cell-btn', type: 'button', title: '담당자' });
  function render() {
    const ids = pjvAssignees(t);
    btn.className = 'pjv-cell-btn' + (ids.length ? '' : ' empty');
    if (ids.length) {
      const faces = el('span', { class: 'pjv-asg-faces' });
      for (const id of ids.slice(0, 3)) faces.append(personFace(id, 'pjv-ava', nameOf(id)));
      if (ids.length > 3) faces.append(el('span', { class: 'pjv-ava pjv-ava-more', text: '+' + (ids.length - 3) }));
      btn.replaceChildren(faces);
    } else {
      btn.replaceChildren(pjvIcon('assignee'));
    }
  }
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu pjv-asg-menu' });
    pjvPopover(btn, menu);
    const setIds = (ids) => { t.assignee = pjvAssigneeWrite(ids); render(); apply({ assignee: t.assignee }); rebuild(); };
    const none = el('button', { class: 'pjv-menu-item', type: 'button' },
      el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '담당 없음' }));
    none.onclick = (ev) => { ev.stopPropagation(); setIds([]); };
    const itemsBox = el('div', {});
    menu.append(none, itemsBox);
    function rebuild() {
      const ids = pjvAssignees(t);
      none.className = 'pjv-menu-item' + (!ids.length ? ' sel' : '');
      itemsBox.replaceChildren(...members.map((m) => {
        const on = ids.includes(m.member_id);
        const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
          personFace(m.member_id, 'pjv-ava', m.display_name || m.member_id),
          el('span', { class: 'pjv-asg-mname', text: m.display_name || m.member_id }),
          el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
        item.onclick = (ev) => { ev.stopPropagation(); const c = pjvAssignees(t); setIds(c.includes(m.member_id) ? c.filter((x) => x !== m.member_id) : [...c, m.member_id]); };
        return item;
      }));
      if (!members.length) itemsBox.append(el('div', { class: 'pjv-menu-empty', text: '팀원을 먼저 추가하세요' }));
    }
    rebuild();
  };
  render();
  return btn;
}

// 마감일(YYYY-MM-DD, 표시는 m/d). 클릭→날짜입력 + 지우기.
function pjvDueControl(t, apply) {
  const overdue = pjvIsOverdue(t);
  const btn = el('button', { class: 'pjv-cell-btn' + (t.due_date ? '' : ' empty'), type: 'button', title: '마감일' });
  btn.append(t.due_date
    ? el('span', { class: 'pjv-due-text' + (overdue ? ' overdue' : ''), text: pjvFmtDate(t.due_date) })
    : pjvIcon('due'));
  btn.onclick = (e) => {
    e.stopPropagation();
    const input = el('input', { type: 'date', class: 'pjv-date-input', value: t.due_date || '' });
    const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input,
      t.due_date ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '마감일 지우기',
        onclick: () => { close(); apply({ due_date: null }); } }) : null);
    const close = pjvPopover(btn, wrap);
    setTimeout(() => { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) { /* noop */ } } }, 0);
    input.onchange = () => { const v = input.value || null; close(); apply({ due_date: v }); };
  };
  return btn;
}

// 우선순위(깃발, 색상). 클릭→긴급/높음/보통/낮음/없음.
function pjvPriorityControl(t, apply) {
  const m = t.priority ? PJV_PRIORITY[t.priority] : null;
  const btn = el('button', { class: 'pjv-cell-btn' + (m ? '' : ' empty'), type: 'button', title: '우선순위' });
  btn.append(m
    ? el('span', { class: 'pjv-flag ' + m.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' }), el('span', { class: 'pjv-flag-label', text: m.label }))
    : pjvIcon('priority'));
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const key of PJV_PRIORITY_ORDER) {
      const pm = PJV_PRIORITY[key];
      const sel = t.priority === key;
      const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })),
        el('span', { text: pm.label }));
      item.onclick = () => { close(); if (!sel) apply({ priority: key }); };
      menu.append(item);
    }
    const none = el('button', { class: 'pjv-menu-item' + (!t.priority ? ' sel' : ''), type: 'button' },
      el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
    none.onclick = () => { close(); if (t.priority) apply({ priority: null }); };
    menu.append(none);
  };
  return btn;
}

// 닫힌(완료=Closed) 항목 표시 상태 — 클릭업 'Closed' 토글. 세션 동안 유지(reload 무관). 기본 숨김.
const pjvClosedView = { tasks: false, subtasks: false };
// 프로젝트 보드(#/projects2 대시보드)의 완료 그룹 표시 토글 — 태스크 리스트의 Closed 와 동형. 기본 숨김.
const pjvProjClosedView = { done: false };
// '내 할당만' 토글(보드) — 내가 만든·팀원인 프로젝트만. 세션 유지(reload 무관). 기본 OFF.
const pjvBoardMineOnly = { on: false };
// 보드 보기 — 묶는 기준을 독립 토글. byArea=폴더 사이드바(좌측 폴더 목록에서 하나 골라 그 안만, 기본 꺼짐, 헤더 '폴더' 버튼 전담) /
//  byFolder=폴더로 나누기(본문에 폴더별 접이식 구역들을 인라인으로 쌓아 한눈에, 필터 팝오버 토글, #455) /
//  byStatus=상태(할 일·진행 중·완료)로 나누기(기본 켜짐; byFolder 와 겹치면 폴더 › 상태 중첩). 세션 유지.
//  byArea(사이드바)와 byFolder(인라인)는 같은 '폴더로 보기'의 두 방식이라 상호배타 — 한쪽을 켜면 다른쪽을 끈다.
const pjvBoardView = { byArea: true, byStatus: true, byFolder: false, kanban: false, overview: false };
// 프로젝트 → 폴더 드래그(#454) 진행 상태. dragstart 에서 프로젝트 id(+이름 #1020)를 담고, 폴더(사이드바 항목·인라인 그룹 헤더)·휴지통이 드롭 타깃.
const pjvFolderDrag: any = { id: null, name: null };
// 사이드바 내부 드래그(#473 후속) — kind:'list'(리스트를 폴더로 넣기/빼기) | 'folder'(폴더 순서 재정렬). id=끌고 있는 대상 id.
const pjvSideDrag: any = { kind: null, id: null, folderId: null };
// 영역 그룹 펼침 상태 사용자 오버라이드 — key: 'L'+id | '__none__'. 없으면 기본(내 영역=펼침)을 따른다. 세션 유지.
const pjvListOpen = new Map<string, boolean>();
// 사이드바 폴더(project_folder) 펼침 상태 — key: folder id. 없으면 기본 펼침(#475 폴더›리스트 트리). 세션 유지.
const pjvFolderOpen = new Map<number, boolean>();
// 영역 목록에서 선택된 영역 key('L'+id | '__none__' | '__all__'). 세션 유지.
//  explicit(#662) — 사용자가 직접 고른 스코프인지(사이드바 클릭·딥링크). 자동 해소(defaultSel)면 false —
//  사이드바를 닫을 때 explicit 스코프만 유지하고, 자동 선택이면 예전처럼 전체 보드로 돌아간다.
const pjvSidebarSel: { key: string; explicit?: boolean } = { key: '__all__', explicit: false };
// 스코프 유지 모드(#662) 판정 — 사용자가 고른 스코프가 살아있는가.
function pjvScopeKept() { return !!(pjvSidebarSel.explicit && pjvSidebarSel.key && pjvSidebarSel.key !== '__all__'); }
// 사이드바를 접을 때(#1067) — 지금 보고 있는 스코프·뷰를 그대로 들고 간다. 직접 고른 게 아니라 자동 해소된 스코프여도
//  화면에 떠 있던 건 그것이므로 '접었더니 다른 화면'이 되면 안 된다. 전체 보기로 나가려면 툴바 스코프 칩의 × 를 쓴다.
//  스코프가 아예 없을 때만 예전처럼 전역 보드 기본으로 리셋(#541 잔존뷰 누수 방지).
function pjvKeepScopeOnCollapse() {
  if (pjvSidebarSel.key && pjvSidebarSel.key !== '__all__') pjvSidebarSel.explicit = true;
  else pjvExitAreaMode();
}
// 프로젝트 보드의 '하위 태스크' 버튼 모드 — 각 프로젝트를 펼쳐 그 안의 태스크를 보여주는 방식.
//  collapsed(접힘·기본, 캐럿으로 펼침) / expanded(펼침·전부 열림) / separate(분리·태스크를 상태 그룹에 평면 표시). 태스크 박스의 pjvSubtaskMode 와 독립.
const pjvProjTaskMode = { mode: 'collapsed' };

// 하위 태스크 표시 모드(클릭업 Subtasks 버튼) — collapsed(접힘·기본) / expanded(펼침) / separate(분리·하위를 최상위 행으로).
const pjvSubtaskMode = { mode: 'collapsed' };
const PJV_SUBTASK_OPTS = [
  { key: 'collapsed', label: '접힘', hint: '기본 (하위는 캐럿으로 펼침)' },
  { key: 'expanded', label: '펼침', hint: '모든 하위를 펼쳐서 표시' },
  { key: 'separate', label: '분리', hint: '하위를 별도 행으로 표시' },
];
const PJV_SUBTASK_BTNLABEL = { collapsed: '하위 태스크', expanded: '펼침', separate: '분리' };
// 하위 태스크 아이콘(클릭업식) — 좌상단 노드 → 꺾인 가지 → 우하단 노드.
function pjvSubtaskIcon() {
  const n = sv('svg', { class: 'pjv-subtask-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 7, cy: 6, r: 2.2 }), sv('circle', { cx: 17, cy: 17, r: 2.2 }), sv('path', { d: 'M7 8.2v5.6a2.6 2.6 0 0 0 2.6 2.6H14.6' }));
  return n;
}
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

// '폴더' 버튼 아이콘 — 라인 스타일 폴더(상위 폴더로 정리한다는 표식, #356).
function pjvSideToggleIcon() {
  const n = sv('svg', { class: 'pjv-view-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M4 7.6C4 6.8 4.7 6.1 5.5 6.1h3.1c.4 0 .8.2 1.05.5l.9 1.15h7c.85 0 1.55.7 1.55 1.55v7.55c0 .85-.7 1.55-1.55 1.55H5.5C4.7 18.9 4 18.2 4 17.35V7.6z' }));
  return n;
}
// 사이드바 검색창 돋보기 아이콘(#req).
function pjvSideSearchIcon() {
  const n = sv('svg', { class: 'pjv-side-search-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 11, cy: 11, r: 6.5 }), sv('path', { d: 'M20 20l-3.6-3.6' }));
  return n;
}
// 폴더(사이드바 항목) 아이콘 — 색을 채운 폴더. kind='all'(전체·파랑) / 'none'(미분류·점선 외곽) / 그 외=해당 폴더 색 채움.
function pjvBundleIcon(color, kind?) {
  const FOLDER = 'M3 6.7C3 5.8 3.72 5.1 4.6 5.1h3.55c.46 0 .9.22 1.18.58l.86 1.1h8.2c.88 0 1.6.72 1.6 1.6v8.42c0 .88-.72 1.6-1.6 1.6H4.6C3.72 18.9 3 18.2 3 17.3V6.7z';
  const n = sv('svg', { class: 'pjv-bundle-ic' + (kind ? ' ' + kind : ''), viewBox: '0 0 24 24', width: 17, height: 17, 'aria-hidden': 'true' });
  if (kind === 'none') n.append(sv('path', { d: FOLDER, fill: 'none', stroke: 'var(--muted-3, #aab1bd)', 'stroke-width': 1.5, 'stroke-dasharray': '3 2.4', 'stroke-linejoin': 'round' }));
  else n.append(sv('path', { d: FOLDER, fill: color || 'var(--muted-2)' }));
  return n;
}
// '보기' 버튼 아이콘 — 슬라이더 2줄(설정 느낌).
function pjvViewIcon() {
  const n = sv('svg', { class: 'pjv-view-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(
    sv('path', { d: 'M4 8h7M15 8h5' }), sv('circle', { cx: 13, cy: 8, r: 2.1 }),
    sv('path', { d: 'M4 16h5M13 16h7' }), sv('circle', { cx: 11, cy: 16, r: 2.1 }));
  return n;
}
// (구 '보기 방식' 팝오버(#670)는 #1067 에서 툴바 톱니(보기 설정)로 이관 — pjvBoardSettingsPopover 가 같은 라디오를 품는다.)
// 체크-원 아이콘(Closed 버튼용).
function pjvCheckCircle() {
  const n = sv('svg', { class: 'pjv-closed-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 9 }));
  n.append(sv('path', { d: 'M8.5 12.3l2.4 2.4 4.6-5' }));
  return n;
}
// 토글 스위치 행(라벨 + iOS식 스위치). after() = 상태 반영 후 재렌더.
function pjvSwitchRow(label, getOn, setOn, after) {
  const sw = el('button', { class: 'pjv-switch' + (getOn() ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': getOn() ? 'true' : 'false' }, el('span', { class: 'pjv-switch-knob' }));
  sw.onclick = (e) => { e.stopPropagation(); const nv = !getOn(); setOn(nv); sw.classList.toggle('on', nv); sw.setAttribute('aria-checked', nv ? 'true' : 'false'); after(); };
  return el('div', { class: 'pjv-closed-row' }, el('span', { class: 'pjv-closed-row-label', text: label }), sw);
}

// ════════════════════════════════════════════════════════════════════════════
// 프로젝트 보드 상단 헤더(#1067) — ClickUp 파리티 3층 구조.
//   ① 브레드크럼   스페이스 › 폴더 › 리스트  + ⌄(설정 메뉴) + ☆(즐겨찾기)
//   ② 뷰 탭        보드 · 타임라인 · 테이블 · 리스트 · ＋뷰   (지금은 버튼·아이콘만 — 기능은 별도 작업)
//   ③ 툴바         좌: 그룹 · 하위태스크 · 컬럼   /   우: 필터 · 완료 · 담당자 · 나 · 검색 | 설정 · ＋프로젝트
//  예전엔 이 셋이 한 줄에 뒤섞여(제목 + 사이드바 + 스코프칩 + 필터 + 뷰 + 그룹 + 하위 + 정렬 + 내할당 + Closed)
//  '무엇이 위치이고 무엇이 보기 옵션인지' 구분이 안 됐다. 층을 나눠 위치(①)/보기(②)/데이터 좁히기(③)로 분리.
//  아이콘은 우리 톤(단색 라인 · currentColor · 컬러 이모지 금지)으로 직접 제작 — 형태만 ClickUp 과 맞춘다.
// ════════════════════════════════════════════════════════════════════════════

// ── 툴바 아이콘 (#1067) ─────────────────────────────────────────────────────
//  세 가지를 통일해야 '우글거림'이 사라진다 — 손으로 좌표를 찍으면 미세 비대칭이 작은 크기에서 그대로 보인다.
//   ① 광학 상자: 모든 아이콘 내용이 24 그리드의 3~21 안을 꽉 채운다(어떤 건 크고 어떤 건 작아 보이던 문제).
//   ② 획: 1.6 단일 두께 · round cap/join(예전엔 1.7/1.8/1.9 가 섞여 굵기가 튀었다).
//   ③ 대칭이 중요한 도형(톱니·별)은 **각도·반지름으로 계산**해서 만든다 — 손으로 쓴 베지어는 좌우가 미세하게 어긋난다.

// 중심에서 반지름 목록대로 점을 찍어 만드는 폐곡선. spec[i] = i 번째 점의 반지름(각도는 균등 분할).
//  rot 로 첫 점의 각도를 잡는다(기본 위쪽). 좌표는 소수 2자리로 굳혀 렌더마다 동일.
function pjvRadialPath(spec: number[], rot: number, cx = 12, cy = 12) {
  const n = spec.length;
  const pts = spec.map((r, i) => {
    const a = rot + (i * 2 * Math.PI) / n;
    return (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2);
  });
  return 'M' + pts.join('L') + 'Z';
}
// 톱니 8개 기어 — 톱니마다 [윗면 시작·끝 / 골 시작·끝] 4점. 각 구간의 **각도 폭을 따로** 줘야
//  톱니가 각지게(사다리꼴) 나온다. 균등분할이면 옆면이 완만해져 8각 별처럼 뾰족하게 읽힌다.
function pjvGearPath(teeth: number, rOut: number, rIn: number, topDeg: number, valleyDeg: number) {
  const step = 360 / teeth;
  const rad = (d: number) => (d * Math.PI) / 180;
  const pt = (r: number, deg: number) => (12 + r * Math.cos(rad(deg))).toFixed(2) + ' ' + (12 + r * Math.sin(rad(deg))).toFixed(2);
  const out: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const c = -90 + i * step;              // 이 톱니의 중심각(첫 톱니가 12시)
    const v = c + step / 2;                // 다음 톱니와의 사이 골 중심각
    out.push(pt(rOut, c - topDeg / 2), pt(rOut, c + topDeg / 2), pt(rIn, v - valleyDeg / 2), pt(rIn, v + valleyDeg / 2));
  }
  return 'M' + out.join('L') + 'Z';
}
const PJV_GEAR_PATH = pjvGearPath(8, 9.2, 6.6, 19, 19);
// 5각 별 — 바깥/안쪽 반지름 교대. 꼭짓점이 12시.
const PJV_STAR_PATH = pjvRadialPath(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 8.8 : 3.9)), -Math.PI / 2);

function pjvTbIcon(kind, cls?) {
  const n = sv('svg', { class: 'pjv-tb-ic' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  if (kind === 'group') { // 그룹 — 겹쳐 쌓은 판 3장(레이어)
    n.append(sv('path', { d: 'M12 3.2 3 7.5l9 4.3 9-4.3-9-4.3Z' }),
      sv('path', { d: 'M3 12.1 12 16.4l9-4.3' }), sv('path', { d: 'M3 16.6 12 20.9l9-4.3' }));
    return n;
  }
  if (kind === 'columns') { // 컬럼 — 세로 3분할 판
    n.append(sv('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.4 }), sv('path', { d: 'M9 4.5v15M15 4.5v15' }));
    return n;
  }
  if (kind === 'filter') { // 필터 — 아래로 좁아지는 3선(깔때기). 폭 18/10/4 로 확실히 좁아지게.
    n.append(sv('path', { d: 'M3 6.5h18M7 12h10M10 17.5h4' }));
    return n;
  }
  if (kind === 'people') { // 담당자 — 두 사람(앞사람 온전 + 뒷사람 반쪽)
    n.append(sv('circle', { cx: 9.6, cy: 8.2, r: 3.6 }),
      sv('path', { d: 'M3 20.2v-1.1a4.4 4.4 0 0 1 4.4-4.4h4.4a4.4 4.4 0 0 1 4.4 4.4v1.1' }),
      sv('path', { d: 'M17.2 4.9a3.6 3.6 0 0 1 0 6.6' }),
      sv('path', { d: 'M21 20.2v-1.1a4.4 4.4 0 0 0-3.3-4.26' }));
    return n;
  }
  if (kind === 'search') { n.append(sv('circle', { cx: 10.6, cy: 10.6, r: 7 }), sv('path', { d: 'M21 21l-5.4-5.4' })); return n; }
  if (kind === 'gear') { n.append(sv('path', { d: PJV_GEAR_PATH }), sv('circle', { cx: 12, cy: 12, r: 3.2 })); return n; }
  if (kind === 'star' || kind === 'star-on') {
    const p = sv('path', { d: PJV_STAR_PATH });
    if (kind === 'star-on') p.setAttribute('fill', 'currentColor');
    n.append(p);
    return n;
  }
  if (kind === 'check') { // 완료 — 원 + 체크(원이 3~21 을 채운다)
    n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('path', { d: 'M8.1 12.2l2.7 2.7 5.1-5.6' }));
    return n;
  }
  if (kind === 'subtask') { // 하위 태스크 — 부모 노드에서 꺾여 내려가는 가지
    n.append(sv('circle', { cx: 6.4, cy: 5.6, r: 2.6 }), sv('circle', { cx: 17.6, cy: 18.4, r: 2.6 }),
      sv('path', { d: 'M6.4 8.2v7A3.2 3.2 0 0 0 9.6 18.4h5.4' }));
    return n;
  }
  if (kind === 'sidebar') { // 사이드바 — 좌측 패널이 붙은 판(폴더보다 '패널 여닫기'가 직관적)
    n.append(sv('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.4 }), sv('path', { d: 'M9.6 4.5v15' }));
    return n;
  }
  if (kind === 'plus') { n.append(sv('path', { d: 'M12 5v14M5 12h14' })); return n; }
  if (kind === 'trash') {
    n.append(sv('path', { d: 'M4 6.6h16' }), sv('path', { d: 'M9.6 6.6V5c0-.83.67-1.5 1.5-1.5h1.8c.83 0 1.5.67 1.5 1.5v1.6' }),
      sv('path', { d: 'M6.4 6.6l.83 12.5A1.5 1.5 0 0 0 8.72 20.5h6.56a1.5 1.5 0 0 0 1.5-1.4L17.6 6.6' }));
    return n;
  }
  if (kind === 'x') { n.append(sv('path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' })); return n; }
  n.append(sv('path', { d: 'M6.5 9.5 12 15l5.5-5.5' })); // caret(기본)
  return n;
}
// ── 뷰 탭 아이콘(보드·타임라인·테이블·리스트) — 같은 광학 상자·같은 획. ────────
function pjvTabIcon(kind) {
  const n = sv('svg', { class: 'pjv-vtab-ic', viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  if (kind === 'board') { // 칸반 — 높이가 다른 세 컬럼
    n.append(sv('rect', { x: 3, y: 4.5, width: 5, height: 15, rx: 1.6 }),
      sv('rect', { x: 9.5, y: 4.5, width: 5, height: 9.5, rx: 1.6 }),
      sv('rect', { x: 16, y: 4.5, width: 5, height: 12.5, rx: 1.6 }));
  } else if (kind === 'timeline') { // 간트 — 어긋나게 쌓인 막대 3개
    n.append(sv('rect', { x: 3, y: 5, width: 10, height: 4, rx: 2 }),
      sv('rect', { x: 8, y: 10, width: 13, height: 4, rx: 2 }),
      sv('rect', { x: 5, y: 15, width: 9, height: 4, rx: 2 }));
  } else if (kind === 'table') { // 표 — 헤더행 + 첫 열 경계
    n.append(sv('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.4 }),
      sv('path', { d: 'M3 9.4h18M9.6 9.4v10.1' }));
  } else { // 리스트 — 점 + 줄 3
    n.append(sv('circle', { cx: 4.6, cy: 6.6, r: 1.3, fill: 'currentColor', stroke: 'none' }),
      sv('circle', { cx: 4.6, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }),
      sv('circle', { cx: 4.6, cy: 17.4, r: 1.3, fill: 'currentColor', stroke: 'none' }),
      sv('path', { d: 'M8.8 6.6H21M8.8 12H21M8.8 17.4H21' }));
  }
  return n;
}

// ══ 툴바 필터 엔진 ══════════════════════════════════════════════════════════
//  ClickUp Filters 파리티. 조건행(field·op·values) + 담당자 빠른필터 + 뷰 내 검색을 한 술어로 합쳐
//  모든 렌더 경로(상태·평면·폴더·리스트·칸반)가 통과하는 pjvApplyToolbarFilters 하나로 적용한다.
//  스코프별 저장 없이 세션 유지(내 할당만·Closed 와 동일 결) — 화면을 떠나면 초기화된다.
const PJV_FILTER_FIELDS = [
  { key: 'status', label: '상태' },
  { key: 'assignee', label: '담당자' },
  { key: 'priority', label: '우선순위' },
  { key: 'tag', label: '태그' },
  { key: 'due', label: '마감일' },
  { key: 'name', label: '이름' },
];
// 연산자 — 값형(다중선택)과 날짜/텍스트형이 다르다. '있음/없음'은 값 없이 성립.
const PJV_FILTER_OPS: any = {
  multi: [{ key: 'is', label: '이다' }, { key: 'not', label: '아니다' }, { key: 'set', label: '있음' }, { key: 'unset', label: '없음' }],
  date: [{ key: 'on', label: '해당일' }, { key: 'before', label: '이전' }, { key: 'after', label: '이후' }, { key: 'set', label: '있음' }, { key: 'unset', label: '없음' }],
  text: [{ key: 'contains', label: '포함' }, { key: 'ncontains', label: '미포함' }],
};
function pjvFilterKind(field) { return field === 'due' ? 'date' : field === 'name' ? 'text' : 'multi'; }
const pjvFilterState: any = { rows: [], match: 'and' };      // rows: {field, op, values[]}
const pjvAsgFilter: any = { ids: new Set<string>(), none: false }; // 담당자 빠른필터(우측 사람 아이콘)
const pjvBoardSearch = { q: '' };                              // 뷰 내 검색(돋보기)
// 필터 값 후보 — 보드 렌더마다 현재 데이터에서 수집(상태·담당자·태그). 카운트는 ClickUp 처럼 옆에 숫자로.
let pjvFilterUniverse: any = { statuses: [], members: [], tags: [], counts: { member: new Map(), none: 0 } };
function pjvSetFilterUniverse(projects, _lists) {
  const statuses = new Map<string, any>();
  for (const defs of pjvStatusReg.values()) for (const d of defs) if (!statuses.has(d.key)) statuses.set(d.key, d);
  for (const d of PJV_DEFAULT_STATUS_DEFS) if (!statuses.has(d.key)) statuses.set(d.key, d);
  // 네이티브 3버킷도 후보에 — 커스텀 상태를 안 쓰는 리스트의 프로젝트는 status(todo|in_progress|done)로만 산다.
  if (!statuses.has('in_progress')) statuses.set('in_progress', { key: 'in_progress', label: '진행 중', color: '#f59e0b', category: 'active' });
  const members = new Map<string, any>();
  const tags = new Map<string, any>();
  const counts = { member: new Map<string, number>(), none: 0 };
  // 개수는 '지금 보이는 것' 기준 — 완료(done)는 Closed 를 켰을 때만 센다(사이드바 카운트·본문과 동형).
  //  안 그러면 리스트에 59개가 보이는데 담당자 옆엔 211 이 떠 숫자가 화면과 안 맞는다.
  for (const p of (projects || []).filter((x) => pjvProjClosedView.done || x.status !== 'done')) {
    const ms = p.members || [];
    if (!ms.length) counts.none++;
    for (const m of ms) {
      const id = String(m.member_id);
      if (!members.has(id)) members.set(id, { id, name: m.display_name || m.member_id });
      counts.member.set(id, (counts.member.get(id) || 0) + 1);
    }
    for (const t of (p.tags || [])) if (!tags.has(String(t.id))) tags.set(String(t.id), { id: String(t.id), name: t.name, color: t.color });
  }
  pjvFilterUniverse = { statuses: [...statuses.values()], members: [...members.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))), tags: [...tags.values()], counts };
}
// 이 프로젝트가 가질 수 있는 상태 키들 — 커스텀 상태 키 + status_raw + 네이티브 status(어느 걸로 걸어도 걸리게).
function pjvProjStatusKeys(p) {
  const out = new Set<string>();
  const d = pjvResolveProjStatus(p);
  if (d) out.add(String(d.key));
  if (p.status_raw) out.add(String(p.status_raw));
  if (p.status) out.add(String(p.status));
  if (p.status === 'in_progress') out.add('active'); // 기본 스킴의 '진행 중' 키는 active
  return out;
}
function pjvFilterRowValues(p, field) {
  if (field === 'status') return [...pjvProjStatusKeys(p)];
  if (field === 'assignee') return (p.members || []).map((m) => String(m.member_id));
  if (field === 'priority') return p.priority ? [String(p.priority)] : [];
  if (field === 'tag') return (p.tags || []).map((t) => String(t.id));
  if (field === 'due') return p.due_date ? [String(p.due_date)] : [];
  return [];
}
function pjvFilterRowMatch(p, r) {
  if (!r || !r.field) return true;
  if (r.field === 'name') {
    const s = String(p.name || '').toLowerCase();
    const t = String((r.values || [])[0] || '').trim().toLowerCase();
    if (!t) return true;
    return r.op === 'ncontains' ? !s.includes(t) : s.includes(t);
  }
  const cur = pjvFilterRowValues(p, r.field);
  if (r.op === 'set') return cur.length > 0;
  if (r.op === 'unset') return cur.length === 0;
  const vals = (r.values || []).filter((v) => v !== '' && v != null);
  if (!vals.length) return true; // 값 미선택 = 아직 안 건 조건(ClickUp 동형 — 결과를 비우지 않는다)
  if (r.field === 'due') {
    const d = p.due_date ? String(p.due_date).slice(0, 10) : null;
    const t = String(vals[0]).slice(0, 10);
    if (!d) return false;
    if (r.op === 'before') return d < t;
    if (r.op === 'after') return d > t;
    return d === t;
  }
  const hit = vals.some((v) => cur.includes(String(v)));
  return r.op === 'not' ? !hit : hit;
}
// 툴바가 거는 모든 좁히기의 단일 술어 — 검색어 → 담당자 빠른필터 → 조건행(AND/OR).
function pjvProjPassesToolbar(p) {
  const q = pjvBoardSearch.q.trim().toLowerCase();
  if (q && !String(p.name || '').toLowerCase().includes(q)) return false;
  if (pjvAsgFilter.none || pjvAsgFilter.ids.size) {
    const ms = (p.members || []).map((m) => String(m.member_id));
    const hit = (pjvAsgFilter.none && !ms.length) || ms.some((x) => pjvAsgFilter.ids.has(x));
    if (!hit) return false;
  }
  const rows = (pjvFilterState.rows || []).filter((r) => r && r.field);
  if (rows.length) {
    const res = rows.map((r) => pjvFilterRowMatch(p, r));
    if (!(pjvFilterState.match === 'or' ? res.some(Boolean) : res.every(Boolean))) return false;
  }
  return true;
}
function pjvApplyToolbarFilters(arr) {
  if (!pjvToolbarNarrowed()) return arr;
  return (arr || []).filter(pjvProjPassesToolbar);
}
function pjvToolbarNarrowed() {
  return !!(pjvBoardSearch.q.trim() || pjvAsgFilter.none || pjvAsgFilter.ids.size || (pjvFilterState.rows || []).some((r) => r && r.field));
}
function pjvFilterCount() { return (pjvFilterState.rows || []).filter((r) => r && r.field).length; }

// ── 다중 선택 팝오버(값 고르기) — 검색 + 전체 선택 + 체크박스 목록. ClickUp 'Select option' 파리티. ──
//  opts: [{id, label, color?, count?, group?}]. sel=Set(문자열 id). onChange 마다 호출(팝오버는 안 닫힘).
function pjvMultiPick(anchor, title, opts, sel, onChange) {
  const pop = el('div', { class: 'pjv-menu pjv-multipick' });
  pjvPopover(anchor, pop);
  const search = el('input', { type: 'text', class: 'pjv-multipick-search', placeholder: '검색…' });
  const listBox = el('div', { class: 'pjv-multipick-list' });
  const head = el('div', { class: 'pjv-multipick-head' },
    el('span', { class: 'pjv-multipick-title', text: title }));
  const all = el('button', { class: 'pjv-multipick-all', type: 'button', text: '전체 선택' });
  head.append(all);
  pop.append(el('div', { class: 'pjv-multipick-searchwrap' }, pjvTbIcon('search', 'sm'), search), head, listBox);
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const cand = opts.filter((o) => !q || String(o.label).toLowerCase().includes(q));
    const everyOn = cand.length > 0 && cand.every((o) => sel.has(String(o.id)));
    all.textContent = everyOn ? '전체 해제' : '전체 선택';
    if (!cand.length) { listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '일치하는 항목이 없어요.' })); return; }
    const nodes: any[] = [];
    let lastGroup: any = undefined;
    for (const o of cand) {
      if (o.group !== undefined && o.group !== lastGroup) { nodes.push(el('div', { class: 'pjv-multipick-group', text: o.group })); lastGroup = o.group; }
      const on = sel.has(String(o.id));
      const row = el('button', { class: 'pjv-multipick-row' + (on ? ' on' : ''), type: 'button', role: 'checkbox', 'aria-checked': String(on) },
        o.color ? el('span', { class: 'pjv-multipick-dot', style: 'background:' + o.color }) : (o.face || el('span', { class: 'pjv-multipick-dot none' })),
        el('span', { class: 'pjv-multipick-label', text: o.label }),
        o.count != null ? el('span', { class: 'pjv-multipick-count', text: String(o.count) }) : null,
        pjvCheckMini(on));
      row.onclick = (e) => { e.stopPropagation(); if (on) sel.delete(String(o.id)); else sel.add(String(o.id)); paint(); onChange(); };
      nodes.push(row);
    }
    listBox.replaceChildren(...nodes);
  };
  all.onclick = (e) => {
    e.stopPropagation();
    const q = search.value.trim().toLowerCase();
    const cand = opts.filter((o) => !q || String(o.label).toLowerCase().includes(q));
    const everyOn = cand.length > 0 && cand.every((o) => sel.has(String(o.id)));
    for (const o of cand) { if (everyOn) sel.delete(String(o.id)); else sel.add(String(o.id)); }
    paint(); onChange();
  };
  search.addEventListener('input', paint);
  paint();
  setTimeout(() => search.focus(), 0);
}
// 필터 행의 값 후보 — 필드별. 상태는 카테고리(Active/Done/Closed)로 묶어 보여준다(ClickUp 동형).
function pjvFilterOptsFor(field) {
  if (field === 'status') {
    const catLabel = { active: '진행', done: '완료', closed: '닫힘' };
    return [...pjvFilterUniverse.statuses]
      .sort((a, b) => PJV_STATUS_CATS.findIndex((c) => c.key === a.category) - PJV_STATUS_CATS.findIndex((c) => c.key === b.category))
      .map((d) => ({ id: d.key, label: d.label, color: d.color, group: catLabel[d.category] || '진행' }));
  }
  if (field === 'assignee') return pjvFilterUniverse.members.map((m) => ({ id: m.id, label: m.name, face: personFace(m.id, 'pjv-ava', m.name), count: pjvFilterUniverse.counts.member.get(m.id) }));
  if (field === 'priority') return PJV_PRIORITY_ORDER.map((k) => ({ id: k, label: PJV_PRIORITY[k].label }));
  if (field === 'tag') return pjvFilterUniverse.tags.map((t) => ({ id: t.id, label: t.name, color: t.color }));
  return [];
}
// ── '필터' 팝오버 — 조건행 목록 + 모두/아무 + 값 선택 + 삭제 + 조건 추가 + 전체 해제. ──
function pjvFilterPopover(anchor, onChange) {
  const pop = el('div', { class: 'pjv-menu pjv-filter-pop' });
  pjvPopover(anchor, pop, { align: 'right' });
  const rowsBox = el('div', { class: 'pjv-filter-rows' });
  const head = el('div', { class: 'pjv-filter-head' }, el('span', { class: 'pjv-filter-title', text: '필터' }));
  const clearAll = el('button', { class: 'pjv-filter-clear', type: 'button', text: '모두 지우기' });
  clearAll.onclick = (e) => { e.stopPropagation(); pjvFilterState.rows = []; paint(); onChange(); };
  head.append(clearAll);
  const addBtn = el('button', { class: 'pjv-filter-add', type: 'button' }, pjvTbIcon('plus', 'sm'), el('span', { text: '필터 추가' }));
  addBtn.onclick = (e) => { e.stopPropagation(); pjvFilterState.rows.push({ field: 'status', op: 'is', values: [] }); paint(); onChange(); };
  pop.append(head, rowsBox, addBtn);

  const mkSelect = (label, cls, onOpen) => {
    const b = el('button', { class: 'pjv-filter-sel ' + cls, type: 'button' },
      el('span', { class: 'pjv-filter-sel-label', text: label }), pjvTbIcon('caret', 'sm'));
    b.onclick = (e) => { e.stopPropagation(); onOpen(b); };
    return b;
  };
  const valueLabel = (r) => {
    const kind = pjvFilterKind(r.field);
    if (kind === 'text') return (r.values || [])[0] ? String(r.values[0]) : '값 입력';
    if (kind === 'date') return (r.values || [])[0] ? String(r.values[0]) : '날짜 선택';
    const opts = pjvFilterOptsFor(r.field);
    const sel = (r.values || []).map(String);
    if (!sel.length) return '값 선택';
    const first = opts.find((o) => String(o.id) === sel[0]);
    return (first ? first.label : sel[0]) + (sel.length > 1 ? ' +' + (sel.length - 1) : '');
  };
  function paint() {
    clearAll.style.display = pjvFilterCount() ? '' : 'none';
    if (!pjvFilterState.rows.length) {
      rowsBox.replaceChildren(el('div', { class: 'pjv-filter-empty', text: '조건이 없어요. 아래에서 필터를 추가하세요.' }));
      return;
    }
    const nodes: any[] = [];
    pjvFilterState.rows.forEach((r, i) => {
      const kind = pjvFilterKind(r.field);
      const line = el('div', { class: 'pjv-filter-row' });
      // 첫 행은 '조건', 둘째 행부터 모두 충족(and)/하나라도(or) 선택기 — 전체 행에 공통 적용.
      if (i === 0) line.append(el('span', { class: 'pjv-filter-lead', text: '조건' }));
      else {
        const m = mkSelect(pjvFilterState.match === 'or' ? '하나라도' : '모두 충족', 'pjv-filter-match', (b) => {
          const menu = el('div', { class: 'pjv-menu' });
          const close = pjvPopover(b, menu);
          for (const o of [{ k: 'and', l: '모두 충족' }, { k: 'or', l: '하나라도' }]) {
            const it = el('button', { class: 'pjv-menu-item' + (pjvFilterState.match === o.k ? ' sel' : ''), type: 'button' }, el('span', { text: o.l }));
            it.onclick = (ev) => { ev.stopPropagation(); close(); pjvFilterState.match = o.k; paint(); onChange(); };
            menu.append(it);
          }
        });
        line.append(m);
      }
      const fdef = PJV_FILTER_FIELDS.find((f) => f.key === r.field);
      line.append(mkSelect(fdef ? fdef.label : '필드', 'pjv-filter-field', (b) => {
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(b, menu);
        for (const f of PJV_FILTER_FIELDS) {
          const it = el('button', { class: 'pjv-menu-item' + (r.field === f.key ? ' sel' : ''), type: 'button' }, el('span', { text: f.label }));
          it.onclick = (ev) => {
            ev.stopPropagation(); close();
            if (r.field === f.key) return;
            r.field = f.key; r.values = [];
            r.op = PJV_FILTER_OPS[pjvFilterKind(f.key)][0].key; // 필드가 바뀌면 연산자도 그 형의 기본으로
            paint(); onChange();
          };
          menu.append(it);
        }
      }));
      const ops = PJV_FILTER_OPS[kind];
      const odef = ops.find((o) => o.key === r.op) || ops[0];
      r.op = odef.key;
      line.append(mkSelect(odef.label, 'pjv-filter-op', (b) => {
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(b, menu);
        for (const o of ops) {
          const it = el('button', { class: 'pjv-menu-item' + (r.op === o.key ? ' sel' : ''), type: 'button' }, el('span', { text: o.label }));
          it.onclick = (ev) => { ev.stopPropagation(); close(); r.op = o.key; paint(); onChange(); };
          menu.append(it);
        }
      }));
      // 값 — '있음/없음'은 값이 필요 없다(ClickUp 동형: 값칸 자체를 안 그림).
      if (r.op !== 'set' && r.op !== 'unset') {
        if (kind === 'text') {
          const inp = el('input', { type: 'text', class: 'pjv-filter-text', placeholder: '텍스트', value: (r.values || [])[0] || '' });
          inp.addEventListener('input', () => { r.values = [inp.value]; onChange(); });
          inp.addEventListener('click', (e: any) => e.stopPropagation());
          line.append(inp);
        } else if (kind === 'date') {
          const inp = el('input', { type: 'date', class: 'pjv-filter-date', value: (r.values || [])[0] ? String(r.values[0]).slice(0, 10) : '' });
          inp.addEventListener('change', () => { r.values = inp.value ? [inp.value] : []; onChange(); });
          inp.addEventListener('click', (e: any) => e.stopPropagation());
          line.append(inp);
        } else {
          line.append(mkSelect(valueLabel(r), 'pjv-filter-val', (b) => {
            const sel = new Set((r.values || []).map(String));
            pjvMultiPick(b, (fdef ? fdef.label : '값') + ' 선택', pjvFilterOptsFor(r.field), sel, () => {
              r.values = [...sel];
              const lbl = b.querySelector('.pjv-filter-sel-label'); if (lbl) lbl.textContent = valueLabel(r);
              onChange();
            });
          }));
        }
      }
      const del = el('button', { class: 'pjv-filter-del', type: 'button', title: '이 조건 삭제', 'aria-label': '이 조건 삭제' }, pjvTbIcon('trash', 'sm'));
      del.onclick = (e) => { e.stopPropagation(); pjvFilterState.rows.splice(i, 1); paint(); onChange(); };
      line.append(del);
      nodes.push(line);
    });
    rowsBox.replaceChildren(...nodes);
  }
  paint();
}
// ── '담당자' 빠른필터 팝오버 — 검색 + 미지정 + 사람별 개수(ClickUp Assignees 파리티). ──
function pjvAssigneePopover(anchor, onChange) {
  const opts = [
    { id: '__none__', label: '미지정', count: pjvFilterUniverse.counts.none, face: pjvIcon('assignee') },
    ...pjvFilterUniverse.members.map((m) => ({ id: m.id, label: m.name, count: pjvFilterUniverse.counts.member.get(m.id), face: personFace(m.id, 'pjv-ava', m.name) })),
  ];
  const sel = new Set<string>([...pjvAsgFilter.ids]);
  if (pjvAsgFilter.none) sel.add('__none__');
  pjvMultiPick(anchor, '담당자', opts, sel, () => {
    pjvAsgFilter.none = sel.has('__none__');
    pjvAsgFilter.ids = new Set([...sel].filter((x) => x !== '__none__'));
    onChange();
  });
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
  const curMode = () => pjvBoardView.overview ? 'overview' : pjvBoardView.kanban ? 'kanban' : pjvBoardView.byFolder ? 'list' : 'status';
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
// ── 뷰 탭 줄(#1067) — 보드·타임라인·테이블·리스트 + ＋뷰. **지금은 버튼·아이콘만**(기능은 별도 작업). ──
//  누르면 무엇이 준비 중인지 알려준다 — 아무 반응 없는 죽은 버튼은 '고장'으로 읽힌다.
const PJV_VIEW_TABS = [
  { key: 'board', label: '보드' },
  { key: 'timeline', label: '타임라인' },
  { key: 'table', label: '테이블' },
  { key: 'list', label: '리스트' },
];
function pjvViewTabsRow() {
  const row = el('div', { class: 'pjv-vtabs', role: 'tablist', 'aria-label': '뷰' });
  for (const t of PJV_VIEW_TABS) {
    const on = t.key === 'list'; // 기본 활성 탭 표시(현재 보드가 리스트형)
    const b = el('button', { class: 'pjv-vtab' + (on ? ' active' : ''), type: 'button', role: 'tab', 'aria-selected': String(on) },
      pjvTabIcon(t.key), el('span', { class: 'pjv-vtab-label', text: t.label }));
    b.onclick = (e) => { e.stopPropagation(); toast(t.label + ' 뷰는 준비 중이에요 — 곧 열립니다'); };
    row.append(b);
  }
  const add = el('button', { class: 'pjv-vtab pjv-vtab-add', type: 'button', title: '뷰 추가' }, pjvTbIcon('plus', 'sm'), el('span', { class: 'pjv-vtab-label', text: '뷰' }));
  add.onclick = (e) => { e.stopPropagation(); toast('뷰 추가는 준비 중이에요'); };
  row.append(el('span', { class: 'pjv-vtab-sep' }), add);
  return row;
}

// ════════════════════════════════════════════════════════════════════════════
// 커스텀 필드(클릭업형 "+ 컬럼 추가") — 우선순위 옆 (+) 로 형식을 지정해 컬럼을 추가하고, 각 태스크에 값을 채운다.
//  백엔드 task_field/task_field_value(루트 프로젝트 단위 정의 + 태스크별 값). FIELD_TYPES 는 store 의 것과 1:1.
//  아이콘은 우리 서비스 톤(단색 라인, currentColor, 형태로 구분 — 컬러 이모지 금지)으로 직접 제작.
// ════════════════════════════════════════════════════════════════════════════

// 옵션(드롭다운/라벨) 색 팔레트 — 차분한 톤(채도 절제). 추가 순서대로 라운드로빈.
const PJV_FIELD_PALETTE = ['#6b7cff', '#2bb3a3', '#e6913a', '#e0688e', '#9268d6', '#3f9ae0', '#56b877', '#dd6450', '#7f8aa3'];
// 통화 — 금액 필드. 기본 원화.
const PJV_CURRENCIES = {
  KRW: { symbol: '₩', label: '원 (₩)' }, USD: { symbol: '$', label: '달러 ($)' },
  EUR: { symbol: '€', label: '유로 (€)' }, JPY: { symbol: '¥', label: '엔 (¥)' },
};
// 필드 형식 정의 — key 는 백엔드 field_type 과 동일. w=컬럼 px 폭, config=설정 단계 종류(옵션/통화/별점/진행률).
const PJV_FIELD_TYPES = [
  { key: 'text',     label: '텍스트',       desc: '한 줄 텍스트',       w: 150 },
  { key: 'textarea', label: '긴 텍스트',     desc: '여러 줄 메모',       w: 180 },
  { key: 'number',   label: '숫자',         desc: '정수·소수',         w: 104 },
  { key: 'money',    label: '금액',         desc: '통화 단위 숫자',     w: 120, config: 'money' },
  { key: 'date',     label: '날짜',         desc: '날짜 선택',         w: 108 },
  { key: 'dropdown', label: '드롭다운',      desc: '옵션 1개 선택',      w: 130, config: 'options' },
  { key: 'labels',   label: '라벨',         desc: '옵션 여러 개 선택',   w: 130, config: 'options' },
  { key: 'checkbox', label: '체크박스',      desc: '예 / 아니오',        w: 86 },
  { key: 'website',  label: '웹사이트',      desc: 'URL 링크',          w: 156 },
  { key: 'email',    label: '이메일',       desc: '메일 주소',         w: 168 },
  { key: 'phone',    label: '전화',         desc: '전화번호',          w: 148 },
  { key: 'rating',   label: '별점',         desc: '별 점수',           w: 128, config: 'rating' },
  { key: 'progress', label: '진행률',       desc: '0–100% 막대',       w: 136, config: 'progress' },
  { key: 'tshirt',   label: '티셔츠 사이즈',  desc: 'XS–XXL',           w: 104 },
  { key: 'location', label: '위치',         desc: '장소·주소',         w: 156 },
  { key: 'files',     label: '파일',         desc: '공유 폴더에서 선택',  w: 150 },
  { key: 'relationship', label: '관계',      desc: '태스크 연결',        w: 150 },
  { key: 'progress_auto', label: '진행률(자동)', desc: '하위 완료율 자동',  w: 136 },
];
const PJV_FIELD_BY_KEY = Object.fromEntries(PJV_FIELD_TYPES.map((f) => [f.key, f]));
const PJV_TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

// 라인 아이콘 글리프(24x24, currentColor) — 형태만으로 형식을 구분(파일 아이콘 idiom 과 동일 톤).
const PJV_FIELD_ICON_PATHS = {
  text:     [['polyline', { points: '5 7 5 4 19 4 19 7' }], ['line', { x1: 12, y1: 4, x2: 12, y2: 20 }], ['line', { x1: 9, y1: 20, x2: 15, y2: 20 }]],
  textarea: [['line', { x1: 4, y1: 6, x2: 20, y2: 6 }], ['line', { x1: 4, y1: 11, x2: 20, y2: 11 }], ['line', { x1: 4, y1: 16, x2: 13, y2: 16 }]],
  number:   [['line', { x1: 9.5, y1: 4, x2: 7.5, y2: 20 }], ['line', { x1: 16.5, y1: 4, x2: 14.5, y2: 20 }], ['line', { x1: 4, y1: 9, x2: 20, y2: 9 }], ['line', { x1: 4, y1: 15, x2: 20, y2: 15 }]],
  money:    [['line', { x1: 12, y1: 3, x2: 12, y2: 21 }], ['path', { d: 'M16 6.8H10.1a2.85 2.85 0 0 0 0 5.7h3.8a2.85 2.85 0 0 1 0 5.7H8' }]],
  date:     [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2.5 }], ['line', { x1: 3, y1: 9.5, x2: 21, y2: 9.5 }], ['line', { x1: 8, y1: 3, x2: 8, y2: 7 }], ['line', { x1: 16, y1: 3, x2: 16, y2: 7 }]],
  dropdown: [['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }], ['polyline', { points: '8.5 10 12 13.5 15.5 10' }]],
  labels:   [['path', { d: 'M3.6 12.4 11 5a2 2 0 0 1 1.42-.6H19A1.4 1.4 0 0 1 20.4 5.8v6.6a2 2 0 0 1-.6 1.42l-7.4 7.4a1.55 1.55 0 0 1-2.2 0l-6.6-6.6a1.55 1.55 0 0 1 0-2.2Z' }], ['circle', { cx: 16, cy: 8, r: 1.25 }]],
  checkbox: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 3.5 }], ['polyline', { points: '8.4 12.4 11 15 16 9.4' }]],
  website:  [['circle', { cx: 12, cy: 12, r: 9 }], ['line', { x1: 3, y1: 12, x2: 21, y2: 12 }], ['path', { d: 'M12 3c2.6 2.7 2.6 15.3 0 18' }], ['path', { d: 'M12 3c-2.6 2.7-2.6 15.3 0 18' }]],
  email:    [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }], ['polyline', { points: '4 7.5 12 13 20 7.5' }]],
  phone:    [['path', { d: 'M6.5 3h3l1.6 4.2-2.3 1.5a11 11 0 0 0 4.9 4.9l1.5-2.3 4.2 1.6v3a2 2 0 0 1-2.1 2A15.5 15.5 0 0 1 4.5 5.1 2 2 0 0 1 6.5 3Z' }]],
  rating:   [['path', { d: 'M12 4.3l2.34 4.74 5.23.76-3.78 3.69.89 5.2L12 16.9l-4.68 2.46.89-5.2-3.78-3.69 5.23-.76Z' }]],
  progress: [['rect', { x: 3, y: 9, width: 18, height: 6, rx: 3 }], ['path', { d: 'M6.2 12h6', 'stroke-width': 3.2, 'stroke-linecap': 'round' }]],
  tshirt:   [['path', { d: 'M8.2 3.5 4 6.5l2.1 3.2 1.9-1.1V19a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8.6l1.9 1.1L20 6.5l-4.2-3a2.4 2.4 0 0 1-3.8 1.4 2.4 2.4 0 0 1-3.8-1.4Z' }]],
  location: [['path', { d: 'M12 21s-6.4-5.3-6.4-10.4A6.4 6.4 0 0 1 18.4 10.6C18.4 15.7 12 21 12 21Z' }], ['circle', { cx: 12, cy: 10.4, r: 2.3 }]],
  files:    [['path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' }]],
  relationship: [['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }], ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]],
  progress_auto: [['path', { d: 'M5.5 17.5a8 8 0 1 1 13 0' }], ['path', { d: 'M12 13l3.4-3.4' }]],
};
function pjvFieldIcon(key, cls?) {
  const node = sv('svg', { class: 'pjv-ficon' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  for (const [t, a] of (PJV_FIELD_ICON_PATHS[key] || PJV_FIELD_ICON_PATHS.text)) node.append(sv(t, a));
  return node;
}
function pjvPlusIcon() {
  const n = sv('svg', { class: 'pjv-addcol-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('line', { x1: 12, y1: 8, x2: 12, y2: 16 }), sv('line', { x1: 8, y1: 12, x2: 16, y2: 12 }));
  return n;
}
function pjvStarGlyph(on) {
  const n = sv('svg', { class: 'pjv-fstar-ic', viewBox: '0 0 24 24', fill: on ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M12 4.3l2.34 4.74 5.23.76-3.78 3.69.89 5.2L12 16.9l-4.68 2.46.89-5.2-3.78-3.69 5.23-.76Z' }));
  return n;
}
function pjvCheckGlyph(on) {
  const n = sv('svg', { class: 'pjv-fcheck-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }));
  if (on) n.append(sv('polyline', { points: '8.4 12.4 11 15 16 9' }));
  return n;
}
function pjvOptChip(o) {
  return el('span', { class: 'pjv-fopt', style: '--opt:' + (o.color || PJV_FIELD_PALETTE[0]) },
    el('span', { class: 'pjv-fopt-dot' }), el('span', { class: 'pjv-fopt-label', text: o.label }));
}
function pjvCheckMini(on) {
  const n = sv('svg', { class: 'pjv-check-mini' + (on ? ' on' : ''), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }));
  if (on) n.append(sv('polyline', { points: '8.4 12.4 11 15 16 9' }));
  return n;
}

// 그리드 템플릿 — 기본(이름·담당자·마감·우선순위) + 커스텀 필드 폭들 + 더보기. thead/행/추가행에 인라인 적용.
function pjvGridTemplate(fields) {
  // 제목 floor(--pjv-name-min, 180px) + 메타 minmax(0,W). 제목칸 폭은 CSS 변수 — 열 경계 드래그(#483)로 키우거나,
  //  좁은 태스크 모달의 하위태스크 표(#497)에서 컨테이너가 값을 덮어써 이름칸을 넓힌다. 메타는 좁아지면 제목 대신 먼저 준다(#339).
  //  커스텀 필드 폭도 CSS 변수(#666) — 컬럼 헤더 경계 드래그(pjvColResizeHandle)로 조절 가능.
  const extra = (fields || []).map((f) => 'minmax(0, var(' + pjvColWVar('f:' + f.id) + ', ' + ((PJV_FIELD_BY_KEY[f.field_type] && PJV_FIELD_BY_KEY[f.field_type].w) || 130) + 'px))').join(' ');
  return 'minmax(var(--pjv-name-min, 180px), 1fr) minmax(0, var(--pjv-w-assignee, 96px)) minmax(0, var(--pjv-w-due, 92px)) minmax(0, var(--pjv-w-priority, 112px))' + (extra ? ' ' + extra : '') + ' 34px';
}
// 프로젝트 목록 전용 — 우선순위 뒤 '내 세션'(80px) 컬럼 추가. 태스크 박스(pjvGridTemplate)엔 없음.
// 리스트별 커스텀 필드(#607/D) — 선택 리스트에서 보일 필드만: 그 리스트 전용(list_id===listId) + 전역(list_id 없음).
//  listId 없으면(폴더·전체 스코프) 전역 필드만. 필드는 list_id 를 백엔드에서 함께 내려준다(getBoardFields).
function pjvFieldsForList(fields, listId) {
  if (!Array.isArray(fields)) return [];
  return fields.filter((f) => f.list_id == null || String(f.list_id) === String(listId));
}
function pjvProjGridTemplate(fields) {
  // 제목 = minmax(제목최소, 1fr) — 그 이하로 안 줄고(#607), 컬럼이 적으면 1fr 로 남은 폭을 채운다. 최소 폭은 --pjv-name-min(기본 넉넉히).
  //  메타(팀원·마감·…·커스텀)는 고정 폭(pjvColTrackFor) — 좁아도 안 찌그러지고, 다 못 담으면 컨테이너가 가로 스크롤(#607).
  //  컬럼 순서(#611): 저장된 열 순서(기본 키 + 커스텀 'f:id')대로 트랙을 깐다. 시작일·생성일·갱신일은 기본 폭 0(숨김).
  const order = pjvColOrderList('proj', fields);
  const tracks = order.map((k) => pjvColTrackFor(k, fields)).join(' ');
  return 'minmax(var(--pjv-name-min, 240px), 1fr) ' + (tracks ? tracks + ' ' : '') + '34px';
}

// ── 열 순서 드래그 재정렬(#611) — 컬럼 헤더를 잡아 좌우로 끌어 순서를 바꾼다. 기본 열(팀원·마감·…)·커스텀 필드 모두 대상. ──
//  키(기본=team/due/…, 커스텀='f:'+id) 리스트를 컬럼 폭·숨김과 같은 결로 사용자별 localStorage 에 저장. 헤더·행·그리드가 이 순서를
//  CSS order + 그리드 트랙으로 함께 반영해, 행 DOM 구조(셀 생성 순서)는 그대로 두고 화면 순서만 바꾼다. 드롭 위치는 대상 헤더 좌/우 세로선.
const pjvColDrag: { id: any } = { id: null };
function pjvColOrderKey(surface) { return 'pjv:colOrder:' + surface; }
function pjvGetColOrderSaved(surface) { try { return JSON.parse(localStorage.getItem(pjvColOrderKey(surface)) || 'null'); } catch (_) { return null; } }
function pjvSetColOrder(surface, keys) { try { localStorage.setItem(pjvColOrderKey(surface), JSON.stringify(keys)); } catch (_) { /* noop */ } }
// 자연 키 순서 = 기본 컬럼(PJV_STD_COLS) + 커스텀 필드('f:'+id). 제목/추가는 고정이라 제외.
function pjvColKeysNatural(surface, fields) {
  return [...((PJV_STD_COLS[surface] || []).map((c) => c.key)), ...((fields || []).map((f) => 'f:' + f.id))];
}
// 저장 순서를 자연 키에 적용 — 저장 안 된(새로 생긴) 키는 자연 순서로 뒤에. 저장 없으면 자연 순서 그대로(무영향).
function pjvColOrderList(surface, fields) {
  const natural = pjvColKeysNatural(surface, fields);
  const saved = pjvGetColOrderSaved(surface);
  if (!saved || !saved.length) return natural;
  const nat = new Set(natural);
  const ordered = saved.filter((k) => nat.has(k));
  const seen = new Set(ordered);
  for (const k of natural) if (!seen.has(k)) ordered.push(k);
  return ordered;
}
// 키 → 그리드 트랙 문자열 — 고정 폭(안 찌그러짐, #607). 기본=CSS 폭 변수(숨김은 0), 커스텀=타입별 기본 폭.
//  다 담을 폭이 모자라면 컬럼을 줄이는 대신 컨테이너(.pjv-board-scroll)가 가로 스크롤한다.
function pjvColTrackFor(key, fields) {
  const STD = { team: '--pjv-w-team, 96px', assignee: '--pjv-w-assignee, 120px', due: '--pjv-w-due, 92px', start: '--pjv-w-start, 0px', created: '--pjv-w-created, 0px', updated: '--pjv-w-updated, 0px', priority: '--pjv-w-priority, 112px', sess: '--pjv-w-sess, 80px' };
  if (STD[key]) return 'var(' + STD[key] + ')';
  const f = (fields || []).find((x) => 'f:' + x.id === key);
  const w = (f && PJV_FIELD_BY_KEY[f.field_type] && PJV_FIELD_BY_KEY[f.field_type].w) || 130;
  return 'var(' + pjvColWVar(key) + ', ' + w + 'px)'; // 커스텀 필드도 변수 트랙(#666) — 폭 드래그 조절 대상
}
// 헤더/행에 열 순서 적용 — [data-col] 셀에 CSS order 부여(제목=0·추가=끝 고정). DOM 순서는 안 건드림(기본 순서면 order 가 DOM 순서와 같아 무영향).
function pjvApplyColOrder(rowEl, surface, fields) {
  const order = pjvColOrderList(surface, fields);
  const idx = new Map(order.map((k, i) => [k, i + 1])); // 제목(0) 다음부터
  const title = rowEl.querySelector(':scope > .pjv-trow-title-cell') as HTMLElement | null;
  if (title) title.style.order = '0';
  for (const cell of Array.from(rowEl.children) as HTMLElement[]) {
    const k = cell.getAttribute && cell.getAttribute('data-col');
    if (k != null && idx.has(k)) cell.style.order = String(idx.get(k));
  }
  const add = rowEl.querySelector(':scope > .pjv-tcell-add') as HTMLElement | null;
  if (add) add.style.order = String(order.length + 1);
}
// 컬럼 헤더 행에 드래그 재정렬 배선 — headEl 안 [data-col] 헤더 셀을 잡아 좌우로 끌어 순서 변경. 드롭 시 새 순서 저장 후 재렌더.
function pjvWireColReorder(headEl, surface, fields, reload) {
  const cells = (Array.from(headEl.children) as HTMLElement[]).filter((c) => c.getAttribute && c.getAttribute('data-col'));
  if (cells.length < 2) return;
  const clearMarks = () => cells.forEach((c) => c.classList.remove('pjv-col-drop-before', 'pjv-col-drop-after'));
  for (const cell of cells) {
    const key = cell.getAttribute('data-col') as string;
    cell.setAttribute('draggable', 'true');
    cell.classList.add('pjv-col-draggable');
    cell.addEventListener('dragstart', (ev: any) => {
      const t = ev.target as Element;
      if (t && t.closest && t.closest('.pjv-thcol-menu, button, input, .pjv-col-resize')) { ev.preventDefault(); return; } // 메뉴/버튼/폭핸들에서 시작한 건 취소(클릭·정렬·폭조절 유지)
      pjvColDrag.id = key; cell.classList.add('pjv-col-drag-src');
      try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', 'col:' + key); } catch (_) { /* */ }
    });
    cell.addEventListener('dragend', () => { pjvColDrag.id = null; cell.classList.remove('pjv-col-drag-src'); clearMarks(); });
    const markSide = (ev) => {
      if (pjvColDrag.id == null || pjvColDrag.id === key) return false;
      ev.preventDefault(); try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* */ }
      const r = cell.getBoundingClientRect();
      const after = ev.clientX > r.left + r.width / 2;
      clearMarks(); cell.classList.add(after ? 'pjv-col-drop-after' : 'pjv-col-drop-before');
      return after;
    };
    cell.addEventListener('dragover', markSide);
    cell.addEventListener('dragleave', (ev: any) => { if (!cell.contains(ev.relatedTarget)) cell.classList.remove('pjv-col-drop-before', 'pjv-col-drop-after'); });
    cell.addEventListener('drop', (ev: any) => {
      if (pjvColDrag.id == null) { clearMarks(); return; }
      const after = markSide(ev);
      ev.preventDefault(); ev.stopPropagation();
      const dragged = pjvColDrag.id; pjvColDrag.id = null; clearMarks();
      if (dragged === key) return;
      const order = pjvColOrderList(surface, fields);
      const from = order.indexOf(dragged); if (from < 0) return;
      order.splice(from, 1);
      let to = order.indexOf(key); if (to < 0) return;
      if (after) to += 1;
      order.splice(to, 0, dragged);
      pjvSetColOrder(surface, order);
      toast('열 순서를 저장했습니다');
      pjvReloadKeepScroll(reload); // 새 순서로 재렌더 + 스크롤 보존
    });
  }
}

// 이름(제목) 컬럼 폭 조절(#483) — 헤더 제목칸 오른쪽 경계에 얹는 드래그 핸들. 끌면 --pjv-name-min 을 키우고(메타 컬럼이
//  그만큼 자동으로 줄어듦), 값은 가장 가까운 .pjv-tasks-card 의 dataset.nameKey 로 localStorage 에 저장돼 새로고침 후에도 유지.
//  더블클릭 = 기본값으로 리셋. 프로젝트 목록·프로젝트 상세의 태스크 리스트(=하위 태스크 포함) 헤더에 공용으로 붙인다.
function pjvNameResizeHandle() {
  const h = el('div', { class: 'pjv-col-resize', title: '드래그하여 이름 칸 너비 조절 (더블클릭: 기본값)', 'aria-hidden': 'true' });
  h.addEventListener('mousedown', (e: any) => {
    e.preventDefault(); e.stopPropagation();
    const card = h.closest('.pjv-tasks-card') as HTMLElement | null;
    const titleCell = h.closest('.pjv-trow-title-cell') as HTMLElement | null;
    if (!card || !titleCell) return;
    const startX = e.clientX;
    const startW = titleCell.getBoundingClientRect().width;
    const cardW = card.getBoundingClientRect().width;
    const maxW = Math.max(200, cardW - 200); // 메타 컬럼용 최소 여백 확보(음수/과대 방지)
    document.body.classList.add('pjv-col-resizing');
    const onMove = (ev: any) => {
      let w = startW + (ev.clientX - startX);
      w = Math.max(140, Math.min(maxW, w));
      card.style.setProperty('--pjv-name-min', Math.round(w) + 'px');
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('pjv-col-resizing');
      const key = card.dataset.nameKey;
      const cur = card.style.getPropertyValue('--pjv-name-min');
      if (key && cur) { try { localStorage.setItem(key, cur.trim()); } catch (_) { /* noop */ } }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  h.addEventListener('dblclick', (e: any) => {
    e.preventDefault(); e.stopPropagation();
    const card = h.closest('.pjv-tasks-card') as HTMLElement | null;
    if (!card) return;
    card.style.removeProperty('--pjv-name-min');
    if (card.dataset.nameKey) { try { localStorage.removeItem(card.dataset.nameKey); } catch (_) { /* noop */ } }
  });
  return h;
}
// 카드 생성 시 1회 — 저장 키 지정 + 저장된 이름칸 폭 복원(#483).
function pjvInitNameResize(card, key) {
  card.dataset.nameKey = key;
  try { const w = localStorage.getItem(key); if (w) card.style.setProperty('--pjv-name-min', w.indexOf('px') >= 0 ? w : (w + 'px')); } catch (_) { /* noop */ }
}

// ── 모든 컬럼 폭 드래그 조절(#666) — 이름칸(#483)의 일반화: 기본/커스텀 컬럼 헤더 우측 경계 드래그. ──
//  폭은 그리드 트랙의 CSS 변수(기본=PJV_STD_COL_VAR, 커스텀='--pjv-w-f-<id>')를 카드 스코프에서 조절하고,
//  per-surface localStorage(pjv:colW:proj|task — 숨김/순서와 같은 결)에 {컬럼키: 'NNpx'} 로 저장. 더블클릭=기본 폭.
function pjvColWVar(colKey) {
  if (PJV_STD_COL_VAR[colKey]) return PJV_STD_COL_VAR[colKey];
  return '--pjv-w-' + String(colKey).replace(/[^a-zA-Z0-9_-]+/g, '-'); // 'f:12'→--pjv-w-f-12, 'f:cu:x'→--pjv-w-f-cu-x
}
function pjvColWKey(surface) { return 'pjv:colW:' + surface; }
function pjvGetColW(surface) { try { return JSON.parse(localStorage.getItem(pjvColWKey(surface)) || '{}') || {}; } catch (_) { return {}; } }
function pjvSetColW(surface, colKey, px) {
  try {
    const m = pjvGetColW(surface);
    if (px == null) delete m[colKey]; else m[colKey] = px;
    localStorage.setItem(pjvColWKey(surface), JSON.stringify(m));
  } catch (_) { /* noop */ }
}
// 카드 생성 시 1회 — 저장된 컬럼 폭 복원. 숨긴 기본 컬럼(폭 0)은 건너뛴다(폭 적용이 숨김을 풀면 안 됨).
//  pjvApplyHiddenCols 뒤에 불러 defaultHidden 컬럼의 '켬 폭'(92px)을 저장 폭이 덮어쓴다.
function pjvApplyColWidths(card, surface, listId?) {
  const lid = listId != null ? listId : (card && card.dataset.colList) || null; // #710 현재 리스트 스코프
  const m = pjvGetColW(surface);
  for (const colKey of Object.keys(m)) {
    if (!pjvStdColVisible(surface, colKey, lid)) continue; // 리스트별 숨김(기본·커스텀)이면 저장폭이 되살리지 않게
    card.style.setProperty(pjvColWVar(colKey), m[colKey]);
  }
}
// 컬럼 헤더용 폭 핸들 — 이름칸 pjvNameResizeHandle 과 동일 결(class 공유: 열 재정렬 dragstart 가드가 핸들을 무시).
function pjvColResizeHandle(colKey) {
  const h = el('div', { class: 'pjv-col-resize pjv-col-resize-col', title: '드래그하여 컬럼 너비 조절 (더블클릭: 기본값)', 'aria-hidden': 'true' });
  h.addEventListener('mousedown', (e: any) => {
    e.preventDefault(); e.stopPropagation();
    const card = h.closest('.pjv-tasks-card') as HTMLElement | null;
    const cell = h.closest('.pjv-tcell') as HTMLElement | null;
    if (!card || !cell) return;
    const surface = card.dataset.colSurface || 'proj';
    const varName = pjvColWVar(colKey);
    const startX = e.clientX;
    const startW = cell.getBoundingClientRect().width;
    document.body.classList.add('pjv-col-resizing');
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      document.body.classList.remove('pjv-col-resizing');
      const cur = card.style.getPropertyValue(varName);
      if (cur) pjvSetColW(surface, colKey, cur.trim());
    };
    const onMove = (ev: any) => {
      if (ev.buttons === 0) { onUp(); return; } // 창 밖에서 손 뗀 경우 등 mouseup 유실 방지
      let w = startW + (ev.clientX - startX);
      w = Math.max(56, Math.min(560, w));
      card.style.setProperty(varName, Math.round(w) + 'px');
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
  });
  h.addEventListener('dblclick', (e: any) => {
    e.preventDefault(); e.stopPropagation();
    const card = h.closest('.pjv-tasks-card') as HTMLElement | null;
    if (!card) return;
    card.style.removeProperty(pjvColWVar(colKey));
    pjvSetColW(card.dataset.colSurface || 'proj', colKey, null);
  });
  return h;
}

// ── 기본(내장) 컬럼 숨기기/보이기 — 팀원·마감일·우선순위·(내 세션)도 커스텀 필드처럼 호버 ⋯로 숨길 수 있게(#req). ──
//  숨김은 폭 CSS 변수를 0 으로 만들어 컬럼을 접는다(행 그리드는 gap:0 이라 흔적 없이 사라짐 — 셀/그리드 구조는 안 건드림).
//  surface: 'proj'(팀원·마감·우선·세션) | 'task'(담당자·마감·우선). 값은 localStorage 에 저장돼 유지, Fields 패널에서 되살린다.
const PJV_STD_COLS = {
  proj: [
    { key: 'team', label: '팀원' }, { key: 'due', label: '마감일' },
    // #541 빌트인 컬럼(ClickUp 뷰 패리티) — 기본 숨김(defaultHidden): 켠 사람/뷰에만 보임.
    { key: 'start', label: '시작일', defaultHidden: true }, { key: 'created', label: '생성일', defaultHidden: true }, { key: 'updated', label: '갱신일', defaultHidden: true },
    { key: 'priority', label: '우선순위' }, { key: 'sess', label: '내 세션' }],
  task: [{ key: 'assignee', label: '담당자' }, { key: 'due', label: '마감일' }, { key: 'priority', label: '우선순위' }],
};
const PJV_STD_COL_VAR = { team: '--pjv-w-team', assignee: '--pjv-w-assignee', due: '--pjv-w-due', start: '--pjv-w-start', created: '--pjv-w-created', updated: '--pjv-w-updated', priority: '--pjv-w-priority', sess: '--pjv-w-sess' };
const PJV_STD_COL_W = { start: '92px', created: '92px', updated: '92px' }; // defaultHidden 컬럼을 켤 때 부여할 폭
function pjvHiddenColsKey(surface) { return 'pjv:hiddenCols:' + surface; }
// ── #710 리스트별 컬럼 표시/숨김(팀 공유) ─────────────────────────────────────
//  리스트 스코프(선택 리스트)에선 컬럼 숨김을 그 리스트의 settings(hiddenCols/shownCols)를 단일 출처로 읽고 쓴다
//  → 서버 저장이라 **전체 구성원이 같은 컬럼 구성을 본다**(리스트마다 다르게). 리스트 밖 스코프(전체·폴더·비사이드바
//  상태/평면)는 예전대로 per-user localStorage(pjv:hiddenCols|shownCols:<surface>). #607/D 결정(리스트별 커스텀=백엔드
//  공유)의 시야 확장 — 거기선 필드 '정의'를, 여기선 필드 '표시'를 리스트 단위로. listId 없으면(=null/'') 보드 전역.
const pjvListById = new Map();
let pjvBoardFieldsCur: any[] = []; // #710 확장 — 현재 보드의 커스텀 필드(anchor board.fields). 커스텀 컬럼 리스트별 숨김 재조정(pjvApplyHiddenCols)·되살리기 패널이 참조.
function pjvSetListRegistry(lists) { pjvListById.clear(); for (const l of (lists || [])) if (l && l.id != null) pjvListById.set(Number(l.id), l); }
function pjvListOf(listId) { return listId == null || listId === '' ? null : (pjvListById.get(Number(listId)) || null); }
function pjvColSetFromList(list, key) { const a = list && list.settings && list.settings[key]; return new Set((Array.isArray(a) ? a : []).filter((x) => typeof x === 'string')); }
// 리스트 settings 의 컬럼 집합을 낙관적으로 갱신(같은 렌더의 후속 읽기·다른 뷰가 즉시 반영) + 서버 저장(얕은 병합, 공유).
function pjvPersistListColSet(list, key, arr) {
  list.settings = list.settings || {};
  list.settings[key] = arr;
  api('/api/ui/v6/project-lists/' + list.id + '/settings', { method: 'POST', body: JSON.stringify({ settings: { [key]: arr } }) })
    .catch((e) => toast('컬럼 표시 설정 저장 실패 — ' + (e && e.message || e), true));
}
function pjvGetHiddenCols(surface, listId?) {
  const l = pjvListOf(listId);
  if (l) return pjvColSetFromList(l, 'hiddenCols');
  try { return new Set(JSON.parse(localStorage.getItem(pjvHiddenColsKey(surface)) || '[]')); } catch (_) { return new Set(); }
}
function pjvSetHiddenCols(surface, set, listId?) {
  const l = pjvListOf(listId);
  if (l) { pjvPersistListColSet(l, 'hiddenCols', [...set]); return; }
  try { localStorage.setItem(pjvHiddenColsKey(surface), JSON.stringify([...set])); } catch (_) { /* noop */ }
}
// 기본숨김(defaultHidden) 컬럼의 '명시 켬' 저장 — hidden-set 과 별도(#541).
function pjvShownColsKey(surface) { return 'pjv:shownCols:' + surface; }
function pjvGetShownCols(surface, listId?) {
  const l = pjvListOf(listId);
  if (l) return pjvColSetFromList(l, 'shownCols');
  try { return new Set(JSON.parse(localStorage.getItem(pjvShownColsKey(surface)) || '[]')); } catch (_) { return new Set(); }
}
function pjvSetShownCols(surface, set, listId?) {
  const l = pjvListOf(listId);
  if (l) { pjvPersistListColSet(l, 'shownCols', [...set]); return; }
  try { localStorage.setItem(pjvShownColsKey(surface), JSON.stringify([...set])); } catch (_) { /* noop */ }
}
function pjvStdColVisible(surface, key, listId?) {
  const def = (PJV_STD_COLS[surface] || []).find((c) => c.key === key);
  return def && def.defaultHidden ? pjvGetShownCols(surface, listId).has(key) : !pjvGetHiddenCols(surface, listId).has(key);
}
// 저장된 숨김 컬럼을 폭 0 으로 적용(surface·리스트별, #710). 카드 생성 시 1회 + 리스트 전환마다 renderArea 가 재호출하므로
//  **완전 재조정**: 보여야 할 컬럼은 var 를 지워 기본폭으로 되돌린다(이전 리스트가 남긴 0/켬폭 잔존 제거). 저장폭 복원은 뒤이어
//  pjvApplyColWidths. dataset.colList 에 현재 스코프를 새겨 두면 컬럼 ⋯/되살리기 토글이 그 스코프로 읽고 쓴다(카드 파생 스코프).
//  모달 하위태스크 표에는 적용하지 않는다(되살릴 UI가 없어서). listId 없으면 보드 전역(per-user localStorage).
function pjvApplyHiddenCols(card, surface, listId?) {
  card.dataset.colSurface = surface;
  card.dataset.colList = listId != null && listId !== '' ? String(listId) : '';
  const hidden = pjvGetHiddenCols(surface, listId);
  const shown = pjvGetShownCols(surface, listId);
  for (const c of PJV_STD_COLS[surface]) {
    const v = PJV_STD_COL_VAR[c.key];
    if (!v) continue;
    if (c.defaultHidden) {
      if (shown.has(c.key)) card.style.setProperty(v, PJV_STD_COL_W[c.key] || '92px');
      else card.style.removeProperty(v);   // 기본숨김 & 미켬 → 기본(0폭) 복귀
    } else if (hidden.has(c.key)) {
      card.style.setProperty(v, '0px');
    } else {
      card.style.removeProperty(v);         // 보임 → 기본폭 복귀(리스트 전환 잔존 제거; 저장폭은 pjvApplyColWidths 가 다시 얹음)
    }
  }
  // #710 확장 — 커스텀 필드 컬럼도 리스트별 숨김(hidden-set 의 'f:<id>' 키). 프로젝트 보드(캐시된 board.fields)만.
  //  전환마다 재조정: 숨김이면 폭 0, 아니면 var 제거(기본폭 복귀·저장폭은 pjvApplyColWidths 가 다시). 태스크 보드(surface='task')는
  //  그 보드 필드가 board.fields 와 달라(프로젝트 task_field) 커스텀 숨김 미지원 — 건너뜀(회귀 없음).
  if (surface === 'proj') for (const f of pjvBoardFieldsCur) {
    const cv = pjvColWVar('f:' + f.id);
    if (hidden.has('f:' + f.id)) card.style.setProperty(cv, '0px');
    else card.style.removeProperty(cv);
  }
}
// 컬럼 보이기/숨기기 토글 — 저장 + 해당 카드의 폭 변수 즉시 반영(리로드 없이 접힘/펼침). 기본 컬럼·커스텀 필드('f:<id>' 키) 공용(#710).
//  스코프(#710): 명시 listId > 카드의 현재 리스트(dataset.colList, pjvApplyHiddenCols 가 새김) > 보드 전역.
//  리스트 스코프면 그 리스트 settings 에 저장돼 전체 구성원에게 공유된다.
function pjvSetStdColVisible(surface, key, visible, card, listId?) {
  const lid = listId != null && listId !== '' ? listId : ((card && card.dataset.colList) || null);
  const def = (PJV_STD_COLS[surface] || []).find((c) => c.key === key);
  if (def && def.defaultHidden) {
    const sh = pjvGetShownCols(surface, lid);
    if (visible) sh.add(key); else sh.delete(key);
    pjvSetShownCols(surface, sh, lid);
    if (card) { if (visible) card.style.setProperty(PJV_STD_COL_VAR[key], PJV_STD_COL_W[key] || '92px'); else card.style.removeProperty(PJV_STD_COL_VAR[key]); }
    return;
  }
  const s = pjvGetHiddenCols(surface, lid);
  if (visible) s.delete(key); else s.add(key);
  pjvSetHiddenCols(surface, s, lid);
  if (card) { const cv = pjvColWVar(key); if (visible) card.style.removeProperty(cv); else card.style.setProperty(cv, '0px'); } // pjvColWVar: 기본 키→고정 var, 'f:<id>'→커스텀 var(#710)
}
// 기본 컬럼 헤더 — 라벨 + 호버 ⋯(숨기기). 커스텀 필드 헤더(pjvColumnHead)와 같은 클래스/결.
function pjvStdColHead(surface, key, label) {
  const nameEl = el('span', { class: 'pjv-thcol-name', text: label, title: label });
  if (surface === 'proj' && key !== 'sess') pjvHeadSortable(nameEl, key); // 클릭 정렬(#541) — 내 세션 제외
  const cell = el('div', { class: 'pjv-tcell pjv-colhead pjv-stdcol', 'data-col': key }, nameEl); // data-col: 열 순서 드래그(#611)
  const menuBtn = el('button', { class: 'pjv-thcol-menu', type: 'button', text: '⋯', 'aria-label': label + ' 컬럼 옵션' });
  menuBtn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(menuBtn, menu);
    const hide = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { text: '이 컬럼 숨기기' }));
    hide.onclick = () => { close(); const card = cell.closest('.pjv-tasks-card'); pjvSetStdColVisible(surface, key, false, card); };
    menu.append(hide, el('div', { class: 'pjv-menu-hint', text: '되살리기: 컬럼 추가(＋) → 기본 컬럼' }));
  };
  cell.append(menuBtn);
  cell.append(pjvColResizeHandle(key)); // 컬럼 폭 드래그(#666) — 헤더 우측 경계
  return cell;
}
// Fields(컬럼 추가) 패널의 '기본 컬럼' 섹션 — 각 기본 컬럼의 보임/숨김 토글(되살리기 진입점).
//  스코프(#710): 카드의 현재 리스트(dataset.colList)면 그 리스트만·전체 구성원 공유, 없으면 보드 전역(per-user).
function pjvDefaultColsSection(surface, card) {
  const lid = (card && card.dataset.colList) || null;
  const list = pjvListOf(lid);
  const sec = el('div', { class: 'pjv-fields-defcols' });
  sec.append(el('div', { class: 'pjv-fields-sec', text: '기본 컬럼' + (list ? ' · 이 리스트' : '') }));
  for (const c of PJV_STD_COLS[surface]) {
    const row = el('button', { class: 'pjv-defcol-row', type: 'button' });
    const toggle = el('span', { class: 'pjv-defcol-toggle', 'aria-hidden': 'true' });
    const paint = (on) => { toggle.classList.toggle('on', on); row.setAttribute('aria-pressed', String(on)); };
    paint(pjvStdColVisible(surface, c.key, lid)); // 기본숨김(defaultHidden)=shown-set 기준(#541); 리스트 스코프면 그 리스트 기준(#710)
    row.append(el('span', { class: 'pjv-defcol-name', text: c.label }), toggle);
    row.onclick = () => { const on = !toggle.classList.contains('on'); pjvSetStdColVisible(surface, c.key, on, card); paint(on); };
    sec.append(row);
  }
  if (list) sec.append(el('div', { class: 'pjv-menu-hint', text: '이 리스트에만 적용 · 전체 구성원 공유' }));
  return sec;
}
// Fields 패널 '커스텀 필드' 섹션(#710 확장) — 이 스코프의 커스텀 필드 표시/숨김 토글(헤더 ⋯ '이 컬럼 숨기기'의 되살리기 진입점).
//  프로젝트 보드 전용(pjvBoardFieldsCur = board.fields). 스코프는 카드의 dataset.colList(기본 컬럼 섹션과 동일 규칙). 필드 없으면 null.
function pjvCustomColsSection(card, reload) {
  const lid = (card && card.dataset.colList) || null;
  const fields = pjvFieldsForList(pjvBoardFieldsCur, lid); // 이 리스트 스코프의 커스텀 필드(#607/D 전역+리스트전용)
  if (!fields.length) return null;
  const list = pjvListOf(lid);
  const sec = el('div', { class: 'pjv-fields-defcols' });
  sec.append(el('div', { class: 'pjv-fields-sec', text: '커스텀 필드' + (list ? ' · 이 리스트' : '') }));
  for (const f of fields) {
    const key = 'f:' + f.id;
    const row = el('button', { class: 'pjv-defcol-row', type: 'button' });
    const toggle = el('span', { class: 'pjv-defcol-toggle', 'aria-hidden': 'true' });
    const paint = (on) => { toggle.classList.toggle('on', on); row.setAttribute('aria-pressed', String(on)); };
    paint(pjvStdColVisible('proj', key, lid)); // 커스텀 키도 hidden-set 기준(#710)
    row.append(el('span', { class: 'pjv-defcol-name', text: f.name || key }), toggle);
    row.onclick = () => { const on = !toggle.classList.contains('on'); pjvSetStdColVisible('proj', key, on, card); paint(on); };
    sec.append(row);
  }
  if (list) sec.append(el('div', { class: 'pjv-menu-hint', text: '이 리스트에만 적용 · 전체 구성원 공유' }));
  return sec;
}
function pjvHasFieldValue(v) {
  return !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
}
function pjvUrlText(v) { return String(v).replace(/^https?:\/\//i, '').replace(/\/$/, ''); }

// 값 표시 노드(읽기) — 타입별. 셀 버튼 안에 들어간다.
function pjvFieldDisplay(field, value) {
  const type = field.field_type;
  const cfg = field.config || {};
  if (type === 'dropdown') {
    const o = (cfg.options || []).find((x) => x.id === value);
    return o ? pjvOptChip(o) : el('span', { class: 'pjv-fval', text: String(value) });
  }
  if (type === 'labels') {
    const opts = cfg.options || [];
    const wrap = el('span', { class: 'pjv-flabels' });
    for (const id of (Array.isArray(value) ? value : [])) {
      const o = opts.find((x) => x.id === id);
      wrap.append(o ? pjvOptChip(o) : el('span', { class: 'pjv-fval', text: String(id) }));
    }
    return wrap;
  }
  if (type === 'money') {
    const c = PJV_CURRENCIES[cfg.currency] || PJV_CURRENCIES.KRW;
    const n = Number(value);
    return el('span', { class: 'pjv-fval', text: c.symbol + (Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(value)) });
  }
  if (type === 'number') {
    const n = Number(value);
    return el('span', { class: 'pjv-fval', text: Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(value) });
  }
  if (type === 'date') return el('span', { class: 'pjv-fval', text: pjvFmtDate(value) });
  if (type === 'progress') {
    const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    return el('span', { class: 'pjv-fprog' },
      el('span', { class: 'pjv-fprog-track' }, el('span', { class: 'pjv-fprog-fill', style: 'width:' + pct + '%' })),
      el('span', { class: 'pjv-fprog-num', text: pct + '%' }));
  }
  if (type === 'files') {
    const arr = Array.isArray(value) ? value : [];
    return el('span', { class: 'pjv-ffiles' }, pjvFieldIcon('files', 'pjv-fmini'),
      el('span', { class: 'pjv-fval', text: arr.length === 1 ? arr[0].name : arr.length + '개' }));
  }
  if (type === 'relationship') {
    const arr = Array.isArray(value) ? value : [];
    const w = el('span', { class: 'pjv-frel' });
    for (const r of arr.slice(0, 2)) w.append(el('span', { class: 'pjv-rel-chip', text: r.name || ('#' + r.id), title: r.name }));
    if (arr.length > 2) w.append(el('span', { class: 'pjv-rel-more', text: '+' + (arr.length - 2) }));
    return w;
  }
  if (type === 'tshirt') return el('span', { class: 'pjv-fsize', text: String(value) });
  if (type === 'website') return el('span', { class: 'pjv-fval pjv-flink', text: pjvUrlText(value) });
  return el('span', { class: 'pjv-fval', text: String(value) }); // text/textarea/email/phone/location
}

// 한 셀의 컨트롤 — 낙관적 로컬 갱신 + 백그라운드 저장(전체 reload 없이 부드럽게). 옵션 추가 등 정의 변경은 reload.
function pjvFieldControl(t, field, reload) {
  let value = (t.field_values || {})[field.id];
  value = value === undefined ? null : value;
  const cell = el('span', { class: 'pjv-fcell-wrap' });
  const persist = (v) => {
    // ClickUp 리스트 컬럼(#541): 정의가 프로젝트별 복제라 POST 는 행별 내부 field id(cuIds 맵)로 해소.
    const postId = field.cuIds ? field.cuIds[t.id] : field.id;
    if (field.cuIds && !postId) { toast('이 행에는 ClickUp 필드 정의가 아직 없어요 — 다음 싱크 후 편집 가능해요', true); return; }
    const prev = value; value = v;
    render();
    api('/api/ui/v6/tasks/' + t.id + '/fields/' + postId, { method: 'POST', body: JSON.stringify({ value: v }) })
      .then(() => { (t.field_values || (t.field_values = {}))[field.id] = v; })
      .catch((e) => { value = prev; render(); toast('수정 실패 — ' + e.message, true); });
  };
  function render() { cell.replaceChildren(pjvFieldInner(t, field, value, persist, reload)); }
  render();
  return cell;
}

// 셀 내부 — 인라인 상호작용(체크박스·별점)은 셀 자체가 컨트롤, 그 외는 값 버튼(클릭→팝오버 편집기).
function pjvFieldInner(t, field, value, persist, reload) {
  const type = field.field_type;
  if (type === 'checkbox') {
    const on = value === true;
    const btn = el('button', { class: 'pjv-fcheck' + (on ? ' on' : ''), type: 'button', title: field.name, 'aria-pressed': on ? 'true' : 'false' }, pjvCheckGlyph(on));
    btn.onclick = (e) => { e.stopPropagation(); persist(!on); };
    return btn;
  }
  if (type === 'rating') {
    const max = Math.max(1, Math.min(10, Number(field.config && field.config.max) || 5));
    const cur = Number(value) || 0;
    const wrap = el('span', { class: 'pjv-frating', title: field.name });
    for (let i = 1; i <= max; i++) {
      const on = i <= cur;
      const star = el('button', { class: 'pjv-fstar' + (on ? ' on' : ''), type: 'button', 'aria-label': i + '점' }, pjvStarGlyph(on));
      star.onclick = (e) => { e.stopPropagation(); persist(i === cur ? null : i); };
      wrap.append(star);
    }
    return wrap;
  }
  if (type === 'progress_auto') {
    const pct = pjvAutoProgress(t);
    if (pct === null) return el('span', { class: 'pjv-cell-btn empty', title: '하위 태스크가 없어요(자동 진행률)', style: 'cursor:default' }, el('span', { class: 'pjv-cell-ph', text: '—' }));
    return el('span', { class: 'pjv-fprog', title: '하위 태스크 ' + pct + '% 완료(자동)' },
      el('span', { class: 'pjv-fprog-track' }, el('span', { class: 'pjv-fprog-fill', style: 'width:' + pct + '%' })),
      el('span', { class: 'pjv-fprog-num', text: pct + '%' }));
  }
  const has = pjvHasFieldValue(value);
  const btn = el('button', { class: 'pjv-cell-btn' + (has ? '' : ' empty'), type: 'button', title: field.name },
    has ? pjvFieldDisplay(field, value) : el('span', { class: 'pjv-cell-ph', text: '＋' }));
  btn.onclick = (e) => {
    e.stopPropagation();
    if (type === 'dropdown') return pjvFieldDropdownEditor(btn, t, field, value, persist, reload);
    if (type === 'labels') return pjvFieldLabelsEditor(btn, t, field, value, persist, reload);
    if (type === 'date') return pjvFieldDateEditor(btn, value, persist);
    if (type === 'progress') return pjvFieldProgressEditor(btn, value, persist);
    if (type === 'files') return pjvFieldFilesEditor(btn, t, field, value, persist);
    if (type === 'relationship') return pjvFieldRelEditor(btn, t, field, value, persist);
    if (type === 'tshirt') return pjvFieldTshirtEditor(btn, value, persist);
    if (type === 'textarea') return pjvFieldTextareaEditor(btn, field, value, persist);
    return pjvFieldTextEditor(btn, field, value, persist);
  };
  return btn;
}

// 텍스트류 편집기(text/number/money/website/email/phone/location) — 입력 + 저장/지우기. Enter 저장.
function pjvFieldTextEditor(anchor, field, value, persist) {
  const type = field.field_type;
  const itype = (type === 'number' || type === 'money') ? 'number' : type === 'website' ? 'url' : type === 'email' ? 'email' : type === 'phone' ? 'tel' : 'text';
  const input = el('input', { type: itype, class: 'pjv-field-input', value: value == null ? '' : String(value),
    placeholder: (PJV_FIELD_BY_KEY[type] && PJV_FIELD_BY_KEY[type].desc) || '',
    inputmode: (type === 'number' || type === 'money') ? 'decimal' : null });
  const coerce = (v) => {
    if (type === 'number' || type === 'money') { const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : undefined; }
    return v;
  };
  const save = () => {
    const raw = input.value.trim();
    if (raw === '') { close(); persist(null); return; }
    const out = coerce(raw);
    if (out === undefined) { toast('숫자를 입력하세요', true); return; }
    close(); persist(out);
  };
  const actions = el('div', { class: 'pjv-fe-actions' },
    el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }),
    (type === 'website' && pjvHasFieldValue(value)) ? el('a', { class: 'pjv-fe-btn', href: safeHref(String(value)) || '#', target: '_blank', rel: 'noopener', text: '열기 ↗' }) : null,
    pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
  const close = pjvPopover(anchor, el('div', { class: 'pjv-field-editor' }, input, actions));
  setTimeout(() => { input.focus(); if (input.select) input.select(); }, 0);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
}

// 긴 텍스트 편집기 — textarea + 저장/지우기. Cmd/Ctrl+Enter 저장.
function pjvFieldTextareaEditor(anchor, field, value, persist) {
  const ta = el('textarea', { class: 'pjv-field-textarea', rows: '4', placeholder: '여러 줄 메모', maxlength: '4000' });
  ta.value = value == null ? '' : String(value);
  const save = () => { const v = ta.value.trim(); close(); persist(v === '' ? null : v); };
  const actions = el('div', { class: 'pjv-fe-actions' },
    el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }),
    pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
  const close = pjvPopover(anchor, el('div', { class: 'pjv-field-editor wide' }, ta, actions));
  setTimeout(() => { ta.focus(); }, 0);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });
}

// 날짜 편집기 — 마감일과 동형(YYYY-MM-DD).
function pjvFieldDateEditor(anchor, value, persist) {
  const input = el('input', { type: 'date', class: 'pjv-date-input', value: typeof value === 'string' ? value : '' });
  const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input,
    pjvHasFieldValue(value) ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
  const close = pjvPopover(anchor, wrap);
  setTimeout(() => { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) { /* noop */ } } }, 0);
  input.onchange = () => { const v = input.value || null; close(); persist(v); };
}

// 진행률 편집기 — 슬라이더 + 숫자(0–100).
function pjvFieldProgressEditor(anchor, value, persist) {
  const cur = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const range = el('input', { type: 'range', class: 'pjv-prog-range', min: '0', max: '100', step: '5', value: String(cur) });
  const num = el('input', { type: 'number', class: 'pjv-prog-num-input', min: '0', max: '100', value: String(cur) });
  range.oninput = () => { num.value = range.value; };
  num.oninput = () => { const n = Math.max(0, Math.min(100, Number(num.value) || 0)); range.value = String(n); };
  const save = () => { const n = Math.max(0, Math.min(100, Math.round(Number(num.value) || 0))); close(); persist(n === 0 ? null : n); };
  const wrap = el('div', { class: 'pjv-field-editor pjv-prog-editor' },
    el('div', { class: 'pjv-prog-row' }, range, el('span', { class: 'pjv-prog-pct' }, num, el('span', { text: '%' }))),
    el('div', { class: 'pjv-fe-actions' },
      el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }),
      pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null));
  const close = pjvPopover(anchor, wrap);
}

// 티셔츠 사이즈 — 고정 옵션(XS–XXL) 메뉴.
function pjvFieldTshirtEditor(anchor, value, persist) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  for (const s of PJV_TSHIRT_SIZES) {
    const sel = value === s;
    const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-fsize', text: s }));
    item.onclick = () => { close(); persist(sel ? null : s); };
    menu.append(item);
  }
  const none = el('button', { class: 'pjv-menu-item' + (value == null ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
  none.onclick = () => { close(); if (value != null) persist(null); };
  menu.append(none);
}

// 하위 태스크 완료율(자동) — 진행률(자동) 필드용. 하위 없으면 null. (클릭업 Progress Auto 의 하위 기반 버전)
function pjvAutoProgress(t) {
  const subs = (t && t.subtasks) || [];
  if (!subs.length) return null;
  const done = subs.filter((s) => s.status === 'done').length;
  return Math.round((done / subs.length) * 100);
}

// 파일 필드 — 공유 폴더에서 선택(참조). 업로드가 아니라 프로젝트 공유폴더의 기존 파일을 골라 연결한다.
//  값=[{name, path, size}](path=공유폴더 상대경로). 연결 해제해도 실제 파일은 안 지워진다(참조만 끊음).
function pjvFieldFilesEditor(anchor, t, field, value, persist) {
  let selected = Array.isArray(value) ? value.slice() : [];
  const B = '/api/ui/v6/projects/' + field.project_id;
  const wrap = el('div', { class: 'pjv-field-editor pjv-files-editor' });
  const close = pjvPopover(anchor, wrap);
  let curPath = '';
  let curData: any = null;
  const chips = el('div', { class: 'pjv-files-selected' });
  const crumb = el('div', { class: 'pjv-files-crumb' });
  const rowsBox = el('div', { class: 'pjv-files-browser' });
  const renderChips = () => {
    chips.replaceChildren(el('span', { class: 'pjv-files-sel-label', text: '연결된 파일 ' + selected.length + '개' }));
    for (const s of selected) {
      chips.append(el('span', { class: 'pjv-rel-chip removable' },
        el('button', { class: 'pjv-chip-dl', type: 'button', title: '다운로드', text: '↓', onclick: () => authDownload(B + '/file?download=1&path=' + encodeURIComponent(s.path), s.name) }),
        el('span', { class: 'pjv-files-name', text: s.name, title: s.path }),
        el('button', { class: 'pjv-rel-x', type: 'button', title: '연결 해제', text: '✕', onclick: () => { selected = selected.filter((x) => x.path !== s.path); persist(selected.length ? selected.slice() : null); renderChips(); refreshRows(); } })));
    }
  };
  const refreshRows = () => {
    rowsBox.replaceChildren();
    const items = (curData && curData.items) || [];
    if (!items.length) { rowsBox.append(el('div', { class: 'pjv-files-empty', text: '빈 폴더예요' })); return; }
    for (const it of items) {
      const childPath = curPath ? curPath + '/' + it.name : it.name;
      if (it.type === 'dir') {
        rowsBox.append(el('button', { class: 'pjv-files-row dir', type: 'button', onclick: () => { curPath = childPath; load(); } },
          fileIconSvg(it.name, true), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-chev', text: '›' })));
      } else {
        const on = selected.some((x) => x.path === childPath);
        const row = el('button', { class: 'pjv-files-row file' + (on ? ' on' : ''), type: 'button' },
          pjvCheckMini(on), fileIconSvg(it.name, false), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-size', text: fmtSize(it.size) }));
        row.onclick = () => {
          if (on) selected = selected.filter((x) => x.path !== childPath);
          else selected.push({ name: it.name, path: childPath, size: it.size });
          persist(selected.length ? selected.slice() : null);
          renderChips(); refreshRows();
        };
        rowsBox.append(row);
      }
    }
  };
  const renderCrumb = () => {
    crumb.replaceChildren(el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: '루트', onclick: () => { curPath = ''; load(); } }));
    let acc = '';
    for (const p of (curPath ? curPath.split('/') : [])) {
      acc = acc ? acc + '/' + p : p; const target = acc;
      crumb.append(el('span', { class: 'pjv-files-crumb-sep', text: '/' }), el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: p, onclick: () => { curPath = target; load(); } }));
    }
  };
  const load = async () => {
    rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '불러오는 중…' }));
    try { curData = await api(B + '/files?path=' + encodeURIComponent(curPath)); }
    catch (e) { curData = { items: [] }; renderCrumb(); rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '공유 폴더를 불러오지 못했어요' })); return; }
    renderCrumb(); refreshRows();
  };
  wrap.append(el('div', { class: 'pjv-files-head2', text: '공유 폴더에서 파일 선택' }), chips, crumb, rowsBox);
  renderChips(); load();
}

// 관계(태스크 연결) 필드 — 같은 프로젝트의 다른 태스크를 검색해 연결. 값=[{id, name}]. (link-targets 재활용)
function pjvFieldRelEditor(anchor, t, field, value, persist) {
  let linked = Array.isArray(value) ? value.slice() : [];
  const B = '/api/ui/v6/projects/' + field.project_id;
  const chips = el('div', { class: 'pjv-rel-chips' });
  const results = el('div', { class: 'pjv-rel-results' });
  const search = el('input', { type: 'text', class: 'pjv-field-input', placeholder: '연결할 태스크 검색…' });
  let timer: any = null;
  const renderChips = () => {
    chips.replaceChildren();
    if (!linked.length) { chips.append(el('span', { class: 'pjv-files-empty', text: '연결된 태스크가 없어요' })); return; }
    for (const r of linked) {
      chips.append(el('span', { class: 'pjv-rel-chip removable' }, el('span', { text: r.name || ('#' + r.id) }),
        el('button', { class: 'pjv-rel-x', type: 'button', title: '연결 해제', text: '✕', onclick: () => { linked = linked.filter((x) => x.id !== r.id); persist(linked.length ? linked.slice() : null); renderChips(); doSearch(); } })));
    }
  };
  const doSearch = async () => {
    let targets: any[] = [];
    try { const d = await api(B + '/link-targets?exclude=' + t.id + '&q=' + encodeURIComponent(search.value.trim())); targets = (d && d.targets) || []; }
    catch (e) { results.replaceChildren(el('div', { class: 'pjv-files-empty', text: '검색 실패' })); return; }
    const avail = targets.filter((x) => !linked.some((l) => l.id === x.id));
    results.replaceChildren();
    if (!avail.length) { results.append(el('div', { class: 'pjv-files-empty', text: '결과가 없어요' })); return; }
    for (const x of avail) {
      const row = el('button', { class: 'pjv-rel-result', type: 'button' },
        el('span', { class: 'pjv-rel-result-name', text: x.name }), el('span', { class: 'pjv-rel-add', text: '＋ 연결' }));
      row.onclick = () => { linked.push({ id: x.id, name: x.name }); persist(linked.slice()); renderChips(); doSearch(); };
      results.append(row);
    }
  };
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(doSearch, 220); };
  const wrap = el('div', { class: 'pjv-field-editor pjv-rel-editor' }, chips, search, results);
  const close = pjvPopover(anchor, wrap);
  renderChips(); doSearch();
  setTimeout(() => search.focus(), 0);
}

// 드롭다운 편집기 — 옵션 1개 선택 + 없음 + 즉석 옵션 추가.
function pjvFieldDropdownEditor(anchor, t, field, value, persist, reload) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  for (const o of (field.config && field.config.options) || []) {
    const sel = value === o.id;
    const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, pjvOptChip(o));
    item.onclick = () => { close(); persist(sel ? null : o.id); };
    menu.append(item);
  }
  const none = el('button', { class: 'pjv-menu-item' + (value == null ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
  none.onclick = () => { close(); if (value != null) persist(null); };
  menu.append(none);
  menu.append(pjvAddOptionRow(field, async (opt) => {
    close();
    try { await api('/api/ui/v6/tasks/' + t.id + '/fields/' + field.id, { method: 'POST', body: JSON.stringify({ value: opt.id }) }); } catch (_) { /* noop */ }
    pjvReloadKeepScroll(reload);  // 옵션 추가·선택 후 스크롤 보존(#459)
  }));
}

// 라벨 편집기 — 옵션 여러 개(토글, 즉시 저장·셀 실시간 갱신, 팝오버 유지) + 즉석 옵션 추가.
function pjvFieldLabelsEditor(anchor, t, field, value, persist, reload) {
  const selected = Array.isArray(value) ? value.slice() : [];
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  for (const o of (field.config && field.config.options) || []) {
    const item = el('button', { class: 'pjv-menu-item' + (selected.includes(o.id) ? ' sel' : ''), type: 'button' }, pjvCheckMini(selected.includes(o.id)), pjvOptChip(o));
    item.onclick = () => {
      const on = selected.includes(o.id);
      if (on) selected.splice(selected.indexOf(o.id), 1); else selected.push(o.id);
      item.classList.toggle('sel', !on);
      item.replaceChildren(pjvCheckMini(!on), pjvOptChip(o));
      persist(selected.length ? selected.slice() : null);
    };
    menu.append(item);
  }
  menu.append(pjvAddOptionRow(field, async (opt) => {
    close();
    try { await api('/api/ui/v6/tasks/' + t.id + '/fields/' + field.id, { method: 'POST', body: JSON.stringify({ value: [...selected, opt.id] }) }); } catch (_) { /* noop */ }
    pjvReloadKeepScroll(reload);  // 라벨 옵션 추가 후 스크롤 보존(#459)
  }));
}

// 즉석 옵션 추가 행 — 입력 + Enter. 필드 config 에 옵션 추가 후 onAdded(opt) 콜백.
function pjvAddOptionRow(field, onAdded) {
  const inp = el('input', { type: 'text', class: 'pjv-opt-add-input', placeholder: '＋ 옵션 추가', maxlength: '40' });
  const row = el('div', { class: 'pjv-opt-add' }, inp);
  inp.onclick = (e) => e.stopPropagation();
  inp.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    const label = inp.value.trim(); if (!label) return;
    inp.disabled = true;
    try { onAdded(await pjvAddFieldOption(field, label)); }
    catch (err) { toast('옵션 추가 실패 — ' + err.message, true); inp.disabled = false; }
  });
  return row;
}
async function pjvAddFieldOption(field, label) {
  const opts = (field.config && field.config.options) || [];
  const opt = { id: 'o' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), label: label.slice(0, 40), color: PJV_FIELD_PALETTE[opts.length % PJV_FIELD_PALETTE.length] };
  const config = Object.assign({}, field.config, { options: [...opts, opt] });
  await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ config }) });
  return opt;
}

// ── 컬럼 헤더(커스텀 필드) — 아이콘 + 이름 + ⋯ 메뉴(이름변경/옵션편집/삭제) ──
function pjvColumnHead(field, projectId, reload) {
  const nameEl = el('span', { class: 'pjv-thcol-name', text: field.name, title: field.name });
  pjvHeadSortable(nameEl, String(field.id)); // 클릭 정렬(#541) — field_values 값 기준
  const cell = el('div', { class: 'pjv-tcell pjv-thcol', 'data-col': 'f:' + field.id }, // data-col: 열 순서 드래그(#611)
    pjvFieldIcon(field.field_type, 'pjv-thcol-ic'), nameEl);
  // ClickUp 이관 컬럼(#541) — 정의는 커넥터 소유(이름변경·삭제 불가), 배지로 출처 표시. 폭 조절(#666)은 가능.
  if (field.readonlyDef) {
    cell.append(el('span', { class: 'pjv-thcol-src', text: 'CU', title: 'ClickUp에서 이관된 컬럼' }));
    cell.append(pjvColResizeHandle('f:' + field.id));
    return cell;
  }
  const menuBtn = el('button', { class: 'pjv-thcol-menu', type: 'button', text: '⋯', 'aria-label': field.name + ' 컬럼 설정' });
  menuBtn.onclick = (e) => { e.stopPropagation(); pjvColumnMenu(menuBtn, field, projectId, reload); };
  cell.append(menuBtn);
  cell.append(pjvColResizeHandle('f:' + field.id)); // 컬럼 폭 드래그(#666)
  return cell;
}
function pjvColumnMenu(anchor, field, projectId, reload) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  const mk = (label, fn, danger?) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
  menu.append(mk('이름 변경', () => pjvRenameColumn(anchor, field, reload)));
  const meta = PJV_FIELD_BY_KEY[field.field_type];
  if (meta && meta.config === 'options') menu.append(mk('옵션 편집', () => pjvEditColumnOptions(field, reload)));
  // #710 이 컬럼 숨기기 — 프로젝트 보드에서만(리스트 스코프면 그 리스트만·팀 공유, 아니면 보드 전역). 되살리기: 컬럼 추가(＋)→커스텀 필드.
  const _card = anchor.closest('.pjv-tasks-card');
  if (_card && _card.classList.contains('pjv-proj-card')) menu.append(mk('이 컬럼 숨기기', () => pjvSetStdColVisible('proj', 'f:' + field.id, false, _card)));
  menu.append(mk('컬럼 삭제', () => pjvDeleteColumn(field, reload), true));
}
function pjvRenameColumn(anchor, field, reload) {
  const input = el('input', { type: 'text', class: 'pjv-rename-input', value: field.name, maxlength: '120' });
  const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
  input.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); const v = input.value.trim(); close();
    if (v && v !== field.name) {
      try { await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ name: v }) }); pjvReloadKeepScroll(reload); /* 컬럼 이름변경 후 스크롤 보존(#459) */ }
      catch (err) { toast('수정 실패 — ' + err.message, true); }
    }
  };
  setTimeout(() => { input.focus(); input.select(); }, 0);
}
function pjvEditColumnOptions(field, reload) {
  const ob = pjvOptionsBuilder((field.config && field.config.options) || []);
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const back = overlayBox('옵션 편집 · ' + field.name,
    el('div', { class: 'field' }, ob.el),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  saveBtn.onclick = async () => {
    const options = ob.get();
    if (!options.length) { toast('옵션을 1개 이상 두세요', true); return; }
    saveBtn.disabled = true;
    const config = Object.assign({}, field.config, { options });
    try { await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ config }) }); back.remove(); pjvReloadKeepScroll(reload); /* 옵션 편집 후 스크롤 보존(#459) */ }
    catch (e) { toast('저장 실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}
function pjvDeleteColumn(field, reload) {
  if (!confirm("'" + field.name + "' 컬럼을 삭제할까요?\n\n이 컬럼의 모든 값이 함께 사라집니다.")) return;
  (async () => {
    try { await api('/api/ui/v6/fields/' + field.id + '/delete', { method: 'POST', body: JSON.stringify({}) }); toast('컬럼을 삭제했어요'); pjvReloadKeepScroll(reload); /* 컬럼 삭제 후 스크롤 보존(#459) */ }
    catch (e) { toast('삭제 실패 — ' + e.message, true); }
  })();
}

// ── 옵션 빌더(생성/편집 공용) — 색 점(클릭=색 순환)·라벨·삭제 + 추가. 기존 id 보존(값 깨짐 방지). ──
function pjvOptionsBuilder(initial) {
  const rows = el('div', { class: 'pjv-optb-rows' });
  const data: any[] = [];
  const addRow = (o) => {
    o = o || {};
    const item = { id: o.id || null, label: o.label || '', color: o.color || PJV_FIELD_PALETTE[data.length % PJV_FIELD_PALETTE.length] };
    data.push(item);
    let ci = Math.max(0, PJV_FIELD_PALETTE.indexOf(item.color));
    const dot = el('button', { class: 'pjv-optb-dot', type: 'button', style: '--opt:' + item.color, title: '색상 변경' });
    dot.onclick = () => { ci = (ci + 1) % PJV_FIELD_PALETTE.length; item.color = PJV_FIELD_PALETTE[ci]; dot.style.setProperty('--opt', item.color); };
    const inp = el('input', { type: 'text', class: 'pjv-optb-input', value: item.label, placeholder: '옵션 이름', maxlength: '40' });
    inp.oninput = () => { item.label = inp.value; };
    const rm = el('button', { class: 'pjv-optb-rm', type: 'button', text: '✕', title: '삭제' });
    const rowEl = el('div', { class: 'pjv-optb-row' }, dot, inp, rm);
    rm.onclick = () => { const i = data.indexOf(item); if (i >= 0) data.splice(i, 1); rowEl.remove(); };
    rows.append(rowEl);
  };
  (initial && initial.length ? initial : [{}, {}]).forEach(addRow);
  const addBtn = el('button', { class: 'pjv-optb-add', type: 'button', text: '＋ 옵션 추가', onclick: () => addRow(null) });
  return {
    el: el('div', { class: 'pjv-optb' }, rows, addBtn),
    get: () => data.filter((d) => d.label.trim()).map((d) => ({
      id: d.id || ('o' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)),
      label: d.label.trim().slice(0, 40), color: d.color,
    })),
  };
}

// ── (+) 컬럼 추가 버튼 + Fields 패널(클릭업형: 검색 · 새로 만들기/기존 항목 탭 · 형식 목록 · 설정 폼) ──
function pjvAddColumnButton(projectId, reload, listId?) {
  const btn = el('button', { class: 'pjv-addcol-btn', type: 'button', title: listId ? '이 리스트에 컬럼 추가' : '컬럼 추가', 'aria-label': '컬럼 추가' }, pjvPlusIcon());
  btn.onclick = (e) => { e.stopPropagation(); pjvOpenFieldsPanel(btn, projectId, reload, listId); };
  return btn;
}
function pjvOpenFieldsPanel(anchor, projectId, reload, listId?) {
  const panel = el('div', { class: 'pjv-fields-panel' });
  const close = pjvPopover(anchor, panel);
  // 이 +버튼이 속한 표(카드)로 surface 판별 — 기본 컬럼 보임/숨김 토글(되살리기)용(#req).
  const card = anchor.closest('.pjv-tasks-card');
  const surface = (card && card.classList.contains('pjv-proj-card')) ? 'proj' : 'task';
  let catalog: any = null;
  const showPicker = (tab) => {
    tab = tab || 'new';
    const search = el('input', { type: 'text', class: 'pjv-fields-search', placeholder: '필드 검색…' });
    const tNew = el('button', { class: 'pjv-fields-tab' + (tab === 'new' ? ' on' : ''), type: 'button', text: '새로 만들기', onclick: () => showPicker('new') });
    const tExist = el('button', { class: 'pjv-fields-tab' + (tab === 'existing' ? ' on' : ''), type: 'button', text: '기존 항목', onclick: () => showPicker('existing') });
    const list = el('div', { class: 'pjv-fields-list' });
    const _customSec = surface === 'proj' ? pjvCustomColsSection(card, reload) : null; // #710 확장 — 커스텀 필드 표시/숨김(프로젝트 보드)
    panel.replaceChildren(
      el('div', { class: 'pjv-fields-head' }, el('span', { class: 'pjv-fields-title', text: '필드' })),
      pjvDefaultColsSection(surface, card),
      ...(_customSec ? [_customSec] : []),
      search, el('div', { class: 'pjv-fields-tabs' }, tNew, tExist), list);
    const renderNew = () => {
      const qs = search.value.trim().toLowerCase();
      const matches = PJV_FIELD_TYPES.filter((f) => !qs || f.label.toLowerCase().includes(qs) || f.desc.toLowerCase().includes(qs) || f.key.includes(qs));
      list.replaceChildren();
      if (!matches.length) { list.append(el('div', { class: 'pjv-fields-empty', text: '일치하는 형식이 없어요' })); return; }
      list.append(el('div', { class: 'pjv-fields-sec', text: '필드 형식' }));
      for (const f of matches) {
        const row = el('button', { class: 'pjv-field-opt', type: 'button' },
          el('span', { class: 'pjv-field-opt-ic' }, pjvFieldIcon(f.key)),
          el('span', { class: 'pjv-field-opt-tx' }, el('span', { class: 'pjv-field-opt-name', text: f.label }), el('span', { class: 'pjv-field-opt-desc', text: f.desc })));
        row.onclick = () => panel.replaceChildren(pjvFieldConfigForm(projectId, f, reload, close, () => showPicker('new'), listId));
        list.append(row);
      }
    };
    const renderExisting = async () => {
      list.replaceChildren(el('div', { class: 'pjv-fields-empty', text: '불러오는 중…' }));
      if (catalog === null) { try { catalog = await api('/api/ui/v6/projects/' + projectId + '/field-catalog').then((d) => d.fields || []); } catch (_) { catalog = []; } }
      const qs = search.value.trim().toLowerCase();
      const matches = catalog.filter((c) => !qs || String(c.name).toLowerCase().includes(qs));
      list.replaceChildren();
      if (!matches.length) { list.append(el('div', { class: 'pjv-fields-empty', text: '다른 프로젝트에 만든 필드가 없어요' })); return; }
      for (const c of matches) {
        const meta = PJV_FIELD_BY_KEY[c.field_type];
        const row = el('button', { class: 'pjv-field-opt', type: 'button' },
          el('span', { class: 'pjv-field-opt-ic' }, pjvFieldIcon(c.field_type)),
          el('span', { class: 'pjv-field-opt-tx' }, el('span', { class: 'pjv-field-opt-name', text: c.name }), el('span', { class: 'pjv-field-opt-desc', text: meta ? meta.label : c.field_type })));
        row.onclick = () => pjvCreateField(projectId, { field_type: c.field_type, name: c.name, config: c.config || {}, list_id: listId || undefined }, reload, close); // #607/D 리스트별 필드
        list.append(row);
      }
    };
    search.oninput = () => { tab === 'new' ? renderNew() : renderExisting(); };
    (tab === 'new' ? renderNew : renderExisting)();
    setTimeout(() => search.focus(), 0);
  };
  showPicker('new');
}
// 형식 선택 후 설정 폼 — 이름 + (옵션/통화/별점) 설정 → 만들기.
function pjvFieldConfigForm(projectId, f, reload, close, back, listId?) {
  const wrap = el('div', { class: 'pjv-fcfg' });
  wrap.append(el('div', { class: 'pjv-fcfg-head' },
    el('button', { class: 'pjv-fcfg-back', type: 'button', text: '←', title: '뒤로', onclick: back }),
    el('span', { class: 'pjv-fcfg-ic' }, pjvFieldIcon(f.key)),
    el('span', { class: 'pjv-fcfg-title', text: f.label })));
  const nameIn = el('input', { type: 'text', class: 'pjv-fcfg-name', value: f.label, maxlength: '120', placeholder: '필드 이름' });
  wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '이름' }), nameIn);
  let getConfig: any = () => ({});
  if (f.config === 'options') {
    const ob = pjvOptionsBuilder([]);
    wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '옵션' }), ob.el);
    getConfig = () => ({ options: ob.get() });
  } else if (f.config === 'money') {
    const sel = el('select', { class: 'pjv-fcfg-sel' });
    for (const [code, c] of Object.entries(PJV_CURRENCIES)) sel.append(el('option', { value: code, text: c.label }));
    sel.value = 'KRW';
    wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '통화' }), sel);
    getConfig = () => ({ currency: sel.value, symbol: PJV_CURRENCIES[sel.value].symbol });
  } else if (f.config === 'rating') {
    const sel = el('select', { class: 'pjv-fcfg-sel' });
    for (const n of [3, 5, 10]) sel.append(el('option', { value: String(n), text: n + '점 만점' }));
    sel.value = '5';
    wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '별 개수' }), sel);
    getConfig = () => ({ max: Number(sel.value) });
  }
  const createBtn = el('button', { class: 'pjv-fcfg-create', type: 'button', text: '만들기' });
  createBtn.onclick = () => {
    const name = nameIn.value.trim() || f.label;
    const config = getConfig();
    if (f.config === 'options' && (!config.options || !config.options.length)) { toast('옵션을 1개 이상 추가하세요', true); return; }
    pjvCreateField(projectId, { field_type: f.key, name, config, list_id: listId || undefined }, reload, close); // #607/D 리스트별 필드
  };
  wrap.append(el('div', { class: 'pjv-fcfg-actions' }, createBtn, el('button', { class: 'pjv-fcfg-cancel', type: 'button', text: '취소', onclick: back })));
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
  return wrap;
}
async function pjvCreateField(projectId, payload, reload, close) {
  try { await api('/api/ui/v6/projects/' + projectId + '/fields', { method: 'POST', body: JSON.stringify(payload) }); if (close) close(); toast('컬럼을 추가했어요'); pjvReloadKeepScroll(reload); /* 컬럼 추가 후 스크롤 보존(#459) */ }
  catch (e) { toast('컬럼 추가 실패 — ' + e.message, true); }
}

// 더블클릭 → 하위 태스크 인라인 생성(클릭업식). 같은 행에 입력칸 1개만, Enter=생성, Esc/빈 blur=취소.
function pjvShowInlineSubtask(projectId, parentTask, subBox, reload) {
  const existing = subBox.querySelector('.pjv-subadd');
  if (existing) { const i = existing.querySelector('input'); if (i) i.focus(); return; }
  const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '하위 태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
  const row = el('div', { class: 'pjv-subadd' }, input);
  subBox.append(row);
  setTimeout(() => input.focus(), 0);
  let busy = false;
  input.addEventListener('blur', () => { if (!input.value.trim()) row.remove(); });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { input.value = ''; row.remove(); return; }
    if (e.key !== 'Enter') return;
    const name = input.value.trim(); if (!name || busy) return;
    busy = true; input.disabled = true;
    try { await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: parentTask.id }) }); pjvReloadKeepScroll(reload); /* 하위 추가 후 스크롤 보존(#459) */ }
    catch (err) { toast('추가 실패 — ' + err.message, true); input.disabled = false; busy = false; }
  });
}

// 태스크 섹션 — [태스크 N개][Closed 토글] 헤더 + 컬럼헤더 + 상태 그룹(할 일/진행 중/Closed). 클릭업식 리스트뷰.
//  할 일·진행 중은 비어도 항상 표시(인라인 추가행). Closed(완료) 그룹은 기본 숨김 — 헤더의 Closed 토글로만 노출.
//  fields = 커스텀 필드 정의(루트 프로젝트). 컬럼 헤더·각 행에 필드 셀을 끼우고 grid-template 을 동적으로.
function pjvTasksSection(projectId, tasks, members, reload, fields) {
  fields = fields || [];
  const card = el('div', { class: 'card pjv-tasks-card', style: 'margin-bottom:18px' });
  pjvInitNameResize(card, 'pjv:nameMin:task:' + projectId); // 이름칸 폭 드래그 저장/복원 — 프로젝트별(#483)
  pjvApplyHiddenCols(card, 'task'); // 숨긴 기본 컬럼 복원(#req)
  pjvApplyColWidths(card, 'task'); // 저장된 컬럼 폭 복원(#666)

  // Closed 토글 버튼 — 누르면 태스크/하위태스크 popover. 활성(노출 중) 시 파란 강조.
  const closedBtn = el('button', { class: 'pjv-closed-btn', type: 'button', title: '닫힌(완료) 항목 표시' },
    pjvCheckCircle(), el('span', { text: 'Closed' }));
  const syncBtn = () => closedBtn.classList.toggle('active', pjvClosedView.tasks || pjvClosedView.subtasks);
  syncBtn();

  // 본문 — Closed 토글 시 서버 재요청 없이 즉시 재렌더(이미 받은 tasks 를 필터).
  const body = el('div', { class: 'pjv-tasks-body' });
  const renderGroups = () => {
    body.replaceChildren();
    if (!tasks.length) {
      body.append(el('div', { class: 'pjv-empty-hint' },
        el('b', { text: '아직 태스크가 없어요.' }),
        ' 아래 ', el('span', { class: 'pjv-empty-chip', text: '＋ 태스크' }),
        ' 를 눌러 이름을 적고 Enter — 첫 할 일을 추가하세요.'));
    }
    // 별도 컬럼헤더 행 없음 — 컬럼 라벨은 첫(맨 위) 그룹 헤더에 합친다(withCols).
    const buckets = { todo: [], in_progress: [], done: [] };
    const sep = pjvSubtaskMode.mode === 'separate';
    for (const t of tasks) {
      buckets[pjvStatusMeta(t.status).bucket].push(t);
      if (sep) for (const s of (t.subtasks || [])) {
        if (!pjvClosedView.subtasks && s.status === 'done') continue;
        buckets[pjvStatusMeta(s.status).bucket].push(s);
      }
    }
    let firstShown = true;
    for (const key of ['in_progress', 'todo', 'done']) { // 진행 중을 할 일 위로(기본 레이아웃)
      if (key === 'done' && !pjvClosedView.tasks) continue; // Closed 그룹은 토글 시에만 노출
      body.append(pjvStatusGroup(projectId, key, buckets[key], members, reload, fields, firstShown));
      firstShown = false;
    }
  };

  // Closed 버튼 = 직접 토글. 한 번 누르면 닫힌(완료) 태스크가 보이고 버튼이 활성(파란) 상태, 다시 누르면 숨김.
  //  하위 닫힘 항목도 함께 따라오게 묶는다(Closed = '닫힌 것 보기' 한 동작).
  closedBtn.onclick = (e) => {
    e.stopPropagation();
    const nv = !pjvClosedView.tasks;
    pjvClosedView.tasks = nv;
    pjvClosedView.subtasks = nv;
    syncBtn();
    renderGroups();
  };

  // 좌상단 하위 태스크(Subtasks) 버튼 — 접힘/펼침/분리. 활성(펼침·분리) 시 파란 강조. (Closed 는 우측 유지)
  const subtaskBtn = el('button', { class: 'pjv-subtask-btn', type: 'button', title: '하위 태스크 표시 방식' },
    pjvSubtaskIcon(), el('span', { class: 'pjv-subtask-btn-label', text: PJV_SUBTASK_BTNLABEL[pjvSubtaskMode.mode] }));
  const syncSubBtn = () => {
    subtaskBtn.classList.toggle('active', pjvSubtaskMode.mode !== 'collapsed');
    const lbl = subtaskBtn.querySelector('.pjv-subtask-btn-label');
    if (lbl) lbl.textContent = PJV_SUBTASK_BTNLABEL[pjvSubtaskMode.mode];
  };
  syncSubBtn();
  subtaskBtn.onclick = (e) => { e.stopPropagation(); pjvSubtaskMenu(subtaskBtn, () => { syncSubBtn(); renderGroups(); }); };
  card.append(el('div', { class: 'card-head' },
    el('div', { class: 'pjv-tasks-head-left' }, el('h2', { text: '태스크' }), subtaskBtn),
    el('div', { class: 'card-head-actions' },
      closedBtn)));
  card.append(body);
  renderGroups();
  return card;
}

// 상태 그룹 — head(캐럿·점·라벨·개수) + body(행들 + 인라인 추가행). 완료 그룹엔 추가행 없음.
// withCols=true 면(첫 그룹) 별도 컬럼헤더 행 대신 이 그룹 헤더에 컬럼 라벨(담당자/마감일/우선순위+커스텀)을 합쳐 컬럼 위에 정렬한다.
function pjvStatusGroup(projectId, key, list, members, reload, fields, withCols) {
  const m = PJV_TASK_STATUS[key];
  const body = el('div', { class: 'pjv-tgroup-body' });
  for (const t of list) body.append(pjvTaskRow(projectId, t, members, reload, 0, fields));
  const countEl = el('span', { class: 'pjv-tgroup-count', text: String(list.length) });
  if (key !== 'done') body.append(pjvAddRow(projectId, key, members, reload, body, countEl, fields));

  // 태스크 상태 그룹 접힘도 새로고침에 유지(#req) — 프로젝트 스코프('p'+id 로 리스트 id 와 네임스페이스 분리). 기본 펼침.
  let gopen = pjvGrpOpenGet('p' + projectId, key);
  body.hidden = !gopen;
  const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: gopen ? '▾' : '▸', 'aria-expanded': String(gopen) });
  gcaret.onclick = () => {
    gopen = !gopen; gcaret.textContent = gopen ? '▾' : '▸';
    gcaret.setAttribute('aria-expanded', gopen ? 'true' : 'false'); body.hidden = !gopen;
    pjvGrpOpenSet('p' + projectId, key, gopen);
  };
  const dot = pjvStatusIconStd(key, 'sm');
  const labelEl = el('span', { class: 'pjv-tgroup-label', text: m.label });

  let head: any;
  if (withCols) {
    // 컬럼 라벨을 행 그리드에 맞춰 헤더에 합침(별도 thead 없음). 좌측 첫 칸 = 그룹 라벨(+#664 전체선택 체크박스).
    head = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols ' + m.cls },
      el('div', { class: 'pjv-trow-title-cell' }, pjvGroupCheck('task', body), dot, labelEl, countEl, gcaret, pjvNameResizeHandle()),
      pjvStdColHead('task', 'assignee', '담당자'),
      pjvStdColHead('task', 'due', '마감일'),
      pjvStdColHead('task', 'priority', '우선순위'),
      ...(fields || []).map((f) => pjvColumnHead(f, projectId, reload)),
      el('div', { class: 'pjv-tcell pjv-tcell-add' }, pjvAddColumnButton(projectId, reload)));
    head.style.gridTemplateColumns = pjvGridTemplate(fields);
  } else {
    // 컬럼 없는 그룹(할 일/완료)도 첫 그룹(진행 중, withCols)과 같은 제목칸 구조(체크박스+점+라벨)를
    // 써서 그룹 헤더의 가로 들여쓰기·정렬이 그룹마다 동일하게 보이도록 한다(#295).
    head = el('div', { class: 'pjv-tgroup-head ' + m.cls },
      el('div', { class: 'pjv-trow-title-cell' },
        pjvGroupCheck('task', body), dot, labelEl, countEl, gcaret));
  }
  return el('div', { class: 'pjv-tgroup' }, head, body);
}

// 인라인 추가행(클릭업식) — 클릭→입력칸, Enter=생성(연속 추가 위해 입력 유지·낙관적 삽입), Esc/빈 blur=접기.
//  생성은 그 그룹 상태로(todo 외엔 생성 후 status 패치). 모달 없이 그 자리에서 바로.
function pjvAddRow(projectId, status, members, reload, body, countEl, fields) {
  const row = el('div', { class: 'pjv-addrow' });
  let indentParent: any = null; // Tab 들여쓰기 — 바로 위 상위태스크의 하위로 만들 때 그 부모 {id,name}. Shift+Tab 으로 해제.
  const trigger = el('button', { class: 'pjv-addrow-trigger', type: 'button', 'data-tour': 'pd-add-task' },   // #853 '프로젝트 체험' 투어 앵커
    el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '태스크' }));
  const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
  // 생성 전 드래프트 — 담당자·마감·우선순위를 미리 지정해 생성 직후 한 번에 적용(클릭업식). 셀은 행과 동일.
  const draft = { assignee: null, due_date: null, priority: null };
  const cAssignee = el('div', { class: 'pjv-tcell' });
  const cDue = el('div', { class: 'pjv-tcell' });
  const cPriority = el('div', { class: 'pjv-tcell' });
  const setDraft = (p) => { Object.assign(draft, p); paintCells(); setTimeout(() => { if (row.classList.contains('editing')) input.focus(); }, 0); };
  function paintCells() {
    cAssignee.replaceChildren(pjvAssigneeControl(draft, members, (p) => { Object.assign(draft, p); }));
    cDue.replaceChildren(pjvDueControl(draft, setDraft));
    cPriority.replaceChildren(pjvPriorityControl(draft, setDraft));
  }
  const collapse = () => { row.classList.remove('editing'); draft.assignee = draft.due_date = draft.priority = null; indentParent = null; row.replaceChildren(trigger); };
  // 추가행 제목 칸 — 실제 태스크 행과 동일 구조(캐럿 자리 + 상태 동그라미 + 입력)로 그린다. 들여쓰면 paddingLeft 22px(하위 위치)
  //  + 상태 동그라미는 todo(점선). 안 들여쓰면 그룹 상태 동그라미. → 입력 텍스트·동그라미가 행과 픽셀 단위로 정확히 일치.
  const statusDotPlaceholder = (st) => pjvStatusIconStd(pjvStatusMeta(st).bucket);
  const buildTitleCell = () => {
    // 실제 태스크 행 제목칸 맨 앞에는 선택 체크박스(.pjv-row-check, 16px)가 있다. 추가행에도 같은 폭의
    // 스페이서를 둬서 입력 글자가 시작되는 들여쓰기 위치를 행 제목과 정확히 같게 한다(#292).
    const tc = el('div', { class: 'pjv-trow-title-cell' },
      el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }),
      el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' }),
      statusDotPlaceholder(indentParent ? 'todo' : status),
      input);
    if (indentParent) tc.style.paddingLeft = '22px';
    return tc;
  };
  // 펼침: 태스크 행과 동일한 그리드 — 이름 입력 + 담당자·마감·우선순위 드래프트 셀(생성 시 적용). 커스텀 필드는 생성 후 행에서.
  const expand = () => {
    row.classList.add('editing');
    row.style.gridTemplateColumns = pjvGridTemplate(fields);
    paintCells();
    row.replaceChildren(
      buildTitleCell(),
      cAssignee, cDue, cPriority,
      ...(fields || []).map(() => el('div', { class: 'pjv-tcell' })),
      el('div', { class: 'pjv-tcell pjv-tcell-add' }));
    input.focus();
  };
  trigger.onclick = expand;
  // Tab 들여쓰기 시각화 — 제목 칸을 한 단 들이고(하위 느낌) 안내문을 부모 이름으로 바꾼다.
  const applyIndent = () => {
    const old = row.querySelector('.pjv-trow-title-cell');
    if (old) old.replaceWith(buildTitleCell()); // 캐럿+동그라미+들여쓰기까지 하위태스크 행과 동일하게 다시 그림
    input.placeholder = indentParent
      ? ('“' + (indentParent.name || '상위 태스크') + '” 의 하위 — 이름 입력 후 Enter (Shift+Tab 해제)')
      : '태스크 이름 입력 후 Enter (Esc 취소)';
    input.focus();
  };
  let busy = false;
  // 생성 — Enter(keepOpen=연속추가) 또는 바깥클릭. 생성 후 드래프트(담당자·마감·우선순위)를 한 번에 패치.
  const commit = async (keepOpen) => {
    if (busy) return;
    const name = input.value.trim();
    if (!name) { if (!keepOpen) collapse(); return; }
    busy = true; input.disabled = true;
    if (indentParent) {
      // Tab 들여쓰기 — 위 상위태스크의 하위로 생성. 생성 후 reload 로 중첩 반영(부모 caret·하위수 갱신).
      try { await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: indentParent.id }) }); pjvReloadKeepScroll(reload); /* 들여쓰기 하위 추가 후 스크롤 보존(#459) */ }
      catch (err) { toast('하위 추가 실패 — ' + err.message, true); input.disabled = false; busy = false; }
      return;
    }
    try {
      const created = await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => d && d.task);
      if (created && status !== 'todo') {
        await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify({ status }) }).catch(() => {});
      }
      const patch: any = {};
      if (draft.assignee) patch.assignee = draft.assignee;
      if (draft.due_date) patch.due_date = draft.due_date;
      if (draft.priority) patch.priority = draft.priority;
      if (created && Object.keys(patch).length) {
        await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
      }
      const t = Object.assign({ priority: null, assignee: null, due_date: null }, created, patch, { status, subtasks: [], field_values: {} });
      body.insertBefore(pjvTaskRow(projectId, t, members, reload, 0, fields), row);
      if (countEl) countEl.textContent = String((parseInt(countEl.textContent, 10) || 0) + 1);
      const card = row.closest('.pjv-tasks-card');
      const hint = card && card.querySelector('.pjv-empty-hint');
      if (hint) hint.remove();
      input.value = ''; input.disabled = false; busy = false;
      draft.assignee = draft.due_date = draft.priority = null; paintCells();
      if (keepOpen) input.focus(); else collapse();
    } catch (err) { toast('추가 실패 — ' + err.message, true); input.disabled = false; busy = false; }
  };
  // 바깥클릭(=커밋) 가드 — 셀 팝오버 편집 중이거나 행 내부 포커스면 보류(드래프트 설정 중 조기 생성 방지).
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (busy || !row.classList.contains('editing')) return;
      if (document.querySelector('.pjv-pop')) return;        // 셀 팝오버 편집 중
      if (row.contains(document.activeElement)) return;       // 행 내부 포커스(셀 버튼 등)
      commit(false);
    }, 130);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; collapse(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) { if (indentParent) { indentParent = null; applyIndent(); input.focus(); } return; }
      // 들여쓰기 — 바로 위 상위태스크를 부모로(클릭업식). 위에 (상위)태스크가 없으면 무시.
      const prev = row.previousElementSibling;
      const pid = prev && prev.dataset ? prev.dataset.taskId : null;
      if (pid && prev.dataset.taskLevel !== 'subtask') { indentParent = { id: Number(pid), name: prev.dataset.taskName || '' }; applyIndent(); input.focus(); }
      return;
    }
    // 한글(IME) 조합 중 Enter 는 글자 확정용 — 그때 생성하면 마지막 글자가 중복된 이름이 만들어진다(#293 와 동일 버그).
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); commit(true); }
  });
  collapse();
  return row;
}

// 행 오른쪽 끝 ⋯ 더보기 메뉴(클릭업식) — 하위 태스크 추가(상위만)·이름 변경·삭제.
function pjvRowMore(projectId, t, depth, reload, onAddSub) {
  const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '더보기', 'aria-label': '태스크 작업' , text: '⋯' });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    const mkItem = (label, onPick, danger?) => {
      const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label }));
      b.onclick = () => { close(); onPick(); };
      return b;
    };
    if (depth === 0 && onAddSub) menu.append(mkItem('하위 태스크 추가', onAddSub));
    menu.append(mkItem('이름 변경', () => pjvRenameTask(btn, t, reload)));
    menu.append(mkItem('삭제', () => pjvDeleteTask(t, reload), true));
  };
  return btn;
}

// 이름 변경 — 앵커 아래 인라인 입력 팝오버. Enter 저장 / Esc·바깥클릭 취소.
function pjvRenameTask(anchor, t, reload) {
  const cur = t.name || t.title || '';
  const input = el('input', { type: 'text', class: 'pjv-rename-input', value: cur, maxlength: '200' });
  const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); close(); if (v && v !== cur) pjvPatchTask(t.id, { name: v }, reload); }
  };
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

// 삭제 — 확인 후 task_delete_v6. 하위 동반 삭제 경고. #/trash 복원 가능.
function pjvDeleteTask(t, reload) {
  const nm = t.name || t.title || '이 태스크';
  const nSub = (t.subtasks || []).length;
  const msg = "'" + nm + "' 태스크를 삭제할까요?" + (nSub ? '\n\n하위 ' + nSub + '개도 함께 삭제됩니다.' : '') + '\n\n#/trash 에서 복원할 수 있습니다.';
  if (!confirm(msg)) return;
  (async () => {
    try {
      await api('/api/ui/v6/tasks/' + t.id + '/delete', { method: 'POST', body: JSON.stringify({}) });
      toast('삭제했습니다 — #/trash 에서 복원 가능');
      pjvReloadKeepScroll(reload);  // 태스크 삭제 후 위로 튀지 않게 스크롤 보존(#459)
    } catch (e) { toast('삭제 실패 — ' + e.message, true); }
  })();
}

// 태스크 한 행 — [캐럿][상태점] 제목 [하위수] | 담당자 | 마감일 | 우선순위 | [⋯]. 하위는 중첩(상위만 하위 추가 가능).
function pjvTaskRow(projectId, t, members, reload, depth, fields) {
  depth = depth || 0;
  fields = fields || [];
  // 닫힌(완료) 하위는 Closed>하위태스크 토글 시에만 노출(클릭업 동형). separate 모드면 하위는 최상위 행으로 빠져 중첩 X.
  const allSubs = t.subtasks || [];
  const subsVisible = pjvClosedView.subtasks ? allSubs : allSubs.filter((s) => s.status !== 'done');
  const subs = pjvSubtaskMode.mode === 'separate' ? [] : subsVisible;
  const isDone = t.status === 'done';
  const wrap = el('div', { class: 'pjv-trow-wrap', 'data-task-id': t.id, 'data-task-name': t.name || t.title || '', 'data-task-level': t.level || 'task' });

  let open = false;
  const caret = subs.length
    ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸' })
    : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });

  // el() 로 구성 — null 자식을 건너뛴다(네이티브 .append(null) 은 "null" 텍스트를 삽입하므로 금지).
  // 태그 칩(클릭업식) — 이름 옆에 최대 2개 + 나머지는 "+N". 색은 태그 색.
  const tagsEl = pjvRowTagsEl(t, reload);
  const subcountEl = subs.length ? el('span', { class: 'pjv-trow-subcount pjv-subcount-ico clickable', role: 'button', tabindex: '0', title: subs.length + '개 하위 — 클릭하여 펼치기' },
    pjvSubtaskIcon(), el('span', { text: String(subs.length) })) : null;
  const titleCell = el('div', { class: 'pjv-trow-title-cell' },
    pjvRowGrip('task', t, { reload }), // 좌측 드래그 핸들(#366) — 잡고 끌어 순서 변경
    pjvRowCheck('task', t, { reload, projectId, members }),
    caret, pjvStatusControl(t, reload, projectId),
    el('span', { class: 'pjv-trow-title' + (isDone ? ' done' : ''), text: t.name || t.title || '(제목 없음)' }),
    subcountEl,
    tagsEl);
  if (depth) titleCell.style.paddingLeft = (depth * 22) + 'px';

  // 하위 영역 — 하위 행도 pjvTaskRow 재귀라 담당자·마감일·우선순위·커스텀필드까지 상위와 완전 동일하게 동작.
  const subBox = el('div', { class: 'pjv-trow-subs' });
  subBox.hidden = true;
  if (subs.length && depth < 4) {
    for (const s of subs) subBox.append(pjvTaskRow(projectId, s, members, reload, depth + 1, fields));
    const toggle = () => {
      open = !open; caret.textContent = open ? '▾' : '▸';
      caret.setAttribute('aria-expanded', open ? 'true' : 'false'); subBox.hidden = !open;
    };
    caret.onclick = toggle;
    if (subcountEl) {
      subcountEl.onclick = (e) => { e.stopPropagation(); toggle(); };
      subcountEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); } };
    }
    // 펼침 모드 — 모든 하위를 처음부터 펼쳐 보여준다(개별 caret 으로 다시 접을 수 있음).
    if (pjvSubtaskMode.mode === 'expanded') { open = true; subBox.hidden = false; caret.textContent = '▾'; caret.setAttribute('aria-expanded', 'true'); }
  }

  // ⋯메뉴 '하위 태스크 추가'(상위 depth 0 만) → 부모 아래 인라인 입력행 펼치고 포커스. 모달/박스 없음.
  let subAddRow: any = null;
  const startAddSub = () => {
    subBox.hidden = false; open = true;
    if (caret.tagName === 'BUTTON') { caret.textContent = '▾'; caret.setAttribute('aria-expanded', 'true'); }
    if (!subAddRow) {
      const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '하위 태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
      const tcell = el('div', { class: 'pjv-trow-title-cell' }, input);
      tcell.style.paddingLeft = ((depth + 1) * 22) + 'px';
      subAddRow = el('div', { class: 'pjv-addrow editing pjv-subaddrow' }, tcell,
        el('div', { class: 'pjv-tcell' }), el('div', { class: 'pjv-tcell' }), el('div', { class: 'pjv-tcell' }),
        ...fields.map(() => el('div', { class: 'pjv-tcell' })),
        el('div', { class: 'pjv-tcell pjv-tcell-add' }));
      subAddRow.style.gridTemplateColumns = pjvGridTemplate(fields);
      let busy = false;
      const remove = () => { if (subAddRow) { subAddRow.remove(); subAddRow = null; } };
      const commit = async () => {
        if (busy) return; const name = input.value.trim();
        if (!name) { remove(); return; }
        busy = true; input.disabled = true;
        try {
          await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: t.id }) });
          pjvReloadKeepScroll(reload);  // 하위 태스크 추가 후 스크롤 보존(#459)
        } catch (err) { toast('하위 추가 실패 — ' + err.message, true); input.disabled = false; busy = false; }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { input.value = ''; remove(); }
        else if (e.key === 'Enter') { e.preventDefault(); commit(); }
      });
      subBox.append(subAddRow);
    }
    const inp = subAddRow.querySelector('input'); if (inp) inp.focus();
  };

  const moreBtn = pjvRowMore(projectId, t, depth, reload, (depth === 0 && t.level !== 'subtask') ? startAddSub : null);

  // 제목 우측 호버 아이콘 3개(클릭업식) — 하위 추가(상위만)·태그 편집·이름 변경. startAddSub 정의 후 붙인다.
  titleCell.append(pjvRowActions([
    (t.level !== 'subtask') ? { title: '하위 태스크 추가', icon: 'add', fn: () => startAddSub() } : null,
    { title: '태그 편집', icon: 'tag', fn: (b) => pjvTagPopover(b, t, reload) },
    { title: '이름 변경', icon: 'rename', fn: (b) => pjvRenameTask(b, t, reload) },
  ]));

  const rowEl = el('div', { class: 'pjv-trow' },
    titleCell,
    el('div', { class: 'pjv-tcell' }, pjvAssigneeControl(t, members, (p) => pjvSaveTask(t.id, p))),
    el('div', { class: 'pjv-tcell' }, pjvDueControl(t, (p) => pjvPatchTask(t.id, p, reload))),
    el('div', { class: 'pjv-tcell' }, pjvPriorityControl(t, (p) => pjvPatchTask(t.id, p, reload))),
    ...fields.map((f) => el('div', { class: 'pjv-tcell pjv-fcell' }, pjvFieldControl(t, f, reload))),
    el('div', { class: 'pjv-tcell pjv-tcell-add' }, moreBtn));
  rowEl.style.gridTemplateColumns = pjvGridTemplate(fields);
  wrap.append(rowEl);
  wrap.append(subBox);
  return wrap;
}

// 태스크/하위 추가 폼 — 이름(필수)·설명(선택). parentTaskId 있으면 하위로 생성(parent_task_id).
function pjvAddTask(projectId, parentTaskId, reload) {
  const nameIn = el('input', { type: 'text', placeholder: parentTaskId ? '하위 태스크 이름' : '태스크 이름', maxlength: '200' });
  const descIn = el('textarea', { rows: '2', placeholder: '설명 (선택)', maxlength: '4000' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '추가' });
  const back = overlayBox(parentTaskId ? '하위 태스크 추가' : '새 태스크',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({
        name, description: descIn.value.trim() || undefined,
        parent_task_id: parentTaskId != null ? parentTaskId : undefined,
      }) });
      back.remove();
      toast(parentTaskId ? '하위 태스크를 추가했습니다' : '태스크를 추가했습니다');
      pjvReloadKeepScroll(reload);  // 태스크 추가 후 스크롤 보존(#459)
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// 전체 작업 로그(대시보드 ④ 의 ⤢ 팝업) — 회사 전체 활동 피드 + 유형 칩 필터.
//  #852: 예전엔 200건을 받아 놓고도 **6개만** 그리고 '＋N개 더 보기'로 10개씩 늘렸다 —
//  큰 팝업을 열었는데 여섯 줄만 보이니 "한 번에 좀 보여 달라"가 됐다. 이제 받은 만큼 **다 그리고**
//  모달 안에서 스크롤로 읽는다(행 상세는 펼칠 때 만드는 lazy 라 수백 행이어도 가볍다).
//  더 과거는 #709 표준(limit/offset)으로 이어 붙인다.
const CTL_PAGE = 200;
function companyTimelineSection() {
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const st = { type: '' };
  let members: any[] = [];
  let acts: any[] = [];
  let atEnd = false;              // 마지막 페이지까지 받음 → '더 불러오기' 숨김
  const nameOf = (pid) => { const m = members.find((x) => x.id === pid); return (m && m.display_name) || pid || '—'; };
  const TYPES = [['', '전체'], ['feature', '기능'], ['fix', '수정'], ['decision', '결정'], ['docs', '문서'], ['research', '리서치'], ['review', '검토'], ['chore', '운영'], ['other', '기타']];
  const chipsBar = el('div', { class: 'proj-tl-filter' });
  const paintChips = () => chipsBar.replaceChildren(...TYPES.map(([v, label]) =>
    el('button', { class: 'proj-tl-chip' + (st.type === v ? ' active' : ''), text: label, onclick: () => { st.type = v; paintChips(); load(); } })));
  paintChips();
  card.append(chipsBar, body);
  api('/api/ui/dash/members').then((d) => { members = (d && d.members) || []; if (acts.length) render(); }).catch(() => {});
  load();
  return card;

  async function load(more?: boolean) {
    if (!more) { acts = []; atEnd = false; body.replaceChildren(skeletonRows(6)); }
    try {
      const qs = '?limit=' + CTL_PAGE + '&offset=' + acts.length + (st.type ? '&type=' + encodeURIComponent(st.type) : '');
      const got = await api('/api/ui/activity/list' + qs).then((d) => (Array.isArray(d) ? d : (d && d.rows) || []));
      if (got.length < CTL_PAGE) atEnd = true;      // 덜 왔다 = 마지막 페이지
      acts = acts.concat(got);
    } catch (e) { body.replaceChildren(errorNote(e, '작업을 불러오지 못했습니다')); return; }
    render();
  }
  function render() {
    if (!acts.length) { body.replaceChildren(el('div', { class: 'empty', text: '아직 기록된 작업이 없습니다.' })); return; }
    body.replaceChildren(el('div', { class: 'proj-tl-count', text: acts.length + '개' + (atEnd ? '' : '+') + ' · 작업을 누르면 상세가 펼쳐집니다' }),
      el('div', { class: 'proj-tl-list' }, ...acts.map(actRow)));
    if (!atEnd) {
      const more = el('button', { class: 'btn btn-ghost btn-sm proj-tl-more', text: '이전 작업 더 불러오기' });
      more.onclick = () => { more.disabled = true; more.textContent = '불러오는 중…'; load(true); };
      body.append(more);
    }
  }
  function actRow(a) { return activityTimelineRow(a, nameOf); }
}

// 한 섹션(진행 중 / 완료) — 카드 + 개수 배지 + 행 리스트(비었으면 안내).
function projectSection(label, list, emptyText, reload, done, opts) {
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' },
    el('div', { class: 'card-head' },
      el('h3', { class: 'project-sec-title' }, label,
        el('span', { class: 'project-count', text: String(list.length) }))));
  if (!list.length) { card.append(el('div', { class: 'empty', text: emptyText })); return card; }
  card.append(el('div', { class: 'project-grid' + (done ? ' done' : '') }, ...list.map((p) => projectTile(p, reload, opts))));
  return card;
}

// 프로젝트 타일 카드 — 이름·설명·팀원 아바타(facepile)·메타 + 상태 토글. 카드 클릭=상세.
//  opts.statusBase / opts.detailBase 로 v1(/api/ui/projects, #/projects)·v6(/api/ui/v6/projects, #/projects2/p) 공용.
function projectTile(p, reload, opts) {
  const statusBase = (opts && opts.statusBase) || '/api/ui/projects/';
  const detailBase = (opts && opts.detailBase) || '#/projects/';
  const select = opts && opts.select;             // 선택(일괄삭제) 모드 — 있으면 클릭=체크 토글, 상태 토글 숨김.
  const selectable = !!select && select.canSelect(p); // 내가 만든 것만 선택 가능.
  const isDone = p.status === 'done';
  const tile = el('div', { class: 'project-tile' + (isDone ? ' done' : '') + (select ? ' select-mode' : '') });

  if (select && selectable) {
    tile.classList.add('selectable');
    const cb = el('span', { class: 'project-tile-check', 'aria-hidden': 'true' });
    const apply = (on) => { tile.classList.toggle('selected', on); cb.textContent = on ? '✓' : ''; tile.setAttribute('aria-checked', on ? 'true' : 'false'); };
    apply(select.ids.has(p.id));
    tile.append(cb);
    tile.setAttribute('role', 'checkbox');
    tile.setAttribute('tabindex', '0');
    const toggle = () => { const on = !select.ids.has(p.id); if (on) select.ids.add(p.id); else select.ids.delete(p.id); apply(on); select.onToggle(); };
    tile.addEventListener('click', toggle);
    tile.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  } else if (select) {
    // 선택 모드지만 내 프로젝트 아님 — 선택 불가(흐리게), 클릭은 상세로.
    tile.classList.add('not-selectable');
    tile.addEventListener('click', () => { location.hash = detailBase + p.id; });
  } else {
    // 완료 카드는 비활성 느낌 — 전체클릭 대신 아래 '보기' 버튼으로 접근. 활성 카드만 전체클릭=상세.
    if (!isDone) tile.addEventListener('click', () => { location.hash = detailBase + p.id; });
  }

  tile.append(el('div', { class: 'project-tile-name', text: p.name }));
  if (p.description) tile.append(el('div', { class: 'project-tile-desc', text: p.description }));

  const members = p.members || [];
  if (members.length) {
    const faces = el('div', { class: 'project-tile-faces' });
    for (const m of members.slice(0, 5)) {
      faces.append(personFace(m.member_id, 'project-face', m.display_name || m.member_id));
    }
    if (members.length > 5) faces.append(el('span', { class: 'project-face more', text: '+' + (members.length - 5) }));
    tile.append(faces);
  }

  const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
  const meta = el('div', { class: 'project-tile-meta', text: (isDone ? '완료 ' : '갱신 ') + (when ? relTime(when) : '') });
  const foot = el('div', { class: 'project-tile-foot' }, meta);
  if (!select) {
    // 비선택 모드만 상태 토글 노출 — 선택 모드에선 카드 클릭(=체크)과 충돌 방지 위해 숨김.
    const changeStatus = async (ev, status, okMsg) => {
      ev.stopPropagation();
      const btn = ev.currentTarget; btn.disabled = true;
      try {
        await api(statusBase + p.id + '/status', { method: 'POST', body: JSON.stringify({ status }) });
        toast(okMsg); reload();
      } catch (e) { toast('실패 — ' + e.message, true); btn.disabled = false; }
    };
    if (isDone) {
      // 완료 카드 — '보기'(상세 접근) + '진행 중으로'(재개). 둘 다 ghost(파란 강조 없음, 비활성 톤 유지).
      const viewBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '보기',
        onclick: (ev) => { ev.stopPropagation(); location.hash = detailBase + p.id; } });
      const reBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '진행 중으로',
        onclick: (ev) => changeStatus(ev, 'active', '진행 중으로 옮겼습니다') });
      foot.append(el('div', { class: 'project-tile-acts' }, viewBtn, reBtn));
    } else {
      const toggle = el('button', { class: 'btn btn-sm btn-primary', text: '완료',
        onclick: (ev) => changeStatus(ev, 'done', '완료로 표시했습니다') });
      foot.append(toggle);
    }
  } else if (!selectable) {
    foot.append(el('span', { class: 'project-tile-mine-no', text: '내 프로젝트 아님' }));
  }
  tile.append(foot);
  return tile;
}

// 팀원 선택 위젯 — 이름 검색으로 하나씩 추가(클릭), 선택된 사람은 칩으로(× 제거). 생성·수정 공용.
//  동기 반환(즉시 로딩표시) + 비동기 채움. getSelected() 가 현재 선택 id 배열.
function memberPicker(preselected, opts?) {
  opts = opts || {};
  const selected = new Set(preselected || []);
  const fire = () => { try { opts.onChange && opts.onChange(); } catch (_) { /* */ } };
  let all: any[] = [];
  // 단일 목록 — 선택된 사람도 위쪽 별도 chips 없이 이 목록에서 체크로 표시하고 클릭으로 토글(해제)한다(#475: 중복 표시 제거).
  const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '이름으로 검색…' });
  const count = el('div', { class: 'proj-mp-count' });
  const results = el('div', { class: 'proj-mp-results' }, el('span', { class: 'admin-hint', text: '불러오는 중…' }));
  const box = el('div', { class: 'proj-mp' }, searchIn, count, results);

  // 단일 목록(#475 중복 chips 제거) — 선택된 사람은 우측 체크·행 강조로 표시, 클릭 토글. 상단에 참여 인원 요약(#500).
  //  선택 변경 시 fire()(onChange 콜백, #473).
  function paintResults() {
    const n = selected.size;
    count.textContent = n ? n + '명 참여 중' : '참여 멤버를 골라 추가하세요';
    if (!all.length) { results.replaceChildren(el('span', { class: 'admin-hint', text: '등록된 사람 구성원이 없습니다.' })); return; }
    const q = searchIn.value.trim().toLowerCase();
    const cand = all.filter((m) => !q || (m.display_name || m.id).toLowerCase().includes(q));
    // 선택된 사람을 위로(선택 상태 한눈에), 그 안/밖은 이름순 유지.
    cand.sort((a, b) => (selected.has(b.id) ? 1 : 0) - (selected.has(a.id) ? 1 : 0));
    if (!cand.length) { results.replaceChildren(el('div', { class: 'proj-mp-empty', text: q ? '일치하는 사람이 없어요.' : '구성원이 없습니다.' })); return; }
    results.replaceChildren(...cand.map((m) => {
      const on = selected.has(m.id);
      return el('div', { class: 'proj-mp-row' + (on ? ' on' : ''), role: 'button', 'aria-pressed': on ? 'true' : 'false',
        onclick: () => { if (on) selected.delete(m.id); else selected.add(m.id); paintResults(); searchIn.focus(); fire(); } },
        personFace(m.id, 'proj-mp-ava', m.display_name || m.id),
        el('span', { class: 'proj-mp-name', text: m.display_name || m.id }),
        el('span', { class: 'proj-mp-check' + (on ? ' on' : ''), 'aria-hidden': 'true', text: on ? '✓' : '' }));
    }));
  }
  searchIn.addEventListener('input', paintResults);
  api('/api/ui/dash/members').then((d) => {
    all = (d && d.members) || [];
    // 생성 폼 기본값: 나(생성자)를 디폴트 선택 — 활성 구성원 목록에 실제 있을 때만(유령 id 방지). 다시 눌러 해제 가능.
    if (opts && opts.includeMe) {
      const meId = state.me && state.me.userId;
      if (meId && all.some((m) => m.id === meId)) selected.add(meId);
    }
    paintResults(); fire();
  })
    .catch(() => results.replaceChildren(el('span', { class: 'admin-hint', text: '팀원 목록을 불러오지 못했습니다.' })));
  return {
    box,
    getSelected: () => [...selected],
    getSelectedLabels: () => all.filter((m) => selected.has(m.id)).map((m) => ({ key: m.id, label: m.display_name || m.id, color: (m.avatar_color && /^#[0-9a-fA-F]{6}$/.test(m.avatar_color)) ? m.avatar_color : avatarColor(m.id), initials: (m.avatar_char && String(m.avatar_char).trim()) || initials(m.display_name || m.id) })),
  };
}

// 새 프로젝트 오버레이 폼 — 이름(필수)·설명(선택)·팀원. 생성 시 폴더 자동 생성 + 새 전용 페이지로 이동.
async function authDownload(url, filename) {
  const token = localStorage.getItem(TOKEN_KEY);
  let res: any;
  try { res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); }
  catch (e) { toast('다운로드 실패 — ' + e.message, true); return; }
  if (!res.ok) { toast('다운로드 실패 (' + res.status + ')', true); return; }
  const blob = await res.blob();
  const a = el('a', { href: URL.createObjectURL(blob), download: filename || 'download' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// 업로드 취소(#797) — 취소는 어느 경로로 끊었든 name==='AbortError' 하나로 알아본다(XHR·fetch·루프 공통).
//  끊긴 PUT 은 서버가 임시파일만 지우고 목적지는 손대지 않는다(src/upload-file.ts) → 취소해도 깨진 파일이 남지 않는다.
const upAbortErr = (): Error => { const e = new Error('업로드를 취소했습니다'); e.name = 'AbortError'; return e; };
const upIsAbort = (e): boolean => !!e && (e.name === 'AbortError');

// 인증 fetch 업로드(PUT raw 스트림). 파일 본문 그대로 — Content-Type 비워 서버가 스트림으로 받음. signal(선택) = 취소.
async function authUpload(url, file, signal?) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(url, { method: 'PUT', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: file, signal });
  if (!res.ok) { let m = ''; try { m = (await res.json()).error; } catch (_) { /* */ } throw new Error(m || ('업로드 실패 (' + res.status + ')')); }
}
// 진행률 콜백 업로드 — fetch 는 업로드 progress 가 없어 XHR 사용. onProgress(pct 0~100).
//  signal(선택) — 취소되면 xhr.abort() 로 **지금 전송 중인 파일까지** 즉시 끊는다(다음 파일을 안 보내는 것만으론 큰 파일에서 한참 기다린다).
function authUploadProgress(url, file, onProgress, signal?) {
  return new Promise<void>((resolve, reject) => {
    if (signal && signal.aborted) { reject(upAbortErr()); return; }
    const token = localStorage.getItem(TOKEN_KEY);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    const onAbort = () => xhr.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress((ev.loaded / ev.total) * 100); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else { let m = ''; try { m = JSON.parse(xhr.responseText).error; } catch (_) { /* */ } reject(new Error(m || ('업로드 실패 (' + xhr.status + ')'))); }
    };
    xhr.onerror = () => reject(new Error('네트워크 오류'));
    xhr.onabort = () => reject(upAbortErr());
    xhr.onloadend = () => { if (signal) signal.removeEventListener('abort', onAbort); }; // load·error·abort 어느 쪽이든 리스너 정리
    xhr.send(file);
  });
}
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}
// 파일 수정일 컴팩트 표기(#877) — 목록에서 '언제 바뀐/올라온 버전인지' 식별용. 오늘/어제는 시각까지, 올해는 M/D, 지난해는 YY/M/D.
//  mtime=0/미상(구버전 서버 응답)이면 빈 문자열 → 날짜를 아예 표시하지 않는다(graceful).
function fmtFileDate(ms) {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const sameYMD = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yst = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameYMD(d, now)) return '오늘 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  if (sameYMD(d, yst)) return '어제 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '/' + d.getDate();
  return (d.getFullYear() % 100) + '/' + (d.getMonth() + 1) + '/' + d.getDate();
}
// 전체 일시(툴팁) — 컴팩트 표기 위에 커서를 올리면 정확한 날짜·시각을 본다.
function fmtFileDateFull(ms) {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '. ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fileExt(name) { const i = String(name || '').lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; }
// 클립보드 붙여넣기 이미지 → 업로드용 File(고유 이름). File.name 은 read-only 라 새 File 로 감싼다.
//  같은 시각 다중 붙여넣기 충돌 방지로 날짜-시각(+ms 2자리, 다중이면 순번). 공유폴더는 유니코드 보존이라 한글 이름 OK.
function pastedImageFile(blob, seq) {
  const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff' };
  const ext = extMap[blob.type] || (String(blob.type).split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const ts = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + p(d.getMilliseconds()).slice(0, 2);
  const name = '붙여넣기-' + ts + (seq ? '-' + (seq + 1) : '') + '.' + ext;
  try { return new File([blob], name, { type: blob.type }); }
  catch (_) { try { blob.name = name; } catch (_2) { /* File.name read-only */ } return blob; }
}

// 붙여넣기 전 이름 지정 + 동작 안내 팝업 — 클립보드 이미지를 공유 폴더로 올리기 전에 띄운다.
//  단일: [이름][.확장자(고정 태그)]. 다중: 공통 베이스명 + 각 파일에 -1,-2…와 원래 확장자. 확인 시 onConfirm(files).
//  확장자를 입력칸 밖 고정 태그로 둬, 타이핑 중 확장자가 지워지는 것을 구조적으로 막는다.
function openPasteDialog(imgs, destLabel, onConfirm) {
  const multi = imgs.length > 1;
  const defName = pastedImageFile(imgs[0], 0).name;            // 기존 자동이름 규칙 재사용
  const ext0 = fileExt(defName);
  const stem0 = ext0 ? defName.slice(0, defName.length - ext0.length - 1) : defName;
  const nameIn = el('input', { type: 'text', value: stem0, maxlength: '120', placeholder: '파일 이름' });

  const action = el('p', { class: 'paste-action' },
    '클립보드의 ', el('b', { text: '이미지 ' + imgs.length + '개' }),
    ' 를 ', el('b', { text: destLabel }), ' 에 업로드합니다.');

  const nameRow = el('div', { class: 'paste-name-row' }, nameIn,
    multi ? null : el('span', { class: 'paste-ext', text: '.' + (ext0 || 'png') }));
  const hint = multi
    ? el('p', { class: 'admin-hint', text: '각 파일 이름 뒤에 -1, -2 … 와 원래 확장자가 붙습니다.' })
    : null;

  const saveBtn = el('button', { class: 'btn btn-primary', text: multi ? (imgs.length + '개 올리기') : '올리기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('붙여넣기',
    action,
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameRow, hint),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0); // 확장자는 입력칸 밖이라 전체선택해도 안전

  const go = () => {
    let stem = nameIn.value.trim().replace(/[/\\]/g, '-').replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
    if (!stem) stem = stem0;
    const files = imgs.map((b, i) => {
      const ext = fileExt(pastedImageFile(b, 0).name) || 'png';
      const nm = (multi ? stem + '-' + (i + 1) : stem) + '.' + ext;
      try { return new File([b], nm, { type: b.type }); }
      catch (_) { try { b.name = nm; } catch (_2) { /* read-only */ } return b; }
    });
    back.remove();
    onConfirm(files);
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
function iconFor(name) {
  const e = fileExt(name);
  if (IMG_EXTS.includes(e)) return '🖼️';
  if (['md', 'txt', 'rtf', 'csv'].includes(e)) return '📝';
  if (e === 'pdf') return '📕';
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e)) return '🗜️';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e)) return '🎬';
  if (['mp3', 'wav', 'flac', 'm4a'].includes(e)) return '🎵';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'yml', 'yaml', 'toml'].includes(e)) return '📄';
  return '📄';
}

// 공유 폴더 단색 라인 아이콘 — 컬러 이모지 대신(calm 예산: 색이 아니라 형태로 구분).
//  currentColor 를 상속하므로 색·획굵기는 CSS(.fic)에서 통제. 확장자→형태만 매핑(타입은 파일명 확장자가 이미 말해줌).
function fileKind(name) {
  const e = fileExt(name);
  if (IMG_EXTS.includes(e)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e)) return 'video';
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'].includes(e)) return 'audio';
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e)) return 'archive';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'yml', 'yaml', 'toml'].includes(e)) return 'code';
  return 'file';
}
const FILE_ICON_GLYPHS = {
  dir:     [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  file:    [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 3 14 8 19 8' }], ['line', { x1: 9, y1: 13, x2: 15, y2: 13 }], ['line', { x1: 9, y1: 16.5, x2: 15, y2: 16.5 }]],
  image:   [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['circle', { cx: 8.5, cy: 9.5, r: 1.5 }], ['polyline', { points: '21 16 15.5 11 5 20' }]],
  video:   [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['polygon', { points: '10 8.5 16 12 10 15.5 10 8.5' }]],
  audio:   [['path', { d: 'M9 17V5l10-2v12' }], ['circle', { cx: 6, cy: 17, r: 3 }], ['circle', { cx: 16, cy: 15, r: 3 }]],
  archive: [['rect', { x: 4, y: 4, width: 16, height: 4, rx: 1 }], ['path', { d: 'M5.5 8v10a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8' }], ['line', { x1: 10.5, y1: 12, x2: 13.5, y2: 12 }]],
  code:    [['polyline', { points: '15 7 20 12 15 17' }], ['polyline', { points: '9 7 4 12 9 17' }]],
};
// 파일/폴더 단색 라인 아이콘 — 동시 리팩터가 이 함수 정의를 지우고 호출처(공유폴더 참조목록·파일 필드·설정 참고파일)는
//  남겨 ReferenceError(fileIconSvg is not defined)가 났다. fileKind·FILE_ICON_GLYPHS(둘 다 생존)에 기반해 복구.
function fileIconSvg(name, isDir) {
  const kind = isDir ? 'dir' : fileKind(name);
  const node = sv('svg', { class: 'fic fic-' + kind, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  for (const [t, a] of (FILE_ICON_GLYPHS[kind] || FILE_ICON_GLYPHS.file)) node.append(sv(t as any, a));
  return node;
}
function fileThumb(id, it, rel, base) {
  if (it.type === 'dir') return folderThumb();
  const ext = fileExt(it.name);
  if (IMG_EXTS.includes(ext)) return imageThumb(id, rel, base, it.name);
  return docIcon(ext);
}
// 폴더 — 맥 느낌 소프트 블루(두 톤).
function folderThumb() {
  const n = sv('svg', { class: 'ft ft-folder', viewBox: '0 0 48 40', fill: 'none', 'aria-hidden': 'true' });
  n.append(sv('path', { class: 'ft-folder-tab', d: 'M4 9a3 3 0 0 1 3-3h10.5l4 4H4z' }));
  n.append(sv('path', { class: 'ft-folder-body', d: 'M4 12a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z' }));
  return n;
}
// 타입별 파일 라벨/색 — 동시 리팩터가 이 const 정의를 지우고 docIcon 의 사용처만 남겨 공유 폴더 파일 아이콘이
//  ReferenceError(FILE_TYPE_META is not defined)로 깨졌다(→ '폴더를 불러오지 못했습니다'). 사용처 바로 위에 복구.
const FILE_TYPE_META = {
  pdf: { label: 'PDF', cls: 'ft-pdf' },
  doc: { label: 'DOC', cls: 'ft-word' }, docx: { label: 'DOC', cls: 'ft-word' }, hwp: { label: 'HWP', cls: 'ft-word' }, hwpx: { label: 'HWP', cls: 'ft-word' },
  ppt: { label: 'PPT', cls: 'ft-ppt' }, pptx: { label: 'PPT', cls: 'ft-ppt' }, key: { label: 'KEY', cls: 'ft-ppt' },
  xls: { label: 'XLS', cls: 'ft-xls' }, xlsx: { label: 'XLS', cls: 'ft-xls' }, csv: { label: 'CSV', cls: 'ft-xls' },
  zip: { label: 'ZIP', cls: 'ft-zip' }, tar: { label: 'TAR', cls: 'ft-zip' }, gz: { label: 'GZ', cls: 'ft-zip' }, rar: { label: 'RAR', cls: 'ft-zip' }, '7z': { label: '7Z', cls: 'ft-zip' },
  mp3: { label: 'MP3', cls: 'ft-av' }, wav: { label: 'WAV', cls: 'ft-av' }, m4a: { label: 'M4A', cls: 'ft-av' }, flac: { label: 'FLAC', cls: 'ft-av' },
  mp4: { label: 'MP4', cls: 'ft-av' }, mov: { label: 'MOV', cls: 'ft-av' }, webm: { label: 'WEBM', cls: 'ft-av' }, mkv: { label: 'MKV', cls: 'ft-av' },
  md: { label: 'MD', cls: 'ft-txt' }, txt: { label: 'TXT', cls: 'ft-txt' }, rtf: { label: 'RTF', cls: 'ft-txt' },
};
// 타입별 색 문서 아이콘 — 흰 페이지 + 접힌 모서리 + 색 띠 + 라벨(PDF/DOC/PPT/XLS …).
function docIcon(ext) {
  const meta = FILE_TYPE_META[ext] || { label: (String(ext || '').toUpperCase().slice(0, 4) || 'FILE'), cls: 'ft-generic' };
  const n = sv('svg', { class: 'ft ft-file ' + meta.cls, viewBox: '0 0 40 48', fill: 'none', 'aria-hidden': 'true' });
  n.append(sv('path', { class: 'ft-page', d: 'M6 2.5h17.5L34 13v30.5a2.5 2.5 0 0 1-2.5 2.5h-25A2.5 2.5 0 0 1 4 43.5V5A2.5 2.5 0 0 1 6 2.5z' }));
  n.append(sv('path', { class: 'ft-fold', d: 'M23.5 2.5V11a2 2 0 0 0 2 2H34z' }));
  n.append(sv('rect', { class: 'ft-band', x: 4, y: 29, width: 30, height: 12, rx: 2.5 }));
  const t = sv('text', { class: 'ft-label', x: 19, y: 37.8, 'text-anchor': 'middle' }); t.textContent = meta.label;
  n.append(t);
  return n;
}
// 이미지 — 실제 썸네일. 파일 API 가 Bearer 인증이라 <img src> 직접 불가 → blob fetch 후 objectURL. 보일 때 지연 로드.
function imageThumb(id, rel, base, name) {
  const wrap = el('div', { class: 'ft ft-img' });
  const img = el('img', { alt: name });
  wrap.append(img);
  (wrap as any)._loadThumb = async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    const url = (base || '/api/ui/projects/') + id + '/file?path=' + encodeURIComponent(rel);
    try {
      const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      if (!res.ok) { wrap.classList.add('ft-img-err'); return; }
      img.src = URL.createObjectURL(await res.blob());
      wrap.classList.add('loaded');
    } catch (_) { wrap.classList.add('ft-img-err'); }
  };
  thumbObserve(wrap);
  return wrap;
}
// 지연 로드 — 화면(+여유 200px)에 들어올 때 _loadThumb() 1회. IntersectionObserver 없으면 즉시.
let _thumbObserver: any = null;
function thumbObserve(wrap) {
  if (typeof IntersectionObserver === 'undefined') { if ((wrap as any)._loadThumb) (wrap as any)._loadThumb(); return; }
  if (!_thumbObserver) {
    _thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { _thumbObserver.unobserve(e.target); if ((e.target as any)._loadThumb) (e.target as any)._loadThumb(); }
    }, { rootMargin: '200px' });
  }
  _thumbObserver.observe(wrap);
}

// 텍스트로 열어 편집 가능한 확장자(화이트리스트). 그 외 바이너리(docx/xlsx/zip 등)는 textarea 로 열면 깨지므로 다운로드.
const TEXT_EXTS = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
  'py', 'sh', 'bash', 'zsh', 'rb', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'kt', 'swift', 'php',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env',
  'sql', 'vue', 'svelte', 'r', 'lua', 'pl', 'dart', 'gradle', 'properties', 'gitignore', 'dockerfile'];

// 파일 뷰어 — 이미지=미리보기, PDF=내장 뷰어(iframe), 텍스트=편집·저장, 그 외 바이너리=다운로드 안내.
async function openFileViewer(id, rel, name, reload, base) {
  const B = base || '/api/ui/projects/';
  const token = localStorage.getItem(TOKEN_KEY);
  const url = B + id + '/file?path=' + encodeURIComponent(rel);
  const ext = fileExt(name);
  const isImg = IMG_EXTS.includes(ext);
  const isPdf = ext === 'pdf';
  const isText = TEXT_EXTS.includes(ext);
  const footer = (back, extra?) => el('div', { class: 'ov-actions' },
    ...(extra || []),
    el('button', { class: 'btn btn-ghost', text: '다운로드', onclick: () => authDownload(url + '&download=1', name) }),
    el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => back.remove() }));

  // 미리보기 미지원 바이너리 — 다운로드만(fetch 생략).
  if (!isImg && !isPdf && !isText) {
    const back = overlayBox(name, el('p', { class: 'admin-hint', text: '미리보기를 지원하지 않는 형식이에요. 다운로드해서 확인하세요.' }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  let res: any;
  try { res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); }
  catch (_) { toast('파일을 열지 못했습니다', true); return; }
  if (res.status === 413) {
    const back = overlayBox(name, el('p', { class: 'admin-hint', text: '미리보기엔 너무 큰 파일이에요. 다운로드해서 확인하세요.' }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  if (!res.ok) { toast('파일을 열지 못했습니다 (' + res.status + ')', true); return; }
  const blob = await res.blob();

  if (isImg) {
    const back = overlayBox(name, el('img', { class: 'proj-file-img', src: URL.createObjectURL(blob), alt: name }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  if (isPdf) {
    // blob 에 MIME 이 없으면 iframe 이 PDF 를 텍스트로 표시(원시 %PDF 바이트 노출) — application/pdf 로 강제 후 네이티브 뷰어 렌더.
    const pdfBlob = blob.type === 'application/pdf' ? blob : new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
    const back = overlayBox(name, el('iframe', { class: 'proj-file-pdf', src: URL.createObjectURL(pdfBlob) }));
    const box = back.querySelector('.ov-box'); box.classList.add('ov-box-wide'); box.append(footer(back));
    return;
  }
  // 텍스트 — 편집/저장
  const ta = el('textarea', { class: 'proj-file-edit' }); ta.value = await blob.text();
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  // #req 마크다운 — 원문 대신 렌더(제목·목록·표·코드…)로 보기 좋게. '✎ 편집' 토글로 원문 수정·저장.
  const isMd = ext === 'md' || ext === 'markdown';
  let content: any = ta;
  let extraBtns: any[] = [saveBtn];
  if (isMd) {
    const wrap = el('div', { class: 'proj-file-mdwrap' }, el('div', { class: 'md-rendered proj-file-md' }, renderMarkdown(ta.value)));
    let editing = false;
    const toggle = el('button', { class: 'btn btn-ghost', text: '✎ 편집' });
    toggle.onclick = () => {
      editing = !editing;
      wrap.replaceChildren(editing ? ta : el('div', { class: 'md-rendered proj-file-md' }, renderMarkdown(ta.value)));
      toggle.textContent = editing ? '👁 렌더 보기' : '✎ 편집';
      saveBtn.hidden = !editing; // 저장은 편집 모드에서만 노출
    };
    saveBtn.hidden = true;
    content = wrap;
    extraBtns = [toggle, saveBtn];
  }
  const back = overlayBox(name, content);
  const box = back.querySelector('.ov-box'); if (isMd) box.classList.add('ov-box-wide');
  box.append(footer(back, extraBtns));
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try { await authUpload(url, new Blob([ta.value])); toast('저장했습니다'); back.remove(); if (reload) reload(); }
    catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  };
}

// 공유 폴더 아이콘 카드(맥 데스크탑 느낌) — 폴더는 onDir(rel), 파일은 뷰어 팝업. 섹션·전체보기 팝업 공용.
function projFileCardEl(id, it, rel, onDir, reload, base, select) {
  const isDir = it.type === 'dir';
  const c = el('div', { class: 'proj-file-card' + (select ? ' select-mode' : ''), title: it.name },
    el('div', { class: 'proj-file-card-ic' }, fileThumb(id, it, rel, base)),
    el('div', { class: 'proj-file-card-nm', text: it.name }),
    el('div', { class: 'proj-file-card-sz', text: isDir ? '폴더' : fmtSize(it.size) }),
    it.mtime ? el('div', { class: 'proj-file-card-dt', text: fmtFileDate(it.mtime), title: fmtFileDateFull(it.mtime) }) : null);
  if (select) {
    // 선택 모드 — 카드 클릭 = 체크 토글(열기/진입 대신). 파일·폴더 모두 골라 일괄 삭제 가능.
    const ids = select.ids;
    const on0 = ids.has(rel);
    if (on0) c.classList.add('selected');
    const cb = el('span', { class: 'proj-file-check', 'aria-hidden': 'true', text: on0 ? '✓' : '' });
    c.append(cb);
    c.setAttribute('role', 'checkbox'); c.setAttribute('tabindex', '0'); c.setAttribute('aria-checked', on0 ? 'true' : 'false');
    const toggle = () => { const v = !ids.has(rel); if (v) ids.add(rel); else ids.delete(rel); c.classList.toggle('selected', v); cb.textContent = v ? '✓' : ''; c.setAttribute('aria-checked', v ? 'true' : 'false'); select.onToggle(); };
    c.onclick = toggle;
    c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  } else {
    c.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, base);
  }
  return c;
}
function projUpCardEl(onClick) {
  return el('div', { class: 'proj-file-card', onclick: onClick },
    el('div', { class: 'proj-file-card-ic', text: '↩' }), el('div', { class: 'proj-file-card-nm', text: '상위 폴더' }));
}

// 전체 보기 목록의 한 행 — [아이콘][이름][크기][호버 시 액션 아이콘]. 폴더는 진입, 파일은 뷰어.
function projFileRowEl(id, it, rel, onDir, reload, base) {
  const B = base || '/api/ui/projects/';
  const isDir = it.type === 'dir';
  const acts = el('div', { class: 'proj-file-lacts' },
    fileIconBtn('✎', '이름변경', (ev) => { ev.stopPropagation(); renameEntry(id, rel, it.name, isDir, reload, B); }),
    isDir ? null : fileIconBtn('↓', '다운로드', (ev) => { ev.stopPropagation(); authDownload(B + id + '/file?download=1&path=' + encodeURIComponent(rel), it.name); }),
    fileIconBtn('✕', '삭제', (ev) => { ev.stopPropagation(); deleteEntry(id, rel, it.name, isDir, reload, B); }, true));
  const row = el('div', { class: 'proj-file-lrow' },
    el('span', { class: 'proj-file-lic' }, fileThumb(id, it, rel, B)),
    el('span', { class: 'proj-file-lnm' + (isDir ? ' is-dir' : ''), text: it.name, title: it.name }),
    el('span', { class: 'proj-file-lsz', text: isDir ? '' : fmtSize(it.size) }),
    el('span', { class: 'proj-file-ldt', text: fmtFileDate(it.mtime), title: fmtFileDateFull(it.mtime) }),
    acts);
  row.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, B);
  return row;
}
function fileIconBtn(glyph, title, onclick, danger?) {
  return el('button', { class: 'proj-file-iconbtn' + (danger ? ' danger' : ''), title, type: 'button', text: glyph, onclick });
}
// 파일/폴더 이름 변경(같은 폴더 안).
function renameEntry(id, rel, name, isDir, reload, base) {
  const B = base || '/api/ui/projects/';
  const nameIn = el('input', { type: 'text', value: name, maxlength: '120' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const back = overlayBox('이름 변경',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '새 이름' }), nameIn),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  setTimeout(() => {
    nameIn.focus();
    // 파일은 확장자(.png 등)를 뺀 본문만 선택 — 타이핑 시 확장자가 통째로 지워지는 것 방지(Finder/VS Code 동작).
    const dot = name.lastIndexOf('.');
    if (!isDir && dot > 0) nameIn.setSelectionRange(0, dot);
    else nameIn.select();
  }, 0);
  const go = async () => {
    const nm = nameIn.value.trim();
    if (!nm || nm === name) { back.remove(); return; }
    saveBtn.disabled = true;
    try { await api(B + id + '/rename', { method: 'POST', body: JSON.stringify({ path: rel, name: nm }) }); back.remove(); toast('이름을 변경했습니다'); reload(); }
    catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
// 파일/폴더 삭제(폴더는 내용까지). 확인 후.
async function deleteEntry(id, rel, name, isDir, reload, base) {
  const B = base || '/api/ui/projects/';
  if (!confirm((isDir ? '폴더' : '파일') + ' ‘' + name + '’을(를) 삭제할까요?' + (isDir ? '\n\n폴더 안 내용도 함께 삭제됩니다(되돌릴 수 없음).' : '\n\n되돌릴 수 없습니다.'))) return;
  try { await api(B + id + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

// ── 업로드 입력(파일 + 폴더) 공통 프리미티브 (#781) ──
//  공유 폴더는 '파일'만 받고 '폴더'는 못 받았다. 원인은 서버가 아니라 프론트다 — 서버 PUT /file?path=a/b/c.png 은
//  이미 dirname 을 mkdir -p 하므로(project-routes.ts) **중첩 경로만 보내면** 폴더 구조가 그대로 생긴다.
//  그래서 파일·폴더 어느 쪽으로 받든 [{ file, rel }] 한 형태로 정규화해 올린다(rel = 대상 폴더 기준 상대경로).
//  OS 중립: rel 의 구분자는 규격상 어느 OS(윈도·리눅스·맥)에서나 '/' 다 — 드롭 경로는 우리가 직접 '/' 로 조립하고,
//  폴더 선택(webkitdirectory)의 File.webkitRelativePath 도 '/' 로 온다. 백슬래시는 맥·리눅스에선 파일명의 일부라 안 건드린다.
type UpItem = { file: any; rel: string };
const UP_MANY = 12;       // 이보다 많으면 파일별 카드 대신 묶음 진행 카드 1개(그리드 폭주 방지)
const UP_CONFIRM = 200;   // 이보다 많으면 확인 — 큰 폴더를 실수로 떨어뜨렸을 때의 안전핀

// 덮어쓰기 사전 검사(#877) — 올릴 항목이 현재 폴더의 기존 파일/폴더와 이름이 겹치는지 본다.
//  currentItems = 지금 보고 있는 폴더 목록([{name,type}]) — 검색결과 화면이면 폴더 컨텍스트가 아니라 호출부가 [] 를 준다.
//  중첩(rel 에 '/')은 최상위 세그먼트(폴더)만 판단: 그 폴더가 이미 있으면 '병합'이라 안쪽 같은 이름 파일만 덮인다.
function upCollisions(items: UpItem[], currentItems: any[]): { files: string[]; dirs: string[]; conflicts: string[] } {
  const byName = new Map<string, string>();
  for (const it of (currentItems || [])) if (it && it.name) byName.set(it.name, it.type);
  const files = new Set<string>(), dirs = new Set<string>(), conflicts = new Set<string>();
  for (const u of (items || [])) {
    const top = String(u.rel || '').split('/')[0];
    const t = byName.get(top);
    if (!t) continue;
    if (String(u.rel).includes('/')) { if (t === 'dir') dirs.add(top); else conflicts.add(top); }  // 폴더 병합 vs 같은 이름 파일 아래로(서버가 거부)
    else if (t === 'file') files.add(top);                                                          // 직접 파일 덮어쓰기
    else conflicts.add(top);                                                                        // 폴더와 같은 이름의 파일(서버가 거부)
  }
  return { files: [...files], dirs: [...dirs], conflicts: [...conflicts] };
}
// 덮어쓰기 확인 — 겹치는 게 있으면 무엇이 덮이는지 목록으로 보여주고 confirm(마이크 이슈 #877: 조용히 덮이던 것을 명시).
//  반환: 계속하면 { go:true, over:Set<덮어쓸 직접 파일명> }, 취소면 { go:false }. over 는 결과 요약('N개 덮어씀')용으로 upSend 에 넘긴다.
function upPrecheckOverwrite(items: UpItem[], currentItems: any[]): { go: boolean; over: Set<string> } {
  const { files, dirs, conflicts } = upCollisions(items, currentItems);
  const over = new Set(files);
  if (!files.length && !dirs.length && !conflicts.length) return { go: true, over };
  const cap = (arr) => arr.slice(0, 10).map((n) => '  • ' + n).join('\n') + (arr.length > 10 ? ('\n  …외 ' + (arr.length - 10) + '개') : '');
  const parts: string[] = [];
  if (files.length) parts.push('이미 있는 파일 ' + files.length + '개를 덮어씁니다:\n' + cap(files));
  if (dirs.length) parts.push('이미 있는 폴더 ' + dirs.length + '개 — 그 안의 같은 이름 파일만 덮어써집니다:\n' + cap(dirs));
  if (conflicts.length) parts.push('이름이 겹쳐(파일↔폴더) 업로드가 거부될 수 있는 항목 ' + conflicts.length + '개:\n' + cap(conflicts));
  return { go: confirm(parts.join('\n\n') + '\n\n계속할까요?'), over };
}

// 상대경로 정규화 — 빈 세그먼트 제거, '.' 제거, '..'(경로 탈출)은 항목 자체를 버림. 서버도 봉쇄하지만 프론트에서 먼저 막는다.
function upSafeRel(rel): string | null {
  const parts = String(rel || '').split('/').filter((s) => s !== '' && s !== '.');
  if (!parts.length || parts.some((s) => s === '..')) return null;
  return parts.join('/');
}
// 숨김(.으로 시작) 항목은 폴더 안에서만 걸러낸다 — 서버 목록·매니페스트가 dotfile 을 숨기므로 올려도 화면에 안 보이고
//  로컬로도 안 내려간다(= .DS_Store·Thumbs.db 같은 OS 잡동사니만 쌓인다). 사용자가 직접 고른 최상위 파일은 존중해 그대로 올린다.
function upHidden(rel: string): boolean {
  const parts = rel.split('/');
  return parts.length > 1 && parts.some((s) => s.startsWith('.'));
}
function upNormalize(items: UpItem[]): UpItem[] {
  const out: UpItem[] = [];
  for (const it of items) {
    const rel = upSafeRel(it.rel);
    if (!rel || upHidden(rel)) continue;
    out.push({ file: it.file, rel });
  }
  return out;
}
// <input webkitdirectory> 로 고른 폴더 — File.webkitRelativePath('폴더명/하위/파일')가 구조를 담고 있다(윈도·리눅스·맥 동일).
//  일반 파일 선택이면 webkitRelativePath 가 빈 문자열이라 rel = 파일명.
function upFromInput(input): UpItem[] {
  return upNormalize((Array.from(input.files || []) as any[]).map((f) => ({ file: f, rel: String(f.webkitRelativePath || f.name) })));
}
// 브라우저가 폴더 선택을 지원하는가(webkitdirectory) — 데스크탑 크롬·엣지·파폭·사파리는 모두 지원. 미지원이면 메뉴에서 감춘다.
function upDirSupported(): boolean {
  try { return 'webkitdirectory' in HTMLInputElement.prototype; } catch (_) { return false; }
}
// 드롭한 폴더는 dataTransfer.files 로는 못 읽는다(내용 없는 항목으로만 잡혀 통째로 유실).
//  webkitGetAsEntry()(FileSystemEntry)로 트리를 재귀 순회해야 하위 파일까지 온다 — 크롬·엣지·파폭·사파리 공통.
//  ⚠ dataTransfer.items 는 드롭 핸들러가 끝나면 무효화된다 → await 하기 전에 동기로 entry 를 전부 꺼내둔다.
function upDropEntries(dt): any[] {
  const out: any[] = [];
  for (const it of (Array.from(dt.items || []) as any[])) {
    if (it.kind !== 'file') continue;
    const ent = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (ent) out.push(ent);
  }
  return out;
}
// FileSystemDirectoryReader.readEntries 는 한 번에 최대 100건만 준다 — 빈 배열이 올 때까지 반복해야 폴더를 다 읽는다.
function upReadAll(reader): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const acc: any[] = [];
    const step = () => reader.readEntries((batch) => {
      if (!batch || !batch.length) { resolve(acc); return; }
      acc.push(...batch);
      step();
    }, reject);
    step();
  });
}
const upEntryFile = (ent): Promise<any> => new Promise((res, rej) => ent.file(res, rej));
// 드롭 이벤트 → 업로드 목록. emptyDirs = 파일이 하나도 없는 폴더(빈 폴더도 만들어 줘야 구조가 보존된다).
//  entries API 가 없는 구형 브라우저는 예전처럼 파일만 받는다(폴더는 못 받음 — 기존 동작 유지).
async function upFromDrop(dt): Promise<{ items: UpItem[]; emptyDirs: string[] }> {
  const roots = upDropEntries(dt);   // ⚠ 반드시 await 전에(동기) — items 무효화 회피
  if (!roots.length) {
    const items = upNormalize((Array.from(dt.files || []) as any[]).map((f) => ({ file: f, rel: String(f.name) })));
    return { items, emptyDirs: [] };
  }
  const items: UpItem[] = [];
  const emptyDirs: string[] = [];
  const walk = async (ent, prefix) => {
    const name = String(ent.name || '');
    if (prefix && name.startsWith('.')) return;   // 폴더 안의 숨김은 제외(최상위로 직접 끌어온 건 존중)
    const rel = prefix ? prefix + '/' + name : name;
    if (ent.isFile) { items.push({ file: await upEntryFile(ent), rel }); return; }
    if (!ent.isDirectory) return;
    const kids = (await upReadAll(ent.createReader())).filter((k) => !String(k.name || '').startsWith('.'));
    if (!kids.length) { emptyDirs.push(rel); return; }
    for (const k of kids) await walk(k, rel);
  };
  for (const ent of roots) await walk(ent, '');
  return { items: upNormalize(items), emptyDirs: emptyDirs.map(upSafeRel).filter(Boolean) as string[] };
}
// '＋ 업로드' 버튼 — 파일 / 폴더 선택 메뉴(폴더는 <input webkitdirectory> 로만 고를 수 있어 입력이 따로다).
//  반환한 입력 두 개는 호출부가 헤더에 함께 append 한다(숨김 input).
//  opts.className/label — 버튼 톤을 부르는 화면에 맞춘다(프로젝트 카드 = btn btn-ghost, 대시보드 브라우저 = dash-fb-btn, #795).
function upControl(onPick: (items: UpItem[]) => void, opts?: { className?: string; label?: string }) {
  const fileIn = el('input', { type: 'file', multiple: '', style: 'display:none' });
  const dirIn = el('input', { type: 'file', multiple: '', webkitdirectory: '', style: 'display:none' });
  fileIn.addEventListener('change', () => { onPick(upFromInput(fileIn)); fileIn.value = ''; });
  dirIn.addEventListener('change', () => { onPick(upFromInput(dirIn)); dirIn.value = ''; });
  const btn = el('button', { class: (opts && opts.className) || 'btn btn-ghost btn-sm', type: 'button', text: (opts && opts.label) || '＋ 업로드' });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu, { align: 'right' });
    const mk = (label, desc, fn) => {
      const item = el('button', { class: 'pjv-menu-item', type: 'button' },
        el('span', { style: 'display:flex;flex-direction:column;gap:1px;min-width:0' },
          el('span', { text: label }), el('span', { class: 'caption', text: desc })));
      item.onclick = (ev) => { ev.stopPropagation(); close(); fn(); };
      return item;
    };
    menu.append(mk('파일 올리기', '여러 개 선택 가능', () => fileIn.click()));
    if (upDirSupported()) menu.append(mk('폴더 올리기', '하위 폴더까지 구조 그대로', () => dirIn.click()));
  };
  return { btn, fileIn, dirIn };
}
// 드래그앤드롭 배선 — zone 위로 파일·폴더를 끌어오면 hi 에 .drop-active, 놓으면 onDrop(items, emptyDirs).
//  드롭 핸들러는 동기로 upFromDrop 을 호출해야 한다(items 무효화) → 여기서 한 번만 제대로 해두고 두 화면이 같이 쓴다.
function upDropZone(zone, hi, onDrop: (items: UpItem[], emptyDirs: string[]) => void) {
  let depth = 0;
  const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
  const clear = () => { depth = 0; hi.classList.remove('drop-active'); };
  zone.addEventListener('dragenter', (ev) => { if (hasFiles(ev)) { ev.preventDefault(); depth++; hi.classList.add('drop-active'); } });
  zone.addEventListener('dragover', (ev) => { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
  zone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hi.classList.remove('drop-active'); });
  zone.addEventListener('drop', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault(); clear();
    upFromDrop(ev.dataTransfer)                       // 동기 시작(내부에서 entry 를 먼저 꺼낸다)
      .then(({ items, emptyDirs }) => onDrop(items, emptyDirs))
      .catch((e) => toast('끌어온 항목을 읽지 못했습니다 — ' + (e && e.message ? e.message : e), true));
  });
}

// ── 업로드 실행 + 취소 (#797) ──
//  세 화면(공유 폴더 카드 · '전체 보기' 모달 · 대시보드 팀 공유 폴더)이 같은 전송 루프를 각자 복붙하고 있었다.
//  취소를 세 번 만들 이유가 없으니 루프 자체를 프리미티브로 내린다 — 화면은 진행 표시만 자기 방식대로 그린다.
//  취소 정책: **이미 올라간 파일은 되돌리지 않는다**(서버에 트랜잭션이 없다). 대신 'N개까지 올리고 취소' 로 정직하게 알린다.
//   전송 중이던 파일은 서버가 임시파일에만 쓰고 있었으므로 목적지엔 흔적이 없다(부분 파일 X, 덮어쓰던 원본도 무사 — src/upload-file.ts).
type UpResult = { ok: number; fail: number; made: number; over: number; canceled: boolean };
async function upSend(o: {
  items: UpItem[];
  emptyDirs?: string[];
  signal: AbortSignal;
  fileUrl: (rel: string) => string;    // 파일 PUT 주소(대상 폴더는 호출부가 드롭 시점에 고정)
  dirUrl?: (rel: string) => string;    // 빈 폴더 mkdir 주소(구조 보존)
  overwriteNames?: Set<string>;        // 사전확인에서 '덮어쓸' 것으로 판정된 직접 파일명(#877) — 결과 요약 카운트용
  onProgress?: (i: number, rel: string, pct: number) => void;
}): Promise<UpResult> {
  const arr = o.items || [], dirs = o.emptyDirs || [];
  const overSet = o.overwriteNames || null;
  let ok = 0, fail = 0, made = 0, over = 0;
  for (let i = 0; i < arr.length; i++) {
    if (o.signal.aborted) return { ok, fail, made, over, canceled: true };
    const u = arr[i];
    if (o.onProgress) o.onProgress(i, u.rel, 0);
    try {
      await authUploadProgress(o.fileUrl(u.rel), u.file, (pct) => { if (o.onProgress) o.onProgress(i, u.rel, pct); }, o.signal);
      ok += 1;
      if (overSet && !String(u.rel).includes('/') && overSet.has(u.rel)) over += 1;   // 기존 파일을 실제로 덮어씀
      if (o.onProgress) o.onProgress(i, u.rel, 100);
    } catch (e) {
      if (upIsAbort(e)) return { ok, fail, made, over, canceled: true };   // 전송 중이던 파일이 끊김 = 취소
      fail += 1;
      toast(u.rel + ' 실패 — ' + e.message, true);
    }
  }
  // 빈 폴더는 올릴 파일이 없으니 mkdir 로 만들어 준다(구조 보존).
  for (const d of dirs) {
    if (o.signal.aborted) return { ok, fail, made, over, canceled: true };
    if (!o.dirUrl) break;
    try { await api(o.dirUrl(d), { method: 'POST' }); made += 1; }
    catch (_) { /* 비치명 — 파일은 이미 올라갔다 */ }
  }
  return { ok, fail, made, over, canceled: false };
}
// 업로드 결과 알림 — 취소했으면 **몇 개까지 올라갔는지** 반드시 말한다(조용히 멈추면 사용자가 폴더 상태를 알 수 없다).
//  ⚠ ok 는 '성공 응답까지 확인한' 개수 = 하한이다. 취소를 누른 그 순간 서버가 이미 다 받아 저장을 마쳤는데 응답만 못 받은
//   파일이 1개 더 있을 수 있다(끊는 쪽은 상대가 끝냈는지 알 길이 없다 — HTTP 취소의 본질적 모호성). 그래서 호출부는 취소
//   뒤에도 목록을 다시 읽어 사용자가 '진짜 상태'를 보게 한다. 어느 경우든 파일 자체는 온전하다(부분 파일 X — src/upload-file.ts).
function upToast(r: UpResult) {
  const over = r.over ? ' · ' + r.over + '개 덮어씀' : '';   // #877 — 덮어쓴 개수를 결과에도 명시(사전확인과 짝)
  if (r.canceled) { toast(r.ok ? (r.ok + '개까지 올리고 취소했습니다' + over) : '업로드를 취소했습니다'); return; }
  if (r.ok || r.made) toast((r.ok ? r.ok + '개 업로드 완료' : r.made + '개 폴더 생성') + over + (r.fail ? (' · ' + r.fail + '개 실패') : ''));
}
// 업로드 진행 + 취소 바 — 배치 하나당 한 줄. 배치가 동시에 여러 개 돌면 줄도 여러 개라 '어느 업로드를 끊는지' 헷갈리지 않는다.
//  세 화면이 같은 바를 쓴다(.up-prog) — 취소 어포던스를 화면마다 다르게 만들 이유가 없다.
//  opts.label — 전송 시작 전에 보일 문구(예: 공유 폴더에서 첨부는 '원본을 읽는 중…'). set() 이 불리면 '업로드 중 — …' 으로 바뀐다.
function upProgress(total: number, onCancel: () => void, opts?: { label?: string }) {
  const label = el('div', { class: 'up-prog-label', text: (opts && opts.label) || '업로드 준비 중…' });
  const fill = el('div', { class: 'up-prog-fill' });
  const btn = el('button', { class: 'btn btn-ghost btn-sm up-prog-cancel', type: 'button', text: '취소' });
  const row = el('div', { class: 'up-prog' },
    el('div', { class: 'up-prog-main' }, label, el('div', { class: 'up-prog-bar' }, fill)),
    btn);
  btn.onclick = (ev) => { ev.stopPropagation(); btn.disabled = true; btn.textContent = '취소 중…'; onCancel(); };
  return {
    row,
    // i = 0-based 현재 파일, pct = 그 파일의 진행률 → 바는 배치 전체 기준으로 채운다.
    set(i: number, rel: string, pct: number) {
      const nm = String(rel || '').split('/').pop() || rel;
      label.textContent = '업로드 중 — ' + (total > 1 ? (Math.min(i + 1, total) + '/' + total + ' · ') : '') + nm;
      fill.style.width = (total > 0 ? ((i + pct / 100) / total) * 100 : pct) + '%';
    },
  };
}

// 공유 폴더 '전체 보기' — 넓은 팝업에 일반 파일 목록(행 단위)으로 전부 표시. 폴더 탐색·파일 열기 가능.
function openFolderGrid(id, startPath, base) {
  const B = base || '/api/ui/projects/';
  const st = { path: startPath || '', q: '' };
  let lastFolderItems: any[] = [];   // 현재 폴더(검색결과 아님) 목록 — 업로드 덮어쓰기 사전확인용(#877). 검색 중이어도 실제 업로드 대상 폴더 기준으로 판정.
  const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '파일 검색…' });
  searchIn.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); load(); }, 300));
  const up = upControl((items) => uploadHere(items, []));
  const mkdirBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더', onclick: () => mkdirHere() });
  const crumb = el('div', { class: 'proj-file-crumb' });
  const listBox = el('div', { class: 'proj-file-llist' });
  const progBox = el('div', { class: 'up-prog-box' });   // 업로드 진행·취소 바(배치별 한 줄, #797)
  const back = overlayBox('공유 폴더 — 전체 보기',
    el('div', { class: 'proj-fg-head' }, searchIn, el('div', { class: 'proj-fg-actions' }, mkdirBtn, up.btn, up.fileIn, up.dirIn)),
    crumb, progBox, listBox);
  const box = back.querySelector('.ov-box'); if (box) box.classList.add('ov-box-wide');
  // 드래그앤드롭 업로드(#781) — 이 모달엔 아예 없었다(그래서 끌어다 놔도 아무 일도 안 일어났다).
  //  받는 영역은 오버레이 전체(back) — 모달 밖 배경에 떨어뜨려도 브라우저가 그 파일을 열어 화면을 날리지 않게.
  upDropZone(back, box || back, (items, emptyDirs) => uploadHere(items, emptyDirs));
  const join = (a, b) => (a ? a + '/' + b : b);
  load();

  // 업로드 — 여기엔 진행 표시가 아예 없었다(수백 개를 올려도 화면이 조용했다). 이제 진행 바 + 취소(#797).
  async function uploadHere(items: UpItem[], emptyDirs: string[]) {
    const arr = items || [];
    const dirs = emptyDirs || [];
    if (!arr.length && !dirs.length) { toast('올릴 파일이 없습니다', true); return; }
    const cur = lastFolderItems;   // 검색 중이어도 실제 업로드 대상 폴더 기준(#877 리뷰)
    const pc = upPrecheckOverwrite(arr, cur);   // #877 — 겹치면 무엇이 덮이는지 보여주고 확인
    if (!pc.go) return;
    if (arr.length > UP_CONFIRM && !confirm(arr.length + '개 파일을 업로드합니다. 계속할까요?')) return;
    const dest = st.path;    // 업로드 중 폴더를 옮겨도 '떨어뜨린 그 폴더'로 간다
    const ac = new AbortController();
    const bar = upProgress(arr.length, () => ac.abort());
    progBox.append(bar.row);
    const r = await upSend({
      items: arr, emptyDirs: dirs, signal: ac.signal, overwriteNames: pc.over,
      fileUrl: (rel) => B + id + '/file?path=' + encodeURIComponent((dest ? dest + '/' : '') + rel),
      dirUrl: (d) => B + id + '/folder?path=' + encodeURIComponent((dest ? dest + '/' : '') + d),
      onProgress: (i, rel, pct) => bar.set(i, rel, pct),
    });
    bar.row.remove();
    upToast(r);
    st.q = ''; searchIn.value = ''; load();
  }
  function mkdirHere() {
    const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '80' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
    const b2 = overlayBox('새 폴더',
      el('p', { class: 'admin-hint', text: (st.path ? '“' + st.path + '” 안에' : '루트에') + ' 새 폴더를 만듭니다.' }),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: '폴더 이름' }), nameIn),
      el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => b2.remove() })));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
      const nm = nameIn.value.trim(); if (!nm) { nameIn.focus(); return; }
      saveBtn.disabled = true;
      try { await api(B + id + '/folder?path=' + encodeURIComponent((st.path ? st.path + '/' : '') + nm), { method: 'POST' }); b2.remove(); toast('폴더를 만들었습니다'); load(); }
      catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
    };
    saveBtn.onclick = go; nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  async function load() {
    listBox.replaceChildren(skeletonRows(5));
    const qs = st.q ? ('?q=' + encodeURIComponent(st.q)) : ('?path=' + encodeURIComponent(st.path));
    let data: any;
    try { data = await api(B + id + '/files' + qs); }
    catch (e) { listBox.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다')); return; }
    if (data.search === undefined) lastFolderItems = data.items || [];   // 검색 응답은 무시 — 폴더 목록일 때만 갱신
    if (data.search !== undefined) {
      crumb.replaceChildren(el('span', { text: '“' + data.search + '” 검색 — ' + data.items.length + '건' }));
      const rows = (data.items || []).map((it) => projFileRowEl(id, it, it.path, (t) => { st.q = ''; searchIn.value = ''; st.path = t; load(); }, load, B));
      listBox.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty', text: '일치하는 파일이 없어요.' })]));
      return;
    }
    crumb.replaceChildren(
      el('span', { class: 'proj-crumb-link', text: '⌂ 루트', onclick: () => { st.path = ''; load(); } }),
      data.path ? el('span', { text: ' / ' + data.path }) : null);
    const rows: any[] = [];
    if (data.path) rows.push(el('div', { class: 'proj-file-lrow', onclick: () => { st.path = data.parent || ''; load(); } },
      el('span', { class: 'proj-file-lic', text: '↩' }), el('span', { class: 'proj-file-lnm', text: '상위 폴더' }),
      el('span', { class: 'proj-file-lsz' }), el('span', { class: 'proj-file-ldt' }), el('span', { class: 'proj-file-lacts' })));
    for (const it of (data.items || [])) rows.push(projFileRowEl(id, it, join(st.path, it.name), (t) => { st.path = t; load(); }, load, B));
    listBox.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty', text: '빈 폴더입니다.' })]));
  }
}
function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
// 타임라인용 날짜시간 — '몇 시간 전' 대신 절대 날짜·시각(연도는 올해가 아니면만 표기).
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const yr = d.getFullYear() !== new Date().getFullYear() ? (d.getFullYear() + '. ') : '';
  return yr + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── 상세 ① 공유 폴더 — 프로젝트 폴더 탐색 + 업로드/다운로드 + 검색. ──
function projectFolderSection(id, base) {
  const B = base || '/api/ui/projects/';
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const st = { path: '', q: '' };
  let lastData: any = null;   // 마지막 서버 응답(업로드 중 그리드 즉시 재구성용)
  let lastFolderItems: any[] = [];   // 현재 폴더(검색결과 아님) 목록 — 업로드 덮어쓰기 사전확인용(#877)
  const uploading: any[] = [];  // 업로드 중 카드 [{ name, label, pct, pctEl, fill, nmEl }] — 폴더 업로드는 묶음 카드 1장
  const searchIn = el('input', { type: 'search', placeholder: '파일 검색…', class: 'proj-file-search' });
  searchIn.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); load(); }, 300));
  const up = upControl((items) => uploadFiles(items, []));
  const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '전체 보기', onclick: () => openFolderGrid(id, st.path, B) });
  const mkdirBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더', onclick: () => openMkdir() });
  // 선택(일괄삭제) 모드 — 카드 뷰에서 여러 항목을 골라 한 번에 삭제. ids = 선택된 rel(상대경로) 집합.
  const sel = { mode: false, ids: new Set() };
  let lastPairs: any[] = [];
  const selectBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 항목을 골라 한 번에 삭제', onclick: () => toggleSelMode() });
  const selBar = el('div', { class: 'bulk-bar', hidden: true });
  const progBox = el('div', { class: 'up-prog-box' });   // 업로드 진행·취소 바(배치별 한 줄, #797). 그리드의 '업로드 중 카드'는 위치 표시로 그대로.
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '공유 폴더' }),
    el('div', { class: 'card-head-actions' }, searchIn, allBtn, mkdirBtn, up.btn, selectBtn, up.fileIn, up.dirIn)));
  card.append(selBar);
  card.append(progBox);
  card.append(body);
  // 드래그앤드롭 업로드 — 카드 위로 파일·폴더를 끌어다 놓으면 현재 폴더에 올림(폴더는 하위 구조 그대로, #781).
  upDropZone(card, card, (items, emptyDirs) => uploadFiles(items, emptyDirs));
  // 클립보드 이미지 붙여넣기 — 프로젝트 상세에서 (텍스트 입력칸이 아닌 곳에) 붙여넣으면 현재 공유 폴더로 업로드.
  //  card 가 DOM 에서 사라지면(다른 화면 이동) 다음 paste 때 스스로 해제(언마운트 훅이 없어 누수 방지용 self-clean).
  const onPaste = (ev) => {
    if (!document.body.contains(card)) { document.removeEventListener('paste', onPaste); return; }
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // 텍스트 편집 중 붙여넣기는 방해 않음
    const items = (ev.clipboardData && ev.clipboardData.items) || [];
    const imgs: any[] = [];
    for (const it of items) { if (it.kind === 'file' && String(it.type || '').startsWith('image/')) { const b = it.getAsFile(); if (b) imgs.push(b); } }
    if (!imgs.length) return; // 이미지가 없으면 평소 붙여넣기 동작 유지
    ev.preventDefault();
    const dest = '공유 폴더' + (st.path ? ' / ' + st.path : '');
    openPasteDialog(imgs, dest, (files) => uploadFiles(files.map((f) => ({ file: f, rel: String(f.name) })), []));
  };
  document.addEventListener('paste', onPaste);
  load();
  return card;

  // 선택 모드 토글 — 켜면 카드가 체크박스로, 끄면 선택 해제 + 헤드 버튼 라벨 전환.
  function toggleSelMode(on?) {
    sel.mode = on != null ? on : !sel.mode;
    if (!sel.mode) sel.ids.clear();
    selectBtn.classList.toggle('active', sel.mode);
    selectBtn.textContent = sel.mode ? '선택 취소' : '선택';
    paintSelBar();
    if (lastData) render(lastData);
  }
  function paintSelBar() {
    if (!sel.mode) { selBar.hidden = true; selBar.replaceChildren(); return; }
    const n = sel.ids.size, total = lastPairs.length;
    const allOn = total > 0 && n >= total;
    const allBtn2 = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
      onclick: () => { if (allOn) sel.ids.clear(); else lastPairs.forEach((p) => sel.ids.add(p.rel)); paintSelBar(); if (lastData) render(lastData); } });
    const delB = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0, onclick: () => bulkDeleteSel() });
    selBar.hidden = false;
    selBar.replaceChildren(
      el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 항목을 고르세요' }),
      el('div', { class: 'bulk-bar-actions' }, allBtn2, delB));
  }
  async function bulkDeleteSel() {
    const rels: any[] = [...sel.ids];
    if (!rels.length) return;
    if (!confirm(rels.length + '개 항목을 삭제할까요?\n\n폴더는 안의 내용까지 함께 삭제됩니다(되돌릴 수 없음).')) return;
    // 병렬 삭제 — 일부 실패해도 나머지 진행(성공/실패 집계).
    const results = await Promise.allSettled(rels.map((rel) =>
      api(B + id + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 삭제했습니다'), fail > 0);
    toggleSelMode(false);
    load();
  }

  // 여러 파일 업로드 — 그리드에 '업로드 중 카드'(비활성 아이콘 + 실시간 %) 띄우고 순차 전송.
  //  items[].rel = 대상 폴더 기준 상대경로 — 폴더 업로드면 'sub/child/a.png' 처럼 하위 경로가 들어있고,
  //  서버 PUT 이 dirname 을 mkdir -p 하므로 그 구조 그대로 만들어진다. emptyDirs = 파일 없는 빈 폴더(따로 mkdir).
  async function uploadFiles(items: UpItem[], emptyDirs: string[]) {
    const arr = items || [];
    const dirs = emptyDirs || [];
    if (!arr.length && !dirs.length) { toast('올릴 파일이 없습니다', true); return; }
    const cur = lastFolderItems;   // 검색 중이어도 실제 업로드 대상 폴더 기준(#877 리뷰)
    const pc = upPrecheckOverwrite(arr, cur);   // #877 — 겹치면 무엇이 덮이는지 보여주고 확인
    if (!pc.go) return;
    if (arr.length > UP_CONFIRM && !confirm(arr.length + '개 파일을 업로드합니다. 계속할까요?')) return;
    const dest = st.path;   // 업로드 중 다른 폴더로 들어가도 '떨어뜨린 그 폴더'로 간다
    // 파일이 많으면(폴더 업로드) 파일별 카드 대신 묶음 카드 1개 — 그리드가 수백 장으로 폭주하지 않게.
    const many = arr.length > UP_MANY;
    const cards: any[] = many
      ? [{ name: arr.length + '개 파일', label: '0/' + arr.length + ' 업로드 중', pct: 0 }]
      : arr.map((u) => ({ name: u.rel, label: u.rel, pct: 0 }));
    uploading.push(...cards);
    if (lastData) render(lastData); // 업로드 카드 즉시 표시(load 기다리지 않음)
    // 취소는 이 배치만 끊는다 — 배치마다 컨트롤러·바가 따로라 동시 업로드끼리 서로 영향이 없다(#797).
    const ac = new AbortController();
    const bar = upProgress(arr.length, () => ac.abort());
    progBox.append(bar.row);
    const r = await upSend({
      items: arr, emptyDirs: dirs, signal: ac.signal, overwriteNames: pc.over,
      fileUrl: (rel) => B + id + '/file?path=' + encodeURIComponent((dest ? dest + '/' : '') + rel),
      dirUrl: (d) => B + id + '/folder?path=' + encodeURIComponent((dest ? dest + '/' : '') + d),
      onProgress: (i, rel, pct) => {
        bar.set(i, rel, pct);
        const c = many ? cards[0] : cards[i];
        if (!c) return;
        c.pct = many ? ((i + pct / 100) / arr.length) * 100 : pct;
        if (many) c.label = i + '/' + arr.length + ' — ' + (rel.split('/').pop() || rel);
        updateUpCard(c);
      },
    });
    bar.row.remove();
    for (const c of cards) { const ix = uploading.indexOf(c); if (ix >= 0) uploading.splice(ix, 1); } // 이 배치 카드만 걷어냄(동시 업로드 보호)
    upToast(r);
    st.q = ''; searchIn.value = '';
    load();
  }
  function uploadingCard(u) {
    const pctEl = el('div', { class: 'proj-up-pct', text: Math.round(u.pct) + '%' });
    const fill = el('div', { class: 'proj-up-bar-fill', style: 'width:' + u.pct + '%' });
    const nmEl = el('div', { class: 'proj-file-card-nm', text: u.label || u.name });
    u.pctEl = pctEl; u.fill = fill; u.nmEl = nmEl;
    return el('div', { class: 'proj-file-card uploading', title: u.name },
      el('div', { class: 'proj-up-icwrap' },
        el('div', { class: 'proj-file-card-ic', text: iconFor(u.name) }),
        el('div', { class: 'proj-up-overlay' }, pctEl)),
      nmEl,
      el('div', { class: 'proj-up-bar' }, fill));
  }
  function updateUpCard(u) {
    if (u.pctEl) u.pctEl.textContent = Math.round(u.pct) + '%';
    if (u.fill) u.fill.style.width = u.pct + '%';
    if (u.nmEl) u.nmEl.textContent = u.label || u.name;
  }
  // 현재 폴더 안에 하위 폴더 생성.
  function openMkdir() {
    const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '80' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
    const back = overlayBox('새 폴더',
      el('p', { class: 'admin-hint', text: (st.path ? '“' + st.path + '” 안에' : '루트에') + ' 새 폴더를 만듭니다.' }),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: '폴더 이름' }), nameIn),
      el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
      const nm = nameIn.value.trim();
      if (!nm) { nameIn.focus(); toast('폴더 이름을 입력하세요', true); return; }
      const target = (st.path ? st.path + '/' : '') + nm;
      saveBtn.disabled = true;
      try { await api(B + id + '/folder?path=' + encodeURIComponent(target), { method: 'POST' }); back.remove(); toast('폴더를 만들었습니다'); st.q = ''; searchIn.value = ''; load(); }
      catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
    };
    saveBtn.onclick = go;
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  async function load() {
    body.replaceChildren(skeletonRows(3));
    try {
      const qs = st.q ? ('?q=' + encodeURIComponent(st.q)) : ('?path=' + encodeURIComponent(st.path));
      render(await api(B + id + '/files' + qs));
    } catch (e) { body.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다')); }
  }
  function render(data) {
    lastData = data;
    if (data.search === undefined) lastFolderItems = data.items || [];   // 검색결과는 무시 — 폴더 목록일 때만(#877)
    const frag: any[] = [];
    let pairs: any; // { it, rel }
    if (data.search !== undefined) {
      frag.push(el('div', { class: 'proj-file-crumb', text: '“' + data.search + '” 검색 — ' + data.items.length + '건' }));
      pairs = data.items.map((it) => ({ it, rel: it.path }));
      if (!data.items.length) frag.push(el('div', { class: 'empty', text: '일치하는 파일이 없습니다.' }));
    } else {
      const crumb = el('div', { class: 'proj-file-crumb' },
        el('span', { class: 'proj-crumb-link', text: '⌂ 루트', onclick: () => { st.path = ''; load(); } }));
      if (data.path) crumb.append(el('span', { text: ' / ' + data.path }));
      frag.push(crumb);
      pairs = data.items.map((it) => ({ it, rel: join(st.path, it.name) }));
      if (!data.items.length && !data.path) frag.push(el('div', { class: 'empty', text: '빈 폴더입니다. ‘＋ 업로드’를 누르거나, 파일·폴더를 끌어다 놓으세요.' }));
    }
    const cards: any[] = [];
    for (const u of uploading) cards.push(uploadingCard(u)); // 업로드 중 카드 먼저(비활성 + 실시간 %)
    lastPairs = pairs;
    const enterDir = (t) => { sel.ids.clear(); st.q = ''; searchIn.value = ''; st.path = t; load(); };
    if (data.search === undefined && data.path) cards.push(projUpCardEl(() => enterDir(data.parent || '')));
    const selCtl = sel.mode ? { ids: sel.ids, onToggle: paintSelBar } : null;
    for (const { it, rel } of pairs) cards.push(projFileCardEl(id, it, rel, enterDir, load, B, selCtl));
    if (cards.length) frag.push(el('div', { class: 'proj-file-grid' }, ...cards));
    body.replaceChildren(...frag);
    if (sel.mode) paintSelBar();
  }
  function join(a, b) { return a ? a + '/' + b : b; }
}

// 이니셜 아바타 — 이름 첫 글자(한글 1자 / 영문 1~2자). 이름 기반 파스텔 배경.
function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  if (/[가-힣]/.test(s[0])) return s.slice(0, 1);
  const parts = s.split(/\s+/);
  if (parts.length >= 2 && parts[1][0]) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
function avatarColor(seed) {
  const s = String(seed || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return 'hsl(' + h + ', 50%, 60%)';
}

// ── 상세 ② 터미널 세션 — 팀원 프로필(아바타) 그리드 → 클릭 시 그 사람 세션 펼침(페이지 내). 본인은 상태메시지 공유. ──
function projectTerminalSection(id, members, meId, base, projectName, project?) {
  const B = base || '/api/ui/projects/';
  const projectRepos = (project && project.repos) || [];
  const card = el('div', { class: 'card proj-term-card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  // '＋ 새 세션' — 곧장 폼이 아니라 드롭다운으로 '어디서 작업할지' 먼저 고른다.
  //  · 내 컴퓨터에서 작업 — 내 PC 터미널 실행 명령을 안내(openLocalWorkModal). 웹은 원격 PC를 스트리밍하지 않음.
  //  · 중앙 컴퓨터에서 작업 — 중앙(박스)에서 공동 세션을 바로 생성(openProjectSessionForm). 관련 레포가 기본값.
  const newBtn = el('button', { class: 'btn btn-ghost btn-sm', 'data-tour': 'proj-new-session', text: '＋ 새 세션' });
  newBtn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu pjv-sess-menu' });
    const close = pjvPopover(newBtn, menu, { align: 'right' });  // 우상단 '＋ 새 세션' 버튼 아래 우측정렬(#481 위치 어색 수정)
    const mkItem = (icon, label, desc, fn) => {
      const item = el('button', { class: 'pjv-menu-item', type: 'button' },
        icon ? el('span', { class: 'pjv-sess-ico', text: icon }) : null,
        el('span', { style: 'display:flex;flex-direction:column;gap:1px;min-width:0' },
          el('span', { text: label }),
          desc ? el('span', { class: 'caption', text: desc }) : null));
      item.onclick = (ev) => { ev.stopPropagation(); close(); fn(); };
      return item;
    };
    const localItem = mkItem('💻', '내 PC에서 열기', '개발자용 · 직접 설치해 실행',
      () => openLocalWorkModal(id, project || { id, name: projectName, repos: projectRepos }));
    const webItem = mkItem('☁️', '웹에서 바로 열기', '설치 불필요 · 팀 공용',
      () => openProjectSessionForm(id, load, B, projectName, projectRepos));
    webItem.dataset.tour = 'sess-web';  // Lively 둘러보기(#761) 앵커 — 이 항목을 눌러 만들기 창을 띄운다
    menu.append(localItem, webItem);
  };
  // 세션 기록(#905 C1) — 끝난 세션 포함 중앙 대화록. 공간 아끼려 섹션 대신 여기 버튼→모달.
  const sessLogBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '📜 세션 기록' });
  sessLogBtn.addEventListener('click', () => openProjectSessionsModal(id, projectName));
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '터미널 세션' }), el('div', { class: 'card-head-actions' }, sessLogBtn, newBtn)));
  card.append(body);
  let sessions: any[] = [];
  let selected: any = null;
  let dragId: any = null;
  const ppl = () => (members && members.length ? members : []);
  const ownerName = (oid) => { const m = ppl().find((x) => x.member_id === oid); return (m && m.display_name) || oid; };
  load();
  return card;

  async function load() {
    body.replaceChildren(skeletonRows(2));
    try { sessions = await api(B + id + '/sessions').then((d) => (d && d.sessions) || []); }
    catch (e) { body.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다')); return; }
    render();
  }
  function render() {
    if (!ppl().length) { body.replaceChildren(el('div', { class: 'empty', text: '팀원이 없습니다. 위 ‘팀원 수정’으로 추가하면 여기에 프로필이 생깁니다.' })); return; }
    const grid = el('div', { class: 'proj-people-grid' }, ...ppl().map(personCircle));
    const panel = el('div', { class: 'proj-people-panel' });
    if (selected) renderPanel(panel);
    body.replaceChildren(grid, panel);
  }
  function personCircle(m) {
    const isMe = m.member_id === meId;
    const cnt = sessions.filter((s) => s.owner === m.member_id).length;
    const avatar = personFace(m.member_id, 'proj-avatar', m.display_name || m.member_id);
    if (cnt) avatar.append(el('span', { class: 'proj-avatar-badge', text: String(cnt) }));
    const hasStatus = !!m.status_message;
    const status = el('div', { class: 'proj-person-status' + (isMe ? ' me' : '') + (hasStatus ? ' filled' : ' empty'),
      text: hasStatus ? m.status_message : (isMe ? '✎ 상태 남기기' : '') });
    if (isMe && hasStatus) status.append(el('span', { class: 'proj-status-pen', text: ' ✎' }));
    if (isMe) { status.title = '클릭해서 상태 메시지 수정'; status.onclick = (ev) => { ev.stopPropagation(); editStatus(m); }; }
    const wrap = el('div', { class: 'proj-person' + (selected === m.member_id ? ' active' : '') },
      avatar, el('div', { class: 'proj-person-name', text: m.display_name || m.member_id }), status);
    wrap.onclick = () => { selected = (selected === m.member_id ? null : m.member_id); render(); };
    // 드래그앤드롭으로 진열 순서 조절(짧게 누르면 선택, 끌면 재배치).
    wrap.draggable = true;
    wrap.addEventListener('dragstart', (ev) => { dragId = m.member_id; wrap.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', m.member_id); } catch (_) { /* */ } });
    wrap.addEventListener('dragend', () => { dragId = null; wrap.classList.remove('dragging'); });
    wrap.addEventListener('dragover', (ev) => { if (dragId && dragId !== m.member_id) { ev.preventDefault(); wrap.classList.add('drop-target'); } });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
    wrap.addEventListener('drop', (ev) => { ev.preventDefault(); wrap.classList.remove('drop-target'); if (dragId && dragId !== m.member_id) reorder(dragId, m.member_id); });
    return wrap;
  }
  function reorder(fromId, toId) {
    const list = ppl();
    const fromIdx = list.findIndex((x) => x.member_id === fromId);
    const toIdx = list.findIndex((x) => x.member_id === toId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    render();
    api(B + id + '/members', { method: 'POST', body: JSON.stringify({ members: list.map((x) => x.member_id) }) })
      .then(() => toast('순서를 저장했습니다'))
      .catch((e) => toast('순서 저장 실패 — ' + e.message, true));
  }
  function renderPanel(panel) {
    const m = ppl().find((x) => x.member_id === selected);
    const mine = sessions.filter((s) => s.owner === selected);
    const head = el('div', { class: 'proj-panel-head' },
      el('b', { text: (m && m.display_name) || selected }), ' 의 세션 ',
      el('span', { class: 'proj-panel-cnt', text: String(mine.length) }));
    // ＋ 새 세션 버튼은 카드 헤더 우상단에 항상 있으므로 패널에선 중복 제거(같은 동작).
    panel.append(head);
    if (!mine.length) { panel.append(el('div', { class: 'empty', text: selected === meId ? '아직 만든 세션이 없어요. ‘＋ 새 세션’으로 시작하세요.' : '아직 만든 세션이 없습니다.' })); return; }
    panel.append(el('div', { class: 'proj-sess-list' }, ...mine.map(sessRow)));
  }
  function sessRow(s) {
    const acts: any[] = [];
    if (s.owned) acts.push(
      el('button', { class: 'btn btn-ghost btn-sm', text: '이름변경', onclick: () => openSessionRename(s, load) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => removeSession(s, load) }));
    acts.push(el('button', { class: 'btn btn-ghost btn-sm', text: 'ℹ 정보', onclick: () => openSessionInfo(s) }));  // 세션 메타 팝업(#480 요청2)
    // 노드 세션(#905 C4)은 &node= 로 입장해야 게이트웨이가 그 노드로 attach 를 릴레이한다.
    const openQ = '/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || '') + (s.node ? '&node=' + encodeURIComponent(s.node.id) : '');
    acts.push(el('button', { class: 'btn btn-primary btn-sm', text: '입장', onclick: () => window.open(openQ, '_blank') }));
    return el('div', { class: 'proj-sess-row' },
      el('div', { class: 'proj-sess-main' },
        el('div', { class: 'proj-sess-name' }, (s.label || s.id),
          s.attached ? el('span', { class: 'proj-sess-live', text: '● 사용 중' }) : null),
        el('div', { class: 'proj-sess-meta', text: (s.harness || 'shell') + ' · 만든이 ' + ownerName(s.owner) + (s.node ? ' · 🖥 ' + (s.node.name || s.node.id) + (s.node.online ? '' : ' (끊김)') : '') })),
      el('div', { class: 'proj-sess-acts' }, ...acts));
  }
  // 세션 메타 팝업(#480 요청2) — 목록이 이미 담아 보내는 값만으로 구성(추가 백엔드 없음). 실시간 상태는 미포함(요청).
  function openSessionInfo(s) {
    const HARNESS_LABEL = { claude: 'Claude Code', codex: 'Codex', shell: '셸 (에이전트 없음)' };
    const model = (s.flags && (s.flags['--model'] || s.flags['-m'])) || '';
    const harnessTxt = (HARNESS_LABEL[s.harness] || s.harness || 'shell') + (model ? ' · ' + model : '');
    const inviteNames = (s.invites || []).map(ownerName);
    const rows: any[] = [
      ['이름', s.label || s.id],
      ['종류', harnessTxt],
      ...(s.node ? [['실행 노드', '🖥 ' + (s.node.name || s.node.id) + (s.node.online ? '' : ' — 연결 끊김')]] : []),  // #905 C4
      ['자동 승인', s.autoApprove ? '켜짐 — 권한 확인 없이 실행' : '꺼짐'],
      ['사용 중', s.attached ? '예 — 지금 열려 있음' : '아니오'],
      ['만든이', ownerName(s.owner)],
      ['만든 시각', s.created ? (new Date(s.created * 1000).toLocaleString('ko-KR') + ' · ' + relTime(s.created * 1000)) : '—'],
      ['작업 폴더', s.dir || '—'],
      ['공개 범위', inviteNames.length ? ('초대: ' + inviteNames.join(', ')) : '비공개 — 프로젝트 세션은 팀원 공용'],
      ['세션 ID', s.id],
    ];
    const rowEl = (kv) => el('div', { style: 'display:flex;gap:10px;padding:7px 0;border-bottom:1px solid rgba(127,127,127,.12)' },
      el('div', { style: 'flex:0 0 92px;color:var(--muted,#888);font-size:13px', text: kv[0] }),
      el('div', { style: 'flex:1;min-width:0;word-break:break-all', text: kv[1] }));
    const enterBtn = el('button', { class: 'btn btn-primary', text: '입장',
      onclick: () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || '') + (s.node ? '&node=' + encodeURIComponent(s.node.id) : ''), '_blank') });
    const back = overlayBox('세션 정보 — ' + (s.label || s.id),
      el('div', {}, ...rows.map(rowEl)),
      el('div', { class: 'ov-actions' }, enterBtn, el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => back.remove() })));
  }
  function editStatus(m) {
    const input = el('input', { type: 'text', value: m.status_message || '', placeholder: '현재 상태 (예: 결제 모듈 작업 중)', maxlength: '200' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const back = overlayBox('내 상태 메시지',
      el('p', { class: 'admin-hint', text: '이 프로젝트에서의 ‘현재 상태’예요 — 이 프로젝트 팀원에게만 보이고, 다른 프로젝트엔 영향을 주지 않아요.' }),
      el('div', { class: 'field' }, input),
      el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    setTimeout(() => input.focus(), 0);
    const go = async () => {
      saveBtn.disabled = true;
      try {
        const r = await api(base + id + '/my-status', { method: 'POST', body: JSON.stringify({ message: input.value.trim() }) });
        m.status_message = r.status_message;
        back.remove(); toast('상태를 저장했습니다'); render();
      } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
    };
    saveBtn.onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
}

// 새 프로젝트 세션 오버레이 — 터미널 탭과 같은 정보(실행기·모델 등 플래그·자동승인). 폴더는 프로젝트 폴더 고정,
//  공개범위는 '팀원 공동'(별도 입력 없음). 생성 후 새 탭 입장.
async function openProjectSessionForm(id, reload, base, projectName, projectRepos?) {
  const B = base || '/api/ui/projects/';
  let cfg: any;
  try { cfg = await api('/api/ui/terminal/config'); }
  catch (e) { toast('세션 설정을 불러오지 못했습니다 — ' + e.message, true); return; }
  const harnesses = cfg.harnesses || [];
  const prefs = termCreatePrefs();   // 이전 '실행 설정'(터미널 탭 새 세션과 같은 기억 — #673/#req) 프리필
  const nameIn = el('input', { type: 'text', value: projectName || '', placeholder: '세션 이름 (예: 개발, 빌드)', maxlength: '80' });
  const harnessSel = el('select', { class: 'term-input' }, ...harnesses.map((h) => el('option', { value: h.key, text: h.label })));
  const flagsBox = el('div', { class: 'term-flags' });
  const autoCb = el('input', { type: 'checkbox' });
  // #782: 자동 승인 기본 해제(옛 #480 의 '기본 켬' 철회) — 켠 적이 있는 사람만 그 선택이 이어진다(사용자별 기억).
  autoCb.checked = prefs.autoApprove === true;
  const autoRow = el('label', { class: 'proj-sess-auto' }, autoCb, el('span', { text: ' 자동 승인 — 파일 수정·명령 실행을 매번 묻지 않고 바로 진행 (신뢰하는 작업에만)' }));
  // '실행 설정' — 터미널 탭 새 세션 팝업의 프리셋 UI 그대로(#req — 같은 term-preset-* 컴포넌트/요약줄).
  //  요약줄이 프리필 값(하네스·모델·effort)을 그대로 보여주므로 기본 '접힘'(#req 후속 — 터미널 탭과 동일), 클릭으로 펼침.
  const presetSum = el('div', { class: 'term-preset-sum' });
  const presetChev = el('span', { class: 'term-preset-chev' });
  const presetToggle = el('button', { class: 'term-preset-toggle', type: 'button' }, presetSum, presetChev);
  const presetBody = el('div', { class: 'term-preset-body' },
    field('실행 (AI)', harnessSel),
    flagsBox,
    el('div', { style: 'margin-top:10px' }, autoRow));
  let presetOpen = false;   // 기본 접힘(#req 후속) — 프리필 값이 요약줄에 이미 보여 펼칠 필요가 없다.
  const applyPreset = () => { presetBody.style.display = presetOpen ? '' : 'none'; presetChev.textContent = presetOpen ? '▴' : '▾'; };
  presetToggle.onclick = () => { presetOpen = !presetOpen; applyPreset(); };
  const harnessOf = () => harnesses.find((x) => x.key === harnessSel.value) || {};
  function presetSummary() {
    const h = harnessOf();
    const parts = [h.label || harnessSel.value];
    for (const f of (h.flags || [])) {
      if (f.name !== '--model' && f.name !== '--effort') continue;
      const c = flagsBox.querySelector('[data-flag="' + f.name + '"]') as any;
      parts.push((f.name === '--model' ? '모델 ' : 'effort ') + ((c && c.value) || '기본'));
    }
    presetSum.replaceChildren(el('b', { text: '실행 설정' }), document.createTextNode(' · ' + parts.join(' · ')));
  }
  function renderFlags() {
    const h = harnessOf();
    flagsBox.replaceChildren();
    for (const f of (h.flags || [])) {
      let ctrl: any;
      if (f.type === 'select') ctrl = el('select', { class: 'term-input', 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c, text: c || '(기본)' })));
      else if (f.type === 'bool') ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
      else ctrl = el('input', { class: 'term-input', type: 'text', 'data-flag': f.name, placeholder: f.desc || '' });
      const saved = prefs.flags && prefs.flags[f.name];   // 이전 설정 프리필(#673/#req)
      if (saved != null) { if (ctrl.type === 'checkbox') ctrl.checked = !!saved; else ctrl.value = saved; }
      ctrl.addEventListener('change', presetSummary);
      flagsBox.append(el('div', { class: 'field', style: 'margin-top:12px' },
        el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
    }
    autoRow.style.display = h.hasAutoApprove ? '' : 'none';
    presetSummary();
  }
  harnessSel.addEventListener('change', renderFlags);
  if (prefs.harness && harnesses.some((h) => h.key === prefs.harness)) harnessSel.value = prefs.harness;   // 이전 하네스 프리필
  renderFlags();
  applyPreset();

  // ── 레포에서 작업 (선택, 여러 개) — '내 컴퓨터에서 작업'(work.mjs)과 동일 수준: 박스가 각 레포를 준비(입력 경로에
  //  없으면 레지스트리 clone_url 로 clone)한다. 워크트리면 project/<id>/<repo> 격리 폴더(브랜치 project/<id>). 세션은
  //  프로젝트 폴더에서 열리고 — 워크트리는 그 하위라 접근됨, 비워크트리 클론은 add-dir(.claude/settings.local.json)로 접근. ──
  const boxPathKey = (repo) => 'lively:boxpath:' + repo;            // 박스 경로 기억(로컬PC 경로와 별개 키)
  const savedBoxPath = (repo) => { try { return repo ? (localStorage.getItem(boxPathKey(repo)) || '') : ''; } catch (_) { return ''; } };
  const cloneRepoNames: string[] = [];
  const reposWrap = el('div', {});
  let rrows: any[] = [];
  const fillRepoSel = (sel) => {
    const cur = sel.value;
    sel.replaceChildren(el('option', { value: '', text: '— 코드 저장소 선택 —' }));
    cloneRepoNames.forEach((n) => sel.append(el('option', { value: n, text: n })));
    if (cloneRepoNames.includes(cur)) sel.value = cur;
  };
  const addRepoRow = (initRepo = '') => {
    const sel = el('select', {});
    const pathInp = el('input', { type: 'text', placeholder: '코드를 둘 위치 (비워두면 자동 — 보통 안 건드려도 돼요)' });
    const wtChk = el('input', { type: 'checkbox' }); wtChk.checked = true;
    const branchInp = el('input', { type: 'text', value: 'project/' + id });
    const rmBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '✕' });
    fillRepoSel(sel); if (initRepo) sel.value = initRepo;
    pathInp.value = savedBoxPath(sel.value);
    const branchWrap = el('div', { class: 'field', style: 'margin-top:6px' }, el('label', { class: 'field-label', text: '작업 공간 이름 (자동 · 보통 그대로 두세요)' }), branchInp);
    const pathField = el('div', { class: 'field' }, el('label', { class: 'field-label', text: '코드 저장 위치 (선택)' }), pathInp);
    // 워크트리(격리) 체크 — 기본 화면에선 숨기고 '고급 설정' 안으로 넣는다. 기본값은 체크(권장)라 안 열어도 워크트리로 준비됨.
    const wtRow = el('label', { class: 'proj-sess-auto', style: 'margin-top:2px' }, wtChk, el('span', { text: ' 워크트리 — 다른 작업과 안 섞임 (권장)' }));
    // 고급 설정 — 워크트리·경로·작업공간 이름을 하나의 토글로 접어둔다(기본 닫힘, 중첩 없음). 기본 화면엔 저장소 선택만.
    const advBox = el('div', { style: 'display:none;margin-top:8px' }, wtRow, pathField, branchWrap);
    const advToggle = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '▸ 고급 설정' });
    let advOpen = false;
    advToggle.onclick = () => { advOpen = !advOpen; advBox.style.display = advOpen ? '' : 'none'; advToggle.textContent = (advOpen ? '▾' : '▸') + ' 고급 설정'; };
    const branchVis = () => { branchWrap.style.display = wtChk.checked ? '' : 'none'; };
    const ro: any = { sel, pathInp, wtChk, branchInp };
    rrows.push(ro);
    sel.addEventListener('change', () => { pathInp.value = savedBoxPath(sel.value); });               // 레포 바꾸면 그 레포의 마지막 경로로
    pathInp.addEventListener('change', () => { if (sel.value && pathInp.value.trim()) { try { localStorage.setItem(boxPathKey(sel.value), pathInp.value.trim()); } catch (_) { /* */ } } });
    wtChk.addEventListener('change', branchVis);
    const rowEl = el('section', { class: 'ps-block', style: 'border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:10px;margin-top:8px' },
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, sel, rmBtn),
      el('div', { style: 'margin-top:8px' }, advToggle),
      advBox);
    ro.el = rowEl;
    rmBtn.onclick = () => { rowEl.remove(); rrows = rrows.filter((r) => r !== ro); };
    branchVis(); reposWrap.append(rowEl);
  };
  const addRepoBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 레포 추가', onclick: () => addRepoRow() });
  try {
    const rr = await api('/api/ui/repos');
    ((rr && rr.domainmapRepos) || []).forEach((it) => { if (it && it.name) cloneRepoNames.push(it.name); });
  } catch (_) { /* graceful: 레포 없음 */ }
  // 이 프로젝트의 관련 레포를 기본 행으로(있으면) — 없으면 빈 채로 '+ 레포 추가' 안내.
  (projectRepos || []).filter((n) => cloneRepoNames.includes(n)).forEach((n) => addRepoRow(n));

  // 실행 위치(#905 C4) — 기본 중앙 박스. 등록된 워커/멤버 노드를 고르면 그 노드에서 레포 provision + 세션 생성.
  //  usable=1 로 조직 worker 노드까지 조회(소유 무관 개방). provision 능력 없는 구 번들·오프라인 노드는 disabled 로 이유를 보인다.
  let usableNodes: any[] = [];
  try { usableNodes = (await api('/api/ui/nodes?usable=1')).nodes || []; } catch (_) { /* graceful: 노드 없음 */ }
  const nodeSel = el('select', { class: 'term-input' },
    el('option', { value: '', text: '중앙 컴퓨터 (기본)' }),
    ...usableNodes.map((n) => {
      const caps = Array.isArray(n.agent_caps) ? n.agent_caps : [];
      const suffix = caps.indexOf('provision') < 0 ? ' — 에이전트 업데이트 필요' : (!n.online ? ' — 오프라인' : '');
      const o = el('option', { value: n.id, text: '🖥 ' + (n.name || n.id) + (n.kind === 'worker' ? ' (워커)' : '') + suffix });
      if (suffix) o.disabled = true;
      return o;
    }));
  const nodeField = el('div', { class: 'field', style: 'margin-top:12px' },
    el('label', { class: 'field-label', text: '실행 위치' }), nodeSel,
    el('div', { class: 'caption', text: '기본은 중앙 컴퓨터입니다. 등록된 워커/멤버 노드를 고르면 그 노드에서 레포를 받아 세션을 엽니다(provision 지원 노드만 고를 수 있어요).' }));

  const saveBtn = el('button', { class: 'btn btn-primary', 'data-tour': 'sess-create', text: '만들고 입장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', 'data-tour': 'sess-cancel', text: '취소', onclick: () => back.remove() });
  // 옛 '▸ 고급 설정 (실행기·모델·자동 승인)' 접이 토글 폐기(#req) — 터미널 탭과 동일한 '실행 설정' 프리셋을
  //  기본 펼침으로 바로 노출(presetToggle + presetBody 위에서 구성). 이전 설정 프리필이라 대부분 그대로 만들면 된다.
  const back = overlayBox('새 터미널 세션',
    el('p', { class: 'admin-hint', text: '이 프로젝트 폴더에서 시작하는 공동 세션입니다 — 프로젝트 팀원만 보고 입장할 수 있어요.' }),
    el('div', { class: 'field', 'data-tour': 'sess-name' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    ...(usableNodes.length ? [nodeField] : []),
    el('div', { class: 'field', 'data-tour': 'sess-repos', style: 'margin-top:12px' },
      el('label', { class: 'field-label', text: '코드 저장소 미리 받기 (선택 — 대개 필요 없어요)' }),
      el('div', { class: 'caption', text: '코드 작업이어도 고를 필요 없어요 — 세션이 코드가 필요해지면 스스로 가져옵니다(프로젝트에 연결된 저장소가 없어도 후보를 찾아 물어봐요). 큰 저장소라 받는 데 오래 걸려서 세션 시작 전에 미리 받아두고 싶을 때만 쓰세요.' }),
      reposWrap, el('div', { style: 'margin-top:8px' }, addRepoBtn)),
    el('div', { class: 'term-preset proj-sess-preset', style: 'margin-top:12px' }, presetToggle, presetBody),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const flags = {};
    for (const ctrl of flagsBox.querySelectorAll('[data-flag]')) {
      const k = ctrl.getAttribute('data-flag');
      const v = ctrl.type === 'checkbox' ? (ctrl.checked ? 'true' : '') : ctrl.value;
      if (v) flags[k] = v;
    }
    saveTermCreatePrefs({ harness: harnessSel.value, flags, autoApprove: autoCb.checked });   // 다음 생성 때 기본값(터미널 탭과 공유 — #673/#req, 자동 승인은 #782)
    try {
      // 선택한 레포(들)를 먼저 provision(clone/worktree + 비워크트리 add-dir). node 를 고르면 그 노드에서, 아니면 중앙 박스에서.
      //  세션도 같은 node 로 열어야 provision 된 폴더에서 열린다(node 없으면 중앙 — 무회귀).
      const node = nodeSel.value || undefined;
      const specs = rrows.map((r) => ({ name: r.sel.value, path: r.pathInp.value.trim(), worktree: r.wtChk.checked, branch: r.branchInp.value.trim() })).filter((s) => s.name);
      if (specs.length) {
        saveBtn.textContent = node ? '레포 준비 중… (노드에서 clone, 잠시)' : '레포 준비 중… (clone 시 잠시)';
        await api(B + id + '/provision', { method: 'POST', body: JSON.stringify({ repos: specs, node }) });
      }
      saveBtn.textContent = node ? '노드에서 세션 여는 중…' : '세션 여는 중…';
      const r = await api(B + id + '/sessions', { method: 'POST', body: JSON.stringify({
        label: nameIn.value.trim(), harness: harnessSel.value, flags, autoApprove: autoCb.checked, node,
      }) });
      back.remove();
      toast(specs.length ? ('레포 ' + specs.length + '개 준비 완료 · 세션을 만들었습니다') : '세션을 만들었습니다');
      // 노드 세션(#905 C4)은 &node= 로 열어야 게이트웨이가 그 노드로 attach WS 를 릴레이한다(public/terminal.js).
      if (r && r.session && r.session.id) window.open('/ui/terminal.html?session=' + encodeURIComponent(r.session.id) + '&label=' + encodeURIComponent(r.session.label || '') + (node ? '&node=' + encodeURIComponent(node) : ''), '_blank');
      reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; saveBtn.textContent = '만들고 입장'; }
  };
}

// 세션 이름 변경 오버레이 — 기존 터미널 세션 API 재사용(소유자만, 서버가 강제).
function openSessionRename(s, reload) {
  const nameIn = el('input', { type: 'text', value: s.label || '', placeholder: '세션 이름', maxlength: '80' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('세션 이름 변경',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const label = nameIn.value.trim();
    if (!label) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      // 노드 세션(#905 C4)은 node 를 함께 보내야 편집이 그 노드에 릴레이된다(안 보내면 게이트웨이 로컬 편집→소유권 오판 403).
      await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label, node: (s.node && s.node.id) || undefined }) });
      back.remove(); toast('이름을 변경했습니다'); reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
// 세션 삭제 — 확인 후 tmux 세션 종료(소유자만). 실행 중 작업도 종료됨.
async function removeSession(s, reload) {
  if (!confirm('세션 ‘' + (s.label || s.id) + '’을(를) 삭제할까요?\n\n실행 중인 작업이 함께 종료됩니다(되돌릴 수 없음).')) return;
  try {
    // 노드 세션(#905 C4)은 ?node= 로 삭제를 그 노드에 위임한다(터미널 탭과 동일).
    await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node.id) : ''), { method: 'DELETE' });
    toast('세션을 삭제했습니다'); reload();
  } catch (e) { toast('실패 — ' + e.message, true); }
}

// ── 상세 ③ 작업 타임라인 — 팀원 activity + 사람별 필터(전체/팀원 칩). ──
function projectTimelineSection(id, members, base) {
  const B = base || '/api/ui/projects/';
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const st = { person: '' };
  const nameOf = (pid) => { const m = (members || []).find((x) => x.member_id === pid); return (m && m.display_name) || pid || '—'; };
  const chipsBar = el('div', { class: 'proj-tl-filter' });
  function paintChips() {
    const mk = (label, person) => el('button',
      { class: 'proj-tl-chip' + (st.person === person ? ' active' : ''), text: label,
        onclick: () => { st.person = person; paintChips(); load(); } });
    chipsBar.replaceChildren(mk('전체', ''), ...(members || []).map((m) => mk(m.display_name || m.member_id, m.member_id)));
  }
  paintChips();
  card.append(
    el('div', { class: 'card-head' }, el('h3', { text: '작업 타임라인' })),
    el('p', { class: 'proj-tl-note' },
      el('span', { class: 'proj-tl-note-ic', text: 'ⓘ' }),
      el('span', {}, '여기엔 ', el('b', { text: '이 프로젝트에 연결된 작업' }),
        '이 모여요 — 이 프로젝트의 터미널 세션에서 AI와 함께 진행했거나, 이 프로젝트로 직접 기록된 작업입니다(다른 프로젝트의 작업은 섞이지 않아요). ',
        el('b', { text: '확실하게 진행이 된 일을 위주로' }),
        ' 프로젝트 진행의 큰 맥락을 확인하는 용도로 사용해주세요.')),
    chipsBar, body);
  load();
  return card;

  async function load() {
    body.replaceChildren(skeletonRows(3));
    try {
      const qs = st.person ? ('?author_person=' + encodeURIComponent(st.person)) : '';
      const acts = await api(B + id + '/activity' + qs).then((d) => (d && d.activities) || []);
      if (!acts.length) { body.replaceChildren(el('div', { class: 'empty', text: st.person ? '이 팀원의 작업 기록이 없습니다.' : '아직 이 프로젝트 팀원의 작업 기록이 없습니다.' })); return; }
      renderActs(acts);
    } catch (e) { body.replaceChildren(errorNote(e, '타임라인을 불러오지 못했습니다')); }
  }
  // 5개까지 보이고 나머지는 '더 보기'로 펼침(끝없이 길어지지 않게).
  function renderActs(acts) {
    const LIMIT = 5;
    const list = el('div', { class: 'proj-tl-list' });
    for (const a of acts.slice(0, LIMIT)) list.append(actRow(a));
    body.replaceChildren(list);
    if (acts.length > LIMIT) {
      const rest = acts.slice(LIMIT);
      const moreBtn = el('button', { class: 'btn btn-ghost btn-sm proj-tl-more', text: '＋ ' + rest.length + '개 더 보기' });
      moreBtn.onclick = () => { for (const a of rest) list.append(actRow(a)); moreBtn.remove(); };
      body.append(moreBtn);
    }
  }
  function actRow(a) { return activityTimelineRow(a, nameOf); }
}

// 팀원 수정 오버레이 — 현재 팀원 미리 체크된 멀티선택 → 통째 교체 저장.
// (openMembersEdit 제거 — #473 후속. 팀원 편집은 세부 설정의 '팀원' 컴팩트 피커에서 인라인 자동저장.)

// ── 태스크 행 제목 클릭 → 상세 모달 배선(몽키패치) ──
//  동시 리팩터되는 pjvTaskRow 를 인플레이스 편집하지 않고 감싼다(append-only, 그쪽 작업 무손상).
//  pjvTaskRow(projectId, t, members, reload, depth, fields[, …]) 의 인자 위치만 의존(t=1, reload=3) — 가변인자 보존.
(function () {
  if (typeof pjvTaskRow !== 'function' || (pjvTaskRow as any).__tmWrapped) return;
  const _origPjvTaskRow = pjvTaskRow;
  // @ts-ignore 의도적 몽키패치 — function 선언을 런타임에서 재할당(JS 합법·동작 보존). TS 만 막아서 무시.
  pjvTaskRow = function (this: any, ...args: any[]) {
    const node = _origPjvTaskRow.apply(this, args as any);
    try {
      const t = args[1], reload = args[3];
      const titleEl = node && node.querySelector ? node.querySelector('.pjv-trow-title') : null;
      if (titleEl && t && t.id != null && !titleEl.dataset.tmWired) {
        titleEl.dataset.tmWired = '1';
        titleEl.classList.add('clickable');
        titleEl.title = '상세 열기';
        titleEl.addEventListener('click', function (e) { e.stopPropagation(); pjvOpenTaskModal(t.id, reload); });
      }
    } catch (_) { /* 구조 달라도 무해 */ }
    return node;
  };
  (pjvTaskRow as any).__tmWrapped = true;
})();

// ── 태스크 제목: 클릭=상세 모달 / 더블클릭=하위 태스크 추가(클릭업식). 위 모달 배선과 공존하도록 감싼다(append-only). ──
//  같은 click 을 행의 캡처 단계에서 가로채 단일/더블 구분 — 위 래퍼의 제목 click(모달)을 stopImmediatePropagation 으로
//  눌러두고: 1회=240ms 뒤 모달, 2회=하위 태스크 인라인 추가. depth 0(태스크)만. 셀/컨트롤 클릭은 그대로 통과.
(function () {
  if (typeof pjvTaskRow !== 'function' || (pjvTaskRow as any).__cfDblWrapped) return;
  const _inner = pjvTaskRow;
  // @ts-ignore 의도적 몽키패치 — function 선언을 런타임에서 재할당(JS 합법·동작 보존). TS 만 막아서 무시.
  pjvTaskRow = function (this: any, ...args: any[]) {
    const node = _inner.apply(this, args as any);
    try {
      const projectId = args[0], t = args[1], reload = args[3], depth = args[4] || 0;
      if (depth === 0 && node && node.querySelector) {
        const rowEl = node.querySelector('.pjv-trow');
        const titleEl = node.querySelector('.pjv-trow-title');
        const subBox = node.querySelector('.pjv-trow-subs');
        if (rowEl && titleEl && subBox && t && t.id != null && !rowEl.dataset.cfDbl) {
          rowEl.dataset.cfDbl = '1';
          titleEl.title = '클릭: 상세 열기 · 더블클릭: 하위 태스크 추가';
          let clicks = 0, timer: any = null;
          rowEl.addEventListener('click', function (e) {
            // 제목 셀 전체(여백 포함)를 클릭 타깃으로 — 단, 캐럿·상태점은 각자 동작하도록 통과시킨다. 다른 컬럼 셀도 통과.
            if (!e.target.closest('.pjv-trow-title-cell')) return;
            if (e.target.closest('.pjv-trow-caret') || e.target.closest('.pjv-status-dot') || e.target.closest('.pjv-status-btn') || e.target.closest('.pjv-subcount-ico')) return; // 하위 태스크 아이콘 클릭은 펼침(모달/더블클릭 가로채기 제외)
            if (e.target.closest('.pjv-row-check') || e.target.closest('.pjv-row-actions')) return; // 다중선택 체크박스·호버 액션은 각자 동작(모달 가로채지 않음)
            e.stopImmediatePropagation(); e.preventDefault();
            clicks++;
            if (clicks === 1) {
              timer = setTimeout(function () { clicks = 0; if (typeof pjvOpenTaskModal === 'function') pjvOpenTaskModal(t.id, reload); }, 240);
            } else {
              clearTimeout(timer); clicks = 0;
              subBox.hidden = false;
              const car = rowEl.querySelector('.pjv-trow-caret');
              if (car && car.tagName === 'BUTTON') { car.textContent = '▾'; car.setAttribute('aria-expanded', 'true'); }
              pjvShowInlineSubtask(projectId, t, subBox, reload);
            }
          }, true); // 캡처 — 제목 자체 click(모달) 리스너보다 먼저
        }
      }
    } catch (_) { /* 구조 달라도 무해 */ }
    return node;
  };
  (pjvTaskRow as any).__cfDblWrapped = true;
})();

// 업로드 프리미티브(upControl/upDropZone/UpItem/UP_CONFIRM)는 대시보드 '팀 공유 폴더' 브라우저도 그대로 쓴다(#795 — dashboard-home.ts).
//  전송 루프·취소·진행바(upSend/upToast/upProgress)도 마찬가지 — 취소를 화면마다 따로 만들지 않는다(#797).
export type { UpItem };
export {
  PJV_PRIORITY,
  PJV_PRIORITY_ORDER,
  PJV_STATUS_ORDER,
  PJV_TASK_STATUS,
  UP_CONFIRM,
  authDownload,
  authUpload,
  authUploadProgress,
  avatarColor,
  buildWysiwygToolbar,
  companyTimelineSection,
  debounce,
  fileIconSvg,
  fmtDateTime,
  fmtFileDate,
  fmtFileDateFull,
  fmtSize,
  initials,
  mdFromDom,
  mountBodyEditor,
  openFileViewer,
  uploadBodyFile,
  pjvAssigneeControl,
  pjvAssignees,
  pjvAssigneeWrite,
  pjvCheckMini,
  pjvDueControl,
  pjvFieldControl,
  pjvFmtDate,
  pjvGridTemplate,
  pjvIsOverdue,
  pjvCloseProjectModalOnRoute,
  pjvOpenProjectModal,
  pjvProjectModalOpen,
  pjvProjectModalRefreshIfRoute,
  pjvPatchTask,
  pjvPopover,
  pjvPriorityControl,
  pjvSaveTask,
  pjvStatusIconStd,
  pjvStatusMeta,
  pjvTaskModalStatusField,
  pjvTaskRow,
  renderProjectV2Detail,
  renderProjectsV2,
  upControl,
  upDropZone,
  upIsAbort,
  upPrecheckOverwrite,
  upProgress,
  upSend,
  upToast,
};
