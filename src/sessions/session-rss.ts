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
import fsp from "node:fs/promises";

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
 * /proc 를 1회 스캔해 pid → {ppid, rssKb} 테이블을 만든다.
 * 비-Linux 이거나 읽기에 실패하면 **빈 맵**(절대 throw 안 함 — 회수 tick 을 죽이면 안 된다).
 * 스캔 중 사라진 pid(ENOENT)는 건너뛴다 — 프로세스 목록은 본질적으로 경합한다.
 */
export async function readProcTable(): Promise<Map<number, ProcEntry>> {
  const table = new Map<number, ProcEntry>();
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
      if (e) table.set(Number(name), e);
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
