// lib/share-guide-rules.ts — «누가 무엇을 보나요» 안내(#5598)의 순수 규칙: 단계 문구 · 워크스페이스 설정 → 갈래 · 자동으로 띄워도 되는 자리.
//  DOM · api 를 물지 않는 잎 모듈이다 — 시험(src/v6/share-guide.test.ts)이 소스를 옮겨 직접 부른다. 화면은 v2/share-guide.ts.
/** 다시 보기 주소. */
export const SHARE_GUIDE_ROUTE = /^#\/share-guide(?:[/?]|$)/;

export type ProjMode = 'invite' | 'open' | 'all';
export const I = (id: string): string => `<svg class="sg-ic"><use href="#sg-i-${id}"/></svg>`;

export interface Step {
  scene: string;
  title: (m: ProjMode) => string;
  lead: (m: ProjMode) => string;
  extra?: () => string;
}
/** (순수) 단계 문구 — 안내 팝업(2026-11-22): 1~4장은 개념(AI 세션 · 프로젝트 · 자료 · 지식), 5장만 «누가 볼 수 있나» 이고
 *  워크스페이스의 프로젝트 공개 방식에 따라 갈린다. 시험이 이 표를 직접 읽는다. */
export const SG_STEPS: Step[] = [
  {
    scene: 's1',
    title: () => 'AI 세션은 AI와 일하는 대화창이에요',
    lead: () => 'AI에게 일을 시키는 대화창 하나가 <strong>AI 세션</strong> 하나예요. 연 대화창은 왼쪽 목록에 쌓여서, 언제든 다시 열어 이어서 시킬 수 있어요.',
  },
  {
    scene: 's2',
    title: () => '프로젝트는 한 가지 일을 모아 두는 곳이에요',
    lead: () => '같은 일을 하는 AI 세션과 AI가 만든 파일은 <strong>프로젝트</strong> 하나에 모여요. 처음 일을 시키면 프로젝트가 자동으로 생겨요.',
  },
  {
    scene: 's3',
    title: () => '자료는 AI가 읽는 회사의 글과 파일이에요',
    lead: () => '연결한 슬랙 · 노션 · 드라이브, 내가 올린 파일, AI가 만든 파일이 모두 <strong>자료</strong>예요. AI는 일할 때 여기서 필요한 것을 찾아 읽어요.',
  },
  {
    scene: 's4',
    title: () => '지식은 AI가 정리해 둔 메모예요',
    lead: () => 'AI가 자료를 읽고 알게 된 것을 짧게 정리해 둔 글이 <strong>지식</strong>이에요. 다음에 비슷한 일을 시키면 AI가 이 메모부터 꺼내 봐요.',
    extra: () => `<span class="sg-more-wrap" data-sg="more-wrap"><button type="button" class="sg-more" data-sg="more" aria-expanded="false">${I('help')}지식으로 남기기 싫을 때는?</button></span>`,
  },
  {
    scene: 's5',
    title: () => '누가 무엇을 볼 수 있나요',
    lead: (m) => (m === 'invite'
      ? 'AI 세션과 프로젝트는 <strong>나와 내가 초대한 사람만</strong>,<br>자료와 지식은 <strong>팀 전원</strong>이 봐요.'
      : 'AI 세션은 <strong>나와 내가 초대한 사람만</strong>,<br>프로젝트 · 자료 · 지식은 <strong>팀 전원</strong>이 봐요.'),
    extra: () => '<p class="sg-note">쓰다가 이 대화창에서만 라이블리를 끄려면 AI에게 <code>/lively-disconnect</code>를 입력하세요.</p>',
  },
];

/** (순수) 워크스페이스 설정 → 5장(누가 보나) 갈래. 못 읽으면 초대제(새 프로젝트 기본값)로 본다. */
export function projModeOf(access: { mode?: string; enforced?: boolean } | null | undefined): ProjMode {
  if (!access) return 'invite';
  if (access.enforced === false) return 'all';
  return access.mode === 'open' ? 'open' : 'invite';
}

/** (순수) 지금 주소에서 첫 안내를 자동으로 띄워도 되나 — 지나가는 자리에선 띄우지 않는다. */
export function shareGuideAutoAllowed(hash: string): boolean {
  return !/^#\/(welcome|activate|full|app-grant|app-open|share-guide)(?:[/?]|$)/.test(hash || '');
}

/** 온보딩 영상(기초)을 창으로 띄울지 정하는 재료 — liv-profile 이 돌려주는 칸. 옛 서버는 새 칸을 주지 않는다(undefined). */
export interface FilmFacts {
  share_guide_seen_at?: string | null;
  welcome_film_due_at?: string | null;
  welcome_film_seen_at?: string | null;
}
/**
 * (순수) 온보딩 영상(기초)을 지금 창으로 띄울까(#5598, 상민 2026-11-24 — 처음 설정의 영상과 셸의 안내 카드가 자리를 바꿨다).
 *  · 처음 설정 인사 장면의 안내 카드를 끝까지 넘긴 사람(due)에게, 아직 띄운 적이 없을 때(seen 없음) 한 번.
 *  · due 가 없는 사람(이 변경 전부터 쓰던 구성원)에게는 띄우지 않는다 — 영상은 [사용 가이드] 에서 본다.
 *  · 안내 카드를 아직 확인하지 않았으면 그 카드 팝업이 먼저다 — 창은 한 번에 하나.
 *  · 지나가는 자리(처음 설정 · 앱 전체 화면 · 승인)에서는 띄우지 않는다 — 셸로 돌아온 뒤에.
 */
export function welcomeFilmAutoDue(p: FilmFacts | null | undefined, hash: string): boolean {
  if (!p || !p.welcome_film_due_at || p.welcome_film_seen_at) return false;
  if (!p.share_guide_seen_at) return false;
  return shareGuideAutoAllowed(hash);
}

