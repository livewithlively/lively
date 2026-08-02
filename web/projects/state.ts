// projects/state.ts — #1313 R31: web/projects.ts 분해 ②.
//  프로젝트 화면의 **세션 상태 싱글턴**과 그 영속 계층 —
//   보기 모드(pjvBoardView·pjvSavedView) · 스코프 선택(pjvSidebarSel) · Closed/내할당 · 하위태스크 표시 모드 ·
//   스코프별 뷰 저장(localStorage) · 사이드바 열림(pjvListOpen·pjvFolderOpen + member_side_pref 영속) ·
//   인라인 편집 재렌더용 스크롤/라우트 신호 · 정렬/그룹 컨텍스트.
//  ⚠ 이 모듈이 값을 **단독 소유**한다. ESM import 바인딩은 재할당할 수 없으므로, 밖에서 값을 바꾸는 경로는
//   반드시 아래 세터를 거친다: consumeKeepScroll() · setSortCtx() · setGroupCtx() · clearSortCtx().
//   (객체·Map 싱글턴은 프로퍼티 변형이라 세터가 필요 없다 — pjvBoardView.kanban = … 등은 그대로.)
import { api, state } from '../core.js';

// ── 인라인 편집(상태 아이콘·우선순위·담당자 등) 후 재렌더 시 스크롤 위치 보존 (#358) ──
//  상태 아이콘 클릭 등 인라인 편집은 전체 재페인트(reload)를 부른다. 기본 경로는 먼저 스켈레톤으로
//  교체하는데, 이때 문서 높이가 줄며 브라우저가 스크롤을 맨 위로 클램프 → '새로고침돼서 위로 강제이동'
//  되는 느낌을 준다. 아래 신호를 세팅해 두면 renderProjectV2Board/Detail 이 스켈레톤을 건너뛰고
//  (구 DOM 을 유지한 채 조용히 재페치) 재페인트 후 원래 스크롤 위치를 복원한다.
//  신호는 대상 렌더가 최상단에서 동기적으로 소비하며, 비대상 재로드(예: 태스크 모달 자체 재렌더)는
//  소비하지 않으므로 래퍼가 즉시 null 로 되돌려 다음 페이지 렌더로 새는 것(누수)을 막는다.
let _pjvKeepScrollY: any = null;
let _pjvKeepScrollHost: any = null;   // 그 위치를 가진 스크롤 주체(아래 pjvScrollHost) — 신호와 함께 소비된다
// 프로젝트 상세는 페이지(#/projects2/p/<id> — window 스크롤)로도, 프로젝트 모달 안(.pjv-pm-body 자체 스크롤)으로도
//  같은 렌더러로 그려진다. '지금 그 상세가 어디서 스크롤되는지'가 곧 보존·복원의 주체다.
function pjvScrollHost(): any { return document.querySelector('.pjv-pm-body') || window; }
function pjvScrollTop(host): number { return host === window ? (window.scrollY || window.pageYOffset || 0) : host.scrollTop; }
function pjvScrollSet(host, y) { if (host === window) window.scrollTo(0, y); else host.scrollTop = y; }
function pjvScrollTopNow(): number { return pjvScrollTop(pjvScrollHost()); }   // 지금 상세가 보고 있는 위치(모달이면 모달 안)
function pjvReloadKeepScroll(reload) {
  if (!reload) return;
  const host = pjvScrollHost();
  _pjvKeepScrollHost = host;
  _pjvKeepScrollY = pjvScrollTop(host);
  const ret = reload();      // 대상 렌더가 최상단에서 신호를 동기 소비(스켈레톤 스킵)
  _pjvKeepScrollY = null; _pjvKeepScrollHost = null;    // 미소비(비대상 재로드)면 여기서 즉시 해제 — 누수 방지
  return ret;
}
// 태스크 모달을 닫아 **라우터**가 뒤 화면을 다시 그리는 경우(#1233-1) — history.back() 의 hashchange 는 다음 tick 이라
//  위 동기 소비 계약이 성립하지 않는다. 신호를 잠깐 남겨 두고, 그 사이 아무도 안 쓰면 회수한다(누수 방지).
function pjvKeepScrollForNextRender(y) {
  if (y == null) return;
  const host = pjvScrollHost();
  _pjvKeepScrollHost = host;
  _pjvKeepScrollY = y;
  setTimeout(() => { if (_pjvKeepScrollY === y && _pjvKeepScrollHost === host) { _pjvKeepScrollY = null; _pjvKeepScrollHost = null; } }, 300);
}
// 태스크 모달을 닫고 **이미 그려져 있는 그 페이지로** 돌아가는 경우(#1233) — 라우터가 같은 화면을 처음부터
//  다시 그릴 이유가 없다. 재렌더는 스켈레톤 → 섹션 순차 로드로 문서 높이를 출렁이게 만들고, 그 사이 스크롤이
//  최대치로 클램프돼 위로 튄다('뚜둑'). 스크롤을 뒤쫓아 되돌리는 방식으론 이 출렁임을 못 이긴다 —
//  **애초에 다시 그리지 않는 것**이 답이다. 닫기 직전에 이 신호를 세우면 라우터가 그 주소의 렌더 한 번을
//  건너뛴다(화면·스크롤 그대로 유지). 내용이 바뀌었으면(dirty) 모달 쪽이 조용한 재조회를 따로 돌린다.
let _pjvSkipRouteRenderFor: string | null = null;
function pjvSkipNextRouteRender(hash) {
  if (!hash) return;
  _pjvSkipRouteRenderFor = hash;
  setTimeout(() => { if (_pjvSkipRouteRenderFor === hash) _pjvSkipRouteRenderFor = null; }, 1000); // 미소비 시 회수
}
function pjvConsumeSkipRouteRender(hash) {
  if (_pjvSkipRouteRenderFor && _pjvSkipRouteRenderFor === hash) { _pjvSkipRouteRenderFor = null; return true; }
  return false;
}
// 재페인트 후 스크롤 복원 — 하위 비동기 섹션(폴더·터미널·타임라인)은 재페인트 직후 스켈레톤이라
//  문서가 잠깐 짧아진다. 이때 한 번만 복원하면 목표 위치가 최대 스크롤로 클램프돼 위로 튄다.
//  ⚠ '한 번 도달하면 멈춘다'도 틀렸다(#1233 라이브 실측: 1000 → 321). 도달은 문서가 아직 긴 순간일 수 있고,
//   **그 뒤에** 섹션이 스켈레톤으로 바뀌며 짧아지면 브라우저가 다시 클램프한다 → 창(1.2s) 내내 되돌린다.
//   대신 그 사이 사용자가 스크롤·키를 쓰면 즉시 손을 뗀다(사람의 조작을 덮어쓰지 않는다).
function pjvRestoreScroll(y, host?) {
  if (y == null) return;
  const h = host || pjvScrollHost();
  let stopped = false;
  const optsP: any = { passive: true, capture: true };
  const cleanup = () => {
    window.removeEventListener('wheel', stop, optsP);
    window.removeEventListener('touchmove', stop, optsP);
    window.removeEventListener('keydown', stop, true);
  };
  function stop() { stopped = true; cleanup(); }
  window.addEventListener('wheel', stop, optsP);
  window.addEventListener('touchmove', stop, optsP);
  window.addEventListener('keydown', stop, true);
  // 고정 타이머 창(구 구현: 1.2s)으로는 부족했다 — 섹션이 늦게 그려지면 그 뒤에 클램프가 일어난다.
  //  '목표에 앉은 채로 잠시 흔들림이 없을 때'를 완료로 보고, 그때까지(최대 4s) 매 프레임 되돌린다.
  const t0 = Date.now();
  let settledAt = 0;
  const tick = () => {
    if (stopped) return;
    if (Math.abs(pjvScrollTop(h) - y) > 2) { pjvScrollSet(h, y); settledAt = 0; }
    else if (!settledAt) settledAt = Date.now();
    if ((settledAt && Date.now() - settledAt > 500) || Date.now() - t0 > 4000) { cleanup(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ══ 보기 상태 싱글턴 — 세션 유지(reload 무관). 화면 여러 곳이 같은 객체를 읽고 프로퍼티를 토글한다. ══
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
const pjvBoardView = { byArea: true, byStatus: true, byFolder: false, kanban: false, overview: false, table: false, timeline: false };

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
  return { overview: false, byStatus: true, kanban: false, table: false, timeline: false, savedViewId: null, savedViewName: '', savedViewSort: null };
}
function pjvSnapshotView() {
  return { kanban: !!pjvBoardView.kanban, byStatus: pjvBoardView.byStatus !== false, overview: !!pjvBoardView.overview,
    table: !!pjvBoardView.table, timeline: !!pjvBoardView.timeline,
    savedViewId: pjvSavedView.id, savedViewName: pjvSavedView.name, savedViewSort: pjvSavedView.sort };
}
function pjvApplyView(v) {
  pjvBoardView.kanban = !!(v && v.kanban);
  pjvBoardView.byStatus = !v || v.byStatus !== false;
  pjvBoardView.overview = !!(v && v.overview);
  pjvBoardView.table = !!(v && v.table);
  pjvBoardView.timeline = !!(v && v.timeline);
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

// ══ 사이드바 — 그룹/폴더 펼침(계정별 영속)과 지금 선택된 스코프, 그리고 하위태스크 표시 모드. ══
// 영역 그룹 펼침 상태 사용자 오버라이드 — key: 'L'+id | '__none__'. 없으면 기본(내 영역=펼침)을 따른다. 세션 유지.
const pjvListOpen = new Map<string, boolean>();
// 사이드바 폴더(project_folder) 펼침 상태 — key: folder id(숫자). 없으면 기본 펼침(#475 폴더›리스트 트리).
//  (#1227) 계정별 영속 — 예전엔 이 Map 이 탭 세션 한정이라 **새로고침만 해도 접어둔 폴더가 전부 다시 펼쳐졌다**.
//  이제 서버(member_side_pref)가 정본이라 다른 기기·브라우저로 들어와도 접어둔 대로 열린다. 아래 pjvSidePrefs* 참고.
const pjvFolderOpen = new Map<number, boolean>();
// ── 폴더 접힘 영속(#1227) — 대시보드 개인화(#1129)와 같은 방식: 서버가 정본, localStorage 는 첫 페인트용 캐시(계정별 키),
//  변경은 디바운스 write-through. 저장 실패는 조용히 무시한다(즐겨찾기와 같은 개인 UI 상태 — 실패해도 화면은 이미 맞다). ──
const PJV_SIDE_PREFS_API = '/api/ui/v6/side-prefs';
function pjvSidePrefsCacheKey() { return 'pjv:folderOpen:v1:' + ((state.me && (state.me.userId || state.me.email)) || 'anon'); }
// 지금 트리에 실제로 있는 폴더 id — 저장 시 이걸로 걸러 삭제된 폴더의 접힘 상태가 영원히 쌓이지 않게 한다(비어 있으면 거르지 않음).
const pjvKnownFolderIds = new Set<number>();
// 기본값이 항목마다 달라(일반 폴더=펼침, 아카이브=접힘) '접은 것'과 '편 것'을 따로 담는다 — 3상태(미설정/false/true) 왕복 보존.
function pjvSidePrefsBody() {
  const closed: number[] = [];
  const open: number[] = [];
  for (const [id, v] of pjvFolderOpen) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (pjvKnownFolderIds.size && !pjvKnownFolderIds.has(n)) continue;
    (v ? open : closed).push(n);
  }
  return { folder_closed: closed, folder_open: open };
}
function pjvSidePrefsApply(p) {
  pjvFolderOpen.clear();
  for (const id of (p && p.folder_closed) || []) { const n = Number(id); if (Number.isFinite(n)) pjvFolderOpen.set(n, false); }
  for (const id of (p && p.folder_open) || []) { const n = Number(id); if (Number.isFinite(n)) pjvFolderOpen.set(n, true); }
}
function pjvSidePrefsCacheSave() { try { localStorage.setItem(pjvSidePrefsCacheKey(), JSON.stringify(pjvSidePrefsBody())); } catch (_) { /* noop */ } }
function pjvSidePrefsCacheLoad() { try { const v = JSON.parse(localStorage.getItem(pjvSidePrefsCacheKey()) || 'null'); if (v) pjvSidePrefsApply(v); } catch (_) { /* noop */ } }
let pjvSidePrefsTimer: any = null;
// 접기/펼치기 직후 — 캐시는 즉시, 서버는 디바운스(연속 토글을 한 번의 POST 로).
function pjvSidePrefsPush() {
  pjvSidePrefsCacheSave();
  if (pjvSidePrefsTimer) clearTimeout(pjvSidePrefsTimer);
  pjvSidePrefsTimer = setTimeout(() => {
    pjvSidePrefsTimer = null;
    api(PJV_SIDE_PREFS_API, { method: 'POST', body: JSON.stringify(pjvSidePrefsBody()) }).catch(() => { /* 서버 저장 실패는 조용히 — 캐시엔 이미 반영 */ });
  }, 400);
}
// 보드 진입 시 1회 로드(첫 트리 렌더 전) — 이후엔 인메모리 Map 이 정본이라 다시 GET 하지 않는다.
//  reload 마다 다시 부르면, 디바운스 대기 중인 방금의 토글을 옛 서버 값이 덮어써 '접었는데 다시 펼쳐지는' 레이스가 난다.
let pjvSidePrefsReady: Promise<void> | null = null;
function pjvSidePrefsEnsure() { if (!pjvSidePrefsReady) pjvSidePrefsReady = pjvSidePrefsLoad(); return pjvSidePrefsReady; }
async function pjvSidePrefsLoad() {
  pjvSidePrefsCacheLoad(); // 캐시 먼저 — 서버가 느리거나 실패해도 접어둔 대로 그린다
  let server: any = null;
  try { server = await api(PJV_SIDE_PREFS_API); } catch (_) { return; } // 실패 시 캐시 그대로(무해)
  if (server && server.saved) { pjvSidePrefsApply(server); pjvSidePrefsCacheSave(); return; }
  if (pjvFolderOpen.size) pjvSidePrefsPush(); // 서버 미저장 + 이 브라우저 캐시 있음 → 1회 이관(기존 사용자 보존)
}
// 폴더 펼침 조회·설정의 단일 창구 — id 를 숫자로 정규화(캐시·서버 왕복이 숫자라 키가 어긋나지 않게) + 설정 시 영속.
//  dflt 는 '설정된 적 없을 때'의 기본값: 일반 폴더=펼침(true), 아카이브=접힘(false).
function pjvIsFolderOpen(fid, dflt = true) { const n = Number(fid); return pjvFolderOpen.has(n) ? !!pjvFolderOpen.get(n) : dflt; }
function pjvSetFolderOpen(fid, open) { pjvFolderOpen.set(Number(fid), !!open); pjvSidePrefsPush(); }
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

// ══ 정렬/그룹 컨텍스트 + 드래그 재정렬 오버라이드 — 보드 렌더가 세우고 헤더·툴바가 읽는다. ══
// 현재 렌더 스코프의 정렬 컨텍스트 — 컬럼 헤더(pjvStdColHead/pjvColumnHead)가 클릭 정렬에 사용.
//  renderArea 가 렌더마다 갱신(리스트 스코프 밖 화면에선 null → 헤더 정렬 비활성).
let pjvSortCtx: any = null;
// 현재 렌더 스코프의 그룹바이 컨텍스트 — 툴바 '그룹' 버튼이 사용(renderArea 가 갱신).
let pjvGroupCtx: any = null;

// 드래그 재정렬 직후 세션 오버라이드(#541) — 보드 메모리의 projects 배열은 refetch 전까지 옛 sort 를 들고 있어,
//  드롭 후 같은 세션 안 재렌더에서 원복돼 보인다. 저장 성공 시 여기 기록해 비교자가 우선 참조(다음 fetch 가 진실로 대체).
const pjvLocalSortOverride = new Map<number, number>();

// ── #1313 R31 — 모듈 경계를 넘는 재할당 창구. ESM import 바인딩은 재할당 불가라, 값을 바꾸는 쪽은 세터를 부른다. ──
// 인라인 편집 재렌더 신호의 **동기 소비** — 읽는 즉시 비운다(예전 소비부의 '읽고 null 대입' 두 줄과 동일한 계약).
function consumeKeepScroll(): { y: any; host: any } {
  const y = _pjvKeepScrollY, host = _pjvKeepScrollHost;
  _pjvKeepScrollY = null; _pjvKeepScrollHost = null;
  return { y, host };
}
// 정렬/그룹 컨텍스트 — 보드 렌더가 렌더마다 세우고(setSortCtx/setGroupCtx), 상세 진입은 둘 다 비운다(clearSortCtx).
function setSortCtx(v) { pjvSortCtx = v; }
function setGroupCtx(v) { pjvGroupCtx = v; }
function clearSortCtx() { pjvSortCtx = null; pjvGroupCtx = null; }

export {
  clearSortCtx,
  consumeKeepScroll,
  PJV_SIDE_PREFS_API,
  pjvApplyView,
  pjvBoardMineOnly,
  pjvBoardView,
  pjvClosedView,
  pjvConsumeSkipRouteRender,
  pjvDefaultView,
  pjvExitAreaMode,
  pjvFolderOpen,
  pjvGroupCtx,
  pjvIsFolderOpen,
  pjvKeepScopeOnCollapse,
  pjvKeepScrollForNextRender,
  pjvKnownFolderIds,
  pjvListOpen,
  pjvLoadScopeView,
  pjvLocalSortOverride,
  pjvPersistSideOpen,
  pjvProjClosedView,
  pjvProjTaskMode,
  pjvReloadKeepScroll,
  pjvRestoreScroll,
  pjvSavedView,
  pjvSaveScopeView,
  pjvScopeHash,
  pjvScopeIsFolder,
  pjvScopeKept,
  pjvScopeViewKey,
  pjvScrollHost,
  pjvScrollSet,
  pjvScrollTop,
  pjvScrollTopNow,
  pjvSetFolderOpen,
  pjvSidebarSel,
  pjvSidePrefsApply,
  pjvSidePrefsBody,
  pjvSidePrefsCacheKey,
  pjvSidePrefsCacheLoad,
  pjvSidePrefsCacheSave,
  pjvSidePrefsEnsure,
  pjvSidePrefsLoad,
  pjvSidePrefsPush,
  pjvSkipNextRouteRender,
  pjvSnapshotView,
  pjvSortCtx,
  pjvSubtaskMode,
  pjvSyncUrl,
  setGroupCtx,
  setSortCtx,
};
