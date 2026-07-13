// main.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { $view, TOKEN_KEY, api, el, errorNote, hideGate, loadPeopleAvatars, profileAvatar, showGate, state } from './core.js';
import { renderDomainmap } from './domainmap.js';
import { renderWiki, renderWikiTrash } from './wiki.js'; // #764 WIKI 탭 전면 재구축(사이드바 유지)
import { consumeWikiPeekGuard, dismissWikiPeek, renderWikiDocPage } from './wiki-doc.js';
import { wkRouteCleanup } from './wiki-data.js'; // #764 — 라우트 이탈 시 위키 에디터/팝오버 청소
import { renderProjectV2Detail, renderProjectsV2 } from './projects.js';
import { renderInstall, renderLearn, renderLearnMenu, renderLearnTour, renderOnboarding } from './learn.js';
import { resumeGuideTour } from './guide-tour.js'; // Lively 둘러보기(#761) — 라우팅 후 장면 재개
import { renderMyDashboard } from './dashboard-home.js';
import { renderTerminal, startTerminalTour, teardownTerminal } from './terminal.js';
import { changePasswordModal, openMyProfile, renderSystem } from './admin.js';
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
        mainEl.classList.toggle('doc-mode', page === 'knowledge' || page === 'k' || page === 'k-edit' || page === 'trash');
    try {
        if (page === 'dashboard') {
            setActiveTab('dashboard'); // 대시보드 — 옛 '시작하기' 탭 자리를 개편(#617). 현재는 자리표시.
            await renderMyDashboard(view);
        }
        else if (page === 'learn') {
            setActiveTab('learn'); // '사용 가이드' — 우측 상단 보조 링크(.help-link). 시작하기(설치)는 그 하위 서브탭(#617).
            if (segs[1] === 'install')
                await renderInstall(view); // #/learn/install — 옮겨 온 설치 화면
            else if (segs[1] === 'tour')
                await renderLearnTour(view); // #/learn/tour — Lively 둘러보기(#761)
            else if (segs[1] === 'menu')
                await renderLearnMenu(view); // #/learn/menu — 메뉴 한눈에 보기(#780)
            else
                await renderLearn(view);
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
            setActiveTab('projects2'); // 프로젝트(v2) — 맥락의 변화. 하위 탭(대시보드·탐색) 폐지: 상세(p) 외엔 보드 하나.
            // 상세(p)만 읽기 페이지 폭, 그 외(보드·스코프 딥링크 /l·/f·/none, 옛 worklog·browse URL)는 전부 풀스크린 보드.
            //  스코프 딥링크(#541): /l/<id>·/f/<id>·/none 은 보드의 리스트/폴더/미분류 선택 — 새로고침·뒤로가기 복원.
            const sub2 = segs[1] || 'dashboard';
            document.body.dataset.route = sub2 === 'p' ? 'projects2-detail' : 'projects2-board';
            if (segs[1] === 'p' && segs[2])
                await renderProjectV2Detail(view, segs[2]);
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
    // 우측 상단 = '내 프로필' 버튼(아바타 + 표시이름). 표시이름 우선(없으면 이메일/아이디). 클릭→셀프 편집(openMyProfile).
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
// 내 프로필 — 우측 상단 본인 표시(버튼) 클릭 시 셀프 편집 모달(표시 이름·개인 레이어). 한 번만 배선.
(() => {
    const btn = document.getElementById('user-email');
    if (!btn)
        return;
    btn.addEventListener('click', () => { if (state.me)
        openMyProfile(); });
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
// 토큰 로그인(고급) 토글 — 클릭 시 토큰 입력칸을 보였다 숨긴다.
document.getElementById('gate-token-toggle').addEventListener('click', () => {
    const t = document.getElementById('gate-input');
    t.hidden = !t.hidden;
    if (!t.hidden)
        t.focus();
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
