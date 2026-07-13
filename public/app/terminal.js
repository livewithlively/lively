// terminal.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { api, el, errorNote, pageHead, personFace, state, toast } from './core.js';
import { skeleton } from './learn.js';
import { field, overlay } from './admin.js';
import { startTour, isTourActive } from './tour.js';
// ════════════════════════════════════════════════════════════════════
// 터미널 세션 매니저 (#/terminal) — 중앙 박스 경로 D: xterm.js + 서버 node-pty(tmux).
//  목록/생성폼/CRUD → REST(/api/ui/terminal/*), PTY 스트림 → WS(/terminal/ws, ticket 쿠키).
//  보기(폰트·크기·테마·커서)는 사용자별 localStorage 영속 + 실시간 적용. 보안: el()/textContent 만.
// ════════════════════════════════════════════════════════════════════
const TERM_PREFS_KEY = 'lively_term_prefs';
const TERM_FONTS = [
    { v: 'JetBrains Mono, D2Coding, Menlo, monospace', label: 'JetBrains Mono' },
    { v: 'D2Coding, Menlo, monospace', label: 'D2Coding' },
    { v: 'Menlo, Monaco, monospace', label: 'Menlo' },
    { v: 'SFMono-Regular, "SF Mono", monospace', label: 'SF Mono' },
    { v: 'Consolas, "Courier New", monospace', label: 'Consolas' },
];
const TERM_THEMES = {
    dark: { name: '다크', theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70' } },
    light: { name: '라이트', theme: { background: '#fdfdfd', foreground: '#2a2a2a', cursor: '#5566ff', selectionBackground: '#cfe3ff' } },
    solarized: { name: 'Solarized', theme: { background: '#002b36', foreground: '#93a1a1', cursor: '#cb4b16', selectionBackground: '#073642' } },
    dracula: { name: 'Dracula', theme: { background: '#282a36', foreground: '#f8f8f2', cursor: '#ff79c6', selectionBackground: '#44475a' } },
};
function termPrefs() {
    let p = {};
    try {
        p = JSON.parse(localStorage.getItem(TERM_PREFS_KEY) || '{}');
    }
    catch (_) { /* 기본값 */ }
    return Object.assign({ fontFamily: TERM_FONTS[0].v, fontSize: 14, theme: 'dark', cursorStyle: 'bar' }, p);
}
function saveTermPrefs(p) { try {
    localStorage.setItem(TERM_PREFS_KEY, JSON.stringify(p));
}
catch (_) { /* noop */ } }
// 새 세션 폼 '실행 설정' 기억(#673) — 마지막으로 쓴 하네스 + 플래그(모델·effort)를 브라우저에 저장해 다음 생성 때 기본값으로 복원.
const TERM_CREATE_PREFS_KEY = 'lively_term_create_prefs';
function termCreatePrefs() {
    try {
        const p = JSON.parse(localStorage.getItem(TERM_CREATE_PREFS_KEY) || '{}');
        return (p && typeof p === 'object') ? p : {};
    }
    catch (_) {
        return {};
    }
}
function saveTermCreatePrefs(p) { try {
    localStorage.setItem(TERM_CREATE_PREFS_KEY, JSON.stringify(p));
}
catch (_) { /* noop */ } }
// 활성 터미널(세션) — 라우트 이탈/재진입 시 정리한다(ws 종료 + xterm dispose + 리스너 제거).
let termSession = null;
function teardownTerminal() {
    if (!termSession)
        return;
    try {
        if (termSession.ws)
            termSession.ws.close();
    }
    catch (_) { /* noop */ }
    try {
        if (termSession.term)
            termSession.term.dispose();
    }
    catch (_) { /* noop */ }
    if (termSession.onResize)
        window.removeEventListener('resize', termSession.onResize);
    termSession = null;
}
// 작업자(작성자) = 로그인 사용자. 서버가 토큰으로 owner 를 강제하므로 표시 전용(타인 선택 불가).
function memberName(cfg, id) {
    const m = ((cfg && cfg.members) || []).find((x) => x.id === id);
    return (m && m.name) || id || '';
}
function myName(cfg) {
    const id = (state.me && state.me.userId) || '';
    return memberName(cfg, id) || (state.me && state.me.email) || id || '나';
}
// 세션 생성 시각 — '6월 19일 22:17'(브라우저 로컬 타임존). created 는 epoch 초.
function fmtTermDate(sec) {
    const n = Number(sec) || 0;
    if (!n)
        return '';
    const d = new Date(n * 1000);
    if (isNaN(d.getTime()))
        return '';
    const p = (x) => String(x).padStart(2, '0');
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// ── 세션 라이브 상태(#745) — 게이트웨이 백엔드의 agentState 를 그대로 쓴다. ──
//  busy=작업 중(프로세스그룹 CPU 큼) · waiting=확인 필요(승인·선택 대기) · idle=대기 중(접속중·유휴) · offline(미접속 또는 셸=하네스 종료).
//  title = Claude Code 가 pane 에 써두는 '지금 하는 일' 요약(백엔드 제공) → 카드에 그대로 노출(= '지금 무슨 작업').
//  (초기엔 session_activity 로 파생했으나 스피너가 활동으로 안 잡혀 항상 stale → 백엔드 CPU 기반 agentState 로 대체.)
//  waiting 을 맨 앞으로: 내 승인/선택을 기다리는 = 가장 먼저 처리할 것.
const TSESS_STATUS = {
    waiting: { label: '확인 필요', cls: 'waiting', rank: 0 },
    busy: { label: '작업 중', cls: 'busy', rank: 1 },
    idle: { label: '대기 중', cls: 'idle', rank: 2 },
    offline: { label: '오프라인', cls: 'offline', rank: 3 },
};
function sessState(s) { return TSESS_STATUS[s.agentState] ? s.agentState : 'offline'; }
// 상대 시각 — '방금 · 3분 전 · 2시간 전 · 5일 전'.
function relAgo(sec) {
    const n = Number(sec) || 0;
    if (!n)
        return '';
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - n);
    if (diff < 45)
        return '방금';
    if (diff < 3600)
        return Math.floor(diff / 60) + '분 전';
    if (diff < 86400)
        return Math.floor(diff / 3600) + '시간 전';
    return Math.floor(diff / 86400) + '일 전';
}
// 작업 폴더는 끝 2단계만(…/745/context-ontology) — 카드 한 줄에 담기게.
function shortDir(d) {
    const segs = String(d || '').split('/').filter(Boolean);
    return segs.length <= 2 ? (d || '') : '…/' + segs.slice(-2).join('/');
}
// 기본 상태 필터(전체/작업중/대기/오프라인) — 브라우저에 기억.
const TSESS_FILTER_KEY = 'lively_term_status_filter_v1';
function tsessFilter() { try {
    return localStorage.getItem(TSESS_FILTER_KEY) || 'all';
}
catch (_) {
    return 'all';
} }
function saveTsessFilter(v) { try {
    localStorage.setItem(TSESS_FILTER_KEY, v);
}
catch (_) { /* noop */ } }
// 상태 필터칩 겸 카운트 요약 — 색점 + 라벨 + 개수. (전체 칩은 색점 없음.)
function tsessChip(label, count, cls, active, onClick) {
    const c = el('button', { class: 'tsess-chip-btn' + (active ? ' active' : '') + (cls ? ' ' + cls : ''), type: 'button', onclick: onClick });
    if (cls)
        c.append(el('span', { class: 'tsess-dot tsess-dot-' + cls }));
    c.append(el('span', { class: 'tsess-chip-label', text: label }), el('span', { class: 'tsess-chip-n', text: String(count) }));
    return c;
}
async function renderTerminal(view) {
    view.replaceChildren(skeleton('세션을 불러오는 중'));
    let data, cfg, projects;
    try {
        [data, cfg, projects] = await Promise.all([
            api('/api/ui/terminal/sessions'),
            api('/api/ui/terminal/config'),
            // 프로젝트명 매핑 + '어떤 프로젝트 할당' 칩. 실패해도 세션 목록은 그대로 보인다.
            api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []).catch(() => []),
        ]);
    }
    catch (e) {
        view.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다'));
        return;
    }
    const sessions = (data && data.sessions) || [];
    const projName = new Map((projects || []).map((p) => [p.id, p.name]));
    const myProjIds = new Set((projects || []).map((p) => p.id));
    // 프로젝트 세션은 터미널 목록 API 가 숨기므로(터미널 탭 정책), 내 프로젝트별 /sessions 로 내가 소유한 세션을 합친다(대시보드와 동형).
    //  → '어떤 프로젝트 할당인지' 를 이 탭에서 보이게(#745). 백엔드 무변경(프론트 병합) · id 중복 제거.
    try {
        const withSess = (projects || []).filter((p) => Number(p.my_session_count) > 0);
        if (withSess.length) {
            const lists = await Promise.all(withSess.map((p) => api('/api/ui/v6/projects/' + p.id + '/sessions').then((d) => (d && d.sessions) || []).catch(() => [])));
            const seen = new Set(sessions.map((s) => s.id));
            for (const arr of lists)
                for (const s of arr)
                    if (s.owned && !seen.has(s.id)) {
                        seen.add(s.id);
                        sessions.push(s);
                    }
        }
    }
    catch (_) { /* 병합 실패 → 개인 세션만 유지 */ }
    for (const s of sessions)
        s._st = sessState(s); // 카드·정렬·카운트가 공유(백엔드 agentState)
    const reRender = () => renderTerminal(view);
    // 관리(선택삭제) 가능 = 내 소유 세션. 서버도 소유자 아니면 403 재검증.
    const ownedSessions = sessions.filter((s) => s.owned);
    const sel = { mode: false, ids: new Set() };
    let statusF = tsessFilter(); // all | working | idle | offline
    let projF = 0; // 0 = 전체, or projectId
    const headActions = el('div', { class: 'term-head-actions' });
    const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
    const controls = el('div', { class: 'tsess-controls' });
    const listWrap = el('div', {});
    function repaintBulk() {
        if (!sel.mode) {
            bulkBar.hidden = true;
            bulkBar.replaceChildren();
            return;
        }
        const n = sel.ids.size;
        const allOn = sessions.length > 0 && sessions.every((s) => sel.ids.has(s.id));
        const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
            onclick: () => { if (allOn)
                sel.ids.clear();
            else
                sessions.forEach((s) => sel.ids.add(s.id)); draw(); } });
        const openBtn = el('button', { class: 'btn btn-primary btn-sm', text: '선택 열기', disabled: n === 0, title: '고른 세션들을 한 탭 그리드로 동시에 열기',
            onclick: () => bulkOpen() });
        const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0,
            onclick: () => bulkDelete(delBtn) });
        bulkBar.hidden = false;
        bulkBar.replaceChildren(el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '세션을 골라 한 탭에 열거나 삭제하세요' }), el('div', { class: 'bulk-bar-actions' }, allBtn, openBtn, delBtn));
    }
    sel.onToggle = repaintBulk; // 카드 체크박스 토글 시 bulkBar 카운트만 갱신(전체 재렌더 없이)
    const ctx = { cfg, view, projName, myProjIds, reRender, sel };
    function draw() {
        // 헤더 우측 — [+ 새 세션] + (내 세션 0개면) 따라하기. data-tour 앵커 유지(#517 온보딩).
        const newBtn = el('button', { class: 'btn btn-primary', 'data-tour': 'new-session', text: '+ 새 세션', onclick: () => openTermCreateForm(cfg, view) });
        const tourBtn = ownedSessions.length === 0
            ? el('button', { class: 'btn btn-ghost', text: '🧭 따라하기', title: '세션 만드는 법을 화면에서 한 단계씩 짚어드려요', onclick: () => startTerminalTour() })
            : null;
        headActions.replaceChildren(...[tourBtn, newBtn].filter(Boolean));
        // 상태 카운트 = 필터칩 겸 요약.
        const counts = { all: sessions.length, busy: 0, waiting: 0, idle: 0, offline: 0 };
        for (const s of sessions)
            counts[s._st]++;
        const chip = (label, key, cls) => tsessChip(label, key === 'all' ? counts.all : counts[key], cls, statusF === key, () => { statusF = key; saveTsessFilter(key); draw(); });
        const chips = el('div', { class: 'tsess-chips' }, chip('전체', 'all', ''), chip('확인 필요', 'waiting', 'waiting'), chip('작업 중', 'busy', 'busy'), chip('대기', 'idle', 'idle'), chip('오프라인', 'offline', 'offline'));
        // 우측 컨트롤 — 통합 질문검색 + 프로젝트 필터(세션에 프로젝트가 있을 때만) + 선택(일괄삭제) 토글.
        const right = el('div', { class: 'tsess-controls-right' });
        right.append(el('button', { class: 'btn btn-ghost btn-sm tsess-gbtn', text: '질문 검색', title: '여러 세션에서 내가 클로드에게 보낸 질문을 통합 검색하고 어느 세션인지 찾기', onclick: () => openGlobalPromptSearch(ctx) }));
        const projIds = [...new Set(sessions.map((s) => Number(s.projectId) || 0).filter(Boolean))];
        if (projIds.length) {
            const psel = el('select', { class: 'tsess-projsel', onchange: () => { projF = Number(psel.value) || 0; draw(); } }, el('option', { value: '0' }, '프로젝트 전체'), ...projIds.map((id) => el('option', { value: String(id), selected: id === projF ? '' : null }, projName.get(id) || ('프로젝트 #' + id))));
            right.append(psel);
        }
        const selToggle = sel.mode
            ? el('button', { class: 'btn btn-ghost btn-sm', text: '취소', onclick: () => { sel.mode = false; sel.ids.clear(); draw(); } })
            : (sessions.length ? el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 세션을 골라 한 탭 그리드로 열거나 한 번에 삭제', onclick: () => { sel.mode = true; draw(); } }) : null);
        if (selToggle)
            right.append(selToggle);
        controls.replaceChildren(chips, right);
        // 필터 적용 + 정렬(작업중→대기→오프라인, 그 안에서 최근 활동순).
        const shown = sessions
            .filter((s) => (statusF === 'all' || s._st === statusF) && (projF === 0 || Number(s.projectId) === projF))
            .sort((a, b) => TSESS_STATUS[a._st].rank - TSESS_STATUS[b._st].rank
            || (Number(b.lastActive || b.created) || 0) - (Number(a.lastActive || a.created) || 0));
        if (!sessions.length) {
            listWrap.replaceChildren(el('div', { class: 'empty', text: '아직 세션이 없습니다. "+ 새 세션"으로 만드세요.' }));
            repaintBulk();
            return;
        }
        if (!shown.length) {
            listWrap.replaceChildren(el('div', { class: 'empty', text: '이 필터에 해당하는 세션이 없습니다.' }));
            repaintBulk();
            return;
        }
        const list = el('div', { class: 'tsess-list' });
        for (const s of shown)
            list.append(tsessCard(s, ctx));
        listWrap.replaceChildren(list);
        repaintBulk();
    }
    // 선택 열기 — 고른 세션들을 한 탭 그리드로. 1개면 단독 탭, 여러 개면 배치(그리드) 선택 팝업 후 terminal-grid.html.
    function bulkOpen() {
        const items = [...sel.ids]
            .map((id) => sessions.find((s) => s.id === id))
            .filter(Boolean)
            .map((s) => ({ id: s.id, label: s.label || '' }));
        if (!items.length)
            return;
        if (items.length === 1) {
            window.open('/ui/terminal.html?session=' + encodeURIComponent(items[0].id) + '&label=' + encodeURIComponent(items[0].label), '_blank');
            return;
        }
        openGridPicker(items);
    }
    async function bulkDelete(btn) {
        const ids = [...sel.ids];
        if (!ids.length)
            return;
        if (!confirm(ids.length + '개 세션을 삭제할까요?\n\n실행 중인 작업도 함께 종료됩니다(되돌릴 수 없음).'))
            return;
        btn.disabled = true;
        // 병렬 삭제 — 일부 실패해도 나머지는 진행(성공/실패 건수 보고). 서버가 비소유분은 403.
        const results = await Promise.allSettled(ids.map((id) => api('/api/ui/terminal/sessions/' + encodeURIComponent(id), { method: 'DELETE' })));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const fail = results.length - ok;
        toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 세션을 삭제했습니다'), fail > 0);
        sel.mode = false;
        sel.ids.clear();
        reRender();
    }
    const head = pageHead('터미널', '내 AI 세션이 지금 무슨 작업을 하는지 · 어떤 프로젝트 할당인지 · 어떤 게 오프라인인지 한눈에.', [headActions], '널');
    view.replaceChildren(...[loginBannerEl(cfg, view), head, bulkBar, controls, listWrap].filter(Boolean));
    draw();
}
// 세션 카드(#745) — 라이브 상태점 + 라벨(작업) / 상태·시각·하네스·모델·워크트리·폴더 + 프로젝트 칩 + 열기/관리.
//  선택(일괄삭제) 모드면 내 소유 카드에 체크박스(카드 전체가 토글 = label). 남의 세션은 체크박스 없음(삭제 불가).
function tsessCard(s, ctx) {
    const { cfg, view, projName, myProjIds, reRender, sel } = ctx;
    const st = TSESS_STATUS[s._st] || TSESS_STATUS.offline;
    const harnessLabel = ((cfg.harnesses || []).find((h) => h.key === s.harness) || {}).label || s.harness || '셸';
    const model = (s.flags && s.flags['--model']) || '';
    const owner = memberName(cfg, s.owner) || s.owner || '?';
    const pid = Number(s.projectId) || 0;
    // ── 1행: 상태점 + 이름 + 프로젝트 칩 + 배지 ──
    const title = el('div', { class: 'tsess-title' }, el('span', { class: 'tsess-dot tsess-dot-' + st.cls, title: st.label }), el('span', { class: 'tsess-name', title: s.label, text: s.label || '(이름 없음)' }));
    if (pid) {
        const mine = myProjIds.has(pid);
        title.append(el('span', { class: 'tsess-proj' + (mine ? ' mine' : ''), title: (mine ? '내 프로젝트: ' : '프로젝트: ') + (projName.get(pid) || ('#' + pid)), text: '🗂 ' + (projName.get(pid) || ('프로젝트 #' + pid)) }));
    }
    if (s.attached)
        title.append(el('span', { class: 'tsess-badge live', text: '접속중' }));
    if (s.autoApprove)
        title.append(el('span', { class: 'tsess-badge danger', text: '자동승인' }));
    if (!s.owned)
        title.append(el('span', { class: 'tsess-badge', title: '소유: ' + owner, text: '👤 ' + owner + ' · 초대받음' }));
    else if ((s.invites || []).length)
        title.append(el('span', { class: 'tsess-badge', title: s.invites.map((id) => memberName(cfg, id)).join(', '), text: '초대 ' + s.invites.length + '명' }));
    // ── 2행(있으면): '지금 하는 일' 실시간 요약(백엔드 title = Claude Code pane 요약) — 라벨과 다를 때만 ──
    const workTitle = (s.title && s.title !== s.label) ? el('div', { class: 'tsess-worktitle', title: s.title, text: '💬 ' + s.title }) : null;
    // ── 3행: 상태 · 시각 · 하네스·모델 · 워크트리 · 폴더 ──
    const bits = [];
    bits.push(el('span', { class: 'tsess-stat tsess-stat-' + st.cls, text: st.label }));
    const when = relAgo(s.lastActive || s.created);
    if (when)
        bits.push(el('span', { text: (s.lastActive ? '작업 ' : '') + when }));
    bits.push(el('span', { text: harnessLabel + (model ? '·' + model : '') }));
    if (s.wtBranch)
        bits.push(el('span', { title: '워크트리 격리 브랜치', text: '🌿 ' + s.wtBranch }));
    if (s.dir)
        bits.push(el('span', { class: 'tsess-dir', title: s.dir, text: '📁 ' + shortDir(s.dir) }));
    const meta = el('div', { class: 'tsess-meta' });
    bits.forEach((b, i) => { if (i)
        meta.append(el('span', { class: 'tsess-sep', text: '·' })); meta.append(b); });
    const info = el('div', { class: 'tsess-info' }, ...[title, workTitle, meta].filter(Boolean));
    // 선택 모드 — 모든 카드에 체크박스(카드 전체 토글). 골라서 한 탭 그리드로 '열기' 또는 '삭제'(삭제는 서버가 소유자만 허용).
    if (sel && sel.mode) {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = sel.ids.has(s.id);
        cb.addEventListener('change', () => { if (cb.checked)
            sel.ids.add(s.id);
        else
            sel.ids.delete(s.id); if (sel.onToggle)
            sel.onToggle(); });
        return el('label', { class: 'tsess-card tsess-' + st.cls + ' tsess-card--sel' }, el('span', { class: 'tsess-check' }, cb), info);
    }
    // 액션 — 열기(항상) + 내 질문(항상) + 소유자면 수정·삭제.
    const acts = el('div', { class: 'tsess-acts' }, el('button', { class: 'tsess-open', text: '열기', onclick: () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank') }), el('button', { class: 'tsess-icon tsess-q', title: '이 세션에서 클로드에게 보낸 내 질문만 순서대로 모아보기', text: '내 질문', onclick: () => openSessPrompts(s) }));
    if (s.owned) {
        acts.append(el('button', { class: 'tsess-icon', title: '이름·초대 수정', text: '수정', onclick: () => openTermEdit(s, cfg, view) }));
        acts.append(el('button', { class: 'tsess-icon danger', title: '세션 종료(삭제)', text: '삭제', onclick: async () => {
                if (!confirm('세션 "' + s.label + '" 을(를) 종료할까요? 실행 중인 작업도 함께 종료됩니다.'))
                    return;
                try {
                    await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' });
                    toast('세션 종료됨');
                    reRender();
                }
                catch (e) {
                    toast('실패 — ' + e.message, true);
                }
            } }));
    }
    return el('div', { class: 'tsess-card tsess-' + st.cls + (s.attached ? ' attached' : '') }, info, acts);
}
// 카드 '내 질문' 팝아웃(#745) — 이 세션에서 클로드에게 보낸 사용자 질문(프롬프트)만 시간순으로 모아 본다(위=최근).
//  백엔드가 ~/.claude 트랜스크립트에서 사람이 친 질문만 추출(툴결과·주입 메시지 제외). 접근통제는 서버 canAttach.
// 여러 세션을 한 탭 그리드로(#745) — n개에 맞는 배치 후보(격자·가로·세로·2열·3열). cols*rows>=n 인 것만.
function gridLayouts(n) {
    const out = [];
    const seen = new Set();
    const add = (cols, rows, label) => { const k = cols + 'x' + rows; if (cols >= 1 && rows >= 1 && cols * rows >= n && !seen.has(k)) {
        seen.add(k);
        out.push({ cols, rows, label });
    } };
    const sq = Math.ceil(Math.sqrt(n));
    add(sq, Math.ceil(n / sq), '격자'); // 정사각형에 가깝게
    add(n, 1, '가로 한 줄');
    add(1, n, '세로 한 줄');
    add(2, Math.ceil(n / 2), '2열');
    if (n >= 6)
        add(3, Math.ceil(n / 3), '3열');
    return out.slice(0, 5);
}
// 배치(그리드) 선택 팝업 — 고른 뒤 terminal-grid.html 을 새 탭으로. items = [{id,label}].
function openGridPicker(items) {
    const n = items.length;
    const container = el('div', { class: 'tgrid-opts' });
    const back = overlay(n + '개 세션을 한 탭에서 열기 — 배치를 고르세요', container);
    const openGrid = (cols, rows) => {
        const ids = items.map((x) => x.id).join(',');
        const labels = encodeURIComponent(JSON.stringify(items.map((x) => x.label || '')));
        window.open('/ui/terminal-grid.html?sessions=' + encodeURIComponent(ids) + '&labels=' + labels + '&cols=' + cols + '&rows=' + rows, '_blank');
        back.remove();
    };
    for (const L of gridLayouts(n)) {
        const preview = el('div', { class: 'tgrid-prev', style: 'grid-template-columns:repeat(' + L.cols + ',1fr);grid-template-rows:repeat(' + L.rows + ',1fr)' });
        for (let i = 0; i < L.cols * L.rows; i++)
            preview.append(el('span', { class: 'tgrid-prev-cell' + (i < n ? ' on' : '') }));
        container.append(el('button', { class: 'tgrid-opt', type: 'button', onclick: () => openGrid(L.cols, L.rows) }, preview, el('div', { class: 'tgrid-opt-lbl', text: L.label }), el('div', { class: 'tgrid-opt-dim', text: L.cols + '×' + L.rows })));
    }
}
function qWhen(ts) {
    const ms = Date.parse(ts || '');
    if (!ms)
        return '';
    return relAgo(Math.floor(ms / 1000));
}
// 검색어 → 토큰(공백분리·중복제거·소문자).
function qTerms(q) { return [...new Set(String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean))]; }
// 관련도 점수(백엔드 scoreText 와 동형) — 팝아웃 내 검색(클라이언트)도 같은 랭킹. matched=매치 단어 수(AND 판정).
const QBOUNDARY_RE = /[\s.,!?()[\]{}"'“”‘’·\-—:;/\\]/;
function qScore(textLower, terms, phrase) {
    let score = 0, matched = 0;
    const positions = [];
    for (const t of terms) {
        const idx = textLower.indexOf(t);
        if (idx === -1)
            continue;
        matched++;
        positions.push(idx);
        score += 10;
        if (idx === 0 || QBOUNDARY_RE.test(textLower[idx - 1]))
            score += 5;
        let c = 0, i = idx;
        while (i !== -1 && c < 5) {
            c++;
            i = textLower.indexOf(t, i + t.length);
        }
        score += Math.min(c - 1, 3);
    }
    if (matched === 0)
        return { score: 0, matched: 0 };
    if (terms.length > 1) {
        if (matched === terms.length && positions.length) {
            const span = Math.max(...positions) - Math.min(...positions);
            if (span < 30)
                score += 20;
            else if (span < 100)
                score += 8;
        }
        if (textLower.includes(phrase))
            score += 50;
    }
    return { score, matched };
}
// 질문 텍스트에서 각 검색 토큰의 모든 등장을 <mark> 로 강조(el/textContent — XSS 안전). terms 없으면 그냥 텍스트.
function qHighlight(text, terms) {
    const wrap = el('div', { class: 'tsess-qtext' });
    if (!terms || !terms.length) {
        wrap.textContent = text;
        return wrap;
    }
    const lower = String(text).toLowerCase();
    const ranges = [];
    for (const t of terms) {
        let i = 0, idx;
        while ((idx = lower.indexOf(t, i)) !== -1) {
            ranges.push([idx, idx + t.length]);
            i = idx + t.length;
        }
    }
    if (!ranges.length) {
        wrap.textContent = text;
        return wrap;
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [ranges[0].slice()];
    for (let k = 1; k < ranges.length; k++) {
        const last = merged[merged.length - 1];
        if (ranges[k][0] <= last[1])
            last[1] = Math.max(last[1], ranges[k][1]);
        else
            merged.push(ranges[k].slice());
    }
    let pos = 0;
    for (const [a, b] of merged) {
        if (a > pos)
            wrap.append(document.createTextNode(text.slice(pos, a)));
        wrap.append(el('mark', { class: 'tsess-qmark', text: text.slice(a, b) }));
        pos = b;
    }
    if (pos < text.length)
        wrap.append(document.createTextNode(text.slice(pos)));
    return wrap;
}
// 한 세션 '내 질문' 팝아웃 — 상단 검색으로 그 세션 질문을 즉시 필터(클라이언트). 최신이 위, #N=시간순 번호.
async function openSessPrompts(s) {
    const body = el('div', { class: 'tsess-qbody' }, el('div', { class: 'caption', text: '질문을 불러오는 중…' }));
    overlay('💬 내 질문 · ' + (s.label || '(이름 없음)'), body);
    try {
        const d = await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/prompts');
        const prompts = (d && d.prompts) || [];
        const total = (d && d.total) || prompts.length;
        if (!prompts.length) {
            body.replaceChildren(el('div', { class: 'empty', text: (d && d.found) ? '이 세션에서 보낸 질문이 아직 없어요.' : '이 세션의 대화 기록을 찾지 못했어요.' }));
            return;
        }
        const search = el('input', { class: 'tsess-qsearch', type: 'search', placeholder: '이 세션의 질문 검색…' });
        const cap = el('div', { class: 'caption tsess-qcap' });
        const list = el('div', { class: 'tsess-qlist' });
        const draw = () => {
            const query = search.value.trim();
            const terms = qTerms(query);
            list.replaceChildren();
            if (!terms.length) { // 검색 없음 → 최신순 전체
                cap.textContent = total + '개 질문 · 최근 순' + (total > prompts.length ? ' (최근 ' + prompts.length + '개)' : '');
                prompts.slice().reverse().forEach((p) => {
                    list.append(el('div', { class: 'tsess-qitem' }, el('div', { class: 'tsess-qmeta' }, el('span', { class: 'tsess-qnum', text: '#' + (prompts.indexOf(p) + 1) }), el('span', { text: qWhen(p.ts) })), qHighlight(p.text, null)));
                });
                return;
            }
            const phrase = query.toLowerCase();
            const scored = [];
            for (let i = 0; i < prompts.length; i++) {
                const r = qScore(prompts[i].text.toLowerCase(), terms, phrase);
                if (r.matched >= 1)
                    scored.push({ p: prompts[i], chrono: i + 1, score: r.score, matched: r.matched });
            }
            const strict = scored.filter((x) => x.matched === terms.length);
            const isPartial = strict.length === 0 && terms.length > 1;
            const pool = isPartial ? scored : strict;
            pool.sort((a, b) => b.score - a.score || (b.chrono - a.chrono)); // 관련도 → 최신
            cap.textContent = pool.length ? (pool.length + ' / ' + total + '개 일치 · 관련도순' + (isPartial ? ' (일부 단어)' : '')) : '';
            if (!pool.length) {
                list.append(el('div', { class: 'empty', text: '일치하는 질문이 없어요.' }));
                return;
            }
            pool.forEach(({ p, chrono }) => {
                list.append(el('div', { class: 'tsess-qitem' }, el('div', { class: 'tsess-qmeta' }, el('span', { class: 'tsess-qnum', text: '#' + chrono }), el('span', { text: qWhen(p.ts) })), qHighlight(p.text, terms)));
            });
        };
        search.addEventListener('input', draw);
        body.replaceChildren(search, cap, list);
        draw();
    }
    catch (e) {
        body.replaceChildren(el('div', { class: 'empty', text: '질문을 불러오지 못했어요 — ' + (e && e.message || e) }));
    }
}
// 전체 세션 통합 '질문 검색' 팝아웃(#745) — 여러 터미널에서 보낸 질문을 한 번에 검색하고, 각 결과가 '어느 세션'인지 보여준다.
//  결과 클릭 = 그 세션 터미널 열기. 서버가 접근 가능한 세션만 검색(개인 소유/초대 + 내 프로젝트 세션).
function openGlobalPromptSearch(ctx) {
    const { projName, myProjIds } = ctx;
    const input = el('input', { class: 'tsess-gsearch', type: 'search', placeholder: '모든 세션에서 내 질문 검색 — 뜻이 비슷한 것도 찾아요' });
    const status = el('div', { class: 'caption tsess-qcap', text: '내가 여러 세션에서 클로드에게 보낸 질문을 한 번에 검색해요 (의미 기반).' });
    const results = el('div', { class: 'tsess-qlist tsess-gresults' });
    overlay('질문 검색 · 모든 세션', el('div', { class: 'tsess-qbody tsess-gbody' }, input, status, results));
    let timer = null, lastQ = null;
    const run = async () => {
        const q = input.value.trim();
        if (q === lastQ)
            return;
        lastQ = q;
        if (q.length < 2) {
            status.textContent = '두 글자 이상 입력하세요.';
            results.replaceChildren();
            return;
        }
        status.textContent = '검색 중…';
        results.replaceChildren();
        try {
            const d = await api('/api/ui/terminal/prompts/search?q=' + encodeURIComponent(q));
            if (input.value.trim() !== q)
                return; // 늦게 온 응답 무시
            const rows = (d && d.results) || [];
            const mode = d.semantic ? '의미 검색' : '관련도순';
            status.textContent = rows.length ? (rows.length + '개 · ' + mode + (d.partial ? ' (일부 단어만 일치)' : '') + (d.truncated ? ' · 많아서 일부만' : '')) : '일치하는 질문이 없어요.';
            results.replaceChildren();
            const ql = qTerms(q);
            rows.forEach((r) => {
                const pid = Number(r.projectId) || 0;
                const meta = el('div', { class: 'tsess-qmeta' }, el('span', { class: 'tsess-gsess', title: r.label, text: r.label || r.sessionId }), pid ? el('span', { class: 'tsess-proj' + (myProjIds.has(pid) ? ' mine' : ''), title: (projName.get(pid) || ('#' + pid)), text: '🗂 ' + (projName.get(pid) || ('프로젝트 #' + pid)) }) : null, el('span', { text: qWhen(r.ts) }), el('span', { class: 'tsess-gopen', text: '열기 ↗' }));
                const item = el('div', { class: 'tsess-qitem tsess-gitem', role: 'button', tabindex: '0', title: '이 세션 열기' }, meta, qHighlight(r.text, ql));
                item.onclick = () => window.open('/ui/terminal.html?session=' + encodeURIComponent(r.sessionId) + '&label=' + encodeURIComponent(r.label || ''), '_blank');
                results.append(item);
            });
        }
        catch (e) {
            if (input.value.trim() !== q)
                return;
            status.textContent = '검색 실패 — ' + (e && e.message || e);
        }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
    setTimeout(() => input.focus(), 30);
}
// 구성원 격리(#524) — 이 세션의 claude 가 '내 격리 계정(box_)'으로 뜨는지 안내. box_ 격리가 #346 멀티프로필을 대체.
//  게이트웨이는 box_ 700 홈을 못 읽어 '로그인됨' 여부를 알 수 없으므로(격리의 본질), 로그인 안내를 상시 노출.
function profileNoteEl(cfg) {
    const os = (cfg && cfg.os) || {};
    if (os.ready) {
        const who = os.osUser || 'box_…';
        if (os.provisioned && os.loggedIn)
            return el('div', { class: 'caption', text: '🔐 내 AI 세션은 내 격리 계정(' + who + ')으로 실행됩니다 — 자격증명이 구성원 간 격리됩니다.' });
        if (os.provisioned)
            return el('div', { class: 'caption', text: '🔐 내 격리 계정(' + who + ') · Claude 로그인 전입니다 — 세션에서  claude  실행 후 /login (한 번만).' });
        return el('div', { class: 'caption', text: '🔐 첫 세션을 열면 내 격리 계정(' + who + ')이 자동 생성돼 격리 실행됩니다. 세션에서  claude  실행 후 /login 하세요.' });
    }
    // 격리 인프라 미설치 = 비격리(공유) — 레거시 #346 멀티프로필 안내(폴백).
    const p = (cfg && cfg.profile) || {};
    if (!p.multiprofile)
        return null;
    if (p.active)
        return el('div', { class: 'caption', text: '🔐 이 AI 세션은 내 Claude 계정(프로필 로그인됨)으로 실행됩니다.' });
    if (p.provisioned)
        return el('div', { class: 'caption', text: '⚠ 내 프로필이 아직 로그인 안 돼 공유 계정으로 실행됩니다 — 상단 [내 계정 로그인] 버튼으로 한 번 로그인하세요.' });
    return el('div', { class: 'caption', text: '⚠ 공유 계정으로 실행됩니다(구성원 격리 미설치). 박스에서 deploy/linux/install-isolation.sh 실행 시 구성원별 격리가 켜집니다.' });
}
// 최초 로그인 세션 — loginProfile 로 게이트를 우회해 내 프로필 dir 로 claude 를 띄운다(닭-달걀 해소). 새 탭으로 열어 로그인.
async function openLoginSession(view) {
    try {
        const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
                label: '내 계정 로그인', rootKey: 'personal', subpath: '', harness: 'claude', flags: {}, autoApprove: false, loginProfile: true,
            }) });
        toast('로그인 터미널을 열었습니다 — 뜨는 claude 에서 로그인을 진행하세요');
        if (out && out.session)
            window.open('/ui/terminal.html?session=' + encodeURIComponent(out.session.id) + '&label=' + encodeURIComponent(out.session.label || ''), '_blank');
        renderTerminal(view);
    }
    catch (e) {
        toast('로그인 터미널 열기 실패 — ' + e.message, true);
    }
}
// 상단 '내 계정 로그인' 버튼 — 개인 claude 세션을 열어 거기서 로그인. box_ 격리면 그 세션이 내 격리 계정(box_)으로
//  떠서 로그인이 box_ 홈에 저장돼 이후 내 세션에 재사용된다. 게이트웨이가 box_ 로그인 여부를 못 봐서(격리) 상시 노출.
function loginBannerEl(cfg, view) {
    const os = (cfg && cfg.os) || {};
    if (os.ready) {
        if (os.loggedIn)
            return null; // 이미 로그인됨(box_ creds 존재) → 버튼 숨김
        return el('div', { class: 'card' }, el('button', { class: 'btn btn-primary btn-sm', text: '🔑 내 계정 로그인', onclick: () => openLoginSession(view) }), el('span', { class: 'caption', text: '  처음 한 번 — 개인 세션을 열어 claude 에서 /login (이후 내가 만드는 세션은 내 격리 계정으로 뜹니다).' }));
    }
    // 레거시 비격리(#346): 프로필 프로비저닝됐지만 미로그인일 때만.
    const p = (cfg && cfg.profile) || {};
    if (!p.multiprofile || !p.provisioned || p.loggedIn)
        return null;
    return el('div', { class: 'card' }, el('div', { class: 'caption', text: '⚠ 내 Claude 계정이 아직 로그인되지 않았습니다. 한 번 로그인하면 이후 내가 만드는 세션은 내 계정으로 뜹니다.' }), el('button', { class: 'btn btn-primary', text: '내 계정 로그인', onclick: () => openLoginSession(view) }));
}
// 새 세션 — 기본 비공개. 초대 피커에서 멤버를 고르면 그 사람도 보고 열 수 있다.
// onCreated(out) — 있으면 생성 후 그걸 호출(대시보드에서 재사용: 세션 위젯 새로고침). 없으면 터미널 뷰 재렌더.
function openTermCreateForm(cfg, view, onCreated) {
    const roots = cfg.roots || [];
    const harnesses = cfg.harnesses || [];
    const prefs = termCreatePrefs();
    const labelI = el('input', { class: 'term-input', type: 'text', placeholder: '예: 랜딩 카피 수정' });
    const rootSel = el('select', { class: 'term-input' }, ...roots.map((r) => el('option', { value: r.key }, r.label)));
    const pickerBox = el('div', { class: 'term-picker' });
    let pickerPath = '';
    const harnessSel = el('select', { class: 'term-input' }, ...harnesses.map((h) => el('option', { value: h.key }, h.label)));
    const inviteBox = buildInvitePicker(cfg, new Set()); // 기본 비공개(아무도 선택 안 됨)
    const flagsBox = el('div', { class: 'term-flags' });
    // 두 개의 체크박스(워크트리·자동 승인)는 '실행 옵션'으로 묶는다(#673). 워크트리 기본 ON, 자동승인 기본 OFF.
    const autoCb = el('input', { type: 'checkbox' });
    const autoWrap = el('label', { class: 'term-auto' }, autoCb, el('span', { text: ' 자동 승인 — 확인 없이 바로 실행해 빨라요. 공유 폴더에선 꺼 두는 걸 권해요.' }));
    const wtCb = el('input', { type: 'checkbox', checked: '' });
    const wtWrap = el('label', { class: 'term-auto' }, wtCb, el('span', { text: ' git 워크트리에서 작업 (권장) — 폴더가 git 저장소면 새 브랜치 워크트리에서 격리 작업(다른 세션·메인 체크아웃과 안 충돌).' }));
    // '실행 설정'(하네스·모델·effort) — 접이식 프리셋으로 묶어 세로를 아끼고, 이전 설정을 기억한다(#673). 기본 접힘.
    const presetSum = el('div', { class: 'term-preset-sum' });
    const presetChev = el('span', { class: 'term-preset-chev', text: '▾' });
    const presetToggle = el('button', { class: 'term-preset-toggle', type: 'button', 'data-tour': 'preset' }, presetSum, presetChev);
    const presetBody = el('div', { class: 'term-preset-body', 'data-tour': 'model' }, el('div', { 'data-tour': 'harness' }, field('실행 (AI)', harnessSel)), flagsBox, profileNoteEl(cfg));
    let presetOpen = false;
    const applyPreset = () => { presetBody.style.display = presetOpen ? '' : 'none'; presetChev.textContent = presetOpen ? '▴' : '▾'; };
    presetToggle.onclick = () => { presetOpen = !presetOpen; applyPreset(); };
    const harnessOf = () => harnesses.find((x) => x.key === harnessSel.value) || {};
    function presetSummary() {
        const h = harnessOf();
        const parts = [h.label || harnessSel.value];
        for (const f of (h.flags || [])) {
            if (f.name !== '--model' && f.name !== '--effort')
                continue;
            const c = flagsBox.querySelector('[data-flag="' + f.name + '"]');
            parts.push((f.name === '--model' ? '모델 ' : 'effort ') + ((c && c.value) || '기본'));
        }
        presetSum.replaceChildren(el('b', { text: '실행 설정' }), document.createTextNode(' · ' + parts.join(' · ')));
    }
    function renderFlags() {
        const h = harnessOf();
        flagsBox.replaceChildren();
        for (const f of (h.flags || [])) {
            let ctrl;
            if (f.type === 'select')
                ctrl = el('select', { class: 'term-input', 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c }, c || '(기본)')));
            else if (f.type === 'bool')
                ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
            else
                ctrl = el('input', { class: 'term-input', type: 'text', 'data-flag': f.name, placeholder: f.desc || '' });
            const saved = prefs.flags && prefs.flags[f.name]; // 이전 설정 복원(#673)
            if (saved != null) {
                if (ctrl.type === 'checkbox')
                    ctrl.checked = !!saved;
                else
                    ctrl.value = saved;
            }
            ctrl.addEventListener('change', presetSummary);
            flagsBox.append(el('div', { class: 'field' }, el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
        }
        autoWrap.style.display = h.hasAutoApprove ? '' : 'none';
        presetSummary();
    }
    harnessSel.addEventListener('change', renderFlags);
    if (prefs.harness && harnesses.some((h) => h.key === prefs.harness))
        harnessSel.value = prefs.harness; // 이전 하네스 복원
    renderFlags();
    applyPreset();
    // 작업 폴더 = 선택한 루트(공유/개인) 안을 드롭다운으로 재귀 탐색.
    async function loadPicker() {
        pickerBox.replaceChildren(el('div', { class: 'caption', text: '폴더 불러오는 중…' }));
        let data;
        try {
            data = await api('/api/ui/terminal/browse?root=' + encodeURIComponent(rootSel.value) + '&path=' + encodeURIComponent(pickerPath));
        }
        catch (e) {
            pickerBox.replaceChildren(el('div', { class: 'caption', text: '폴더를 불러오지 못했습니다: ' + e.message }));
            return;
        }
        pickerPath = data.path || '';
        const rootLabel = (roots.find((r) => r.key === rootSel.value) || {}).label || rootSel.value;
        const crumb = el('div', { class: 'term-crumb' }, el('a', { class: 'crumb', text: rootLabel, onclick: () => { pickerPath = ''; loadPicker(); } }));
        let acc = '';
        for (const seg of (pickerPath ? pickerPath.split('/') : [])) {
            acc = acc ? acc + '/' + seg : seg;
            const p = acc;
            crumb.append(el('span', { class: 'crumb-sep', text: ' / ' }), el('a', { class: 'crumb', text: seg, onclick: () => { pickerPath = p; loadPicker(); } }));
        }
        const parentPath = data.parent; // '' = 루트로, null = 이미 루트(상위 없음)
        const sel = el('select', { class: 'term-input', onchange: () => {
                const v = sel.value;
                sel.value = '';
                if (v === '__up__') {
                    pickerPath = parentPath || '';
                    loadPicker();
                    return;
                }
                if (v === '__new__') {
                    newPickerFolder();
                    return;
                }
                if (v) {
                    pickerPath = (pickerPath ? pickerPath + '/' : '') + v;
                    loadPicker();
                }
            } }, el('option', { value: '' }, data.dirs.length ? '하위 폴더로 이동…' : '(하위 폴더 없음)'), (pickerPath ? el('option', { value: '__up__' }, '⬆ 상위 폴더로') : null), ...data.dirs.map((d) => el('option', { value: d }, '📁 ' + d)), el('option', { value: '__new__' }, '＋ 새 폴더 만들기…'));
        pickerBox.replaceChildren(crumb, sel, el('div', { class: 'caption', text: '여기서 시작: /' + pickerPath }));
    }
    async function newPickerFolder() {
        const name = prompt('새 폴더 이름');
        if (!name || !name.trim())
            return;
        const rel = (pickerPath ? pickerPath + '/' : '') + name.trim();
        try {
            await api('/api/ui/terminal/browse/mkdir?root=' + encodeURIComponent(rootSel.value) + '&path=' + encodeURIComponent(rel), { method: 'POST' });
            pickerPath = rel;
            loadPicker();
        }
        catch (e) {
            toast('폴더 생성 실패 — ' + e.message, true);
        }
    }
    rootSel.addEventListener('change', () => { pickerPath = ''; loadPicker(); });
    loadPicker();
    // 폼 순서(#673) — 무엇(이름) → 어디(폴더) → 어떻게(실행 옵션 체크박스 · 실행 설정 프리셋) → 누구(초대는 맨 아래).
    //  온보딩 투어(#517)의 data-tour 앵커도 이 순서에 맞춘다: label → folder → options → preset → invite → create.
    const back = overlay('새 세션', el('div', { 'data-tour': 'label' }, field('이름', labelI)), el('div', { 'data-tour': 'folder' }, field('작업 위치', rootSel), field('폴더', pickerBox)), el('div', { class: 'term-checks', 'data-tour': 'options' }, wtWrap, autoWrap), presetToggle, presetBody, el('div', { 'data-tour': 'invite' }, field('초대 (비우면 나만 보는 비공개 세션)', inviteBox.box)), el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-primary', 'data-tour': 'create', text: '생성하기', onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            const fromTour = isTourActive(); // 클릭 순간(투어 종료 전)에 캡처 — 따라하기면 완료 안내를 새 터미널 탭에 띄운다(#673)
            const flags = {};
            for (const c of flagsBox.querySelectorAll('[data-flag]'))
                flags[c.dataset.flag] = (c.type === 'checkbox') ? c.checked : c.value;
            const payload = { label: labelI.value, rootKey: rootSel.value, subpath: pickerPath, harness: harnessSel.value, flags, autoApprove: autoCb.checked, invites: inviteBox.selected(), worktree: wtCb.checked };
            try {
                const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify(payload) });
                saveTermCreatePrefs({ harness: harnessSel.value, flags }); // 이 설정을 다음 생성 때 기본값으로 기억(#673)
                back.remove();
                // 워크트리 켰는데 서버가 안 만들었으면(=폴더가 git 저장소 아님) 조용히 넘기지 말고 알린다(#673 — 사용자 혼란 방지).
                if (wtCb.checked && out && out.session && !out.session.wtBranch)
                    toast('세션 생성됨 — 폴더가 git 저장소가 아니라 워크트리는 미적용(폴더에서 직접 실행).', true);
                else
                    toast('세션 생성됨');
                if (out && out.session)
                    window.open('/ui/terminal.html?session=' + encodeURIComponent(out.session.id) + '&label=' + encodeURIComponent(out.session.label || '') + (fromTour ? '&welcome=1' : ''), '_blank');
                if (onCreated)
                    onCreated(out);
                else
                    renderTerminal(view);
            }
            catch (e) {
                btn.disabled = false;
                toast('생성 실패 — ' + e.message, true);
            }
        } })));
}
// 세션 수정 — 이름·초대 멤버만 변경 가능(소유자만, 서버가 강제). 작업폴더·하네스·모델·자동승인은
//  생성 시 실행 명령에 박혀(돌고 있는 LLM/셸 프로세스) 사후 변경 불가 → '현재값'을 비활성으로 보여주고
//  왜 못 바꾸는지(닫고 새로 켜야 함) 안내한다. "기능 미구현"이 아니라 "구조상 고정"임을 분명히.
function openTermEdit(s, cfg, view) {
    const harnesses = (cfg && cfg.harnesses) || [];
    const harness = harnesses.find((h) => h.key === s.harness) || {};
    // ── 변경 가능 ──
    const labelI = el('input', { class: 'term-input', type: 'text', value: s.label });
    const inviteBox = buildInvitePicker(cfg, new Set(s.invites || []));
    // ── 생성 시 고정(비활성 표시) ──
    const ro = (val) => el('input', { class: 'term-input', type: 'text', value: val, disabled: '' });
    const author = memberName(cfg, s.owner) || s.owner || '?';
    const flagFields = (harness.flags || []).map((f) => {
        const raw = (s.flags && s.flags[f.name] != null) ? String(s.flags[f.name]) : '';
        const shown = f.type === 'bool' ? (raw ? '켜짐' : '꺼짐') : (raw || '(기본)');
        return field(f.label, ro(shown));
    });
    const autoShown = harness.hasAutoApprove ? (s.autoApprove ? '켜짐 (위험)' : '꺼짐') : '해당 없음';
    // 워크트리(#673) — 생성 시 격리 브랜치를 만들었으면 그 브랜치, 아니면 '사용 안 함'(폴더 직접). 다른 고정값과 함께 비활성 표시.
    const wtShown = s.wtBranch ? (s.wtBranch + ' (격리 브랜치)') : '사용 안 함 (선택한 폴더에서 직접 작업)';
    const lockNote = el('div', { class: 'term-lock-note' }, el('span', { text: '🔒 작업 폴더 · 워크트리 · 하네스 · 모델 · 자동 승인은 세션을 처음 켤 때 정해집니다. 바꾸려면 실행 중인 LLM(또는 셸)을 닫고 새로 켜야 하므로 여기서는 수정할 수 없습니다 — 바꾸려면 새 세션을 만드세요.' }));
    const back = overlay('세션 수정', field('이름', labelI), field('초대 (선택한 멤버만 이 세션을 보고 열 수 있음 · 비우면 비공개)', inviteBox.box), lockNote, field('작업자', ro(author)), field('작업 폴더', ro(s.dir || '(기본)')), field('워크트리', ro(wtShown)), field('하네스', ro(harness.label || s.harness || '?')), flagFields, field('자동 승인', ro(autoShown)), el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-primary', text: '저장', onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            try {
                await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label: labelI.value, invites: inviteBox.selected() }) });
                back.remove();
                toast('수정됨');
                renderTerminal(view);
            }
            catch (e) {
                ev.currentTarget.disabled = false;
                toast('수정 실패 — ' + e.message, true);
            }
        } })));
}
// 초대 멤버 피커(#673) — 긴 행 목록 대신 '검색해 추가 → 칩' 타입어헤드. 세로로 여러 이름을 항상 보여줄 이유가 없어,
//  기본은 칩(선택된 사람)만 보이고, 검색창을 누르면 드롭다운(absolute 오버레이라 폼 높이를 안 늘림)이 후보를 보여준다.
//  나(state.me) 제외한 구성원이 후보. current(Set)=초기 선택, selected()=고른 id 배열. 생성·수정 폼이 공유한다.
function buildInvitePicker(cfg, current) {
    const meId = (state.me && state.me.userId) || '';
    const others = (cfg.members || []).filter((m) => m.id !== meId);
    const selected = new Set([...current].filter((id) => others.some((m) => m.id === id))); // 유령 id 방지
    const label = (m) => (m.name || m.id) + (m.kind === 'agent' ? ' (AI)' : '');
    const chips = el('div', { class: 'proj-mp-chips' });
    const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '이름으로 검색해 추가…' });
    const menu = el('div', { class: 'proj-mp-menu', hidden: '' });
    const box = el('div', { class: 'proj-mp' }, chips, el('div', { class: 'proj-mp-ta' }, searchIn, menu));
    function paintChips() {
        if (!selected.size) {
            chips.replaceChildren(el('span', { class: 'proj-mp-hint', text: others.length ? '비우면 나만 보는 비공개 세션이에요.' : '초대할 다른 구성원이 없습니다 — 비공개 세션이 됩니다.' }));
            return;
        }
        chips.replaceChildren(...[...selected].map((id) => {
            const m = others.find((x) => x.id === id) || { id, name: id };
            return el('span', { class: 'proj-mp-chip' }, personFace(m.id, 'proj-mp-ava proj-mp-ava-sm', m.name), el('span', { class: 'proj-mp-chip-name', text: label(m) }), el('button', { class: 'proj-mp-chip-x', type: 'button', 'aria-label': '초대 제거', text: '×', onclick: () => { selected.delete(id); paintChips(); } }));
        }));
    }
    function closeMenu() { menu.hidden = true; menu.replaceChildren(); }
    function openMenu() {
        const q = searchIn.value.trim().toLowerCase();
        const cand = others.filter((m) => !selected.has(m.id) && (!q || (m.name || m.id).toLowerCase().includes(q))).slice(0, 8);
        if (!cand.length) {
            menu.replaceChildren(el('div', { class: 'proj-mp-empty', text: others.length ? '일치하는 사람이 없어요.' : '초대할 구성원이 없어요.' }));
            menu.hidden = false;
            return;
        }
        menu.replaceChildren(...cand.map((m) => el('div', { class: 'proj-mp-row', role: 'button',
            // mousedown+preventDefault: 클릭 전 blur 로 메뉴가 닫혀 클릭이 씹히는 걸 막는다.
            onmousedown: (e) => { e.preventDefault(); selected.add(m.id); searchIn.value = ''; paintChips(); openMenu(); searchIn.focus(); } }, personFace(m.id, 'proj-mp-ava', m.name), el('span', { class: 'proj-mp-name', text: label(m) }), el('span', { class: 'proj-mp-add', text: '＋ 추가' }))));
        menu.hidden = false;
    }
    searchIn.addEventListener('focus', openMenu);
    searchIn.addEventListener('input', openMenu);
    searchIn.addEventListener('blur', () => setTimeout(closeMenu, 120));
    paintChips();
    return { box, selected: () => [...selected] };
}
async function renderTerminalSession(view, id) {
    const prefs = termPrefs();
    const backLink = el('a', { class: 'btn btn-ghost btn-sm', href: '#/terminal', text: '← 세션 목록' });
    const status = el('span', { class: 'caption', text: '연결 중…' });
    const gear = el('button', { class: 'btn btn-ghost btn-sm', text: '⚙ 보기 설정', onclick: () => openTermSettings() });
    const bar = el('div', { class: 'term-bar' }, backLink, el('span', { class: 'term-bar-id', text: decodeURIComponent(id) }), el('span', { style: 'flex:1' }), status, gear);
    const host = el('div', { class: 'term-host' });
    view.replaceChildren(el('div', { class: 'term-wrap' }, bar, host));
    if (!window.Terminal || !window.FitAddon) {
        status.textContent = '터미널 라이브러리 로드 실패 (xterm)';
        return;
    }
    const term = new Terminal({
        fontFamily: prefs.fontFamily, fontSize: prefs.fontSize, cursorStyle: prefs.cursorStyle, cursorBlink: true,
        theme: (TERM_THEMES[prefs.theme] || TERM_THEMES.dark).theme, scrollback: 5000, allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
        fit.fit();
    }
    catch (_) { /* noop */ }
    try {
        await api('/api/ui/terminal/ticket', { method: 'POST' });
    }
    catch (e) {
        status.textContent = '인증 실패 — ' + e.message;
        return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/terminal/ws?session=' + encodeURIComponent(id));
    const onResize = () => { try {
        fit.fit();
    }
    catch (_) { /* noop */ } if (ws.readyState === 1) {
        try {
            ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
        }
        catch (_) { /* noop */ }
    } };
    termSession = { ws, term, fit, onResize };
    window.addEventListener('resize', onResize);
    ws.onopen = () => { status.textContent = '연결됨'; onResize(); term.focus(); };
    ws.onmessage = (e) => { if (typeof e.data === 'string')
        term.write(e.data); };
    ws.onclose = () => { status.textContent = '연결 종료'; };
    ws.onerror = () => { status.textContent = '연결 오류'; };
    term.onData((d) => { if (ws.readyState === 1) {
        try {
            ws.send(JSON.stringify({ t: 'i', d }));
        }
        catch (_) { /* noop */ }
    } });
}
function openTermSettings() {
    if (!termSession || !termSession.term) {
        toast('열린 터미널이 없습니다', true);
        return;
    }
    const term = termSession.term;
    const prefs = termPrefs();
    const fontSel = el('select', { class: 'term-input' }, ...TERM_FONTS.map((f) => el('option', { value: f.v, selected: f.v === prefs.fontFamily ? '' : null }, f.label)));
    const sizeI = el('input', { class: 'term-input', type: 'number', min: '9', max: '28', value: String(prefs.fontSize) });
    const themeSel = el('select', { class: 'term-input' }, ...Object.entries(TERM_THEMES).map(([k, v]) => el('option', { value: k, selected: k === prefs.theme ? '' : null }, v.name)));
    const cursorSel = el('select', { class: 'term-input' }, ...['bar', 'block', 'underline'].map((c) => el('option', { value: c, selected: c === prefs.cursorStyle ? '' : null }, c)));
    const apply = () => {
        const p = { fontFamily: fontSel.value, fontSize: Number(sizeI.value) || 14, theme: themeSel.value, cursorStyle: cursorSel.value };
        term.options.fontFamily = p.fontFamily;
        term.options.fontSize = p.fontSize;
        term.options.cursorStyle = p.cursorStyle;
        term.options.theme = (TERM_THEMES[p.theme] || TERM_THEMES.dark).theme;
        saveTermPrefs(p);
        if (termSession && termSession.onResize)
            termSession.onResize();
    };
    for (const c of [fontSel, themeSel, cursorSel])
        c.addEventListener('change', apply);
    sizeI.addEventListener('input', apply);
    overlay('터미널 보기 설정', field('폰트', fontSel), field('크기(px)', sizeI), field('테마', themeSel), field('커서', cursorSel), el('div', { class: 'caption', text: '설정은 이 브라우저에 저장되어 다음에도 적용됩니다.' }));
}
// 터미널 온보딩 투어(#517) — 세션 만드는 과정을 실제 UI 위에서 스포트라이트로 한 단계씩 짚어 준다.
//  '새 창으로 열기'(원래 창을 가림)를 대체: 같은 화면에서 필요한 버튼만 밝게, 나머지는 어둡게 하고
//  사용자가 실제 버튼을 직접 누르며 진행한다. renderTerminal/폼이 그린 DOM(data-tour 앵커)에 붙는다.
//  순서는 만들기 창의 시각적 위→아래를 그대로 따른다: [+ 새 세션] 클릭 → ② 이름 → ③ 폴더 → ④ 실행 옵션 →
//  ⑤ 실행 설정(선택) → ⑥ 초대(선택) → ⑦ [생성하기] 클릭 → 🎉 완료.
//  ① 새 세션·⑦ 생성하기는 advanceOn:'click' — 실제 버튼을 눌러야만 진행되며(코치마크에 [이전]/[다음]
//  없이 ✕ 닫기만), 나머지 정보 단계는 [다음 →]으로 넘어간다.
// firstStep — 있으면 ① 단계를 이걸로 대체(대시보드 등 다른 진입점의 '새 세션' 버튼 위치·문구에 맞춤). 없으면 터미널 기본.
function startTerminalTour(firstStep) {
    startTour([
        firstStep || {
            target: '[data-tour="new-session"]',
            title: '① 새 세션 만들기',
            body: [el('p', { class: 'tour-p' }, '오른쪽 위 파란 ', el('b', { text: '[+ 새 세션]' }), ' 버튼을 눌러 주세요. 세션 만들기 창이 열립니다.')],
            placement: 'bottom', advanceOn: 'click',
        },
        {
            target: '[data-tour="label"]',
            title: '② 세션 이름 정하기',
            body: [el('p', { class: 'tour-p' }, '나중에 알아보기 쉽게 이름을 적어요. 예: ', el('b', { text: '랜딩 카피 수정' }), '.')],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="folder"]',
            title: '③ 작업 폴더 고르기',
            body: [el('p', { class: 'tour-p' }, '어디서 일할지 골라요 — ', el('b', { text: '작업 위치' }), '(공유 워크스페이스 · 개인 폴더)와 ', el('b', { text: '폴더' }), '.'),
                el('p', { class: 'tour-p', text: '잘 모르겠으면 [개인 폴더] 그대로 두어도 괜찮아요.' })],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="options"]',
            title: '④ 실행 옵션',
            body: [el('p', { class: 'tour-p' }, el('b', { text: 'git 워크트리' }), ' — 저장소면 새 브랜치의 워크트리에서 격리 작업해요(다른 세션·메인과 안 충돌). 기본 켜짐.'),
                el('p', { class: 'tour-p' }, el('b', { text: '자동 승인' }), ' — 확인 없이 바로 실행해 빨라요. 공유 폴더에선 꺼 두는 걸 권해요.')],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="preset"]',
            title: '⑤ 실행 설정 (선택)',
            body: [el('p', { class: 'tour-p' }, '함께 일할 ', el('b', { text: 'AI · 모델 · effort' }), '예요. 기본값으로 접혀 있고 ', el('b', { text: '이전 설정을 기억' }), '해요 — 바꾸려면 눌러 펼치세요.'),
                el('p', { class: 'tour-p', text: '잘 모르겠으면 그대로 — Claude Code · 기본 모델로 시작해요.' })],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="invite"]',
            title: '⑥ 함께 볼 사람 초대하기 (선택)',
            body: [el('p', { class: 'tour-p' }, '검색해서 추가하면 그 사람도 이 세션을 봐요. ', el('b', { text: '비워두면 나만 보는 비공개 세션' }), '이에요.'),
                el('p', { class: 'tour-p', text: '지금 안 정해도 돼요 — 나중에 세션 [수정]에서 바꿀 수 있어요.' })],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="create"]',
            title: '⑦ 만들기',
            body: [el('p', { class: 'tour-p' }, '마지막! ', el('b', { text: '[생성하기]' }), ' 를 누르면 새 탭에 까만 터미널 창이 열리고, 거기서 완료 안내가 이어집니다.')],
            placement: 'top', scrollIntoView: true, advanceOn: 'click',
        },
        // '🎉 완료' 단계는 여기(원래 탭)에 안 띄운다 — 생성하면 새 탭으로 실제 터미널이 열리므로, 완료 안내는 그 새 탭에서
        //  보여준다(openTermCreateForm 이 &welcome=1 로 넘기고 terminal.js 의 maybeShowWelcome 이 띄운다). 흐름이 실제 터미널에서 끝난다.
    ]);
}
export { renderTerminal, startTerminalTour, openTermCreateForm, teardownTerminal, 
// '실행 설정' 기억(#673) — 프로젝트 탭 '웹에서 바로 열기' 폼도 같은 키를 읽고 써 두 폼이 기억을 공유한다(#req).
termCreatePrefs, saveTermCreatePrefs, };
