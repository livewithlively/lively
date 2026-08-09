// dash/prefs.ts — 대시보드 개인화 저장층(#1313 R41 · dashboard-home.ts 에서 verbatim 분리).
//  localStorage 키 문자열과 버전 이관 로직은 **사용자 데이터 스키마**다 — 문자열 하나만 바뀌어도 그 사람의 배치·필터가
//  초기화된다. 옮길 때 키·순서·기본값을 바이트 그대로 보존했고, 소비자 계약은 dashboard-home.ts 재수출로 유지한다.
//  ⚠ dashLayout()/dashDefaultLayout() 은 위젯 레지스트리(DASH_WIDGETS/DASH_W)를 읽어야 해서 dash/shell.ts 가 갖는다
//   (여기서 import 하면 shell ↔ prefs 순환). 이 파일은 그 짝인 키·버전·writer(dashSaveLayout/dashResetLayout)만 보관한다.
//  ⚠ DASH_NOTIF_GROUPS(알림 유형 카탈로그)도 같은 이유로 여기 산다 — 바로 아래 DASH_NOTIF_DEFAULTS 가 **모듈 초기화
//   시점에** 카탈로그를 접기 때문에, 카탈로그를 widget-notifications.ts 로 올리면 TDZ 로 실제로 깨지는 순환이 된다.
import { api } from '../core.js';
import { dashListStatusDefs, dashResolveStatus } from './status.js';
// ── 최신 알림 사용자화(유형별 on/off) — 전용 알림 백엔드가 없어 대시보드-로컬(localStorage, 기기별). ──
//  카탈로그는 앱 전체 신호를 감사해 '나에 관한 알림'이 될 수 있는 것만 실배선(dead 토글 금지). 사소한 변경(상태·수정·필드)은 기본 off.
const DASH_NOTIF_PREF_KEY = 'dash_notif_prefs_v1';
const DASH_NOTIF_GROUPS = [
    { title: '나에 관한 것', items: [
            { key: 'mention', label: '멘션 (@나)', desc: '댓글에서 나를 언급할 때', on: true },
            { key: 'session_invite', label: 'AI 세션 초대', desc: '나를 초대한 터미널 세션', on: true },
        ] },
    { title: '내 프로젝트', items: [
            { key: 'comment', label: '새 댓글', desc: '내 프로젝트에 달린 댓글', on: true },
            { key: 'activity', label: '팀원 작업', desc: '기능·수정·결정·문서·리서치·리뷰', on: true },
            { key: 'created', label: '새 항목 추가', desc: '태스크·프로젝트가 새로 생김', on: true },
            { key: 'assign', label: '담당자 변경', desc: '담당자가 바뀔 때', on: true },
        ] },
    { title: '사소한 변경', items: [
            { key: 'chore', label: '운영·잡무 처리', desc: 'chore 유형 작업(빌드·정리 등)', on: false },
            { key: 'status', label: '상태 변경', desc: '예: 할 일 → 완료', on: false },
            { key: 'edit', label: '이름·내용 수정', desc: '제목·설명 편집', on: false },
            { key: 'field', label: '기타 필드 변경', desc: '마감·우선순위·시작일 등', on: false },
        ] },
    { title: '일정', items: [
            { key: 'due', label: '마감 임박·지남', desc: '7일 이내 또는 지난 마감', on: true },
        ] },
    // #802 검토 대기 — 지금까진 관리탭 ‹검토 큐›에 직접 들어가야만 보였다. 아무도 안 들어가면 에이전트가 쓴 지식이
    //  승인 대기로 묻힌다(pending 은 검색·세션주입에서 빠져 있다 = "기록했는데 아무도 못 쓰는" 상태).
    { title: '지식', items: [
            { key: 'review', label: '검토 대기 지식', desc: '승인해야 검색·세션주입에 반영돼요', on: true },
        ] },
];
const DASH_NOTIF_DEFAULTS = (() => {
    const d = {};
    for (const g of DASH_NOTIF_GROUPS)
        for (const it of g.items)
            d[it.key] = it.on;
    return d;
})();
function dashNotifPrefs() {
    try {
        return { ...DASH_NOTIF_DEFAULTS, ...(JSON.parse(localStorage.getItem(DASH_NOTIF_PREF_KEY) || '{}') || {}) };
    }
    catch {
        return { ...DASH_NOTIF_DEFAULTS };
    }
}
function dashSaveNotifPrefs(p) { try {
    localStorage.setItem(DASH_NOTIF_PREF_KEY, JSON.stringify(p));
}
catch { /* 저장 실패 무시 */ } }
// 필드 변경 이벤트 → 프리셋 유형 키.
function dashFieldPref(field) {
    if (field === 'status')
        return 'status';
    if (field === 'name' || field === 'description')
        return 'edit';
    if (field === 'assignee')
        return 'assign';
    return 'field';
}
// ── 알림 읽음 상태(인박스) — 읽은 알림 key 집합(기기별 localStorage). 피드엔 없는 '읽음/안읽음'이 알림다움의 핵심. ──
const DASH_NOTIF_READ_KEY = 'dash_notif_read_v1';
function dashNotifReadSet() { try {
    const a = JSON.parse(localStorage.getItem(DASH_NOTIF_READ_KEY) || '[]');
    return new Set(Array.isArray(a) ? a : []);
}
catch {
    return new Set();
} }
function dashSaveNotifRead(set) { try {
    localStorage.setItem(DASH_NOTIF_READ_KEY, JSON.stringify([...set].slice(-300)));
}
catch { /* 저장 실패 무시 */ } }
// ── 위젯 배치(#1232) 저장 — 키·포맷 버전·writer. 저장값 → 정규형 변환(dashLayout)은 위젯 레지스트리를 읽어야 해서 ──
//  dash/shell.ts 에 있고, 그쪽이 이 키·버전을 import 해 쓴다.
const DASH_LAYOUT_KEY = 'dash_layout_v1';
// 2 = 'off(기본 숨김)' 개념이 생긴 뒤 · 3 = 검토 대기 지식도 off 로(기본 배치를 1단계 프리셋과 완전히 동일하게).
//  v2 는 짧게 살아 있었지만 그 사이에 저장한 사람에겐 검토 대기가 열에 박혀 있다 — 버전을 올려 그 한 번을 되돌린다.
// 4 = '최신 알림' hidden 구제(#1570) — 알림 개편(#1571)의 과도기(최신 알림→통합 인박스 대체 후 원복) 상태를
//  연 브라우저에 notif 가 hidden 으로 저장돼 남았다("숨긴 적 없는데 사라짐"). v3 때와 같은 되돌리기를 반대
//  방향으로 한 번 한다(shell.ts dashLayout 마이그레이션).
const DASH_LAYOUT_VER = 4;
function dashSaveLayout(lay) { try {
    localStorage.setItem(DASH_LAYOUT_KEY, JSON.stringify({ v: DASH_LAYOUT_VER, ...lay }));
}
catch { /* 저장 실패 무시 */ } }
function dashResetLayout() { try {
    localStorage.removeItem(DASH_LAYOUT_KEY);
}
catch { /* 무시 */ } }
// ── 개요 리스트 순서(드래그) — 대시보드-로컬(localStorage). 프로젝트 탭의 리스트 순서와는 독립. ──
const DASH_LIST_ORDER_KEY = 'dash_list_order_v1';
function dashListOrderSaved() { try {
    const a = JSON.parse(localStorage.getItem(DASH_LIST_ORDER_KEY) || '[]');
    return Array.isArray(a) ? a : [];
}
catch {
    return [];
} }
function dashSaveListOrder(order) { try {
    localStorage.setItem(DASH_LIST_ORDER_KEY, JSON.stringify(order));
}
catch { /* 저장 실패 무시 */ } dashPrefsPush(); }
// 저장된 순서를 현재 리스트 집합(base)에 적용 — 저장분 먼저(그 순서대로), 새 리스트는 뒤에.
function dashApplyListOrder(base) {
    const saved = dashListOrderSaved();
    const head = saved.filter((id) => base.includes(id));
    const tail = base.filter((id) => !head.includes(id));
    return [...head, ...tail];
}
// dragId 를 targetId 앞(after=false)/뒤(after=true)로 이동 → 저장(현재 화면 밖 리스트 순서도 보존해 병합).
function dashReorderList(order, dragId, targetId, after) {
    const arr = order.filter((id) => id !== dragId);
    const ti = arr.indexOf(targetId);
    const at = ti < 0 ? arr.length : ti + (after ? 1 : 0);
    arr.splice(at, 0, dragId);
    const saved = dashListOrderSaved();
    dashSaveListOrder([...arr, ...saved.filter((id) => !arr.includes(id))]);
}
// ── 개요 카드 표시/숨김(사용자화, #671) — 숨긴 리스트 id 집합을 대시보드-로컬(localStorage, 기기별)에 저장. ──
//  미분류(id 0)까지 개별 토글. 헤더 ⚙ 팝오버 체크박스 + 카드 hover ✕ 두 경로로 조작한다(리스트 순서와는 독립).
const DASH_OV_HIDDEN_KEY = 'dash_ov_hidden_v1';
function dashOvHidden() {
    try {
        const a = JSON.parse(localStorage.getItem(DASH_OV_HIDDEN_KEY) || '[]');
        return new Set(Array.isArray(a) ? a.map(Number) : []);
    }
    catch {
        return new Set();
    }
}
function dashSaveOvHidden(set) { try {
    localStorage.setItem(DASH_OV_HIDDEN_KEY, JSON.stringify([...set]));
}
catch { /* 저장 실패 무시 */ } dashPrefsPush(); }
// ── #req 직접 고른 리스트(화이트리스트) — ⚙ 스페이스›폴더 트리에서 체크한, 내 프로젝트가 없는 리스트. ──
//  hidden(블랙리스트)과 짝이다: 자동 후보는 hidden 으로 빼고, 그 밖의 리스트는 pinned 로 넣는다.
//  pinned 리스트는 mine 필터 없이 '리스트 전체'를 보여준다(그렇지 않으면 0개 빈 카드가 된다).
const DASH_OV_PINNED_KEY = 'dash_ov_pinned_v1';
function dashOvPinned() {
    try {
        const a = JSON.parse(localStorage.getItem(DASH_OV_PINNED_KEY) || '[]');
        return new Set(Array.isArray(a) ? a.map(Number).filter((n) => n > 0) : []);
    }
    catch {
        return new Set();
    }
}
function dashSaveOvPinned(set) { try {
    localStorage.setItem(DASH_OV_PINNED_KEY, JSON.stringify([...set]));
}
catch { /* 저장 실패 무시 */ } dashPrefsPush(); }
// ── #1129 개요 정리(순서·숨김·핀) 멤버별 서버 저장 — 위 localStorage(기기별) 3키를 계정에 묶어 어느 기기/브라우저로 ──
//  들어와도 유지한다. localStorage 는 '빠른 캐시'로 남기고(동기 리더 전부 그대로), 변경 시 서버로 write-through(디바운스),
//  진입 시 서버가 정본이면 캐시를 갈아끼운다. 서버 저장 실패는 조용히 무시(캐시엔 이미 반영 — 즐겨찾기와 같은 개인 UI 상태).
const DASH_PREFS_API = '/api/ui/v6/dash-prefs';
function dashPrefsBody() { return { list_order: dashListOrderSaved(), ov_hidden: [...dashOvHidden()], ov_pinned: [...dashOvPinned()] }; }
function dashPrefsPost() { return api(DASH_PREFS_API, { method: 'POST', body: JSON.stringify(dashPrefsBody()) }).catch(() => { }); }
let dashPrefsTimer = null;
function dashPrefsPush() {
    if (dashPrefsTimer)
        clearTimeout(dashPrefsTimer);
    dashPrefsTimer = setTimeout(() => { dashPrefsTimer = null; dashPrefsPost(); }, 400);
}
// 서버 값으로 localStorage 캐시 seed — 이후 모든 동기 리더가 서버 정본을 읽게 된다.
function dashPrefsSeedLocal(p) {
    const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);
    try {
        localStorage.setItem(DASH_LIST_ORDER_KEY, arr(p.list_order));
        localStorage.setItem(DASH_OV_HIDDEN_KEY, arr(p.ov_hidden));
        localStorage.setItem(DASH_OV_PINNED_KEY, arr(p.ov_pinned));
    }
    catch { /* 무시 */ }
}
// 진입 시 서버 개인화를 반영. 서버에 저장 이력(saved)이 있으면 그게 정본 → 캐시 갈아끼우고 재렌더가 필요하면 true.
//  저장 이력이 없으면(첫 사용) 이 브라우저의 기존 localStorage 정리를 1회 서버로 이관한다(기존 사용자 보존).
async function dashPrefsSync() {
    let server = null;
    try {
        server = await api(DASH_PREFS_API);
    }
    catch {
        return false;
    } // 실패 시 캐시 그대로(무해)
    if (server && server.saved) {
        dashPrefsSeedLocal(server);
        return true;
    }
    const hasLocal = dashListOrderSaved().length || dashOvHidden().size || dashOvPinned().size;
    if (hasLocal)
        dashPrefsPost(); // 서버 미저장 + 로컬 정리 있음 → 즉시 이관(디바운스 없이)
    return false; // 캐시(로컬)가 이미 화면과 일치 — 재렌더 불필요
}
// ── #req 리스트별 목록 필터(기기별) — 리스트 헤더 우측 필터 버튼. 리스트 id 별 { who, q, st[], pri[], tags[], due }. ──
//  직접 고른 리스트는 남의 프로젝트까지 들어와 길어지므로, 요약 카드는 그대로 두고 아래 목록만 좁힌다.
//  #1236 고도화 — 담당·이름만으론 있으나 마나였다: 상태(리스트 커스텀 상태 어휘 그대로)·우선순위·태그·마감 축을 더해 실제로 좁힌다.
//   구 저장분({who,q}만)은 새 축이 빈 배열/''로 읽혀 그대로 호환된다.
const DASH_LISTFILTER_KEY = 'dash_list_filter_v1';
function dashListFilterAll() {
    try {
        const o = JSON.parse(localStorage.getItem(DASH_LISTFILTER_KEY) || '{}');
        return (o && typeof o === 'object') ? o : {};
    }
    catch {
        return {};
    }
}
function dashListFilter(listId) {
    const v = dashListFilterAll()[String(Number(listId) || 0)] || {};
    const arr = (x) => (Array.isArray(x) ? x.map(String) : []);
    return {
        who: v.who === 'mine' ? 'mine' : 'all', q: typeof v.q === 'string' ? v.q : '',
        st: arr(v.st), pri: arr(v.pri), tags: arr(v.tags),
        due: (v.due === 'over' || v.due === 'week' || v.due === 'unset') ? v.due : '',
    };
}
// 걸린 필터가 하나라도 있나 — 버튼 강조·'초기화' 노출·저장 정리의 공통 판정.
function dashListFilterOn(lf) {
    return lf.who === 'mine' || !!String(lf.q || '').trim() || (lf.st || []).length > 0 || (lf.pri || []).length > 0 || (lf.tags || []).length > 0 || !!lf.due;
}
function dashSaveListFilter(listId, v) {
    const all = dashListFilterAll();
    const k = String(Number(listId) || 0);
    const n = v ? {
        who: v.who === 'mine' ? 'mine' : 'all', q: String(v.q || ''),
        st: (v.st || []).map(String), pri: (v.pri || []).map(String), tags: (v.tags || []).map(String),
        due: (v.due === 'over' || v.due === 'week' || v.due === 'unset') ? v.due : '',
    } : null;
    if (!n || !dashListFilterOn(n))
        delete all[k]; // 기본값이면 항목째 지워 저장소를 깨끗이
    else
        all[k] = n;
    try {
        localStorage.setItem(DASH_LISTFILTER_KEY, JSON.stringify(all));
    }
    catch { /* 무시 */ }
}
// #1236 리스트 필터의 상태 축 키 — 커스텀 상태 리스트면 해석된 def.key(그 리스트 어휘), 아니면 표준 3버킷(todo|active|done).
//  dashListStatusDefs 의 키와 1:1 이라 필터 옵션(=defs)과 판정이 같은 어휘를 쓴다.
function dashProjFilterStatusKey(p, l) {
    const s = l && l.settings;
    if (s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length) {
        const d = dashResolveStatus(p, dashListStatusDefs(l));
        if (d)
            return String(d.key);
    }
    if (p.status === 'done' || p.status_category === 'done' || p.status_category === 'closed')
        return 'done';
    return p.status === 'todo' ? 'todo' : 'active';
}
// 로컬(사용자 시간대) YYYY-MM-DD — 마감 축의 '지남/7일 이내' 판정 기준일. toISOString(UTC)을 쓰면 자정 근처에 하루 밀린다.
function dashLocalDay(offsetDays) {
    const t = new Date();
    t.setDate(t.getDate() + (offsetDays || 0));
    const pad = (n) => String(n).padStart(2, '0');
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}
// #1236 리스트 필터 술어 — 축별로 쪼개, 본문 필터와 팝오버 카운트('자기 축만 뺀 풀', #1098 세션 필터 동형)가 같은 판정을 쓴다.
//  mineIds = 위젯이 아는 '내 프로젝트' id 집합(호출부 주입). 상태 축은 선택 시 위젯 칩(mode)을 대체한다 — 적용은 호출부가 정한다.
function dashListFilterPreds(lf, l, mineIds) {
    const q = String(lf.q || '').trim().toLowerCase();
    const st = new Set(lf.st), pri = new Set(lf.pri), tg = new Set(lf.tags);
    const today = dashLocalDay(0), weekEnd = dashLocalDay(7);
    return {
        who: (p) => lf.who !== 'mine' || mineIds.has(Number(p.id)),
        q: (p) => !q || String(p.name || '').toLowerCase().includes(q),
        st: (p) => !st.size || st.has(dashProjFilterStatusKey(p, l)),
        pri: (p) => !pri.size || pri.has(String(p.priority || 'none')),
        tags: (p) => !tg.size || (p.tags || []).some((x) => tg.has(String(x.id))),
        due: (p) => {
            if (!lf.due)
                return true;
            const d = p.due_date ? String(p.due_date).slice(0, 10) : '';
            if (lf.due === 'unset')
                return !d;
            if (!d)
                return false;
            return lf.due === 'over' ? d < today : (d >= today && d <= weekEnd);
        },
    };
}
// ── #req 내 프로젝트 위젯 개인화(기기별) — 태스크 수 표시 방식 · 기본 상태 필터. ⚙ 팝오버에서 선택. ──
const DASH_TASKCOUNT_KEY = 'dash_taskcount_v1'; // 'active'(진행 중만·기본) | 'all'(전체) | 'progress'(완료/전체)
const DASH_PROJFILTER_KEY = 'dash_projfilter_v1'; // 'active'(진행 중·기본) | 'all'(전체) — 첫 진입 기본 필터
function dashTaskCountMode() { try {
    const v = localStorage.getItem(DASH_TASKCOUNT_KEY);
    return (v === 'all' || v === 'progress') ? v : 'active';
}
catch {
    return 'active';
} }
function dashSaveTaskCountMode(v) { try {
    localStorage.setItem(DASH_TASKCOUNT_KEY, v);
}
catch { /* 무시 */ } }
function dashProjFilterDefault() { try {
    return localStorage.getItem(DASH_PROJFILTER_KEY) === 'all' ? 'all' : 'active';
}
catch {
    return 'active';
} }
function dashSaveProjFilterDefault(v) { try {
    localStorage.setItem(DASH_PROJFILTER_KEY, v);
}
catch { /* 무시 */ } }
// 프로젝트 행 태스크 칩 텍스트/표시여부 — active=진행 중 태스크(전체−완료; 완료·닫힘은 native done 으로 집계됨).
function dashTaskChip(p) {
    const total = Number(p.task_count) || 0, done = Number(p.task_done_count) || 0, active = Math.max(0, total - done);
    const mode = dashTaskCountMode();
    if (mode === 'all')
        return total > 0 ? { text: String(total), title: total + '개 태스크' } : null;
    if (mode === 'progress')
        return total > 0 ? { text: done + '/' + total, title: '완료 ' + done + ' / 전체 ' + total } : null;
    return active > 0 ? { text: String(active), title: '진행 중 태스크 ' + active + '개 (완료·닫힘 제외)' } : null;
}
// ── 위젯별 기본 표시 설정(기기별 localStorage) — 헤더 ⚙ 통일 컨트롤이 읽고/쓴다. ──
const DASH_FOLD_VIEW_KEY = 'dash_fb_view_v1'; // 공유 폴더 브라우저 기본 뷰(icon|list)
const DASH_SESS_FILTER_KEY = 'dash_sess_filter_v1'; // (구) 내 AI 세션 단일 필터(all|private|invited|myproj) — v2 로 1회 이관 후 제거
const DASH_SESS_FILTER2_KEY = 'dash_sess_filter_v2'; // #1098 출처·상태 2축 다중선택 {src:[],state:[]}
const DASH_SESS_SHOWCLOSED_KEY = 'dash_sess_showclosed_v1'; // 완료·보관 프로젝트 세션 포함 여부(기본 off=숨김) #req
const DASH_SESS_ONLINEONLY_KEY = 'dash_sess_onlineonly_v1'; // 접속 중(온라인=attached) 세션만 보기(기본 off) #670
// #670 '온라인 세션만' — 지금 도는(작업 중·확인 필요·대기 중) 세션만 남기고 오프라인·종료됨·복원 가능은 숨긴다.
//  #1098 에서 상태 필터와 겹친다고 한 번 없앴다가, 체크 세 개를 매번 고르는 것보다 스위치 하나가 편해 되살렸다(상민님).
//  상태 필터와는 AND — 둘 다 걸면 '고른 상태 중 살아 있는 것'만 남는다.
function dashSessOnlineOnly() { try {
    return localStorage.getItem(DASH_SESS_ONLINEONLY_KEY) === '1';
}
catch {
    return false;
} }
function dashSaveSessOnlineOnly(v) { try {
    if (v)
        localStorage.setItem(DASH_SESS_ONLINEONLY_KEY, '1');
    else
        localStorage.removeItem(DASH_SESS_ONLINEONLY_KEY);
}
catch { /* 무시 */ } }
const DASH_SESS_SORT_KEY = 'dash_sess_sort_v1'; // 세션 카드 정렬(smart|recent|name) #req
const DASH_SESS_DENSITY_KEY = 'dash_sess_density_v1'; // 세션 카드 보기 밀도(full=자세히 기본 | compact=간략히) #758
const DASH_LOG_TYPE_KEY = 'dash_log_type_v1'; // 작업 로그 기본 유형 필터(''=전체 | feature·fix·… #req R14)
function dashFoldView() { try {
    return localStorage.getItem(DASH_FOLD_VIEW_KEY) === 'list' ? 'list' : 'icon';
}
catch {
    return 'icon';
} }
function dashSaveFoldView(v) { try {
    localStorage.setItem(DASH_FOLD_VIEW_KEY, v === 'list' ? 'list' : 'icon');
}
catch { /* 무시 */ } }
// #1098 세션 필터 = 출처·상태 두 축의 **다중선택**(빈 집합 = 그 축 안 거름 = '전체').
//  섹션 안은 OR, 섹션끼리는 AND. 구버전 단일값(v1)과 '온라인 세션만'(#670) 토글은 첫 로드에서 1회 이관하고 지운다.
const DASH_SESS_SRC_KEYS = ['myproj', 'private', 'invited'];
const DASH_SESS_STATE_KEYS = ['busy', 'waiting', 'idle', 'restorable', 'exited'];
function dashSessFilter2() {
    try {
        const raw = localStorage.getItem(DASH_SESS_FILTER2_KEY);
        if (raw) {
            const o = JSON.parse(raw) || {};
            return {
                src: (Array.isArray(o.src) ? o.src : []).filter((k) => DASH_SESS_SRC_KEYS.includes(k)),
                state: (Array.isArray(o.state) ? o.state : []).filter((k) => DASH_SESS_STATE_KEYS.includes(k)),
            };
        }
        // 1회 이관 — 구 단일 출처 필터만. ('온라인 세션만'은 토글 그대로 살아 있으므로 그 키는 건드리지 않는다.)
        const old = localStorage.getItem(DASH_SESS_FILTER_KEY);
        const src = DASH_SESS_SRC_KEYS.includes(old) ? [old] : [];
        const state = [];
        if (src.length)
            dashSaveSessFilter2({ src, state });
        localStorage.removeItem(DASH_SESS_FILTER_KEY);
        return { src, state };
    }
    catch {
        return { src: [], state: [] };
    }
}
function dashSaveSessFilter2(f) {
    try {
        if (!f.src.length && !f.state.length)
            localStorage.removeItem(DASH_SESS_FILTER2_KEY);
        else
            localStorage.setItem(DASH_SESS_FILTER2_KEY, JSON.stringify({ src: f.src, state: f.state }));
    }
    catch { /* 무시 */ }
}
// #req 완료·보관(done/closed) 프로젝트 세션은 기본 숨김 — 토글 켜면 포함(표시). 기기별 저장.
function dashSessShowClosed() { try {
    return localStorage.getItem(DASH_SESS_SHOWCLOSED_KEY) === '1';
}
catch {
    return false;
} }
function dashSaveSessShowClosed(v) { try {
    if (v)
        localStorage.setItem(DASH_SESS_SHOWCLOSED_KEY, '1');
    else
        localStorage.removeItem(DASH_SESS_SHOWCLOSED_KEY);
}
catch { /* 무시 */ } }
// #670 접속 중(온라인=attached)인 세션만 보기 — 토글 켜면 오프라인/미접속 세션 숨김. 기기별 저장.
function dashSessSort() { try {
    const v = localStorage.getItem(DASH_SESS_SORT_KEY);
    return ['active', 'priority', 'recent', 'name'].includes(v) ? v : 'active';
}
catch {
    return 'active';
} }
function dashSaveSessSort(v) { try {
    localStorage.setItem(DASH_SESS_SORT_KEY, v);
}
catch { /* 무시 */ } }
// #758 세션 카드 보기 밀도 — full(자세히, 기본=#745 리치 2줄 카드) | compact(간략히, 한 줄). ⚙ 설정 팝오버에서 선택, 기기별 저장.
function dashSessDensity() { try {
    return localStorage.getItem(DASH_SESS_DENSITY_KEY) === 'compact' ? 'compact' : 'full';
}
catch {
    return 'full';
} }
function dashSaveSessDensity(v) { try {
    if (v === 'compact')
        localStorage.setItem(DASH_SESS_DENSITY_KEY, 'compact');
    else
        localStorage.removeItem(DASH_SESS_DENSITY_KEY);
}
catch { /* 무시 */ } }
function dashLogType() { try {
    return localStorage.getItem(DASH_LOG_TYPE_KEY) || '';
}
catch {
    return '';
} }
function dashSaveLogType(v) { try {
    if (v)
        localStorage.setItem(DASH_LOG_TYPE_KEY, v);
    else
        localStorage.removeItem(DASH_LOG_TYPE_KEY);
}
catch { /* 무시 */ } }
// 폴더 기본 뷰 설정 팝오버(⚙) — 브라우저 열 때 initial 뷰가 됨.
// ── ⑥ 내 할 일 기본 필터(기기별) — all(전체) | soon(임박). ⚙ 팝오버에서 선택, 위젯 칩의 첫 상태가 된다. ──
const DASH_TASK_FILTER_KEY = 'dash_task_filter_v1';
function dashTaskFilterDefault() { try {
    return localStorage.getItem(DASH_TASK_FILTER_KEY) === 'soon' ? 'soon' : 'all';
}
catch {
    return 'all';
} }
function dashSaveTaskFilter(v) { try {
    if (v === 'soon')
        localStorage.setItem(DASH_TASK_FILTER_KEY, 'soon');
    else
        localStorage.removeItem(DASH_TASK_FILTER_KEY);
}
catch { /* 무시 */ } }
// ── ⑦ 검토 대기 지식 기본 필터(기기별) — all(전체) | mine(내 도메인). 내 도메인이 없으면 위젯이 all 로 고정한다. ──
const DASH_RVW_FILTER_KEY = 'dash_review_filter_v1';
function dashRvwFilterDefault() { try {
    return localStorage.getItem(DASH_RVW_FILTER_KEY) === 'mine' ? 'mine' : 'all';
}
catch {
    return 'all';
} }
function dashSaveRvwFilter(v) { try {
    if (v === 'mine')
        localStorage.setItem(DASH_RVW_FILTER_KEY, 'mine');
    else
        localStorage.removeItem(DASH_RVW_FILTER_KEY);
}
catch { /* 무시 */ } }
export { DASH_NOTIF_PREF_KEY, DASH_NOTIF_GROUPS, DASH_NOTIF_DEFAULTS, dashNotifPrefs, dashSaveNotifPrefs, dashFieldPref, DASH_NOTIF_READ_KEY, dashNotifReadSet, dashSaveNotifRead, DASH_LAYOUT_KEY, DASH_LAYOUT_VER, dashSaveLayout, dashResetLayout, DASH_LIST_ORDER_KEY, dashListOrderSaved, dashSaveListOrder, dashApplyListOrder, dashReorderList, DASH_OV_HIDDEN_KEY, dashOvHidden, dashSaveOvHidden, DASH_OV_PINNED_KEY, dashOvPinned, dashSaveOvPinned, DASH_PREFS_API, dashPrefsBody, dashPrefsPost, dashPrefsPush, dashPrefsSeedLocal, dashPrefsSync, DASH_LISTFILTER_KEY, dashListFilterAll, dashListFilter, dashListFilterOn, dashSaveListFilter, dashProjFilterStatusKey, dashLocalDay, dashListFilterPreds, DASH_TASKCOUNT_KEY, DASH_PROJFILTER_KEY, dashTaskCountMode, dashSaveTaskCountMode, dashProjFilterDefault, dashSaveProjFilterDefault, dashTaskChip, DASH_FOLD_VIEW_KEY, DASH_SESS_FILTER_KEY, DASH_SESS_FILTER2_KEY, DASH_SESS_SHOWCLOSED_KEY, DASH_SESS_ONLINEONLY_KEY, dashSessOnlineOnly, dashSaveSessOnlineOnly, DASH_SESS_SORT_KEY, DASH_SESS_DENSITY_KEY, DASH_LOG_TYPE_KEY, dashFoldView, dashSaveFoldView, DASH_SESS_SRC_KEYS, DASH_SESS_STATE_KEYS, dashSessFilter2, dashSaveSessFilter2, dashSessShowClosed, dashSaveSessShowClosed, dashSessSort, dashSaveSessSort, dashSessDensity, dashSaveSessDensity, dashLogType, dashSaveLogType, DASH_TASK_FILTER_KEY, dashTaskFilterDefault, dashSaveTaskFilter, DASH_RVW_FILTER_KEY, dashRvwFilterDefault, dashSaveRvwFilter, };
