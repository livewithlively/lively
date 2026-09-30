// #4075 — 곁칸 [뷰어]의 시안(HTML)이 격리 프레임에서도 코멘트를 저장·복사·내려받을 수 있게 하는 «검토 다리».
//  사양·엣지 표(1~26)는 스크래치패드 spec.md — 아래 이름의 번호가 그 행이다.
//
//  ⚠ 왜 순수 함수와 소스 텍스트를 함께 보나: 다리의 안전 규칙(이 프레임만·문자열만·이름 공간·크기 상한)은
//   handleBridgeMessage 한 곳에 있고 창 없이 그대로 시험된다. 그런데 그 함수가 있어도 **뷰어가 안 걸면**
//   문서는 여전히 죽어 있다(#4075 의 첫 판은 sandbox='' 였다). 그래서 뷰어 소스가 공용 렌더러 htmlFrame 과
//   attachFrameBridge 를 실제로 부르는지, 옛 절단(400_000)·옛 sandbox='' 가 시안 갈래에서 사라졌는지도 잰다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

// 창 흉내 — attachFrameBridge 는 window.addEventListener/removeEventListener 만 쓴다. 모듈을 읽기 전에 심는다.
const listeners = new Set();
globalThis.window = {
  addEventListener: (t, fn) => { if (t === "message") listeners.add(fn); },
  removeEventListener: (t, fn) => { if (t === "message") listeners.delete(fn); },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
};
const dispatch = (ev) => { for (const fn of [...listeners]) fn(ev); };
const tick = () => new Promise((r) => setTimeout(r, 0));

const { handleBridgeMessage, attachFrameBridge, browserDeps, nsKey, safeDownloadName, RV_VALUE_MAX, RV_KEY_MAX } =
  await import(join(root, "public/app/lib/frame-bridge.js"));

/** 가짜 의존 — 무엇이 불렸는지 남긴다(부작용으로 단언한다). */
function deps(over = {}) {
  const store = new Map();
  const log = [];
  return {
    store, log,
    get: (k) => { log.push(["get", k]); return store.has(k) ? store.get(k) : null; },
    set: (k, v) => { log.push(["set", k, v]); store.set(k, v); },
    del: (k) => { log.push(["del", k]); store.delete(k); },
    copy: async (t, h) => { log.push(["copy", t, h]); return true; },
    download: (n, t, m) => { log.push(["download", n, t, m]); },
    ...over,
  };
}
const calls = (d, op) => d.log.filter((x) => x[0] === op);
const NS = "3625:2026 GovTech/검토판6.html";
const msg = (op, rest = {}) => ({ lv: "rv", op, ...rest });

// ══ 1~5 저장 규약 ═══════════════════════════════════════════════════════════════
{
  const d = deps();
  const r = await handleBridgeMessage(msg("hello"), NS, d);
  ok(r && r.lv === "rv" && r.op === "ready" && d.log.length === 0, "1 hello → ready (저장소는 건드리지 않는다)");
  ok((await handleBridgeMessage(msg("set", { key: "rv:doc:6", value: '{"c":1}' }), NS, d)) === null, "4a set 은 답이 없다");
  ok(d.store.get(nsKey(NS, "rv:doc:6")) === '{"c":1}' && d.store.size === 1, "4b 이름 공간(rvb:<ns>:)이 붙은 키 하나로 저장된다");
  const g = await handleBridgeMessage(msg("get", { key: "rv:doc:6" }), NS, d);
  ok(g && g.op === "got" && g.key === "rv:doc:6" && g.value === '{"c":1}', "2 있는 키 get → got + 값");
  const g0 = await handleBridgeMessage(msg("get", { key: "rv:doc:7" }), NS, d);
  ok(g0 && g0.op === "got" && g0.value === null, "3 없는 키 get → got + null");
  ok((await handleBridgeMessage(msg("del", { key: "rv:doc:6" }), NS, d)) === null && d.store.size === 0, "5a del 은 답 없이 지운다");
  const g2 = await handleBridgeMessage(msg("get", { key: "rv:doc:6" }), NS, d);
  ok(g2 && g2.value === null, "5b del 뒤 get 은 null");
}

// ══ 6~11 복사·내려받기 ═══════════════════════════════════════════════════════════
{
  const d = deps();
  const r = await handleBridgeMessage(msg("copy", { text: "코멘트 · 2건", html: "<p>코멘트 · 2건</p>" }), NS, d);
  const c = calls(d, "copy");
  ok(r && r.op === "copied" && r.ok === true && c.length === 1 && c[0][1] === "코멘트 · 2건" && c[0][2] === "<p>코멘트 · 2건</p>", "6 copy → 셸 복사 1회(같은 글자·서식) + copied ok:true");
  const r2 = await handleBridgeMessage(msg("copy", { text: "", html: "" }), NS, d);
  ok(r2 && r2.op === "copied" && r2.ok === false && calls(d, "copy").length === 1, "7 빈 copy → 복사 0회, copied ok:false");
  const d2 = deps({ copy: async () => { throw new Error("denied"); } });
  const r3 = await handleBridgeMessage(msg("copy", { text: "x" }), NS, d2);
  ok(r3 && r3.op === "copied" && r3.ok === false, "8 셸 복사가 던져도 copied ok:false 로 답한다");
}
{
  const d = deps();
  ok((await handleBridgeMessage(msg("download", { name: "백업.json", text: "{}", mime: "application/json" }), NS, d)) === null, "9a download 는 답이 없다");
  const dl = calls(d, "download");
  ok(dl.length === 1 && dl[0][1] === "백업.json" && dl[0][2] === "{}" && dl[0][3] === "application/json", "9b 이름·글·MIME 그대로 내려받기 1회");
  const d2 = deps();
  await handleBridgeMessage(msg("download", { name: "../../etc/passwd\u0000.txt", text: "x", mime: "text/plain; charset=utf-8" }), NS, d2);
  const dl2 = calls(d2, "download");
  ok(dl2.length === 1 && !/[\\/\u0000]/.test(dl2[0][1]) && dl2[0][3] === "text/plain", "10 이름의 경로·제어 문자는 지우고 꼴이 안 맞는 MIME 은 text/plain");
  ok(safeDownloadName("") === "download.txt", "10b 빈 이름은 기본 이름");
  const d3 = deps();
  await handleBridgeMessage(msg("download", { name: "a.txt" }), NS, d3);
  ok(calls(d3, "download").length === 0, "11 글이 없는 download 는 0회");
}

// ══ 12~19 신뢰하지 않는다 ═══════════════════════════════════════════════════════
{
  const d = deps();
  for (const bad of [{ type: "lively:open-route", href: "x" }, { lv: "rv" }, { lv: "xx", op: "get", key: "k" }, "rv", null, undefined, 42]) {
    ok((await handleBridgeMessage(bad, NS, d)) === null, `12 규약 밖 메시지는 무시: ${JSON.stringify(bad)}`);
  }
  ok(d.log.length === 0, "12b 규약 밖 메시지는 부작용 0");
  ok((await handleBridgeMessage(msg("eval", { key: "k", value: "1+1" }), NS, d)) === null && d.log.length === 0, "13 모르는 op 는 무시");
  ok((await handleBridgeMessage(msg("set", { key: "k", value: { a: 1 } }), NS, d)) === null && calls(d, "set").length === 0, "14 문자열이 아닌 값은 저장 0");
  await handleBridgeMessage(msg("set", { key: "max", value: "x".repeat(RV_VALUE_MAX) }), NS, d);
  ok(d.store.get(nsKey(NS, "max"))?.length === RV_VALUE_MAX, "15a 값 길이 정확히 상한은 저장된다(경계)");
  await handleBridgeMessage(msg("set", { key: "over", value: "x".repeat(RV_VALUE_MAX + 1) }), NS, d);
  ok(!d.store.has(nsKey(NS, "over")), "15b 상한+1 은 버린다");
  const k200 = "k".repeat(RV_KEY_MAX), k201 = "k".repeat(RV_KEY_MAX + 1);
  await handleBridgeMessage(msg("set", { key: k200, value: "v" }), NS, d);
  ok(d.store.has(nsKey(NS, k200)), "16a 키 길이 정확히 200 은 허용(경계)");
  await handleBridgeMessage(msg("set", { key: k201, value: "v" }), NS, d);
  ok(!d.store.has(nsKey(NS, k201)), "16b 키 201자는 버린다");
  ok((await handleBridgeMessage(msg("get", { key: "" }), NS, d)) === null, "16c 빈 키는 답하지 않는다");
  await handleBridgeMessage(msg("set", { key: "k", value: "A의 값" }), "fileA", d);
  const gb = await handleBridgeMessage(msg("get", { key: "k" }), "fileB", d);
  ok(gb && gb.value === null, "17 다른 이름 공간에서는 남의 값이 보이지 않는다");
  const d2 = deps({ get: () => { throw new Error("blocked"); } });
  const g = await handleBridgeMessage(msg("get", { key: "k" }), NS, d2);
  ok(g && g.op === "got" && g.value === null, "18 저장소 get 이 던져도 got null");
  const d3 = deps({ set: () => { throw new Error("quota"); } });
  let threw = false;
  try { await handleBridgeMessage(msg("set", { key: "k", value: "v" }), NS, d3); } catch { threw = true; }
  ok(!threw, "19 저장소 set 이 던져도 밖으로 안 나간다");
}

// ══ 20 새로 도입한 기본 의존 — localStorage 없는 환경 ═══════════════════════════
{
  const b = browserDeps();
  let threw = false, v = "?";
  try { v = b.get("rvb:x:k"); b.set("rvb:x:k", "1"); b.del("rvb:x:k"); } catch { threw = true; }
  ok(!threw && v === null, "20 localStorage 가 없어도 get 은 null, set·del 은 무해");
}

// ══ 21~24 다리 걸기 — 이 프레임만·그 프레임 창으로만 ═══════════════════════════
{
  const mkFrame = () => { const sent = []; return { isConnected: true, contentWindow: { postMessage: (m, o) => sent.push([m, o]) }, sent }; };
  const f = mkFrame();
  const d = deps();
  const off = attachFrameBridge(f, NS, d);
  const other = mkFrame();
  dispatch({ source: other.contentWindow, data: msg("hello") }); await tick();
  ok(f.sent.length === 0 && other.sent.length === 0 && d.log.length === 0, "21 다른 프레임에서 온 메시지는 무시(답 0·부작용 0)");
  dispatch({ source: f.contentWindow, data: msg("hello") }); await tick();
  ok(f.sent.length === 1 && f.sent[0][0].op === "ready" && f.sent[0][1] === "*", "22 같은 프레임의 hello 엔 그 창으로 ready 1회('*' 대상)");
  dispatch({ source: f.contentWindow, data: msg("set", { key: "k", value: "v" }) }); await tick();
  ok(d.store.get(nsKey(NS, "k")) === "v", "22b 같은 프레임의 set 은 저장된다");
  f.isConnected = false;
  dispatch({ source: f.contentWindow, data: msg("hello") }); await tick();
  ok(f.sent.length === 1 && listeners.size === 0, "23 프레임이 문서에서 빠지면 답하지 않고 리스너를 뗀다");
  const f2 = mkFrame();
  const off2 = attachFrameBridge(f2, NS, d);
  off2();
  dispatch({ source: f2.contentWindow, data: msg("hello") }); await tick();
  ok(f2.sent.length === 0 && listeners.size === 0, "24 떼는 손잡이를 부른 뒤엔 답하지 않는다");
  off();
}

// ══ 25~26 뷰어·공용 렌더러 배선 — 소스 텍스트 ══════════════════════════════════
{
  const PARTS = read("web/v2/panes-parts.ts");
  const a = PARTS.indexOf("function viewerPart(");
  const b = PARTS.indexOf("\nfunction appsPart(", a + 1);
  assert.ok(a >= 0 && b > a, "viewerPart 구간을 못 찾았다");
  const V = PARTS.slice(a, b);
  const s = V.indexOf("if (k.kind === 'page') {");
  const e = V.indexOf("} else if (/\\.(md|markdown)$/i.test(p2)) {", s);
  assert.ok(s >= 0 && e > s, "시안 갈래를 못 찾았다");
  const page = V.slice(s, e);
  ok(page.includes("htmlFrame(txt,"), "25a 시안은 공용 렌더러 htmlFrame 으로 그린다(자르지 않는다)");
  ok(!page.includes("400_000") && !page.includes("sandbox: ''"), "25b 시안 갈래에 40만 자 절단과 sandbox='' 가 없다");
  ok(page.includes("attachFrameBridge(f, `${ctx.id}:${p2}`)"), "25c 프레임에 다리를 걸고 이름 공간은 프로젝트·경로다");
  ok(page.includes("unbridge();") && V.includes("let unbridge: () => void"), "25d 다른 파일을 펼 때 옛 다리를 뗀다");
  ok(page.includes("show(f, 'scale', () => PAGE_BASE)"), "25e 배율(칸 폭 맞춤)은 종전과 같다");
  const FP = read("web/lib/file-preview.ts");
  ok(/sandbox: 'allow-scripts[^']*'/.test(FP) && !/sandbox: '[^']*allow-same-origin/.test(FP), "26a 공용 렌더러는 allow-scripts 만 주고 allow-same-origin 을 주지 않는다");
  ok(FP.includes("bridgeNs?: string") && FP.includes("attachFrameBridge(f, host.bridgeNs)"), "26b 공용 렌더러도 bridgeNs 를 받으면 같은 다리를 건다");
  const FB = read("web/lib/frame-bridge.ts");
  ok(FB.includes("ev.source !== frame.contentWindow") && FB.includes("postMessage(reply, '*')"), "26c 이 프레임에서 온 메시지만 받고 답은 그 프레임 창으로만 간다");
}

console.log(`\n${pass} passed`);
