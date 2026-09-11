// 복원을 **다시 불러도** 같은 대화를 둘로 만들지 않는다(순수, #3891).
//
// 왜: 복원(`POST …/restore`)은 여러 걸음이다 — desired 행 → 컨테이너 → 판(new-session, 여기서 하네스가 뜬다) → 메타 →
//  뒷정리(이정표·대화 매핑·아웃박스·인스턴스). 그 사이에 요청이 끊기면 **세션은 이미 떠 있는데** 뒷정리가 하나도 안 된다.
//  실측(2026-09-11 08:45:00Z, 매니지드): 롤이 게이트웨이를 SIGTERM 한 15ms 뒤 새 세션의 메타 relay 가 죽었다 —
//  새 세션(Claude Code)은 떠 있고 옛 행은 이정표 없이 «되살릴 수 있음» 으로 남아 목록에 같은 세션이 두 줄 섰다.
//  화면은 실패를 받았으니 사람이 다시 보내면(또는 화면이 다시 물으면) **같은 대화로 세션을 하나 더** 띄웠을 것이다 —
//  한 대화 파일에 하네스 둘이 붙는다.
//
// 규칙: 같은 주인·같은 대화를 **들고 있는** 다른 세션(후보, 최근 순)마다 «살아 있나» 를 확답으로 물어 —
//  · 산 것이 하나라도 있으면 그리로 잇는다(최근 것). 확답이 «모름» 을 이긴다.
//  · 산 것은 없는데 «모름» 이 있으면 **만들지 않는다**(#835 확답 only — 모르면 같은 대화를 둘로 만들지 않는다).
//    단 사람이 force(«그대로 새 세션으로 되살리기»)를 골랐으면 만든다 — 그 선택은 이미 «옛 것이 살아 있을 수도 있음» 을 안다.
//  · 전부 죽었으면(또는 후보가 없으면) 종전대로 새로 만든다.
//  옛 id 자신은 후보가 아니다(자기 자신으로 «이어» 붙이면 이정표가 고리가 된다).
export interface AdoptProbe {
  id: string;
  /** true = 살아 있다(확답) · false = 없다(확답) · null = 모른다(중계 불통·타임아웃) */
  alive: boolean | null;
}

export type AdoptVerdict =
  | { kind: "adopt"; id: string }
  | { kind: "unknown"; id: string }
  | { kind: "none" };

/**
 * 같은 열쇠의 일을 **한 줄로 세운다**(이 프로세스 안에서) — 같은 세션의 복원 요청 둘이 동시에 도는 것을 막는다.
 *
 *  왜 이어 붙이기(adoptVerdict)만으로 모자라나: 새 세션의 판이 **뜨기 전** 창(컨테이너 확보·판 띄우기 — 매니지드에서
 *  수 초)에는 그 세션이 대화로 찾아져도 has-session 이 «없음» 이라 «산 것» 이 아니다. 그 창에 같은 세션의 복원이
 *  하나 더 오면(두 탭 · 터미널 액자와 셸 · 대기 지시의 [강제로 되살리기]) 둘 다 «아무도 안 만들었다» 를 보고 각자
 *  만든다 — 한 대화에 하네스 둘. 줄을 세우면 뒤 요청은 앞 요청이 **끝난 뒤 처음부터 다시 판정**한다: 그때는 이정표
 *  (성공)나 대화 매핑 + 떠 있는 판(끊김)이 이미 있어 그리로 잇는다.
 *  ⚠ 프로세스 안 자물쇠다 — 청/녹 교대 순간의 두 프로세스 사이는 못 막는다(그 창은 짧고, 끊긴 앞 요청의 뒤는 이어 붙이기가 받는다).
 *  ⚠ 앞 일이 던져도 뒤 일은 돈다(자물쇠는 결과와 무관하게 풀린다) · 다 끝나면 열쇠를 지운다(쌓이지 않는다).
 */
export function createKeyedSerializer(): {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  //  열쇠는 **첫 인자**(라우트면 요청)에서 뽑는다 — 인자 모양은 fn 이 정한다.
  wrap<A extends [unknown, ...unknown[]], T>(keyOf: (first: NoInfer<A[0]>) => string, fn: (...args: A) => Promise<T>): (...args: A) => Promise<T>;
  size(): number;
} {
  const tails = new Map<string, Promise<void>>();
  async function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);      // prev 는 resolve 만 하는 사슬이라 거절로 끊기지 않는다
    tails.set(key, tail);
    await prev;
    try { return await fn(); }
    finally { release(); if (tails.get(key) === tail) tails.delete(key); }
  }
  return {
    run,
    wrap: (keyOf, fn) => (...args) => run(keyOf(args[0]), () => fn(...args)),
    size: () => tails.size,
  };
}

/** probes 는 **최근 순**이어야 한다(같은 대화를 여러 세션이 들고 있으면 사람이 마지막으로 쓰던 자리가 갈 곳이다). */
export function adoptVerdict(oldId: string, probes: readonly AdoptProbe[], force: boolean): AdoptVerdict {
  const others = probes.filter((p) => !!p.id && p.id !== oldId);
  const live = others.find((p) => p.alive === true);
  if (live) return { kind: "adopt", id: live.id };
  const unknown = others.find((p) => p.alive === null);
  if (unknown && !force) return { kind: "unknown", id: unknown.id };
  return { kind: "none" };
}
