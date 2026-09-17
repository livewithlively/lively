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
//   · (#3994 T3) 매니지드에선 수집을 게이트웨이 **밖** 일시 유닛(판)에서 돌린다 — run-unit.ts 머리말.
//     그때 이 파일의 추적(trackRunChild)은 판 안 엔트리(job-entry)가 부르고, 게이트웨이는 기다리기·멈추기·치우기만 한다.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { itemsPool, tenantBindingActive, tenantBindingSql, withTx } from "../db/client.js";
import { logger } from "../log.js";
import { HttpError } from "../http-error.js";
import type { JobRoute } from "./run-unit.js";   // 타입만 — run-unit 은 동적으로 부른다(아래 unitMod)

const LOG_CAP = 400_000;          // connector_run.log tail 캡(문자)
const FLUSH_MS = 1500;            // 로그 flush 주기(하트비트 겸용)
const FLUSH_BYTES = 16_384;       // 즉시 flush 임계
// 하트비트 liveness(#586 실배포 교훈): 게이트웨이(부모)가 재시작되면 로그 스트리밍·종료 기록을 하던 추적이
//  통째로 사라져 run 행이 'running'으로 박제되고, 중복 가드가 그 유령 행을 근거로 새 싱크를 계속 막았다.
//  status(의도)와 별개로 **부모가 1.5초마다 갱신하는 heartbeat_at(생존 증거)** 를 두고, 끊긴 지 STALE 이상이면
//  죽은 실행으로 판정해 정리한다 — 상태 행과 실제 프로세스가 어긋나도 자가 치유되는 구조.
export const HEARTBEAT_STALE_MS = 120_000;

// 이 게이트웨이가 띄운 살아있는 run — 취소(사용자 중지)와 종료 기록이 같은 행을 두고 경합하지 않게 한다.
const liveRuns = new Map<number, { child: ChildProcess; canceled: boolean }>();

/** pid 가 **해당 system 의** run-sync 프로세스일 때만 kill — pid 재사용으로 무관한 프로세스(다른 커넥터의
 *  정상 run 포함)를 죽이지 않게 명령줄에 run-sync + system 명이 모두 있어야 한다. */
async function isOurRunSync(pid: number | null | undefined, system: string): Promise<boolean> {
  if (!pid || !Number.isFinite(pid)) return false;
  const cmd = await new Promise<string>((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], (err, stdout) => resolve(err ? "" : String(stdout)));
  });
  return cmd.includes("run-sync") && cmd.includes(system);
}
async function killIfRunSync(pid: number | null | undefined, system: string): Promise<boolean> {
  if (!(await isOurRunSync(pid, system))) return false;
  try { process.kill(pid as number, "SIGKILL"); return true; } catch { return false; }
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

/**
 * 자식(run-sync)에게 넘길 환경 — **소유권과 테넌트 두 가지를 명시적으로 건넨다**(실측 2026-08-25).
 *
 * 종전엔 `env: process.env` 로 부모 환경을 그대로 물려줬다. 다중 워크스페이스(registry)를 켜면 부모의
 *  `ITEMS_DATABASE_URL` 은 이미 **앱 role**(lvly_app_<db>)로 바뀌어 있는데(org/tenancy 의 app_dsn),
 *  자식은 그 사실을 모른 채 부팅에서 `initAllSchemas()` 로 DDL 을 쳐서 죽었다 —
 *  `permission denied for schema public`(42501). 그래서 **수집 서브프로세스가 한 번도 못 떴다.**
 *  (자식의 `--env-file-if-exists=.env` 는 구제책이 못 된다 — node 는 이미 있는 환경변수를 덮지 않는다.)
 *
 * 두 신호를 준다. 둘 다 이미 있는 스위치라 새 개념을 만들지 않는다:
 *  · `LIVELY_SKIP_SCHEMA_INIT` — "이 프로세스는 스키마를 소유하지 않는다"(boot/schemas.ts 머리말).
 *    스키마는 마이그레이터가 배포 절차에서 적용한다.
 *  · `LIVELY_TENANT_BINDING=rls` + `LIVELY_TENANT_ID` — leaf 프로세스용 **고정 바인딩**(db/client.ts 머리말).
 *    이게 없으면 자식의 모든 쿼리가 `app.tenant_id` 없이 나가 정책에서 시끄럽게 실패한다(조용한 유출 대신).
 *
 * ★ 테넌트 id 는 **바인딩 층에 직접 묻는다**(`tenantBindingSql()`) — 컨텍스트를 다시 읽어 규칙을 복제하면
 *  모드마다 다른 폴백(registry = "컨텍스트 없으면 primary", request = null)을 여기서 또 판단하게 되고,
 *  두 곳이 어긋나는 순간 자식이 **부모와 다른 워크스페이스에 쓴다**. 부모가 이 쿼리에 걸 바로 그 값을
 *  그대로 물려주면 어긋날 자리가 없다(실측: registry 에서 currentTenant() 는 null 이라 복제판은 못 넘겼다).
 *
 * 바인딩이 꺼진 자가호스팅 단일 워크스페이스에서는 **아무것도 더하지 않는다** — 자식이 종전 그대로
 *  스키마를 만들고(신규 DB 단독 CLI 경로) 전역 풀로 돈다.
 */
function childEnv(system: string): NodeJS.ProcessEnv {
  if (!tenantBindingActive()) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env, LIVELY_SKIP_SCHEMA_INIT: "1" };
  const id = String(tenantBindingSql()?.params?.[0] ?? "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    env.LIVELY_TENANT_BINDING = "rls";
    env.LIVELY_TENANT_ID = id;
  } else {
    // 부모조차 걸 값이 없다 = 배선 버그다. 임의의 테넌트를 고르지 않는다(남의 자료에 쓰는 것보다 실패가 낫다) —
    //  자식은 정책에서 곧바로 실패하고 그 오류가 run 로그에 남는다.
    logger.warn({ system }, "수집 자식에 테넌트 바인딩을 넘기지 못했습니다 — 컨텍스트 밖에서 실행이 시작됐습니다");
  }
  return env;
}

export interface StartRunResult {
  runId: number;
  alreadyRunning: boolean;
  /** 완주 대기(크론용). 웹은 await 하지 않는다(비동기 — 폴링으로 관찰). */
  done: Promise<{ ok: boolean; exitCode: number | null }>;
}

/**
 * 판 자리가 없다(#3994 T3) — 박스·프로필 동시 상한. **행을 만들지 않았다.** 기다리면 풀린다(배압):
 *  크론은 이번 틱을 건너뛴 것으로 적고(실패 아님), 사람의 «지금 수집» 에는 그대로 사유를 보여 준다.
 */
export class RunCapacityError extends HttpError {
  constructor(message: string) { super(503, message); this.name = "RunCapacityError"; }
}

const unitMod = (): Promise<typeof import("./run-unit.js")> => import("./run-unit.js");

/**
 * 판을 쓸 수 있는 박스인가 + 이 워크스페이스 slug — 둘 다 있어야 판 이름을 짓는다. 없으면 null.
 *  · 새 판(launch) — `sandboxAvailable()`: 소켓이 있고 되돌림 스위치(LIVELY_TASK_SANDBOX=off)가 꺼져 있지 않다.
 *  · 이미 도는 판의 관리(manage: 정지·상태·입양) — **소켓만** 본다. 스위치를 켠 뒤에도 켜기 전에 뜬 판은 멈추고 치울 수 있어야 한다
 *    (스위치가 그 판들을 «관리 불능» 으로 만들면 사용자 중지가 조용히 먹히지 않는다).
 */
async function unitContext(o: { manage?: boolean } = {}): Promise<{ slug: string } | null> {
  try {
    const [sbx, { tenantSlug }] = await Promise.all([import("../node/sandbox-task.js"), import("../terminal/catalog.js")]);
    const slug = tenantSlug();
    if (!slug) return null;
    if (!o.manage) return sbx.sandboxAvailable() ? { slug } : null;
    const fs = await import("node:fs");
    try { return fs.statSync(sbx.sandboxOpSock()).isSocket() ? { slug } : null; } catch { return null; }
  } catch { return null; }
}

/**
 * 커넥터가 게이트웨이 디스크에 기대나(#3994 T3) — null 은 «못 가렸다»(판으로 보내지 않는다).
 *  수집기 실행이면 프리셋을 해소해 **기반 모듈**을 본다(복제 프리셋은 원본 모듈의 표지를 따른다). 범용 드라이버
 *  (http·rss·webhook)는 디스크를 안 쓴다.
 */
async function connectorNeedsGatewayDisk(system: string, collectorId: number | null | undefined): Promise<boolean | null> {
  try {
    const { connectors } = await import("./index.js");
    if (!collectorId) {
      const c = connectors[system];
      return c ? c.needsGatewayDisk === true : null;
    }
    const { resolvePreset, moduleNameOf } = await import("../org/store/collector-presets.js");
    const preset = await resolvePreset(system);
    if (!preset) return null;
    const mod = moduleNameOf(preset);
    if (!mod) return false;
    const c = connectors[mod];
    return c ? c.needsGatewayDisk === true : null;
  } catch { return null; }
}

/** 이 수집의 실행 자리(판/자식) — 판정은 run-unit.jobRoute 한 곳. */
async function decideRunRoute(system: string, collectorId: number | null | undefined): Promise<{ route: JobRoute; slug: string | null }> {
  const [{ jobRoute }, ctx] = await Promise.all([unitMod(), unitContext()]);
  const pre = jobRoute({
    sandbox: !!ctx, codeRoot: process.env.LIVELY_CODE_ROOT, slug: ctx?.slug,
    switchValue: process.env.LIVELY_GATEWAY_JOB, needsGatewayDisk: false,
  });
  //  커넥터 해소(DB 조회일 수 있다)는 판을 쓸 수 있는 박스에서만 한다.
  if (!pre.unit) return { route: pre, slug: ctx?.slug ?? null };
  const disk = await connectorNeedsGatewayDisk(system, collectorId);
  return {
    route: jobRoute({ sandbox: true, codeRoot: process.env.LIVELY_CODE_ROOT, slug: ctx!.slug, switchValue: process.env.LIVELY_GATEWAY_JOB, needsGatewayDisk: disk }),
    slug: ctx!.slug,
  };
}

/** run 로그에 한 줄 보탠다(tail 캡). onlyRunning 이면 이미 닫힌 행에는 안 쓴다. 실패는 삼킨다. */
export async function appendRunLog(runId: number, text: string, o: { onlyRunning?: boolean } = {}): Promise<void> {
  await itemsPool.query(
    `UPDATE connector_run SET log = right(log || $2, ${LOG_CAP}), log_total = log_total + char_length($2::text) WHERE id=$1${o.onlyRunning ? " AND status='running'" : ""}`,
    [runId, text]).catch((e) => logger.warn({ e: (e as Error)?.message, runId }, "connector_run 로그 추가 실패(무시)"));
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
  //  (#3994 T3) 판 실행(pid 없음)은 판 추적기가 1.5초마다 박동을 찍는다 — 끊겼다면 판이 죽었거나 DB 에 못 닿는다.
  //   행을 닫고 그 판에 **멈추라고 전한다**(이름이 run id 에서 나오므로 남의 판을 건드릴 수 없다).
  const ghostMarker = `\n[tracker] 추적 끊김(게이트웨이 재시작 등, 하트비트 ${Math.round(HEARTBEAT_STALE_MS / 1000)}s 무응답) — 정리됨. 커서 미전진이라 다음 run 이 재수집합니다.`;
  const ghosts = await itemsPool.query(
    `UPDATE connector_run SET status='error', finished_at=now(),
            log = right(log || $3, ${LOG_CAP}), log_total = log_total + char_length($3::text)
     WHERE ${scopeSql} AND status='running' AND heartbeat_at < now() - interval '${Math.round(HEARTBEAT_STALE_MS / 1000)} seconds'
       AND NOT (id = ANY($2::bigint[]))
     RETURNING id, pid`, [scopeVal, [...liveRuns.keys()], ghostMarker]);
  const ghostUnits: number[] = [];
  for (const g of ghosts.rows as Array<{ id: number; pid: number | null }>) {
    if (g.pid) {
      if (await killIfRunSync(g.pid, system)) logger.warn({ runId: g.id, pid: g.pid }, "유령 run 의 잔존 자식 프로세스 종료");
    } else ghostUnits.push(Number(g.id));
  }
  if (ghostUnits.length) {
    const ctx = await unitContext({ manage: true });
    if (ctx) {
      const u = await unitMod();
      for (const id of ghostUnits) {
        const stopped = await u.stopRunUnit(ctx.slug, id).catch(() => false);
        logger.warn({ runId: id, slug: ctx.slug, stopped }, "유령 run 의 판에 정지를 전했다");
      }
    }
  }

  // 중복 가드 — 이미 도는 run 이 있으면 그걸 돌려준다(멱등 UX: 버튼 연타·크론 겹침 안전).
  const running = await itemsPool.query(
    `SELECT id FROM connector_run WHERE ${scopeSql} AND status='running' ORDER BY started_at DESC LIMIT 1`, [scopeVal]);
  if (running.rows[0]) {
    return { runId: Number((running.rows[0] as { id: string | number }).id), alreadyRunning: true, done: Promise.resolve({ ok: true, exitCode: null }) };
  }

  //  #3994 T3 — 실행 자리. 판을 쓸 수 있으면 판, 판 경로가 이 박스에서 아직 안 서면(fallback) 자식으로 내려온다.
  const { route, slug } = await decideRunRoute(system, opts.collectorId);
  let note = (await unitMod()).jobRouteNote(route);
  if (route.unit && slug) {
    const viaUnit = await startRunInUnit(system, opts, slug, String(process.env.LIVELY_CODE_ROOT), { scopeSql, scopeVal });
    if (viaUnit.kind === "started") return viaUnit.result;
    note = `[tracker] 게이트웨이 자식으로 실행 — 판을 세우지 못했다(${viaUnit.why}). 게이트웨이 교대에 끊길 수 있습니다.`;
  }
  return await startRunAsChild(system, opts, note);
}

/** 판 실행 결과 — 섰거나(행이 있다), 이 박스에서 판 경로가 아직 안 서서 자식으로 내려가야 하거나. */
type UnitStart = { kind: "started"; result: StartRunResult } | { kind: "fallback"; why: string };

/**
 * 판에서 수집을 띄운다(#3994 T3) — **판이 먼저, 행이 나중**이다.
 *  ① 같은 범위의 트랜잭션 락 안에서 «이미 도는가» 를 다시 보고 ② run id 를 먼저 받아 ③ 판을 띄운 뒤 ④ 행을 커밋한다.
 *  판 추적기(job-entry)는 자기 행이 보일 때까지 기다린다(JOB_ROW_WAIT_MS) — 커밋 전에 게이트웨이가 죽으면 행이 없으니
 *  판은 아무것도 안 긁고 끝난다(고아 수집 0). 거꾸로(행이 먼저) 하면 자리 없음(busy)마다 빈 실행 행이 쌓인다.
 *  · 자리 없음 → RunCapacityError(행 없음) · 이 박스에서 판 경로가 아직 안 섬 → fallback
 *  · 그 밖의 실패 → 실패 행을 남긴다(사유 포함). 판이 섰을 수 있는 실패면 멈추라고 먼저 전한다.
 */
async function startRunInUnit(
  system: string,
  opts: { full?: boolean; trigger?: "cron" | "manual"; startedBy?: string | null; collectorId?: number | null },
  slug: string, codeRoot: string, scope: { scopeSql: string; scopeVal: string | number },
): Promise<UnitStart> {
  const u = await unitMod();
  const mode = opts.full ? "full" : "incremental";
  //  끝난 판의 결과 폴더 청소 — 기다리던 게이트웨이가 교대로 사라지면 아무도 안 치운다. 실패해도 시작을 막지 않는다.
  void u.reapFinishedRunUnits(slug, async (ids) => {
    const r = await itemsPool.query(`SELECT id FROM connector_run WHERE id = ANY($1::bigint[]) AND status='running'`, [ids]);
    return new Set((r.rows as Array<{ id: string | number }>).map((x) => Number(x.id)));
  }).catch((e) => logger.warn({ e: (e as Error)?.message, slug }, "끝난 수집 판 청소 실패(무시)"));

  const tenantKey = String(tenantBindingSql()?.params?.[0] ?? "");
  const out = await withTx(async (client): Promise<UnitStart | { kind: "running"; runId: number }> => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`connector_run:${tenantKey}:${scope.scopeVal}`]);
    const again = await client.query(
      `SELECT id FROM connector_run WHERE ${scope.scopeSql} AND status='running' ORDER BY started_at DESC LIMIT 1`, [scope.scopeVal]);
    if (again.rows[0]) return { kind: "running", runId: Number((again.rows[0] as { id: string | number }).id) };
    const seq = await client.query(`SELECT nextval(pg_get_serial_sequence('connector_run','id')) AS id`);
    const runId = Number((seq.rows[0] as { id: string | number }).id);
    const job = { system, runId, collectorId: opts.collectorId ?? null, full: opts.full === true };
    const memMb = Number(process.env.LIVELY_GATEWAY_JOB_MEM_MB) > 0 ? Number(process.env.LIVELY_GATEWAY_JOB_MEM_MB) : null;
    const launch = await u.launchRunUnit({ slug, codeRoot, job, env: u.jobEnvDoc(childEnv(system)), memMb });
    const insert = async (status: "running" | "error", log: string): Promise<void> => {
      await client.query(
        `INSERT INTO connector_run(id, system, mode, trigger, started_by, collector_id, status, finished_at, log, log_total)
         VALUES($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7='running' THEN NULL ELSE now() END, $8, char_length($8::text))`,
        [runId, system, mode, opts.trigger ?? "cron", opts.startedBy ?? null, opts.collectorId ?? null, status, log]);
    };
    const why = `${launch.reply.code ?? "?"}: ${String(launch.reply.error ?? "").slice(0, 500)}`;
    switch (launch.cls) {
      case "ok":
        await insert("running", `[tracker] 판 ${launch.unit} 에서 실행 — 게이트웨이 교대·재시작에 끊기지 않습니다.\n`);
        return { kind: "started", result: { runId, alreadyRunning: false, done: watchRunUnit(runId, slug) } };
      case "busy":
        throw new RunCapacityError(`수집 판 자리가 없습니다(${why}) — 도는 수집이 끝나면 다음 주기에 시작합니다.`);
      case "fallback":
        logger.warn({ system, slug, code: launch.reply.code, error: launch.reply.error }, "수집 판을 세우지 못해 게이트웨이 자식으로 실행");
        return { kind: "fallback", why };
      case "fail": {
        if (u.launchMayHaveStarted(launch.reply.code)) await u.stopRunUnit(slug, runId).catch(() => false);
        await insert("error", `[tracker] 판을 띄우지 못했다(${why}). 커서 미전진이라 다음 run 이 재수집합니다.\n`);
        logger.error({ system, slug, runId, code: launch.reply.code, error: launch.reply.error }, "수집 판 띄우기 실패");
        return { kind: "started", result: { runId, alreadyRunning: false, done: Promise.resolve({ ok: false, exitCode: null }) } };
      }
    }
  });
  if (out.kind === "running") {
    return { kind: "started", result: { runId: out.runId, alreadyRunning: true, done: Promise.resolve({ ok: true, exitCode: null }) } };
  }
  return out;
}

/** 종전 길 — 게이트웨이 자식으로 run-sync 를 띄우고 이 프로세스가 추적한다. note 가 있으면 로그 첫 줄로 남긴다. */
async function startRunAsChild(
  system: string,
  opts: { full?: boolean; trigger?: "cron" | "manual"; startedBy?: string | null; collectorId?: number | null },
  note: string | null,
): Promise<StartRunResult> {
  const mode = opts.full ? "full" : "incremental";
  const ins = await itemsPool.query(
    `INSERT INTO connector_run(system, mode, trigger, started_by, collector_id) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [system, mode, opts.trigger ?? "cron", opts.startedBy ?? null, opts.collectorId ?? null]);
  const runId = Number((ins.rows[0] as { id: string | number }).id);
  if (note) await appendRunLog(runId, `${note}\n`);

  //  #3994 T2-a — 자식에게 자기 run 번호를 넘긴다. 하트비트(생존 증거)를 자식이 직접 찍어야
  //   부모(게이트웨이)가 재시작해도 «살아 있는 수집» 이 유령으로 오판되지 않는다.
  const args = ["--env-file-if-exists=.env", "dist/connectors/run-sync.js", system, "--run", String(runId)];
  // 수집기 바인딩을 자식에게 넘긴다 — 자식은 이 id 로 config·커서 네임스페이스를 해소한다(config.bindCollector).
  if (opts.collectorId) args.push("--collector", String(opts.collectorId));
  if (opts.full) args.push("--full");
  const child = spawn("node", args, { cwd: process.cwd(), env: childEnv(system), stdio: ["ignore", "pipe", "pipe"] });
  liveRuns.set(runId, { child, canceled: false });
  if (child.pid) {
    await itemsPool.query(`UPDATE connector_run SET pid=$2 WHERE id=$1`, [runId, child.pid])
      .catch((e) => logger.warn({ e: (e as Error)?.message, runId }, "connector_run pid 기록 실패(무시)"));
  }
  const done = trackRunChild(runId, child, {
    isCanceled: () => liveRuns.get(runId)?.canceled === true,
    onClose: () => { liveRuns.delete(runId); },
  });
  return { runId, alreadyRunning: false, done };
}

export interface TrackOpts {
  /** 이 프로세스가 자식을 멈췄나(사용자 중지) — 끝 기록을 canceled 로. */
  isCanceled(): boolean;
  /** 자식이 닫힌 직후(끝 기록 전). */
  onClose?(): void;
  /** 자식 출력의 사본을 받을 곳(판 안 추적기가 자기 stdout 에 남긴다). */
  echo?(chunk: Buffer): void;
  /**
   * 끝 기록을 «아직 running 인 행에만» 쓴다(#3994 T3 판 추적기). 행이 이미 닫혔으면(사용자 중지·유령 정리) 덮지 않는다 —
   *  게이트웨이 자식 길은 종전대로 무조건 쓴다(그 길의 중지는 이 프로세스의 canceled 플래그가 나른다).
   */
  guardFinal?: boolean;
}

/**
 * 자식(run-sync) 하나를 추적해 connector_run 행에 적는다 — 로그 스트리밍·하트비트·정체/하드캡 종료·끝 기록.
 *  게이트웨이(자식 길)와 판 안 엔트리(job-entry)가 **같은 함수**를 쓴다: 판으로 옮겨도 기록 규칙이 한 벌이다.
 */
export function trackRunChild(runId: number, child: ChildProcess, o: TrackOpts): Promise<{ ok: boolean; exitCode: number | null }> {
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
  const onChunk = (c: Buffer) => { lastOutputAt = Date.now(); buf += c.toString("utf8"); o.echo?.(c); if (buf.length >= FLUSH_BYTES) void flush(); };
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

  return new Promise<{ ok: boolean; exitCode: number | null }>((resolve) => {
    child.on("error", (err) => { buf += `\n[tracker] spawn 실패: ${err.message}`; });
    child.on("close", (code) => {
      clearInterval(timer);
      clearInterval(killer);
      const canceled = o.isCanceled();
      o.onClose?.();
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
          `UPDATE connector_run SET status=$2, exit_code=$3, finished_at=now(), stats=$4::jsonb WHERE id=$1${o.guardFinal ? " AND status='running'" : ""}`,
          [runId, ok ? "ok" : canceled ? "canceled" : "error", code, stats == null ? null : JSON.stringify(stats)])
          .catch((e) => logger.warn({ e: (e as Error)?.message, runId }, "connector_run 종료 기록 실패"));
        resolve({ ok, exitCode: code });
      })();
    });
  });
}

/** 판 감시 주기 — DB 한 줄 조회. 판 추적기가 끝을 적으면 다음 주기에 안다. */
const UNIT_WATCH_MS = 5_000;
/** 박동이 끊긴 채 판 상태를 끝내 못 읽으면(op 에 못 닿음) 이만큼 뒤에 실패로 닫는다. */
const UNIT_BLIND_CLOSE_MS = 15 * 60_000;

/**
 * 판 실행이 끝나기를 기다린다(#3994 T3) — 크론의 `done`. 기록은 판 추적기가 하고, 이 함수는 **읽기만** 한다.
 *  · 행이 running 을 벗어나면 끝 — 판 결과 폴더를 치운다.
 *  · 박동이 끊겼고(유령 임계) 판이 **죽었으면** 판 추적기가 끝을 못 적은 것이다 — 사유(유닛 상태·stderr 꼬리)를 붙여 닫는다.
 *    판이 살아 있거나 상태를 모르면(op 못 닿음) 계속 본다. 다만 모르는 채 박동이 UNIT_BLIND_CLOSE_MS 넘게 끊기면 닫는다.
 *  · 이 게이트웨이가 교대로 사라지면 이 대기도 사라진다 — 판과 기록은 그대로 간다(다음 시작의 유령 정리·결과 폴더 청소가 수습).
 */
export function watchRunUnit(runId: number, slug: string, o: { everyMs?: number } = {}): Promise<{ ok: boolean; exitCode: number | null }> {
  const every = o.everyMs ?? UNIT_WATCH_MS;
  return new Promise((resolve) => {
    const finish = (v: { ok: boolean; exitCode: number | null }): void => {
      void unitMod().then((u) => u.reapRunUnit(slug, runId)).catch(() => false);
      resolve(v);
    };
    const tick = async (): Promise<void> => {
      try {
        const r = await itemsPool.query(
          `SELECT status, exit_code, EXTRACT(EPOCH FROM (now() - heartbeat_at)) * 1000 AS quiet_ms FROM connector_run WHERE id=$1`, [runId]);
        const row = r.rows[0] as { status: string; exit_code: number | null; quiet_ms: string | number } | undefined;
        if (!row) { resolve({ ok: false, exitCode: null }); return; }
        if (row.status !== "running") { finish({ ok: row.status === "ok", exitCode: row.exit_code }); return; }
        const quiet = Number(row.quiet_ms);
        if (quiet > HEARTBEAT_STALE_MS) {
          const u = await unitMod();
          const st = await u.runUnitState(slug, runId).catch(() => null);
          const live = u.jobUnitLive(st);
          if (live === false || (live === null && quiet > UNIT_BLIND_CLOSE_MS)) {
            const tail = live === false ? await u.runUnitStderrTail(slug, runId) : "";
            const reason = live === false ? u.jobGoneReason(st) : `판 상태를 읽지 못한 채 박동이 ${Math.round(quiet / 60000)}분 끊겼다`;
            const marker = `\n[tracker] ${reason}${tail ? ` — stderr: ${tail.slice(-1500)}` : ""}. 커서 미전진이라 다음 run 이 재수집합니다.`;
            const upd = await itemsPool.query(
              `UPDATE connector_run SET status='error', finished_at=now(),
                      log = right(log || $2, ${LOG_CAP}), log_total = log_total + char_length($2::text)
               WHERE id=$1 AND status='running'`, [runId, marker]);
            if (upd.rowCount) {
              if (live === null) await u.stopRunUnit(slug, runId).catch(() => false);
              logger.warn({ runId, slug, reason }, "수집 판이 끝 기록 없이 끝나 실패로 닫았다");
              finish({ ok: false, exitCode: null });
              return;
            }
          }
        }
      } catch { /* DB 일시 오류 — 다음 주기 */ }
      setTimeout(() => { void tick(); }, every);
    };
    setTimeout(() => { void tick(); }, every);
  });
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
  //  ★ 무조건 닫고 죽이던 자리(#3994 T2-a). 수집 자식은 부모와 함께 죽지 않으므로, kill 이 빗나가면
  //   그 자식이 완주해 **커서를 전진시키는데 run 행은 이미 error** 인 스플릿브레인이 났다.
  //   살아 있으면 이어받고(adopt), 죽었을 때만 닫는다. 판정은 orphanVerdict 한 곳.
  const { orphanVerdict, unitRunAlive } = await import("./sync-outcome.js");
  const cand = await itemsPool.query(
    `SELECT id, system, pid, EXTRACT(EPOCH FROM (now() - heartbeat_at)) * 1000 AS quiet_ms
     FROM connector_run WHERE status='running' AND NOT (id = ANY($1::bigint[]))`, [own]);
  let ctx: { slug: string } | null | undefined;   // 판 실행 행을 만났을 때만 한 번 묻는다
  for (const g of cand.rows as Array<{ id: number; system: string; pid: number | null; quiet_ms: string | number }>) {
    let aliveAndOurs: boolean;
    if (g.pid) aliveAndOurs = await isOurRunSync(g.pid, g.system);
    else {
      //  #3994 T3 — pid 없는 행은 판 실행이다(자식 실행은 띄우자마자 pid 를 적는다). 생존 입력을 pid 가 아니라
      //   판 추적기의 박동과 판 상태에서 받는다. 판정 규율(orphanVerdict)은 그대로다.
      const quietMs = Number(g.quiet_ms);
      let unitLive: boolean | null = null;
      if (!(quietMs <= HEARTBEAT_STALE_MS)) {
        if (ctx === undefined) ctx = await unitContext({ manage: true });
        if (ctx) {
          const u = await unitMod();
          unitLive = u.jobUnitLive(await u.runUnitState(ctx.slug, Number(g.id)).catch(() => null));
        }
      }
      aliveAndOurs = unitRunAlive({ quietMs, staleMs: HEARTBEAT_STALE_MS, unitLive });
    }
    const v = orphanVerdict({ pid: g.pid, aliveAndOurs });
    if (v.adopt) {
      logger.warn({ runId: g.id, system: g.system, pid: g.pid }, g.pid
        ? "부팅 스윕 — 살아 있는 수집 자식을 이어받는다(죽이지 않음)"
        : "부팅 스윕 — 살아 있는 수집 판을 이어받는다(판 추적기가 기록을 잇는다)");
      continue;
    }
    await itemsPool.query(
      `UPDATE connector_run SET status='error', finished_at=now(),
              log = right(log || $2, ${LOG_CAP}), log_total = log_total + char_length($2::text)
       WHERE id=$1 AND status='running'`, [g.id, marker])
      .catch((e) => logger.warn({ e: (e as Error)?.message, runId: g.id }, "고아 run 정리 실패(무시)"));
    logger.warn({ runId: g.id, system: g.system, pid: g.pid, killed: false }, "부팅 스윕 — 고아 connector_run 정리");
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
  const marker = row.pid ? `\n[tracker] ${who}(추적 부모 부재 — 직접 정리)` : `\n[tracker] ${who} — 판에 정지를 전한다`;
  const upd = await itemsPool.query(
    `UPDATE connector_run SET status='canceled', finished_at=now(),
            log = right(log || $2, ${LOG_CAP}), log_total = log_total + char_length($2::text)
     WHERE id=$1 AND status='running'`, [id, marker]);
  if (!upd.rowCount) {
    const cur = (await itemsPool.query(`SELECT status FROM connector_run WHERE id=$1`, [id])).rows[0] as { status: string } | undefined;
    return { ok: false, message: `이미 종료된 실행(${cur?.status ?? "?"})` };
  }
  if (!row.pid) {
    //  #3994 T3 판 실행 — 행을 **먼저** 닫았다(판 추적기의 끝 기록은 running 행에만 쓴다 — 여기 canceled 를 안 덮는다).
    //   그다음 판을 멈춘다. 멈춤은 비대기이고, 이미 끝난 판이면 op 가 성공으로 접는다.
    const ctx = await unitContext({ manage: true });
    if (ctx) {
      const stopped = await (await unitMod()).stopRunUnit(ctx.slug, id).catch(() => false);
      if (!stopped) return { ok: true, message: "중지로 기록했지만 판에 정지를 전하지 못했습니다 — 판은 시간 상한에 스스로 끝납니다." };
      return { ok: true, message: "중지됨 — 판에 정지를 전했습니다. 커서 미전진이라 다음 run 이 재수집합니다." };
    }
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
