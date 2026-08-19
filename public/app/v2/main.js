// v2/main.ts — 새 1탭 셸(#1719)의 뿌리. main.ts boot() 가 ui_mode 로 고른 뒤 bootV2() 를 부른다.
//  구조(마진 없는 풀스크린 · 상단/하단 바 없음):
//    좌 사이드바 — 로고(→홈) · 리브(→리브 페이지) · 열린 세션(탭) 고정 · 프로젝트 ▸ 세션 트리(web/v2/side.ts) · 앱 · 나/로그아웃
//    중앙        — **탭 줄**(web/v2/tabs.ts) + 탭마다: 홈 입력창 / 프로젝트 / 세션(터미널·대화) / 앱 프레임 / 리브 페이지
//    우측        — 이 선택의 맥락(타임라인) — **탭마다 한 벌**(전환하면 그 탭의 우패널이 그대로 돌아온다)
//  라우트: #/ #/dashboard → 홈 · #/liv · #/p/<id> · #/s/<sid> · #/app/<key>[/…] · 그 밖의 클래식 해시 → 같은 해시로 앱 프레임.
//  탭 규칙(#1719 상민님 2026-08-18): 주소는 활성 탭의 라우트다. 링크는 활성 탭 안에서 이동하되, 같은 화면이 이미 다른
//  탭에 있으면 그 탭으로 간다(한 세션 = 한 탭). Alt+클릭 = 새 탭에서 열기.
//  데스크톱(일렉트론)에서 그대로 쓰기 위한 규약: 정적 자산 + 해시 라우트 + api()(상대 경로·bearer/쿠키)만 쓴다.
import { $view, anchoredPopover, api, el, sv, toast } from '../core.js';
import { fillLivCards, renderLiv } from '../liv.js';
import { CLASSIC_PAGES, appByKey, appFrame } from './apps.js';
import { drawSide as drawSideTree, projectOrder } from './side.js';
import { dotCls, mergeSessions, projName, renderHome, renderProject, renderSession } from './views.js';
import { takeCreated } from './created-cache.js';
import { createTimeline } from '../timeline.js';
import { loadProjectTimeline, loadSessionActivities, loadWorkspaceTimeline } from '../timeline-sources.js';
import { makeSplitter } from './split.js';
import { createSessionFiles } from './files.js';
import { createTabs, routeKey } from './tabs.js';
import { mountMobileChrome } from './mobile.js';
let root = null;
let sideEl = null;
// 팝아웃 창(#1744) — 세션 화면의 [⋯ ▸ 새 창]이 `?solo=1` 로 여는 같은 앱. **왼쪽 사이드바(와 탭 줄)만 없다**:
//  가운데(터미널·대화)와 우패널(발자취·파일)은 본 화면과 한 코드다. 종전엔 이 자리에 터미널 단독 페이지가 떠서 화면이 아예 달랐다.
const SOLO = new URLSearchParams(location.search).get('solo') === '1';
let centerEl = null;
let asideEl = null;
let tabsApi = null;
let mobile = null; // ≤900px 모바일 크롬(#1777) — 상단 바·서랍. 데스크톱에선 보이지 않는 채로 달려 있다.
let tlBtn = null; // 홈(바탕화면)의 타임라인 서랍 버튼 — 우패널이 있는 화면에선 CSS 로 숨는다.
let data = { projects: [], sessions: [], loadedAt: 0 };
let projLoadedAt = 0;
const projRetried = new Set(); // 목록에 없어 한 번 더 당겨 본 프로젝트 id(같은 id 로 반복 재조회 방지)
let suppressHash = 0; // 탭 전환이 만든 hashchange 를 라우터가 다시 그리지 않게
// 프로젝트 목록은 워크스페이스 전체(수백 건·설명 포함이라 1MB 를 넘는다) — 세션처럼 20초마다 당기지 않는다.
const PROJ_TTL_MS = 5 * 60 * 1000;
export async function bootV2() {
    root = document.getElementById('v2-root');
    if (!root)
        return;
    root.hidden = false;
    root.classList.toggle('solo', SOLO);
    root.replaceChildren(...(SOLO ? [] : [
        sideEl = el('nav', { class: 'v2-side', 'aria-label': '탐색' }),
        makeSplitter({ axis: 'x', key: 'side-w', cssVar: '--v2-side-w', target: root, def: 292, min: 200, max: 520, grow: 1, label: '사이드바 너비' }),
    ]), centerEl = el('div', { class: 'v2-main', id: 'v2-main' }), makeSplitter({ axis: 'x', key: 'aside-w', cssVar: '--v2-aside-w', target: root, def: 316, min: 240, max: 720, grow: -1, label: '우패널 너비' }), asideEl = el('aside', { class: 'v2-aside', 'aria-label': '이 선택의 맥락' }));
    // 모바일 크롬(#1777) — 바는 그리드 맨 앞, 배경막은 맨 뒤. 데스크톱에선 둘 다 display:none 이라 그리드 열 순서에 안 낀다.
    if (!SOLO) {
        mobile = mountMobileChrome(root, sideEl, asideEl);
        root.prepend(mobile.bar);
        root.append(mobile.scrim);
    }
    tabsApi = createTabs(centerEl, asideEl, {
        titleFor,
        onActivate: (tab, fresh) => {
            // 활성 탭의 라우트가 곧 주소다 — 다르면 맞춘다(이 hashchange 는 라우터가 무시).
            if (location.hash !== tab.route && '#' + location.hash !== tab.route) {
                suppressHash++;
                location.hash = tab.route;
            }
            applyTabChrome(tab);
            if (fresh)
                void renderRoute(tab);
            else
                markActive(routeKey(tab.route));
            drawSide();
        },
        onClose: (tab) => { if (tab.chat) {
            tab.chat.destroy();
            tab.chat = null;
        } drawSide(); },
    });
    centerEl.prepend(tabsApi.strip); // 탭 줄은 가운데 열 맨 위(탭 패널들은 tabs.ts 가 이미 뒤에 붙였다)
    // 모바일이면 탭 줄이 상단 바 가운데로 옮겨 간다(#1777) — 데스크톱으로 돌아오면 여기(가운데 열 맨 위)로 되돌린다.
    if (mobile)
        mobile.adoptStrip(tabsApi.strip, () => centerEl.prepend(tabsApi.strip));
    // 타임라인 서랍(#1719 바탕화면 방향 1차, 상민님 2026-08-19 "이 홈에서는 우측에 타임라인이 사이드바로 있는거 버려야할듯") —
    //  홈의 타임라인은 상주 열이 아니라 '불러오는 것'이다. 맥 알림 센터 문법: 우상단 버튼으로 우측 위에 카드로 떠오르고,
    //  밖 클릭·Esc·화면 이동이면 물러난다. 내용은 탭의 우패널(tab.aside) 그대로 — 렌더는 renderRoute 가 이미 해 둔다.
    const tl = el('button', { class: 'v2-tl-btn', type: 'button', 'aria-expanded': 'false', title: '타임라인 — 이 워크스페이스에 무슨 일이 있었나' }, sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, ...['M12 4v16', 'M12 8h6', 'M12 14h6', 'M6 6h2', 'M6 12h2', 'M6 18h2'].map((d) => sv('path', { d }))), '타임라인');
    tlBtn = tl;
    tl.onclick = () => setDrawer(!root.classList.contains('d-aside'));
    centerEl.append(tl);
    document.addEventListener('pointerdown', (e) => {
        if (!root || !root.classList.contains('d-aside'))
            return;
        const t = e.target;
        if (asideEl.contains(t) || tl.contains(t))
            return;
        setDrawer(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root?.classList.contains('d-aside'))
        setDrawer(false); });
    drawSide(); // 데이터 전 골격(로고·리브·앱)부터 — 빈 화면을 오래 두지 않는다
    await loadData();
    // 시작 탭 — 주소에 화면이 있으면(딥링크) 그 화면: 있던 탭이면 그 탭, 아니면 저장된 활성 탭이 그리로 간다.
    const boot = location.hash && location.hash !== '#/' && location.hash !== '#' ? location.hash : null;
    if (boot && tabsApi.find(boot)) {
        const hit = tabsApi.find(boot);
        hit.route = boot;
        tabsApi.activate(hit);
    }
    else {
        const t = tabsApi.initial() || tabsApi.add(boot || '#/', { activate: false });
        if (boot)
            t.route = boot;
        tabsApi.activate(t);
    }
    drawSide();
    window.addEventListener('hashchange', () => { void onHash(); });
    bindAltOpen();
    // 사이드바 상태점 — 라이브 세션은 자주 바뀐다. 20초 폴링. 탭이 숨어 있으면(브라우저 탭) 건너뛴다.
    setInterval(() => {
        if (document.hidden || !tabsApi)
            return;
        void loadData().then(() => {
            drawSide();
            tabsApi.paint();
            for (const t of tabsApi.tabs) {
                if (!t.chat)
                    continue;
                const sid = routeKey(t.route).startsWith('s:') ? routeKey(t.route).slice(2) : '';
                const s = sid ? findSess(sid) : null;
                if (s) {
                    t.chat.update({ ...s, projectName: projName(data, s.projectId) });
                    // 우측 '이 세션'도 — 프로젝트 드롭다운(#1749)은 body 팝오버라 우측을 되그려도 안 닫힌다.
                    drawAsideSession(t, s);
                }
            }
        });
    }, 20000);
}
// ── 데이터 ──
async function loadData(opts) {
    const wantProj = opts && opts.projects != null ? opts.projects : (Date.now() - projLoadedAt > PROJ_TTL_MS);
    const [pj, live, logs] = await Promise.all([
        // 워크스페이스 **전체** 프로젝트(mine=1 아님) — 가시성은 서버가 시행한다(#1291).
        wantProj ? api('/api/ui/v6/projects').then((d) => (d && d.projects) || null).catch(() => null) : Promise.resolve(null),
        api('/api/ui/terminal/sessions?includeProjects=1').then((d) => (d && d.sessions) || []).catch(() => []),
        api('/api/ui/v6/sessions').then((d) => (d && d.sessions) || []).catch(() => []),
    ]);
    let projects = data.projects;
    if (Array.isArray(pj)) {
        projects = pj.map((p) => ({ id: Number(p.id), name: String(p.name || ''), status: p.status ?? null, status_category: p.status_category ?? null, description: p.description ?? null, list_id: p.list_id ?? null, updated_at: p.updated_at ?? null,
            created_by: p.created_by != null ? String(p.created_by) : null, member_ids: Array.isArray(p.members) ? p.members.map((m) => String(m && m.member_id != null ? m.member_id : m)) : [] }));
        projLoadedAt = Date.now();
    }
    const sessions = mergeSessions(live, logs);
    data = { projects, sessions, loadedAt: Date.now() };
    if (!wantProj) {
        const known = new Set(projects.map((p) => p.id));
        const fresh = sessions.filter((s) => s.projectId && !known.has(s.projectId) && !projRetried.has(s.projectId)).map((s) => s.projectId);
        if (fresh.length) {
            for (const id of fresh)
                projRetried.add(id);
            await loadData({ projects: true });
        }
    }
}
const findSess = (id) => data.sessions.find((x) => x.id === id) || data.sessions.find((x) => x.logId === id);
// ── 라우터 ──
function parseRoute(route) {
    const h = String(route || '').replace(/^#\/?/, '');
    const q = h.indexOf('?');
    const path = q >= 0 ? h.slice(0, q) : h;
    return { segs: path.split('/').filter(Boolean), params: new URLSearchParams(q >= 0 ? h.slice(q + 1) : ''), raw: h };
}
/** 라우트 → 탭 제목·우패널 유무(탭 줄이 매 paint 마다 묻는다 — 데이터가 늦게 와도 이름이 따라잡는다). */
function titleFor(route) {
    const { segs, raw } = parseRoute(route);
    const p = segs[0] || '';
    // 홈은 우패널(타임라인) 없이 — 홈의 일은 '시키기'지 '돌아보기'가 아니다(상민님 2026-08-19,
    //  바탕화면 방향과 같은 결: 타임라인은 상시 패널이 아니라 불러오는 것으로 옮겨 간다).
    if (!p || p === 'dashboard')
        return { title: '홈', noAside: true };
    if (p === 'liv')
        return { title: '리브', noAside: false };
    if (p === 'p') {
        const id = Number(segs[1]);
        return { title: projName(data, id), noAside: false };
    }
    if (p === 's') {
        const s = findSess(decodeURIComponent(segs[1] || ''));
        return { title: s ? (String(s.label || '').trim() || String(s.raw?.harness || '세션')) : '세션', noAside: false };
    }
    if (p === 'app') {
        const a = appByKey(segs[1]);
        return { title: a ? a.title : segs[1], noAside: true };
    }
    if (CLASSIC_PAGES[p]) {
        const a = appByKey(CLASSIC_PAGES[p]);
        return { title: a ? a.title : raw, noAside: true };
    }
    return { title: '홈', noAside: true };
}
/** 타임라인 서랍 열림/닫힘 — 데스크톱 홈 전용(우패널이 있는 화면·모바일에선 버튼 자체가 숨는다). */
function setDrawer(on) {
    root.classList.toggle('d-aside', on);
    tlBtn?.setAttribute('aria-expanded', String(on));
}
function applyTabChrome(tab) {
    const home = routeKey(tab.route) === 'home'; // 홈: 우패널 '열'은 없지만 타임라인은 서랍으로 산다(#1719 바탕화면 1차)
    root.classList.toggle('no-aside', tab.noAside);
    root.classList.toggle('no-tl', tab.noAside && !home); // 앱 프레임: 타임라인 자체가 없다 — 서랍 버튼도 없다
    setDrawer(false); // 화면을 옮기면 서랍은 닫는다(알림 센터 문법)
    if (mobile)
        mobile.setAside(!tab.noAside || home); // 모바일 [타임라인]: 우패널 화면 + 홈(서랍으로) — 앱 프레임에만 없다
    // 리브 페이지를 떠나면 그 폴링이 멈추게(liv.ts 는 body.dataset.route==='liv' 동안만 폴링).
    document.body.dataset.route = routeKey(tab.route) === 'raw:liv' || parseRoute(tab.route).segs[0] === 'liv' ? 'liv' : 'v2';
}
/** 주소가 바뀌었다(링크 클릭·뒤로가기) — 활성 탭이 그 화면으로 이동한다. 이미 다른 탭에 있으면 그 탭으로 간다. */
async function onHash() {
    if (!tabsApi)
        return;
    if (suppressHash > 0) {
        suppressHash--;
        return;
    }
    const hash = location.hash || '#/';
    const cur = tabsApi.active();
    if (routeKey(cur.route) === routeKey(hash)) {
        cur.route = hash;
        tabsApi.routed(cur);
        return;
    }
    const other = tabsApi.find(hash);
    if (other) {
        tabsApi.activate(other);
        return;
    } // 같은 화면(같은 세션·프로젝트)은 그 탭으로 — 두 번 그리지 않는다
    if (cur.chat) {
        cur.chat.destroy();
        cur.chat = null;
    } // 세션 화면을 떠나면 그 폴링·리스너를 끈다
    cur.route = hash;
    tabsApi.routed(cur); // 제목·noAside 를 새 라우트로 먼저 — 그 뒤에 크롬을 맞춘다(거꾸로 하면 no-aside 가 한 화면 늦게 따라온다, 실측 #1777)
    applyTabChrome(cur);
    await renderRoute(cur);
    drawSide();
}
// Alt+클릭 = 새 탭에서 열기 — 셸 안 링크(#/…)에만. (Cmd/Ctrl+클릭은 브라우저 새 탭 그대로 둔다.)
function bindAltOpen() {
    document.addEventListener('click', (e) => {
        if (!e.altKey || !tabsApi)
            return;
        const a = e.target?.closest?.('a[href^="#/"]');
        if (!a)
            return;
        e.preventDefault();
        e.stopPropagation();
        const href = a.getAttribute('href') || '#/';
        const hit = tabsApi.find(href);
        if (hit)
            tabsApi.activate(hit);
        else
            tabsApi.add(href);
    }, true);
}
async function renderRoute(tab) {
    const seq = ++tab.seq;
    const { segs, raw } = parseRoute(tab.route);
    const page = segs[0] || '';
    markActive(page === 'p' ? 'p:' + segs[1] : page === 's' ? 's:' + decodeURIComponent(segs[1] || '') : page === 'liv' ? 'liv' : page === '' || page === 'dashboard' ? 'home' : '');
    try {
        if (page === '' || page === 'dashboard') {
            renderHome(tab.center, data);
            drawAsideHome(tab);
        }
        else if (page === 'liv') {
            tab.center.replaceChildren();
            const host = el('div', { class: 'v2-livpage' });
            tab.center.append(host);
            const rail = drawAsideLiv(tab);
            await renderLiv(host, { rail, embedded: true });
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
            if (seq !== tab.seq)
                return;
            if (detail && !data.projects.some((p) => p.id === id))
                void loadData({ projects: true }).then(() => { drawSide(); tabsApi?.paint(); });
            await renderProject(tab.center, data, id, detail);
            drawAsideProject(tab, detail, id);
        }
        else if (page === 's' && segs[1]) {
            const id = decodeURIComponent(segs[1]);
            let s = findSess(id);
            // 방금 만든 세션이면 생성 응답 전문으로 먼저 그린다(created-cache 머리말 — 노드 세션은 목록 반영이 한 박자 늦다).
            if (!s) {
                const seeded = takeCreated(id);
                if (seeded) {
                    data.sessions = mergeSessions([seeded], []).concat(data.sessions);
                    s = findSess(id);
                }
            }
            if (!s) {
                await loadData();
                drawSide();
                s = findSess(id);
            }
            // 그래도 없으면(다른 탭에서 만든 노드 세션 등) 에러로 끝내지 않는다 — "새로고침해 주세요"는 사람에게 폴링을 시키는 것.
            //  잠깐 기다리며 몇 번 더 본다(노드 state push 는 수 초 안에 온다). 라우트가 바뀌면(seq) 즉시 중단.
            if (!s) {
                tab.center.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '세션을 여는 중…' })));
                for (let i = 0; i < 4 && !s; i++) {
                    await new Promise((r) => setTimeout(r, 800));
                    if (seq !== tab.seq)
                        return;
                    await loadData();
                    s = findSess(id);
                }
                drawSide();
            }
            if (seq !== tab.seq)
                return;
            // 우패널(발자취)을 먼저 — 세션 화면이 대화 파일을 읽으며 거기로 흘려보낸다.
            const trail = drawAsideSession(tab, s || null);
            tab.chat = renderSession(tab.center, data, id, {
                trail,
                onPickProject: (anchor) => openProjectPicker(anchor, id, tab),
                onRename: (label) => renameSession(s ? s.id : id, label, tab),
                onToggleFiles: () => toggleAsideFiles(tab, id), // 상단바 [파일] → 이 탭 우패널을 파일 탐색기로(#1744)
                solo: SOLO,
            });
        }
        else if (page === 'app' && segs[1]) {
            const a = appByKey(segs[1]);
            const rest = segs.slice(2).join('/');
            const hash = a ? a.route + (rest ? '/' + rest : '') : segs.slice(1).join('/');
            tab.center.replaceChildren(appFrame(hash, a ? a.title : segs[1]));
            markActive('app:' + (a ? a.key : ''));
        }
        else if (CLASSIC_PAGES[page]) {
            const a = appByKey(CLASSIC_PAGES[page]);
            tab.center.replaceChildren(appFrame(raw, a ? a.title : page));
            markActive('app:' + (a ? a.key : ''));
        }
        else {
            renderHome(tab.center, data);
            drawAsideHome(tab);
        }
    }
    catch (e) {
        tab.center.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '화면을 불러오지 못했습니다 — ' + (e && e.message ? e.message : e) })));
    }
    tabsApi?.routed(tab);
}
// ── 사이드바 ── (트리·필터·펼침은 web/v2/side.ts — 여기선 활성 표시·활성 키·열린 탭 목록만)
function markActive(key) {
    if (!sideEl)
        return;
    let hit = null;
    for (const a of Array.from(sideEl.querySelectorAll('[data-nav]'))) {
        const on = a.dataset.nav === key;
        a.classList.toggle('on', on);
        if (on && !hit)
            hit = a;
    }
    //  모바일 서랍이 닫혀 있을 땐 굴리지 않는다(#1777) — 화면 밖에 고정된 서랍을 향해 굴리면 문서 자체가 밀린다. 서랍을 열 때 mobile.ts 가 굴린다.
    if (hit && key !== 'home' && key !== 'liv' && !(mobile && mobile.isMobile() && !root.classList.contains('m-side')))
        hit.scrollIntoView({ block: 'nearest' });
}
function activeKey() {
    // 부작용 없는 조회 — 부팅 중(활성 탭 확정 전)의 drawSide 가 탭을 만들어 버리면 딥링크가 죽는다(실측).
    const t = tabsApi ? tabsApi.current() : null;
    const cur = parseRoute(t ? t.route : location.hash);
    return cur.segs[0] === 'p' ? 'p:' + cur.segs[1] : cur.segs[0] === 's' ? 's:' + decodeURIComponent(cur.segs[1] || '') : cur.segs[0] === 'liv' ? 'liv' : (!cur.segs[0] || cur.segs[0] === 'dashboard') ? 'home' : cur.segs[0] === 'app' ? 'app:' + cur.segs[1] : 'app:' + (CLASSIC_PAGES[cur.segs[0]] || '');
}
/** 셸 탭에 열린 세션 id 들(활성 먼저) — 사이드바 '열린 세션' 고정 줄(side.ts)이 그린다. */
function openSessions() {
    if (!tabsApi)
        return [];
    const act = tabsApi.current();
    const out = [];
    for (const t of [...tabsApi.tabs].sort((a, b) => Number(b === act) - Number(a === act))) {
        const k = routeKey(t.route);
        if (k.startsWith('s:'))
            out.push({ id: k.slice(2), active: t === act });
    }
    return out;
}
function drawSide() { if (sideEl)
    drawSideTree(sideEl, data, activeKey, openSessions); }
// ── 우측(탭마다 한 벌 — tab.aside 에 그린다) ──
function knItem(name, rel) {
    return el('a', { class: 'v2-kn', href: '#/k/' + encodeURIComponent(name), title: name }, el('span', { class: 'v2-kn-rel ' + rel, text: rel === 'req' ? '필요' : '산출' }), el('span', { class: 'v2-kn-name', text: name }));
}
function drawAsideHome(tab) {
    const askHost = el('div', { class: 'liv-askdock v2-askdock' });
    const cards = el('div', { class: 'liv-cards v2-liv-cards', hidden: true });
    tab.aside.replaceChildren(askHost, cards);
    const tl = createTimeline(tab.aside, { scope: '워크스페이스', showActors: true, empty: '아직 남은 작업 기록이 없어요 — 세션이 일하고 기록하면 여기에 쌓입니다.' });
    void fillLivCards(cards, askHost);
    void loadWorkspaceTimeline(60).then((items) => tl.addAll(items));
}
function drawAsideLiv(tab) {
    tab.aside.replaceChildren();
    const tl = createTimeline(tab.aside, { scope: '워크스페이스', showActors: true, empty: '아직 남은 작업 기록이 없어요.' });
    void loadWorkspaceTimeline(60).then((items) => tl.addAll(items));
    return null; // rail 을 주지 않는다 = 카드는 본문에
}
function drawAsideProject(tab, detail, id) {
    tab.aside.replaceChildren();
    const tl = createTimeline(tab.aside, { scope: '프로젝트 #' + id, showActors: true, empty: '아직 이 프로젝트에서 일어난 일이 없어요.' });
    const kn = detail && detail.project && detail.project.knowledge;
    const req = (kn && kn.required) || [];
    const prod = (kn && kn.produced) || [];
    tab.aside.append(el('div', { class: 'v2-kn-foot' }, el('span', { class: 'v2-k', text: `지식 · 필요 ${req.length} · 산출 ${prod.length}` }), el('div', { class: 'v2-kn-list' }, ...[...req.map((k) => knItem(k.name, 'req')), ...prod.map((k) => knItem(k.name, 'prod'))].slice(0, 6))));
    //  '프로젝트 앱에서 열기' 는 여기 두지 않는다(상민님 2026-08-19) — 같은 링크가 가운데 화면 액션줄에 이미 있다.
    void loadProjectTimeline(id, detail).then((items) => tl.addAll(items));
}
function paintAsidePanes(host) {
    if (host.__trail)
        host.__trail.w.root.hidden = !!host.__filesOn;
    if (host.__files)
        host.__files.h.root.hidden = !host.__filesOn;
}
function dropAsideFiles(host) {
    if (host.__files) {
        host.__files.h.destroy();
        host.__files = undefined;
    }
    host.__filesOn = false;
}
/** 상단바 [파일] — 이 탭의 우패널을 '발자취 ↔ 파일 탐색기'로 갈아 낀다. 켠 상태를 돌려준다(버튼 불). */
function toggleAsideFiles(tab, id) {
    const host = tab.aside;
    const s = findSess(id);
    if (!s) {
        toast('세션 정보를 찾지 못해 파일을 열 수 없어요.', true);
        return false;
    }
    if (host.__files && host.__files.id !== s.id)
        dropAsideFiles(host);
    host.__filesOn = !host.__filesOn;
    if (host.__filesOn && !host.__files) {
        host.__files = { id: s.id, h: createSessionFiles(host, { sessionId: s.id, node: s.node,
                onClose: () => { host.__filesOn = false; paintAsidePanes(host); if (tab.chat)
                    tab.chat.setFilesOn(false); } }) };
    }
    paintAsidePanes(host);
    return !!host.__filesOn;
}
function drawAsideSession(tab, s) {
    const host = tab.aside;
    if (!s) {
        host.__trail = undefined;
        dropAsideFiles(host);
        host.replaceChildren(el('p', { class: 'v2-empty', text: '세션 정보를 찾을 수 없어요.' }));
        return null;
    }
    const raw = s.raw || {};
    const factsEl = el('div', { class: 'v2-sfacts' }, el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { text: s.stateLabel }), el('span', { class: 'sep', text: '·' }), s.projectId ? el('a', { href: '#/p/' + s.projectId, text: projName(data, s.projectId) }) : el('span', { text: '프로젝트 없음' }), raw.harness ? [el('span', { class: 'sep', text: '·' }), el('span', { class: 'mono', text: String(raw.harness) })] : null, s.node ? [el('span', { class: 'sep', text: '·' }), el('span', { text: String(s.node) })] : null, !s.owned && (raw.owner_name || raw.owner) ? [el('span', { class: 'sep', text: '·' }), el('span', { text: String(raw.owner_name || raw.owner) })] : null);
    if (host.__trail && host.__trail.id === s.id && host.__trail.w.root.isConnected) {
        host.__trail.w.setMeta(factsEl);
        paintAsidePanes(host);
        return host.__trail.w;
    }
    host.replaceChildren();
    dropAsideFiles(host); // 다른 세션으로 옮겼다 — 파일 패널도 그 세션 것으로 새로 연다
    const w = createTimeline(host, { scope: '이 세션', outcomes: true, empty: '아직 남은 것이 없어요 — 세션이 만들고 고친 것이 여기에 쌓입니다.' });
    w.setMeta(factsEl);
    host.__trail = { id: s.id, w };
    paintAsidePanes(host);
    void loadSessionActivities(s.id).then((items) => w.addAll(items));
    return w;
}
// 세션 이름 바꾸기(#1719) — 가운데 화면의 제목이 곧 편집 자리다. 서버(POST terminal/sessions/:id {label})가
//  tmux @box_label 과 복원용 desired-state 를 함께 바꾼다. 소유자만(서버가 403 으로 강제 — 화면도 내 세션에서만 연다).
//  ⚠ 바꾼 뒤 **좌측 사이드바·우패널·탭 제목이 곧바로 그 이름**이어야 한다 — 20초 폴링을 기다리게 하면 "안 바뀌었다"로 읽힌다.
//   그래서 손에 든 목록을 먼저 고쳐 다시 그리고(낙관), 서버 목록은 뒤따라 당겨 사실로 덮는다.
async function renameSession(sessionId, label, tab) {
    const s = findSess(sessionId); // 기록(uuid) 링크로 열린 세션도 같은 박스를 가리키게
    const body = { label };
    if (s && s.node)
        body.node = s.node; // 노드 세션은 게이트웨이가 그 노드로 중계한다(라우트가 body.node 를 본다)
    await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId), { method: 'POST', body: JSON.stringify(body) });
    if (s) {
        s.label = label;
        if (s.raw)
            s.raw.label = label;
    }
    drawSide();
    const cur = findSess(sessionId);
    if (tab.chat && cur)
        tab.chat.update({ ...cur, projectName: projName(data, cur.projectId) });
    drawAsideSession(tab, cur || null);
    tabsApi?.routed(tab);
    tabsApi?.paint(); // 탭 줄의 제목도 새 이름으로
    void loadData().then(() => { drawSide(); tabsApi?.paint(); });
}
// 세션의 프로젝트 소속(#1749) — 상단바 [프로젝트 연결]/[▾] 이 여는 검색 드롭다운.
function openProjectPicker(anchor, sessionId, tab) {
    const s = data.sessions.find((x) => x.id === sessionId);
    if (!s)
        return;
    const rows = projectOrder(data);
    const input = el('input', { class: 'v2-pjpick-in', type: 'search', placeholder: '프로젝트 검색', 'aria-label': '프로젝트 검색' });
    const listEl = el('div', { class: 'v2-pjpick-list', role: 'listbox' });
    const note = el('p', { class: 'v2-fine v2-pjpick-note' });
    const panel = el('div', { class: 'dash-pop-panel v2-pjpick' }, input, listEl, note);
    let closePop = null;
    let busyPick = false;
    async function pick(pid) {
        if (busyPick)
            return;
        busyPick = true;
        note.textContent = pid ? '붙이는 중…' : '떼는 중…';
        try {
            const r = await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId) + '/project', { method: 'POST', body: JSON.stringify({ projectId: pid }) });
            toast(pid ? `프로젝트에 붙였어요${r && r.linked ? ' — 세션 폴더의 ./project 로 프로젝트 폴더에 갑니다' : ''}.` : '프로젝트에서 뗐어요.');
            if (closePop)
                closePop();
            await loadData();
            drawSide();
            tabsApi?.paint();
            const cur = data.sessions.find((x) => x.id === sessionId) || null;
            if (tab.chat && cur)
                tab.chat.update({ ...cur, projectName: projName(data, cur.projectId) });
            drawAsideSession(tab, cur);
        }
        catch (e) {
            busyPick = false;
            note.textContent = '';
            toast('프로젝트를 바꾸지 못했습니다 — ' + (e && e.message ? e.message : e), true);
        }
    }
    const renderList = () => {
        const q = input.value.trim().toLowerCase();
        const hits = rows.filter((r) => !q || r.proj.name.toLowerCase().includes(q) || String(r.proj.id) === q);
        const kids = [];
        if (s.projectId)
            kids.push(el('button', { class: 'v2-pjpick-row v2-pjpick-none', type: 'button', role: 'option', onclick: () => void pick(null) }, el('span', { class: 'n', text: '프로젝트에서 떼기' }), el('span', { class: 'm', text: '프로젝트 없음으로' })));
        for (const r of hits.slice(0, 50)) {
            const cur = Number(s.projectId) === Number(r.proj.id);
            kids.push(el('button', { class: 'v2-pjpick-row' + (cur ? ' cur' : ''), type: 'button', role: 'option', 'aria-selected': String(cur), onclick: () => { if (!cur)
                    void pick(r.proj.id); },
                title: r.proj.name + ' · #' + r.proj.id }, el('span', { class: 'n', text: r.proj.name }), el('span', { class: 'm' }, el('span', { class: 'mono', text: '#' + r.proj.id }), r.done ? el('span', { class: 'v2-pjpick-done', text: '완료' }) : null, cur ? el('span', { class: 'v2-pjpick-cur', text: '✓ 지금' }) : null)));
        }
        if (hits.length > 50)
            kids.push(el('p', { class: 'v2-fine', text: `외 ${hits.length - 50}개 — 더 좁혀 검색하세요.` }));
        if (!kids.length)
            kids.push(el('p', { class: 'v2-fine', text: '조건에 맞는 프로젝트가 없어요.' }));
        listEl.replaceChildren(...kids);
    };
    input.oninput = renderList;
    input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            const first = listEl.querySelector('.v2-pjpick-row:not(.v2-pjpick-none):not(.cur)');
            if (first)
                first.click();
        }
    };
    renderList();
    closePop = anchoredPopover(anchor, panel);
    window.setTimeout(() => input.focus(), 0);
}
// 미사용 경고 방지 — 라우터 밖에서도 뷰를 갱신하고 싶을 때 쓰는 진입점(툴바 등 후속용).
export function v2Refresh() { void loadData().then(() => { drawSide(); if (tabsApi)
    void renderRoute(tabsApi.active()); }); }
export function v2Toast(msg) { toast(msg); }
export function v2View() { return $view(); }
