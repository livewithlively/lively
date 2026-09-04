// 세션 점유(RSS) 측정 테스트 (#1220) — 압박 회수가 **무엇을 먼저 걷을지**를 정하는 축이라, 여기가 틀리면
//  "회수해도 압박이 안 풀리는" #1220 의 원래 실패가 그대로 재현된다. 순수 함수만 검증한다(/proc 불요).
//  사양·엣지 표: 스크래치패드 spec.md 표 B(R1~R8).
import assert from "node:assert/strict";
import {
  parseProcStatus, parseProcStat, parsePsTable, sessionRssMb, sessionPidOwners, sessionsWithLiveJobs, readProcTable, type ProcEntry,
} from "./session-rss.js";

// R1 — 부모·점유가 다 있는 정상 프로세스
{
  const e = parseProcStatus("Name:\tclaude\nUmask:\t0022\nState:\tS (sleeping)\nPPid:\t4242\nVmRSS:\t  204800 kB\nThreads:\t9\n");
  assert.deepEqual(e, { ppid: 4242, rssKb: 204800, name: "claude" }, "PPid·VmRSS·comm 을 그대로 읽는다");
}

// R2 — 점유 정보가 없음(커널 스레드·좀비): 오류가 아니라 '물리 점유 0'
{
  assert.deepEqual(parseProcStatus("Name:\tkthreadd\nPPid:\t2\nThreads:\t1\n"), { ppid: 2, rssKb: 0, name: "kthreadd" },
    "VmRSS 가 없는 프로세스는 0 으로 취급(읽기 실패가 아니다)");
}

// R3 — 부모 정보가 없음(형식 불일치): 읽기 실패
{
  assert.equal(parseProcStatus("Name:\tx\nVmRSS:\t100 kB\n"), null, "PPid 가 없으면 트리를 못 세우므로 실패로 본다");
}

// R4 — pane → 자식 → 손자: 서브트리 전체 합
//  실제 격리 경로가 이 모양이다(pane=sudo → box-spawn → claude). pane 만 재면 sudo(수 MB)를 세션 크기로 착각한다.
{
  const t = new Map<number, ProcEntry>([
    [10, { ppid: 1, rssKb: 1024, name: "p" }],        // pane: sudo (1MB)
    [11, { ppid: 10, rssKb: 2048, name: "p" }],       // box-spawn (2MB)
    [12, { ppid: 11, rssKb: 307_200, name: "p" }],    // claude (300MB)  ← 세션 크기의 실체
  ]);
  const out = sessionRssMb(t, new Map([["box-a", [10]]]));
  assert.equal(out.get("box-a"), Math.round((1024 + 2048 + 307_200) / 1024), "자손 전부를 합쳐야 세션 크기다");
  assert.ok((out.get("box-a") ?? 0) > 300, "껍데기(pane)만 재면 안 된다 — 300MB 급으로 나와야 한다");
}

// R5 — 한 세션의 여러 pane 이 조상을 공유: 같은 프로세스를 두 번 세지 않음
{
  const t = new Map<number, ProcEntry>([
    [20, { ppid: 1, rssKb: 100 * 1024, name: "p" }],
    [21, { ppid: 20, rssKb: 50 * 1024, name: "p" }],
  ]);
  // pane 목록에 부모(20)와 그 자식(21)이 함께 들어온 경우 — 21 은 20 의 서브트리에도 포함된다.
  const out = sessionRssMb(t, new Map([["box-b", [20, 21]]]));
  assert.equal(out.get("box-b"), 150, "중복 계산 금지(150MB 이지 200MB 가 아니다)");
}

// R6 — 부모 관계에 사이클: 멈춰야 한다(무한 루프 = 회수 tick 정지 = 방어 정지)
{
  const t = new Map<number, ProcEntry>([
    [30, { ppid: 31, rssKb: 1024, name: "p" }],
    [31, { ppid: 30, rssKb: 1024, name: "p" }],   // 서로가 서로의 부모(비정상 표)
  ]);
  const out = sessionRssMb(t, new Map([["box-c", [30]]]));
  assert.equal(out.get("box-c"), 2, "사이클이어도 종료하고 각 프로세스를 한 번씩만 센다");
}

// R7 — pane 이 이미 죽어 표에 없음: 0 기여(오류 아님)
{
  const out = sessionRssMb(new Map<number, ProcEntry>(), new Map([["box-d", [999]]]));
  assert.equal(out.get("box-d"), 0, "죽은 pane 은 0 — 측정 실패가 예외가 되면 회수가 통째로 멈춘다");
}

// R8 — 단위 변환(kB → MB) 반올림
{
  const t = new Map<number, ProcEntry>([[40, { ppid: 1, rssKb: 1536, name: "p" }]]);   // 1.5MB
  assert.equal(sessionRssMb(t, new Map([["box-e", [40]]])).get("box-e"), 2, "kB→MB 반올림");
}

// 배선 단언(S8) — 지원 플랫폼(Linux·macOS)에서는 **실제로 재고**, 나머지는 빈 표를 돌려주되 throw 하지 않는다.
//  ⚠ macOS 가 «무조건 빈 표»였던 것이 #2652 의 절반이다: 못 재면 압박 회수의 정지 조건이 성립할 수 없어
//   후보를 전부 걷는다(실측 2026-09-03~04 맥미니 13회 발동·30세션, 전부 rssMeasured=false). 여기서 못박는다.
{
  const t = await readProcTable();
  assert.ok(t instanceof Map, "readProcTable 은 항상 Map 을 돌려준다(플랫폼 무관, throw 금지)");
  if (process.platform === "linux" || process.platform === "darwin") {
    const self = t.get(process.pid);
    assert.ok(self, "자기 pid 는 표에 있어야 한다(빈 표면 측정 경로가 죽은 것)");
    assert.ok((self?.rssKb ?? 0) > 0, "자기 RSS 는 양수 — 0 이면 '못 잰 것'과 구별되지 않는다");
    assert.ok((self?.pgid ?? 0) > 0, "pgid 가 없으면 작업 판정(⑥)이 통째로 죽는다");
  } else {
    assert.equal(t.size, 0, "미지원 플랫폼이면 빈 표");
  }
}

// ── A. /proc/<pid>/stat 파싱 — comm 에 공백·괄호가 들어가므로 **마지막 ')' 뒤**부터 센다 ──────────────
// A1 — 정상: state·ppid 다음이 pgrp(5), 그 뒤 session·tty_nr·tpgid(8)
{
  assert.deepEqual(parseProcStat("4242 (claude) S 4240 4242 4242 34816 4300 4194304 ..."), { pgid: 4242, tpgid: 4300 });
}
// A2 — comm 에 공백과 괄호: 앞에서 세면 값이 밀린다
{
  assert.deepEqual(parseProcStat("77 (npm exec (x)) S 10 55 55 0 -1 ..."), { pgid: 55, tpgid: -1 },
    "마지막 ')' 기준이어야 pgrp 가 안 밀린다");
}
// A3 — 형식 불일치: 추측하지 않는다
{
  assert.equal(parseProcStat("쓰레기"), null);
}
// A4 — tpgid 자리가 없다: pgid 는 살리고 tpgid 는 -1
{
  assert.deepEqual(parseProcStat("9 (x) S 1 42"), { pgid: 42, tpgid: -1 }, "그룹은 알고 tty 만 모를 수 있다");
}

// ── B. ps 표 파싱(macOS 경로) — 실측 출력 모양(2026-09-04 맥미니) ─────────────────────────────
{
  const t = parsePsTable([
    "  62416   26098   62416   62418      896 sh",                                  // B1 pane(래퍼 셸)
    "  62418   62416   62418   62418   346544 claude",                              // B1 하네스
    "  62689   62418   62418   62418    34432 npm exec @playwright/mcp@latest",      // B2 comm 에 공백
    "  95326   62418   95326       0     1184 /bin/zsh",                             // B4 tpgid=0(제어 tty 없음)
    "  95999   62418   95999       0      100",                                      // B5 comm 없음
    "  쓰레기   줄",                                                                  // B3 버린다
  ].join("\n"));
  assert.equal(t.size, 5, "B3 — 수치가 안 나오는 줄만 버린다");
  assert.deepEqual(t.get(62418), { ppid: 62416, rssKb: 346544, name: "claude", pgid: 62418, tpgid: 62418 }, "B1");
  assert.equal(t.get(62689)?.name, "npm exec @playwright/mcp@latest", "B2 — comm 은 공백을 품은 채 통째로");
  assert.equal(t.get(95326)?.tpgid, 0, "B4 — 제어 tty 없음은 0 그대로(그룹 판정에서 무시된다)");
  assert.equal(t.get(95999)?.name, "", "B5 — 이름이 없어도 죽지 않는다");
  assert.equal(t.get(95999)?.pgid, 95999);
}

// ── C. ⑥ 작업 판정 — 실측 모양: pane(sh) → claude → {MCP·caffeinate}(하네스 그룹) · 작업 셸(자기 그룹) ──
const jobTable = (over: Array<[number, ProcEntry]> = []): Map<number, ProcEntry> => new Map<number, ProcEntry>([
  [10, { ppid: 1, rssKb: 900, name: "sh", pgid: 10, tpgid: 11 }],           // pane — tty 포그라운드 = 하네스(11)
  [11, { ppid: 10, rssKb: 300_000, name: "claude", pgid: 11, tpgid: 11 }],  // 하네스
  [12, { ppid: 11, rssKb: 30_000, name: "node", pgid: 11, tpgid: 11 }],     // MCP stdio 서버 — 하네스 그룹
  [13, { ppid: 11, rssKb: 1_600, name: "caffeinate", pgid: 11, tpgid: 11 }],
  ...over,
]);

// C1 — 유휴 AI 세션: 상주 자식(MCP·caffeinate)은 작업이 아니다
{
  assert.equal(sessionsWithLiveJobs(jobTable(), new Map([["box-a", [10]]])).has("box-a"), false,
    "상주 자식을 작업으로 세면 AI 세션은 영원히 회수되지 않는다");
}
// C2 — 백그라운드 작업: 자기 그룹의 셸 + 그 자식
{
  const out = sessionsWithLiveJobs(jobTable([
    [20, { ppid: 11, rssKb: 1_200, name: "zsh", pgid: 20, tpgid: -1 }],
    [21, { ppid: 20, rssKb: 500, name: "sleep", pgid: 20, tpgid: -1 }],
  ]), new Map([["box-a", [10]]]));
  assert.equal(out.has("box-a"), true, "하네스가 띄운 셸 작업 = spine 밖 그룹");
}
// C3 — pane 프로세스가 하네스 자신(래퍼 셸 없음): 유무를 정확히 가른다
{
  const idle = new Map<number, ProcEntry>([
    [11, { ppid: 1, rssKb: 300_000, name: "claude", pgid: 11, tpgid: 11 }],
    [12, { ppid: 11, rssKb: 30_000, name: "node", pgid: 11, tpgid: 11 }],
  ]);
  assert.equal(sessionsWithLiveJobs(idle, new Map([["box-b", [11]]])).has("box-b"), false);
  const busy = new Map(idle).set(20, { ppid: 11, rssKb: 1_200, name: "zsh", pgid: 20, tpgid: -1 });
  assert.equal(sessionsWithLiveJobs(busy, new Map([["box-b", [11]]])).has("box-b"), true);
}
// C4 — 그룹 정보가 없는 표(구 플랫폼·hidepid): **판정하지 않는다**(빈 집합 = 종전 동작)
{
  const t = new Map<number, ProcEntry>([
    [10, { ppid: 1, rssKb: 900, name: "sh" }],
    [11, { ppid: 10, rssKb: 300_000, name: "claude" }],
    [20, { ppid: 11, rssKb: 1_200, name: "zsh" }],
  ]);
  assert.equal(sessionsWithLiveJobs(t, new Map([["box-c", [10]]])).size, 0,
    "판정 불가에 '보호'를 주면 그 플랫폼에선 회수가 통째로 멈춘다 — 모르면 종전대로 둔다");
}
// C5 — pane 이 이미 죽어 표에 없다
{
  assert.equal(sessionsWithLiveJobs(jobTable(), new Map([["box-d", [999]]])).size, 0);
}
// C6 — 한 세션에 pane 이 둘, 한쪽에서만 작업이 돈다
{
  const t = jobTable([
    [30, { ppid: 1, rssKb: 900, name: "sh", pgid: 30, tpgid: 31 }],
    [31, { ppid: 30, rssKb: 200_000, name: "claude", pgid: 31, tpgid: 31 }],
    [32, { ppid: 31, rssKb: 800, name: "zsh", pgid: 32, tpgid: -1 }],
  ]);
  assert.equal(sessionsWithLiveJobs(t, new Map([["box-e", [10, 30]]])).has("box-e"), true);
}
// C7 — 부모 포인터가 사이클을 이루는 비정상 표: 무한루프 없이 끝난다(방어가 멈추면 안 된다)
{
  const t = new Map<number, ProcEntry>([
    [40, { ppid: 41, rssKb: 10, name: "a", pgid: 40, tpgid: 40 }],
    [41, { ppid: 40, rssKb: 10, name: "b", pgid: 40, tpgid: 40 }],
  ]);
  assert.equal(sessionsWithLiveJobs(t, new Map([["box-f", [40]]])).size, 0, "사이클에서도 종료한다");
}

// ── #1251 sessionPidOwners — kill 된 pid 를 세션으로 되짚기 위한 스냅샷 ────────────────────
// O1 — 서브트리의 **모든** pid 가 그 세션으로 매핑된다(earlyoom 이 죽이는 건 대개 말단 claude 다).
{
  const t = new Map<number, ProcEntry>([
    [10, { ppid: 1, rssKb: 1024, name: "sudo" }],
    [11, { ppid: 10, rssKb: 2048, name: "box-spawn" }],
    [12, { ppid: 11, rssKb: 307_200, name: "claude" }],
  ]);
  const o = sessionPidOwners(t, new Map([["box-a", [10]]]));
  assert.equal(o.get(12)?.sessionId, "box-a", "말단 claude 도 그 세션 것으로 잡혀야 한다");
  assert.equal(o.get(12)?.name, "claude", "comm 을 함께 담는다 — pid 재사용 대조에 쓴다");
  assert.equal(o.get(10)?.sessionId, "box-a");
}

// O2 — 두 세션이 같은 pid 를 주장하면 **지운다**. 모호한 채로 남기면 엉뚱한 세션에 라벨이 박힌다.
{
  const t = new Map<number, ProcEntry>([[30, { ppid: 1, rssKb: 100, name: "x" }]]);
  const o = sessionPidOwners(t, new Map([["box-a", [30]], ["box-b", [30]]]));
  assert.equal(o.has(30), false, "소유가 모호한 pid 는 아예 빼야 한다(그럴싸하게 틀리는 것보다 모르는 게 낫다)");
}

// O3 — 표에 없는 pid(이미 죽음)는 매핑되지 않는다.
{
  assert.equal(sessionPidOwners(new Map(), new Map([["box-a", [999]]])).size, 0);
}

console.log("session-rss: all passed");
