// earlyoom 이 **무엇을 죽였는지** 게이트웨이가 안다 (#1240).
//
// 왜 필요한가: earlyoom 의 SIGTERM 은 `exec claude` 구조상 tmux 세션까지 없앤다 — 사용자 눈엔 세션이 그냥
//  사라진다. 그런데 게이트웨이는 그 사실을 **전혀 몰랐다.** 2026-07-28 마이크가 "배포 모니터링 세션이 주기적으로
//  회수된다"고 신고했을 때 F(idle 회수)는 꺼져 있었는데도 원인을 못 짚어, **운영자에게 journalctl 로그를 받아서야**
//  범인이 earlyoom 임을 알았다. #1220 으로 kill 선택은 고쳤지만 이 관측 공백은 그대로였다.
//
// 왜 저널을 읽나(설계 선택 — #1240): earlyoom 의 `-N` 훅(kill 직후 root 로 스크립트 실행)은 새 실행 표면과
//  토큰 경로를 만든다. 반면 저널은 **이미 있는 기록**이고, 결정적으로 **게이트웨이가 다운돼 있던 동안의 kill 도
//  나중에 읽을 수 있다** — earlyoom 이 도는 상황은 대개 메모리 압박이라 게이트웨이 자신도 위태롭다.
//  push 방식이었다면 하필 그 순간을 잃는다. 대가는 서비스 유저가 `systemd-journal` 그룹이어야 한다는 것
//  (설치가 usermod 로 넣는다 — **읽기 전용** 권한이고, 없으면 이 모듈은 조용히 빈 결과를 준다).
//  ⚠ pilot-box 실측: 그룹 없이는 `No journal files were opened due to insufficient permissions`,
//   그룹에 넣으면 즉시 읽힌다.
//
// 이 모듈은 **절대 throw 하지 않는다.** 관측이 감시 tick 을 죽이면 본말이 전도된다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface EarlyoomKillEvent {
  /** earlyoom 이 보낸 시그널. SIGTERM 이 먼저 가고, 안 죽으면 SIGKILL 로 에스컬레이션된다. */
  signal: string;
  pid: number;
  uid: number;
  /** 프로세스 comm(커널이 15자로 자른다). `(sd-pam)` 처럼 괄호가 들어갈 수 있다. */
  name: string;
  /** earlyoom 이 본 점수 = /proc/<pid>/oom_score (+prefer/avoid 보정). 크기와 비례하지 않는다 — #1220 참조. */
  badness: number;
  /** 죽인 시점의 실제 물리 점유(MiB). **이 값이 곧 회수된 RAM 이다** — badness 와 따로 봐야 한다(#1220). */
  vmRssMb: number;
}

export interface EarlyoomKill extends EarlyoomKillEvent {
  /** 이벤트 시각(epoch ms). */
  at: number;
}

// earlyoom v1.7 kill.c:377 의 포맷 그대로:
//   warn("sending %s to process %d uid %d \"%s\": badness %d, VmRSS %lld MiB\n", ...)
// ⚠ 이름 부분을 `[\s\S]*` 로 느슨하게 두고 **뒤쪽 `": badness ` 로 앵커**한다 — comm 에 따옴표가 들어가도
//  마지막 경계에서 정확히 끊긴다(앞에서 greedy 하게 끊으면 이름에 `"` 가 있을 때 어긋난다).
const KILL_RE = /sending (\S+) to process (\d+) uid (\d+) "([\s\S]*)": badness (-?\d+), VmRSS (\d+) MiB/;

/**
 * 저널 메시지 한 줄 → kill 이벤트. kill 로그가 아니면 null.
 * 순수 함수 — 픽스처로 단위테스트한다(journalctl 없이).
 */
export function parseEarlyoomKill(msg: string): EarlyoomKillEvent | null {
  const m = KILL_RE.exec(msg);
  if (!m) return null;
  const [, signal, pid, uid, name, badness, vmRss] = m;
  return {
    signal,
    pid: Number(pid),
    uid: Number(uid),
    name,
    badness: Number(badness),
    vmRssMb: Number(vmRss),
  };
}

/** journalctl JSON 한 줄에서 MESSAGE 를 문자열로. 비-UTF8 이면 바이트 배열로 오므로 그것도 받는다. */
function messageOf(rec: unknown): string {
  // ⚠ 한 줄이 `null`·숫자 같은 비-객체로 파싱되면 프로퍼티 접근이 throw 하고, 그게 위로 새면 그 회차 전체가
  //  readable:false 가 된다 — 잡음 한 줄 때문에 '못 봤다'가 되는 건 이 기능이 막으려는 바로 그 모호함이다.
  if (!rec || typeof rec !== "object") return "";
  const m = (rec as Record<string, unknown>).MESSAGE;
  if (typeof m === "string") return m;
  if (Array.isArray(m)) {
    try { return Buffer.from(m as number[]).toString("utf8"); } catch { return ""; }
  }
  return "";
}

/** journalctl JSON 출력 본문 → kill 목록. 순수 함수(실행과 파싱을 분리해 테스트 가능). */
export function parseJournalJson(stdout: string, fallbackAt: number): EarlyoomKill[] {
  const out: EarlyoomKill[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }   // 잡음 줄은 건너뛴다
    const ev = parseEarlyoomKill(messageOf(rec));
    if (!ev) continue;
    // __REALTIME_TIMESTAMP 는 **마이크로초** 문자열이다(ms 아님 — 1000 으로 나눠야 한다).
    const usec = Number((rec as Record<string, unknown>).__REALTIME_TIMESTAMP);
    out.push({ ...ev, at: Number.isFinite(usec) && usec > 0 ? Math.round(usec / 1000) : fallbackAt });
  }
  return out;
}

export interface ReadKillsOptions {
  /** 이 시각(epoch ms) **이후**만. 생략하면 limit 개수만큼 최근 것. */
  sinceMs?: number;
  /** 최대 건수(기본 50). 연쇄 학살 때 저널이 길어질 수 있어 상한을 둔다. */
  limit?: number;
  /** 실행 seam — 테스트가 journalctl 없이 결정 로직만 검증한다. */
  run?: (args: string[]) => Promise<string>;
  now?: () => number;
}

export interface EarlyoomReadResult {
  /**
   * 저널을 **실제로 읽었나**. false = 권한 없음(systemd-journal 그룹 미가입)·journalctl 부재·비-Linux.
   *
   * ⚠ 이 플래그가 없으면 화면이 "최근 kill 없음"과 "못 봐서 모름"을 **똑같이** 표시하게 된다 — #1220 에서
   *  값비싸게 배운 "한 소스만 보고 단정"의 UI 판이다. 관측 실패를 '이상 없음'으로 읽히게 두면, 정작 사고가
   *  났을 때 사람이 화면을 믿고 다른 데를 판다.
   */
  readable: boolean;
  kills: EarlyoomKill[];
}

/**
 * 최근 earlyoom kill 이벤트. **절대 throw 하지 않는다** — Linux 가 아니거나, 권한이 없거나, earlyoom 유닛이
 * 없으면 `{readable:false, kills:[]}`. 그 셋은 '사건이 없다'가 아니라 **'알 수 없다'** 이므로 호출부가 구분해야 한다.
 */
export async function readEarlyoomKills(opts: ReadKillsOptions = {}): Promise<EarlyoomReadResult> {
  const now = opts.now ?? Date.now;
  if (!opts.run && process.platform !== "linux") return { readable: false, kills: [] };
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const args = ["-u", "earlyoom", "-o", "json", "--no-pager", "-n", String(limit)];
  // journalctl 은 `@<unix초>` 형태의 절대시각을 받는다(로케일·타임존 파싱을 피한다).
  if (opts.sinceMs !== undefined) args.push(`--since=@${Math.floor(opts.sinceMs / 1000)}`);
  const run = opts.run ?? (async (a: string[]) => (await execFileAsync("journalctl", a, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout);
  try {
    return { readable: true, kills: parseJournalJson(await run(args), now()) };
  } catch {
    return { readable: false, kills: [] };   // 권한 없음·유닛 없음·journalctl 부재
  }
}
