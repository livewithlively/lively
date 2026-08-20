// v2/side.ts — 새 셸 좌측 사이드바(#1719): 워크스페이스 **전체** 프로젝트 ▸ 살아 있는 세션 트리.
//  규칙(상민님 2026-08-18, 같은 날 재구성 지시로 갱신):
//   · 프로젝트는 워크스페이스 전체가 보인다(내 것만이 아니다). '내 프로젝트만'은 필터 안의 토글.
//   · **고정**은 사람이 고른다(2026-08-19) — 행의 압정을 누르면 맨 위로. 자동으로 뭘 올려 두지 않는다
//     (열린 세션을 자동으로 띄우던 줄은 같은 날 걷었다: 내가 고르지 않은 것이 자리를 차지했다).
//   · 프로젝트 아래엔 도는 세션이 먼저. **멈춘 세션도 사라지지 않는다** — 그 아래 '지난 세션 n' 한 줄로 접혀 있고
//     펴면 그 자리에 그대로 있다(#1808, 원준님 신고: 자동회수로 멈추면 새 셸 어디에서도 못 찾겠다).
//     ⚠ 종전 규칙("끝난 것은 프로젝트 화면·세션 이력에서")의 의도는 **가독성**이었다 — 그건 접어 두는 것으로 지키고,
//     '사라진다'는 부작용만 없앤다. 기본 화면은 종전과 똑같다(도는 세션만 펴져 있다).
//   · 완료 프로젝트는 기본 숨김(살아 있는 세션이 있으면 예외로 보인다). 정렬 = 마지막 작업 시각 내림차순.
//   · **기본 화면은 목록 하나다** — 상태 칩·완료 숨김·내 프로젝트만 같은 필터는 전부 [필터] 버튼 속 팝오버로
//     들어간다(밖에 늘어놓으면 목록보다 조작부가 먼저 읽힌다 — 번잡함의 주범이었다).
//   · **위계가 시각으로 갈린다**: 프로젝트 행 = 폴더 아이콘 + 굵은 글씨 → 누르면 프로젝트 화면.
//     세션 행 = 들여쓴 레일 + 상태점 + 보통 글씨 → 누르면 그 세션의 대화. 서로 다른 곳으로 간다는 게 생김새에서 보인다.
//   · 흐린 회색 본문 금지 — 완료·조용한 프로젝트도 이름은 같은 잉크색이고, 상태는 작은 태그·시각으로만 구분한다
//     (연회색 글씨가 목록의 절반을 차지하면 전체가 바래 보인다).
//   · **위계는 네 층이다**(상민님 2026-08-19 "전반적으로 위계가 잘못된 듯"):
//       ⓪ 워크스페이스 — 여기가 어디인가(맨 위 한 줄, 스위처)
//       ① 늘 있는 곳 — 홈 · 리브
//       ② 내용 — 프로젝트 ▸ 세션
//       ③ 도구·나 — 앱 · 계정
//     ①~③ 은 **같은 모양의 행**이고 기둥도 같다. 층은 구분선과 작은 라벨로만 나눈다 —
//     리브만 알약(테두리·큰 글씨)이면 목록보다 먼저 읽혀 위계가 뒤집힌다.
//  main.ts 가 데이터·활성 키를 넘기고, 필터·펼침 같은 사이드바 자체 상태는 여기 산다(브라우저에 기억).
import { anchoredPopover, api, el, loadPeopleAvatars, logout, navOn, personFace, profileAvatar, relTime, setUiModeOverride, state, sv, toast } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { SESS_STATES } from '../session-status.js';
import { appIcon, openLaunchpad, visibleApps } from './apps.js';
import { dotCls, isLiveSess, isPastSess, sessWork } from './views.js';
import { switcherTop } from './switcher.js';
// 기본은 **전부 접힘**(상민님 2026-08-18: 선택된 프로젝트 외에는 다 접어둔다) — 사용자가 편 것만 기억한다.
//  지금 보는 프로젝트(선택)는 늘 펼침이 기본이고, 그걸 접은 건 잠깐의 상태라 기억하지 않는다(다음 방문엔 다시 펼쳐 보인다).
const OPEN_KEY = 'lively_v2_opened';
const DONE_KEY = 'lively_v2_side_done'; // '1' = 완료 프로젝트도 보인다(필터 풀림)
const MINE_KEY = 'lively_v2_side_mine'; // '1' = 내 프로젝트만
const PAST_KEY = 'lively_v2_side_past'; // '지난 세션' 묶음을 펴 둔 프로젝트 키
const ALL_KEY = 'lively_v2_side_all'; // '1' = 「전체 프로젝트」 묶음을 펴 둠 (기본 접힘 — 매일 화면은 '진행 중'만)
const PIN_KEY = 'lively_v2_side_pin'; // 위에 고정한 프로젝트 키('p:123') — 사람이 고른 것만 들어간다
const MAX_SESS = 12; // 한 프로젝트 아래 펼쳐 보이는 세션 상한(넘치면 '외 n개' → 프로젝트 화면)
let openSet = new Set();
let pastSet = new Set(); // '지난 세션'을 펴 둔 프로젝트 — 브라우저에 기억(도는 세션과 따로 접힌다)
let allOpen = false; // 「전체 프로젝트」 펼침 — 브라우저에 기억
let pinnedSet = new Set(); // ★고정 = 사람이 고른 프로젝트를 맨 위로(상민님 2026-08-19)
const closedSelected = new Set(); // 선택 프로젝트를 일부러 접은 것 — 세션(페이지) 수명만
let showDone = false;
let mineOnly = false;
let sideFilter = '';
let findOpen = false; // 돋보기로 펼친 검색칸. **검색어가 있으면 늘 펼친 상태**로 친다(왜 목록이 짧은지 화면이 말해야 한다)
let keyBound = false;
let stateFilter = null; // 상태 칩 — 세션 상태 key(waiting·busy…) 하나. 새로고침하면 풀린다(잠깐 보는 렌즈)
let people = {}; // id → 멤버(표시명·아바타). 남의 세션 소유자 이름용
let inited = false;
let last = null;
function loadSet(k) { try {
    const a = JSON.parse(localStorage.getItem(k) || '[]');
    return new Set(Array.isArray(a) ? a : []);
}
catch (_) {
    return new Set();
} }
function saveSet(k, s) { try {
    if (s.size)
        localStorage.setItem(k, JSON.stringify([...s]));
    else
        localStorage.removeItem(k);
}
catch (_) { /* noop */ } }
function saveFlag(k, v) { try {
    if (v)
        localStorage.setItem(k, '1');
    else
        localStorage.removeItem(k);
}
catch (_) { /* noop */ } }
function init() {
    if (inited)
        return;
    inited = true;
    openSet = loadSet(OPEN_KEY);
    pastSet = loadSet(PAST_KEY);
    try {
        allOpen = localStorage.getItem(ALL_KEY) === '1';
    }
    catch (_) { /* noop */ }
    pinnedSet = loadSet(PIN_KEY);
    try {
        showDone = localStorage.getItem(DONE_KEY) === '1';
        mineOnly = localStorage.getItem(MINE_KEY) === '1';
    }
    catch (_) { /* noop */ }
    void loadPeopleAvatars().then((m) => { people = m || {}; if (last)
        redraw(); });
}
/** 도는 세션 = tmux 에 살아 있는 박스. / 지난 세션 = 되살릴 수 있는 것 전부(중단됨·종료됨·메모리 부족·기록만). views.ts 가 정의한다. */
const isLive = isLiveSess;
const isPast = isPastSess;
// 상태 key → 표시어. SESS_STATES 에 없는 'log'(중앙 기록만 남은 대화)까지 덮는다.
const stLabel = (k) => (SESS_STATES[k] ? SESS_STATES[k].label : k === 'log' ? '기록' : k);
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
// 하네스가 pane 제목에 자기 이름만 써 둔 것 — '지금 하는 일'이 아니다(정보 0).
const HARNESS_TITLES = new Set(['claude code', 'claude', 'codex', 'opencode', 'antigravity', 'grok', 'shell', 'bash', 'zsh', 'tmux', 'node']);
// 기계가 붙인 세션 이름 — 사람이 읽을 게 없다('이어보기 · 3e1ca8f2', '위탁 #t501ac…').
// 이름 자리에서 걷어낼 자동 생성 이름. ⚠ **id 꼴은 따로 본다**(#1744) — '위탁 #41'·'이어보기 · 3e1ca8f2' 는
//  pane 제목이 없을 때 마지막 폴백으로 쓸 값은 되지만(무슨 세션인지는 말해 준다), `box-yoon-40096683` 은 아무것도
//  말해 주지 않아 폴백으로도 못 쓴다. 이름을 안 주고 만든 세션이 그 꼴이 된다(sessions.ts: label = … || id).
const isIdLabel = (s) => /^box-/i.test(s) || /^[0-9a-f-]{20,}$/i.test(s);
const isMachineLabel = (s) => /^이어보기\s*[·:]/.test(s) || /^위탁\s*#/.test(s) || isIdLabel(s);
/** 이 이름이 프로젝트명의 되풀이인가. 세 모양을 다 잡는다(실측):
 *   ① 그대로              "APP. lvly. io 셀프서브 방식 와이어프레임"
 *   ② 만들 때 잘린 것      "라이블리 키트, cli, 노드 등록을 지금 다 cli에서 해야하는데, 이거 윈도…"(프로젝트명의 앞부분)
 *   ③ 조각만 이어붙인 변형  "app.lvly.io 와이어프레임" ⊂ "APP. lvly. io 셀프서브 방식 와이어프레임"
 *  ③은 글자·숫자만 남긴 뒤 공통 앞머리 + 공통 꼬리가 이름 전체를 덮으면 되풀이로 본다(우연 일치를 막으려 6자 미만은 제외). */
function echoesProject(label, proj) {
    const a = norm(label);
    const b = norm(proj);
    if (!a || !b)
        return false;
    if (a === b || b.startsWith(a) || a.startsWith(b))
        return true;
    const ca = a.replace(/[^\p{L}\p{N}]/gu, '');
    const cb = b.replace(/[^\p{L}\p{N}]/gu, '');
    if (ca.length < 6 || !cb)
        return false;
    let head = 0;
    while (head < ca.length && head < cb.length && ca[head] === cb[head])
        head++;
    let tail = 0;
    while (tail < ca.length - head && tail < cb.length - head && ca[ca.length - 1 - tail] === cb[cb.length - 1 - tail])
        tail++;
    return head + tail >= ca.length;
}
/** 세션 행에 쓸 글 — ★프로젝트명 반복을 걷어낸다.
 *  프로젝트에서 연 세션은 이름이 **프로젝트명 그대로**인 게 대다수(dev 실측 2026-08-18: 25건 중 14건) — 그 이름은 바로 위
 *  프로젝트 행이 이미 말하고 있다. 같은 제목이 한 화면에 대여섯 번 반복돼 목록이 통째로 안 읽히던 원인이라 지운다.
 *  대신 하네스가 pane 제목에 써 두는 '지금 하는 일'이 그 자리를 받는다 — 실제로 세션을 구분해 주던 건 그 줄이었다.
 *  이름이 따로 있는 세션(사람이 지은 것)만 두 줄이 된다. 원래 이름은 툴팁에 남는다(정보를 버리지는 않는다). */
export function sessText(s, projName) {
    const label = String(s.label || '').trim();
    //  멈춘 세션엔 pane 제목이 없다(박스가 없으니 훔쳐볼 화면도 없다) — 그 자리를 **중앙 기록의 대화 제목**
    //  (= 그 세션에 처음 시킨 말)이 받는다. 없으면 종전대로 이름만 남는다.
    const work = sessWork(s);
    let name = label;
    // '프로젝트명 + 꼬리'(예: "… 와이어프레임 - 3열")면 꼬리만 남기고, 그 밖의 되풀이는 통째로 지운다.
    if (projName && label.startsWith(projName))
        name = label.slice(projName.length).replace(/^[\s·:\-–—_/|]+/, '').trim();
    if (projName && name && echoesProject(name, projName))
        name = '';
    if (isMachineLabel(name))
        name = '';
    const job = work && !HARNESS_TITLES.has(norm(work)) && norm(work) !== norm(name) ? work : '';
    if (name && job)
        return { main: name, sub: job };
    if (name || job)
        return { main: name || job, sub: '' };
    return { main: (isIdLabel(label) ? '' : label) || String((s.raw && s.raw.harness) || '') || '이름 없는 세션', sub: '' };
}
const rankOf = (k) => (SESS_STATES[k] ? SESS_STATES[k].rank : 9);
/** 사이드바 세션 정렬 — 상태 순위(답 기다림이 위) 다음 최근 순. **'맨 위 세션'의 정의는 여기 하나뿐**이다
 *  (라우터가 프로젝트 → 세션으로 보낼 때도 이걸 쓴다 — 사이드바에서 보이는 순서와 어긋나면 안 된다). */
export const bySeen = (a, b) => rankOf(a.stateKey) - rankOf(b.stateKey) || b.lastSeen - a.lastSeen;
const when = (ms) => (ms ? relTime(new Date(ms).toISOString()) : '');
function ownerName(s) {
    if (s.owned)
        return '나';
    const id = String((s.raw && s.raw.owner) || '');
    const m = people[id];
    return (m && m.display_name) || id || '?';
}
// ── 방금 만든 프로젝트는 잠깐 맨 위 (원준 2026-08-20 신고) ──────────────────────
//  사이드바 순서는 '마지막 작업 시각'인데 갓 만든 프로젝트는 그 값이 0이다 — 그래서 만들자마자
//  「전체 프로젝트」 접힌 묶음 뒤로 사라져 화면에서 찾을 수가 없었다(신고자는 검색으로 찾아야 했다).
//  생성 시각을 그 자리에 **잠깐** 세워 둔다: 정렬 앞 + 「진행 중」에 노출. 시간이 지나면 스스로 가라앉는다
//  (★고정은 사람이 거는 것이므로 자동으로 건드리지 않는다 — 자동 고정은 목록을 영구히 늘린다).
const FRESH_MS = 2 * 60 * 60 * 1000;
/** 생성 후 FRESH_MS 안이면 그 생성 시각(ms), 아니면 0. */
function freshMs(p) {
    if (!p || !p.created_at)
        return 0;
    const t = Date.parse(String(p.created_at));
    if (!(t > 0))
        return 0;
    return Date.now() - t < FRESH_MS ? t : 0;
}
function buildRows(data) {
    const me = String((state.me && state.me.userId) || '');
    const byProj = new Map();
    const noProj = [];
    for (const s of data.sessions) {
        if (s.projectId) {
            const arr = byProj.get(s.projectId) || [];
            arr.push(s);
            byProj.set(s.projectId, arr);
        }
        else
            noProj.push(s);
    }
    const lastOf = (arr) => arr.reduce((m, s) => Math.max(m, s.lastSeen || 0), 0);
    const rows = data.projects.map((p) => {
        const all = byProj.get(p.id) || [];
        const fresh = freshMs(p);
        return { key: 'p:' + p.id, proj: p, live: all.filter(isLive).sort(bySeen), past: all.filter(isPast).sort((a, b) => b.lastSeen - a.lastSeen),
            // 갓 만든 프로젝트는 생성 시각을 '마지막 작업'으로 친다 — 세션이 아직 없어도 맨 위에 선다.
            lastWork: Math.max(lastOf(all), fresh), done: p.status_category === 'done', fresh: fresh > 0,
            mine: !!me && (p.created_by === me || (p.member_ids || []).includes(me)) };
    });
    // 프로젝트 없는 세션 — 가짜 프로젝트 한 줄로 같은 정렬에 섞는다(맨 아래 고정이면 프로젝트 수백 개 밑에 묻힌다).
    //  ⚠ 도는 게 하나도 없어도 이 줄은 선다(#1808) — 종전엔 loose.length 로만 세워서, 프로젝트에 안 붙은 세션이
    //   전부 멈추는 순간 그 묶음이 통째로 사라졌다. dev 실측으로 그게 가장 큰 덩어리였다(멈춘 세션 202건 중 183건).
    const loose = noProj.filter(isLive).sort(bySeen);
    const loosePast = noProj.filter(isPast).sort((a, b) => b.lastSeen - a.lastSeen);
    if (loose.length || loosePast.length)
        rows.push({ key: 'p:0', proj: null, live: loose, past: loosePast, lastWork: lastOf(noProj), done: false, fresh: false, mine: true });
    return rows;
}
// ── 사이드바 정렬을 밖에서도(#1749 상단바 프로젝트 연결 드롭다운) — 트리와 **같은 순서**(마지막 작업 시각 ↓ → updated_at ↓).
//  완료 프로젝트는 뒤로 보낸다(트리는 기본 숨김이라 "보이는 순서"가 곧 미완료 순서 — 드롭다운은 숨기는 대신 가라앉힌다).
export function projectOrder(data) {
    const byWork = (a, b) => b.lastWork - a.lastWork || String((b.proj && b.proj.updated_at) || '').localeCompare(String((a.proj && a.proj.updated_at) || ''));
    return buildRows(data).filter((r) => r.proj)
        .sort((a, b) => Number(a.done) - Number(b.done) || byWork(a, b))
        .map((r) => ({ proj: r.proj, done: r.done, mine: r.mine, lastWork: r.lastWork }));
}
let hooks = {};
export function drawSide(host, data, activeKey, h) {
    init();
    hooks = h || hooks;
    last = { host, data, activeKey };
    render();
}
function redraw() { if (last)
    render(); }
// ★고정 — 사람이 고른 프로젝트를 목록 맨 위로. 자동으로 뭘 올려 두지 않는다(열린 세션을 자동으로 띄우던
//  줄은 2026-08-19 에 걷었다: 내가 고르지 않은 것이 자리를 차지했다). 브라우저에 남는다.
const isPinned = (key) => pinnedSet.has(key);
function togglePin(key) {
    if (pinnedSet.has(key))
        pinnedSet.delete(key);
    else
        pinnedSet.add(key);
    saveSet(PIN_KEY, pinnedSet);
    renderTree();
}
let treeEl = null;
let countEl = null;
let filterOpen = false; // [필터] 팝오버 — 열림은 잠깐의 상태라 브라우저에 기억하지 않는다
let outsideBound = false;
// 위계 아이콘 — 프로젝트는 폴더(펼치면 열린 폴더), 세션은 말풍선. 같은 24 뷰박스·현재색 스트로크(붓은 하나).
function glyph(kind, cls) {
    const D = {
        folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
        // 뚜껑이 젖혀진 열린 폴더 — 카드가 열려 있다는 것을 아이콘도 함께 말한다(안 1 '방').
        'folder-open': ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1', 'M3 17l2.3-6.6A2 2 0 0 1 7.2 9H21l-2.4 7.6a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-1z'],
        chat: ['M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z'],
        inbox: ['M4.6 5h14.8L22 13v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4z', 'M2 13h6a4 4 0 0 0 8 0h6'],
        // 외부 앱 연결 — 고리 둘이 맞물린 모양(연결). 자물쇠·플러그는 '잠금'·'전원'으로 읽혀 뜻이 어긋난다.
        link: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3', 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.3-1.3'],
        home: ['M3.5 11.2 12 4.5l8.5 6.7', 'M6 10v9h12v-9'],
    };
    return sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, ...D[kind].map((d) => sv('path', { d })));
}
function render() {
    if (!last)
        return;
    const { host, data } = last;
    // 개인 워크스페이스 = 웜 캔버스(안3 문패의 온도축) — 클래스는 사이드바 뿌리(.v2-side)에 건다.
    const wsReg = state.me?.workspace_registry || {};
    const wsKind = (wsReg.active && wsReg.kind) || (state.me?.workspace?.kind);
    host.closest('.v2-side')?.classList.toggle('ws-personal', wsKind === 'personal');
    // 문패 얼굴 스택 = **세션을 가진 사람들**(나 먼저) — 멤버 명부 순서 그대로면 dev 처럼 더미 계정이 먼저 잡힌다(실측).
    const faceOwners = [...new Set(data.sessions.map((s) => String((s.raw && s.raw.owner) || '')).filter(Boolean))];
    const me = state.me || {};
    const name = String(me.display_name || me.email || me.userId || '');
    const rows = buildRows(data);
    // [필터]의 '세션 상태' 항목은 **트리에 있는 세션 전부**를 센다 — 지난 세션까지(중단됨만 골라 보는 렌즈가 여기서 생긴다).
    const liveAll = rows.flatMap((r) => [...r.live, ...r.past]);
    const livOn = navOn('liv') !== false;
    // 20초 폴링마다 통째로 다시 그린다 — 스크롤 위치와 검색칸 포커스는 이어져야 한다(수백 행에서 매번 맨 위로 튀면 못 쓴다).
    const prevScroll = treeEl ? treeEl.scrollTop : 0;
    const findHad = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('v2-find-in') ? document.activeElement : null;
    const findSel = findHad ? [findHad.selectionStart, findHad.selectionEnd] : null;
    countEl = el('span', { class: 'v2-k' });
    treeEl = el('div', { class: 'v2-tree', role: 'tree', 'aria-label': '프로젝트와 세션' });
    const findIn = el('input', { class: 'v2-find-in', type: 'search', placeholder: '프로젝트 찾기', 'aria-label': '프로젝트 찾기', value: sideFilter,
        // 타이핑 중에는 트리만 다시 그린다(전면 재렌더는 포커스·한글 IME 조합을 깬다) → 아이콘 강조는 클래스만 손댄다
        oninput: (e) => {
            sideFilter = e.target.value;
            renderTree();
            if (treeEl)
                treeEl.scrollTop = 0;
            markFind();
        },
        // Esc = 지우고 접는다(검색어가 있으면 한 번 더 눌러야 접힌다 — 실수로 지운 걸 되돌릴 여지를 준다)
        onkeydown: (e) => {
            if (e.key !== 'Escape')
                return;
            e.stopPropagation();
            if (sideFilter) {
                sideFilter = '';
                renderTree();
                e.currentTarget.value = '';
                markFind();
            }
            else
                closeFind();
        },
        // 검색어 없이 다른 곳을 누르면 조용히 접힌다 — 빈 칸이 자리를 계속 차지할 이유가 없다
        onblur: () => { if (!sideFilter && findOpen)
            window.setTimeout(() => { if (!sideFilter)
                closeFind(); }, 120); } });
    const doneCount = rows.filter((r) => r.done).length;
    const fltN = (stateFilter ? 1 : 0) + (mineOnly ? 1 : 0) + (showDone ? 1 : 0);
    // 확인할 것 = 확인 필요(waiting, 보이는 것 전부 — 프로젝트 세션은 팀 누구든 답할 수 있다) + 작업 완료 미열람(내 것만).
    const inboxN = data.sessions.filter((s) => isLive(s) && (s.stateKey === 'waiting' || (s.stateKey === 'done' && s.owned))).length;
    host.replaceChildren(navRow(), // 맨 위 — 뒤로/앞으로 + 통합검색(상민님 2026-08-20, 클로드 데스크톱 문법)
    switcherTop({ people, faces: faceOwners }), // 좌상단 워크스페이스 **문패 카드**(#1750 메뉴 + 얼굴 스택) — 여기가 어느 집인지 말하는 자리
    // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다(el() 과 다르다) — 조건부 자식은 스프레드로.
    el('nav', { class: 'v2-fixed', 'aria-label': '바로 가기' }, 
    // [새 작업](원준 2026-08-20) — 홈은 이제 **고정 탭이 아니라 새 탭으로 여는 화면**이다. 그래서 이 줄은
    //  '홈으로 돌아가기'가 아니라 '새 일을 벌이는 자리'이고, 누를 때마다 빈 탭이 하나 열린다(브라우저 ⌘T 문법).
    //  Alt+클릭·가운데클릭과 결이 어긋나지 않도록 href 는 그대로 두고(주소는 여전히 #/), 기본 이동만 가로챈다.
    el('a', { class: 'v2-nav' + (last.activeKey() === 'home' ? ' on' : ''), href: '#/', 'data-nav': 'home',
        title: '새 작업 — 새 탭을 열어 무엇이든 시킵니다.',
        onclick: (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !hooks.onNewTask)
                return; // 새 브라우저 탭·셸 새 탭은 원래 동작 그대로
            e.preventDefault();
            hooks.onNewTask();
        } }, glyph('home', 'v2-nav-ic'), el('span', { class: 'n', text: '새 작업' })), 
    // 확인할 것(#1719 사이드바 개편 안2) — 답을 기다리는 세션 + 끝났는데 아직 안 본 세션. **사이드바에서 유일하게
    //  숫자 배지를 가진 행**이라 눈이 먼저 간다(슬랙 읽지 않음 문법). 우리 제품의 루프는 시키다→기다리다→확인이고,
    //  그 병목(확인)이 상시 자리를 가져야 "세션은 받은 편지함"(셀프서브 설계)과 화면이 일치한다. 0건이어도 행은
    //  남는다(자리가 사라지면 있다는 것 자체를 잊는다) — 배지만 조용히 사라진다.
    el('a', { class: 'v2-nav' + (last.activeKey() === 'inbox' ? ' on' : ''), href: '#/inbox', 'data-nav': 'inbox',
        title: '확인할 것 — 내 답·확인을 기다리는 세션' }, glyph('inbox', 'v2-nav-ic'), el('span', { class: 'n', text: '확인할 것' }), inboxN ? el('span', { class: 'v2-nav-cnt', text: String(inboxN) }) : null), 
    // 외부 앱 연결(#1719 원준) — "AI가 내 노션·슬랙을 쓸 수 있나"는 설정이 아니라 **능력**이다. 시키기 전에
    //  알아야 하고 안 되면 그 자리에서 켜야 해서, 관리탭 안쪽이 아니라 여기 상시 자리로 올렸다.
    el('a', { class: 'v2-nav' + (last.activeKey() === 'connect' ? ' on' : ''), href: '#/connect', 'data-nav': 'connect',
        title: '외부 앱 연결 — AI가 내 계정으로 쓸 수 있는 앱' }, glyph('link', 'v2-nav-ic'), el('span', { class: 'n', text: '외부 앱 연결' })), ...(livOn ? [el('a', { class: 'v2-nav' + (last.activeKey() === 'liv' ? ' on' : ''), href: '#/liv', 'data-nav': 'liv',
            title: '리브 — 이 워크스페이스를 맡아 보는 담당자' }, el('span', { class: 'v2-nav-lm', text: 'L' }), el('span', { class: 'n', text: '리브' }))] : [])), el('div', { class: 'v2-side-sec' }, countEl, findBtn(), filterBtn(fltN, liveAll, doneCount), 
    // ＋도 아이콘으로 — 돋보기가 자리를 차지하면서 글자 버튼까지 두면 헤더가 두 줄로 접힌다(#1067 의 🔍/＋ 문법).
    //  누르면 **여기서 만들고 그 작업대로 간다**(원준 2026-08-19) — 옛 프로젝트 앱(보드)으로 떠나보내지 않는다.
    //  이름은 그 자리에서 받는다(빈 판을 먼저 만들고 이름을 나중에 묻는 건 '이름 없는 프로젝트'만 늘린다).
    newBtn()), 
    // 검색칸은 돋보기를 눌렀을 때만(#1067 의 방식). 단 **검색어가 남아 있으면 계속 보인다** —
    //  #1154 가 토글을 폐지했던 사유 중 하나가 '검색 중인 줄 모른 채 짧아진 목록을 본다'였다.
    ...(findShown() ? [el('div', { class: 'v2-find' }, findIn)] : []), ...(fltN ? [filterSummary(fltN)] : []), treeEl, el('div', { class: 'v2-side-foot' }, 
    // 「도구」 — 앱(런치패드)은 콘텐츠가 아니라 도구다. 계정(신원)과 결을 갈라, 푸터가 잡동사니로 읽히지 않게 한다.
    el('div', { class: 'v2-foot-k', text: '도구' }), el('button', { class: 'v2-apps-btn', type: 'button', onclick: () => openLaunchpad(), title: '앱 — 아직 새 화면으로 옮기지 않은 것들' }, appIcon('proj', 'v2-apps-ic'), el('span', { text: '앱' }), el('span', { class: 'v2-cnt', text: String(visibleApps().length) })), el('div', { class: 'v2-me' }, profileAvatar(me.avatar, name, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }), el('span', { class: 'v2-me-name', text: name }), el('button', { class: 'btn-text', type: 'button', text: '로그아웃', onclick: () => void logout() })), el('button', { class: 'v2-classic-link', type: 'button', text: '클래식 화면으로 (이 브라우저)', title: '이 브라우저에서만 옛 화면으로 봅니다. 관리탭 [화면] 에서 되돌릴 수 있어요.', onclick: () => { setUiModeOverride('classic'); location.replace(location.pathname + '#/dashboard'); location.reload(); } })));
    renderTree(rows);
    treeEl.scrollTop = prevScroll;
    if (findHad) {
        findIn.focus();
        if (findSel && findSel[0] != null)
            findIn.setSelectionRange(findSel[0], findSel[1]);
    }
    else if (findFocusWanted) {
        findFocusWanted = false;
        findIn.focus();
    }
    bindFindKey();
}
// ── 돋보기 = 검색칸 여닫기 (#1067 의 방식을 되살리되 #1154 의 반려 사유 둘을 설계로 막는다) ──
//  ⓐ "있는 줄도 모른다" → 돋보기 **아이콘 자체는 늘 보인다**(헤더 고정 자리) + 어디서든 `/` 키로 열린다 +
//     검색 중이면 아이콘이 켜진 상태로 남고 지우는 [×] 가 붙는다.
//  ⓑ "사이드바를 접으면 닿을 길이 없다" → 새 셸 사이드바는 통째로 접히지 않는다(손잡이 최소 200px).
//     클래식 프로젝트 보드(접힘 레일 없음)와 다른 조건이라 그 사유는 여기 해당하지 않는다.
let findFocusWanted = false;
const findShown = () => findOpen || !!sideFilter;
// 검색 중이면 돋보기를 켠 색으로 — 전면 재렌더 없이 클래스만(재렌더는 포커스·한글 IME 조합을 깬다)
function markFind() { const fb = document.querySelector('.v2-findbtn'); if (fb)
    fb.classList.toggle('has', !!sideFilter); }
function openFind() { findOpen = true; findFocusWanted = true; redraw(); }
function closeFind() { if (!findOpen && !sideFilter)
    return; findOpen = false; sideFilter = ''; redraw(); }
// `/` 한 번으로 열린다 — 글자를 치던 중이면(입력칸·편집영역) 가로채지 않는다.
function bindFindKey() {
    if (keyBound)
        return;
    keyBound = true;
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey)
            return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName)))
            return;
        if (!last)
            return;
        e.preventDefault();
        openFind();
    });
}
/** ＋ 새 프로젝트 — 이름만 그 자리에서 받고, 만들자마자 그 프로젝트의 빈 작업대로 간다. */
function newBtn() {
    const b = el('button', { class: 'v2-add', type: 'button', title: '새 프로젝트 — 만들고 그 작업대로 갑니다', 'aria-label': '새 프로젝트' }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-add-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M12 5v14M5 12h14' })));
    b.onclick = (e) => {
        e.preventDefault();
        const inp = el('input', { class: 'v2-newin', type: 'text', placeholder: '새 프로젝트 이름', maxlength: '120', 'aria-label': '새 프로젝트 이름' });
        const msg = el('p', { class: 'v2-newmsg', hidden: true });
        const go = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '만들기' });
        const close = anchoredPopover(b, el('div', { class: 'v2-newpop' }, el('div', { class: 'v2-newrow' }, inp, go), el('p', { class: 'v2-fine', text: '만들면 그 프로젝트의 빈 작업대가 열립니다. 이름은 나중에 바꿀 수 있어요.' }), msg));
        window.setTimeout(() => inp.focus(), 0);
        let sending = false; // 한 번의 '만들기'가 두 번 나가지 않게 — 아래 IME 가드와 이중 방어(둘 다 실측 사고의 원인)
        const create = async () => {
            const name = inp.value.trim();
            if (sending)
                return;
            if (!name) {
                inp.focus();
                return;
            }
            sending = true;
            go.disabled = true;
            go.textContent = '만드는 중…';
            msg.hidden = true;
            try {
                const np = await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => (d && d.project) || d);
                if (!np || !np.id)
                    throw new Error('생성 응답에 프로젝트가 없어요');
                close();
                location.hash = '#/p/' + np.id; // 그 작업대로(목록 갱신은 라우터가 새 프로젝트를 보고 알아서 당긴다)
            }
            catch (err) {
                sending = false;
                msg.hidden = false;
                msg.textContent = '만들지 못했어요 — ' + (err?.message || err);
                go.disabled = false;
                go.textContent = '만들기';
            }
        };
        go.onclick = () => void create();
        // 한글(IME) 조합 중의 Enter 는 **조합 확정**이지 제출이 아니다. 그 확정 Enter 와 뒤이은 진짜 Enter 가
        //  잇달아 들어와 create() 가 두 번 돌았고, 같은 이름의 프로젝트가 **같은 밀리초에 두 개** 만들어졌다
        //  (실측 2026-08-20: #1818/#1819 · 앞서 #1806/#1807 · #1812/#1813 — 전부 한글로 끝나는 이름).
        //  project-form.ts 가 #505 에서 이미 배운 가드를 여기(사이드바 빠른 생성)에도 둔다.
        inp.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229)
                return;
            ev.preventDefault();
            void create();
        });
    };
    return b;
}
// ── 사이드바 맨 윗줄 — [←][→] + [통합검색] (상민님 2026-08-20 "클로드 데스크탑 앱처럼") ──────────────
//  왜 여기인가: 데스크톱 앱에서 맨 위 줄은 이제 **탭 줄**이 가져갔고(창 버튼과 같은 줄), 탐색 도구는
//  내용(프로젝트·세션)보다 위, 문패보다도 위 — '이 워크스페이스 안에서 움직이는 손잡이'라 목록의 일부가 아니다.
//  웹(브라우저)에서도 같은 자리다: 브라우저 뒤로가기와 겹쳐 보여도, 앱 안에서 손이 닿는 자리가 하나 있어야 한다.
//  검색은 **칸처럼 생긴 버튼**이다 — 진짜 입력칸을 두면 사이드바 20초 재렌더가 입력을 끊는다(트리 검색칸이
//  포커스·IME 를 지키느라 치르는 비용을 하나 더 만들지 않는다). 눌리면 화면 가운데 스포트라이트가 뜬다.
function navArrow(dir, on, run) {
    const d = dir === 'back' ? 'M14 6l-6 6 6 6' : 'M10 6l6 6-6 6';
    return el('button', {
        class: 'v2-navb', type: 'button', disabled: !on || !run,
        title: dir === 'back' ? '뒤로' : '앞으로', 'aria-label': dir === 'back' ? '뒤로 가기' : '앞으로 가기',
        onclick: () => run?.()
    }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-navb-ic', 'aria-hidden': 'true' }, sv('path', { d })));
}
function navRow() {
    const st = hooks.navState ? hooks.navState() : { back: true, forward: true };
    // ⌘/Ctrl 은 플랫폼 표기를 따른다 — 맥이 아닌데 ⌘K 라고 적어 두면 눌러도 안 열린다(같은 키를 두 이름으로 배우게 된다).
    const mac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
    return el('div', { class: 'v2-side-nav' }, navArrow('back', st.back, hooks.onBack), navArrow('fwd', st.forward, hooks.onForward), el('button', {
        class: 'v2-omnib', type: 'button', title: '통합검색 — 지식 · 프로젝트 · 자료 · 세션 · 세션 이력을 한 번에',
        'aria-label': '통합검색 열기', onclick: () => hooks.onSearch?.()
    }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-omnib-ic', 'aria-hidden': 'true' }, sv('circle', { cx: '11', cy: '11', r: '6.5' }), sv('path', { d: 'M16 16l4.5 4.5' })), el('span', { class: 'v2-omnib-t', text: '검색' }), el('kbd', { class: 'v2-omnib-k', text: mac ? '⌘K' : 'Ctrl K' })));
}
/** 화살표 둘의 켜짐만 갱신한다 — 이동할 때마다 사이드바를 통째로 다시 그리지 않게(markFind 와 같은 규칙). */
export function markNav(st) {
    const row = document.querySelector('.v2-side-nav');
    if (!row)
        return;
    const btns = Array.from(row.querySelectorAll('.v2-navb'));
    if (btns[0])
        btns[0].disabled = !st.back || !hooks.onBack;
    if (btns[1])
        btns[1].disabled = !st.forward || !hooks.onForward;
}
function findBtn() {
    const on = findShown();
    return el('span', { class: 'v2-findbtn-wrap' }, el('button', {
        class: 'v2-findbtn' + (on ? ' on' : '') + (sideFilter ? ' has' : ''), type: 'button',
        'aria-label': on ? '프로젝트 찾기 닫기' : '프로젝트 찾기', 'aria-expanded': String(on),
        title: on ? '닫기 (Esc)' : '프로젝트 찾기 — / 키로도 열려요',
        onclick: () => { if (findShown())
            closeFind();
        else
            openFind(); }
    }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-findbtn-ic', 'aria-hidden': 'true' }, sv('circle', { cx: '11', cy: '11', r: '6.5' }), sv('path', { d: 'M16 16l4.5 4.5' }))));
}
// [필터] 버튼 + 팝오버 — 조작부는 여기 다 모인다. 목록 표면에는 필터가 없다(켜져 있으면 요약 한 줄만).
function filterBtn(activeN, liveAll, doneCount) {
    const counts = new Map();
    for (const s of liveAll)
        counts.set(s.stateKey, (counts.get(s.stateKey) || 0) + 1);
    if (stateFilter && !counts.has(stateFilter))
        counts.set(stateFilter, 0); // 켜 둔 상태가 0이 돼도 끌 수 있게 남긴다
    const keys = [...counts.keys()].sort((a, b) => rankOf(a) - rankOf(b));
    const wrap = el('div', { class: 'v2-flt' });
    const btn = el('button', {
        class: 'v2-flt-btn' + (activeN ? ' has' : '') + (filterOpen ? ' open' : ''), type: 'button',
        'aria-haspopup': 'true', 'aria-expanded': String(filterOpen), title: '보기 조건 — 상태·범위·완료',
        onclick: (e) => { e.stopPropagation(); filterOpen = !filterOpen; redraw(); }
    }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-flt-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M4 6h16M7 12h10M10 18h4' })), el('span', { text: '필터' }), activeN ? el('b', { class: 'v2-flt-n', text: String(activeN) }) : null);
    wrap.append(btn);
    if (filterOpen) {
        const opt = (on, label, cnt, dot, onclick) => el('button', { class: 'v2-fo' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), onclick }, dot ? el('span', { class: 'v2-dot ' + dot, 'aria-hidden': 'true' }) : el('span', { class: 'v2-fo-pad', 'aria-hidden': 'true' }), el('span', { class: 'n', text: label }), cnt ? el('span', { class: 'v2-cnt', text: cnt }) : null, on ? el('span', { class: 'v2-fo-ck', text: '✓', 'aria-hidden': 'true' }) : null);
        wrap.append(el('div', { class: 'v2-flt-pop', role: 'menu', onclick: (e) => e.stopPropagation() }, el('div', { class: 'v2-flt-k', text: '세션 상태' }), opt(!stateFilter, '전체', '', null, () => { stateFilter = null; redraw(); }), ...keys.map((k) => opt(stateFilter === k, stLabel(k), String(counts.get(k) || 0), dotCls(k), () => { stateFilter = stateFilter === k ? null : k; redraw(); })), el('div', { class: 'v2-flt-k', text: '범위' }), opt(mineOnly, '내 프로젝트만', '', null, () => { mineOnly = !mineOnly; saveFlag(MINE_KEY, mineOnly); redraw(); }), opt(showDone, '완료 프로젝트도 보기', doneCount ? String(doneCount) : '', null, () => { showDone = !showDone; saveFlag(DONE_KEY, showDone); redraw(); }), el('div', { class: 'v2-flt-foot' }, el('button', { class: 'btn-text', type: 'button', text: '전부 지우기', onclick: () => { stateFilter = null; mineOnly = false; showDone = false; saveFlag(MINE_KEY, false); saveFlag(DONE_KEY, false); redraw(); } }), el('button', { class: 'btn-text', type: 'button', text: '닫기', onclick: () => { filterOpen = false; redraw(); } }))));
        if (!outsideBound) {
            outsideBound = true;
            document.addEventListener('click', (e) => {
                if (filterOpen && !e.target?.closest?.('.v2-flt')) {
                    filterOpen = false;
                    redraw();
                }
            });
        }
    }
    return wrap;
}
// 필터가 켜져 있을 때만 나오는 한 줄 — 무엇으로 걸러 보고 있는지 + 한 번에 끄기.
function filterSummary(n) {
    const bits = [];
    if (stateFilter)
        bits.push(stLabel(stateFilter) + ' 세션만');
    if (mineOnly)
        bits.push('내 프로젝트만');
    if (showDone)
        bits.push('완료 포함');
    return el('div', { class: 'v2-flt-sum' }, el('span', { text: bits.join(' · ') }), el('button', { class: 'btn-text', type: 'button', text: '지우기', title: `필터 ${n}개를 끕니다`,
        onclick: () => { stateFilter = null; mineOnly = false; showDone = false; saveFlag(MINE_KEY, false); saveFlag(DONE_KEY, false); redraw(); } }));
}
// 트리(프로젝트 ▸ 세션) — 검색은 여기만 다시 그린다(입력칸 포커스를 잃지 않게).
function renderTree(rowsIn) {
    if (!last || !treeEl)
        return;
    const rows = rowsIn || buildRows(last.data);
    const activeKey = last.activeKey();
    // 지금 보는 프로젝트 — 프로젝트 화면이면 그것, 세션 화면이면 그 세션이 붙은 프로젝트(없으면 '프로젝트 없는 세션' 묶음).
    let selectedPk = activeKey.startsWith('p:') ? activeKey : '';
    if (activeKey.startsWith('s:')) {
        const sid = activeKey.slice(2);
        const s = last.data.sessions.find((x) => x.id === sid) || last.data.sessions.find((x) => x.logId === sid);
        selectedPk = s ? 'p:' + (s.projectId || 0) : '';
    }
    const q = sideFilter.trim().toLowerCase();
    const hit = (r) => !q || (r.proj ? (r.proj.name.toLowerCase().includes(q) || String(r.proj.id) === q) : '프로젝트 없는 세션'.includes(q));
    const stateOf = (r) => (stateFilter ? r.live.filter((s) => s.stateKey === stateFilter) : r.live);
    const pastOf = (r) => (stateFilter ? r.past.filter((s) => s.stateKey === stateFilter) : r.past);
    let hiddenDone = 0;
    const shown = rows.filter((r) => {
        if (!hit(r))
            return false;
        if (mineOnly && !r.mine)
            return false;
        if (stateFilter && !stateOf(r).length && !pastOf(r).length)
            return false;
        if (r.done && !showDone && !r.live.length && !isPinned(r.key)) {
            hiddenDone++;
            return false;
        }
        return true;
    }).sort((a, b) => Number(isPinned(b.key)) - Number(isPinned(a.key)) || b.lastWork - a.lastWork || String((b.proj && b.proj.updated_at) || '').localeCompare(String((a.proj && a.proj.updated_at) || '')));
    // ── 진행 중 / 전체 프로젝트 (#1719 사이드바 개편 안2) ─────────────────────────
    //  매일 쓰는 화면은 「진행 중」(도는 세션이 있는 프로젝트 + 압정 고정)만이다 — dev 실측으로 4~6개.
    //  나머지 수백 개는 「전체 프로젝트 · N」 한 줄 뒤로 접는다(노션이 Favorites 를 먼저 놓고 전체 트리를 뒤로
    //  미는 문법). ⚠ **검색·필터가 켜져 있으면 가르지 않는다** — 찾으려고 건 렌즈를 묶음이 가리면 안 된다.
    //  그때는 종전처럼 한 목록이다('완료 포함'도 렌즈로 취급).
    const splitting = !q && !stateFilter && !mineOnly && !showDone;
    //  갓 만든 프로젝트(fresh)도 여기 선다 — 아직 도는 세션이 없다고 접힌 묶음에 숨기면 만든 사람이 못 찾는다.
    const isActiveRow = (r) => isPinned(r.key) || r.live.length > 0 || r.fresh;
    const activeRows = splitting ? shown.filter(isActiveRow) : shown;
    const restRows = splitting ? shown.filter((r) => !isActiveRow(r)) : [];
    if (countEl)
        countEl.textContent = splitting
            ? `진행 중 · ${activeRows.length}`
            : `프로젝트 · ${shown.filter((r) => r.proj).length}${q || mineOnly || stateFilter ? ` / ${rows.filter((r) => r.proj && (showDone || !r.done || r.live.length)).length}` : ''}`;
    const kids = activeRows.map((r) => projRow(r, stateOf(r), pastOf(r), activeKey, selectedPk));
    const firstLoose = activeRows.findIndex((r) => !isPinned(r.key));
    if (firstLoose > 0 && kids[firstLoose])
        kids[firstLoose].classList.add('after-pins');
    if (splitting && !activeRows.length && last.data.loadedAt) {
        kids.push(el('p', { class: 'v2-tree-note', text: '지금 도는 세션이 없어요. 아래 전체 프로젝트에서 이어서 하거나, 홈에서 새로 시키세요.' }));
    }
    if (splitting) {
        // 「전체 프로젝트」 머리 — 누르면 그 자리에서 펴진다(기억됨). 완료 프로젝트는 펴도 종전 규칙대로 숨김(맨 아래 more).
        // 카운트는 **펴면 보이는 것만** 센다 — 완료 프로젝트(수백)는 펴도 '숨긴 완료 N개 보기' 뒤에 있으므로
        //  여기 합치면 라벨(539)과 목록(205)이 어긋난다(실측). 완료는 그 버튼이 제 숫자를 말한다.
        const totalN = restRows.length;
        kids.push(el('button', {
            class: 'v2-all-h' + (allOpen ? ' open' : ''), type: 'button', 'aria-expanded': String(allOpen),
            title: allOpen ? '전체 프로젝트 접기' : '진행 중이 아닌 프로젝트까지 모두 폅니다',
            onclick: () => { allOpen = !allOpen; saveFlag(ALL_KEY, allOpen); renderTree(); }
        }, el('span', { class: 'v2-car', 'aria-hidden': 'true', text: '›' }), el('span', { class: 'n', text: '전체 프로젝트' }), el('span', { class: 'v2-cnt', text: String(totalN) })));
        if (allOpen)
            kids.push(...restRows.map((r) => projRow(r, stateOf(r), pastOf(r), activeKey, selectedPk)));
    }
    if (!kids.length) {
        kids.push(!last.data.loadedAt ? el('p', { class: 'v2-tree-note', text: '불러오는 중…' }) : !last.data.projects.length
            ? el('p', { class: 'v2-tree-note', text: '아직 프로젝트가 없어요. 가운데 입력창에 무엇이든 시키면 세션이 열리고, 프로젝트는 나중에 붙일 수 있어요.' })
            : el('div', { class: 'v2-tree-note' }, el('span', { text: '조건에 맞는 프로젝트가 없어요.' }), el('button', { class: 'btn-text', type: 'button', text: '필터 지우기', onclick: () => { sideFilter = ''; stateFilter = null; mineOnly = false; saveFlag(MINE_KEY, false); redraw(); } })));
    }
    // 숨긴 완료 N개 — 전체 묶음이 접혀 있으면 그 안의 일이라 보이지 않는 게 맞다(펴면 맨 아래).
    if (hiddenDone && (!splitting || allOpen))
        kids.push(el('button', { class: 'v2-tree-more', type: 'button', text: `숨긴 완료 프로젝트 ${hiddenDone}개 보기`, onclick: () => { showDone = true; saveFlag(DONE_KEY, true); redraw(); } }));
    treeEl.replaceChildren(...kids);
}
function projRow(r, sess, past, activeKey, selectedPk) {
    const p = r.proj;
    const pk = r.key;
    // 프로젝트 없는 세션도 **작업대(캔버스)** 로 간다(#/p/0) — 옛 AI 세션 앱이 아니라(원준 2026-08-19).
    //  자투리 세션들이 그 판에 카드로 모여 거기서 바로 대화·열기가 된다.
    const href = p ? '#/p/' + p.id : '#/p/0';
    const isOn = activeKey === pk;
    // 펼침 기본값(#1719 재구성): **선택된 프로젝트만 펼침**, 나머지는 접힘 — 사용자가 편 것만 그대로.
    //  선택을 일부러 접은 건 이 페이지 수명만 기억한다(다음 방문엔 다시 펼쳐 보인다 — 선택은 늘 보이는 게 기본).
    //  ⚠ 상태 필터가 켜져 있으면 편다 — 걸러 놓고 접혀 있으면 "0개"로 보인다(찾으려고 건 필터가 감추는 꼴).
    const isSel = pk === selectedPk;
    const has = sess.length + past.length;
    const isOpen = has > 0 && (stateFilter ? true : (isSel ? !closedSelected.has(pk) : openSet.has(pk)));
    const caret = has
        ? el('button', { class: 'v2-car', type: 'button', 'aria-label': isOpen ? '접기' : '펼치기', 'aria-expanded': String(isOpen), text: '›', onclick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isSel) {
                    if (isOpen)
                        closedSelected.add(pk);
                    else
                        closedSelected.delete(pk);
                }
                if (isOpen)
                    openSet.delete(pk);
                else
                    openSet.add(pk);
                saveSet(OPEN_KEY, openSet);
                renderTree();
            } })
        : el('span', { class: 'v2-car none', 'aria-hidden': 'true' });
    // '지난 세션' 묶음 — 도는 세션 아래에 접힌 한 줄. 상태 필터로 지난 상태를 골랐으면 이미 그걸 보러 온 것이니 편다.
    const pastOpen = past.length > 0 && (pastSet.has(pk) || (!!stateFilter && !sess.length));
    const tipBits = p
        ? [`#${p.id} · ${p.status_category === 'done' ? '완료' : p.status_category === 'unstarted' ? '시작 전' : '진행 중'}`, r.lastWork ? '마지막 작업 ' + when(r.lastWork) : '세션 없음', r.mine ? '내 프로젝트' : (p.created_by ? `${(people[p.created_by] && people[p.created_by].display_name) || p.created_by} 만듦` : '')]
        : ['프로젝트에 붙지 않은 세션 — 이 세션들의 작업대를 엽니다'];
    // 이름은 언제나 같은 잉크색이다 — 완료·조용함은 태그·시각이 말한다(연회색 본문이 목록 절반이면 전체가 바래 보인다).
    const row = el('a', { class: 'v2-pj-row' + (isOn ? ' on' : ''), href, 'data-nav': pk, title: (p ? p.name + '\n' : '') + tipBits.filter(Boolean).join(' · ') + '\n프로젝트 화면을 엽니다' }, caret, glyph(isOpen ? 'folder-open' : 'folder', 'v2-pj-ic'), el('span', { class: 'n', text: p ? p.name : '프로젝트 없는 세션' }), r.done ? el('span', { class: 'v2-tag', text: '완료' }) : null, sumEl(sess, past) || (r.lastWork ? el('span', { class: 'v2-pj-when', text: when(r.lastWork) }) : null), p ? newSessBtn(p.id) : null, p ? pinBtn(pk) : null);
    const head = sess.slice(0, MAX_SESS);
    const pastHead = past.slice(0, MAX_SESS);
    const list = has ? el('div', { class: 'v2-ss-list', role: 'group', hidden: !isOpen }, ...head.map((s) => sessRow(s, activeKey, sessText(s, p ? p.name : ''))), sess.length > MAX_SESS ? el('a', { class: 'v2-ss-more', href, text: `외 ${sess.length - MAX_SESS}개` }) : null, past.length ? pastHead2(pk, past.length, pastOpen) : null, ...(pastOpen ? pastHead.map((s) => sessRow(s, activeKey, sessText(s, p ? p.name : ''), true)) : []), pastOpen && past.length > MAX_SESS ? el('a', { class: 'v2-ss-more', href, text: `외 ${past.length - MAX_SESS}개` }) : null) : null;
    return el('div', { class: 'v2-pj' + (isOpen ? ' open' : ''), role: 'treeitem', 'aria-expanded': has ? String(isOpen) : null }, row, list);
}
// '지난 세션 n' — 멈춘 세션을 **한 줄로 접어** 둔다. 펴면 그 자리에 그대로 나온다(사라지지 않는다, #1808).
//  도는 세션과 같은 레일·같은 들여쓰기 — 위계가 아니라 묶음이라는 뜻이다.
function pastHead2(pk, n, open) {
    return el('button', {
        class: 'v2-ss-past' + (open ? ' open' : ''), type: 'button', 'aria-expanded': String(open),
        title: open ? '지난 세션 접기' : `멈춘 세션 ${n}개 — 열면 그때 대화를 이어서 계속할 수 있어요`,
        onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (pastSet.has(pk))
                pastSet.delete(pk);
            else
                pastSet.add(pk);
            saveSet(PAST_KEY, pastSet);
            renderTree();
        }
    }, el('span', { class: 'v2-car', 'aria-hidden': 'true', text: '›' }), el('span', { class: 'n', text: '지난 세션' }), el('span', { class: 'v2-cnt', text: String(n) }));
}
// ＋ 새 세션 — 프로젝트 이름 줄에 손을 얹으면 나타난다(원준 2026-08-20).
//  종전엔 새 세션을 열려면 **먼저 그 프로젝트로 들어가** 문패의 [＋ 세션]을 눌러야 했다. 목록에서 곧장 시작하는 길을
//  하나 더 둔다 — 누르면 그 프로젝트 화면이 '새 세션 자리'로 열린다(들어가서 누르는 것과 같은 자리로 간다).
//  자리는 늘 차지하고 보이기만 토글한다(핀과 같은 규칙 — 나타나며 행을 밀면 목록 전체가 흔들린다).
function newSessBtn(projectId) {
    return el('button', {
        class: 'v2-newb', type: 'button', 'aria-label': '이 프로젝트에서 새 세션 열기',
        title: '새 세션 — 이 프로젝트에 붙은 AI 세션을 엽니다',
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); hooks.onNewSession?.(projectId); }
    }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-newb-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M12 5v14M5 12h14' })));
}
// 고정 단추 — 자리는 늘 차지한다(눌러야 보이는 것이 나타나며 행을 밀면 목록 전체가 흔들린다).
//  고정된 것은 늘 보이고, 아닌 것은 그 행에 손을 얹었을 때만 보인다.
function pinBtn(pk) {
    const on = isPinned(pk);
    return el('button', { class: 'v2-pinb' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on),
        'aria-label': on ? '고정 해제' : '위에 고정', title: on ? '고정 해제' : '위에 고정 — 맨 위로 올려 둡니다',
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); togglePin(pk); } }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-pinb-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M9 4h6l-1 5 3.2 3.2a1 1 0 0 1-.7 1.7H12v5l-1 1-1-1v-5H6.5a1 1 0 0 1-.7-1.7L9 9z' })));
}
// 프로젝트 행 오른쪽 — 숫자를 늘어놓지 않는다. **볼 일이 있는 것만**: 확인 필요(호박)·작업 중(파랑).
//  그 밖의 살아 있는 세션은 개수 하나(회색). 상태별 전체 분포는 [필터] 팝오버가 보여 준다.
function sumEl(sess, past = []) {
    const part = (n, cls, label) => (n ? el('span', { class: 'v2-sum ' + cls, title: `${label} ${n}` }, el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), String(n)) : null);
    // 도는 게 하나도 없는 프로젝트 — 오른쪽 자리를 '지난 세션 n'이 받는다(#1808). 종전엔 시각만 떠서 **이어서 할 게
    //  있다는 사실 자체가 화면에 없었다**. 도는 세션이 있으면 종전 그대로(급한 것만) — 숫자를 늘어놓지 않는다.
    if (!sess.length)
        return past.length ? el('span', { class: 'v2-sums', 'aria-label': `지난 세션 ${past.length}` }, part(past.length, 'past', '지난 세션')) : null;
    const c = { wait: 0, busy: 0, rest: 0 };
    for (const s of sess) {
        if (s.stateKey === 'waiting')
            c.wait++;
        else if (s.stateKey === 'busy')
            c.busy++;
        else
            c.rest++;
    }
    return el('span', { class: 'v2-sums', 'aria-label': `세션 ${sess.length}` }, part(c.wait, 'wait', '확인 필요'), part(c.busy, 'busy', '작업 중'), (!c.wait && !c.busy && c.rest) ? el('span', { class: 'v2-sum idle', title: `살아 있는 세션 ${c.rest}` }, String(c.rest)) : null);
}
// 세션 행 — 상태점 · 세션을 실제로 구분해 주는 글(sessText) · 남의 세션이면 소유자 얼굴 · 상태어.
function sessRow(s, activeKey, text, pastRow = false) {
    const st = SESS_STATES[s.stateKey];
    const cls = dotCls(s.stateKey);
    const raw = s.raw || {};
    const owner = ownerName(s);
    // 프로젝트명 반복을 걷어낸 뒤의 이름·'지금 하는 일'(하네스 pane 제목 = 클래식 카드의 💬 줄).
    //  끝난 세션은 트리에 없으니 '마지막으로 하던 일'로 읽어도 틀리지 않는다.
    const main = text.main;
    const sub = text.sub;
    const tip = [s.label, sub || (raw.title && String(raw.title) !== s.label ? String(raw.title) : ''), `${st ? st.label : s.stateLabel}${s.lastSeen ? ' · ' + when(s.lastSeen) : ''}`, s.owned ? '내 세션' : `${owner}의 세션`, raw.harness ? String(raw.harness) : '', s.node ? '노드 ' + s.node : ''].filter(Boolean).join('\n');
    // 이름 자리 — 더블클릭하면 그 자리에서 고친다(원준 2026-08-20). 고친 이름은 서버로 가고 탭·대화창까지 따라온다.
    const nameEl = el('span', { class: 't', text: main });
    const row = el('a', { class: 'v2-ss-row' + (activeKey === 's:' + s.id ? ' on' : '') + (s.owned ? '' : ' other') + (pastRow ? ' past' : ''), href: '#/s/' + encodeURIComponent(s.id), 'data-nav': 's:' + s.id, title: tip + (pastRow ? '\n열면 그때 대화를 읽고 [이어서 대화하기]로 계속할 수 있어요' : '\n세션 대화를 엽니다\n이름을 더블클릭하면 그 자리에서 고칠 수 있어요'), role: 'treeitem' }, el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), el('span', { class: 'v2-ss-main' }, nameEl), s.owned ? null : personFace(String(raw.owner || ''), 'v2-ss-face', owner), 
    // 오른쪽 끝은 **한 자리**로 고정한다 — 상태어를 조건부로 넣으면 행마다 길이가 달라 목록이 들쭉날쭉해진다(상민님 2026-08-18).
    //  상태는 왼쪽 점이, 개수는 프로젝트 행이 말한다. 여기는 '누르면 대화로 간다'는 표식만(hover 때 보인다).
    //  ⚠ 지난 세션 묶음은 그 한 자리를 **'언제'**가 받는다 — 멈춘 것들을 고르는 축은 시간이고(어제 것인가 3주 전 것인가),
    //   묶음 안 모든 행이 똑같이 시각을 가지므로 '행마다 길이가 달라진다'는 그 규칙의 사유엔 걸리지 않는다.
    pastRow ? el('span', { class: 'w', text: when(s.lastSeen) }) : glyph('chat', 'v2-ss-go'), 
    // 보관(×) — **도는 세션에만**(지난 세션은 이미 거기 있다), **내 세션에만**(서버도 소유자만 허용).
    //  자리는 늘 차지한다(hover 때만 보인다) — 나타나며 행을 밀면 목록이 흔들린다(압정과 같은 규약).
    !pastRow && s.owned ? archiveBtn(s) : null);
    if (s.owned)
        row.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); beginRename(row, nameEl, s); });
    return row;
}
// ── 세션 이름 인라인 편집 ────────────────────────────────────────────────────
//  ⚠ 이름 자리에 그려진 글(main)은 **원래 이름이 아닐 수 있다** — sessText 가 프로젝트명 되풀이를 걷어내고
//   pane 제목·첫 지시를 그 자리에 올리기 때문이다(#1808). 그래서 편집칸의 초기값은 화면 글이 아니라
//   **s.label(진짜 세션 이름)** 이다. 그리지 않은 것을 고치게 하면 사용자는 자기가 안 쓴 글을 지우게 된다.
let renaming = false;
function beginRename(row, nameEl, s) {
    if (renaming)
        return;
    renaming = true;
    const shown = nameEl.textContent || '';
    const input = el('input', { class: 'v2-ss-edit', type: 'text', value: String(s.label || shown), 'aria-label': '세션 이름' });
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
        if (done)
            return;
        done = true;
        renaming = false;
        const next = input.value.trim();
        if (!save || !next || next === s.label) {
            nameEl.replaceChildren(document.createTextNode(shown));
            return;
        }
        nameEl.replaceChildren(document.createTextNode(next));
        try {
            await hooks.onRenameSession?.(s.id, next);
        }
        catch (e) {
            toast((e && e.message) || '이름을 바꾸지 못했습니다', true);
            nameEl.replaceChildren(document.createTextNode(shown));
        }
    };
    input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // '/' 검색 단축키·Esc 사이드바 핸들러가 가로채지 않게
        if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            void finish(true);
        }
        else if (e.key === 'Escape') {
            e.preventDefault();
            void finish(false);
        }
    });
    input.addEventListener('blur', () => { void finish(true); });
    input.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); }); // 편집 중 클릭이 행 이동으로 새지 않게
    void row;
}
// ── 보관(×) — 세션을 '지난 세션'으로 보낸다 ──────────────────────────────────
//  DELETE …?reclaim=1 = tmux 만 내리고 복원 좌표(desired-state)는 남긴다 → 그 프로젝트의 '지난 세션'에 쌓이고
//  열면 [이어서 대화하기] 로 그대로 살아난다. **완전 삭제가 아니다** — 그래서 문구도 '보관'이라고 말한다.
const ARCHIVE_ACK_KEY = 'lively_v2_archive_ack'; // '1' = 안내를 다시 띄우지 않음(사용자가 체크)
function archiveBtn(s) {
    const btn = el('button', {
        class: 'v2-ss-x', type: 'button', 'aria-label': s.label + ' 보관(지난 세션으로)',
        title: '지난 세션으로 보내기 — 지금 실행만 멈추고, 나중에 열어서 이어서 할 수 있어요',
    }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-ss-x-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M6 6l12 12M18 6L6 18' })));
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void doArchive(s);
    });
    return btn;
}
async function doArchive(s) {
    let ack = false;
    try {
        ack = localStorage.getItem(ARCHIVE_ACK_KEY) === '1';
    }
    catch (_) { /* noop */ }
    if (!ack) {
        // '다시 보지 않기' 는 **확인을 누른 경우에만** 저장한다 — 취소하고 닫았는데 다음부터 말없이 보관되면 사고다.
        const again = el('input', { type: 'checkbox', id: 'v2-arch-ack' });
        const extra = el('label', { class: 'v2-arch-ack', for: 'v2-arch-ack' }, again, el('span', { text: '다시 안내하지 않기' }));
        const ok = await confirmDialog({
            title: '지난 세션으로 보낼까요?',
            message: '지금 돌고 있는 것만 멈춥니다. 대화는 그대로 보관돼요.',
            lines: [
                '이 세션은 프로젝트 아래 [지난 세션] 묶음으로 들어갑니다.',
                '나중에 열어서 [이어서 대화하기] 를 누르면 그때 대화 그대로 다시 시작합니다.',
            ],
            note: '지우는 것이 아닙니다 — 되돌릴 수 있어요.',
            confirmText: '지난 세션으로', extra,
        });
        if (!ok)
            return;
        if (again.checked) {
            try {
                localStorage.setItem(ARCHIVE_ACK_KEY, '1');
            }
            catch (_) { /* noop */ }
        }
    }
    try {
        const q = '?reclaim=1' + (s.node ? '&node=' + encodeURIComponent(s.node) : '');
        await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + q, { method: 'DELETE' });
        toast('지난 세션으로 보냈어요 — 열면 이어서 할 수 있습니다');
        hooks.onArchived?.();
    }
    catch (e) {
        toast((e && e.message) || '보관하지 못했습니다', true);
    }
}
