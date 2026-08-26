// 노드 링크 이력으로 "왜 안 붙어 있나"를 추정한다 (#1849 ③).
//
// 왜: 화면은 지금 "이 노드가 연결돼 있지 않습니다" 한 줄로 끝난다. 사용자는 원인도 조치도 알 수 없다
//  (2026-08-23 상민님: "이거 왜그럼?" — 답을 찾는 데 게이트웨이 로그 24시간치를 사람이 grep 해야 했다).
//  그런데 **게이트웨이는 이미 답을 갖고 있다** — 연결/해제 이력의 모양이 곧 원인이다.
//
// 잠자기의 지문: **짧게 붙었다 곧 끊기고, 한참 뒤 다시 붙는 것의 반복.**
//  근거는 우리 코드에 있다 — 재연결 백오프 상한은 30초다(reconnect-delay.ts `BACKOFF_MAX_MS`, #1865 로
//  그 파일로 옮겨졌고 초기 구간은 오히려 더 촘촘해졌다: 12회까지 최대 5초). 프로세스가 살아서 깨어 있으면
//  **30초(지터 포함 36초) 안에** 다시 붙는다. 그러므로 수 분 이상의 공백은 "그 머신이 네트워크에서 사라진 상태"다.
//  ⚠ 이 관계는 아래 LONG_GAP_MS 의 근거이므로 **테스트로 대조한다**(sleep-pattern.test.ts D19) — 백오프가
//   또 바뀌면 임계값 근거가 조용히 무너지는데, 그걸 사람이 알아챌 방법이 없다.
//  실측(`haruui-macbookair`): 연결 유지 56~64초 · 공백 3583~3591초(≈1시간) — macOS 유지보수 깨어남 창.
//
// ★ 이건 **추정**이다. 단정하지 않는다 — 게이트웨이 재배포·네트워크 장애도 비슷한 모양을 만들 수 있다.
//  그래서 반환에 근거 수치를 함께 실어, 화면이 "왜 그렇게 봤는지"까지 말하게 한다.
//
// 순수함수다(now 를 인자로 받는다) — 시계에 의존하면 이 판정은 테스트할 수 없고, 테스트 못 하는 판정은
//  사용자에게 원인을 단언하는 자리에 둘 수 없다.

export type LinkEv = "up" | "down";
export interface LinkEvent { at: number; ev: LinkEv }

/** 분석 창 — 이보다 오래된 이벤트는 지금 상태를 설명하지 못한다. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** '짧은 연결' 임계 — 이 **미만**이면 짧다. 실측 56~64초를 넉넉히 덮되, 정상 재시작(수 분)과는 갈린다. */
export const SHORT_UP_MS = 180_000;
/** '긴 공백' 임계 — 이를 **초과**하면 길다. 재연결 백오프 상한(30초)의 10배 — 프로세스가 깨어 있으면 나올 수 없다. */
export const LONG_GAP_MS = 300_000;
/** 판정에 필요한 최소 완결 구간 수 — 2회는 우연일 수 있다. */
export const MIN_CYCLES = 3;
/** 지금 이만큼 붙어 있으면 과거 이력으로 경고하지 않는다 — 이미 해결된 문제를 경고하면 그게 거짓말이다. */
export const HEALTHY_UP_MS = 30 * 60 * 1000;

export interface LinkDiagnosis {
  /** 추정 원인. null = 판정 없음(정상이거나 표본 부족). */
  suspected: "sleep" | null;
  /** 아래 셋은 화면이 근거를 말하기 위한 값 — 판정이 없어도 채운다(진단 화면에서 그대로 보여줄 수 있게). */
  cycles: number;        // 창 안의 완결 연결 구간 수
  medianUpSec: number;   // 연결 유지 중앙값(초)
  medianGapSec: number;  // 공백 중앙값(초)
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};

/**
 * 연결/해제 이벤트에서 잠자기 패턴을 추정한다.
 *
 * @param events  임의 순서로 들어와도 된다(내부에서 정렬한다 — 호출부의 쿼리 순서에 판정이 좌우되면 안 된다).
 * @param now     기준 시각(ms). 순수성을 위해 반드시 주입받는다.
 */
export function diagnoseLink(events: readonly LinkEvent[], now: number): LinkDiagnosis {
  const empty: LinkDiagnosis = { suspected: null, cycles: 0, medianUpSec: 0, medianGapSec: 0 };
  if (!Number.isFinite(now)) return empty;

  // 창 안 + 시간순. 시계 역행(now 가 과거)이나 미래 이벤트는 걸러진다 — at > now 는 계산을 음수로 만든다.
  const evs = [...events]
    .filter((e) => e && Number.isFinite(e.at) && e.at <= now && now - e.at <= WINDOW_MS)
    .sort((a, b) => a.at - b.at);
  if (!evs.length) return empty;

  // up→down 쌍 걷기. 방어적으로:
  //  · down 이 먼저 오면(창 경계에 잘림) 버린다 — 시작을 모르는 구간의 길이는 지어낼 수 없다.
  //  · up 이 연달아 오면(해제 유실) **앞의 up 을 버린다** — 뒤의 것이 실제로 이어진 연결이다.
  const ups: number[] = [];    // 완결 연결 구간 길이(ms)
  const gaps: number[] = [];   // 공백 길이(ms) = 이전 down → 다음 up
  let openAt: number | null = null;
  let lastDown: number | null = null;
  for (const e of evs) {
    if (e.ev === "up") {
      if (openAt !== null) { /* 해제 유실 — 앞 up 버림 */ }
      else if (lastDown !== null) gaps.push(e.at - lastDown);
      openAt = e.at;
      continue;
    }
    if (openAt === null) continue;          // 창 경계의 고아 down
    ups.push(e.at - openAt);
    openAt = null;
    lastDown = e.at;
  }

  // 지금 열려 있는 구간(마지막 up 이 안 닫힘) — 완결 구간에 넣지 않는다(아직 얼마나 갈지 모른다).
  //  다만 **충분히 오래 붙어 있으면 판정을 접는다**: 지금 멀쩡한데 과거 이력으로 경고할 이유가 없다.
  const openMs = openAt !== null ? now - openAt : null;

  const out: LinkDiagnosis = {
    suspected: null,
    cycles: ups.length,
    medianUpSec: Math.round(median(ups) / 1000),
    medianGapSec: Math.round(median(gaps) / 1000),
  };
  if (openMs !== null && openMs >= HEALTHY_UP_MS) return out;
  if (ups.length < MIN_CYCLES) return out;

  const shortUps = ups.filter((ms) => ms < SHORT_UP_MS).length;
  const longGaps = gaps.filter((ms) => ms > LONG_GAP_MS).length;
  // 과반 = 절반 초과(정확히 절반은 아니다 — 반반이면 그건 패턴이 아니라 잡음이다).
  if (shortUps * 2 > ups.length && longGaps >= 2) out.suspected = "sleep";
  return out;
}
