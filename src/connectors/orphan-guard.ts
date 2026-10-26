// 부모(게이트웨이)를 잃은 수집 자식의 뒷일(#5012).
//
//  ★ 왜: 셀프호스트에서 수집은 게이트웨이의 자식 프로세스로 돌고, 로그는 부모가 쥔 파이프로 나간다. 게이트웨이가
//   재시작되면 부팅 스윕은 «살아 있는 수집 자식을 이어받는다» 고 적지만(run-tracker recoverOrphanConnectorRuns),
//   자식은 다음 로그 한 줄에서 **EPIPE 로 죽었다** — 위시스트 실측(2026-10-26 09:00 UTC): 노션 첫 수집이 페이지
//   1,080개를 받은 채 업데이트 재시작 1분 뒤 사라졌다. 맥미니 재현: 오류 처리기가 없으면 `uncaught EPIPE` → exit 70,
//   있으면 끝까지 돌고 exit 0.
//   살아남아도 끝 기록을 남길 부모가 없어 행은 running 으로 남고, 다음 실행 때 유령으로 닫혔다(완주했는데 error).
//
//  그래서 이 모듈이 세 가지를 맡는다(부모가 살아 있는 동안은 아무것도 하지 않는다 — 기록은 종전대로 부모 몫).
//   1. 파이프 오류를 삼킨다 — 로그를 못 내보내는 것이 수집을 멈출 이유가 아니다.
//   2. 부모가 사라진 뒤의 로그 줄을 run 행에 직접 이어 쓴다(화면의 실행 로그가 끊기지 않게).
//   3. 끝날 때 run 행을 직접 닫는다(ok/error · 요약 stats) — running 행에만 쓴다(부모가 이미 닫았으면 건드리지 않는다).
import { runStatsFromLog } from "./sync-outcome.js";

/** run 행 갱신 — 실제로는 itemsPool.query. 테스트는 가짜를 넣는다. */
export type RunWrite = (sql: string, params: unknown[]) => Promise<unknown>;

export interface OrphanGuardOpts {
  runId: number;
  write: RunWrite;
  /** 로그 꼬리 상한(문자) — run-tracker 의 LOG_CAP 과 같아야 한다. */
  logCap: number;
  /** 감시할 출력 — 기본 process.stdout · process.stderr. */
  streams?: NodeJS.WriteStream[];
  /** 지금 부모 pid — 기본 process.ppid 를 읽는다(부모가 죽으면 init/systemd 로 바뀐다). */
  ppid?: () => number;
  /** 버퍼를 run 행에 내보내는 주기(ms). */
  flushMs?: number;
}

export interface OrphanGuard {
  /** 부모를 잃었나. */
  gone(): boolean;
  /** 부모를 잃은 뒤 모인 로그를 run 행에 쓴다(비었으면 아무것도 안 한다). */
  flush(): Promise<void>;
  /** 부모를 잃었을 때만 한 줄을 run 행 로그에 남긴다 — pino 는 파이프가 끊기면 조용히 로그를 끊어(pino/lib/tools.js
   *  filterBrokenPipe) 요약·실패 줄이 사라진다. 그 줄은 호출부가 여기로도 넘긴다. */
  note(line: string): void;
  /** 끝 기록 — 부모를 잃었을 때만 run 행을 닫는다. */
  finish(exitCode: number): Promise<void>;
  /** 타이머 해제(테스트·정상 종료). */
  stop(): void;
}

export const ORPHAN_NOTE = "\n[sync] 게이트웨이가 재시작돼 추적 부모가 없다 — 수집 자식이 이어서 돌고 로그·끝 기록을 직접 남긴다.";

export function installOrphanGuard(o: OrphanGuardOpts): OrphanGuard {
  const streams = o.streams ?? [process.stdout, process.stderr];
  const readPpid = o.ppid ?? (() => process.ppid);
  const ppid0 = readPpid();
  let gone = false;
  let buf = "";   // 부모를 잃은 뒤의 출력 — 다음 flush 가 run 행에 붙인다
  let log = "";   // 부모를 잃은 뒤 쓴 전부(요약 stats 를 꺼낼 재료) — 꼬리만 둔다

  const markGone = (): void => {
    if (gone) return;
    gone = true;
    buf += ORPHAN_NOTE + "\n";
  };
  const capture = (chunk: unknown): void => {
    if (!gone) return;
    const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    buf += s;
    log = (log + s).slice(-o.logCap);
  };

  for (const s of streams) {
    // 1 — 파이프가 끊긴 뒤의 쓰기 오류는 비동기 'error' 로도, 동기 throw 로도 온다(pino 의 동기 쓰기). 둘 다 삼킨다.
    s.on("error", (e: NodeJS.ErrnoException) => { if (e?.code === "EPIPE" || e?.code === "ERR_STREAM_DESTROYED") markGone(); });
    const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
    (s as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]): boolean => {
      capture(a[0]);
      if (gone) return true; // 부모가 없다 — 내보낼 곳이 없으니 run 행 버퍼로만 간다
      try { return orig(...a); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") { markGone(); capture(a[0]); return true; }
        throw e;
      }
    };
  }

  const flush = async (): Promise<void> => {
    if (!buf) return;
    const chunk = buf;
    buf = "";
    await o.write(
      `UPDATE connector_run SET log = right(log || $2, ${Math.floor(o.logCap)}), log_total = log_total + char_length($2::text)
       WHERE id=$1 AND status='running'`, [o.runId, chunk]).catch(() => { buf = chunk + buf; }); // 다음 주기에 다시
  };

  // 2 — 쓰기가 없어도 부모가 바뀐 것으로 안다(조용한 구간에 재시작되면 EPIPE 가 아직 안 났다).
  const timer = setInterval(() => {
    if (!gone && readPpid() !== ppid0) markGone();
    if (gone) void flush();
  }, o.flushMs ?? 3_000);
  timer.unref();

  return {
    gone: () => gone,
    flush,
    note(line: string): void { if (gone) capture(line.endsWith("\n") ? line : line + "\n"); },
    async finish(exitCode: number): Promise<void> {
      if (!gone && readPpid() !== ppid0) markGone();
      if (!gone) return; // 부모가 살아 있다 — 끝 기록은 부모 몫(종전 그대로)
      await flush();
      const stats = runStatsFromLog(log);
      await o.write(
        `UPDATE connector_run SET status=$2, exit_code=$3, finished_at=now(), stats=$4::jsonb WHERE id=$1 AND status='running'`,
        [o.runId, exitCode === 0 ? "ok" : "error", exitCode, stats == null ? null : JSON.stringify(stats)]).catch(() => undefined);
    },
    stop: () => clearInterval(timer),
  };
}
