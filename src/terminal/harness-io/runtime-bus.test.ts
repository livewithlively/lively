// 런타임 버스 계약 (#2439) — ★ 지키는 것은 하나다: **모든 요청은 반드시 한 번 답한다.**
//
//  이 표가 없으면 어댑터마다 각자 규칙을 지켜야 하고, 하나가 빠지면 그 세션의 턴이 **영구 정지**한다
//  (claude: "permission prompts have no park deadline" · codex #2055 §11 함정1 — 둘이 같은 성질이다).
import assert from "node:assert/strict";
import { ask, answer, clearSessionTasks, emitSessionEvent, onSessionEvent, pendingAsks, resetSessionBus, sessionTasks, settleAll } from "./runtime-bus.js";
import type { SessionEvent } from "./session-event.js";

let pass = 0;
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve(fn()).then(() => { pass++; console.log(`ok  ${name}`); });

await t("[1] 구독자가 이벤트를 받는다 · 해지하면 안 받는다", () => {
  const S = "s1"; resetSessionBus(S);
  const got: SessionEvent[] = [];
  const off = onSessionEvent(S, (e) => got.push(e));
  emitSessionEvent(S, { t: "usage", usage: { costUsd: 1 } });
  off();
  emitSessionEvent(S, { t: "usage", usage: { costUsd: 2 } });
  assert.equal(got.length, 1);
});

await t("[2] ★ 구독자가 던져도 다른 구독자에게 계속 간다 — 탭 하나의 버그가 남의 화면을 멈추지 않는다", () => {
  const S = "s2"; resetSessionBus(S);
  const got: string[] = [];
  onSessionEvent(S, () => { throw new Error("이 탭이 터졌다"); });
  onSessionEvent(S, (e) => got.push(e.t));
  emitSessionEvent(S, { t: "usage", usage: {} });
  assert.deepEqual(got, ["usage"]);
});

await t("[3] 물음 → 사람이 답하면 그 값으로 풀린다 · 화면엔 asked/resolved 가 흐른다", async () => {
  const S = "s3"; resetSessionBus(S);
  const seen: string[] = [];
  onSessionEvent(S, (e) => seen.push(e.t));
  const p = ask<string>(S, "a1", { toolName: "Bash" }, "deny");
  assert.equal(pendingAsks(S).length, 1, "걸려 있는 물음을 셀 수 있다");
  assert.equal(answer(S, "a1", "allow"), true);
  assert.equal(await p, "allow");
  assert.equal(pendingAsks(S).length, 0);
  assert.deepEqual(seen, ["permission.asked", "permission.resolved"]);
});

await t("[4] 없는 요청에 답하면 false — 던지지 않는다(이미 마감·남의 것)", () => {
  const S = "s4"; resetSessionBus(S);
  assert.equal(answer(S, "없음", "allow"), false);
});

await t("[5] ★ 시간이 다하면 기본값(거부)으로 마감한다 — 영원히 서 있지 않는다", async () => {
  const S = "s5"; resetSessionBus(S);
  const v = await ask<string>(S, "a1", {}, "deny", 10);
  assert.equal(v, "deny");
  assert.equal(pendingAsks(S).length, 0);
});

await t("[6] 같은 id 가 다시 오면 앞의 것을 매달아 두지 않는다(중복 배달·재연결)", async () => {
  const S = "s6"; resetSessionBus(S);
  const first = ask<string>(S, "dup", {}, "deny");
  const second = ask<string>(S, "dup", {}, "deny");
  assert.equal(await first, "deny", "앞의 것이 곧바로 마감된다");
  assert.equal(answer(S, "dup", "allow"), true);
  assert.equal(await second, "allow");
});

await t("[7] ★★ 런타임이 죽으면 남은 물음을 전부 마감한다 — 안 하면 그 턴은 영영 안 끝난다", async () => {
  const S = "s7"; resetSessionBus(S);
  const a = ask<string>(S, "a1", {}, "deny");
  const b = ask<string>(S, "a2", {}, "deny");
  assert.equal(pendingAsks(S).length, 2);
  assert.equal(settleAll(S, "런타임 종료"), 2, "몇 개를 마감했는지 돌려준다");
  assert.equal(await a, "deny");
  assert.equal(await b, "deny");
  assert.equal(pendingAsks(S).length, 0);
  assert.equal(settleAll(S, "두 번째"), 0, "두 번 불러도 안전하다(멱등)");
});

await t("[8] 세션끼리 새지 않는다 — 남의 세션 물음에 답할 수 없다", async () => {
  resetSessionBus("x"); resetSessionBus("y");
  const p = ask<string>("x", "a1", {}, "deny");
  assert.equal(answer("y", "a1", "allow"), false, "다른 세션에서는 못 답한다");
  assert.equal(pendingAsks("y").length, 0);
  assert.equal(pendingAsks("x").length, 1);
  settleAll("x", "정리"); await p;
});

await t("[9] ★ 작업 이벤트는 접혀서 스냅샷으로 나간다 — 접는 규칙이 두 벌이 되지 않게", () => {
  const S = "s9"; resetSessionBus(S);
  const got: SessionEvent[] = [];
  onSessionEvent(S, (e) => got.push(e));
  emitSessionEvent(S, { t: "task.started", task: { id: "T1", kind: "shell", title: "빌드", status: "running" } });
  emitSessionEvent(S, { t: "task.updated", id: "T1", patch: { status: "completed" } });
  //  화면이 보는 것은 언제나 스냅샷 한 장이다(델타를 화면이 다시 접지 않는다).
  assert.deepEqual(got.map((e) => e.t), ["tasks.snapshot", "tasks.snapshot"]);
  assert.equal((got[1] as any).tasks[0].status, "completed");
  //  서버도 같은 목록을 들고 있어 **새로 붙은 화면**에 곧바로 줄 수 있다.
  assert.equal(sessionTasks(S)[0].status, "completed");
});

await t("[10] 작업 아닌 이벤트는 그대로 흐른다(접기가 남의 이벤트를 삼키지 않는다)", () => {
  const S = "s10"; resetSessionBus(S);
  const got: SessionEvent[] = [];
  onSessionEvent(S, (e) => got.push(e));
  emitSessionEvent(S, { t: "usage", usage: { costUsd: 1 } });
  emitSessionEvent(S, { t: "facts", facts: { model: "m" } });
  assert.deepEqual(got.map((e) => e.t), ["usage", "facts"]);
});

await t("[11] 런타임이 끝나면 작업 목록도 비운다 — 죽은 세션의 «도는 중» 이 남지 않게", () => {
  const S = "s11"; resetSessionBus(S);
  emitSessionEvent(S, { t: "task.started", task: { id: "T1", kind: "agent", title: "리뷰", status: "running" } });
  assert.equal(sessionTasks(S).length, 1);
  clearSessionTasks(S);
  assert.equal(sessionTasks(S).length, 0);
});

console.log(`\n${pass}건 통과`);
