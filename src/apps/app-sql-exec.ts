// 앱 자유 SQL 실행기 — 격벽 풀 · 호출 빈도 · 고객 사이 공평 분배 · 용량 · 시간 상한 · 묶음 트랜잭션 (#4226 · #4483).
//
// ── 왜 따로 도나 (계획 지식 crm-dogfood-app-builder-plan-4200 §7-3) ──────────────────────────
//  게이트웨이 본체 풀은 20개(db/client.ts)를 매니지드 전 워크스페이스·전 기능이 같이 쓴다. 앱 SQL 이 그걸 잡으면
//  라이블리 전체가 멈춘다. 그래서 앱 SQL 은 **자기 풀(최대 4)** 에서만 돌고, 그 안에서도 한 워크스페이스가 풀을
//  독점하지 못하게 동시 실행을 2로 묶는다. 문장은 5초·잠금 대기 1초에서 끊고(잠금 대기가 연결을 붙잡는 게 가장 흔한
//  풀 고갈 경로다), 정렬·해시 메모리(work_mem)를 낮게 둔다 — DB 한 대(db.t4g.medium 4GB)를 전원이 나눠 쓴다.
//  결과는 DB 쪽에서 5,000행·5MB 로 자른다(app-sql.wrapForCaps). 호출 빈도는 (워크스페이스, 앱)마다 초당 10·순간 30.
//  용량은 워크스페이스 앱 데이터 1GB — 넘으면 쓰기(INSERT·UPDATE)를 거절한다(DELETE 는 공간을 비우므로 늘 된다).
//
// ── 공평 분배 (#4483) ────────────────────────────────────────────────────────────────────
//  풀 자리는 고객(워크스페이스)들이 나눠 쓴다. 종전엔 자리가 비면 먼저 줄 선 순서(FIFO)로 넘겼다 — 한 고객이 대기열을
//  채우면 다른 고객은 그 뒤에 섰다. 이제 빈 자리는 **지금 가장 적게 쓰고 있는 고객**의 대기자에게 먼저 간다(같으면
//  먼저 온 쪽). 실행 중인 문장을 뺏지는 않는다 — 문장은 5초 안에 끝나므로 다음 빈 자리부터 바로잡힌다.
//
// ── 실행 한 번 = DB 왕복 3번 (#4483 — 종전 9번) ──────────────────────────────────────────
//  ① 준비 한 덩이(단순 질의 프로토콜 — 여러 문장): BEGIN [READ ONLY] · 행 격리 값(app.tenant_id) · 시간·메모리 상한 ·
//     search_path=pg_catalog · standard_conforming_strings=on(검사기의 렉서와 DB 렉서를 같게 고정) · SET LOCAL ROLE <앱 역할>
//  ② 사용자 문장(확장 프로토콜 — 값은 바인딩, DB 도 여러 문장을 거부한다) — 묶음이면 문장마다 한 번
//     id 를 직접 넣은 문장(INSERT … OVERRIDING SYSTEM VALUE) 뒤엔 그 표의 id 시퀀스를 맞추는 한 덩이를 더 보낸다(#5172 idResyncSql)
//  ③ COMMIT(쓰기·잠금)/ROLLBACK(읽기)
//  SET LOCAL 이라 트랜잭션이 끝나면 Postgres 가 전부 되돌린다 — 다음 차례가 앱 역할을 물려받지 않는다.
//  ⚠ 역할로 내려가는 게 **사용자 SQL 보다 먼저**다. ① 이 실패하면(어느 한 줄이라도) ② 는 보내지 않는다.
//  ⚠ ① 에 문자열로 끼우는 값은 행 격리 값 하나뿐이고, 그건 UUID 모양을 확인한 뒤에만 끼운다. id 맞춤 한 덩이(#5172)에 끼우는
//   표 이름도 인용 이름 모양을 확인한 뒤에만 끼운다.
import pg from "pg";
import { performance } from "node:perf_hooks";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { itemsPool, boundTenantId } from "../db/client.js";
import { SINGLE_TENANT_ID } from "../db/tenant-column.js";
import { wrapForCaps, WRAP_COLUMNS, type AppSqlPlan } from "./app-sql.js";
import { qualifiedAppTable } from "./store-ddl.js";

// ── 상한(환경변수로 조정) ─────────────────────────────────────────────────────────────────
export interface AppSqlLimits {
  poolMax: number;         // 앱 전용 풀 연결 수 = 동시에 도는 앱 SQL 전체 상한
  perWorkspace: number;    // 워크스페이스당 동시 실행
  queueWaitMs: number;     // 동시 실행 자리를 기다리는 최대 시간
  statementMs: number;     // 문장 시간
  lockMs: number;          // 잠금 대기
  workMemKb: number;       // 정렬·해시 메모리
  maxRows: number;         // 결과 행(문장마다)
  maxBytes: number;        // 결과 바이트(행 텍스트 표현 합 — 묶음은 문장 전체가 나눠 쓴다)
  ratePerSec: number;      // (워크스페이스, 앱)당 초당
  burst: number;           // 순간
  quotaBytes: number;      // 워크스페이스 앱 데이터 용량
  batchMax: number;        // 묶음 한 번의 문장 수
  batchMs: number;         // 묶음 한 번의 전체 시간
  serverRatePerSec: number; // 앱 서버(사람 신원을 실은 호출) — (워크스페이스, 앱) 전체 초당. 사람마다는 ratePerSec·burst
  serverBurst: number;      // 앱 서버 — (워크스페이스, 앱) 전체 순간
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
    batchMax: Math.floor(num(env.LIVELY_APP_SQL_BATCH_MAX, 20)),
    batchMs: Math.floor(num(env.LIVELY_APP_SQL_BATCH_MS, 10_000)),
    serverRatePerSec: num(env.LIVELY_APP_SQL_SERVER_RATE, 50),
    serverBurst: num(env.LIVELY_APP_SQL_SERVER_BURST, 150),
  };
}

// ── 호출 빈도 — 토큰 버킷 ────────────────────────────────────────────────────────────────
//  AI 반복 루프·화면 버그의 폭주를 막는다. 키 = (워크스페이스, 앱). 프로세스 안 기억이라 게이트웨이마다 따로 센다
//  (매니지드 중앙 게이트웨이는 하나다). 오래 안 쓴 키는 가득 찬 버킷과 같으므로 지워도 결과가 같다.
//  묶음은 문장 수만큼 쓴다(n) — 묶음으로 빈도 상한을 우회하지 못하게.
export class TokenBuckets {
  private readonly b = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly rate: number, private readonly burst: number, private readonly now: () => number = Date.now) {}
  /** n 개를 한꺼번에 쓴다. 된다면 0, 막히면 다시 해도 되는 때까지 남은 ms(아무것도 쓰지 않는다). */
  take(key: string, n = 1): number {
    const t = this.now();
    const cur = this.b.get(key) ?? { tokens: this.burst, at: t };
    const tokens = Math.min(this.burst, cur.tokens + ((t - cur.at) / 1000) * this.rate);
    if (tokens < n) { this.b.set(key, { tokens, at: t }); return Math.ceil(((n - tokens) / this.rate) * 1000); }
    this.b.set(key, { tokens: tokens - n, at: t });
    if (this.b.size > 10_000) this.sweep(t);
    return 0;
  }
  /** 방금 쓴 n 개를 되돌린다(두 버킷을 차례로 볼 때 뒤 버킷이 막히면 앞 버킷 몫을 돌려준다). */
  refund(key: string, n = 1): void {
    const cur = this.b.get(key);
    if (cur) cur.tokens = Math.min(this.burst, cur.tokens + n);
  }
  private sweep(t: number): void {
    for (const [k, v] of this.b) if (v.tokens + ((t - v.at) / 1000) * this.rate >= this.burst) this.b.delete(k);
  }
}

// ── 공평 스케줄러 — 전체 상한 · 키(워크스페이스)당 상한 · 빈 자리는 가장 적게 쓰는 키부터 ────────────
export class FairScheduler {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<{ grant: () => void; at: number }>>();
  private used = 0;
  private seq = 0;
  constructor(private readonly total: number, private readonly perKey: number) {}

  /** 자리를 얻으면 풀어 줄 함수를 준다. waitMs 안에 못 얻으면 null. */
  async acquire(key: string, waitMs: number): Promise<(() => void) | null> {
    if (this.used < this.total && (this.active.get(key) ?? 0) < this.perKey && !this.waiting.get(key)?.length) {
      this.take(key);
      return this.releaser(key);
    }
    return new Promise((resolve) => {
      const q = this.waiting.get(key) ?? [];
      let done = false;
      const entry = {
        at: this.seq++,
        grant: (): void => { if (done) return; done = true; clearTimeout(timer); resolve(this.releaser(key)); },
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const list = this.waiting.get(key);
        if (list) { const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1); if (!list.length) this.waiting.delete(key); }
        resolve(null);
      }, waitMs);
      q.push(entry);
      this.waiting.set(key, q);
    });
  }

  private take(key: string): void {
    this.used++;
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
  }

  private releaser(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      const n = (this.active.get(key) ?? 1) - 1;
      if (n <= 0) this.active.delete(key); else this.active.set(key, n);
      this.dispatch();
    };
  }

  /** 빈 자리를 넘긴다 — 대기자가 있고 키 상한 아래인 키 가운데 지금 가장 적게 쓰는 키(같으면 먼저 온 대기자). */
  private dispatch(): void {
    while (this.used < this.total) {
      let best: string | null = null, bestActive = Infinity, bestAt = Infinity;
      for (const [k, q] of this.waiting) {
        const a = this.active.get(k) ?? 0;
        if (!q.length || a >= this.perKey) continue;
        if (a < bestActive || (a === bestActive && q[0].at < bestAt)) { best = k; bestActive = a; bestAt = q[0].at; }
      }
      if (best === null) return;
      const q = this.waiting.get(best)!;
      const next = q.shift()!;
      if (!q.length) this.waiting.delete(best);
      this.take(best);
      next.grant();
    }
  }

  /** 시험·지표용 — 그 키가 쥔 자리 수 · 전체 쓰는 자리 · 기다리는 수. */
  inUse(key: string): number { return this.active.get(key) ?? 0; }
  snapshot(): { used: number; waiting: number; keys: number } {
    let w = 0;
    for (const q of this.waiting.values()) w += q.length;
    return { used: this.used, waiting: w, keys: this.active.size };
  }
}

// ── 지표 — 최근 표본(문장 지연·자리 대기)과 셈 ───────────────────────────────────────────
//  측정 ②(문장당 지연 p50·p95, 부하 때 다른 고객의 대기)와 «앱 SQL 을 따로 뗄 기준» 판정에 쓴다. 프로세스 안 기억이다.
const SAMPLES = 4096;
class Ring {
  private readonly a: number[] = [];
  private i = 0;
  push(v: number): void { if (this.a.length < SAMPLES) this.a.push(v); else { this.a[this.i] = v; this.i = (this.i + 1) % SAMPLES; } }
  pct(p: number): number | null {
    if (!this.a.length) return null;
    const s = [...this.a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  }
  get n(): number { return this.a.length; }
  clear(): void { this.a.length = 0; this.i = 0; }
}
let cpuBase = process.cpuUsage();
let eluBase = performance.eventLoopUtilization();
const stats = {
  since: Date.now(),
  calls: 0, statements: 0, batches: 0, errors: 0, rejectedQueue: 0, rejectedPool: 0,
  waitMs: new Ring(), execMs: new Ring(), stmtMs: new Ring(), planUs: new Ring(),
};
/** 검사기가 문장 하나에 쓴 시간(µs) — 가게 핸들러가 잰다. */
export function recordPlanMicros(us: number): void { stats.planUs.push(us); }
export interface AppSqlStats {
  since: string; calls: number; statements: number; batches: number; errors: number; rejected_queue: number; rejected_pool: number;
  wait_ms: { p50: number | null; p95: number | null; max: number | null; n: number };
  exec_ms: { p50: number | null; p95: number | null; max: number | null; n: number };
  statement_ms: { p50: number | null; p95: number | null; n: number };
  plan_us: { p50: number | null; p95: number | null; n: number };
  scheduler: { used: number; waiting: number; keys: number };
  limits: { pool: number; per_workspace: number };
  /** 이 게이트웨이 프로세스 전체(앱 SQL 만이 아니다)의 CPU 시간·이벤트 루프 사용률 — since 부터. */
  process: { cpu_user_ms: number; cpu_system_ms: number; elapsed_ms: number; cpu_pct: number; event_loop_utilization: number };
}
export function appSqlStats(reset = false): AppSqlStats {
  const out: AppSqlStats = {
    since: new Date(stats.since).toISOString(),
    calls: stats.calls, statements: stats.statements, batches: stats.batches, errors: stats.errors,
    rejected_queue: stats.rejectedQueue, rejected_pool: stats.rejectedPool,
    wait_ms: { p50: stats.waitMs.pct(50), p95: stats.waitMs.pct(95), max: stats.waitMs.pct(100), n: stats.waitMs.n },
    exec_ms: { p50: stats.execMs.pct(50), p95: stats.execMs.pct(95), max: stats.execMs.pct(100), n: stats.execMs.n },
    statement_ms: { p50: stats.stmtMs.pct(50), p95: stats.stmtMs.pct(95), n: stats.stmtMs.n },
    plan_us: { p50: stats.planUs.pct(50), p95: stats.planUs.pct(95), n: stats.planUs.n },
    scheduler: slots.snapshot(),
    limits: { pool: limits.poolMax, per_workspace: limits.perWorkspace },
    process: (() => {
      const c = process.cpuUsage(cpuBase);
      const elapsed = Math.max(1, Date.now() - stats.since);
      return {
        cpu_user_ms: Math.round(c.user / 1000), cpu_system_ms: Math.round(c.system / 1000), elapsed_ms: elapsed,
        cpu_pct: Math.round(((c.user + c.system) / 1000 / elapsed) * 1000) / 10,
        event_loop_utilization: Math.round(performance.eventLoopUtilization(eluBase).utilization * 1000) / 1000,
      };
    })(),
  };
  if (reset) {
    cpuBase = process.cpuUsage();
    eluBase = performance.eventLoopUtilization();
    stats.since = Date.now();
    stats.calls = stats.statements = stats.batches = stats.errors = stats.rejectedQueue = stats.rejectedPool = 0;
    for (const r of [stats.waitMs, stats.execMs, stats.stmtMs, stats.planUs]) r.clear();
  }
  return out;
}

let limits = appSqlLimits();
let buckets = new TokenBuckets(limits.ratePerSec, limits.burst);
let serverBuckets = new TokenBuckets(limits.serverRatePerSec, limits.serverBurst);
let slots = new FairScheduler(limits.poolMax, limits.perWorkspace);
let pool: pg.Pool | null = null;
/** 닫는 중인 옛 풀들 — closeAppSqlPool 이 끝까지 기다린다. */
const closing: Array<Promise<void>> = [];

/** 지금 상한(읽기 전용 사본). */
export function currentAppSqlLimits(): AppSqlLimits { return { ...limits }; }

/** 테스트·운영 조정 — 상한을 다시 읽고 기억(버킷·스케줄러)을 새로 만든다. 풀은 다음 사용 때 새 크기로 만든다. */
export function resetAppSqlLimits(env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): AppSqlLimits {
  limits = appSqlLimits(env);
  //  now — 시험이 시계를 넘겨 준다(빈도 버킷이 실제 시간에 기대면 부하 걸린 CI 에서 그새 다시 차 흔들린다).
  buckets = new TokenBuckets(limits.ratePerSec, limits.burst, now);
  serverBuckets = new TokenBuckets(limits.serverRatePerSec, limits.serverBurst, now);
  slots = new FairScheduler(limits.poolMax, limits.perWorkspace);
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

/** 앱 전용 풀 — 본체 풀과 같은 DSN(런타임 역할)이지만 따로 센다. 처음 쓸 때 만든다. 크기 = 스케줄러 전체 상한. */
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
//  앱 서버(#4483 — 사람 신원을 실은 호출)는 한 앱이 여러 사람을 받는다. (워크스페이스, 앱) 하나에 초당 10 을 걸면 서너 명이
//  동시에 쓰는 순간 막힌다 — 그래서 **사람마다** 초당 10·순간 30 을 따로 세고, 앱 전체는 초당 50·순간 150 으로 묶는다.
//  DB 를 지키는 건 여전히 스케줄러다(워크스페이스당 동시 2 · 전체 풀 4).
export function takeAppCall(appId: string, tenantId: string = appSqlTenantId(), n = 1, person?: string): void {
  const appKey = `${tenantId}\0${appId}`;
  if (person) {
    const pk = `${appKey}\0${person}`;
    const w1 = buckets.take(pk, n);
    if (w1 > 0) {
      throw new HttpError(429, `앱 '${appId}' 에서 이 사람의 호출이 너무 잦습니다(초당 ${limits.ratePerSec}·순간 ${limits.burst}) — ${Math.ceil(w1 / 100) / 10}초 뒤 다시 하세요`,
        { body: { retry_after_ms: w1 } });
    }
    const w2 = serverBuckets.take(appKey, n);
    if (w2 > 0) {
      buckets.refund(pk, n);
      throw new HttpError(429, `앱 '${appId}' 의 전체 호출이 너무 잦습니다(앱 서버 초당 ${limits.serverRatePerSec}·순간 ${limits.serverBurst}) — ${Math.ceil(w2 / 100) / 10}초 뒤 다시 하세요. 여러 행은 한 문장·묶음으로 쓰세요`,
        { body: { retry_after_ms: w2 } });
    }
    return;
  }
  const wait = buckets.take(appKey, n);
  if (wait > 0) {
    throw new HttpError(429, `앱 '${appId}' 호출이 너무 잦습니다(초당 ${limits.ratePerSec}·순간 ${limits.burst}${n > 1 ? ` · 이번 묶음 ${n}문장` : ""}) — ${Math.ceil(wait / 100) / 10}초 뒤 다시 하세요. 여러 행은 INSERT … VALUES (…),(…) 한 문장으로 쓰세요`,
      { body: { retry_after_ms: wait } });
  }
}

// ── 용량 ─────────────────────────────────────────────────────────────────────────────────
//  워크스페이스 스키마 테이블(인덱스·TOAST 포함)의 합. 10초 기억 — 쓰기마다 카탈로그를 훑지 않게.
//  ⚠ **소프트 상한**이다: 문장 전에만 재고 기억이 10초라, 그 사이 큰 INSERT … SELECT 몇 개가 상한을 넘겨 쓸 수 있다
//   (문장 5초 · 동시 2 가 넘는 폭을 묶는다). 넘은 뒤엔 다음 측정부터 쓰기가 막힌다.
//  세지 않는 것: 보관 스키마(<스키마>_archive — 앱이 쓰지 않는 자리라 앱을 쓰는 사람이 비울 수 없다. 관리자가 비운다 — #4733 app_archive_clear) ·
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
/** 결과 모양 — objects: 칸 이름 → 값(pg 기본 해석, 사람·AI 용) · wire: 값은 DB 가 준 글자 그대로 + 칸 형 OID(SDK 드라이버 용 —
 *  node-postgres 와 같은 해석을 SDK 가 한다. 날짜·numeric·int8·NaN 이 JSON 을 지나며 바뀌지 않는다). */
export type AppSqlFormat = "objects" | "wire";

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
export interface AppSqlWireResult {
  fields: Array<{ name: string; type: number }>;
  rows: Array<Array<string | null>>;
  row_count: number;
  truncated: boolean;
  changed: number | null;
  ms: number;
}

const qid = (n: string): string => { if (!/^[a-z_][a-z0-9_]*$/.test(n)) throw new HttpError(500, `안전하지 않은 역할 이름: ${n}`); return `"${n}"`; };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 모든 값을 DB 가 보낸 글자 그대로(wire). */
const RAW_TYPES = { getTypeParser: () => (v: string) => v };

/** Postgres 오류 → 사람이 읽을 HttpError. 물리 이름(스키마·앱 접두)은 선언 이름으로 되돌려 보인다. */
function mapPgError(e: unknown, hide: (s: string) => string, l: AppSqlLimits): HttpError {
  if (e instanceof HttpError) return e;
  const err = e as { code?: string; message?: string; detail?: string; constraint?: string };
  const code = String(err?.code ?? "");
  const msg = hide(String(err?.message ?? e));
  const detail = err?.detail ? ` (${hide(String(err.detail))})` : "";
  if (code === "57014") return new HttpError(408, `${l.statementMs / 1000}초 안에 끝나지 않아 멈췄습니다 — 조건을 좁히거나 매니페스트에 인덱스를 선언하세요`, { cause: e });
  if (code === "55P03") return new HttpError(409, `다른 작업이 같은 행을 잡고 있어 ${l.lockMs / 1000}초 넘게 기다리다 멈췄습니다 — 잠시 뒤 다시 하세요`, { cause: e });
  //  교착(서로 기다림) — 묶음끼리 같은 행·같은 표 id 맞춤(#5172)을 반대 순서로 잡으면 생긴다. 다시 하면 되는 일이라 500 이 아니다.
  if (code === "40P01" || code === "40001") return new HttpError(409, "다른 작업과 서로를 기다리게 되어 멈췄습니다 — 잠시 뒤 다시 하세요", { cause: e, body: { pg_code: code } });
  if (code === "42501") return new HttpError(403, `권한이 없습니다 — 이 앱의 테이블만 쓸 수 있습니다(${msg})`, { cause: e });
  if (code === "25006") return new HttpError(400, `읽기 문장에서 쓰기를 할 수 없습니다(${msg})`, { cause: e });
  if (code.startsWith("23")) {
    return new HttpError(409, `제약 조건에 걸렸습니다: ${msg}${detail}`, { cause: e, body: { pg_code: code, ...(err?.constraint ? { constraint: hide(err.constraint) } : {}) } });
  }
  if (code.startsWith("22") || code.startsWith("42") || code === "0A000" || code.startsWith("54")) return new HttpError(400, `SQL 오류: ${msg}${detail}`, { cause: e, body: { pg_code: code } });
  if (/timeout exceeded when trying to connect/i.test(msg)) return new HttpError(503, "앱 DB 연결이 모두 쓰이고 있습니다 — 잠시 뒤 다시 하세요", { cause: e });
  return new HttpError(500, `앱 SQL 실행 실패: ${msg}`, { cause: e });
}

/** 준비 한 덩이(왕복 1번) — 머리말 ①. */
function prepSql(rw: boolean, tenantId: string, role: string, l: AppSqlLimits): string {
  if (!UUID_RE.test(tenantId)) throw new HttpError(500, "행 격리 값이 UUID 모양이 아닙니다");
  return [
    rw ? "BEGIN" : "BEGIN READ ONLY",
    `SELECT set_config('app.tenant_id', '${tenantId.toLowerCase()}', true)`,
    `SET LOCAL statement_timeout = ${Math.floor(l.statementMs)}`,
    `SET LOCAL lock_timeout = ${Math.floor(l.lockMs)}`,
    `SET LOCAL work_mem = '${Math.floor(l.workMemKb)}kB'`,
    "SET LOCAL search_path = pg_catalog, pg_temp",
    "SET LOCAL standard_conforming_strings = on",
    `SET LOCAL ROLE ${qid(role)}`,
  ].join(";\n");
}

/**
 * id 를 직접 넣은 문장 뒤(#5172) — 그 표의 id 시퀀스를 **앞으로만** 맞춘다(왕복 1번 · 두 문장). 직접 넣은 id 는 시퀀스를 올리지
 *  않아, 그대로 두면 다음 평범한 INSERT 가 그 id 를 받아 기본 키가 부딪친다(23505 — 넣은 id 수만큼 차례로).
 *  앱 역할로 돈다 — 그 역할은 자기 표 id 시퀀스의 SELECT·UPDATE 를 받는다(store-schema ensureAppSqlRoleOn — UPDATE 는 DB 에서
 *  nextval·setval 을 허락한다. 앱 SQL 이 그 함수를 부르는 것은 검사기가 막는다). 시퀀스는 서버가 표 이름으로 찾는다.
 *   ① 같은 표를 맞추는 트랜잭션끼리 줄 세운다 — setval 은 트랜잭션과 무관하게 바로 반영돼, 둘이 엇갈리면 작은 값이 나중에 덮어
 *      시퀀스가 뒤로 갈 수 있다. 잠금은 커밋·취소 때 풀린다.
 *   ② 지금 위치(pg_sequence_last_value)보다 max(id) 가 클 때만 옮긴다 — 지운 맨 끝 id 를 다시 내주지 않는다. 정확성은 이 비교가
 *      진다(잠금 다음 문장이라 앞서 커밋된 다른 쪽 행까지 보는 것은 덤).
 *  ⚠ «앞으로만» 은 최선이다 — 원래 id 로 넣는 동안 같은 표에 평범한 INSERT 가 함께 들면, 그 INSERT 가 넣는 번호 범위 안의
 *   번호를 먼저 받거나(23505 → 409) 위치를 읽고 옮기는 찰나에 끼어 시퀀스가 그만큼 되돌 수 있다. 옮기기는 표가 조용할 때 한다.
 *  rel 은 qualifiedAppTable 이 만든 인용 이름이다 — 끼우기 전에 모양을 한 번 더 본다.
 */
const QUOTED_REL = /^"[a-z0-9_]+"\."[a-z0-9_]+"$/;
function idResyncSql(rel: string): string {
  if (!QUOTED_REL.test(rel)) throw new HttpError(500, "id 시퀀스를 맞출 표 이름이 모양에 맞지 않습니다");
  const lit = `'${rel}'`;
  return [
    `SELECT pg_advisory_xact_lock(hashtextextended('lvly-app-id-seq:' || ${lit}, 0))`,
    `SELECT setval(s.seq, s.top, true) FROM (SELECT pg_get_serial_sequence(${lit}, 'id')::regclass AS seq, (SELECT max(id) FROM ${rel}) AS top) s`
      + " WHERE s.top > COALESCE(pg_sequence_last_value(s.seq), 0)",
  ].join(";\n");
}

/** idResyncSql 을 보내고, 맞춤 잠금을 기다리다 멈춘 것은 그 까닭으로 말한다(같은 행을 잡은 것이 아니다). 표를 모르면 멈춘다 —
 *  맞추지 않고 커밋하면 뒤의 평범한 INSERT 가 부딪친다. */
async function resyncIds(client: pg.PoolClient, o: RunAppSqlBatchOpts, plan: AppSqlPlan, l: AppSqlLimits): Promise<void> {
  if (!plan.targets.length) throw new HttpError(500, "원래 id 로 넣은 표를 계획에서 찾지 못해 id 시퀀스를 맞출 수 없습니다 — 취소했습니다");
  try { await client.query(idResyncSql(qualifiedAppTable(o.schema, o.appId, plan.targets[0]))); }
  catch (e) {
    if ((e as { code?: string })?.code === "55P03") {
      throw new HttpError(409, `같은 표에 원래 id 로 넣는 다른 작업이 끝나기를 ${l.lockMs / 1000}초 기다리다 멈췄습니다 — 잠시 뒤 다시 하세요`, { cause: e });
    }
    throw e;
  }
}

export interface AppSqlItem { plan: AppSqlPlan; params: unknown[] }
export interface RunAppSqlOpts {
  plan: AppSqlPlan;
  params: unknown[];
  role: string;
  appId: string;
  schema: string;
  /** 오류 문구에서 물리 이름을 지울 때 쓰는 앱 접두(`crm_dash__`). */
  physicalPrefix: string;
  tenantId?: string;
  format?: AppSqlFormat;
  /** 결과가 상한에 잘리면 오류(413)로 되돌린다 — 쓰기도 취소된다. ORM 드라이버는 잘린 결과를 «전부» 로 믿기 때문이다. */
  strict?: boolean;
}

/**
 * 계획된 문장 하나를 앱 역할로 실행한다. 빈도·용량 게이트는 호출부가 먼저 부른다(takeAppCall · assertAppDataQuota)
 *  — 여기선 워크스페이스 자리와 풀 연결을 얻고, 상한을 걸고, 돌린다.
 */
export async function runAppSql(o: RunAppSqlOpts): Promise<AppSqlResult | AppSqlWireResult> {
  const out = await execute({ ...o, items: [{ plan: o.plan, params: o.params }] }, false);
  return out.results[0];
}

export interface RunAppSqlBatchOpts extends Omit<RunAppSqlOpts, "plan" | "params"> { items: AppSqlItem[] }
/**
 * 묶음 — 여러 문장을 **한 트랜잭션**에서 차례로 돌린다. 하나라도 실패하면 전부 취소하고 몇 번째 문장인지(body.index) 말한다.
 *  대화형이 아니다 — 앞 문장의 결과를 뒤 문장에 넣을 수 없다(값이 필요하면 한 문장 안에서 서브쿼리·RETURNING 으로).
 *  상한: 문장 수 batchMax · 전체 시간 batchMs · 결과 바이트는 문장 전체가 maxBytes 하나를 나눠 쓴다(게이트웨이 메모리).
 */
export async function runAppSqlBatch(o: RunAppSqlBatchOpts): Promise<{ results: Array<AppSqlResult | AppSqlWireResult>; ms: number }> {
  if (!o.items.length) throw new HttpError(400, "묶음에 문장이 없습니다");
  if (o.items.length > limits.batchMax) throw new HttpError(400, `묶음은 한 번에 ${limits.batchMax}문장까지입니다(${o.items.length}문장) — 나눠 보내거나, 여러 행은 INSERT … VALUES (…),(…) 한 문장으로 쓰세요`);
  return execute(o, true);
}

async function execute(o: RunAppSqlBatchOpts, batch: boolean): Promise<{ results: Array<AppSqlResult | AppSqlWireResult>; ms: number }> {
  const l = limits;
  const tenantId = o.tenantId ?? appSqlTenantId();
  const wire = o.format === "wire";
  const hide = (s: string): string => s.split(`"${o.schema}".`).join("").split(`${o.schema}.`).join("").split(o.physicalPrefix).join("");
  const rw = o.items.some((it) => it.plan.writes || it.plan.locks);
  stats.calls++;
  if (batch) stats.batches++;
  const queued = Date.now();
  const release = await slots.acquire(tenantId, l.queueWaitMs);
  const waited = Date.now() - queued;
  stats.waitMs.push(waited);
  if (!release) {
    stats.rejectedQueue++;
    throw new HttpError(429, `이 워크스페이스에서 동시에 도는 앱 SQL 이 ${l.perWorkspace}개이거나 앱 DB 자리가 모두 차서 ${l.queueWaitMs / 1000}초를 기다리다 멈췄습니다 — 잠시 뒤 다시 하세요`,
      { body: { retry_after_ms: 1000 } });
  }
  const started = Date.now();
  let client: pg.PoolClient | null = null;
  let broken: unknown = undefined;
  let at = -1;                                                       // 실패한 문장 번호(묶음 오류 문구용)
  try {
    try { client = await appSqlPool().connect(); }
    catch (e) { stats.rejectedPool++; throw mapPgError(e, hide, l); }
    try {
      await client.query(prepSql(rw, tenantId, o.role, l));
      const results: Array<AppSqlResult | AppSqlWireResult> = [];
      let budget = l.maxBytes;
      let lastTimeout = l.statementMs;
      for (let i = 0; i < o.items.length; i++) {
        at = i;
        const { plan, params } = o.items[i];
        if (batch) {
          // 묶음 전체 시간 — 남은 시간이 문장 상한보다 짧아지면 그만큼만 준다(그 문장 앞에서 한 줄 더 보낸다).
          const next = nextStatementTimeout(l.batchMs - (Date.now() - started), l.statementMs, lastTimeout);
          if (next === "abort") throw new HttpError(408, `묶음이 ${l.batchMs / 1000}초 안에 끝나지 않아 전부 취소했습니다 — 문장을 줄이거나 나눠 보내세요`);
          if (next !== null) { await client.query(`SET LOCAL statement_timeout = ${next}`); lastTimeout = next; }
        }
        const t0 = Date.now();
        const r = await client.query({
          text: wrapForCaps(plan, { maxRows: l.maxRows, maxBytes: Math.max(1, budget) }),
          values: params,
          rowMode: "array",
          queryMode: "extended",
          ...(wire ? { types: RAW_TYPES } : {}),
        } as pg.QueryConfig & { rowMode: "array"; queryMode: "extended" });
        const ms = Date.now() - t0;
        stats.statements++;
        stats.stmtMs.push(ms);
        const shaped = wire ? shapeWire(plan, r, ms) : shapeResult(plan, r, ms);
        budget -= shaped.bytes;
        if (shaped.result.truncated && o.strict) {
          throw new HttpError(413, `결과가 상한(${l.maxRows.toLocaleString()}행 · ${Math.round(l.maxBytes / 1024 / 1024)}MB${batch ? " — 묶음 전체" : ""})을 넘습니다 — `
            + "LIMIT·OFFSET(Drizzle .limit()·.offset())으로 나눠 읽으세요. 쓰기였다면 취소했습니다", { body: { truncated: true } });
        }
        //  #5172 원래 id 로 넣었으면 같은 트랜잭션에서 시퀀스를 맞춘다 — 묶음의 다음 문장부터 맞춰진 시퀀스를 쓴다.
        //   0행이면(다시 돌린 시드의 ON CONFLICT DO NOTHING 등) 맞출 것이 없다 — 잠금도 잡지 않는다.
        if (plan.setsId && shaped.result.changed !== 0) await resyncIds(client, o, plan, l);
        results.push(shaped.result);
      }
      at = -1;
      await client.query(rw ? "COMMIT" : "ROLLBACK");
      const total = Date.now() - started;
      stats.execMs.push(total);
      if (total > 1000) logger.warn({ app: o.appId, tenant: tenantId, ms: total, statements: o.items.length, kinds: o.items.map((it) => it.plan.kind), tables: [...new Set(o.items.flatMap((it) => it.plan.tables))] }, "앱 SQL 이 1초를 넘었습니다");
      return { results, ms: total };
    } catch (e) {
      stats.errors++;
      if (client) await client.query("ROLLBACK").catch((re) => { broken = re; });
      const err = mapPgError(e, hide, l);
      if (batch && at >= 0) {
        throw new HttpError(err.status, `묶음 ${at + 1}번째 문장에서 멈춰 전부 취소했습니다 — ${err.message}`, { cause: e, body: { ...(err.body ?? {}), index: at } });
      }
      throw err;
    }
  } finally {
    if (client) client.release(broken as Error | undefined);
    release();
  }
}

/**
 * 묶음에서 다음 문장의 시간 상한 — 남은 시간(ms)·문장 상한·지금 걸린 값으로 정한다. "abort" = 이미 묶음 시간을 다 썼다,
 *  null = 바꿀 필요 없음, 수 = 그 값으로 줄인다. ⚠ 0 은 Postgres 에서 «상한 없음» 이라 절대 돌려주지 않는다(늘 1 이상).
 */
export function nextStatementTimeout(leftMs: number, statementMs: number, current: number): "abort" | number | null {
  if (!(leftMs > 0)) return "abort";
  const want = Math.max(1, Math.min(statementMs, Math.ceil(leftMs)));
  return want < current ? want : null;
}

type RawResult = { fields: Array<{ name: string; dataTypeID?: number }>; rows: unknown[][]; rowCount: number | null };

/** 감싼 결과의 끝 세 칸 위치를 확인한다. */
function wrapIndex(names: string[]): number {
  const k = names.length - WRAP_COLUMNS.length;
  if (k < 0 || WRAP_COLUMNS.some((c, i) => names[k + i] !== c)) throw new HttpError(500, "앱 SQL 결과 모양이 예상과 다릅니다");
  return k;
}

/** 감싼 결과를 떼어 낸다 — 끝 세 칸은 실행기 몫, __lively_rn 이 NULL 인 행은 «데이터 없음» 표지. 겹치는 칸 이름은 _2… 를 붙인다.
 *  bytes = 돌려준 행의 텍스트 표현 합(묶음이 나눠 쓰는 예산에서 뺀다). */
export function shapeResult(plan: Pick<AppSqlPlan, "returning" | "writes">, r: RawResult, ms: number): { result: AppSqlResult; bytes: number } {
  if (!plan.returning) {
    return { result: { columns: [], rows: [], row_count: 0, truncated: false, changed: r.rowCount ?? 0, ms }, bytes: 0 };
  }
  const names = r.fields.map((f) => f.name);
  const k = wrapIndex(names);
  const seen = new Map<string, number>();
  const columns = names.slice(0, k).map((n) => {
    const c = (seen.get(n) ?? 0) + 1;
    seen.set(n, c);
    return c === 1 ? n : `${n}_${c}`;
  });
  let total = 0, bytes = 0;
  const rows: Array<Record<string, unknown>> = [];
  for (const row of r.rows) {
    total = Number(row[k + 2] ?? 0);
    if (row[k] === null || row[k] === undefined) continue;          // «데이터 없음» 표지
    bytes = Number(row[k + 1] ?? bytes);
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => { o[c] = row[i]; });
    rows.push(o);
  }
  return { result: { columns, rows, row_count: rows.length, truncated: total > rows.length, changed: plan.writes ? total : null, ms }, bytes };
}

/** wire 모양 — 칸 이름·형 OID 를 그대로(겹친 이름도 그대로 — 드라이버는 위치로 읽는다), 값은 글자 그대로. */
export function shapeWire(plan: Pick<AppSqlPlan, "returning" | "writes">, r: RawResult, ms: number): { result: AppSqlWireResult; bytes: number } {
  if (!plan.returning) {
    return { result: { fields: [], rows: [], row_count: 0, truncated: false, changed: r.rowCount ?? 0, ms }, bytes: 0 };
  }
  const k = wrapIndex(r.fields.map((f) => f.name));
  const fields = r.fields.slice(0, k).map((f) => ({ name: f.name, type: Number(f.dataTypeID ?? 0) }));
  let total = 0, bytes = 0;
  const rows: Array<Array<string | null>> = [];
  for (const row of r.rows) {
    total = Number(row[k + 2] ?? 0);
    if (row[k] === null || row[k] === undefined) continue;
    bytes = Number(row[k + 1] ?? bytes);
    rows.push(row.slice(0, k) as Array<string | null>);
  }
  return { result: { fields, rows, row_count: rows.length, truncated: total > rows.length, changed: plan.writes ? total : null, ms }, bytes };
}

/** 시험 전용 — 앱 전용 풀(연결이 SET LOCAL 뒤 원래대로 돌아왔는지 PG 시험이 잰다). */
export function _appSqlPoolForTest(): pg.Pool { return appSqlPool(); }
