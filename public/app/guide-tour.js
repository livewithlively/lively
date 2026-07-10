// guide-tour.ts — 'Lively 둘러보기'(#761): 프로젝트 → 도메인 맵 → WIKI 를 실제 화면 위에서 눌러 보는 크로스탭 투어.
//  사용 가이드 › Lively 둘러보기(#/learn/tour)에서 시작한다. 단일 화면 스포트라이트 엔진(tour.ts #517)을
//  장면(scene) 단위로 이어 붙인다: 라우팅이 일어나면 엔진 오버레이는 내려가고(main.ts route → endTour),
//  라우팅 끝의 resumeGuideTour() 가 sessionStorage 플랜에서 현재 해시에 맞는 장면을 찾아 다시 켠다.
//  장면 전환 자체가 '실제 상단 탭을 직접 누르기'라, 투어가 끝나면 이동법이 몸에 남는다.
//  막다른 길 0 원칙: 단계 목록은 장면 시작 시점의 실제 DOM 을 보고 만든다(build) — 행/노드가 없으면 그 단계를
//  빼고, 예상 밖 화면으로 가면(딤 밖은 안 눌리므로 피크 [전체 화면]·뒤로가기 정도) 플랜을 조용히 접는다.
import { el, toast } from './core.js';
import { isTourActive, startTour } from './tour.js';
const PLAN_KEY = 'lively_gtour_plan_v1'; // sessionStorage — 진행 중 플랜(새로고침에도 이어짐, 탭 단위)
const DONE_KEY = 'lively_gtour_done_v1'; // localStorage — 완주 표시(랜딩 배지)
const TAB_LABEL = { projects2: '프로젝트', domainmap: '도메인 맵', knowledge: 'WIKI' };
// 코스(랜딩 카드 단위) → 장면 구성. 개별 코스도 같은 장면 정의를 부분집합으로 쓴다.
const COURSES = [
    { key: 'projects', label: '프로젝트', scenes: ['projects-board', 'projects-detail'] },
    { key: 'domainmap', label: '도메인 맵', scenes: ['domainmap'] },
    { key: 'wiki', label: 'WIKI', scenes: ['wiki'] },
];
const q = (sel) => document.querySelector(sel);
function p(text) { return el('p', { class: 'tour-p', text }); }
// 상단 탭으로 이동시키는 스텝 — 실제 내비 링크를 스포트라이트, 직접 눌러야 진행(advanceOn:'click').
function navStep(tab, title) {
    return {
        target: '.tabs a[data-tab="' + tab + '"]', placement: 'bottom',
        title: title || '다음 정거장 — ' + TAB_LABEL[tab],
        body: '상단의 [' + TAB_LABEL[tab] + '] 탭을 눌러 이동하세요.',
        advanceOn: 'click',
    };
}
// 마무리(중앙 카드) — 타깃 없음 = 엔진의 전체 딤 + 중앙 말풍선 폴백을 그대로 사용. __finale 로 완주 판정.
function finaleStep() {
    return {
        target: () => null, __finale: true, ctaNext: '마치기',
        title: '여기까지 — 둘러보기 끝!',
        body: [
            p('프로젝트(일의 흐름) → 도메인 맵(코드의 지도) → WIKI(AI가 읽는 지식)를 봤어요. 여기 쌓이는 만큼 회사 AI가 똑똑해져요.'),
            el('p', { class: 'tour-p' }, '이제 직접 해볼 차례 — ', el('a', { href: '#/terminal?tour=1', text: '터미널 따라하기 →' }), ' 로 AI에게 첫 말을 걸어보세요.'),
        ],
    };
}
// 장면 꼬리 — 플랜에 다음 탭이 남았으면 그 탭으로 보내는 이동 스텝, 없으면 마무리.
function tail(ctx) { return ctx.nextTab ? [navStep(ctx.nextTab)] : [finaleStep()]; }
// ── 장면 정의 — match: 담당 해시 · ready: 필수 크롬 대기 · hint: 콘텐츠(행·노드) 소프트 대기 · build: 실제 DOM 기반 스텝. ──
const SCENES = [
    {
        key: 'projects-board', tab: 'projects2',
        match: (h) => h.startsWith('#/projects2') && !h.startsWith('#/projects2/p/'),
        ready: () => !!q('.pjv-board-wrap'), hint: '.pjv-trow-title',
        build(ctx) {
            const steps = [];
            steps.push({ target: '.pjv-board-scroll, .pjv-board-wrap', padding: 4, title: '회사의 일이 다 여기에',
                body: '진행 중인 프로젝트가 리스트로 묶여 보여요. 팀이 지금 뭘 하는지 궁금할 때 가장 먼저 여는 화면이에요.' });
            if (q('.pjv-side-nav'))
                steps.push({ target: '.pjv-side-nav', placement: 'right', title: '왼쪽은 폴더 · 리스트',
                    body: '사업·제품처럼 성격별로 일이 정리돼요. 위 검색창으로 프로젝트를 바로 찾을 수도 있어요.' });
            if (q('.pjv-trow-title')) {
                steps.push({ target: () => q('.pjv-trow-title'), scrollIntoView: true, advanceOn: 'click',
                    title: '하나 열어볼까요?', body: '프로젝트 이름을 누르면 그 일의 상세로 들어가요.' });
                return steps; // 다음 장면(상세)으로는 위 클릭이 데려간다
            }
            if (q('.pjv-addrow-trigger'))
                steps.push({ target: '.pjv-addrow-trigger', title: '새 일은 여기서',
                    body: '[＋ 프로젝트]를 누르면 새 일을 등록해요. 지금은 구경만 할게요.' });
            return steps.concat(tail(ctx)); // 열어 볼 프로젝트가 없으면 이 화면에서 다음 정거장/마무리로
        },
    },
    {
        key: 'projects-detail', tab: 'projects2',
        match: (h) => h.startsWith('#/projects2/p/'),
        ready: () => !!q('main .page-head'),
        build(ctx) {
            const steps = [];
            steps.push({ target: 'main .page-head', title: '프로젝트의 얼굴',
                body: '이름·상태·팀원 — 이 일의 기본 정보예요. 아래로 개요와 태스크(할 일), 작업 기록이 이어져요.' });
            if (knFlowCard())
                steps.push({ target: knFlowCard, scrollIntoView: true, title: '이 일에 필요한 지식',
                    body: 'WIKI 지식을 \'필요지식\'으로 연결해 두면, 이 프로젝트를 맡은 AI가 그 내용을 처음부터 알고 시작해요.' });
            return steps.concat(tail(ctx));
        },
    },
    {
        key: 'domainmap', tab: 'domainmap',
        match: (h) => h.startsWith('#/domainmap'),
        ready: () => !!q('.dmx-canvas'), hint: '.dmx-node',
        build(ctx) {
            const steps = [];
            steps.push({ target: '.dmx-canvas', padding: 4, title: '제품 코드의 지도',
                body: '상자 하나가 기능 덩어리(도메인), 화살표는 의존 관계예요. 이 안에서는 자유롭게 끌고 확대해 봐도 좋아요.' });
            if (q('.dmx-controls'))
                steps.push({ target: '.dmx-controls', title: '의도 vs 실제',
                    body: '하려던 구조(should)와 실제 코드(is)를 겹쳐 보고, 서로 어긋난 곳(괴리)을 찾는 스위치예요.' });
            if (q('.dmx-node')) {
                steps.push({ target: () => q('.dmx-node'), advanceOn: 'click',
                    title: '도메인 속 들여다보기', body: '이 상자를 눌러 보세요.' });
                steps.push({ target: '.dmx-panel.open', placement: 'left', title: '정의 · 범위 · 괴리',
                    body: '이 도메인이 무엇인지(의도), 실제 코드는 어떤지, 어긋남은 없는지 보여줘요.' });
            }
            return steps.concat(tail(ctx));
        },
    },
    {
        key: 'wiki', tab: 'knowledge',
        match: (h) => h.startsWith('#/knowledge'),
        ready: () => !!q('.kn-side, main .list-box'), hint: 'main .list-box .row',
        build(ctx) {
            const steps = [];
            if (q('.kn-side'))
                steps.push({ target: '.kn-side', placement: 'right', title: 'AI가 읽는 지식 창고',
                    body: '회사의 규칙·결정·자료가 사업·제품·시스템으로 분류돼 쌓여요. 📌 인덱스에 핀된 지식은 매 대화 첫머리에 항상 깔려요.' });
            // 검색 — 홈(전체) 뷰는 사이드바 검색(.pjv-side-search), 카테고리 목록 뷰는 상단 검색(.kn-search-group).
            if (q('.kn-search-group, .kn-side .pjv-side-search'))
                steps.push({
                    target: '.kn-search-group, .kn-side .pjv-side-search', title: '검색 — AI도 이렇게 찾아요',
                    body: '여기서 검색하는 그대로, AI도 일할 때 이 지식을 검색해 꺼내 써요. 잘 쌓일수록 AI가 똑똑해져요.'
                });
            if (q('main .list-box .row')) {
                steps.push({ target: () => q('main .list-box .row'), scrollIntoView: true, advanceOn: 'click',
                    title: '하나 열어볼까요?', body: '지식을 누르면 오른쪽에 살짝 열려요(피크).' });
                steps.push({ target: '.kn-peek', placement: 'left', title: '지식 한 덩어리',
                    body: '제목·본문과 분류·핀 상태가 한눈에 — 이 내용이 그대로 AI에게 전달되는 회사 맥락이에요.' });
            }
            return steps.concat(tail(ctx));
        },
    },
];
// 프로젝트 상세의 '연결된 지식' 카드 — 고정 id 가 없어 제목 텍스트로 찾는다(없으면 스텝 생략).
function knFlowCard() {
    for (const h of document.querySelectorAll('main .card-head h3, main .card-head h2')) {
        if (/연결된 지식/.test(h.textContent || ''))
            return h.closest('.card');
    }
    return null;
}
// ── 플랜(sessionStorage) — { v, keys: 장면 key 순서, i: 현재 장면 인덱스(-1=출발 전) } ──
function sceneByKey(k) { return SCENES.find((s) => s.key === k) || null; }
function loadPlan() {
    try {
        const p0 = JSON.parse(sessionStorage.getItem(PLAN_KEY) || 'null');
        return p0 && p0.v === 1 && Array.isArray(p0.keys) && p0.keys.length ? p0 : null;
    }
    catch (_) {
        return null;
    }
}
function savePlan(plan) { try {
    sessionStorage.setItem(PLAN_KEY, JSON.stringify(plan));
}
catch (_) { /* 저장 불가면 단일 장면짜리로 동작 */ } }
function dropPlan() { try {
    sessionStorage.removeItem(PLAN_KEY);
}
catch (_) { /* noop */ } }
// 플랜 접기 — ✕/ESC(say=true) 또는 예상 밖 화면 이동(say=false, 조용히).
function foldGuideTour(say) {
    if (!loadPlan())
        return;
    dropPlan();
    if (say)
        toast('둘러보기를 닫았어요 — 사용 가이드 › Lively 둘러보기에서 언제든 다시 시작할 수 있어요.');
}
// j 번째 장면 뒤에 '다른 탭'의 장면이 남았으면 그 탭(다음 정거장), 없으면 null(=이 장면에서 마무리).
function nextTabAfter(plan, j) {
    const cur = (sceneByKey(plan.keys[j]) || {}).tab;
    for (let k = j + 1; k < plan.keys.length; k++) {
        const sc = sceneByKey(plan.keys[k]);
        if (sc && sc.tab !== cur)
            return sc.tab;
    }
    return null;
}
// 조건 폴링 — ready(필수 크롬)·hint(늦게 뜨는 행/노드) 대기. 시간 내 안 뜨면 그냥 진행(스텝이 알아서 빠짐).
async function waitFor(fn, ms) {
    const until = Date.now() + ms;
    for (;;) {
        try {
            if (fn())
                return true;
        }
        catch (_) { /* 셀렉터 오류 = 미충족 취급 */ }
        if (Date.now() >= until) {
            try {
                return !!fn();
            }
            catch (_) {
                return false;
            }
        }
        await new Promise((r) => setTimeout(r, 60));
    }
}
// ── 시작(랜딩 버튼) — 플랜 저장 후 '출발' 스텝(첫 코스의 상단 탭 스포트라이트)만 즉시 띄운다. ──
//  이후 진행은 사용자의 실제 탭 클릭 → 라우팅 → resumeGuideTour 가 이어받는다.
function startGuideTour(courseKeys) {
    const courses = courseKeys && courseKeys.length ? COURSES.filter((c) => courseKeys.includes(c.key)) : COURSES;
    const keys = courses.flatMap((c) => c.scenes);
    if (!keys.length)
        return;
    savePlan({ v: 1, keys, i: -1 });
    const first = sceneByKey(keys[0]);
    startTour([navStep(first.tab, '출발 — 첫 정거장은 ' + TAB_LABEL[first.tab])], { onEnd: (r) => { if (r === 'user')
            foldGuideTour(true); } });
}
// ── 재개(main.ts route() 끝에서 매 라우팅마다) — 플랜 없으면 no-op. ──
//  현재 장면부터 앞으로만 스캔(행이 없어 상세를 건너뛰는 등 선택 장면 스킵을 자연 처리).
let resumeSeq = 0; // ready/hint 대기 중 또 라우팅되면 이전 재개 무효화
async function resumeGuideTour() {
    const plan = loadPlan();
    if (!plan)
        return;
    const h = location.hash || '#/';
    let j = -1;
    for (let k = Math.max(plan.i, 0); k < plan.keys.length; k++) {
        const sc = sceneByKey(plan.keys[k]);
        if (sc && sc.match(h)) {
            j = k;
            break;
        }
    }
    // 예상 밖 화면(피크 [전체 화면]·뒤로가기·마무리 링크로 터미널行 등) — 접는다.
    //  다른 투어가 막 켜졌으면(터미널 따라하기 체이닝) 조용히, 아니면 다시 시작하는 법을 한 줄 안내.
    if (j < 0) {
        foldGuideTour(!isTourActive());
        return;
    }
    plan.i = j;
    savePlan(plan);
    const sc = sceneByKey(plan.keys[j]);
    const seq = ++resumeSeq;
    if (sc.ready)
        await waitFor(sc.ready, 1600);
    if (sc.hint)
        await waitFor(() => !!q(sc.hint), 900);
    if (seq !== resumeSeq)
        return;
    const cur = loadPlan();
    if (!cur || cur.i !== j)
        return; // 대기 중 플랜이 접히거나 이동함
    const steps = sc.build({ nextTab: nextTabAfter(cur, j) });
    if (!steps.length)
        return;
    const hasFinale = steps.some((s) => s && s.__finale);
    startTour(steps, { onEnd: (r) => {
            if (r === 'user') {
                foldGuideTour(true);
                return;
            }
            // 자연 완주는 마무리 스텝이 있던 장면에서만 의미 — 이동 클릭 직후의 잔여 complete(라우팅 경합)는 무시.
            if (r === 'complete' && hasFinale)
                finishGuideTour();
        } });
}
function finishGuideTour() {
    dropPlan();
    try {
        localStorage.setItem(DONE_KEY, new Date().toISOString());
    }
    catch (_) { /* noop */ }
    toast('Lively 둘러보기 완주 — 수고했어요!');
    location.hash = '#/learn/tour'; // 랜딩으로 복귀(완주 배지)
}
function isGuideTourDone() { try {
    return !!localStorage.getItem(DONE_KEY);
}
catch (_) {
    return false;
} }
export { COURSES, isGuideTourDone, resumeGuideTour, startGuideTour };
