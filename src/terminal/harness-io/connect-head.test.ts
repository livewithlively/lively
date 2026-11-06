// #5398 — 화면이 세션 통로에 **다시 붙는 순간** 서버가 주는 머리(지금 상태 전부)와, 그 재료(마지막 사실 · 사용량)를 잰다.
//
//  왜: 화면은 숨으면 상시 스트림을 끊는다(web/session-events.ts ★ · web/session-codex-live.ts ★ — 평문 http 는 같은 주소에
//   연결이 6개뿐이라 숨은 화면이 쥐고 있으면 새로 연 화면이 «연결 준비 중…» 에 선다). 그 사이 흐른 것은 못 받았으니
//   붙는 자리가 곧 재동기의 자리다. 여기가 틀리면 «숨었다 돌아온 탭의 세션 상태» 가 묵는다.
//  사양 표(행마다 시험 하나 이상):
//   H1 아무것도 없을 때 머리 = 작업 목록(빈) · 걸린 물음 목록(빈)만      H2 머리 순서 = 작업 → 사실 → 사용량 → 물음 하나하나 → 물음 id 전부
//   H3 사실은 조각을 겹쳐 든다                                         H4 사용량은 한도 창에 숫자가 있을 때만 바꿔 든다(빈 것 · 토큰만은 앞 값을 지우지 않는다)
//   H5 경계: 한도 값 0 도 값이다                                       H6 런타임이 끝나면(작업 목록을 비울 때) · reset 이면 사실 · 사용량도 비운다
//   H7 경계: 세션 500개까지 다 들고 501번째에 가장 오래 안 바뀐 것 하나만 놓는다 · 갱신된 것은 뒤로 간다
//   H8 돌려준 값 · 보낸 쪽 값을 고쳐도 들고 있는 값은 안 바뀐다          H9 들기에 실패해도(복사할 수 없는 값) 사건은 그대로 흘린다
//   C1 codex 머리: 승인 · 사용량 없음 → hello(빈 승인 목록)만           C2 hello.approvals = 걸린 id 전부 → 승인 → 사용량(토큰 · % 겹침)
//   C3 codex 세션을 내리면 사용량을 비우고 승인도 머리에서 빠진다
import assert from "node:assert/strict";
import {
  ask, clearSessionTasks, connectHead, emitSessionEvent, KEPT_SESSIONS_MAX, onSessionEvent, resetSessionBus, sessionFacts, sessionUsage, settleAll,
} from "./runtime-bus.js";
import {
  _emitCodexChatEventForTest, askApproval, codexChatUsage, codexConnectHead, dropAllCodexChats, dropSession,
} from "./codex-chat-runtime.js";
import type { SessionEvent } from "./session-event.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const kinds = (h: SessionEvent[]): string[] => h.map((e) => e.t);

await t("H1 아무것도 없을 때의 머리 — 작업 목록(빈)과 걸린 물음 목록(빈)만 · 사실 · 사용량은 안 싣는다", () => {
  const S = "h1"; resetSessionBus(S);
  const h = connectHead(S);
  assert.deepEqual(h, [{ t: "tasks.snapshot", tasks: [] }, { t: "permission.pending", ids: [] }]);
});

await t("H2 머리의 순서와 내용 — 작업 → 사실 → 사용량 → 걸린 물음 하나하나 → 걸린 물음 id 전부", async () => {
  const S = "h2"; resetSessionBus(S);
  emitSessionEvent(S, { t: "task.started", task: { id: "k1", kind: "shell", title: "빌드", status: "running" } });
  emitSessionEvent(S, { t: "facts", facts: { model: "opus" } });
  emitSessionEvent(S, { t: "usage", usage: { utilization: { five_hour: 0.7 } } });
  const p1 = ask(S, "a1", { id: "a1", toolName: "Bash" }, false);
  const p2 = ask(S, "a2", { id: "a2", toolName: "Edit" }, false);
  const h = connectHead(S);
  assert.deepEqual(kinds(h), ["tasks.snapshot", "facts", "usage", "permission.asked", "permission.asked", "permission.pending"]);
  assert.equal((h[0] as any).tasks[0].id, "k1", "작업 목록이 실린다");
  assert.deepEqual((h[1] as any).facts, { model: "opus" });
  assert.deepEqual((h[2] as any).usage, { utilization: { five_hour: 0.7 } });
  assert.deepEqual(h.filter((e) => e.t === "permission.asked").map((e: any) => e.ask.id), ["a1", "a2"]);
  assert.deepEqual((h[5] as any).ids, ["a1", "a2"], "걸린 물음 id 전부가 마지막에 실린다");
  settleAll(S, "test");
  assert.deepEqual(await Promise.all([p1, p2]), [false, false], "(정리) 물음은 기본값으로 마감됐다");
  assert.deepEqual((connectHead(S).at(-1) as any).ids, [], "마감 뒤 다시 붙으면 걸린 목록이 비어 온다 — 화면이 카드를 접는 근거");
});

await t("H3 사실은 조각을 겹쳐 든다(모델 따로 · 슬래시 따로)", () => {
  const S = "h3"; resetSessionBus(S);
  emitSessionEvent(S, { t: "facts", facts: { model: "opus" } });
  emitSessionEvent(S, { t: "facts", facts: { commands: [{ name: "/review" }] } });
  emitSessionEvent(S, { t: "facts", facts: { model: "sonnet" } });
  assert.deepEqual(sessionFacts(S), { model: "sonnet", commands: [{ name: "/review" }] });
});

await t("H4 사용량은 한도 창에 숫자가 있을 때만 바꿔 든다 — 빈 것(턴 끝) · 토큰만 · 빈 창 · 숫자 아닌 창은 앞 값을 지우지 않는다", () => {
  const S = "h4"; resetSessionBus(S);
  emitSessionEvent(S, { t: "usage", usage: { utilization: { five_hour: 0.62 }, resetsAt: 123 } });
  emitSessionEvent(S, { t: "usage", usage: {} });
  emitSessionEvent(S, { t: "usage", usage: { inputTokens: 10, outputTokens: 20 } });
  emitSessionEvent(S, { t: "usage", usage: { utilization: {} } });
  emitSessionEvent(S, { t: "usage", usage: { utilization: { five_hour: "많이" as unknown as number } } });
  assert.deepEqual(sessionUsage(S), { utilization: { five_hour: 0.62 }, resetsAt: 123 });
  emitSessionEvent(S, { t: "usage", usage: { utilization: { seven_day: 0.9 } } });
  assert.deepEqual(sessionUsage(S), { utilization: { seven_day: 0.9 } }, "한도 창이 있는 새 값은 통째로 바꾼다(화면도 마지막 것을 그린다)");
});

await t("H5 경계 — 한도 값 0 도 값이다(바꿔 든다)", () => {
  const S = "h5"; resetSessionBus(S);
  emitSessionEvent(S, { t: "usage", usage: { utilization: { five_hour: 0.8 } } });
  emitSessionEvent(S, { t: "usage", usage: { utilization: { five_hour: 0 } } });
  assert.deepEqual(sessionUsage(S), { utilization: { five_hour: 0 } });
});

await t("H6 런타임이 끝나면(작업 목록을 비울 때) 사실 · 사용량도 비운다 — reset 도", () => {
  const S = "h6"; resetSessionBus(S);
  emitSessionEvent(S, { t: "facts", facts: { model: "opus" } });
  emitSessionEvent(S, { t: "usage", usage: { utilization: { five_hour: 0.6 } } });
  clearSessionTasks(S);
  assert.equal(sessionFacts(S), null);
  assert.equal(sessionUsage(S), null);
  assert.deepEqual(kinds(connectHead(S)), ["tasks.snapshot", "permission.pending"], "끝난 런타임의 것을 새로 붙는 화면에 되살리지 않는다");
  emitSessionEvent(S, { t: "facts", facts: { model: "opus" } });
  resetSessionBus(S);
  assert.equal(sessionFacts(S), null);
});

await t("H7 경계 — 500 세션까지는 다 들고, 501번째에 가장 오래 안 바뀐 것 하나만 놓는다 · 갱신된 것은 뒤로 간다", () => {
  assert.equal(KEPT_SESSIONS_MAX, 500);
  const id = (i: number): string => `cap-${i}`;
  //  앞 시험들이 남긴 세션을 먼저 비운다 — 들고 있는 것이 이 500개뿐이어야 «누가 먼저 놓이나» 를 잴 수 있다.
  for (const s of ["h1", "h2", "h3", "h4", "h5", "h6"]) resetSessionBus(s);
  for (let i = 0; i < KEPT_SESSIONS_MAX; i++) resetSessionBus(id(i));
  for (let i = 0; i < KEPT_SESSIONS_MAX; i++) emitSessionEvent(id(i), { t: "facts", facts: { model: `m${i}` } });
  assert.notEqual(sessionFacts(id(0)), null, "500번째까지는 맨 처음 것도 남아 있다");
  //  0번을 갱신 — 뒤로 간다. 그러면 다음에 놓이는 것은 1번이다.
  emitSessionEvent(id(0), { t: "facts", facts: { model: "m0b" } });
  emitSessionEvent(id(KEPT_SESSIONS_MAX), { t: "facts", facts: { model: "new" } });
  assert.notEqual(sessionFacts(id(0)), null, "갱신된 0번은 남는다(가장 오래 안 바뀐 것이 아니다)");
  assert.equal(sessionFacts(id(1)), null, "가장 오래 안 바뀐 1번 하나만 놓는다");
  assert.notEqual(sessionFacts(id(2)), null, "그다음 것은 남는다(하나만 놓는다)");
  assert.deepEqual(sessionFacts(id(KEPT_SESSIONS_MAX)), { model: "new" });
  for (let i = 0; i <= KEPT_SESSIONS_MAX; i++) resetSessionBus(id(i));
});

await t("H8 돌려준 값을 고쳐도 들고 있는 값은 안 바뀐다(사본) — 보낸 쪽 값을 나중에 고쳐도 마찬가지", () => {
  const S = "h8"; resetSessionBus(S);
  const sent = { utilization: { five_hour: 0.7 } };
  emitSessionEvent(S, { t: "usage", usage: sent });
  sent.utilization.five_hour = 0.1;
  const got = sessionUsage(S)!;
  got.utilization!.five_hour = 0.2;
  assert.deepEqual(sessionUsage(S), { utilization: { five_hour: 0.7 } });
  emitSessionEvent(S, { t: "facts", facts: { commands: [{ name: "/a" }] } });
  sessionFacts(S)!.commands!.push({ name: "/b" });
  assert.deepEqual(sessionFacts(S), { commands: [{ name: "/a" }] });
});

await t("H9 들기에 실패해도(복사할 수 없는 값) 사건은 그대로 흘린다 — 들기가 흘리기를 막지 않는다", () => {
  const S = "h9"; resetSessionBus(S);
  const got: string[] = [];
  const off = onSessionEvent(S, (e) => got.push(e.t));
  emitSessionEvent(S, { t: "facts", facts: { model: "opus", weird: () => 1 } as never });
  off();
  assert.deepEqual(got, ["facts"]);
  assert.equal(sessionFacts(S), null, "복사할 수 없는 값은 들지 않는다");
});

// ── codex 통로 ─────────────────────────────────────────────────────────────────
dropAllCodexChats();
await t("C1 codex 머리 — 승인도 사용량도 없으면 hello(도는 중 아님 · 걸린 승인 빈 목록)만", () => {
  assert.deepEqual(codexConnectHead("c1"), [{ kind: "hello", running: false, approvals: [] }]);
});

await t("C2 codex 머리 — hello.approvals 에 걸린 id 전부 → 승인 하나하나 → 마지막 사용량(토큰 · % 를 겹친 것)", () => {
  const S = "c2";
  void askApproval(S, "item/commandExecution/requestApproval", { command: "ls" });
  _emitCodexChatEventForTest(S, { kind: "usage", totalTokens: 1200 });
  _emitCodexChatEventForTest(S, { kind: "usage", usedPercent: 41 });
  const h = codexConnectHead(S);
  assert.deepEqual(h.map((e) => e.kind), ["hello", "approval", "usage"]);
  const id = (h[1] as any).id as string;
  assert.ok(id, "승인에 id 가 있다");
  assert.deepEqual((h[0] as any).approvals, [id], "hello 가 걸린 승인 id 전부를 싣는다");
  assert.deepEqual({ ...(h[2] as any) }, { kind: "usage", totalTokens: 1200, usedPercent: 41 }, "토큰 수와 한도 % 를 겹쳐 준다");
});

await t("C3 codex 런타임이 끝나면(세션을 내리면) 사용량을 비우고 승인도 닫혀 머리에서 빠진다", () => {
  const S = "c2";
  dropSession(S);
  assert.equal(codexChatUsage(S), null);
  assert.deepEqual(codexConnectHead(S), [{ kind: "hello", running: false, approvals: [] }]);
});

dropAllCodexChats();
console.log(`\n${pass}건 통과`);
process.exit(0);
