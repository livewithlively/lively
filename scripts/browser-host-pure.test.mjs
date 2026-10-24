// #4993 — AI 와 사람이 같이 쓰는 브라우저: 웹 쪽 **순수** 판정 표.
//
//  ① 탭 열쇠(v2/browser-tabs.js) — 탭 열쇠는 곧 웹 칸의 저장 열쇠다(panes-kit slotStoreKey: 첫 칸 `<세션>`, N번째 `<세션>#N`).
//     이 규칙이 어긋나면 AI 가 연 탭과 사람이 보는 웹 칸이 **서로 다른 탭**이 된다(같이 쓴다는 약속이 조용히 깨진다).
//  ② JS 실행 원문(lib/browser-page.js evalSource · callSource) — 사용자 코드는 문자열 평가(eval) 없이 원문에 끼운다.
//     많은 사이트가 CSP 로 unsafe-eval 을 막아(github 실측) 페이지 안에서 new Function 을 부르는 순간 막히기 때문이다.
//  DOM 이 있어야 하는 것(요소 읽기 · ref 좌표 · 양식 · 스크롤)은 Electron 실측 하네스로 검증했다(지식 lively-browser-ai-control-design-4993).
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

const { sessionOfKey, tabNoOfKey, keyOfTab, slotOfKey } = await import(join(root, "public/app/v2/browser-tabs.js"));
const { evalSource, callSource } = await import(join(root, "public/app/lib/browser-page.js"));

// panes-kit 의 저장 열쇠 규칙(같은 규칙을 글로 옮긴 것 — panes-kit 은 DOM 을 끌어와 node 에서 못 부른다).
//  ⚠ panes-kit.ts slotStoreKey 가 바뀌면 이 줄도 같이 바꿔야 한다(그때 이 표가 왕복을 다시 잰다).
const tabNum = (slot) => { const m = /#(\d+)$/.exec(slot); return m ? Number(m[1]) : 1; };
const slotStoreKey = (mem, slot) => (tabNum(slot) >= 2 ? mem + "#" + tabNum(slot) : mem);

const S = "box-lively-46e3-1a2b3c4d";
// ── ① 탭 열쇠 ───────────────────────────────────────────────────────────────
eq(sessionOfKey(S), S, "K1 꼬리 없는 열쇠는 세션 그대로");
eq(sessionOfKey(S + "#2"), S, "K2 #숫자 꼬리를 뗀다");
eq(sessionOfKey("a#x"), "a#x", "K3 숫자가 아닌 꼬리는 세션 이름의 일부다");
eq(sessionOfKey("#3"), "#3", "K3 세션 없이 꼬리만이면 떼지 않는다(빈 세션을 만들지 않는다)");
eq(tabNoOfKey(S), "1", "K4 꼬리 없음 → 탭 1");
eq(tabNoOfKey(S + "#7"), "7", "K4 #7 → 탭 7");
eq([1, 0, "", null, "abc", undefined].map((n) => keyOfTab(S, n)), [S, S, S, S, S, S], "K5 1·0·빈값·숫자 아님 → 세션 그대로(최소 1)");
eq([keyOfTab(S, 2), keyOfTab(S, "3"), keyOfTab(S, 3.7)], [S + "#2", S + "#3", S + "#3"], "K6 2 · '3' · 3.7(내림)");
eq([slotOfKey(S), slotOfKey(S + "#4")], ["web", "web#4"], "K7 첫 탭 'web' · 넷째 'web#4'");
for (const k of [S, S + "#2", S + "#9"]) eq(slotStoreKey(S, slotOfKey(k)), k, `K8 왕복 — 웹 칸 저장 열쇠로 되돌리면 같은 탭(${k.slice(-3)})`);
eq(keyOfTab(S, tabNoOfKey(S + "#5")), S + "#5", "K8 번호 왕복 — keyOf(세션, tabNo(열쇠)) = 열쇠");

// ── ② JS 실행 원문 ───────────────────────────────────────────────────────────
//  원문은 async IIFE 식이다 — 간접 eval 로 평가해 페이지에서 executeJavaScript 가 받는 것과 같은 값을 본다.
const run = async (code, expr) => (0, eval)(evalSource(code, expr));
eq(await run("1+2", true), { ok: true, value: 3 }, "V1 식 1+2 → 3");
eq(await run("const a = 2; return a * 3", false), { ok: true, value: 6 }, "V2 본문 → return 값");
eq(await run('throw new Error("x")', false), { ok: false, error: "Error: x" }, "V3 던지면 ok:false + '이름: 메시지'");
eq(await run("undefined", true), { ok: true, value: { __undefined: true } }, "V4 undefined 는 표지로(JSON 에서 사라지지 않게)");
eq(await run("(function hello(){})", true), { ok: true, value: "[function hello]" }, "V5 함수는 이름만");
{
  const r = await run("({a:{b:{c:{d:{e:{f:{g:{h:1}}}}}}}})", true);
  eq(r.value.a.b.c.d.e.f.g, "[깊이 초과]", "V6 깊이 6 을 넘으면 거기서 끊는다(순환·거대 객체 방어)");
}
eq((await run("'x'.repeat(50000)", true)).value.length, 50000, "V7 경계: 50,000자는 그대로");
{
  const v = (await run("'x'.repeat(50001)", true)).value;
  ok(v.length === 50001 && v.endsWith("…") && v.slice(0, 50000) === "x".repeat(50000), "V7 경계: 50,001자는 50,000자 + '…'");
}
eq(await run("await Promise.resolve(5)", true), { ok: true, value: 5 }, "V8 await 를 쓸 수 있다");
eq(await run("10n", true), { ok: true, value: "10n" }, "V9 bigint 는 'Nn' 글로");
{
  let syntax = false;
  try { await run("const a = 1; a", true); } catch (e) { syntax = e instanceof SyntaxError; }
  ok(syntax, "V10 식 모드에 문장을 넣으면 원문 자체가 문법 오류다(부르는 쪽이 본문 모드로 다시 부를 근거)");
  eq(await run("const a = 1; return a", false), { ok: true, value: 1 }, "V10 같은 코드를 본문 모드로는 실행된다");
}
eq((await run("Array.from({length: 201}, (_, i) => i)", true)).value.length, 200, "V11 배열은 200개까지");
{
  const src = callSource((a, b, c) => ({ a, b, c }), "a", { b: 1 }, undefined);
  eq((0, eval)(src), { a: "a", b: { b: 1 }, c: null }, "C1 callSource — 인자는 JSON 으로만(undefined → null)");
  ok(!/\bimport\b|\brequire\(/.test(src), "C1 원문에 바깥 이름(import·require)이 끼지 않는다");
}

console.log(`\n${pass} 통과`);
