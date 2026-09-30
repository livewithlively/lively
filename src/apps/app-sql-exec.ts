// 앱 자유 SQL 실행기 — 격벽 풀 · 호출 빈도 · 워크스페이스 동시 실행 · 용량 · 시간 상한 (#4226).
//
// ── 왜 따로 도나 (계획 지식 crm-dogfood-app-builder-plan-4200 §7-3) ──────────────────────────
//  게이트웨이 본체 풀은 20개(db/client.ts)를 매니지드 전 워크스페이스·전 기능이 같이 쓴다. 앱 SQL 이 그걸 잡으면
//  라이블리 전체가 멈춘다. 그래서 앱 SQL 은 **자기 풀(최대 4)** 에서만 돌고, 그 안에서도 한 워크스페이스가 풀을
//  독점하지 못하게 동시 실행을 2로 묶는다. 문장은 5초·잠금 대기 1초에서 끊고(잠금 대기가 연결을 붙잡는 게 가장 흔한
//  풀 고갈 경로다), 정렬·해시 메모리(work_mem)를 낮게 둔다 — DB 한 대(db.t4g.medium 4GB)를 전원이 나눠 쓴다.
//  결과는 DB 쪽에서 5,000행·5MB 로 자른다(app-sql.wrapForCaps). 호출 빈도는 (워크스페이스, 앱)마다 초당 10·순간 30.
//  용량은 워크스페이스 앱 데이터 1GB — 넘으면 쓰기(INSERT·UPDATE)를 거절한다(DELETE 는 공간을 비우므로 늘 된다).
//
// ── 실행 한 번 ───────────────────────────────────────────────────────────────────────────
//  BEGIN [READ ONLY] → 행 격리 값(app.tenant_id) → 시간·메모리 상한 → search_path=pg_catalog → SET LOCAL ROLE <앱 역할>
//  → 사용자 문장(확장 프로토콜 — DB 도 여러 문장을 거부한다) → COMMIT(쓰기)/ROLLBACK(읽기).
//  SET LOCAL 이라 트랜잭션이 끝나면 Postgres 가 전부 되돌린다 — 다음 차례가 앱 역할을 물려받지 않는다.
//  ⚠ 역할로 내려가는 게 **사용자 SQL 보다 먼저**다. 순서가 뒤집히면 그 SQL 이 런타임 권한으로 돈다.
import pg from "pg";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { itemsPool, boundTenantId } from "../db/client.js";
import { SINGLE_TENANT_ID } from "../db/tenant-column.js";
import { wrapForCaps, WRAP_COLUMNS, type AppSqlPlan } from "./app-sql.js";

// ── 상한(환경변수로 조정) ─────────────────────────────────────────────────────────────────
export interface AppSqlLimits {
  poolMax: number;         // 앱 전용 풀 연결 수
  perWorkspace: number;    // 워크스페이스당 동시 실행
  queueWaitMs: number;     // 동시 실행 자리를 기다리는 최대 시간
  statementMs: number;     // 문장 시간
  lockMs: number;          // 잠금 대기
  workMemKb: number;       // 정렬·해시 메모리
  maxRows: number;         // 결과 행
  maxBytes: number;        // 결과 바이트(행 텍스트 표현 합)
  ratePerSec: number;      // (워크스페이스, 앱)당 초당
  burst: number;           // 순간
  quotaBytes: number;      // 워크스페이스 앱 데이터 용량
}

const num = (v: unknown, dflt: number): number => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export function appSqlLimits(env: NodeJS.ProcessEnv = process.env): AppSqlLimits {
  return {
    poolMax: Math.floor(num(env.LIVELY_APP_SQL_POOL, 4)),
    perWorkspace: Math.floor(num(env.LIVELY_APP_SQL_PER_WORKSPACE, 2)),
    queueWaitMs: num(env.LIVELY_APP_SQL_QUEUE_MS, 5000),
    statementMs: Math.floor(num(env.LIVELY_APP_SQL_STATEMENT_MS, 5000)),
    lockMs: Math.floor(num(env.LIVELY_APP_SQL_LOCK_MS, 1000)),
    workMemKb: Math.floor(num(env.LIVELY_APP_SQL_WORK_MEM_KB, 4096)),
    maxRows: Math.floor(num(env.LIVELY_APP_SQL_MAX_ROWS, 5000)),
    maxBytes: Math.floor(num(env.LIVELY_APP_SQL_MAX_BYTES, 5 * 1024 * 1024)),
    ratePerSec: num(env.LIVELY_APP_SQL_RATE, 10),
    burst: num(env.LIVELY_APP_SQL_BURST, 30),
    quotaBytes: num(env.LIVELY_APP_DATA_QUOTA_BYTES, 1024 * 1024 * 1024),
  };
}

// ── 호출 빈도 — 토큰 버킷 ────────────────────────────────────────────────────────────────
//  AI 반복 루프·화면 버그의 폭주를 막는다. 키 = (워크스페이스, 앱). 프로세스 안 기억이라 게이트웨이마다 따로 센다
//  (매니지드 중앙 게이트웨이는 하나다). 오래 안 쓴 키는 가득 찬 버킷과 같으므로 지워도 결과가 같다.
export class TokenBuckets {
  private readonly b = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly rate: number, private readonly burst: number, private readonly now: () => number = Date.now) {}
  /** 한 번 쓴다. 된다면 0, 막히면 다시 해도 되는 때까지 남은 ms. */
  take(key: string): number {
    const t = this.now();
    const cur = this.b.get(key) ?? { tokens: this.burst, at: t };
    const tokens = Math.min(this.burst, cur.tokens + ((t - cur.at) / 1000) * this.rate);
    if (tokens < 1) { this.b.set(key, { tokens, at: t }); return Math.ceil(((1 - tokens) / this.rate) * 1000); }
    this.b.set(key, { tokens: tokens - 1, at: t });
    if (this.b.size > 10_000) this.sweep(t);
    return 0;
  }
  private sweep(t: number): void {
    for (const [k, v] of this.b) if (v.tokens + ((t - v.at) / 1000) * this.rate >= this.burst) this.b.delete(k);
  }
}

// ── 워크스페이스 동시 실행 — 키별 세마포어 ────────────────────────────────────────────────
export class KeyedSemaphore {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  constructor(private readonly limit: number) {}
  /** 자리를 얻으면 풀어 줄 함수를 준다. waitMs 안에 못 얻으면 null. */
  async acquire(key: string, waitMs: number): Promise<(() => void) | null> {
    if ((this.active.get(key) ?? 0) < this.limit) { this.active.set(key, (this.active.get(key) ?? 0) + 1); return this.releaser(key); }
    return new Promise((resolve) => {
      const q = this.waiting.get(key) ?? [];
      let done = false;
      const grant = (): void => { if (done) return; done = true; clearTimeout(timer); resolve(this.releaser(key)); };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const list = this.waiting.get(key);
        if (list) { const i = list.indexOf(grant); if (i >= 0) list.splice(i, 1); if (!list.length) this.waiting.delete(key); }
        resolve(null);
      }, waitMs);
      q.push(grant);
      this.waiting.set(key, q);
    });
  }
  private releaser(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.get(key)?.shift();
      if (this.waiting.get(key)?.length === 0) this.waiting.delete(key);
      if (next) { next(); return; }                                  // 자리를 그대로 넘긴다(active 수는 그대로)
      const n = (this.active.get(key) ?? 1) - 1;
      if (n <= 0) this.active.delete(key); else this.active.set(key, n);
    };
  }
  /** 테스트용 — 지금 그 키가 쥔 자리 수. */
  inUse(key: string): number { return this.active.get(key) ?? 0; }
}

let limits = appSqlLimits();
let buckets = new TokenBuckets(limits.ratePerSec, limits.burst);
let slots = new KeyedSemaphore(limits.perWorkspace);
let pool: pg.Pool | null = null;
/** 닫는 중인 옛 풀들 — closeAppSqlPool 이 끝까지 기다린다. */
const closing: Array<Promise<void>> = [];

/** 테스트·운영 조정 — 상한을 다시 읽고 기억(버킷·세마포어)을 새로 만든다. 풀은 다음 사용 때 새 크기로 만든다. */
export function resetAppSqlLimits(env: NodeJS.ProcessEnv = process.env): AppSqlLimits {
  limits = appSqlLimits(env);
  buckets = new TokenBuckets(limits.ratePerSec, limits.burst);
  slots = new KeyedSemaphore(limits.perWorkspace);
  if (pool) { const p = pool; pool = null; closing.push(p.end().catch(() => undefined)); }
  quotaCache.clear();
  return limits;
}

/** 앱 전용 풀을 닫는다(기다린다) — 시험 정리·종료 경로. DB 를 지우기 전에 불러야 끊긴 연결의 오류가 처리되지 않은 채 튀지 않는다. */
export async function closeAppSqlPool(): Promise<void> {
  if (pool) { const p = pool; pool = null; closing.push(p.end().catch(() => undefined)); }
  const all = closing.splice(0);
  await Promise.all(all);
}

/** 앱 전용 풀 — 본체 풀과 같은 DSN(런타임 역할)이지만 따로 센다. 처음 쓸 때 만든다. */
function appSqlPool(): pg.Pool {
  if (pool) return pool;
  const dsn = (process.env.ITEMS_DATABASE_URL ?? "").trim();
  if (!dsn) throw new HttpError(503, "DB 주소(ITEMS_DATABASE_URL)가 없어 앱 SQL 을 돌릴 수 없습니다");
  pool = new pg.Pool({
    connectionString: dsn, max: limits.poolMax,
    connectionTimeoutMillis: limits.queueWaitMs, idleTimeoutMillis: 30_000, application_name: "lively-app-sql",
  });
  pool.on("error", (err) => logger.warn({ err }, "앱 SQL 풀 유휴 연결 오류(연결을 버린다)"));
  return pool;
}

/** 이 요청의 행 격리 값 — 본체 풀과 같은 리졸버. 바인딩이 없으면(단일 테넌트) 단일 테넌트 id. */
export function appSqlTenantId(): string {
  return boundTenantId() ?? SINGLE_TENANT_ID;
}

// ── 빈도 게이트(store_* 와 store_sql 이 같이 쓴다) ────────────────────────────────────────
//  워크스페이스가 만든 앱만 센다 — 기본 앱은 라이블리가 싣는 코드라 화면이 부르는 모양을 우리가 안다(격리 리뷰: 기본 앱은
//  store_sql 로 묶어 쓸 길도 없어 429 가 막다른 길이 된다).
export function takeAppCall(appId: string, tenantId: string = appSqlTenantId()): void {
  const wait = buckets.take(`${tenantId}\0${appId}`);
  if (wait > 0) {
    throw new HttpError(429, `앱 '${appId}' 호출이 너무 잦습니다(초당 ${limits.ratePerSec}·순간 ${limits.burst}) — ${Math.ceil(wait / 100) / 10}초 뒤 다시 하세요. 여러 행은 store_sql 한 문장으로 한 번에 쓰세요`,
      { body: { retry_after_ms: wait } });
  }
}

// ── 용량 ─────────────────────────────────────────────────────────────────────────────────
//  워크스페이스 스키마 테이블(인덱스·TOAST 포함)의 합. 10초 기억 — 쓰기마다 카탈로그를 훑지 않게.
//  ⚠ **소프트 상한**이다: 문장 전에만 재고 기억이 10초라, 그 사이 큰 INSERT … SELECT 몇 개가 상한을 넘겨 쓸 수 있다
//   (문장 5초 · 동시 2 가 넘는 폭을 묶는다). 넘은 뒤엔 다음 측정부터 쓰기가 막힌다.
//  세지 않는 것: 보관 스키마(<스키마>_archive — 사람이 비울 도구가 아직 없어 거기서 막히면 풀 길이 없다) ·
//   떠 두기(org_app_snapshot — 본체 테이블에 있고 7일이면 지워진다).
const QUOTA_TTL_MS = 10_000;
const quotaCache = new Map<string, { bytes: number; at: number }>();

export async function appDataBytes(schema: string): Promise<number> {
  const hit = quotaCache.get(schema);
  if (hit && Date.now() - hit.at < QUOTA_TTL_MS) return hit.bytes;
  const r = await itemsPool.query(
    `SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0)::bigint AS b
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p')`, [schema]);
  const bytes = Number(r.rows[0]?.b ?? 0);
  quotaCache.set(schema, { bytes, at: Date.now() });
  return bytes;
}

/** 쓰기 전에 — 워크스페이스 앱 데이터가 상한을 넘었으면 507. 공유 스키마(기본 앱)는 워크스페이스 몫을 셀 수 없어 보지 않는다. */
export async function assertAppDataQuota(schema: string, shared: boolean): Promise<void> {
  if (shared) return;
  const bytes = await appDataBytes(schema);
  if (bytes > limits.quotaBytes) {
    const mb = (b: number): string => `${Math.round(b / 1024 / 1024)}MB`;
    throw new HttpError(507, `이 워크스페이스의 앱 데이터가 상한(${mb(limits.quotaBytes)})을 넘었습니다(지금 ${mb(bytes)}) — `
      + "쓰기는 막히고 읽기·삭제는 됩니다. 필요 없는 행을 지우거나 관리자에게 알려 주세요");
  }
}

// ── 실행 ─────────────────────────────────────────────────────────────────────────────────
export interface AppSqlResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
  /** 행·바이트 상한 때문에 다 못 돌려줬나. */
  truncated: boolean;
  /** 쓰기가 바꾼 행 수(SELECT 는 null). */
  changed: number | null;
  ms: number;
}

const qid = (n: string): string => { if (!/^[a-z_][a-z0-9_]*$/.test(n)) throw new HttpError(500, `안전하지 않은 역할 이름: ${n}`); return `"${n}"`; };

/** Postgres 오류 → 사람이 읽을 HttpError. 물리 이름(스키마·앱 접두)은 선언 이름으로 되돌려 보인다. */
function mapPgError(e: unknown, hide: (s: string) => string, l: AppSqlLimits): HttpError {
  if (e instanceof HttpError) return e;
  const err = e as { code?: string; message?: string };
  const code = String(err?.code ?? "");
  const msg = hide(String(err?.message ?? e));
  if (code === "57014") return new HttpError(408, `${l.statementMs / 1000}초 안에 끝나지 않아 멈췄습니다 — 조건을 좁히거나 매니페스트에 인덱스를 선언하세요`, { cause: e });
  if (code === "55P03") return new HttpError(409, `다른 작업이 같은 행을 잡고 있어 ${l.lockMs / 1000}초 넘게 기다리다 멈췄습니다 — 잠시 뒤 다시 하세요`, { cause: e });
  if (code === "42501") return new HttpError(403, `권한이 없습니다 — 이 앱의 테이블만 쓸 수 있습니다(${msg})`, { cause: e });
  if (code === "25006") return new HttpError(400, `읽기 문장에서 쓰기를 할 수 없습니다(${msg})`, { cause: e });
  if (code.startsWith("23")) return new HttpError(409, `제약 조건에 걸렸습니다: ${msg}`, { cause: e });
  if (code.startsWith("22") || code.startsWith("42") || code === "0A000" || code.startsWith("54")) return new HttpError(400, `SQL 오류: ${msg}`, { cause: e });
  if (/timeout exceeded when trying to connect/i.test(msg)) return new HttpError(503, "앱 DB 연결이 모두 쓰이고 있습니다 — 잠시 뒤 다시 하세요", { cause: e });
  return new HttpError(500, `앱 SQL 실행 실패: ${msg}`, { cause: e });
}

export interface RunAppSqlOpts {
  plan: AppSqlPlan;
  params: unknown[];
  role: string;
  appId: string;
  schema: string;
  /** 오류 문구에서 물리 이름을 지울 때 쓰는 앱 접두(`crm_dash__`). */
  physicalPrefix: string;
  tenantId?: string;
}

/**
 * 계획된 문장 하나를 앱 역할로 실행한다. 빈도·동시 실행·용량 게이트는 호출부가 먼저 부른다(takeAppCall · assertAppDataQuota)
 *  — 여기선 워크스페이스 자리와 풀 연결을 얻고, 상한을 걸고, 돌린다.
 */
export async function runAppSql(o: RunAppSqlOpts): Promise<AppSqlResult> {
  const l = limits;
  const tenantId = o.tenantId ?? appSqlTenantId();
  const hide = (s: string): string => s.split(`"${o.schema}".`).join("").split(`${o.schema}.`).join("").split(o.physicalPrefix).join("");
  const release = await slots.acquire(tenantId, l.queueWaitMs);
  if (!release) {
    throw new HttpError(429, `이 워크스페이스에서 동시에 도는 앱 SQL 이 ${l.perWorkspace}개라 ${l.queueWaitMs / 1000}초를 기다리다 멈췄습니다 — 잠시 뒤 다시 하세요`);
  }
  const started = Date.now();
  let client: pg.PoolClient | null = null;
  let broken: unknown = undefined;
  try {
    try { client = await appSqlPool().connect(); }
    catch (e) { throw mapPgError(e, hide, l); }
    try {
      await client.query(o.plan.writes ? "BEGIN" : "BEGIN READ ONLY");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(`SET LOCAL statement_timeout = ${l.statementMs}`);
      await client.query(`SET LOCAL lock_timeout = ${l.lockMs}`);
      await client.query(`SET LOCAL work_mem = '${l.workMemKb}kB'`);
      await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
      await client.query(`SET LOCAL ROLE ${qid(o.role)}`);
      const r = await client.query({
        text: wrapForCaps(o.plan, { maxRows: l.maxRows, maxBytes: l.maxBytes }),
        values: o.params,
        rowMode: "array",
        queryMode: "extended",
      } as pg.QueryConfig & { rowMode: "array"; queryMode: "extended" });
      await client.query(o.plan.writes ? "COMMIT" : "ROLLBACK");
      const ms = Date.now() - started;
      if (ms > 1000) logger.warn({ app: o.appId, tenant: tenantId, ms, kind: o.plan.kind, tables: o.plan.tables }, "앱 SQL 이 1초를 넘었습니다");
      return shapeResult(o.plan, r, ms);
    } catch (e) {
      if (client) await client.query("ROLLBACK").catch((re) => { broken = re; });
      throw mapPgError(e, hide, l);
    }
  } finally {
    if (client) client.release(broken as Error | undefined);
    release();
  }
}

/** 감싼 결과를 떼어 낸다 — 끝 세 칸은 실행기 몫, __lively_rn 이 NULL 인 행은 «데이터 없음» 표지. 겹치는 칸 이름은 _2… 를 붙인다. */
export function shapeResult(plan: Pick<AppSqlPlan, "returning" | "writes">, r: { fields: Array<{ name: string }>; rows: unknown[][]; rowCount: number | null }, ms: number): AppSqlResult {
  if (!plan.returning) {
    return { columns: [], rows: [], row_count: 0, truncated: false, changed: r.rowCount ?? 0, ms };
  }
  const names = r.fields.map((f) => f.name);
  const k = names.length - WRAP_COLUMNS.length;
  if (k < 0 || WRAP_COLUMNS.some((c, i) => names[k + i] !== c)) throw new HttpError(500, "앱 SQL 결과 모양이 예상과 다릅니다");
  const seen = new Map<string, number>();
  const columns = names.slice(0, k).map((n) => {
    const c = (seen.get(n) ?? 0) + 1;
    seen.set(n, c);
    return c === 1 ? n : `${n}_${c}`;
  });
  let total = 0;
  const rows: Array<Record<string, unknown>> = [];
  for (const row of r.rows) {
    total = Number(row[k + 2] ?? 0);
    if (row[k] === null || row[k] === undefined) continue;          // «데이터 없음» 표지
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => { o[c] = row[i]; });
    rows.push(o);
  }
  return { columns, rows, row_count: rows.length, truncated: total > rows.length, changed: plan.writes ? total : null, ms };
}

/** 시험 전용 — 앱 전용 풀(연결이 SET LOCAL 뒤 원래대로 돌아왔는지 PG 시험이 잰다). */
export function _appSqlPoolForTest(): pg.Pool { return appSqlPool(); }
