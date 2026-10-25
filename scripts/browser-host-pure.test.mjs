// #4993 — AI 와 사람이 같이 쓰는 브라우저: 웹 쪽 **순수** 판정 표.
//
//  ① 탭 열쇠(v2/browser-tabs.js) — 탭 열쇠는 곧 웹 칸의 저장 열쇠다(panes-kit slotStoreKey: 첫 칸 `<세션>`, N번째 `<세션>#N`).
//     이 규칙이 어긋나면 AI 가 연 탭과 사람이 보는 웹 칸이 **서로 다른 탭**이 된다(같이 쓴다는 약속이 조용히 깨진다).
//  ② JS 실행 원문(lib/browser-page.js evalSource · callSource) — 사용자 코드는 문자열 평가(eval) 없이 원문에 끼운다.
//     많은 사이트가 CSP 로 unsafe-eval 을 막아(github 실측) 페이지 안에서 new Function 을 부르는 순간 막히기 때문이다.
//  ③ 호스트 판정(v2/browser-host-kit.js) — 실앱 끝단 확인(상민님 앱, 2026-10-25)에서 나온 셋:
//     이동 기다림(L — 늦게 온 앞 적재의 멈춤으로 끝나지 않는다) · 화면 찍기 시간 예산(C) · 스크롤 보내는 법(P — 숨은 창은 휠 대신 바로).
//     webview 는 가짜 사건 표적, 찍기·쉬기는 가짜 함수로 — 사건 순서와 시간만 재현한다.
//  DOM 이 있어야 하는 것(요소 읽기 · ref 좌표 · 양식 · 스크롤)은 Electron 실측 하네스로 검증했다(지식 lively-browser-ai-control-design-4993).
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

const { sessionOfKey, tabNoOfKey, keyOfTab, slotOfKey, dockScale } = await import(join(root, "public/app/v2/browser-tabs.js"));
const { evalSource, callSource } = await import(join(root, "public/app/lib/browser-page.js"));
const { loadAndWait, captureFrame, scrollPlan, hostErrorKind, PAUSED_MSG, NO_TAB_MSG, missingTabMsg, shotStuckMessage } = await import(join(root, "public/app/v2/browser-host-kit.js"));

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
  //  V12 — 순환은 끊고(지나온 길의 객체를 또 만나면 '[순환]'), 순환이 아닌 공유 참조는 그대로 펼친다.
  const r = (await run("(() => { const a = { x: 1 }; a.self = a; a.list = [a]; return a; })()", true)).value;
  eq([r.x, r.self, r.list[0]], [1, "[순환]", "[순환]"], "V12 자기 참조 객체 — '[순환]' 으로 끊는다");
  const sh = (await run("(() => { const s = { n: 1 }; return { a: s, b: s }; })()", true)).value;
  eq([sh.a.n, sh.b.n], [1, 1], "V12b 순환이 아닌 공유 참조는 둘 다 펼친다");
}
{
  //  V13 — 평범하지 않은 객체(브라우저의 window · document — node 에선 globalThis)는 펼치지 않고 종류 이름만. 곧바로 끝난다.
  const t0 = Date.now();
  const r = await run("globalThis", true);
  eq(r, { ok: true, value: Object.prototype.toString.call(globalThis) }, "V13 전역 객체는 종류 이름만");
  ok(Date.now() - t0 < 1000, "V13 전역 객체 직렬화가 1초 안에 끝난다");
}
{
  //  V14 — 칸 수 예산: 100키 × 200칸(2만 칸)은 5,000칸에서 '[생략…]' 으로 끊긴다.
  const v = (await run("Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k' + i, Array.from({ length: 200 }, (_, j) => j)]))", true)).value;
  const flat = JSON.stringify(v);
  ok(flat.includes("[생략"), "V14 칸 수 예산을 넘으면 '[생략]' 표지가 남는다");
  ok((flat.match(/\d+/g) || []).length <= 5_100, "V14 펼친 칸이 예산(5,000) 근처에서 멈춘다");
}
{
  //  V15 — Map 은 [키, 값] 쌍으로, 날짜는 ISO 글로.
  eq((await run("new Map([['a', 1]])", true)).value, { __map: [["a", 1]] }, "V15 Map → [키, 값] 쌍");
  eq((await run("new Date(0)", true)).value, "1970-01-01T00:00:00.000Z", "V15 Date → ISO");
}
{
  const src = callSource((a, b, c) => ({ a, b, c }), "a", { b: 1 }, undefined);
  eq((0, eval)(src), { a: "a", b: { b: 1 }, c: null }, "C1 callSource — 인자는 JSON 으로만(undefined → null)");
  ok(!/\bimport\b|\brequire\(/.test(src), "C1 원문에 바깥 이름(import·require)이 끼지 않는다");
}

// ── ③ 호스트 판정 ────────────────────────────────────────────────────────────
//  가짜 webview — 사건 표적(듣기 수를 센다) + 적재 중 여부.
const fakeView = () => {
  const on = new Map();
  let loading = false;
  return {
    addEventListener(type, fn) { if (!on.has(type)) on.set(type, new Set()); on.get(type).add(fn); },
    removeEventListener(type, fn) { on.get(type)?.delete(fn); },
    isLoading: () => loading,
    setLoading(v) { loading = v; },
    emit(type, e) { for (const fn of [...(on.get(type) || [])]) fn(e); },
    count() { let n = 0; for (const s of on.values()) n += s.size; return n; },
  };
};
/** 약속이 끝났나·오류였나를 들여다보는 꼬리표. */
const track = (p) => { const st = { done: false, err: null }; p.then(() => { st.done = true; }, (e) => { st.done = true; st.err = e; }); return st; };
const flush = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MAIN = { isMainFrame: true, isInPlace: false };

{
  const v = fakeView();
  const st = track(loadAndWait(v, () => {}, 5_000));
  ok(v.count() > 0, "L0 배선 — 기다리는 동안 사건을 듣고 있다");
  v.emit("did-stop-loading");                       // 갓 만든 탭의 빈 페이지(about:blank) 멈춤이 늦게 온다
  await flush();
  ok(!st.done, "L1 늦게 온 앞 적재의 멈춤으로 끝나지 않는다");
  v.emit("did-start-loading"); v.emit("did-stop-loading");
  await flush();
  ok(st.done && !st.err, "L1 이번 이동이 시작된 뒤의 멈춤에서 끝난다");
  eq(v.count(), 0, "L13 끝나면 건 듣기를 모두 걷는다");
}
{
  const v = fakeView();
  const st = track(loadAndWait(v, () => {}, 5_000));
  v.emit("did-start-navigation", MAIN); v.emit("did-stop-loading");
  await flush();
  ok(st.done && !st.err, "L2 적재 상태가 안 꺼진 채 갈아탈 때(본 프레임 이동 시작만) — 멈춤에서 끝난다");
}
{
  const v = fakeView();
  const st = track(loadAndWait(v, () => {}, 150));
  v.emit("did-start-navigation", { isMainFrame: false, isInPlace: false }); v.emit("did-stop-loading");
  await flush();
  ok(!st.done, "L3 하위 프레임의 이동 시작은 시작이 아니다 — 그 멈춤으로 끝나지 않는다");
  await wait(220);
  ok(st.done && !st.err, "L3 한도에서 오류 없이 끝난다");
}
{
  const v = fakeView();
  const st = track(loadAndWait(v, () => {}, 5_000));
  v.emit("did-start-navigation", { isMainFrame: true, isInPlace: true }); v.emit("did-navigate-in-page");
  await flush();
  ok(!st.done, "L4 같은 문서 이동 — 곧바로는 안 끝난다");
  await wait(480);
  ok(st.done && !st.err, "L4 같은 문서 이동만 있으면 약 0.4초 뒤 끝난다(한도 5초 전)");
}
{
  const v = fakeView();
  const st = track(loadAndWait(v, () => {}, 5_000));
  v.emit("did-start-loading");
  v.emit("did-fail-load", { isMainFrame: true, errorCode: -105, errorDescription: "ERR_NAME_NOT_RESOLVED", validatedURL: "https://x.invalid/" });
  v.emit("did-stop-loading");
  await flush();
  ok(st.done && /-105/.test(String(st.err?.message)), "L5 본 프레임 실패는 오류로 끝난다(코드가 메시지에)");
}
{
  const v = fakeView();
  const st = track(loadAndWait(v, () => {}, 5_000));
  v.emit("did-start-loading"); v.emit("did-fail-load", { isMainFrame: true, errorCode: -3 }); v.emit("did-stop-loading");
  await flush();
  ok(st.done && !st.err, "L6 ERR_ABORTED(-3)는 오류가 아니다");
}
{
  const v = fakeView();
  const st = track(loadAndWait(v, () => {}, 5_000));
  v.emit("did-start-navigation", MAIN); v.setLoading(false); v.emit("did-navigate");
  await flush();
  ok(st.done && !st.err, "L7 적재 없이 확정만 오면(저장해 둔 페이지 되살리기) 확정에서 끝난다");
}
{
  const v = fakeView();
  const st = track(loadAndWait(v, () => {}, 5_000));
  v.emit("did-start-navigation", MAIN); v.setLoading(true); v.emit("did-navigate");
  await flush();
  ok(!st.done, "L8 확정 때 아직 적재 중이면 거기서 끝내지 않는다");
  v.setLoading(false); v.emit("did-stop-loading");
  await flush();
  ok(st.done && !st.err, "L8 이어서 온 멈춤에서 끝난다");
}
{
  const v = fakeView();
  const t0 = Date.now();
  const st = track(loadAndWait(v, () => {}, 120));
  await wait(40);
  ok(!st.done, "L9 아무 사건이 없으면 한도 전엔 안 끝난다");
  await wait(140);
  ok(st.done && !st.err && Date.now() - t0 >= 115, "L9 한도에서 오류 없이 끝난다");
}
{
  const v = fakeView();
  const st = track(loadAndWait(v, () => Promise.reject(new Error("ERR_ABORTED (-3) loading 'https://a/'")), 5_000));
  await flush();
  ok(!st.done, "L10 걸기가 ERR_ABORTED 로 거절돼도 오류로 끝내지 않는다");
  v.emit("did-start-loading"); v.emit("did-stop-loading");
  await flush();
  ok(st.done && !st.err, "L10 이어서 온 이동의 멈춤에서 끝난다");
}
{
  const v = fakeView();
  const st = track(loadAndWait(v, () => Promise.reject(new Error("ERR_CONNECTION_REFUSED (-102)")), 5_000));
  await flush();
  ok(st.done && /ERR_CONNECTION_REFUSED/.test(String(st.err?.message)), "L11 걸기가 다른 오류로 거절되면(시작 전) 곧바로 오류");
}
{
  const v = fakeView();
  const st = track(loadAndWait(v, () => {}, 120));
  v.emit("did-start-navigation", undefined); v.emit("did-stop-loading");
  await flush();
  ok(!st.done, "L12 이동 시작 사건에 내용이 없으면 시작으로 치지 않는다");
  await wait(180);
  ok(st.done && !st.err, "L12 한도에서 끝난다");
}

//  가짜 찍기 — 순서대로 'hang'(안 끝남) · 'err'(빠른 오류) · 그 밖(그 값으로 성공) · {after:ms, img}(늦게 성공).
const mkCap = (seq) => {
  let i = 0;
  const c = { n: 0, naps: [], pings: 0 };
  c.fn = () => {
    c.n++;
    const s = seq[Math.min(i++, seq.length - 1)];
    if (s === "hang") return new Promise(() => {});
    if (s === "err") return Promise.reject(new Error("UnknownVizError"));
    if (s && typeof s === "object") return new Promise((r) => setTimeout(() => r(s.img), s.after));
    return Promise.resolve(s);
  };
  c.opts = (hidden) => ({ hidden, firstMs: 60, mainMs: 100, ping: async () => { c.pings++; }, nap: async (ms) => { c.naps.push(ms); } });
  return c;
};
const settle = async (p) => { const t0 = Date.now(); try { return { v: await p, ms: Date.now() - t0 }; } catch (e) { return { e, ms: Date.now() - t0 }; } };
{
  const c = mkCap(["img1"]);
  const r = await settle(captureFrame(c.fn, c.opts(false)));
  ok(r.v === "img1" && c.n === 1, "C1 보이는 창 — 한 번 찍어 그 그림");
}
{
  const c = mkCap(["old", "new"]);
  const r = await settle(captureFrame(c.fn, c.opts(true)));
  ok(r.v === "new" && c.n === 2 && c.pings === 1, "C2 숨은 창 — 첫 장(옛 프레임)은 버리고 빈 왕복 뒤 둘째 장");
}
{
  const c = mkCap(["hang"]);
  const r = await settle(captureFrame(c.fn, c.opts(false)));
  ok(/화면을 찍지 못했습니다/.test(String(r.e?.message)) && /데스크톱 앱 창/.test(String(r.e?.message)), "C3 찍기가 안 끝나면 창 안내로 실패");
  ok(c.n === 1 && r.ms >= 95 && r.ms < 190, `C3 다시 기다리지 않는다 — 한도 한 번(100ms) 남짓에 끝(${r.ms}ms · 찍기 ${c.n}번)`);
}
{
  const c = mkCap(["hang"]);
  const r = await settle(captureFrame(c.fn, c.opts(true)));
  ok(/화면을 찍지 못했습니다/.test(String(r.e?.message)) && c.n === 1 && r.ms < 95, `C4 숨은 창에서 첫 장부터 안 끝나면 본 찍기 없이 곧바로 실패(${r.ms}ms)`);
}
{
  const c = mkCap(["err", "img2"]);
  const r = await settle(captureFrame(c.fn, c.opts(false)));
  ok(r.v === "img2" && c.n === 2 && c.naps.length === 1 && c.naps[0] === 250, "C5 빠른 오류(프레임 없음)는 0.25초 쉬고 한 번만 다시");
}
{
  const c = mkCap(["err", "hang"]);
  const r = await settle(captureFrame(c.fn, c.opts(false)));
  ok(/화면을 찍지 못했습니다/.test(String(r.e?.message)) && c.n === 2, "C6 다시 찍기가 안 끝나면 창 안내로 실패");
}
{
  const c = mkCap(["err", "img3"]);
  const r = await settle(captureFrame(c.fn, c.opts(true)));
  ok(r.v === "img3" && c.n === 2, "C7 숨은 창 — 버리는 첫 장이 빠른 오류여도 본 찍기로 그림");
}
{
  const c = mkCap(["err", "err"]);
  const r = await settle(captureFrame(c.fn, c.opts(false)));
  ok(String(r.e?.message) === "UnknownVizError", "C8 빠른 오류가 두 번이면 그 오류를 그대로(창 안내로 바꾸지 않는다)");
}
{
  const c = mkCap([{ after: 70, img: "late" }]);
  const r = await settle(captureFrame(c.fn, c.opts(false)));
  ok(r.v === "late" && c.n === 1, "C9 경계 — 한도(100ms) 직전(70ms)에 끝난 찍기는 그 그림");
}

{
  //  P — 스크롤 보내는 법. 숨은 창은 페이지에서 바로(페이지 부호), 보이는 창은 휠 300px 씩(Electron 휠 부호 = 페이지 부호의 반대).
  const W = (dx, dy) => ({ deltaX: dx, deltaY: dy });
  eq(scrollPlan(true, 1200, "down"), { page: { dx: 0, dy: 1200 } }, "P1 숨은 창 · 아래 1200 → 페이지에서 바로 +1200(휠 없음)");
  eq(scrollPlan(true, 500, "up"), { page: { dx: 0, dy: -500 } }, "P2 숨은 창 · 위 500 → -500");
  eq([scrollPlan(true, 700, "right"), scrollPlan(true, 50, "left")], [{ page: { dx: 700, dy: 0 } }, { page: { dx: -50, dy: 0 } }], "P3 숨은 창 · 오른쪽 +700 · 왼쪽 -50");
  eq(scrollPlan(false, 1200, "down"), { wheel: [W(0, -300), W(0, -300), W(0, -300), W(0, -300)] }, "P4 보이는 창 · 아래 1200 → 휠 -300 네 번");
  eq(scrollPlan(false, 650, "up"), { wheel: [W(0, 300), W(0, 300), W(0, 50)] }, "P5 보이는 창 · 위 650 → 휠 +300 · +300 · +50");
  eq([scrollPlan(false, 300, "right"), scrollPlan(false, 900, "left")], [{ wheel: [W(-300, 0)] }, { wheel: [W(300, 0), W(300, 0), W(300, 0)] }], "P6 보이는 창 · 오른쪽 -300 한 번 · 왼쪽 +300 세 번");
  eq([scrollPlan(false, 300, "down").wheel.length, scrollPlan(false, 301, "down").wheel], [1, [W(0, -300), W(0, -1)]], "P7 경계 — 300 은 한 번 · 301 은 두 번(-300, -1)");
  eq([20000, 20001, Infinity, NaN, 0].map((n) => scrollPlan(true, n, "down").page.dy), [20000, 20000, 20000, 600, 600], "P8 경계 — 상한 20,000 · 무한·숫자 아님·0 은 기본 600");
  eq([scrollPlan(true, 100, ""), scrollPlan(true, 100, "x")], [{ page: { dx: 0, dy: 100 } }, { page: { dx: 0, dy: 100 } }], "P9 방향이 없거나 모르면 아래");
}
{
  //  P' — 칸 배율. 사람 칸에 겹친 탭은 휠 거리가 배율의 역수만큼 커져 들어간다(실앱 0.755 에서 1200→1590) → 휠에 배율을 곱해 보낸다.
  const W = (dx, dy) => ({ deltaX: dx, deltaY: dy });
  const sum = (plan) => plan.wheel.reduce((a, w) => a + w.deltaY + w.deltaX, 0);
  eq(scrollPlan(false, 1200, "down", 0.755), { wheel: [W(0, -227), W(0, -226), W(0, -227), W(0, -226)] }, "P10 배율 0.755 · 아래 1200 → -227 · -226 · -227 · -226");
  eq(sum(scrollPlan(false, 1200, "down", 0.755)), -906, "P10 합 = 1200 × 0.755(누적 경계 반올림이라 어긋나지 않는다)");
  eq(scrollPlan(false, 600, "up", 0.5), { wheel: [W(0, 150), W(0, 150)] }, "P11 배율 0.5 · 위 600 → +150 · +150");
  eq(scrollPlan(true, 1200, "down", 0.5), { page: { dx: 0, dy: 1200 } }, "P12 숨은 창의 페이지 굴리기는 배율과 무관");
  const plain = scrollPlan(false, 1200, "down");
  eq([undefined, NaN, 0, -1].map((z) => scrollPlan(false, 1200, "down", z)), [plain, plain, plain, plain], "P13 배율이 없거나 이상하면 1");
  eq(scrollPlan(false, 4, "down", 0.1), { wheel: [W(0, -1)] }, "P14 경계 — 반올림이 0 이어도 -1 하나는 보낸다(안 굴러가지 않게)");
  eq(scrollPlan(false, 300, "down", 4), { wheel: [W(0, -1200)] }, "P15 경계 — 배율 4 · 300 → -1200 하나");
}
{
  //  D — 지금 탭의 배율. 칸에 겹쳤을 때만 칸 배율(0.1~4), 대기·차가움은 transform 이 없어 1.
  const tab = (mode, z) => ({ mode, scale: () => z });
  eq(dockScale(tab("docked", 0.755)), 0.755, "D1 칸에 붙은 탭은 칸 배율");
  eq([dockScale(tab("warm", 0.5)), dockScale(tab("cold", 0.5))], [1, 1], "D2 대기·차가움은 1");
  eq([10, 0.01, NaN].map((z) => dockScale(tab("docked", z))), [4, 0.1, 1], "D3 경계 — 4 로 · 0.1 로 · 못 읽으면 1");
}

// ── E. 데스크톱 오류 문구 → 원격 화면 상태(hostErrorKind) — 문구는 kit 상수에서만 만든다(웹 판 원격 화면이 이 판정을 쓴다) ──
{
  const E = hostErrorKind;
  eq(E(PAUSED_MSG), "paused", "E1 [AI 멈춤] 문구 → paused");
  eq([E(NO_TAB_MSG), E(missingTabMsg("3")), E(missingTabMsg(12))], ["empty", "empty", "empty"], "E2 탭 없음 · 그 번호의 탭 없음 → empty");
  eq(E(shotStuckMessage(5000)), "stuck", "E3 화면을 찍지 못함 → stuck");
  eq([E("Error: " + PAUSED_MSG), E("앞말 " + missingTabMsg("2") + " 뒷말"), E("x " + shotStuckMessage(3000))], ["paused", "empty", "stuck"], "E4 앞뒤에 무엇이 붙어도 들어 있으면 같은 상태");
  eq([E("브라우저 연결이 방금 끊겼습니다"), E(""), E(undefined), E(null)], ["other", "other", "other", "other"], "E5 그 밖 · 빈 값 → other");
  eq(missingTabMsg("9"), "탭 9 이 없습니다 — browser_tabs 로 이 세션의 탭을 확인하세요.", "E6 그 번호의 탭이 없을 때 데스크톱이 내는 문구(AI 가 읽는 문장 — 고치면 이 행도 고친다)");
}

// ── T2' — 없는 번호의 탭을 만드는 것은 이동(navigate)뿐 (#4993 (A) 격리 리뷰) ─────────────────────
//  웹 판 원격 화면이 칸 번호로 처음 주소를 열 때 그 탭이 있어야 한다 — 그래서 이동은 만든다. 사람에게 넘기기 · 보기 · 누르기는
//  종전대로 «탭 n 이 없습니다» 다(넘기기가 빈 탭을 만들어 사람에게 부탁을 걸면, 오타 난 번호 하나로 빈 탭이 쌓인다).
//  화면 층(webview)을 세워야 하는 모듈이라 값으로 못 돌린다 — 부르는 자리를 구문 나무(TS AST)로 센다(문자열 정규식이 아니라).
{
  const HOST = readFileSync(join(root, "web/v2/browser-host.ts"), "utf8");
  const sf = ts.createSourceFile("browser-host.ts", HOST, ts.ScriptTarget.Latest, true);
  const calls = [];
  const visit = (n, fn) => {
    if (ts.isFunctionDeclaration(n) && n.name) fn = n.name.text;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === "withTab" || n.expression.text === "pickTab")) {
      calls.push({ callee: n.expression.text, fn, args: n.arguments.map((a) => a.getText(sf)) });
    }
    ts.forEachChild(n, (c) => visit(c, fn));
  };
  visit(sf, null);
  const numbered = calls.filter((c) => (c.callee === "withTab" && c.args[4] === "true") || (c.callee === "pickTab" && c.args[3] === "true")).map((c) => c.fn);
  const passThrough = calls.filter((c) => c.callee === "pickTab" && c.args.length >= 4 && c.args[3] !== "true").map((c) => `${c.fn}:${c.args[3]}`);
  eq([calls.length > 8, numbered, passThrough], [true, ["opNavigate"], ["withTab:makeNumbered"]], "T2' 없는 번호의 탭은 이동(opNavigate)만 만든다 — 넘기기 · 보기 · 누르기는 안 만든다");
}

console.log(`\n${pass} 통과`);
