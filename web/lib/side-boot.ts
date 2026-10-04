// 사이드바 목록은 **정본을 받은 뒤에만** 그린다(#3870).
//
//  원준 2026-10-04 신고: "새로고침하면 사이드바에 무슨 기준인지 모르겠는데 로딩이 덜 됐을 때 로딩이 된 뒤의 사실과
//   다른 프로젝트나 세션 이름이 쭉 뜨는데 이상해".
//  2026-08-27(#2234)에도 같은 신고가 있었다: "앱 로드될 때 처음에 … 사이드바에 나와있는 세션명이 얼토당토안잖아."
//
//  셸은 데이터를 받기 전에 사이드바 골격을 먼저 그린다(main.ts — 빈 화면을 오래 두지 않으려고). 그런데 그 첫 판이
//   골격이 아니라 **목록**이었다 — 세션·프로젝트 목록은 아직 비어 있는데(data.loadedAt = 0) 재료는 이 브라우저가
//   기억하던 것뿐이라, 화면이 모르는 것을 아는 것처럼 말했다(매니지드 실측 2026-10-04, 목록 응답을 6초 늦춰 봄):
//   · 홈 — 저장돼 있던 창(탭 줄은 안 그리므로 사람은 그런 게 있는 줄도 모른다, 최대 12개)이 전부 「오늘」 아래 줄로
//     선다. 이름은 창을 연 순간의 스냅샷·브라우저 기억이고, 소속은 「AI 세션」·「프로젝트 #4528」, 지운 세션도 선다.
//     0.9초~수 초 뒤 정본이 오면 이름·소속·묶음·순서가 통째로 바뀌고 일부 줄은 사라진다.
//     창이 하나도 없으면 「앱 0 · 열린 앱이 없어요」 — 300개가 넘게 있는데도.
//   · 세션 목록 — 「전체 0 · 아직 세션이 없어요. 홈에서 무엇이든 시켜 보세요.」
//   · 프로젝트 — 「전체 0 · 아직 리스트가 없어요.」
//  #2028 · #2022 · #2234 는 그 첫 판의 이름을 **덜 틀리게** 만들었다(이름 기억 · 인스턴스 먼저 · 응답 빠르게).
//   그래도 받기 전의 그림은 추측이고, 추측은 맞을 때도 틀릴 때도 있다 — 사람은 그걸 구분할 수 없다.
//  ⇒ 받기 전에는 **목록 · 숫자 · «없어요» 안내를 아예 그리지 않는다.** 그 자리엔 이름처럼 안 보이는 막대만 둔다.
//   문패 · 구역 머리 · 발치처럼 데이터 없이도 참인 것은 그대로 먼저 선다.
//
//  ⚠ 판정은 «한 번이라도 받았나» 다 — 받은 뒤의 실패한 폴링은 직전 목록을 그대로 쓰므로(main.ts loadData) 다시
//   막대로 돌아가지 않는다.
//  ⚠ **첫 판이 실패한 것은 받은 것이 아니다.** 종전 loadData 는 요청이 전부 실패해도 끝나며 loadedAt 을 찍었다 — 그 값으로
//   가르면 게이트웨이를 막 배포한 직후(요청이 몇 초 실패하는 창 — 사람이 «새로고침» 하는 바로 그때)에 저장돼 있던 창의
//   줄이 「프로젝트 #4528」 · 「세션 7a856c」 같은 폴백 이름으로 도로 선다(매니지드 실측, 목록 응답 셋을 끊고 새로고침).
//   그래서 loadedAt 은 아래 sideTruthVerdict 가 «그려도 된다» 고 할 때만 찍힌다. 그동안 막대 아래에 못 받았다고 말한다.
//  ⚠ 그렇다고 막대에 가두지 않는다 — 어느 축이 계속 실패하는 환경(권한 · 옛 서버)에서 목록이 영영 안 서면 그게 더 큰
//   고장이다. 세 판 · 15초(SIDE_BOOT_GIVEUP_*)를 기다려도 다 못 받으면 가진 것으로 그린다(종전 동작으로 물러난다).

/** 목록의 정본(세션 · 프로젝트)을 한 번이라도 받았나 — 못 받았으면 목록도 숫자도 빈 안내도 그리지 않는다. */
export function sideTruthReady(d: { loadedAt?: number | null } | null | undefined): boolean {
  return !!d && Number(d.loadedAt) > 0;
}

/** 목록의 이름 · 소속 · 줄 · 숫자를 만드는 다섯 축 — 각각 **한 번이라도 성공해 받았나**. */
export interface SideTruthAxes {
  projects: boolean;   // 프로젝트 이름(없으면 「프로젝트 #12」)
  lists: boolean;      // 프로젝트 사이드바의 리스트(없으면 «아직 리스트가 없어요»)
  sessions: boolean;   // 살아 있는 세션(없으면 저장돼 있던 창의 옛 이름)
  logs: boolean;       // 지난 세션 기록(없으면 지난 세션 줄이 통째로 빠진다)
  instances: boolean;  // 내가 목록에 둔 것 · 치운 것(없으면 치운 세션이 「오늘」 아래 섰다가 이 축이 오면 사라진다)
}

/** 다 못 받은 채 이만큼 판이 끝나고 **이만큼 시간도 지나면** 가진 것으로 그린다 — 첫 판 + 8초 폴링 두 번(약 16초).
 *  판 수만 세면 안 된다: loadData 는 폴링 말고도 클릭 · 스트림 · 세션 생성에서 불려, 배포 직후 같은 창에선 몇 초 만에 세 판이 찬다. */
export const SIDE_BOOT_GIVEUP_ROUNDS = 3;
export const SIDE_BOOT_GIVEUP_MS = 15_000;

/**
 * 받은 축 · 끝난 loadData 판 수 · 첫 판이 끝난 뒤 흐른 시간으로 «이제 목록을 그려도 되나» 를 가른다.
 *  · ready  — 다섯 축을 다 받았다.
 *  · wait   — 아직 못 받은 축이 있다. 막대를 두고 다음 판을 기다린다.
 *  · giveup — 기다릴 만큼 기다렸다(판 수와 시간 둘 다). 가진 것으로 그린다(막대에 가두지 않는다).
 */
export function sideTruthVerdict(seen: SideTruthAxes, rounds: number, waitedMs: number): 'ready' | 'wait' | 'giveup' {
  if (seen.projects && seen.lists && seen.sessions && seen.logs && seen.instances) return 'ready';
  return rounds >= SIDE_BOOT_GIVEUP_ROUNDS && waitedMs >= SIDE_BOOT_GIVEUP_MS ? 'giveup' : 'wait';
}

/**
 * 판정을 판마다 이어 가는 작은 장부 — 셸(main.ts loadData)이 판이 끝날 때마다 note 를 부른다.
 *  **한 번 «그려도 된다» 가 되면 되돌아가지 않는다**: 그 뒤의 실패한 폴링은 직전 목록을 그대로 쓰므로 막대로 돌아갈 이유가 없다.
 */
export interface SideTruth {
  /** 한 판이 끝났다 — 지금까지 받은 축과 지금 시각. 돌려주는 값이 그 판의 data.loadedAt(받았나) · loadFailed(못 받았나)의 재료다. */
  note(seen: SideTruthAxes, now: number): { ready: boolean; failed: boolean };
  ready(): boolean;
}
export function createSideTruth(): SideTruth {
  let rounds = 0, firstAt = 0, ok = false;
  return {
    note(seen, now) {
      rounds++;
      if (!firstAt) firstAt = now;
      if (!ok && sideTruthVerdict(seen, rounds, now - firstAt) !== 'wait') ok = true;
      return { ready: ok, failed: !ok };
    },
    ready: () => ok,
  };
}

/** 받기 전 자리 표시 막대의 폭(%) — 줄 수가 곧 배열 길이다. 길이를 달리해 «불러오는 중» 으로 읽히게 한다. */
export const SIDE_BOOT_BARS: readonly number[] = [68, 52, 80, 60, 44, 72];
