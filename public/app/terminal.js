// terminal.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { api, el, errorNote, pageHead, personFace, state, toast } from './core.js';
import { skeleton } from './learn.js';
import { field, overlay } from './admin.js';
import { startTour } from './tour.js';
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
async function renderTerminal(view) {
    view.replaceChildren(skeleton('세션을 불러오는 중'));
    let data, cfg;
    try {
        [data, cfg] = await Promise.all([
            api('/api/ui/terminal/sessions'), api('/api/ui/terminal/config'),
        ]);
    }
    catch (e) {
        view.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다'));
        return;
    }
    const sessions = (data && data.sessions) || [];
    const reRender = () => renderTerminal(view);
    // 서버(listSessions)가 이미 '내 것 또는 나를 초대한' 세션만 내려준다 → owned 로 두 섹션 분기.
    const mine = sessions.filter((s) => s.owned);
    const invited = sessions.filter((s) => !s.owned);
    // 삭제 가능 = 내 소유 세션. 서버도 소유자 아니면 403 으로 재검증.
    const deletable = mine;
    // 선택(일괄삭제) 상태 — 리페치 없이 로컬 재페인트. ids = 선택된 세션 id 집합.
    const sel = { mode: false, ids: new Set() };
    const headActions = el('div', { class: 'term-head-actions' });
    const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
    const body = el('div', {});
    // 작업 로그는 대시보드(#/dashboard) '팀 작업 로그' 위젯의 '전체 보기' 팝업으로 이관(터미널 탭에서 제거).
    function repaintBulk() {
        if (!sel.mode) {
            bulkBar.hidden = true;
            bulkBar.replaceChildren();
            return;
        }
        const n = sel.ids.size;
        const allOn = deletable.length > 0 && deletable.every((s) => sel.ids.has(s.id));
        const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
            onclick: () => { if (allOn)
                sel.ids.clear();
            else
                deletable.forEach((s) => sel.ids.add(s.id)); repaint(); } });
        const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0,
            onclick: () => bulkDelete(delBtn) });
        bulkBar.hidden = false;
        bulkBar.replaceChildren(el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 세션을 고르세요' }), el('div', { class: 'bulk-bar-actions' }, allBtn, delBtn));
    }
    function repaint() {
        // 헤더 우측 — '새 세션'. data-tour 앵커로 온보딩 투어(#517)가 이 버튼을 스포트라이트한다.
        //  처음이신 분(내 세션 0개)께는 '따라하기'(스포트라이트 온보딩)를 함께 — 언제든 재실행 가능한 진입점.
        const newBtn = el('button', { class: 'btn btn-primary', 'data-tour': 'new-session', text: '+ 새 세션', onclick: () => openTermCreateForm(cfg, view) });
        const tourBtn = mine.length === 0
            ? el('button', { class: 'btn btn-ghost', text: '🧭 따라하기', title: '세션 만드는 법을 화면에서 한 단계씩 짚어드려요', onclick: () => startTerminalTour() })
            : null;
        headActions.replaceChildren(...[tourBtn, newBtn].filter(Boolean));
        // '내 세션' 헤더 우측 토글 — 선택모드면 [취소], 평소엔 (삭제 가능한 세션이 있을 때만) [선택].
        const selToggle = sel.mode
            ? el('button', { class: 'btn btn-ghost btn-sm term-sel-toggle', text: '취소', onclick: () => { sel.mode = false; sel.ids.clear(); repaint(); } })
            : (deletable.length
                ? el('button', { class: 'btn btn-ghost btn-sm term-sel-toggle', text: '선택', title: '여러 세션을 골라 한 번에 삭제', onclick: () => { sel.mode = true; repaint(); } })
                : null);
        // 내 세션 / 내가 초대받은 남의 세션 — 두 섹션. 선택모드면 내 세션 행에 체크박스(selOpt).
        const selOpt = sel.mode ? { ids: sel.ids, onToggle: repaintBulk } : null;
        body.replaceChildren();
        const sec1 = termSectionHead('내 세션', '내가 만든 세션입니다. 기본 비공개이며, 멤버를 초대하면 그 사람도 보고 열 수 있습니다.', selToggle);
        const sec2 = termSectionHead('내가 초대받은 남의 세션', '다른 멤버가 나를 초대한 세션입니다.');
        sec2.classList.add('term-section--div'); // 두 번째 섹션 위에 구분선
        body.append(sec1, termSessionList(mine, cfg, view, '아직 만든 세션이 없습니다. "새 세션"으로 만드세요.', selOpt));
        body.append(sec2, termSessionList(invited, cfg, view, '초대받은 세션이 없습니다.'));
        repaintBulk();
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
    const head = pageHead('터미널', '브라우저에서 바로 AI 세션을 열고, 진행 중인 세션들을 이어서 관리합니다.', [headActions], '널');
    view.replaceChildren(...[loginBannerEl(cfg, view), head, bulkBar, body].filter(Boolean));
    repaint();
}
// 섹션 제목 + 한 줄 설명(desc 없으면 제목만).
function termSectionHead(title, desc, rightEl) {
    return el('div', { class: 'term-section' }, el('div', { class: 'term-section-row' }, el('div', { class: 'term-section-title', text: title }), rightEl || null), desc ? el('div', { class: 'caption term-section-desc', text: desc }) : null);
}
// 세션 목록(비면 안내 문구 — emptyText 가 있을 때만).
function termSessionList(items, cfg, view, emptyText, sel) {
    const list = el('div', { class: 'term-list' });
    if (!items.length && emptyText)
        list.append(el('div', { class: 'empty', text: emptyText }));
    for (const s of items)
        list.append(termRow(s, cfg, view, sel));
    return list;
}
function termRow(s, cfg, view, sel) {
    const harnessLabel = ((cfg.harnesses || []).find((h) => h.key === s.harness) || {}).label || s.harness;
    const author = memberName(cfg, s.owner) || s.owner || '?';
    const created = fmtTermDate(s.created);
    // 공유 상태 — 내 세션이면 초대 인원(없으면 '비공개')을 보여준다. 남의 세션은 소유자(author) 배지로 충분.
    const invites = s.invites || [];
    const shareBadge = s.owned
        ? (invites.length
            ? el('span', { class: 'term-badge', title: invites.map((id) => memberName(cfg, id)).join(', '), text: '초대 ' + invites.length + '명' })
            : el('span', { class: 'term-badge', text: '비공개' }))
        : null;
    const meta = el('div', { class: 'term-row-meta' }, el('div', { class: 'term-row-title' }, el('span', { class: 'term-row-name', title: s.label, text: s.label }), el('span', { class: 'term-badge author', text: '👤 ' + author }), shareBadge, s.autoApprove ? el('span', { class: 'term-badge danger', text: '자동승인' }) : null, s.attached ? el('span', { class: 'term-badge', text: '접속중' }) : null), el('div', { class: 'caption', text: harnessLabel + (created ? ' · ' + created : '') + (s.dir ? ' · ' + s.dir : '') }));
    // 선택(일괄삭제) 모드: 내 소유 세션엔 체크박스(행 전체가 토글 — label). 남의 세션은 체크박스 없음(삭제 불가).
    if (sel && s.owned) {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = sel.ids.has(s.id);
        cb.addEventListener('change', () => { if (cb.checked)
            sel.ids.add(s.id);
        else
            sel.ids.delete(s.id); if (sel.onToggle)
            sel.onToggle(); });
        return el('label', { class: 'term-row term-row--sel' }, el('span', { class: 'term-row-check' }, cb), meta);
    }
    const reRender = () => renderTerminal(view);
    const actions = [el('button', { class: 'btn btn-primary btn-sm', text: '열기', onclick: () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank') })];
    if (s.owned) {
        actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openTermEdit(s, cfg, view) }));
        actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: async () => {
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
    return el('div', { class: 'term-row' }, meta, el('div', { class: 'term-row-actions' }, ...actions));
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
function openTermCreateForm(cfg, view) {
    const roots = cfg.roots || [];
    const harnesses = cfg.harnesses || [];
    const labelI = el('input', { class: 'term-input', type: 'text', placeholder: '예: 랜딩 카피 수정' });
    const authorI = el('input', { class: 'term-input', type: 'text', value: myName(cfg), disabled: '' });
    const rootSel = el('select', { class: 'term-input' }, ...roots.map((r) => el('option', { value: r.key }, r.label)));
    const pickerBox = el('div', { class: 'term-picker' });
    let pickerPath = '';
    const harnessSel = el('select', { class: 'term-input' }, ...harnesses.map((h) => el('option', { value: h.key }, h.label)));
    const inviteBox = buildInvitePicker(cfg, new Set()); // 기본 비공개(아무도 선택 안 됨)
    const flagsBox = el('div', { class: 'term-flags' });
    const autoCb = el('input', { type: 'checkbox' });
    const autoWrap = el('label', { class: 'term-auto', 'data-tour': 'autoapprove' }, autoCb, el('span', { text: ' 자동 승인 (위험) — 에이전트가 확인 없이 파일 수정·명령 실행. 공유 폴더에선 특히 주의.' }));
    function renderFlags() {
        const h = harnesses.find((x) => x.key === harnessSel.value) || {};
        flagsBox.replaceChildren();
        for (const f of (h.flags || [])) {
            let ctrl;
            if (f.type === 'select')
                ctrl = el('select', { class: 'term-input', 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c }, c || '(기본)')));
            else if (f.type === 'bool')
                ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
            else
                ctrl = el('input', { class: 'term-input', type: 'text', 'data-flag': f.name, placeholder: f.desc || '' });
            flagsBox.append(el('div', { class: 'field' }, el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
        }
        autoWrap.style.display = h.hasAutoApprove ? '' : 'none';
    }
    harnessSel.addEventListener('change', renderFlags);
    renderFlags();
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
    // data-tour 래퍼 — 온보딩 투어(#517)가 폼의 시각적 순서(위→아래)대로 스포트라이트한다:
    //  이름 → 폴더 → AI → 초대 → 모델 → 자동 승인 → 생성.
    const back = overlay('새 세션', el('div', { 'data-tour': 'label' }, field('이름', labelI)), field('작업자', authorI), el('div', { 'data-tour': 'folder' }, field('작업 위치', rootSel), field('폴더', pickerBox)), el('div', { 'data-tour': 'harness' }, field('하네스', harnessSel)), profileNoteEl(cfg), el('div', { 'data-tour': 'invite' }, field('초대 (선택한 멤버만 이 세션을 보고 열 수 있음 · 비우면 비공개)', inviteBox.box)), el('div', { 'data-tour': 'model' }, flagsBox), autoWrap, el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-primary', 'data-tour': 'create', text: '생성하기', onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            const flags = {};
            for (const c of flagsBox.querySelectorAll('[data-flag]'))
                flags[c.dataset.flag] = (c.type === 'checkbox') ? c.checked : c.value;
            const payload = { label: labelI.value, rootKey: rootSel.value, subpath: pickerPath, harness: harnessSel.value, flags, autoApprove: autoCb.checked, invites: inviteBox.selected() };
            try {
                const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify(payload) });
                back.remove();
                toast('세션 생성됨');
                if (out && out.session)
                    window.open('/ui/terminal.html?session=' + encodeURIComponent(out.session.id) + '&label=' + encodeURIComponent(out.session.label || ''), '_blank');
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
    const lockNote = el('div', { class: 'term-lock-note' }, el('span', { text: '🔒 작업 폴더 · 하네스 · 모델 · 자동 승인은 세션을 처음 켤 때 정해집니다. 바꾸려면 실행 중인 LLM(또는 셸)을 닫고 새로 켜야 하므로 여기서는 수정할 수 없습니다 — 바꾸려면 새 세션을 만드세요.' }));
    const back = overlay('세션 수정', field('이름', labelI), field('초대 (선택한 멤버만 이 세션을 보고 열 수 있음 · 비우면 비공개)', inviteBox.box), lockNote, field('작업자', ro(author)), field('작업 폴더', ro(s.dir || '(기본)')), field('하네스', ro(harness.label || s.harness || '?')), flagFields, field('자동 승인', ro(autoShown)), el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-primary', text: '저장', onclick: async (ev) => {
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
// 초대 멤버 피커 — 프로젝트 팀원 피커(projects.ts memberPicker, .proj-mp)와 동일한 UI 로 통일(#617):
//  검색 + 초대 요약 + [아바타·이름·✓] 행(클릭 토글, 선택된 사람은 위로). 나(state.me) 제외한
//  구성원(사람·AI)이 후보. current(Set)=초기 선택, selected()=고른 멤버 id 배열. 생성·수정 폼이 공유한다.
function buildInvitePicker(cfg, current) {
    const meId = (state.me && state.me.userId) || '';
    const others = (cfg.members || []).filter((m) => m.id !== meId);
    const selected = new Set([...current].filter((id) => others.some((m) => m.id === id))); // 유령 id 방지
    const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '이름으로 검색…' });
    const count = el('div', { class: 'proj-mp-count' });
    const results = el('div', { class: 'proj-mp-results' });
    const box = el('div', { class: 'proj-mp' }, searchIn, count, results);
    function paint() {
        const n = selected.size;
        count.textContent = n ? n + '명 초대됨' : '초대할 사람을 골라 추가하세요';
        if (!others.length) {
            results.replaceChildren(el('div', { class: 'proj-mp-empty', text: '초대할 다른 구성원이 없습니다 — 비공개 세션이 됩니다.' }));
            return;
        }
        const q = searchIn.value.trim().toLowerCase();
        const cand = others.filter((m) => !q || (m.name || m.id).toLowerCase().includes(q));
        cand.sort((a, b) => (selected.has(b.id) ? 1 : 0) - (selected.has(a.id) ? 1 : 0)); // 선택된 사람을 위로
        if (!cand.length) {
            results.replaceChildren(el('div', { class: 'proj-mp-empty', text: '일치하는 사람이 없어요.' }));
            return;
        }
        results.replaceChildren(...cand.map((m) => {
            const on = selected.has(m.id);
            return el('div', { class: 'proj-mp-row' + (on ? ' on' : ''), role: 'button', 'aria-pressed': on ? 'true' : 'false',
                onclick: () => { if (on)
                    selected.delete(m.id);
                else
                    selected.add(m.id); paint(); searchIn.focus(); } }, personFace(m.id, 'proj-mp-ava', m.name), el('span', { class: 'proj-mp-name', text: m.name + (m.kind === 'agent' ? ' (AI)' : '') }), el('span', { class: 'proj-mp-check' + (on ? ' on' : ''), 'aria-hidden': 'true', text: on ? '✓' : '' }));
        }));
    }
    searchIn.addEventListener('input', paint);
    paint();
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
//  순서는 만들기 창의 시각적 위→아래를 그대로 따른다: [+ 새 세션] 클릭 → ② 이름 → ③ 폴더 → ④ AI →
//  ⑤ 초대(선택) → ⑥ 모델(선택) → ⑦ 자동 승인(주의) → ⑧ [생성하기] 클릭 → 🎉 완료.
//  ① 새 세션·⑧ 생성하기는 advanceOn:'click' — 실제 버튼을 눌러야만 진행되며(코치마크에 [이전]/[다음]
//  없이 ✕ 닫기만), 나머지 정보 단계는 [다음 →]으로 넘어간다.
function startTerminalTour() {
    startTour([
        {
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
            target: '[data-tour="harness"]',
            title: '④ 함께 일할 AI 고르기',
            body: [el('p', { class: 'tour-p' }, el('b', { text: 'Claude Code' }), ' 또는 ', el('b', { text: 'Codex' }), ' 중에 골라요. 잘 모르겠으면 Claude Code 를 추천해요.')],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="invite"]',
            title: '⑤ 함께 볼 사람 초대하기 (선택)',
            body: [el('p', { class: 'tour-p' }, '필요하면 이 세션을 함께 볼 사람을 골라요. ', el('b', { text: '비워두면 나만 보는 비공개 세션' }), '이에요.'),
                el('p', { class: 'tour-p', text: '지금 안 정해도 돼요 — 나중에 세션 [수정]에서 바꿀 수 있어요.' })],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="model"]',
            title: '⑥ 모델 고르기 (선택)',
            body: [el('p', { class: 'tour-p' }, '함께 일할 AI 의 ', el('b', { text: '모델' }), '을 골라요. ', el('b', { text: '비워두면 기본 모델' }), '로 시작해요.'),
                el('p', { class: 'tour-p', text: '잘 모르겠으면 그대로 두면 돼요 — 더 똑똑한 모델일수록 느리거나 비쌀 수 있어요.' })],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="autoapprove"]',
            title: '⑦ 자동 승인 (주의)',
            body: [el('p', { class: 'tour-p' }, '체크하면 AI 가 ', el('b', { text: '확인 없이 파일 수정·명령 실행' }), '까지 알아서 해요 — 빠르지만 위험해요.'),
                el('p', { class: 'tour-p', text: '특히 공유 폴더에선 꺼 두길 권해요. 잘 모르겠으면 그대로(꺼짐) 두세요.' })],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="create"]',
            title: '⑧ 만들기',
            body: [el('p', { class: 'tour-p' }, '마지막! ', el('b', { text: '[생성하기]' }), ' 를 누르면 까만 터미널 창이 열려요.')],
            placement: 'top', scrollIntoView: true, advanceOn: 'click',
        },
        {
            target: () => null,
            title: '🎉 다 됐어요!',
            body: [el('p', { class: 'tour-p', text: '새로 열린 터미널 창에 하고 싶은 말을 그냥 입력하면 됩니다. 회사 맥락·규칙은 이미 들어가 있어요.' }),
                el('p', { class: 'tour-p', text: '세션은 창을 닫아도 서버에 남아, 다음에 [터미널] 탭에서 이어서 쓸 수 있어요.' })],
            placement: 'center', ctaNext: '마치기',
        },
    ]);
}
export { renderTerminal, startTerminalTour, teardownTerminal, };
