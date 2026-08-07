// guide-tour.ts — 'Lively 둘러보기'(#761): 프로젝트 → 도메인 맵 → WIKI 를 실제 화면 위에서 눌러 보는 크로스탭 투어.
//  사용 가이드 › Lively 둘러보기(#/learn/tour)에서 시작한다. 단일 화면 스포트라이트 엔진(tour.ts #517)을
//  장면(scene) 단위로 이어 붙인다: 라우팅이 일어나면 엔진 오버레이는 내려가고(main.ts route → endTour),
//  라우팅 끝의 resumeGuideTour() 가 sessionStorage 플랜에서 현재 해시에 맞는 장면을 찾아 다시 켠다.
//  장면 전환 자체가 '실제 상단 탭을 직접 누르기'라, 투어가 끝나면 이동법이 몸에 남는다.
//  막다른 길 0 원칙: 단계 목록은 장면 시작 시점의 실제 DOM 을 보고 만든다(build) — 행/노드가 없으면 그 단계를
//  빼고, 예상 밖 화면으로 가면(딤 밖은 안 눌리므로 피크 [전체 화면]·뒤로가기 정도) 플랜을 조용히 접는다.
import { el, navOn, toast } from './core.js';
import { isTourActive, startTour } from './tour.js';

const PLAN_KEY = 'lively_gtour_plan_v1'; // sessionStorage — 진행 중 플랜(새로고침에도 이어짐, 탭 단위)
const DONE_KEY = 'lively_gtour_done_v1'; // (구) localStorage — 전체 완주 타임스탬프. 하위호환 읽기만(= 세 섹션 다 봄).
const DONE_SECTIONS_KEY = 'lively_gtour_done_sections_v1'; // localStorage — 섹션별 완료 표시(랜딩 ✓)
const TAB_LABEL: any = { projects2: '프로젝트', domainmap: '도메인 맵', knowledge: 'WIKI' };

// 섹션(랜딩 진입 단위) → 장면 구성. 전체 투어 = 세 섹션을 이어 붙인 것 == 섹션 하나만 골라 들어갈 수도 있다(#780).
const COURSES = [
  { key: 'projects', label: '프로젝트', scenes: ['projects-board', 'projects-detail'] },
  { key: 'domainmap', label: '도메인 맵', scenes: ['domainmap'] },
  { key: 'wiki', label: 'WIKI', scenes: ['wiki'] },
  // #853 '프로젝트 체험'(손수 하기) — 둘러보기 랜딩엔 안 뜨고 #/start/project 에서만 시작(startGuideTour(['project-do'])).
  //  둘러보기 완주(isGuideTourDone)·랜딩 코스 목록엔 포함하지 않는다(TOUR_ONLY 로 걸러냄).
  { key: 'project-do', label: '프로젝트 체험', scenes: ['pd-create', 'pd-detail'] },
];
const TOUR_ONLY = (c: any) => c.key !== 'project-do'; // 'Lively 둘러보기'(랜딩·완주) 대상 = project-do 제외 3섹션
const courseLabel = (k: string) => (COURSES.find((c) => c.key === k) || { label: k }).label;

const q = (sel: string) => document.querySelector(sel);
function p(text: string) { return el('p', { class: 'tour-p', text }); }
// 코치마크 본문 가독성(#761 피드백): 긴 문단 대신 짧은 줄 + 핵심만 굵게. b()=굵은 조각, pb(lead, rest)=굵은 리드 + 설명 한 줄.
function b(text: string) { return el('b', { text }); }
function pb(lead: string, rest: any) { return el('p', { class: 'tour-p' }, b(lead), rest); }

// 상단 탭으로 이동시키는 스텝 — 실제 내비 링크를 스포트라이트, 직접 눌러야 진행(advanceOn:'click').
function navStep(tab: string, title?: string) {
  return {
    target: '.tabs a[data-tab="' + tab + '"]', placement: 'bottom' as const,
    title: title || '다음은 ' + TAB_LABEL[tab],
    body: '상단의 [' + TAB_LABEL[tab] + '] 탭을 눌러 이동하세요.',
    advanceOn: 'click' as const,
  };
}
// 마무리(중앙 카드) — 타깃 없음 = 엔진의 전체 딤 + 중앙 말풍선 폴백을 그대로 사용. __finale 로 완주 판정.
//  섹션만 골라 본 경우(#780)엔 '다 봤다'고 하지 않는다 — 본 섹션만 짚고, 남은 섹션을 어디서 볼 수 있는지 알려 준다.
function finaleStep(courses: string[]) {
  const seen = COURSES.filter((c) => courses.includes(c.key));
  const rest = COURSES.filter((c) => !courses.includes(c.key));
  const terminal = el('p', { class: 'tour-p' }, '이제 직접 해볼 차례 — ',
    el('a', { href: '#/terminal?tour=1', text: '터미널 따라하기 →' }), ' 로 AI에게 첫 말을 걸어보세요.');
  const body = rest.length
    ? [
      p(seen.map((c) => c.label).join(' · ') + ' 섹션은 여기까지예요.'),
      el('p', { class: 'tour-p' }, '남은 ', b(rest.map((c) => c.label).join(' · ')), ' 섹션도 사용 가이드 › Lively 둘러보기에서 골라 볼 수 있어요.'),
      terminal,
    ]
    : [
      p('프로젝트(일의 흐름) → 도메인 맵(코드의 구조) → WIKI(AI가 읽는 지식)를 봤어요. 여기 쌓이는 만큼 회사 AI가 똑똑해져요.'),
      terminal,
    ];
  return {
    target: () => null, __finale: true, ctaNext: '마치기',
    title: rest.length ? seen.map((c) => c.label).join(' · ') + ' 섹션 끝!' : '여기까지 — 둘러보기 끝!',
    body,
  };
}
// 장면 꼬리 — 플랜에 다음 탭이 남았으면 그 탭으로 보내는 이동 스텝, 없으면 마무리.
function tail(ctx: any) { return ctx.nextTab ? [navStep(ctx.nextTab)] : [finaleStep(ctx.courses)]; }

// ── 장면 정의 — match: 담당 해시 · ready: 필수 크롬 대기 · hint: 콘텐츠(행·노드) 소프트 대기 · build: 실제 DOM 기반 스텝. ──
const SCENES: any[] = [
  {
    // 보드(앞단) — 목록·할 일 관리는 클릭업과 거의 같다(#761 요청): 짧게 넘기고 곧장 '프로젝트 안'으로.
    key: 'projects-board', tab: 'projects2',
    match: (h: string) => h.startsWith('#/projects2') && !h.startsWith('#/projects2/p/'),
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
    match: (h: string) => h.startsWith('#/projects2/p/'),
    ready: () => !!q('main .page-head'),
    build(ctx: any) {
      const steps: any[] = [];
      steps.push({ target: 'main .page-head', placement: 'bottom', title: '프로젝트 안 — 위에서부터 볼게요',
        body: [
          el('p', { class: 'tour-p' }, '예시 프로젝트 ', b('“새 요금제 ‘팀 플랜’ 출시”'), ' 예요. 이름·상태가 위에 있어요.'),
          el('p', { class: 'tour-p' }, '오른쪽 ', b('[⚙ 세부 설정]'), '에서 팀원·분류·레포·AI 규칙을 바꾸거나 프로젝트를 지울 수 있어요.'),
        ] });

      // ⭐ 선행/후속 프로젝트 — 라이블리 고유 ①. 속성판 2열 그리드의 '첫 줄 두 칸'(선행=좌·후속=우)만 뚫는다 —
      //  패널(.pjv-proj-meta) 전체를 뚫으면 상태·리스트·팀원까지 밝아져 어디를 보라는 건지 흐려진다(#780 사용자 리포트).
      //  코치마크는 아래(bottom)로: 'right' 면 오른쪽 칸(후속)을 가린다.
      if (edgeFields().length === 2) steps.push({
        target: edgeFields, placement: 'bottom', scrollIntoView: true, padding: 6,
        title: '⭐ 선행 · 후속 프로젝트',
        body: [
          el('p', { class: 'tour-p' }, '왼쪽이 ', b('선행'), ', 오른쪽이 ', b('후속'), ' 이에요. 이 일의 앞뒤에 오는 프로젝트를 여기에 이어 둬요.'),
          pb('좋은 점: ', '일의 순서가 한눈에 잡히고, AI도 이 일이 어떤 일 다음에 오는지 안 채로 시작해요.'),
        ],
      });

      // 개요(본문)
      if (cardByHeading(/^본문$/)) steps.push({ target: () => cardByHeading(/^본문$/), scrollIntoView: true,
        title: '개요',
        body: el('p', { class: 'tour-p' }, '이 일이 ', b('왜 필요한지, 무엇을 하는지'), ' 적는 곳이에요. 여기 적은 배경도 이 프로젝트의 AI 세션에 함께 전달돼요.') });

      // ⭐ 연결된 지식 — 라이블리 고유 ②
      if (knFlowCard()) steps.push({ target: knFlowCard, scrollIntoView: true,
        title: '⭐ 연결된 지식',
        body: [
          el('p', { class: 'tour-p' }, 'WIKI 지식을 이 프로젝트의 ', b('‘필요지식’'), '으로 붙여둬요. 이 일을 하려면 알아야 하는 것들이에요.'),
          pb('좋은 점: ', 'AI가 그 내용을 처음부터 알고 시작해요. 배경을 매번 다시 설명할 필요가 없고, 팀이 정해 둔 대로 일해요. 일하면서 새로 만든 지식은 ‘산출지식’으로 여기 쌓여요.'),
        ],
      });

      // 할 일(태스크) — 클릭업류, 짧게
      if (q('main .pjv-tasks-card')) steps.push({ target: 'main .pjv-tasks-card', scrollIntoView: true, padding: 4,
        title: '할 일 (태스크)',
        body: el('p', { class: 'tour-p' }, '프로젝트를 잘게 나눠 관리해요. ', b('이 부분도 클릭업과 비슷'), '해요.') });

      // 공유 폴더 — '어디에' 생기나
      if (cardByHeading(/공유 폴더/)) steps.push({ target: () => cardByHeading(/공유 폴더/), scrollIntoView: true,
        title: '공유 폴더 — 파일은 “어디에” 생기나',
        body: [
          el('p', { class: 'tour-p' }, '이 프로젝트 전용 폴더예요. 파일은 ', b('내 PC가 아니라 중앙(박스)'), '에 저장돼요.'),
          p('그래서 팀원 모두 같은 파일을 보고, 이 프로젝트의 AI 세션도 여기서 열려 그 파일을 바로 읽어요. 끌어다 놓거나 붙여넣기(⌘V)로 파일을 올릴 수 있어요.'),
        ],
      });

      // ⭐ 터미널 세션 — 어떻게 만드나 + 팝업(＋새 세션 → 드롭다운 → 웹 폼 → 취소로 닫기)
      if (q('.proj-term-card')) {
        steps.push({ target: '.proj-term-card', scrollIntoView: true,
          title: '⭐ 터미널 세션 — 이 프로젝트에서 AI 켜기',
          body: el('p', { class: 'tour-p' }, '이 프로젝트에서 여는 ', b('AI 작업 세션'), '이에요. 팀원별로 모여 보여서 누가 무슨 일을 하고 있는지 한눈에 알 수 있어요.') });
        steps.push({ target: '[data-tour="proj-new-session"]', placement: 'left', advanceOn: 'click',
          title: '세션 만들기 ① — ＋ 새 세션', body: '오른쪽 위 [＋ 새 세션]을 눌러 볼게요.' });
        // #1145 — '내 PC / 웹' 드롭다운은 없어졌다(그 선택은 이제 모달 제목 줄의 pill). 스텝도 함께 걷는다.
        steps.push({ target: '[data-tour="label"]', placement: 'right', scrollIntoView: true,
          title: '만들기 창 — 세션 이름',
          body: el('p', { class: 'tour-p' }, '무슨 일을 하는 세션인지 알아보기 쉽게 이름을 정해요. 여기선 예시로 ', b('“출시 안내 메일 초안”'), ' 을 넣어 뒀어요.') });
        steps.push({ target: '[data-tour="sess-repos"]', placement: 'right', scrollIntoView: true,
          title: '코드 저장소 (선택)',
          body: [
            p('코드 작업이면 저장소를 고르세요. 박스가 그 코드를 자동으로 가져와 준비해 둬요.'),
            el('p', { class: 'tour-p' }, b('코드 작업이 아니면 비워도 돼요.')),
          ] });
        steps.push({ target: '.proj-sess-preset', placement: 'right', scrollIntoView: true,
          title: '실행 설정',
          body: el('p', { class: 'tour-p' }, '함께 일할 ', b('AI·모델'), '과 자동 승인 여부를 고르는 곳이에요. 이전 설정을 기억하니 보통 그대로 둬도 돼요.') });
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
    // #1153 — 구 '도메인 맵' 투어. 그래프가 사라지고 분류 목록이 됐으므로 안내도 '정의를 관리한다'로 다시 썼다.
    key: 'categories', tab: 'categories',
    match: (h: string) => h.startsWith('#/categories'),
    ready: () => !!q('.wikicat'), hint: '.wikicat-row',
    build(ctx: any) {
      const steps: any[] = [];
      steps.push({ target: '.wikicat', padding: 4, title: '회사 기록의 갈래',
        body: [
          el('p', { class: 'tour-p' }, '지식과 프로젝트를 담는 ', b('분류'), '예요. 사업 · 제품 · 시스템 셋으로 나뉘고, 그 아래 필요한 만큼 갈래를 둡니다.'),
          p('제품 아래의 갈래는 코드가 실제로 그 단위로 나뉘어 있어 도메인이라고 불러요.'),
        ] });
      if (q('.wikicat-drift')) steps.push({ target: () => q('.wikicat-drift'), title: '정의가 낡았는지 보기',
        body: el('p', { class: 'tour-p' }, '정의를 마지막으로 고친 날과, ', b('그 뒤 이 갈래에 쌓인 기록 수'), '예요. 숫자가 크면 정의가 현실을 못 따라가고 있다는 신호입니다.') });
      if (q('.wikicat-row-acts')) steps.push({ target: () => q('.wikicat-row-acts'), title: '정의 손보기',
        body: el('p', { class: 'tour-p' }, '[수정]에서 그 갈래가 ', b('무엇을 담고 무엇을 담지 않는지'), '를 적어 둡니다. 이 정의가 AI가 분류를 판단하는 기준이 돼요.') });
      return steps.concat(tail(ctx));
    },
  },
  {
    // #853 '프로젝트 체험' ① — 보드에서 **진짜 프로젝트**를 직접 만든다(손수 하기 — 데모 아님).
    //  '만들기' 저장이 새 프로젝트 상세로 라우팅(projects.ts go(): location.hash='#/projects2/p/<id>')하므로
    //  장면 전환 스텝이 필요 없다 — resume 이 다음 장면(pd-detail)을 이어받는다.
    key: 'pd-create', tab: 'projects2',
    match: (h: string) => h.startsWith('#/projects2') && !h.startsWith('#/projects2/p/'),
    ready: () => !!q('.pjv-board-wrap'),
    build() {
      return [
        { // ＋ 프로젝트 → 인라인 입력(이름) → Enter 로 '새 프로젝트' 창까지. 창이 열리면 자동 진행.
          //  타깃은 입력이 펼쳐지면 입력, 아니면 트리거 — 어느 쪽이든 실존 요소를 짚는다.
          target: () => q('main .pjv-addrow-input') || q('[data-tour="pd-new-project"]'),
          placement: 'top' as const, scrollIntoView: true,
          advanceWhen: () => !!q('.np-form'),
          title: '진짜 프로젝트를 하나 만들어 볼게요',
          body: [
            el('p', { class: 'tour-p' }, '목록 끝의 ', b('[＋ 프로젝트]'), ' 를 누르고, ', b('이름을 입력한 뒤 Enter'), ' 를 치세요.'),
            p('연습이 아니라 진짜로 만들어져요 — 필요 없어지면 나중에 지워도 돼요.'),
          ],
        },
        { // 새 프로젝트 창 — '리스트'만 짚는다(미선택이면 만들기가 막히는 유일한 필수 선택).
          target: () => { const n = q('.ov-back .pjv-listpick'); return n ? (n.closest('.cf-row') || n) : null; },
          placement: 'right' as const, scrollIntoView: true,
          title: '어느 리스트(영역)에 둘까요',
          body: el('p', { class: 'tour-p' }, '프로젝트가 속할 ', b('리스트'), '를 고르세요. 마땅한 게 없으면 ', b('‘기타 (미분류)’'), ' 를 고르면 돼요.'),
        },
        { // 만들기 — 실제 생성. 창이 닫히면(저장 성공) 자동 진행 → 앱이 스스로 상세로 이동해 다음 장면이 이어진다.
          //  advanceOn:'click' 대신 advanceWhen(창 닫힘): 저장 실패(리스트 미선택 토스트)면 창이 남아 [이전]으로
          //  리스트 단계에 되돌아갈 수 있다 — 막다른 길 0.
          target: '[data-tour="pd-create-btn"]', placement: 'top' as const,
          advanceWhen: () => !q('.ov-back'),
          title: '만들기!',
          body: [
            el('p', { class: 'tour-p' }, b('[만들기]'), ' 를 누르면 프로젝트가 생기고, 곧장 그 안으로 들어가요.'),
            p('안 넘어가고 안내가 뜨면 [이전]으로 돌아가 리스트를 골라 주세요.'),
          ],
        },
      ];
    },
  },
  {
    // #853 '프로젝트 체험' ② — 방금 만든 진짜 프로젝트 안에서 손수: 지식 연결 → AI 세션 → 하위 태스크 → 여러 태스크 한 세션에.
    //  둘러보기의 projects-detail(설명형·데모)과 별개 장면 — 이 장면은 project-do 플랜에서만 쓰인다.
    key: 'pd-detail', tab: 'projects2',
    match: (h: string) => h.startsWith('#/projects2/p/') && h.indexOf('__demo__') < 0,
    ready: () => !!q('main .page-head'),
    build() {
      const steps: any[] = [];
      steps.push({ target: 'main .page-head', placement: 'bottom',
        title: '방금 만든 진짜 프로젝트예요',
        body: p('이 안에서 넷을 직접 해볼게요 — 지식 연결 · AI 세션 · 하위 태스크 · 여러 태스크 한 번에 맡기기.') });
      // ① 지식 연결 — 픽커를 열어 실제로 붙여 본다. 창을 닫으면 다음으로.
      if (q('[data-tour="pd-link-kn"]')) {
        steps.push({ target: '[data-tour="pd-link-kn"]', scrollIntoView: true, advanceOn: 'click' as const,
          title: '① 지식 연결',
          body: el('p', { class: 'tour-p' }, '이 일에 필요한 회사 지식(WIKI)을 붙여두면 ', b('AI 가 그걸 알고 시작'), '해요. ', b('[＋ 지식 연결]'), ' 을 눌러 보세요.') });
        steps.push({
          target: () => { const bk = Array.from(document.querySelectorAll('.ov-back')).pop() as any; return bk ? (bk.querySelector('.ov-box') || bk) : null; },
          advanceWhen: () => !q('.ov-back'),
          title: '골라서 [＋ 연결]',
          body: [
            p('추천 목록에서 [＋ 연결]을 누르거나, 검색해서 찾아 연결해 보세요.'),
            p('다 했으면(또는 나중에 하려면) 창을 닫으세요 — 닫히면 다음으로 넘어가요.'),
          ],
        });
      }
      // ② AI 세션 — 실제 생성 폼까지. [만들고 입장]=진짜 생성(새 탭, 이 화면 유지) / [취소]도 허용 — 어느 쪽이든 창이 닫히면 진행.
      if (q('.proj-term-card') && q('[data-tour="proj-new-session"]')) {
        steps.push({ target: '[data-tour="proj-new-session"]', placement: 'left' as const, scrollIntoView: true, advanceOn: 'click' as const,
          title: '② 이 프로젝트에서 AI 켜기',
          body: el('p', { class: 'tour-p' }, '이 프로젝트 맥락(본문·연결된 지식)을 다 아는 ', b('AI 작업 세션'), '을 열 수 있어요. ', b('[＋ 새 세션]'), ' 을 눌러 보세요.') });
        steps.push({ target: '[data-tour="label"]', placement: 'right' as const, scrollIntoView: true,
          title: '세션 이름',
          body: el('p', { class: 'tour-p' }, '무슨 일을 시킬지 알아보기 쉽게 이름을 지어요. 예: ', b('“자료 조사”'), '. 저장소·실행 설정은 필요할 때만 만지면 돼요.') });
        steps.push({ target: '[data-tour="sess-create"]', placement: 'top' as const, scrollIntoView: true,
          advanceWhen: () => !q('.ov-back'),
          title: '만들어 볼까요?',
          body: [
            el('p', { class: 'tour-p' }, b('[만들고 입장]'), ' 을 누르면 진짜 세션이 ', b('새 탭'), '에서 열려요 — 이 화면은 그대로라 체험은 계속돼요.'),
            p('지금은 만들기 싫으면 [취소]로 닫아도 돼요. 창이 닫히면 다음으로 넘어가요.'),
          ],
        });
      }
      // ③ 하위 태스크 — 두어 개 직접 추가(Enter), Tab=하위로 들여쓰기. 2개 이상 생기면 자동 진행.
      if (q('main .pjv-tasks-card')) {
        steps.push({
          target: () => q('main .pjv-tasks-card .pjv-addrow-input') || q('main .pjv-tasks-card [data-tour="pd-add-task"]') || q('main .pjv-tasks-card'),
          scrollIntoView: true,
          advanceWhen: () => document.querySelectorAll('main .pjv-tasks-card .pjv-row-check:not(.pjv-group-check)').length >= 2,
          title: '③ 태스크로 나누기',
          body: [
            el('p', { class: 'tour-p' }, b('[＋ 태스크]'), ' 를 누르고 이름 입력 후 Enter — ', b('두어 개'), ' 만들어 보세요.'),
            el('p', { class: 'tour-p' }, '입력 중 ', b('Tab'), ' 을 누르면 바로 위 태스크의 ', b('하위(서브태스크)'), ' 로 들어가요. 행을 더블클릭해도 하위를 추가할 수 있어요.'),
          ],
        });
        // ④ 여러 태스크 체크 → 하단 바 등장까지.
        steps.push({
          target: () => q('main .pjv-tasks-card'), padding: 4, scrollIntoView: true,
          advanceWhen: () => !!q('.pjv-bulkbar'),
          title: '④ 여러 태스크 골라잡기',
          body: p('태스크 행 왼쪽에 마우스를 올리면 체크박스가 나타나요 — 2개 이상 체크해 보세요.'),
        });
        steps.push({
          target: () => q('.pjv-bulk-run') || q('.pjv-bulkbar'),
          placement: 'top' as const,
          advanceWhen: () => false, // 실행(새 탭)은 실제 클릭으로 — 진행은 [다음]으로(강제 실행 아님)
          title: '한 번에 맡기기 — [클로드로 실행]',
          body: [
            el('p', { class: 'tour-p' }, '선택한 태스크들을 ', b('한 AI 세션에 묶어'), ' 통째로 맡겨요 — 내용·체크리스트까지 함께 전달돼요.'),
            p('눌러 보면 새 탭에서 진짜 실행돼요. 구경만 했으면 [다음]으로.'),
          ],
        });
      }
      steps.push({
        target: () => null, __finale: true, ctaNext: '마치기',
        title: '프로젝트 체험 끝! 🎉',
        body: [
          p('프로젝트 만들기 → 지식 연결 → AI 세션 → 하위 태스크 → 여러 태스크 한 번에 맡기기까지 전부 해봤어요.'),
          p('만든 프로젝트는 진짜예요 — 그대로 이어서 일해도 되고, ⚙ 세부 설정에서 지워도 돼요.'),
        ],
      });
      return steps;
    },
  },
  {
    key: 'wiki', tab: 'knowledge',
    match: (h: string) => h.startsWith('#/knowledge'),
    ready: () => !!q('.kn-side, .wk-home, .wk-cat'), hint: 'main .wk-row, main .wk-doccard',   // #764v2 카드 표면 포함
    build(ctx: any) {
      const steps: any[] = [];
      if (q('.kn-side')) steps.push({ target: '.kn-side', placement: 'right', title: 'AI가 읽는 회사 지식',
        body: '회사의 규칙·결정·자료가 사업·제품·시스템으로 분류돼 쌓여요. 📌 인덱스에 핀된 지식은 매 대화 첫머리에 항상 깔려요.' });
      // 검색 — 사이드바 분류·지식 검색(전문 의미검색은 ⌘K).
      if (q('.kn-side .pjv-side-search')) steps.push({
        target: '.kn-side .pjv-side-search', title: '검색 — AI도 이렇게 찾아요',
        body: '여기서 검색하는 그대로, AI도 일할 때 이 지식을 검색해 꺼내 써요. 잘 쌓일수록 AI가 똑똑해져요.' });
      if (q('main .wk-row, main .wk-doccard')) {
        steps.push({ target: () => q('main .wk-row, main .wk-doccard'), scrollIntoView: true, advanceOn: 'click',
          title: '하나 열어볼까요?', body: '지식을 누르면 오른쪽에 살짝 열려요(피크).' });
        steps.push({ target: '.wk-peek', placement: 'left', title: '지식 한 덩어리',
          body: '제목·본문과 분류·핀 상태를 한눈에 볼 수 있어요. 이 내용이 그대로 AI에게 전달되는 회사 맥락이에요.' });
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

// 속성판(2열 그리드)에서 선행·후속 두 칸만 — 라벨 텍스트로 찾는다(행 순서가 바뀌어도 안전).
//  둘을 배열로 넘기면 엔진이 '합친 사각형' 하나로 뚫는다 → 상태·팀원 등 다른 속성은 딤 아래 그대로(#780).
function edgeFields(): Element[] {
  const hit = (re: RegExp) => {
    for (const f of document.querySelectorAll('.pjv-proj-meta .pjv-tm-field')) {
      const lab = f.querySelector('.pjv-tm-field-label');
      if (lab && re.test(lab.textContent || '')) return f;
    }
    return null;
  };
  return [hit(/선행/), hit(/후속|후행/)].filter(Boolean) as Element[];
}

// 둘러보기 중 사용자가 연 임시 오버레이(세션 만들기 모달·＋새 세션 드롭다운)를 장면이 끝날 때 정리(#761) —
//  탭 이동 스텝(navStep)이 모달에 가려 안 눌리거나, 마무리/이탈 후 잔여 모달이 남지 않게. 지식 피크(.wk-peek)는 건드리지 않는다.
function closeStrayOverlays() {
  document.querySelectorAll('.ov-back, .pjv-pop').forEach((n) => n.remove());
}

// ── 플랜(sessionStorage) — { v, keys: 장면 key 순서, i: 현재 장면 인덱스(-1=시작 전), courses: 이번에 보는 섹션 key } ──
function sceneByKey(k: string) { return SCENES.find((s) => s.key === k) || null; }
function loadPlan() {
  try {
    const p0 = JSON.parse(sessionStorage.getItem(PLAN_KEY) || 'null');
    if (!(p0 && p0.v === 1 && Array.isArray(p0.keys) && p0.keys.length)) return null;
    if (!Array.isArray(p0.courses)) p0.courses = COURSES.map((c) => c.key); // 구 플랜(섹션 정보 없음) = 전체 투어
    return p0;
  } catch (_) { return null; }
}
function savePlan(plan: any) { try { sessionStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch (_) { /* 저장 불가면 단일 장면짜리로 동작 */ } }
function dropPlan() { try { sessionStorage.removeItem(PLAN_KEY); } catch (_) { /* noop */ } }

// 플랜 접기 — ✕/ESC(say=true) 또는 예상 밖 화면 이동(say=false, 조용히).
function foldGuideTour(say: boolean) {
  if (!loadPlan()) return;
  dropPlan();
  if (say) toast('둘러보기를 닫았어요 — 사용 가이드 › Lively 둘러보기에서 원하는 섹션부터 다시 시작할 수 있어요.');
}
// j 번째 장면 뒤에 '다른 탭'의 장면이 남았으면 그 탭(다음 이동처), 없으면 null(=이 장면에서 마무리).
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

// ui_nav 게이팅(#1454 S2) — 씬의 탭이 꺼져 있으면 그 씬은 플랜에서 뺀다. 씬 전환이 '실제 상단 탭 누르기'라
//  숨은 탭의 씬을 남기면 navStep 이 hidden 링크를 스포트라이트하는 막다른 길이 된다.
//  씬 tab → 상단 탭(data-tab) 매핑: 'categories'(구 도메인 맵 씬)는 #/categories 가 #/context 로 리다이렉트되므로
//  context 탭을 따른다. 목록에 없는 tab 은 그대로 navOn 에 묻는다(모르는 값 = 켜짐 — navOn 의 기본 규약).
const NAV_TAB_OF: any = { categories: 'context', domainmap: 'context' };
function sceneNavOn(key: string): boolean {
  const sc = sceneByKey(key);
  if (!sc) return true; // 정의 없는 씬 키(구 플랜 잔재)는 종전처럼 보존 — resume 스캔이 어차피 건너뛴다
  return navOn(NAV_TAB_OF[sc.tab] || sc.tab);
}

// ── 시작(랜딩 버튼) — 플랜 저장 후 첫 스텝(첫 코스의 상단 탭 스포트라이트)만 즉시 띄운다. ──
//  이후 진행은 사용자의 실제 탭 클릭 → 라우팅 → resumeGuideTour 가 이어받는다.
function startGuideTour(courseKeys?: string[]) {
  const courses = courseKeys && courseKeys.length ? COURSES.filter((c) => courseKeys.includes(c.key)) : COURSES;
  const keys = courses.flatMap((c) => c.scenes).filter(sceneNavOn); // 꺼진 탭 씬 스킵(#1454 S2 — ui_nav {} 면 전부 통과)
  if (!keys.length) return;
  savePlan({ v: 1, keys, i: -1, courses: courses.map((c) => c.key) });
  const first = sceneByKey(keys[0]);
  startTour([navStep(first.tab, TAB_LABEL[first.tab] + '부터 볼게요')],
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
  const steps = sc.build({ nextTab: nextTabAfter(cur, j), courses: cur.courses });
  if (!steps.length) return;
  const hasFinale = steps.some((s: any) => s && s.__finale);
  startTour(steps, { onEnd: (r) => {
    closeStrayOverlays(); // 장면 종료 시 잔여 세션 모달·드롭다운 정리(#761)
    if (r === 'user') { foldGuideTour(true); return; }
    // 자연 완주는 마무리 스텝이 있던 장면에서만 의미 — 이동 클릭 직후의 잔여 complete(라우팅 경합)는 무시.
    if (r === 'complete' && hasFinale) finishGuideTour(cur.courses);
  } });
}

// 완료 표시 — 섹션 단위(#780). 세 섹션을 다 봐야 '완주'다(옛 전체완주 타임스탬프는 세 섹션 완료로 읽어 준다).
function doneSections(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DONE_SECTIONS_KEY) || 'null');
    if (Array.isArray(raw)) return raw.filter((k) => typeof k === 'string');
    return localStorage.getItem(DONE_KEY) ? COURSES.map((c) => c.key) : [];
  } catch (_) { return []; }
}
function markSectionsDone(keys: string[]) {
  const merged = [...new Set([...doneSections(), ...keys])];
  try { localStorage.setItem(DONE_SECTIONS_KEY, JSON.stringify(merged)); } catch (_) { /* noop */ }
}
function isSectionDone(key: string) { return doneSections().includes(key); }
function isGuideTourDone() { return COURSES.filter(TOUR_ONLY).every((c) => isSectionDone(c.key)); }

function finishGuideTour(courses: string[]) {
  dropPlan();
  markSectionsDone(courses);
  // #853 '프로젝트 체험'은 둘러보기와 별개 — 완주 시 시작하기 화면으로 복귀(둘러보기 랜딩·완주 문구 안 씀).
  if (courses.length === 1 && courses[0] === 'project-do') {
    toast('프로젝트 체험 완료 — 방금 만든 프로젝트에서 이어서 일해 보세요!');
    location.hash = '#/start/project';
    return;
  }
  const rest = COURSES.filter(TOUR_ONLY).filter((c) => !isSectionDone(c.key));
  toast(rest.length
    ? courses.map(courseLabel).join(' · ') + ' 섹션 완료 — 남은 ' + rest.map((c) => c.label).join(' · ') + ' 섹션도 골라 볼 수 있어요.'
    : 'Lively 둘러보기 완주 — 수고했어요!');
  location.hash = '#/learn/tour'; // 랜딩으로 복귀(섹션 ✓ · 완주 배지)
}

export { COURSES, isGuideTourDone, isSectionDone, resumeGuideTour, startGuideTour };
