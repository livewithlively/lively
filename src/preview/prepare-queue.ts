// 미리보기 준비(합치기·설치·빌드)의 줄 — 한 번에 N개(기본 1)만 돌린다 (#4119, 2026-09-21).
//
// 왜 줄이 필요한가: 준비는 게이트웨이의 자식 프로세스로 돈다(preview-prepare.runCmd 의 spawn). 그래서 빌드의
//  메모리가 **게이트웨이와 같은 systemd 유닛 한도**(매니지드 lvly-gw@ = MemoryMax 2GiB)에 잡힌다. 종전엔 주기
//  점검(preview_reconcile, 5분)이 자동 합치기 stage 일곱을 **한꺼번에** 다시 빌드했고, 빌드 프로세스 35개가
//  10초 만에 한도를 채웠다 → 커널이 게이트웨이 본체까지 스왑으로 밀어내 게이트웨이가 1~4분씩 통째로 멈췄다
//  (새 세션 «여는 중…» 1분+ · 노드 링크 끊김 · /healthz 30초 무응답 실측). 빌드 하나(~0.5GB)는 게이트웨이 옆에
//  들어가지만 일곱은 안 들어간다 — 그래서 수를 센다.
//
// 같은 키(미리보기 id)는 줄에 한 번만 선다: 같은 워크트리에서 설치·빌드가 두 벌 돌면 서로를 깨뜨린다
//  (preview-envs 의 PREPARE_STUCK_MS 주석이 적은 그 사고). 사람이 누른 준비는 줄 **앞**에 세운다 —
//  [띄우기]를 누른 사람이 자동 갱신 여섯 개 뒤에서 기다리게 두지 않는다.

export interface PrepareQueue {
  /**
   * 줄에 세운다. 이미 줄에 있거나 도는 중인 키면 새로 세우지 않고 false —
   *  단 `front` 이고 아직 기다리는 중이면 줄 맨 앞으로 옮긴다(사람이 누른 것이 자동 갱신 뒤에 묻히지 않게).
   */
  schedule(key: string, job: () => Promise<void>, opts?: { front?: boolean }): boolean;
  /** 이 키가 줄에 있거나 도는 중인가 */
  has(key: string): boolean;
  /** 지금 도는 수 · 기다리는 수(진단·시험용) */
  stats(): { active: number; waiting: number };
}

export function createPrepareQueue(concurrency: number, onError?: (key: string, err: unknown) => void): PrepareQueue {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const waiting: Array<{ key: string; job: () => Promise<void> }> = [];
  const inflight = new Set<string>(); // 기다리는 것 + 도는 것
  let active = 0;
  const pump = (): void => {
    while (active < limit && waiting.length) {
      const next = waiting.shift()!;
      active++;
      // job 이 동기로 throw 해도 줄이 멈추지 않게 then 안에서 부른다.
      Promise.resolve().then(next.job)
        .catch((e) => { try { onError?.(next.key, e); } catch { /* 보고 실패가 줄을 멈추면 안 된다 */ } })
        .finally(() => { active--; inflight.delete(next.key); pump(); });
    }
  };
  return {
    schedule(key, job, opts = {}) {
      if (inflight.has(key)) {
        if (opts.front) {
          const i = waiting.findIndex((w) => w.key === key);
          if (i > 0) waiting.unshift(...waiting.splice(i, 1));
        }
        return false;
      }
      inflight.add(key);
      if (opts.front) waiting.unshift({ key, job }); else waiting.push({ key, job });
      pump();
      return true;
    },
    has: (key) => inflight.has(key),
    stats: () => ({ active, waiting: waiting.length }),
  };
}

// 동시 실행 수 — 기본 1. 게이트웨이 유닛 한도(2GiB)에 빌드 하나(~0.5GB)가 게이트웨이(~0.3GB)·세션 중계(~0.4GB)
//  옆에 들어가는 수가 1이다. 한도가 넉넉한 설치는 LVLY_PREVIEW_PREPARE_CONCURRENCY 로 올린다(상한 8).
export function prepareConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.LVLY_PREVIEW_PREPARE_CONCURRENCY ?? ""), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 1;
}
