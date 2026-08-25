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
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";

const LOG_CAP = 400_000;          // connector_run.log tail 캡(문자)
const FLUSH_MS = 1500;            // 로그 flush 주기(하트비트 겸용)
const FLUSH_BYTES = 16_384;       // 즉시 flush 임계
// 하트비트 liveness(#586 실배포 교훈): 게이트웨이(부모)가 재시작되면 로그 스트리밍·종료 기록을 하던 추적이
//  통째로 사라져 run 행이 'running'으로 박제되고, 중복 가드가 그 유령 행을 근거로 새 싱크를 계속 막았다.
//  status(의도)와 별개로 **부모가 1.5초마다 갱신하는 heartbeat_at(생존 증거)** 를 두고, 끊긴 지 STALE 이상이면
//  죽은 실행으로 판정해 정리한다 — 상태 행과 실제 프로세스가 어긋나도 자가 치유되는 구조.
const HEARTBEAT_STALE_MS = 120_000;

// 이 게이트웨이가 띄운 살아있는 run — 취소(사용자 중지)와 종료 기록이 같은 행을 두고 경합하지 않게 한다.
const liveRuns = new Map<number, { child: ChildProcess; canceled: boolean }>();

/** pid 가 **해당 system 의** run-sync 프로세스일 때만 kill — pid 재사용으로 무관한 프로세스(다른 커넥터의
 *  정상 run 포함)를 죽이지 않게 명령줄에 run-sync + system 명이 모두 있어야 한다. */
async function killIfRunSync(pid: number | null | undefined, system: string): Promise<boolean> {
  if (!pid || !Number.isFinite(pid)) return false;
  const cmd = await new Promise<string>((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], (err, stdout) => resolve(err ? "" : String(stdout)));
  });
  if (!cmd.includes("run-sync") || !cmd.includes(system)) return false;
  try { process.kill(pid, "SIGKILL"); return true; } catch { return false; }
}
// 타임아웃 정책(#586 실배포 교훈): 고정 상한은 대형 워크스페이스의 정당한 장기 full 백필을 죽여
//  "매번 30분 낭비 후 처음부터" 라이브락을 만든다(고객사 A 1,010페이지+DB 848 실측). 커넥터는 수 초마다
//  진행 로그를 찍으므로 **정체(stall) 감지**가 올바른 liveness 가드다 — 출력이 STALL_MS 동안 0이면 행 걸림으로
//  판정해 종료, 진행 중이면 몇 시간이든 완주시킨다. HARD_CAP 은 폭주 백스톱(정상 도달 불가).
const STALL_MS = 15 * 60_000;      // 로그 무출력 15분 = 행 걸림(레이트리밋 대기도 재시도 로그가 남는다)
const HARD_CAP_MS = 12 * 3_600_000; // 12시간 — 런어웨이 백스톱

let schemaReady: Promise<void> | null = null;

/**
 * 이 표가 **이미 완성돼 있나**(#1750 후속) — 있으면 DDL 을 아예 치지 않는다.
 *
 * ★ 왜 필요한가(실측 2026-08-25, dev): 다중 워크스페이스(registry)를 켜면 게이트웨이는 소유자(items)가 아니라
 *  **앱 role(lvly_app_<db>)** 로 붙는다(org/tenancy/state.ts 의 app_dsn). 그 역은 NOSUPERUSER 라 public 스키마에
 *  CREATE 권한이 없고 표의 소유자도 아니다 → `CREATE TABLE IF NOT EXISTS` 는 **존재 검사보다 ACL 검사가 먼저**라
 *  표가 멀쩡히 있어도 `permission denied for schema public` 으로 죽고, ALTER 는 `must be owner of table` 로 죽는다.
 *  connector_run 은 스키마 체인 밖에서 **지연 생성**되는 유일한 표라(#1750 이 같은 이름을 이미 짚었다) 이 경로만
 *  이 함정에 빠졌고, 그 결과 **수집기 실행이 통째로 막혔다**(모든 커넥터의 크론·수동 싱크가 시작조차 못 함).
 *  고쳐야 할 것은 권한이 아니라 **런타임 DDL 자체**다 — 표가 이미 있으면 확인만 하고 지나간다(introspection).
 *  없을 때만 DDL 을 친다: 자가호스팅 단일 워크스페이스는 소유자 역으로 붙으므로 종전 그대로 만들어진다.
 */
export const RUN_REQUIRED_COLS = ["id", "system", "mode", "trigger", "status", "started_at", "finished_at",
  "exit_code", "stats", "log", "started_by", "pid", "heartbeat_at", "log_total", "collector_id"] as const;

/** 순수 판정 — 관측된 컬럼 집합이 이 표를 '완성'으로 볼 수 있나. 하나라도 없으면 DDL 이 필요하다. */
export function runSchemaColumnsComplete(cols: Iterable<string>): boolean {
  const have = new Set(cols);
  return RUN_REQUIRED_COLS.every((c) => have.has(c));
}

async function runSchemaComplete(): Promise<boolean> {
  try {
    const r = await itemsPool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='connector_run'`);
    return runSchemaColumnsComplete(r.rows.map((x) => String((x as { column_name: string }).column_name)));
  } catch { return false; } // 조회 자체가 막히면 DDL 로 넘겨 원래 오류를 그대로 보여준다
}

function ensureRunSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      if (await runSchemaComplete()) return; // 이미 완성 — 권한 없는 역으로도 통과한다
      await itemsPool.query(`
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
      ALTER TABLE connector_run ADD COLUMN IF NOT EXISTS pid INT;
      ALTER TABLE connector_run ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE connector_run ADD COLUMN IF NOT EXISTS log_total BIGINT NOT NULL DEFAULT 0;
      UPDATE connector_run SET log_total = char_length(log) WHERE log_total = 0 AND log <> '';
      -- #1419 T1 — 실행을 **수집기 인스턴스**에 귀속. 구 행은 NULL(레거시 system 단위 실행)로 남고,
      --  화면은 collector_id 가 있으면 그 수집기 이력으로, 없으면 종전처럼 system 이력으로 읽는다.
      --  ⚠ FK 를 걸지 않는다 — 수집기를 지워도 그 실행 이력(무슨 일이 있었나)은 남아야 한다(감사 성격).
      ALTER TABLE connector_run ADD COLUMN IF NOT EXISTS collector_id BIGINT;
      CREATE INDEX IF NOT EXISTS connector_run_collector_idx ON connector_run(collector_id, started_at DESC)
        WHERE collector_id IS NOT NULL;
    `);
    })();
    // ⚠ **실패한 프라미스를 캐시하지 않는다**(같은 실측에서 함께 드러난 두 번째 결함): 캐시해 두면 부팅 때 한 번
    //  실패한 뒤로 그 프로세스가 사는 내내 **모든 호출이 그 옛 거절을 그대로 다시 던진다** — 스택이 부팅 시점을
    //  가리켜 원인 추적도 어긋난다(실측: /api/ui/org/connector/runs 실패 스택이 boot/housekeeping 을 가리켰다).
    //  권한·마이그레이션이 나중에 갖춰지면 다음 호출이 다시 시도해 스스로 회복하게 둔다.
    schemaReady = schemaReady.catch((e) => { schemaReady = null; throw e; });
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
  opts: { full?: boolean; trigger?: "cron" | "manual"; startedBy?: string | null; collectorId?: number | null } = {},
): Promise<StartRunResult> {
  await ensureRunSchema();

  // ── 실행 범위(#1419 T1) — 이 run 이 무엇과 겹치면 안 되나. ──
  //  수집기 인스턴스가 지정되면 **그 인스턴스**가 범위다: 같은 프리셋(예: 슬랙)의 다른 수집기는 서로 다른
  //  워크스페이스·채널 그룹을 긁으므로 **동시에 도는 게 정상**이다. system 으로 잠그면 그 병렬성이 죽는다.
  //  지정이 없으면 종전 그대로 system 단위 — 단 collector_id IS NULL 인 레거시 실행끼리만 본다.
  const scopeSql = opts.collectorId ? `collector_id=$1` : `system=$1 AND collector_id IS NULL`;
  const scopeVal: string | number = opts.collectorId ?? system;

  // 유령 정리 — 하트비트가 STALE 이상 끊긴 running 행은 추적(부모)이 죽은 것(게이트웨이 재시작 등).
  //  error 로 닫고, 자식이 살아 남아있으면 kill(명령줄 검증) — 커서 미전진이라 데이터는 다음 run 이 재수집.
  const ghostMarker = `\n[tracker] 추적 끊김(게이트웨이 재시작 등, 하트비트 ${Math.round(HEARTBEAT_STALE_MS / 1000)}s 무응답) — 정리됨. 커서 미전진이라 다음 run 이 재수집합니다.`;
  const ghosts = await itemsPool.query(
    `UPDATE connector_run SET status='error', finished_at=now(),
            log = right(log || $3, ${LOG_CAP}), log_total = log_total + char_length($3::text)
     WHERE ${scopeSql} AND status='running' AND heartbeat_at < now() - interval '${Math.round(HEARTBEAT_STALE_MS / 1000)} seconds'
       AND NOT (id = ANY($2::bigint[]))
     RETURNING id, pid`, [scopeVal, [...liveRuns.keys()], ghostMarker]);
  for (const g of ghosts.rows as Array<{ id: number; pid: number | null }>) {
    if (await killIfRunSync(g.pid, system)) logger.warn({ runId: g.id, pid: g.pid }, "유령 run 의 잔존 자식 프로세스 종료");
  }

  // 중복 가드 — 이미 도는 run 이 있으면 그걸 돌려준다(멱등 UX: 버튼 연타·크론 겹침 안전).
  const running = await itemsPool.query(
    `SELECT id FROM connector_run WHERE ${scopeSql} AND status='running' ORDER BY started_at DESC LIMIT 1`, [scopeVal]);
  if (running.rows[0]) {
    return { runId: Number((running.rows[0] as { id: string | number }).id), alreadyRunning: true, done: Promise.resolve({ ok: true, exitCode: null }) };
  }

  const mode = opts.full ? "full" : "incremental";
  const ins = await itemsPool.query(
    `INSERT INTO connector_run(system, mode, trigger, started_by, collector_id) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [system, mode, opts.trigger ?? "cron", opts.startedBy ?? null, opts.collectorId ?? null]);
  const runId = Number((ins.rows[0] as { id: string | number }).id);

  const args = ["--env-file-if-exists=.env", "dist/connectors/run-sync.js", system];
  // 수집기 바인딩을 자식에게 넘긴다 — 자식은 이 id 로 config·커서 네임스페이스를 해소한다(config.bindCollector).
  if (opts.collectorId) args.push("--collector", String(opts.collectorId));
  if (opts.full) args.push("--full");
  const child = spawn("node", args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  liveRuns.set(runId, { child, canceled: false });
  if (child.pid) {
    await itemsPool.query(`UPDATE connector_run SET pid=$2 WHERE id=$1`, [runId, child.pid])
      .catch((e) => logger.warn({ e: (e as Error)?.message, runId }, "connector_run pid 기록 실패(무시)"));
  }

  // ── 로그 스트리밍 — 버퍼 + 주기/임계 flush. append 는 tail 캡(right). flush = 하트비트 겸용. ──
  let buf = "";
  let flushing = Promise.resolve();
  const flush = () => {
    if (!buf) {
      // 새 로그가 없어도 생존 신호는 남긴다 — 유령 판정(heartbeat stale)의 기준선.
      flushing = flushing.then(() =>
        itemsPool.query(`UPDATE connector_run SET heartbeat_at=now() WHERE id=$1 AND status='running'`, [runId])
          .then(() => undefined).catch(() => undefined));
      return flushing;
    }
    const chunk = buf; buf = "";
    flushing = flushing.then(() =>
      itemsPool.query(
        `UPDATE connector_run SET log = right(log || $2, ${LOG_CAP}), log_total = log_total + char_length($2::text), heartbeat_at=now() WHERE id=$1`,
        [runId, chunk])
        .then(() => undefined)
        .catch((e) => { logger.warn({ e: (e as Error)?.message, runId }, "connector_run 로그 flush 실패(무시)"); }));
    return flushing;
  };
  const timer = setInterval(() => { void flush(); }, FLUSH_MS);
  const onChunk = (c: Buffer) => { lastOutputAt = Date.now(); buf += c.toString("utf8"); if (buf.length >= FLUSH_BYTES) void flush(); };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  // 정체 감지 — 마지막 출력 시각 기준. 진행 로그가 살아 있는 한 죽이지 않는다(장기 full 백필 완주 보장).
  let lastOutputAt = Date.now();
  const startedAtMs = Date.now();
  const killer = setInterval(() => {
    const now = Date.now();
    if (now - lastOutputAt > STALL_MS) {
      buf += `\n[tracker] 정체 감지 — ${Math.round(STALL_MS / 60000)}분간 출력 없음 → 프로세스 종료. 커서 미전진이라 다음 run 이 재수집합니다.`;
      try { child.kill("SIGKILL"); } catch { /* 이미 종료 */ }
    } else if (now - startedAtMs > HARD_CAP_MS) {
      buf += `\n[tracker] 하드캡(${Math.round(HARD_CAP_MS / 3600000)}시간) 초과 — 런어웨이 백스톱으로 종료.`;
      try { child.kill("SIGKILL"); } catch { /* 이미 종료 */ }
    }
  }, 60_000);

  const done = new Promise<{ ok: boolean; exitCode: number | null }>((resolve) => {
    child.on("error", (err) => { buf += `\n[tracker] spawn 실패: ${err.message}`; });
    child.on("close", (code) => {
      clearInterval(timer);
      clearInterval(killer);
      const canceled = liveRuns.get(runId)?.canceled === true;
      liveRuns.delete(runId);
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
        // 정상 완주(exit 0)는 취소 플래그보다 우선 — kill 직전에 이미 끝난 run 을 canceled 로 오기록하지 않게(리뷰 지적).
        await itemsPool.query(
          `UPDATE connector_run SET status=$2, exit_code=$3, finished_at=now(), stats=$4::jsonb WHERE id=$1`,
          [runId, ok ? "ok" : canceled ? "canceled" : "error", code, stats == null ? null : JSON.stringify(stats)])
          .catch((e) => logger.warn({ e: (e as Error)?.message, runId }, "connector_run 종료 기록 실패"));
        resolve({ ok, exitCode: code });
      })();
    });
  });

  return { runId, alreadyRunning: false, done };
}

/**
 * 부팅 스윕 — 게이트웨이 기동 시 running 잔재를 전부 error 로 닫는다. 이 프로세스가 방금 떴다는 것 자체가
 * 어떤 running 행도 추적 부모가 없다는 증거(단일 게이트웨이). 자식이 잔존하면 kill(명령줄 검증) — 재시작이
 * 유령 상태를 만들지 않게 하고, 다음 크론/수동 싱크가 즉시 새로 뜰 수 있게 한다.
 */
export async function recoverOrphanConnectorRuns(): Promise<void> {
  await ensureRunSchema();
  // 이 프로세스가 이미 띄운 run 은 제외 — REST 는 listen 직후(스키마 체인 완료 전)부터 열려 있어,
  //  스윕 전에 시작된 **정상** run 을 '재시작 잔재'로 오인해 죽일 수 있다(리뷰 지적). liveRuns = 내 자식 전부.
  const own = [...liveRuns.keys()];
  const marker = "\n[tracker] 게이트웨이 재시작으로 추적 중단 — 부팅 시 정리. 커서 미전진이라 다음 run 이 재수집합니다.";
  const r = await itemsPool.query(
    `UPDATE connector_run SET status='error', finished_at=now(),
            log = right(log || $2, ${LOG_CAP}), log_total = log_total + char_length($2::text)
     WHERE status='running' AND NOT (id = ANY($1::bigint[])) RETURNING id, system, pid`, [own, marker]);
  for (const g of r.rows as Array<{ id: number; system: string; pid: number | null }>) {
    const killed = await killIfRunSync(g.pid, g.system);
    logger.warn({ runId: g.id, system: g.system, pid: g.pid, killed }, "부팅 스윕 — 고아 connector_run 정리");
  }
}

/** 사용자 중지 — 이 게이트웨이의 자식이면 canceled 마킹 후 kill(종료 기록은 close 핸들러가), 유령이면 즉시 닫는다. */
export async function cancelConnectorRun(id: number, actor?: string | null): Promise<{ ok: boolean; message: string }> {
  await ensureRunSchema();
  const r = await itemsPool.query(`SELECT id, system, status, pid FROM connector_run WHERE id=$1`, [id]);
  const row = r.rows[0] as { system: string; status: string; pid: number | null } | undefined;
  if (!row) return { ok: false, message: "run 없음" };
  if (row.status !== "running") return { ok: false, message: `이미 종료된 실행(${row.status})` };
  const who = actor ? `사용자 중지(${actor})` : "사용자 중지";
  const live = liveRuns.get(id);
  if (live) {
    live.canceled = true;
    await itemsPool.query(
      `UPDATE connector_run SET log = right(log || $2, ${LOG_CAP}), log_total = log_total + char_length($2::text) WHERE id=$1`,
      [id, `\n[tracker] ${who} 요청 — 프로세스 종료`]).catch(() => undefined);
    try { live.child.kill("SIGKILL"); } catch { /* 이미 종료 */ }
    return { ok: true, message: "중지 요청됨 — 곧 canceled 로 기록됩니다. 커서 미전진이라 다음 run 이 재수집합니다." };
  }
  await killIfRunSync(row.pid, row.system);
  // status='running' 가드 — 자연 종료(close 기록)와 경합해도 완주 결과를 canceled 로 덮지 않는다(리뷰 지적).
  const marker = `\n[tracker] ${who}(추적 부모 부재 — 직접 정리)`;
  const upd = await itemsPool.query(
    `UPDATE connector_run SET status='canceled', finished_at=now(),
            log = right(log || $2, ${LOG_CAP}), log_total = log_total + char_length($2::text)
     WHERE id=$1 AND status='running'`, [id, marker]);
  if (!upd.rowCount) {
    const cur = (await itemsPool.query(`SELECT status FROM connector_run WHERE id=$1`, [id])).rows[0] as { status: string } | undefined;
    return { ok: false, message: `이미 종료된 실행(${cur?.status ?? "?"})` };
  }
  return { ok: true, message: "중지됨" };
}

/**
 * 실행 목록(로그 제외 — 목록은 가볍게). stale = running 인데 하트비트 끊김(추적 사망 추정).
 *  범위(#1419 T1): collectorId 를 주면 **그 수집기의 이력만**, 없으면 종전대로 system 전체(그 프리셋의 모든
 *  인스턴스 + 레거시 실행이 함께 보인다 — '이 소스가 최근 어땠나'를 묻는 질문이라 그게 맞다).
 */
export async function listConnectorRuns(
  system?: string, limit = 20, offset = 0, collectorId?: number | null,
): Promise<Record<string, unknown>[]> {
  await ensureRunSchema();
  const params: unknown[] = [];
  const conds: string[] = [];
  if (collectorId) { params.push(collectorId); conds.push(`collector_id=$${params.length}`); }
  else if (system) { params.push(system); conds.push(`system=$${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(Math.min(Math.max(1, limit), 100)); const limP = `$${params.length}`;
  params.push(Math.min(Math.max(0, Math.trunc(Number(offset) || 0)), 1_000_000)); const offP = `$${params.length}`;   // #709 offset — 과거 이력 도달
  const r = await itemsPool.query(
    `SELECT id, system, collector_id, mode, trigger, status, started_at, finished_at, exit_code, stats, length(log) AS log_size, started_by, heartbeat_at,
            (status='running' AND heartbeat_at < now() - interval '${Math.round(HEARTBEAT_STALE_MS / 1000)} seconds') AS stale
     FROM connector_run ${where} ORDER BY started_at DESC LIMIT ${limP} OFFSET ${offP}`, params);
  return r.rows as Record<string, unknown>[];
}

/**
 * 실행 1건 + 로그 청크(offset 이후) — 웹이 폴링으로 이어붙인다.
 * offset 좌표계 = **누적 스트림**(log_total, PG char 단위): log 는 tail 캡(right)으로 앞이 잘릴 수 있어
 * 저장 문자열 인덱스로는 캡 도달 순간 좌표가 밀린다(리뷰 지적 — 뷰 동결/구간 스킵). 보관 구간은
 * [log_total-char_length(log), log_total) — 요청 offset 이 그보다 이전이면 skipped 로 알리고 보관 시작부터 준다.
 */
export async function getConnectorRun(id: number, offset = 0, maxChunk = 65_536): Promise<Record<string, unknown> | null> {
  await ensureRunSchema();
  const off = Math.max(0, Math.trunc(offset));
  const r = await itemsPool.query(
    `SELECT id, system, mode, trigger, status, started_at, finished_at, exit_code, stats, started_by, heartbeat_at,
            (status='running' AND heartbeat_at < now() - interval '${Math.round(HEARTBEAT_STALE_MS / 1000)} seconds') AS stale,
            log_total, char_length(log) AS log_len,
            substr(log, GREATEST(1, $2 + 1 - (log_total - char_length(log)))::int, $3) AS log_chunk
     FROM connector_run WHERE id=$1`, [id, off, Math.min(Math.max(1024, maxChunk), 262_144)]);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const total = Number(row.log_total ?? 0);
  const retainedStart = total - Number(row.log_len ?? 0);
  const start = Math.max(off, retainedStart);
  const chunk = String(row.log_chunk ?? "");
  const chunkChars = [...chunk].length; // PG substr 는 코드포인트 단위 — JS UTF-16 length 와 다름(이모지)
  return { ...row, log_chunk: chunk, log_size: total, skipped: start - off, next_offset: start + chunkChars };
}
