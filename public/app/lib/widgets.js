// lib/widgets.ts — 앱 공용 작은 위젯 + 도메인 라벨 상수(#1313 R29b). core.ts 에서 **verbatim 이동**(로직 변경 0).
//  담당: 페이지/카드 머리(pageHead·cardHead) · 상태 점(lifecycleDot·confidenceDot) · 폼 조각(secretInput 3종·
//   usernameAnchor·memberCombo·selectFilter) · 수치 타일(stat) · 에러 안내(errorNote) · repo 목록(loadRepos)
//   + 백엔드 enum 과 1:1 인 화면 라벨 상수들.
//  ⚠ uid(datalist 고유 id 카운터)·CSS_MASK_OK 는 모듈 전역이라 소유자와 동거한다.
//  의존 방향: widgets → dom·net·state·overlay(단방향). 역방향 없음 — uiText 는 lib/uitext 로 따로 떼어
//   overlay↔widgets 순환을 애초에 만들지 않는다.
//  소비 파일은 종전대로 './core.js' 에서 받는다(core 의 배럴 재수출).
import { denyAutofill, el } from './dom.js';
import { api } from './net.js';
import { infoPop } from './overlay.js';
import { state } from './state.js';
// 출처(provenance) 라벨 — ai=AI 에이전트 생성, human=사람 저작/승인, rule=시스템 결정론 파생, observed=외부 시스템 미러(커넥터 원천).
//  V4-C: 'confidence' 컬럼/enum 은 물리적으로 불변 — UI 라벨만 '출처(provenance)'로 의미를 명확히 한다(출처는 채널이
//  기계로 박는 사실이지 신뢰도·가치가 아니다). observed 는 외부 *살아있는 미러* — 진실·편집은 외부에 있다.
const CONFIDENCE_LABEL = { ai: 'AI', human: '사람', rule: '규칙', observed: '외부 미러' };
// lifecycle(상태) 라벨 — active=유효, rejected=반려, superseded=대체됨.
const LIFECYCLE_LABEL = { active: '유효', rejected: '반려', superseded: '대체됨', archived: '보관됨' }; // archived(#551): 외부 미러 원본 삭제/보관 전파
// 작업(activity) 유형 라벨 — 백엔드 activity.type(성격, 프로젝트 #182)과 1:1. 작업 현황 대시보드 유형분포 표시용.
//  type = "이 작업이 무엇인가". 커밋은 유형이 아니라 commit_sha 존재로 표현(어떤 유형이든 커밋 동반 가능).
const ACTIVITY_TYPE_LABEL = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타' };
const ACTIVITY_TYPE_ORDER = ['feature', 'fix', 'decision', 'docs', 'research', 'review', 'chore', 'other'];
// 작업↔지식 연결 관계 라벨(activity_knowledge.relation) — produced=산출, references=참조, decided=결정 근거.
const REF_REL_LABEL = { produced: '산출', references: '참조', decided: '결정' };
// should/is 점검 결과 라벨(activity.should_review/is_review) — 도메인 의도(should)·코드구조(is) 점검 3-state.
const REVIEW_LABEL = { na: '해당 없음', checked_no_change: '점검함(변화 없음)', changed: '변경됨' };
// V5 탈-repo: 도메인 귀속은 repo-비의존(business=조직평면). 저장/필터 드롭다운은 통합 목록(loadAllDomains)을
//  쓰고, 어휘CRUD 화면만 repo별 product 도메인(loadDomains)을 유지한다(코드앵커·debt 가 repo 스코프).
const VOCAB_CRUD_DEFAULT_REPO = 'productivity'; // 어휘관리 화면 repo 셀렉터 폴백 기본(product 도메인 CRUD 전용)
let uid = 0; // datalist 등 고유 id 카운터
// ── 공통 구성원(프로필) 단일 선택 콤보 — 드롭다운 + 타이핑 검색(native datalist), 자유입력도 허용. ──
//  데이터원 = /api/ui/terminal/profiles(구성원 + 로그인상태). 여러 폼 재사용(상시세션 account 등).
//  ⚠ 다중선택·초대는 별도(terminal.ts buildInvitePicker). 반환 { el, value() }.
export function memberCombo(opts) {
    const listId = 'mc-dl-' + (++uid);
    const input = el('input', { type: 'text', style: 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box',
        value: (opts && opts.value) || '', placeholder: (opts && opts.placeholder) || '구성원 선택/검색', list: listId, autocomplete: 'off' });
    const dl = el('datalist', { id: listId });
    api('/api/ui/terminal/profiles').then((r) => {
        for (const p of (r && r.profiles) || []) {
            const s = p.status || {};
            const tag = s.loggedIn ? '✓ 로그인' : (s.provisioned ? 'provisioned·미로그인' : '미provision');
            dl.append(el('option', { value: p.id, label: (p.name || p.id) + ' — ' + tag }));
        }
    }).catch(() => { });
    return { el: el('div', {}, input, dl), value: () => input.value.trim() };
}
// ── 시크릿 입력칸(#1250) ──
//  토큰·client_secret·웹훅 URL 은 **이 사이트 계정의 비밀번호가 아니다**. type=password 로 두면 위 오작동을 그대로
//  부르므로(크롬이 로그인 폼으로 오인 → 앞칸에 이메일 자동입력 + 제출 때 저장 프롬프트) 텍스트칸으로 두고
//  가림은 CSS 로만 한다(.secret-input → -webkit-text-security: disc).
//  지원: 크롬 4+ · 사파리 3.1+ · 엣지 79+ · 파이어폭스 114+ (caniuse 96%+).
//  ⚠ 미지원 브라우저에서 텍스트칸으로 두면 시크릿이 평문 노출된다 → 그때만 type=password 로 되돌린다(가림 우선).
const CSS_MASK_OK = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    && CSS.supports('-webkit-text-security', 'disc');
export function secretInput(attrs) {
    const n = el('input', {
        ...(attrs || {}),
        type: CSS_MASK_OK ? 'text' : 'password',
        class: 'secret-input' + (attrs && attrs.class ? ' ' + attrs.class : ''),
        autocomplete: 'off',
        spellcheck: 'false',
    });
    denyAutofill(n);
    return n;
}
// 시크릿칸 + [보기] 토글 한 줄. 값은 넘긴 input 에서 그대로 읽는다(호출부의 .value 유지).
//  type=password 의 브라우저 기본 가림을 CSS 로 대체하면서, 붙여넣은 값을 눈으로 확인할 길은 남긴다.
export function secretRow(input, ...extra) {
    const btn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm secret-toggle', text: '보기',
        title: '입력한 값 보기/가리기', 'aria-pressed': 'false' });
    btn.addEventListener('click', () => {
        const shown = input.classList.toggle('is-shown');
        if (!CSS_MASK_OK)
            input.type = shown ? 'text' : 'password'; // CSS 가림 미지원 폴백
        btn.textContent = shown ? '가리기' : '보기';
        btn.setAttribute('aria-pressed', String(shown));
    });
    return el('div', { class: 'secret-row' }, input, btn, ...extra);
}
// 정적 HTML(index.html)에 있는 시크릿칸에 위와 같은 규칙을 입힌다 — el() 을 안 타는 칸용(#1250).
export function markSecretInput(input) {
    input.classList.add('secret-input');
    input.type = CSS_MASK_OK ? 'text' : 'password';
    denyAutofill(input);
}
// 비밀번호 폼의 아이디 앵커(#1250) — 크롬은 비번칸 주위에서 아이디칸을 **반드시** 찾고, 없으면 근처의 아무
//  텍스트칸(CLI 승인코드 등)을 아이디로 오인해 거기에 저장된 이메일을 채운다. 이미 로그인한 사람의 비번
//  재확인·변경 폼에는 이 숨은 칸을 비번칸 **바로 앞**에 넣어 "아이디는 이 사람"이라고 못박는다.
//  (크로미움 권장 — 비번 폼은 숨겨도 되는 아이디칸을 가져야 한다. 접근성 콘솔 경고도 이걸 요구한다.)
//  ⚠ display:none·hidden 은 파서가 걸러낼 수 있어 '자리는 차지하되 안 보이게'(1px·투명) 둔다.
export function usernameAnchor() {
    return el('input', {
        type: 'text', autocomplete: 'username', readonly: true, tabindex: '-1', 'aria-hidden': 'true',
        value: (state.me && (state.me.email || state.me.userId)) || '',
        style: 'position:absolute;width:1px;height:1px;padding:0;border:0;opacity:0;overflow:hidden;clip:rect(0 0 0 0);pointer-events:none',
    });
}
// ── 에러 표시 헬퍼 ──
function errorNote(e, prefix) {
    if (e && e.status === 403) {
        return el('div', { class: 'note', text: '이 토큰에 필요한 권한(memory)이 없습니다.' });
    }
    return el('div', { class: 'note', text: (prefix || '불러오지 못했습니다') + ' — ' + (e && e.message ? e.message : '알 수 없는 오류') });
}
// ── 공용: 상태 점 + 라벨(§0.5 — 채운 필 금지, 6px 점 + 무채 텍스트) ──
function lifecycleDot(lifecycle) {
    const cls = lifecycle === 'active' ? 'st ok' : (lifecycle === 'rejected' || lifecycle === 'archived' ? 'st dim' : 'st');
    return el('span', { class: cls, text: LIFECYCLE_LABEL[lifecycle] || lifecycle });
}
function confidenceDot(confidence) {
    // 출처(provenance) 점: ai=점만(중립), human=민트(사람 저작/승인), rule=연회색, observed=연회색(외부 미러 — 큐레이션 아님).
    const cls = confidence === 'human' ? 'st ok'
        : (confidence === 'rule' || confidence === 'observed') ? 'st dim' : 'st';
    return el('span', { class: cls, text: CONFIDENCE_LABEL[confidence] || confidence });
}
// 카드(박스) 섹션 제목 — 제목 + 오른쪽 ⓘ. 카드 안 설명도 회색 줄 대신 이 아이콘 뒤로 접는다(#1085).
function cardHead(title, desc, badge, action) {
    // badge — '(개발자용)' 처럼 괄호로 덧붙이던 부가 표시를 제목 옆 칩으로(#1085). 제목 자체는 무엇인지만 말한다.
    // action — 이 섹션의 주 동작(예: [+ 새 팀]). 목록 안에 끼워 두면 어디에 속한 버튼인지 안 읽혀서 제목 줄 오른쪽에 둔다.
    return el('div', { class: 'card-head-row' }, el('h3', { text: title }), badge || null, infoPop(desc || null), action ? el('div', { class: 'card-head-act' }, action) : null);
}
function stat(num, label, unit) {
    return el('div', { class: 'stat' }, el('div', { class: 'num' }, num, unit ? el('small', {}, ' ' + unit) : null), el('div', { class: 'lbl', text: label }));
}
// 검토 대기 — 0 이면 무채(건강), >0 이면 클릭 가능(검토로 이동).
function selectFilter(opts, sel) {
    const s = el('select');
    for (const [v, t] of opts)
        s.append(el('option', { value: v, text: t }));
    s.value = sel || '';
    return s;
}
// ── P-V3-4a 도메인 통제어휘 select ──
// 도메인은 자유 키워드가 아니라 repo 하위 통제 어휘. 드롭다운은 domain_list(=/api/ui/domainmap/:repo/domains)로
// 채운다. 도메인맵이 죽거나 repo 미존재면 graceful: 캐시에 error 를 남기고 호출부가 자유입력 폴백을 쓴다.
// v6 은퇴(2026-06-24): loadAllDomains/loadDomains(구 도메인 통제어휘 드롭다운 — 주제분류 패널 폐기) 제거. 카테고리 관리는 관리→위지설정.
// repo 셀렉터 — repo_list union 의 repos[] 로 채운다(domainmap ∪ 매핑테이블). 단일 repo 면 라벨만.
async function loadRepos() {
    if (state.domains.__repos__)
        return state.domains.__repos__;
    let repos = [VOCAB_CRUD_DEFAULT_REPO];
    try {
        const r = await api('/api/ui/repos');
        if (r && Array.isArray(r.repos) && r.repos.length)
            repos = r.repos;
    }
    catch (_) { /* graceful: 기본 repo 만 */ }
    state.domains.__repos__ = repos;
    return repos;
}
// v6 은퇴(2026-06-24): buildDomainSelect(구 도메인 통제어휘 <select>) 제거 — 주제분류 패널 폐기.
// ── 공용 페이지 헤더(#367) — 모든 탭 상단 제목을 하나의 형식으로 통일 ──
// 구조: .page-head > .page-head-row( h1.page-title  [+ .page-head-actions] ) [+ p.sub].
//  · title  = 탭 이름과 같은 짧은 제목(28px h1) — 페이지마다 손으로 다르게 짜던 것을 여기 한 곳으로.
//  · sub    = 한 줄 설명(plain, 없으면 생략). 전문용어 대신 쉬운 말로.
//  · actions= 제목 오른쪽에 붙는 버튼/요소들(+ 추가·🗑 휴지통 등, 없으면 제목만).
//  · accent = 제목의 뒤쪽 일부를 브랜드 블루로(앱 전반의 관례: 프로'젝트'·지'식'처럼 끝부분 강조). 생략 시 강조 없음.
function pageHead(title, sub, actions, accent) {
    const acts = (actions || []).filter(Boolean);
    const row = el('div', { class: 'page-head-row' });
    // 제목이 비면(빈 문자열) 큰 제목·부제 없이 액션만 — 상단 군더더기 제거용(툴바만 남김).
    if (title) {
        const h1 = el('h1', { class: 'page-title' });
        if (accent && title.endsWith(accent)) {
            const lead = title.slice(0, title.length - accent.length);
            if (lead)
                h1.append(document.createTextNode(lead));
            h1.append(el('span', { class: 'accent', text: accent }));
        }
        else {
            h1.textContent = title;
        }
        row.append(h1);
    }
    if (acts.length)
        row.append(el('div', { class: 'page-head-actions' }, ...acts));
    return el('div', { class: 'page-head' + (title ? '' : ' page-head-noheading') }, row, (title && sub) ? el('p', { class: 'sub', text: sub }) : null);
}
export { ACTIVITY_TYPE_LABEL, ACTIVITY_TYPE_ORDER, LIFECYCLE_LABEL, REF_REL_LABEL, REVIEW_LABEL, VOCAB_CRUD_DEFAULT_REPO, cardHead, confidenceDot, errorNote, lifecycleDot, loadRepos, pageHead, selectFilter, stat, };
