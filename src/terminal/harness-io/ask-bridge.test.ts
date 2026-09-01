// 훅이 사람에게 되묻는 문 (#2439) — antigravity 처럼 «벤더가 헤드리스에서 못 묻는» 하네스를 위한 자리.
//
//  이 파일이 지키는 것은 하나다: **훅은 어떤 경우에도 유효한 답을 한 번 받는다.**
//  (못 받으면 antigravity 는 그 세션의 모든 툴을 fail-closed deny 한다 — #1689 실측.)
import assert from "node:assert/strict";
import { handleAskRequest, askBridgeEnv, closeAskBridge } from "./ask-bridge.js";
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

console.log(`\n${pass} passed — 훅이 사람에게 되묻는 문(#2439)`);
