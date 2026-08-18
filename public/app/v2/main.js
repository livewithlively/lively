// v2/main.ts — 새 1탭 셸(#1719)의 뿌리. main.ts boot() 가 ui_mode 로 고른 뒤 bootV2() 를 부른다.
//  구조(마진 없는 풀스크린 · 상단/하단 바 없음):
//    좌 사이드바 — 로고(→홈) · 리브(→리브 페이지) · 내 프로젝트 ▸ 세션 트리 · 앱(런치패드) · 나/로그아웃
//    중앙        — 리브와 대화(홈) / 프로젝트 / 세션 / 앱 프레임(클래식 화면 임베드) / 리브 페이지
//    우측        — 이 선택의 지식(프로젝트 필요·산출) · 리브 카드(홈)
//  라우트: #/ #/dashboard → 홈 · #/liv · #/p/<id> · #/s/<sid> · #/app/<key>[/…] · 그 밖의 클래식 해시 → 같은 해시로 앱 프레임.
//  데스크톱(일렉트론)에서 그대로 쓰기 위한 규약: 정적 자산 + 해시 라우트 + api()(상대 경로·bearer/쿠키)만 쓴다.
//   서버 템플릿 의존 0, window.open 대신 <a target=_blank>(일렉트론이 새 창 정책으로 받는다).
import { $view, api, el, logout, navOn, profileAvatar, setUiModeOverride, state, toast } from '../core.js';
import { fillLivCards, renderLiv } from '../liv.js';
import { CLASSIC_PAGES, appByKey, appFrame, appIcon, openLaunchpad, visibleApps } from './apps.js';
import { dotCls, mergeSessions, projName, renderHome, renderProject, renderSession } from './views.js';
const OPEN_KEY = 'lively_v2_open';
let root = null;
let sideEl = null;
let centerEl = null;
let asideEl = null;
let data = { projects: [], sessions: [], loadedAt: 0 };
let openSet = new Set();
let sideFilter = '';
let routeSeq = 0;
export async function bootV2() {
    root = document.getElementById('v2-root');
    if (!root)
        return;
    try {
        openSet = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'));
    }
    catch (_) {
        openSet = new Set();
    }
    root.hidden = false;
    root.replaceChildren(sideEl = el('nav', { class: 'v2-side', 'aria-label': '탐색' }), centerEl = el('div', { class: 'v2-main', id: 'v2-main' }), asideEl = el('aside', { class: 'v2-aside', 'aria-label': '이 선택의 지식' }));
    drawSide(); // 데이터 전 골격(로고·리브·앱)부터 — 빈 화면을 오래 두지 않는다
    await loadData();
    drawSide();
    window.addEventListener('hashchange', () => { void route(); });
    await route();
    // 사이드바 상태점 — 라이브 세션은 자주 바뀐다. 20초 폴링(가벼운 목록 두 개). 탭이 숨어 있으면 건너뛴다.
    setInterval(() => { if (document.hidden)
        return; void loadData().then(drawSide); }, 20000);
}
// ── 데이터 ──
async function loadData() {
    const [pj, live, logs] = await Promise.all([
        api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []).catch(() => data.projects),
        api('/api/ui/terminal/sessions').then((d) => (d && d.sessions) || []).catch(() => []),
        api('/api/ui/v6/sessions').then((d) => (d && d.sessions) || []).catch(() => []),
    ]);
    const projects = pj.map((p) => ({ id: Number(p.id), name: String(p.name || ''), status: p.status ?? null, status_category: p.status_category ?? null, my_session_count: p.my_session_count, description: p.description ?? null, list_id: p.list_id ?? null, updated_at: p.updated_at ?? null }));
    data = { projects, sessions: mergeSessions(live, logs), loadedAt: Date.now() };
}
// ── 라우터 ──
function parse() {
    const h = location.hash.replace(/^#\/?/, '');
    const q = h.indexOf('?');
    const path = q >= 0 ? h.slice(0, q) : h;
    return { segs: path.split('/').filter(Boolean), params: new URLSearchParams(q >= 0 ? h.slice(q + 1) : ''), raw: h };
}
async function route() {
    if (!centerEl || !asideEl)
        return;
    const seq = ++routeSeq;
    const { segs, raw } = parse();
    const page = segs[0] || '';
    // 리브 페이지를 떠나면 그 폴링이 멈추도록 route 표식을 되돌린다(liv.ts 는 body.dataset.route==='liv' 동안만 폴링).
    document.body.dataset.route = 'v2';
    markActive(page === 'p' ? 'p:' + segs[1] : page === 's' ? 's:' + decodeURIComponent(segs[1] || '') : page === 'liv' ? 'liv' : page === '' || page === 'dashboard' ? 'home' : '');
    root.classList.toggle('no-aside', false);
    try {
        if (page === '' || page === 'dashboard') {
            renderHome(centerEl, data);
            drawAsideHome();
        }
        else if (page === 'liv') {
            // 리브 전체 페이지 — 클래식 renderLiv 를 **그대로** 이 칸에 그린다(카드 레일 + 대화). 크롬은 새 셸이 대신 준다.
            centerEl.replaceChildren();
            const host = el('div', { class: 'v2-livpage' });
            centerEl.append(host);
            await renderLiv(host);
            root.classList.add('no-aside');
        }
        else if (page === 'p' && segs[1]) {
            const id = Number(segs[1]);
            let detail = null;
            try {
                detail = await api('/api/ui/v6/projects/' + id);
            }
            catch (_) {
                detail = null;
            }
            if (seq !== routeSeq)
                return;
            await renderProject(centerEl, data, id, detail);
            drawAsideProject(detail, id);
        }
        else if (page === 's' && segs[1]) {
            const id = decodeURIComponent(segs[1]);
            let s = data.sessions.find((x) => x.id === id);
            if (!s) {
                await loadData();
                drawSide();
                s = data.sessions.find((x) => x.id === id);
            }
            if (seq !== routeSeq)
                return;
            renderSession(centerEl, data, id);
            drawAsideSession(s || null);
        }
        else if (page === 'app' && segs[1]) {
            const a = appByKey(segs[1]);
            const rest = segs.slice(2).join('/');
            const hash = a ? a.route + (rest ? '/' + rest : '') : segs.slice(1).join('/');
            centerEl.replaceChildren(appFrame(hash, a ? a.title : segs[1]));
            root.classList.add('no-aside');
            markActive('app:' + (a ? a.key : ''));
        }
        else if (CLASSIC_PAGES[page]) {
            // 옛 딥링크(#/knowledge/…, #/projects2/p/12, #/system/…) — 앱 프레임에 그 해시 그대로. 북마크가 새 셸에서도 산다.
            const a = appByKey(CLASSIC_PAGES[page]);
            centerEl.replaceChildren(appFrame(raw, a ? a.title : page));
            root.classList.add('no-aside');
            markActive('app:' + (a ? a.key : ''));
        }
        else {
            renderHome(centerEl, data);
            drawAsideHome();
        }
    }
    catch (e) {
        centerEl.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '화면을 불러오지 못했습니다 — ' + (e && e.message ? e.message : e) })));
    }
}
// ── 사이드바 ──
function markActive(key) {
    if (!sideEl)
        return;
    for (const a of Array.from(sideEl.querySelectorAll('[data-nav]')))
        a.classList.toggle('on', a.dataset.nav === key);
}
function saveOpen() { try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...openSet]));
}
catch (_) { /* noop */ } }
function drawSide() {
    if (!sideEl)
        return;
    const me = state.me || {};
    const name = String(me.display_name || me.email || me.userId || '');
    const cur = parse();
    const activeKey = cur.segs[0] === 'p' ? 'p:' + cur.segs[1] : cur.segs[0] === 's' ? 's:' + decodeURIComponent(cur.segs[1] || '') : cur.segs[0] === 'liv' ? 'liv' : (!cur.segs[0] || cur.segs[0] === 'dashboard') ? 'home' : cur.segs[0] === 'app' ? 'app:' + cur.segs[1] : 'app:' + (CLASSIC_PAGES[cur.segs[0]] || '');
    const liveByProj = new Map();
    const noProj = [];
    for (const s of data.sessions) {
        if (s.projectId) {
            const arr = liveByProj.get(s.projectId) || [];
            arr.push(s);
            liveByProj.set(s.projectId, arr);
        }
        else
            noProj.push(s);
    }
    const q = sideFilter.trim().toLowerCase();
    const projects = [...data.projects].filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.id) === q).sort((a, b) => {
        const la = (liveByProj.get(a.id) || []).some((s) => s.live && s.alive) ? 1 : 0, lb = (liveByProj.get(b.id) || []).some((s) => s.live && s.alive) ? 1 : 0;
        if (la !== lb)
            return lb - la;
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
    const projRow = (p) => {
        const sess = (liveByProj.get(p.id) || []).sort((a, b) => Number(b.live) - Number(a.live) || b.lastSeen - a.lastSeen);
        const pk = 'p:' + p.id;
        const isOpen = openSet.has(pk);
        const worst = sess.some((s) => s.alive && s.stateKey === 'waiting') ? 'wait' : sess.some((s) => s.alive && s.stateKey === 'busy') ? 'busy' : p.status_category === 'done' ? 'done' : '';
        const caret = el('button', { class: 'v2-car', type: 'button', 'aria-label': isOpen ? '접기' : '펼치기', 'aria-expanded': String(isOpen), text: '›', onclick: (e) => { e.preventDefault(); e.stopPropagation(); if (openSet.has(pk))
                openSet.delete(pk);
            else
                openSet.add(pk); saveOpen(); drawSide(); } });
        const row = el('a', { class: 'v2-pj-row' + (activeKey === pk ? ' on' : ''), href: '#/p/' + p.id, 'data-nav': pk }, caret, el('span', { class: 'n', text: p.name }), sess.length ? el('span', { class: 'v2-cnt', text: String(sess.length) }) : null, el('span', { class: 'v2-dot ' + worst }));
        const list = el('div', { class: 'v2-ss-list', hidden: !isOpen }, ...sess.slice(0, 12).map((s) => el('a', { class: 'v2-ss-row' + (activeKey === 's:' + s.id ? ' on' : ''), href: '#/s/' + encodeURIComponent(s.id), 'data-nav': 's:' + s.id, title: s.label }, el('span', { class: 'v2-dot ' + dotCls(s.stateKey) }), el('span', { class: 't', text: s.label }), el('span', { class: 'w', text: s.live ? s.stateLabel : '기록' }))), sess.length > 12 ? el('a', { class: 'v2-ss-more', href: '#/p/' + p.id, text: `외 ${sess.length - 12}개` }) : null);
        return el('div', { class: 'v2-pj' + (isOpen ? ' open' : '') }, row, list);
    };
    const livOn = navOn('liv') !== false;
    sideEl.replaceChildren(el('div', { class: 'v2-side-top' }, el('a', { class: 'v2-logo', href: '#/', title: '홈으로', 'data-nav': 'home' }, 'Lively', el('span', { class: 'pulse-dot', 'aria-hidden': 'true' }))), livOn ? el('a', { class: 'v2-liv-btn' + (activeKey === 'liv' ? ' on' : ''), href: '#/liv', 'data-nav': 'liv' }, el('span', { class: 'lm', text: 'L' }), el('span', { text: '리브' }), el('span', { class: 'sub', text: '워크스페이스 담당자' })) : null, el('div', { class: 'v2-side-sec' }, el('span', { class: 'v2-k', text: `내 프로젝트 · ${data.projects.length}` }), el('a', { class: 'v2-add', href: '#/projects2', text: '+ 새 프로젝트', title: '프로젝트 앱(보드)에서 만듭니다' })), data.projects.length > 12 ? el('div', { class: 'v2-find' }, el('input', { class: 'v2-find-in', type: 'search', placeholder: '프로젝트 찾기', 'aria-label': '프로젝트 찾기', value: sideFilter, oninput: (e) => { sideFilter = e.target.value; drawSide(); const i = sideEl.querySelector('.v2-find-in'); if (i) {
            i.focus();
            i.setSelectionRange(i.value.length, i.value.length);
        } } })) : null, el('div', { class: 'v2-tree' }, ...projects.map(projRow), noProj.length ? el('div', { class: 'v2-pj open' }, el('a', { class: 'v2-pj-row' + (activeKey === 'app:terminal' ? '' : ''), href: '#/app/terminal', 'data-nav': 'app:terminal' }, el('span', { class: 'v2-car', 'aria-hidden': 'true', text: '›' }), el('span', { class: 'n', text: '프로젝트 없는 세션' }), el('span', { class: 'v2-cnt', text: String(noProj.length) })), el('div', { class: 'v2-ss-list' }, ...noProj.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 8).map((s) => el('a', { class: 'v2-ss-row' + (activeKey === 's:' + s.id ? ' on' : ''), href: '#/s/' + encodeURIComponent(s.id), 'data-nav': 's:' + s.id, title: s.label }, el('span', { class: 'v2-dot ' + dotCls(s.stateKey) }), el('span', { class: 't', text: s.label }), el('span', { class: 'w', text: s.live ? s.stateLabel : '기록' }))))) : null, !projects.length && !noProj.length ? el('p', { class: 'v2-tree-note', text: '아직 프로젝트가 없어요. 리브에게 무엇이든 시키거나, [+ 새 프로젝트]로 시작하세요.' }) : null), el('div', { class: 'v2-side-foot' }, el('button', { class: 'v2-apps-btn', type: 'button', onclick: () => openLaunchpad(), title: '앱 — 아직 새 화면으로 옮기지 않은 것들' }, appIcon('proj', 'v2-apps-ic'), el('span', { text: '앱' }), el('span', { class: 'v2-cnt', text: String(visibleApps().length) })), el('div', { class: 'v2-me' }, profileAvatar(me.avatar, name, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }), el('span', { class: 'v2-me-name', text: name }), el('button', { class: 'btn-text', type: 'button', text: '로그아웃', onclick: () => void logout() })), el('button', { class: 'v2-classic-link', type: 'button', text: '클래식 화면으로 (이 브라우저)', title: '이 브라우저에서만 옛 화면으로 봅니다. 관리탭 [화면] 에서 되돌릴 수 있어요.', onclick: () => { setUiModeOverride('classic'); location.replace(location.pathname + '#/dashboard'); location.reload(); } })));
}
// ── 우측 ──
function knItem(name, rel) {
    return el('a', { class: 'v2-kn', href: '#/k/' + encodeURIComponent(name), title: name }, el('span', { class: 'v2-kn-rel ' + rel, text: rel === 'req' ? '필요' : '산출' }), el('span', { class: 'v2-kn-name', text: name }));
}
function drawAsideHome() {
    if (!asideEl)
        return;
    const cards = el('div', { class: 'liv-cards v2-liv-cards' });
    asideEl.replaceChildren(el('div', { class: 'v2-aside-h' }, el('b', { text: '리브가 지금 보는 것' })), cards, el('div', { class: 'v2-aside-h', style: 'margin-top:14px' }, el('b', { text: '앱' }), el('span', { class: 'v2-k', text: '옛 화면 그대로' })), el('div', { class: 'v2-applist' }, ...visibleApps().slice(0, 6).map((a) => el('a', { class: 'v2-applink', href: '#/app/' + a.key }, appIcon(a.icon), el('span', { text: a.title })))), el('button', { class: 'btn-text', type: 'button', text: '전체 앱 보기 →', onclick: () => openLaunchpad() }));
    const askHost = (centerEl && centerEl.querySelector('.v2-askdock'));
    void fillLivCards(cards, askHost || el('div', {}));
}
function drawAsideProject(detail, id) {
    if (!asideEl)
        return;
    const kn = detail && detail.project && detail.project.knowledge;
    const req = (kn && kn.required) || [];
    const prod = (kn && kn.produced) || [];
    asideEl.replaceChildren(el('div', { class: 'v2-aside-h' }, el('b', { text: '이 프로젝트의 지식' }), el('span', { class: 'v2-k', text: `필요 ${req.length} · 산출 ${prod.length}` })), el('div', { class: 'v2-kn-sec' }, el('span', { class: 'v2-k', text: '필요지식' }), req.length ? el('div', { class: 'v2-kn-list' }, ...req.map((k) => knItem(k.name, 'req'))) : el('p', { class: 'v2-empty', text: '아직 없어요 — 세션에서 리브가 읽은 것부터 채워집니다.' })), el('div', { class: 'v2-kn-sec' }, el('span', { class: 'v2-k', text: '산출지식' }), prod.length ? el('div', { class: 'v2-kn-list' }, ...prod.map((k) => knItem(k.name, 'prod'))) : el('p', { class: 'v2-empty', text: '세션이 끝나면 여기에 쌓입니다.' })), el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2/p/' + id, text: '프로젝트 앱에서 지식 연결' }));
}
function drawAsideSession(s) {
    if (!asideEl)
        return;
    if (!s) {
        asideEl.replaceChildren(el('p', { class: 'v2-empty', text: '세션 정보를 찾을 수 없어요.' }));
        return;
    }
    const raw = s.raw || {};
    const facts = [
        ['상태', s.stateLabel], ['프로젝트', projName(data, s.projectId)],
        ['하네스', String(raw.harness || '—')], ['노드', String(s.node || '이 박스')],
        ['소유', s.owned ? '나' : String(raw.owner || raw.owner_name || '—')],
    ];
    asideEl.replaceChildren(el('div', { class: 'v2-aside-h' }, el('b', { text: '이 세션' })), el('dl', { class: 'v2-facts' }, ...facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])), s.projectId ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/p/' + s.projectId, text: '프로젝트로' }) : null, el('p', { class: 'v2-fine', text: '이 세션이 읽고 찾은 지식(get·search)은 다음 단계에서 여기에 순서대로 붙습니다.' }));
}
// 미사용 경고 방지 — 라우터 밖에서도 뷰를 갱신하고 싶을 때 쓰는 진입점(툴바 등 후속용).
export function v2Refresh() { void loadData().then(() => { drawSide(); void route(); }); }
export function v2Toast(msg) { toast(msg); }
export function v2View() { return $view(); }
