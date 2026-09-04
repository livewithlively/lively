// 세션이 **지금 실제로 쥐고 있는 물리 메모리(RSS)** — #1220 압박 회수의 선택 축.
//
// 왜 이 축이어야 하나(#1220 의 핵심 교훈): 회수·kill 대상을 "메모리를 많이 쓰는 것처럼 보이는 것"으로 고르면
//  **죽여도 압박이 안 풀린다.** 커널이 노출하는 oom_score 는 분자에 **swap 을 포함**하므로(mm/oom_kill.c
//  oom_badness = RSS + swap + pgtables), 오래 idle 이라 swap 으로 밀려난 세션일수록 점수가 높은데 **그걸 죽여도
//  RAM 은 RSS 만큼만 돌아온다**. 고객사 A 실측(2026-07-28): earlyoom 이 badness 978 짜리를 SIGTERM 했는데 실제
//  VmRSS 는 177MB 뿐이라 5초 뒤에도 여전히 임계 아래(5.37%)였고, 그래서 여러 멤버 세션을 연쇄로 죽였다.
//  → 회수 순서는 oom_score 도 idle 나이도 아닌 **RSS 내림차순**이다. 그게 회수로 실제 돌아오는 양이다.
//
// 왜 `/proc/<pid>/status` 인가: rss 를 **페이지 수**로 주는 stat/statm 과 달리 `VmRSS` 를 **kB 단위**로 준다 →
//  페이지 크기를 가정할 필요가 없다(16K 페이지 박스에서 4배 틀리는 사고를 원천 차단). `PPid` 도 같은 파일에 있어
//  **한 번 읽기로 트리와 크기를 동시에** 얻는다. comm 에 공백·괄호가 들어가도 파싱이 안 깨진다(stat 의 고질).
//
// 왜 서브트리 합산인가: 세션의 pane pid 는 하네스가 아니다. 격리(#524) 경로는 `sudo → box-spawn → claude` 이고
//  D 캡(#1059)까지 켜면 `sudo → box-cgspawn → systemd-run → setpriv → box-spawn → claude` 다. pane pid 만 재면
//  **sudo(수 MB)를 세션 크기로 착각**해, 정작 큰 세션을 작다고 보고 회수 순서가 뒤집힌다.
//
// 못 재면(비-Linux·hidepid 마운트·경합으로 사라진 pid) 조용히 0/빈 맵을 돌려준다 — 호출부가 idle 순으로 폴백하며,
//  측정 실패로 회수 자체를 막지 않는다(방어책이 방어를 멈추면 안 된다).
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcEntry {
  /** 부모 pid(/proc/<pid>/status PPid). */
  ppid: number;
  /** 상주 물리 메모리(kB, VmRSS). 커널 스레드 등 mm 이 없는 프로세스는 0. */
  rssKb: number;
  /**
   * #1251 — comm(커널이 15자로 자른 실행파일명). earlyoom kill 로그가 주는 이름과 **대조**해
   * pid 재사용 오표기를 거른다(pid 만으로 세션을 특정하면 그럴싸하게 틀릴 수 있다).
   */
  name: string;
  /**
   * 프로세스 그룹(/proc/<pid>/stat pgrp · `ps -o pgid`). **하네스가 띄운 작업을 가르는 유일한 신호**다
   * (sessionsWithLiveJobs 참조). 못 읽는 플랫폼에선 undefined — 그때는 판정을 하지 않는다.
   */
  pgid?: number;
  /**
   * 그 프로세스의 제어 tty **포그라운드 그룹**(/proc/<pid>/stat tpgid · `ps -o tpgid`). pane 프로세스에서만 쓴다:
   * 그 값이 곧 «지금 이 pane 에서 도는 하네스의 그룹»이다(tmux 의 `pane_current_command` 가 같은 출처를 본다).
   * tty 가 없으면 -1/0.
   */
  tpgid?: number;
}

/** `/proc/<pid>/status` 본문 → 엔트리. PPid 가 없으면(형식 불일치) null. 순수 함수 — 픽스처로 단위테스트. */
export function parseProcStatus(text: string): ProcEntry | null {
  const p = /^PPid:\s+(\d+)/m.exec(text);
  if (!p) return null;
  // VmRSS 는 커널 스레드·좀비엔 아예 없다(그때는 0 = 물리 점유 없음).
  const r = /^VmRSS:\s+(\d+)\s*kB/m.exec(text);
  const n = /^Name:\s*(.*)$/m.exec(text);
  return { ppid: Number(p[1]), rssKb: r ? Number(r[1]) : 0, name: (n?.[1] ?? "").trim() };
}

/**
 * `/proc/<pid>/stat` 본문 → 프로세스 그룹·tty 포그라운드 그룹. 형식이 안 맞으면 null.
 *
 * ⚠ comm(2번째 필드)에는 **공백·괄호가 들어간다**(`(npm exec (x))`). 그래서 앞에서 세면 안 되고,
 *  **마지막 `)` 뒤**부터 세야 한다 — 그 뒤로 state(3) · ppid(4) · pgrp(5) · session(6) · tty_nr(7) · tpgid(8).
 */
export function parseProcStat(text: string): { pgid: number; tpgid: number } | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const rest = text.slice(close + 1).trim().split(/\s+/);   // [state, ppid, pgrp, session, tty_nr, tpgid, …]
  const pgid = Number(rest[2]), tpgid = Number(rest[5]);
  if (!Number.isInteger(pgid)) return null;
  return { pgid, tpgid: Number.isInteger(tpgid) ? tpgid : -1 };
}

/**
 * `ps -eo pid=,ppid=,pgid=,tpgid=,rss=,comm=` 출력 → 표. **macOS 경로**(리눅스는 /proc 가 정본).
 *  순수 함수 — 픽스처로 단위테스트한다. rss 는 ps 가 kB 로 준다(리눅스 VmRSS 와 같은 단위).
 *  comm 은 공백을 품을 수 있어 **마지막 필드로 통째로** 받는다(앞 5개만 잘라 쓴다).
 */
export function parsePsTable(stdout: string): Map<number, ProcEntry> {
  const table = new Map<number, ProcEntry>();
  for (const line of stdout.split("\n")) {
    const f = line.trim().split(/\s+/, 5);
    if (f.length < 5) continue;
    const [pid, ppid, pgid, tpgid, rssKb] = f.map(Number);
    if (![pid, ppid, pgid, rssKb].every(Number.isInteger) || !pid || pid <= 0) continue;
    // comm 은 5개 필드 뒤 나머지 전부(공백 포함). split(limit) 은 나머지를 버리므로 직접 잘라 낸다.
    let rest = line.trim();
    for (let i = 0; i < 5; i++) {
      const sp = rest.search(/\s/);
      if (sp < 0) { rest = ""; break; }        // 필드가 모자란 줄 — 이름 없이 둔다(숫자 축은 이미 검증됐다)
      rest = rest.slice(sp).trimStart();
    }
    table.set(pid!, { ppid: ppid!, rssKb: rssKb!, name: rest, pgid: pgid!, tpgid: Number.isInteger(tpgid) ? tpgid! : -1 });
  }
  return table;
}

/**
 * pid → {ppid, rssKb, name, pgid, tpgid} 표를 뜬다. 읽기에 실패하면 **빈 맵**(절대 throw 안 함 — 회수 tick 을
 * 죽이면 안 된다). 스캔 중 사라진 pid(ENOENT)는 건너뛴다 — 프로세스 목록은 본질적으로 경합한다.
 *
 * ⚠ **macOS 를 여기서 처음 지원한다**(종전엔 비-Linux 면 무조건 빈 맵). 그 공백은 조용하지 않았다: 맥미니
 *  셀프호스트 박스에서 압박 회수가 세션 점유를 **한 건도 못 재** `freedMb` 가 늘 0 이었고, 그래서
 *  «목표에 닿으면 멈춘다»(reclaimTargetReached)가 성립할 수 없어 **후보를 전부 걷었다**(실측 2026-09-03~04:
 *  13회 발동·30세션 회수, 전부 rssMeasured=false·reachedTarget=false). 리눅스에만 있는 방어를 «맥은 원래
 *  그런 것»으로 두면, 그 박스에서만 이 기능이 정반대로 동작한다.
 *
 * ⓘ 리눅스는 pid 당 파일을 **둘** 읽는다(status=VmRSS·PPid·Name, stat=pgrp·tpgid). 종전 1회 읽기의 이점을
 *  포기하는 대가로 «작업이 살아 있나»를 얻는다 — 이 표는 회수 후보가 있을 때만 뜨므로(평시 0회) 값이 있다.
 */
export async function readProcTable(): Promise<Map<number, ProcEntry>> {
  const table = new Map<number, ProcEntry>();
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,pgid=,tpgid=,rss=,comm="], { timeout: 5000, maxBuffer: 8 << 20 });
      return parsePsTable(stdout);
    } catch { return table; }   // ps 가 없거나 느리다 — 못 잰 것으로 두고 진행(방어를 멈추지 않는다)
  }
  if (process.platform !== "linux") return table;
  let names: string[];
  try {
    names = await fsp.readdir("/proc");
  } catch {
    return table;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const e = parseProcStatus(await fsp.readFile(`/proc/${name}/status`, "utf8"));
      if (!e) continue;
      // pgrp·tpgid 는 status 에 없다(stat 에만 있다). 못 읽어도 엔트리는 남긴다 — RSS 축은 그대로 살아야 한다.
      try {
        const g = parseProcStat(await fsp.readFile(`/proc/${name}/stat`, "utf8"));
        if (g) { e.pgid = g.pgid; e.tpgid = g.tpgid; }
      } catch { /* 방금 죽었다 — 그룹만 모르는 채로 둔다 */ }
      table.set(Number(name), e);
    } catch { /* 방금 죽었거나 hidepid — 건너뛴다 */ }
  }
  return table;
}

/**
 * 세션별 **서브트리 RSS 합(MB)**. `panePids` = 세션 id → 그 세션 pane 들의 pid.
 * 순수 함수(테이블 주입) — /proc 없이 단위테스트한다.
 *
 * 같은 pid 를 두 번 세지 않는다(세션 하나가 여러 pane 을 갖고 조상이 겹칠 수 있다). 부모 포인터가 사이클을
 * 이루는 비정상 테이블에서도 visited 로 멈춘다(무한 루프 = 회수 tick 정지 = 방어 정지).
 */
export function sessionRssMb(table: Map<number, ProcEntry>, panePids: Map<string, number[]>): Map<string, number> {
  // 부모 → 자식 인덱스는 한 번만 만든다(세션 수 × 프로세스 수 재순회 방지).
  const children = new Map<number, number[]>();
  for (const [pid, e] of table) {
    const arr = children.get(e.ppid);
    if (arr) arr.push(pid); else children.set(e.ppid, [pid]);
  }
  const out = new Map<string, number>();
  for (const [sid, roots] of panePids) {
    let kb = 0;
    const seen = new Set<number>();
    const stack = [...roots];
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const e = table.get(pid);
      if (!e) continue;                      // 이미 죽은 pane — 0 으로 친다
      kb += e.rssKb;
      const kids = children.get(pid);
      if (kids) for (const k of kids) if (!seen.has(k)) stack.push(k);
    }
    out.set(sid, Math.round(kb / 1024));
  }
  return out;
}

/**
 * 세션별 **«하네스가 띄운 작업이 지금 살아 있나»**. 회수 안전 불변식 ⑥ 의 신호다(session-reaper 참조).
 *
 * ── 왜 필요한가 ──
 * 종전 «작업 중» 판정(sessions.ts `working`)은 셋 다 **턴**에 묶여 있었다: pane 제목 스피너 · 훅 보고
 *  (UserPromptSubmit·PostToolUse=busy, **Stop=idle**) · shellWorking(셸 하네스 전용). 그래서 **AI 가 백그라운드로
 *  긴 작업을 걸어 두고 턴을 끝낸 세션**은 어느 신호로도 «작업 중»이 아니었다 — 실측 2026-09-04: 50분짜리 감시를
 *  `run_in_background` 로 걸어 둔 세션이 26분째에 압박 회수로 죽었다(그 작업은 복원해도 안 살아난다).
 *  shellWorking 이 «pane 포그라운드가 셸이 아니면 활동»으로 정확히 이 사고를 막고 있었는데, `!r_harnessIsAgent`
 *  로 **셸 세션에만** 걸려 있어 AI 세션의 같은 사례가 비어 있었다.
 *
 * ── 어떻게 가르나(이름 화이트리스트 없이) ──
 * 하네스가 셸 명령을 돌릴 때 그 자식은 **자기 프로세스 그룹**을 받는다. 반면 하네스가 상주로 띄우는 것들
 *  (MCP stdio 서버·caffeinate 등)은 **하네스의 그룹을 그대로 물려받는다**. 그래서 «세션 서브트리에 spine 밖
 *  그룹이 있나» 하나로 갈린다(실측 2026-09-04 맥미니: claude(pgid 62418) 밑의 MCP 3개·caffeinate 는 전부
 *  62418, 백그라운드 `sleep` 은 95326 = 자기 자신).
 *
 *  spine = { pane 프로세스의 그룹, pane tty 의 **포그라운드 그룹**(tpgid) }. 뒤쪽이 곧 하네스의 그룹이다 —
 *  pane 이 `sh -c claude …` 든(맥미니 실측) `sudo → box-spawn → claude` 든(격리) 하네스 이름을 몰라도 잡힌다.
 *
 * ⚠ **판정 못 하면 «작업 없음»**(빈 집합)이다 = 종전 동작. 이 신호는 회수를 **막기만** 하므로, 판정 불가에
 *  «보호»를 주면 그 플랫폼에선 회수가 통째로 멈춘다(방어가 방어를 멈추는 것보다 나쁘다). 대신 호출부가
 *  이 집합의 크기를 로그에 남겨, 어떤 박스에서 이 신호가 죽어 있는지 사람이 볼 수 있게 한다.
 * ⚠ 포그라운드 턴 중에도 참이다(툴 실행 = 자기 그룹). 그건 문제가 아니다 — 그 세션은 어차피 `working` 이다.
 *
 * ⚠ **한계를 숨기지 않는다: «오래 사는 자식»은 그 세션을 계속 붙잡는다.** 브라우저·개발서버처럼 하네스가
 *  띄워 놓고 안 끄는 프로세스가 있으면 그 세션은 유휴로도 압박으로도 안 걷힌다. 실측 2026-09-04 이 박스:
 *  28세션 중 2건만 참이었고(하나는 지금 툴을 돌리는 세션, 하나는 Chrome 을 띄워 둔 세션) 나머지 26개는
 *  그대로 회수 대상이었다 — 즉 신호는 충분히 좁다. 다만 «걷을 게 없는데 압박이 안 풀린다»가 보이면
 *  `skipReasons.jobs` 가 큰지부터 본다. 그 숫자가 이 한계의 관측창이고, 그때 고칠 곳은 코드가 아니라
 *  그 세션이 띄워 둔 프로세스다(운영자는 `pressure_max_reap`·정책으로 폭발반경만 조절한다).
 */
export function sessionsWithLiveJobs(table: Map<number, ProcEntry>, panePids: Map<string, number[]>): Set<string> {
  const children = new Map<number, number[]>();
  for (const [pid, e] of table) {
    const arr = children.get(e.ppid);
    if (arr) arr.push(pid); else children.set(e.ppid, [pid]);
  }
  const out = new Set<string>();
  for (const [sid, roots] of panePids) {
    const spine = new Set<number>();
    let sawForeground = false;
    for (const r of roots) {
      const e = table.get(r);
      if (!e) continue;
      if (e.pgid && e.pgid > 0) spine.add(e.pgid);
      if (e.tpgid && e.tpgid > 0) { spine.add(e.tpgid); sawForeground = true; }   // pane tty 의 포그라운드 = 하네스 그룹
    }
    // ⚠ **포그라운드 그룹을 못 읽으면 판정 자체를 포기한다**(빈 집합 = 종전 동작). 여기가 이 함수에서 가장
    //  위험한 자리다: tpgid 없이 pane 그룹만으로 spine 을 세우면 **하네스가 제 그룹을 가진 배치에서 하네스
    //  자신이 «작업»으로 잡혀** 그 세션이 영원히 안 걷힌다(회수가 통째로 멈춘다 = 방어 사망). 반대로 포기하면
    //  잃는 건 «보호가 안 걸린다»뿐이고 그건 이 변경 이전의 상태다 — 모르는 플랫폼에서는 새 기능이 조용히
    //  꺼지는 쪽이 옳다. 관측: 그 면에서는 `skipReasons.jobs` 가 늘 0 이다(활성 여부가 로그로 보인다).
    //  ⓘ tmux pane 은 항상 tty 를 가지므로 리눅스·macOS 실측에서는 늘 참이다. 이 갈래는 procfs 가 tpgid 를
    //   안 주는 면(예: gVisor 샌드박스 — 2026-09-04 시점 미실측)을 위한 것이다.
    if (!spine.size || !sawForeground) continue;
    const seen = new Set<number>();
    const stack = [...roots];
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const e = table.get(pid);
      if (!e) continue;
      if (e.pgid && e.pgid > 0 && !spine.has(e.pgid)) { out.add(sid); break; }   // spine 밖 그룹 = 하네스가 띄운 작업
      const kids = children.get(pid);
      if (kids) for (const k of kids) if (!seen.has(k)) stack.push(k);
    }
  }
  return out;
}

/**
 * #1251 — 세션 서브트리의 **모든 pid → 그 세션**(+comm). earlyoom 이 죽인 pid 를 **사후에** 세션으로 되짚기 위한 스냅샷.
 *
 * 왜 스냅샷인가: earlyoom 로그는 pid·uid·comm·시각만 준다. 그런데 그 pid 는 **이미 죽어 `/proc` 에 없다** —
 * 사후 조회가 원리적으로 불가능하다. 그래서 감시 tick 이 매번 이 맵을 떠 두고, 다음 tick 에 읽은 kill 을 **직전
 * 스냅샷**에서 되짚는다.
 *
 * ⚠ pid 는 재사용된다. 이 맵만 믿고 라벨을 붙이면 엉뚱한 세션에 '메모리 부족으로 종료됨'이 박힌다 —
 * 호출부는 **comm 대조 + 그 세션이 실제로 사라졌는지**까지 교차 확인해야 한다(box-watch 참조).
 * 같은 pid 가 여러 세션에 잡히면(있어선 안 되지만) **먼저 만난 것을 남기지 않고 지운다** — 모호하면 안 붙이는 게 낫다.
 */
export function sessionPidOwners(
  table: Map<number, ProcEntry>,
  panePids: Map<string, number[]>,
): Map<number, { sessionId: string; name: string }> {
  const children = new Map<number, number[]>();
  for (const [pid, e] of table) {
    const arr = children.get(e.ppid);
    if (arr) arr.push(pid); else children.set(e.ppid, [pid]);
  }
  const out = new Map<number, { sessionId: string; name: string }>();
  const ambiguous = new Set<number>();
  for (const [sid, roots] of panePids) {
    const seen = new Set<number>();
    const stack = [...roots];
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const e = table.get(pid);
      if (!e) continue;
      const prev = out.get(pid);
      if (prev && prev.sessionId !== sid) ambiguous.add(pid);   // 두 세션이 같은 pid 를 주장 → 못 믿는다
      else out.set(pid, { sessionId: sid, name: e.name });
      const kids = children.get(pid);
      if (kids) for (const k of kids) if (!seen.has(k)) stack.push(k);
    }
  }
  for (const pid of ambiguous) out.delete(pid);
  return out;
}
