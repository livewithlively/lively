// 수집 실행의 «결과 판정» 두 가지 — DB·네트워크 무의존 순수 leaf (#3994 T2-a).
//  ① 크론이 그 tick 을 성공으로 적을 것인가(syncBatchStatus)
//  ② 부모가 재시작했을 때 살아 있는 자식을 어떻게 할 것인가(orphanVerdict)
//
//  왜 순수로 빼나 — 이 둘은 «조용한 실패» 가 태어나는 자리다. 호출부에 인라인으로 있으면 조건이
//  슬그머니 바뀌어도 아무도 모른다. 조건 조합을 표로 고정해 둔다(sync-outcome.test.ts).

/** runConnectorSync 가 타깃마다 summary 에 넣는 항목의 관측 가능한 모양. */
export interface SyncTargetOutcome {
  ok?: unknown;
  skipped?: unknown;
}

/**
 * 수집 tick 의 잡 상태 — 하나라도 실패면 error.
 *
 *  ⚠ 종전엔 타깃 실패를 summary 에 담고도 무조건 "ok" 를 반환했다. 그 값이 org_cron.last_status 가 되고
 *   연속실패 서킷브레이커는 status 로만 판정하므로 **영원히 트립하지 않았다**(파이프라인 화면도 초록).
 *   15분마다 강제 종료되는 수집기가 무기한 정상으로 보이던 자리다.
 *
 *  · 타깃이 0개면 ok — 켜진 수집기가 없는 것은 실패가 아니다.
 *  · `skipped:"already_running"` 은 ok — 이미 도는 중이고 기다리면 풀린다(정상 배압).
 *    단 그건 **ok 가 참일 때만** 이다. 실패에 붙은 skipped 를 정상으로 접지 않는다.
 *  · ok 가 비었거나(undefined) 항목이 객체가 아니면 **실패로 본다** — 모르는 결과를 정상으로 적지 않는다.
 */
export function syncBatchStatus(items: readonly unknown[] | null | undefined): "ok" | "error" {
  if (!items || !items.length) return "ok";
  for (const it of items) {
    if (!it || typeof it !== "object") return "error";
    if ((it as SyncTargetOutcome).ok !== true) return "error";
  }
  return "ok";
}

export interface OrphanInput {
  /** connector_run.pid — 없으면(NULL) 확인할 수단이 없다. */
  pid: number | null | undefined;
  /** 그 pid 가 지금 살아 있고 **이 수집의** run-sync 인가(명령줄 검증 결과). */
  aliveAndOurs: boolean;
}

export interface OrphanVerdict {
  /** run 행을 error 로 닫을 것인가. */
  close: boolean;
  /** 그 pid 를 죽일 것인가. */
  kill: boolean;
  /** 살아 있는 실행을 그대로 이어받을 것인가(행을 running 으로 둔다). */
  adopt: boolean;
}

/**
 * 부모(게이트웨이)가 재시작했을 때 남아 있는 running 행을 어떻게 할 것인가.
 *
 *  ★ 종전엔 무조건 «error 로 닫고 pid kill 시도» 였다. 그런데 수집 자식은 부모와 함께 죽지 않는다
 *   (정상 종료 핸들러의 정리 대상이 아니고 detached 도 아니다). kill 이 빗나가면 그 자식이 완주해
 *   **커서를 전진시키는데 run 행은 이미 error** 인 스플릿브레인이 났다.
 *
 *  살아 있으면 죽이지 말고 이어받는다(내구성 — 넘겨받기). 죽일 때는 죽었음을 확인하고 죽인다.
 *  pid 가 남의 프로세스면(재사용) 닫되 **건드리지 않는다**.
 */
export function orphanVerdict(inp: OrphanInput): OrphanVerdict {
  if (inp.aliveAndOurs) return { close: false, kill: false, adopt: true };
  return { close: true, kill: false, adopt: false };
}

/** 자식이 자기 생존을 적는 주기 — 유령 판정 임계보다 충분히 짧아야 한다(임계의 1/2 이하). */
export function childHeartbeatMs(staleMs: number): number {
  const half = Math.floor(staleMs / 2);
  //  ⚠ 하한이 임계를 넘으면 안 된다 — 넘으면 살아 있는 자식이 첫 하트비트를 찍기도 전에 유령으로
  //   판정된다(이 변경이 막으려던 바로 그 사고를 하한 상수가 다시 만든다). 그래서 하한도 half 를 넘지 않는다.
  return Math.max(1_000, Math.min(30_000, half));
}
