// core.ts — 토큰 게이트 + **배럴**(#1313 R28·R29a·R29b). 실체 로직은 web/lib/* 로 전부 내려갔다.
//
// Lively Context 웹 UI — 프레임워크 없는 해시 라우팅 SPA-lite.
// 보안 규칙: 모든 데이터 텍스트는 textContent/createElement 만 사용(innerHTML 에 데이터 주입 금지 —
// discord/notion 본문 XSS 방어). 토큰은 localStorage 에만, 절대 로그/URL 에 싣지 않는다.
//
// IA(2026-06-24): 지식을 두 직교축 injection(always 항상주입 / recalled 검색소환) × provenance(authored 저작 / observed 외부미러)
//  으로 분류해 비개발자가 조회·편집·핀. 주요 화면:
//   · 지식(#/knowledge/<space>) — 사업·제품·시스템 + 📌 인덱스(핀 전용 뷰) + 통계·검토. 좌 카테고리 사이드바 + 검색/필터 목록.
//   · 지식 상세(#/k/<name>)      — 전문(markdown) + 메타 + 연결 카테고리 + 편집·핀·삭제. (생성=목록 '+ 추가')
//   · 프로젝트(#/projects2) · 도메인 맵(#/domainmap) · 관리(#/system) · 가이드(#/learn) · 휴지통(#/trash) · 터미널(#/terminal).
//
// ── 이 파일이 하는 일은 둘뿐이다 ──────────────────────────────────────────────
//  ① 토큰 게이트(showGate/hideGate/logout) — 앱 셸의 로그인 경계. 정적 index.html 의 #gate/#app 을 직접 다룬다.
//  ② 배럴 — web/lib/* 의 공용 심볼을 한 이름공간으로 재수출한다. 49개 소비 파일이 종전대로 './core.js' 에서
//     받게 해 이동 리팩토링(R28·R29a·R29b)이 호출부 import 문을 한 줄도 건드리지 않게 하는 **계약**이다.
//  ⚠ 여기에 새 로직을 추가하지 마라 — 소관 lib/ 모듈에 두고 아래 재수출 목록에만 이름을 더한다.
//     (의존 방향은 core → lib 단방향. lib 가 core 를 import 하면 순환이며 check-imports 가 막는다.)
'use strict';
// 토큰·API 베이스·fetch 는 leaf 모듈 web/lib/net.ts 소관(R29a). 401 처리기 배선은 main.ts 최상단(setUnauthorizedHandler).
import { TOKEN_KEY, apiUrl } from './lib/net.js';
import { state } from './lib/state.js';
// ── 토큰 게이트 ──
function showGate(message) {
    document.getElementById('app').hidden = true;
    const gate = document.getElementById('gate');
    gate.hidden = false;
    const err = document.getElementById('gate-error');
    if (message) {
        err.textContent = message;
        err.hidden = false;
    }
    document.getElementById('gate-input').focus();
}
function hideGate() {
    document.getElementById('gate').hidden = true;
    document.getElementById('app').hidden = false;
}
// ── 로그아웃 — 세션 회수 + 로컬 토큰 제거 → 게이트. (헤더 버튼·강제 비번변경 모달 공용) ──
async function logout(message) {
    // 데스크톱 앱 안(#1541 web-shell)이면 이 PC 의 로그인(CLI 토큰)도 함께 끝낸다 — 앱은 창을 열 때마다 그 토큰을 넣어 주므로,
    //  여기서 localStorage 만 지우면 다음 창 열기에서 도로 로그인돼 '로그아웃이 안 된다' 로 보인다. 브라우저에선 없는 다리라 그대로 지나간다.
    const desk = window.livelyDesktop;
    if (desk && typeof desk.logout === 'function') {
        try {
            await desk.logout();
        }
        catch (_) { /* 앱 쪽 실패는 아래 웹 로그아웃을 막지 않는다 */ }
    }
    try {
        await fetch(apiUrl('/api/ui/logout'), { method: 'POST' });
    }
    catch (_) { /* noop */ }
    localStorage.removeItem(TOKEN_KEY);
    state.me = null;
    const lb = document.getElementById('logout-btn');
    if (lb)
        lb.hidden = true;
    showGate(message || '로그아웃되었습니다.');
}
export { hideGate, logout, showGate };
// ── 배럴 재수출(호출부 무변경 계약) ─────────────────────────────────────────────
//  네트워크(R29a) — 토큰 키·API 베이스·인증 fetch.
export { TOKEN_KEY, api, apiUrl, appUrl, currentWorkspace, setCurrentWorkspace } from './lib/net.js';
//  DOM 프리미티브 — el/sv 로만 화면을 짓는다(innerHTML 금지 불변식의 물리적 근거).
export { $view, applyReveal, el, interleave, reducedMotion, sv } from './lib/dom.js';
//  제자리 갱신이 스크롤을 옮기지 않게(#1635) — busy(비우는 동안 높이 예약) · keepSideScroll(사이드바 자체 스크롤).
export { busy, keepSideScroll } from './lib/inplace.js';
//  전역 상태 싱글턴 + 그 위의 판정 헬퍼.
export { hasScope, navOn, setUiModeOverride, state, uiMode, uiModeOverride, visAxisOn } from './lib/state.js';
//  시간·숫자 표기(core 소유분).
export { absTime, fmtNum, relTime } from './lib/format.js';
//  안내문 인라인 표기 → 화면 칩.
export { uiKeyCls, uiText } from './lib/uitext.js';
//  떠 있는 레이어(비모달) — 모달 다이얼로그는 web/ui-primitives.ts 소관.
export { anchoredPopover, infoPop, toast, withTip } from './lib/overlay.js';
//  아바타 단일 소스(#473) — 사람 얼굴은 전부 이 한 경로로.
export { avatarColor, initials, loadPeopleAvatars, personFace, profileAvatar, setPersonAvatar } from './lib/avatar.js';
//  체크박스 드래그 범위 선택(#1140) — 모듈 전역 상태 + document 리스너 1회 등록.
export { initDragRangeSelect } from './lib/drag-select.js';
//  공용 위젯 + 백엔드 enum 1:1 라벨 상수.
export { ACTIVITY_TYPE_LABEL, ACTIVITY_TYPE_ORDER, LIFECYCLE_LABEL, REF_REL_LABEL, REVIEW_LABEL, VOCAB_CRUD_DEFAULT_REPO, cardHead, confidenceDot, errorNote, lifecycleDot, loadRepos, markSecretInput, memberCombo, pageHead, secretInput, secretRow, selectFilter, stat, usernameAnchor, } from './lib/widgets.js';
//  마크다운 렌더러(R28) — 소비 15+ 파일이 종전대로 여기서 받는다.
export { renderCollection, renderInline, renderMarkdown, safeHref } from './lib/markdown.js';
