// 수집 실행의 «결과 판정» 두 가지 — DB·네트워크 무의존 순수 leaf (#3994 T2-a).
//  ① 크론이 그 tick 을 성공으로 적을 것인가(syncBatchStatus)
//  ② 부모가 재시작했을 때 살아 있는 자식을 어떻게 할 것인가(orphanVerdict)
//
//  왜 순수로 빼나 — 이 둘은 «조용한 실패» 가 태어나는 자리다. 호출부에 인라인으로 있으면 조건이
//  슬그머니 바뀌어도 아무도 모른다. 조건 조합을 표로 고정해 둔다(sync-outcome.test.ts).

/**
 * 자식 CLI(run-sync/run-push/run-wiki-push)의 진단 한 줄 — stdout 에서 뽑는다.
 *
 *  🔴 **실패 경로에서도 이걸 담아야 한다.** 커넥터 CLI 는 pino 로 **stdout** 에 찍고 실패 시 exit(1) 하므로
 *   execFile 이 던지는 에러의 `message` 엔 stderr(비어 있다)만 실린다 → 잡 요약이
 *   `Command failed: node … dist/connectors/run-push.js clickup` 한 줄로 끝나, 원인이 필요한 바로 그 순간에
 *   진단이 사라진다(연속 실패로 크론이 자동 정지했을 때 관리 화면에 볼 것이 없었다).
 *   execFile 에러 객체는 `stdout`/`stderr` 를 실어 주므로, 문자열이든 그 객체든 같은 방식으로 뽑는다.
 *
 *  마지막 줄은 «완료 요약»(건수)이라 실패했다는 사실만 말한다. **왜** 실패했는지는 그 앞의 warn/error 줄에만
 *   있으므로(pino level 40=warn·50=error·60=fatal) 있으면 함께 담는다. pino 의 err 직렬화는 stack 을 통째로
 *   싣기 때문에 그 줄엔 상한을 둔다 — 잡 요약 컬럼이 로그 저장소가 되지 않게.
 */
export function childTail(x: unknown): string {
  const raw = typeof x === "string" ? x
    : typeof (x as { stdout?: unknown } | null)?.stdout === "string" ? (x as { stdout: string }).stdout
    : "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const last = lines[lines.length - 1]!;
  const why = [...lines].reverse().find((l) => l !== last && /"level":\s*[456]\d/.test(l));
  return why ? `${why.slice(0, 1000)} | ${last}` : last;
}

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
 *    `skipped:"capacity"`(#3994 T3 — 판 자리 없음, 행을 안 만들었다)도 같다.
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

/**
 * 판 실행(#3994 T3)의 «살아 있나» — orphanVerdict 의 aliveAndOurs 자리에 들어가는 입력.
 *
 *  판(게이트웨이 밖 일시 유닛)에는 pid 가 없다(run 행의 pid 가 비어 있다). 대신 판 안 추적기가 1.5초마다 **자기 행에**
 *   박동을 찍으므로, 박동이 곧 생존 증거다 — 게이트웨이가 몇 번 재시작해도 박동은 안 멈춘다.
 *  · 박동이 임계 안이면 산 것이다(판에 묻지 않는다).
 *  · 박동이 끊겼으면 판에 물어 **살아 있다고 답할 때만** 산 것이다. 모르면(op 에 못 닿음) 죽은 것으로 본다 —
 *    «모름» 을 «삶» 으로 접으면 행이 영원히 running 으로 남아 그 수집기의 다음 실행이 막힌다(유령 정리도 같은 기준이다).
 */
export function unitRunAlive(i: { quietMs: number; staleMs: number; unitLive: boolean | null }): boolean {
  if (Number.isFinite(i.quietMs) && i.quietMs <= i.staleMs) return true;
  return i.unitLive === true;
}

/** 자식이 자기 생존을 적는 주기 — 유령 판정 임계보다 충분히 짧아야 한다(임계의 1/2 이하). */
export function childHeartbeatMs(staleMs: number): number {
  const half = Math.floor(staleMs / 2);
  //  ⚠ 하한이 임계를 넘으면 안 된다 — 넘으면 살아 있는 자식이 첫 하트비트를 찍기도 전에 유령으로
  //   판정된다(이 변경이 막으려던 바로 그 사고를 하한 상수가 다시 만든다). 그래서 하한도 half 를 넘지 않는다.
  return Math.max(1_000, Math.min(30_000, half));
}
