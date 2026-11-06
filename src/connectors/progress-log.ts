// 커넥터 진행 로그 — 러너(run-tracker.ts)의 정체 감지는 «출력이 끊긴 시간»만 본다. 그래서 오래 도는 백필은
//  진행하는 동안 스스로 살아있음을 찍어야 한다. 안 찍으면 멀쩡히 적재 중인 run 도 행 걸림으로 보고 죽이고,
//  커서가 안 올라 다음 run 이 처음부터 다시 돌다 또 죽는다(gitlab 초기 백필 · gdrive 첫 수집이 이렇게 끝나지 않았다).

/** 진행 로그 최소 간격. 러너의 정체 감지(무출력 15분)보다 훨씬 짧게 둬서, 큰 범위를 훑는 동안에도 살아있음이 드러나게 한다. */
export const PROGRESS_LOG_INTERVAL_MS = 15_000;

/**
 * 마지막 출력 이후 간격이 지났을 때만 찍는 진행 로그.
 * 항목마다 찍으면 로그가 못 쓰게 되고, 안 찍으면 러너가 정체로 보고 죽인다 — 그래서 '건수'가 아니라 '시간'으로 조인다.
 * 진행이 있을 때만 부르게 둬야 한다: 진짜 행(fetch 정지)에는 침묵해야 정체 감지가 제 할 일을 한다.
 */
export function makeProgressLogger(
  intervalMs: number = PROGRESS_LOG_INTERVAL_MS,
  // 벽시계(Date.now)는 NTP step 으로 뒤로 갈 수 있고, 그러면 역행 폭만큼 로그가 통째로 억제된다 — 정체 오판이 다시 열린다.
  // 단조 증가하는 시계를 쓰면 그 경우가 설계상 존재하지 않는다.
  now: () => number = () => performance.now(),
  emit: (msg: string) => void = (m) => console.log(m),
): (msg: string, force?: boolean) => void {
  let last: number | null = null;
  /** force 는 간격을 무시하고 찍되 **타이머도 갱신한다** — 경계 로그 직후의 잔줄까지 쏟아지지 않게. */
  return (msg, force = false) => {
    const t = now();
    if (!force && last !== null && t - last < intervalMs) return;
    last = t;
    emit(msg);
  };
}
