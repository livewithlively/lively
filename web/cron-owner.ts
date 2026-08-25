// cron-owner.ts — 크론 잡의 '주인 화면' 한 곳(#1618 후속).
//
//  왜 필요한가: 크론 액션 20종 중 절반 이상이 **다른 화면에 주인이 있다**. 증류 잡은 [맥락 관리 ▸ 증류]가,
//   수집 싱크는 수집기가, 미리보기 회수는 [미리보기]가 소유한다. 그런데 [자동화]의 스케줄 표는 그 사실을
//   말하지 않아서, 표에서 `distill-sources-headless` 를 본 사람은 "여기서 고쳐도 되나, 전용 화면이 따로
//   있나"를 알 수 없었다. 반대로 주인 화면만 아는 사람은 표에 그 잡이 왜 또 있는지 모른다.
//
//  왜 '이관'이 아니라 '표기'인가: 스케줄 표는 임의 액션으로 잡을 만드는 **저수준 도구**라 없앨 수 없고
//   (도메인맵 6종·범용 3종은 주인 화면이 아예 없다), 파이프라인 잡만 빼면 '전체 스케줄을 한눈에'가 깨진다.
//   그래서 양쪽에 두되 **어느 쪽이 정본인지 화면이 말하게** 한다.
//
//  ⚠ 이 표가 유일한 출처다. 화면마다 따로 적으면 자동화 표와 단계 카드가 서로 다른 말을 하게 되고,
//   그건 아무 말도 안 하는 지금보다 나쁘다(사람이 둘 중 뭘 믿을지 판단해야 한다).
//  ⚠ 새 액션을 CRON_ACTION_ALLOWLIST 에 추가할 때 주인 화면이 있으면 여기도 한 줄 늘린다. 없으면 그냥 둔다 —
//   **주인이 없는 것을 억지로 만들지 마라.** 그 잡은 스케줄 표가 곧 주인이다.

export interface CronOwner {
  /** 사람이 읽는 자리 이름 — 화면 라벨 그대로(내부 키·액션명 금지). */
  label: string;
  /** 그 화면으로 가는 해시 경로. 없으면 이 화면 안(서브탭 등)이라 링크가 무의미한 경우. */
  href?: string;
  /** 그 화면에서 하면 무엇이 더 나은지 — 왜 굳이 옮겨 가는지 한 줄로. */
  why: string;
}

// 액션 → 주인 화면. 여기 없는 액션은 주인이 없다(스케줄 표가 곧 주인).
const OWNERS: Record<string, CronOwner> = {
  // 수집 — 잡의 주인은 '수집기' 자체다. 수집기를 켜면 서버가 싱크 잡을 만들고 켜며, 끄면 같이 멈춘다
  //  (syncCollectorJob). 그래서 이 잡만 손으로 끄면 '수집기는 켜져 있는데 싱크는 안 도는' 어긋난 상태가 된다.
  //  ⚠ 단 그 짝은 **현행 수집기 잡(`collector-<id>`)에만** 성립한다 — 구 커넥터 축(`sync-<시스템>`)은
  //   수집기가 아니라 org_connector 가 소유하므로 같은 문장을 붙이면 거짓말이 된다(아래 cronOwner 가 가른다).
  connector_sync: {
    label: '맥락 관리 ▸ 수집', href: '#/context/sources/collectors',
    why: '수집기를 켜고 끄면 이 잡도 함께 맞춰집니다. 여기서 잡만 끄면 수집기는 켜진 채 싱크만 멈춥니다.',
  },
  connector_push: {
    label: '맥락 관리 ▸ 수집', href: '#/context/sources/collectors',
    why: '우리 편집을 외부로 되돌려 보내는 잡입니다 — 대상 수집기와 함께 보는 편이 낫습니다.',
  },
  // 증류·분류·관리 — 단계 화면의 [언제 도나] 카드가 만들기·켜고끄기·주기·의뢰자를 함께 다룬다.
  distill_sources: {
    label: '맥락 관리 ▸ 증류', href: '#/context/knowledge/distillers',
    why: '증류기 설정과 밀린 자료를 함께 보면서 주기·의뢰자를 정할 수 있습니다.',
  },
  distill_sources_headless: {
    label: '맥락 관리 ▸ 증류', href: '#/context/knowledge/distillers',
    why: '증류기 설정과 밀린 자료를 함께 보면서 주기·의뢰자를 정할 수 있습니다.',
  },
  classify_knowledge: {
    label: '맥락 관리 ▸ 분류', href: '#/context/topics/classifiers',
    why: '분류기·분류축과 미분류 잔량을 함께 보면서 정할 수 있습니다.',
  },
  classify_knowledge_headless: {
    label: '맥락 관리 ▸ 분류', href: '#/context/topics/classifiers',
    why: '분류기·분류축과 미분류 잔량을 함께 보면서 정할 수 있습니다.',
  },
  run_managers: {
    label: '맥락 관리 ▸ 관리', href: '#/context/checks/managers',
    why: '어떤 관리기가 켜져 있는지, 무엇이 발견됐는지와 함께 볼 수 있습니다.',
  },
  // 위키 아웃바운드 — 지식이 외부(노션 피드)로 나가는 경로. 발행 게이트(카테고리 매핑)가 그 화면에 있다.
  //  ⚠ 이건 '맥락 관리 ▸ 전달'로 옮기지 않기로 했다(2026-08-12) — 전달은 '지식이 AI 에게 닿는 경로'로
  //   좁게 두고, 사람·외부 도구로 나가는 경로는 데이터 연결에 남긴다.
  wiki_push: {
    label: '데이터 연결 ▸ 위키 아웃바운드(피드)', href: '#/system/feed-targets',
    why: '어떤 카테고리를 어디로 내보낼지(발행 게이트)가 거기 있습니다 — 매핑이 없으면 이 잡은 아무 일도 하지 않습니다.',
  },
  preview_reconcile: {
    label: 'AI 능력 ▸ 미리보기', href: '#/system/preview-envs',
    why: '회수 대상인 미리보기 환경 목록을 함께 볼 수 있습니다.',
  },
  // 상시 세션 keep-alive — 주인은 이 화면의 다른 서브탭이다. 링크 대신 자리만 알려준다.
  ensure_managed_sessions: {
    label: '이 화면 ▸ 상시 에이전트',
    why: '보장할 세션 목록이 옆 탭에 있습니다 — 등록된 상시 세션이 없으면 이 잡은 아무 일도 하지 않습니다.',
  },
};

/**
 * 이 잡을 소유한 화면. 없으면 null(= 스케줄 표가 곧 주인 — 도메인맵·범용 잡).
 *
 * jobId 를 함께 받는 이유: **같은 액션에 두 계보가 있는 경우**가 있다. `connector_sync` 는 현행
 *  수집기 소유(`collector-<id>`)와 구 커넥터 축(`sync-<시스템>`)이 같은 액션을 쓴다. 화면은 같지만
 *  '왜 거기서 하냐'는 다르다 — 구 방식 잡은 수집기와 짝지어져 있지 않아서 "수집기를 켜고 끄면 함께
 *  맞춰진다"가 거짓이 된다. 액션만 보고 한 문장을 붙이면 그 거짓이 화면에 뜬다(실측: sync-clickup 행).
 */
export function cronOwner(action: string | null | undefined, jobId?: string | null): CronOwner | null {
  const base = (action && OWNERS[action]) || null;
  if (!base) return null;
  if (action === 'connector_sync' && jobId && !/^collector-\d+(-full)?$/.test(jobId)) {
    return { ...base, why: '수집은 그 화면에서 관리합니다. 이 잡은 수집기 이전의 구 방식이라 수집기와 짝지어져 있지 않습니다 — 지금 쓰는 수집기를 보려면 그리로 가세요.' };
  }
  return base;
}
