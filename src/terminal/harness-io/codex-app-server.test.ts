// App Server 클라이언트 계약 (#2055) — 전송을 **가짜로 갈아 끼워** 프로토콜 규약만 검증한다(프로세스 없음).
//  여기서 잡는 것: 핸드셰이크 순서 · 요청/응답 짝짓기 · 승인 기본값(fail-closed) · 연결 끊김의 전파 · 줄 잡음 내성.
import assert from "node:assert/strict";
import { CodexAppServer, type AppServerTransport, type ApprovalDecision } from "./codex-app-server.js";
import type { ChatLine } from "./chat-line.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

/** 보낸 것을 모아 두고 아무 때나 답을 밀어 넣을 수 있는 가짜 전송. */
function fake(): AppServerTransport & { sent: any[]; push: (o: unknown) => void; die: (r: string) => void } {
  let onLine: ((l: string) => void) | null = null;
  let onClose: ((r: string) => void) | null = null;
  const sent: any[] = [];
  return {
    sent,
    send: (line) => sent.push(JSON.parse(line)),
    onLine: (cb) => { onLine = cb; },
    onClose: (cb) => { onClose = cb; },
    close: () => { onClose?.("closed"); },
    push: (o) => onLine?.(typeof o === "string" ? o : JSON.stringify(o)),
    die: (r) => onClose?.(r),
  };
}
const reply = (tr: ReturnType<typeof fake>, id: number, result: unknown) => tr.push({ jsonrpc: "2.0", id, result });

await t("H1 initialize 는 응답 뒤 initialized 알림까지가 계약이다", async () => {
  const tr = fake();
  const c = new CodexAppServer({ transport: tr });
  const p = c.initialize();
  assert.equal(tr.sent[0].method, "initialize");
  assert.equal(tr.sent[0].params.clientInfo.name, "lively");
  reply(tr, tr.sent[0].id, { userAgent: "x" });
  await p;
  assert.equal(tr.sent[1].method, "initialized", "initialized 알림이 뒤따라야 한다");
  assert.equal(tr.sent[1].id, undefined, "알림에는 id 가 없다");
});

await t("H2 요청/응답은 id 로 짝지어진다 — 순서가 뒤바뀌어 와도 맞는 것끼리 풀린다", async () => {
  const tr = fake();
  const c = new CodexAppServer({ transport: tr });
  const a = c.startThread({ cwd: "/w" });
  const b = c.startThread({ cwd: "/w2" });
  const [ra, rb] = [tr.sent[0].id, tr.sent[1].id];
  reply(tr, rb, { thread: { id: "T-B" } });      // 나중 것이 먼저 온다
  reply(tr, ra, { thread: { id: "T-A" } });
  assert.equal((await a).threadId, "T-A");
  assert.equal((await b).threadId, "T-B");
});

await t("H3 서버가 error 로 답하면 그 요청만 거부된다 — active writer 충돌이 이 경로다", async () => {
  const tr = fake();
  const c = new CodexAppServer({ transport: tr });
  const p = c.resumeThread("T1");
  tr.push({ jsonrpc: "2.0", id: tr.sent[0].id, error: { code: -32600, message: "thread T1 already has an active writer" } });
  await assert.rejects(p, /active writer/);
});

await t("★ I1 승인 정책을 안 주면 **전부 거부**한다(자동 승인은 명시적으로 켜는 것)", async () => {
  const tr = fake();
  new CodexAppServer({ transport: tr });
  tr.push({ jsonrpc: "2.0", id: 7, method: "item/commandExecution/requestApproval", params: { command: "rm -rf /" } });
  await new Promise((r) => setImmediate(r));
  const ans = tr.sent.find((s) => s.id === 7);
  assert.deepEqual(ans.result, { decision: "decline" });
});

await t("I2 정책이 준 결정을 그대로 보낸다", async () => {
  const tr = fake();
  const seen: string[] = [];
  new CodexAppServer({
    transport: tr,
    onApproval: (req) => { seen.push(req.method); return "accept" as ApprovalDecision; },
  });
  tr.push({ jsonrpc: "2.0", id: 9, method: "applyPatchApproval", params: { itemId: "p1" } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["applyPatchApproval"]);
  assert.deepEqual(tr.sent.find((s) => s.id === 9).result, { decision: "accept" });
});

await t("★ I3 정책이 터지면 막는 쪽으로 닫는다(fail-closed)", async () => {
  const tr = fake();
  new CodexAppServer({ transport: tr, onApproval: () => { throw new Error("정책 조회 실패"); } });
  tr.push({ jsonrpc: "2.0", id: 11, method: "item/commandExecution/requestApproval", params: {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(tr.sent.find((s) => s.id === 11).result, { decision: "decline" });
});

await t("J1 알림은 ChatLine 으로 번역돼 onLine 으로 나가고, 델타는 onDelta 로 갈린다", async () => {
  const tr = fake();
  const lines: ChatLine[] = []; const deltas: string[] = [];
  new CodexAppServer({ transport: tr, onLine: (l) => lines.push(l), onDelta: (d) => deltas.push(d) });
  tr.push({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "t", delta: "패리" } });
  tr.push({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t", completedAtMs: 1, item: { type: "agentMessage", id: "m", text: "패리티 확인" } } });
  assert.deepEqual(deltas, ["패리"]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "assistant");
});

await t("J2 턴 경계 상태가 알림 사이에 이어진다(turn/started → turn/completed)", async () => {
  const tr = fake();
  const lines: ChatLine[] = [];
  new CodexAppServer({ transport: tr, onLine: (l) => lines.push(l) });
  tr.push({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t", startedAtMs: 1000 } });
  tr.push({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", completedAtMs: 4000 } });
  assert.equal(lines.length, 1);
  assert.equal((lines[0] as any).durationMs, 3000);
});

await t("K1 연결이 끊기면 기다리던 요청이 **에러로 깨어난다**(영원히 멈추지 않는다)", async () => {
  const tr = fake();
  const c = new CodexAppServer({ transport: tr });
  const p = c.startTurn("T1", "안녕");
  tr.die("app-server 종료(code=1)");
  await assert.rejects(p, /code=1/);
  assert.equal(c.isClosed, true);
  await assert.rejects(c.startTurn("T1", "또"), /code=1/, "닫힌 뒤의 요청도 즉시 거부된다");
});

await t("K2 JSON 이 아닌 줄·모르는 id 응답은 무시한다(잡음 한 줄이 세션을 죽이지 않는다)", async () => {
  const tr = fake();
  const c = new CodexAppServer({ transport: tr });
  tr.push("이건 JSON 이 아니다");
  tr.push({ jsonrpc: "2.0", id: 999, result: { x: 1 } });
  const p = c.startThread({ cwd: "/w" });
  reply(tr, tr.sent[0].id, { thread: { id: "T" } });
  assert.equal((await p).threadId, "T");
});


// ── 멈춤·얹기의 필수 인자 (#2055, 실측 2026-08-26 dev) ─────────────────────────────────
//  스키마가 못박은 것: TurnInterruptParams.required = [threadId, turnId] · TurnSteerParams 는 expectedTurnId 필수.
//  ★ 왜 표로 잡나: threadId 만 보내면 서버가 요청을 거부하는데, 우리는 그 실패를 **조용히 false 로 접었다** —
//   그래서 화면의 [멈춤]·Esc 가 아무 일도 하지 않았고, 사람 눈에는 "멈춰지지도 않고"로만 보였다.
//   인자 하나가 빠졌을 뿐인데 증상은 '기능이 없음'이다. 다시 빠지면 여기서 걸린다.
async function ready(tr: ReturnType<typeof fake>): Promise<CodexAppServer> {
  const c = new CodexAppServer({ transport: tr });
  const p = c.initialize();
  reply(tr, tr.sent[0].id, { userAgent: "x" });
  await p;
  return c;
}

await t("★ T1 turn/interrupt 는 turnId 를 함께 보낸다 — 없으면 서버가 거부하고 멈춤이 먹통이 된다", async () => {
  const tr = fake();
  const c = await ready(tr);
  tr.push({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "th1", turn: { id: "TU-9" } } });
  const p = c.interrupt("th1");
  const sent = tr.sent.find((m) => m.method === "turn/interrupt");
  assert.equal(sent.params.threadId, "th1");
  assert.equal(sent.params.turnId, "TU-9", "지금 도는 턴 id 를 실어야 한다");
  reply(tr, sent.id, {});
  await p;
});

await t("★ T2 turn/steer 는 expectedTurnId 를 함께 보낸다(도는 턴 선행조건)", async () => {
  const tr = fake();
  const c = await ready(tr);
  tr.push({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "th1", turn: { id: "TU-3" } } });
  const p = c.steer("th1", "그거 말고 이거요");
  const sent = tr.sent.find((m) => m.method === "turn/steer");
  assert.equal(sent.params.expectedTurnId, "TU-3");
  assert.deepEqual(sent.params.input, [{ type: "text", text: "그거 말고 이거요" }]);
  reply(tr, sent.id, { turnId: "TU-3" });
  await p;
});

await t("T3 턴이 끝나면 그 id 를 놓는다 — 끝난 턴을 멈추려 들지 않는다(엉뚱한 턴을 끊을 위험)", async () => {
  const tr = fake();
  const c = await ready(tr);
  tr.push({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "th1", turn: { id: "TU-1" } } });
  tr.push({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "th1", turn: { id: "TU-1" } } });
  assert.equal(c.currentTurnId, "");
  await assert.rejects(() => c.interrupt("th1"), /멈출 턴이 없습니다/);
});

await t("T4 turn/start 응답의 turn.id 도 잡는다 — 알림보다 먼저 올 수 있다(곧바로 멈출 수 있어야 한다)", async () => {
  const tr = fake();
  const c = await ready(tr);
  const p = c.startTurn("th1", "안녕");
  const sent = tr.sent.find((m) => m.method === "turn/start");
  reply(tr, sent.id, { turn: { id: "TU-7" } });
  await p;
  assert.equal(c.currentTurnId, "TU-7");
});

console.log(`\n${pass} passed`);
