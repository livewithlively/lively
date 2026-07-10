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
// 코치마크 본문 가독성(#761 피드백): 긴 문단 대신 짧은 줄 + 핵심만 굵게. b()=굵은 조각, pb(lead, rest)=굵은 리드 + 설명 한 줄.
function b(text) { return el('b', { text }); }
function pb(lead, rest) { return el('p', { class: 'tour-p' }, b(lead), rest); }
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
        // 보드(앞단) — 목록·할 일 관리는 클릭업과 거의 같다(#761 요청): 짧게 넘기고 곧장 '프로젝트 안'으로.
        key: 'projects-board', tab: 'projects2',
        match: (h) => h.startsWith('#/projects2') && !h.startsWith('#/projects2/p/'),
        ready: () => !!q('.pjv-board-wrap'),
        build() {
            // 실제 데이터 대신 이해를 돕는 예시 프로젝트(#/projects2/p/__demo__)로 데려간다(#761) — 실데이터·빈 조직 무관.
            return [{
                    target: '.pjv-board-scroll, .pjv-board-wrap', padding: 4,
                    title: '이 목록·할 일 관리는 익숙할 거예요',
                    body: [
                        el('p', { class: 'tour-p' }, '프로젝트를 폴더·리스트로 묶어 관리해요 — ', b('쓰던 클릭업과 비슷하게'), ' 맞췄어요.'),
                        el('p', { class: 'tour-p' }, '여긴 빠르게 넘길게요. ', b('진짜는 프로젝트 안'), '에 있어요 — 예시로 하나 열어볼게요.'),
                    ],
                    ctaNext: '예시 프로젝트 열기 →',
                    onAdvance: () => { location.hash = '#/projects2/p/__demo__'; },
                }];
        },
    },
    {
        // 상세 — 위→아래로 실제 섹션을 훑되, 라이블리 고유(선행/후행·연결된 지식·공유폴더·터미널 세션)는 '왜 좋은지'까지(#761).
        key: 'projects-detail', tab: 'projects2',
        match: (h) => h.startsWith('#/projects2/p/'),
        ready: () => !!q('main .page-head'),
        build(ctx) {
            const steps = [];
            steps.push({ target: 'main .page-head', placement: 'bottom', title: '프로젝트 안 — 위에서부터 볼게요',
                body: [
                    el('p', { class: 'tour-p' }, '예시 프로젝트 ', b('“새 요금제 ‘팀 플랜’ 출시”'), ' 예요. 이름·상태가 위에 있어요.'),
                    el('p', { class: 'tour-p' }, '오른쪽 ', b('[⚙ 세부 설정]'), ' — 팀원·분류·레포·AI 규칙·삭제.'),
                ] });
            // ⭐ 선행/후행 프로젝트 — 라이블리 고유 ①. 속성판은 2열 그리드(선행=좌·후행=우)라 코치마크를 아래로 둬야
            //  오른쪽 칸(후행)이 안 가린다 → 패널 전체 스포트라이트 + placement 'bottom'.
            if (q('.pjv-proj-meta'))
                steps.push({
                    target: '.pjv-proj-meta', placement: 'bottom', scrollIntoView: true, padding: 6,
                    title: '⭐ 선행 · 후행 프로젝트',
                    body: [
                        el('p', { class: 'tour-p' }, b('맨 윗줄 두 칸'), ' — 왼쪽 선행, 오른쪽 후행. 이 일의 앞뒤 프로젝트를 이어 둬요. (나머지는 상태·팀원 등 익숙한 속성.)'),
                        pb('좋은 점: ', '일의 순서가 한눈에 잡히고, AI도 “이건 X 다음 단계”를 안 채로 시작해요.'),
                    ],
                });
            // 개요(본문)
            if (cardByHeading(/^본문$/))
                steps.push({ target: () => cardByHeading(/^본문$/), scrollIntoView: true,
                    title: '개요',
                    body: el('p', { class: 'tour-p' }, '이 일이 ', b('왜·무엇인지'), ' 적는 곳. 여기 배경도 이 프로젝트 AI 세션에 함께 전달돼요.') });
            // ⭐ 연결된 지식 — 라이블리 고유 ②
            if (knFlowCard())
                steps.push({ target: knFlowCard, scrollIntoView: true,
                    title: '⭐ 연결된 지식',
                    body: [
                        el('p', { class: 'tour-p' }, 'WIKI 지식을 이 프로젝트의 ', b('‘필요지식’'), '으로 붙여둬요.'),
                        pb('좋은 점: ', 'AI가 그 내용을 처음부터 알고 시작 — 배경 설명 반복 없이, 팀 결정대로. (새로 만든 지식은 ‘산출’로 쌓여요.)'),
                    ],
                });
            // 할 일(태스크) — 클릭업류, 짧게
            if (q('main .pjv-tasks-card'))
                steps.push({ target: 'main .pjv-tasks-card', scrollIntoView: true, padding: 4,
                    title: '할 일 (태스크)',
                    body: el('p', { class: 'tour-p' }, '프로젝트를 잘게 나눠 관리 — ', b('이 부분도 클릭업과 비슷'), '해요.') });
            // 공유 폴더 — '어디에' 생기나
            if (cardByHeading(/공유 폴더/))
                steps.push({ target: () => cardByHeading(/공유 폴더/), scrollIntoView: true,
                    title: '공유 폴더 — 파일은 “어디에” 생기나',
                    body: [
                        el('p', { class: 'tour-p' }, '이 프로젝트 전용 폴더 — 파일은 ', b('내 PC가 아니라 중앙(박스)'), '에 저장돼요.'),
                        p('그래서 팀원 모두 같은 파일을 보고, 이 프로젝트 AI 세션도 여기서 열려 바로 읽어요. 끌어다 놓기·붙여넣기(⌘V)로 올려요.'),
                    ],
                });
            // ⭐ 터미널 세션 — 어떻게 만드나 + 팝업(＋새 세션 → 드롭다운 → 웹 폼 → 취소로 닫기)
            if (q('.proj-term-card')) {
                steps.push({ target: '.proj-term-card', scrollIntoView: true,
                    title: '⭐ 터미널 세션 — 이 프로젝트에서 AI 켜기',
                    body: el('p', { class: 'tour-p' }, '이 프로젝트에서 여는 ', b('AI 작업 세션'), '이에요. 팀원별로 모여 보여, 누가 뭘 켰는지 한눈에.') });
                steps.push({ target: '[data-tour="proj-new-session"]', placement: 'left', advanceOn: 'click',
                    title: '세션 만들기 ① — ＋ 새 세션', body: '오른쪽 위 [＋ 새 세션]을 눌러 볼게요.' });
                // 드롭다운: 두 옵션을 설명하되 클릭 진행은 '웹에서 바로 열기'에만 건다 — '내 PC' 항목은 딤에 가려 못 눌러
                //  오작동(로컬 모달 오픈)이 원천 차단되고, 설명 단계와 클릭 단계를 하나로 합쳐 순서 어긋남도 없앤다.
                steps.push({ target: '[data-tour="sess-web"]', placement: 'left', advanceOn: 'click',
                    title: '세션 만들기 ② — 어디서 켤까',
                    body: [
                        p('두 갈래가 떠요:'),
                        el('p', { class: 'tour-p' }, b('💻 내 PC'), ' — 개발자용. 내 컴퓨터에 설치.'),
                        el('p', { class: 'tour-p' }, b('☁️ 웹에서 바로'), ' — 설치 없이 중앙에서 여는 팀 공용. 비개발자는 이게 쉬워요.'),
                        el('p', { class: 'tour-p' }, '밝은 ', b('[☁️ 웹에서 바로 열기]'), '를 눌러 볼게요.'),
                    ] });
                steps.push({ target: '[data-tour="sess-name"]', placement: 'right', scrollIntoView: true,
                    title: '만들기 창 — 세션 이름',
                    body: el('p', { class: 'tour-p' }, '알아보기 쉽게 이름을 정해요. 예: ', b('“랜딩 카피 수정”'), '.') });
                steps.push({ target: '[data-tour="sess-repos"]', placement: 'right', scrollIntoView: true,
                    title: '코드 저장소 (선택)',
                    body: [
                        p('코드 작업이면 저장소를 고르세요 — 박스가 그 코드를 자동으로 가져와 준비해요.'),
                        el('p', { class: 'tour-p' }, b('코드가 아니면 비워도 돼요.')),
                    ] });
                steps.push({ target: '.proj-sess-preset', placement: 'right', scrollIntoView: true,
                    title: '실행 설정',
                    body: el('p', { class: 'tour-p' }, '함께 일할 ', b('AI·모델'), '과 자동 승인. 이전 설정을 기억하니 보통 그대로 둬도 돼요.') });
                steps.push({ target: '[data-tour="sess-create"]', placement: 'top', scrollIntoView: true,
                    title: '만들면 이렇게 돼요',
                    body: [
                        el('p', { class: 'tour-p' }, b('[만들고 입장]'), '을 누르면 새 탭에 터미널이 열려요 — AI에게 바로 말을 걸면 돼요.'),
                        p('회사·이 프로젝트 맥락은 이미 들어가 있어요.'),
                    ] });
                steps.push({ target: '[data-tour="sess-cancel"]', placement: 'top', advanceOn: 'click',
                    title: '둘러보기라 여기까지', body: '실제로 만들지는 않을게요 — [취소]로 닫고 계속할게요.' });
            }
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
                body: [
                    el('p', { class: 'tour-p' }, '상자 하나가 ', b('기능 덩어리(도메인)'), ', 화살표는 의존이에요.'),
                    p('드래그·휠로 자유롭게 움직여 봐도 좋아요.'),
                ] });
            if (q('.dmx-controls'))
                steps.push({ target: '.dmx-controls', title: '의도 vs 실제',
                    body: el('p', { class: 'tour-p' }, b('하려던 구조(should)'), '와 ', b('실제 코드(is)'), '를 겹쳐 보고, 어긋난 곳을 찾는 스위치예요.') });
            if (q('.dmx-node')) {
                // 노드는 선택 시 그래프가 재렌더돼(draw) click 리스너 타깃이 사라진다 → advanceOn:'click' 무효.
                //  대신 advanceWhen(패널 열림)으로 진행하고 [다음]도 노출(절대 안 막힘). (#761 사용자 리포트)
                steps.push({ target: () => q('.dmx-node'), advanceWhen: () => !!q('.dmx-panel.open'),
                    title: '도메인 속 들여다보기',
                    body: el('p', { class: 'tour-p' }, '상자를 하나 눌러 보세요 — 오른쪽에 그 도메인의 ', b('자세히'), '가 열려요.') });
                steps.push({ target: '.dmx-panel.open', placement: 'left', title: '정의 · 범위 · 괴리',
                    body: el('p', { class: 'tour-p' }, '이 도메인의 ', b('정의·범위(의도)'), ', 실제 코드, 둘의 ', b('어긋남(괴리)'), '을 보여줘요.') });
            }
            return steps.concat(tail(ctx));
        },
    },
    {
        key: 'wiki', tab: 'knowledge',
        match: (h) => h.startsWith('#/knowledge'),
        ready: () => !!q('.kn-side, .wk-home, .wk-cat'), hint: 'main .wk-row', // #764 재구축 표면
        build(ctx) {
            const steps = [];
            if (q('.kn-side'))
                steps.push({ target: '.kn-side', placement: 'right', title: 'AI가 읽는 지식 창고',
                    body: '회사의 규칙·결정·자료가 사업·제품·시스템으로 분류돼 쌓여요. 📌 인덱스에 핀된 지식은 매 대화 첫머리에 항상 깔려요.' });
            // 검색 — 사이드바 분류·지식 검색(전문 의미검색은 ⌘K).
            if (q('.kn-side .pjv-side-search'))
                steps.push({
                    target: '.kn-side .pjv-side-search', title: '검색 — AI도 이렇게 찾아요',
                    body: '여기서 검색하는 그대로, AI도 일할 때 이 지식을 검색해 꺼내 써요. 잘 쌓일수록 AI가 똑똑해져요.'
                });
            if (q('main .wk-row')) {
                steps.push({ target: () => q('main .wk-row'), scrollIntoView: true, advanceOn: 'click',
                    title: '하나 열어볼까요?', body: '지식을 누르면 오른쪽에 살짝 열려요(피크).' });
                steps.push({ target: '.wk-peek', placement: 'left', title: '지식 한 덩어리',
                    body: '제목·본문과 분류·핀 상태가 한눈에 — 이 내용이 그대로 AI에게 전달되는 회사 맥락이에요.' });
            }
            return steps.concat(tail(ctx));
        },
    },
];
// 프로젝트 상세의 섹션 카드를 제목(h3/h2) 텍스트로 찾는다 — 고정 id 가 없어서(없으면 그 스텝은 생략).
function cardByHeading(re) {
    for (const h of document.querySelectorAll('main .card-head h3, main .card-head h2')) {
        if (re.test(h.textContent || ''))
            return h.closest('.card');
    }
    return null;
}
function knFlowCard() { return cardByHeading(/연결된 지식/); }
// 둘러보기 중 사용자가 연 임시 오버레이(세션 만들기 모달·＋새 세션 드롭다운)를 장면이 끝날 때 정리(#761) —
//  탭 이동 스텝(navStep)이 모달에 가려 안 눌리거나, 마무리/이탈 후 잔여 모달이 남지 않게. 지식 피크(.wk-peek)는 건드리지 않는다.
function closeStrayOverlays() {
    document.querySelectorAll('.ov-back, .pjv-pop').forEach((n) => n.remove());
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
    startTour([navStep(first.tab, '출발 — 첫 정거장은 ' + TAB_LABEL[first.tab])], { onEnd: (r) => { closeStrayOverlays(); if (r === 'user')
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
            closeStrayOverlays(); // 장면 종료 시 잔여 세션 모달·드롭다운 정리(#761)
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
