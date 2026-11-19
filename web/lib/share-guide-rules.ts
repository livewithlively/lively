// lib/share-guide-rules.ts — «누가 무엇을 보나요» 안내(#5598)의 순수 규칙: 단계 문구 · 워크스페이스 설정 → 갈래 · 자동으로 띄워도 되는 자리.
//  DOM · api 를 물지 않는 잎 모듈이다 — 시험(src/v6/share-guide.test.ts)이 소스를 옮겨 직접 부른다. 화면은 v2/share-guide.ts.
/** 다시 보기 주소. */
export const SHARE_GUIDE_ROUTE = /^#\/share-guide(?:[/?]|$)/;

export type ProjMode = 'invite' | 'open' | 'all';
export const I = (id: string): string => `<svg class="sg-ic"><use href="#sg-i-${id}"/></svg>`;
export const B = {
  sess: `<span class="sg-bd sg-what">${I('chat')}AI 세션</span>`,
  proj: `<span class="sg-bd sg-what">${I('folder')}프로젝트</span>`,
  know: `<span class="sg-bd sg-what">${I('know')}지식</span>`,
  priv: `<span class="sg-bd sg-priv">${I('lock')}비공개</span>`,
  pub: `<span class="sg-bd sg-pub">${I('globe')}전체 공개</span>`,
  off: `<span class="sg-bd sg-off">${I('power')}라이블리 꺼짐</span>`,
};

export interface Step {
  scene: string;
  badges: (m: ProjMode) => string;
  title: (m: ProjMode) => string;
  lead: (m: ProjMode) => string;
  extra?: () => string;
}
/** (순수) 단계 문구 — 워크스페이스의 프로젝트 공개 방식에 따라 2장만 달라진다. 시험이 이 표를 직접 읽는다. */
export const SG_STEPS: Step[] = [
  {
    scene: 's1', badges: () => B.sess + B.priv,
    title: () => 'AI와 나눈 대화는 기본으로 비공개예요',
    lead: () => 'AI와 나누는 대화 하나하나를 <strong>AI 세션</strong>이라고 불러요. AI 세션은 기본으로 <strong>비공개</strong>예요. 다른 사람이 보길 원하면 세션에서 <strong>[공유]</strong>를 눌러 초대하세요.',
  },
  {
    scene: 's2', badges: (m) => B.proj + (m === 'invite' ? B.priv : B.pub),
    title: (m) => (m === 'invite' ? '세션은 프로젝트로 묶이고, 프로젝트도 비공개예요' : '세션은 프로젝트로 묶이고, 프로젝트는 팀에 공개돼요'),
    lead: (m) => 'AI 세션을 열면 <strong>프로젝트</strong>가 자동으로 생기고, 같은 일을 이어 하는 세션은 그 프로젝트로 묶여요. '
      + (m === 'invite'
        ? '프로젝트도 기본으로 <strong>비공개</strong>라, 보여 주려면 초대하세요. 단, 프로젝트에 초대받은 사람도 <strong>남이 만든 세션 안은 볼 수 없어요.</strong>'
        : m === 'open'
          ? '이 워크스페이스는 프로젝트를 팀과 함께 보는 방식이라, 결과를 남긴 프로젝트는 <strong>팀 전원</strong>이 봐요. 그래도 <strong>남이 만든 세션 안은 볼 수 없어요.</strong>'
          : '이 워크스페이스는 프로젝트를 <strong>팀 전원</strong>이 봐요. 그래도 <strong>남이 만든 세션 안은 볼 수 없어요.</strong>'),
  },
  {
    scene: 's3', badges: () => B.know + B.pub,
    title: () => '지식은 자동으로 만들어지고, 모두에게 공유돼요',
    lead: () => 'AI는 일하다가 팀에 쓸모 있는 결론·결정·방법을 얻으면 <strong>지식</strong>으로 저장해요. 이때 내 질문이나 대화를 그대로 옮기지 않고, <strong>누가 읽어도 같은 형식의 문서로 다시 써요.</strong> 지식은 <strong>팀 전원에게 자동으로 공유</strong>되고, 대화 원문은 공유되지 않아요.',
    extra: () => `<span class="sg-more-wrap" data-sg="more-wrap"><button type="button" class="sg-more" data-sg="more" aria-expanded="false">${I('help')}지식으로 남기기 싫을 때는?</button></span>`,
  },
  {
    scene: 's4', badges: () => B.sess + B.off,
    title: () => '쓰다가 라이블리를 끄고 싶으면 /lively-disconnect',
    lead: () => 'AI를 쓰다가 <strong>이 세션에서만</strong> 라이블리를 끄고 싶으면 AI에게 <code>/lively-disconnect</code>를 입력하세요. 그때부터 이 세션은 기록되지 않고, 회사 자료도 쓰지 않아요. 다시 켜려면 <code>/lively-connect</code>예요.',
  },
  {
    scene: 's5', badges: () => '',
    title: () => '한눈에 보기',
    lead: () => '',
    extra: () => '<p class="sg-note">연결한 앱(슬랙·노션 등)에서 가져온 자료는 원래 볼 수 있던 사람만 봐요. 남는 기록은 회사의 라이블리 서버에 저장돼요.</p>',
  },
];

/** (순수) 워크스페이스 설정 → 2장 갈래. 못 읽으면 초대제(새 프로젝트 기본값)로 본다. */
export function projModeOf(access: { mode?: string; enforced?: boolean } | null | undefined): ProjMode {
  if (!access) return 'invite';
  if (access.enforced === false) return 'all';
  return access.mode === 'open' ? 'open' : 'invite';
}

/** (순수) 지금 주소에서 첫 안내를 자동으로 띄워도 되나 — 지나가는 자리에선 띄우지 않는다. */
export function shareGuideAutoAllowed(hash: string): boolean {
  return !/^#\/(welcome|activate|full|app-grant|app-open|share-guide)(?:[/?]|$)/.test(hash || '');
}

