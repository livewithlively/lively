// 훅이 사람에게 되묻는 문 (#2439) — antigravity 처럼 «벤더가 헤드리스에서 못 묻는» 하네스를 위한 자리.
//
//  이 파일이 지키는 것은 하나다: **훅은 어떤 경우에도 유효한 답을 한 번 받는다.**
//  (못 받으면 antigravity 는 그 세션의 모든 툴을 fail-closed deny 한다 — #1689 실측.)
import assert from "node:assert/strict";
import { handleAskRequest, askBridgeEnv, askSessionForToken, askTokenForSession, bindAskBodyToToken, closeAskBridge } from "./ask-bridge.js";
import type { PermissionAnswer, PermissionAsk } from "./session-event.js";

let pass = 0;
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve(fn()).then(() => { pass++; console.log(`ok  ${name}`); });

const ALLOW: PermissionAnswer = { allow: true, scope: "once" };

await t("[1] 세션·id 가 없으면 400 + **거부** — 모르면 넓게 열지 않는다", async () => {
  const a = await handleAskRequest({ toolName: "run_command" });
  assert.equal(a.status, 400);
  assert.equal(a.body.ok, false);
  assert.equal(a.body.allow, false);
});

await t("[2] 훅이 준 재료를 **우리 낱말**로 옮겨 버스에 건다(★3 — 하네스 낱말은 여기서 끊는다)", async () => {
  let seen: PermissionAsk | null = null;
  const out = await handleAskRequest(
    { session: "s1", id: "a1", toolName: "run_command", title: "npm test", why: "테스트 실행", input: { CommandLine: "npm test" } },
    { ask: (_s, _id, p) => { seen = p; return Promise.resolve(ALLOW); } },
  );
  assert.equal(out.status, 200);
  assert.equal(out.body.allow, true);
  const p = seen as unknown as PermissionAsk;
  assert.equal(p.id, "a1");
  assert.equal(p.toolName, "run_command");
  assert.equal(p.title, "npm test");
  assert.equal(p.description, "테스트 실행");
  assert.deepEqual(p.input, { CommandLine: "npm test" });
});

await t("[3] 선택지가 오면 **질문**으로 건다 — 화면이 승인 대신 버튼을 그린다", async () => {
  let seen: PermissionAsk | null = null;
  await handleAskRequest(
    { session: "s1", id: "q1", toolName: "ask_question", questions: [{ question: "딸기? 사과?", options: [{ label: "딸기" }, { label: "사과" }] }] },
    { ask: (_s, _id, p) => { seen = p; return Promise.resolve({ allow: true, scope: "once", answers: { "딸기? 사과?": ["딸기"] } } as PermissionAnswer); } },
  );
  const p = seen as unknown as PermissionAsk;
  assert.equal(p.questions?.length, 1);
  assert.equal(p.questions?.[0].options.length, 2);
});

await t("[4] ★ 버스가 던져도 **거부로 접는다** — 훅에 무효 출력을 주면 그 세션 전체가 fail-closed deny 된다", async () => {
  const out = await handleAskRequest(
    { session: "s1", id: "a2", toolName: "x" },
    { ask: () => Promise.reject(new Error("버스가 없다")) },
  );
  assert.equal(out.status, 200);       // 500 이 아니다 — 훅은 **답을 받아야** 한다
  assert.equal(out.body.allow, false);
});

await t("[5] 답을 기다리는 시간은 상한을 넘지 않는다(훅이 먼저 죽으면 답이 갈 곳이 없다)", async () => {
  let ttl = 0;
  await handleAskRequest(
    { session: "s1", id: "a3", toolName: "x", ttlMs: 99 * 60 * 1000 },
    { ask: (_s, _id, _p, ms) => { ttl = ms; return Promise.resolve(ALLOW); } },
  );
  assert.ok(ttl <= 10 * 60 * 1000, `상한을 넘었다: ${ttl}`);
});

await t("[6] env 는 **루프백 주소 + 토큰 + 세션** 셋이다 — 이게 있는 자식만 사람에게 묻는다", async () => {
  const env = askBridgeEnv("box-x");
  await new Promise((r) => setTimeout(r, 60));      // listen 은 비동기다
  const env2 = askBridgeEnv("box-x");
  const e = Object.keys(env2).length ? env2 : env;
  assert.ok(e.LIVELY_ASK_URL?.startsWith("http://127.0.0.1:"), `루프백이 아니다: ${e.LIVELY_ASK_URL}`);
  assert.ok((e.LIVELY_ASK_TOKEN || "").length >= 32, "토큰이 짧다");
  assert.equal(e.LIVELY_ASK_SESSION, "box-x");
  closeAskBridge();
});

// ── 토큰은 세션의 자격증명이다 ────────────────────────────────────────────────
//  왜 이 묶음이 필요한가: 토큰이 프로세스당 한 개면 그 하나가 **모든 세션의 열쇠**다. 박스의 멤버는 자기 agy
//   자식 env 에서 그 값을 읽을 수 있으니(자기 uid 의 프로세스다), 본문에 남의 session id 를 실어 그 사람
//   화면에 승인 카드를 띄우고 답까지 받아 갈 수 있다 — 루프백 바인딩은 같은 박스 안이라 이걸 못 막는다.
//   그래서 «본문이 말하는 세션» 이 아니라 «토큰이 말하는 세션» 으로만 물음이 가야 한다.

await t("[7] 세션마다 토큰이 다르고, 같은 세션은 같은 토큰이다(턴마다 새 자식이 뜬다)", () => {
  const a = askTokenForSession("box-a");
  const b = askTokenForSession("box-b");
  assert.notEqual(a, b, "세션이 다르면 토큰도 달라야 한다 — 하나면 그 하나가 모든 세션의 열쇠다");
  assert.equal(askTokenForSession("box-a"), a, "같은 세션은 값이 고정이다(앞 턴의 훅이 403 을 받으면 안 된다)");
  assert.ok(a.length >= 32, `토큰이 짧다: ${a.length}`);
  closeAskBridge();
});

await t("[8] ★ 본문이 남의 세션을 말해도 **토큰의 세션**으로 묶인다(승인 피싱 차단)", () => {
  askTokenForSession("victim");
  const attacker = askTokenForSession("attacker");
  const bound = bindAskBodyToToken(attacker, { session: "victim", id: "x1", toolName: "run_command" });
  assert.equal(bound?.session, "attacker", "본문의 session 을 믿으면 남의 화면에 카드가 뜨고 그 답이 공격자에게 간다");
  assert.equal(bound?.id, "x1", "나머지 재료는 그대로 지난다");
  assert.equal(bound?.toolName, "run_command");
  closeAskBridge();
});

await t("[9] 본문에 세션이 없어도 토큰이 채운다 — 훅은 세션을 몰라도 된다", () => {
  const tok = askTokenForSession("solo");
  assert.equal(bindAskBodyToToken(tok, { id: "x2", toolName: "t" })?.session, "solo");
  //  객체가 아닌 본문(배열·null)도 죽지 않는다 — 세션만 든 객체가 되어 handleAskRequest 가 id 없음으로 끊는다.
  assert.deepEqual(bindAskBodyToToken(tok, [1, 2]), { session: "solo" });
  assert.deepEqual(bindAskBodyToToken(tok, null), { session: "solo" });
  closeAskBridge();
});

await t("[10] 모르는 토큰·빈 토큰은 문을 못 연다(null → 호출부가 403)", () => {
  askTokenForSession("known");
  assert.equal(askSessionForToken("주워온-토큰"), null);
  assert.equal(askSessionForToken(""), null);
  assert.equal(bindAskBodyToToken("주워온-토큰", { session: "known", id: "x3" }), null,
    "모르는 토큰이 본문의 session 으로 통과하면 결속이 없는 것과 같다");
  closeAskBridge();
});

await t("[11] 문을 닫으면 발급한 토큰도 죽는다 — 샌 토큰이 재기동을 넘어 살지 않는다", () => {
  const tok = askTokenForSession("gone");
  assert.equal(askSessionForToken(tok), "gone");
  closeAskBridge();
  assert.equal(askSessionForToken(tok), null);
});

await t("[12] 세션 id 가 비면 env 를 주지 않는다 — 묶을 자리가 없다(종전 동작으로 접힌다)", () => {
  assert.deepEqual(askBridgeEnv(""), {});
  assert.deepEqual(askBridgeEnv("   "), {});
  closeAskBridge();
});

console.log(`\n${pass} passed — 훅이 사람에게 되묻는 문(#2439)`);
