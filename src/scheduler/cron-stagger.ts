// 시각형(cron_expr) 잡의 고정 지연 — 같은 분에 걸린 잡들이 같은 틱에 한꺼번에 뜨지 않게 흩는다. 순수 leaf.
//
//  왜: 사람은 `0 * * * *` · `*/30 * * * *` · `0 9 * * 1` 처럼 정각을 습관적으로 쓴다. due 판정(cron-due.ts)은
//   분 단위라 그런 잡들이 같은 틱에 함께 뜬다. 한 운영 환경에서 켜진 시각형 잡의 실행 분을 세니 :00 에 16개,
//   :30 에 5개가 몰려 있었다. 운영자가 시각을 손으로 흩어도 새로 만드는 잡은 다시 정각으로 등록되므로 플랫폼이 기본으로 흩는다.
//
//  · 결정적이다 — 오프셋은 잡 id 의 해시로만 정한다. 재기동·노드가 바뀌어도 같은 잡은 같은 시각에 돈다.
//  · 시각형 반복 잡에만 쓴다. 주기형(interval_sec)은 위상이 last_run 에서 나오므로 여기서 흩을 축이 없다.
//    1회성(run_once)과 즉시 실행(runCronById)은 «그 시각에·지금» 이 뜻이라 지연을 넣지 않는다.
//  · 끄기: CRON_STAGGER_SEC=0. 값의 해석은 cronStaggerSec.
import { parseCron } from "./cron-expr.js";

/**
 * 기본 흩뜨림 폭(초).
 *  인프로세스 틱 간격(engine.ts 의 TICK_MS)이 판정 해상도라, 같은 틱 창에 든 오프셋끼리는 여전히 함께 뜬다.
 *  그래서 폭은 틱 여러 개에 걸쳐야 뜻이 있고(이 값이면 정각 무리가 3~4개 틱으로 나뉜다), 동시에
 *  «9시 잡은 9시 언저리에 돈다» 는 기대를 깨지 않게 2분 안쪽으로 둔다.
 */
export const CRON_STAGGER_DEFAULT_SEC = 90;

/**
 * 크론 틱이 가장 성길 때의 간격(초) — 매니지드에서 CP 가 HTTP 로 부르는 틱 격자다(실측 기록은 cron-due.ts 머리말).
 *  지연의 상한을 이 값으로 잡는다(cronStaggerOffsetMs). CP 틱이 더 성기게 바뀌면 이 값도 함께 올려야
 *  짧은 주기 잡이 회차를 건너뛰지 않는다.
 */
export const COARSEST_TICK_SEC = 300;

/**
 * 틱이 제때 안 오는 몫(초) — 상한에서 틱 간격과 함께 뺀다.
 *  틱이 정확히 COARSEST_TICK_SEC 마다 온다고 보면 간격이 그보다 조금 긴 식(6분마다 등)에도 지연을 주게 되는데,
 *  그 틱이 몇 초만 늦어도 지연 + 늦음이 간격을 넘어 회차를 건너뛴다(6분마다 도는 잡에 지연 37~40초 · 5분 틱이
 *  7번에 한 번 60초 늦으면 6시간에 두세 회차를 건너뛴다 — cron-due.test.ts 표 G1b). CP 틱의 늦음이 이보다 커지면 이 값도 올린다.
 */
export const TICK_JITTER_SEC = 60;

/** 흩뜨림 폭(초). 비었거나 숫자가 아니거나 음수면 기본값, 0 이면 끔. */
export function cronStaggerSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CRON_STAGGER_SEC;
  if (raw == null || raw.trim() === "") return CRON_STAGGER_DEFAULT_SEC;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : CRON_STAGGER_DEFAULT_SEC;
}

// FNV-1a 32bit — 의존성 없이 결정적이고 짧은 id 에서도 고르게 퍼진다. 암호 강도는 필요 없다.
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 연속한 두 매치 사이 간격(초)의 하한 — 분 필드만 보고 정한다.
 *  분 값이 하나면 매치는 한 시간에 최대 한 번이라 3600. 여럿이면 이웃한 분 값의 차와 시간 경계를 넘는 차
 *  (60 − 마지막 + 처음) 중 작은 것. 시·일·월·요일 필드는 간격을 늘릴 수만 있어 하한을 바꾸지 않는다.
 */
export function cronMinGapSec(minutes: Iterable<number>): number {
  const v = [...minutes].sort((a, b) => a - b);
  if (v.length <= 1) return 3600;
  let gap = 60 - v[v.length - 1] + v[0];
  for (let i = 1; i < v.length; i++) gap = Math.min(gap, v[i] - v[i - 1]);
  return gap * 60;
}

/**
 * 이 잡의 고정 지연(ms) — [0, min(spreadSec, 최소 간격 − COARSEST_TICK_SEC − TICK_JITTER_SEC)) 초. 0 이하로 접히면 지연 없음.
 *
 *  ★ 상한의 이유: cronDue 는 «last_run_at 이후 첫 매치 + 지연» 으로 판정하고 last_run_at 은 실행 **시작** 시각이다.
 *   실행은 due 뒤 첫 틱에 시작하므로 last_run_at ≈ 매치 + 지연 + 틱 늦음(< 틱 간격)이다. 이 합이 다음 매치에 닿으면
 *   last_run_at 이 그 매치 분으로 넘어가 그 회차를 건너뛴다(5분 틱에서 5분마다 도는 잡에 80초를 주면 10분에 한 번만 돈다).
 *   지연 < 간격 − 틱 − 틱 늦음 이면 합이 간격을 넘지 않는다. 그래서 간격이 6분 이하인 잡(매분·5분마다 등)은 흩지 않는다.
 *  ★ 반대로 «last_run_at − 지연» 을 기준으로 다음 매치를 찾으면 이 상한이 필요 없지만, 기능을 켜는 순간 직전 회차를
 *   지연 없이 돈 모든 잡이 그 회차를 아직 안 돈 것으로 읽혀 한 번씩 다시 돈다. 그 길은 택하지 않았다.
 *  잘못된 식은 0 — 판정은 cronDue 가 «아님» 으로 따로 접는다.
 */
export function cronStaggerOffsetMs(id: string, expr: string, spreadSec: number): number {
  if (!(spreadSec > 0)) return 0;
  let minutes: Set<number>;
  try { minutes = parseCron(expr).min; } catch { return 0; }
  const span = Math.min(Math.floor(spreadSec), cronMinGapSec(minutes) - COARSEST_TICK_SEC - TICK_JITTER_SEC);
  if (span <= 0) return 0;
  return (fnv1a32(id) % span) * 1000;
}
