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
import { memAvailableMb, memTotalMb } from "./host-mem.js"; // #1059 — 메모리 경보(디스크와 대칭)
import { ptyUsage } from "../terminal/host-pty.js";                   // #687 후속 — PTY 슬롯 경보
import { readEarlyoomKills, type EarlyoomKill } from "./earlyoom-log.js"; // #1240 — earlyoom kill 관측
import { readProcTable, sessionPidOwners } from "../sessions/session-rss.js";          // #1251 — kill → 세션 되짚기
import { listSessionPanePids, listSessionsRaw } from "../terminal/terminal-sessions.js";
import { markSessionOomKilled } from "../sessions/session-state.js";
import { logger } from "../log.js";

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
let lastMem: Level | null = null;     // #1059 메모리 전이 감지
let memProblemSent = false;
let lastPty: Level | null = null;     // #687 후속 PTY 전이 감지
let ptyProblemSent = false;
// #1240 — 마지막으로 알린 earlyoom kill 의 시각(epoch ms). 부팅 직후엔 null 이고, **첫 tick 이 '지금'으로 잡는다**:
//  게이트웨이가 뜨기 전의 옛 kill 을 새 사건인 양 다시 알리지 않기 위해서다. 그 대신 재시작 중에 일어난 kill 은
//  경보를 놓치는데, **이력은 관리탭이 저널에서 직접 읽어 보여준다**(경보=실시간 · 목록=이력, 역할 분담).
let lastKillAt: number | null = null;
// #1251 — **직전 tick** 의 세션 pid 스냅샷. earlyoom 이 죽인 pid 는 이미 /proc 에 없어 사후 조회가 불가능하므로,
//  매 tick 떠 두고 다음 tick 에 되짚는다. 비면(비-Linux·측정 실패) 매핑을 시도하지 않는다 = 라벨 안 붙음.
let pidSnapshot = new Map<number, { sessionId: string; name: string }>();
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
        + `→ 관리 ▸ 컴퓨팅 리소스 ▸ 저장소 에서 프로젝트 워크스페이스를 회수하세요.`,
      detail,
    };
  }
  if (cur === "warn") {
    return {
      severity: "warn",
      title: `디스크 경고 — ${st.usedPct}% 사용`,
      text: `아직 정상 동작하지만 정리가 필요합니다. 남은 공간 ${fmtBytes(st.availBytes)}.\n`
        + `→ 관리 ▸ 컴퓨팅 리소스 ▸ 저장소 에서 회수 가능한 용량을 확인하세요.`,
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

// ── 메모리 경보(#1059) — 디스크와 대칭. OOM 은 #1059 다운의 원인이라 디스크풀만큼 치명적이지만, 사용%는 박스마다
//  정상범위가 달라 기본 끔(0)이고 운영자가 켠다. used% = (전체-가용)/전체, 가용은 회수 가능 캐시 포함(host-mem). ──
export interface MemThresholds { warnPct: number; criticalPct: number }   // 0 = 그 단계 끔
export interface MemState { usedPct: number; availableMb: number; totalMb: number }

/** 메모리 사용% → 경보 단계. 0 임계 = 그 단계 끔. 디스크와 같은 방향(used% 클수록 나쁨). 순수 함수. */
export function memLevelOf(usedPct: number, t: MemThresholds): Level {
  if (t.criticalPct > 0 && usedPct >= t.criticalPct) return "critical";
  if (t.warnPct > 0 && usedPct >= t.warnPct) return "warn";
  return "ok";
}

/** 메모리 전이 → 알릴 내용(없으면 null). 순수 함수 — 전이 규칙을 테스트가 직접 못 박는다(diskAlertFor 와 동형). */
export function memAlertFor(prev: Level | null, cur: Level, st: MemState): BoxAlert | null {
  if (prev === cur) return null;                    // 상태 그대로 → 침묵
  if (prev === null && cur === "ok") return null;   // 부팅 시 정상 → 침묵
  const detail = { usedPct: st.usedPct, availableMb: st.availableMb, totalMb: st.totalMb, from: prev, to: cur };
  if (cur === "critical") {
    return {
      severity: "critical",
      title: `⚠ 메모리 위험 — 사용 ${st.usedPct}% (가용 ${st.availableMb}MB)`,
      text: `가용 메모리가 위험 수준입니다(${st.availableMb}MB). 세션 누적(baseline)에 임베딩(Ollama) 스파이크가 겹치면 `
        + `OOM 으로 박스가 멈출 수 있습니다 — 2026-07 #1059 다운의 그 상태입니다.\n`
        + `→ 관리 ▸ 컴퓨팅 리소스 ▸ 메모리 에서 idle 세션 회수·세션 메모리 상한을 확인하세요.`,
      detail,
    };
  }
  if (cur === "warn") {
    return {
      severity: "warn",
      title: `메모리 경고 — 사용 ${st.usedPct}% (가용 ${st.availableMb}MB)`,
      text: `메모리 여유가 줄고 있습니다(가용 ${st.availableMb}MB). 아직 정상이나 idle 세션 회수·임베딩 백필 게이트를 점검하세요.\n`
        + `→ 관리 ▸ 컴퓨팅 리소스 ▸ 메모리.`,
      detail,
    };
  }
  return {
    severity: "ok",
    title: `메모리 정상 복귀 — 사용 ${st.usedPct}% (가용 ${st.availableMb}MB)`,
    text: `메모리 여유가 확보됐습니다(가용 ${st.availableMb}MB).`,
    detail,
  };
}

// ── earlyoom kill 경보(#1240) ── 임계가 없다. **이건 상태가 아니라 이미 일어난 사건**이라, 감지되면 늘 알린다
//  (kill 이 없으면 조용하고, 저널을 못 읽으면 자동으로 조용하다 — 그래서 '기본 켬'이 노이즈가 되지 않는다).
//
//  왜 critical 인가: earlyoom 이 돌았다는 건 **메모리가 이미 임계까지 갔고 누군가의 프로세스가 강제 종료됐다**는
//  뜻이다. 죽은 게 claude 면 `exec claude` 구조상 그 사람의 세션이 통째로 사라진 것이다(desired-state 는 남아
//  '복원 가능'으로 뜨지만, 하던 작업은 끊겼다).
//
//  본문에 **회수된 RAM 합(VmRSS)** 을 반드시 싣는다 — #1220 의 핵심 교훈이 여기 있다: badness 가 높다고 큰 게
//  아니어서, 여러 건인데 회수량이 작으면 그건 "죽여도 압박이 안 풀려 연쇄로 죽이는 중"이라는 신호다.
export function earlyoomAlertFor(kills: EarlyoomKill[]): BoxAlert | null {
  if (kills.length === 0) return null;
  const freedMb = kills.reduce((s, k) => s + k.vmRssMb, 0);
  const what = kills.map((k) => `${k.name}(${k.vmRssMb}MB, uid ${k.uid})`).join(" · ");
  // 여러 건인데 건당 회수량이 작으면 연쇄 학살 징후(#1220). 임계는 '건당 100MB 미만'.
  const chain = kills.length > 1 && freedMb / kills.length < 100;
  return {
    severity: "critical",
    title: `⚠ earlyoom 이 프로세스를 강제 종료했습니다 — ${kills.length}건 (회수 ${freedMb}MB)`,
    text: `메모리가 임계에 닿아 OS 보호장치(earlyoom)가 프로세스를 죽였습니다: ${what}\n`
      + `죽은 것이 claude 면 그 멤버의 웹터미널 세션이 사라집니다(작업 내용은 보존돼 '복원 가능'으로 뜹니다).\n`
      + (chain
        ? `⚠ ${kills.length}건인데 회수량이 건당 평균 ${Math.round(freedMb / kills.length)}MB 뿐입니다 — `
          + `**죽여도 압박이 안 풀려 연쇄로 죽는 상태**일 수 있습니다(#1220).\n`
        : "")
      + `→ 관리 ▸ 컴퓨팅 리소스 ▸ 메모리 에서 '메모리 압박 회수'를 켜면, 이 지경에 이르기 전에 `
      + `게이트웨이가 먼저 idle 세션을 **복원 가능한 방식으로** 정리합니다.`,
    detail: { count: kills.length, freedMb, chainSuspected: chain, kills },
  };
}

// ── PTY 경보(#687 후속) — 디스크·메모리와 대칭이되 성격이 하나 다르다: PTY 가 고갈되면 웹터미널뿐 아니라
//  **ssh 인터랙티브 접속까지 막혀** '들어가서 고치는' 경로가 함께 끊긴다. 그래서 디스크(85/95)·메모리(기본 끔)와
//  달리 **기본으로 켜 두고 더 이르게(70/85)** 알린다. 정상 사용률이 낮아(dev 맥미니 평시 12%) 오탐 위험도 작다.
//  경보 본문에 '게이트웨이가 붙들고 있는 attach 수'를 함께 실어 **누수인지 실사용인지**를 받는 사람이 바로 가른다. ──
export interface PtyThresholds { warnPct: number; criticalPct: number }   // 0 = 그 단계 끔
export interface PtyState {
  used: number; max: number; usedPct: number;
  /** 장부 — 이 게이트웨이가 붙들고 있다고 **아는** attach 수(liveTerms). 모르면 null. */
  attachCount: number | null;
  /** fd 축 누수 = 실제 열린 ptmx master fd − 장부. 못 재면 null. */
  fdLeak: number | null;
  /** 프로세스 축 누수 = 살아있는 attach 자식 − 장부. 못 재면 null. */
  procLeak: number | null;
  /**
   * 고아(PPID=1) attach 수 — 위 두 축과 **다른 출처**다. 자식 게이트(ppid===우리 pid)로 세는 procLeak 엔
   * 원리적으로 안 잡히므로(부모가 이미 죽었다), 안 세면 화면·경보가 0 으로 보인다(#687 버그B 축).
   * 못 재면 null.
   */
  orphans: number | null;
}

/** PTY 사용% → 경보 단계. 0 임계 = 그 단계 끔. 순수 함수(memLevelOf 와 동형). */
export function ptyLevelOf(usedPct: number, t: PtyThresholds): Level {
  if (t.criticalPct > 0 && usedPct >= t.criticalPct) return "critical";
  if (t.warnPct > 0 && usedPct >= t.warnPct) return "warn";
  return "ok";
}

/**
 * 누수 한 줄 — **게이트웨이 내부 지표만** 쓴다(장부 대비 실제).
 *
 * ⚠ 초안은 '시스템 PTY − 우리 attach' 차이를 썼는데 **원리적으로 틀렸다.** 그 차이에는 tmux pane·ssh·
 *  멤버가 직접 연 pty 같은 정상분이 섞이고 그 baseline 이 박스마다 다르다 —
 *  dev 맥미니 53 vs 고객사 A 실박스 106(내역: tmux pane ~50 · root ssh 17 · 멤버 pty ~39).
 *  맥미니 기준으로 잡은 상수 임계 100 은 고객사 A에서 **평시에 상시 오탐**이었다(사용률 0.7% "여유"인데
 *  동시에 "누수 의심"이 뜨는 자기모순). 박스 규모에 좌우되는 지표로는 임계를 정할 수 없다.
 *
 * 지금 두 값은 **장부(liveTerms)와의 차이**라 박스 규모와 무관하고, 0 이 정상·0 이 아니면 곧 누수다
 *  (튜닝할 임계가 없다). `cleanup` 이 kill 성공 여부와 무관하게 장부에서 먼저 지우기 때문에,
 *  회수에 실패한 놈은 정확히 이 차이로만 드러난다.
 */
function ptyLeakHint(st: PtyState): string {
  const found: string[] = [];
  if (st.fdLeak !== null && st.fdLeak > 0) found.push(`회수 안 된 PTY fd ${st.fdLeak}개`);
  if (st.procLeak !== null && st.procLeak > 0) found.push(`죽지 않은 attach 프로세스 ${st.procLeak}개`);
  if (st.orphans !== null && st.orphans > 0) found.push(`이전 인스턴스가 남긴 고아 attach ${st.orphans}개`);
  if (found.length) {
    return `\n**PTY 누수 감지** — ${found.join(" · ")}(장부 ${st.attachCount ?? "?"}개 대비).`
      + ` 게이트웨이 재시작이 즉시 전부 회수합니다(머신 재부팅 불필요, tmux 세션도 안 죽습니다).`;
  }
  if (st.fdLeak === null && st.procLeak === null && st.orphans === null) return ""; // 전부 못 쟀다 — 추측하지 않는다
  return `\n누수는 없습니다(이 게이트웨이 attach ${st.attachCount ?? "?"}개, 장부와 실제가 일치).`
    + ` 사용량은 실사용이니 세션 정리를 검토하세요.`;
}

/** PTY 전이 → 알릴 내용(없으면 null). 순수 함수 — 전이 규칙을 테스트가 직접 못 박는다(diskAlertFor 와 동형). */
export function ptyAlertFor(prev: Level | null, cur: Level, st: PtyState): BoxAlert | null {
  if (prev === cur) return null;                    // 상태 그대로 → 침묵(스팸 금지)
  if (prev === null && cur === "ok") return null;   // 부팅 시 정상 → 침묵
  const detail = { used: st.used, max: st.max, usedPct: st.usedPct, attachCount: st.attachCount, fdLeak: st.fdLeak, procLeak: st.procLeak, from: prev, to: cur };
  if (cur === "critical") {
    return {
      severity: "critical",
      title: `⚠ PTY 슬롯 위험 — ${st.usedPct}% (${st.used}/${st.max})`,
      text: `PTY 가 곧 고갈됩니다. 고갈되면 웹터미널이 안 열리는 것으로 끝나지 않고 **ssh 접속조차 막혀**`
        + ` 박스에 들어가 고칠 수 없게 됩니다.${ptyLeakHint(st)}\n`
        + `→ 즉시 조치: 게이트웨이 재시작(붙들고 있는 PTY 를 전부 회수 — 머신 재부팅은 불필요하고 tmux 세션도 안 죽습니다).`,
      detail,
    };
  }
  if (cur === "warn") {
    return {
      severity: "warn",
      title: `PTY 슬롯 경고 — ${st.usedPct}% (${st.used}/${st.max})`,
      // ⚠ 원인 단정은 갭 힌트에게만 맡긴다 — 실사용이 대부분인데 고정 문구로 "누수" 라고 하면 엉뚱한 조치를 유도한다.
      text: `아직 정상이지만 PTY 여유가 줄고 있습니다.${ptyLeakHint(st)}\n`
        + `→ 관리 ▸ 컴퓨팅 리소스 ▸ PTY 슬롯 에서 사용량과 attach 수를 확인하세요.`,
      detail,
    };
  }
  return {
    severity: "ok",
    title: `PTY 슬롯 정상 복귀 — ${st.usedPct}% (${st.used}/${st.max})`,
    text: `PTY 여유가 확보됐습니다.`,
    detail,
  };
}

export interface BoxWatchDeps {
  pool: QueryablePool;
  paths: () => string[];
  loadThresholds: () => Promise<Thresholds>;
  /** #1059 — 메모리 경보 임계(사용%). 0/0 = 끔(감시 skip). 없으면 메모리 감시 안 함(구 배선 호환). */
  loadMemThresholds?: () => Promise<MemThresholds>;
  /** #687 후속 — PTY 경보 임계(사용%). 0/0 = 끔. 없으면 PTY 감시 안 함(구 배선 호환). */
  loadPtyThresholds?: () => Promise<PtyThresholds>;
  /**
   * #1240 — 최근 earlyoom kill 조회(주입 seam). 생략하면 실제 저널(`journalctl -u earlyoom`)을 읽는다.
   * 임계 설정이 없는 이유: 이건 상태가 아니라 **이미 일어난 사건**이라 켜고 끌 것이 없다(사건이 없으면 조용하다).
   */
  readKills?: (sinceMs?: number) => Promise<EarlyoomKill[]>;
  /** #1251 — 세션 pid 소유 스냅샷 + 지금 살아있는 세션 id. 주입 seam(테스트는 /proc·tmux 없이 판정만 검증). */
  snapshotSessions?: () => Promise<{ owners: Map<number, { sessionId: string; name: string }>; liveIds: Set<string>; liveKnown: boolean }>;
  /** #1251 — 'earlyoom 이 죽였다' 기록(사유만; exited_at 은 안 건드린다). */
  markOomKilled?: (sessionId: string) => Promise<boolean>;
  /** 장부 — 이 게이트웨이가 붙들고 있다고 아는 attach 수(liveTerms). 누수 판정의 기준선. */
  attachCount?: () => number;
  /**
   * 누수 관측 — 장부가 아니라 **실제**를 센다. ptmxFd = 열린 PTY master fd 수, attachChildren = 살아있는
   * attach 자식 프로세스 수. box-watch 가 장부와의 차이를 누수량으로 계산한다(각각 fd 축·프로세스 축).
   * 시스템 전체 사용량과 대조하지 않는 이유는 ptyLeakHint 주석 참조(박스별 baseline 때문에 임계 불가).
   */
  leakProbe?: () => Promise<{ ptmxFd: number | null; attachChildren: number | null; orphanAttach: number | null }>;
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

  // ── 메모리(#1059) ── OOM 예방 push 경보. 임계 미설정(0/0)이거나 deps 미배선이면 감시 skip.
  try {
    const mt = deps.loadMemThresholds ? await deps.loadMemThresholds() : null;
    if (mt && (mt.warnPct > 0 || mt.criticalPct > 0)) {
      const availableMb = await memAvailableMb();
      const totalMb = memTotalMb();
      const usedPct = totalMb > 0 ? Math.round(((totalMb - availableMb) / totalMb) * 100) : 0;
      const level = memLevelOf(usedPct, mt);
      const a = memAlertFor(lastMem, level, { usedPct, availableMb, totalMb });
      lastMem = level;
      if (a) {
        const sent = await emit(a, memProblemSent, deps.send);
        memProblemSent = a.severity === "ok" ? false : (sent || memProblemSent);
      }
    } else {
      // 껐거나 미배선 → 전이 상태 리셋(다시 켰을 때 옛 상태로 오탐하지 않게).
      lastMem = null; memProblemSent = false;
    }
  } catch (err) {
    logger.warn({ err }, "박스 감시 — 메모리 확인 실패");
  }

  // ── earlyoom kill(#1240) ── 임계가 없다: 사건이 감지되면 알린다. 저널을 못 읽으면 빈 배열이라 자동으로 조용하다.
  //  ⚠ 첫 tick 은 커서만 세우고 **알리지 않는다** — 게이트웨이가 뜨기 전의 옛 kill 을 새 사건인 양 재방송하지
  //   않기 위해서다(재시작마다 지난 kill 이 다시 울리면 경보를 아무도 안 믿게 된다).
  try {
    const readKills = deps.readKills ?? (async (since?: number) => (await readEarlyoomKills({ sinceMs: since })).kills);
    const snapshotSessions = deps.snapshotSessions ?? (async () => {
      const [table, panes, live] = await Promise.all([readProcTable(), listSessionPanePids(), listSessionsRaw()]);
      // liveKnown = **이번 tick 에 tmux 를 실제로 읽었나.** listSessionsRaw 는 실패를 빈 배열로 삼키므로
      //  그것만 보면 '조회 실패'와 '세션 0개'가 같아진다 — 같은 tmux 서버를 보는 list-panes 의 성공 여부로 가른다.
      return { owners: sessionPidOwners(table, panes.panes), liveIds: new Set(live.map((x) => x.id)), liveKnown: panes.ok };
    });
    const markOom = deps.markOomKilled ?? markSessionOomKilled;
    const snap = await snapshotSessions();
    if (lastKillAt === null) {
      lastKillAt = Date.now();
    } else {
      // ⚠ 시계가 뒤로 조정되면(부팅 직후 NTP 동기화) 커서가 현재보다 앞서 남아 그동안 통지가 밀린다.
      //  **일부러 보정하지 않는다.** 커서를 현재로 당겨 보정하면, 저널에 남은 '미래' 타임스탬프 사건들이
      //  매 tick 마다 다시 `at > cursor` 를 통과해 **무한 중복 통지**가 된다(한 번이 아니다 — 커서는 계속
      //  당겨지고 사건은 계속 미래다). 일시적 침묵보다 경보 도배가 훨씬 나쁘다: 도배는 사람이 채널을
      //  음소거하게 만들어 **다음 진짜 사고까지 못 보게** 한다(이 모듈 상단의 '늑대소년' 원칙).
      //  침묵의 피해는 제한적이다 — 관리탭 이력은 이 커서를 거치지 않고 저널을 직접 읽는다.
      //  (이 트레이드오프는 실제로 테스트가 잡아냈다: 보정을 넣자 T3 중복 억제가 즉시 red 가 됐다.)
      const cursor = lastKillAt;
      // 저널 조회는 초 단위 경계라 커서와 같은 초의 이벤트가 다시 올 수 있다 → `> cursor` 로 한 번 더 거른다.
      const fresh = (await readKills(cursor)).filter((k) => k.at > cursor);
      if (fresh.length > 0) {
        lastKillAt = Math.max(cursor, ...fresh.map((k) => k.at));
        // ── #1251: 죽은 pid 를 세션으로 되짚어 '메모리 부족으로 종료됨' 라벨을 붙인다 ──
        //  ⚠ **셋을 다 만족할 때만** 붙인다. 하나라도 어긋나면 조용히 넘어간다 —
        //   엉뚱한 세션에 이 라벨이 박히면 사용자는 있지도 않은 원인을 쫓는다(#1220·#1240 에서 거듭 확인한 원칙:
        //   *그럴싸하게 틀리는 쪽이 모르는 것보다 나쁘다*). 못 붙여도 손실은 '종전과 같음'뿐이다.
        //   ① 그 pid 가 **직전 스냅샷**에서 우리 세션 것이었다(스냅샷이 비면 아예 시도 안 함)
        //   ② comm 이 일치한다 — pid 재사용을 거르는 축(양쪽 다 이름이 있을 때만 따진다)
        //   ③ 그 세션이 **지금 실제로 사라졌다** — 살아 있으면 그 kill 은 그 세션 것이 아니다(재사용의 결정적 반증)
        //  ⚠ **남는 위험(알고 받아들인다)**: 세션 A 가 다른 이유로 죽고(예: idle 회수) 그 pid 를 세션 B 의 claude 가
        //   재사용한 뒤 B 가 OOM 으로 죽으면, comm 이 둘 다 'claude' 라 ②로 못 가르고 A 는 이미 사라져 ③도 통과해
        //   **A 에 라벨이 잘못 붙는다**. 스냅샷 간격(기본 5분) 안에서만 가능한 좁은 창이지만 0 은 아니다.
        //   claude 가 이 박스에서 압도적으로 흔한 이름이라 comm 대조의 변별력이 낮은 게 근인 — 더 좁히려면
        //   pid 만이 아니라 프로세스 시작시각(/proc stat starttime)까지 스냅샷에 담아야 하는데, earlyoom 로그엔
        //   그 값이 없어 대조할 짝이 없다. 그래서 여기서 멈춘다.
        // ⚠⚠ **liveness 를 못 재면 매핑을 통째로 건너뛴다.** 조건 ③은 '목록에 없음'을 죽음의 **결정적 증거**로
        //  쓰는데, tmux 조회가 실패하면 목록이 통째로 비어 **살아있는 세션이 전부 죽은 것으로 보인다**.
        //  그리고 그 실패는 하필 **메모리 압박**(스래싱·느린 fork/exec 로 tmux 호출 타임아웃)에서 잘 나는데,
        //  그게 바로 earlyoom 이 도는 순간이다 — 즉 가장 위험할 때 가장 크게 틀린다.
        //  조건 ①이 '모르면 안 붙인다'인 것과 방향을 맞춘다(모르면 아무것도 하지 않는다).
        for (const k of snap.liveKnown ? fresh : []) {
          const owner = pidSnapshot.get(k.pid);
          if (!owner) continue;                                                   // ①
          if (owner.name && k.name && owner.name !== k.name) continue;            // ②
          if (snap.liveIds.has(owner.sessionId)) continue;                        // ③
          try {
            if (await markOom(owner.sessionId)) {
              logger.warn({ session: owner.sessionId, pid: k.pid, name: k.name, vmRssMb: k.vmRssMb },
                "earlyoom 이 죽인 세션으로 표시(#1251) — 카드에 '메모리 부족으로 종료됨'");
            }
          } catch (e) {
            logger.warn({ err: e, session: owner.sessionId }, "OOM 사망 표시 실패(비치명 — 라벨만 못 붙는다)");
          }
        }
        const a = earlyoomAlertFor(fresh);
        if (a) await emit(a, false, deps.send);   // 전이가 아니라 사건 — problemSent 억제 로직을 쓰지 않는다
      }
    }
    pidSnapshot = snap.owners;   // 다음 tick 이 되짚을 기준(매핑을 끝낸 **뒤에** 갱신해야 한다)
  } catch (err) {
    logger.warn({ err }, "박스 감시 — earlyoom kill 확인 실패");
  }

  // ── PTY 슬롯(#687 후속) ── 고갈되면 ssh 까지 막혀 '들어가서 고치는' 경로가 사라진다 → 더 이르게 알린다.
  try {
    const pt = deps.loadPtyThresholds ? await deps.loadPtyThresholds() : null;
    if (pt && (pt.warnPct > 0 || pt.criticalPct > 0)) {
      const u = await ptyUsage();
      if (u) { // 못 재는 플랫폼·커널이면 조용히 넘어간다(못 잰다고 경보하지 않는다 — 디스크와 같은 규약)
        const attachCount = deps.attachCount ? deps.attachCount() : null;
        // 실제 관측(fd·프로세스) − 장부 = 누수량. 못 재면 null 로 두고 힌트에서 추측하지 않는다.
        //  음수는 스폰 직후 레이스(장부에 먼저 들어가고 fd 는 아직)일 뿐이므로 0 으로 눕힌다.
        const probe = deps.leakProbe ? await deps.leakProbe().catch(() => null) : null;
        const diff = (actual: number | null | undefined): number | null =>
          actual === null || actual === undefined || attachCount === null ? null : Math.max(0, actual - attachCount);
        // 고아는 장부와의 '차이'가 아니라 **절대 개수** 그대로다 — 부모가 죽어 애초에 장부에 없다.
        const st: PtyState = {
          ...u, attachCount,
          fdLeak: diff(probe?.ptmxFd), procLeak: diff(probe?.attachChildren),
          orphans: probe?.orphanAttach ?? null,
        };
        const level = ptyLevelOf(u.usedPct, pt);
        const a = ptyAlertFor(lastPty, level, st);
        lastPty = level;
        if (a) {
          const sent = await emit(a, ptyProblemSent, deps.send);
          ptyProblemSent = a.severity === "ok" ? false : (sent || ptyProblemSent);
        }
      }
    } else {
      lastPty = null; ptyProblemSent = false;
    }
  } catch (err) {
    logger.warn({ err }, "박스 감시 — PTY 확인 실패");
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
  lastMem = null;
  memProblemSent = false;
  lastPty = null;
  ptyProblemSent = false;
  lastKillAt = null;   // #1240 — 다음 tick 이 커서를 다시 '지금'으로 세운다
  pidSnapshot = new Map();   // #1251
}

/** 테스트 전용 — 한 tick 을 즉시 돌린다(주기를 기다리지 않고 전이 규칙을 검증). */
export async function tickOnce(deps: BoxWatchDeps): Promise<void> {
  await tick(deps);
}
