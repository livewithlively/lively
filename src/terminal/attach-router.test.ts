// attach 워커 sticky 라우팅 + K 노브 (#2228 1단계 · C안) — 순수 로직 단위 검증.
//  ★ 이 파일이 지키는 불변식: 「한 세션의 모든 attach 는 매핑이 풀리기 전까지 같은 워커로」(sticky).
//   그래야 attachRefs·detachGhostClients 의 «마지막 WS» 판정이 워커별로 온전하다(장부 분열 방지).
// 실행: npm run build && node dist/terminal/attach-router.test.js
import assert from "node:assert/strict";
import test from "node:test";
import { AttachRouter, parseWorkerK } from "./attach-router.js";
import { summarizeAttachProcs } from "./terminal-pty.js";

test("K1/K2/K3 parseWorkerK — 미설정/off/0/음수/오류=0, 정수=K, inf=Infinity", () => {
  assert.equal(parseWorkerK(undefined), 0);
  assert.equal(parseWorkerK(""), 0);
  assert.equal(parseWorkerK("0"), 0);
  assert.equal(parseWorkerK("off"), 0);
  assert.equal(parseWorkerK("-3"), 0);
  assert.equal(parseWorkerK("abc"), 0);
  assert.equal(parseWorkerK("1"), 1);
  assert.equal(parseWorkerK("4"), 4);
  assert.equal(parseWorkerK("inf"), Infinity);
  assert.equal(parseWorkerK("∞"), Infinity);
});

test("S1 sticky — 매핑된 세션은 늘 같은 워커(재사용)", () => {
  const r = new AttachRouter(4);
  r.assign("box-a", 100);
  assert.deepEqual(r.pick("box-a", [100, 200]), { worker: 100, sticky: true });
});

test("S2 (경계) sticky 는 K 초과여도 유지 — 이미 슬롯을 차지한 세션", () => {
  const r = new AttachRouter(2);
  r.assign("box-a", 100); r.assign("box-b", 100); // 워커 100 이 K=2 로 꽉 참
  assert.deepEqual(r.pick("box-a", [100]), { worker: 100, sticky: true }, "그래도 a 는 자기 워커로");
});

test("C1 (경계) K 상한 — 꽉 찬 워커만 있으면 신규 필요(worker:null)", () => {
  const r = new AttachRouter(1);
  r.assign("box-a", 100); // 워커 100 K=1 꽉 참
  assert.deepEqual(r.pick("box-b", [100]), { worker: null, sticky: false }, "신규 세션은 새 워커가 필요");
  assert.deepEqual(r.pick("box-b", [100, 200]), { worker: 200, sticky: false }, "빈 워커 200 이 있으면 거기로");
});

test("C2 고른 분산 — 새 세션은 가장 덜 찬 워커로", () => {
  const r = new AttachRouter(4);
  r.assign("a1", 100); r.assign("a2", 100); // 100: 2
  r.assign("b1", 200);                        // 200: 1
  assert.deepEqual(r.pick("new", [100, 200]), { worker: 200, sticky: false }, "덜 찬 200 선택");
});

test("R1 releaseSession — 마지막 WS 후 슬롯이 풀려 재사용 가능", () => {
  const r = new AttachRouter(1);
  r.assign("box-a", 100);
  assert.equal(r.sessionCount(100), 1);
  r.releaseSession("box-a");
  assert.equal(r.sessionCount(100), 0);
  assert.ok(r.isIdle(100));
  assert.deepEqual(r.pick("box-b", [100]), { worker: 100, sticky: false }, "빈 워커에 새 세션 배정 가능");
});

test("D1 dropWorker — 죽은 워커의 세션 전부 떨구고 반환, 다른 워커는 보존", () => {
  const r = new AttachRouter(4);
  r.assign("a", 100); r.assign("b", 100); r.assign("c", 200);
  const dropped = r.dropWorker(100);
  assert.deepEqual(new Set(dropped), new Set(["a", "b"]));
  assert.equal(r.workerForSession("a"), undefined, "a 매핑 사라짐");
  assert.equal(r.workerForSession("c"), 200, "다른 워커 세션은 그대로");
  assert.deepEqual(r.pick("a", [200]), { worker: 200, sticky: false }, "떨어진 세션은 새 워커로");
});

test("INF K=Infinity(B 모드) — 모든 세션이 한 워커로", () => {
  const r = new AttachRouter(Infinity);
  r.assign("a", 100);
  for (const id of ["b", "c", "d", "e"]) {
    assert.deepEqual(r.pick(id, [100]), { worker: 100, sticky: false }, `${id} 도 유일 워커 100 으로`);
    r.assign(id, 100);
  }
  assert.equal(r.sessionCount(100), 5);
});

test("G1/G2 누수 지표 무회귀 — ownedPids(워커 pid)의 attach 자식도 «우리 것»으로 센다", () => {
  const gwPid = 999;
  const stdout = [
    "  111   999 01:00 tmux -u -CC attach -t box-yoon-aaaa",   // 게이트웨이 자식
    "  222  4242 02:00 tmux -u -CC attach -t box-yoon-bbbb",   // attach 워커(4242) 자식
    "  333     1 03:00 tmux -u -CC attach -t box-yoon-cccc",   // 고아(이전 세대)
    "  444  4242 00:30 node /opt/lively/libexec/tmux-relay.cjs foo attach -t box-yoon-dddd", // 워커 자식(매니지드 중계)
  ].join("\n");
  const s = summarizeAttachProcs(stdout, gwPid, [4242]);
  assert.equal(s.children, 3, "게이트웨이 자식 1 + 워커 자식 2 = 3");
  assert.equal(s.orphans, 1, "PPID=1 고아는 그대로 1");
  const legacy = summarizeAttachProcs(stdout, gwPid); // ownedPids 생략 = 종전 동작
  assert.equal(legacy.children, 1, "ownedPids 없으면 게이트웨이 자식만(무변경)");
  assert.equal(legacy.orphans, 1);
});
