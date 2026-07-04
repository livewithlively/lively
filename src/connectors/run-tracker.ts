// 커넥터 실행(run) 추적 — #586. "지금 싱크"가 동기 HTTP 로 긴 full 백필을 기다리다 프록시 504 를 뱉던 것을
// 실행 단위 엔티티(connector_run)로 바꾼다: 시작은 즉시 응답(run id), 서브프로세스의 stdout/stderr 는
// DB(log)로 스트리밍, 상태·통계·소요시간을 기록해 웹에서 진행/로그를 본다.
//
//   · 스케줄러(connector_sync)와 웹 "지금 싱크"가 같은 경로를 탄다 — 크론은 done 을 await(잡 상태 기록),
//     웹은 run_id 만 받고 폴링으로 로그를 본다.
//   · 중복 방지: 같은 system 의 running 행이 있으면 새로 안 띄우고 그 run 을 돌려준다(스케줄러 인메모리 락은
//     프로세스 내부용 — REST 와 크론이 섞여도 이 DB 가드가 겹침을 막는다).
//   · 로그는 tail 400KB 로 캡(right) — 대형 백필도 행이 비대해지지 않게. 전체 관측이 필요하면 stats·검증기.
//   · 게이트웨이 재시작으로 고아가 된 running 행은 다음 시작 시 error 로 정리(2시간 기준).
import { spawn } from "node:child_process";
import { itemsPool } from "../items/store.js";
import { logger } from "../log.js";

const LOG_CAP = 400_000;          // connector_run.log tail 캡(문자)
const FLUSH_MS = 1500;            // 로그 flush 주기
const FLUSH_BYTES = 16_384;       // 즉시 flush 임계
const TIMEOUT_MS_DEFAULT = 300_000;
const TIMEOUT_MS_NOTION = 1_800_000; // 재귀 트래버스 + 3rps — full 백필 여유(#551)

let schemaReady: Promise<void> | null = null;
function ensureRunSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = itemsPool.query(`
      CREATE TABLE IF NOT EXISTS connector_run(
        id BIGSERIAL PRIMARY KEY,
        system TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'incremental',
        trigger TEXT NOT NULL DEFAULT 'cron',
        status TEXT NOT NULL DEFAULT 'running',
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        exit_code INT,
        stats JSONB,
        log TEXT NOT NULL DEFAULT '',
        started_by TEXT);
      CREATE INDEX IF NOT EXISTS connector_run_system_idx ON connector_run(system, started_at DESC);
    `).then(() => undefined);
  }
  return schemaReady;
}

export interface StartRunResult {
  runId: number;
  alreadyRunning: boolean;
  /** 완주 대기(크론용). 웹은 await 하지 않는다(비동기 — 폴링으로 관찰). */
  done: Promise<{ ok: boolean; exitCode: number | null }>;
}

export async function startConnectorRun(
  system: string,
  opts: { full?: boolean; trigger?: "cron" | "manual"; startedBy?: string | null } = {},
): Promise<StartRunResult> {
  await ensureRunSchema();

  // 고아 정리 — 게이트웨이 재시작으로 close 콜백을 못 받은 running 행(2h 초과)은 error 로 닫는다.
  await itemsPool.query(
    `UPDATE connector_run SET status='error', finished_at=now(),
            log = right(log || E'\\n[tracker] 게이트웨이 재시작 등으로 중단된 실행 — 정리됨', ${LOG_CAP})
     WHERE system=$1 AND status='running' AND started_at < now() - interval '2 hours'`, [system]);

  // 중복 가드 — 이미 도는 run 이 있으면 그걸 돌려준다(멱등 UX: 버튼 연타·크론 겹침 안전).
  const running = await itemsPool.query(
    `SELECT id FROM connector_run WHERE system=$1 AND status='running' ORDER BY started_at DESC LIMIT 1`, [system]);
  if (running.rows[0]) {
    return { runId: Number((running.rows[0] as { id: string | number }).id), alreadyRunning: true, done: Promise.resolve({ ok: true, exitCode: null }) };
  }

  const mode = opts.full ? "full" : "incremental";
  const ins = await itemsPool.query(
    `INSERT INTO connector_run(system, mode, trigger, started_by) VALUES($1,$2,$3,$4) RETURNING id`,
    [system, mode, opts.trigger ?? "cron", opts.startedBy ?? null]);
  const runId = Number((ins.rows[0] as { id: string | number }).id);

  const args = ["--env-file-if-exists=.env", "dist/connectors/run-sync.js", system];
  if (opts.full) args.push("--full");
  const child = spawn("node", args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });

  // ── 로그 스트리밍 — 버퍼 + 주기/임계 flush. append 는 tail 캡(right). ──
  let buf = "";
  let flushing = Promise.resolve();
  const flush = () => {
    if (!buf) return flushing;
    const chunk = buf; buf = "";
    flushing = flushing.then(() =>
      itemsPool.query(`UPDATE connector_run SET log = right(log || $2, ${LOG_CAP}) WHERE id=$1`, [runId, chunk])
        .then(() => undefined)
        .catch((e) => { logger.warn({ e: (e as Error)?.message, runId }, "connector_run 로그 flush 실패(무시)"); }));
    return flushing;
  };
  const timer = setInterval(() => { void flush(); }, FLUSH_MS);
  const onChunk = (c: Buffer) => { buf += c.toString("utf8"); if (buf.length >= FLUSH_BYTES) void flush(); };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const timeoutMs = system === "notion" ? TIMEOUT_MS_NOTION : TIMEOUT_MS_DEFAULT;
  const killer = setTimeout(() => {
    buf += `\n[tracker] 타임아웃(${Math.round(timeoutMs / 60000)}분) — 프로세스 종료. 커서 미전진이라 다음 run 이 이어서 재수집합니다.`;
    try { child.kill("SIGKILL"); } catch { /* 이미 종료 */ }
  }, timeoutMs);

  const done = new Promise<{ ok: boolean; exitCode: number | null }>((resolve) => {
    child.on("error", (err) => { buf += `\n[tracker] spawn 실패: ${err.message}`; });
    child.on("close", (code) => {
      clearInterval(timer);
      clearTimeout(killer);
      void (async () => {
        await flush();
        // 마지막 pino JSON 라인에서 요약(stats) 추출 — 실패해도 무해(로그가 원본).
        let stats: unknown = null;
        try {
          const r = await itemsPool.query(`SELECT log FROM connector_run WHERE id=$1`, [runId]);
          const log = String((r.rows[0] as { log: string } | undefined)?.log ?? "");
          for (const line of log.split("\n").reverse()) {
            const t = line.trim();
            if (!t.startsWith("{")) continue;
            try {
              const j = JSON.parse(t) as Record<string, unknown>;
              if (j.msg && String(j.msg).includes("싱크 완료")) { stats = { msg: j.msg, ...j, time: undefined, pid: undefined, hostname: undefined, level: undefined }; break; }
            } catch { /* JSON 아닌 줄 */ }
          }
        } catch { /* 조회 실패 무시 */ }
        const ok = code === 0;
        await itemsPool.query(
          `UPDATE connector_run SET status=$2, exit_code=$3, finished_at=now(), stats=$4::jsonb WHERE id=$1`,
          [runId, ok ? "ok" : "error", code, stats == null ? null : JSON.stringify(stats)])
          .catch((e) => logger.warn({ e: (e as Error)?.message, runId }, "connector_run 종료 기록 실패"));
        resolve({ ok, exitCode: code });
      })();
    });
  });

  return { runId, alreadyRunning: false, done };
}

/** 실행 목록(로그 제외 — 목록은 가볍게). */
export async function listConnectorRuns(system?: string, limit = 20): Promise<Record<string, unknown>[]> {
  await ensureRunSchema();
  const params: unknown[] = [];
  let where = "";
  if (system) { params.push(system); where = `WHERE system=$${params.length}`; }
  params.push(Math.min(Math.max(1, limit), 100));
  const r = await itemsPool.query(
    `SELECT id, system, mode, trigger, status, started_at, finished_at, exit_code, stats, length(log) AS log_size, started_by
     FROM connector_run ${where} ORDER BY started_at DESC LIMIT $${params.length}`, params);
  return r.rows as Record<string, unknown>[];
}

/** 실행 1건 + 로그 청크(offset 이후) — 웹이 폴링으로 이어붙인다. */
export async function getConnectorRun(id: number, offset = 0, maxChunk = 65_536): Promise<Record<string, unknown> | null> {
  await ensureRunSchema();
  const off = Math.max(0, Math.trunc(offset));
  const r = await itemsPool.query(
    `SELECT id, system, mode, trigger, status, started_at, finished_at, exit_code, stats, started_by,
            length(log) AS log_size, substr(log, $2 + 1, $3) AS log_chunk
     FROM connector_run WHERE id=$1`, [id, off, Math.min(Math.max(1024, maxChunk), 262_144)]);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const chunk = String(row.log_chunk ?? "");
  return { ...row, log_chunk: chunk, next_offset: off + chunk.length };
}
