// v2/main.ts — 새 1탭 셸(#1719)의 뿌리. main.ts boot() 가 ui_mode 로 고른 뒤 bootV2() 를 부른다.
//  구조(마진 없는 풀스크린 · 상단/하단 바 없음):
//    좌 사이드바 — 로고(→홈) · 리브(→리브 페이지) · 프로젝트(워크스페이스 전체) ▸ 살아 있는 세션 트리(web/v2/side.ts) · 앱(런치패드) · 나/로그아웃
//    중앙        — 입력창 하나(홈 — Enter 로 프로젝트 없는 세션, #1719) / 프로젝트 / 세션(대화창) / 앱 프레임(클래식 화면 임베드) / 리브 페이지
//    우측        — 이 선택의 지식(프로젝트 필요·산출) · 리브 카드(홈)
//  라우트: #/ #/dashboard → 홈 · #/liv · #/p/<id> · #/s/<sid> · #/app/<key>[/…] · 그 밖의 클래식 해시 → 같은 해시로 앱 프레임.
//  데스크톱(일렉트론)에서 그대로 쓰기 위한 규약: 정적 자산 + 해시 라우트 + api()(상대 경로·bearer/쿠키)만 쓴다.
//   서버 템플릿 의존 0, window.open 대신 <a target=_blank>(일렉트론이 새 창 정책으로 받는다).
import { $view, api, el, toast } from '../core.js';
import { fillLivCards, renderLiv } from '../liv.js';
import { CLASSIC_PAGES, appByKey, appFrame, appIcon, openLaunchpad, visibleApps } from './apps.js';
import { drawSide as drawSideTree } from './side.js';
import { mergeSessions, projName, refreshSession, renderHome, renderProject, renderSession, unmountSession } from './views.js';
let root = null;
let sideEl = null;
let centerEl = null;
let asideEl = null;
let data = { projects: [], sessions: [], loadedAt: 0 };
let projLoadedAt = 0;
let routeSeq = 0;
// 프로젝트 목록은 워크스페이스 전체(수백 건·설명 포함이라 1MB 를 넘는다) — 세션처럼 20초마다 당기지 않는다.
//  5분에 한 번, 그리고 세션이 모르는 프로젝트를 가리킬 때(그새 생긴 프로젝트) 한 번 더.
const PROJ_TTL_MS = 5 * 60 * 1000;
export async function bootV2() {
    root = document.getElementById('v2-root');
    if (!root)
        return;
    root.hidden = false;
    root.replaceChildren(sideEl = el('nav', { class: 'v2-side', 'aria-label': '탐색' }), centerEl = el('div', { class: 'v2-main', id: 'v2-main' }), asideEl = el('aside', { class: 'v2-aside', 'aria-label': '이 선택의 지식' }));
    drawSide(); // 데이터 전 골격(로고·리브·앱)부터 — 빈 화면을 오래 두지 않는다
    await loadData();
    drawSide();
    window.addEventListener('hashchange', () => { void route(); });
    await route();
    // 사이드바 상태점 — 라이브 세션은 자주 바뀐다. 20초 폴링(가벼운 목록 두 개). 탭이 숨어 있으면 건너뛴다.
    setInterval(() => {
        if (document.hidden)
            return;
        void loadData().then(() => {
            drawSide();
            const c = parse();
            if (c.segs[0] === 's' && c.segs[1]) {
                const sid = decodeURIComponent(c.segs[1]);
                refreshSession(data, sid);
                // 우측 '이 세션'도 — 단 사람이 프로젝트 select 를 만지는 중이면 되그리지 않는다(선택이 날아간다, #1719).
                if (!(document.activeElement && document.activeElement.classList.contains('v2-pj-sel')))
                    drawAsideSession(data.sessions.find((x) => x.id === sid || x.logId === sid) || null);
            }
        });
    }, 20000);
}
// ── 데이터 ──
async function loadData(opts) {
    const wantProj = opts && opts.projects != null ? opts.projects : (Date.now() - projLoadedAt > PROJ_TTL_MS);
    const [pj, live, logs] = await Promise.all([
        // 워크스페이스 **전체** 프로젝트(mine=1 아님) — 사이드바가 남의 프로젝트·세션까지 한 트리로 보여준다(상민님 2026-08-18).
        //  가시성은 서버가 시행한다(#1291 — 안 보이는 리스트의 프로젝트는 애초에 안 온다).
        wantProj ? api('/api/ui/v6/projects').then((d) => (d && d.projects) || null).catch(() => null) : Promise.resolve(null),
        // includeProjects=1 — 프로젝트 폴더 세션까지(기본은 '내 개인 세션'만이라 프로젝트 트리 아래 라이브 세션이 통째로 빠졌다).
        //  프로젝트 세션은 로그인한 전원에게 보인다(#452) — 클래식 AI 세션 탭과 같은 목록이다.
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
    // 세션이 가리키는데 목록에 없는 프로젝트(방금 만든 것) — 한 번 더 당긴다. 30초 안에 또 없으면 그건 진짜 안 보이는 프로젝트(가시성)라 그만.
    if (!wantProj && Date.now() - projLoadedAt > 30_000) {
        const known = new Set(projects.map((p) => p.id));
        if (sessions.some((s) => s.projectId && !known.has(s.projectId))) {
            await loadData({ projects: true });
        }
    }
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
    if (page !== 's')
        unmountSession(); // 세션 화면을 떠나면 그 폴링·리스너를 끈다(다음 렌더가 덮어써도 타이머는 남는다)
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
            // 목록에 없는 프로젝트(방금 만든 것·딥링크) — 사이드바 트리에도 나오게 목록을 한 번 더 당긴다.
            if (detail && !data.projects.some((p) => p.id === id))
                void loadData({ projects: true }).then(() => drawSide());
            await renderProject(centerEl, data, id, detail);
            drawAsideProject(detail, id);
        }
        else if (page === 's' && segs[1]) {
            const id = decodeURIComponent(segs[1]);
            const find = () => data.sessions.find((x) => x.id === id) || data.sessions.find((x) => x.logId === id);
            let s = find();
            if (!s) {
                await loadData();
                drawSide();
                s = find();
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
// ── 사이드바 ── (트리·필터·펼침은 web/v2/side.ts — 여기선 활성 표시와 활성 키 계산만)
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
    // 트리는 수백 행이라 지금 보는 것이 화면 밖일 수 있다 — 라우트가 바뀔 때만 그 행이 보이게 살짝 굴린다(폴링 재렌더에선 안 건드린다).
    if (hit && key !== 'home' && key !== 'liv')
        hit.scrollIntoView({ block: 'nearest' });
}
function activeKey() {
    const cur = parse();
    return cur.segs[0] === 'p' ? 'p:' + cur.segs[1] : cur.segs[0] === 's' ? 's:' + decodeURIComponent(cur.segs[1] || '') : cur.segs[0] === 'liv' ? 'liv' : (!cur.segs[0] || cur.segs[0] === 'dashboard') ? 'home' : cur.segs[0] === 'app' ? 'app:' + cur.segs[1] : 'app:' + (CLASSIC_PAGES[cur.segs[0]] || '');
}
function drawSide() { if (sideEl)
    drawSideTree(sideEl, data, activeKey); }
// ── 우측 ──
function knItem(name, rel) {
    return el('a', { class: 'v2-kn', href: '#/k/' + encodeURIComponent(name), title: name }, el('span', { class: 'v2-kn-rel ' + rel, text: rel === 'req' ? '필요' : '산출' }), el('span', { class: 'v2-kn-name', text: name }));
}
function drawAsideHome() {
    if (!asideEl)
        return;
    const cards = el('div', { class: 'liv-cards v2-liv-cards' });
    asideEl.replaceChildren(el('div', { class: 'v2-aside-h' }, el('b', { text: '리브가 지금 보는 것' })), cards, el('div', { class: 'v2-aside-h', style: 'margin-top:14px' }, el('b', { text: '앱' }), el('span', { class: 'v2-k', text: '옛 화면 그대로' })), el('div', { class: 'v2-applist' }, ...visibleApps().slice(0, 6).map((a) => el('a', { class: 'v2-applink', href: '#/app/' + a.key }, appIcon(a.icon), el('span', { text: a.title })))), el('button', { class: 'btn-text', type: 'button', text: '전체 앱 보기 →', onclick: () => openLaunchpad() }));
    // 리브가 기다리는 물음(자격·선택·업로드 카드)은 이제 홈 가운데가 아니라 여기(우측) 카드 위에 붙는다 — 홈 가운데는 입력창 하나다.
    const askHost = el('div', { class: 'liv-askdock v2-askdock' });
    cards.before(askHost);
    void fillLivCards(cards, askHost);
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
    asideEl.replaceChildren(el('div', { class: 'v2-aside-h' }, el('b', { text: '이 세션' })), el('dl', { class: 'v2-facts' }, ...facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])), projectPicker(s), 
    // ⚠ replaceChildren 에 null 을 넘기면 글자 "null" 이 그려진다(el() 과 달리 걸러 주지 않는다) — 프로젝트 없는 세션에서 실측.
    ...(s.projectId ? [el('a', { class: 'btn btn-ghost btn-sm', href: '#/p/' + s.projectId, text: '프로젝트로' })] : []), el('p', { class: 'v2-fine', text: '이 세션이 읽고 찾은 지식(get·search)은 다음 단계에서 여기에 순서대로 붙습니다.' }));
}
// 세션의 프로젝트 소속 — 내 세션이면 여기서 **언제든** 붙이고 뗀다(#1719: 홈 입력창은 프로젝트를 묻지 않고 연다).
//  POST terminal/sessions/:id/project — 서버가 tmux 표시값·세션 폴더 안 마커/링크·DB 구간을 함께 바꾼다(cwd 는 그대로).
//  목록은 '내 프로젝트'(사이드바와 같은 집합) — 서버도 같은 기준(생성자·팀원)으로 막는다.
function projectPicker(s) {
    if (!s.owned || !s.live)
        return el('div', {});
    const sel = el('select', { class: 'v2-pj-sel', 'aria-label': '이 세션의 프로젝트' });
    sel.append(el('option', { value: '', text: '프로젝트 없음' }));
    const mine = [...data.projects].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    for (const p of mine)
        sel.append(el('option', { value: String(p.id), text: p.name }));
    if (s.projectId && !mine.some((p) => Number(p.id) === Number(s.projectId)))
        sel.append(el('option', { value: String(s.projectId), text: projName(data, s.projectId) }));
    sel.value = s.projectId ? String(s.projectId) : '';
    const note = el('span', { class: 'v2-fine v2-pj-note' });
    sel.onchange = async () => {
        const pid = Number(sel.value) || 0;
        sel.disabled = true;
        note.textContent = '바꾸는 중…';
        try {
            const r = await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/project', { method: 'POST', body: JSON.stringify({ projectId: pid || null }) });
            toast(pid ? `프로젝트에 붙였어요${r && r.linked ? ' — 세션 폴더의 ./project 로 프로젝트 폴더에 갑니다' : ''}.` : '프로젝트에서 뗐어요.');
            note.textContent = '';
            await loadData();
            drawSide();
            const cur = data.sessions.find((x) => x.id === s.id) || null;
            drawAsideSession(cur);
            refreshSession(data, s.id);
        }
        catch (e) {
            note.textContent = '';
            sel.disabled = false;
            sel.value = s.projectId ? String(s.projectId) : '';
            toast('프로젝트를 바꾸지 못했습니다 — ' + (e && e.message ? e.message : e), true);
        }
    };
    return el('div', { class: 'v2-pj-pick' }, el('span', { class: 'v2-k', text: '프로젝트' }), sel, note);
}
// 미사용 경고 방지 — 라우터 밖에서도 뷰를 갱신하고 싶을 때 쓰는 진입점(툴바 등 후속용).
export function v2Refresh() { void loadData().then(() => { drawSide(); void route(); }); }
export function v2Toast(msg) { toast(msg); }
export function v2View() { return $view(); }
