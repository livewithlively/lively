// attach 워커 host — **워커가 먼저 죽는 판**의 유령 정리 (#3545). 배선 단위 검증.
//
// ★ 이 파일이 지키는 계약: 「워커가 통째로 사라지면, 그 워커가 쥐고 있던 세션들의 남은 attach
//  클라이언트를 **게이트웨이가** 끊는다」. 그 일을 하던 코드(`terminal-pty` 의 cleanup)는 워커 안이라
//  워커가 SIGKILL·크래시로 죽으면 아예 안 돈다. 원격 tmux(매니지드 중계)에서는 attach 클라이언트가
//  워커의 자식이 아니라 샌드박스 안 프로세스라 부모와 함께 죽지도 않는다(#2625) — 그래서 아무도 안
//  보는 클라이언트가 영구히 남고, 그 세션은 `session_attached>0` 이라 유휴 회수에서도 영영 빠진다(#2148).
//
// ⚠⚠ **이 시험은 실 tmux 를 한 번도 부르지 않는다.** 워커 포크와 유령정리를 둘 다 주입(seam)으로
//  갈아끼운다. 실 mux 를 건드리는 시험은 그 PC 의 세션을 죽일 수 있다 — 2026-09-04 실측 사고
//  (knowledge: tmux-experiment-isolation-tmux-env-beats-tmpdir-3545 · 선례 #209).
// 실행: npm run build && node dist/terminal/attach-worker-host.test.js
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { AttachWorkerHost } from "./attach-worker-host.js";

/** 가짜 워커 — 게이트웨이가 실제로 쓰는 표면(pid·on/once·send·kill)만 흉내낸다. */
class FakeChild extends EventEmitter {
  sendOk = true;
  killed: string[] = [];
  constructor(public pid: number) { super(); }
  send(_msg: unknown, _handle: unknown, cb: (err: Error | null) => void): boolean {
    setImmediate(() => cb(this.sendOk ? null : new Error("channel closed")));
    return this.sendOk;
  }
  kill(sig?: string): boolean { this.killed.push(sig ?? "SIGTERM"); return true; }
}

interface Rig {
  host: AttachWorkerHost;
  children: FakeChild[];
  detached: Array<{ id: string; slug: string | null }>;
  hand(id: string, slug: string | null): Promise<boolean>;
}

function rig(k: number): Rig {
  const children: FakeChild[] = [];
  const detached: Array<{ id: string; slug: string | null }> = [];
  let nextPid = 1000;
  const host = new AttachWorkerHost(k, {
    fork: (() => { const c = new FakeChild(++nextPid); children.push(c); return c as unknown as ChildProcess; }) as never,
    detachGhosts: (id, slug) => { detached.push({ id, slug }); },
  });
  const hand = (id: string, slug: string | null): Promise<boolean> => host.handoff({
    req: { method: "GET", url: `/terminal/ws?session=${id}`, headers: {} } as IncomingMessage,
    socket: {} as Duplex,
    head: Buffer.alloc(0),
    id,
    tenant: slug === null ? null : ({ id: `t-${slug}`, slug } as never),
  });
  return { host, children, detached, hand };
}

/** 미뤄 둔 정리(setTimeout 0)가 돌 때까지 한 틱 넘긴다. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

test("W1 워커가 세션 하나를 쥔 채 죽으면 그 세션의 유령을 끊는다 — 슬러그는 handoff 때 받은 것", async () => {
  const r = rig(4);
  assert.equal(await r.hand("box-a-11111111", "lively-46e3"), true);
  r.children[0]!.emit("exit", null, "SIGKILL");
  await tick();
  assert.deepEqual(r.detached, [{ id: "box-a-11111111", slug: "lively-46e3" }]);
});

test("W2 워커가 세션 여럿을 쥔 채 죽으면 전부 각각 한 번씩 끊는다", async () => {
  const r = rig(4);
  for (const id of ["box-a-1", "box-a-2", "box-a-3"]) assert.equal(await r.hand(id, "t1"), true);
  assert.equal(r.children.length, 1, "K=4 라 한 워커가 셋을 다 받는다");
  r.children[0]!.emit("exit", null, "SIGKILL");
  await tick();
  assert.deepEqual(r.detached.map((d) => d.id).sort(), ["box-a-1", "box-a-2", "box-a-3"]);
});

test("W3 세션이 정상적으로 비워진 뒤(session-empty) 워커가 죽으면 끊을 것이 없다", async () => {
  const r = rig(4);
  assert.equal(await r.hand("box-a-1", "t1"), true);
  r.children[0]!.emit("message", { t: "session-empty", id: "box-a-1" });  // 마지막 소켓이 닫혔다
  r.children[0]!.emit("exit", 0, null);
  await tick();
  assert.deepEqual(r.detached, [], "이미 스스로 끊고 나간 세션을 또 끊으면 안 된다");
});

test("W4 죽자마자 그 세션이 다른 워커로 재배정되면 건너뛴다(handoff 재시도 경로)", async () => {
  const r = rig(4);
  assert.equal(await r.hand("box-a-1", "t1"), true);   // 워커1 이 잡는다
  r.children[0]!.sendOk = false;                       // 이제 채널이 끊긴다
  assert.equal(await r.hand("box-a-2", "t1"), true);   // 같은 워커 → send 실패 → 회수 → 워커2 로 재시도
  assert.equal(r.children.length, 2, "두 번째 워커가 떠서 소켓을 받았다");
  await tick();
  assert.deepEqual(r.detached.map((d) => d.id), ["box-a-1"],
    "죽은 워커가 쥐고 있던 box-a-1 만 끊는다 — 살아 있는 워커로 옮겨간 box-a-2 는 건드리지 않는다");
});

test("W5 단일 테넌트(tenant=null)면 슬러그 없이 끊는다", async () => {
  const r = rig(4);
  assert.equal(await r.hand("box-a-1", null), true);
  r.children[0]!.emit("exit", null, "SIGKILL");
  await tick();
  assert.deepEqual(r.detached, [{ id: "box-a-1", slug: null }]);
});

test("W6 exit 과 error 가 겹쳐 와도 세션당 한 번만 끊는다(멱등)", async () => {
  const r = rig(4);
  assert.equal(await r.hand("box-a-1", "t1"), true);
  r.children[0]!.emit("exit", null, "SIGKILL");
  r.children[0]!.emit("error", new Error("EPIPE"));
  await tick();
  assert.deepEqual(r.detached, [{ id: "box-a-1", slug: "t1" }]);
});

test("W7 K=0(비활성)이면 워커도 유령정리도 없다 — 코드가 있기 전과 동일", async () => {
  const r = rig(0);
  assert.equal(await r.hand("box-a-1", "t1"), false, "fail-open: 게이트웨이 인프로세스로 폴백");
  assert.equal(r.children.length, 0);
  await tick();
  assert.deepEqual(r.detached, []);
});

test("W8 게이트웨이 종료(shutdown)로 워커를 회수할 때도 남은 세션을 끊는다", async () => {
  const r = rig(4);
  assert.equal(await r.hand("box-a-1", "t1"), true);
  const c = r.children[0]!;
  c.on("newListener", () => { /* noop */ });
  setImmediate(() => c.emit("exit", 0, "SIGTERM"));   // SIGTERM 을 받고 정상 종료
  await r.host.shutdown();
  //  ⚠ 여기서 **틱을 넘기지 않는다.** `index.ts` 는 shutdown 이 resolve 하자마자 `process.exit` 을 부르므로
  //   미뤄 둔 타이머는 프로덕션에서 한 번도 안 돈다 — shutdown 이 **직접** 흘려야 한다.
  //   (재배포·롤이 곧 이 경로다 — #2625 §4 가 지목한 최대 누수 창.)
  assert.deepEqual(r.detached, [{ id: "box-a-1", slug: "t1" }],
    "종료 경로는 타이머에 맡기지 않고 그 자리에서 내보내야 한다");
});

test("W9 세션이 비면 «세션→테넌트» 기억도 함께 풀린다 — 게이트웨이 수명 내내 쌓이면 안 된다", async () => {
  const r = rig(4);
  for (const id of ["box-a-1", "box-a-2"]) assert.equal(await r.hand(id, "t1"), true);
  assert.equal(r.host.stats().slugs, 2);
  for (const id of ["box-a-1", "box-a-2"]) r.children[0]!.emit("message", { t: "session-empty", id });
  assert.deepEqual(
    { sessions: r.host.stats().sessions, slugs: r.host.stats().slugs },
    { sessions: 0, slugs: 0 },
    "라우터 매핑과 슬러그 기억이 **같이** 풀려야 한다(푸는 문은 하나)");
});
