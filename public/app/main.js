// main.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { $view, TOKEN_KEY, api, el, errorNote, hideGate, loadPeopleAvatars, profileAvatar, showGate, state } from './core.js';
import { renderDomainmap } from './domainmap.js';
import { renderWiki, renderWikiTrash } from './wiki.js'; // #764 WIKI 탭 전면 재구축(사이드바 유지)
import { refreshWiki2NavBadge, renderWiki2 } from './wiki2.js'; // #968 WIKI2 — 검증·기록(변화의 관제실)
import { consumeWikiPeekGuard, dismissWikiPeek, renderWikiDocPage } from './wiki-doc.js';
import { wkRouteCleanup } from './wiki-data.js'; // #764 — 라우트 이탈 시 위키 에디터/팝오버 청소
import { pjvCloseProjectModalOnRoute, renderProjectV2Detail, renderProjectsV2 } from './projects.js';
import { pjvCloseTaskModalOnRoute, pjvRenderTaskRoute } from './taskmodal.js'; // #804 라우트 이탈 시 모달 정리 · #810 태스크 딥링크
import { renderLearn, renderLearnDocs, renderLearnTour, renderOnboarding } from './learn.js';
import { renderStart, renderStartMigrate, renderStartProject } from './start.js'; // #/start — 구성원 온보딩(#846/850) + 프로젝트 체험(#853)
import { renderActivate } from './activate.js'; // #/activate — CLI 디바이스 로그인 승인(#880)
import { renderSessions } from './sessions.js'; // #/sessions — 세션이력 웹뷰(#905 C1 이어보기)
import { resumeGuideTour } from './guide-tour.js'; // Lively 둘러보기(#761) — 라우팅 후 장면 재개
import { renderMyDashboard, startDashboardSessionTour } from './dashboard-home.js';
import { renderTerminal, startTerminalTour, teardownTerminal } from './terminal.js';
import { changePasswordModal, openMyProfileModal, renderSystem } from './admin.js';
import { endTour } from './tour.js';
import { installGlobalUndo } from './undo.js';
// ── 라우터 ──
function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const qIdx = h.indexOf('?');
    const pathPart = qIdx >= 0 ? h.slice(0, qIdx) : h;
    const params = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : '');
    return { segs: pathPart.split('/').filter(Boolean), params };
}
function setActiveTab(name) {
    for (const a of document.querySelectorAll('.tabs a, .help-link')) {
        const on = a.dataset.tab === name;
        a.classList.toggle('active', on);
        if (on)
            a.setAttribute('aria-current', 'page');
        else
            a.removeAttribute('aria-current');
    }
}
// #971 WIKI2 는 아직 미완성 탭 — 내부 개발·데모 도메인(lvly.io 계열)에서만 노출하고, 파일럿 고객 박스
//  (예: lively.honestai.tech)에는 숨긴다. 화이트리스트라 새 고객 도메인은 자동으로 차단된다(안전 기본값).
//  boot() 의 탭 노출 · route() 의 직접 접근 가드 · 배지 refresh 세 곳이 이 단일 판정을 공유한다.
function wiki2Visible() {
    const h = location.hostname.toLowerCase();
    return h === 'lvly.io' || h.endsWith('.lvly.io') || h === 'localhost' || h === '127.0.0.1';
}
async function route() {
    teardownTerminal(); // 터미널 뷰를 떠나면 ws/xterm 정리(메모리·소켓 누수 방지)
    // #592 피크 패널 — 뒤/앞으로가기가 peek 파라미터만 바꾼 이동이면 패널이 스스로 개폐를 끝냈다(가드) —
    //  본문 전체 재렌더를 생략해 목록 스크롤·상태를 보존. 그 외 라우팅은 남은 피크를 정리(전체화면 이동·탭 전환 등).
    //  (#761) 투어 정리는 이 가드 '뒤'에서 — 피크 개폐만으로는 진행 중 둘러보기를 죽이지 않는다(본문도 그대로니까).
    if (consumeWikiPeekGuard())
        return;
    endTour(); // 진행 중이던 온보딩 투어(#517/#761) 오버레이 정리 — 둘러보기는 라우팅 끝에 resumeGuideTour 로 재개
    dismissWikiPeek();
    wkRouteCleanup(); // 분리된 위키 블록 에디터 destroy + 잔존 body 팝오버 제거(#764)
    // #804 열려 있던 상세 모달(프로젝트·태스크) 정리 — 모달은 document.body 에 얹혀 라우터가 존재를 모른다.
    //  안 닫으면 새 페이지가 모달 뒤에 렌더되고 모달이 계속 덮어 '클릭해도 아무 일 없는' 죽은 클릭이 된다(뒤로가기도 동일).
    //  중첩(프로젝트 모달 위 태스크 모달)이라 위(태스크)부터. 편집 중 본문은 닫히며 flush(저장)된다.
    //  (지식·가이드 같은 '참조' 링크는 애초에 새 탭으로 열려 여기까지 오지 않는다 — 그게 목적이므로.)
    // #808·#810 모달은 '자기 주소'를 소유한다 → 새 주소가 그 모달의 주소면 **살려두고, 뒤 화면도 다시 그리지 않는다**:
    //  중첩 태스크 모달을 닫아 프로젝트 모달의 주소로 돌아온 경우가 그것이다(모달 뒤 보드는 열었을 때 그대로여야 한다).
    //  살아남은 모달이 곧 이 주소의 '페이지'이므로 라우터는 여기서 손을 뗀다.
    const keptTask = pjvCloseTaskModalOnRoute();
    const keptProject = pjvCloseProjectModalOnRoute();
    if (keptTask || keptProject)
        return;
    if (!state.me) {
        showGate();
        return;
    } // 인증 상태는 boot()/로그인이 state.me 로 표시(세션 쿠키 또는 토큰)
    const { segs, params } = parseHash();
    const view = $view();
    const page = segs[0] || 'dashboard'; // 홈(빈 해시·로고) = 대시보드(#617 — 옛 기본값 install 에서 개편)
    document.body.dataset.route = page; // 라우트별 레이아웃 훅(#541 — 프로젝트 보드 풀스크린 등). projects2 는 아래서 세분화.
    // #592 doc-mode — 지식 계열 라우트(목록·문서·편집·휴지통)는 main 을 전폭 캔버스로(패딩 0).
    //  셸(.kn-shell)/래퍼(.kn-plain)가 자체 패딩·사이드바 폭을 가진다. 그 외 탭은 기존 중앙 정렬 유지.
    const mainEl = document.querySelector('main');
    if (mainEl)
        mainEl.classList.toggle('doc-mode', page === 'knowledge' || page === 'k' || page === 'k-edit' || page === 'trash' || page === 'wiki2'); // #968 WIKI2 도 .kn-shell 전폭
    if (wiki2Visible())
        void refreshWiki2NavBadge(); // #968 상단 WIKI2 배지(검토 대기 총계) — 내부 60s 스로틀, 실패는 조용히 · #971 미노출 도메인에선 호출 생략
    try {
        if (page === 'dashboard') {
            setActiveTab('dashboard'); // 대시보드 — 옛 '시작하기' 탭 자리를 개편(#617). 현재는 자리표시.
            await renderMyDashboard(view);
            // 사용 가이드 [내 AI 세션 생성]의 '따라하며 만들기 →'(#/dashboard?tour=1) — 홈에서 세션 만들기 투어를 켠다(#780).
            //  쿼리는 새로고침 재실행 방지를 위해 조용히 제거(해시만 갱신 — hashchange/재라우팅 없음).
            if (params.get('tour') === '1') {
                const fromOnboarding = params.get('from') === 'onboarding'; // #/start '웹에서 만들기' → 완주 후 #/start 복귀
                history.replaceState(null, '', '#/dashboard');
                startDashboardSessionTour(fromOnboarding ? '#/start' : undefined);
            }
        }
        else if (page === 'learn') {
            setActiveTab('learn'); // '사용 가이드' — 우측 상단 보조 링크(.help-link). '직접 해보기'(시작하기 등)는 #/start/* 로 이동(#1000).
            // #1000 직접 해보기 URI 를 #/start/* 로 통일 — 옛 #/learn 경로는 리다이렉트로 보존(북마크·외부 링크 방어).
            if (segs[1] === 'install') {
                location.replace('#/start');
                return;
            } // 설치 = #/start ② 설정(모달)
            else if (segs[1] === 'tour') {
                location.replace('#/start/tour');
                return;
            } // #/learn/tour → #/start/tour
            else if (segs[1] === 'menu') {
                location.replace('#/learn');
                return;
            } // #/learn/menu 폐기 — 개요로 리다이렉트
            else if (segs[1] === 'docs') {
                const slug = decodeURIComponent(segs[2] || '').split('?')[0];
                if (slug === 'examples') {
                    location.replace('#/start/examples');
                    return;
                } // '이런 걸 시켜보세요' → #/start/examples
                await renderLearnDocs(view, slug); // #/learn/docs/<slug> — 읽는 문서(화면별 안내·레퍼런스)
            }
            else
                await renderLearn(view);
        }
        else if (page === 'start') {
            // #/start — 구성원 온보딩 '시작하기'. **온보딩의 유일한 진입·완주 표면.** 상태 SoT 는 서버
            //  computeMemberOnboarding 이고 이 화면과 AI 스킬이 같은 REST 를 읽는다(드리프트 0).
            //  #1000 URI 통일: 직접 해보기 그룹(examples·tour)이 #/start/* 로 모인다. 설치는 전체페이지 대신
            //  모달(openInstallModal)로 — #/start/setup 전체페이지는 폐지하고 #/start 로 리다이렉트(딥링크 방어).
            setActiveTab('learn');
            if (segs[1] === 'setup') {
                location.replace('#/start');
                return;
            } // 설치 = 모달. 전체페이지 폐지(#1000)
            else if (segs[1] === 'migrate')
                await renderStartMigrate(view);
            else if (segs[1] === 'project')
                await renderStartProject(view); // #853 — 프로젝트 체험(손수 투어 랜딩)
            else if (segs[1] === 'examples')
                await renderLearnDocs(view, 'examples'); // #1000 — '이런 걸 시켜보세요'(원고는 docs-content)
            else if (segs[1] === 'tour')
                await renderLearnTour(view); // #1000 — Lively 둘러보기(#/learn/tour 에서 이동)
            else if (segs[1] === 'harness') {
                location.replace('#/system/me-assets');
                return;
            } // #893 — 하네스 관리는 관리탭이 정주소(기존 딥링크 보존)
            else
                await renderStart(view);
        }
        else if (page === 'activate') {
            // #/activate?code=XXXX — CLI 디바이스 로그인 승인(#880). 게이트(로그인) 뒤에 렌더되며, 딥링크의 ?code= 는
            //  로그인 후에도 살아남는다(route 가 state.me 없으면 showGate 후 return — 해시는 보존, boot 이 재실행).
            setActiveTab('');
            await renderActivate(view);
        }
        else if (page === 'sessions') {
            // #/sessions — 세션이력 웹뷰(#905 C1 이어보기). 내 세션 목록 + 트랜스크립트 회수(렌더).
            setActiveTab('sessions');
            await renderSessions(view);
        }
        else if (page === 'install') {
            // 옛 상단 탭(#/install) — 사용 가이드 › 시작하기로 이동(#617). 기존 딥링크·북마크 보존(projects v1→v2 와 동일 패턴).
            location.replace('#/learn/install');
            return;
        }
        else if (page === 'domainmap') {
            setActiveTab('domainmap'); // 도메인 맵 — 독립 탭(index.html data-tab="domainmap")
            await renderDomainmap(view, params);
        }
        else if (page === 'wiki2') {
            if (!wiki2Visible()) {
                location.replace('#/dashboard');
                return;
            } // #971 미완성 탭 — 미노출 도메인(고객 박스)에선 직접 URL 접근도 차단
            setActiveTab('wiki2'); // #968 WIKI2 — 변화의 관제실: 검증(#/wiki2) · 기록(#/wiki2/history)
            await renderWiki2(view, segs[1] || '', params);
        }
        else if (page === 'knowledge') {
            setActiveTab('knowledge'); // WIKI(맥락의 기록) — #764 재구축: 홈/카테고리 페이지/필터 목록/드래프트/자료
            await renderWiki(view, segs[1] || '', params);
        }
        else if (page === 'trash') {
            setActiveTab('knowledge'); // 휴지통(삭제됨)은 지식 탭 계열의 하위 회수 뷰 — 상위 탭 활성 유지
            await renderWikiTrash(view);
        }
        else if (page === 'k') {
            setActiveTab('knowledge'); // 지식 상세는 지식 탭의 하위 뷰 — 상위 탭 활성 유지
            await renderWikiDocPage(view, decodeURIComponent(segs.slice(1).join('/')));
        }
        else if (page === 'k-edit') {
            // #764 — 별도 편집 페이지 폐지(문서 페이지가 곧 에디터). 구 링크·북마크는 문서로 리다이렉트(MD 원문은 ⋯ 메뉴).
            location.replace('#/k/' + segs.slice(1).join('/'));
            return;
        }
        else if (page === 'projects') {
            // v1 프로젝트 탭 폐기(2026-06-23) — projects2 로 통합. 옛 링크/북마크는 리다이렉트.
            location.replace('#/projects2');
            return;
        }
        else if (page === 'projects2') {
            setActiveTab('projects2'); // 프로젝트(v2) — 맥락의 변화. 하위 탭(대시보드·탐색) 폐지: 상세(p·t) 외엔 보드 하나.
            // 상세(p=프로젝트, t=태스크)만 읽기 페이지 폭, 그 외(보드·스코프 딥링크 /l·/f·/none, 옛 worklog·browse URL)는 전부 풀스크린 보드.
            //  스코프 딥링크(#541): /l/<id>·/f/<id>·/none 은 보드의 리스트/폴더/미분류 선택 — 새로고침·뒤로가기 복원.
            //  태스크 딥링크(#810): /t/<id> — 태스크·서브태스크 공통(부모를 경로에 안 넣는 평면 id). 전용 페이지가 없으므로
            //  소속 프로젝트 페이지 위에 태스크 모달로 뜬다(pjvRenderTaskRoute).
            const sub2 = segs[1] || 'dashboard';
            document.body.dataset.route = (sub2 === 'p' || sub2 === 't') ? 'projects2-detail' : 'projects2-board';
            if (segs[1] === 'p' && segs[2])
                await renderProjectV2Detail(view, segs[2]);
            else if (segs[1] === 't' && segs[2])
                await pjvRenderTaskRoute(view, segs[2]);
            else {
                let scopeKey = null;
                if (sub2 === 'l' && segs[2])
                    scopeKey = 'L' + segs[2];
                else if (sub2 === 'f' && segs[2])
                    scopeKey = 'F' + segs[2];
                else if (sub2 === 'none')
                    scopeKey = '__none__';
                await renderProjectsV2(view, 'dashboard', params, scopeKey);
            }
        }
        else if (page === 'system') {
            setActiveTab('system');
            await renderSystem(view, segs[1] || null);
        }
        else if (page === 'terminal') {
            setActiveTab('terminal');
            await renderTerminal(view);
            // 시작하기(#/install)의 '따라하기 시작 →'(#/terminal?tour=1) 로 들어오면 스포트라이트 온보딩을 켠다.
            //  쿼리는 새로고침 재실행 방지를 위해 조용히 제거(해시만 갱신 — hashchange/재라우팅 없음).
            if (params.get('tour') === '1') {
                history.replaceState(null, '', '#/terminal');
                startTerminalTour();
            }
        }
        else if (page === 'onboarding') {
            setActiveTab('learn'); // 온보딩 진행상황 — 설치(시작하기) 계열이 사용 가이드로 이동(#617)했으므로 그 탭 활성
            await renderOnboarding(view);
        }
        else {
            setActiveTab('dashboard'); // 알 수 없는 경로 → 홈(대시보드)
            await renderMyDashboard(view);
        }
        resumeGuideTour(); // (#761) Lively 둘러보기 — 렌더 끝난 화면이 진행 중 플랜의 장면이면 스포트라이트 재개(플랜 없으면 no-op)
    }
    catch (e) {
        if (e && e.status === 401)
            return;
        view.replaceChildren(errorNote(e, '페이지를 불러오지 못했습니다'));
    }
}
window.addEventListener('hashchange', route);
// ── 부팅 ──
async function boot() {
    // 세션 쿠키 또는 bearer 토큰 중 하나로 인증(/api/ui/me). 둘 다 없으면 401 → 게이트.
    try {
        state.me = await api('/api/ui/me');
    }
    catch (e) {
        if (e.status === 401)
            return; // api() 가 게이트 표시
        showGate('서버에 연결하지 못했습니다 — ' + e.message);
        return;
    }
    if (!state.me || !state.me.userId) {
        showGate();
        return;
    }
    hideGate();
    // 우측 상단 = '내 프로필' 버튼(아바타 + 표시이름). 표시이름 우선(없으면 이메일/아이디). 클릭→'내 정보' 팝업(#762).
    const userBtn = document.getElementById('user-email');
    if (userBtn) {
        const nm = state.me.display_name || state.me.email || state.me.userId || '';
        userBtn.replaceChildren(profileAvatar(state.me.avatar, nm, state.me.userId, 'topbar-ava', { char: state.me.avatar_char, color: state.me.avatar_color }), el('span', { text: nm }));
        userBtn.hidden = false;
    }
    loadPeopleAvatars(); // 사람 아바타 맵 선로드(칩·얼굴·작성자 아바타가 커스텀 글자·색·이미지로 뜨게 — #473 후속)
    // '관리' 탭은 모든 인증 사용자에게 — admin 은 편집, 그 외는 읽기 전용(서버가 쓰기를 강제 차단).
    const sysTab = document.getElementById('system-tab');
    if (sysTab)
        sysTab.hidden = false;
    // #971 WIKI2 는 아직 미완성 탭 — 내부 개발·데모 도메인(lvly.io 계열)에서만 노출한다(파일럿 고객 박스엔 숨김).
    const wiki2Tab = document.getElementById('wiki2-tab');
    // #1015 WIKI2 상단 탭 임시 숨김(장원준/상민님 요청, 2026-07-20) — 나중에 부활 시 아래 줄 주석 해제.
    //  (#/wiki2 라우트·배지 로직은 그대로 — 나브 노출만 억제. 탭은 index.html 기본 hidden 유지.)
    // if (wiki2Tab && wiki2Visible()) wiki2Tab.hidden = false;
    void wiki2Tab;
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn)
        logoutBtn.hidden = false;
    route();
}
// 로그아웃 — 세션 회수 + 로컬 토큰 제거 → 게이트.
(() => {
    const btn = document.getElementById('logout-btn');
    if (!btn)
        return;
    btn.addEventListener('click', async () => {
        try {
            await fetch('/api/ui/logout', { method: 'POST' });
        }
        catch (_) { /* noop */ }
        localStorage.removeItem(TOKEN_KEY);
        state.me = null;
        btn.hidden = true;
        showGate('로그아웃되었습니다.');
    });
})();
// 내 프로필 — 우측 상단 본인 표시(버튼) 클릭 시 '내 정보' 팝업 열기(#762). 관리 페이지로 이동하지 않는다.
//  (내 정보 편집을 관리에서 분리 — 관리엔 me-profile 섹션이 더는 없다. 팝업이 유일한 진입점.)
(() => {
    const btn = document.getElementById('user-email');
    if (!btn)
        return;
    btn.addEventListener('click', () => { if (state.me)
        openMyProfileModal(); });
})();
// ── 부팅 이전에 등록되던 DOM 리스너(원래 파일 상단 로드 시 등록 — 모듈 진입점으로 이동, 동작 동일) ──
// ── 스킵 링크 — href 를 따라가면 해시 라우터가 오작동하므로 JS 로 포커스만 이동(§8) ──
document.getElementById('skip-link').addEventListener('click', (ev) => {
    ev.preventDefault();
    const v = $view();
    if (v) {
        v.setAttribute('tabindex', '-1');
        v.focus();
    }
});
// 토큰 로그인(고급) 토글 — **입력 방식 전환**이다(#1085). 예전엔 토큰칸만 덧붙이고 이메일·비밀번호 칸을
//  그대로 뒀는데, 토큰 모드에서 그 칸들은 제출 시 무시된다(아래 submit: 토큰이 보이고 값이 있으면 토큰이 이긴다)
//  — 안 쓰는 칸이 남아 '토큰도 넣고 비밀번호도 넣으라는 건가?'로 읽혔다(사용자 지적). 한 번에 한 방식만 보인다.
const gateToggle = document.getElementById('gate-token-toggle');
gateToggle.addEventListener('click', () => {
    const t = document.getElementById('gate-input');
    const email = document.getElementById('gate-email');
    const pw = document.getElementById('gate-password');
    const copy = document.querySelector('.gate-copy');
    const toToken = t.hidden; // 지금 숨어 있으면 → 토큰 모드로 전환
    t.hidden = !toToken;
    email.hidden = toToken;
    pw.hidden = toToken;
    if (toToken) {
        email.value = '';
        pw.value = '';
    }
    else {
        t.value = '';
    }
    if (copy)
        copy.textContent = toToken ? '발급받은 접속 토큰을 붙여넣으세요.' : '회사 계정으로 로그인하세요.';
    gateToggle.textContent = toToken ? '← 이메일·비밀번호로 로그인' : '토큰으로 로그인 (고급)';
    (toToken ? t : email).focus();
});
document.getElementById('gate-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = document.getElementById('gate-error');
    const tokenIn = document.getElementById('gate-input');
    const tokenVal = (tokenIn && !tokenIn.hidden) ? tokenIn.value.trim() : '';
    let forcePw = null; // 임시 비번(must_change) 로그인 시 강제 변경할 현재(임시) 비번
    try {
        if (tokenVal) {
            // 고급: 토큰 로그인 — /api/ui/me 로 검증 후 localStorage 저장(bearer, 에이전트/서비스용).
            const res = await fetch('/api/ui/me', { headers: { Authorization: 'Bearer ' + tokenVal } });
            if (!res.ok) {
                err.textContent = '토큰이 유효하지 않습니다.';
                err.hidden = false;
                return;
            }
            localStorage.setItem(TOKEN_KEY, tokenVal);
        }
        else {
            // 기본: 이메일+비밀번호 로그인 → 세션 쿠키.
            const email = document.getElementById('gate-email').value.trim();
            const password = document.getElementById('gate-password').value;
            if (!email || !password) {
                err.textContent = '이메일과 비밀번호를 입력하세요.';
                err.hidden = false;
                return;
            }
            const res = await fetch('/api/ui/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                err.textContent = (data && data.error) || '로그인에 실패했습니다.';
                err.hidden = false;
                return;
            }
            localStorage.removeItem(TOKEN_KEY); // 세션 쿠키 사용 — 토큰 불필요
            // 임시 비번(관리자 발급) 로그인 → 첫 진입 시 새 비번 강제 설정. 방금 입력한 임시 비번을 '현재 비번'으로 넘긴다.
            if (data && data.mustChange)
                forcePw = password;
        }
        document.getElementById('gate-password').value = '';
        if (tokenIn)
            tokenIn.value = '';
        err.hidden = true;
        hideGate();
        boot();
        if (forcePw)
            changePasswordModal({ forced: true, currentPrefill: forcePw }); // 임시 비번이면 강제 변경 모달
    }
    catch (_) {
        err.textContent = '서버에 연결하지 못했습니다.';
        err.hidden = false;
    }
});
installGlobalUndo(); // #702 전역 실행취소(Cmd/Ctrl+Z) — 텍스트 편집 밖에서 '내 마지막 웹 변경'을 되돌린다.
boot();
export { parseHash, };
