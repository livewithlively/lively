// v2/main.ts — 새 1탭 셸(#1719)의 뿌리. main.ts boot() 가 ui_mode 로 고른 뒤 bootV2() 를 부른다.
//  구조(마진 없는 풀스크린 · 상단/하단 바 없음):
//    좌 사이드바 — 로고(→홈) · 리브(→리브 페이지) · 열린 세션(탭) 고정 · 프로젝트 ▸ 세션 트리(web/v2/side.ts) · 앱 · 나/로그아웃
//    중앙        — **탭 줄**(web/v2/tabs.ts) + 탭마다: 홈 입력창 / 프로젝트(짧은 개요 + 리브 대화, v2/project-view.ts #1757) / 세션(터미널·대화) / 앱 프레임 / 리브 페이지
//    우측        — 이 선택의 맥락(타임라인) — **탭마다 한 벌**(전환하면 그 탭의 우패널이 그대로 돌아온다)
//  라우트: #/ #/dashboard → 홈 · #/liv · #/p/<id> · #/s/<sid> · #/app/<key>[/…] · 그 밖의 클래식 해시 → 같은 해시로 앱 프레임.
//  탭 규칙(#1719 상민님 2026-08-18): 주소는 활성 탭의 라우트다. 링크는 활성 탭 안에서 이동하되, 같은 화면이 이미 다른
//  탭에 있으면 그 탭으로 간다(한 세션 = 한 탭). Alt+클릭 = 새 탭에서 열기.
//  데스크톱(일렉트론)에서 그대로 쓰기 위한 규약: 정적 자산 + 해시 라우트 + api()(상대 경로·bearer/쿠키)만 쓴다.
import { $view, anchoredPopover, api, el, toast } from '../core.js';
import { renderLiv } from '../liv.js';
import { CLASSIC_PAGES, appByKey, appFrame } from './apps.js';
import { bySeen, drawSide as drawSideTree, projectOrder, sessText } from './side.js';
import { dotCls, mergeSessions, projName, renderHome, renderInbox, renderSession } from './views.js';
import { renderConnect, renderConnectApp } from './connect.js';
import { mountPanes } from './panes.js'; // 프로젝트 = 세션 화면(#1719 원준 2026-08-20) — 칸으로 나뉜 도킹 화면 하나뿐이다.
import { createTimeline } from '../timeline.js';
import { loadSessionActivities } from '../timeline-sources.js';
import { makeSplitter } from './split.js';
import { createSessionFiles } from './files.js';
import { createTabs, routeKey } from './tabs.js';
import { confirmSessionArchive } from '../session-actions.js';
import { mountMobileChrome } from './mobile.js';
import { takeCreated } from './created-cache.js';
// 팝아웃 창(#1744) — 세션 화면 [⋯ ▸ 새 창]이 `?solo=1` 로 여는 같은 앱. **좌측(과 탭 줄)만 없다**:
//  가운데(터미널·대화)와 우패널은 본 화면과 한 코드다. 실험장으로 갈아타도 이 창은 그대로 서야 한다.
const SOLO = new URLSearchParams(location.search).get('solo') === '1';
let root = null;
let sideEl = null;
let centerEl = null;
let asideEl = null;
let tabsApi = null;
let mobile = null; // ≤900px 모바일 크롬(#1777) — 상단 바·서랍. 데스크톱에선 보이지 않는 채로 달려 있다.
let data = { projects: [], sessions: [], loadedAt: 0 };
let projLoadedAt = 0;
const projRetried = new Set(); // 목록에 없어 한 번 더 당겨 본 프로젝트 id(같은 id 로 반복 재조회 방지)
let suppressHash = 0; // 탭 전환이 만든 hashchange 를 라우터가 다시 그리지 않게
// 프로젝트 화면(#1757) 핸들 — **탭마다 하나**. 탭이 다른 화면으로 가거나 닫힐 때 destroy(리브 턴 폴링 정지).
//  탭 전환(숨김)에는 살려 둔다 — 탭의 존재 이유(상태 보존)와 같은 원칙.
//  뷰가 둘(기본·캔버스)이라 핸들은 공통 계약 하나로만 본다 — 셸이 아는 것은 '언젠가 정리해야 한다'뿐이다.
const projViews = new Map();
function dropProjView(tab) { const pv = projViews.get(tab); if (pv) {
    pv.destroy();
    projViews.delete(tab);
} }
// ── 프로젝트 = 세션이 놓인 방(원준 2026-08-20) ────────────────────────────────
/** 그 프로젝트의 **맨 위 세션** — 사이드바에서 보이는 순서와 같은 정의(side.ts bySeen). */
/** 세션 주소를 그 세션의 **정본 id**(박스 id)로 맞춘다 — 기록 uuid 로 들어와도 같은 탭이 되도록. */
function canonSessionHash(hash) {
    const k = routeKey(hash);
    if (!k.startsWith('s:'))
        return hash;
    const id = k.slice(2);
    const s = findSess(id);
    return s && s.id && s.id !== id ? '#/s/' + encodeURIComponent(s.id) : hash;
}
function topSessionOf(projectId) {
    if (!(projectId > 0))
        return null;
    const list = data.sessions.filter((s) => Number(s.projectId) === projectId).sort(bySeen);
    return list[0] || null;
}
/** 주소를 그 세션 것으로 바꾼다 — 라우터가 다시 돌아 셸을 그린다(프로젝트 주소는 거쳐 가는 문일 뿐이다).
 *  ⚠ replace 로 바꾼다 — push 로 남기면 '뒤로'가 프로젝트 주소로 돌아왔다가 다시 세션으로 튕겨 뒤로가기가 먹지 않는다. */
function goSession(sid, tab) {
    const href = '#/s/' + encodeURIComponent(sid);
    // ⚠ tab.route 를 **미리 바꾸지 않는다** — 라우터는 '탭 라우트와 새 해시가 같으면 다시 그리지 않는다'로 동작하므로,
    //  먼저 바꿔 두면 이 이동이 통째로 삼켜져 화면이 비어 버린다(실측 2026-08-20).
    // ⚠ 이 이동은 **이 탭 안에서 이어지는 이동**이다(프로젝트 주소 → 그 프로젝트의 맨 위 세션). 세션 주소라고 해서
    //  새 탭을 만들면, 프로젝트 탭을 누를 때마다 탭이 하나씩 늘고 활성이 끝으로 튄다(원준 2026-08-20 신고 실측:
    //  '고객사 사용 분석' 탭을 눌렀더니 12번째 탭이 새로 생기고 그리로 옮겨 갔다). 그래서 hop 으로 표시해 둔다.
    if (location.hash !== href)
        inTabHops++;
    location.replace(location.pathname + location.search + href);
}
/** 같은 탭 안에서 이어지는 이동(리다이렉트)의 수 — onHash 의 '새 탭' 규칙만 건너뛴다(다시 그리기는 그대로 한다). */
let inTabHops = 0;
/** 프로젝트 셸(문패 + 칸 + 세션 서랍)을 이 탭에 마운트한다. 세션 화면은 그 안 '세션' 칸에 통째로 들어간다. */
async function mountProjectShell(tab, projectId, sessionId, seq) {
    let detail = null;
    if (projectId > 0) {
        try {
            detail = await api('/api/ui/v6/projects/' + projectId);
        }
        catch (_) {
            detail = null;
        }
    }
    if (seq !== tab.seq)
        return;
    if (detail && !data.projects.some((p) => p.id === projectId))
        void loadData({ projects: true }).then(() => { drawSide(); tabsApi?.paint(); });
    dropProjView(tab);
    if (tab.chat) {
        tab.chat.destroy();
        tab.chat = null;
    }
    projViews.set(tab, mountPanes(tab.center, {
        data: () => data,
        id: projectId,
        detail,
        sessionId,
        onProjectChanged: () => { void loadData({ projects: true }).then(() => { drawSide(); tabsApi?.paint(); }); },
        // 서랍에서 세션을 갈아 끼웠다 — 셸은 살려 두고 **주소·탭 제목만** 그 세션 것으로(라우터를 다시 돌리지 않는다).
        onSessionPicked: (sid) => {
            // 세션을 고르면 그 세션 주소, 새 세션 자리로 돌아가면 **?new=1** 을 붙인 프로젝트 주소.
            //  쿼리를 붙이는 이유: 프로젝트 주소만 두면 새로고침·탭 복원 때 라우터가 '맨 위 세션'으로 보내 버려
            //  열어 둔 새 세션 자리가 사라진다. routeKey 는 '?' 앞만 보므로 탭 동일성에는 영향이 없다.
            const href = sid ? '#/s/' + encodeURIComponent(sid) : '#/p/' + projectId + '?new=1';
            tab.route = href;
            // 셸은 그대로 두고 주소·탭 제목만 바꾼다 — hashchange 를 한 번 삼켜 라우터가 다시 그리지 않게.
            //  ⚠ 값이 같으면 hashchange 가 아예 안 나므로 그때는 세지 않는다(안 그러면 다음 진짜 이동을 삼킨다).
            if (location.hash !== href) {
                suppressHash++;
                location.hash = href;
            }
            tabsApi?.routed(tab);
            drawSide();
        },
        // 새 세션 자리에서 방금 만든 세션 — 그 전문을 **지금** 목록에 끼워 넣는다(#1719 원준 2026-08-20 신고:
        //  "엔터 친 다음에 클로드 미러링이 새로고침 안 하면 안 나온다"). 20초 폴링을 기다리면 그 사이 세션 화면이
        //  붙을 세션을 못 찾아 빈 채로 굳었다. 홈 입력창은 라우트가 created-cache 로 같은 일을 한다 — 여기는 셸이 산 채로
        //  칸만 갈아 끼우는 경로라 라우트를 거치지 않으므로 그 자리를 이 훅이 맡는다.
        onSessionCreated: (row) => {
            if (!row || !row.id)
                return;
            data.sessions = mergeSessions([row], []).concat(data.sessions.filter((x) => x.id !== String(row.id)));
            drawSide();
            tabsApi?.paint();
            void loadData().then(() => { drawSide(); tabsApi?.paint(); }); // 곧바로 진짜 목록으로 대체(이 낙관 행은 임시다)
        },
        // 세션 화면 자체 — 우패널이 없는 셸이라 발자취·파일은 넘기지 않는다(맥락은 곁칸이 쥔다).
        mountSession: (host, sid) => {
            const h = renderSession(host, data, sid, {
                onPickProject: (anchor) => openProjectPicker(anchor, sid, tab),
                onRename: (label) => renameSession(sid, label, tab),
                onArchive: () => void archiveSession(sid),
            });
            tab.chat = h; // 20초 목록 갱신이 이 핸들로 상태를 흘려보낸다
            return h;
        },
    }));
    tab.aside.replaceChildren(); // 우패널 없음 — 맥락은 화면 안(칸)에서 산다
}
// 프로젝트 목록은 워크스페이스 전체(수백 건·설명 포함이라 1MB 를 넘는다) — 세션처럼 20초마다 당기지 않는다.
const PROJ_TTL_MS = 5 * 60 * 1000;
export async function bootV2() {
    root = document.getElementById('v2-root');
    if (!root)
        return;
    root.hidden = false;
    // 실험장(#1719 원준): 작업대 골격(rail-mode)은 그대로 두되 **좌측 사이드바는 늘 보인다**(원준 2026-08-20:
    //  "새로고침하다 보면 사라질 때가 있다 — 항상 표시하고, 없앨 수는 없게. 폭만 끌어 조절"). 그래서
    //  여닫는 길(알약·×·핀)을 전부 걷고 **폭 손잡이 하나**만 남긴다 — 사라지지 않으니 되찾는 길도 필요 없다.
    root.classList.add('rail-mode');
    root.classList.toggle('solo', SOLO);
    root.replaceChildren(...(SOLO ? [] : [
        sideEl = el('nav', { class: 'v2-side stu-side', 'aria-label': '탐색' }),
        makeSplitter({ axis: 'x', key: 'side-w', cssVar: '--v2-side-w', target: root, def: 292, min: 220, max: 560, grow: 1, label: '사이드바 너비' }),
    ]), centerEl = el('div', { class: 'v2-main', id: 'v2-main' }), makeSplitter({ axis: 'x', key: 'aside-w', cssVar: '--v2-aside-w', target: root, def: 316, min: 240, max: 720, grow: -1, label: '우패널 너비' }), asideEl = el('aside', { class: 'v2-aside', 'aria-label': '이 선택의 맥락' }));
    // 모바일 크롬(#1777) — 바는 그리드 맨 앞, 배경막은 맨 뒤. 데스크톱에선 둘 다 display:none 이라 그리드 열 순서에 안 낀다.
    if (!SOLO) {
        mobile = mountMobileChrome(root, sideEl, asideEl);
        root.prepend(mobile.bar);
        root.append(mobile.scrim);
    }
    // 실험장(#1719 원준): 크롬식 탭 줄은 걷는다 — 사이드바(프로젝트·열린 세션)가 이미 그 역할을 한다.
    //  탭 '기계'는 남긴다(화면마다 상태 보존·복귀가 이 구조에 실려 있다) — 줄만 안 그린다.
    const TABS_OFF = false; // 탭 줄은 남긴다(원준 2026-08-19 확정) — 실험장은 걷었지만 그 하나는 되살린다
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
        } dropProjView(tab); drawSide(); },
        // 탭 두 번 눌러 이름 바꾸기(원준 2026-08-20) — 세션 탭만. 판정은 세션 화면의 규칙과 같다:
        //  내 세션이고 살아 있고 복원 대기가 아닐 때(session-chat canRename).
        canRename: (tab) => {
            const k = routeKey(tab.route);
            if (!k.startsWith('s:'))
                return false;
            const s2 = findSess(k.slice(2));
            return !!s2 && s2.owned && s2.live && !s2.raw?.restorable;
        },
        onRename: async (tab, name) => {
            const id = routeKey(tab.route).slice(2);
            try {
                await renameSession(id, name, tab);
                toast('세션 이름을 바꿨어요.');
            }
            catch (e) {
                toast('이름을 바꾸지 못했습니다 — ' + (e && e.message ? e.message : e), true);
            }
        },
    });
    if (!TABS_OFF) {
        centerEl.prepend(tabsApi.strip); // 탭 줄은 가운데 열 맨 위(탭 패널들은 tabs.ts 가 이미 뒤에 붙였다)
        // 모바일이면 탭 줄이 상단 바 가운데로 옮겨 간다(#1777) — 데스크톱으로 돌아오면 여기(가운데 열 맨 위)로 되돌린다.
        mobile?.adoptStrip(tabsApi.strip, () => centerEl.prepend(tabsApi.strip));
    }
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
        const saved = tabsApi.initial();
        // 저장된 활성 탭이 **고정 홈**이면 그 탭을 딥링크로 끌고 가지 않는다 — 홈은 홈으로 두고 새 탭을 연다.
        const t = boot && (!saved || saved.fixed) ? tabsApi.add(boot, { activate: false }) : (saved || tabsApi.add(boot || '#/', { activate: false }));
        if (boot && !t.fixed)
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
            const at = tabsApi.active();
            if (parseRoute(at.route).segs[0] === 'inbox')
                renderInbox(at.center, data); // 확인할 것 — 20초 결로 따라온다
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
            // created_at — 사이드바가 '방금 만든 프로젝트'를 잠깐 맨 위에 세울 때 쓴다(side.ts freshMs).
            //  ⚠ 이 map 은 화이트리스트다. 서버가 주더라도 여기 없으면 화면엔 없는 값이다(#1819 실측: 정렬이 안 먹었다).
            created_at: p.created_at ?? null,
            created_by: p.created_by != null ? String(p.created_by) : null, member_ids: Array.isArray(p.members) ? p.members.map((m) => String(m && m.member_id != null ? m.member_id : m)) : [] }));
        projLoadedAt = Date.now();
    }
    const sessions = mergeSessions(live, logs);
    applyRenamePins(sessions); // 방금 고친 이름을 **떠 있던 응답이 되덮지 않게**(아래 renamePins)
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
    // 실험장: **어느 화면에도 상시 타임라인 열은 없다**(원준 2026-08-19 "메인 홈에도 리브에도 떠 있는데 둘 다 없애줘").
    //  돌아보기는 불러오는 것 — 프로젝트 화면은 문패 [타임라인](알림 센터)이 그 자리를 맡는다.
    if (!p || p === 'dashboard')
        return { title: '홈', noAside: true };
    if (p === 'inbox')
        return { title: '확인할 것', noAside: true };
    if (p === 'connect')
        return { title: segs[1] ? '앱 연결' : '외부 앱 연결', noAside: true };
    if (p === 'liv')
        return { title: '리브', noAside: true };
    // 실험장 v4(2026-08-19 바탕화면): 프로젝트 화면은 우패널 없이 — 판이 폭 전체를 쓴다. 타임라인은 문패 [타임라인](알림 센터),
    //  위젯·앱은 도크 ⊞(런치패드)로 옮겨 갔다(web/v2/studio.ts 머리 주석).
    //  #/p/0 = 프로젝트 없는 세션들의 작업대(사이드바의 그 폴더) — 프로젝트가 아니라 '자투리 묶음'이다.
    // 프로젝트 주소로 남아 있는 탭 = **새 세션 자리**다(세션이 하나라도 있으면 라우터가 맨 위 세션으로 보낸다 —
    //  이 주소가 그대로 살아 있는 경우는 '＋ 세션'을 눌러 새 세션을 여는 중일 때뿐이다). 그래서 탭에는
    //  폴더+프로젝트명이 아니라 **새 세션**이라고 쓴다(원준 2026-08-20) — 프로젝트 이름은 바로 아래 문패가 말하고 있고,
    //  탭이 프로젝트명을 달고 있으면 '무엇을 하는 탭인지'가 아니라 '어디 있는지'만 되풀이된다.
    //  이름은 첫 지시를 넣는 순간 그 세션의 이름으로 바뀐다(서버가 지어 붙인다 — src/terminal/session-name-ai.ts).
    if (p === 'p')
        return { title: '새 세션', noAside: true, kind: 'new' };
    if (p === 's') {
        // 탭 제목도 사이드바와 **같은 규칙**(side.ts sessText)을 쓴다(#1744) — 종전엔 s.label 을 날것으로 써서
        //  탭에 `box-yoon-…`·`위탁 #41`·프로젝트명 반복이 그대로 떴다(dev 실측: 자동 생성 이름이 죽은 세션의 83%).
        //  sessText 는 그런 이름을 걷어내고 pane 제목('지금 하는 일')을 그 자리에 올린다.
        //  ★ 우패널 없음 — 세션 화면은 프로젝트 셸(v2/panes.ts) 안에서 열리고, 맥락(자료·지식·타임라인)은 그 셸의
        //   곁칸이 쥔다(2026-08-20 통합). 팝아웃 창(?solo=1)만 종전대로 세션 하나 + 발자취 우패널이다.
        const s = findSess(decodeURIComponent(segs[1] || ''));
        // 못 찾은 세션(죽었거나 아직 목록에 안 온 것)도 **서로 구분되게** — 전부 '세션'이면 다른 탭이 같아 보인다.
        if (!s) {
            const raw = decodeURIComponent(segs[1] || '');
            const tail = raw.split('-').pop() || raw;
            return { title: '세션 ' + tail.slice(0, 6), noAside: !SOLO };
        }
        const t = sessText(s, projName(data, s.projectId));
        // 아이콘 색이 될 상태 — 사이드바 점과 같은 판정(dotCls): 도는 중·확인 필요·끝남만 색을 갖는다.
        return { title: t.main || t.sub || String(s.raw?.harness || '세션'), noAside: !SOLO, state: dotCls(s.stateKey) };
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
function applyTabChrome(tab) {
    root.classList.toggle('no-aside', tab.noAside);
    if (mobile)
        mobile.setAside(!tab.noAside); // 모바일 상단 바의 [타임라인] — 우패널이 없는 화면(앱 프레임)에선 버튼도 없다
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
    let hash = location.hash || '#/';
    // ★ 프로젝트 주소는 '거쳐 가는 문'이다(원준 2026-08-20 "그거 눌렀을 때 열리는 탭도 그냥 세션이 열리는걸로").
    //  사이드바에서 프로젝트 제목을 누르면 #/p/<id> 로 오는데, 그대로 탭을 만들면 **프로젝트 탭**이 하나 생겼다가
    //  그 안에서 다시 세션으로 바뀐다(제목이 두 번 바뀌고, 이미 프로젝트 탭이 있으면 그 낡은 탭이 켜졌다).
    //  그래서 탭을 고르기 **전에** 여기서 그 프로젝트의 맨 위 세션(사이드바 첫 줄과 같은 정의)으로 갈아 끼운다.
    // ★ 같은 세션이 **두 철자**로 열려 탭이 둘이 되던 것(원준 2026-08-20 신고) — 세션은 박스 id(box-…)와
    //  중앙 기록 id(uuid) 두 이름을 갖는다(findSess 가 둘 다 받는다). 타임라인·기록에서 열면 uuid, 사이드바에서
    //  열면 박스 id 라 routeKey 가 갈려 '한 세션 = 한 탭'이 깨졌다. 탭을 고르기 전에 **박스 id 로 통일**한다.
    const canon = canonSessionHash(hash);
    if (canon !== hash) {
        hash = canon;
        suppressHash++;
        location.replace(location.pathname + location.search + hash);
    }
    const pk0 = routeKey(hash);
    // ⚠ ?new=1 은 **새 세션 자리를 달라**는 뜻이라 이 갈아끼우기를 건너뛴다(사이드바 프로젝트 줄의 [＋]·문패 [＋ 세션]).
    //  routeKey 는 쿼리를 버리므로 여기서 원래 주소의 쿼리를 따로 본다 — 안 그러면 [＋]를 눌러도 맨 위 세션이 열린다(실측 2026-08-20).
    if (pk0.startsWith('p:') && parseRoute(hash).params.get('new') !== '1') {
        const top = topSessionOf(Number(pk0.slice(2)));
        if (top) {
            hash = '#/s/' + encodeURIComponent(top.id);
            suppressHash++; // 이 replace 가 만든 hashchange 는 라우터가 무시한다
            location.replace(location.pathname + location.search + hash);
        }
    }
    const cur = tabsApi.active();
    if (routeKey(cur.route) === routeKey(hash)) {
        cur.route = hash;
        tabsApi.routed(cur);
        return;
    }
    // 이 탭 안에서 이어지는 이동인가(프로젝트 → 그 프로젝트의 세션) — 새 탭 규칙만 건너뛴다.
    const hop = inTabHops > 0;
    if (hop)
        inTabHops--;
    const other = tabsApi.find(hash);
    if (other && other !== cur) {
        tabsApi.activate(other);
        return;
    } // 같은 화면(같은 세션·프로젝트)은 그 탭으로 — 두 번 그리지 않는다
    // 새 탭에서 여는 세 경우(원준 2026-08-20):
    //  ① **세션으로 간다** — 여러 세션이 탭으로 나란히 살아야 한다. 지금 탭을 덮어쓰면 보던 세션이 사라진다.
    //  ② **홈에서 출발** — 홈 탭은 늘 홈이다(고정). 홈이 다른 화면으로 변신하면 '못 닫는 홈'이 무의미해진다.
    //  ③ **세션에서 출발** — 세션 탭도 세션으로 남는다. 안 그러면 사이드바에서 프로젝트 한 번 눌렀다고
    //     열어 둔 대화가 통째로 사라진다(실측: dev 에서 '안뇽' 세션 탭이 프로젝트로 바뀌어 없어졌다).
    //  나머지(프로젝트 → 프로젝트·앱 등)는 종전대로 그 탭 안에서 이동한다 — 클릭마다 탭이 불어나면 그것도 못 쓴다.
    if (!hop && (routeKey(hash).startsWith('s:') || cur.fixed || routeKey(cur.route).startsWith('s:'))) {
        tabsApi.add(hash);
        return;
    }
    if (cur.chat) {
        cur.chat.destroy();
        cur.chat = null;
    } // 세션 화면을 떠나면 그 폴링·리스너를 끈다
    dropProjView(cur); // 프로젝트 화면(#1757)의 리브 턴 폴링도
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
    const { segs, raw, params } = parseRoute(tab.route);
    const page = segs[0] || '';
    markActive(page === 'p' ? 'p:' + segs[1] : page === 's' ? 's:' + decodeURIComponent(segs[1] || '') : page === 'liv' ? 'liv' : page === 'inbox' ? 'inbox' : page === 'connect' ? 'connect' : page === '' || page === 'dashboard' ? 'home' : '');
    try {
        if (page === '' || page === 'dashboard') {
            renderHome(tab.center, data);
            tab.aside.replaceChildren();
        }
        else if (page === 'inbox') {
            markActive('inbox');
            renderInbox(tab.center, data);
            tab.aside.replaceChildren();
        }
        else if (page === 'connect') {
            markActive('connect');
            tab.aside.replaceChildren();
            // 목록과 앱 상세는 같은 라우트의 두 깊이 — seq 로 늦은 응답을 버린다(빠르게 오가면 옛 화면이 덮는다).
            if (segs[1])
                await renderConnectApp(tab.center, decodeURIComponent(segs[1]));
            else
                await renderConnect(tab.center);
            if (seq !== tab.seq)
                return;
        }
        else if (page === 'liv') {
            tab.center.replaceChildren();
            const host = el('div', { class: 'v2-livpage' });
            tab.center.append(host);
            tab.aside.replaceChildren();
            await renderLiv(host, { rail: null, embedded: true }); // rail 없음 = 카드·편지는 본문에(종전 drawAsideLiv 도 null 을 돌려줬다)
        }
        else if (page === 'p' && segs[1]) {
            // ★ 프로젝트 전용 화면은 없앴다(원준 2026-08-20) — 프로젝트는 세션이 놓인 방이고, 주소는 늘 세션이다.
            //  그 프로젝트의 **맨 위 세션**(사이드바와 같은 정렬)으로 보낸다. 세션이 하나도 없으면 그때만 이 주소가
            //  '새 세션 자리'로 열린다(갈 세션이 없으니 폴백이 필요하다).
            const id = Number(segs[1]);
            // ?new=1 = **새 세션 자리를 달라**는 뜻(사이드바 [＋]·문패 [＋ 세션]). 그때는 맨 위 세션으로 보내지 않는다.
            const first = params.get('new') === '1' ? null : topSessionOf(id);
            if (first) {
                goSession(first.id, tab);
                return;
            }
            await mountProjectShell(tab, id, null, seq);
        }
        else if (page === 's' && segs[1]) {
            const id = decodeURIComponent(segs[1]);
            let s = findSess(id);
            // 방금 만든 세션이면 생성 응답 전문으로 먼저 그린다(created-cache — 노드 세션은 목록 반영이 한 박자 늦다).
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
            // 팝아웃 창(?solo=1)은 **세션 하나만 담은 창**이다 — 프로젝트 셸을 두르지 않는다(그게 이 창의 정의).
            if (SOLO) {
                const trail = drawAsideSession(tab, s || null);
                tab.chat = renderSession(tab.center, data, id, {
                    trail,
                    onPickProject: (anchor) => openProjectPicker(anchor, id, tab),
                    onRename: (label) => renameSession(s ? s.id : id, label, tab),
                    onToggleFiles: () => toggleAsideFiles(tab, id),
                    solo: true,
                });
                return;
            }
            await mountProjectShell(tab, s && s.projectId ? Number(s.projectId) : 0, id, seq);
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
            tab.aside.replaceChildren();
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
    return cur.segs[0] === 'p' ? 'p:' + cur.segs[1] : cur.segs[0] === 's' ? 's:' + decodeURIComponent(cur.segs[1] || '') : cur.segs[0] === 'liv' ? 'liv' : cur.segs[0] === 'inbox' ? 'inbox' : cur.segs[0] === 'connect' ? 'connect' : (!cur.segs[0] || cur.segs[0] === 'dashboard') ? 'home' : cur.segs[0] === 'app' ? 'app:' + cur.segs[1] : 'app:' + (CLASSIC_PAGES[cur.segs[0]] || '');
}
// ── 좌측 사이드바는 **늘 있다**(원준 2026-08-20) ──────────────────────────────────
//  이력: 3차(2026-08-19)에 좌측 열을 걷고 떠다니는 알약으로 여닫게 했는데, 그 알약이 ⓐ 자리를 가리고
//  ⓑ 새로고침·상태에 따라 목록이 사라져 "왜 없어졌나"를 매번 되찾아야 했다(원준 신고). 목록은 셸의 뼈대다 —
//  숨길 수 있는 것으로 두면 숨겨진 상태가 기본이 된다. 그래서 **없앨 수 없고, 폭만 조절**한다.
//  · 닫기(×)·핀 고정·알약(stu-panel-fab)·그 자리 기억(stu_fab_pos)은 전부 제거했다.
//  · 패널 머리글도 뺐다 — 트리 자신이 이미 '프로젝트 · N'과 검색·필터를 머리에 두고 있어 두 겹이었다.
function drawSide() {
    if (!sideEl)
        return;
    const treeHost = el('div', { class: 'stu-panel-tree' });
    sideEl.replaceChildren(el('div', { class: 'stu-panel' }, treeHost));
    drawSideTree(treeHost, data, activeKey, {
        onNewSession: newSessionFor,
        // 사이드바에서 고친 이름은 **화면 전체**에 반영한다 — 목록만 바뀌고 탭·대화창 제목이 옛 이름이면 그게 더 혼란스럽다.
        onRenameSession: (id, label) => renameSessionEverywhere(id, label),
        // 보관(×) 뒤 — 그 세션은 이제 '지난 세션'이라 목록의 자리가 바뀐다. 서버가 정답이므로 다시 읽는다.
        onArchived: () => { void loadData().then(() => { drawSide(); tabsApi?.paint(); }); },
    });
}
/** 이 탭이 보고 있는 프로젝트 — 프로젝트 주소면 그 id, 세션 주소면 그 세션이 붙은 프로젝트. 아니면 -1. */
function tabProject(t) {
    const k = routeKey(t.route);
    if (k.startsWith('p:'))
        return Number(k.slice(2)) || 0;
    if (k.startsWith('s:')) {
        const s = findSess(k.slice(2));
        return s && s.projectId ? Number(s.projectId) : -1;
    }
    return -1;
}
/** 사이드바 프로젝트 줄의 [＋] — 그 프로젝트를 '새 세션 자리'로 연다(#1719 원준 2026-08-20).
 *  그 프로젝트를 이미 보고 있는 탭이 있으면 **그 탭 안에서** 자리만 바꾼다(탭을 늘리지 않는다 — 프로젝트 하나 = 탭 하나).
 *  없으면 ?new=1 주소로 새 탭을 연다(그 쿼리가 '맨 위 세션으로 보내기'를 건너뛰게 한다). */
function newSessionFor(projectId) {
    if (!(projectId > 0))
        return;
    const href = '#/p/' + projectId + '?new=1';
    const hit = tabsApi?.tabs.find((t) => tabProject(t) === projectId);
    if (!tabsApi || !hit) {
        location.hash = href;
        return;
    } // 그 프로젝트를 보는 탭이 없다 — 새 탭에서 연다
    const pv = projViews.get(hit);
    // 셸이 이미 살아 있으면 **그 셸 안에서** 자리만 바꾼다(대화·터미널·배치가 그대로 산다).
    if (pv?.newSession) {
        tabsApi.activate(hit);
        pv.newSession();
        return;
    }
    // ⚠ 아직 안 그려진(또는 그리는 중인) 탭이면 셸 핸들이 없다 — 여기서 activate 만 하면 그 탭이 **옛 주소로**
    //  그려져(세션 화면) 방금 연 새 세션 자리를 덮는다(실측 2026-08-20). 그래서 주소를 먼저 새 세션 자리로 바꾼다.
    hit.route = href;
    if (tabsApi.current() === hit) { // 이미 활성 탭이면 activate 는 아무 일도 하지 않으므로 직접 그린다
        suppressHash++;
        location.hash = href;
        void renderRoute(hit);
        tabsApi.paint();
    }
    else
        tabsApi.activate(hit);
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
/** 세션 보관(#1719) — 터미널만 내리고 좌표·대화는 DB 에 남긴다(DELETE ?reclaim=1 = restorable).
 *  세션 탭 줄을 없애면서 입구가 [⋯ ▸ 이 세션 보관] 하나로 모였다. 확인창 정의는 session-actions.ts(#1582 규약). */
async function archiveSession(sessionId) {
    const s = findSess(sessionId);
    const name = s ? (sessText(s, projName(data, s.projectId)).main || sessionId) : sessionId;
    const working = !!s && (s.stateKey === 'busy' || s.stateKey === 'waiting');
    if (!await confirmSessionArchive({ title: `「${name}」 세션을 보관할까요?`, working }))
        return;
    try {
        await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId) + '?reclaim=1' + (s && s.node ? '&node=' + encodeURIComponent(s.node) : ''), { method: 'DELETE' });
        toast('세션을 보관했어요 — [보관한 세션]에서 되살릴 수 있어요.');
        await loadData();
        drawSide();
        tabsApi?.paint();
    }
    catch (e) {
        toast('보관하지 못했어요 — ' + (e && e.message ? e.message : e), true);
    }
}
// ── 방금 고친 이름 고정(#1719 원준) ────────────────────────────────────────────
//  이름을 바꾸는 순간에도 20초 폴링이 **이미 떠 있을 수 있다.** 그 응답에는 옛 이름이 담겨 있어서, 늦게
//  도착하면 방금 고친 이름을 도로 옛것으로 되돌린다(실측: 4초 뒤 옛 이름, 13초 뒤 새 이름으로 복귀).
//  자가 치유되긴 하지만 "내가 바꿨는데 안 바뀌네" 로 읽히는 몇 초다 — 그래서 짧게 고정해 둔다.
//  서버가 정답이라는 원칙은 지킨다: 고정은 **내가 방금 쓴 값**에 대해서만, 30초만.
const renamePins = new Map();
function pinRename(id, label) { renamePins.set(id, { label, until: Date.now() + 30_000 }); }
function applyRenamePins(sessions) {
    if (!renamePins.size)
        return;
    const now = Date.now();
    for (const [id, p] of [...renamePins]) {
        if (p.until < now) {
            renamePins.delete(id);
            continue;
        }
        const s = sessions.find((x) => x.id === id);
        if (!s)
            continue;
        if (s.label === p.label) {
            renamePins.delete(id);
            continue;
        } // 서버가 따라잡았다 — 고정 해제
        s.label = p.label;
        if (s.raw)
            s.raw.label = p.label;
    }
}
/** 사이드바 인라인 편집(#1719 원준) — 탭이 어디에 있든 이름을 전체에 반영한다.
 *  그 세션을 연 탭이 있으면 그 탭의 대화창·우패널·탭 제목까지, 없으면 목록만. 서버 반영은 renameSession 과 같은 경로. */
async function renameSessionEverywhere(sessionId, label) {
    const tab = tabsApi?.tabs.find((t) => routeKey(t.route) === 's:' + sessionId) || tabsApi?.active();
    if (!tab)
        return;
    await renameSession(sessionId, label, tab);
}
async function renameSession(sessionId, label, tab) {
    const s = findSess(sessionId); // 기록(uuid) 링크로 열린 세션도 같은 박스를 가리키게
    const body = { label };
    if (s && s.node)
        body.node = s.node; // 노드 세션은 게이트웨이가 그 노드로 중계한다(라우트가 body.node 를 본다)
    await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId), { method: 'POST', body: JSON.stringify(body) });
    pinRename(sessionId, label); // 떠 있던 폴링 응답이 옛 이름으로 되덮지 않게(위 renamePins)
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
