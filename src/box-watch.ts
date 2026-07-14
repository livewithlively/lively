// 박스 상태 감시 + 경보(#813) — 디스크·DB 상태가 **바뀔 때만** 사람에게 알린다.
//
// 왜 이게 필요한가: T5 로 가드는 넣었다(위험하면 신규 세션·클론·업로드 차단). 그런데 **그 사실을 아무도 모른다.**
//  현재 창구는 로그(아무도 안 본다) · 관리탭 배너(들어가야 본다) · /readyz(누가 폴링해야 본다) 뿐이다.
//  2026-07-13 사고의 본질은 "디스크가 찼다"가 아니라 **"아무도 몰랐다"** 였다 — 사람이 로그인 실패로 발견했다.
//  탐지 창구는 만들었으니 이제 **밀어서 알리는(push)** 경로가 필요하다. 이 모듈이 그 경로다.
//  (지식: gateway-disk-leak-audit-2026-07-13 §L4)
//
// 무엇을 보나 — 사람이 알아야 하는 것 둘:
//  ① **DB 도달 불가** = 로그인 포함 전 기능 500. 7/13 사고의 그 상태. 가장 급하다.
//  ② **디스크 임계** = 곧 ①이 된다(그리고 100% 에 닿으면 공간을 비워도 수동 재시작이 필요하다).
//
// ⚠ 스팸 금지 — **상태가 바뀔 때만** 보낸다. 5분마다 같은 경보를 쏘면 아무도 안 보게 되고(늑대소년),
//  그 자체가 로그·채널을 채운다. 복구(정상 복귀)도 알린다 — 경보만 오고 해제가 안 오면 신뢰를 잃는다.
//
// ⚠ 알림 실패가 게이트웨이를 죽이면 안 된다 — 전부 best-effort(throw 금지, 로그만).
import { pingDb, type QueryablePool, type Level, type Thresholds } from "./health.js";
import { diskState, invalidateDiskState, type DiskState } from "./disk-guard.js";
import { logger } from "./log.js";

/** 알림 한 건 — 채널(웹훅 등)에 실어 보낼 내용. 채널 구현은 alerts.ts 가 맡는다(여기선 '무엇을 알릴지'만). */
export interface BoxAlert {
  /** critical=지금 장애 · warn=곧 장애 · ok=복구(해제) */
  severity: "critical" | "warn" | "ok";
  title: string;
  /** 사람이 읽고 **무엇을 해야 할지** 알 수 있는 한 문단. */
  text: string;
  detail: Record<string, unknown>;
}

/** 실제로 보냈는지 돌려준다 — 미설정·임계미만이면 false. 해제 알림을 보낼지 판단하는 데 쓴다. */
export type AlertSender = (a: BoxAlert) => Promise<boolean>;

const CHECK_MS = Number(process.env.BOX_WATCH_INTERVAL_MS ?? 5 * 60_000);

// 마지막으로 **관측한** 상태 — 전이 감지용. null = 아직 한 번도 안 봄(첫 tick 이 '정상'이면 안 알린다).
let lastDisk: Level | null = null;
let lastDbOk: boolean | null = null;
// 마지막으로 **실제로 보낸** 문제 경보가 있는지 — 해제(복구) 알림을 보낼지 결정한다.
//  ⚠ 알린 적 없는 문제의 "정상 복귀"를 보내면 받는 사람이 혼란스럽다("복귀? 언제 문제였는데?").
//   (예: min_severity=critical 인데 디스크가 warn→ok 로 갔을 때. warn 은 안 보냈으니 해제도 보내면 안 된다.)
let diskProblemSent = false;
let dbProblemSent = false;
let timer: NodeJS.Timeout | null = null;

const fmtBytes = (b: number): string =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}GB` : `${Math.round(b / 1024 ** 2)}MB`;

/** 디스크 전이 → 알릴 내용(없으면 null). 순수 함수 — 테스트가 전이 규칙을 직접 못 박는다. */
export function diskAlertFor(prev: Level | null, cur: Level, st: DiskState): BoxAlert | null {
  if (prev === cur) return null;                    // 상태 그대로 → 침묵(스팸 금지)
  if (prev === null && cur === "ok") return null;   // 부팅 시 정상 → 굳이 알리지 않는다
  const detail = { usedPct: st.usedPct, avail: fmtBytes(st.availBytes), path: st.path, from: prev, to: cur };
  if (cur === "critical") {
    return {
      severity: "critical",
      title: `⚠ 디스크 위험 — ${st.usedPct}% 사용`,
      text: `새 세션 · 레포 클론 · 파일 업로드가 **차단되고 있습니다**. 남은 공간 ${fmtBytes(st.availBytes)}.\n`
        + `100%에 닿으면 DB가 죽어 로그인을 포함한 모든 기능이 멈추고, 공간을 비워도 수동 재시작이 필요합니다.\n`
        + `→ 관리 ▸ 저장소·로그 에서 프로젝트 워크스페이스를 회수하세요.`,
      detail,
    };
  }
  if (cur === "warn") {
    return {
      severity: "warn",
      title: `디스크 경고 — ${st.usedPct}% 사용`,
      text: `아직 정상 동작하지만 정리가 필요합니다. 남은 공간 ${fmtBytes(st.availBytes)}.\n`
        + `→ 관리 ▸ 저장소·로그 에서 회수 가능한 용량을 확인하세요.`,
      detail,
    };
  }
  return {
    severity: "ok",
    title: `디스크 정상 복귀 — ${st.usedPct}% 사용`,
    text: `여유 공간이 확보됐습니다(${fmtBytes(st.availBytes)}). 차단이 해제됐습니다.`,
    detail,
  };
}

/** DB 전이 → 알릴 내용(없으면 null). DB 불가 = 7/13 사고의 그 상태(전 기능 500). */
export function dbAlertFor(prev: boolean | null, ok: boolean, err?: string): BoxAlert | null {
  if (prev === ok) return null;
  if (prev === null && ok) return null; // 부팅 시 정상 → 침묵
  if (!ok) {
    return {
      severity: "critical",
      title: "🔴 DB 연결 불가 — 서비스 전면 장애",
      text: `게이트웨이가 DB에 닿지 못합니다. **로그인을 포함한 모든 기능이 실패합니다.**\n`
        + `에러: ${err ?? "(불명)"}\n`
        + `디스크가 꽉 차 Postgres가 복구모드에 갇힌 경우, 공간을 비우는 것만으론 살아나지 않습니다 — 컨테이너/VM 재시작이 필요합니다.`,
      detail: { error: err ?? null },
    };
  }
  return { severity: "ok", title: "✅ DB 연결 복구", text: "게이트웨이가 다시 DB에 닿습니다.", detail: {} };
}

export interface BoxWatchDeps {
  pool: QueryablePool;
  paths: () => string[];
  loadThresholds: () => Promise<Thresholds>;
  /** 알림 전송(채널 미설정이면 no-op). 실패해도 throw 하지 않아야 한다. */
  send: AlertSender;
  dbTimeoutMs?: number;
}

const levelOf = (s: BoxAlert["severity"]): "error" | "warn" | "info" =>
  s === "critical" ? "error" : s === "warn" ? "warn" : "info";

/** 알림 1건 처리 — 로그는 항상 남기고, 전송은 '해제 규칙'을 지킨다. 보냈으면 true. */
async function emit(a: BoxAlert, problemSent: boolean, send: AlertSender): Promise<boolean> {
  logger[levelOf(a.severity)]({ ...a.detail }, a.title); // 채널이 없어도 로그엔 항상 남는다
  // 알린 적 없는 문제의 해제는 보내지 않는다(받는 사람이 혼란스럽다).
  if (a.severity === "ok" && !problemSent) return false;
  try {
    return await send(a);
  } catch (err) {
    logger.warn({ err }, "경보 전송 실패 — 감시는 계속한다");
    return false;
  }
}

async function tick(deps: BoxWatchDeps): Promise<void> {
  // ── DB 먼저 ── 가장 급한 신호다(전 기능 500).
  try {
    const db = await pingDb(deps.pool, deps.dbTimeoutMs);
    const a = dbAlertFor(lastDbOk, db.ok, db.error);
    lastDbOk = db.ok;
    if (a) {
      const sent = await emit(a, dbProblemSent, deps.send);
      dbProblemSent = a.severity === "ok" ? false : (sent || dbProblemSent);
    }
  } catch (err) {
    logger.warn({ err }, "박스 감시 — DB 확인 실패");
  }

  // ── 디스크 ──
  try {
    invalidateDiskState(); // 감시는 항상 새로 잰다(캐시된 옛값으로 경보하면 의미 없다)
    const st = await diskState(deps.paths(), await deps.loadThresholds());
    if (!st) return; // 못 재면 조용히 넘어간다(못 잰다고 경보를 쏘지 않는다)
    const a = diskAlertFor(lastDisk, st.level, st);
    lastDisk = st.level;
    if (a) {
      const sent = await emit(a, diskProblemSent, deps.send);
      diskProblemSent = a.severity === "ok" ? false : (sent || diskProblemSent);
    }
  } catch (err) {
    logger.warn({ err }, "박스 감시 — 디스크 확인 실패");
  }
}

export function startBoxWatch(deps: BoxWatchDeps): void {
  if (timer) return;
  timer = setInterval(() => { void tick(deps); }, CHECK_MS);
  timer.unref?.();
  void tick(deps); // 부팅 직후 1회 — 이미 위험한 상태로 뜬 박스를 다음 주기까지 방치하지 않는다
}

export function stopBoxWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
  lastDisk = null;
  lastDbOk = null;
  diskProblemSent = false;
  dbProblemSent = false;
}

/** 테스트 전용 — 한 tick 을 즉시 돌린다(주기를 기다리지 않고 전이 규칙을 검증). */
export async function tickOnce(deps: BoxWatchDeps): Promise<void> {
  await tick(deps);
}
