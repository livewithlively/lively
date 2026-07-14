// 디스크 가드(#813 T5) — **차기 전에 막는다.**
//
// 왜: 2026-07-13 에 디스크가 100% 에 닿자 Postgres 가 crash recovery 에 갇혀 **로그인을 포함한 전 기능이 500** 이
//  됐고, 공간을 16GB 비워도 살아나지 않았다 — VM/컨테이너를 재시작해야 했다(수동 개입). 즉 디스크풀은 '느린
//  성능저하'가 아니라 **전면 다운 + 수동 복구**로 착지한다. 그러니 100% 에 닿기 **전에** 막아야 한다.
//  (지식: gateway-disk-leak-audit-2026-07-13)
//
// 무엇을 막나 — **디스크를 크게 쓰는 신규 작업만**: 세션 생성 · 레포 클론 · 파일 업로드.
//  ⚠ 읽기·기존 세션·DB 쓰기는 **막지 않는다.** 목적은 서비스를 죽이는 게 아니라 **더 못 붓게 하는 것**이다.
//   (그래서 /readyz 도 디스크 때문에 503 을 내지 않는다 — 멀쩡한 게이트웨이를 LB 에서 빼는 건 자해다.)
//
// 임계치는 관리탭 저장소 정책이 단일 출처(src/org/storage-policy.ts) — 고객 박스는 .env 를 못 고친다.
import { checkDisks, type Thresholds, type Level, FALLBACK_THRESHOLDS } from "./health.js";
import { HttpError } from "./capabilities/rest-util.js";
import { logger } from "./log.js";

export interface DiskState {
  usedPct: number;
  level: Level;
  path: string;
  availBytes: number;
}

// 쓰기 경로마다 statfs 를 때리면 낭비 → 짧게 캐시. 디스크는 초 단위로 급변하지 않는다.
let cache: { at: number; state: DiskState | null } | null = null;
const TTL_MS = Number(process.env.DISK_GUARD_TTL_MS ?? 15_000);

/** 감시 대상 볼륨 중 **가장 나쁜 것**. 하나라도 위험하면 위험이다. 못 재면 null(가드는 통과 — 못 잰다고 서비스를 막지 않는다). */
export async function diskState(paths: string[], thresholds: Thresholds, now: () => number = Date.now): Promise<DiskState | null> {
  if (cache && now() - cache.at < TTL_MS) return cache.state;
  let worst: DiskState | null = null;
  try {
    for (const d of await checkDisks(paths, thresholds)) {
      if (!worst || d.usedPct > worst.usedPct) {
        worst = { usedPct: d.usedPct, level: d.level, path: d.path, availBytes: d.availBytes };
      }
    }
  } catch (err) {
    logger.warn({ err }, "디스크 상태 확인 실패 — 가드는 통과시킨다(못 잰다고 서비스를 막지 않는다)");
    worst = null;
  }
  cache = { at: now(), state: worst };
  return worst;
}

export function invalidateDiskState(): void {
  cache = null;
}

/** 507 Insufficient Storage — 정체불명 500 대신 **무엇을 해야 하는지** 말해준다. */
export function diskFullError(what: string, st: DiskState): HttpError {
  return new HttpError(
    507,
    `디스크 공간이 부족해 ${what}을(를) 시작할 수 없습니다 (${st.usedPct}% 사용, ${fmtMb(st.availBytes)} 남음). ` +
    `관리 ▸ 저장소·로그 에서 프로젝트 워크스페이스를 회수하거나 디스크를 늘리세요.`,
  );
}

function fmtMb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`;
}

/**
 * 디스크를 크게 쓰는 작업 **직전**에 부른다. 위험 임계(기본 95%)를 넘었으면 507 로 거부한다.
 * 경고 임계(85%)에선 막지 않고 로그만 — 아직은 쓸 수 있다.
 * 상태를 못 재면 **통과**시킨다(가드가 못 재는 이유로 서비스를 막는 건 과잉).
 */
export async function assertDiskWritable(what: string, paths: string[], thresholds: Thresholds = FALLBACK_THRESHOLDS): Promise<void> {
  const st = await diskState(paths, thresholds);
  if (!st) return;
  if (st.level === "critical") {
    logger.error({ what, usedPct: st.usedPct, path: st.path }, "디스크 위험 — 신규 작업 차단");
    throw diskFullError(what, st);
  }
  if (st.level === "warn") {
    logger.warn({ what, usedPct: st.usedPct, path: st.path }, "디스크 경고 — 아직 허용하지만 정리가 필요하다");
  }
}

// ── ENOSPC 인식 ───────────────────────────────────────────────────────
// 가드를 통과했어도 작업 도중 디스크가 찰 수 있다(경계에서). 그때 나가는 건 지금 정체불명 500 이라
//  사용자도 운영자도 원인을 모른다. ENOSPC 는 원인이 명확하니 그대로 말해준다.
//  ⚠ Node 의 errno 뿐 아니라 **자식 프로세스(git clone 등)의 stderr 문구**도 잡아야 한다 — 그쪽이 훨씬 흔하다.
const ENOSPC_TEXT = /ENOSPC|no space left on device|디스크.*부족|quota exceeded/i;

export function isDiskFullError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  const msg = err instanceof Error ? `${err.message}` : String(err);
  return ENOSPC_TEXT.test(msg);
}

/** 자식 프로세스 실패 문자열(git stderr 등)에서 디스크 부족을 판정. */
export function isDiskFullText(text: string | undefined | null): boolean {
  return !!text && ENOSPC_TEXT.test(text);
}

// ── 주기 점검 + 임계 전이 경보 ──────────────────────────────────────────
// 알림 채널(슬랙·메일)이 아직 없다 → **전이 시점에만** 큰 소리로 로그하고(중복 스팸 금지), 관리탭·/readyz 가 상태를
//  보여준다. 채널이 생기면 여기 notify() 한 줄만 붙이면 된다.
let lastLevel: Level | null = null;
let timer: NodeJS.Timeout | null = null;
const CHECK_MS = Number(process.env.DISK_CHECK_INTERVAL_MS ?? 5 * 60_000);

export function startDiskWatch(
  paths: () => string[],
  loadThresholds: () => Promise<Thresholds>,
): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    try {
      invalidateDiskState(); // 감시는 항상 새로 잰다(캐시된 옛값으로 경보하면 의미 없다)
      const st = await diskState(paths(), await loadThresholds());
      if (!st) return;
      if (st.level !== lastLevel) {
        // 전이할 때만 소리를 낸다 — 5분마다 같은 경고를 찍으면 로그가 차고(그 자체가 L3 릭) 아무도 안 본다.
        const line = { usedPct: st.usedPct, availBytes: st.availBytes, path: st.path, from: lastLevel, to: st.level };
        if (st.level === "critical") logger.error(line, "디스크 위험 — 신규 세션·클론·업로드를 차단합니다. 즉시 정리 필요");
        else if (st.level === "warn") logger.warn(line, "디스크 경고 — 정리가 필요합니다(관리 ▸ 저장소·로그)");
        else logger.info(line, "디스크 정상 복귀");
        lastLevel = st.level;
      }
    } catch (err) {
      logger.warn({ err }, "디스크 감시 tick 실패");
    }
  };
  timer = setInterval(() => { void tick(); }, CHECK_MS);
  timer.unref?.();
  void tick(); // 부팅 직후 1회 — 이미 위험한 상태로 뜬 박스를 다음 주기까지 방치하지 않는다
}

export function stopDiskWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
  lastLevel = null;
}
