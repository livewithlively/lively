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
// starting(#2578) — 프로세스는 떠 있는데 스키마 마이그레이션·첫 부팅 재기동이 아직이다(503). gateBySchema 만 낸다.
export type Status = "ok" | "degraded" | "down" | "starting";

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

// ── /readyz 의 스키마 게이트(#2578) ──────────────────────────────────────────────────────────────
//  «DB 에 닿는다»(readyReport)와 «스키마·시딩이 끝났다»(boot/boot-state.ts)는 다른 질문이다. 2026-09-03 EC2 실측:
//  healthz 200 직후 부트스트랩이 `column "tenant_id" does not exist` 로 죽고 설치는 '완료'로 끝났다 — readyz 도
//  «DB 도달 + 디스크»라 그걸 못 가렸다. 설치·업데이트 스크립트(deploy/lib/common.sh wait_ready)는 이제 이 게이트를 기다린다.
//   · pending / restarting → 503 + status=starting: 마이그레이션 중이거나 첫 부팅이 곧 재기동한다. 부트스트랩 금지.
//     (DB 자체가 죽어 있으면 그 판정(down)을 덮지 않는다 — 더 근본적인 사유다.)
//   · failed → 503 + status=down: 스키마가 서기 전에 체인이 던졌다(로그 'schema init failed'). 기다려도 안 온다 →
//     설치 스크립트는 타임아웃 대신 즉시 멈추고 로그를 가리킨다.
//   · ready / skipped → 종전 그대로(200/503 은 DB·디스크가 정한다). skipped = 이 프로세스가 체인을 안 돌린다(매니지드
//     중앙 게이트웨이 · DB 없음). **매니지드 무영향의 근거가 여기다** — 거기선 이 게이트가 응답을 바꾸지 않는다.
//  ⚠ 200+degraded 정책은 그대로다: 디스크 경고로 503 을 내지 않는 규칙(ops/disk-guard.ts)에 새 사유를 얹지 않았다.
//   새 503 은 «아직 못 선다(starting)»와 «스키마가 깨졌다(failed)» 뿐이고, 둘 다 트래픽을 받으면 안 되는 상태다.
//  응답에 `schema` 를 항상 싣는다(값 하나짜리 grep 으로 셸에서 판정할 수 있게 — jq 없는 박스).
import type { SchemaBootPhase } from "../boot/boot-state.js";

export interface SchemaGated<T> { httpStatus: number; body: T & { schema: SchemaBootPhase } }

export function gateBySchema<T extends { ok: boolean; status: Status }>(body: T, schema: SchemaBootPhase): SchemaGated<T> {
  const out = { ...body, schema };
  if (schema === "ready" || schema === "skipped") return { httpStatus: body.ok ? 200 : 503, body: out };
  if (schema === "failed") return { httpStatus: 503, body: { ...out, ok: false, status: "down" } };
  return { httpStatus: 503, body: { ...out, ok: false, status: body.ok ? "starting" : body.status } };
}
