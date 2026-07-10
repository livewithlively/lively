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
const TAB_LABEL: any = { projects2: '프로젝트', domainmap: '도메인 맵', knowledge: 'WIKI' };

// 코스(랜딩 카드 단위) → 장면 구성. 개별 코스도 같은 장면 정의를 부분집합으로 쓴다.
const COURSES = [
  { key: 'projects', label: '프로젝트', scenes: ['projects-board', 'projects-detail'] },
  { key: 'domainmap', label: '도메인 맵', scenes: ['domainmap'] },
  { key: 'wiki', label: 'WIKI', scenes: ['wiki'] },
];

const q = (sel: string) => document.querySelector(sel);
function p(text: string) { return el('p', { class: 'tour-p', text }); }

// 상단 탭으로 이동시키는 스텝 — 실제 내비 링크를 스포트라이트, 직접 눌러야 진행(advanceOn:'click').
function navStep(tab: string, title?: string) {
  return {
    target: '.tabs a[data-tab="' + tab + '"]', placement: 'bottom' as const,
    title: title || '다음 정거장 — ' + TAB_LABEL[tab],
    body: '상단의 [' + TAB_LABEL[tab] + '] 탭을 눌러 이동하세요.',
    advanceOn: 'click' as const,
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
function tail(ctx: any) { return ctx.nextTab ? [navStep(ctx.nextTab)] : [finaleStep()]; }

// ── 장면 정의 — match: 담당 해시 · ready: 필수 크롬 대기 · hint: 콘텐츠(행·노드) 소프트 대기 · build: 실제 DOM 기반 스텝. ──
const SCENES: any[] = [
  {
    // 보드(앞단) — 목록·할 일 관리는 클릭업과 거의 같다(#761 요청): 짧게 넘기고 곧장 '프로젝트 안'으로.
    key: 'projects-board', tab: 'projects2',
    match: (h: string) => h.startsWith('#/projects2') && !h.startsWith('#/projects2/p/'),
    ready: () => !!q('.pjv-board-wrap'), hint: '.pjv-trow-title',
    build(ctx: any) {
      const steps: any[] = [];
      steps.push({ target: '.pjv-board-scroll, .pjv-board-wrap', padding: 4, title: '이 목록·할 일 관리는 익숙할 거예요',
        body: '프로젝트를 폴더·리스트로 묶어 관리해요 — 여러분이 쓰던 클릭업과 최대한 비슷하게 맞췄어요. 그래서 이 앞부분은 빠르게 지나갈게요. 라이블리만의 진짜는 프로젝트 하나를 열었을 때 그 안에 있어요.' });
      if (q('.pjv-trow-title')) {
        steps.push({ target: () => q('.pjv-trow-title'), scrollIntoView: true, advanceOn: 'click',
          title: '프로젝트를 하나 열어볼까요?', body: '이름을 눌러 프로젝트 안으로 들어가 볼게요 — 여기부터가 핵심이에요.' });
        return steps; // 클릭이 상세 장면으로 데려간다
      }
      // 열어 볼 프로젝트가 없을 때 — 만드는 곳만 짚고 다음 정거장/마무리로(막다른 길 0).
      if (q('.pjv-addrow-trigger')) steps.push({ target: '.pjv-addrow-trigger', title: '새 프로젝트는 여기서',
        body: '[＋ 프로젝트]로 새 일을 등록해요. (지금은 열어 볼 프로젝트가 없어, 안쪽 기능은 실제 프로젝트가 생기면 볼 수 있어요.)' });
      return steps.concat(tail(ctx));
    },
  },
  {
    // 상세 — 위→아래로 실제 섹션을 훑되, 라이블리 고유(선행/후행·연결된 지식·공유폴더·터미널 세션)는 '왜 좋은지'까지(#761).
    key: 'projects-detail', tab: 'projects2',
    match: (h: string) => h.startsWith('#/projects2/p/'),
    ready: () => !!q('main .page-head'),
    build(ctx: any) {
      const steps: any[] = [];
      steps.push({ target: 'main .page-head', placement: 'bottom', title: '프로젝트 안 — 위에서부터 볼게요',
        body: '제목을 누르면 바로 이름을 고쳐요. 오른쪽 [⚙ 프로젝트 세부 설정]에서 팀원·분류·연결 레포·AI 규칙·삭제를 다뤄요.' });

      // ⭐ 선행/후행 프로젝트 — 라이블리 고유 ①. 속성판은 2열 그리드(선행=좌·후행=우)라 코치마크를 아래로 둬야
      //  오른쪽 칸(후행)이 안 가린다 → 패널 전체 스포트라이트 + placement 'bottom'.
      if (q('.pjv-proj-meta')) steps.push({
        target: '.pjv-proj-meta', placement: 'bottom', scrollIntoView: true, padding: 6,
        title: '⭐ 선행 · 후행 프로젝트 — 라이블리다운 ①',
        body: [
          p('이 속성판 맨 윗줄 두 칸이에요 — 왼쪽이 선행, 오른쪽이 후행. 이 일이 어떤 일 뒤에 오고(선행), 어떤 일로 이어지는지(후행)를 서로 연결해요. (아래 상태·팀원·기간은 익숙한 속성이에요.)'),
          p('왜 좋냐면 — 흩어진 프로젝트가 순서·의존으로 이어져 큰 그림이 잡히고, 이 프로젝트를 맡은 AI도 “이건 X 다음 단계”라는 맥락을 안 채로 시작해요. 후속을 만들 땐 선행의 연결 지식·배경까지 그대로 물려받아요.'),
        ],
      });

      // 개요(본문)
      if (cardByHeading(/^본문$/)) steps.push({ target: () => cardByHeading(/^본문$/), scrollIntoView: true,
        title: '개요', body: '이 일이 왜·무엇인지 적는 곳이에요. 여기 적은 배경도 이 프로젝트의 AI 세션에 함께 전달돼요.' });

      // ⭐ 연결된 지식 — 라이블리 고유 ②
      if (knFlowCard()) steps.push({ target: knFlowCard, scrollIntoView: true,
        title: '⭐ 연결된 지식 — 라이블리다운 ②',
        body: [
          p('WIKI에 쌓인 회사 지식을 이 프로젝트의 ‘필요지식’으로 연결해요.'),
          p('왜 좋냐면 — 이 프로젝트를 맡은 AI가 그 지식을 처음부터 손에 쥐고 시작해요. 배경을 매번 설명 안 해도 되고, 팀이 내린 결정대로 정확히 일해요. 일하며 새로 만든 지식은 ‘산출’로 여기 쌓여, 다음 사람·다음 AI가 또 씁니다.'),
        ],
      });

      // 할 일(태스크) — 클릭업류, 짧게
      if (q('main .pjv-tasks-card')) steps.push({ target: 'main .pjv-tasks-card', scrollIntoView: true, padding: 4,
        title: '할 일 (태스크)', body: '프로젝트를 잘게 나눠 관리해요 — 이 부분도 클릭업과 비슷해서 금방 익숙해질 거예요.' });

      // 공유 폴더 — '어디에' 생기나
      if (cardByHeading(/공유 폴더/)) steps.push({ target: () => cardByHeading(/공유 폴더/), scrollIntoView: true,
        title: '공유 폴더 — 파일은 “어디에” 생기나',
        body: [
          p('이 프로젝트 전용 폴더예요. 올린 파일은 내 컴퓨터가 아니라 라이블리 중앙(박스)의 이 프로젝트 폴더에 저장돼요.'),
          p('그래서 팀원 모두가 같은 파일을 보고, 이 프로젝트의 AI 세션도 바로 이 폴더에서 열려 이 파일들을 곧장 읽어요. 끌어다 놓거나 붙여넣기(⌘V)로 올릴 수 있어요.'),
        ],
      });

      // ⭐ 터미널 세션 — 어떻게 만드나 + 팝업(＋새 세션 → 드롭다운 → 웹 폼 → 취소로 닫기)
      if (q('.proj-term-card')) {
        steps.push({ target: '.proj-term-card', scrollIntoView: true,
          title: '⭐ 터미널 세션 — 이 프로젝트에서 AI 켜기',
          body: '이 프로젝트 폴더에서 여는 AI 작업 세션이에요. 팀원별로 세션이 모여 보여, 누가 무슨 작업을 켰는지 한눈에 알 수 있어요.' });
        steps.push({ target: '[data-tour="proj-new-session"]', placement: 'left', advanceOn: 'click',
          title: '세션 만들기 ① — ＋ 새 세션', body: '오른쪽 위 [＋ 새 세션]을 눌러 볼게요.' });
        // 드롭다운: 두 옵션을 설명하되 클릭 진행은 '웹에서 바로 열기'에만 건다 — '내 PC' 항목은 딤에 가려 못 눌러
        //  오작동(로컬 모달 오픈)이 원천 차단되고, 설명 단계와 클릭 단계를 하나로 합쳐 순서 어긋남도 없앤다.
        steps.push({ target: '[data-tour="sess-web"]', placement: 'left', advanceOn: 'click',
          title: '세션 만들기 ② — 어디서 켤까',
          body: [
            p('두 갈래가 떠요 — 💻 내 PC에서 열기(개발자용, 내 컴퓨터에 설치해 실행)와 ☁️ 웹에서 바로 열기(설치 없이 중앙 박스에서 여는 팀 공용 세션).'),
            p('비개발자는 웹이 제일 쉬워요. 밝게 표시된 [☁️ 웹에서 바로 열기]를 눌러 만들기 창을 띄워 볼게요.'),
          ] });
        steps.push({ target: '[data-tour="sess-name"]', placement: 'right', scrollIntoView: true,
          title: '만들기 창 — 세션 이름', body: '나중에 알아보기 쉽게 이름을 정해요. 예: “랜딩 카피 수정”.' });
        steps.push({ target: '[data-tour="sess-repos"]', placement: 'right', scrollIntoView: true,
          title: '코드 저장소 (선택)', body: '코드를 다루는 작업이면 저장소를 고르세요 — 박스가 그 코드를 자동으로 가져와 AI가 바로 작업하게 준비해요. 코드 작업이 아니면 비워두면 돼요(공유 폴더만 써요).' });
        steps.push({ target: '.proj-sess-preset', placement: 'right', scrollIntoView: true,
          title: '실행 설정', body: '함께 일할 AI·모델과 자동 승인 여부예요. 이전 설정을 기억하니 보통 그대로 두면 되고, 잘 모르겠으면 기본값으로.' });
        steps.push({ target: '[data-tour="sess-create"]', placement: 'top', scrollIntoView: true,
          title: '만들면 이렇게 돼요', body: '[만들고 입장]을 누르면 중앙 박스에 세션이 열리고 새 탭에 까만 터미널 창이 떠요 — 거기서 AI에게 바로 말을 걸면 됩니다. 회사 맥락과 이 프로젝트 맥락(연결된 지식·개요)은 이미 들어가 있어요.' });
        steps.push({ target: '[data-tour="sess-cancel"]', placement: 'top', advanceOn: 'click',
          title: '둘러보기라 여기까지', body: '실제로 만들지는 않을게요 — [취소]를 눌러 닫고 계속할게요.' });
      }
      return steps.concat(tail(ctx));
    },
  },
  {
    key: 'domainmap', tab: 'domainmap',
    match: (h: string) => h.startsWith('#/domainmap'),
    ready: () => !!q('.dmx-canvas'), hint: '.dmx-node',
    build(ctx: any) {
      const steps: any[] = [];
      steps.push({ target: '.dmx-canvas', padding: 4, title: '제품 코드의 지도',
        body: '상자 하나가 기능 덩어리(도메인), 화살표는 의존 관계예요. 이 안에서는 자유롭게 끌고 확대해 봐도 좋아요.' });
      if (q('.dmx-controls')) steps.push({ target: '.dmx-controls', title: '의도 vs 실제',
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
    match: (h: string) => h.startsWith('#/knowledge'),
    ready: () => !!q('.kn-side, main .list-box'), hint: 'main .list-box .row',
    build(ctx: any) {
      const steps: any[] = [];
      if (q('.kn-side')) steps.push({ target: '.kn-side', placement: 'right', title: 'AI가 읽는 지식 창고',
        body: '회사의 규칙·결정·자료가 사업·제품·시스템으로 분류돼 쌓여요. 📌 인덱스에 핀된 지식은 매 대화 첫머리에 항상 깔려요.' });
      // 검색 — 홈(전체) 뷰는 사이드바 검색(.pjv-side-search), 카테고리 목록 뷰는 상단 검색(.kn-search-group).
      if (q('.kn-search-group, .kn-side .pjv-side-search')) steps.push({
        target: '.kn-search-group, .kn-side .pjv-side-search', title: '검색 — AI도 이렇게 찾아요',
        body: '여기서 검색하는 그대로, AI도 일할 때 이 지식을 검색해 꺼내 써요. 잘 쌓일수록 AI가 똑똑해져요.' });
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
// 프로젝트 상세의 섹션 카드를 제목(h3/h2) 텍스트로 찾는다 — 고정 id 가 없어서(없으면 그 스텝은 생략).
function cardByHeading(re: RegExp): Element | null {
  for (const h of document.querySelectorAll('main .card-head h3, main .card-head h2')) {
    if (re.test(h.textContent || '')) return h.closest('.card');
  }
  return null;
}
function knFlowCard(): Element | null { return cardByHeading(/연결된 지식/); }

// 둘러보기 중 사용자가 연 임시 오버레이(세션 만들기 모달·＋새 세션 드롭다운)를 장면이 끝날 때 정리(#761) —
//  탭 이동 스텝(navStep)이 모달에 가려 안 눌리거나, 마무리/이탈 후 잔여 모달이 남지 않게. 지식 피크(.kn-peek)는 건드리지 않는다.
function closeStrayOverlays() {
  document.querySelectorAll('.ov-back, .pjv-pop').forEach((n) => n.remove());
}

// ── 플랜(sessionStorage) — { v, keys: 장면 key 순서, i: 현재 장면 인덱스(-1=출발 전) } ──
function sceneByKey(k: string) { return SCENES.find((s) => s.key === k) || null; }
function loadPlan() {
  try {
    const p0 = JSON.parse(sessionStorage.getItem(PLAN_KEY) || 'null');
    return p0 && p0.v === 1 && Array.isArray(p0.keys) && p0.keys.length ? p0 : null;
  } catch (_) { return null; }
}
function savePlan(plan: any) { try { sessionStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch (_) { /* 저장 불가면 단일 장면짜리로 동작 */ } }
function dropPlan() { try { sessionStorage.removeItem(PLAN_KEY); } catch (_) { /* noop */ } }

// 플랜 접기 — ✕/ESC(say=true) 또는 예상 밖 화면 이동(say=false, 조용히).
function foldGuideTour(say: boolean) {
  if (!loadPlan()) return;
  dropPlan();
  if (say) toast('둘러보기를 닫았어요 — 사용 가이드 › Lively 둘러보기에서 언제든 다시 시작할 수 있어요.');
}
// j 번째 장면 뒤에 '다른 탭'의 장면이 남았으면 그 탭(다음 정거장), 없으면 null(=이 장면에서 마무리).
function nextTabAfter(plan: any, j: number) {
  const cur = (sceneByKey(plan.keys[j]) || {}).tab;
  for (let k = j + 1; k < plan.keys.length; k++) {
    const sc = sceneByKey(plan.keys[k]);
    if (sc && sc.tab !== cur) return sc.tab;
  }
  return null;
}
// 조건 폴링 — ready(필수 크롬)·hint(늦게 뜨는 행/노드) 대기. 시간 내 안 뜨면 그냥 진행(스텝이 알아서 빠짐).
async function waitFor(fn: () => any, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    try { if (fn()) return true; } catch (_) { /* 셀렉터 오류 = 미충족 취급 */ }
    if (Date.now() >= until) { try { return !!fn(); } catch (_) { return false; } }
    await new Promise((r) => setTimeout(r, 60));
  }
}

// ── 시작(랜딩 버튼) — 플랜 저장 후 '출발' 스텝(첫 코스의 상단 탭 스포트라이트)만 즉시 띄운다. ──
//  이후 진행은 사용자의 실제 탭 클릭 → 라우팅 → resumeGuideTour 가 이어받는다.
function startGuideTour(courseKeys?: string[]) {
  const courses = courseKeys && courseKeys.length ? COURSES.filter((c) => courseKeys.includes(c.key)) : COURSES;
  const keys = courses.flatMap((c) => c.scenes);
  if (!keys.length) return;
  savePlan({ v: 1, keys, i: -1 });
  const first = sceneByKey(keys[0]);
  startTour([navStep(first.tab, '출발 — 첫 정거장은 ' + TAB_LABEL[first.tab])],
    { onEnd: (r) => { closeStrayOverlays(); if (r === 'user') foldGuideTour(true); } });
}

// ── 재개(main.ts route() 끝에서 매 라우팅마다) — 플랜 없으면 no-op. ──
//  현재 장면부터 앞으로만 스캔(행이 없어 상세를 건너뛰는 등 선택 장면 스킵을 자연 처리).
let resumeSeq = 0; // ready/hint 대기 중 또 라우팅되면 이전 재개 무효화
async function resumeGuideTour() {
  const plan = loadPlan();
  if (!plan) return;
  const h = location.hash || '#/';
  let j = -1;
  for (let k = Math.max(plan.i, 0); k < plan.keys.length; k++) {
    const sc = sceneByKey(plan.keys[k]);
    if (sc && sc.match(h)) { j = k; break; }
  }
  // 예상 밖 화면(피크 [전체 화면]·뒤로가기·마무리 링크로 터미널行 등) — 접는다.
  //  다른 투어가 막 켜졌으면(터미널 따라하기 체이닝) 조용히, 아니면 다시 시작하는 법을 한 줄 안내.
  if (j < 0) { foldGuideTour(!isTourActive()); return; }
  plan.i = j; savePlan(plan);
  const sc = sceneByKey(plan.keys[j]);
  const seq = ++resumeSeq;
  if (sc.ready) await waitFor(sc.ready, 1600);
  if (sc.hint) await waitFor(() => !!q(sc.hint), 900);
  if (seq !== resumeSeq) return;
  const cur = loadPlan();
  if (!cur || cur.i !== j) return; // 대기 중 플랜이 접히거나 이동함
  const steps = sc.build({ nextTab: nextTabAfter(cur, j) });
  if (!steps.length) return;
  const hasFinale = steps.some((s: any) => s && s.__finale);
  startTour(steps, { onEnd: (r) => {
    closeStrayOverlays(); // 장면 종료 시 잔여 세션 모달·드롭다운 정리(#761)
    if (r === 'user') { foldGuideTour(true); return; }
    // 자연 완주는 마무리 스텝이 있던 장면에서만 의미 — 이동 클릭 직후의 잔여 complete(라우팅 경합)는 무시.
    if (r === 'complete' && hasFinale) finishGuideTour();
  } });
}

function finishGuideTour() {
  dropPlan();
  try { localStorage.setItem(DONE_KEY, new Date().toISOString()); } catch (_) { /* noop */ }
  toast('Lively 둘러보기 완주 — 수고했어요!');
  location.hash = '#/learn/tour'; // 랜딩으로 복귀(완주 배지)
}
function isGuideTourDone() { try { return !!localStorage.getItem(DONE_KEY); } catch (_) { return false; } }

export { COURSES, isGuideTourDone, resumeGuideTour, startGuideTour };
