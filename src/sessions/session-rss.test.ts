// 세션 점유(RSS) 측정 테스트 (#1220) — 압박 회수가 **무엇을 먼저 걷을지**를 정하는 축이라, 여기가 틀리면
//  "회수해도 압박이 안 풀리는" #1220 의 원래 실패가 그대로 재현된다. 순수 함수만 검증한다(/proc 불요).
//  사양·엣지 표: 스크래치패드 spec.md 표 B(R1~R8).
import assert from "node:assert/strict";
import { parseProcStatus, sessionRssMb, sessionPidOwners, readProcTable, type ProcEntry } from "./session-rss.js";

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

// 배선 단언 — 비-Linux(이 개발 머신 등)에서는 빈 표를 돌려주되 **throw 하지 않는다**.
//  (측정이 예외를 던지면 회수 tick 전체가 죽는다.)
{
  const t = await readProcTable();
  assert.ok(t instanceof Map, "readProcTable 은 항상 Map 을 돌려준다(플랫폼 무관, throw 금지)");
  if (process.platform !== "linux") assert.equal(t.size, 0, "비-Linux 면 빈 표");
  else assert.ok(t.size > 0, "Linux 면 자기 자신이라도 잡혀야 한다(빈 표면 측정 경로가 죽은 것)");
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
