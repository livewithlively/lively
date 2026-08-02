// 준비상태(readiness) 점검 — /readyz 가 쓰는 '진짜' 헬스체크 (#813 T2).
//
// 왜: /healthz 는 얕은 liveness 라 `{ok:true}` 만 낸다 — **DB 가 죽어도 200 이다.** 2026-07-13 사고에서
//  디스크가 꽉 차 Postgres 가 recovery mode 에 갇혀 모든 로그인이 500 이었는데 healthz 는 끝까지 초록이었고,
//  결국 사람이 로그인 실패로 발견했다(모니터가 구조적으로 못 잡는 상태). 2026-07-03 SASL 사고도 같은 패턴이었다.
//  → 모니터·알림이 볼 수 있는 '실제로 서비스 가능한가' 창구가 필요하다. (지식: gateway-disk-leak-audit-2026-07-13)
//
// ⚠ /healthz 를 깊게 만들지 않고 /readyz 를 따로 둔 이유: deploy/lib/common.sh 의 wait_healthz() 가 설치·업데이트
//  중 /healthz 를 60회 재시도로 폴링해 기동을 확인한다 — 그 시점엔 DB 가 아직 안 떠 있을 수 있다. healthz 에 DB 를
//  물리면 **정상 설치가 실패한다**(닭-달걀). liveness(프로세스 살아있음) 와 readiness(서비스 가능) 는 분리한다.
//
// 디스크를 같이 보는 이유: 세션 워크스페이스가 무한 증가하는 구조라(같은 지식 L1) 디스크가 차는 게 이 박스의
//  1차 사인(死因)이다. 차오르는 중에 미리 알아야 한다 — 다 차서 DB 가 죽은 뒤엔 수동 개입 없이 복구가 안 된다.
//
// pool·paths 를 주입받는다: items/store.ts 는 커넥터 미러까지 끌고 오는 무거운 체인이라 테스트가 그걸 로드하지
//  않게 하고, 스텁 풀로 down 경로를 검증할 수 있게 한다.
import fsp from "node:fs/promises";
import { logger } from "../log.js";

// DB 가 recovery mode 면 pg 가 즉시 FATAL 을 던지지만, 네트워크·풀 고갈 시엔 매달릴 수 있다 → 헬스체크는 빨리 답해야 한다.
const DB_TIMEOUT_MS = Number(process.env.HEALTH_DB_TIMEOUT_MS ?? 3000);

export type Level = "ok" | "warn" | "critical";
export type Status = "ok" | "degraded" | "down";

/** 디스크 임계치 — **관리탭(DB) 저장소 정책이 단일 출처**(src/org/policies/storage-policy.ts). 호출자가 주입한다. */
export interface Thresholds {
  warnPct: number;
  criticalPct: number;
}

// DB 를 못 읽는 상황(=DB 다운, 헬스체크가 가장 필요한 순간)에도 판정은 해야 한다 → 최후 폴백.
export const FALLBACK_THRESHOLDS: Thresholds = { warnPct: 85, criticalPct: 95 };

/** pg.Pool 중 우리가 쓰는 부분만 — 테스트가 스텁을 넣을 수 있게 좁힌다. */
export interface QueryablePool {
  query(text: string): Promise<unknown>;
}

export interface DiskCheck {
  path: string;
  totalBytes: number;
  availBytes: number;
  usedPct: number;
  level: Level;
}

export interface DbCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface ReadyReport {
  ok: boolean;
  status: Status;
  db: DbCheck;
  disks: DiskCheck[];
  thresholds: Thresholds; // 어떤 기준으로 판정했는지 — 관리탭에서 바꾼 값이 실제로 먹는지 눈으로 확인 가능해야 한다
  uptimeSec: number;
}

export function levelFor(usedPct: number, t: Thresholds = FALLBACK_THRESHOLDS): Level {
  if (usedPct >= t.criticalPct) return "critical";
  if (usedPct >= t.warnPct) return "warn";
  return "ok";
}

// pg 에러 메시지엔 접속 URL(user:pass@host) 이 섞여 나올 수 있다. /readyz 는 미인증 창구라 **절대** 새면 안 된다.
export function scrubError(msg: string): string {
  return msg.replace(/\/\/[^/@\s]*@/g, "//***@");
}

// df 와 같은 관례로 사용률을 낸다: used/(used+avail). statfs.blocks 엔 root 예약분이 포함돼 있어 bavail(비특권
//  가용)을 안 쓰면 사람이 `df` 에서 보는 수치와 어긋난다 — 운영자가 대조할 수 있어야 하므로 df 를 따른다.
export async function checkDisk(p: string, t: Thresholds = FALLBACK_THRESHOLDS): Promise<DiskCheck | null> {
  try {
    const st = await fsp.statfs(p);
    const bsize = Number(st.bsize);
    const blocks = Number(st.blocks);
    const bfree = Number(st.bfree);
    const bavail = Number(st.bavail);
    const used = blocks - bfree;
    const denom = used + bavail;
    const usedPct = denom > 0 ? Math.round((used / denom) * 1000) / 10 : 0;
    return { path: p, totalBytes: blocks * bsize, availBytes: bavail * bsize, usedPct, level: levelFor(usedPct, t) };
  } catch (err) {
    // 경로 부재(미프로비저닝 세션 루트)·statfs 미지원 — 치명 아님. 리포트에서 빠지고 나머지는 계속 본다.
    logger.warn({ err, path: p }, "디스크 점검 실패 — 리포트에서 제외");
    return null;
  }
}

// 앱 상태루트와 세션 루트가 같은 볼륨인 경우가 흔하다 → 디바이스로 중복 제거(같은 디스크를 두 번 세지 않게).
export async function checkDisks(paths: string[], t: Thresholds = FALLBACK_THRESHOLDS): Promise<DiskCheck[]> {
  const seenDev = new Set<number>();
  const out: DiskCheck[] = [];
  for (const p of paths) {
    let dev: number;
    try {
      dev = (await fsp.stat(p)).dev;
    } catch {
      continue; // 아직 안 만들어진 경로 — 조용히 건너뛴다(에러 아님).
    }
    if (seenDev.has(dev)) continue;
    seenDev.add(dev);
    const c = await checkDisk(p, t);
    if (c) out.push(c);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`DB 응답 없음 (${ms}ms 초과)`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export async function pingDb(pool: QueryablePool, timeoutMs = DB_TIMEOUT_MS): Promise<DbCheck> {
  const t0 = Date.now();
  try {
    const q = pool.query("select 1");
    // 타임아웃이 먼저 이기면 q 는 나중에 거부될 수 있다 → 미처리 거부(unhandledRejection) 로 로그가 더러워지지 않게 흡수.
    q.catch(() => { /* noop */ });
    await withTimeout(q, timeoutMs);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: scrubError(err instanceof Error ? err.message : String(err)),
    };
  }
}

// ok(=HTTP 200) 는 **'DB 에 닿는가' 하나로만** 결정한다.
//  디스크 경고는 degraded 로 알리되 트래픽은 끊지 않는다 — 95% 라도 게이트웨이는 정상 동작하는데 503 을 내면
//  멀쩡한 서비스를 LB 에서 빼버린다(자해). 디스크가 진짜 한계에 닿으면 DB 가 먼저 죽고 그건 db.ok=false 로 잡힌다.
//  '신규 세션·클론 차단' 같은 실제 degrade 동작은 디스크 가드(T5)의 몫이지 readiness 의 몫이 아니다.
export function summarize(db: DbCheck, disks: DiskCheck[]): { ok: boolean; status: Status } {
  if (!db.ok) return { ok: false, status: "down" };
  const degraded = disks.some((d) => d.level !== "ok");
  return { ok: true, status: degraded ? "degraded" : "ok" };
}

export async function readyReport(opts: {
  pool: QueryablePool;
  paths: string[];
  thresholds?: Thresholds; // 관리탭 저장소 정책에서 온다(호출자가 주입 — DB 다운 시 폴백은 호출자 책임)
  timeoutMs?: number;
}): Promise<ReadyReport> {
  const thresholds = opts.thresholds ?? FALLBACK_THRESHOLDS;
  const [db, disks] = await Promise.all([
    pingDb(opts.pool, opts.timeoutMs),
    checkDisks(opts.paths, thresholds),
  ]);
  const { ok, status } = summarize(db, disks);
  return { ok, status, db, disks, thresholds, uptimeSec: Math.round(process.uptime()) };
}
