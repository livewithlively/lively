// 웹터미널 attach 워커 배치 — **순수 라우팅 장부**(I/O 없음, 테스트 대상). (#2228 1단계 · C안 + K 노브)
//
// ── 왜 이 파일이 따로 있나 ────────────────────────────────────────────────────
// C안(소켓 fd 를 워커로 이관)의 유일한 노브는 **K = 워커 하나가 담당하는 세션 수**다. 그런데 이
//  프로젝트의 진짜 난점은 `liveTerms`·`attachRefs` 가 **프로세스 전역**이라, 워커가 여럿이면
//  그 장부가 쪼개져 「마지막 WS」(detachGhostClients 의 발동 조건)를 못 센다는 것이었다(#2148).
//
// 해법은 **끈끈한 배치(sticky)**다 — **한 세션의 모든 attach 는 항상 같은 워커로** 보낸다. 그러면
//  그 세션의 attachRefs 는 그 워커 안에 온전히 모여, 「마지막 WS」 판정이 워커별로 정확해진다.
//  즉 sticky 라우팅이 장부 분열 문제를 구조적으로 없앤다. 이 파일이 그 sticky 불변식을 지킨다.
//
// ── 불변식 ────────────────────────────────────────────────────────────────────
//  (1) 세션 id 가 어떤 워커에 매핑돼 있으면, 그 매핑이 풀리기 전까지 **반드시 같은 워커**로 간다.
//  (2) 매핑은 딱 두 경우에만 풀린다 — 그 세션의 마지막 WS 가 닫혀 워커가 'session-empty' 를 알릴 때,
//      또는 워커가 죽어 그 워커의 세션 전체가 한꺼번에 떨어질 때(dropWorker). 두 경우 모두 **살아 있는
//      attach 가 없는 시점**이라, 그 뒤 같은 세션이 다른 워커로 새로 붙어도 유령 정리와 겹치지 않는다.
//  (3) K 는 **서로 다른 세션 수**의 상한이다. 이미 매핑된 세션은 K 와 무관하게 자기 워커로 간다
//      (그 세션은 이미 슬롯을 차지하고 있다). 새 세션만 size<K 인 워커를 찾고, 없으면 새 워커가 필요하다.
//
// 워커를 실제로 띄우는 것은 I/O 라 host 의 몫이고, 여기서는 pid(문자열/숫자 토큰)만 다룬다 —
//  그래서 자식 프로세스 없이 이 로직 전부를 단위 테스트할 수 있다.

export type WorkerKey = number; // 워커 프로세스 pid (host 가 pid→child 를 따로 안다)

export interface Placement {
  /** 이 세션을 보낼 워커. null = 받을 워커가 없다 → host 가 새로 띄워 assign() 해야 한다. */
  worker: WorkerKey | null;
  /** 이미 이 세션을 담당하던 워커였나(sticky 재사용). false = 새 배정. */
  sticky: boolean;
}

/** K 파싱 — env 문자열 → 정수 상한. 미설정/0/off/음수/오류 = 0(=비활성). "inf"/"∞" = Infinity(B 모드, 워커 1개). */
// #2599 T2 — 파서는 그 env 의 **유일한 소유자**(exec-topology)로 옮겼다. 여기 두면 이 파일도 «env 를 읽는 자리»가 되기 쉽다.
//  이름은 그대로 재수출한다(호출부·기존 시험 무변경).
export { parseWorkerK } from "../exec-topology.js";

export class AttachRouter {
  /** 서로 다른 세션 수의 워커당 상한. Infinity = 워커 1개에 전부(B 모드). */
  readonly k: number;
  private readonly sessionWorker = new Map<string, WorkerKey>();
  private readonly workerSessions = new Map<WorkerKey, Set<string>>();

  constructor(k: number) { this.k = k; }

  /** host 가 워커를 띄운 직후(또는 재사용 결정 후) 이 세션↔워커 매핑을 확정한다. */
  assign(id: string, worker: WorkerKey): void {
    this.sessionWorker.set(id, worker);
    let set = this.workerSessions.get(worker);
    if (!set) { set = new Set(); this.workerSessions.set(worker, set); }
    set.add(id);
  }

  /**
   * 이 세션을 어느 워커로 보낼지 고른다(할당은 아직 — host 가 실제 워커 확보 후 assign 한다).
   *  - 이미 매핑돼 있고 그 워커가 후보 목록(alive)에 있으면 → sticky 재사용.
   *  - 아니면 size<K 인 alive 워커 중 **가장 덜 찬** 것.
   *  - 그것도 없으면 worker:null(=새 워커 필요).
   */
  pick(id: string, aliveWorkers: readonly WorkerKey[]): Placement {
    const alive = new Set(aliveWorkers);
    const mapped = this.sessionWorker.get(id);
    if (mapped !== undefined && alive.has(mapped)) return { worker: mapped, sticky: true };
    // 새 세션 — size<K 인 워커 중 가장 덜 찬 것(고른 분산). K=Infinity 면 첫 워커가 늘 통과 → 단일 워커.
    let best: WorkerKey | null = null;
    let bestSize = Infinity;
    for (const w of aliveWorkers) {
      const size = this.workerSessions.get(w)?.size ?? 0;
      if (size < this.k && size < bestSize) { best = w; bestSize = size; }
    }
    return { worker: best, sticky: false };
  }

  /** 세션의 마지막 WS 가 닫혀 워커가 'session-empty' 를 알릴 때 — 매핑만 푼다(워커는 그대로 살아 다른 세션을 본다). */
  releaseSession(id: string): void {
    const w = this.sessionWorker.get(id);
    if (w === undefined) return;
    this.sessionWorker.delete(id);
    const set = this.workerSessions.get(w);
    if (set) { set.delete(id); if (set.size === 0) this.workerSessions.delete(w); }
  }

  /** 워커가 죽었다(exit/error) — 그 워커의 세션 매핑을 **한꺼번에** 떨군다. 그 세션들은 다음 attach 때 재배정된다. */
  dropWorker(worker: WorkerKey): string[] {
    const set = this.workerSessions.get(worker);
    if (!set) return [];
    const ids = [...set];
    for (const id of ids) if (this.sessionWorker.get(id) === worker) this.sessionWorker.delete(id);
    this.workerSessions.delete(worker);
    return ids;
  }

  workerForSession(id: string): WorkerKey | undefined { return this.sessionWorker.get(id); }
  sessionCount(worker: WorkerKey): number { return this.workerSessions.get(worker)?.size ?? 0; }
  isIdle(worker: WorkerKey): boolean { return this.sessionCount(worker) === 0; }
  totalSessions(): number { return this.sessionWorker.size; }
}
